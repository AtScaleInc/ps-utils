/**
 * Synthetic data generator — Phase 8 of the fingerprint algorithm.
 *
 * Reads a SchemaFingerprint and generates statistically equivalent synthetic
 * data without requiring any database connection.  The output matches:
 *
 *   • Dimension hierarchy structure — correct member cardinalities at every
 *     level, with tier-aware child-count skew (fat-head parents generate more
 *     children than the median, reproducing the real rollup distribution shape)
 *
 *   • Fact density — rows-per-leaf-member distribution (power_law / normal /
 *     log_normal / uniform) weighted by the density fingerprint; cold members
 *     receive zero fact rows
 *
 *   • Measure distributions — sampled via percentile-interpolated inverse CDF
 *     for each measure's recorded shape
 *
 *   • Measure-to-measure correlation — Gaussian copula using the captured
 *     Pearson r values so correlated measures (e.g. quantity and revenue)
 *     move together rather than being drawn independently
 *
 *   • FK pairwise association — each high-association FK pair is pre-assigned
 *     a constrained set of compatible values so the cross-dimension combinations
 *     reflect the real structural correlation
 *
 * Column naming mirrors generate-ddl-from-data-shape so generated CSVs can be
 * loaded directly into the schema that operation produces.
 */

import fs   from "fs";
import path from "path";

import type {
  SchemaFingerprint,
  DimensionFingerprint,
  FactFingerprint,
  FingerprintMetadata,
  HierarchyFingerprint,
  LevelFingerprint,
  RollupEdgeFingerprint,
  MeasureFingerprint,
  NumericDistribution,
  DistributionShape,
  PercentileSet,
} from "./types.js";
import {
  assertGeneratedKeyShape,
  assertFkClosure,
  type FkClosureReport,
} from "./security.js";

// ─── Public types ─────────────────────────────────────────────────────────────

export interface GenerateOptions {
  /** Random seed for deterministic output.  Omit for non-deterministic. */
  seed?: number;
  /**
   * Scale all row counts and member counts by this factor.
   * 1.0 = full size (default).  0.1 = 10% of real size.
   * Minimum 1 member per level / 1 fact row regardless of scale.
   */
  scaleFactor?: number;
  /**
   * Optional metadata block from the fingerprint (present when the fingerprint
   * was captured with --preserve-meta-data true).  When supplied, generated
   * tables and columns use the real physical names from the original schema.
   */
  metadata?: FingerprintMetadata;
}

/** A generated table — column headers + rows stored as value arrays. */
export interface GeneratedTable {
  tableName: string;
  columns:   string[];
  rows:      unknown[][];
}

export interface GeneratedData {
  /** Dimension tables (generated first; fact FKs reference these). */
  dimensions: GeneratedTable[];
  /** Fact tables. */
  facts:      GeneratedTable[];
  /**
   * Referential-integrity report produced after all tables are generated.
   * Always present; every fact FK is verified to resolve to a dim leaf key.
   * Referential integrity is verified after generation via assertFkClosure.
   */
  fkClosure:  FkClosureReport;
}

// ─── Public API ───────────────────────────────────────────────────────────────

