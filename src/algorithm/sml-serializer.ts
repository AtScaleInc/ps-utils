// ============================================================
// AtScale SML (Semantic Modeling Language) Serializer
//
// Converts a SemanticModel into a set of YAML files conforming
// to the AtScale SML specification (v1.5).
//
// Output file layout:
//   catalog.yml
//   connections/{connectionName}.yml
//   datasets/{sourceTable}.yml          (one per fact + dimension table)
//   dimensions/{dimensionName}.yml      (one per dimension)
//   metrics/{metricUniqueName}.yml      (one per measure)
//   models/{modelName}.yml
//
// Reference: https://github.com/semanticdatalayer/SML
// ============================================================

import {
  ColumnMeta,
  SemanticModel,
  isBinaryType,
  SemanticDimension,
  SemanticFact,
  SemanticMeasure,
  SemanticHierarchy,
  SemanticAttribute,
  SemanticRelationship,
  SnowflakeRelationship,
  AggregationType,
  STRING_TYPES,
  NUMERIC_TYPES,
  isIntegerType,
} from "./types.js";

// ----------------------------------------------------------
// Public types
// ----------------------------------------------------------

export interface SmlSerializerOptions {
  /**
   * The unique_name of the SML Connection object all datasets will reference.
   * Must match an existing connection configured in AtScale.
   */
  connectionName: string;

  /**
   * Display label for the generated catalog.  Defaults to the model name.
   */
  catalogName?: string;

  /**
   * Database (catalog) name to embed in the connection file.
   * Required by AtScale when datasets reference tables (not SQL expressions).
   */
  database?: string;

  /**
   * Schema name to embed in the connection file.
   * Required by AtScale when datasets reference tables (not SQL expressions).
   */
  schema?: string;

  /**
   * Raw column metadata keyed by table name (snake_case).
   * When provided, dataset files include the full column list with data types.
   * When omitted, dataset files include only the columns referenced by the
   * semantic model (measures, hierarchy levels, attributes).
   */
  columnsByTable?: Map<string, ColumnMeta[]>;

  /**
   * Prefix for metric unique_names.  Default: "m_".
   * e.g. "m_revenue_sum", "m_quantity_average"
   */
  metricPrefix?: string;

  /**
   * Prefix for level_attribute unique_names within dimensions.  Default: "la_".
   * e.g. "la_year", "la_category"
   */
  levelAttributePrefix?: string;

  /**
   * Database dialect (e.g. "snowflake", "postgresql").
   * When "snowflake", dataset table names are emitted in UPPER CASE.
   */
  dialect?: string;

  /**
   * When true, dataset and dimension filenames are derived from the source
   * table name converted to camelCase (e.g. "factInternetSales.yml").
   * When false (default), the raw source table name is used as-is.
   */
  camelCaseFiles?: boolean;

  /**
   * When true, metric labels use the source column name converted to camelCase
   * (e.g. "totalRevenue").  When false (default), the raw column name is used.
   */
  camelCaseMeasures?: boolean;
}

/** Map of relative file path → YAML content. */
export type SmlOutput = Map<string, string>;

// ----------------------------------------------------------
// Internal helpers — YAML serialisation
// ----------------------------------------------------------

/** Values that YAML would misinterpret without quoting. */
const YAML_SPECIAL_VALUES = new Set([
  "yes", "no", "true", "false", "null", "~", "on", "off",
]);

