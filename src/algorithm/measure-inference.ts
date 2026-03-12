// ============================================================
// Measure inference
//
// Determines which aggregations (SUM, AVG, MIN, MAX) are
// semantically appropriate for a numeric column based on its
// name, then expands it into one SemanticMeasure per aggregation.
//
// Rules are matched against the lowercased column name in order;
// the first matching rule wins. If no rule matches, a data-type
// default is applied (integer → all four; decimal → AVG/MIN/MAX).
// ============================================================

import { AggregationType, JdbcColumnMeta, SemanticMeasure, isIntegerType, toTitleCase } from "./types.js";

// ----------------------------------------------------------
// Aggregation rule table
// ----------------------------------------------------------

interface AggRule {
  /** Pattern tested against the lowercased column name. */
  pattern: RegExp;
  aggregations: AggregationType[];
  /** Optional human-readable rationale (documentation only). */
  rationale?: string;
}

const AGG_RULES: AggRule[] = [
  // --- Financial / monetary amounts ---
  // All four aggregations are meaningful: total spend, average price, cheapest, dearest.
  {
    pattern: /cost|price|amount|revenue|sales|gross|net|fee|charge|spend|budget|expense|profit|margin|discount|tax|salary|wage|earning|payment|invoice|billing|receipt|total/,
    aggregations: ["SUM", "AVG", "MIN", "MAX"],
    rationale: "Monetary amounts support summing, averaging, and range queries.",
  },

  // --- Physical quantities ---
  // Counting or weighing things: summing makes sense.
  {
    pattern: /qty|quantity|units|volume|count|num_|number_of|pieces|items|orders|transactions|shipments|deliveries|returns/,
    aggregations: ["SUM", "AVG", "MIN", "MAX"],
    rationale: "Countable quantities can be summed and averaged.",
  },

  // --- Rates, ratios, percentages ---
  // Summing a percentage or ratio is almost always wrong; averaging is the correct default.
  {
    pattern: /rate|ratio|pct|percent|percentage|share|proportion|factor|multiplier|coefficient|score|index|utilization|efficiency|yield|margin_pct/,
    aggregations: ["AVG", "MIN", "MAX"],
    rationale: "Rates and ratios should be averaged, not summed.",
  },

  // --- Duration / elapsed time ---
  // Summing durations (total processing time) and averaging (average lead time) are both valid.
  {
    pattern: /duration|elapsed|latency|delay|lead_time|cycle_time|age|tenure|days|hours|minutes|seconds|response_time|processing_time/,
    aggregations: ["SUM", "AVG", "MIN", "MAX"],
    rationale: "Durations support total, average, and range queries.",
  },

  // --- Physical dimensions ---
  {
    pattern: /weight|mass|size|length|width|height|area|distance|miles|km|meters|volume_/,
    aggregations: ["SUM", "AVG", "MIN", "MAX"],
    rationale: "Physical measurements support all four aggregations.",
  },

  // --- Scores / rankings / sequences ---
  // Ranking values or priority numbers; summing rarely meaningful.
  {
    pattern: /rank|ranking|priority|order_num|sequence|position|level_num/,
    aggregations: ["MIN", "MAX", "AVG"],
    rationale: "Ordinal values are best compared, not summed.",
  },

  // --- Temperature / environmental ---
  // Summing temperatures is meaningless; avg/min/max are the meaningful aggregations.
  {
    pattern: /temperature|temp_[cf]$|celsius|fahrenheit|humidity|pressure_/,
    aggregations: ["AVG", "MIN", "MAX"],
    rationale: "Physical sensor readings should be averaged or compared, not summed.",
  },

  // --- Customer satisfaction / NPS / CSAT ---
  {
    pattern: /nps|csat|net_promoter|satisfaction_score|survey_score|feedback_score/,
    aggregations: ["AVG", "MIN", "MAX"],
    rationale: "Survey scores should be averaged, not summed.",
  },

  // --- Inventory / stock levels ---
  {
    pattern: /inventory|on_hand|stock_qty|stock_level|reorder_point|safety_stock|bin_qty/,
    aggregations: ["SUM", "AVG", "MIN", "MAX"],
    rationale: "Inventory quantities can be totalled across locations and averaged over time.",
  },

  // --- Defect / error / incident counts ---
  {
    pattern: /defect_count|error_count|bug_count|incident_count|failure_count|fault_count|reject_count/,
    aggregations: ["SUM", "AVG", "MIN", "MAX"],
    rationale: "Quality counts can be summed to totals and averaged per period.",
  },

  // --- Explicit currency suffix (column already has a currency code appended) ---
  {
    pattern: /_usd$|_gbp$|_eur$|_cad$|_aud$|_jpy$|_cny$|_inr$|_brl$/,
    aggregations: ["SUM", "AVG", "MIN", "MAX"],
    rationale: "Columns with a currency suffix are monetary amounts that support all aggregations.",
  },
];

/** Prefix labels used when constructing measure names. */
const AGG_PREFIX: Record<AggregationType, string> = {
  SUM:   "Total",
  AVG:   "Average",
  MIN:   "Minimum",
  MAX:   "Maximum",
  COUNT: "Count",
};

// Data-type fallbacks applied when no name rule matches.
// Integer columns get all four aggregations because integers commonly represent
// counts or quantities where SUM is meaningful (e.g., a mystery "score" column
// might be summed).  Decimal columns default to AVG/MIN/MAX because unrecognised
// decimal columns are more likely to be rates, prices, or ratios where SUM is
// rarely the right answer.
const ALL_AGGS: AggregationType[]     = ["SUM", "AVG", "MIN", "MAX"];
const DECIMAL_AGGS: AggregationType[] = ["AVG", "MIN", "MAX"];

// ----------------------------------------------------------
// Public API
// ----------------------------------------------------------

/**
 * Determine the appropriate aggregations for a numeric column
 * based on its name, falling back to data-type defaults.
 */
export function inferAggregations(columnName: string, jdbcType: string): AggregationType[] {
  const lower = columnName.toLowerCase();
  for (const rule of AGG_RULES) {
    if (rule.pattern.test(lower)) return rule.aggregations;
  }
  return isIntegerType(jdbcType) ? ALL_AGGS : DECIMAL_AGGS;
}

/**
 * Expand a single numeric column into one SemanticMeasure per
 * inferred aggregation (e.g. "Total Cost", "Average Cost", …).
 */
export function expandMeasures(col: JdbcColumnMeta): SemanticMeasure[] {
  const aggregations = inferAggregations(col.columnName, col.dataType);
  const baseName = toTitleCase(col.columnName);
  const dataType: SemanticMeasure["dataType"] = isIntegerType(col.dataType) ? "integer" : "decimal";

  return aggregations.map((agg) => ({
    name:         `${AGG_PREFIX[agg]} ${baseName}`,
    sourceColumn: col.columnName,
    dataType,
    aggregation:  agg,
  }));
}