export function generateData(
  fp:      SchemaFingerprint,
  options: GenerateOptions = {},
): GeneratedData {
  const scale    = Math.max(0, options.scaleFactor ?? 1.0);
  const rand     = mkRand(options.seed ?? Math.floor(Math.random() * 0xFFFFFFFF));
  // Use caller-supplied metadata when explicitly provided (even undefined means "don't use metadata").
  // Fall back to fp.metadata only when the caller didn't pass the key at all.
  const metadata = "metadata" in options ? options.metadata : fp.metadata;

  // ── Dimensions ──────────────────────────────────────────────────────────────
  const dimLeaves = new Map<string, number[]>(); // dimId → leaf key array
  const dimensions: GeneratedTable[] = [];
  // Multiple SML dimensions can reference the same physical dataset; only generate
  // one table per physical name and share its leaf keys with all alias dim IDs.
  const seenDimTables = new Map<string, number[]>(); // tableName → leaf keys

  for (const dim of fp.dimensions) {
    const tableName = metadata?.dimensionTables[dim.id] ?? dimIdToTable(dim.id);
    if (seenDimTables.has(tableName)) {
      // Re-use the leaf keys from the first occurrence for FK generation
      dimLeaves.set(dim.id, seenDimTables.get(tableName)!);
      continue;
    }
    const table = generateDimensionTable(dim, scale, rand, metadata);
    dimensions.push(table);
    // Collect leaf keys for fact FK generation
    const lastKeyIdx = table.columns.map((c, i) => c.endsWith("_key") ? i : -1)
      .filter((i) => i >= 0).at(-1) ?? 0;
    const leaves = table.rows.map((r) => r[lastKeyIdx] as number);
    dimLeaves.set(dim.id, leaves);
    seenDimTables.set(tableName, leaves);
  }

  // ── Facts ────────────────────────────────────────────────────────────────────
  const facts: GeneratedTable[] = [];
  const seenFactTables = new Set<string>();
  for (const fact of fp.facts) {
    const tableName = metadata?.factTables[fact.id] ?? factIdToTable(fact.id);
    if (seenFactTables.has(tableName)) continue;
    seenFactTables.add(tableName);
    facts.push(generateFactTable(fact, dimLeaves, fp, scale, rand, metadata));
  }

  // ── Security: generated-key shape (R-15) + FK closure ──────────────────────
  for (const t of dimensions) assertGeneratedKeyShape(t.tableName, t.columns, t.rows);
  for (const t of facts)      assertGeneratedKeyShape(t.tableName, t.columns, t.rows);

  const dimLeafKeySets = new Map<string, Set<number>>();
  for (const dim of fp.dimensions) {
    const tableName = metadata?.dimensionTables[dim.id] ?? dimIdToTable(dim.id);
    dimLeafKeySets.set(tableName, new Set(dimLeaves.get(dim.id) ?? []));
  }
  const fkClosure = assertFkClosure(facts, dimLeafKeySets);

  return { dimensions, facts, fkClosure };
}

/**
 * Write generated data to CSV files in the given directory.
 * One file per table: `<outputDir>/<tableName>.csv`
 */
export function writeDataToCsv(data: GeneratedData, outputDir: string): void {
  fs.mkdirSync(outputDir, { recursive: true });
  for (const table of [...data.dimensions, ...data.facts]) {
    const filePath = path.join(outputDir, `${table.tableName}.csv`);
    const lines    = [table.columns.join(",")];
    for (const row of table.rows) {
      lines.push(row.map(csvVal).join(","));
    }
    fs.writeFileSync(filePath, lines.join("\n") + "\n", "utf8");
  }
}

// ─── Dimension generation ─────────────────────────────────────────────────────

