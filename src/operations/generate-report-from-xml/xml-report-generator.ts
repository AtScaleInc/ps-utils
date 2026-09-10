/**
 * Markdown generator for generate-report-from-xml.
 *
 * Pure (no fs / no services): given an AtScale XML project file (project_2_0
 * schema — the same source format generate-sml-from-xml converts), it returns a
 * single, human-readable Markdown document describing every object found in the
 * model as-is, independent of anything the SML converter does or does not
 * support: connections, physical datasets (tables/queries/columns), the
 * fact-to-dimension join graph, the schema-level attribute library, dimensions
 * (hierarchies, levels, secondary attributes), cubes (measures, calculated
 * members, User Defined Aggregates, named sets, KPIs, drillthrough), and the
 * schema-level calculated-member formula library.
 *
 * This is a report, not a conversion: nothing here is renamed, deduplicated, or
 * reshaped for SML compatibility. Every object in the XML is listed, including
 * ones the converter deliberately skips (perspectives, roles, translations,
 * named sets, KPIs) so the report is a complete inventory of the source model.
 */

import { Parser } from "xml2js";

/* eslint-disable @typescript-eslint/no-explicit-any */
type El = Record<string, any>;

export interface XmlReportOptions {
  /** Original XML filename — included in the report header for traceability. */
  xmlFileName?: string;
  /** H1 title. Defaults to the XML schema name. */
  title?: string;
}

// ============================================================
// XML navigation helpers (mirrors xml-converter.ts's convention: xml2js with
// explicitArray + attrkey "$" + charkey "_" — kept local and independent so
// this report never depends on, or risks destabilizing, the converter).
// ============================================================

function first<T>(a: T[] | undefined): T | undefined {
  return a?.[0];
}

function arr(val: unknown): El[] {
  if (!val) return [];
  if (Array.isArray(val)) return val as El[];
  return [val as El];
}

function s(val: unknown): string | undefined {
  if (val == null) return undefined;
  if (typeof val === "string") return val || undefined;
  if (Array.isArray(val)) {
    const v = val[0];
    return v == null ? undefined : typeof v === "string" ? (v || undefined) : s(v);
  }
  if (typeof val === "object") {
    const obj = val as El;
    if (typeof obj._ === "string") return obj._ || undefined;
  }
  return String(val) || undefined;
}

function a(el: unknown, name: string): string | undefined {
  if (!el || typeof el !== "object") return undefined;
  const attrs = (el as El).$ as Record<string, string> | undefined;
  return attrs?.[name];
}

/** A `<column>` element is either plain text or `<column><name>/<sql>/<type>`. */
function columnName(col: unknown): string | undefined {
  if (typeof col === "string") return col || undefined;
  if (col && typeof col === "object") {
    const obj = col as El;
    if (obj.name !== undefined) return s(obj.name);
  }
  return s(col);
}

function columnNames(vals: unknown): string[] {
  return arr(vals).map(columnName).filter((c): c is string => !!c);
}

/** Best-effort guess at a measure's column from its own name (e.g. "m_FOO_sum" → "FOO"),
 *  the naming convention this XML format falls back on when no explicit binding exists. */
function parseColumnFromAttrName(attrName: string): string {
  const withoutPrefix = attrName.replace(/^m_/i, "");
  return withoutPrefix.replace(/_(sum|avg|min|max|count|distinct|average|minimum|maximum)$/i, "");
}

/**
 * True if this <attribute> is an AtScale quantile-group definition — a hidden helper (a
 * base attribute id + compression setting) that one or more <quantile-instance> attributes
 * reference by id to build a percentile measure. It carries no queryable value of its own
 * (generate-sml-from-xml never emits it as its own SML object either), so it's excluded from
 * measure counts and rows rather than shown as an unresolvable "unknown"-kind measure.
 */
function isQuantileGroupAttribute(attrEl: El): boolean {
  const props = first(arr(attrEl.properties)) as El | undefined;
  const typeEl = props ? (first(arr(props.type)) as El | undefined) : undefined;
  return !!(typeEl && arr(typeEl["quantile-group"]).length > 0);
}

// ── small Markdown helpers (same conventions as generate-sml-docs) ─────────

function cell(v: unknown): string {
  if (v === undefined || v === null || v === "") return "";
  return String(v).replace(/\|/g, "\\|").replace(/\r?\n/g, " ").trim();
}

function code(v: unknown): string {
  const c = cell(v);
  return c ? `\`${c}\`` : "";
}

function flag(v: boolean | undefined): string {
  return v ? "yes" : "";
}

function anchor(title: string): string {
  return title.toLowerCase().replace(/[^\w\s-]/g, "").trim().replace(/\s+/g, "-");
}

/** Render a table; returns [] when there are no rows. */
function table(headers: string[], rows: string[][]): string[] {
  if (rows.length === 0) return [];
  const sep = headers.map(() => "---");
  return [`| ${headers.join(" | ")} |`, `| ${sep.join(" | ")} |`, ...rows.map((r) => `| ${r.join(" | ")} |`), ""];
}

// ============================================================
// Parsed intermediate model
// ============================================================

