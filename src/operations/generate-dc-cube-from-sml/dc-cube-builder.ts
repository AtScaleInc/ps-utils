/**
 * Data Catalog Cube builder — pure functions, no I/O.
 *
 * Walks every model's metrics and fact→dimension relationships and emits one catalog row per
 * model / metric / fact join / dimension / attribute path. Those rows back a small, self-describing
 * AtScale model (the "Data Catalog Cube") that lets BI users browse which metrics can be sliced by
 * which attributes, through which fact join keys.
 *
 * A metric reaches a dimension only through a relationship whose `from.dataset` is the metric's own
 * dataset; calculations have no dataset and are not catalogued. Missing references are reported as
 * warnings and skipped rather than thrown, so a half-finished model never blocks the refresh.
 */

export type Raw = Record<string, unknown>;

export interface DCCubeInput {
  models: Raw[];
  metrics: Raw[];
  dimensions: Raw[];
}

export const CATALOG_COLUMNS = [
  "catalog_row_id",
  "model_name",
  "model_label",
  "measure_name",
  "measure_label",
  "aggregation",
  "fact_dataset",
  "fact_column",
  "fact_join_key",
  "relationship_name",
  "dimension_name",
  "dimension_label",
  "attribute_name",
  "attribute_label",
  "attribute_type",
  "dimension_dataset",
  "attribute_key_column",
] as const;

export type CatalogColumn = (typeof CATALOG_COLUMNS)[number];
export type CatalogRow = Record<CatalogColumn, string>;

export interface DCCubeNames {
  modelName: string;
  datasetName: string;
}

export const DEFAULT_DC_CUBE_NAMES: DCCubeNames = {
  modelName: "data_catalog_cube",
  datasetName: "data_catalog_relationships",
};

const asArray = <T = Raw>(v: unknown): T[] => (Array.isArray(v) ? (v as T[]) : []);
const str = (v: unknown): string => (v === undefined || v === null ? "" : String(v).trim());
const titleCase = (s: string): string => s.split(" ").map((w) => (w ? w[0].toUpperCase() + w.slice(1).toLowerCase() : w)).join(" ");

interface AttributeEntry {
  name: string;
  label: string;
  type: "Level" | "Join Level" | "Secondary Attribute";
  dataset: string;
  keyColumns: string;
}

/** Every attribute a dimension exposes through its hierarchies: each level, then that level's secondary attributes. */
function dimensionAttributes(dim: Raw, joinLevel: string, warnings: string[]): AttributeEntry[] {
  const byName = new Map(asArray(dim.level_attributes).map((a) => [str(a.unique_name), a]));
  const out: AttributeEntry[] = [];
  for (const h of asArray(dim.hierarchies)) {
    for (const lvl of asArray(h.levels)) {
      const a = byName.get(str(lvl.unique_name));
      if (!a) {
        warnings.push(`${str(dim.unique_name)}: level ${str(lvl.unique_name)} has no level_attribute; skipped`);
        continue;
      }
      out.push({
        name: str(a.unique_name),
        label: str(a.label) || str(a.unique_name),
        type: str(a.unique_name) === joinLevel ? "Join Level" : "Level",
        dataset: str(a.dataset),
        keyColumns: asArray<string>(a.key_columns).join(","),
      });
      for (const sa of asArray(lvl.secondary_attributes)) {
        out.push({
          name: str(sa.unique_name),
          label: str(sa.label) || str(sa.unique_name),
          type: "Secondary Attribute",
          dataset: str(sa.dataset),
          keyColumns: asArray<string>(sa.key_columns).join(","),
        });
      }
    }
  }
  return out;
}