function needsQuoting(s: string): boolean {
  if (s === "") return true;
  if (YAML_SPECIAL_VALUES.has(s.toLowerCase())) return true;
  if (/^[\d\-+.]/.test(s)) return true; // looks numeric
  if (/[:#\[\]{},|>&*!%@`"']/.test(s)) return true;
  if (s.startsWith(" ") || s.endsWith(" ")) return true;
  if (s.includes("\n")) return true;
  return false;
}

function yamlStr(s: string): string {
  if (!needsQuoting(s)) return s;
  // Use double-quoted style
  return `"${s.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\n/g, "\\n")}"`;
}

type YamlPrimitive = string | number | boolean | null | undefined;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type YamlValue = any;

/**
 * Serialize a plain JS object tree to a YAML string.
 * Keys with `undefined` values are omitted.
 * Arrays always use block style.
 */
function toYaml(value: YamlValue, indent = 0): string {
  const pad = " ".repeat(indent);

  if (value === null || value === undefined) return "~";
  if (typeof value === "boolean") return value ? "true" : "false";
  if (typeof value === "number") return String(value);
  if (typeof value === "string") return yamlStr(value);

  if (Array.isArray(value)) {
    if (value.length === 0) return "[]";
    return value
      .map((item) => {
        const rendered = toYaml(item, indent + 2);
        if (rendered.includes("\n")) {
          // Multi-line block item: first line on same line as `-`
          const [first, ...rest] = rendered.split("\n");
          return `${pad}- ${first}\n${rest.map((l) => `${pad}  ${l}`).join("\n")}`;
        }
        return `${pad}- ${rendered}`;
      })
      .join("\n");
  }

  // Object
  const entries = Object.entries(value as Record<string, YamlValue>).filter(
    ([, v]) => v !== undefined,
  );
  if (entries.length === 0) return "{}";

  return entries
    .map(([k, v]) => {
      const renderedVal = toYaml(v, indent + 2);
      if (
        Array.isArray(v) && (v as unknown[]).length > 0
      ) {
        // Block arrays: key on its own line, items indented
        return `${pad}${k}:\n${renderedVal}`;
      }
      if (
        v !== null &&
        typeof v === "object" &&
        !Array.isArray(v) &&
        Object.keys(v as object).length > 0
      ) {
        return `${pad}${k}:\n${renderedVal}`;
      }
      return `${pad}${k}: ${renderedVal}`;
    })
    .join("\n");
}

/** Wrap a YAML object with an optional header comment. */
function yamlDoc(obj: Record<string, YamlValue>, comment?: string): string {
  const header = comment ? `# ${comment}\n` : "";
  return `${header}${toYaml(obj)}\n`;
}

// ----------------------------------------------------------
// Naming helpers
// ----------------------------------------------------------

function toKebab(s: string): string {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");
}

function toTitleCase(s: string): string {
  return s.replace(/(^|[\s_-])(\w)/g, (_, sep, ch) => (sep ? " " : "") + ch.toUpperCase()).trim();
}

function toCamelCase(s: string): string {
  const words = s
    .replace(/([a-z])([A-Z])/g, "$1 $2")
    .replace(/([A-Z]+)([A-Z][a-z])/g, "$1 $2")
    .split(/[_\-\s]+/)
    .filter(Boolean);
  return words
    .map((w, i) =>
      i === 0 ? w.toLowerCase() : w.charAt(0).toUpperCase() + w.slice(1).toLowerCase(),
    )
    .join("");
}

function laName(columnName: string, prefix: string): string {
  return `${prefix}${columnName.toLowerCase()}`;
}

function metricUniqueName(measure: SemanticMeasure, prefix: string): string {
  return `${prefix}${measure.sourceColumn.toLowerCase()}_${measure.aggregation.toLowerCase()}`;
}

// ----------------------------------------------------------
// Data type mappings
// ----------------------------------------------------------

const JDBC_TO_SML: Record<string, string> = {
  // Character types
  VARCHAR: "string",    CHAR: "string",     NVARCHAR: "string",
  NCHAR: "string",      TEXT: "string",     NTEXT: "string",
  CLOB: "string",       STRING: "string",   XML: "string",
  SYSNAME: "string",    UNIQUEIDENTIFIER: "string",
  TINYTEXT: "string",   MEDIUMTEXT: "string", LONGTEXT: "string",
  ENUM: "string",       SET: "string",
  CHARACTER: "string",
  // Integer types
  INTEGER: "int",       INT: "int",         SMALLINT: "int",
  TINYINT: "int",       MEDIUMINT: "int",   INT2: "int",
  INT4: "int",
  BIGINT: "bigint",     INT8: "bigint",
  // Floating-point types
  FLOAT: "float",       REAL: "float",
  DOUBLE: "double",
  // Decimal types
  DECIMAL: "decimal",   NUMERIC: "decimal", NUMBER: "decimal",
  MONEY: "decimal",     SMALLMONEY: "decimal",
  // Boolean
  BOOLEAN: "boolean",   BOOL: "boolean",    BIT: "boolean",
  // Date / time
  DATE: "date",
  TIMESTAMP: "datetime",  DATETIME: "datetime",   SMALLDATETIME: "datetime",
  DATETIME2: "datetime",  DATETIMEOFFSET: "datetime",
  "TIMESTAMP WITH TIME ZONE": "datetime",
  "TIMESTAMP WITHOUT TIME ZONE": "datetime",
  // Snowflake types
  TIMESTAMP_NTZ: "datetime",   TIMESTAMP_LTZ: "datetime",   TIMESTAMP_TZ: "datetime",
};

function smlDataType(jdbcType: string): string {
  return JDBC_TO_SML[jdbcType.toUpperCase()] ?? "string";
}

const AGG_TO_SML: Record<AggregationType, string> = {
  SUM:   "sum",
  AVG:   "average",
  MIN:   "minimum",
  MAX:   "maximum",
  COUNT: "count non-null",
};

// ----------------------------------------------------------
// Time dimension helpers
// ----------------------------------------------------------

/**
 * Ordered list of [pattern, time_unit] pairs.
 * Word-boundary patterns are tried first (e.g. "Calendar Year"), then
 * substring fallbacks for concatenated column names (e.g. "calendaryear").
 * "semester" has no SML equivalent and is intentionally excluded.
 */
const TIME_UNIT_PATTERNS: Array<[RegExp, string]> = [
  [/\byear\b|\byr\b/i,              "year"],
  [/\bquarter\b|\bqtr\b/i,          "quarter"],
  [/\bhalf.?year\b|\bh[12]\b/i,     "halfyear"],   // J: half-year / halfyear / h1 / h2
  [/\bsemester\b/i,                 "quarter"],     // SML has no semester; nearest is quarter
  [/\bmonth\b/i,                    "month"],
  [/\bweek\b|\bwk\b/i,              "week"],
  [/\bday\b|\bdate\b/i,             "day"],
  [/\bhour\b|\bhr\b/i,              "hour"],
  [/\bminute\b|\bmin\b/i,           "minute"],
  [/\bsecond\b|\bsec\b/i,           "second"],
  // Substring fallbacks for concatenated names like "calendaryear", "datekey"
  [/year/i,                          "year"],
  [/quarter/i,                       "quarter"],
  [/half.?year|halfyr/i,             "halfyear"],   // J
  [/semester/i,                      "quarter"],
  [/month/i,                         "month"],
  [/week/i,                          "week"],
  [/date|day/i,                      "day"],
  [/hour/i,                          "hour"],
  [/minute/i,                        "minute"],
  [/second/i,                        "second"],
];

function inferTimeUnit(levelName: string): string | undefined {
  for (const [pattern, unit] of TIME_UNIT_PATTERNS) {
    if (pattern.test(levelName)) return unit;
  }
  return undefined;
}

function isTimeDimension(dim: SemanticDimension): boolean {
  return /date|time|fiscal|calendar|period/i.test(dim.name);
}

/**
 * SML unique_name for a dimension YAML object.
 * AtScale compares unique_names case-insensitively across all object types, so
 * a dimension named "Queries" would collide with a dataset named "queries".
 * We append " Dim" to all dimension unique_names to guarantee no collision.
 */
function dimUniqueName(dimName: string): string {
  return `${dimName} Dim`;
}

// ----------------------------------------------------------
// 1. Catalog file
// ----------------------------------------------------------

function buildCatalog(model: SemanticModel, opts: SmlSerializerOptions): string {
  return yamlDoc(
    {
      unique_name: toKebab(opts.catalogName ?? model.name),
      object_type: "catalog",
      label: opts.catalogName ?? model.name,
      version: 1.5,
      aggressive_agg_promotion: false,
      build_speculative_aggs: false,
      hidden_models: [],
    },
    "AtScale SML Catalog — generated by jdbc-semantic-model",
  );
}

// ----------------------------------------------------------
// 2. Connection file
// ----------------------------------------------------------

function buildConnection(opts: SmlSerializerOptions): string {
  return yamlDoc({
    unique_name: opts.connectionName,
    object_type: "connection",
    label: opts.connectionName,
    as_connection: opts.connectionName,
    database: opts.database ?? "database_name",
    schema:   opts.schema   ?? "default",
  });
}

// ----------------------------------------------------------
// 3. Dataset files
// ----------------------------------------------------------

/**
 * Collect all column names referenced by a dimension or fact so we can
 * produce a minimal dataset file when raw column metadata is unavailable.
 */
function columnsFromDimension(dim: SemanticDimension): string[] {
  const cols = new Set<string>();
  for (const h of dim.hierarchies) {
    for (const l of h.levels) cols.add(l.sourceColumn);
  }
  for (const a of dim.attributes) {
    cols.add(a.sourceColumn);
    for (const lbl of a.labels ?? []) cols.add(lbl.sourceColumn);
  }
  return Array.from(cols);
}

function columnsFromFact(fact: SemanticFact): string[] {
  const cols = new Set<string>();
  if (fact.primaryKey) cols.add(fact.primaryKey);
  for (const m of fact.measures) cols.add(m.sourceColumn);
  for (const d of fact.degenerateDimensions) cols.add(d.sourceColumn);
  return Array.from(cols);
}

function buildDataset(
  tableName: string,
  referencedColumns: string[],
  opts: SmlSerializerOptions,
): string {
  const physicalTableName = opts.dialect?.toLowerCase() === "snowflake"
    ? tableName.toUpperCase()
    : tableName;
  const rawCols = opts.columnsByTable?.get(tableName);

  let columns: Array<Record<string, YamlValue>>;

  if (rawCols && rawCols.length > 0) {
    // Full column list from JDBC metadata
    columns = rawCols.map((c) => ({
      name: c.columnName,
      data_type: smlDataType(c.dataType),
    }));
  } else {
    // Fallback: only columns we know about from the semantic model
    columns = referencedColumns.map((colName) => ({
      name: colName,
      data_type: "string", // unknown — mark for review
    }));
  }

  return yamlDoc({
    unique_name: tableName,
    object_type: "dataset",
    label: tableName,
    connection_id: opts.connectionName,
    ...(opts.database ? { database: opts.database } : {}),
    ...(opts.schema   ? { schema:   opts.schema   } : {}),
    table: physicalTableName,
    columns,
  });
}

// ----------------------------------------------------------
// 4. Dimension files
// ----------------------------------------------------------

interface LevelAttributeDef {
  unique_name: string;
  label: string;
  dataset: string;
  name_column: string;
  key_columns: string[];
  sort_column?: string;
  time_unit?: string;
  is_unique_key?: boolean;
  is_hidden?: boolean;
  description?: string;
  folder?: string;
  secondary_attributes?: Array<Record<string, YamlValue>>;
}

// ----------------------------------------------------------
// Helpers for surrogate-key pairing (A) and sort-column (C)
// ----------------------------------------------------------

/**
 * A: Given an integer key column name, find a string display-name companion
 * in the same table (e.g. "customerkey" → "fullname", "categoryid" → "category_name").
 */
function findNameColumn(
  sourceCol: string,
  colByLower: Map<string, ColumnMeta>,
): string | undefined {
  const lower = sourceCol.toLowerCase();
  // Strip common key suffixes to get stem ("productkey" → "product")
  const stem = lower.replace(/(_?key|_?id)$/i, "");
  if (!stem || stem === lower) return undefined;

  const nameSuffixes = ["name", "_name", "label", "_label", "description", "_description", "title", "_title"];
  for (const suffix of nameSuffixes) {
    const col = colByLower.get(stem + suffix);
    if (col && STRING_TYPES.has(col.dataType.toUpperCase())) return col.columnName;
  }
  // Generic display columns (fullname, displayname) — useful for surrogate customer/person keys
  for (const generic of ["fullname", "full_name", "displayname", "display_name"]) {
    const col = colByLower.get(generic);
    if (col && STRING_TYPES.has(col.dataType.toUpperCase())) return col.columnName;
  }
  return undefined;
}

/**
 * C: Given a string label column, find a numeric companion to use as sort_column
 * (e.g. "month_name" → "month_of_year", "month_number").
 */
function findSortColumn(
  sourceCol: string,
  colByLower: Map<string, ColumnMeta>,
): string | undefined {
  const lower = sourceCol.toLowerCase();
  // Strip common name/label suffixes to get stem
  const stem = lower.replace(/(_name|_label|_title|name|label|title)$/i, "");
  if (!stem || stem === lower) return undefined;

  const sortSuffixes = ["_number", "_num", "_id", "_key", "_code", "_sort"];
  for (const suffix of sortSuffixes) {
    const col = colByLower.get(stem + suffix);
    if (col && NUMERIC_TYPES.has(col.dataType.toUpperCase())) return col.columnName;
  }
  // "stem_of_*" pattern (e.g. month_of_year as sort for month_name)
  for (const [candidateLower, col] of colByLower) {
    if (
      candidateLower.startsWith(stem + "_of_") &&
      NUMERIC_TYPES.has(col.dataType.toUpperCase())
    ) {
      return col.columnName;
    }
  }
  return undefined;
}

function buildDimensionFile(
  dim: SemanticDimension,
  opts: SmlSerializerOptions,
): string {
  const laPrefix = opts.levelAttributePrefix ?? "la_";
  const isTime = isTimeDimension(dim);

  // Build column lookup maps for A (surrogate key pairing) and C (sort column).
  const rawCols = opts.columnsByTable?.get(dim.sourceTable) ?? [];
  const colByLower = new Map<string, ColumnMeta>(
    rawCols.map((c) => [c.columnName.toLowerCase(), c]),
  );

  // Build attribute lookup for description/folder propagation (H, I).
  const attrByCol = new Map<string, typeof dim.attributes[number]>(
    dim.attributes.map((a) => [a.sourceColumn, a]),
  );

  // Collect all level attributes needed:
  // - One per hierarchy level
  // - One per flat attribute (not already in a hierarchy)
  const levelAttrMap = new Map<string, LevelAttributeDef>();
  const hierarchyLevelColumns = new Set<string>();

  // Collect hierarchy level columns first
  for (const h of dim.hierarchies) {
    for (const l of h.levels) {
      hierarchyLevelColumns.add(l.sourceColumn);
    }
  }

  // Build level_attributes from hierarchy levels
  for (const h of dim.hierarchies) {
    for (const l of h.levels) {
      const key = l.sourceColumn;
      if (levelAttrMap.has(key)) continue; // shared across hierarchies

      const colMeta = colByLower.get(l.sourceColumn.toLowerCase());
      const colIsInt = colMeta ? isIntegerType(colMeta.dataType) : false;

      // A: surrogate key pairing — use a companion name column when the level
      // column is an integer and a string display companion exists.
      const nameColName = colIsInt ? findNameColumn(l.sourceColumn, colByLower) : undefined;

      // C: sort column pairing — find a numeric sort companion for string columns.
      const displayCol = nameColName ?? l.sourceColumn;
      const displayColMeta = colByLower.get(displayCol.toLowerCase());
      const sortColName = displayColMeta && STRING_TYPES.has(displayColMeta.dataType.toUpperCase())
        ? findSortColumn(displayCol, colByLower)
        : undefined;

      const la: LevelAttributeDef = {
        unique_name: laName(l.sourceColumn, laPrefix),
        label: l.name,
        dataset: dim.sourceTable,
        name_column: nameColName ?? l.sourceColumn,
        key_columns: [l.sourceColumn],
      };

      if (sortColName) la.sort_column = sortColName;

      const tu = inferTimeUnit(l.name) ?? (nameColName ? inferTimeUnit(nameColName) : undefined);
      if (isTime && tu) la.time_unit = tu;

      // H: description from attribute
      const attr = attrByCol.get(l.sourceColumn);
      if (attr?.description) la.description = attr.description;

      // I: folder
      if (isTime) {
        la.folder = "Date Attributes";
      } else if (attr?.folder) {
        la.folder = attr.folder;
      }

      levelAttrMap.set(key, la);
    }
  }

  // Build secondary_attributes from labels on flat attributes
  // and attach them to the appropriate level_attribute
  for (const attr of dim.attributes) {
    if (!attr.labels?.length) continue;
    const parentLa = levelAttrMap.get(attr.sourceColumn);
    if (!parentLa) continue;

    parentLa.secondary_attributes = attr.labels.map((lbl) => ({
      unique_name: laName(lbl.sourceColumn, laPrefix),
      label: lbl.name,
      dataset: dim.sourceTable,
      name_column: lbl.sourceColumn,
      key_columns: [lbl.sourceColumn],
    }));
  }

  // Add flat attributes (not already in a hierarchy) as standalone level_attributes
  for (const attr of dim.attributes) {
    if (hierarchyLevelColumns.has(attr.sourceColumn)) continue;
    if (levelAttrMap.has(attr.sourceColumn)) continue;

    const colMeta = colByLower.get(attr.sourceColumn.toLowerCase());
    const colIsInt = colMeta ? isIntegerType(colMeta.dataType) : false;

    // A: surrogate key pairing
    const nameColName = colIsInt ? findNameColumn(attr.sourceColumn, colByLower) : undefined;

    // C: sort column pairing
    const displayCol = nameColName ?? attr.sourceColumn;
    const displayColMeta = colByLower.get(displayCol.toLowerCase());
    const sortColName = displayColMeta && STRING_TYPES.has(displayColMeta.dataType.toUpperCase())
      ? findSortColumn(displayCol, colByLower)
      : undefined;

    const la: LevelAttributeDef = {
      unique_name: laName(attr.sourceColumn, laPrefix),
      label: attr.name,
      dataset: dim.sourceTable,
      name_column: nameColName ?? attr.sourceColumn,
      key_columns: [attr.sourceColumn],
    };

    if (sortColName) la.sort_column = sortColName;

    const tu = inferTimeUnit(attr.name) ?? inferTimeUnit(attr.sourceColumn);
    if (isTime && tu) la.time_unit = tu;

    // H: description
    if (attr.description) la.description = attr.description;

    // I: folder
    if (isTime) {
      la.folder = "Date Attributes";
    } else if (attr.folder) {
      la.folder = attr.folder;
    }

    levelAttrMap.set(attr.sourceColumn, la);
  }

  // PK as a level_attribute if not already included.
  // For composite PKs all key columns are gathered into one level_attribute.
  if (dim.primaryKeys.length > 0) {
    const firstPk = dim.primaryKeys[0];
    if (!levelAttrMap.has(firstPk)) {
      const colMeta = colByLower.get(firstPk.toLowerCase());
      const colIsInt = colMeta ? isIntegerType(colMeta.dataType) : false;

      // A: surrogate key pairing for the PK
      const nameColName = colIsInt ? findNameColumn(firstPk, colByLower) : undefined;

      // C: sort column pairing (only when single-column PK for simplicity)
      const displayCol = nameColName ?? firstPk;
      const displayColMeta = colByLower.get(displayCol.toLowerCase());
      const sortColName = dim.primaryKeys.length === 1 && displayColMeta && STRING_TYPES.has(displayColMeta.dataType.toUpperCase())
        ? findSortColumn(displayCol, colByLower)
        : undefined;

      const la: LevelAttributeDef = {
        unique_name: dim.primaryKeys.length === 1
          ? laName(firstPk, laPrefix)
          : laName(`${dim.sourceTable}_key`, laPrefix),
        label: firstPk,
        dataset: dim.sourceTable,
        name_column: nameColName ?? firstPk,
        key_columns: dim.primaryKeys,   // all PK columns (composite-key safe)
        is_unique_key: true,            // B: PK is always the unique key
      };

      if (sortColName) la.sort_column = sortColName;

      const tu = inferTimeUnit(firstPk);
      if (isTime && tu) la.time_unit = tu;

      if (isTime) la.folder = "Date Attributes";

      levelAttrMap.set(firstPk, la);
    } else {
      // B: PK may have been added already via a hierarchy level; mark it unique
      // and expand key_columns to include all PK columns.
      const existing = levelAttrMap.get(firstPk);
      if (existing) {
        existing.is_unique_key = true;
        if (dim.primaryKeys.length > 1) existing.key_columns = dim.primaryKeys;
      }
    }
  }

  // F: Add hidden join-key level_attributes for each snowflake FK group.
  // AtScale resolves to.level against the SOURCE dimension's own LAs, so each
  // relationship needs an LA here whose key_columns exactly match join_columns.
  const fkLaAdded = new Set<string>();
  for (const sr of dim.snowflakeRelationships ?? []) {
    const laUniqueName = sr.fromColumns.length === 1
      ? laName(sr.fromColumns[0], laPrefix)
      : laName(`${sr.toTable}_key`, laPrefix);
    if (fkLaAdded.has(laUniqueName)) continue;
    // Skip if an existing LA already has this unique_name with the right key count.
    const alreadyOk = Array.from(levelAttrMap.values()).some(
      (la) => la.unique_name === laUniqueName && la.key_columns.length === sr.fromColumns.length,
    );
    if (alreadyOk) { fkLaAdded.add(laUniqueName); continue; }
    fkLaAdded.add(laUniqueName);
    const firstCol = sr.fromColumns[0];
    const colMeta  = colByLower.get(firstCol.toLowerCase());
    const colIsInt = colMeta ? isIntegerType(colMeta.dataType) : false;
    const nameColName = colIsInt ? findNameColumn(firstCol, colByLower) : undefined;
    // Use a synthetic key so we don't overwrite any existing single-column entry.
    levelAttrMap.set(`__fk_${laUniqueName}`, {
      unique_name: laUniqueName,
      label: firstCol,
      dataset: dim.sourceTable,
      name_column: nameColName ?? firstCol,
      key_columns: sr.fromColumns,
      is_hidden: true,
    });
  }

  // Serialise level_attributes
  const level_attributes: Array<Record<string, YamlValue>> = Array.from(
    levelAttrMap.values(),
  ).map((la) => {
    const obj: Record<string, YamlValue> = {
      unique_name: la.unique_name,
      label: la.label,
      dataset: la.dataset,
      name_column: la.name_column,
      key_columns: la.key_columns,
    };
    if (la.is_unique_key) obj.is_unique_key = true;
    if (la.is_hidden)     obj.is_hidden = true;
    if (la.description)   obj.description = la.description;
    if (la.folder)        obj.folder = la.folder;
    if (la.sort_column)   obj.sort_column = la.sort_column;
    if (la.time_unit)     obj.time_unit = la.time_unit;
    if (la.secondary_attributes?.length) {
      obj.secondary_attributes = la.secondary_attributes as unknown as YamlValue;
    }
    return obj;
  });

  // Build hierarchy definitions
  const hierarchies: Array<Record<string, YamlValue>> = dim.hierarchies.map(
    (h) => ({
      unique_name: h.name,
      label: h.name,
      filter_empty: "yes",
      ...(isTime ? { folder: "Date Attributes" } : {}),
      levels: h.levels.map((l) => ({
        unique_name: laName(l.sourceColumn, laPrefix),
      })),
    }),
  );

  // F: Snowflake relationships within the dimension — dimension-to-dimension joins.
  const snowflakeRels = (dim.snowflakeRelationships ?? []).map((sr) => ({
    unique_name: `${dim.sourceTable}_${sr.toTable}_${sr.fromColumns.join("_")}`,
    from: {
      dataset:      dim.sourceTable,
      join_columns: sr.fromColumns,
    },
    to: {
      dimension: dimUniqueName(toTitleCase(sr.toTable)),
      level:     sr.fromColumns.length === 1
          ? laName(sr.fromColumns[0], laPrefix)
          : laName(`${sr.toTable}_key`, laPrefix),
    },
    type: "snowflake",
  }));

  const dimObj: Record<string, YamlValue> = {
    unique_name: dimUniqueName(dim.name),
    object_type: "dimension",
    label: dim.name,
    ...(dim.description ? { description: dim.description } : {}),
    type: isTime ? "time" : "standard",   // D: always emit type
    level_attributes: level_attributes as unknown as YamlValue,
    hierarchies: hierarchies as unknown as YamlValue,
  };

  // F: only emit relationships block when there are snowflake joins
  if (snowflakeRels.length > 0) {
    dimObj.relationships = snowflakeRels as unknown as YamlValue;
  }

  return yamlDoc(dimObj);
}

// ----------------------------------------------------------
// 5. Metric files
// ----------------------------------------------------------

function buildMetricFile(
  measure: SemanticMeasure,
  fact: SemanticFact,
  opts: SmlSerializerOptions,
): string {
  const prefix = opts.metricPrefix ?? "m_";
  const label = opts.camelCaseMeasures
    ? toCamelCase(measure.sourceColumn)
    : measure.sourceColumn;

  return yamlDoc({
    unique_name: metricUniqueName(measure, prefix),
    object_type: "metric",
    label,
    calculation_method: AGG_TO_SML[measure.aggregation],
    dataset: fact.sourceTable,
    column: measure.sourceColumn,
    is_hidden: false,
    unrelated_dimensions_handling: "empty",
  });
}

// ----------------------------------------------------------
// 6. Model file
// ----------------------------------------------------------

/**
 * Returns true for dimensions whose source table is itself a fact-like table
 * (name starts with "Fact" or matches a known fact source table).
 * These are bridge/junction tables that cannot be cleanly modeled as either
 * regular or degenerate dimensions in AtScale SML.
 */
function isFactLikeDimension(
  dim: SemanticDimension,
  factSourceTables: Set<string>,
): boolean {
  return (
    /^fact/i.test(dim.sourceTable) ||
    factSourceTables.has(dim.sourceTable.toLowerCase())
  );
}

function buildModelFile(
  model: SemanticModel,
  opts: SmlSerializerOptions,
): string {
  const laPrefix = opts.levelAttributePrefix ?? "la_";
  const metricPrefix = opts.metricPrefix ?? "m_";

  const dimByName = new Map(model.dimensions.map((d) => [d.name, d]));
  const factByName = new Map(model.facts.map((f) => [f.name, f]));
  const factSourceTables = new Set(model.facts.map((f) => f.sourceTable.toLowerCase()));

  // ---- Build relationships -----------------------------------------------

  type RelEntry = {
    rel: Record<string, YamlValue>;
    dimName: string;
    fromCol: string;
  };
  const relEntries: RelEntry[] = [];

  for (const rel of model.relationships) {
    const fact = factByName.get(rel.fromDataset);
    const dim  = dimByName.get(rel.toDataset);
    if (!fact || !dim) continue;

    // Bridge/junction tables classified as dimensions are excluded — they
    // cannot be modeled as regular or degenerate dimensions in AtScale SML.
    if (isFactLikeDimension(dim, factSourceTables)) continue;

    // Resolve the join level: prefer the level whose source column matches
    // the FK column; fall back to the dimension's primary key.
    let joinLevel: string = dim.primaryKeys.length === 1
      ? laName(dim.primaryKeys[0], laPrefix)
      : dim.primaryKeys.length > 1 ? laName(`${dim.sourceTable}_key`, laPrefix) : "";
    for (const h of dim.hierarchies) {
      const match = h.levels.find(
        (l) => l.sourceColumn.toLowerCase() === rel.toColumn.toLowerCase(),
      );
      if (match) { joinLevel = laName(match.sourceColumn, laPrefix); break; }
    }

    const relUniqueName = `${fact.sourceTable}_${toKebab(dim.name)}_${rel.fromColumn}`;
    relEntries.push({
      rel: {
        unique_name: relUniqueName,
        from: { dataset: fact.sourceTable, join_columns: rel.fromColumns ?? [rel.fromColumn] } as unknown as YamlValue,
        to:   { dimension: dimUniqueName(dim.name), level: joinLevel }       as unknown as YamlValue,
      },
      dimName: dim.name,
      fromCol: rel.fromColumn,
    });
  }

  // ---- Role-playing dimensions -------------------------------------------
  // When the same dimension is referenced by more than one relationship,
  // each relationship gets a `role_play` template string (e.g. "Order {0}").
  // AtScale substitutes {0} with dimension/level names in the UI.
  // No separate role_playing_dimensions block is needed.

  const dimRelCount = new Map<string, number>();
  for (const { dimName } of relEntries) {
    dimRelCount.set(dimName, (dimRelCount.get(dimName) ?? 0) + 1);
  }

  for (const entry of relEntries) {
    if ((dimRelCount.get(entry.dimName) ?? 0) <= 1) continue;
    // Humanise the FK column name and strip a trailing "Key" suffix for brevity
    // e.g. OrderDateKey → "Order Date", ShipDateKey → "Ship Date"
    const label = entry.fromCol
      .replace(/([a-z])([A-Z])/g, "$1 $2")
      .replace(/([A-Z]+)([A-Z][a-z])/g, "$1 $2")
      .replace(/_/g, " ")
      .replace(/\s*Key$/i, "")
      .trim();
    entry.rel.role_play = `${label} {0}`;
  }

  const relationships = relEntries.map((e) => e.rel);

  // ---- Degenerate dimensions ---------------------------------------------
  // Dimensions that have no incoming relationship from any fact are degenerate
  // (their columns live on the fact table itself).  Bridge/junction tables
  // that look like facts are excluded — they are omitted from the model entirely.

  const dimensionsWithRelationships = new Set(model.relationships.map((r) => r.toDataset));
  const degenerateDimNames = model.dimensions
    .filter((d) => !dimensionsWithRelationships.has(d.name))
    .filter((d) => !isFactLikeDimension(d, factSourceTables))
    // A true degenerate dimension lives on a fact table — exclude standalone
    // dimension tables that have no relationship path to any fact.
    .filter((d) => factSourceTables.has(d.sourceTable))
    .map((d) => dimUniqueName(d.name));

  // ---- Metrics -----------------------------------------------------------

  const allMetrics = model.facts.flatMap((f) =>
    f.measures.map((m) => ({ unique_name: metricUniqueName(m, metricPrefix) })),
  );
  const seenMetrics = new Set<string>();
  const uniqueMetrics = allMetrics.filter(({ unique_name }) => {
    if (seenMetrics.has(unique_name)) return false;
    seenMetrics.add(unique_name);
    return true;
  });

  // ---- Assemble model object ---------------------------------------------

  const modelObj: Record<string, YamlValue> = {
    unique_name: model.name,
    object_type: "model",
    label: model.name,
    relationships: relationships as unknown as YamlValue,
    metrics: uniqueMetrics as unknown as YamlValue,
  };

  if (degenerateDimNames.length > 0) {
    modelObj.dimensions = degenerateDimNames;
  }

  return yamlDoc(modelObj);
}

// ----------------------------------------------------------
// Main entry point
// ----------------------------------------------------------

/**
 * Convert a SemanticModel into a set of AtScale SML YAML files.
 *
 * @returns SmlOutput — a Map<relative-file-path, yaml-content>.
 *
 * @example
 * import { serializeToSml } from "./sml-serializer.js";
 * import { createDefaultEngine } from "./inference.js";
 *
 * const engine = createDefaultEngine();
 * const model = await proposeSemanticModel(db, "SalesModel", {
 *   inferenceEngine: engine,
 *   suggestions: true,
 * });
 *
 * const sml = serializeToSml(model, {
 *   connectionName: "My Snowflake Connection",
 *   columnsByTable: rawColumnMap,
 * });
 *
 * for (const [path, yaml] of sml) {
 *   await fs.writeFile(path, yaml, "utf8");
 * }
 */
export function serializeToSml(
  model: SemanticModel,
  opts: SmlSerializerOptions,
): SmlOutput {
  const output: SmlOutput = new Map();
  const laPrefix = opts.levelAttributePrefix ?? "la_";
  const metricPrefix = opts.metricPrefix ?? "m_";

  const factSourceTables = new Set(model.facts.map((f) => f.sourceTable.toLowerCase()));

  // catalog.yml
  output.set("catalog.yml", buildCatalog(model, opts));

  // connections/{name}.yml
  output.set(
    `connections/${toKebab(opts.connectionName)}.yml`,
    buildConnection(opts),
  );

  // datasets/{table}.yml — one per dimension table (skip bridge/junction tables)
  for (const dim of model.dimensions) {
    if (isFactLikeDimension(dim, factSourceTables)) continue;
    const referencedCols = columnsFromDimension(dim);
    const dsFilename = opts.camelCaseFiles ? toCamelCase(dim.sourceTable) : dim.sourceTable;
    output.set(
      `datasets/${dsFilename}.yml`,
      buildDataset(dim.sourceTable, referencedCols, opts),
    );
  }

  // datasets/{table}.yml — one per fact table
  for (const fact of model.facts) {
    const referencedCols = columnsFromFact(fact);
    const dsFilename = opts.camelCaseFiles ? toCamelCase(fact.sourceTable) : fact.sourceTable;
    output.set(
      `datasets/${dsFilename}.yml`,
      buildDataset(fact.sourceTable, referencedCols, opts),
    );
  }

  // dimensions/{name}.yml (skip bridge/junction tables)
  for (const dim of model.dimensions) {
    if (isFactLikeDimension(dim, factSourceTables)) continue;
    const dimFilename = opts.camelCaseFiles ? toCamelCase(dim.sourceTable) : dim.sourceTable;
    output.set(
      `dimensions/${dimFilename}.yml`,
      buildDimensionFile(dim, opts),
    );
  }

  // metrics/{uniqueName}.yml — one per unique measure
  const seenMetrics = new Set<string>();
  for (const fact of model.facts) {
    for (const measure of fact.measures) {
      const uniqueName = metricUniqueName(measure, metricPrefix);
      if (seenMetrics.has(uniqueName)) continue;
      seenMetrics.add(uniqueName);
      output.set(
        `metrics/${toKebab(uniqueName)}.yml`,
        buildMetricFile(measure, fact, opts),
      );
    }
  }

  // models/{name}.yml
  output.set(
    `models/${toKebab(model.name)}.yml`,
    buildModelFile(model, opts),
  );

  return output;
}
