/**
 * What AtScale actually accepts in a calculation expression.
 *
 * Transcribed from the AtScale documentation. Kept as inline constants rather
 * than a data file on purpose: the VS Code extension runs a single-file esbuild
 * bundle with no reliable disk layout (see CLAUDE.md), so anything read at
 * runtime has to go through `src/assets.ts`. A whitelist is small and changes
 * rarely, so inlining it avoids that machinery entirely.
 *
 * Values in BASE_AGGREGATION_METHODS are checked against the vendored SML
 * specification (resources/sml-reference/metric.md), not inferred.
 *
 * Sources (captured 2026-09-18) -- the CONTAINER docs. AtScale publishes an
 * installer-docs copy of these pages too, and for the equivalent CLIENT-side
 * page the two disagree substantially (the installer copy omits SELECTEDVALUE,
 * ALLSELECTED, AVERAGEX and five others). The container docs are the current
 * ones: refresh from them, and re-run the parity tests below after any refresh.
 *   server-side DAX: https://documentation.atscale.com/container/creating-and-sharing-cubes/creating-cubes/modeling-cube-measures/add-calculated-measures/server-side-dax
 *   MDX:             https://documentation.atscale.com/container/creating-and-sharing-cubes/creating-cubes/modeling-cube-measures/add-calculated-measures/mdx-reference
 */

export const CAPABILITIES_CAPTURED = "2026-09-18";

/**
 * Server-side DAX (public preview). The docs are explicit: "Language elements
 * that are not listed in this document are not supported."
 *
 * Note what is NOT here: SUM, MIN, MAX, AVERAGE, COUNT, DISTINCTCOUNT. AtScale
 * models those as base metrics with a `calculation_method`, not as
 * calculations -- see BASE_AGGREGATION_METHODS.
 */
// <generated:server-dax> -- npm run check:capabilities -- --write
export const SUPPORTED_DAX_FUNCTIONS: ReadonlySet<string> = new Set([
  // Aggregation
  "AVERAGEA", "AVERAGEX", "COUNTA", "COUNTAX", "COUNTBLANK", "COUNTROWS",
  "COUNTX", "DISTINCTCOUNTNOBLANK", "MAXA", "MAXX", "MINA", "MINX", "PRODUCTX",
  "SUMX",
  // Date and time
  "DATE", "DATEDIFF", "DATEVALUE", "DAY", "EDATE", "HOUR", "MINUTE", "MONTH",
  "NOW", "QUARTER", "SECOND", "TODAY", "UTCNOW", "UTCTODAY", "WEEKDAY",
  "WEEKNUM", "YEAR",
  // Filter
  "ALL", "ALLSELECTED", "CALCULATE", "CALCULATETABLE", "FILTER", "KEEPFILTERS",
  "SELECTEDVALUE",
  // Information
  "ISBLANK", "ISFILTERED",
  // Logical
  "AND", "COALESCE", "FALSE", "IF", "NOT", "OR", "SWITCH", "TRUE",
  // Math
  "ABS", "CEILING", "DIVIDE", "FLOOR", "INT", "LN", "LOG", "LOG10", "ROUND",
  "ROUNDUP",
  // Other
  "ERROR",
  // Table
  "ADDCOLUMNS", "SUMMARIZE", "TOPN",
  // Text
  "CONCATENATE", "LEFT", "MID", "RIGHT", "SUBSTITUTE",
  // Time intelligence
  "DATESMTD", "DATESQTD", "DATESYTD", "ENDOFQUARTER", "ENDOFYEAR",
  "STARTOFMONTH", "STARTOFQUARTER", "STARTOFYEAR", "TOTALMTD", "TOTALQTD",
  "TOTALWTD", "TOTALYTD",
]);
// </generated:server-dax>

// <generated:mdx> -- npm run check:capabilities -- --write
export const SUPPORTED_MDX_FUNCTIONS: ReadonlySet<string> = new Set([
  "ABS", "AGGREGATE", "ALL", "ALLMEMBER", "ALLMEMBEREXCEPT", "ANCESTOR", "AVG",
  "BOTTOMCOUNT", "CASE", "CBOOL", "CDBL", "CDEC", "CEILING", "CHILDREN", "CINT",
  "CLONG", "COUNT", "CROSSJOIN", "CSTR", "CURRENTMEMBER", "DATESMTD",
  "DATESPERIODSTODATE", "DATESQTD", "DATESWTD", "DATESYTD", "DAY", "DESCENDANTS",
  "DIVIDE", "E", "EXCEPT", "EXP", "EXTRACTMEMBER", "FIRSTCHILD", "FIRSTSIBLING",
  "FLOOR", "HEAD", "HOUR", "IIF", "INSTR", "INTERSECT", "ISEMPTY", "LAG",
  "LASTCHILD", "LASTSIBLING", "LCASE", "LEAD", "LEFT", "LEN", "LEVEL", "LOG",
  "LOG10", "LOG2", "LTRIM", "MAX", "MEMBERS", "MID", "MIN", "MINUTE", "MONTH",
  "NEXTMEMBER", "NONEMPTY", "NOW", "NULLEXCEPT", "NULLIFZERO", "PARALLELPERIOD",
  "PARENT", "PERIODSTODATE", "PI", "POW", "PREVMEMBER", "PROPERTIES", "RAND",
  "RANK", "RIGHT", "ROUND", "RTRIM", "SECOND", "SIBLINGS", "SIGN", "SQLSUM",
  "SUM", "TAIL", "TOPCOUNT", "TRIM", "TRUNCATE", "UCASE", "UNION", "XIRR",
  "YEAR", "ZEROIFNULL",
  // Trigonometric group
  "SIN", "COS", "TAN", "ASIN", "ACOS", "ATAN", "SINH", "COSH", "TANH",
]);
// </generated:mdx>

/**
 * DAX aggregations that become SML `metric` objects with a
 * `calculation_method`, not calculations. This is the authoritative mapping;
 * `classifyMeasure` in tabular-converter.ts already handles the single-call
 * form, and this table keeps the two in agreement.
 */
export const BASE_AGGREGATION_METHODS: Readonly<Record<string, string>> = {
  SUM: "sum",
  AVERAGE: "average",
  MIN: "minimum",
  MAX: "maximum",
  DISTINCTCOUNT: "count distinct",
  COUNT: "count non-null",
  COUNTA: "count non-null",
  COUNTROWS: "count non-null",
  // MEDIAN is deliberately absent: SML's `percentile` is non-additive and
  // needs a `named_quantiles` setting, so mapping it automatically would
  // silently drop configuration. It is flagged with a hint instead.
  "STDEV.P": "stddev_pop",
  "STDEV.S": "stddev_samp",
  "STDEVX.P": "stddev_pop",
  "STDEVX.S": "stddev_samp",
  "VAR.P": "var_pop",
  "VAR.S": "var_samp",
};

export const supportsDax = (name: string): boolean =>
  SUPPORTED_DAX_FUNCTIONS.has(name.toUpperCase());

export const supportsMdx = (name: string): boolean =>
  SUPPORTED_MDX_FUNCTIONS.has(name.toUpperCase());

export const baseAggregationMethod = (name: string): string | undefined =>
  BASE_AGGREGATION_METHODS[name.toUpperCase()];