/** Build the catalog rows. Models are visited in unique_name order so the output is stable across runs. */
export function buildCatalogRows(input: DCCubeInput, names: DCCubeNames = DEFAULT_DC_CUBE_NAMES): { rows: CatalogRow[]; warnings: string[] } {
  const warnings: string[] = [];
  const metrics = new Map(input.metrics.map((m) => [str(m.unique_name), m]));
  const dims = new Map(input.dimensions.map((d) => [str(d.unique_name), d]));
  const models = input.models
    .filter((m) => str(m.object_type || "model") === "model" && str(m.unique_name) !== names.modelName)
    .sort((a, b) => str(a.unique_name).localeCompare(str(b.unique_name)));

  const rows: CatalogRow[] = [];
  for (const model of models) {
    const modelName = str(model.unique_name);
    for (const ref of asArray(model.metrics)) {
      const metricName = str(ref.unique_name);
      const metric = metrics.get(metricName);
      if (!metric) {
        warnings.push(`${modelName}: metric ${metricName} not found in metrics/; skipped`);
        continue;
      }
      for (const rel of asArray(model.relationships)) {
        const from = (rel.from ?? {}) as Raw;
        const to = (rel.to ?? {}) as Raw;
        if (str(from.dataset) !== str(metric.dataset)) continue;
        const dim = dims.get(str(to.dimension));
        if (!dim) {
          warnings.push(`${modelName}: dimension ${str(to.dimension)} not found; skipped`);
          continue;
        }
        for (const attr of dimensionAttributes(dim, str(to.level), warnings)) {
          rows.push({
            catalog_row_id: String(rows.length + 1),
            model_name: modelName,
            model_label: str(model.label) || modelName,
            measure_name: metricName,
            measure_label: `${str(metric.label) || metricName} (${titleCase(str(metric.calculation_method))})`,
            aggregation: str(metric.calculation_method),
            fact_dataset: str(metric.dataset),
            fact_column: str(metric.column),
            fact_join_key: asArray<string>(from.join_columns).join(","),
            relationship_name: str(rel.unique_name),
            dimension_name: str(dim.unique_name),
            dimension_label: str(dim.label) || str(dim.unique_name),
            attribute_name: attr.name,
            attribute_label: attr.label,
            attribute_type: attr.type,
            dimension_dataset: attr.dataset,
            attribute_key_column: attr.keyColumns,
          });
        }
      }
    }
  }
  // De-duplicate warnings: a dimension shared by several relationships would otherwise repeat them.
  return { rows, warnings: [...new Set(warnings)] };
}

const sqlLiteral = (v: string): string => `'${v.replace(/'/g, "''")}'`;

/** A portable inline-VALUES query, so the catalog needs no physical table to deploy. */
export function buildValuesSql(rows: CatalogRow[]): string {
  const values = rows.map((r) => `  (${CATALOG_COLUMNS.map((c) => sqlLiteral(r[c])).join(", ")})`).join(",\n");
  return `SELECT * FROM (VALUES\n${values}\n) AS t (${CATALOG_COLUMNS.join(", ")})`;
}

