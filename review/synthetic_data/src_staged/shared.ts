/**
 * Shared utilities for generate-synthetic-data-from-sml and
 * generate-synthetic-data-from-connection.
 *
 * Contents:
 *   - Fingerprint YAML types mirroring STATISTICS.md §"The Fingerprint File Format"
 *   - mulberry32 seeded PRNG + Box-Muller normal + Abramowitz-Stegun normalCdf
 *   - Percentile interpolation (8-point ladder → scalar draw)
 *   - Rollup-edge sampler (tier-aware, honoring power_law / log_normal / uniform)
 *   - FK assignment with association-score subset cache (synthetic-index keyed)
 *   - Synthetic key invariant (^syn_[0-9a-f]{8}$) and fail-closed validators
 *   - DDL builder (ANSI / postgres / snowflake / bigquery dialects)
 *   - CSV row emitter + multi-value INSERT emitter
 *   - pipeline_isolation_report.json writer
 *
 * PROMOTION NOTE:
 *   This file is staged at review/synthetic_data/src_staged/shared.ts. On promotion it
 *   moves to src/operations/generate-synthetic-data-shared.ts. The relative imports
 *   below ("../logging.js", "../services/...") assume the promoted location.
 */
import fs from "fs";
import path from "path";
import crypto from "crypto";
import type { Logger } from "../logging.js";

// ────────────────────────────────────────────────────────────────────────────
// Fingerprint types (STATISTICS.md §"The Fingerprint File Format" v2.0)
// ────────────────────────────────────────────────────────────────────────────

export type FingerprintVersion = "2.0";

export type RollupShape = "uniform" | "power_law" | "log_normal" | "normal" | "bimodal";

export interface RollupTiers {
  q1_avg_children: number;
  q2_avg_children: number;
  q3_avg_children: number;
  q4_avg_children: number;
  q4_child_fraction: number;
}

export interface RollupEdgeFingerprint {
  avg_ratio?: number;
  stddev_ratio?: number;
  shape?: RollupShape;
  p50?: number;
  p95?: number;
  tiers?: RollupTiers;
}

export interface LevelFingerprint {
  id: string;
  role?: "root" | "leaf";
  member_count: number;
  null_key_fraction?: number;
  is_unique_label?: boolean;          // replaces label_uniqueness per review §R-2
  cold_member_fraction?: number;      // bucketized per review §R-4
  rollup_from_parent?: RollupEdgeFingerprint;
}

export interface HierarchyFingerprint {
  id: string;
  levels: LevelFingerprint[];
}

export interface DimensionFingerprint {
  id: string;
  row_count: number;
  hierarchies: HierarchyFingerprint[];
}

export interface DensityFingerprint {
  avg: number;
  stddev: number;
  shape: RollupShape;
  p50: number;
  p90: number;
  p99: number;
  p999?: number;                      // winsorized ceiling per review §R-5
}

export interface FactJoinFingerprint {
  to_dimension: string;
  to_leaf: string;
  null_fk_fraction?: number;
  coverage_fraction?: number;
  density: DensityFingerprint;
}

export interface MeasureDistribution {
  shape: "log_normal" | "normal" | "uniform" | "power_law";
  percentiles: {
    p5: number; p25: number; p50: number; p75: number; p95: number;
    p10?: number; p90?: number;        // collapsed ladder for small tables
  };
}

export interface MeasureFingerprint {
  id: string;
  aggregation: string;
  type: "integer" | "decimal";
  additivity?: "additive" | "semi_additive" | "non_additive";
  distribution: MeasureDistribution;
}

export interface MeasureCorrelation {
  measure_id_1: string;
  measure_id_2: string;
  pearson_r: number;
}

export interface FKAssociation {
  dimension_id_1: string;
  dimension_id_2: string;
  association_score: number;
  is_near_functional?: boolean;       // replaces raw score when > 0.9 per review §R-11
}

export interface FactFingerprint {
  id: string;
  row_count: number;
  joins: FactJoinFingerprint[];
  measures: MeasureFingerprint[];
  measure_correlations?: MeasureCorrelation[];
  fk_associations?: FKAssociation[];
}

export interface ConformedDimensionFingerprint {
  dimension: string;
  facts: string[];
  overlap_fraction: number;           // binned to 5% buckets per review §R-10
}

export interface Fingerprint {
  fingerprint_version: FingerprintVersion;
  model_role: "semantic_layer";
  generator?: Record<string, unknown>;
  dimensions: DimensionFingerprint[];
  facts: FactFingerprint[];
  conformed_dimensions?: ConformedDimensionFingerprint[];
}