function generateDimensionTable(
  dim:      DimensionFingerprint,
  scale:    number,
  rand:     () => number,
  metadata?: FingerprintMetadata,
): GeneratedTable {
  const tableName = metadata?.dimensionTables[dim.id] ?? dimIdToTable(dim.id);
  const multiHier = dim.hierarchies.length > 1;

  // ── Primary hierarchy: walk top-down to produce leaf-member paths ───────────
  const primaryHier = dim.hierarchies[0]!;
  interface PathEntry { levelKeys: number[] }

  // Root level
  const rootCount = clampMin(primaryHier.levels[0]!.memberCount * scale);
  let currentPath: PathEntry[] = Array.from({ length: rootCount }, (_, i) => ({
    levelKeys: [i + 1],
  }));

  for (let l = 1; l < primaryHier.levels.length; l++) {
    const level  = primaryHier.levels[l]!;
    const target = clampMin(level.memberCount * scale);
    const edge   = level.rollupFromParent!;

    // Assign tiers to parents (Q1..Q4 in round-robin order)
    const childCounts = currentPath.map((_, idx) =>
      sampleChildCount(rand, edge, ((idx % 4) + 1) as 1 | 2 | 3 | 4),
    );

    // Scale to hit target total
    const total    = childCounts.reduce((s, c) => s + c, 0);
    const scaledCounts = scaleToTarget(childCounts, target);

    const nextPath: PathEntry[] = [];
    let keyCounter = 1;
    for (let p = 0; p < currentPath.length; p++) {
      for (let c = 0; c < scaledCounts[p]!; c++) {
        nextPath.push({ levelKeys: [...currentPath[p]!.levelKeys, keyCounter++] });
      }
    }
    currentPath = nextPath;
  }

  // ── Build columns (with deduplication) ───────────────────────────────────────
  // A degenerate SML hierarchy may assign the same ID to multiple levels,
  // producing the same physical column name twice.  Track emitted names and
  // record which (h, l) positions are skipped so row-building stays in sync.
  const columns: string[] = [];
  const emittedColNames = new Set<string>();
  // "h:l" pairs whose column was suppressed; row builder must skip these too.
  const skipPos = new Set<string>();

  for (let h = 0; h < dim.hierarchies.length; h++) {
    const hier = dim.hierarchies[h]!;
    for (let l = 0; l < hier.levels.length; l++) {
      const level      = hier.levels[l]!;
      const keyColName = metadata?.levelKeyColumns[level.id] ?? levelKeyColName(l, h, multiHier);
      if (emittedColNames.has(keyColName)) {
        skipPos.add(`${h}:${l}`);
        continue;
      }
      emittedColNames.add(keyColName);
      columns.push(keyColName);
      if (shouldEmitLabel(level, metadata)) {
        const lblColName = metadata?.levelLabelColumns[level.id] ?? levelLabelColName(l, h, multiHier);
        if (!emittedColNames.has(lblColName)) {
          emittedColNames.add(lblColName);
          columns.push(lblColName);
        }
      }
    }
  }

  // ── Build rows ───────────────────────────────────────────────────────────────
  const rows: unknown[][] = currentPath.map((entry, rowIdx) => {
    const vals: unknown[] = [];

    // Primary hierarchy columns
    for (let l = 0; l < primaryHier.levels.length; l++) {
      if (skipPos.has(`0:${l}`)) continue;
      vals.push(entry.levelKeys[l]);
      if (shouldEmitLabel(primaryHier.levels[l]!, metadata)) {
        vals.push(`lbl_${dim.id}_${l + 1}_${entry.levelKeys[l]}`);
      }
    }

    // Secondary hierarchies: assign ancestors independently
    for (let h = 1; h < dim.hierarchies.length; h++) {
      const secHier    = dim.hierarchies[h]!;
      const leafCount  = currentPath.length;
      for (let l = 0; l < secHier.levels.length; l++) {
        if (skipPos.has(`${h}:${l}`)) continue;
        const memberCount = clampMin(secHier.levels[l]!.memberCount * scale);
        // Distribute leaf members across this level's members
        const key = Math.floor(rowIdx / Math.max(1, leafCount / memberCount)) + 1;
        vals.push(Math.min(key, memberCount));
        if (shouldEmitLabel(secHier.levels[l]!, metadata)) {
          vals.push(`lbl_${dim.id}_h${h + 1}_l${l + 1}_${key}`);
        }
      }
    }

    return vals;
  });

  return { tableName, columns, rows };
}

// ─── Fact generation ──────────────────────────────────────────────────────────

