/**
 * SML model reader.
 *
 * Parses an SML output directory (or a path to a model.yml file) into a
 * ModelGraph — the in-memory representation consumed by the profilers.
 *
 * Expected directory layout (as produced by generate-sml-from-*):
 *   <sml-dir>/
 *     models/<model>.yml         — relationships between facts and dimensions
 *     dimensions/<dim>.yml       — dimension definitions with embedded datasets
 *     datasets/<fact>.yml        — fact dataset definitions with measures
 *     catalog.yml                — ignored here
 *     metrics/*.yml              — ignored here
 */

import fs   from "fs";
import path from "path";
import yaml from "js-yaml";

import type {
  ModelGraph,
  FactNode,
  DimensionNode,
  HierarchyNode,
  LevelNode,
  JoinEdge,
  MeasureNode,
} from "./types.js";

// ─── Raw YAML shapes (permissive — actual SML may have additional fields) ─────

interface SmlBase {
  unique_name: string;
  object_type?: string;
  label?: string;
}

interface SmlModelFile extends SmlBase {
  relationships?: Array<{
    unique_name?: string;
    from: {
      dataset:       string;
      join_columns?: string[];
    };
    to: {
      dimension: string;
      level:     string;
    };
    type?: string;
  }>;
}

interface SmlLevelAttribute {
  unique_name:   string;
  label?:        string;
  dataset?:      string;      // reference to dataset unique_name (actual SML format)
  key_columns?:  string[];
  name_column?:  string;      // display/label column (actual SML format)
  is_unique_key?: boolean;
  attributes?: Array<{
    unique_name:   string;
    source_column?: string;
  }>;
}

interface SmlDimensionFile extends SmlBase {
  hierarchies?: Array<{
    unique_name: string;
    label?:      string;
    levels?: Array<{
      unique_name:    string;
      label?:         string;
      is_unique_key?: boolean;
    }>;
  }>;
  // Actual SML format: level_attributes at dimension top level, each with a dataset reference
  level_attributes?: SmlLevelAttribute[];
  // Legacy: embedded datasets array
  datasets?: Array<{
    unique_name:       string;
    label?:            string;
    source?: {
      schema?: string;
      table?:  string;
    };
    level_attributes?: SmlLevelAttribute[];
  }>;
  /**
   * Dimension-internal relationships — join a snowflake-schema hierarchy's
   * per-level physical tables together (e.g. dimproduct.productsubcategorykey
   * → level "Product Sub-Category", whose own dataset is dimproductsubcategory).
   * `from.dataset` is the CHILD table that carries the FK column(s) named in
   * `from.join_columns`; `to.level` is the parent level those FK column(s)
   * reference. Absent for star-schema dimensions where every level lives in
   * one physical table and no cross-table join is needed.
   */
  relationships?: Array<{
    unique_name?: string;
    from: {
      dataset:       string;
      join_columns?: string[];
    };
    to: {
      level: string;
    };
    type?: string;
  }>;
}

interface SmlDatasetFile extends SmlBase {
  // Actual SML format: table at top level
  table?: string;
  connection_id?: string;
  // Actual SML format: columns array
  columns?: Array<{
    name:       string;
    data_type?: string;
  }>;
  // Legacy: source.table
  source?: {
    schema?: string;
    table?:  string;
  };
  // Legacy: measures array
  measures?: Array<{
    unique_name:    string;
    label?:         string;
    sql_expression?: string;
    data_type?:     string;
    aggregations?:  string[];
  }>;
}

// ─── Public API ───────────────────────────────────────────────────────────────

/**
 * Read an SML output directory or a path to a model.yml file and return a
 * ModelGraph that the profilers can walk.
 *
 * @param smlPathOrFile  Path to the SML output directory OR to a model.yml file.
 */
export function readModelGraph(smlPathOrFile: string): ModelGraph {
  const smlDir = fs.statSync(smlPathOrFile).isDirectory()
    ? smlPathOrFile
    : path.dirname(smlPathOrFile);

  const all = collectYamlFiles(smlDir);

  const modelFiles = all.filter((f) => f.object_type === "model")     as SmlModelFile[];
  const dimFiles   = all.filter((f) => f.object_type === "dimension") as SmlDimensionFile[];
  const dsFiles    = all.filter((f) => f.object_type === "dataset")   as SmlDatasetFile[];

  if (modelFiles.length === 0) {
    throw new Error(`No model YAML found in: ${smlDir}`);
  }

  const modelFile = modelFiles[0]!;
  const modelName = modelFile.unique_name;

  const datasetByName = new Map(dsFiles.map((d) => [d.unique_name, d]));

  // Collect dataset names referenced by dimensions (to distinguish facts from dims)
  const dimDatasetNames = new Set<string>();
  for (const dimFile of dimFiles) {
    for (const la of (dimFile.level_attributes ?? [])) {
      if (la.dataset) dimDatasetNames.add(la.dataset);
    }
    for (const emb of (dimFile.datasets ?? [])) {
      dimDatasetNames.add(emb.unique_name);
    }
  }

  // Collect fact dataset names from relationships; fall back to any dataset not
  // referenced by a dimension when the model has no relationships defined.
  const explicitFacts = (modelFile.relationships ?? []).map((r) => r.from.dataset);
  const factDatasetNames = new Set<string>(
    explicitFacts.length > 0
      ? explicitFacts
      : dsFiles.map((d) => d.unique_name).filter((n) => !dimDatasetNames.has(n)),
  );

  // Build dimension nodes
  const dimensions: DimensionNode[] = [];
  for (const dimFile of dimFiles) {
    const node = buildDimension(dimFile, datasetByName);
    if (node) dimensions.push(node);
  }

  // Build fact nodes
  const facts: FactNode[] = [];
  for (const dsName of factDatasetNames) {
    const ds = datasetByName.get(dsName);
    if (ds) {
      const node = buildFact(ds, modelFile, dsName);
      if (node) facts.push(node);
    }
  }

  return { modelName, facts, dimensions };
}

