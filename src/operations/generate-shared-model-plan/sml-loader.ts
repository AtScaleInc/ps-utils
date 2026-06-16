/**
 * sml-loader.ts
 *
 * Parses one SML output directory into a strongly-typed in-memory representation.
 * Handles: catalog.yml, connections/, datasets/, dimensions/, metrics/,
 *          calculations/, models/
 */

import fs from "fs";
import path from "path";
import { load as parseYaml } from "js-yaml";

// ============================================================
// In-memory SML types
// ============================================================

export interface SmlColumn {
  name: string;
  dataType: string;
}

export interface SmlLevelAttribute {
  uniqueName: string;
  label?: string;
  dataset: string;          // e.g. "FACT_TABLE.dataset"
  keyColumns: string[];
  attributeColumns: string[];
}

export interface SmlLevel {
  uniqueName: string;
  label?: string;
  dataset?: string;         // present for degenerate levels
  keyColumns?: string[];
  timeUnit?: string;
  secondaryAttributes: SmlLevelAttribute[];
}

export interface SmlHierarchy {
  uniqueName: string;
  label?: string;
  levels: SmlLevel[];
}

export interface SmlDimension {
  uniqueName: string;
  label: string;
  type: string;             // "degenerate" | "standard" | "time"
  hierarchies: SmlHierarchy[];
  sourceFile: string;       // absolute path

  // Derived fingerprint sets (populated by loader)
  levelNames: Set<string>;       // all level unique_names across all hierarchies
  attributeNames: Set<string>;   // all secondary attribute unique_names
  backingDatasets: Set<string>;  // datasets referenced (strip ".dataset" suffix)
}

export interface SmlDataset {
  uniqueName: string;
  label: string;
  connectionId: string;
  table?: string;
  sql?: string;
  columns: SmlColumn[];
  sourceFile: string;

  // Derived
  columnNames: Set<string>;      // lowercase column names for Jaccard
  tableRef: string;              // normalised "connectionId:table" for identity check
}

export interface SmlMetric {
  uniqueName: string;
  label: string;
  objectType: string;            // "measure" | "calculation"
  dataset?: string;
  calculationMethod?: string;
  column?: string;
  formula?: string;
  folder?: string;
  sourceFile: string;
}

export interface SmlRelationship {
  uniqueName: string;
  fromDataset: string;           // e.g. "FACT_TABLE.dataset"
  joinColumns: string[];
  toDimension: string;
  toLevel: string;
  rolePlay?: string;
}

export interface SmlModel {
  uniqueName: string;
  label: string;
  relationships: SmlRelationship[];
  metricRefs: string[];          // metric unique_names
  sourceFile: string;

  // Derived
  dimensionNames: Set<string>;   // toDimension values
  factDatasets: Set<string>;     // fromDataset values (stripped of ".dataset")
}

export interface SmlProject {
  dir: string;                   // absolute path
  label: string;                 // from catalog.yml or dir basename
  dimensions: Map<string, SmlDimension>;
  datasets:   Map<string, SmlDataset>;
  metrics:    Map<string, SmlMetric>;
  models:     Map<string, SmlModel>;
}

// ============================================================
// YAML navigation helpers
// ============================================================

type YDoc = Record<string, unknown>;

function doc(raw: unknown): YDoc {
  if (raw && typeof raw === "object" && !Array.isArray(raw)) return raw as YDoc;
  return {};
}

function docArr(raw: unknown): YDoc[] {
  if (!raw) return [];
  if (Array.isArray(raw)) return raw.map(doc);
  return [];
}

function str(raw: unknown): string | undefined {
  return typeof raw === "string" ? raw : undefined;
}

function strArr(raw: unknown): string[] {
  if (!raw) return [];
  if (Array.isArray(raw)) return raw.filter((v): v is string => typeof v === "string");
  if (typeof raw === "string") return [raw];
  return [];
}

function stripDatasetSuffix(s: string): string {
  return s.replace(/\.dataset$/, "");
}

/** Extract a flattened lowercase table key from a raw table value.
 *  Handles both string form ("MY_TABLE") and nested object form
 *  ({db: "DB", schema: "SCH", name: "MY_TABLE"} → "db.sch.my_table").
 */
