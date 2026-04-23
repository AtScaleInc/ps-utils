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
  key_columns?:  string[];
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
  datasets?: Array<{
    unique_name:       string;
    label?:            string;
    source?: {
      schema?: string;
      table?:  string;
    };
    level_attributes?: SmlLevelAttribute[];
  }>;
}

interface SmlDatasetFile extends SmlBase {
  source?: {
    schema?: string;
    table?:  string;
  };
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
  const dimByName     = new Map(dimFiles.map((d) => [d.unique_name, d]));

  // Collect fact dataset names from relationships
  const factDatasetNames = new Set(
    (modelFile.relationships ?? []).map((r) => r.from.dataset),
  );

  // Build dimension nodes
  const dimensions: DimensionNode[] = [];
  for (const dimFile of dimFiles) {
    const node = buildDimension(dimFile);
    if (node) dimensions.push(node);
  }

  // Build fact nodes
  const facts: FactNode[] = [];
  for (const dsName of factDatasetNames) {
    // Fact dataset may be in a standalone datasets/ file
    const ds = datasetByName.get(dsName);
    if (ds) {
      const node = buildFact(ds, modelFile, dsName, dimByName);
      if (node) facts.push(node);
    }
  }

  return { modelName, facts, dimensions };
}

// ─── Builders ─────────────────────────────────────────────────────────────────

function buildDimension(f: SmlDimensionFile): DimensionNode | null {
  const embedded = f.datasets?.[0];
  const source   = embedded?.source;
  if (!embedded || !source?.table) return null;

  // Map level unique_name → key columns (from level_attributes)
  const keyColMap   = new Map<string, string[]>();
  const labelColMap = new Map<string, string>();

  for (const la of (embedded.level_attributes ?? [])) {
    const keys = la.key_columns?.length ? la.key_columns : [la.unique_name];
    keyColMap.set(la.unique_name, keys);

    // Look for a companion attribute whose name suggests it carries a display value
    const labelAttr = la.attributes?.find((a) => /name|label|desc/i.test(a.unique_name));
    if (labelAttr?.source_column) {
      labelColMap.set(la.unique_name, labelAttr.source_column);
    }
  }

  const hierarchies: HierarchyNode[] = [];
  for (const h of (f.hierarchies ?? [])) {
    const rawLevels = h.levels ?? [];
    if (rawLevels.length === 0) continue;

    const levels: LevelNode[] = rawLevels.map((l, i) => ({
      uniqueName:   l.unique_name,
      label:        l.label ?? l.unique_name,
      keyColumns:   keyColMap.get(l.unique_name) ?? [l.unique_name],
      labelColumn:  labelColMap.get(l.unique_name),
      isLeaf:       l.is_unique_key === true || i === rawLevels.length - 1,
    }));

    hierarchies.push({
      uniqueName: h.unique_name,
      label:      h.label ?? h.unique_name,
      levels,
    });
  }

  if (hierarchies.length === 0) return null;

  return {
    uniqueName:   f.unique_name,
    sourceTable:  source.table,
    sourceSchema: source.schema ?? "",
    hierarchies,
  };
}

function buildFact(
  ds: SmlDatasetFile,
  model: SmlModelFile,
  dsName: string,
  dimByName: Map<string, SmlDimensionFile>,
): FactNode | null {
  if (!ds.source?.table) return null;

  const measures: MeasureNode[] = (ds.measures ?? []).map((m) => ({
    uniqueName:   m.unique_name,
    sourceColumn: m.sql_expression ?? m.unique_name,
    dataType:     normaliseDataType(m.data_type),
    aggregations: m.aggregations ?? ["SUM"],
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
    uniqueName:   dsName,
    sourceTable:  ds.source.table,
    sourceSchema: ds.source.schema ?? "",
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