// ────────────────────────────────────────────────────────────────────────────
// Seeded PRNG (STATISTICS.md §8.1)
// ────────────────────────────────────────────────────────────────────────────

export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return function () {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function randNormal(rand: () => number): number {
  let u = 0;
  let v = 0;
  while (u === 0) u = rand();
  while (v === 0) v = rand();
  return Math.sqrt(-2.0 * Math.log(u)) * Math.cos(2.0 * Math.PI * v);
}

/** Abramowitz & Stegun 7.1.26, max error 7.5e-8. */
export function normalCdf(z: number): number {
  const sign = z < 0 ? -1 : 1;
  const x = Math.abs(z) / Math.SQRT2;
  const t = 1.0 / (1.0 + 0.3275911 * x);
  const y =
    1.0 -
    (((((1.061405429 * t - 1.453152027) * t) + 1.421413741) * t - 0.284496736) * t +
      0.254829592) *
      t *
      Math.exp(-x * x);
  return 0.5 * (1.0 + sign * y);
}

// ────────────────────────────────────────────────────────────────────────────
// Percentile interpolation (STATISTICS.md §8.3 measure generation)
// ────────────────────────────────────────────────────────────────────────────

type Percentiles = MeasureDistribution["percentiles"];

export function quantileFromU(u: number, p: Percentiles): number {
  const pts: Array<[number, number]> = [];
  pts.push([0.0, p.p5]);
  pts.push([0.05, p.p5]);
  if (p.p10 !== undefined) pts.push([0.10, p.p10]);
  pts.push([0.25, p.p25]);
  pts.push([0.50, p.p50]);
  pts.push([0.75, p.p75]);
  if (p.p90 !== undefined) pts.push([0.90, p.p90]);
  pts.push([0.95, p.p95]);
  pts.push([1.0, p.p95]);

  pts.sort((a, b) => a[0] - b[0]);

  for (let i = 0; i < pts.length - 1; i++) {
    const [x0, y0] = pts[i];
    const [x1, y1] = pts[i + 1];
    if (u >= x0 && u <= x1) {
      if (x1 === x0) return y0;
      return y0 + ((y1 - y0) * (u - x0)) / (x1 - x0);
    }
  }
  return pts[pts.length - 1][1];
}

// ────────────────────────────────────────────────────────────────────────────
// Synthetic key invariant
// ────────────────────────────────────────────────────────────────────────────

export const SYNTH_KEY_REGEX = /^syn_[0-9a-f]{8}$/;

export function synthKey(rand: () => number): string {
  const n = Math.floor(rand() * 0xffffffff).toString(16).padStart(8, "0");
  return `syn_${n}`;
}

export function assertSyntheticKey(k: string): void {
  if (!SYNTH_KEY_REGEX.test(k)) {
    throw new Error(
      `[synthetic-data] Invariant violation: emitted key "${k}" does not match ${SYNTH_KEY_REGEX}`,
    );
  }
}

// ────────────────────────────────────────────────────────────────────────────
// Rollup sampler (STATISTICS.md §8.2)
// ────────────────────────────────────────────────────────────────────────────

export function drawRollupChildCount(
  rand: () => number,
  edge: RollupEdgeFingerprint,
  tierIdx?: 0 | 1 | 2 | 3,
): number {
  const shape = edge.shape ?? "uniform";
  let mean: number;
  if (edge.tiers && tierIdx !== undefined) {
    mean = [
      edge.tiers.q1_avg_children,
      edge.tiers.q2_avg_children,
      edge.tiers.q3_avg_children,
      edge.tiers.q4_avg_children,
    ][tierIdx];
  } else {
    mean = edge.avg_ratio ?? 1;
  }

  if (mean <= 0) return 0;

  switch (shape) {
    case "power_law": {
      return Math.max(1, Math.round(-Math.log(1 - rand()) * mean));
    }
    case "log_normal": {
      const sigma = Math.sqrt(Math.log(1 + (edge.stddev_ratio ?? 0) ** 2 / mean ** 2));
      const mu = Math.log(mean) - (sigma * sigma) / 2;
      return Math.max(1, Math.round(Math.exp(mu + sigma * randNormal(rand))));
    }
    case "normal": {
      const sigma = edge.stddev_ratio ?? mean * 0.25;
      return Math.max(1, Math.round(mean + sigma * randNormal(rand)));
    }
    case "uniform":
    default: {
      const lo = Math.max(1, mean * 0.5);
      const hi = mean * 1.5;
      return Math.max(1, Math.round(lo + (hi - lo) * rand()));
    }
  }
}

export function scaleToTarget(counts: number[], target: number): number[] {
  const total = counts.reduce((a, b) => a + b, 0);
  if (total === 0) return counts;
  const scale = target / total;
  const scaled = counts.map((c) => Math.max(1, Math.round(c * scale)));
  // Correct cumulative drift so sum equals target exactly.
  const drift = target - scaled.reduce((a, b) => a + b, 0);
  if (drift !== 0 && scaled.length > 0) {
    scaled[0] = Math.max(1, scaled[0] + drift);
  }
  return scaled;
}

// ────────────────────────────────────────────────────────────────────────────
// Gaussian copula measure sampler (STATISTICS.md §8.3)
// ────────────────────────────────────────────────────────────────────────────

export interface CopulaSpec {
  measures: MeasureFingerprint[];
  correlations: MeasureCorrelation[];
}

export function sampleMeasuresCopula(
  rand: () => number,
  spec: CopulaSpec,
): Record<string, number> {
  const z: Record<string, number> = {};
  for (const m of spec.measures) z[m.id] = randNormal(rand);

  // Cholesky-free pairwise adjustment (STATISTICS.md §8.3 formula):
  //   z[j] = r·z[i] + √(1 − r²)·z[j]
  for (const c of spec.correlations) {
    const zi = z[c.measure_id_1];
    const zj = z[c.measure_id_2];
    if (zi === undefined || zj === undefined) continue;
    const r = Math.max(-0.999, Math.min(0.999, c.pearson_r));
    z[c.measure_id_2] = r * zi + Math.sqrt(1 - r * r) * zj;
  }

  const out: Record<string, number> = {};
  for (const m of spec.measures) {
    const u = Math.max(1e-9, Math.min(1 - 1e-9, normalCdf(z[m.id])));
    let v = quantileFromU(u, m.distribution.percentiles);
    if (m.type === "integer") v = Math.round(v);
    out[m.id] = v;
  }
  return out;
}

// ────────────────────────────────────────────────────────────────────────────
// FK association subset cache (STATISTICS.md §8.3, review §R-16)
// ────────────────────────────────────────────────────────────────────────────

/** Build an allowed-subset of synthetic dim2 positional indices for each dim1 index. */
export function buildAssociationCache(
  rand: () => number,
  dim1Count: number,
  dim2Count: number,
  associationScore: number,
): Map<number, number[]> {
  const cache = new Map<number, number[]>();
  const subsetSize = Math.max(
    1,
    Math.round((1 - associationScore) * dim2Count),
  );
  for (let i = 0; i < dim1Count; i++) {
    // Deterministic per-i shuffle via seeded rand, taking the first subsetSize indices.
    const pool = [...Array(dim2Count).keys()];
    for (let j = pool.length - 1; j > 0; j--) {
      const k = Math.floor(rand() * (j + 1));
      [pool[j], pool[k]] = [pool[k], pool[j]];
    }
    cache.set(i, pool.slice(0, subsetSize));
  }
  return cache;
}

// ────────────────────────────────────────────────────────────────────────────
// DDL builder (STATISTICS.md §7 mapping)
// ────────────────────────────────────────────────────────────────────────────

export type SqlDialect = "ansi" | "postgres" | "snowflake" | "mysql" | "bigquery";

function keyTypeFor(memberCount: number, dialect: SqlDialect): string {
  if (dialect === "snowflake") {
    if (memberCount <= 32767) return "NUMBER(5,0)";
    if (memberCount <= 2147483647) return "NUMBER(10,0)";
    return "NUMBER(19,0)";
  }
  if (memberCount <= 32767) return "SMALLINT";
  if (memberCount <= 2147483647) return "INTEGER";
  return "BIGINT";
}

function measureTypeFor(type: MeasureFingerprint["type"], dialect: SqlDialect): string {
  if (dialect === "bigquery") return type === "integer" ? "INT64" : "FLOAT64";
  if (dialect === "snowflake") return type === "integer" ? "NUMBER(19,0)" : "NUMBER(18,4)";
  return type === "integer" ? "BIGINT" : "DECIMAL(18,4)";
}

export function buildDdl(fpr: Fingerprint, dialect: SqlDialect): string {
  const omitConstraints = dialect === "bigquery";
  const blocks: string[] = [];

  for (const d of fpr.dimensions) {
    const hier = d.hierarchies[0];
    const leafLevel = hier.levels[hier.levels.length - 1];
    const lines: string[] = [];
    for (let i = 0; i < hier.levels.length; i++) {
      const lv = hier.levels[i];
      const keyName = `l${i + 1}_key`;
      const keyType = keyTypeFor(lv.member_count, dialect);
      lines.push(`    ${keyName.padEnd(10)} ${keyType}  NOT NULL`);
    }
    if (leafLevel.is_unique_label) {
      lines.push(`    l${hier.levels.length}_label VARCHAR(64)`);
    }
    if (!omitConstraints) {
      lines.push(`    PRIMARY KEY (l${hier.levels.length}_key)`);
    }
    blocks.push(
      `-- Dimension ${d.id} (~${d.row_count} rows)\n` +
        `CREATE TABLE dim_${d.id.replace(/^D/, "")} (\n${lines.join(",\n")}\n);`,
    );
  }

  for (const f of fpr.facts) {
    const lines: string[] = [];
    for (const j of f.joins) {
      const dim = fpr.dimensions.find((d) => d.id === j.to_dimension);
      if (!dim) continue;
      const leafCount = dim.hierarchies[0].levels.slice(-1)[0].member_count;
      const colName = `dim_${j.to_dimension.replace(/^D/, "")}_key`;
      lines.push(`    ${colName.padEnd(14)} ${keyTypeFor(leafCount, dialect)}`);
    }
    for (const m of f.measures) {
      const colName = m.id.replace(/^.*\./, "").toLowerCase();
      lines.push(`    ${colName.padEnd(14)} ${measureTypeFor(m.type, dialect)}`);
    }
    if (!omitConstraints) {
      for (const j of f.joins) {
        const dimId = j.to_dimension.replace(/^D/, "");
        lines.push(
          `    FOREIGN KEY (dim_${dimId}_key) REFERENCES dim_${dimId} (l${
            fpr.dimensions.find((d) => d.id === j.to_dimension)?.hierarchies[0].levels
              .length
          }_key)`,
        );
      }
    }
    blocks.push(
      `-- Fact ${f.id} (~${f.row_count} rows, ${f.joins.length} join(s), ${f.measures.length} measure(s))\n` +
        `CREATE TABLE fact_${f.id.replace(/^F/, "")} (\n${lines.join(",\n")}\n);`,
    );
  }

  return blocks.join("\n\n") + "\n";
}

// ────────────────────────────────────────────────────────────────────────────
// CSV writer
// ────────────────────────────────────────────────────────────────────────────

export function writeCsv(rows: Array<Record<string, unknown>>, filePath: string): void {
  if (rows.length === 0) {
    fs.writeFileSync(filePath, "", "utf8");
    return;
  }
  const cols = Object.keys(rows[0]);
  const escape = (v: unknown): string => {
    if (v === null || v === undefined) return "";
    const s = String(v);
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const header = cols.join(",");
  const body = rows.map((r) => cols.map((c) => escape(r[c])).join(",")).join("\n");
  fs.writeFileSync(filePath, header + "\n" + body + "\n", "utf8");
}

// ────────────────────────────────────────────────────────────────────────────
// Pipeline-isolation report (STATISTICS.md revised §8.4 + review §03 Layer 7)
// ────────────────────────────────────────────────────────────────────────────

export interface PipelineIsolationReport {
  report_version: "1.0";
  operation: string;
  run_id: string;
  output_root: string;
  emitted_paths: string[];
  started_at: string;
  completed_at: string;
  outside_boundary_writes: string[];  // MUST be empty; non-empty fails the run
}

export function writePipelineIsolationReport(
  report: PipelineIsolationReport,
  outPath: string,
): void {
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, JSON.stringify(report, null, 2) + "\n", "utf8");
}

// ────────────────────────────────────────────────────────────────────────────
// Fingerprint hash (for the manifest)
// ────────────────────────────────────────────────────────────────────────────

export function fingerprintSha256(raw: string): string {
  return crypto.createHash("sha256").update(raw).digest("hex");
}

// ────────────────────────────────────────────────────────────────────────────
// Logging helper — keeps the "[OpName]" prefix consistent across both ops.
// ────────────────────────────────────────────────────────────────────────────

export function mkTag(tag: string, logger: Logger): {
  log: (msg: string) => void;
  warn: (msg: string) => void;
} {
  return {
    log:  (m: string) => logger.log(`[${tag}] ${m}`),
    warn: (m: string) => logger.log(`[${tag}] ⚠ ${m}`),
  };
}