// ─── Builders ─────────────────────────────────────────────────────────────────

function buildDimension(
  f: SmlDimensionFile,
  datasetByName: Map<string, SmlDatasetFile>,
): DimensionNode | null {
  // Resolve source table and level_attributes.
  // Actual SML format: level_attributes at dimension top level, each with a dataset reference.
  // Legacy format: level_attributes embedded inside datasets[0].
  const topLevelAttrs  = f.level_attributes;
  const embeddedDataset = f.datasets?.[0];

  let sourceTable:  string | undefined;
  let sourceSchema  = "";
  let levelAttrs:   SmlLevelAttribute[];

  if (topLevelAttrs && topLevelAttrs.length > 0) {
    // Actual SML format: look up the dataset referenced by the first level_attribute
    const firstDatasetRef = topLevelAttrs.find((la) => la.dataset)?.dataset;
    const ds = firstDatasetRef ? datasetByName.get(firstDatasetRef) : undefined;
    sourceTable  = ds?.table ?? ds?.source?.table;
    sourceSchema = ds?.source?.schema ?? "";
    levelAttrs   = topLevelAttrs;
  } else if (embeddedDataset) {
    // Legacy format: source embedded in datasets[0]
    sourceTable  = embeddedDataset.source?.table;
    sourceSchema = embeddedDataset.source?.schema ?? "";
    levelAttrs   = embeddedDataset.level_attributes ?? [];
  } else {
    return null;
  }

  if (!sourceTable) return null;

  // Map level unique_name → key columns (from level_attributes)
  const keyColMap   = new Map<string, string[]>();
  const labelColMap = new Map<string, string>();
  // Map level unique_name → its OWN physical table/schema, when a level_attribute
  // names a dataset different from the dimension's default (snowflake-schema
  // hierarchies where each level is normalized into a separate table).
  const levelTableMap = new Map<string, { table: string; schema: string }>();

  for (const la of levelAttrs) {
    const keys = la.key_columns?.length ? la.key_columns : [la.unique_name];
    keyColMap.set(la.unique_name, keys);

    if (la.name_column) {
      // Actual SML format: name_column is the display/label column
      labelColMap.set(la.unique_name, la.name_column);
    } else {
      // Legacy format: look for a companion attribute whose name suggests a display value
      const labelAttr = la.attributes?.find((a) => /name|label|desc/i.test(a.unique_name));
      if (labelAttr?.source_column) {
        labelColMap.set(la.unique_name, labelAttr.source_column);
      }
    }

    if (la.dataset) {
      const levelDs = datasetByName.get(la.dataset);
      const levelTable = levelDs?.table ?? levelDs?.source?.table;
      if (levelTable) {
        levelTableMap.set(la.unique_name, {
          table:  levelTable,
          schema: levelDs?.source?.schema ?? "",
        });
      }
    }
  }

  // Dimension-internal relationships resolve, for a level whose own table
  // differs from its parent's, which FK column (in the level's OWN table)
  // points back at the parent level's key. Keyed by dataset name (the CHILD
  // table named in `from.dataset`) since that's what a level_attribute's
  // `dataset` field is matched against below.
  const parentKeyColByDataset = new Map<string, string>();
  for (const rel of (f.relationships ?? [])) {
    const fkCol = rel.from.join_columns?.[0];
    if (rel.from.dataset && fkCol) {
      parentKeyColByDataset.set(rel.from.dataset, fkCol);
    }
  }
  // Map level unique_name → its resolved dataset name (needed to look up
  // parentKeyColByDataset below without re-scanning levelAttrs per level).
  const levelDatasetMap = new Map<string, string>();
  for (const la of levelAttrs) {
    if (la.dataset) levelDatasetMap.set(la.unique_name, la.dataset);
  }

  const hierarchies: HierarchyNode[] = [];
  for (const h of (f.hierarchies ?? [])) {
    const rawLevels = h.levels ?? [];
    if (rawLevels.length === 0) continue;

    const levels: LevelNode[] = rawLevels.map((l, i) => {
      const ownTable   = levelTableMap.get(l.unique_name);
      const levelDs    = levelDatasetMap.get(l.unique_name);

      // Only resolve a cross-table parentKeyColumn when this level's table
      // actually differs from its immediate parent's table — that's the one
      // point in the chain where a relationship-declared FK is needed.
      // Consecutive levels sharing one table (e.g. Product Line → Product
      // Name, both in dimproduct) must fall back to the parent's own key
      // column name, exactly like a star-schema hierarchy — otherwise every
      // level sharing that dataset would incorrectly inherit the FK column
      // from whichever relationship entry happens to reference that dataset.
      const parentRawLevel = i > 0 ? rawLevels[i - 1] : undefined;
      const parentLevelDs  = parentRawLevel ? levelDatasetMap.get(parentRawLevel.unique_name) : undefined;
      const parentKeyColumn = (levelDs && parentLevelDs && levelDs !== parentLevelDs)
        ? parentKeyColByDataset.get(levelDs)
        : undefined;

      return {
        uniqueName:   l.unique_name,
        label:        l.label ?? l.unique_name,
        keyColumns:   keyColMap.get(l.unique_name) ?? [l.unique_name],
        labelColumn:  labelColMap.get(l.unique_name),
        isLeaf:       l.is_unique_key === true || i === rawLevels.length - 1,
        sourceTable:  ownTable?.table,
        sourceSchema: ownTable?.schema,
        parentKeyColumn,
      };
    });

    hierarchies.push({
      uniqueName: h.unique_name,
      label:      h.label ?? h.unique_name,
      levels,
    });
  }

  if (hierarchies.length === 0) return null;

  return {
    uniqueName:   f.unique_name,
    sourceTable,
    sourceSchema,
    hierarchies,
  };
}

