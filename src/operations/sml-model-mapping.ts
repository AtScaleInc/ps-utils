/**
 * Model mapping — the metric / relationship / attribute / coverage tables of each model in an SML
 * directory, plus structural issues found along the way. Pure functions, no I/O.
 *
 * Shared by generate-report-from-sml (renders the tables as Markdown) and generate-dc-cube-from-sml
 * (writes them as CSV and as a SQL load script).
 *
 * Issues are structural heuristics, not engine validation: a reference to a missing object is an
 * error; a snowflake level no relationship reaches, a secondary attribute duplicating its level, a
 * label shared by two attributes, or a summed price/rate is a warning; an unused dimension is info.
 */

export type Raw = Record<string, any>;

export interface MappingInput {
  models: Raw[];
  metrics: Raw[];
  dimensions: Raw[];
  datasets: Raw[];
  /** Calculations share a model's `metrics` list; names found here are not flagged as missing metrics. */
  calculations?: Raw[];
}

export interface MetricRow {
  model_name: string;
  metric_name: string;
  metric_label: string;
  aggregation: string;
  fact_dataset: string;
  fact_table: string;
  source_column: string;
  format: string;
  folder: string;
}

export interface RelationshipRow {
  model_name: string;
  relationship_name: string;
  fact_dataset: string;
  fact_join_column: string;
  dimension_name: string;
  dimension_label: string;
  join_level: string;
  dimension_dataset: string;
  dimension_key_column: string;
}

export interface AttributeRow {
  model_name: string;
  dimension_name: string;
  dimension_label: string;
  hierarchy_name: string;
  level_number: number;
  level_name: string;
  attribute_name: string;
  attribute_label: string;
  attribute_type: "Level" | "Join Level" | "Secondary";
  dataset: string;
  key_column: string;
  name_column: string;
}

export interface CoverageRow {
  model_name: string;
  metric_name: string;
  metric_label: string;
  dimension_name: string;
  dimension_label: string;
  attribute_count: number;
}

export type IssueSeverity = "error" | "warning" | "info";

export interface IssueRow {
  issue_number: number;
  severity: IssueSeverity;
  model_name: string;
  object_name: string;
  issue: string;
  impact: string;
  recommendation: string;
}

export interface ModelMapping {
  metrics: MetricRow[];
  relationships: RelationshipRow[];
  attributes: AttributeRow[];
  coverage: CoverageRow[];
  issues: IssueRow[];
}

/** Model name used for catalog-wide issues that belong to no single model. */
export const CATALOG_SCOPE = "(catalog)";

const SEVERITY_ORDER: Record<IssueSeverity, number> = { error: 0, warning: 1, info: 2 };
// Column names whose sum across rows is rarely meaningful (unit prices, rates, ratios, percentages, averages).
const NON_ADDITIVE_COLUMN = /(price|rate|ratio|pct|percent|avg|average)/i;

const asArray = <T = Raw>(v: unknown): T[] => (Array.isArray(v) ? (v as T[]) : v === undefined || v === null ? [] : [v as T]);
const str = (v: unknown): string => (v === undefined || v === null ? "" : String(v).trim());
/** Dataset references sometimes carry a `.dataset` suffix the dataset's own unique_name lacks. */
const ds = (v: unknown): string => str(v).replace(/\.dataset$/, "");
const nameOf = (ref: unknown): string => (ref && typeof ref === "object" ? str((ref as Raw).unique_name) : str(ref));
const list = (xs: string[]): string => xs.join(", ");

interface DimAttribute {
  hierarchy: string;
  levelNumber: number;
  level: string;
  attr: Raw;
  secondary: boolean;
}