function generateFactTable(
  fact:      FactFingerprint,
  dimLeaves: Map<string, number[]>,
  fp:        SchemaFingerprint,
  scale:     number,
  rand:      () => number,
  metadata?: FingerprintMetadata,
): GeneratedTable {
  const tableName  = metadata?.factTables[fact.id] ?? factIdToTable(fact.id);
  const totalRows  = clampMin(fact.rowCount * scale);

  // ── Column headers ───────────────────────────────────────────────────────────
  const columns: string[] = [];
  const dimTableNames: string[] = [];
  const dimJoinCount = new Map<string, number>();

  for (const join of fact.joins) {
    dimJoinCount.set(join.toDimensionId, (dimJoinCount.get(join.toDimensionId) ?? 0) + 1);
  }
  const dimJoinSeen = new Map<string, number>();

  for (let j = 0; j < fact.joins.length; j++) {
    const join  = fact.joins[j]!;
    const seen  = (dimJoinSeen.get(join.toDimensionId) ?? 0) + 1;
    dimJoinSeen.set(join.toDimensionId, seen);
    const multi = (dimJoinCount.get(join.toDimensionId) ?? 1) > 1;
    const dName = metadata?.dimensionTables[join.toDimensionId] ?? dimIdToTable(join.toDimensionId);
    const col   = metadata?.joinColumns[`${fact.id}:${j}`]
      ?? (multi ? `${dName}_key_${seen}` : `${dName}_key`);
    columns.push(col);
    dimTableNames.push(join.toDimensionId);
  }
  for (const m of fact.measures) {
    columns.push(metadata?.measureColumns[m.id] ?? measureIdToCol(m.id));
  }

  // ── Anchor dimension (first join): density-weighted row assignment ───────────
  const anchorJoin = fact.joins[0];
  // When the fact has no dimension joins, use a single synthetic leaf so the
  // density budget still distributes totalRows across one virtual "member".
  const anchorLeaves = anchorJoin ? (dimLeaves.get(anchorJoin.toDimensionId) ?? []) : [1];
  const leafCount    = anchorLeaves.length || 1;

  // Determine cold members (cold = will receive 0 fact rows)
  const coldFraction  = anchorJoin ? (1 - anchorJoin.coverageFraction) : 0;
  const coldCount     = Math.floor(coldFraction * leafCount);
  const hotLeaves     = anchorLeaves.slice(coldCount); // non-cold leaves
  const hotCount      = hotLeaves.length || 1;

  // Sample density for each hot member, then scale to totalRows
  let budgets: number[] = hotLeaves.map(() => {
    if (!anchorJoin) return 1;
    const d = anchorJoin.density;
    // Build a pseudo-PercentileSet from density stats
    const pcts: PercentileSet = {
      p5:  d.p50 * 0.1,
      p25: d.p50 * 0.4,
      p50: d.p50,
      p75: d.p90 * 0.7,
      p95: d.p90,
      p99: d.p99,
    };
    const raw = sampleFromShape(rand, d.shape, d.avg, d.stddev, 0, d.max, pcts);
    return Math.max(0, Math.round(raw));
  });
  budgets = scaleToTarget(budgets, totalRows);

  // ── FK association constraints ────────────────────────────────────────────────
  // For each pair (dim_i, dim_j) with high associationScore, pre-assign allowed
  // values so the generator picks from a constrained subset.
  const assocConstraints = buildAssocConstraints(
    fact, dimLeaves, rand,
  );

  // ── Measure correlation plan ─────────────────────────────────────────────────
  // Build a map: measureId → { correlated partners and their Pearson r }
  const corrPlan = buildCorrPlan(fact);

  // ── Generate rows ─────────────────────────────────────────────────────────────
  const rows: unknown[][] = [];

  for (let hotIdx = 0; hotIdx < hotLeaves.length; hotIdx++) {
    const anchorKey = hotLeaves[hotIdx]!;
    const rowCount  = budgets[hotIdx] ?? 0;

    for (let r = 0; r < rowCount; r++) {
      const row: unknown[] = [];

      // FK columns
      for (let j = 0; j < fact.joins.length; j++) {
        const join      = fact.joins[j]!;
        const dimId     = join.toDimensionId;
        const leaves    = dimLeaves.get(dimId) ?? [1];

        if (j === 0) {
          row.push(anchorKey);
        } else {
          // Check for association constraint
          const allowed = assocConstraints.get(`${fact.joins[0]!.toDimensionId}:${dimId}`)
            ?.get(anchorKey);
          const pool = allowed ?? leaves;
          row.push(pool[Math.floor(rand() * pool.length)]!);
        }
      }

      // Measure columns (respecting correlations via Gaussian copula)
      const measureVals = sampleMeasures(rand, fact.measures, corrPlan);
      for (const v of measureVals) row.push(v);

      rows.push(row);
    }
  }

  return { tableName, columns, rows };
}

