/**
 * SML Generation Report
 *
 * Generates a REPORT.md file summarising the inference decisions, generated
 * files, model diagram, and the full AtScale SML Style Guide.
 *
 * Intended to be called once from generate-sml-shared.ts after all SML files
 * have been written to disk.
 */
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import type { SemanticModel } from "./types.js";
import type { SmlSerializerOptions } from "./sml-serializer.js";
import { isSystemColumn } from "./attribute-inference.js";

// ----------------------------------------------------------
// Style guide loader / copier
// ----------------------------------------------------------

function styleGuidePath(): string {
  // Compiled module lives at dist/algorithm/report-generator.js
  // STYLE.md is at the project root: ../../STYLE.md relative to dist/algorithm/
  const moduleDir = path.dirname(fileURLToPath(import.meta.url));
  return path.resolve(moduleDir, "../../STYLE.md");
}

/** Copy STYLE.md to outputDir. Returns true on success. */
export function copyStyleGuide(outputDir: string): boolean {
  try {
    const src  = styleGuidePath();
    const dest = path.join(outputDir, "STYLE.md");
    fs.copyFileSync(src, dest);
    return true;
  } catch {
    return false;
  }
}

// ----------------------------------------------------------
// Metric unique-name helper (mirrors sml-serializer logic)
// ----------------------------------------------------------

function factAbbrev(tableName: string): string {
  return tableName.split("_").filter(Boolean).map((w) => w[0]).join("").toLowerCase();
}

function metricUniqueName(sourceColumn: string, aggregation: string, factTable: string, prefix = "m_"): string {
  return `${prefix}${factAbbrev(factTable)}_${sourceColumn.toLowerCase()}_${aggregation.toLowerCase()}`;
}

/** Build a map of kebab-filename stem → human description for all metrics. */
function buildMetricDescMap(model: SemanticModel): Map<string, string> {
  const map = new Map<string, string>();
  for (const fact of model.facts) {
    for (const m of fact.measures) {
      const uniqueName = metricUniqueName(m.sourceColumn, m.aggregation, fact.sourceTable);
      const kebab      = uniqueName.replace(/_/g, "-");
      const desc       = `${m.aggregation} of \`${m.sourceColumn}\` from \`${fact.sourceTable}\` (folder: \`${fact.sourceTable}_metrics\`)`;
      map.set(kebab, desc);
      map.set(uniqueName, desc);  // also index by underscore form
    }
  }
  return map;
}

// ----------------------------------------------------------
// Mermaid diagram
// ----------------------------------------------------------

function buildMermaid(model: SemanticModel): string {
  const lines: string[] = ["```mermaid", "flowchart LR"];

  const factNames    = new Set(model.facts.map((f) => f.name));
  const bridgePat    = /^\[BRIDGE TABLE\] "(.+?)"/;
  const bridgeTables = new Set(
    model.warnings
      .map((w) => bridgePat.exec(w)?.[1])
      .filter(Boolean) as string[],
  );

  // Subgraph: Facts
  if (model.facts.length > 0) {
    lines.push("    subgraph Facts");
    for (const f of model.facts) {
      const id    = nodeId(f.name);
      const label = `${f.name}<br/>${f.measures.length} measure(s)`;
      lines.push(`        ${id}["${label}"]:::fact`);
    }
    lines.push("    end");
  }

  // Subgraph: Dimensions (bridge tables styled differently)
  if (model.dimensions.length > 0) {
    lines.push("    subgraph Dimensions");
    for (const d of model.dimensions) {
      const id      = nodeId(d.name);
      const isBridge = bridgeTables.has(d.sourceTable);
      const label   = `${d.name}<br/>${d.hierarchies.length} hier, ${d.attributes.length} attr`;
      lines.push(`        ${id}["${label}"]:::${isBridge ? "bridge" : "dim"}`);
    }
    lines.push("    end");
  }

  // Relationships from the model (fact→dim solid, dim→dim dashed)
  for (const rel of model.relationships) {
    const fromId = nodeId(rel.fromDataset);
    const toId   = nodeId(rel.toDataset);
    const cols   = (rel.fromColumns ?? [rel.fromColumn]).join(", ");
    const arrow  = factNames.has(rel.fromDataset) ? "-->" : "-.->";
    lines.push(`    ${fromId} ${arrow}|"${cols}"| ${toId}`);
  }

  lines.push("");
  lines.push("    classDef fact   fill:#dbeafe,stroke:#3b82f6,color:#1e3a5f");
  lines.push("    classDef dim    fill:#dcfce7,stroke:#22c55e,color:#14532d");
  lines.push("    classDef bridge fill:#fef9c3,stroke:#eab308,color:#713f12");
  lines.push("```");
  return lines.join("\n");
}