function walkAttributes(dim: Raw): { attrs: DimAttribute[]; missingLevels: string[] } {
  const byName = new Map(asArray(dim.level_attributes).map((a) => [str(a.unique_name), a]));
  const attrs: DimAttribute[] = [];
  const missingLevels: string[] = [];
  for (const h of asArray(dim.hierarchies)) {
    asArray(h.levels).forEach((lvl, i) => {
      const a = byName.get(str(lvl.unique_name));
      if (!a) {
        missingLevels.push(str(lvl.unique_name));
        return;
      }
      const base = { hierarchy: str(h.unique_name), levelNumber: i + 1, level: str(a.unique_name) };
      attrs.push({ ...base, attr: a, secondary: false });
      for (const sa of asArray(lvl.secondary_attributes)) attrs.push({ ...base, attr: sa, secondary: true });
    });
  }
  return { attrs, missingLevels };
}

/** Datasets a dimension can reach from the dataset of the level the fact joins at, via its snowflake relationships. */
function reachableDatasets(dim: Raw, joinLevel: string): Set<string> {
  const levelDataset = new Map(asArray(dim.level_attributes).map((a) => [str(a.unique_name), ds(a.dataset)]));
  const reached = new Set<string>([levelDataset.get(joinLevel) ?? ""]);
  const links = asArray(dim.relationships).filter((r) => {
    const to = (r.to ?? {}) as Raw;
    return !to.dimension || str(to.dimension) === str(dim.unique_name);
  });
  for (let grew = true; grew; ) {
    grew = false;
    for (const r of links) {
      const target = levelDataset.get(str(r.to?.level));
      if (target && reached.has(ds(r.from?.dataset)) && !reached.has(target)) {
        reached.add(target);
        grew = true;
      }
    }
  }
  return reached;
}

/** Dimensions reachable from any model: its relationships and degenerate dimensions, then embedded relationships. */
function usedDimensionNames(models: Raw[], dims: Map<string, Raw>): Set<string> {
  const used = new Set<string>();
  const queue: string[] = [];
  const add = (n: string) => {
    if (n && !used.has(n)) {
      used.add(n);
      queue.push(n);
    }
  };
  for (const m of models) {
    for (const r of asArray(m.relationships)) add(str(r.to?.dimension));
    for (const d of asArray(m.dimensions)) add(nameOf(d));
  }
  while (queue.length) {
    const dim = dims.get(queue.shift() as string);
    for (const r of asArray(dim?.relationships)) add(str(r.to?.dimension));
  }
  return used;
}

