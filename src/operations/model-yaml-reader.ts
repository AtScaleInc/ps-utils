/**
 * Shared helpers for reading and reconstructing a SemanticModel from model.yaml.
 *
 * Used by:
 *   - generate-namespace-from-model
 *   - generate-metrics-from-model
 */
import type {
  SemanticModel,
  SemanticFact,
  SemanticDimension,
  SemanticMeasure,
  SemanticRelationship,
  SemanticHierarchy,
  AggregationType,
} from "../algorithm/types.js";

// ----------------------------------------------------------
// Data-type constants
// ----------------------------------------------------------

/** Integer data_type_string values from model.yaml */
export const INTEGER_TYPES = new Set([
  "INT1","INT2","INT4","INT8",
  "INT_UNSIGNED1","INT_UNSIGNED2","INT_UNSIGNED4","INT_UNSIGNED8",
]);

/** Floating / decimal data_type_string values from model.yaml */
export const DECIMAL_TYPES = new Set(["FLOAT32","FLOAT64","DECIMAL","NUMERIC","CURRENCY"]);

/** Datetime data_type_string values that support xAxisGranularity */
export const DATETIME_TYPES = new Set(["DATETIME","DATE_DOUBLE"]);

export function toMeasureDataType(dt: string): "integer" | "decimal" {
  return INTEGER_TYPES.has(dt) ? "integer" : "decimal";
}

export function toAggType(agg: string): AggregationType {
  const map: Record<string, AggregationType> = {
    sum: "SUM", avg: "AVG", count: "COUNT", min: "MIN", max: "MAX",
    "distinct count estimate": "DISTINCT_COUNT_ESTIMATE",
    distinct_count_estimate:   "DISTINCT_COUNT_ESTIMATE",
    distinctcountestimate:     "DISTINCT_COUNT_ESTIMATE",
  };
  return map[agg?.toLowerCase()] ?? "SUM";
}

// ----------------------------------------------------------
// SemanticModel reconstruction from model.yaml
// ----------------------------------------------------------

export type ReconstructedModel = {
  model:       SemanticModel;
  /** dimensionName → levelCaption → query_name (column key) */
  levelColMap: Map<string, Map<string, string>>;
  /** column key → data_type_string */
  colTypeMap:  Map<string, string>;
};

/**
 * Build a synthetic SemanticModel from the mdx + sql sections of model.yaml
 * so that generateAnalysisSuggestions can score and rank analysis patterns.
 */
export function reconstructSemanticModel(
  modelName: string,
  modelData: Record<string, any>,
): ReconstructedModel {
  const mdx        = (modelData.mdx ?? {}) as Record<string, any>;
  const sqlColumns = ((modelData.sql ?? {}).columns ?? {}) as Record<string, any>;

  // column key → data_type_string (from sql.columns)
  const colTypeMap = new Map<string, string>();
  for (const [key, col] of Object.entries(sqlColumns)) {
    colTypeMap.set(key, (col as any).data_type ?? "WSTR");
  }

  // Build SemanticMeasure[] from mdx.metrics
  // Skip measures that the model has mapped to role=dimension (e.g. DATE_DOUBLE)
  const measures: SemanticMeasure[] = [];
  for (const m of (mdx.metrics ?? []) as any[]) {
    if (!m?.query_name) continue;
    const sqlCol = sqlColumns[m.query_name];
    if (sqlCol?.role === "dimension") continue;
    measures.push({
      name:         m.caption ?? m.query_name,
      sourceColumn: m.query_name,
      dataType:     toMeasureDataType(m.data_type_string ?? "FLOAT64"),
      aggregation:  toAggType(m.agg_type_string ?? "sum"),
    });
  }

  // Build SemanticDimension[] + SemanticRelationship[] from mdx.attributes
  const dimensions:    SemanticDimension[]   = [];
  const relationships: SemanticRelationship[] = [];
  const levelColMap    = new Map<string, Map<string, string>>();

  for (const [dimName, dimHierarchies] of Object.entries(
    (mdx.attributes ?? {}) as Record<string, Record<string, any[]>>,
  )) {
    const hierarchies: SemanticHierarchy[] = [];
    const dimLevelMap  = new Map<string, string>();

    for (const [hierName, levelsRaw] of Object.entries(dimHierarchies ?? {})) {
      const levels = (levelsRaw as any[])
        .filter(Boolean)
        .sort((a, b) => (a.level_number ?? 0) - (b.level_number ?? 0));

      hierarchies.push({
        name:   hierName,
        levels: levels.map((l) => ({
          name:         l.caption ?? l.query_name,
          sourceColumn: l.query_name,
        })),
      });

      for (const l of levels) {
        dimLevelMap.set(l.caption ?? l.query_name, l.query_name);
      }
    }

    const primaryKey =
      hierarchies[0]?.levels[0]?.sourceColumn ?? dimName.toLowerCase();

    dimensions.push({
      kind:        "dimension",
      name:        dimName,
      sourceTable: dimName,
      primaryKeys: [primaryKey],
      attributes:  [],
      hierarchies,
    });

    // Synthetic relationship: the fact joins to every dimension
    relationships.push({
      fromDataset:    modelName,
      fromColumn:     primaryKey,
      toDataset:      dimName,
      toColumn:       primaryKey,
      constraintName: `${modelName}_${dimName}`.toLowerCase(),
      cardinality:    "MANY_TO_ONE",
    });

    levelColMap.set(dimName, dimLevelMap);
  }

  const fact: SemanticFact = {
    kind:                 "fact",
    name:                 modelName,
    sourceTable:          modelName,
    measures,
    degenerateDimensions: [],
  };

  const model: SemanticModel = {
    name:        modelName,
    generatedAt: new Date().toISOString(),
    facts:       [fact],
    dimensions,
    relationships,
    views:       [],
    suggestions: [],
    warnings:    [],
  };

  return { model, levelColMap, colTypeMap };
}

/**
 * Select a model entry from the top-level model.yaml map.
 * Returns the model name and its data object.
 */
export function selectModel(
  modelFile: Record<string, any>,
  modelName?: string,
  filePath?: string,
): { modelName: string; modelData: Record<string, any> } {
  if (modelName) {
    if (!(modelName in modelFile)) {
      throw new Error(
        `Model "${modelName}" not found in ${filePath ?? "model file"}`,
      );
    }
    return { modelName, modelData: modelFile[modelName] as Record<string, any> };
  }
  const name = Object.keys(modelFile)[0];
  return { modelName: name, modelData: modelFile[name] as Record<string, any> };
}