function nodeId(name: string): string {
  return name.replace(/[^a-zA-Z0-9]/g, "_");
}

// ----------------------------------------------------------
// File table
// ----------------------------------------------------------

const FILE_TYPE_LABELS: Record<string, string> = {
  connections: "Connection",
  datasets:    "Dataset",
  dimensions:  "Dimension",
  metrics:     "Metric",
  models:      "Model",
};

function fileTypeLabel(relativePath: string): string {
  if (relativePath === "catalog.yml") return "Catalog";
  const dir = relativePath.split("/")[0];
  return FILE_TYPE_LABELS[dir] ?? dir;
}

function fileDescription(
  relativePath: string,
  model: SemanticModel,
  catalogName: string | undefined,
  metricDescMap: Map<string, string>,
): string {
  const parts = relativePath.split("/");
  const dir   = parts[0];
  const base  = parts[parts.length - 1].replace(/\.yml$/, "");

  if (relativePath === "catalog.yml") {
    return `AtScale catalog labeled "${catalogName ?? model.name}"`;
  }
  if (dir === "connections") {
    return `Database connection definition`;
  }
  if (dir === "datasets") {
    const fact = model.facts.find((f) => f.sourceTable === base);
    if (fact) {
      return `Source table mapping for fact \`${base}\` (${fact.measures.length} measure column(s))`;
    }
    const dim = model.dimensions.find((d) => d.sourceTable === base);
    if (dim) {
      return `Source table mapping for dimension \`${base}\` (${dim.attributes.length} attribute(s))`;
    }
    return `Source table mapping for \`${base}\``;
  }
  if (dir === "dimensions") {
    const dim = model.dimensions.find(
      (d) => d.sourceTable.toLowerCase() === base.toLowerCase() ||
             d.name.toLowerCase().replace(/\s+/g, "_") === base.toLowerCase(),
    );
    if (dim) {
      return `Dimension "${dim.name}" — ${dim.hierarchies.length} hierarchy(s), ${dim.attributes.length} attribute(s)`;
    }
    return `Dimension definition for \`${base}\``;
  }
  if (dir === "metrics") {
    const desc = metricDescMap.get(base);
    if (desc) return desc;
    return `Metric definition \`${base}\``;
  }
  if (dir === "models") {
    return (
      `Model "${model.name}" — ` +
      `${model.relationships.length} relationship(s), ` +
      `${model.facts.reduce((n, f) => n + f.measures.length, 0)} metric(s)`
    );
  }
  return "";
}

// ----------------------------------------------------------
// Fact table column breakdown
// ----------------------------------------------------------