// ─── FK association pre-computation ──────────────────────────────────────────

/**
 * For each pair (dim1, dim2) with associationScore > 0.05, pre-assign each
 * dim1 leaf key a constrained subset of compatible dim2 leaf keys.
 * The subset size = max(1, round((1 - score) * dim2Count))
 */
function buildAssocConstraints(
  fact:      FactFingerprint,
  dimLeaves: Map<string, number[]>,
  rand:      () => number,
): Map<string, Map<number, number[]>> {
  const result = new Map<string, Map<number, number[]>>();
  if (!fact.fkAssociations) return result;

  for (const assoc of fact.fkAssociations) {
    if (assoc.associationScore < 0.05) continue; // practically independent

    const d1Leaves = dimLeaves.get(assoc.dimensionId1) ?? [];
    const d2Leaves = dimLeaves.get(assoc.dimensionId2) ?? [];
    if (d1Leaves.length === 0 || d2Leaves.length === 0) continue;

    const allowedSize = Math.max(1, Math.round((1 - assoc.associationScore) * d2Leaves.length));
    const key         = `${assoc.dimensionId1}:${assoc.dimensionId2}`;
    const mapping     = new Map<number, number[]>();

    for (const d1Key of d1Leaves) {
      // Pick `allowedSize` random d2 keys for this d1 value
      const shuffled = [...d2Leaves].sort(() => rand() - 0.5);
      mapping.set(d1Key, shuffled.slice(0, allowedSize));
    }
    result.set(key, mapping);
  }

  return result;
}

// ─── Measure correlation (Gaussian copula) ────────────────────────────────────

interface CorrPartner {
  partnerIdx: number;
  pearsonR:   number;
}

/** measureIdx → list of correlated partners */
function buildCorrPlan(fact: FactFingerprint): Map<number, CorrPartner[]> {
  const plan = new Map<number, CorrPartner[]>();
  if (!fact.measureCorrelations) return plan;

  for (const corr of fact.measureCorrelations) {
    const idx1 = fact.measures.findIndex((m) => m.id === corr.measureId1);
    const idx2 = fact.measures.findIndex((m) => m.id === corr.measureId2);
    if (idx1 < 0 || idx2 < 0) continue;

    if (!plan.has(idx1)) plan.set(idx1, []);
    if (!plan.has(idx2)) plan.set(idx2, []);
    plan.get(idx1)!.push({ partnerIdx: idx2, pearsonR: corr.pearsonR });
    plan.get(idx2)!.push({ partnerIdx: idx1, pearsonR: corr.pearsonR });
  }
  return plan;
}

/**
 * Generate one value per measure, respecting pairwise Pearson r via a
 * Gaussian copula: correlated standard-normals → uniform via Φ → percentile CDF.
 */
function sampleMeasures(
  rand:    () => number,
  measures: MeasureFingerprint[],
  corrPlan: Map<number, CorrPartner[]>,
): unknown[] {
  // Generate correlated standard normals
  const z = new Array<number>(measures.length).fill(0).map(() => randNormal(rand));

  // Apply Pearson correlation: for each pair (i,j), replace z[j] with
  // r*z[i] + sqrt(1-r²)*z[j].  We process in index order so earlier indices
  // act as the "driver".
  const zCorr = [...z];
  for (let i = 0; i < measures.length; i++) {
    for (const { partnerIdx: j, pearsonR: r } of corrPlan.get(i) ?? []) {
      if (j > i) {
        zCorr[j] = r * zCorr[i]! + Math.sqrt(Math.max(0, 1 - r * r)) * zCorr[j]!;
      }
    }
  }

  return measures.map((m, i) => {
    if (m.distribution.shape === "unknown") {
      // All distribution stats are zero (security-hardened fingerprint): emit 0
      // rather than null so INSERT succeeds for NOT NULL measure columns.
      return 0;
    }
    const u   = normalCdf(zCorr[i]!);
    const val = sampleFromShape(
      () => u,
      m.distribution.shape,
      m.distribution.mean,
      m.distribution.stddev,
      m.distribution.min,
      m.distribution.max,
      m.distribution.percentiles,
    );
    return m.dataType === "integer" ? Math.round(val) : round4(val);
  });
}

