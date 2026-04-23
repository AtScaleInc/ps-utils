/**
 * Measure column profiler.
 *
 * For each measure in a fact table, captures:
 *   - Null fraction
 *   - Numeric distribution (min, max, mean, stddev, P5–P99)
 *   - Distribution shape (for synthetic generation strategy)
 *   - Additivity classification (additive / semi-additive / non-additive)
 *
 * Queries run on a sampled slice of the fact table (TABLESAMPLE or LIMIT).
 * Additivity detection uses a light heuristic: measures named with "balance",
 * "stock", "headcount", "inventory", or "open" patterns are flagged as
 * semi-additive.  True additivity verification (comparing leaf SUM vs parent
 * SUM across a hierarchy) can be added as a future enhancement.
 */

import type {
  DatabaseQueryRunner,
  FactNode,
  MeasureFingerprint,
  MeasureNode,
  NumericDistribution,
  PairwiseMeasureCorrelation,
  SamplingConfig,
} from "../types.js";
import { qualifyTable, num, queryPercentiles } from "../sql-helpers.js";
import { buildSampleClause }                   from "../sampling.js";
import { classifyShape }                       from "../distribution.js";
import { countRows }                           from "../sql-helpers.js";
import type { IdMapper }                       from "../id-mapper.js";

// ─── Public API ───────────────────────────────────────────────────────────────

export async function profileMeasures(
  runner:   DatabaseQueryRunner,
  fact:     FactNode,
  config:   SamplingConfig,
  idMapper: IdMapper,
): Promise<{ measures: MeasureFingerprint[]; correlations?: PairwiseMeasureCorrelation[] }> {
  const rowCount = await countRows(runner, fact.sourceSchema, fact.sourceTable);
  const sample   = buildSampleClause(
    fact.sourceSchema, fact.sourceTable, rowCount, config.targetColumnRows, config,
  );

  const measures: MeasureFingerprint[] = [];

  for (const measure of fact.measures) {
    try {
      const fp = await profileOneMeasure(runner, measure, sample.tableRef, fact, idMapper);
      measures.push(fp);
    } catch {
      // Non-fatal: a complex sql_expression may fail; skip and continue
      const id = idMapper.measureIdFor(fact.uniqueName, measure.uniqueName);
      measures.push(placeholderMeasure(id, measure));
    }
  }

  // ── Pairwise measure correlations ────────────────────────────────────────
  // Cap at 10 measures to avoid O(n²) query explosion on wide fact tables.
  const correlations = await profileMeasureCorrelations(
    runner, fact, sample.tableRef, measures, idMapper,
  );

  return { measures, ...(correlations.length > 0 ? { correlations } : {}) };
}

// ─── Per-measure profiling ────────────────────────────────────────────────────