interface KeyBinding {
  dataset: string;
  columns: string[];
  complete: string;
  unique: boolean;
  /** cube name this binding came from, undefined for a schema-level physical key-ref */
  cube?: string;
}

interface AttrBinding {
  dataset: string;
  column: string;
  cube?: string;
}

interface AttrDef {
  id: string;
  name: string;
  caption?: string;
  keyUuid?: string;
  visible: boolean;
  folder?: string;
  description?: string;
  format?: string;
  allowedCalcTypes: string[];
}

interface CalcMemberDef {
  id: string;
  name: string;
  caption?: string;
  visible: boolean;
  folder?: string;
  description?: string;
  format?: string;
  expression?: string;
}

interface DatasetDef {
  name: string;
  id: string;
  allowAggregates?: boolean;
  connectionId?: string;
  table?: { database?: string; schema?: string; name?: string };
  sql?: string;
  immutable?: boolean;
  columns: Array<{ name: string; type?: string; sql?: string }>;
  keyRefCount: number;
  attrRefCount: number;
}

// ============================================================
// Main entry point
// ============================================================

export async function generateReportFromXml(xmlContent: string, opts: XmlReportOptions = {}): Promise<string> {
  const parser = new Parser({
    explicitArray: true,
    attrkey: "$",
    charkey: "_",
    explicitCharkey: false,
    trim: true,
    xmlns: false,
  });

  let parsed: El;
  try {
    parsed = await parser.parseStringPromise(xmlContent);
  } catch (e) {
    throw new Error(`Failed to parse XML: ${e instanceof Error ? e.message : String(e)}`);
  }

  const rawSchema = parsed.schema ?? parsed["xsd:schema"] ?? parsed["ns0:schema"] ?? Object.values(parsed)[0];
  const schemaEl = (Array.isArray(rawSchema) ? rawSchema[0] : rawSchema) as El | undefined;
  if (!schemaEl || typeof schemaEl !== "object") {
    throw new Error("No <schema> element found in XML");
  }

  const schemaName = a(schemaEl, "name") ?? "Model";
  const title = opts.title ?? schemaName;

  // ── Phase 1: datasets, connections, and the keyMap/attrMap join graph ─────

  const datasetIdToName = new Map<string, string>();
  const datasets: DatasetDef[] = [];
  const keyMap = new Map<string, KeyBinding[]>();
  const attrMap = new Map<string, AttrBinding[]>();
  const connectionIds = new Set<string>();

  function ingestLogical(logicalEl: El, datasetName: string, cube?: string): { keyRefs: number; attrRefs: number } {
    let keyRefs = 0;
    let attrRefs = 0;
    for (const kr of arr(logicalEl["key-ref"])) {
      const id = a(kr, "id");
      const cols = columnNames(kr.column);
      if (!id || cols.length === 0) continue;
      keyRefs++;
      const list = keyMap.get(id) ?? [];
      list.push({ dataset: datasetName, columns: cols, complete: a(kr, "complete") ?? "true", unique: a(kr, "unique") === "true", cube });
      keyMap.set(id, list);
    }
    for (const ar of arr(logicalEl["attribute-ref"])) {
      const id = a(ar, "id");
      const cols = columnNames(ar.column);
      if (!id || cols.length === 0) continue;
      attrRefs++;
      const list = attrMap.get(id) ?? [];
      list.push({ dataset: datasetName, column: cols[0], cube });
      attrMap.set(id, list);
    }
    return { keyRefs, attrRefs };
  }

  for (const dsSec of arr(schemaEl["data-sets"])) {
    for (const ds of arr(dsSec["data-set"])) {
      const name = a(ds, "name");
      const id = a(ds, "id");
      if (!name || !id) continue;
      datasetIdToName.set(id, name);

      const props = first(arr(ds.properties)) as El | undefined;
      const allowAggregates = props ? s(first(arr(props["allow-aggregates"]))) === "true" : undefined;

      const physEl = first(arr(ds.physical)) as El | undefined;
      const connEl = physEl ? (first(arr(physEl.connection)) as El | undefined) : undefined;
      const connectionId = connEl ? a(connEl, "id") : undefined;
      if (connectionId) connectionIds.add(connectionId);

      const tableEl = physEl ? (first(arr(physEl.table)) as El | undefined) : undefined;
      const table = tableEl
        ? { database: s(first(arr(tableEl.database))), schema: s(first(arr(tableEl.schema))), name: s(first(arr(tableEl.name))) }
        : undefined;

      const queryEl = physEl ? (first(arr(physEl.query)) as El | undefined) : undefined;
      const sql = queryEl ? s(first(arr(queryEl.sql))) : undefined;

      const immutable = physEl ? s(first(arr(physEl.immutable))) === "true" : undefined;

      const columns = physEl
        ? arr(physEl.column).map((c) => ({ name: s(first(arr(c.name))) ?? "", type: s(first(arr(c.type))), sql: s(first(arr(c.sql))) }))
            .filter((c) => c.name)
        : [];

      let keyRefCount = 0;
      let attrRefCount = 0;
      for (const logSec of arr(ds.logical)) {
        const { keyRefs, attrRefs } = ingestLogical(logSec, name);
        keyRefCount += keyRefs;
        attrRefCount += attrRefs;
      }

      datasets.push({ name, id, allowAggregates, connectionId, table, sql, immutable, columns, keyRefCount, attrRefCount });
    }
  }

  // ── Phase 2: schema-level attribute library ────────────────────────────────

  const attrDef = new Map<string, AttrDef>();
  function ingestKeyedAttrs(container: El): void {
    for (const ka of arr(container["keyed-attribute"])) {
      const id = a(ka, "id");
      const name = a(ka, "name");
      if (!id || !name) continue;
      const props = first(arr(ka.properties)) as El | undefined;
      const fmtEl = props ? (first(arr(props.formatting)) as El | undefined) : undefined;
      const allowedEl = props ? (first(arr(props["allowed-calculation-types"])) as El | undefined) : undefined;
      attrDef.set(id, {
        id,
        name,
        caption: props ? s(first(arr(props.caption))) : undefined,
        keyUuid: a(ka, "key-ref"),
        visible: props ? s(first(arr(props.visible))) !== "false" : true,
        folder: props ? s(first(arr(props.folder))) : undefined,
        description: props ? s(first(arr(props.description))) : undefined,
        format: fmtEl ? (s(first(arr(fmtEl["format-string"]))) ?? s(first(arr(fmtEl["named-format"])))) : undefined,
        allowedCalcTypes: allowedEl ? arr(allowedEl["calculation-type"]).map((c) => s(c) ?? "").filter(Boolean) : [],
      });
    }
  }
  for (const attrsSec of arr(schemaEl.attributes)) ingestKeyedAttrs(attrsSec);

  // ── Phase 3: schema-level calculated-member formula library ────────────────

  const calcMemberDef = new Map<string, CalcMemberDef>();
  for (const cmSec of arr(schemaEl["calculated-members"])) {
    for (const cm of arr(cmSec["calculated-member"])) {
      const id = a(cm, "id");
      const name = a(cm, "name");
      if (!id || !name) continue;
      const props = first(arr(cm.properties)) as El | undefined;
      const fmtEl = props ? (first(arr(props.formatting)) as El | undefined) : undefined;
      calcMemberDef.set(id, {
        id,
        name,
        caption: props ? s(first(arr(props.caption))) : undefined,
        visible: props ? s(first(arr(props.visible))) !== "false" : true,
        folder: props ? s(first(arr(props.folder))) : undefined,
        description: props ? s(first(arr(props.description))) : undefined,
        format: fmtEl ? (s(first(arr(fmtEl["format-string"]))) ?? s(first(arr(fmtEl["named-format"])))) : undefined,
        expression: s(first(arr(cm.expression))),
      });
    }
  }

  // ── Phase 4: schema-level dimensions ────────────────────────────────────────

  // Schema-level dims are kept separately (name → element) for <dimension-ref>
  // resolution — a cube can reference one by id without redefining it inline.
  const schemaDims = new Map<string, El>();
  for (const dimsSec of arr(schemaEl.dimensions)) {
    for (const dim of arr(dimsSec.dimension)) {
      const name = a(dim, "name");
      if (name) schemaDims.set(name, dim);
    }
  }

  // Every dimension DEFINITION found anywhere — schema-level plus every cube's own
  // inline ones — kept as a flat, scope-tagged list (not deduplicated by name).
  // A cube can define its own "Cal End Date" distinct from another cube's "Cal End
  // Date" (same display name, different id, different columns) — collapsing them
  // by name would hide exactly that kind of real-world modeling inconsistency, so
  // every definition gets its own entry, sorted by name so same-named ones from
  // different scopes land next to each other for easy comparison.
  interface DimEntry { name: string; scope: string; el: El }
  const dimEntries: DimEntry[] = [];
  for (const dim of schemaDims.values()) {
    const name = a(dim, "name");
    if (name) dimEntries.push({ name, scope: "schema-level", el: dim });
  }

  // ── Phase 5: cubes — need each cube's OWN data-set-ref key-refs/attribute-refs
  //    ingested into keyMap/attrMap (tagged with the cube name) so joins and
  //    measure/dimension dataset bindings resolve per cube, same as datasets. ──

  const cubeEls = arr(schemaEl.cubes).flatMap((c) => arr(c.cube));
  for (const cube of cubeEls) {
    const cubeName = a(cube, "name") ?? "";
    for (const attrsSec of arr(cube.attributes)) ingestKeyedAttrs(attrsSec); // cube-scoped keyed-attributes, if any
    for (const dsSec of arr(cube["data-sets"])) {
      for (const dsRef of arr(dsSec["data-set-ref"])) {
        const refId = a(dsRef, "id");
        const dsName = refId ? datasetIdToName.get(refId) ?? refId : undefined;
        if (!dsName) continue;
        for (const logSec of arr(dsRef.logical)) ingestLogical(logSec, dsName, cubeName);
      }
    }
    for (const dimsSec of arr(cube.dimensions)) {
      for (const dim of arr(dimsSec.dimension)) {
        const name = a(dim, "name");
        if (name) dimEntries.push({ name, scope: `cube: ${cubeName}`, el: dim });
      }
    }
  }
  dimEntries.sort((x, y) => x.name.localeCompare(y.name));

  // ============================================================
  // Rendering
  // ============================================================

  const out: string[] = [];

  const hasRoles = arr(schemaEl.roles).length > 0 || arr(schemaEl.role).length > 0;
  const hasPerspectives = arr(schemaEl.perspectives).length > 0 || arr(schemaEl.perspective).length > 0;
  const hasTranslations = arr(schemaEl.translations).length > 0 || arr(schemaEl.translation).length > 0;
  const perspectiveNames = arr(schemaEl.perspectives).flatMap((p) => arr(p.perspective)).map((p) => a(p, "name") ?? "").filter(Boolean);

  const totalHierarchies = dimEntries.reduce((n, d) => n + arr(d.el.hierarchy).length, 0);
  const totalLevels = dimEntries.reduce(
    (n, d) => n + arr(d.el.hierarchy).reduce((k, h) => k + arr(h.level).length, 0),
    0,
  );
  const totalMeasures = cubeEls.reduce(
    (n, c) => n + arr(c.attributes).reduce((k, s2) => k + arr(s2.attribute).filter((el) => !isQuantileGroupAttribute(el as El)).length, 0),
    0,
  );
  const totalNamedSets = cubeEls.reduce((n, c) => n + arr(c["named-sets"]).reduce((k, s2) => k + arr(s2["named-set"]).length, 0), 0);
  const totalKpis = cubeEls.reduce((n, c) => n + arr(c.kpis).reduce((k, s2) => k + arr(s2.kpi).length, 0), 0);
  const totalAggregates = cubeEls.reduce((n, c) => n + arr(c.aggregates).reduce((k, s2) => k + arr(s2.aggregate).length, 0), 0);

  // ── Header ──────────────────────────────────────────────────────────────────

  out.push(`# ${title}`, "");
  if (opts.xmlFileName) out.push(`> Source: \`${opts.xmlFileName}\``, "");

  out.push("## Summary", "");
  out.push(
    ...table(
      ["Object", "Count"],
      [
        ["Cubes / Models", String(cubeEls.length)],
        ["Datasets", String(datasets.length)],
        ["Connections", String(connectionIds.size)],
        ["Schema-level attributes", String(attrDef.size)],
        ["Dimensions", String(dimEntries.length)],
        ["Hierarchies", String(totalHierarchies)],
        ["Levels", String(totalLevels)],
        ["Measures", String(totalMeasures)],
        ["Calculated members", String(calcMemberDef.size)],
        ["User Defined Aggregates", String(totalAggregates)],
        ["Named sets", String(totalNamedSets)],
        ["KPIs", String(totalKpis)],
        ["Perspectives", String(perspectiveNames.length)],
      ].filter((r) => r[1] !== "0"),
    ),
  );

  const structural: string[] = [];
  if (hasRoles) structural.push("- Security roles are defined in this schema (not detailed below — no SML equivalent).");
  if (hasTranslations) structural.push("- Translations are defined in this schema (not detailed below — no SML equivalent).");
  if (structural.length) out.push(...structural, "");

  // ── Table of contents ──────────────────────────────────────────────────────

  const sections = ["Connections", "Datasets", "Attribute Library", "Dimensions", "Cubes"];
  if (calcMemberDef.size) sections.push("Calculated Member Library");
  if (perspectiveNames.length) sections.push("Perspectives");

  out.push("## Table of Contents", "");
  for (const sec of sections) out.push(`- [${sec}](#${anchor(sec)})`);
  out.push("");

  // ── Connections ─────────────────────────────────────────────────────────────

  out.push("## Connections", "");
  if (connectionIds.size) {
    const rows = [...connectionIds].sort().map((id) => [
      code(id),
      String(datasets.filter((d) => d.connectionId === id).length),
    ]);
    out.push(...table(["Connection id", "Datasets using it"], rows));
  } else {
    out.push("_No connections found._", "");
  }

  // ── Datasets ────────────────────────────────────────────────────────────────

  out.push("## Datasets", "");
  for (const ds of datasets) renderDataset(out, ds);

  // ── Attribute Library ────────────────────────────────────────────────────────

  out.push("## Attribute Library", "");
  out.push(
    "Schema-level keyed attributes are the shared building blocks dimensions and levels reference by id; this is every one defined in the schema, whether or not a dimension currently uses it.",
    "",
  );
  if (attrDef.size) {
    const rows = [...attrDef.values()].map((def) => {
      const bindings = def.keyUuid ? keyMap.get(def.keyUuid) ?? [] : [];
      const boundTo = bindings.map((b) => `${b.dataset}.${b.columns.join("+")}`).join(", ");
      return [
        code(def.name),
        cell(def.caption),
        code(boundTo),
        cell(def.folder),
        def.allowedCalcTypes.join(", "),
        code(def.format),
        flag(!def.visible) ? "hidden" : "",
      ];
    });
    out.push(...table(["Attribute", "Caption", "Bound to (dataset.column)", "Folder", "Allowed DMA calcs", "Format", ""], rows));
  } else {
    out.push("_No schema-level attributes defined._", "");
  }

  // ── Dimensions ──────────────────────────────────────────────────────────────

  out.push("## Dimensions", "");
  const dimNameCounts = new Map<string, number>();
  for (const d of dimEntries) dimNameCounts.set(d.name, (dimNameCounts.get(d.name) ?? 0) + 1);
  const collidingNames = [...dimNameCounts.entries()].filter(([, n]) => n > 1).map(([n]) => n);
  if (collidingNames.length) {
    out.push(
      `**Note:** ${collidingNames.length} dimension name(s) are defined more than once across different scopes (schema-level and/or different cubes) — ${collidingNames.map((n) => `\`${n}\``).join(", ")}. These may be intentionally distinct per-cube definitions, or an unintended naming collision; compare their bindings below.`,
      "",
    );
  }
  for (const { name, scope, el } of dimEntries) renderDimension(out, name, scope, el);

  // ── Cubes ───────────────────────────────────────────────────────────────────

  out.push("## Cubes", "");
  for (const cube of cubeEls) renderCube(out, cube);

  // ── Calculated Member Library ────────────────────────────────────────────────

  if (calcMemberDef.size) {
    out.push("## Calculated Member Library", "");
    out.push(
      "Schema-level calculated-member definitions are named formulas cubes reference by id; this is every one defined in the schema, whether or not a cube currently uses it.",
      "",
    );
    for (const cm of calcMemberDef.values()) {
      out.push(`### ${cm.name}`, "");
      if (cm.caption && cm.caption !== cm.name) out.push(cell(cm.caption), "");
      const meta: string[] = [];
      if (cm.folder) meta.push(`- Folder: \`${cell(cm.folder)}\``);
      if (cm.format) meta.push(`- Format: \`${cell(cm.format)}\``);
      if (!cm.visible) meta.push(`- Hidden`);
      if (cm.description) meta.push(`- ${cell(cm.description)}`);
      if (meta.length) out.push(...meta, "");
      if (cm.expression) out.push("```", cm.expression.trim(), "```", "");
    }
  }

  // ── Perspectives ─────────────────────────────────────────────────────────────

  if (perspectiveNames.length) {
    out.push("## Perspectives", "");
    out.push(...perspectiveNames.map((n) => `- ${cell(n)}`), "");
  }

  out.push("---", "", "_Generated by `atscale-utils generate-report-from-xml`._", "");
  return out.join("\n");

  // ============================================================
  // Section renderers (closures over the phase-1..5 maps above)
  // ============================================================

  function renderDataset(o: string[], ds: DatasetDef): void {
    o.push(`### ${ds.name}`, "");
    const meta: string[] = [];
    if (ds.connectionId) meta.push(`- Connection: \`${cell(ds.connectionId)}\``);
    if (ds.table) meta.push(`- Table: \`${cell([ds.table.database, ds.table.schema, ds.table.name].filter(Boolean).join("."))}\``);
    if (ds.sql) meta.push(`- Backed by a SQL query (view)`);
    if (ds.allowAggregates !== undefined) meta.push(`- Allow aggregates: ${ds.allowAggregates ? "yes" : "no"}`);
    if (ds.immutable !== undefined) meta.push(`- Immutable: ${ds.immutable ? "yes" : "no"}`);
    meta.push(`- Used by ${ds.keyRefCount} key-ref(s) and ${ds.attrRefCount} attribute-ref(s) across all cubes`);
    o.push(...meta, "");
    if (ds.sql) o.push("```sql", ds.sql.trim(), "```", "");
    if (ds.columns.length) {
      o.push(...table(["Column", "Type", "Expression"], ds.columns.map((c) => [code(c.name), code(c.type), code(c.sql)])));
    }
    o.push("");
  }

  /** Resolve a keyed-attribute's own key-ref to every dataset.column binding found anywhere. */
  function resolveAttrBindings(keyUuid: string | undefined): KeyBinding[] {
    return keyUuid ? keyMap.get(keyUuid) ?? [] : [];
  }

  function bindingLabel(bindings: KeyBinding[]): string {
    return bindings.map((b) => `${b.dataset}.${b.columns.join("+")}${b.cube ? ` (${b.cube})` : ""}`).join(", ");
  }

  function renderDimension(o: string[], name: string, scope: string, dimEl: El): void {
    const props = first(arr(dimEl.properties)) as El | undefined;
    const dimType = props ? s(first(arr(props["dimension-type"]))) : undefined;
    o.push(`### ${name}  \`${scope}\`${dimType ? `  \`${dimType}\`` : ""}`, "");
    if (props?.description) o.push(cell(s(first(arr(props.description)))), "");

    for (const hier of arr(dimEl.hierarchy)) {
      const hierName = a(hier, "name") ?? "Hierarchy";
      const hProps = first(arr(hier.properties)) as El | undefined;
      const caption = hProps ? s(first(arr(hProps.caption))) : undefined;
      o.push(`**Hierarchy: ${cell(caption ?? hierName)}**`, "");

      const levelRows: string[][] = [];
      const secondaryRows: string[][] = [];
      for (const level of arr(hier.level)) {
        const primaryId = a(level, "primary-attribute");
        const def = primaryId ? attrDef.get(primaryId) : undefined;
        const lProps = first(arr(level.properties)) as El | undefined;
        const visible = lProps ? s(first(arr(lProps.visible))) !== "false" : true;
        const levelType = lProps ? s(first(arr(lProps["level-type"]))) : undefined;
        const bindings = resolveAttrBindings(def?.keyUuid);

        levelRows.push([
          code(def?.name ?? primaryId ?? "?"),
          cell(def?.caption),
          code(bindingLabel(bindings)),
          cell(levelType),
          flag(!visible) ? "hidden" : "",
          def?.allowedCalcTypes.join(", ") ?? "",
        ]);

        for (const kref of arr(level["keyed-attribute-ref"])) {
          const attrId = a(kref, "attribute-id");
          const role = a(kref, "role");
          const refId = a(kref, "ref-id");
          if (!attrId) continue;
          const kaDef = attrDef.get(attrId);
          const kaBindings = resolveAttrBindings(kaDef?.keyUuid);
          secondaryRows.push([
            code(def?.name ?? primaryId ?? "?"),
            code(kaDef?.name ?? attrId),
            cell(kaDef?.caption),
            role ? cell(role) : refId ? "embedded ref" : "secondary",
            code(bindingLabel(kaBindings)),
          ]);
        }
      }

      if (levelRows.length) {
        o.push(...table(["Level (primary attribute)", "Caption", "Bound to (dataset.column)", "Level type", "Hidden", "Allowed DMA calcs"], levelRows));
      }
      if (secondaryRows.length) {
        o.push("Level attributes (name/sort overrides and secondary attributes):", "");
        o.push(...table(["Level", "Attribute", "Caption", "Role", "Bound to (dataset.column)"], secondaryRows));
      }
    }
    o.push("");
  }

  /** The cube's fact dataset for name-based column guesses: the first <data-set-ref>. */
  function getFactDatasetName(cube: El): string | undefined {
    for (const dsSec of arr(cube["data-sets"])) {
      for (const dsRef of arr(dsSec["data-set-ref"])) {
        const refId = a(dsRef, "id");
        if (refId) return datasetIdToName.get(refId) ?? refId;
      }
    }
    return undefined;
  }

  function renderCube(o: string[], cube: El): void {
    const cubeName = a(cube, "name") ?? "?";
    const props = first(arr(cube.properties)) as El | undefined;
    const visible = props ? s(first(arr(props.visible))) !== "false" : true;
    o.push(`### ${cubeName}${!visible ? "  \`hidden\`" : ""}`, "");

    // Datasets used by this cube.
    const dsRefs: string[] = [];
    for (const dsSec of arr(cube["data-sets"])) {
      for (const dsRef of arr(dsSec["data-set-ref"])) {
        const refId = a(dsRef, "id");
        const dsName = refId ? datasetIdToName.get(refId) ?? refId : undefined;
        if (dsName) dsRefs.push(dsName);
      }
    }
    if (dsRefs.length) o.push(`**Datasets:** ${dsRefs.map((d) => `\`${d}\``).join(", ")}`, "");

    // Joins: this cube's own key-ref bindings, resolved against every dimension's
    // keyed-attribute to show which fact dataset joins to which dimension level
    // on which column(s) — the actual join graph, independent of SML shaping.
    const joinRows: string[][] = [];
    for (const [dimName, dimEl] of schemaDims) {
      for (const hier of arr(dimEl.hierarchy)) {
        for (const level of arr(hier.level)) {
          const primaryId = a(level, "primary-attribute");
          const def = primaryId ? attrDef.get(primaryId) : undefined;
          if (!def?.keyUuid) continue;
          for (const b of keyMap.get(def.keyUuid) ?? []) {
            if (b.cube !== cubeName) continue;
            joinRows.push([code(b.dataset), code(b.columns.join(", ")), code(dimName), code(def.name), b.unique ? "yes" : ""]);
          }
        }
      }
    }
    // Cube-local (inline) dimensions also participate in joins — walk them too.
    for (const dimsSec of arr(cube.dimensions)) {
      for (const dim of arr(dimsSec.dimension)) {
        const dimName = a(dim, "name") ?? "?";
        for (const hier of arr(dim.hierarchy)) {
          for (const level of arr(hier.level)) {
            const primaryId = a(level, "primary-attribute");
            const def = primaryId ? attrDef.get(primaryId) : undefined;
            if (!def?.keyUuid) continue;
            for (const b of keyMap.get(def.keyUuid) ?? []) {
              if (b.cube !== cubeName) continue;
              joinRows.push([code(b.dataset), code(b.columns.join(", ")), code(dimName), code(def.name), b.unique ? "yes" : ""]);
            }
          }
        }
      }
    }
    if (joinRows.length) {
      o.push("**Joins (fact dataset → dimension level)**", "");
      o.push(...table(["From dataset", "Join column(s)", "To dimension", "To level", "Unique"], joinRows));
    }

    // Dimensions used (inline + refs).
    const dimNames: string[] = [];
    for (const dimsSec of arr(cube.dimensions)) {
      for (const dim of arr(dimsSec.dimension)) dimNames.push(`${a(dim, "name") ?? "?"} (cube-local)`);
      for (const dimRef of arr(dimsSec["dimension-ref"])) {
        const refId = a(dimRef, "id");
        const found = [...schemaDims.entries()].find(([, d]) => a(d, "id") === refId);
        dimNames.push(found ? found[0] : refId ?? "?");
      }
    }
    if (dimNames.length) o.push(`**Dimensions used:** ${dimNames.map((d) => `\`${d}\``).join(", ")}`, "");

    // Quantile-group definitions (the AtScale representation of a percentile measure's base
    // attribute id + compression setting, referenced by id from one or more
    // <quantile-instance> attributes) are hidden plumbing, not standalone measures — collected
    // up front so the measures loop below can resolve each quantile-instance's real
    // dataset/column and compression instead of falling back to a naive, wrong guess.
    const quantileGroupDefs = new Map<string, { baseAttrId?: string; compression?: string }>();
    for (const attrsSec of arr(cube.attributes)) {
      for (const attrEl of arr(attrsSec.attribute)) {
        const attrId = a(attrEl, "id");
        if (!attrId) continue;
        const props = first(arr(attrEl.properties)) as El | undefined;
        const typeEl = props ? (first(arr(props.type)) as El | undefined) : undefined;
        const qgEl = typeEl ? (first(arr(typeEl["quantile-group"])) as El | undefined) : undefined;
        if (!qgEl) continue;
        const baseRefEl = first(arr(qgEl["attribute-ref"])) as El | undefined;
        quantileGroupDefs.set(attrId, {
          baseAttrId: baseRefEl ? a(baseRefEl, "id") : undefined,
          compression: s(first(arr(qgEl.compression))),
        });
      }
    }

    // Measures.
    const measureRows: string[][] = [];
    for (const attrsSec of arr(cube.attributes)) {
      for (const attrEl of arr(attrsSec.attribute)) {
        if (isQuantileGroupAttribute(attrEl)) continue; // hidden plumbing — see quantileGroupDefs above
        const name = a(attrEl, "name") ?? "?";
        const attrId = a(attrEl, "id");
        const mProps = first(arr(attrEl.properties)) as El | undefined;
        const caption = mProps ? s(first(arr(mProps.caption))) : undefined;
        const mVisible = mProps ? s(first(arr(mProps.visible))) !== "false" : true;
        const folder = mProps ? s(first(arr(mProps.folder))) : undefined;
        const typeEl = mProps ? (first(arr(mProps.type)) as El | undefined) : undefined;
        const measureEl = typeEl ? (first(arr(typeEl.measure)) as El | undefined) : undefined;
        const countDistEl = typeEl ? (first(arr(typeEl["count-distinct"])) as El | undefined) : undefined;
        const countNonNullEl = typeEl ? (first(arr(typeEl["count-nonnull"])) as El | undefined) : undefined;
        const quantileInstanceEl = typeEl ? (first(arr(typeEl["quantile-instance"])) as El | undefined) : undefined;
        const exprEl = s(first(arr(attrEl.expression)));

        let kind: string;
        let agg = "";
        let semiAdditive = "";
        if (measureEl) {
          kind = "measure";
          agg = s(first(arr(measureEl["default-aggregation"]))) ?? "SUM";
          const additivityEl = first(arr(measureEl.additivity)) as El | undefined;
          const subspaceEl = additivityEl ? (first(arr(additivityEl.subspace)) as El | undefined) : undefined;
          if (subspaceEl) {
            const fn = s(first(arr(subspaceEl["aggregation-function"])));
            semiAdditive = fn ?? "";
          }
        } else if (countDistEl) {
          kind = "count-distinct";
        } else if (countNonNullEl) {
          kind = "count-nonnull";
        } else if (quantileInstanceEl) {
          kind = "percentile";
          const quantileVal = s(first(arr(quantileInstanceEl["quantile-val"])));
          agg = quantileVal ? `p${quantileVal}` : "percentile";
        } else if (exprEl) {
          kind = "calculated";
        } else {
          kind = "unknown";
        }

        // Resolve the fact-side column: prefer an inline <key-ref> under the measure's own
        // <measure>/<count-distinct>/<count-nonnull> element (resolved through keyMap, same
        // as a dimension level attribute), then an <attribute-ref> registered for this
        // attribute id in the cube's own data-set-ref, then — for a percentile measure — the
        // binding of the base attribute its quantile-group points to by id. Only after all
        // three come up empty does this fall back to a naming-convention guess (e.g. "m_FOO_sum"
        // → column FOO on the cube's first fact dataset), clearly labeled as inferred rather
        // than declared, since it is not a fact stated anywhere in the XML.
        const measureTypeEl = measureEl ?? countDistEl ?? countNonNullEl;
        const inlineKeyRefEl = measureTypeEl ? (first(arr(measureTypeEl["key-ref"])) as El | undefined) : undefined;
        const inlineKeyRefId = inlineKeyRefEl ? a(inlineKeyRefEl, "id") : undefined;
        const inlineBindings = inlineKeyRefId ? keyMap.get(inlineKeyRefId) ?? [] : [];
        const attrBindings = attrId ? attrMap.get(attrId)?.filter((b) => b.cube === cubeName) ?? [] : [];

        const quantileGroupRefEl = quantileInstanceEl ? (first(arr(quantileInstanceEl["quantile-group-ref"])) as El | undefined) : undefined;
        const quantileGroupRefId = quantileGroupRefEl ? a(quantileGroupRefEl, "id") : undefined;
        const quantileBaseAttrId = quantileGroupRefId ? quantileGroupDefs.get(quantileGroupRefId)?.baseAttrId : undefined;
        const quantileBindings = quantileBaseAttrId ? attrMap.get(quantileBaseAttrId)?.filter((b) => b.cube === cubeName) ?? [] : [];

        let boundTo: string;
        if (inlineBindings.length) {
          boundTo = inlineBindings.map((b) => `${b.dataset}.${b.columns.join("+")}`).join(", ");
        } else if (attrBindings.length) {
          boundTo = attrBindings.map((b) => `${b.dataset}.${b.column}`).join(", ");
        } else if (quantileBindings.length) {
          boundTo = quantileBindings.map((b) => `${b.dataset}.${b.column}`).join(", ");
        } else {
          const guessedDataset = getFactDatasetName(cube);
          boundTo = guessedDataset ? `${guessedDataset}.${parseColumnFromAttrName(name)} (inferred)` : "";
        }

        measureRows.push([
          code(name),
          cell(caption),
          kind,
          code(agg),
          semiAdditive,
          code(boundTo),
          cell(folder),
          flag(!mVisible) ? "hidden" : "",
        ]);
      }
    }
    if (measureRows.length) {
      o.push("**Measures**", "");
      o.push(...table(["Name", "Caption", "Kind", "Aggregation", "Semi-additive", "Bound to (dataset.column)", "Folder", "Hidden"], measureRows));
    }

    // Calculated members used by this cube (resolved against the schema library).
    const calcRows: string[][] = [];
    for (const cmSec of arr(cube["calculated-members"])) {
      for (const cmRef of arr(cmSec["calculated-member-ref"])) {
        const refId = a(cmRef, "id");
        const def = refId ? calcMemberDef.get(refId) : undefined;
        if (!def) continue;
        calcRows.push([code(def.name), cell(def.caption), code(def.expression), cell(def.folder), flag(!def.visible) ? "hidden" : ""]);
      }
    }
    if (calcRows.length) {
      o.push("**Calculated members used**", "");
      o.push(...table(["Name", "Caption", "Formula", "Folder", "Hidden"], calcRows));
    }

    // User Defined Aggregates.
    const aggRows: string[][] = [];
    for (const aggsSec of arr(cube.aggregates)) {
      for (const aggEl of arr(aggsSec.aggregate)) {
        const aggName = a(aggEl, "name") ?? "?";
        const targetConn = s(first(arr(aggEl["target-connection"])));
        const attrIds: string[] = [];
        for (const attrsWrap of arr(aggEl.attributes)) {
          for (const attrRef of arr(attrsWrap["attribute-ref"])) {
            const refId = a(attrRef, "id");
            const def = refId ? attrDef.get(refId) : undefined;
            attrIds.push(def?.name ?? refId ?? "?");
          }
        }
        aggRows.push([code(aggName), code(targetConn), String(attrIds.length), attrIds.map((n) => `\`${n}\``).join(", ")]);
      }
    }
    if (aggRows.length) {
      o.push("**User Defined Aggregates**", "");
      o.push(...table(["Name", "Target connection", "# attributes", "Attributes"], aggRows));
    }

    // Named sets / KPIs (presence-only — no SML equivalent, but the user should
    // know they exist and what they're called).
    const namedSets = arr(cube["named-sets"]).flatMap((s2) => arr(s2["named-set"])).map((n) => a(n, "name") ?? "?");
    if (namedSets.length) o.push(`**Named sets:** ${namedSets.map((n) => `\`${n}\``).join(", ")}`, "");
    const kpis = arr(cube.kpis).flatMap((s2) => arr(s2.kpi)).map((k) => a(k, "name") ?? "?");
    if (kpis.length) o.push(`**KPIs:** ${kpis.map((n) => `\`${n}\``).join(", ")}`, "");

    // Drillthrough.
    const actionsEl = first(arr(cube.actions)) as El | undefined;
    const actionPropsEl = actionsEl ? (first(arr(actionsEl.properties)) as El | undefined) : undefined;
    const drillthrough = actionPropsEl ? s(first(arr(actionPropsEl["include-default-drill-through"]))) === "true" : undefined;
    if (drillthrough !== undefined) o.push(`**Default drillthrough:** ${drillthrough ? "enabled" : "disabled"}`, "");

    o.push("", "---", "");
  }
}