// ─── Naming (must match ddl-generator.ts exactly) ─────────────────────────────

export function dimIdToTable(dimId: string): string {
  return `dim_${dimId.replace(/^D/i, "")}`;
}
export function factIdToTable(factId: string): string {
  return `fact_${factId.replace(/^F/i, "")}`;
}
export function levelKeyColName(l: number, h: number, multiHier: boolean): string {
  return (multiHier ? `h${h + 1}_` : "") + `l${l + 1}_key`;
}
export function levelLabelColName(l: number, h: number, multiHier: boolean): string {
  return (multiHier ? `h${h + 1}_` : "") + `l${l + 1}_label`;
}
export function measureIdToCol(measureId: string): string {
  return (measureId.split(".").at(-1) ?? measureId).toLowerCase();
}

// ─── PRNG ─────────────────────────────────────────────────────────────────────

/** Mulberry32 — fast, seeded, high quality for simulation use. */
function mkRand(seed: number): () => number {
  let s = seed >>> 0;
  return function rand() {
    s = (s + 0x6D2B79F5) >>> 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t     = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 0x100000000;
  };
}

// ─── Statistical samplers ─────────────────────────────────────────────────────

/** Box-Muller standard normal sample. */
function randNormal(rand: () => number): number {
  const u = Math.max(1e-10, rand());
  const v = rand();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}

/** Standard normal CDF Φ(z) — Abramowitz & Stegun approximation (max error 7.5×10⁻⁸). */
function normalCdf(z: number): number {
  const t    = 1 / (1 + 0.2316419 * Math.abs(z));
  const poly = t * (0.319381530 + t * (-0.356563782 +
               t * (1.781477937 + t * (-1.821255978 + t * 1.330274429))));
  const p    = 1 - (1 / Math.sqrt(2 * Math.PI)) * Math.exp(-z * z / 2) * poly;
  return z >= 0 ? p : 1 - p;
}

/**
 * Sample a value matching the recorded distribution shape.
 * When pcts is provided, uses piecewise-linear inverse CDF interpolation —
 * the most faithful reproduction of the real distribution shape.
 */
function sampleFromShape(
  rand:   () => number,
  shape:  DistributionShape,
  mean:   number,
  stddev: number,
  min:    number,
  max:    number,
  pcts?:  PercentileSet,
): number {
  if (pcts && (shape === "power_law" || shape === "log_normal")) {
    return sampleFromPercentiles(rand, pcts, min, max);
  }
  switch (shape) {
    case "uniform":
      return min + rand() * (max - min);
    case "normal":
      return clampRange(mean + stddev * randNormal(rand), min, max);
    case "log_normal": {
      const sigma2 = Math.log(1 + Math.pow(stddev / Math.max(mean, 1e-10), 2));
      const mu     = Math.log(Math.max(mean, 1e-10)) - sigma2 / 2;
      return clampRange(Math.exp(mu + Math.sqrt(sigma2) * randNormal(rand)), min, max);
    }
    case "power_law":
      // Pareto inverse CDF: x = x_min * u^(-1/alpha), alpha inferred from mean
      if (min <= 0) return Math.max(0, mean + stddev * randNormal(rand));
      return clampRange(min * Math.pow(Math.max(1e-10, rand()), -1 / Math.max(1, mean / min)), min, max);
    default:
      return clampRange(mean + stddev * randNormal(rand), min, max);
  }
}