function factTableSection(model: SemanticModel, buckets: Map<string, string[]>): string {
  const columnsByTable = model.columnsByTable;
  if (!columnsByTable || model.facts.length === 0) return "";

  // Build lookup: fact name → relationships originating from it
  const relsByFact = new Map<string, typeof model.relationships>();
  for (const rel of model.relationships) {
    const list = relsByFact.get(rel.fromDataset) ?? [];
    list.push(rel);
    relsByFact.set(rel.fromDataset, list);
  }

  // Which columns were inferred as FK (no declared constraint)?
  const inferFKPat     = /^"(.+?)"\."(.+?)" →/;
  const inferredPairs  = new Set(
    (buckets.get("INFERRED FK") ?? [])
      .map((w) => { const m = inferFKPat.exec(w); return m ? `${m[1].toLowerCase()}|${m[2].toLowerCase()}` : null; })
      .filter(Boolean) as string[],
  );

  const lines: string[] = [];

  for (const fact of model.facts) {
    const cols = columnsByTable.get(fact.sourceTable) ?? [];
    if (cols.length === 0) continue;

    lines.push(`### \`${fact.sourceTable}\``);
    lines.push(``);

    // Index FK columns → relationships
    const rels       = relsByFact.get(fact.name) ?? [];
    const fkColToRel = new Map<string, typeof rels>();
    for (const rel of rels) {
      const joinCols = rel.fromColumns ?? [rel.fromColumn];
      for (const col of joinCols) {
        const list = fkColToRel.get(col) ?? [];
        list.push(rel);
        fkColToRel.set(col, list);
      }
    }

    // Index measures → list per source column
    const measuresByCol = new Map<string, typeof fact.measures>();
    for (const m of fact.measures) {
      const list = measuresByCol.get(m.sourceColumn) ?? [];
      list.push(m);
      measuresByCol.set(m.sourceColumn, list);
    }

    // Index degenerate dimensions
    const degenerateCols = new Set(fact.degenerateDimensions.map((d) => d.sourceColumn));

    lines.push(`| Column | Type | Decision | Detail |`);
    lines.push(`|---|---|---|---|`);

    for (const col of cols) {
      const measures   = measuresByCol.get(col.columnName);
      const fkRels     = fkColToRel.get(col.columnName);
      const isDegenerate = degenerateCols.has(col.columnName);

      let decision: string;
      let detail: string;

      if (measures && measures.length > 0) {
        const metricNames = measures
          .map((m) => `\`${metricUniqueName(m.sourceColumn, m.aggregation, fact.sourceTable)}\``)
          .join(", ");
        const metricDetail = `Generated: ${metricNames}`;

        if (fkRels && fkRels.length > 0) {
          // Column is both a COUNT metric source and a FK (e.g. PK that is also joined)
          const links = fkRels.map((rel) => {
            const joinCols = (rel.fromColumns ?? [rel.fromColumn]).join(", ");
            const pairKey  = `${fact.sourceTable.toLowerCase()}|${rel.fromColumn.toLowerCase()}`;
            const how      = inferredPairs.has(pairKey) ? "naming convention" : "declared FK";
            return `→ \`${rel.toDataset}\` via \`${joinCols}\` (${how})`;
          });
          decision = "Metric / FK";
          detail   = `${metricDetail}; ${Array.from(new Set(links)).join("; ")}`;
        } else {
          decision = "Metric";
          detail   = metricDetail;
        }

      } else if (fkRels && fkRels.length > 0) {
        decision = "Foreign Key";
        const links = fkRels.map((rel) => {
          const joinCols  = (rel.fromColumns ?? [rel.fromColumn]).join(", ");
          const pairKey   = `${fact.sourceTable.toLowerCase()}|${rel.fromColumn.toLowerCase()}`;
          const how       = inferredPairs.has(pairKey) ? "naming convention" : "declared FK";
          return `→ \`${rel.toDataset}\` via \`${joinCols}\` (${how})`;
        });
        detail = Array.from(new Set(links)).join("; ");

      } else if (isDegenerate) {
        decision = "Attribute";
        detail   = "Kept as degenerate dimension (non-numeric, non-key)";

      } else if (col.isPrimaryKey) {
        decision = "Primary Key";
        detail   = "Fact grain identifier — not exposed as metric or attribute";

      } else {
        // Column exists in schema but was not included in the semantic layer
        decision = "Omitted";
        const reasons: string[] = [];
        if (/^(au_|source_create|source_update|qlik_last)/i.test(col.columnName)) {
          reasons.push("system/audit column pattern");
        }
        if (reasons.length === 0) reasons.push("see Column Omissions section");
        detail = reasons.join("; ");
      }

      lines.push(`| \`${col.columnName}\` | \`${col.dataType}\` | ${decision} | ${detail} |`);
    }

    lines.push(``);
  }

  return lines.join("\n");
}

