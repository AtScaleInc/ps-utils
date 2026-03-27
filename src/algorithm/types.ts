// ============================================================
// Shared types, constants, and utility functions
// ============================================================

// Forward declaration — implementation lives in analysis-suggestions.ts
// to avoid a circular import.  The type is referenced by SemanticModel.
import type { AnalysisSuggestion } from "./analysis-suggestions.js";
export type { AnalysisSuggestion };

// ----------------------------------------------------------
// Database schema metadata interfaces
// ----------------------------------------------------------

export interface ColumnMeta {
  tableName: string;
  columnName: string;
  dataType: string;        // e.g. "VARCHAR", "INTEGER", "DECIMAL", "DATE"
  columnSize: number;
  nullable: boolean;
  isPrimaryKey: boolean;
  ordinalPosition: number;
  /** Optional column remark / comment (maps to INFORMATION_SCHEMA REMARKS). */
  remarks?: string;
}

export interface ForeignKeyMeta {
  fkTableName: string;
  fkColumnName: string;
  pkTableName: string;
  pkColumnName: string;
  keySeq: number;
  constraintName: string;
}

export interface IndexMeta {
  tableName: string;
  indexName: string;
  columnName: string;
  nonUnique: boolean;
  ordinalPosition: number;
  indexType: "CLUSTERED" | "HASHED" | "OTHER";
}

export interface ViewMeta {
  viewName: string;
  definition: string;
  columns: ColumnMeta[];
}

export interface TableMeta {
  tableName: string;
  tableType: "TABLE" | "VIEW" | "SYSTEM TABLE";
  remarks?: string;
}

/** Mirror of java.sql.DatabaseMetaData — implemented by the caller. */
export interface DatabaseMetaData {
  getTables(schemaPattern?: string): Promise<TableMeta[]>;
  getColumns(tableName: string): Promise<ColumnMeta[]>;
  getForeignKeys(tableName: string): Promise<ForeignKeyMeta[]>;
  getIndexInfo(tableName: string): Promise<IndexMeta[]>;
  getViews(schemaPattern?: string): Promise<ViewMeta[]>;
  /**
   * Optional: return up to `limit` sample rows from the table.
   * Used by the inference engine to detect column patterns and refine type inference.
   * Implementations that cannot sample data should omit this method or return [].
   */
  sampleRows?(tableName: string, limit?: number): Promise<Record<string, unknown>[]>;
}

// ----------------------------------------------------------
// Semantic model types
// ----------------------------------------------------------

export type SemanticDataType =
  | "string"
  | "integer"
  | "decimal"
  | "date"
  | "timestamp"
  | "boolean"
  | "unknown";

export type AggregationType = "SUM" | "AVG" | "COUNT" | "MIN" | "MAX";

/** A label (name or description) sourced from a companion column. */
export interface SemanticLabel {
  name: string;
  sourceColumn: string;
  kind: "name" | "description";
}

export interface SemanticAttribute {
  name: string;
  sourceColumn: string;
  dataType: SemanticDataType;
  nullable: boolean;
  /** Companion columns that provide a human-readable label for this attribute. */
  labels?: SemanticLabel[];
  /** Non-empty column remarks, emitted as SML description. */
  description?: string;
  /** UI folder for grouping this attribute in BI tools (e.g. "Date Attributes"). */
  folder?: string;
}

export interface SemanticMeasure {
  /** Human-readable name, e.g. "Total Cost" or "Average Price" */
  name: string;
  sourceColumn: string;
  dataType: "integer" | "decimal";
  aggregation: AggregationType;
}

export interface SemanticHierarchy {
  name: string;
  /** Ordered from broadest → most granular level */
  levels: Array<{ name: string; sourceColumn: string }>;
  sourceIndex?: string;
}

export interface SemanticDimension {
  kind: "dimension";
  name: string;
  sourceTable: string;
  /** All primary-key column names (may be composite). Empty when no PK was detected. */
  primaryKeys: string[];
  attributes: SemanticAttribute[];
  hierarchies: SemanticHierarchy[];
  /** Non-empty table remarks, emitted as SML description. */
  description?: string;
  /**
   * FK columns on this dimension table that point to other dimension tables.
   * These are emitted as snowflake-style relationships in the dimension SML file.
   */
  snowflakeRelationships?: SnowflakeRelationship[];
}

export interface SemanticFact {
  kind: "fact";
  name: string;
  sourceTable: string;
  primaryKey?: string;
  measures: SemanticMeasure[];
  degenerateDimensions: SemanticAttribute[];
}

export interface SemanticRelationship {
  fromDataset: string;
  fromColumn: string;
  /** All FK columns when this is a composite foreign key (multi-column join). */
  fromColumns?: string[];
  toDataset: string;
  toColumn: string;
  constraintName: string;
  cardinality: "MANY_TO_ONE" | "ONE_TO_ONE";
}

/**
 * A dimension-to-dimension join within a snowflake schema dimension.
 * Emitted as a `relationships:` block inside the dimension SML file.
 */
