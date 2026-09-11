/**
 * Markdown generator for generate-report-from-sml.
 *
 * Pure (no fs / no services): given the objects collected from an SML
 * directory, it returns a single, human-readable Markdown document describing
 * every object found in the model as-is — connections, datasets, the
 * fact-to-dimension join graph, dimensions (hierarchies, levels, secondary
 * attributes, snowflake/embedded joins), models (relationships, metrics used,
 * calculations used, degenerate dimensions, perspectives, aggregates,
 * overrides, drillthrough), the metrics library, the calculations library,
 * perspectives, and security.
 *
 * This mirrors generate-report-from-xml's report shape and section ordering
 * (Connections → Datasets → Dimensions → the cube-equivalent unit → its
 * reference libraries → Perspectives) adapted to SML's object model: SML has
 * no schema-level attribute library (level attributes bind straight to
 * dataset columns inside each dimension), but metrics and calculations *are*
 * global libraries referenced by models via unique_name, so — like the XML
 * report resolves calculated-member refs against its schema library — this
 * resolves a model's `metrics`/`calculations` refs against the SML metrics
 * and calculations libraries rather than rendering them inline.
 *
 * Kept local and independent from generate-sml-docs's loader/renderer so this
 * report never depends on, or risks destabilizing, the docs generator.
 */

/* eslint-disable @typescript-eslint/no-explicit-any */
type Raw = Record<string, any>;

/** One parsed SML object plus the file it came from (relative to the sml-dir). */
export interface SmlObject {
  file: string;
  raw: Raw;
}

/** Everything collected from an SML directory, grouped by kind. */
export interface SmlCollection {
  catalog?: Raw;
  connections: SmlObject[];
  datasets: SmlObject[];
  dimensions: SmlObject[];
  metrics: SmlObject[];
  calculations: SmlObject[];
  models: SmlObject[];
  /** Objects whose object_type did not match a known kind. */
  other: SmlObject[];
}

export interface SmlReportOptions {
  /** Basename of the SML directory — included in the report header for traceability. */
  smlDirName?: string;
  /** H1 title. Defaults to the catalog label / unique_name. */
  title?: string;
}

// ── small Markdown helpers (same conventions as generate-report-from-xml) ──

function cell(v: unknown): string {
  if (v === undefined || v === null || v === "") return "";
  return String(v).replace(/\|/g, "\\|").replace(/\r?\n/g, " ").trim();
}

function code(v: unknown): string {
  const c = cell(v);
  return c ? `\`${c}\`` : "";
}

