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
import { isSystemColumn } from "./attribute-inference.js";

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
   * @deprecated No longer used. Level attribute unique_names are the lowercased
   * column name directly (e.g. "query_id"), matching the AtScale SML reference style.
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
   * @deprecated Prefer `labelStyle` for a unified label style across all objects.
   */
  camelCaseMeasures?: boolean;

  /**
   * Controls how display labels are derived from source table / column names for
   * all SML objects: datasets, dimensions, hierarchies, level attributes,
   * secondary attributes, and metrics.
   *
   * - `"title-case"` (default) — strip affixes (dim_, _dimension, _key, …),
   *   then apply Title Case.  e.g. `dim_customer_dimension` → `"Customer"`.
   * - `"camel-case"` — strip affixes then apply lowerCamelCase.
   *   e.g. `dim_customer_dimension` → `"customer"`.
   * - `"none"` — use the raw source name with no transformation.
   *   e.g. `dim_customer_dimension` → `"dim_customer_dimension"`.
   *
   * When `labelStyle` is set, it overrides `camelCaseMeasures` for metric labels.
   */
  labelStyle?: LabelStyle;
}

/** Controls how display labels are derived from source names. */
export type LabelStyle = "title-case" | "camel-case" | "none";

/**
 * Apply the requested label style to a pre-stripped raw name string.
 * Use `dimensionLabel` / `levelLabel` for names that require affix stripping first.
 */
