/**
 * Markdown generator for generate-sml-docs.
 *
 * Pure (no fs / no services): given the objects collected from an SML directory,
 * it returns a single Markdown document describing every object — catalog,
 * connections, datasets (fact vs dimension), dimensions (hierarchies, levels,
 * level attributes, secondary attributes, intra-dimension joins), models
 * (fact→dimension relationships with a Mermaid diagram, metric refs, degenerate
 * dimensions, perspectives, aggregates, overrides, drillthrough), metrics,
 * calculations, and any security objects.
 *
 * The output is plain GitHub-flavored Markdown (it is a technical reference that
 * renders on GitHub, so no embedded HTML/CSS). Mermaid diagrams are assembled by
 * joining lines with real newlines and never embed `\n` inside a node label,
 * per the project's Mermaid conventions.
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

export interface DocsOptions {
  title?: string;
}

// ── small helpers ───────────────────────────────────────────────────────────

/** Escape a value for use inside a Markdown table cell. */
function cell(v: unknown): string {
  if (v === undefined || v === null || v === "") return "";
  return String(v).replace(/\|/g, "\\|").replace(/\r?\n/g, " ").trim();
}

/** Inline code span, or empty string. */
function code(v: unknown): string {
  const s = cell(v);
  return s ? `\`${s}\`` : "";
}

/** A `yes`/blank flag cell for a boolean-ish value. */
function flag(v: unknown): string {
  return v === true || v === "true" || v === "yes" ? "yes" : "";
}

/** GitHub-style heading anchor for a title. */
function anchor(title: string): string {
  return title
    .toLowerCase()
    .replace(/[^\w\s-]/g, "")
    .trim()
    .replace(/\s+/g, "-");
}

/** Display label for an object: label → unique_name → file stem. */
function label(o: SmlObject): string {
  return String(o.raw.label ?? o.raw.unique_name ?? o.file);
}

/** Normalize a dataset reference by dropping a trailing `.dataset` suffix. */
function normDataset(ref: unknown): string {
  return String(ref ?? "").replace(/\.dataset$/, "");
}

function asArray<T = any>(v: unknown): T[] {
  if (Array.isArray(v)) return v as T[];
  if (v === undefined || v === null) return [];
  return [v as T];
}

/** Render a table; returns "" when there are no rows. */
function table(headers: string[], rows: string[][]): string[] {
  if (rows.length === 0) return [];
  const sep = headers.map(() => "---");
  return [
    `| ${headers.join(" | ")} |`,
    `| ${sep.join(" | ")} |`,
    ...rows.map((r) => `| ${r.join(" | ")} |`),
    "",
  ];
}

// ── main ──────────────────────────────────────────────────────────────────────

