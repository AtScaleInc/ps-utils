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
import type { SemanticModel } from "./types.js";
import type { SmlSerializerOptions } from "./sml-serializer.js";
import { isSystemColumn } from "./attribute-inference.js";

// ----------------------------------------------------------
// Style guide generator
// ----------------------------------------------------------

/**
 * Settings that affect the content of the generated STYLE.md.
 * Mirrors the relevant fields of SmlStyleConfig but lives in the algorithm
 * layer to avoid importing from the operations layer.
 */
export interface StyleGuideOptions {
  /** Resolved catalog display name (model-name fallback already applied). */
  catalogName:       string;
  /** PII exclusion threshold: "HIGH" | "MEDIUM" | "LOW" | "none". */
  piiSeverity:       string;
  /** Whether dataset/dimension filenames use camelCase. */
  camelCaseFiles:    boolean;
  /** Whether metric labels use camelCase.
   * @deprecated Prefer `labelStyle`. */
  camelCaseMeasures: boolean;
  /** Label style for all SML object labels. */
  labelStyle: "title-case" | "camel-case" | "none";
  /** Tables explicitly forced as facts (empty = auto-detected). */
  factTables:        string[];
  /** Rows sampled per table for type inference (0 = disabled). */
  sampleSize:        number;
  /** Minimum hierarchies a dimension must have to be included (default 1). */
  minHierarchiesPerDim: number;
  /** Maximum hierarchies kept per dimension (default 4). */
  maxHierarchiesPerDim: number;
}