const csvCell = (v: string): string => (/[",\n\r]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v);

export function buildCsv(rows: CatalogRow[]): string {
  const lines = [CATALOG_COLUMNS.join(","), ...rows.map((r) => CATALOG_COLUMNS.map((c) => csvCell(r[c])).join(","))];
  return lines.join("\r\n") + "\r\n";
}

export interface DCCubeObjectOptions extends DCCubeNames {
  connectionId: string;
  /** Physical table to read instead of the inline VALUES query. */
  table?: string;
}

/** The SML objects of the Data Catalog Cube, keyed by their path relative to the SML directory. */
export function buildDCCubeObjects(rows: CatalogRow[], opts: DCCubeObjectOptions): Record<string, Raw> {
  const ds = opts.datasetName;
  const attr = (unique_name: string, label: string, keys: string[], name_column: string): Raw => ({
    unique_name,
    label,
    dataset: ds,
    key_columns: keys,
    name_column,
  });

  const dataset: Raw = {
    unique_name: ds,
    object_type: "dataset",
    label: "Data Catalog Relationships",
    description: `One row per model / measure / fact / dimension / attribute path (${rows.length} rows). Generated by ps-utils generate-dc-cube-from-sml.`,
    connection_id: opts.connectionId,
    ...(opts.table ? { table: opts.table } : { sql: buildValuesSql(rows) }),
    columns: CATALOG_COLUMNS.map((name) => ({ name, data_type: "string" })),
  };

  const dimension = (unique_name: string, label: string, hierarchyLabel: string, levels: Raw[], levelAttributes: Raw[]): Raw => ({
    unique_name,
    object_type: "dimension",
    label,
    type: "standard",
    is_degenerate: true,
    hierarchies: [{ unique_name: `${unique_name}_hierarchy`, label: hierarchyLabel, levels }],
    level_attributes: levelAttributes,
  });

  const dcModel = dimension("dc_model", "Catalog Model", "Model", [{ unique_name: "dc_model_name" }], [
    attr("dc_model_name", "Model", ["model_name"], "model_label"),
  ]);
  const dcMeasure = dimension(
    "dc_measure", "Catalog Measure", "Measure",
    [{
      unique_name: "dc_measure_name",
      secondary_attributes: [
        attr("dc_measure_aggregation", "Aggregation", ["aggregation"], "aggregation"),
        attr("dc_measure_fact_column", "Measure Source Column", ["fact_column"], "fact_column"),
      ],
    }],
    [attr("dc_measure_name", "Measure", ["measure_name"], "measure_label")],
  );
  const dcFact = dimension(
    "dc_fact", "Catalog Fact", "Fact Join",
    [
      { unique_name: "dc_fact_dataset" },
      { unique_name: "dc_fact_join_key", secondary_attributes: [attr("dc_relationship_name", "Relationship", ["relationship_name"], "relationship_name")] },
    ],
    [
      attr("dc_fact_dataset", "Fact Dataset", ["fact_dataset"], "fact_dataset"),
      attr("dc_fact_join_key", "Fact Join Key", ["fact_dataset", "fact_join_key"], "fact_join_key"),
    ],
  );
  const dcDimension = dimension(
    "dc_dimension", "Catalog Dimension", "Dimension Attribute",
    [
      { unique_name: "dc_dimension_name", secondary_attributes: [attr("dc_dimension_dataset", "Dimension Dataset", ["dimension_dataset"], "dimension_dataset")] },
      {
        unique_name: "dc_attribute_name",
        secondary_attributes: [
          attr("dc_attribute_type", "Attribute Type", ["attribute_type"], "attribute_type"),
          attr("dc_attribute_key_column", "Attribute Key Column", ["attribute_key_column"], "attribute_key_column"),
        ],
      },
    ],
    [
      attr("dc_dimension_name", "Dimension", ["dimension_name"], "dimension_label"),
      attr("dc_attribute_name", "Attribute", ["dimension_name", "attribute_name"], "attribute_label"),
    ],
  );

  const metricSpecs: [string, string, CatalogColumn][] = [
    ["relationship_paths", "Relationship Paths", "catalog_row_id"],
    ["measure_count", "Measure Count", "measure_name"],
    ["dimension_count", "Dimension Count", "dimension_name"],
    ["fact_count", "Fact Dataset Count", "fact_dataset"],
    ["model_count", "Model Count", "model_name"],
  ];
  const metricObjects = Object.fromEntries(
    metricSpecs.map(([n, label, column]) => [
      `metrics/m_dc_${n}.yml`,
      { unique_name: `m_dc_${n}`, object_type: "metric", label, calculation_method: "count distinct", column, dataset: ds },
    ]),
  );

  const dims = [dcModel, dcMeasure, dcFact, dcDimension];
  const model: Raw = {
    unique_name: opts.modelName,
    object_type: "model",
    label: "Data Catalog Cube",
    description:
      "Metadata cube describing which measures, from which facts, can be sliced by which dimensions and attributes in this catalog. Generated by ps-utils generate-dc-cube-from-sml.",
    dimensions: dims.map((d) => d.unique_name),
    metrics: metricSpecs.map(([n]) => ({ unique_name: `m_dc_${n}` })),
    relationships: [],
  };

  return {
    [`datasets/${ds}.yml`]: dataset,
    ...Object.fromEntries(dims.map((d) => [`dimensions/${d.unique_name}.yml`, d])),
    ...metricObjects,
    [`models/${opts.modelName}.yml`]: model,
  };
}

/** The connection the catalog dataset should live on: that of the first catalogued fact dataset. */
export function inferConnectionId(rows: CatalogRow[], datasets: Raw[]): string | undefined {
  const byName = new Map(datasets.map((d) => [str(d.unique_name), d]));
  for (const r of rows) {
    const c = str(byName.get(r.fact_dataset)?.connection_id);
    if (c) return c;
  }
  return undefined;
}