export function buildModelMapping(input: MappingInput, opts: { excludeModels?: string[] } = {}): ModelMapping {
  const exclude = new Set(opts.excludeModels ?? []);
  const metrics = new Map(input.metrics.map((m) => [str(m.unique_name), m]));
  const dims = new Map(input.dimensions.map((d) => [str(d.unique_name), d]));
  const datasets = new Map(input.datasets.map((d) => [ds(d.unique_name), d]));
  const calculations = new Set((input.calculations ?? []).map((c) => str(c.unique_name)));
  const models = input.models
    .filter((m) => str(m.object_type || "model") === "model" && !exclude.has(str(m.unique_name)))
    .sort((a, b) => str(a.unique_name).localeCompare(str(b.unique_name)));

  const out: ModelMapping = { metrics: [], relationships: [], attributes: [], coverage: [], issues: [] };
  const issues: Omit<IssueRow, "issue_number">[] = [];
  const issue = (severity: IssueSeverity, model_name: string, object_name: string, text: string, impact: string, recommendation: string) =>
    issues.push({ severity, model_name, object_name, issue: text, impact, recommendation });

  for (const model of models) {
    const modelName = str(model.unique_name);
    const joinLevels = new Map<string, Set<string>>();

    for (const rel of asArray(model.relationships)) {
      const dimName = str(rel.to?.dimension);
      const factDs = ds(rel.from?.dataset);
      if (factDs && !datasets.has(factDs)) {
        issue("error", modelName, str(rel.unique_name), `Relationship reads dataset ${factDs}, which does not exist`,
          "Validation and deployment fail", `Restore dataset ${factDs}, or repoint the relationship and its metrics`);
      }
      const dim = dims.get(dimName);
      if (!dim) {
        if (dimName) issue("error", modelName, str(rel.unique_name), `Relationship joins dimension ${dimName}, which does not exist`,
          "Validation and deployment fail", `Restore dimension ${dimName}, or remove the relationship`);
        continue;
      }
      const level = str(rel.to?.level);
      if (!joinLevels.has(dimName)) joinLevels.set(dimName, new Set());
      joinLevels.get(dimName)!.add(level);
      const levelAttr = asArray(dim.level_attributes).find((a) => str(a.unique_name) === level) ?? {};
      out.relationships.push({
        model_name: modelName,
        relationship_name: str(rel.unique_name),
        fact_dataset: factDs,
        fact_join_column: asArray<string>(rel.from?.join_columns).join(","),
        dimension_name: dimName,
        dimension_label: str(dim.label) || dimName,
        join_level: level,
        dimension_dataset: ds(levelAttr.dataset),
        dimension_key_column: asArray<string>(levelAttr.key_columns).join(","),
      });
    }

    for (const ref of asArray(model.metrics)) {
      const metricName = nameOf(ref);
      const m = metrics.get(metricName);
      if (!m) {
        if (!calculations.has(metricName)) {
          issue("error", modelName, metricName, `Model references metric ${metricName}, which does not exist`,
            "Validation and deployment fail", `Restore metric ${metricName}, or remove it from the model`);
        }
        continue;
      }
      const factDs = ds(m.dataset);
      if (factDs && !datasets.has(factDs)) {
        issue("error", modelName, metricName, `Metric reads dataset ${factDs}, which does not exist`,
          "Validation and deployment fail", `Restore dataset ${factDs}, or repoint the metric's dataset`);
      }
      out.metrics.push({
        model_name: modelName,
        metric_name: metricName,
        metric_label: str(m.label) || metricName,
        aggregation: str(m.calculation_method),
        fact_dataset: factDs,
        fact_table: str(datasets.get(factDs)?.table),
        source_column: str(m.column),
        format: str(m.format),
        folder: str((ref as Raw)?.folder),
      });
      if (str(m.calculation_method) === "sum" && NON_ADDITIVE_COLUMN.test(str(m.column))) {
        issue("warning", modelName, metricName, `${str(m.label) || metricName} sums ${str(m.column)}`,
          "Summing prices or rates across rows is rarely meaningful", "Use average, or keep sum and label it clearly");
      }
      for (const rel of asArray(model.relationships)) {
        const dim = dims.get(str(rel.to?.dimension));
        if (!dim || ds(rel.from?.dataset) !== factDs) continue;
        out.coverage.push({
          model_name: modelName,
          metric_name: metricName,
          metric_label: str(m.label) || metricName,
          dimension_name: str(dim.unique_name),
          dimension_label: str(dim.label) || str(dim.unique_name),
          attribute_count: walkAttributes(dim).attrs.length,
        });
      }
    }

    for (const dimName of [...joinLevels.keys()].sort()) {
      const dim = dims.get(dimName)!;
      const { attrs, missingLevels } = walkAttributes(dim);
      for (const lvl of missingLevels) {
        issue("error", modelName, dimName, `Hierarchy level ${lvl} has no level attribute`,
          "The level cannot be queried", `Add a level_attributes entry for ${lvl}`);
      }
      for (const a of attrs) {
        out.attributes.push({
          model_name: modelName,
          dimension_name: dimName,
          dimension_label: str(dim.label) || dimName,
          hierarchy_name: a.hierarchy,
          level_number: a.levelNumber,
          level_name: a.level,
          attribute_name: str(a.attr.unique_name),
          attribute_label: str(a.attr.label) || str(a.attr.unique_name),
          attribute_type: a.secondary ? "Secondary" : joinLevels.get(dimName)!.has(str(a.attr.unique_name)) ? "Join Level" : "Level",
          dataset: ds(a.attr.dataset),
          key_column: asArray<string>(a.attr.key_columns).join(","),
          name_column: str(a.attr.name_column),
        });
      }

      // Snowflake levels the fact's join level cannot reach.
      const reached = new Set<string>();
      for (const jl of joinLevels.get(dimName)!) for (const d of reachableDatasets(dim, jl)) reached.add(d);
      const stranded = attrs.filter((a) => !a.secondary && !reached.has(ds(a.attr.dataset)));
      if (stranded.length) {
        const strandedDs = [...new Set(stranded.map((a) => ds(a.attr.dataset)))];
        const joinDs = [...reached].filter(Boolean);
        issue("warning", modelName, dimName,
          `Levels ${list(stranded.map((a) => a.level))} come from ${list(strandedDs)}, which no relationship joins to ${list(joinDs)}`,
          `Slicing by ${list(stranded.map((a) => a.level))} may fail or return wrong totals`,
          `Add snowflake relationships in ${dimName} linking ${list(joinDs)} to ${list(strandedDs)}`);
      }

      // Secondary attributes that repeat their own level's key column.
      for (const a of attrs.filter((x) => x.secondary)) {
        const level = attrs.find((x) => !x.secondary && x.level === a.level);
        const sameKey = level && asArray<string>(level.attr.key_columns).join(",") === asArray<string>(a.attr.key_columns).join(",")
          && ds(level.attr.dataset) === ds(a.attr.dataset);
        if (sameKey) {
          issue("warning", modelName, dimName, `Secondary attribute ${str(a.attr.unique_name)} repeats level ${a.level}'s key column ${asArray<string>(a.attr.key_columns).join(",")}`,
            "BI users see the same attribute twice", "Remove it, or point it at a different column");
        }
      }

      // Two attributes sharing one label.
      const byLabel = new Map<string, string[]>();
      for (const a of attrs) {
        const l = (str(a.attr.label) || str(a.attr.unique_name)).toLowerCase();
        byLabel.set(l, [...(byLabel.get(l) ?? []), str(a.attr.unique_name)]);
      }
      for (const [l, names] of byLabel) {
        if (names.length > 1) {
          issue("warning", modelName, dimName, `Label "${l}" is used by ${list(names)}`,
            "Users can't tell the attributes apart", "Give each attribute a distinct label");
        }
      }
    }
  }

  const used = usedDimensionNames(input.models, dims);
  for (const d of input.dimensions) {
    const n = str(d.unique_name);
    if (!used.has(n)) issue("info", CATALOG_SCOPE, n, `Dimension ${n} is not used by any model`, "Clutter; may overlap other dimensions", "Remove it, or add it to a model");
  }

  const seen = new Set<string>();
  out.issues = issues
    .filter((i) => {
      const k = `${i.model_name}|${i.object_name}|${i.issue}`;
      return seen.has(k) ? false : (seen.add(k), true);
    })
    .map((i, idx) => ({ i, idx }))
    .sort((a, b) => SEVERITY_ORDER[a.i.severity] - SEVERITY_ORDER[b.i.severity] || a.idx - b.idx)
    .map(({ i }, n) => ({ issue_number: n + 1, ...i }));
  return out;
}

/** The mapping tables in a fixed order, each with its SQL/CSV name, for writers that emit them all. */
export function mappingTables(m: ModelMapping): { name: string; label: string; rows: Record<string, string | number>[] }[] {
  return [
    { name: "model_metrics", label: "Model Metrics", rows: m.metrics as unknown as Record<string, string | number>[] },
    { name: "model_relationships", label: "Model Relationships", rows: m.relationships as unknown as Record<string, string | number>[] },
    { name: "model_dimension_attributes", label: "Model Dimension Attributes", rows: m.attributes as unknown as Record<string, string | number>[] },
    { name: "model_metric_coverage", label: "Model Metric Coverage", rows: m.coverage as unknown as Record<string, string | number>[] },
    { name: "model_issues", label: "Model Issues", rows: m.issues as unknown as Record<string, string | number>[] },
  ];
}