export function applyLabelStyle(rawName: string, style: LabelStyle = "title-case"): string {
  if (style === "camel-case") return toCamelCase(rawName);
  if (style === "none") return rawName;
  return toTitleCase(rawName);
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
    const itemPad = " ".repeat(indent + 2);
    return value
      .map((item) => {
        // Render the item without leading indent so the first key lands
        // immediately after "- ", matching AtScale's expected SML format.
        const rendered = toYaml(item, 0);
        if (rendered.includes("\n")) {
          // Multi-line block item: first key on same line as `-`,
          // subsequent lines shifted to indent+2.
          const [first, ...rest] = rendered.split("\n");
          return `${pad}- ${first}\n${rest.map((l) => (l ? `${itemPad}${l}` : "")).join("\n")}`;
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

export function toTitleCase(s: string): string {
  return s.replace(/(^|[\s_-])(\w)/g, (_, sep, ch) => (sep ? " " : "") + ch.toUpperCase()).trim();
}

export function toCamelCase(s: string): string {
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

/** Level-attribute unique_name — just the lowercased column name. */
function laName(columnName: string, _prefix?: string): string {
  return columnName.toLowerCase();
}

/**
 * Derive the abbreviation for a fact table name by taking the first letter
 * of each underscore-delimited word.  e.g. "fact_inventory_transaction" → "fit".
 */
function factTableAbbrev(tableName: string): string {
  return tableName
    .split("_")
    .filter(Boolean)
    .map((w) => w[0])
    .join("")
    .toLowerCase();
}

/**
 * Derive a human-readable label for a dimension from its source table name.
 * Strips the `dim_` prefix and `_dimension` suffix, then applies the label style.
 */
export function dimensionLabel(sourceTable: string, style: LabelStyle = "title-case"): string {
  if (style === "none") return sourceTable;
  return applyLabelStyle(
    sourceTable
      .replace(/^dim_/i, "")
      .replace(/_dimension$/i, ""),
    style,
  );
}

function metricUniqueName(measure: SemanticMeasure, fact: SemanticFact, prefix: string): string {
  const abbrev = factTableAbbrev(fact.sourceTable);
  return `${prefix}${abbrev}_${measure.sourceColumn.toLowerCase()}_${measure.aggregation.toLowerCase()}`;
}

/** Display form of aggregation type used in metric descriptions. */
const AGG_TO_DISPLAY: Record<AggregationType, string> = {
  SUM:                    "Sum",
  AVG:                    "Average",
  MIN:                    "Minimum",
  MAX:                    "Maximum",
  COUNT:                  "Count",
  DISTINCT_COUNT_ESTIMATE: "Distinct Count",
};

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
  BIGINT: "long",       INT8: "long",
  // Floating-point types
  FLOAT: "double",      REAL: "double",
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
  SUM:                    "sum",
  AVG:                    "average",
  MIN:                    "minimum",
  MAX:                    "maximum",
  COUNT:                  "count non-null",
  DISTINCT_COUNT_ESTIMATE: "distinct count estimate",
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
 * Datasets use a ".dataset" suffix and catalogs use ".catalog", so plain
 * dimension names are collision-free without any additional suffix.
 */
function dimUniqueName(dimName: string): string {
  return dimName;
}


// ----------------------------------------------------------
// 1. Catalog file
// ----------------------------------------------------------

function buildCatalog(model: SemanticModel, opts: SmlSerializerOptions): string {
  const label = opts.catalogName ?? model.name;
  return yamlDoc(
    {
      unique_name: `${label}.catalog`,
      object_type: "catalog",
      label,
      version: 1.5,
      aggressive_agg_promotion: false,
      build_speculative_aggs: false,
    },
    "AtScale SML Catalog — generated by semantic-model-builder",
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

/** Returns the SML unique_name for a dataset (tableName + ".dataset" suffix). */
function datasetUniqueName(tableName: string): string {
  return `${tableName}.dataset`;
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

  // database/schema live in the connection file, not in individual datasets.
  return yamlDoc({
    unique_name: datasetUniqueName(tableName),
    object_type: "dataset",
    label: applyLabelStyle(tableName, opts.labelStyle ?? "title-case"),
    connection_id: opts.connectionName,
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
  /**
   * When false, indicates the name_column values are not unique within the
   * composite key (required for composite-key level attributes).
   */
  contains_unique_names?: boolean;
  is_hidden?: boolean;
  /** When true, emits is_hidden: true (surrogate integer key with a companion display column). */
  is_surrogate_key?: boolean;
  description?: string;
  folder?: string;
  secondary_attributes?: Array<Record<string, YamlValue>>;
}

/**
 * Human-readable label for a level attribute / secondary attribute column.
 * Strips surrogate-key suffixes (_key, _id, _sk) and dimension affixes,
 * then applies the label style.
 */
export function levelLabel(columnName: string, style: LabelStyle = "title-case"): string {
  if (style === "none") return columnName;
  return applyLabelStyle(
    columnName
      .replace(/^dim_/i, "")
      .replace(/_dimension$/i, "")
      .replace(/_(key|id|sk)$/i, "")
      .replace(/_level$/i, ""),
    style,
  );
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
  const isTime = isTimeDimension(dim);

  // Build column lookup maps for A (surrogate key pairing) and C (sort column).
  const rawCols = opts.columnsByTable?.get(dim.sourceTable) ?? [];
  const colByLower = new Map<string, ColumnMeta>(
    rawCols.map((c) => [c.columnName.toLowerCase(), c]),
  );

  // Build secondary_attributes for a hierarchy leaf level.
  // All non-system columns from the source table are included. A column whose
  // lowercased name matches the leaf level's unique_name receives a `_sa` suffix
  // to avoid an AtScale validation error for duplicate unique_names within the level.
  function buildLeafSecondaryAttrs(leafSourceColumn: string): Array<Record<string, YamlValue>> {
    if (rawCols.length === 0) return [];
    const leafUniqueName = laName(leafSourceColumn);
    return rawCols
      .filter((col) => !isSystemColumn(col.columnName))
      .map((col) => {
        const colUniqueName = col.columnName.toLowerCase();
        return {
          unique_name: colUniqueName === leafUniqueName ? `${col.columnName}_sa` : col.columnName,
          label: levelLabel(col.columnName, opts.labelStyle ?? "title-case"),
          contains_unique_names: false,
          dataset: datasetUniqueName(dim.sourceTable),
          is_unique_key: false,
          key_columns: [col.columnName],
          name_column: col.columnName,
        };
      });
  }

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
        unique_name: laName(l.sourceColumn),
        label: levelLabel(l.sourceColumn, opts.labelStyle ?? "title-case"),
        dataset: datasetUniqueName(dim.sourceTable),
        name_column: nameColName ?? l.sourceColumn,
        key_columns: [l.sourceColumn],
      };

      if (sortColName) la.sort_column = sortColName;
      if (colIsInt && nameColName && /_(key|id|sk)$/i.test(l.sourceColumn)) {
        la.is_surrogate_key = true;
      }

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
      unique_name: laName(lbl.sourceColumn),
      label: lbl.name,
      dataset: datasetUniqueName(dim.sourceTable),
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
      unique_name: laName(attr.sourceColumn),
      label: levelLabel(attr.sourceColumn, opts.labelStyle ?? "title-case"),
      dataset: datasetUniqueName(dim.sourceTable),
      name_column: nameColName ?? attr.sourceColumn,
      key_columns: [attr.sourceColumn],
    };

    if (sortColName) la.sort_column = sortColName;
    if (colIsInt && nameColName && /_(key|id|sk)$/i.test(attr.sourceColumn)) {
      la.is_surrogate_key = true;
    }

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

      // Collision check: if any snowflake relationship uses firstPk as a
      // single-column FK, it will also need an LA named <firstPk> with
      // key_columns=[firstPk] (1 col).  The unique-key LA has key_columns=all
      // PK cols (N cols).  AtScale validates join_columns.length == LA
      // key_columns.length, so these two LAs cannot share the same unique_name.
      // In that case, rename the unique-key LA to <table>_key.
      const singleColFkCols = new Set(
        (dim.snowflakeRelationships ?? [])
          .filter((sr) => sr.fromColumns.length === 1)
          .map((sr) => sr.fromColumns[0].toLowerCase()),
      );
      const uniqueKeyCollides =
        dim.primaryKeys.length > 1 &&
        singleColFkCols.has(firstPk.toLowerCase());
      const isCompositePk = dim.primaryKeys.length > 1;
      const la: LevelAttributeDef = {
        unique_name: uniqueKeyCollides
          ? laName(`${dim.sourceTable}_key`)
          : laName(firstPk),
        label: levelLabel(firstPk, opts.labelStyle ?? "title-case"),
        dataset: datasetUniqueName(dim.sourceTable),
        name_column: nameColName ?? firstPk,
        // Composite PKs: include all key columns; AtScale supports multi-column
        // key_columns with is_unique_key: true when contains_unique_names: false.
        key_columns: dim.primaryKeys,
        is_unique_key: true,
        ...(isCompositePk ? { contains_unique_names: false } : {}),
        ...(colIsInt && nameColName && /_(key|id|sk)$/i.test(firstPk) ? { is_surrogate_key: true } : {}),
      };

      if (sortColName) la.sort_column = sortColName;

      const tu = inferTimeUnit(firstPk);
      if (isTime && tu) la.time_unit = tu;

      if (isTime) la.folder = "Date Attributes";

      levelAttrMap.set(firstPk, la);

    } else {
      // B: PK may have been added already via a hierarchy level; mark it as
      // the unique key and ensure all PK columns are included.
      const existing = levelAttrMap.get(firstPk);
      if (existing) {
        existing.is_unique_key = true;
        existing.key_columns = dim.primaryKeys;
        if (dim.primaryKeys.length > 1) existing.contains_unique_names = false;
      }
    }
  }

  // F: Add hidden join-key level_attributes for single-column snowflake FK joins.
  // Multi-column FK snowflake joins are filtered out in the semantic model builder
  // (semantic-model-builder.ts) because AtScale cannot satisfy both the validator's
  // source-LA key_columns count check and the compiler's visible-target-LA check
  // when the FK columns differ from the target's PK columns.
  const fkLaAdded = new Set<string>();
  for (const sr of dim.snowflakeRelationships ?? []) {
    // All remaining relationships are single-column at this point.
    const laUniqueName = laName(sr.fromColumns[0]);
    if (fkLaAdded.has(laUniqueName)) continue;
    const alreadyOk = Array.from(levelAttrMap.values()).some(
      (la) => la.unique_name === laUniqueName,
    );
    if (alreadyOk) { fkLaAdded.add(laUniqueName); continue; }
    fkLaAdded.add(laUniqueName);
    const col     = sr.fromColumns[0];
    const colMeta = colByLower.get(col.toLowerCase());
    const colIsInt = colMeta ? isIntegerType(colMeta.dataType) : false;
    const nameColName = colIsInt ? findNameColumn(col, colByLower) : undefined;
    levelAttrMap.set(`__fk_${laUniqueName}`, {
      unique_name: laUniqueName,
      label: col,
      dataset: datasetUniqueName(dim.sourceTable),
      name_column: nameColName ?? col,
      key_columns: [col],
      is_hidden: true,
    });
  }

  // Build hierarchy definitions (emitted before level_attributes to match
  // the reference SML structure).
  const ls = opts.labelStyle ?? "title-case";
  const hierarchies: Array<Record<string, YamlValue>> = dim.hierarchies.map(
    (h) => ({
      unique_name: h.name.toLowerCase().replace(/\s+/g, "_"),
      label: ls === "none" ? h.name.toLowerCase().replace(/\s+/g, "_") : applyLabelStyle(h.name, ls),
      // filter_empty is only meaningful on time hierarchies (avoids blank rows)
      ...(isTime ? { filter_empty: "yes" } : {}),
      ...(isTime ? { folder: "Date Attributes" } : {}),
      levels: h.levels.map((l, i) => {
        const isLeaf = i === h.levels.length - 1;
        const leafAttrs = isLeaf ? buildLeafSecondaryAttrs(l.sourceColumn) : [];
        const levelDef: Record<string, YamlValue> = {
          unique_name: laName(l.sourceColumn),
          ...(isLeaf ? { visualize_in_bi_tool: false } : {}),
        };
        if (leafAttrs.length > 0) {
          levelDef.secondary_attributes = leafAttrs;
        }
        return levelDef;
      }),
    }),
  );

  // AtScale requires `to.level` in model relationships to reference a hierarchy
  // level, not just a level_attribute. The PK column (which carries
  // is_unique_key: true) is excluded from hierarchy inference because it is not
  // in nonPkCols — so it is never in any inferred hierarchy. When the PK is
  // absent from every hierarchy, add it as the leaf of a synthetic hierarchy so
  // model relationships that point to this dimension resolve correctly.
  //
  // When the composite-key LA was renamed to <table>_key due to a name
  // collision (uniqueKeyCollides), the check must use that renamed LA name —
  // the original firstPk name refers to a hidden single-column LA that is
  // already present in an inferred hierarchy, so the check would incorrectly
  // conclude the composite-key LA is covered.
  if (dim.primaryKeys.length > 0) {
    const firstPk = dim.primaryKeys[0];
    // Re-derive collision (same logic as the PK LA creation above).
    const singleColFkColsH = new Set(
      (dim.snowflakeRelationships ?? [])
        .filter((sr) => sr.fromColumns.length === 1)
        .map((sr) => sr.fromColumns[0].toLowerCase()),
    );
    const uniqueKeyCollidesH =
      dim.primaryKeys.length > 1 && singleColFkColsH.has(firstPk.toLowerCase());
    const uniqueKeyLaName = uniqueKeyCollidesH
      ? laName(`${dim.sourceTable}_key`)
      : laName(firstPk);

    const pkInHierarchy = dim.hierarchies.some((h) =>
      h.levels.some((l) => laName(l.sourceColumn) === uniqueKeyLaName),
    );
    if (!pkInHierarchy) {
      // Only include the unique-key LA as the single level — adding other
      // levels risks duplicating them across hierarchies which AtScale rejects.
      // When there is already a hierarchy named <table>_hierarchy (e.g. from
      // the inferred dim.hierarchies), use a non-conflicting name.
      const existingHierNames = new Set(hierarchies.map((h) => String(h["unique_name"] ?? "")));
      const baseName = `${dim.sourceTable}_hierarchy`;
      const synthName = existingHierNames.has(baseName)
        ? `${dim.sourceTable}_key_hierarchy`
        : baseName;
      const dimLbl = dimensionLabel(dim.sourceTable, ls);
      const synthLabel = existingHierNames.has(baseName)
        ? `${dimLbl} Key Hierarchy`
        : `${dimLbl} Hierarchy`;
      // When the composite-key LA was renamed to <table>_key due to collision,
      // the single-column FK LA (laName(firstPk)) is still needed as a hierarchy
      // level so that snowflake relationships can use it as their `to.level`
      // (AtScale requires `to.level` to reference a level in the source
      // dimension, not the target dimension).  Add it as the parent level with
      // the composite-key LA as the leaf.
      // The synthetic hierarchy's leaf is uniqueKeyLaName, which comes from either
      // the renamed composite-key LA or the first PK column.  Derive the source
      // column for secondary attribute collision detection: when collides, the leaf
      // is the composite-key LA whose source column is firstPk; otherwise it is firstPk.
      const synthLeafSrcCol = uniqueKeyCollidesH ? `${dim.sourceTable}_key` : firstPk;
      const synthLeafAttrs = buildLeafSecondaryAttrs(synthLeafSrcCol);
      const synthLeafExtra = synthLeafAttrs.length > 0 ? { secondary_attributes: synthLeafAttrs } : {};
      const synthLevels: Array<Record<string, YamlValue>> = uniqueKeyCollidesH
        ? [
            { unique_name: laName(firstPk), visualize_in_bi_tool: false },
            { unique_name: uniqueKeyLaName, visualize_in_bi_tool: false, ...synthLeafExtra },
          ]
        : [{ unique_name: uniqueKeyLaName, visualize_in_bi_tool: false, ...synthLeafExtra }];
      hierarchies.push({
        unique_name: synthName,
        label: synthLabel,
        ...(isTime ? { filter_empty: "yes" } : {}),
        ...(isTime ? { folder: "Date Attributes" } : {}),
        levels: synthLevels,
      });
    }
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
    if (la.is_unique_key)            obj.is_unique_key = true;
    if (la.contains_unique_names === false) obj.contains_unique_names = false;
    if (la.is_hidden || la.is_surrogate_key) obj.is_hidden = true;
    if (la.description)   obj.description = la.description;
    if (la.folder)        obj.folder = la.folder;
    if (la.sort_column)   obj.sort_column = la.sort_column;
    if (la.time_unit)     obj.time_unit = la.time_unit;
    if (la.secondary_attributes?.length) {
      obj.secondary_attributes = la.secondary_attributes as unknown as YamlValue;
    }
    return obj;
  });

  // F: Snowflake relationships within the dimension — dimension-to-dimension joins.
  const snowflakeRels = (dim.snowflakeRelationships ?? []).map((sr) => ({
    unique_name: `${dim.sourceTable}_${sr.toTable}_${sr.fromColumns.join("_")}`,
    from: {
      dataset:      datasetUniqueName(dim.sourceTable),
      join_columns: sr.fromColumns,
    },
    to: {
      dimension: dimUniqueName(toTitleCase(sr.toTable)),
      level:     laName(sr.fromColumns[0]),
    },
    type: "snowflake",
  }));

  const dimObj: Record<string, YamlValue> = {
    unique_name: dimUniqueName(dim.name),
    object_type: "dimension",
    label: dimensionLabel(dim.sourceTable, ls),
    ...(dim.description ? { description: dim.description } : {}),
    type: isTime ? "time" : "standard",
    hierarchies: hierarchies as unknown as YamlValue,
    level_attributes: level_attributes as unknown as YamlValue,
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

/** Convert a snake_case column name into a human-readable Title Case label. */
function humanizeLabel(columnName: string): string {
  return columnName
    .replace(/_/g, " ")
    .replace(/([a-z])([A-Z])/g, "$1 $2")
    .replace(/\b\w/g, (ch) => ch.toUpperCase());
}

function buildMetricFile(
  measure: SemanticMeasure,
  fact: SemanticFact,
  opts: SmlSerializerOptions,
): string {
  const prefix = opts.metricPrefix ?? "m_";
  // Resolve effective label style for metrics.
  // labelStyle takes precedence; camelCaseMeasures is a legacy fallback.
  const metricLabelStyle = opts.labelStyle ?? (opts.camelCaseMeasures ? "camel-case" : "title-case");
  const label =
    metricLabelStyle === "camel-case" ? toCamelCase(measure.name) :
    metricLabelStyle === "none"       ? `${measure.sourceColumn}_${measure.aggregation.toLowerCase()}` :
    measure.name;

  // Format: #,##0 for columns that support SUM/COUNT; #,##0.00 for rate/ratio-only columns.
  const siblingsHaveSumOrCount = fact.measures
    .filter((m) => m.sourceColumn === measure.sourceColumn)
    .some((m) => m.aggregation === "SUM" || m.aggregation === "COUNT");
  const format = siblingsHaveSumOrCount ? "#,##0" : "#,##0.00";

  const description =
    `${AGG_TO_DISPLAY[measure.aggregation]} of ${humanizeLabel(measure.sourceColumn)} ` +
    `from ${toTitleCase(fact.sourceTable)}`;

  return yamlDoc({
    unique_name: metricUniqueName(measure, fact, prefix),
    object_type: "metric",
    label,
    calculation_method: AGG_TO_SML[measure.aggregation],
    dataset: datasetUniqueName(fact.sourceTable),
    column: measure.sourceColumn,
    description,
    format,
    folder: `${fact.sourceTable}_metrics`,
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

    const joinCols = rel.fromColumns ?? [rel.fromColumn];

    // Per AtScale best practices: create one relationship per hierarchy leaf
    // level so that every hierarchy in the dimension is accessible from the
    // BI tool.  When no hierarchies exist, fall back to the PK level.
    const targetHierarchies = dim.hierarchies.length > 0
      ? dim.hierarchies
      : null;

    // For composite FK joins, the relationship must target the composite-key
    // level attribute (is_unique_key: true), not the hierarchy leaf.
    // Replicate the collision-detection logic from buildDimensionFile to get
    // the correct unique_name of that level attribute.
    const compositeKeyLaName: string | null = (() => {
      if (joinCols.length <= 1 || dim.primaryKeys.length <= 1) return null;
      const firstPk = dim.primaryKeys[0];
      const singleColFkCols = new Set(
        (dim.snowflakeRelationships ?? [])
          .filter((sr) => sr.fromColumns.length === 1)
          .map((sr) => sr.fromColumns[0].toLowerCase()),
      );
      const collides = singleColFkCols.has(firstPk.toLowerCase());
      return collides ? laName(`${dim.sourceTable}_key`) : laName(firstPk);
    })();

    if (targetHierarchies) {
      for (const h of targetHierarchies) {
        const leafLevel = h.levels[h.levels.length - 1];
        if (!leafLevel) continue;
        // Composite FK joins must target the composite-key LA; single-column FK
        // joins target the hierarchy leaf level as usual.
        const joinLevel = compositeKeyLaName ?? laName(leafLevel.sourceColumn);
        const hierSlug  = h.name.toLowerCase().replace(/\s+/g, "_");
        relEntries.push({
          rel: {
            unique_name: `${fact.sourceTable}_${toKebab(dim.name)}_${rel.fromColumn}_${hierSlug}`,
            from: { dataset: datasetUniqueName(fact.sourceTable), join_columns: joinCols } as unknown as YamlValue,
            to:   { dimension: dimUniqueName(dim.name), level: joinLevel }                 as unknown as YamlValue,
          },
          dimName: dim.name,
          fromCol: rel.fromColumn,
        });
      }
    } else {
      // Fallback: join to the PK level attribute (or composite-key LA if composite)
      const joinLevel = compositeKeyLaName
        ?? (dim.primaryKeys.length > 0 ? laName(dim.primaryKeys[0]) : "");
      relEntries.push({
        rel: {
          unique_name: `${fact.sourceTable}_${toKebab(dim.name)}_${rel.fromColumn}`,
          from: { dataset: datasetUniqueName(fact.sourceTable), join_columns: joinCols } as unknown as YamlValue,
          to:   { dimension: dimUniqueName(dim.name), level: joinLevel }                 as unknown as YamlValue,
        },
        dimName: dim.name,
        fromCol: rel.fromColumn,
      });
    }
  }

  // ---- Role-playing dimensions -------------------------------------------
  // When the same dimension is referenced by more than one relationship,
  // each relationship gets a `role_play` template string (e.g. "Order {0}").
  // AtScale substitutes {0} with dimension/level names in the UI.
  // No separate role_playing_dimensions block is needed.

  // Role-playing: a dimension is role-played when the SAME dimension is joined
  // via DIFFERENT FK columns (e.g. order_date_key and ship_date_key both point
  // to dim_date).  Multiple relationships to the same dim via the SAME FK column
  // (one per hierarchy) are NOT role-playing — they share the same fromCol.
  const dimFkPairs = new Set<string>();
  for (const { dimName, fromCol } of relEntries) {
    dimFkPairs.add(`${dimName}|${fromCol}`);
  }
  // Count distinct FK columns per dimension
  const dimDistinctFkCount = new Map<string, number>();
  for (const { dimName } of relEntries) {
    const pairs = Array.from(dimFkPairs).filter((p) => p.startsWith(`${dimName}|`));
    dimDistinctFkCount.set(dimName, pairs.length);
  }

  for (const entry of relEntries) {
    if ((dimDistinctFkCount.get(entry.dimName) ?? 0) <= 1) continue;
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

  // Only include metrics from fact tables that have at least one model
  // relationship. Facts with no dimensional connection produce orphaned
  // metrics that cause AtScale's engine to report "no keyed attributes".
  const connectedFactTables = new Set(
    relEntries.map((e) => (e.rel.from as any)?.dataset as string),
  );

  const allMetrics = model.facts
    .filter((f) => connectedFactTables.has(datasetUniqueName(f.sourceTable)))
    .flatMap((f) =>
      f.measures.map((m) => ({ unique_name: metricUniqueName(m, f, metricPrefix) })),
    );
  const seenMetrics = new Set<string>();
  const uniqueMetrics = allMetrics.filter(({ unique_name }) => {
    if (seenMetrics.has(unique_name)) return false;
    seenMetrics.add(unique_name);
    return true;
  });

  // ---- Assemble model object ---------------------------------------------

  // The catalog uses "Name.catalog" and datasets use "name.dataset", so the
  // plain model name has no collision risk with other SML object types.
  const modelObj: Record<string, YamlValue> = {
    unique_name: model.name,
    object_type: "model",
    label: opts.catalogName ?? model.name,
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
  const metricPrefix = opts.metricPrefix ?? "m_";

  const factSourceTables = new Set(model.facts.map((f) => f.sourceTable.toLowerCase()));

  // Pre-compute which fact tables have at least one valid single-column model
  // relationship so metric file generation can be restricted to connected facts.
  const factBySourceTable = new Map(model.facts.map((f) => [f.sourceTable, f]));
  const factByName = new Map(model.facts.map((f) => [f.name, f]));
  const dimByNameOuter = new Map(model.dimensions.map((d) => [d.name, d]));
  const connectedFactSourceTables = new Set<string>();
  for (const rel of model.relationships) {
    const fact = factByName.get(rel.fromDataset) ?? factBySourceTable.get(rel.fromDataset);
    const dim  = dimByNameOuter.get(rel.toDataset);
    if (!fact || !dim) continue;
    if (isFactLikeDimension(dim, factSourceTables)) continue;
    connectedFactSourceTables.add(fact.sourceTable);
  }

  // Identify degenerate dimensions (columns live on a fact table itself).
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

  // metrics/{uniqueName}.yml — one per unique measure, only for connected facts
  const seenMetrics = new Set<string>();
  for (const fact of model.facts) {
    if (!connectedFactSourceTables.has(fact.sourceTable)) continue;
    for (const measure of fact.measures) {
      const uniqueName = metricUniqueName(measure, fact, metricPrefix);
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