// ----------------------------------------------------------
// Decision sections
// ----------------------------------------------------------

/** Parse warnings into buckets by their [TAG] prefix. */
function bucketWarnings(warnings: string[]): Map<string, string[]> {
  const buckets = new Map<string, string[]>();
  const tagPat  = /^\[([^\]]+)\]\s*/;

  for (const w of warnings) {
    const m   = tagPat.exec(w);
    const tag = m ? m[1] : "OTHER";
    const msg = m ? w.slice(m[0].length) : w;
    const list = buckets.get(tag) ?? [];
    list.push(msg);
    buckets.set(tag, list);
  }
  return buckets;
}

function classificationTable(model: SemanticModel, buckets: Map<string, string[]>): string {
  const bridgePat    = /^"(.+?)"\s+classified/;
  const bridgeTables = new Set(
    (buckets.get("BRIDGE TABLE") ?? [])
      .map((w) => bridgePat.exec(w)?.[1])
      .filter(Boolean) as string[],
  );

  const rows: string[] = [
    "| Table | Classification | Signal |",
    "|---|---|---|",
  ];

  for (const f of model.facts) {
    rows.push(`| \`${f.sourceTable}\` | **Fact** | Has FK references to other tables and at least one numeric measure column |`);
  }
  for (const d of model.dimensions) {
    if (bridgeTables.has(d.sourceTable)) {
      rows.push(`| \`${d.sourceTable}\` | **Shared Dimension** (bridge) | FKs to ≥2 tables and ≤1 non-key payload column |`);
    } else {
      rows.push(`| \`${d.sourceTable}\` | **Dimension** | No qualifying fact-table signals |`);
    }
  }
  return rows.join("\n");
}

function relationshipTable(model: SemanticModel, buckets: Map<string, string[]>): string {
  // Build a set of "fromTableName|fromColumnName" pairs that came from naming-convention inference.
  // Warning format: "query_parts"."query_id" → "queries"."query_id" (naming convention...)
  const inferFKPat = /^"(.+?)"\."(.+?)" →/;
  const inferredPairs = new Set(
    (buckets.get("INFERRED FK") ?? [])
      .map((w) => {
        const m = inferFKPat.exec(w);
        return m ? `${m[1].toLowerCase()}|${m[2].toLowerCase()}` : null;
      })
      .filter(Boolean) as string[],
  );

  const rows: string[] = [
    "| From Dataset | Join Columns | To Dimension | Source |",
    "|---|---|---|---|",
  ];

  for (const rel of model.relationships) {
    const cols     = (rel.fromColumns ?? [rel.fromColumn]).join(", ");
    // Map dimension name back to source table to look up in inferred pairs
    const fromDim  = model.dimensions.find((d) => d.name === rel.fromDataset);
    const fromFact = model.facts.find((f) => f.name === rel.fromDataset);
    const fromTable = (fromDim?.sourceTable ?? fromFact?.sourceTable ?? rel.fromDataset).toLowerCase();
    const pairKey  = `${fromTable}|${rel.fromColumn.toLowerCase()}`;
    const source   = inferredPairs.has(pairKey)
      ? "Naming convention (no FK declared)"
      : "Declared `FOREIGN KEY`";
    rows.push(`| \`${rel.fromDataset}\` | \`${cols}\` | \`${rel.toDataset}\` | ${source} |`);
  }
  return rows.join("\n");
}

function omissionsSection(buckets: Map<string, string[]>): string {
  const sections: string[] = [];

  const pii = [
    ...(buckets.get("PII EXCLUSION") ?? []),
    ...(buckets.get("PHI EXCLUSION") ?? []),
    ...(buckets.get("PII") ?? []),
    ...(buckets.get("PHI") ?? []),
  ];
  if (pii.length > 0) {
    sections.push("### PII / HIPAA Exclusions\n");
    sections.push("Columns excluded from the semantic layer due to detected PII or PHI content:\n");
    for (const w of pii) sections.push(`- ${w}`);
  }

  const audit = buckets.get("AUDIT COLS") ?? [];
  if (audit.length > 0) {
    sections.push("\n### ETL / Audit Columns\n");
    sections.push("Columns present in source tables that should be excluded from the semantic layer:\n");
    for (const w of audit) sections.push(`- ${w}`);
  }

  return sections.join("\n") || "_No column omissions detected._";
}