async function profileOneMeasure(
  runner:    DatabaseQueryRunner,
  measure:   MeasureNode,
  tableRef:  string,
  fact:      FactNode,
  idMapper:  IdMapper,
): Promise<MeasureFingerprint> {
  const expr = measure.sourceColumn; // may be a SQL expression

  // Null fraction
  const nullRows = await runner.query(`
    SELECT
      SUM(CASE WHEN (${expr}) IS NULL THEN 1 ELSE 0 END) * 1.0
        / NULLIF(COUNT(*), 0) AS null_frac
    FROM ${tableRef}
  `);
  const nullFraction = num(nullRows[0], "null_frac");

  // Scalar stats + distribution
  const statRows = await runner.query(`
    SELECT
      MIN(${expr})    AS v_min,
      MAX(${expr})    AS v_max,
      AVG(${expr})    AS v_mean,
      STDDEV(${expr}) AS v_stddev
    FROM ${tableRef}
    WHERE (${expr}) IS NOT NULL
  `);
  const sr     = statRows[0] ?? {};
  const mean   = num(sr, "v_mean");
  const stddev = num(sr, "v_stddev");

  const pcts = await queryPercentiles(
    runner,
    `(${expr})`,
    tableRef,
    `(${expr}) IS NOT NULL`,
  );

  const distribution: NumericDistribution = {
    shape:  classifyShape(mean, stddev, pcts.p50, pcts.p95),
    min:    num(sr, "v_min"),
    max:    num(sr, "v_max"),
    mean,
    stddev,
    percentiles: pcts,
  };

  return {
    id:           idMapper.measureIdFor(fact.uniqueName, measure.uniqueName),
    aggregation:  measure.aggregations[0] ?? "SUM",
    dataType:     measure.dataType,
    additivity:   classifyAdditivity(measure),
    nullFraction,
    distribution,
  };
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Heuristic additivity classification based on the measure name.
 *
 * "balance", "stock", "inventory", "headcount", "open" → semi_additive
 * (These measures are typically point-in-time snapshots, not flows.)
 *
 * A future enhancement could verify additivity by comparing rolled-up sums
 * across hierarchy levels.
 */
function classifyAdditivity(
  measure: MeasureNode,
): "additive" | "semi_additive" | "non_additive" {
  if (measure.aggregations.length === 1 && measure.aggregations[0] === "AVG") {
    return "non_additive";
  }
  const name = measure.uniqueName.toLowerCase() + " " + measure.sourceColumn.toLowerCase();
  if (/balance|stock|inventory|headcount|open_|_open|on_hand/.test(name)) {
    return "semi_additive";
  }
  return "additive";
}

// ─── Measure correlation matrix ───────────────────────────────────────────────

/**
 * Compute pairwise Pearson r between all numeric (non-unknown dataType) measures.
 *
 * Strategy:
 *   1. Try the SQL:2003 CORR(x, y) aggregate — supported by Snowflake, Postgres,
 *      BigQuery, Redshift, Databricks.
 *   2. Fall back to manual: (AVG(x*y) − AVG(x)·AVG(y)) / (STDDEV(x)·STDDEV(y))
 *
 * Capped at the first 10 eligible measures (45 pairs) to avoid query explosion
 * on wide fact tables.  Unknown-datatype and placeholder measures are excluded.
 */
async function profileMeasureCorrelations(
  runner:   DatabaseQueryRunner,
  fact:     FactNode,
  tableRef: string,
  measures: MeasureFingerprint[],
  idMapper: IdMapper,
): Promise<PairwiseMeasureCorrelation[]> {
  // Only numeric measures that were successfully profiled
  const eligible = fact.measures
    .filter((m) => m.dataType !== "unknown")
    .slice(0, 10);

  if (eligible.length < 2) return [];

  const results: PairwiseMeasureCorrelation[] = [];

  for (let i = 0; i < eligible.length; i++) {
    for (let j = i + 1; j < eligible.length; j++) {
      const m1 = eligible[i]!;
      const m2 = eligible[j]!;
      const e1 = m1.sourceColumn;
      const e2 = m2.sourceColumn;

      try {
        const pearsonR = await computePearson(runner, tableRef, e1, e2);
        if (pearsonR === undefined) continue;

        results.push({
          measureId1: idMapper.measureIdFor(fact.uniqueName, m1.uniqueName),
          measureId2: idMapper.measureIdFor(fact.uniqueName, m2.uniqueName),
          pearsonR:   Math.max(-1, Math.min(1, pearsonR)), // clamp for floating-point drift
        });
      } catch {
        // Non-fatal — skip this pair if expression fails
      }
    }
  }

  return results;
}

/**
 * Attempt CORR() first; fall back to manual avg/stddev formula.
 * Returns undefined when either column has zero variance (constant column).
 */
async function computePearson(
  runner:   DatabaseQueryRunner,
  tableRef: string,
  expr1:    string,
  expr2:    string,
): Promise<number | undefined> {
  const whereClause = `(${expr1}) IS NOT NULL AND (${expr2}) IS NOT NULL`;

  // Try SQL:2003 CORR() aggregate
  try {
    const rows = await runner.query(`
      SELECT CORR((${expr1}), (${expr2})) AS r
      FROM ${tableRef}
      WHERE ${whereClause}
    `);
    const r = num(rows[0], "r");
    if (isFinite(r)) return r;
  } catch {
    // CORR() not supported — fall through to manual computation
  }

  // Manual fallback: Pearson via AVG/STDDEV
  const rows = await runner.query(`
    SELECT
      AVG((${expr1}) * (${expr2})) - AVG(${expr1}) * AVG(${expr2}) AS covariance,
      STDDEV((${expr1})) AS s1,
      STDDEV((${expr2})) AS s2
    FROM ${tableRef}
    WHERE ${whereClause}
  `);
  const r0 = rows[0] ?? {};
  const s1 = num(r0, "s1");
  const s2 = num(r0, "s2");
  if (s1 === 0 || s2 === 0) return undefined; // constant column — correlation undefined
  return num(r0, "covariance") / (s1 * s2);
}

function placeholderMeasure(id: string, measure: MeasureNode): MeasureFingerprint {
  return {
    id,
    aggregation:  measure.aggregations[0] ?? "SUM",
    dataType:     measure.dataType,
    additivity:   "additive",
    nullFraction: 0,
    distribution: {
      shape:  "unknown",
      min: 0, max: 0, mean: 0, stddev: 0,
      percentiles: { p5: 0, p25: 0, p50: 0, p75: 0, p95: 0, p99: 0 },
    },
  };
}