/**
 * Piecewise-linear inverse CDF using the recorded percentile control points.
 * Handles any distribution shape without further assumptions.
 */
function sampleFromPercentiles(rand: () => number, pcts: PercentileSet, min: number, max: number): number {
  const u  = rand();
  const pts: [number, number][] = [
    [0.00, min],
    [0.05, pcts.p5],
    [0.25, pcts.p25],
    [0.50, pcts.p50],
    [0.75, pcts.p75],
    [0.95, pcts.p95],
    [0.99, pcts.p99],
    [1.00, max],
  ];
  for (let i = 1; i < pts.length; i++) {
    const [c0, v0] = pts[i - 1]!;
    const [c1, v1] = pts[i]!;
    if (u <= c1) {
      const span = c1 - c0;
      const t    = span > 0 ? (u - c0) / span : 0;
      return v0 + t * (v1 - v0);
    }
  }
  return max;
}

/**
 * Sample an integer child count for a rollup edge, tier-aware when tier data
 * is available.  Falls back to exponential (power_law) sampling globally.
 */
function sampleChildCount(
  rand: () => number,
  edge: RollupEdgeFingerprint,
  tier: 1 | 2 | 3 | 4,
): number {
  let avg = edge.avgRatio;

  if (edge.tiers) {
    const avgs = [
      edge.tiers.q1AvgChildren,
      edge.tiers.q2AvgChildren,
      edge.tiers.q3AvgChildren,
      edge.tiers.q4AvgChildren,
    ];
    avg = avgs[tier - 1]!;
  }

  let raw: number;
  switch (edge.shape) {
    case "power_law":
      // Exponential: F(x) = 1 - e^(-x/avg), inverse: -avg * ln(u)
      raw = -avg * Math.log(Math.max(1e-10, rand()));
      break;
    case "log_normal": {
      const sigma2 = Math.log(1 + Math.pow(edge.stddevRatio / Math.max(avg, 1e-10), 2));
      const mu     = Math.log(Math.max(avg, 1e-10)) - sigma2 / 2;
      raw = Math.exp(mu + Math.sqrt(sigma2) * randNormal(rand));
      break;
    }
    case "uniform":
      raw = edge.min + rand() * (edge.max - edge.min);
      break;
    default:
      raw = avg + edge.stddevRatio * randNormal(rand);
  }

  return Math.max(edge.min || 1, Math.round(raw));
}

// ─── Utilities ────────────────────────────────────────────────────────────────

function clampMin(n: number): number { return Math.max(1, Math.round(n)); }
function clampRange(v: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, v));
}
function round4(v: number): number { return Math.round(v * 10000) / 10000; }
function csvVal(v: unknown): string {
  if (v === null || v === undefined) return "";
  return String(v);
}
/**
 * Whether a label column should be emitted for this level.
 *
 * In metadata mode: only when the metadata explicitly lists a label column
 * (absence means label == key — no separate physical column).
 * In synthetic mode: whenever the fingerprint recorded labelUniqueness.
 */
function shouldEmitLabel(level: LevelFingerprint, metadata: FingerprintMetadata | undefined): boolean {
  if (metadata !== undefined) {
    return metadata.levelLabelColumns[level.id] !== undefined;
  }
  return level.labelUniqueness !== undefined;
}

/**
 * Scale an integer array proportionally so its sum equals target.
 * Preserves relative distribution; adjusts the last non-zero element to hit
 * the exact target.
 */
function scaleToTarget(counts: number[], target: number): number[] {
  const total = counts.reduce((s, c) => s + c, 0);
  if (total === 0) return counts.map(() => Math.max(1, Math.round(target / counts.length)));
  const factor  = target / total;
  const scaled  = counts.map((c) => Math.max(0, Math.round(c * factor)));
  // Adjust for rounding error
  const diff    = target - scaled.reduce((s, c) => s + c, 0);
  const lastIdx = scaled.length - 1;
  scaled[lastIdx] = Math.max(0, (scaled[lastIdx] ?? 0) + diff);
  return scaled;
}