export function generateSmlDocs(c: SmlCollection, opts: DocsOptions = {}): string {
  const out: string[] = [];

  const catalog = c.catalog ?? {};
  const title =
    opts.title ?? String(catalog.label ?? catalog.unique_name ?? "SML Model Documentation");

  // Cross-reference: which datasets are facts (referenced by a model relationship)
  // and which back a dimension.
  const factDatasets = new Set<string>();
  const dimDatasets = new Set<string>();
  for (const m of c.models) {
    for (const rel of asArray(m.raw.relationships)) {
      if (rel?.from?.dataset) factDatasets.add(normDataset(rel.from.dataset));
    }
  }
  for (const d of c.dimensions) {
    for (const la of asArray(d.raw.level_attributes)) {
      if (la?.dataset) dimDatasets.add(normDataset(la.dataset));
    }
  }

  // ── Title + catalog overview ────────────────────────────────────────────────
  out.push(`# ${title}`, "");
  if (catalog.unique_name) {
    out.push(`> Catalog \`${catalog.unique_name}\`${catalog.version ? ` · version ${catalog.version}` : ""}`, "");
  }
  const catRows: string[][] = [];
  if (catalog.version !== undefined) catRows.push(["Version", code(catalog.version)]);
  if (catalog.aggressive_agg_promotion !== undefined)
    catRows.push(["Aggressive agg promotion", flag(catalog.aggressive_agg_promotion)]);
  if (catalog.build_speculative_aggs !== undefined)
    catRows.push(["Build speculative aggregates", flag(catalog.build_speculative_aggs)]);
  if (catRows.length) out.push(...table(["Setting", "Value"], catRows));

  // ── Summary counts ────────────────────────────────────────────────────────────
  const factCount = c.datasets.filter((d) => factDatasets.has(normDataset(d.raw.unique_name))).length;
  const hierCount = c.dimensions.reduce((n, d) => n + asArray(d.raw.hierarchies).length, 0);
  const levelCount = c.dimensions.reduce(
    (n, d) => n + asArray(d.raw.hierarchies).reduce((k: number, h: Raw) => k + asArray(h.levels).length, 0),
    0,
  );
  const perspectiveCount = c.models.reduce((n, m) => n + asArray(m.raw.perspectives).length, 0);

  out.push("## Summary", "");
  out.push(
    ...table(
      ["Object", "Count"],
      [
        ["Models", String(c.models.length)],
        ["Datasets", `${c.datasets.length} (${factCount} fact / ${dimDatasets.size} dimension-backing)`],
        ["Dimensions", String(c.dimensions.length)],
        ["Hierarchies", String(hierCount)],
        ["Levels", String(levelCount)],
        ["Metrics", String(c.metrics.length)],
        ["Calculations", String(c.calculations.length)],
        ["Perspectives", String(perspectiveCount)],
        ["Connections", String(c.connections.length)],
      ].filter((r) => r[1] !== "0"),
    ),
  );

  // ── Table of contents ──────────────────────────────────────────────────────────
  const sections: string[] = [];
  if (c.models.length) sections.push("Models");
  if (c.datasets.length) sections.push("Datasets");
  if (c.dimensions.length) sections.push("Dimensions");
  if (c.metrics.length) sections.push("Metrics");
  if (c.calculations.length) sections.push("Calculations");
  if (c.connections.length) sections.push("Connections");
  sections.push("Security");
  if (c.other.length) sections.push("Other Objects");

  out.push("## Table of Contents", "");
  for (const s of sections) out.push(`- [${s}](#${anchor(s)})`);
  out.push("");

  // ── Models ──────────────────────────────────────────────────────────────────────
  if (c.models.length) {
    out.push("## Models", "");
    for (const m of c.models) renderModel(out, m);
  }

  // ── Datasets ──────────────────────────────────────────────────────────────────────
  if (c.datasets.length) {
    out.push("## Datasets", "");
    for (const d of c.datasets) {
      const nn = normDataset(d.raw.unique_name);
      const kind = factDatasets.has(nn) ? "Fact" : dimDatasets.has(nn) ? "Dimension" : "Unreferenced";
      renderDataset(out, d, kind);
    }
  }

  // ── Dimensions ─────────────────────────────────────────────────────────────────────
  if (c.dimensions.length) {
    out.push("## Dimensions", "");
    for (const d of c.dimensions) renderDimension(out, d);
  }

  // ── Metrics ─────────────────────────────────────────────────────────────────────────
  if (c.metrics.length) {
    out.push("## Metrics", "");
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
      ...table(
        ["Unique name", "Label", "Aggregation", "Dataset", "Column", "Format", "Folder", "Hidden"],
        rows,
      ),
    );
  }

  // ── Calculations ────────────────────────────────────────────────────────────────────
  if (c.calculations.length) {
    out.push("## Calculations", "");
    for (const calc of c.calculations) renderCalculation(out, calc);
  }

  // ── Connections ────────────────────────────────────────────────────────────────────
  if (c.connections.length) {
    out.push("## Connections", "");
    const rows = c.connections.map((conn) => [
      code(conn.raw.unique_name),
      cell(conn.raw.label),
      code(conn.raw.as_connection),
      cell(conn.raw.database),
      cell(conn.raw.schema),
    ]);
    out.push(...table(["Unique name", "Label", "AtScale connection", "Database", "Schema"], rows));
  }

  // ── Security ──────────────────────────────────────────────────────────────────────────
  renderSecurity(out, c);

  // ── Other (unknown object types) ────────────────────────────────────────────────────
  if (c.other.length) {
    out.push("## Other Objects", "");
    out.push(
      ...table(
        ["File", "object_type", "Unique name"],
        c.other.map((o) => [code(o.file), code(o.raw.object_type), code(o.raw.unique_name)]),
      ),
    );
  }

  out.push("---", "", "_Generated by `atscale-utils generate-sml-docs`._", "");
  return out.join("\n");
}

// ── section renderers ──────────────────────────────────────────────────────────