function flag(v: unknown): string {
  return v === true || v === "true" || v === "yes" ? "yes" : "";
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

function asArray<T = any>(v: unknown): T[] {
  if (Array.isArray(v)) return v as T[];
  if (v === undefined || v === null) return [];
  return [v as T];
}

/** Display label for an object: label → unique_name → file stem. */
function label(o: SmlObject): string {
  return String(o.raw.label ?? o.raw.unique_name ?? o.file);
}

/** Normalize a dataset reference by dropping a trailing `.dataset` suffix. */
function normDataset(ref: unknown): string {
  return String(ref ?? "").replace(/\.dataset$/, "");
}

/** Render a `table` value that may be a string or a `{db, schema, name}` object. */
function tableRef(t: unknown): string {
  if (t && typeof t === "object") {
    const o = t as Raw;
    return [o.db, o.schema, o.name].filter(Boolean).join(".");
  }
  return String(t ?? "");
}

// ============================================================
// Main entry point
// ============================================================

export function generateReportFromSml(c: SmlCollection, opts: SmlReportOptions = {}): string {
  const out: string[] = [];

  const catalog = c.catalog ?? {};
  const title = opts.title ?? String(catalog.label ?? catalog.unique_name ?? "SML Model");

  // ── Cross-references ───────────────────────────────────────────────────────

  const factDatasets = new Set<string>();
  const dimDatasets = new Set<string>();
  const datasetRelCount = new Map<string, number>();
  for (const m of c.models) {
    for (const rel of asArray<Raw>(m.raw.relationships)) {
      const ds = normDataset(rel?.from?.dataset);
      if (!ds) continue;
      factDatasets.add(ds);
      datasetRelCount.set(ds, (datasetRelCount.get(ds) ?? 0) + 1);
    }
  }
  const datasetAttrCount = new Map<string, number>();
  for (const d of c.dimensions) {
    for (const la of asArray<Raw>(d.raw.level_attributes)) {
      const ds = normDataset(la?.dataset);
      if (ds) {
        dimDatasets.add(ds);
        datasetAttrCount.set(ds, (datasetAttrCount.get(ds) ?? 0) + 1);
      }
      for (const sec of asArray<Raw>(la?.secondary_attributes)) {
        const secDs = normDataset(sec?.dataset);
        if (secDs) datasetAttrCount.set(secDs, (datasetAttrCount.get(secDs) ?? 0) + 1);
      }
    }
    for (const rel of asArray<Raw>(d.raw.relationships)) {
      const ds = normDataset(rel?.from?.dataset);
      if (ds) datasetAttrCount.set(ds, (datasetAttrCount.get(ds) ?? 0) + 1);
    }
  }

  const metricByName = new Map<string, SmlObject>();
  for (const m of c.metrics) if (m.raw.unique_name) metricByName.set(String(m.raw.unique_name), m);
  const calcByName = new Map<string, SmlObject>();
  for (const cc of c.calculations) if (cc.raw.unique_name) calcByName.set(String(cc.raw.unique_name), cc);

  // ── Header ──────────────────────────────────────────────────────────────────

  out.push(`# ${title}`, "");
  if (opts.smlDirName) out.push(`> Source: \`${opts.smlDirName}\``, "");
  if (catalog.unique_name) {
    out.push(`> Catalog \`${catalog.unique_name}\`${catalog.version ? ` · version ${catalog.version}` : ""}`, "");
  }

  const hierCount = c.dimensions.reduce((n, d) => n + asArray(d.raw.hierarchies).length, 0);
  const levelCount = c.dimensions.reduce(
    (n, d) => n + asArray<Raw>(d.raw.hierarchies).reduce((k, h) => k + asArray(h.levels).length, 0),
    0,
  );
  const perspectives = c.models.flatMap((m) => asArray<Raw>(m.raw.perspectives));

  out.push("## Summary", "");
  out.push(
    ...table(
      ["Object", "Count"],
      [
        ["Models", String(c.models.length)],
        ["Datasets", String(c.datasets.length)],
        ["Connections", String(c.connections.length)],
        ["Dimensions", String(c.dimensions.length)],
        ["Hierarchies", String(hierCount)],
        ["Levels", String(levelCount)],
        ["Metrics", String(c.metrics.length)],
        ["Calculations", String(c.calculations.length)],
        ["Perspectives", String(perspectives.length)],
        ["Other objects", String(c.other.length)],
      ].filter((r) => r[1] !== "0"),
    ),
  );

  // ── Table of contents ──────────────────────────────────────────────────────

  const sections = ["Connections", "Datasets", "Dimensions", "Models", "Metrics", "Calculations"];
  if (perspectives.length) sections.push("Perspectives");
  sections.push("Security");
  if (c.other.length) sections.push("Other Objects");

  out.push("## Table of Contents", "");
  for (const sec of sections) out.push(`- [${sec}](#${anchor(sec)})`);
  out.push("");

  // ── Connections ─────────────────────────────────────────────────────────────

  out.push("## Connections", "");
  if (c.connections.length) {
    const rows = c.connections.map((conn) => [
      code(conn.raw.unique_name),
      cell(conn.raw.label),
      code(conn.raw.as_connection),
      cell(conn.raw.database),
      cell(conn.raw.schema),
    ]);
    out.push(...table(["Unique name", "Label", "AtScale connection", "Database", "Schema"], rows));
  } else {
    out.push("_No connections found._", "");
  }

  // ── Datasets ────────────────────────────────────────────────────────────────

  out.push("## Datasets", "");
  for (const d of c.datasets) {
    const nn = normDataset(d.raw.unique_name);
    const kind = factDatasets.has(nn) ? "Fact" : dimDatasets.has(nn) ? "Dimension" : "Unreferenced";
    renderDataset(out, d, kind);
  }

  // ── Dimensions ──────────────────────────────────────────────────────────────

  out.push("## Dimensions", "");
  for (const d of c.dimensions) renderDimension(out, d);

  // ── Models ──────────────────────────────────────────────────────────────────

  out.push("## Models", "");
  for (const m of c.models) renderModel(out, m);

  // ── Metrics (library) ────────────────────────────────────────────────────────

  out.push("## Metrics", "");
  out.push(
    "The metrics library — every metric defined in this SML directory, whether or not a model currently references it.",
    "",
  );
  if (c.metrics.length) {
    const rows = c.metrics.map((m) => [
      code(m.raw.unique_name),
      cell(m.raw.label),
      code(m.raw.calculation_method),
      code(m.raw.dataset),
      code(m.raw.column),
      code(m.raw.format),
      cell(m.raw.folder),
      flag(m.raw.is_hidden),
    ]);
    out.push(
      ...table(["Unique name", "Label", "Aggregation", "Dataset", "Column", "Format", "Folder", "Hidden"], rows),
    );
  } else {
    out.push("_No metrics defined._", "");
  }

  // ── Calculations (library) ───────────────────────────────────────────────────

  out.push("## Calculations", "");
  out.push(
    "The calculations library — every calculated-metric formula defined in this SML directory, whether or not a model currently references it.",
    "",
  );
  if (c.calculations.length) {
    for (const calc of c.calculations) renderCalculation(out, calc);
  } else {
    out.push("_No calculations defined._", "");
  }

  // ── Perspectives ─────────────────────────────────────────────────────────────

  if (perspectives.length) {
    out.push("## Perspectives", "");
    for (const p of perspectives) {
      const nMetrics = asArray(p?.metrics).length;
      const nDims = asArray(p?.dimensions).length;
      out.push(`- **${cell(p?.label ?? p?.unique_name)}** — ${nMetrics} metric(s), ${nDims} dimension(s)`);
    }
    out.push("");
  }

  // ── Security ─────────────────────────────────────────────────────────────────

  renderSecurity(out, c);

  // ── Other (unrecognized object_type) ────────────────────────────────────────

  if (c.other.length) {
    out.push("## Other Objects", "");
    out.push(
      ...table(
        ["File", "object_type", "Unique name"],
        c.other.map((o) => [code(o.file), code(o.raw.object_type), code(o.raw.unique_name)]),
      ),
    );
  }

  out.push("---", "", "_Generated by `atscale-utils generate-report-from-sml`._", "");
  return out.join("\n");

  // ============================================================
  // Section renderers (closures over the cross-reference maps above)
  // ============================================================

  function renderDataset(o: string[], d: SmlObject, kind: string): void {
    const raw = d.raw;
    o.push(`### ${label(d)}  \`${kind}\``, "");
    if (raw.unique_name && raw.unique_name !== label(d)) o.push(`\`${raw.unique_name}\``, "");
    if (raw.description) o.push(cell(raw.description), "");

    const nn = normDataset(raw.unique_name);
    const meta: string[] = [];
    if (raw.connection_id) meta.push(`- Connection: \`${cell(raw.connection_id)}\``);
    if (raw.table) meta.push(`- Table: \`${cell(tableRef(raw.table))}\``);
    if (raw.sql) meta.push(`- Backed by a SQL query (view)`);
    if (raw.allow_aggregates !== undefined) meta.push(`- Allow aggregates: ${flag(raw.allow_aggregates) || "no"}`);
    meta.push(
      `- Used by ${datasetAttrCount.get(nn) ?? 0} level attribute(s) across all dimensions and ${datasetRelCount.get(nn) ?? 0} relationship(s) across all models`,
    );
    o.push(...meta, "");

    if (raw.sql) o.push("```sql", String(raw.sql).trim(), "```", "");

    const cols = asArray<Raw>(raw.columns);
    if (cols.length) {
      o.push(...table(["Column", "Data type", "Expression"], cols.map((col) => [code(col?.name), code(col?.data_type), code(col?.sql)])));
    }
    o.push(`_Source: \`${d.file}\`_`, "", "---", "");
  }

  function renderDimension(o: string[], d: SmlObject): void {
    const raw = d.raw;
    const dimType = raw.type ?? (raw.is_degenerate ? "degenerate" : "standard");
    o.push(`### ${label(d)}  \`${cell(dimType)}\``, "");
    if (raw.unique_name && raw.unique_name !== label(d)) o.push(`\`${raw.unique_name}\``, "");
    if (raw.description) o.push(cell(raw.description), "");

    const hierarchies = asArray<Raw>(raw.hierarchies);
    if (hierarchies.length) {
      o.push("**Hierarchies**", "");
      for (const h of hierarchies) {
        const levels = asArray<Raw>(h.levels).map((l) => cell(l?.unique_name ?? l));
        o.push(`- **${cell(h?.label ?? h?.unique_name)}**: ${levels.map((l) => `\`${l}\``).join(" → ") || "_(no levels)_"}`);
      }
      o.push("");
    }

    const attrs = asArray<Raw>(raw.level_attributes);
    if (attrs.length) {
      o.push("**Level attributes**", "");
      o.push(
        ...table(
          ["Attribute", "Label", "Bound to (dataset.column)", "Sort", "Time unit", "Unique key", "Hidden"],
          attrs.map((a) => [
            code(a?.unique_name),
            cell(a?.label),
            code(bindingLabel(a)),
            code(a?.sort_column),
            code(a?.time_unit),
            flag(a?.is_unique_key),
            flag(a?.is_hidden),
          ]),
        ),
      );

      const secondaries = attrs.flatMap((a) => asArray<Raw>(a?.secondary_attributes));
      if (secondaries.length) {
        o.push("**Secondary attributes**", "");
        o.push(
          ...table(
            ["Attribute", "Label", "Bound to (dataset.column)"],
            secondaries.map((a) => [code(a?.unique_name), cell(a?.label), code(bindingLabel(a))]),
          ),
        );
      }
    }

    const rels = asArray<Raw>(raw.relationships);
    if (rels.length) {
      o.push("**Snowflake / embedded joins**", "");
      o.push(
        ...table(
          ["From dataset", "Join columns", "To dimension", "To level", "Type"],
          rels.map((rel) => [
            code(normDataset(rel?.from?.dataset)),
            code(asArray(rel?.from?.join_columns).join(", ")),
            cell(rel?.to?.dimension),
            cell(rel?.to?.level),
            cell(rel?.type),
          ]),
        ),
      );
    }
    o.push(`_Source: \`${d.file}\`_`, "", "---", "");
  }

  /** A level/secondary attribute's own `dataset` + key/name column(s), rendered like the XML report's dataset.column bindings. */
  function bindingLabel(a: Raw): string {
    const ds = normDataset(a?.dataset);
    if (!ds) return "";
    const cols = asArray(a?.key_columns).length ? asArray(a.key_columns).join("+") : a?.name_column ?? "";
    return cols ? `${ds}.${cols}` : ds;
  }

  function renderModel(o: string[], m: SmlObject): void {
    const raw = m.raw;
    o.push(`### ${label(m)}`, "");
    if (raw.unique_name && raw.unique_name !== label(m)) o.push(`\`${raw.unique_name}\``, "");
    if (raw.description) o.push(cell(raw.description), "");

    const rels = asArray<Raw>(raw.relationships);
    const dsRefs = [...new Set(rels.map((rel) => normDataset(rel?.from?.dataset)).filter(Boolean))];
    if (dsRefs.length) o.push(`**Datasets:** ${dsRefs.map((d) => `\`${d}\``).join(", ")}`, "");

    if (rels.length) {
      o.push("**Joins (fact dataset → dimension level)**", "");
      o.push(
        ...table(
          ["From dataset", "Join columns", "To dimension", "To level", "Role play", "Type"],
          rels.map((rel) => [
            code(normDataset(rel?.from?.dataset)),
            code(asArray(rel?.from?.join_columns).join(", ")),
            cell(rel?.to?.dimension),
            cell(rel?.to?.level),
            cell(rel?.role_play),
            cell(rel?.type),
          ]),
        ),
      );
    }

    const dimNames = [...new Set(rels.map((rel) => String(rel?.to?.dimension ?? "")).filter(Boolean))];
    const degen = asArray<Raw>(raw.dimensions).map((x) => String(x?.unique_name ?? x?.name ?? x));
    if (dimNames.length || degen.length) {
      o.push(
        `**Dimensions used:** ${[...dimNames, ...degen.map((d) => `${d} (degenerate)`)].map((d) => `\`${d}\``).join(", ")}`,
        "",
      );
    }

    // Metrics used — resolved against the metrics library, mirroring how the
    // XML report resolves a cube's calculated-member refs against its schema library.
    const metricRows: string[][] = [];
    for (const ref of asArray<Raw>(raw.metrics)) {
      const refName = String(ref?.unique_name ?? ref);
      const def = metricByName.get(refName)?.raw;
      metricRows.push([
        code(refName),
        cell(def?.label),
        code(def?.calculation_method),
        code(def?.dataset),
        code(def?.column),
        cell(def?.folder),
        flag(def?.is_hidden),
      ]);
    }
    if (metricRows.length) {
      o.push("**Metrics used**", "");
      o.push(...table(["Name", "Label", "Aggregation", "Dataset", "Column", "Folder", "Hidden"], metricRows));
    }

    // Calculations used — resolved against the calculations library.
    const calcRows: string[][] = [];
    for (const ref of asArray<Raw>(raw.calculations)) {
      const refName = String(ref?.unique_name ?? ref);
      const def = calcByName.get(refName)?.raw;
      if (!def) continue;
      calcRows.push([code(refName), cell(def.label), code(def.expression), cell(def.format), flag(def.is_hidden)]);
    }
    if (calcRows.length) {
      o.push("**Calculations used**", "");
      o.push(...table(["Name", "Label", "Formula", "Format", "Hidden"], calcRows));
    }

    const perspectives = asArray<Raw>(raw.perspectives);
    if (perspectives.length) {
      o.push("**Perspectives**", "");
      for (const p of perspectives) {
        const nMetrics = asArray(p?.metrics).length;
        const nDims = asArray(p?.dimensions).length;
        o.push(`- **${cell(p?.label ?? p?.unique_name)}** — ${nMetrics} metric(s), ${nDims} dimension(s)`);
      }
      o.push("");
    }

    const aggregates = asArray<Raw>(raw.aggregates);
    if (aggregates.length || raw.allow_aggregates !== undefined) {
      o.push("**Aggregates**", "");
      if (raw.allow_aggregates !== undefined) o.push(`- Allow aggregates: ${flag(raw.allow_aggregates) || "no"}`);
      if (aggregates.length) o.push(`- ${aggregates.length} aggregate definition(s)`);
      o.push("");
    }

    const overrides = raw.overrides;
    if (overrides && typeof overrides === "object" && Object.keys(overrides).length) {
      o.push("**Query-name overrides**", "");
      o.push(
        ...table(["Object", "query_name"], Object.entries(overrides).map(([k, v]) => [code(k), code((v as Raw)?.query_name ?? v)])),
      );
    }

    if (raw.include_default_drillthrough !== undefined) {
      o.push(`**Drillthrough:** default drillthrough ${flag(raw.include_default_drillthrough) ? "enabled" : "disabled"}`, "");
    }

    o.push(`_Source: \`${m.file}\`_`, "", "---", "");
  }

  function renderCalculation(o: string[], calc: SmlObject): void {
    const raw = calc.raw;
    o.push(`### ${label(calc)}`, "");
    if (raw.unique_name && raw.unique_name !== label(calc)) o.push(`\`${raw.unique_name}\``, "");
    if (raw.description) o.push(cell(raw.description), "");
    const meta: string[] = [];
    if (raw.mdx_aggregate_function) meta.push(`- MDX aggregate: \`${cell(raw.mdx_aggregate_function)}\``);
    if (raw.format) meta.push(`- Format: \`${cell(raw.format)}\``);
    if (raw.is_hidden) meta.push(`- Hidden`);
    if (meta.length) o.push(...meta, "");
    if (raw.expression) o.push("```", String(raw.expression).trim(), "```", "");
    o.push(`_Source: \`${calc.file}\`_`, "", "---", "");
  }

  function renderSecurity(o: string[], coll: SmlCollection): void {
    o.push("## Security", "");
    const findings: string[] = [];

    const secObjs = [...coll.other, ...coll.models, ...coll.dimensions].filter((obj) =>
      String(obj.raw.object_type ?? "").toLowerCase().includes("security"),
    );
    for (const obj of secObjs) findings.push(`- \`${cell(obj.raw.object_type)}\` \`${cell(obj.raw.unique_name)}\` (\`${obj.file}\`)`);

    const SEC_KEYS = ["row_security", "dimension_security", "security"];
    for (const obj of [...coll.models, ...coll.dimensions]) {
      for (const k of SEC_KEYS) {
        if (obj.raw[k] !== undefined) findings.push(`- \`${k}\` on \`${cell(obj.raw.unique_name)}\` (\`${obj.file}\`)`);
      }
    }

    if (findings.length) {
      o.push("The following security definitions were found:", "", ...findings, "");
    } else {
      o.push("_No row-level or dimension security objects were found in this SML directory._", "");
    }
  }
}