function tableKeyFromRaw(raw: unknown): string {
  if (typeof raw === "string") return raw.toLowerCase();
  if (raw && typeof raw === "object" && !Array.isArray(raw)) {
    const d = raw as Record<string, unknown>;
    const parts = [str(d.db), str(d.schema), str(d.name)].filter(Boolean);
    return parts.join(".").toLowerCase();
  }
  return "";
}

// ============================================================
// Entity parsers
// ============================================================

function parseLevelAttribute(d: YDoc): SmlLevelAttribute | null {
  const un = str(d.unique_name);
  const dataset = str(d.dataset);
  if (!un || !dataset) return null;
  return {
    uniqueName: un,
    label: str(d.label),
    dataset,
    keyColumns: strArr(d.key_columns),
    attributeColumns: strArr(d.attribute_columns),
  };
}

function parseLevel(d: YDoc): SmlLevel | null {
  const un = str(d.unique_name);
  if (!un) return null;
  const secondaryAttributes: SmlLevelAttribute[] = [];
  for (const a of docArr(d.secondary_attributes)) {
    const la = parseLevelAttribute(a);
    if (la) secondaryAttributes.push(la);
  }
  return {
    uniqueName: un,
    label: str(d.label),
    dataset: str(d.dataset),
    keyColumns: strArr(d.key_columns),
    timeUnit: str(d.time_unit),
    secondaryAttributes,
  };
}

function parseHierarchy(d: YDoc): SmlHierarchy | null {
  const un = str(d.unique_name);
  if (!un) return null;
  const levels: SmlLevel[] = [];
  for (const l of docArr(d.levels)) {
    const lv = parseLevel(l);
    if (lv) levels.push(lv);
  }
  return { uniqueName: un, label: str(d.label), levels };
}

function parseDimension(d: YDoc, filePath: string): SmlDimension | null {
  const un = str(d.unique_name);
  if (!un) return null;

  const hierarchies: SmlHierarchy[] = [];
  for (const h of docArr(d.hierarchies)) {
    const hier = parseHierarchy(h);
    if (hier) hierarchies.push(hier);
  }

  // Build fingerprint sets
  const levelNames = new Set<string>();
  const attributeNames = new Set<string>();
  const backingDatasets = new Set<string>();

  for (const hier of hierarchies) {
    for (const level of hier.levels) {
      levelNames.add(level.uniqueName);
      if (level.dataset) backingDatasets.add(stripDatasetSuffix(level.dataset));
      for (const attr of level.secondaryAttributes) {
        attributeNames.add(attr.uniqueName);
        backingDatasets.add(stripDatasetSuffix(attr.dataset));
      }
    }
  }

  return {
    uniqueName: un,
    label: str(d.label) ?? un,
    type: str(d.type) ?? "degenerate",
    hierarchies,
    sourceFile: filePath,
    levelNames,
    attributeNames,
    backingDatasets,
  };
}

function parseDataset(d: YDoc, filePath: string): SmlDataset | null {
  const un = str(d.unique_name);
  if (!un) return null;

  const columns: SmlColumn[] = [];
  for (const c of docArr(d.columns)) {
    const name = str(c.name);
    if (name) columns.push({ name, dataType: str(c.data_type) ?? "string" });
  }

  const connectionId = str(d.connection_id) ?? "";
  const table = str(d.table);
  const sql = str(d.sql);
  const tableKey = tableKeyFromRaw(d.table);
  const tableRef = sql
    ? `${connectionId}:sql:${sql.trim().slice(0, 60)}`
    : tableKey
      ? `${connectionId}:${tableKey}`
      : "";

  const columnNames = new Set(columns.map((c) => c.name.toLowerCase()));

  return {
    uniqueName: un,
    label: str(d.label) ?? un,
    connectionId,
    table,
    sql,
    columns,
    sourceFile: filePath,
    columnNames,
    tableRef,
  };
}

