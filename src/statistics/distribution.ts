/**
 * Distribution shape classification.
 *
 * Given summary statistics (mean, stddev, median, P95), classifies the
 * underlying distribution so synthetic data generators can pick the right
 * sampling strategy.
 *
 * Reference heuristics:
 *   - Coefficient of variation (CV = stddev / mean) measures spread relative to centre.
 *   - Relative skew  = (mean - p50) / p50  measures asymmetry (positive = right-skewed).
 *   - P95 / P50 ratio measures tail heaviness.
 *
 * These thresholds are intentionally coarse — the goal is to choose between four
 * generation strategies (uniform, normal, log-normal, power-law), not to fit a
 * precise parametric model.
 */

import type { DistributionShape } from "./types.js";

/**
 * Classify the shape of a distribution from its summary statistics.
 *
 * @param mean    Arithmetic mean
 * @param stddev  Standard deviation
 * @param p50     Median (50th percentile)
 * @param p95     95th percentile
 */
export function classifyShape(
  mean: number,
  stddev: number,
  p50: number,
  p95: number,
): DistributionShape {
  if (mean <= 0 || p50 <= 0) return "unknown";

  const cv           = stddev / mean;
  const relativeSkew = (mean - p50) / p50;       // 0 = symmetric, >0 = right-skewed
  const tailRatio    = p95 > 0 ? p95 / p50 : 0;  // heavy tail → large ratio

  // Power law: very heavy tail AND strong positive skew (mean well above median).
  // Common in: web traffic, zip/city populations, rows-per-customer distributions.
  if (tailRatio > 8 && relativeSkew > 1.0) return "power_law";

  // Uniform: low variance relative to the mean AND near-zero skew.
  // Common in: sequential IDs, evenly distributed rollup children.
  if (cv < 0.25 && Math.abs(relativeSkew) < 0.10) return "uniform";

  // Log-normal: moderate to high CV with positive skew.
  // Common in: revenue, invoice amounts, product prices.
  if (relativeSkew > 0.25 || cv > 0.6) return "log_normal";

  // Default: roughly symmetric, moderate spread.
  return "normal";
}
