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
 * ones the converter deliberately skips (roles, translations, named sets, KPIs)
 * so the report is a complete inventory of the source model.
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

/** True only when `<properties><visible>` is explicitly `false` — matches xml-converter.ts's
 *  isExplicitlyHidden, the same "absent means visible" convention used for perspective hide-lists. */
function isExplicitlyHidden(el: El): boolean {
  const props = first(arr(el.properties)) as El | undefined;
  return (props ? s(first(arr(props.visible))) : undefined) === "false";
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
  /** `<ref-path><new-ref><ref-naming>` template (e.g. "Ship Date - {0}") when this
   *  key-ref is a role-played binding to the target dimension, undefined otherwise. */
  rolePlay?: string;
}

interface AttrBinding {
  dataset: string;
  column: string;
  cube?: string;
}

interface AttrDef {
  id: string;
  name: string;
  /** Label to render in the report — `name` by default, but disambiguated (see the
   *  pass after Phase 5 below) when two distinct attribute ids only differ by
   *  whitespace that the `cell()`/`code()` Markdown helpers trim away. Table cells
   *  must use this instead of `name` directly, or two genuinely different attributes
   *  print as the identical label. */
  displayName: string;
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
  // Populated alongside `datasets` in Phase 1 so a measure/attribute with no real
  // binding can look up its guessed dataset's own columns (see the "inferred" guess
  // below) without a second pass over `datasets`.
  const datasetByName = new Map<string, DatasetDef>();
  const keyMap = new Map<string, KeyBinding[]>();
  const attrMap = new Map<string, AttrBinding[]>();
  const connectionIds = new Set<string>();
  // A key-ref's <ref-path> can carry a plain <ref id="X"/> instead of a role-play <new-ref>
  // — the "bridge" a cross-dimension embedded <keyed-attribute-ref ref-id="X"> uses to reach
  // its target dimension's real key (see the Phase 6 snowflake-embed resolution below, and
  // xml-converter.ts's own refPathIdToKeyRefId/resolveSnowflakeRelationship, which this
  // mirrors). Maps that ref id to the key-ref's own id, so all of that id's bindings
  // (already collected in keyMap) can be looked up.
  const refPathIdToKeyRefId = new Map<string, string>();

