/**
 * Name <-> id maps for a deployed catalog, so aggregates are matched and
 * promoted by *name*: every host that deploys the same SML generates its own
 * ids (catalog, model, keys, role-play refs), so an id never matches across
 * hosts.
 *
 * Built from the catalog's JSON representation (GET /v1/catalogs/{id}/export,
 * Container API "export-catalog-representation"). An aggregate's `planJson`
 * references two kinds of model objects by id:
 *
 *   - keys (`{"type": "key", "id": ...}`), named here by, in order of
 *     preference: the keyed attribute that uses it ("attr:Customer Name"),
 *     the attribute it is the sort key of ("sort:Custom Year"), or the
 *     dataset column(s) it is bound to ("col:<dataset>:rpt_year")
 *   - role-play references (`{"type": "reuse-ref", "ref-id": ...}`), named by
 *     the naming pattern + attribute they reach ("ref:Order {0}:Order Date")
 *
 * Ported from Atscale-Environment-Manager's api/promote/idmap.py.
 */

type JsonRecord = Record<string, unknown>;

function isRecord(o: unknown): o is JsonRecord {
  return typeof o === "object" && o !== null && !Array.isArray(o);
}

function items(v: unknown): JsonRecord[] {
  const arr = isRecord(v) ? [v] : Array.isArray(v) ? v : [];
  return arr.filter(isRecord);
}

function walk(o: unknown, fn: (o: JsonRecord, ctx: { owner?: string }) => void, ctx: { owner?: string }): void {
  if (isRecord(o)) {
    const nextCtx = typeof o.name === "string" && o.name && "id" in o ? { ...ctx, owner: o.name } : ctx;
    fn(o, nextCtx);
    for (const v of Object.values(o)) {
      walk(v, fn, nextCtx);
    }
  } else if (Array.isArray(o)) {
    for (const v of o) {
      walk(v, fn, ctx);
    }
  }
}

/** id -> logical name for every key and reference in the catalog. */
export function idNames(catalogExport: unknown): Record<string, string> {
  const attributes = isRecord(catalogExport) && isRecord(catalogExport.attributes) ? catalogExport.attributes : {};

  const attrName = new Map<string, string>();
  for (const group of ["keyed-attribute", "attribute"] as const) {
    for (const a of items((attributes as JsonRecord)[group])) {
      if (typeof a.id === "string" && typeof a.name === "string") {
        attrName.set(a.id, a.name);
      }
    }
  }

  const attr = new Map<string, string>();
  const sort = new Map<string, string>();
  const cols = new Map<string, Set<string>>();
  const refs = new Map<string, Set<string>>();

  for (const ka of items((attributes as JsonRecord)["keyed-attribute"])) {
    if (typeof ka["key-ref"] === "string" && typeof ka.name === "string" && !attr.has(ka["key-ref"] as string)) {
      attr.set(ka["key-ref"] as string, `attr:${ka.name}`);
    }
    const properties = isRecord(ka.properties) ? ka.properties : {};
    const ordering = isRecord(properties.ordering) ? properties.ordering : {};
    const sortKey = isRecord(ordering["sort-key"]) ? ordering["sort-key"] : {};
    const keyRef = sortKey["key-ref"];
    if (isRecord(keyRef) && typeof keyRef.id === "string" && typeof ka.name === "string" && !sort.has(keyRef.id)) {
      sort.set(keyRef.id, `sort:${ka.name}`);
    }
  }

  walk(catalogExport, (o, ctx) => {
    const owner = ctx.owner ?? "";
    if ("column" in o && typeof o.id === "string" && !("name" in o)) {
      const set = cols.get(o.id) ?? new Set<string>();
      set.add(`${owner}:${String(o.column)}`);
      cols.set(o.id, set);
    }
    if (typeof o["ref-id"] === "string" && o["attribute-id"]) {
      const target = attrName.get(o["attribute-id"] as string) ?? String(o["attribute-id"]);
      const set = refs.get(o["ref-id"]) ?? new Set<string>();
      set.add(`ref:${typeof o["ref-naming"] === "string" ? o["ref-naming"] : ""}:${target}`);
      refs.set(o["ref-id"], set);
    }
  }, {});

  const out: Record<string, string> = {};
  for (const [kid, cs] of cols) {
    out[kid] = "col:" + Array.from(cs).sort().join("|");
  }
  for (const [kid, name] of sort) out[kid] = name;
  for (const [kid, name] of attr) out[kid] = name;
  for (const [rid, ns] of refs) out[rid] = Array.from(ns).sort()[0];
  return out;
}

/** Inverse: logical name -> id (names that aren't unique are dropped). */
export function nameIds(catalogExport: unknown): Record<string, string> {
  const seen = new Map<string, string[]>();
  for (const [id, name] of Object.entries(idNames(catalogExport))) {
    const ids = seen.get(name) ?? [];
    ids.push(id);
    seen.set(name, ids);
  }
  const out: Record<string, string> = {};
  for (const [name, ids] of seen) {
    if (ids.length === 1) out[name] = ids[0];
  }
  return out;
}

/** Every key id and role-play ref id a plan references. */
export function planIds(plan: unknown): Set<string> {
  const found = new Set<string>();
  const obj = typeof plan === "string" ? (() => { try { return JSON.parse(plan); } catch { return undefined; } })() : plan;

  function visit(o: unknown): void {
    if (isRecord(o)) {
      if (o.type === "key" && typeof o.id === "string") found.add(o.id);
      if (o.type === "reuse-ref" && typeof o["ref-id"] === "string") found.add(o["ref-id"] as string);
      for (const v of Object.values(o)) visit(v);
    } else if (Array.isArray(o)) {
      for (const v of o) visit(v);
    }
  }

  visit(obj);
  return found;
}

/** Replace key / role-play ref ids per `mapping` (other fields untouched). */
export function translatePlan(plan: unknown, mapping: Record<string, string>): unknown {
  const asStr = typeof plan === "string";
  const obj = asStr ? JSON.parse(plan as string) : plan;

  function visit(o: unknown): unknown {
    if (isRecord(o)) {
      const n: JsonRecord = {};
      for (const [k, v] of Object.entries(o)) n[k] = visit(v);
      if (n.type === "key" && typeof n.id === "string" && mapping[n.id]) n.id = mapping[n.id];
      if (n.type === "reuse-ref" && typeof n["ref-id"] === "string" && mapping[n["ref-id"] as string]) {
        n["ref-id"] = mapping[n["ref-id"] as string];
      }
      return n;
    }
    if (Array.isArray(o)) return o.map(visit);
    return o;
  }

  const out = visit(obj);
  return asStr ? JSON.stringify(out) : out;
}