function buildFact(
  ds: SmlDatasetFile,
  model: SmlModelFile,
  dsName: string,
): FactNode | null {
  // Support actual SML format (ds.table) and legacy format (ds.source.table)
  const sourceTable = ds.table ?? ds.source?.table;
  if (!sourceTable) return null;
  const sourceSchema = ds.source?.schema ?? "";

  // Prefer explicit measures; fall back to numeric columns as candidate measures
  const measures: MeasureNode[] = ds.measures && ds.measures.length > 0
    ? ds.measures.map((m) => ({
        uniqueName:   m.unique_name,
        sourceColumn: m.sql_expression ?? m.unique_name,
        dataType:     normaliseDataType(m.data_type),
        aggregations: m.aggregations ?? ["SUM"],
      }))
    : (ds.columns ?? [])
        .filter((c) => normaliseDataType(c.data_type) !== "unknown")
        .map((c) => ({
          uniqueName:   c.name,
          sourceColumn: c.name,
          dataType:     normaliseDataType(c.data_type),
          aggregations: ["SUM"],
        }));

  // Resolve leaf level key column from the dimension's level_attributes
  const joins: JoinEdge[] = (model.relationships ?? [])
    .filter((r) => r.from.dataset === dsName)
    .map((r): JoinEdge => ({
      fromColumns: r.from.join_columns ?? [],
      toDimension: r.to.dimension,
      toLevel:     r.to.level,
    }));

  return {
    uniqueName: dsName,
    sourceTable,
    sourceSchema,
    measures,
    joins,
  };
}

// ─── Utilities ────────────────────────────────────────────────────────────────

function collectYamlFiles(smlDir: string): SmlBase[] {
  const results: SmlBase[] = [];
  const subdirs = [".", "models", "datasets", "dimensions"];

  for (const sub of subdirs) {
    const dir = path.join(smlDir, sub);
    if (!fs.existsSync(dir) || !fs.statSync(dir).isDirectory()) continue;

    for (const entry of fs.readdirSync(dir)) {
      if (!/\.ya?ml$/i.test(entry)) continue;
      try {
        const parsed = yaml.load(
          fs.readFileSync(path.join(dir, entry), "utf8"),
        ) as SmlBase | null;
        if (parsed?.unique_name) results.push(parsed);
      } catch {
        // Skip unparseable files silently
      }
    }
  }

  // Deduplicate by unique_name — same file may be discovered in "." and a subdir
  const seen = new Set<string>();
  return results.filter((f) => {
    if (seen.has(f.unique_name)) return false;
    seen.add(f.unique_name);
    return true;
  });
}

function normaliseDataType(dt?: string): "integer" | "decimal" | "unknown" {
  const s = (dt ?? "").toLowerCase();
  if (/\bint|bigint|smallint|tinyint|long\b/.test(s)) return "integer";
  if (/decimal|numeric|float|double|real|number/.test(s))  return "decimal";
  return "unknown";
}