  function ingestLogical(logicalEl: El, datasetName: string, cube?: string): void {
    for (const kr of arr(logicalEl["key-ref"])) {
      const id = a(kr, "id");
      const cols = columnNames(kr.column);
      if (!id || cols.length === 0) continue;
      const refPathEl = first(arr(kr["ref-path"])) as El | undefined;
      const newRefEl = refPathEl ? (first(arr(refPathEl["new-ref"])) as El | undefined) : undefined;
      const rolePlay = newRefEl ? s(first(arr(newRefEl["ref-naming"]))) : undefined;
      const plainRefEl = refPathEl ? (first(arr(refPathEl.ref)) as El | undefined) : undefined;
      const bridgedRefId = plainRefEl ? a(plainRefEl, "id") : undefined;
      if (bridgedRefId && !refPathIdToKeyRefId.has(bridgedRefId)) refPathIdToKeyRefId.set(bridgedRefId, id);
      const list = keyMap.get(id) ?? [];
      list.push({ dataset: datasetName, columns: cols, complete: a(kr, "complete") ?? "true", unique: a(kr, "unique") === "true", cube, rolePlay });
      keyMap.set(id, list);
    }
    for (const ar of arr(logicalEl["attribute-ref"])) {
      const id = a(ar, "id");
      const cols = columnNames(ar.column);
      if (!id || cols.length === 0) continue;
      const list = attrMap.get(id) ?? [];
      list.push({ dataset: datasetName, column: cols[0], cube });
      attrMap.set(id, list);
    }
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

      // A dataset can declare multiple <query> elements: the base query (no "alternate"
      // attribute) plus alternate query/table bindings (alternate="true") — alternates are
      // preview-only, so picking whichever <query> comes first in document order can
      // misreport an alternate binding as the dataset's real SQL backing.
      const queryEl = physEl ? (arr(physEl.query).find((q) => !a(q, "alternate")) as El | undefined) : undefined;
      const sql = queryEl ? s(first(arr(queryEl.sql))) : undefined;

      const immutable = physEl ? s(first(arr(physEl.immutable))) === "true" : undefined;

      const columns = physEl
        ? arr(physEl.column).map((c) => ({ name: s(first(arr(c.name))) ?? "", type: s(first(arr(c.type))), sql: s(first(arr(c.sql))) }))
            .filter((c) => c.name)
        : [];

      // keyRefCount/attrRefCount are filled in later, once Phase 5 has run — see the
      // "used across cubes" tally below. ingestLogical still runs here so keyMap/attrMap
      // are populated for join resolution, but its return value is intentionally unused:
      // a dataset's own top-level <logical> block is every key-ref/attribute-ref it
      // declares about its own columns, whether or not any cube ever joins to it (e.g. a
      // fully-defined but otherwise orphaned dimension table), so it cannot answer "is
      // this dataset actually used" on its own.
      for (const logSec of arr(ds.logical)) ingestLogical(logSec, name);

      const datasetDef = { name, id, allowAggregates, connectionId, table, sql, immutable, columns, keyRefCount: 0, attrRefCount: 0 };
      datasets.push(datasetDef);
      datasetByName.set(name, datasetDef);
    }
  }

  // ── Phase 2: schema-level attribute library ────────────────────────────────

  const attrDef = new Map<string, AttrDef>();
  // id → name for every plain <attribute> (measures and other non-keyed attributes)
  // alongside every <keyed-attribute>, spanning schema- and cube-level scopes.
  // attrDef itself stays keyed-attribute-only — it backs the Attribute Library
  // section and its count, which should not include measures — but anything that
  // resolves an attribute-ref id to a display name (e.g. a User Defined
  // Aggregate's attribute list, which can point at a measure's plain <attribute>
  // or — via calcMemberDef, checked as a further fallback where this map is used —
  // a calculated member) needs the full id space, or the ref renders as a raw
  // internal UUID instead of a name.
  const attrNameById = new Map<string, string>();
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
        displayName: name, // recomputed once every keyed-attribute is known — see below
        caption: props ? s(first(arr(props.caption))) : undefined,
        keyUuid: a(ka, "key-ref"),
        visible: props ? s(first(arr(props.visible))) !== "false" : true,
        folder: props ? s(first(arr(props.folder))) : undefined,
        description: props ? s(first(arr(props.description))) : undefined,
        format: fmtEl ? (s(first(arr(fmtEl["format-string"]))) ?? s(first(arr(fmtEl["named-format"])))) : undefined,
        allowedCalcTypes: allowedEl ? arr(allowedEl["calculation-type"]).map((c) => s(c) ?? "").filter(Boolean) : [],
      });
      attrNameById.set(id, name);
    }
    for (const attrEl of arr(container.attribute)) {
      const id = a(attrEl, "id");
      const name = a(attrEl, "name");
      if (id && name) attrNameById.set(id, name);
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

  // Datasets at least one cube actually references via a data-set-ref — the same
  // criterion generate-sml-from-xml's xml-converter.ts uses (referencedDatasetNames)
  // to decide which datasets survive conversion. Tracked here, alongside keyMap/attrMap
  // ingestion, so the Summary's "used by a cube" rollup can report the identical subset
  // SML ends up with, next to this report's own schema-wide totals.
  const usedDatasetNames = new Set<string>();
  const cubeEls = arr(schemaEl.cubes).flatMap((c) => arr(c.cube));
  for (const cube of cubeEls) {
    const cubeName = a(cube, "name") ?? "";
    for (const attrsSec of arr(cube.attributes)) ingestKeyedAttrs(attrsSec); // cube-scoped keyed-attributes, if any
    for (const dsSec of arr(cube["data-sets"])) {
      for (const dsRef of arr(dsSec["data-set-ref"])) {
        const refId = a(dsRef, "id");
        const dsName = refId ? datasetIdToName.get(refId) ?? refId : undefined;
        if (!dsName) continue;
        usedDatasetNames.add(dsName);
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

  // Disambiguate keyed-attribute display names that collide only because the report's
  // cell()/code() Markdown helpers trim leading/trailing whitespace. A source schema can
  // define two distinct <keyed-attribute> ids with names like "Foo" and "Foo " (e.g. to
  // give a second, otherwise identically-captioned attribute a unique raw name) — left
  // untrimmed they're already distinguishable, but every table in this report renders
  // through cell()/code(), so both would print as the exact same label, making two real,
  // separately-bound levels/joins look like accidental duplicates. Only collisions where
  // the raw names actually differ get a suffix; two ids that legitimately share one exact
  // name (e.g. same-named attribute reused verbatim) keep the identical, correct label.
  {
    const byRenderedName = new Map<string, AttrDef[]>();
    for (const def of attrDef.values()) {
      def.displayName = cell(def.name);
      const group = byRenderedName.get(def.displayName) ?? [];
      group.push(def);
      byRenderedName.set(def.displayName, group);
    }
    for (const group of byRenderedName.values()) {
      if (group.length <= 1 || new Set(group.map((d) => d.name)).size <= 1) continue;
      group.forEach((def, i) => {
        if (i > 0) def.displayName = `${def.displayName} (${i + 1})`;
      });
    }
  }

  // ── Phase 6: cube-usage rollup ──────────────────────────────────────────────
  // This report is a complete inventory of the XML schema (see file header) — every
  // dataset/dimension/attribute/calculated-member the schema declares is documented
  // below whether or not any cube uses it. generate-sml-from-xml, by contrast, only
  // emits the subset a cube actually references (xml-converter.ts's
  // referencedDatasetNames/referencedDimNames and its calculated-member-ref exclusion).
  // Comparing this report's schema-wide totals directly against generate-report-from-sml's
  // SML-derived ones will therefore look like data loss even when nothing is missing —
  // so this rollup computes the same cube-used subset here too, via the identical
  // per-cube helpers (computeCubeJoins/computeCubeDimNames) the Cubes section renders
  // with below, and the Summary reports both numbers side by side.
  const usedDimNames = new Set<string>();
  const usedCalcMemberIds = new Set<string>();
  let usedMeasureCount = 0;
  // Attribute ids of measures that actually resolve to a real bound-to column — the same
  // subset generate-sml-from-xml emits as SML metrics. A perspective's flat-attribute-ref can
  // name a measure id that never survives conversion at all (unresolvable binding), and that
  // hide-list entry then hides nothing in the resulting SML rather than hiding a metric — see
  // perspectiveHideSummary below, which needs this same subset to report a matching count.
  const survivingMeasureIds = new Set<string>();
  for (const cube of cubeEls) {
    const { schemaJoinedDimNames } = computeCubeJoins(cube);
    const { usedNames } = computeCubeDimNames(cube, schemaJoinedDimNames);
    for (const n of usedNames) usedDimNames.add(n);
    for (const cmSec of arr(cube["calculated-members"])) {
      for (const cmRef of arr(cmSec["calculated-member-ref"])) {
        const refId = a(cmRef, "id");
        if (refId) usedCalcMemberIds.add(refId);
      }
    }
    // A measure counts as "used by a cube" — the same bar generate-sml-from-xml applies when
    // deciding whether to emit it as an SML metric — only once it resolves to a real (or
    // verifiably inferred) dataset.column binding; see resolveMeasureBoundTo.
    const quantileGroupDefs = buildQuantileGroupDefs(cube);
    for (const attrsSec of arr(cube.attributes)) {
      for (const attrEl of arr(attrsSec.attribute)) {
        if (isQuantileGroupAttribute(attrEl)) continue;
        if (resolveMeasureBoundTo(cube, attrEl, quantileGroupDefs)) {
          usedMeasureCount++;
          const attrId = a(attrEl, "id");
          if (attrId) survivingMeasureIds.add(attrId);
        }
      }
    }
  }

  // A dimension's own attribute can be embedded into a DIFFERENT dimension's level as a
  // cross-dimension secondary <keyed-attribute-ref ref-id="R" attribute-id="A"> (a
  // snowflake/embedded reference — e.g. a "Client" dimension embedding a "Segment"
  // dimension's own level attribute so a hierarchy can drill into it without a direct cube
  // join). The owning dimension never gets a key-ref binding tagged with this cube — the
  // cube only ever joins to the embedding dimension's own key — so
  // computeCubeJoins/computeCubeDimNames above can't see it. xml-converter.ts resolves this
  // via collectAttributeDimensionOwnership + resolveSnowflakeRelationship; mirror both here.
  //
  // attrIdToDimName resolves attribute A to the dimension that hosts it: a level's own
  // primary-attribute wins (checked first, across every dimension), falling back to a plain
  // (no ref-id) secondary <keyed-attribute-ref attribute-id="A"> only if no dimension already
  // claims it as primary — same priority collectAttributeDimensionOwnership uses.
  const attrIdToDimName = new Map<string, string>();
  for (const d of dimEntries) {
    for (const hier of arr(d.el.hierarchy)) {
      for (const level of arr(hier.level)) {
        const primaryId = a(level, "primary-attribute");
        if (primaryId) attrIdToDimName.set(primaryId, d.name);
      }
    }
  }
  for (const d of dimEntries) {
    for (const hier of arr(d.el.hierarchy)) {
      for (const level of arr(hier.level)) {
        for (const kref of arr(level["keyed-attribute-ref"])) {
          const attrId = a(kref, "attribute-id");
          const refId = a(kref, "ref-id");
          if (attrId && !refId && !attrIdToDimName.has(attrId)) attrIdToDimName.set(attrId, d.name);
        }
      }
    }
  }

  // dimIdToName resolves a <dimension id="..."> to its name — used only to resolve a
  // perspective's <flat-dimensions><flat-dimension-ref id="..."> back to the dimension it
  // hides (see perspectiveHideSummary below). Cube-level and schema-level dimension
  // definitions can share a name but never an id, so last-write-wins here is fine.
  const dimIdToName = new Map<string, string>();
  for (const d of dimEntries) {
    const id = a(d.el, "id");
    if (id) dimIdToName.set(id, d.name);
  }

  /**
   * Perspectives are a "hide list" (see xml-converter.ts's Phase 7d), not an inclusion list —
   * an empty perspective hides nothing and leaves everything visible. Mirrors that same
   * resolution (flat-attribute-ref → measure or dimension attribute, calculated-member-ref →
   * calculated member, flat-dimension-ref/flat-hierarchy-ref/flat-level-ref → a whole
   * dimension/hierarchy/level) closely enough to report the same counts the converted SML
   * ends up with, without needing the converter's own unique-naming: only distinct hidden
   * metric ids and distinct affected dimension names are counted here.
   */
  function perspectiveHideSummary(perspectiveEl: El): string {
    const hiddenMetricIds = new Set<string>();
    const hiddenDimNames = new Set<string>();

    for (const faSec of arr(perspectiveEl["flat-attributes"])) {
      for (const faRef of arr(faSec["flat-attribute-ref"])) {
        const id = a(faRef, "id");
        if (!id || !isExplicitlyHidden(faRef)) continue;
        if (survivingMeasureIds.has(id)) {
          hiddenMetricIds.add(id); // a measure that actually converted to an SML metric
        } else {
          // Only a dimension the converter actually kept (usedDimNames) can be hidden in the
          // resulting SML — a hide-list entry pointing at an excluded, never-referenced
          // dimension has nothing left to hide there (matching xml-converter.ts, which drops
          // it as an unresolvable Perspective omission rather than emitting a hide).
          const dimName = attrIdToDimName.get(id);
          if (dimName && usedDimNames.has(dimName)) hiddenDimNames.add(dimName);
        }
      }
    }

    for (const cmSec of arr(perspectiveEl["calculated-members"])) {
      for (const cmRef of arr(cmSec["calculated-member-ref"])) {
        const id = a(cmRef, "id");
        if (id && isExplicitlyHidden(cmRef) && calcMemberDef.has(id)) hiddenMetricIds.add(id);
      }
    }

    for (const fdSec of arr(perspectiveEl["flat-dimensions"])) {
      for (const fdRef of arr(fdSec["flat-dimension-ref"])) {
        const dimId = a(fdRef, "id");
        const dimName = dimId ? dimIdToName.get(dimId) : undefined;
        if (!dimName || !usedDimNames.has(dimName)) continue;
        if (isExplicitlyHidden(fdRef)) {
          hiddenDimNames.add(dimName);
          continue;
        }
        for (const fhRef of arr(fdRef["flat-hierarchy-ref"])) {
          if (isExplicitlyHidden(fhRef)) {
            hiddenDimNames.add(dimName);
            continue;
          }
          for (const flRef of arr(fhRef["flat-level-ref"])) {
            if (isExplicitlyHidden(flRef)) hiddenDimNames.add(dimName);
          }
        }
      }
    }

    const nMetrics = hiddenMetricIds.size;
    const nDims = hiddenDimNames.size;
    if (nMetrics === 0 && nDims === 0) return "hides nothing — all metrics and dimensions visible";
    return `hides ${nMetrics} metric(s), ${nDims} dimension(s)`;
  }

  /**
   * Resolves a cross-dimension embed the same way xml-converter.ts's
   * resolveSnowflakeRelationship does: ref-id bridges to the key-ref id that actually carries
   * it (refPathIdToKeyRefId). A key-ref id names an abstract <attribute-key>, not a
   * join-specific pairing, so it can be redeclared by other, unrelated datasets elsewhere in
   * the schema — keyMap.get(hostKeyRefId) is not reliably exactly the two datasets on either
   * side of this particular join. The host side is picked by matching the dataset the level's
   * own primary attribute already lives on (hostDatasetName); the target side by completeness
   * alone when there are more than two redeclarations, or by completeness AND uniqueness (the
   * only other signal available) in the ordinary two-entry case — mirrors the converter
   * exactly, including its own more-than-two-datasets fix.
   */
  function resolveEmbeddedDimName(refId: string, attrId: string, hostDimName: string, hostDatasetName: string | undefined): string | undefined {
    const hostKeyRefId = refPathIdToKeyRefId.get(refId);
    const entries = hostKeyRefId ? keyMap.get(hostKeyRefId) ?? [] : [];
    if (entries.length < 2) return undefined;
    const hostEntry = entries.find((e) => e.dataset === hostDatasetName);
    const targetEntry =
      entries.length === 2
        ? entries.find((e) => e.complete === "true" && e.unique)
        : entries.find((e) => e.complete === "true" && e !== hostEntry);
    if (!targetEntry || !hostEntry) return undefined;
    const targetDimName = attrIdToDimName.get(attrId);
    if (!targetDimName || targetDimName === hostDimName) return undefined;
    return targetDimName;
  }

  // A keyed attribute is "used" iff it backs a level (primary or secondary) of a dimension
  // that's currently marked used — mirrors how a whole dimension, not individual attributes
  // within it, is the unit xml-converter.ts excludes or keeps.
  const usedAttrIds = new Set<string>();
  let usedDimEntries = dimEntries.filter((d) => usedDimNames.has(d.name));
  /** Every cross-dimension embed (ref-id present) found on a currently-used dimension's own
   *  level, collected alongside usedAttrIds so the fixed-point loop below can attempt to
   *  resolve each one without re-walking every dimension's levels again. */
  let pendingEmbeds: Array<{ refId: string; attrId: string; hostDimName: string; hostDatasetName: string | undefined }> = [];
  function collectUsedAttrIds(): void {
    usedAttrIds.clear();
    pendingEmbeds = [];
    for (const d of usedDimEntries) {
      for (const hier of arr(d.el.hierarchy)) {
        for (const level of arr(hier.level)) {
          const primaryId = a(level, "primary-attribute");
          if (primaryId) usedAttrIds.add(primaryId);
          // The dataset this level's own primary attribute is authoritatively bound to — same
          // pick xml-converter.ts's authEntry.datasetName makes — used below to identify which
          // of a redeclared key-ref's bindings is the host side, not the embed's target.
          const hostDatasetName = primaryId ? pickAuthBinding(keyMap.get(attrDef.get(primaryId)?.keyUuid ?? "") ?? [])?.dataset : undefined;
          for (const kref of arr(level["keyed-attribute-ref"])) {
            const attrId = a(kref, "attribute-id");
            if (!attrId) continue;
            const refId = a(kref, "ref-id");
            if (refId) {
              // A cross-dimension embed: attrId belongs to ANOTHER dimension, not this one, so
              // it's only "used" if resolveEmbeddedDimName below actually resolves the
              // relationship (matching xml-converter.ts, which drops an unresolved embed
              // entirely — dimMeta.skippedCrossDimRefs — rather than treating it as a live
              // secondary attribute).
              pendingEmbeds.push({ refId, attrId, hostDimName: d.name, hostDatasetName });
            } else {
              usedAttrIds.add(attrId); // plain secondary attribute, hosted natively here
            }
          }
        }
      }
    }
  }
  collectUsedAttrIds();
  // Grow usedDimNames/usedAttrIds to a fixed point: resolving one embed can mark another
  // dimension used, exposing more embeds of its own (a chain), so keep re-deriving until
  // nothing new resolves.
  let grew = true;
  while (grew) {
    grew = false;
    for (const { refId, attrId, hostDimName, hostDatasetName } of pendingEmbeds) {
      const targetDimName = resolveEmbeddedDimName(refId, attrId, hostDimName, hostDatasetName);
      if (targetDimName && !usedDimNames.has(targetDimName)) {
        usedDimNames.add(targetDimName);
        grew = true;
      }
    }
    if (grew) {
      usedDimEntries = dimEntries.filter((d) => usedDimNames.has(d.name));
      collectUsedAttrIds();
    }
  }
  // Snapshot the pre-growth set — every dataset a cube's own data-set-ref names directly —
  // before the loop below adds dimension-backing datasets too. This is the "Fact" side of
  // the Datasets section's role tag; anything the loop below adds that isn't already here
  // is a "Dimension" table instead (mirrors generate-report-from-sml's factDatasets/
  // dimDatasets split, which reads the same fact-vs-dimension distinction off the SML side).
  const factDatasetNames = new Set(usedDatasetNames);

  // Schema-level dimensions never appear in a cube's own data-set-ref list (they're pulled
  // in via keyed-attribute key-refs instead, resolved through keyMap below), so a dataset
  // that only backs a dimension level — never a cube's fact table — still counts as used;
  // matches xml-converter.ts, which scans each emitted dimension's own YAML for the
  // datasets it names, in addition to what cubes reference directly, regardless of whether
  // any individual binding happens to be cube-tagged.
  //
  // A key-ref id names an abstract key, not a join-specific pairing, so it can be
  // redeclared by other, unrelated datasets elsewhere in the schema purely by UUID
  // coincidence — e.g. a legacy/duplicate dataset that reuses the same key-ref id with
  // complete="false" and no ref-path of its own, wired to nothing. Growing usedDatasetNames
  // from every such redeclaration (rather than only the one(s) actually reachable) would
  // mark that dead dataset "used" purely because a live dimension happens to share its
  // key-ref id. authoritativeBindings() restricts growth to the complete="true"
  // registration(s) — the same signal pickAuthBinding/resolveEmbeddedDimName already use to
  // pick the real source out of a group of redeclarations — falling back to the raw set
  // only when none are complete.
  for (const attrId of usedAttrIds) {
    const keyUuid = attrDef.get(attrId)?.keyUuid;
    const bindings = keyUuid ? keyMap.get(keyUuid) ?? [] : [];
    for (const b of authoritativeBindings(bindings)) usedDatasetNames.add(b.dataset);
  }

  // ── "Used across cubes" tally — usedDatasetNames is now fully grown (direct cube
  //    data-set-ref references, plus every dataset that only backs a used dimension level,
  //    including one reached solely through a snowflake/embedded relationship), so gate the
  //    tally on dataset membership in that set rather than requiring each individual id to
  //    independently carry a cube-tagged binding. The per-id gate undercounted: only a
  //    key-ref id gets restated elsewhere (the fact table's own FK binding, sharing the same
  //    id as the dimension's authoritative definition) — an attribute-ref for a genuine
  //    (non-degenerate) snowflake dimension is never duplicated onto the fact table, so
  //    requiring a per-id restatement left attribute-ref counts at zero for every such
  //    dimension, and silently dropped any of its key-refs that likewise never happen to be
  //    restated. A dataset that clears the usedDatasetNames bar is, by construction, one
  //    whose own declared key-refs/attribute-refs are actually wired into the model — mirrors
  //    xml-converter.ts, which never excludes individual attributes within a dataset it keeps
  //    — so once a dataset clears that bar, every one of its own bindings counts; a dataset
  //    that never clears it still reports zero instead of its raw declaration count.
  function tallyUsageByDataset(bindingsById: Map<string, { dataset: string }[]>): Map<string, number> {
    const counts = new Map<string, number>();
    for (const bindings of bindingsById.values()) {
      // Count this id once per dataset it touches, not once per binding — an id can be
      // declared twice for the SAME dataset (once in that dataset's own schema-level
      // <logical> block, once in a cube's data-set-ref <logical> block that simply
      // restates it), and that must still land as a single "used by this id" credit.
      const datasetsForId = new Set(bindings.map((b) => b.dataset));
      for (const dataset of datasetsForId) {
        if (!usedDatasetNames.has(dataset)) continue;
        counts.set(dataset, (counts.get(dataset) ?? 0) + 1);
      }
    }
    return counts;
  }
  const keyRefUsage = tallyUsageByDataset(keyMap);
  const attrRefUsage = tallyUsageByDataset(attrMap);
  for (const ds of datasets) {
    ds.keyRefCount = keyRefUsage.get(ds.name) ?? 0;
    ds.attrRefCount = attrRefUsage.get(ds.name) ?? 0;
  }

  // ============================================================
  // Rendering
  // ============================================================

  const out: string[] = [];

  const hasRoles = arr(schemaEl.roles).length > 0 || arr(schemaEl.role).length > 0;
  const hasPerspectives = arr(schemaEl.perspectives).length > 0 || arr(schemaEl.perspective).length > 0;
  const hasTranslations = arr(schemaEl.translations).length > 0 || arr(schemaEl.translation).length > 0;
  const perspectiveEls = arr(schemaEl.perspectives).flatMap((p) => arr(p.perspective)).filter((p) => a(p, "name"));
  const perspectiveNames = perspectiveEls.map((p) => a(p, "name") ?? "");

  const totalHierarchies = dimEntries.reduce((n, d) => n + arr(d.el.hierarchy).length, 0);
  const totalLevels = dimEntries.reduce(
    (n, d) => n + arr(d.el.hierarchy).reduce((k, h) => k + arr(h.level).length, 0),
    0,
  );
  const usedHierarchies = usedDimEntries.reduce((n, d) => n + arr(d.el.hierarchy).length, 0);
  const usedLevels = usedDimEntries.reduce(
    (n, d) => n + arr(d.el.hierarchy).reduce((k, h) => k + arr(h.level).length, 0),
    0,
  );
  const usedAttrCount = [...attrDef.keys()].filter((id) => usedAttrIds.has(id)).length;
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
    "Counts below are schema-wide (every object the XML declares). The \"used by a cube\" rows " +
      "show the subset at least one cube actually references — the same scope `generate-sml-from-xml` " +
      "converts, so those rows are what to compare against a report generated from the resulting SML.",
    "",
  );
  out.push(
    ...table(
      ["Object", "Count"],
      [
        ["Cubes / Models", String(cubeEls.length)],
        ["Datasets", String(datasets.length)],
        ["Datasets used by a cube", String(usedDatasetNames.size)],
        ["Connections", String(connectionIds.size)],
        ["Schema-level attributes", String(attrDef.size)],
        ["Attributes used by a cube", String(usedAttrCount)],
        ["Dimensions", String(dimEntries.length)],
        ["Dimensions used by a cube", String(usedDimEntries.length)],
        ["Hierarchies", String(totalHierarchies)],
        ["Hierarchies used by a cube", String(usedHierarchies)],
        ["Levels", String(totalLevels)],
        ["Levels used by a cube", String(usedLevels)],
        ["Measures", String(totalMeasures)],
        ["Measures used by a cube", String(usedMeasureCount)],
        ["Calculated members", String(calcMemberDef.size)],
        ["Calculated members used by a cube", String(usedCalcMemberIds.size)],
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
  for (const ds of datasets) {
    const role = factDatasetNames.has(ds.name) ? "Fact" : usedDatasetNames.has(ds.name) ? "Dimension" : undefined;
    renderDataset(out, ds, role);
  }

  // ── Attribute Library ────────────────────────────────────────────────────────

  out.push("## Attribute Library", "");
  out.push(
    "Schema-level keyed attributes are the shared building blocks dimensions and levels reference by id; this is every one defined in the schema, whether or not a dimension currently uses it.",
    "",
  );
  if (attrDef.size) {
    const rows = [...attrDef.values()].map((def) => {
      const boundTo = bindingLabel(resolveAttrBindings(def.keyUuid));
      return [
        code(def.displayName),
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

  if (perspectiveEls.length) {
    out.push("## Perspectives", "");
    out.push(...perspectiveEls.map((p) => `- **${cell(a(p, "name"))}** — ${perspectiveHideSummary(p)}`), "");
  }

  out.push("---", "", "_Generated by `atscale-utils generate-report-from-xml`._", "");
  return out.join("\n");

  // ============================================================
  // Section renderers (closures over the phase-1..5 maps above)
  // ============================================================

  function renderDataset(o: string[], ds: DatasetDef, role: string | undefined): void {
    o.push(`### ${ds.name}${role ? `  \`${role}\`` : ""}`, "");
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

  /**
   * Pick the single authoritative binding out of a group already known to share one dataset
   * — a key-ref id redeclared more than once on the SAME dataset (e.g. once in its base
   * <logical> section, once as a cube-scoped override) is alternative/context-specific
   * registrations of the same key, not a composite one, so joining their columns together
   * would fabricate a binding that doesn't exist. Same rule as `pickAuthEntry` in
   * generate-sml-from-xml's xml-converter.ts: prefer the entry marked complete="true", else
   * one whose columns verify against its own dataset's known physical columns, else the
   * first entry.
   */
  function pickAuthBinding(bindings: KeyBinding[]): KeyBinding | undefined {
    const complete = bindings.find((b) => b.complete === "true");
    if (complete) return complete;
    const valid = bindings.find((b) => {
      const knownColumns = datasetByName.get(b.dataset)?.columns;
      return !!knownColumns?.length && b.columns.every((col) => knownColumns.some((c) => c.name === col));
    });
    return valid ?? bindings[0];
  }

  /**
   * Restricts a key-ref id's SCHEMA-LEVEL redeclarations (cube undefined — see KeyBinding)
   * to its complete="true" registration(s), dropping bare complete="false" pointers that
   * merely defer to (or, if undeclared/dangling, never reach) some other dataset. A
   * schema-level redeclaration's whole purpose is either to BE the source or to point at
   * one; it is never an independent binding in its own right, so treating it as one
   * fabricates a join hop that doesn't exist in the resolved model (e.g. a legacy/duplicate
   * dataset that reuses another dataset's key-ref id with complete="false" and no ref-path
   * of its own, wired to nothing). Falls back to the raw schema-level set when none are
   * complete — keyMap defaults a declaration with no explicit `complete` attribute to
   * "true", so an empty result here only happens when every schema-level declaration is
   * explicitly an incomplete pointer.
   *
   * Cube-scoped bindings (cube set, from a cube's own <data-set-ref> override — see the
   * other ingestLogical call site) are always kept regardless of `complete`: a cube-scoped
   * override is itself the evidence the binding is real and reachable from that cube, the
   * same "independently cube-tagged" signal `tallyUsageByDataset` relies on elsewhere in
   * this file, so it is never the dangling kind this filter targets.
   */
  function authoritativeBindings(bindings: KeyBinding[]): KeyBinding[] {
    const schemaLevel = bindings.filter((b) => b.cube === undefined);
    const completeSchemaLevel = schemaLevel.filter((b) => b.complete === "true");
    if (!completeSchemaLevel.length) return bindings;
    const cubeLevel = bindings.filter((b) => b.cube !== undefined);
    return [...completeSchemaLevel, ...cubeLevel];
  }

  /**
   * A key-ref id can legitimately be registered more than once and still deserve every
   * registration shown, not collapsed to one:
   *  - under more than one DIFFERENT dataset (e.g. a shared/conformed attribute present in
   *    both a Claims fact and a Policy fact) — independent, complementary bindings.
   *  - under the SAME dataset but with different role-played naming (e.g. "{0} - Beginning"
   *    vs plain, or "Sending {0}" vs "Receiving {0}") — genuinely distinct roles the same
   *    FK column pattern plays, the same distinction the cube join-table preserves.
   * Only redeclarations that share BOTH the same dataset AND the same role (including "no
   * role" on both) are the alternative/override case pickAuthBinding resolves — e.g. one
   * entry from a dataset's own authoritative <logical> section and a stale/incomplete
   * cube-scoped override of the same key.
   *
   * Bare complete="false" pointers to a DIFFERENT dataset are filtered out first (via
   * authoritativeBindings) rather than grouped alongside the real source(s) — such a
   * pointer either resolves elsewhere (a snowflake embed, rendered by its own dedicated
   * table) or nowhere (a dangling/orphaned redeclaration), and either way it is not itself
   * a binding this attribute's value is drawn from.
   */
  function bindingLabel(bindings: KeyBinding[]): string {
    const byDatasetAndRole = new Map<string, KeyBinding[]>();
    for (const b of authoritativeBindings(bindings)) {
      const groupKey = `${b.dataset} ${b.rolePlay ?? ""}`;
      const group = byDatasetAndRole.get(groupKey) ?? [];
      group.push(b);
      byDatasetAndRole.set(groupKey, group);
    }
    return [...byDatasetAndRole.values()]
      .map(pickAuthBinding)
      .filter((b): b is KeyBinding => !!b)
      .map((b) => `${b.dataset}.${b.columns.join("+")}${b.cube ? ` (${b.cube})` : ""}`)
      .join(", ");
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
          code(def?.displayName ?? primaryId ?? "?"),
          cell(def?.caption),
          code(bindingLabel(bindings)),
          cell(levelType),
          flag(bindings.some((b) => b.unique)),
          flag(!visible) ? "hidden" : "",
          cell(def?.folder),
          def?.allowedCalcTypes.join(", ") ?? "",
        ]);

        for (const kref of arr(level["keyed-attribute-ref"])) {
          const attrId = a(kref, "attribute-id");
          const role = a(kref, "role");
          const refId = a(kref, "ref-id");
          if (!attrId) continue;
          const kaDef = attrDef.get(attrId);
          const kaBindings = resolveAttrBindings(kaDef?.keyUuid);
          const kaVisible = kaDef ? kaDef.visible : true;
          secondaryRows.push([
            code(def?.displayName ?? primaryId ?? "?"),
            code(kaDef?.displayName ?? attrId),
            cell(kaDef?.caption),
            role ? cell(role) : refId ? "embedded ref" : "secondary",
            code(bindingLabel(kaBindings)),
            cell(kaDef?.folder),
            flag(!kaVisible) ? "hidden" : "",
            kaDef?.allowedCalcTypes.join(", ") ?? "",
          ]);
        }
      }

      if (levelRows.length) {
        o.push(...table(["Level (primary attribute)", "Caption", "Bound to (dataset.column)", "Level type", "Unique key", "Hidden", "Folder", "Allowed DMA calcs"], levelRows));
      }
      if (secondaryRows.length) {
        o.push("Level attributes (name/sort overrides and secondary attributes):", "");
        o.push(...table(["Level", "Attribute", "Caption", "Role", "Bound to (dataset.column)", "Folder", "Hidden", "Allowed DMA calcs"], secondaryRows));
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

  /**
   * Joins: this cube's own key-ref bindings, resolved against every dimension's
   * keyed-attribute to show which fact dataset joins to which dimension level
   * on which column(s) — the actual join graph, independent of SML shaping.
   *
   * A degenerate attribute (its value is a plain column on the fact table itself, no
   * separate physical dimension table involved at all) has exactly one key-ref entry
   * total for that key, declared complete="true" directly in the fact dataset's own
   * <logical> section — with nothing else bound to the same key, there is no "other side"
   * to join to, so it produces no join row. A genuine cross-table lookup instead has TWO
   * (or more) entries for the same key on DIFFERENT datasets: whichever one owns the
   * authoritative definition (complete="true") plus one or more FK references to it
   * (typically complete="false"/"partial") — every dataset in that group gets its own join
   * row, including the authoritative one itself, because a fact whose own column IS the
   * dimension's key still needs a row describing which column it joins on. That holds even
   * when the authoritative dataset is itself one of this cube's own fact tables (a
   * degenerate dimension whose values live on fact A, looked up via FK from fact B, is a
   * real relationship, not a coincidence). Two cases are NOT a real join: two datasets that
   * each independently declare complete="true" for the same key — both already own the
   * value outright, so neither is joining to the other, they just happen to carry the same
   * degenerate value (shared_degenerate_columns) — and, symmetrically, no dataset at all
   * declaring complete="true" for the key (every entry is "false"/"partial"): there is no
   * authoritative lookup table for any of them to join to, so every dataset under that key
   * hosts the value directly and the whole group is shared-degenerate, not a join. Mirrors
   * the dimTrueEntry rule in xml-converter.ts's gatherDimensionBindings.
   *
   * Also returns schemaJoinedDimNames: schema-level dimensions this cube actually uses via a
   * key-ref binding (as opposed to an explicit <dimension-ref>) — broader than isRealJoin, since
   * a degenerate dimension (its authoritative key-ref lives directly on one of this cube's own
   * fact datasets, with no separate lookup table) never produces a real cross-table join, but the
   * cube still genuinely depends on it whenever the cube's own data-set-ref declares a binding for
   * that key at all — same "any cube-tagged binding counts as usage" rule the "used across cubes"
   * tally above applies per-dataset. computeCubeDimNames (below) folds this into "Dimensions used",
   * and the Phase 6 cube-usage rollup reuses it too, so both places agree on what counts as used.
   */
  function computeCubeJoins(cube: El): { joinRows: string[][]; schemaJoinedDimNames: Set<string> } {
    const cubeName = a(cube, "name") ?? "";
    function isRealJoin(b: KeyBinding, allBindings: KeyBinding[]): boolean {
      // No dataset owns the key outright: it is a shared-degenerate value living directly
      // on every dataset registered under it, not a cross-table relationship at all.
      if (!allBindings.some((e) => e.complete === "true")) return false;
      return allBindings.some((other) => other.dataset !== b.dataset && !(b.complete === "true" && other.complete === "true"));
    }
    const joinRows: string[][] = [];
    // A dimension can expose the same physical key binding through more than one hierarchy
    // (e.g. three hierarchies that each bottom out at a shared "code"-style level attribute) —
    // the level loops below visit that binding once per hierarchy, so this tracks
    // (dataset, columns, dimension, level) combinations already emitted to keep one real join
    // relationship from producing byte-identical duplicate rows.
    const seenJoinRowKeys = new Set<string>();
    const schemaJoinedDimNames = new Set<string>();
    for (const [dimName, dimEl] of schemaDims) {
      for (const hier of arr(dimEl.hierarchy)) {
        for (const level of arr(hier.level)) {
          const primaryId = a(level, "primary-attribute");
          const def = primaryId ? attrDef.get(primaryId) : undefined;
          if (!def?.keyUuid) continue;
          const allBindings = keyMap.get(def.keyUuid) ?? [];
          for (const b of allBindings) {
            if (b.cube !== cubeName) continue;
            schemaJoinedDimNames.add(dimName);
            if (!isRealJoin(b, allBindings)) continue;
            // Keyed by def.id (the keyed-attribute's own id), not def.name/displayName: two
            // distinct keyed-attribute objects can share an identical name/caption and binding
            // (a coincidence in the source model), and deduping on the name would silently drop
            // one of them as if it were the same object visited via another hierarchy.
            const joinRowKey = `${b.dataset} ${b.columns.join(",")} ${dimName} ${def.id} ${b.rolePlay ?? ""}`;
            if (seenJoinRowKeys.has(joinRowKey)) continue;
            seenJoinRowKeys.add(joinRowKey);
            joinRows.push([code(b.dataset), code(b.columns.join(", ")), code(dimName), code(def.displayName), cell(b.rolePlay), b.unique ? "yes" : ""]);
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
            const allBindings = keyMap.get(def.keyUuid) ?? [];
            for (const b of allBindings) {
              if (b.cube !== cubeName || !isRealJoin(b, allBindings)) continue;
              // See the matching comment above: dedup by def.id, not def.name/displayName.
              const joinRowKey = `${b.dataset} ${b.columns.join(",")} ${dimName} ${def.id} ${b.rolePlay ?? ""}`;
              if (seenJoinRowKeys.has(joinRowKey)) continue;
              seenJoinRowKeys.add(joinRowKey);
              joinRows.push([code(b.dataset), code(b.columns.join(", ")), code(dimName), code(def.displayName), cell(b.rolePlay), b.unique ? "yes" : ""]);
            }
          }
        }
      }
    }
    return { joinRows, schemaJoinedDimNames };
  }

  /**
   * Dimensions used (inline + refs), plus every schema-level dimension reached only via a
   * bare key-ref join (schemaJoinedDimNames, from computeCubeJoins) with no <dimension-ref>
   * ever naming it — without that, such dimensions would silently vanish from "Dimensions
   * used" even though the cube genuinely depends on them.
   *
   * The converse also has to be filtered: a schema-level <dimension-ref> is only a
   * *declaration* that the cube's schema mentions the dimension, not proof the cube joins
   * to it. A schema can (and legitimately does) declare a dimension-ref whose dataset has
   * no key-ref binding to any of this cube's fact datasets anywhere in the model — a
   * dimension left over from another cube's schema, or never wired up at all. Such a
   * dimension-ref is excluded here exactly as xml-converter.ts excludes it from the
   * emitted SML (its referencedDimNames is built from real relationships/degenerate
   * bindings, not from the mere presence of a <dimension-ref>), so this report's "used by
   * a cube" counts agree with what actually gets converted.
   */
  function computeCubeDimNames(cube: El, schemaJoinedDimNames: Set<string>): { dimNames: string[]; usedNames: Set<string> } {
    const dimNames: string[] = [];
    const namedDimNames = new Set<string>();
    for (const dimsSec of arr(cube.dimensions)) {
      for (const dim of arr(dimsSec.dimension)) {
        const dName = a(dim, "name") ?? "?";
        dimNames.push(`${dName} (cube-local)`);
        namedDimNames.add(dName);
      }
      for (const dimRef of arr(dimsSec["dimension-ref"])) {
        const refId = a(dimRef, "id");
        const found = [...schemaDims.entries()].find(([, d]) => a(d, "id") === refId);
        const dName = found ? found[0] : refId ?? "?";
        // Only drop it when we positively resolved the ref to a real schema-level
        // dimension AND that dimension has zero cube-tagged key-ref bindings anywhere
        // (schemaJoinedDimNames). An unresolved ref (found undefined) is kept as before —
        // there's nothing to check it against.
        if (found && !schemaJoinedDimNames.has(dName)) continue;
        dimNames.push(dName);
        namedDimNames.add(dName);
      }
    }
    for (const dimName of schemaJoinedDimNames) {
      if (namedDimNames.has(dimName)) continue;
      dimNames.push(`${dimName} (schema-level)`);
      namedDimNames.add(dimName);
    }
    return { dimNames, usedNames: namedDimNames };
  }

  /**
   * Quantile-group definitions (the AtScale representation of a percentile measure's base
   * attribute id + compression setting, referenced by id from one or more
   * <quantile-instance> attributes) are hidden plumbing, not standalone measures — collected
   * up front so a percentile measure's binding can be resolved to its real dataset/column
   * instead of falling back to a naive, wrong guess. Shared by the Phase 6 rollup and the
   * Cubes section's own Measures table so both agree on which measures are bound.
   */
  function buildQuantileGroupDefs(cube: El): Map<string, { baseAttrId?: string; compression?: string }> {
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
    return quantileGroupDefs;
  }

  /**
   * Resolves the fact-side dataset.column a cube's measure attribute is bound to: prefer an
   * inline <key-ref> under the measure's own <measure>/<count-distinct>/<count-nonnull>
   * element (resolved through keyMap, same as a dimension level attribute), then an
   * <attribute-ref> registered for this attribute id in the cube's own data-set-ref, then —
   * for a percentile measure — the binding of the base attribute its quantile-group points to
   * by id. Only after all three come up empty does this fall back to a naming-convention
   * guess (e.g. "m_FOO_sum" → column FOO on the cube's first fact dataset), clearly labeled as
   * inferred rather than declared, since it is not a fact stated anywhere in the XML. Returns
   * "" when no binding — declared or verifiably inferred — exists at all, which is also the
   * "used by a cube" signal the Phase 6 rollup counts, since generate-sml-from-xml's
   * xml-converter.ts likewise excludes a fully unbound measure from SML.
   */
  function resolveMeasureBoundTo(
    cube: El,
    attrEl: El,
    quantileGroupDefs: Map<string, { baseAttrId?: string; compression?: string }>,
  ): string {
    const cubeName = a(cube, "name") ?? "?";
    const name = a(attrEl, "name") ?? "?";
    const attrId = a(attrEl, "id");
    const mProps = first(arr(attrEl.properties)) as El | undefined;
    const typeEl = mProps ? (first(arr(mProps.type)) as El | undefined) : undefined;
    const measureEl = typeEl ? (first(arr(typeEl.measure)) as El | undefined) : undefined;
    const countDistEl = typeEl ? (first(arr(typeEl["count-distinct"])) as El | undefined) : undefined;
    const countNonNullEl = typeEl ? (first(arr(typeEl["count-nonnull"])) as El | undefined) : undefined;
    const quantileInstanceEl = typeEl ? (first(arr(typeEl["quantile-instance"])) as El | undefined) : undefined;

    const measureTypeEl = measureEl ?? countDistEl ?? countNonNullEl;
    const inlineKeyRefEl = measureTypeEl ? (first(arr(measureTypeEl["key-ref"])) as El | undefined) : undefined;
    const inlineKeyRefId = inlineKeyRefEl ? a(inlineKeyRefEl, "id") : undefined;
    const inlineBindings = inlineKeyRefId ? keyMap.get(inlineKeyRefId) ?? [] : [];
    const attrBindings = attrId ? attrMap.get(attrId)?.filter((b) => b.cube === cubeName) ?? [] : [];

    const quantileGroupRefEl = quantileInstanceEl ? (first(arr(quantileInstanceEl["quantile-group-ref"])) as El | undefined) : undefined;
    const quantileGroupRefId = quantileGroupRefEl ? a(quantileGroupRefEl, "id") : undefined;
    const quantileBaseAttrId = quantileGroupRefId ? quantileGroupDefs.get(quantileGroupRefId)?.baseAttrId : undefined;
    const quantileBindings = quantileBaseAttrId ? attrMap.get(quantileBaseAttrId)?.filter((b) => b.cube === cubeName) ?? [] : [];

    if (inlineBindings.length) return inlineBindings.map((b) => `${b.dataset}.${b.columns.join("+")}`).join(", ");
    if (attrBindings.length) return attrBindings.map((b) => `${b.dataset}.${b.column}`).join(", ");
    if (quantileBindings.length) return quantileBindings.map((b) => `${b.dataset}.${b.column}`).join(", ");

    // No key-ref/attribute-ref binding exists anywhere for this attribute — a genuinely
    // incomplete/orphaned definition left over in the source schema. Guessing a column from
    // the attribute's own name (e.g. "m_FOO_sum" → FOO) is only worth reporting when the
    // guess actually matches a column the target dataset declares; otherwise it fabricates a
    // specific-looking binding for a column that does not exist, which is worse than
    // reporting no binding at all. Matches the same guard in generate-sml-from-xml's
    // xml-converter.ts, which excludes an unverifiable guess like this from SML entirely
    // rather than emitting it.
    const guessedDataset = getFactDatasetName(cube);
    const guessedColumn = parseColumnFromAttrName(name);
    const knownColumns = guessedDataset ? datasetByName.get(guessedDataset)?.columns : undefined;
    const isUnverifiableGuess = !!knownColumns?.length && !knownColumns.some((c) => c.name === guessedColumn);
    return guessedDataset && !isUnverifiableGuess ? `${guessedDataset}.${guessedColumn} (inferred)` : "";
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

    const { joinRows, schemaJoinedDimNames } = computeCubeJoins(cube);
    if (joinRows.length) {
      o.push("**Joins (fact dataset → dimension level)**", "");
      o.push(...table(["From dataset", "Join column(s)", "To dimension", "To level", "Role play", "Unique"], joinRows));
    }

    const { dimNames } = computeCubeDimNames(cube, schemaJoinedDimNames);
    if (dimNames.length) o.push(`**Dimensions used:** ${dimNames.map((d) => `\`${d}\``).join(", ")}`, "");

    // Quantile-group definitions (the AtScale representation of a percentile measure's base
    // attribute id + compression setting) — see buildQuantileGroupDefs.
    const quantileGroupDefs = buildQuantileGroupDefs(cube);

    // Measures.
    const measureRows: string[][] = [];
    for (const attrsSec of arr(cube.attributes)) {
      for (const attrEl of arr(attrsSec.attribute)) {
        if (isQuantileGroupAttribute(attrEl)) continue; // hidden plumbing — see quantileGroupDefs above
        const name = a(attrEl, "name") ?? "?";
        const mProps = first(arr(attrEl.properties)) as El | undefined;
        const caption = mProps ? s(first(arr(mProps.caption))) : undefined;
        const mVisible = mProps ? s(first(arr(mProps.visible))) !== "false" : true;
        const folder = mProps ? s(first(arr(mProps.folder))) : undefined;
        const mFmtEl = mProps ? (first(arr(mProps.formatting)) as El | undefined) : undefined;
        const format = mFmtEl ? (s(first(arr(mFmtEl["format-string"]))) ?? s(first(arr(mFmtEl["named-format"])))) : undefined;
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
          // "count distinct" (spaced) is the canonical SML aggregation-type wording,
          // not the raw XML element/tag name — matches generate-sml-from-xml's mapping.
          kind = "count distinct";
        } else if (countNonNullEl) {
          kind = "count non-null";
        } else if (quantileInstanceEl) {
          kind = "percentile";
          const quantileVal = s(first(arr(quantileInstanceEl["quantile-val"])));
          agg = quantileVal ? `p${quantileVal}` : "percentile";
        } else if (exprEl) {
          kind = "calculated";
        } else {
          kind = "unknown";
        }

        // Resolve the fact-side column — see resolveMeasureBoundTo, shared with the Phase 6
        // rollup so the Summary's "Measures used by a cube" count matches this column.
        const boundTo = resolveMeasureBoundTo(cube, attrEl, quantileGroupDefs);

        measureRows.push([
          code(name),
          cell(caption),
          kind,
          code(agg),
          semiAdditive,
          code(boundTo),
          cell(folder),
          cell(format),
          flag(!mVisible) ? "hidden" : "",
        ]);
      }
    }
    if (measureRows.length) {
      o.push("**Measures**", "");
      o.push(...table(["Name", "Caption", "Kind", "Aggregation", "Semi-additive", "Bound to (dataset.column)", "Folder", "Format", "Hidden"], measureRows));
    }

    // Calculated members used by this cube (resolved against the schema library).
    const calcRows: string[][] = [];
    for (const cmSec of arr(cube["calculated-members"])) {
      for (const cmRef of arr(cmSec["calculated-member-ref"])) {
        const refId = a(cmRef, "id");
        const def = refId ? calcMemberDef.get(refId) : undefined;
        if (!def) continue;
        calcRows.push([
          code(def.name),
          cell(def.caption),
          code(def.expression),
          cell(def.folder),
          cell(def.format),
          flag(!def.visible) ? "hidden" : "",
        ]);
      }
    }
    if (calcRows.length) {
      o.push("**Calculated members used**", "");
      o.push(...table(["Name", "Caption", "Formula", "Folder", "Format", "Hidden"], calcRows));
    }

    // User Defined Aggregates. Each attribute-ref is split into the dimension-attribute
    // column or the metric column (measures and calculated members) based on which map
    // resolved it, mirroring the SML report's separate "# attributes"/"# metrics" columns.
    const aggRows: string[][] = [];
    for (const aggsSec of arr(cube.aggregates)) {
      for (const aggEl of arr(aggsSec.aggregate)) {
        const aggName = a(aggEl, "name") ?? "?";
        const targetConn = s(first(arr(aggEl["target-connection"])));
        const attrNames: string[] = [];
        const metricNames: string[] = [];
        for (const attrsWrap of arr(aggEl.attributes)) {
          for (const attrRef of arr(attrsWrap["attribute-ref"])) {
            const refId = a(attrRef, "id");
            const def = refId ? attrDef.get(refId) : undefined;
            if (def) {
              attrNames.push(def.name);
              continue;
            }
            const resolvedName = refId ? attrNameById.get(refId) ?? calcMemberDef.get(refId)?.name : undefined;
            metricNames.push(resolvedName ?? refId ?? "?");
          }
        }
        aggRows.push([
          code(aggName),
          code(targetConn),
          String(attrNames.length),
          attrNames.map((n) => `\`${n}\``).join(", "),
          String(metricNames.length),
          metricNames.map((n) => `\`${n}\``).join(", "),
        ]);
      }
    }
    if (aggRows.length) {
      o.push("**User Defined Aggregates**", "");
      o.push(...table(["Name", "Target connection", "# attributes", "Attributes", "# metrics", "Metrics"], aggRows));
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