function renderModel(out: string[], m: SmlObject): void {
  const raw = m.raw;
  out.push(`### ${label(m)}`, "");
  if (raw.unique_name && raw.unique_name !== label(m)) out.push(`\`${raw.unique_name}\``, "");
  if (raw.description) out.push(cell(raw.description), "");

  const rels = asArray<Raw>(raw.relationships);

  // Mermaid fact → dimension diagram (assembled with real newlines; no `\n` in labels).
  if (rels.length) {
    const ids = new Map<string, string>();
    const idFor = (name: string): string => {
      if (!ids.has(name)) ids.set(name, `n${ids.size}`);
      return ids.get(name)!;
    };
    const lines: string[] = ["```mermaid", "flowchart LR"];
    const nodeDecls: string[] = [];
    const edges: string[] = [];
    for (const rel of rels) {
      const fact = normDataset(rel?.from?.dataset);
      const dim = String(rel?.to?.dimension ?? rel?.to?.level ?? "");
      if (!fact || !dim) continue;
      const fId = idFor(`fact:${fact}`);
      const dId = idFor(`dim:${dim}`);
      nodeDecls.push(`  ${fId}["${mermaidLabel(fact)}"]`);
      nodeDecls.push(`  ${dId}(["${mermaidLabel(dim)}"])`);
      const rp = rel?.role_play ? `|${mermaidLabel(String(rel.role_play))}|` : "";
      edges.push(`  ${fId} -->${rp} ${dId}`);
    }
    // De-duplicate node declarations while keeping order.
    const seen = new Set<string>();
    for (const nd of nodeDecls) if (!seen.has(nd)) { seen.add(nd); lines.push(nd); }
    lines.push(...edges, "```");
    if (edges.length) out.push(...lines, "");
  }

  // Relationships / joins table.
  if (rels.length) {
    out.push("**Relationships (fact → dimension joins)**", "");
    out.push(
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

  const metrics = asArray<Raw>(raw.metrics);
  if (metrics.length) {
    out.push("**Metrics**", "");
    out.push(metrics.map((x) => `\`${cell(x?.unique_name ?? x)}\``).join(", "), "");
  }

  const degen = asArray<Raw>(raw.dimensions);
  if (degen.length) {
    out.push("**Degenerate / model dimensions**", "");
    out.push(degen.map((x) => `\`${cell(x?.unique_name ?? x?.name ?? x)}\``).join(", "), "");
  }

  const perspectives = asArray<Raw>(raw.perspectives);
  if (perspectives.length) {
    out.push("**Perspectives**", "");
    for (const p of perspectives) {
      const nMetrics = asArray(p?.metrics).length;
      const nDims = asArray(p?.dimensions).length;
      out.push(`- **${cell(p?.label ?? p?.unique_name)}** — ${nMetrics} metric(s), ${nDims} dimension(s)`);
    }
    out.push("");
  }

  const aggregates = asArray<Raw>(raw.aggregates);
  if (aggregates.length || raw.allow_aggregates !== undefined) {
    out.push("**Aggregates**", "");
    if (raw.allow_aggregates !== undefined) out.push(`- Allow aggregates: ${flag(raw.allow_aggregates) || "no"}`);
    if (aggregates.length) out.push(`- ${aggregates.length} aggregate definition(s)`);
    out.push("");
  }

  const overrides = raw.overrides;
  if (overrides && typeof overrides === "object" && Object.keys(overrides).length) {
    out.push("**Query-name overrides**", "");
    out.push(
      ...table(
        ["Object", "query_name"],
        Object.entries(overrides).map(([k, v]) => [code(k), code((v as Raw)?.query_name ?? v)]),
      ),
    );
  }

  if (raw.include_default_drillthrough !== undefined) {
    out.push(`**Drillthrough:** default drillthrough ${flag(raw.include_default_drillthrough) ? "enabled" : "disabled"}`, "");
  }

  out.push(`_Source: \`${m.file}\`_`, "", "---", "");
}

function renderDataset(out: string[], d: SmlObject, kind: string): void {
  const raw = d.raw;
  out.push(`### ${label(d)}  \`${kind}\``, "");
  if (raw.unique_name && raw.unique_name !== label(d)) out.push(`\`${raw.unique_name}\``, "");
  if (raw.description) out.push(cell(raw.description), "");

  const meta: string[] = [];
  if (raw.connection_id) meta.push(`- Connection: \`${cell(raw.connection_id)}\``);
  if (raw.table) meta.push(`- Table: \`${cell(tableRef(raw.table))}\``);
  if (raw.sql) meta.push(`- Backed by SQL query`);
  if (meta.length) out.push(...meta, "");

  if (raw.sql) out.push("```sql", String(raw.sql).trim(), "```", "");

  const cols = asArray<Raw>(raw.columns);
  if (cols.length) {
    out.push(
      ...table(
        ["Column", "Data type", "Expression"],
        cols.map((col) => [code(col?.name), code(col?.data_type), code(col?.sql)]),
      ),
    );
  }
  out.push(`_Source: \`${d.file}\`_`, "", "---", "");
}

function renderDimension(out: string[], d: SmlObject): void {
  const raw = d.raw;
  const dimType = raw.type ?? (raw.is_degenerate ? "degenerate" : "standard");
  out.push(`### ${label(d)}  \`${cell(dimType)}\``, "");
  if (raw.unique_name && raw.unique_name !== label(d)) out.push(`\`${raw.unique_name}\``, "");
  if (raw.description) out.push(cell(raw.description), "");

  // Hierarchies → ordered levels.
  const hierarchies = asArray<Raw>(raw.hierarchies);
  if (hierarchies.length) {
    out.push("**Hierarchies**", "");
    for (const h of hierarchies) {
      const levels = asArray<Raw>(h.levels).map((l) => cell(l?.unique_name ?? l));
      out.push(`- **${cell(h?.label ?? h?.unique_name)}**: ${levels.map((l) => `\`${l}\``).join(" → ") || "_(no levels)_"}`);
    }
    out.push("");
  }

  // Level attributes.
  const attrs = asArray<Raw>(raw.level_attributes);
  if (attrs.length) {
    out.push("**Level attributes**", "");
    out.push(
      ...table(
        ["Attribute", "Label", "Dataset", "Key columns", "Name column", "Sort", "Time unit", "Unique key", "Hidden"],
        attrs.map((a) => [
          code(a?.unique_name),
          cell(a?.label),
          code(a?.dataset),
          code(asArray(a?.key_columns).join(", ")),
          code(a?.name_column),
          code(a?.sort_column),
          code(a?.time_unit),
          flag(a?.is_unique_key),
          flag(a?.is_hidden),
        ]),
      ),
    );

    // Secondary attributes hanging off level attributes.
    const secondaries = attrs.flatMap((a) => asArray<Raw>(a?.secondary_attributes));
    if (secondaries.length) {
      out.push("**Secondary attributes**", "");
      out.push(
        ...table(
          ["Attribute", "Label", "Dataset", "Key columns", "Name column"],
          secondaries.map((a) => [
            code(a?.unique_name),
            cell(a?.label),
            code(a?.dataset),
            code(asArray(a?.key_columns).join(", ")),
            code(a?.name_column),
          ]),
        ),
      );
    }
  }

  // Intra-dimension relationships (snowflake / embedded joins).
  const rels = asArray<Raw>(raw.relationships);
  if (rels.length) {
    out.push("**Snowflake / embedded joins**", "");
    out.push(
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

  out.push(`_Source: \`${d.file}\`_`, "", "---", "");
}

function renderCalculation(out: string[], calc: SmlObject): void {
  const raw = calc.raw;
  out.push(`### ${label(calc)}`, "");
  if (raw.unique_name && raw.unique_name !== label(calc)) out.push(`\`${raw.unique_name}\``, "");
  if (raw.description) out.push(cell(raw.description), "");
  const meta: string[] = [];
  if (raw.mdx_aggregate_function) meta.push(`- MDX aggregate: \`${cell(raw.mdx_aggregate_function)}\``);
  if (raw.format) meta.push(`- Format: \`${cell(raw.format)}\``);
  if (meta.length) out.push(...meta, "");
  if (raw.expression) out.push("```", String(raw.expression).trim(), "```", "");
  out.push(`_Source: \`${calc.file}\`_`, "", "---", "");
}

function renderSecurity(out: string[], c: SmlCollection): void {
  out.push("## Security", "");
  const findings: string[] = [];

  // Security objects surfaced as their own object_type.
  const secObjs = [...c.other, ...c.models, ...c.dimensions].filter((o) =>
    String(o.raw.object_type ?? "").toLowerCase().includes("security"),
  );
  for (const o of secObjs) findings.push(`- \`${cell(o.raw.object_type)}\` \`${cell(o.raw.unique_name)}\` (\`${o.file}\`)`);

  // Security-related keys embedded in models or dimensions.
  const SEC_KEYS = ["row_security", "dimension_security", "security"];
  for (const o of [...c.models, ...c.dimensions]) {
    for (const k of SEC_KEYS) {
      if (o.raw[k] !== undefined) findings.push(`- \`${k}\` on \`${cell(o.raw.unique_name)}\` (\`${o.file}\`)`);
    }
  }

  if (findings.length) {
    out.push("The following security definitions were found:", "", ...findings, "");
  } else {
    out.push(
      "_No row-level or dimension security objects were found in this SML directory._",
      "",
    );
  }
}

// ── formatting utilities ─────────────────────────────────────────────────────

/** Render a `table` value that may be a string or a `{db, schema, name}` object. */
function tableRef(t: unknown): string {
  if (t && typeof t === "object") {
    const o = t as Raw;
    return [o.db, o.schema, o.name].filter(Boolean).join(".");
  }
  return String(t ?? "");
}

/**
 * Sanitize a string for a Mermaid label. Mermaid's lexer treats quotes, pipes,
 * brackets, braces, parentheses, angle brackets, `#`, `;`, and backticks as
 * syntax (e.g. `{` opens a rhombus node), so strip them from labels — including
 * role_play placeholders like `{0}` — and collapse whitespace.
 */
function mermaidLabel(s: string): string {
  return s
    .replace(/["'`|{}()\[\]<>#;]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}