export interface SnowflakeRelationship {
  /** FK columns on the owning dimension table (composite-key safe). */
  fromColumns: string[];
  /** The lookup table being joined (a sibling dataset within the same dimension). */
  toTable: string;
  /** PK columns on the lookup table (parallel to fromColumns). */
  toColumns: string[];
}

export interface SemanticView {
  name: string;
  sourceSql: string;
  attributes: SemanticAttribute[];
}

export interface SemanticModel {
  name: string;
  generatedAt: string;
  facts: SemanticFact[];
  dimensions: SemanticDimension[];
  relationships: SemanticRelationship[];
  views: SemanticView[];
  /** Ranked list of measure × hierarchy pairs/tuples worth analysing. Empty when not requested. */
  suggestions: AnalysisSuggestion[];
  /**
   * AtScale SML files ready to write to disk.
   * Populated only when `sml` is set in ProposeOptions.
   * Map key = relative file path, value = YAML content.
   */
  sml?: Map<string, string>;
  warnings: string[];
}

// ----------------------------------------------------------
// Shared type sets
// ----------------------------------------------------------

export const NUMERIC_TYPES = new Set([
  // Standard SQL
  "INTEGER", "INT", "BIGINT", "SMALLINT", "TINYINT",
  "DECIMAL", "NUMERIC", "FLOAT", "DOUBLE", "REAL", "NUMBER",
  // SQL Server
  "MONEY", "SMALLMONEY", "FLOAT", "DOUBLE PRECISION",
  // Oracle
  "NUMBER", "BINARY_FLOAT", "BINARY_DOUBLE",
  // MySQL / MariaDB
  "MEDIUMINT", "INT2", "INT4", "INT8",
]);

export const DATE_TYPES = new Set([
  // Standard
  "DATE", "TIME", "TIMESTAMP", "DATETIME",
  "TIMESTAMP WITH TIME ZONE", "TIMESTAMP WITHOUT TIME ZONE",
  // SQL Server
  "SMALLDATETIME", "DATETIMEOFFSET", "DATETIME2", "TIME",
  // Oracle
  "INTERVAL YEAR TO MONTH", "INTERVAL DAY TO SECOND",
  // Snowflake
  "TIMESTAMP_NTZ", "TIMESTAMP_LTZ", "TIMESTAMP_TZ",
]);

export const STRING_TYPES = new Set([
  // Standard
  "VARCHAR", "CHAR", "NVARCHAR", "NCHAR", "TEXT", "CLOB", "STRING",
  // SQL Server
  "NTEXT", "SYSNAME", "XML", "UNIQUEIDENTIFIER",
  "VARCHAR(MAX)", "NVARCHAR(MAX)",
  // MySQL
  "TINYTEXT", "MEDIUMTEXT", "LONGTEXT", "ENUM", "SET",
  // General
  "CHARACTER VARYING", "NATIONAL CHARACTER VARYING",
  "NATIONAL CHARACTER", "CHARACTER",
]);

export const BOOLEAN_TYPES = new Set(["BOOLEAN", "BOOL", "BIT"]);

// Binary types — not surfaced in the semantic model as attributes or measures
export const BINARY_TYPES = new Set([
  "BINARY", "VARBINARY", "IMAGE", "BLOB", "MEDIUMBLOB", "LONGBLOB",
  "BYTEA", "RAW", "LONG RAW", "VARBINARY(MAX)",
]);

// ----------------------------------------------------------
// Shared utility functions
// ----------------------------------------------------------

export function toSemanticType(jdbcType: string): SemanticDataType {
  const upper = jdbcType.toUpperCase();
  if (BINARY_TYPES.has(upper)) return "unknown"; // excluded from model
  if (NUMERIC_TYPES.has(upper)) {
    return upper === "MONEY" || upper === "SMALLMONEY" || upper === "NUMBER" ||
           upper.includes("DECIMAL") || upper.includes("NUMERIC") ||
           upper.includes("FLOAT") || upper.includes("DOUBLE") ||
           upper.includes("REAL") || upper.includes("BINARY_FLOAT")
      ? "decimal"
      : "integer";
  }
  if (DATE_TYPES.has(upper)) return upper.includes("TIME") ? "timestamp" : "date";
  if (STRING_TYPES.has(upper)) return "string";
  if (BOOLEAN_TYPES.has(upper)) return "boolean";
  return "unknown";
}

export function isBinaryType(jdbcType: string): boolean {
  return BINARY_TYPES.has(jdbcType.toUpperCase());
}

export function isNumericType(jdbcType: string): boolean {
  return NUMERIC_TYPES.has(jdbcType.toUpperCase());
}

export function isIntegerType(jdbcType: string): boolean {
  const upper = jdbcType.toUpperCase();
  return ["INTEGER", "INT", "BIGINT", "SMALLINT", "TINYINT"].includes(upper);
}

export function toTitleCase(s: string): string {
  return s
    .replace(/_/g, " ")
    .replace(/([A-Z])/g, " $1")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/\b\w/g, (c) => c.toUpperCase());
}