function parseMetric(d: YDoc, filePath: string): SmlMetric | null {
  const un = str(d.unique_name);
  if (!un) return null;
  return {
    uniqueName: un,
    label: str(d.label) ?? un,
    objectType: str(d.object_type) ?? "measure",
    dataset: str(d.dataset),
    calculationMethod: str(d.calculation_method),
    column: str(d.column),
    formula: str(d.formula),
    folder: str(d.folder),
    sourceFile: filePath,
  };
}

function parseModel(d: YDoc, filePath: string): SmlModel | null {
  const un = str(d.unique_name);
  if (!un) return null;

  const relationships: SmlRelationship[] = [];
  const dimensionNames = new Set<string>();
  const factDatasets = new Set<string>();

  for (const r of docArr(d.relationships)) {
    const fromDoc = doc(r.from);
    const toDoc = doc(r.to);
    const fromDataset = str(fromDoc.dataset);
    const toDimension = str(toDoc.dimension);
    if (!fromDataset || !toDimension) continue;
    relationships.push({
      uniqueName: str(r.unique_name) ?? `${fromDataset}_${toDimension}`,
      fromDataset,
      joinColumns: strArr(fromDoc.join_columns),
      toDimension,
      toLevel: str(toDoc.level) ?? "",
      rolePlay: str(r.role_play),
    });
    dimensionNames.add(toDimension);
    factDatasets.add(stripDatasetSuffix(fromDataset));
  }

  const metricRefs: string[] = [];
  for (const m of docArr(d.metrics)) {
    const n = str(m.unique_name);
    if (n) metricRefs.push(n);
  }

  return {
    uniqueName: un,
    label: str(d.label) ?? un,
    relationships,
    metricRefs,
    sourceFile: filePath,
    dimensionNames,
    factDatasets,
  };
}

// ============================================================
// Directory loader
// ============================================================

function loadYamlFiles(dir: string, subdir: string): Array<{ file: string; doc: YDoc }> {
  const fullDir = path.join(dir, subdir);
  if (!fs.existsSync(fullDir)) return [];
  return fs
    .readdirSync(fullDir)
    .filter((f) => f.endsWith(".yml") || f.endsWith(".yaml"))
    .flatMap((f) => {
      const filePath = path.join(fullDir, f);
      try {
        const raw = parseYaml(fs.readFileSync(filePath, "utf8"));
        if (raw && typeof raw === "object" && !Array.isArray(raw)) {
          return [{ file: filePath, doc: raw as YDoc }];
        }
      } catch {
        // skip unparseable files
      }
      return [];
    });
}

export function loadSmlProject(sourceDir: string): SmlProject {
  const dir = path.resolve(sourceDir);

  // Catalog label
  let label = path.basename(dir);
  const catalogPath = path.join(dir, "catalog.yml");
  if (fs.existsSync(catalogPath)) {
    try {
      const raw = parseYaml(fs.readFileSync(catalogPath, "utf8"));
      const d = doc(raw);
      label = str(d.label) ?? str(d.unique_name) ?? label;
    } catch {
      // ignore
    }
  }

  const dimensions = new Map<string, SmlDimension>();
  const datasets   = new Map<string, SmlDataset>();
  const metrics    = new Map<string, SmlMetric>();
  const models     = new Map<string, SmlModel>();

  for (const { file, doc: d } of loadYamlFiles(dir, "datasets")) {
    const entity = parseDataset(d, file);
    if (entity) datasets.set(entity.uniqueName, entity);
  }

  for (const { file, doc: d } of loadYamlFiles(dir, "dimensions")) {
    const entity = parseDimension(d, file);
    if (entity) dimensions.set(entity.uniqueName, entity);
  }

  for (const subdir of ["metrics", "calculations"]) {
    for (const { file, doc: d } of loadYamlFiles(dir, subdir)) {
      const entity = parseMetric(d, file);
      if (entity) metrics.set(entity.uniqueName, entity);
    }
  }

  for (const { file, doc: d } of loadYamlFiles(dir, "models")) {
    const entity = parseModel(d, file);
    if (entity) models.set(entity.uniqueName, entity);
  }

  return { dir, label, dimensions, datasets, metrics, models };
}
