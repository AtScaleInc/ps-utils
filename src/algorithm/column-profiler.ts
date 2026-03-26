// ============================================================
// Column Profiler
//
// Samples actual row data (via DatabaseMetaData.sampleRows)
// and produces per-column profiles that the inference engine uses
// to override schema-declared types, suppress identifier columns
// from measures, and add pattern-based PII signals.
//
// Pattern detection priority (highest → lowest):
//   timestamp > date_iso > date_us > uuid > email > url >
//   boolean_flag > postal_code > currency_code > country_code >
//   phone > json > decimal > integer > none
// ============================================================

import { ColumnMeta, DatabaseMetaData, SemanticDataType } from "./types.js";

// ----------------------------------------------------------
// Public types
// ----------------------------------------------------------

export type ColumnPattern =
  | "none"
  | "integer"
  | "decimal"
  | "boolean_flag"
  | "date_iso"
  | "date_us"
  | "timestamp"
  | "email"
  | "phone"
  | "url"
  | "uuid"
  | "postal_code"
  | "country_code"
  | "currency_code"
  | "json";

export type CardinalityClass =
  | "identifier"  // nearly-unique values (distinctRatio ≥ 0.95)
  | "high"        // many distinct values (0.5 ≤ distinctRatio < 0.95)
  | "medium"      // moderate variety (0.05 ≤ distinctRatio < 0.5)
  | "low";        // mostly repeated values (distinctRatio < 0.05)

export interface ColumnProfile {
  columnName: string;
  tableName: string;
  sampleSize: number;
  nullCount: number;
  nullRatio: number;
  distinctCount: number;
  distinctRatio: number;
  cardinalityClass: CardinalityClass;
  detectedPattern: ColumnPattern;
  /** Override type to use instead of the schema-declared JDBC type. */
  inferredType?: SemanticDataType;
  /** PII signal detected from data patterns (email, phone, uuid, postal_code). */
  patternPiiSignal?: "email" | "phone" | "uuid" | "postal_code";
}

/** Table name → column name → ColumnProfile */
export type ProfileMap = Map<string, Map<string, ColumnProfile>>;

// ----------------------------------------------------------
// Pattern recognition thresholds
//
// These govern how many values in a sample need to match before a pattern
// is claimed.  A high threshold (0.9) tolerates ~10% dirty/null rows.
// Postal and phone codes use a slightly lower threshold (0.8) because
// international formatting is highly varied and false negatives are costly.
// ----------------------------------------------------------

/** Fraction of non-null values that must match for a strong pattern claim. */
const PATTERN_MATCH_THRESHOLD    = 0.9;
/** Fraction for patterns with higher natural format variance (postal, phone). */
const LOOSE_PATTERN_THRESHOLD    = 0.8;

// Cardinality classification cut-points:
//   identifier → nearly every value is unique (surrogate key, UUID, etc.)
//   high        → many distinct values (free-text, natural key)
//   medium      → moderate variety (status codes, regions)
//   low         → mostly repeated values (flags, boolean-like)
const IDENTIFIER_CARDINALITY_RATIO = 0.95;
const HIGH_CARDINALITY_RATIO       = 0.50;
const MEDIUM_CARDINALITY_RATIO     = 0.05;

// ----------------------------------------------------------
// Pattern regexes
// Grouped by domain; tested in priority order inside detectPattern().
// ----------------------------------------------------------

// --- Date / time ---
const RE_TIMESTAMP = /^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}:\d{2}/;  // ISO 8601 datetime
const RE_DATE_ISO  = /^\d{4}-\d{2}-\d{2}$/;                        // ISO 8601 date only
const RE_DATE_US   = /^\d{1,2}\/\d{1,2}\/\d{2,4}$/;               // M/D/YYYY or M/D/YY

// --- Identifiers / structured strings ---
const RE_UUID      = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// --- Contact / PII patterns ---
const RE_EMAIL     = /^[a-zA-Z0-9._%+\-]+@[a-zA-Z0-9.\-]+\.[a-zA-Z]{2,}$/;
const RE_URL       = /^https?:\/\//i;
const RE_PHONE     = /^[+]?[(]?\d{1,4}[)]?[-\s.]?\d{2,4}[-\s.]?\d{2,4}[-\s.]?\d{0,9}$/;

// --- Boolean-like flags (often stored as TINYINT or VARCHAR) ---
const RE_BOOL_FLAG = /^(0|1|true|false|yes|no|y|n|t|f)$/i;

// --- Geographic codes ---
const RE_POSTAL_US = /^\d{5}(-\d{4})?$/;                           // US ZIP / ZIP+4
const RE_POSTAL_UK = /^[A-Z]{1,2}\d[A-Z\d]? ?\d[A-Z]{2}$/i;      // UK postcode