function buildStyleGuide(opts: StyleGuideOptions): string {
  const { catalogName, piiSeverity, camelCaseFiles, camelCaseMeasures, labelStyle, factTables, sampleSize, minHierarchiesPerDim, maxHierarchiesPerDim } = opts;
  const effectiveLabelStyle = labelStyle ?? (camelCaseMeasures ? "camel-case" : "title-case");

  // ── Derived descriptions ──────────────────────────────────────────────────
  const piiDesc = piiSeverity.toUpperCase() === "NONE"
    ? "Disabled — all columns included regardless of PII classification"
    : `${piiSeverity.toUpperCase()} and above — columns at lower severity are included`;

  const fileNamingDesc = camelCaseFiles
    ? "camelCase — source table name converted to lowerCamelCase (e.g. `factInventoryTransaction.yml`)"
    : "snake_case — source table name used as-is (e.g. `fact_inventory_transaction.yml`)";

  const labelNamingDesc = effectiveLabelStyle === "camel-case"
    ? "camelCase — column + aggregation in lowerCamelCase (e.g. `primaryQuantitySum`)"
    : effectiveLabelStyle === "none"
    ? "none — raw source column + underscore + aggregation (e.g. `primary_quantity_sum`)"
    : "Title Case — column Title Case + aggregation suffix (e.g. `Primary Quantity Sum`)";

  const labelStyleDesc = effectiveLabelStyle === "camel-case"
    ? "camel-case — strip affixes, apply lowerCamelCase to all labels"
    : effectiveLabelStyle === "none"
    ? "none — raw source table/column name used as label, no transformation"
    : "title-case — strip affixes, apply Title Case to all labels (default)";

  const factTablesDesc = factTables.length > 0
    ? factTables.map((t) => `\`${t}\``).join(", ")
    : "Auto-detected via FK topology and naming patterns";

  const sampleDesc = sampleSize === 0 ? "Disabled" : `${sampleSize} rows per table`;
  const hierarchyLimitsDesc = `min ${minHierarchiesPerDim} / max ${maxHierarchiesPerDim} per dimension`;

  // ── Metric label examples ─────────────────────────────────────────────────
  const metricLabelRows = effectiveLabelStyle === "camel-case"
    ? [
        "| `primary_quantity` | `SUM` | `primaryQuantitySum` |",
        "| `extended_cost` | `AVG` | `extendedCostAvg` |",
        "| `line_amount` | `MIN` | `lineAmountMin` |",
      ]
    : effectiveLabelStyle === "none"
    ? [
        "| `primary_quantity` | `SUM` | `primary_quantity_sum` |",
        "| `extended_cost` | `AVG` | `extended_cost_avg` |",
        "| `line_amount` | `MIN` | `line_amount_min` |",
      ]
    : [
        "| `primary_quantity` | `SUM` | `Primary Quantity Sum` |",
        "| `extended_cost` | `AVG` | `Extended Cost Avg` |",
        "| `line_amount` | `MIN` | `Line Amount Min` |",
      ];

  // ── File naming examples ──────────────────────────────────────────────────
  const dsExamples = camelCaseFiles
    ? [
        "| `fact_inventory_transaction` | `datasets/factInventoryTransaction.yml` |",
        "| `dim_customer_dimension` | `datasets/dimCustomerDimension.yml` |",
        "| `dim_product_dimension` | `dimensions/dimProductDimension.yml` |",
      ]
    : [
        "| `fact_inventory_transaction` | `datasets/fact_inventory_transaction.yml` |",
        "| `dim_customer_dimension` | `datasets/dim_customer_dimension.yml` |",
        "| `dim_product_dimension` | `dimensions/dim_product_dimension.yml` |",
      ];

  // ── PII exclusion section ─────────────────────────────────────────────────
  const piiUppercase = piiSeverity.toUpperCase();
  let piiSectionBody: string;
  if (piiUppercase === "NONE") {
    piiSectionBody = [
      "PII exclusion is **disabled** for this generation (`pii-severity: none`). All columns from",
      "dimension source tables are included as secondary attributes regardless of any PII",
      "classification — subject only to the system-column patterns below.",
    ].join("\n");
  } else {
    const severityRows: string[] = [];
    if (piiUppercase === "HIGH" || piiUppercase === "MEDIUM" || piiUppercase === "LOW") {
      severityRows.push("| HIGH | SSN / national ID, passwords, credit card / payment card numbers, biometric identifiers |");
    }
    if (piiUppercase === "MEDIUM" || piiUppercase === "LOW") {
      severityRows.push("| MEDIUM | Email addresses, phone numbers, date of birth, government ID numbers |");
    }
    if (piiUppercase === "LOW") {
      severityRows.push("| LOW | Full names, street addresses, ZIP/postal codes, IP addresses |");
    }
    piiSectionBody = [
      `PII exclusion threshold: **${piiSeverity.toUpperCase()}** — columns at this severity`,
      `and above are excluded from secondary attributes. Columns at lower severity levels are`,
      `included. Adjust via \`pii-severity\` in \`sml.style.yaml\` or \`--pii-severity\` on the CLI.`,
      ``,
      `The following PII severity levels were **excluded** during this generation:`,
      ``,
      `| Severity | Examples |`,
      `|---|---|`,
      ...severityRows,
    ].join("\n");
  }

  // ── Fact classification note ──────────────────────────────────────────────
  const factClassNote = factTables.length > 0
    ? `\n> **Fact table override:** The following tables were explicitly classified as facts via \`fact-tables\` in \`sml.style.yaml\`: ${factTables.map((t) => `\`${t}\``).join(", ")}. Automatic FK-topology classification was bypassed for these tables.\n`
    : "";

  // ── Build the full document ───────────────────────────────────────────────
  return [
    `# AtScale SML Naming Conventions`,
    ``,
    `> Generated by \`generate-sml-from-connection\` / \`generate-sml-from-ddl\`.`,
    `> Settings from \`sml.style.yaml\` — edit that file to change these conventions.`,
    ``,
    `## Table of Contents`,
    ``,
    `- [Generation Settings](#generation-settings)`,
    `- [0. Label Style](#0-label-style)`,
    `- [1. Metrics (Measures)](#1-metrics-measures)`,
    `  - [1.1 Unique Name](#11-unique-name)`,
    `  - [1.2 Display Name (Label)](#12-display-name-label)`,
    `  - [1.3 Format](#13-format)`,
    `  - [1.4 Folders](#14-folders)`,
    `- [2. Dimensions](#2-dimensions)`,
    `  - [2.1 Display Name (Label)](#21-display-name-label)`,
    `- [3. Hierarchies](#3-hierarchies)`,
    `  - [3.1 Display Name (Label)](#31-display-name-label)`,
    `  - [3.2 Hierarchy Count Limits](#32-hierarchy-count-limits)`,
    `  - [3.3 Unique Name](#33-unique-name)`,
    `- [4. Levels](#4-levels)`,
    `  - [4.1 Unique Name](#41-unique-name)`,
    `  - [4.2 Display Name (Label)](#42-display-name-label)`,
    `  - [4.3 Visualize in BI Tool](#43-visualize-in-bi-tool)`,
    `- [5. Secondary Attributes](#5-secondary-attributes)`,
    `  - [5.1 Inclusion Rule](#51-inclusion-rule)`,
    `  - [5.2 Display Name](#52-display-name)`,
    `- [6. Additional Conventions](#6-additional-conventions)`,
    `  - [6.1 Dataset Labels](#61-dataset-labels)`,
    `  - [6.2 Model and Catalog Labels](#62-model-and-catalog-labels)`,
    `  - [6.3 Metric Description](#63-metric-description)`,
    `  - [6.4 Surrogate Key Level Attributes](#64-surrogate-key-level-attributes)`,
    `  - [6.5 Fact Table Abbreviation Collisions](#65-fact-table-abbreviation-collisions)`,
    `  - [6.6 Metric File Naming](#66-metric-file-naming)`,
    `  - [6.7 Dataset and Dimension File Naming](#67-dataset-and-dimension-file-naming)`,
    ``,
    `---`,
    ``,
    `## Generation Settings`,
    ``,
    `| Setting | Value |`,
    `|---|---|`,
    `| **Catalog** | ${catalogName} |`,
    `| **PII Exclusion** | ${piiDesc} |`,
    `| **Label Style** | ${labelStyleDesc} |`,
    `| **File Naming** | ${fileNamingDesc} |`,
    `| **Metric Labels** | ${labelNamingDesc} |`,
    `| **Fact Tables** | ${factTablesDesc} |`,
    `| **Sample Size** | ${sampleDesc} |`,
    `| **Hierarchies per Dim** | ${hierarchyLimitsDesc} |`,
    ``,
    `---`,
    ``,
    `## 0. Label Style`,
    ``,
    `[↑ Table of Contents](#table-of-contents)`,
    ``,
    `The \`label-style\` setting controls how display labels are derived from source`,
    `table and column names for **all** SML objects: datasets, dimensions, hierarchies,`,
    `level attributes, secondary attributes, and metrics.`,
    ``,
    `| Value | Behaviour | Example source | Example label |`,
    `|---|---|---|---|`,
    `| \`title-case\` (default) | Strip \`dim_\`, \`_dimension\`, \`_key\`, etc., then Title Case | \`dim_customer_dimension\` | \`Customer\` |`,
    `| \`camel-case\` | Strip same affixes, then lowerCamelCase | \`dim_customer_dimension\` | \`customer\` |`,
    `| \`none\` | Use the raw source name with no transformation | \`dim_customer_dimension\` | \`dim_customer_dimension\` |`,
    ``,
    `Configure via \`label-style\` in \`sml.style.yaml\` or \`--label-style\` on the CLI.`,
    `This generation used: **${effectiveLabelStyle}**`,
    ``,
    `> **Note:** \`camel-case-measures\` is a legacy per-metric flag that predates`,
    `> \`label-style\`. When \`label-style\` is set, it overrides \`camel-case-measures\`.`,
    ``,
    `---`,
    ``,
    `## 1. Metrics (Measures)`,
    ``,
    `### 1.1 Unique Name`,
    ``,
    `**Pattern:** \`m_<fact_abbrev>_<column>_<aggregation>\``,
    ``,
    `The fact-table abbreviation is the initials of each word in the fact table name.`,
    ``,
    `| Fact table | Abbreviation |`,
    `|---|---|`,
    `| \`fact_inventory_transaction\` | \`fit\` |`,
    `| \`fact_sales_order_line\` | \`fsol\` |`,
    `| \`fact_purchase_order\` | \`fpo\` |`,
    `| \`fact_general_ledger\` | \`fgl\` |`,
    ``,
    `**Examples:**`,
    ``,
    `| Column | Aggregation | Unique Name |`,
    `|---|---|---|`,
    `| \`primary_quantity\` | \`sum\` | \`m_fit_primary_quantity_sum\` |`,
    `| \`extended_cost\` | \`avg\` | \`m_fit_extended_cost_avg\` |`,
    `| \`order_amount\` | \`sum\` | \`m_fsol_order_amount_sum\` |`,
    ``,
    `---`,
    ``,
    `### 1.2 Display Name (Label)`,
    ``,
    ...(effectiveLabelStyle === "camel-case"
      ? [
          `**Pattern:** \`<columnCamelCase><AggSuffix>\` (lowerCamelCase)`,
          ``,
          `The column name is converted to camelCase and the aggregation suffix is appended`,
          `in TitleCase (no space).`,
        ]
      : effectiveLabelStyle === "none"
      ? [
          `**Pattern:** \`<source_column>_<aggregation>\` (raw snake_case)`,
          ``,
          `The raw source column name and lowercase aggregation are joined with an underscore.`,
        ]
      : [
          `**Pattern:** \`<Column Title Case> <Aggregate>\``,
          ``,
          `The aggregate suffix is appended (not prepended) using its full display form.`,
        ]),
    ``,
    `| Aggregation | Display suffix |`,
    `|---|---|`,
    `| \`SUM\` | \`Sum\` |`,
    `| \`AVG\` | \`Avg\` |`,
    `| \`MIN\` | \`Min\` |`,
    `| \`MAX\` | \`Max\` |`,
    `| \`COUNT\` | \`Count\` |`,
    ``,
    `**Examples:**`,
    ``,
    `| Column | Aggregation | Label |`,
    `|---|---|---|`,
    ...metricLabelRows,
    ``,
    `---`,
    ``,
    `### 1.3 Format`,
    ``,
    `All metrics default to \`"#,##0"\` (Standard — thousands separator, no decimals).`,
    `Rate/ratio metrics (those whose aggregation set contains only \`AVG/MIN/MAX\`) use`,
    `\`"#,##0.00"\` (two decimal places).`,
    ``,
    `\`\`\`mermaid`,
    `flowchart LR`,
    `    A[Metric] --> B{Aggregations include SUM?}`,
    `    B -- Yes --> C["format: #,##0"]`,
    `    B -- No --> D["format: #,##0.00"]`,
    `\`\`\``,
    ``,
    `---`,
    ``,
    `### 1.4 Folders`,
    ``,
    `Group all metrics from the same fact table into a subfolder named after that table.`,
    `The folder name is always derived from the source table name (snake_case), independent`,
    `of the file naming setting.`,
    ``,
    `| Fact table | Folder |`,
    `|---|---|`,
    `| \`fact_inventory_transaction\` | \`fact_inventory_transaction_metrics\` |`,
    `| \`fact_sales_order_line\` | \`fact_sales_order_line_metrics\` |`,
    ``,
    `\`\`\`mermaid`,
    `graph TD`,
    `    Model --> F1["fact_inventory_transaction_metrics/"]`,
    `    Model --> F2["fact_sales_order_line_metrics/"]`,
    `    F1 --> M1[m_fit_primary_quantity_sum]`,
    `    F1 --> M2[m_fit_extended_cost_avg]`,
    `    F2 --> M3[m_fsol_order_amount_sum]`,
    `\`\`\``,
    ``,
    `---`,
    ``,
    `## 2. Dimensions`,
    ``,
    `### 2.1 Display Name (Label)`,
    ``,
    `Strip the \`dim_\` prefix and \`_dimension\` suffix from the source table name, then convert`,
    `the remaining words to Title Case.`,
    ``,
    `| Source table | Label |`,
    `|---|---|`,
    `| \`dim_po_line_dimension\` | \`PO Line\` |`,
    `| \`dim_customer_dimension\` | \`Customer\` |`,
    `| \`dim_product_dimension\` | \`Product\` |`,
    `| \`dim_date\` | \`Date\` |`,
    ``,
    `---`,
    ``,
    `## 3. Hierarchies`,
    ``,
    `### 3.1 Display Name (Label)`,
    ``,
    `Strip \`dim_\`/\`_dimension\`, Title Case the result, then append \` Hierarchy\`.`,
    ``,
    `| Source table | Hierarchy label |`,
    `|---|---|`,
    `| \`dim_po_line_dimension\` | \`PO Line Hierarchy\` |`,
    `| \`dim_customer_dimension\` | \`Customer Hierarchy\` |`,
    ``,
    `### 3.2 Hierarchy Count Limits`,
    ``,
    `| Setting | Value |`,
    `|---|---|`,
    `| **min-hierarchies-per-dim** | ${minHierarchiesPerDim} — dimensions with fewer hierarchies are excluded from the model |`,
    `| **max-hierarchies-per-dim** | ${maxHierarchiesPerDim} — if more hierarchies are inferred, only the first ${maxHierarchiesPerDim} are kept |`,
    ``,
    `Configure via \`min-hierarchies-per-dim\` / \`max-hierarchies-per-dim\` in \`sml.style.yaml\` or the corresponding CLI flags.`,
    ``,
    `### 3.3 Unique Name`,
    ``,
    `Replace spaces with underscores and lowercase the full label.`,
    ``,
    `| Hierarchy label | Hierarchy unique_name |`,
    `|---|---|`,
    `| \`PO Line Hierarchy\` | \`po_line_hierarchy\` |`,
    `| \`Date Hierarchy\` | \`date_hierarchy\` |`,
    `| \`Geography Hierarchy\` | \`geography_hierarchy\` |`,
    ``,
    `\`\`\`mermaid`,
    `flowchart LR`,
    `    A["dim_po_line_dimension"] -->|strip dim_/_dimension| B["po_line"]`,
    `    B -->|Title Case + Hierarchy| C["label: PO Line Hierarchy"]`,
    `    C -->|lowercase + underscores| D["unique_name: po_line_hierarchy"]`,
    `\`\`\``,
    ``,
    `---`,
    ``,
    `## 4. Levels`,
    ``,
    `### 4.1 Unique Name`,
    ``,
    `Set the level's \`unique_name\` to the key column name (snake_case, as-is from the source`,
    `table). Do **not** append suffixes such as \`_level\` or \`_attribute\`.`,
    ``,
    `| Key column | Level unique_name |`,
    `|---|---|`,
    `| \`po_line_key\` | \`po_line_key\` |`,
    `| \`customer_key\` | \`customer_key\` |`,
    `| \`date_key\` | \`date_key\` |`,
    ``,
    `### 4.2 Display Name (Label)`,
    ``,
    `Strip \`dim_\`, \`_dimension\`, \`_key\`, \`_id\`, \`_sk\`, and \`_level\` suffixes from the column`,
    `name, then Title Case.`,
    ``,
    `| Key column | Level label |`,
    `|---|---|`,
    `| \`po_line_key\` | \`PO Line\` |`,
    `| \`customer_key\` | \`Customer\` |`,
    `| \`date_key\` | \`Date\` |`,
    ``,
    `### 4.3 Visualize in BI Tool`,
    ``,
    `The leaf (most granular) level of every hierarchy must have`,
    `\`visualize_in_bi_tool: false\` so that surrogate key values are not exposed to`,
    `end-users in BI tools.`,
    ``,
    `---`,
    ``,
    `## 5. Secondary Attributes`,
    ``,
    `### 5.1 Inclusion Rule`,
    ``,
    piiSectionBody,
    ``,
    `In addition, columns whose names match any of the following system-column patterns`,
    `are always excluded regardless of PII setting:`,
    ``,
    `| Pattern | Rationale |`,
    `|---|---|`,
    `| \`au_*\` | AtScale system columns |`,
    `| \`source_create*\` | ETL audit columns |`,
    `| \`source_update*\` | ETL audit columns |`,
    `| \`qlik_last*\` | Qlik replication metadata |`,
    ``,
    `The key/leaf column must also be included (as a secondary attribute on the leaf level`,
    `attribute).`,
    ``,
    `### 5.2 Display Name`,
    ``,
    `Replace underscores with spaces and capitalize each word.`,
    ``,
    `| Column name | Secondary attribute label |`,
    `|---|---|`,
    `| \`source_system_code\` | \`Source System Code\` |`,
    `| \`po_line_status_desc\` | \`Po Line Status Desc\` |`,
    `| \`created_date\` | \`Created Date\` |`,
    ``,
    `---`,
    ``,
    `## 6. Additional Conventions`,
    ``,
    `### 6.1 Dataset Labels`,
    ``,
    `Dataset labels use Title Case derived from the source table name rather than the raw`,
    `snake_case name.`,
    ``,
    `| Table name | Dataset label |`,
    `|---|---|`,
    `| \`fact_inventory_transaction\` | \`Fact Inventory Transaction\` |`,
    `| \`dim_customer_dimension\` | \`Dim Customer Dimension\` |`,
    ``,
    `### 6.2 Model and Catalog Labels`,
    ``,
    `The catalog label for this generation is **${catalogName}**.`,
    `The model \`label\` matches the catalog label, not the technical model unique_name.`,
    `Configure via \`catalog-name\` in \`sml.style.yaml\` or \`--catalog-name\` on the CLI.`,
    ``,
    `### 6.3 Metric Description`,
    ``,
    `Each metric carries an auto-generated \`description\` in the form:`,
    ``,
    `> \`<Aggregation display> of <Column human name> from <Fact table Title Case>\``,
    ``,
    `Example: \`Sum of Primary Quantity from Fact Inventory Transaction\``,
    ``,
    `### 6.4 Surrogate Key Level Attributes`,
    ``,
    `When a level attribute's key column ends in \`_key\`, \`_sk\`, or \`_id\` and its data type`,
    `is an integer **and** a companion display column exists (resolved by \`findNameColumn\`),`,
    `the level attribute is marked \`is_hidden: true\` so the raw surrogate key is not visible`,
    `in BI tool field lists.`,
    ``,
    `### 6.5 Fact Table Abbreviation Collisions`,
    ``,
    `Two fact tables may share the same abbreviation (e.g. \`fact_item_type\` and`,
    `\`fact_invoice_total\` both abbreviate to \`fit\`). When this occurs, metric unique_names`,
    `will collide. Verify that all fact table abbreviations are unique across the model;`,
    `disambiguate by renaming tables at the source or by adding the \`--metric-prefix\` option`,
    `with an explicit prefix.`,
    ``,
    `### 6.6 Metric File Naming`,
    ``,
    `Metric filenames use the full \`unique_name\` (including fact abbreviation) converted to`,
    `kebab-case, ensuring no collisions when multiple fact tables share measure column names.`,
    ``,
    `### 6.7 Dataset and Dimension File Naming`,
    ``,
    ...(camelCaseFiles
      ? [
          `Dataset and dimension filenames use **camelCase** derived from the source table name`,
          `(\`camel-case-files: true\`).`,
        ]
      : [
          `Dataset and dimension filenames use the **raw source table name** (snake_case,`,
          `\`camel-case-files: false\`).`,
        ]),
    ``,
    `| Source table | Output file |`,
    `|---|---|`,
    ...dsExamples,
    ``,
    ...(factClassNote ? [factClassNote] : []),
  ].join("\n");
}

/**
 * Generate STYLE.md in outputDir reflecting the actual generation settings.
 * Returns true on success.
 */
export function generateStyleGuide(outputDir: string, opts: StyleGuideOptions): boolean {
  try {
    const dest = path.join(outputDir, "STYLE.md");
    fs.mkdirSync(outputDir, { recursive: true });
    fs.writeFileSync(dest, buildStyleGuide(opts), "utf8");
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
