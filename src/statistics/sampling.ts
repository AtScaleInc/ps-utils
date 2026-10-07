/**
 * Sample size calculation and SQL sampling clause generation.
 *
 * Most profiling queries operate on aggregates (GROUP BY parent_key, etc.) that
 * return far fewer rows than the source table, so sampling is only needed for:
 *   - Fact density GROUP BY queries on very large tables
 *   - Measure column distribution queries
 *
 * Formula: Cochran (1977) finite-population correction.
 */

import type { SamplingConfig } from "./types.js";
import { quoter } from "./sql-helpers.js";

// ─── Sample size ──────────────────────────────────────────────────────────────

/**
 * Minimum sample size for a proportion estimate at the given confidence level
 * and margin of error.  Uses worst-case p = 0.5 (maximises the required n).
 *
 * With finite-population correction:
 *   n0  = z² × 0.25 / e²
 *   n   = n0 × N / (n0 + N - 1)
 */
export function computeRequiredSampleSize(
  populationSize: number,
  confidence: number = 0.95,
  marginOfError: number = 0.05,
): number {
  const z  = zForConfidence(confidence);
  const n0 = Math.ceil((z * z * 0.25) / (marginOfError * marginOfError));
  if (populationSize <= 0) return n0;
  return Math.ceil((n0 * populationSize) / (n0 + populationSize - 1));
}

function zForConfidence(c: number): number {
  if (c >= 0.99) return 2.576;
  if (c >= 0.95) return 1.96;
  return 1.645; // 0.90
}

// ─── Sampling clauses ─────────────────────────────────────────────────────────

/**
 * The TABLESAMPLE form each dialect accepts.
 *
 *   postgres / redshift / snowflake  TABLESAMPLE SYSTEM (pct)
 *   bigquery                         TABLESAMPLE SYSTEM (pct PERCENT)   — PERCENT required
 *   databricks                       TABLESAMPLE (pct PERCENT)          — no SYSTEM keyword
 */
function tablesampleClause(dialect: string | undefined, pct: number): string {
  const d = (dialect ?? "").toLowerCase();
  const n = pct.toFixed(4);
  if (d.includes("databricks") || d.includes("spark")) return `TABLESAMPLE (${n} PERCENT)`;
  if (d.includes("bigquery")) return `TABLESAMPLE SYSTEM (${n} PERCENT)`;
  return `TABLESAMPLE SYSTEM (${n})`;
}

export interface SampleClause {
  /** Full table reference to use in the FROM clause. */
  tableRef:       string;
  /** Multiply sampled COUNT(*) results by this to project full-table estimates. */
  scaleFactor:    number;
  sampled:        boolean;
  sampleFraction: number;
}

/**
 * Build a SQL FROM-clause table reference that samples the table when its
 * estimated row count exceeds `targetRows`.
 *
 * Uses a dialect-appropriate TABLESAMPLE form when supported; falls back to
 * `(SELECT * FROM t LIMIT n)` otherwise.  The fallback loses true randomness
 * but is universally compatible and acceptable for distribution estimation.
 */
export function buildSampleClause(
  schema: string,
  table: string,
  estimatedRowCount: number,
  targetRows: number,
  config: SamplingConfig,
): SampleClause {
  const { qualifyTable } = quoter(config.dialect);
  const qualified = qualifyTable(schema, table);

  if (estimatedRowCount <= targetRows || targetRows <= 0) {
    return { tableRef: qualified, scaleFactor: 1, sampled: false, sampleFraction: 1 };
  }

  const fraction    = targetRows / estimatedRowCount;
  const pct         = Math.max(0.001, Math.min(100, fraction * 100));
  const scaleFactor = 100 / pct;

  if (config.supportsTablesample) {
    return {
      tableRef:       `${qualified} ${tablesampleClause(config.dialect, pct)}`,
      scaleFactor,
      sampled:        true,
      sampleFraction: pct / 100,
    };
  }

  // LIMIT-based fallback: slight oversampling to account for block-level variance
  const limitRows = Math.ceil(targetRows * 1.1);
  return {
    tableRef:       `(SELECT * FROM ${qualified} LIMIT ${limitRows})`,
    scaleFactor,
    sampled:        true,
    sampleFraction: pct / 100,
  };
}