// --- ISO reference codes ---
const RE_COUNTRY   = /^[A-Z]{2,3}$/;  // ISO 3166-1 alpha-2/3 country codes
const RE_CURRENCY  = /^(USD|EUR|GBP|JPY|CAD|AUD|CHF|CNY|INR|BRL|MXN|SEK|NOK|DKK|SGD|HKD|NZD)$/i;

// --- Structured / numeric ---
const RE_JSON      = /^[{[]/;          // JSON object or array
const RE_DECIMAL   = /^-?\d+\.\d+$/;
const RE_INTEGER   = /^-?\d+$/;

// ----------------------------------------------------------
// Core detection functions
// ----------------------------------------------------------

/**
 * Detect the most likely data pattern from an array of sampled values.
 * Non-null string samples are tested in priority order.
 */
export function detectPattern(values: unknown[]): ColumnPattern {
  const nonNull = values.filter((v) => v !== null && v !== undefined && v !== "");
  if (nonNull.length === 0) return "none";

  const strings = nonNull.map((v) => String(v));

  // Compute the fraction of sample values that match a given regex.
  // Trimming handles leading/trailing whitespace from VARCHAR storage.
  const matchRatio = (re: RegExp) =>
    strings.filter((s) => re.test(s.trim())).length / strings.length;

  // Tests run in descending specificity: more specific patterns are tried first
  // so that e.g. a timestamp isn't mistaken for a plain date.
  if (matchRatio(RE_TIMESTAMP)  >= PATTERN_MATCH_THRESHOLD) return "timestamp";
  if (matchRatio(RE_DATE_ISO)   >= PATTERN_MATCH_THRESHOLD) return "date_iso";
  if (matchRatio(RE_DATE_US)    >= PATTERN_MATCH_THRESHOLD) return "date_us";
  if (matchRatio(RE_UUID)       >= PATTERN_MATCH_THRESHOLD) return "uuid";
  if (matchRatio(RE_EMAIL)      >= PATTERN_MATCH_THRESHOLD) return "email";
  if (matchRatio(RE_URL)        >= PATTERN_MATCH_THRESHOLD) return "url";
  if (matchRatio(RE_BOOL_FLAG)  >= PATTERN_MATCH_THRESHOLD) return "boolean_flag";
  // Postal and phone formats vary significantly across locales — use the looser threshold.
  if (matchRatio(RE_POSTAL_US)  >= LOOSE_PATTERN_THRESHOLD ||
      matchRatio(RE_POSTAL_UK)  >= LOOSE_PATTERN_THRESHOLD) return "postal_code";
  if (matchRatio(RE_CURRENCY)   >= PATTERN_MATCH_THRESHOLD) return "currency_code";
  if (matchRatio(RE_COUNTRY)    >= PATTERN_MATCH_THRESHOLD) return "country_code";
  if (matchRatio(RE_PHONE)      >= LOOSE_PATTERN_THRESHOLD) return "phone";
  if (matchRatio(RE_JSON)       >= LOOSE_PATTERN_THRESHOLD) return "json";
  if (matchRatio(RE_DECIMAL)    >= PATTERN_MATCH_THRESHOLD) return "decimal";
  if (matchRatio(RE_INTEGER)    >= PATTERN_MATCH_THRESHOLD) return "integer";

  return "none";
}

/** Classify a column's cardinality based on distinct-to-sample ratio. */
export function classifyCardinality(
  distinctCount: number,
  sampleSize: number,
): CardinalityClass {
  if (sampleSize === 0) return "low";
  const ratio = distinctCount / sampleSize;
  if (ratio >= IDENTIFIER_CARDINALITY_RATIO) return "identifier";
  if (ratio >= HIGH_CARDINALITY_RATIO)       return "high";
  if (ratio >= MEDIUM_CARDINALITY_RATIO)     return "medium";
  return "low";
}

/**
 * Infer a SemanticDataType override from a detected pattern.
 *
 * Only overrides the schema-declared JDBC type when the pattern-detected type
 * is more precise or conflicts with the schema declaration.  For example, a
 * VARCHAR column whose values are all ISO dates should be treated as "date",
 * and a TINYINT column containing only 0/1 values should be treated as "boolean".
 *
 * Returns undefined when the detected pattern does not justify an override
 * (e.g., a column already declared DATE still reads as "date_iso").
 */
export function inferTypeFromPattern(
  pattern: ColumnPattern,
  jdbcType: string,
): SemanticDataType | undefined {
  const upperJdbcType = jdbcType.toUpperCase();

  switch (pattern) {
    case "timestamp":
      return "timestamp";
    case "date_iso":
    case "date_us":
      return "date";
    case "boolean_flag":
      // Only override when schema declared it as a number (common BIT/INTEGER pattern).
      if (["INTEGER", "INT", "TINYINT", "SMALLINT", "NUMBER", "BIT"].includes(upperJdbcType)) {
        return "boolean";
      }
      return undefined;
    case "decimal":
      // Numeric values stored as strings — upgrade to decimal for correct aggregation.
      if (["VARCHAR", "CHAR", "NVARCHAR", "STRING", "TEXT"].includes(upperJdbcType)) {
        return "decimal";
      }
      return undefined;
    case "integer":
      // Integer values stored as strings — upgrade to integer for correct aggregation.
      if (["VARCHAR", "CHAR", "NVARCHAR", "STRING", "TEXT"].includes(upperJdbcType)) {
        return "integer";
      }
      return undefined;
    default:
      return undefined;
  }
}

/** Profile a single column from its sampled values. */
export function profileColumn(
  columnName: string,
  tableName: string,
  values: unknown[],
  jdbcType = "VARCHAR",
): ColumnProfile {
  const sampleSize = values.length;
  const nullCount = values.filter((v) => v === null || v === undefined || v === "").length;
  const nonNull = values.filter((v) => v !== null && v !== undefined && v !== "");
  const distinctCount = new Set(nonNull.map((v) => String(v))).size;
  const nullRatio = sampleSize > 0 ? nullCount / sampleSize : 0;
  const distinctRatio = sampleSize > 0 ? distinctCount / sampleSize : 0;
  const cardinalityClass = classifyCardinality(distinctCount, sampleSize - nullCount);
  const detectedPattern = detectPattern(values);
  const inferredType = inferTypeFromPattern(detectedPattern, jdbcType);

  // PII signal from data patterns
  let patternPiiSignal: ColumnProfile["patternPiiSignal"];
  if (detectedPattern === "email")       patternPiiSignal = "email";
  else if (detectedPattern === "phone")  patternPiiSignal = "phone";
  else if (detectedPattern === "uuid")   patternPiiSignal = "uuid";
  else if (detectedPattern === "postal_code") patternPiiSignal = "postal_code";

  return {
    columnName,
    tableName,
    sampleSize,
    nullCount,
    nullRatio,
    distinctCount,
    distinctRatio,
    cardinalityClass,
    detectedPattern,
    inferredType,
    patternPiiSignal,
  };
}

// ----------------------------------------------------------
// Table-level profiling
// ----------------------------------------------------------

/**
 * Profile all columns across all tables by sampling row data.
 *
 * @param db             JDBC-style metadata source (must implement sampleRows).
 * @param columnsByTable Pre-fetched column metadata (avoids extra round-trips).
 * @param sampleSize     Maximum rows to sample per table (default 250).
 */
export async function profileTables(
  db: DatabaseMetaData,
  columnsByTable: Map<string, ColumnMeta[]>,
  sampleSize = 250,
): Promise<ProfileMap> {
  const profileMap: ProfileMap = new Map();

  if (!db.sampleRows) return profileMap;

  await Promise.all(
    Array.from(columnsByTable.entries()).map(async ([tableName, cols]) => {
      let rows: Record<string, unknown>[] = [];
      try {
        rows = await db.sampleRows!(tableName, sampleSize);
      } catch {
        // Sampling is best-effort; failures are silently ignored.
        return;
      }

      if (rows.length === 0) return;

      const tableProfiles = new Map<string, ColumnProfile>();

      for (const col of cols) {
        const values = rows.map((row) => row[col.columnName] ?? row[col.columnName.toLowerCase()] ?? null);
        const profile = profileColumn(col.columnName, tableName, values, col.dataType);
        tableProfiles.set(col.columnName, profile);
      }

      profileMap.set(tableName, tableProfiles);
    }),
  );

  return profileMap;
}

/**
 * Apply column profile overrides to a list of ColumnMeta.
 * Returns a new array where data types have been refined based on profiled patterns.
 */
export function applyProfileTypeOverrides(
  cols: ColumnMeta[],
  tableProfiles: Map<string, ColumnProfile> | undefined,
): ColumnMeta[] {
  if (!tableProfiles) return cols;

  return cols.map((col) => {
    const profile = tableProfiles.get(col.columnName);
    if (!profile?.inferredType) return col;

    // Map SemanticDataType back to a JDBC-compatible type string
    const jdbcOverride = semanticTypeToJdbc(profile.inferredType);
    if (!jdbcOverride) return col;

    return { ...col, dataType: jdbcOverride };
  });
}

function semanticTypeToJdbc(type: SemanticDataType): string | undefined {
  switch (type) {
    case "boolean":   return "BOOLEAN";
    case "date":      return "DATE";
    case "timestamp": return "TIMESTAMP";
    case "integer":   return "INTEGER";
    case "decimal":   return "DECIMAL";
    default:          return undefined;
  }
}