// ----------------------------------------------------------
// Public API
// ----------------------------------------------------------

export interface ReportOptions {
  connectionName: string;
  catalogName?:   string;
  schema?:        string;
  database?:      string;
  dialect?:       string;
}

export function generateReport(
  model:   SemanticModel,
  smlOpts: ReportOptions,
): string {
  const smlFiles      = model.sml ?? new Map<string, string>();
  const buckets       = bucketWarnings(model.warnings);
  const metricDescMap = buildMetricDescMap(model);
  const lines: string[] = [];

  // ----------------------------------------------------------
  // Header
  // ----------------------------------------------------------
  lines.push(`# SML Generation Report`);
  lines.push(``);
  lines.push(`| Property | Value |`);
  lines.push(`|---|---|`);
  lines.push(`| **Model** | \`${model.name}\` |`);
  lines.push(`| **Generated** | ${model.generatedAt} |`);
  lines.push(`| **Connection** | \`${smlOpts.connectionName}\` |`);
  if (smlOpts.catalogName) lines.push(`| **Catalog** | ${smlOpts.catalogName} |`);
  if (smlOpts.database)    lines.push(`| **Database** | \`${smlOpts.database}\` |`);
  if (smlOpts.schema)      lines.push(`| **Schema** | \`${smlOpts.schema}\` |`);
  if (smlOpts.dialect)     lines.push(`| **Dialect** | ${smlOpts.dialect} |`);
  const secondaryAttrCount = model.columnsByTable
    ? model.dimensions.reduce((total, dim) => {
        const cols = model.columnsByTable!.get(dim.sourceTable) ?? [];
        return total + cols.filter((col) => !isSystemColumn(col.columnName)).length;
      }, 0)
    : undefined;
  lines.push(`| **Facts** | ${model.facts.length} |`);
  lines.push(`| **Dimensions** | ${model.dimensions.length} |`);
  lines.push(`| **Metrics** | ${model.facts.reduce((n, f) => n + f.measures.length, 0)} |`);
  if (secondaryAttrCount !== undefined) {
    lines.push(`| **Secondary Attributes** | ${secondaryAttrCount} |`);
  }
  lines.push(`| **Relationships** | ${model.relationships.length} |`);
  lines.push(`| **Files generated** | ${smlFiles.size} |`);
  lines.push(``);

  // ----------------------------------------------------------
  // Table of contents
  // ----------------------------------------------------------
  lines.push(`## Table of Contents`);
  lines.push(``);
  lines.push(`1. [Model Diagram](#model-diagram)`);
  lines.push(`2. [Generated Files](#generated-files)`);
  lines.push(`3. [Fact Table Detail](#fact-table-detail)`);
  lines.push(`4. [Inference Decisions](#inference-decisions)`);
  lines.push(`   - [Table Classification](#table-classification)`);
  lines.push(`   - [Relationship Inference](#relationship-inference)`);
  lines.push(`   - [Column Omissions](#column-omissions)`);
  if (
    (buckets.get("ROLE-PLAYING")         ?? []).length > 0 ||
    (buckets.get("CONFORMED DIM")        ?? []).length > 0 ||
    (buckets.get("SCD TYPE 2")           ?? []).length > 0 ||
    (buckets.get("LIKELY MISCLASSIFIED") ?? []).length > 0 ||
    (buckets.get("OTHER")                ?? []).length > 0
  ) {
    lines.push(`   - [Structural Notes](#structural-notes)`);
  }
  lines.push(``);

  // ----------------------------------------------------------
  // Model diagram
  // ----------------------------------------------------------
  lines.push(`---`);
  lines.push(``);
  lines.push(`## Model Diagram`);
  lines.push(``);
  lines.push(`Solid arrows (→) are fact-to-dimension joins. Dashed arrows (-.->) are dimension-to-dimension (snowflake) joins. Bridge/junction tables are shown in yellow.`);
  lines.push(``);
  lines.push(buildMermaid(model));
  lines.push(``);

  // ----------------------------------------------------------
  // Generated files
  // ----------------------------------------------------------
  lines.push(`---`);
  lines.push(``);
  lines.push(`## Generated Files`);
  lines.push(``);
  lines.push(`| File | Type | Description |`);
  lines.push(`|---|---|---|`);

  const sortedFiles = Array.from(smlFiles.keys()).sort();
  for (const relPath of sortedFiles) {
    const typeLabel = fileTypeLabel(relPath);
    const desc      = fileDescription(relPath, model, smlOpts.catalogName, metricDescMap);
    lines.push(`| \`${relPath}\` | ${typeLabel} | ${desc} |`);
  }
  lines.push(``);

  // ----------------------------------------------------------
  // Fact table detail
  // ----------------------------------------------------------
  lines.push(`---`);
  lines.push(``);
  lines.push(`## Fact Table Detail`);
  lines.push(``);
  lines.push(`Each column in every fact table is listed with how it was treated during inference.`);
  lines.push(``);
  lines.push(factTableSection(model, buckets));

  // ----------------------------------------------------------
  // Inference decisions
  // ----------------------------------------------------------
  lines.push(`---`);
  lines.push(``);
  lines.push(`## Inference Decisions`);
  lines.push(``);

  // Classification
  lines.push(`### Table Classification`);
  lines.push(``);
  lines.push(`Classification priority: explicit bridge/dim/lookup naming patterns → explicit fact naming patterns → FK topology (FKs present + numeric payload columns) → dimension fallback.`);
  lines.push(``);
  lines.push(classificationTable(model, buckets));
  lines.push(``);

  // Relationships
  lines.push(`### Relationship Inference`);
  lines.push(``);
  lines.push(`Relationships are built from declared FK constraints first. When a column named \`<stem>_id\`, \`<stem>_key\`, or \`<stem>_sk\` exists without a declared FK, the engine searches for a table named \`<stem>\` or \`<stem>s\` with a matching single-column primary key and synthesises the join.`);
  lines.push(``);

  const inferredFKs = buckets.get("INFERRED FK") ?? [];
  if (inferredFKs.length > 0) {
    lines.push(`**Inferred (naming convention — no FK declared in schema):**`);
    lines.push(``);
    for (const w of inferredFKs) lines.push(`- ${w}`);
    lines.push(``);
  }

  lines.push(relationshipTable(model, buckets));
  lines.push(``);

  // Column omissions
  lines.push(`### Column Omissions`);
  lines.push(``);
  lines.push(omissionsSection(buckets));
  lines.push(``);

  // Other structural warnings
  const structural: string[] = [
    ...(buckets.get("ROLE-PLAYING")        ?? []).map((w) => `**[ROLE-PLAYING]** ${w}`),
    ...(buckets.get("CONFORMED DIM")       ?? []).map((w) => `**[CONFORMED DIM]** ${w}`),
    ...(buckets.get("SCD TYPE 2")          ?? []).map((w) => `**[SCD TYPE 2]** ${w}`),
    ...(buckets.get("LIKELY MISCLASSIFIED")?? []).map((w) => `**[LIKELY MISCLASSIFIED]** ${w}`),
    ...(buckets.get("OTHER")               ?? []).map((w) => `**[WARNING]** ${w}`),
  ];
  if (structural.length > 0) {
    lines.push(`### Structural Notes`);
    lines.push(``);
    for (const w of structural) lines.push(`- ${w}`);
    lines.push(``);
  }

  lines.push(`---`);
  lines.push(``);
  lines.push(`*See [STYLE.md](./STYLE.md) for the naming conventions applied during generation.*`);
  lines.push(``);

  return lines.join("\n");
}
