/**
 * What AtScale accepts in *client-side* DAX — the expressions Power BI sends
 * over XMLA for report-scoped measures.
 *
 * This is a different surface from the server-side DAX whitelist in
 * generate-sml-from-tabular/dax/capabilities.ts, and the differences are not
 * intuitive. Some examples:
 *
 *   - SUM/MIN/MAX/AVERAGE/COUNT/DISTINCTCOUNT ARE supported client-side, but
 *     are absent server-side (there they are base metrics with a
 *     calculation_method).
 *   - IFERROR, RANKX, HASONEVALUE and ISINSCOPE are supported client-side but
 *     not server-side.
 *   - DATEADD is listed client-side, but the Known Limitations page restricts
 *     it to the DAY interval -- the mirror image of the server-side MDX path,
 *     where only a whole-year shift maps cleanly to ParallelPeriod.
 *   - VALUES, CONCATENATEX, PERCENTILEX.*, COUNTROWS and EARLIER are on
 *     neither list.
 *
 * So a measure can be valid in one surface and broken in the other. Any report
 * has to say which surface it is judging.
 *
 * Source (captured 2026-09-18) -- the CONTAINER docs, which are current. The
 * installer-docs version of this page is older and materially narrower: it
 * omits AVERAGEX, ALLSELECTED, SELECTEDVALUE, HASONEVALUE, ISINSCOPE, DATEADD,
 * DISTINCT and EXCEPT. Using it overstates the gap badly, so if this list is
 * ever refreshed, refresh it from the container docs.
 *   https://documentation.atscale.com/container/connect-integrate/connect-with-bi-tools/microsoft-power-bi/using-dax-tabular/supported-dax-language-elements
 *
 * "Language elements that are not listed in this document are not supported."
 */

export const CLIENT_DAX_CAPTURED = "2026-09-18";

export const SUPPORTED_CLIENT_DAX: ReadonlySet<string> = new Set([
  // Aggregation
  "AVERAGE", "AVERAGEX", "COUNT", "COUNTX", "DISTINCTCOUNT", "MAX", "MAXX",
  "MIN", "MINX", "PRODUCTX", "RANKX", "SUM", "SUMX",
  // Time intelligence (DAY interval only -- see CLIENT_DAX_CAVEATS)
  "DATEADD",
  // Date and time
  "DATE", "DAY", "HOUR", "MINUTE", "MONTH", "QUARTER", "SECOND", "TIME",
  "TODAY", "UTCNOW", "YEAR",
  // Filter
  "ALL", "ALLEXCEPT", "ALLSELECTED", "BLANK", "CALCULATE", "CALCULATETABLE",
  "FILTER", "ISBLANK", "KEEPFILTERS", "REMOVEFILTERS", "SELECTEDVALUE",
  // Information
  "HASONEVALUE", "ISINSCOPE",
  // Logical
  "AND", "COALESCE", "FALSE", "IF", "IFERROR", "ISEMPTY", "ISSUBTOTAL", "NOT",
  "OR", "SWITCH", "TRUE",
  // Math and trig
  "ABS", "ACOS", "ACOSH", "ACOT", "ACOTH", "ASIN", "ASINH", "ATAN", "ATANH",
  "COS", "COSH", "COT", "COTH", "SIN", "SINH", "TAN", "TANH",
  "CONVERT", "CURRENCY", "DEGREES", "RADIANS", "INT", "LOG", "LOG10", "LN",
  "MOD", "ODD", "PI", "SQRT", "DIVIDE", "POWER", "EXP", "QUOTIENT", "RAND",
  "RANDBETWEEN", "ROUND", "CEILING", "FLOOR", "ISO.CEILING", "SIGN", "SQRTPI",
  "TRUNC",
  // Table manipulation
  "ADDCOLUMNS", "DISTINCT", "EXCEPT", "SUMMARIZE", "TOPN",
  // Text
  "CONCATENATE", "EXACT", "FORMAT", "LEFT", "LEN", "LOWER", "MID", "RIGHT",
  "SEARCH", "SUBSTITUTE", "TRIM", "UPPER", "VALUE",
]);

export const SUPPORTED_CLIENT_STATEMENTS: ReadonlySet<string> = new Set([
  "DEFINE", "EVALUATE", "MEASURE", "ORDER BY", "VAR",
]);

export const supportsClientDax = (name: string): boolean =>
  SUPPORTED_CLIENT_DAX.has(name.toUpperCase());

/**
 * Documented limitations that a whitelist check alone will not catch, from the
 * DAX Tabular "Known Limitations" page. Keyed by the function that triggers
 * them so the report can attach the caveat to the measure that will hit it.
 */
export const CLIENT_DAX_CAVEATS: Readonly<Record<string, string>> = {
  DATEADD:
    "on the DAX Tabular dialect DATEADD only works with the DAY interval; " +
    "MONTH, QUARTER and YEAR intervals return an error",
  IF: "comparing a dimension to a measure inside IF is not supported",
  SWITCH: "comparing a dimension to a measure inside SWITCH is not supported",
};

/** Suggested remediation for the client-side functions AtScale does not accept. */
export const CLIENT_REMEDIATION: Readonly<Record<string, string>> = {
  VALUES:
    "returns a table of distinct values; push the aggregation into the AtScale " +
    "model as a metric, or restructure against a level the model exposes",
  CONCATENATEX:
    "iterator-based string aggregation is unavailable; build the label in the " +
    "model, or use CONCATENATE for a fixed number of parts",
  PERCENTILEX_INC:
    "model as an AtScale metric with calculation_method: percentile and an " +
    "explicit named_quantiles setting",
  "PERCENTILEX.INC":
    "model as an AtScale metric with calculation_method: percentile and an " +
    "explicit named_quantiles setting",
  "PERCENTILEX.EXC":
    "model as an AtScale metric with calculation_method: percentile and an " +
    "explicit named_quantiles setting",
  COUNTROWS:
    "COUNT/COUNTX are supported; count a specific column, or model the row " +
    "count as a metric",
  EARLIER:
    "row-context nesting has no client-side equivalent; restructure the " +
    "calculation or push it into the model",
  MEDIAN:
    "model as an AtScale metric with calculation_method: percentile",
  DISTINCTCOUNTNOBLANK:
    "DISTINCTCOUNT is supported; confirm blank handling matches",
};

export const clientRemediation = (fn: string): string =>
  CLIENT_REMEDIATION[fn.toUpperCase()] ?? "";

export const clientCaveat = (fn: string): string =>
  CLIENT_DAX_CAVEATS[fn.toUpperCase()] ?? "";
