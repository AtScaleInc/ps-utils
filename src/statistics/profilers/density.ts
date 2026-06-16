/**
 * Leaf-level fact density profiler.
 *
 * For each FK join (fact → dimension leaf level):
 *   - Null FK fraction
 *   - Coverage fraction (how many leaf members appear in at least one fact row)
 *   - Density distribution (fact rows per leaf member): avg, stddev, P50/P90/P99, shape
 *   - Cold member fraction (leaf members with ZERO fact rows)
 *
 * Density GROUP BY queries may be sampled on large fact tables via TABLESAMPLE.
 * The scale factor is stored in the fingerprint so downstream tools can project
 * full-table estimates.
 */

import type {
  DatabaseQueryRunner,
  DimensionNode,
  FactNode,
  FkAssociation,
  JoinFingerprint,
  SamplingConfig,
} from "../types.js";
import { q, qualifyTable, num } from "../sql-helpers.js";
import { buildSampleClause } from "../sampling.js";
import { classifyShape } from "../distribution.js";
import { countRows } from "../sql-helpers.js";
import type { IdMapper } from "../id-mapper.js";

// ─── Public API ───────────────────────────────────────────────────────────────

/**
 * Profile all FK joins for a single fact table.
 * Returns JoinFingerprints AND a map of leafLevelId → coldMemberFraction
 * so the hierarchy fingerprints can be updated by the extractor.
 */
export async function profileFactJoins(
  runner:     DatabaseQueryRunner,
  fact:       FactNode,
  dimByName:  Map<string, DimensionNode>,
  config:     SamplingConfig,
  idMapper:   IdMapper,
): Promise<{ joins: JoinFingerprint[]; coldMembers: Map<string, number>; fkAssociations?: FkAssociation[] }> {
  const joins: JoinFingerprint[]       = [];
  const coldMembers = new Map<string, number>();

  // Estimate row count once (used for sample clause decisions)
  const factRowCount = await countRows(runner, fact.sourceSchema, fact.sourceTable);

  for (const edge of fact.joins) {
    const dim = dimByName.get(edge.toDimension);
    if (!dim) continue;

    // Find the leaf level node referenced by this join
    const leafLevel = findLeafLevel(dim, edge.toLevel);
    if (!leafLevel) continue;

    const fkCol      = edge.fromColumns[0];
    const dimKeyCol  = leafLevel.keyColumns[0];
    if (!fkCol || !dimKeyCol) continue;

    const factTable  = qualifyTable(fact.sourceSchema, fact.sourceTable);
    const dimTable   = qualifyTable(dim.sourceSchema,   dim.sourceTable);

    // ── Null FK fraction ─────────────────────────────────────────────────────
    const nullRows = await runner.query(`
      SELECT
        SUM(CASE WHEN ${q(fkCol)} IS NULL THEN 1 ELSE 0 END) * 1.0
          / NULLIF(COUNT(*), 0) AS null_fk_fraction
      FROM ${factTable}
    `);
    const nullFkFraction = num(nullRows[0], "null_fk_fraction");

    // ── Density distribution on (possibly sampled) fact table ────────────────
    const sample = buildSampleClause(
      fact.sourceSchema, fact.sourceTable, factRowCount, config.targetFactRows, config,
    );

    const densityRows = await runner.query(`
      SELECT
        COUNT(*)                    AS group_count,
        AVG(rows_per_leaf)          AS avg_density,
        STDDEV(rows_per_leaf)       AS stddev_density,
        MAX(rows_per_leaf)          AS max_density,
        PERCENTILE_CONT(0.50) WITHIN GROUP (ORDER BY rows_per_leaf) AS p50,
        PERCENTILE_CONT(0.90) WITHIN GROUP (ORDER BY rows_per_leaf) AS p90,
        PERCENTILE_CONT(0.99) WITHIN GROUP (ORDER BY rows_per_leaf) AS p99
      FROM (
        SELECT ${q(fkCol)}, COUNT(*) AS rows_per_leaf
        FROM ${sample.tableRef}
        WHERE ${q(fkCol)} IS NOT NULL
        GROUP BY ${q(fkCol)}
      ) density_counts
    `);
    const dr     = densityRows[0] ?? {};
    const avg    = num(dr, "avg_density");
    const stddev = num(dr, "stddev_density");
    const p50    = num(dr, "p50");
    const p90    = num(dr, "p90");
    const p99    = num(dr, "p99");
    const maxD   = num(dr, "max_density");

    // ── Coverage + cold member fraction ──────────────────────────────────────
    // Coverage: how many distinct dim leaf members appear in the fact.
    // Cold: leaf members with ZERO fact rows.
    const leafMemberCount = await runner.query(`
      SELECT COUNT(DISTINCT ${q(dimKeyCol)}) AS leaf_count
      FROM ${dimTable}
    `);
    const totalLeafMembers = num(leafMemberCount[0], "leaf_count");

    // Distinct leaf members WITH fact rows (from the density group count above)
    // If sampled, we project: distinct members in sample ≈ actual * sampleFraction
    const sampledWithFacts = num(dr, "group_count");
    const projectedWithFacts = sample.sampled
      ? Math.round(sampledWithFacts * sample.scaleFactor)
      : sampledWithFacts;

    const coverageFraction = totalLeafMembers > 0
      ? Math.min(1, projectedWithFacts / totalLeafMembers)
      : 0;

    const coldMemberFraction = Math.max(0, 1 - coverageFraction);

    const leafLevelId = idMapper.levelId(dim.uniqueName, findHierarchyForLevel(dim, edge.toLevel), edge.toLevel);
    coldMembers.set(leafLevelId, coldMemberFraction);

    joins.push({
      toDimensionId:    idMapper.dimensionId(dim.uniqueName),
      toLeafLevelId:    leafLevelId,
      nullFkFraction,
      coverageFraction,
      density: {
        avg,
        stddev,
        shape:          classifyShape(avg, stddev, p50, p90),
        p50,
        p90,
        p99,
        max:            maxD,
        sampled:        sample.sampled,
        ...(sample.sampled ? { sampleFraction: sample.sampleFraction } : {}),
      },
    });
  }

  // ── FK pairwise association ───────────────────────────────────────────────
  const fkAssociations = await profileFkAssociations(
    runner, fact, factRowCount, config, idMapper,
  );

  return {
    joins,
    coldMembers,
    ...(fkAssociations.length > 0 ? { fkAssociations } : {}),
  };
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function findLeafLevel(
  dim: DimensionNode,
  levelUniqueName: string,
) {
  for (const hier of dim.hierarchies) {
    const found = hier.levels.find((l) => l.uniqueName === levelUniqueName);
    if (found) return found;
  }
  // If not found by name, return the leaf of the first hierarchy as a fallback
  return dim.hierarchies[0]?.levels.at(-1) ?? null;
}

// ─── FK pairwise association ──────────────────────────────────────────────────

/**
 * For each pair of FK columns on the fact table, compute a normalized
 * non-independence score:
 *
 *   associationScore = 1 − distinctPairs / min(sampleSize, card₁ × card₂)
 *
 *   0 = completely independent (all possible FK combinations observed)
 *   1 = perfectly correlated   (each FK1 value maps to exactly one FK2 value)
 *
 * No actual FK values are stored — only the cardinalities and pair count.
 *
 * Capped at the first 6 FK joins (15 pairs) to avoid query explosion on
 * highly denormalized fact tables.
 */
async function profileFkAssociations(
  runner:       DatabaseQueryRunner,
  fact:         FactNode,
  factRowCount: number,
  config:       SamplingConfig,
  idMapper:     IdMapper,
): Promise<FkAssociation[]> {
  const eligibleJoins = fact.joins
    .filter((j) => j.fromColumns[0])
    .slice(0, 6);

  if (eligibleJoins.length < 2) return [];

  const sample = buildSampleClause(
    fact.sourceSchema, fact.sourceTable, factRowCount, config.targetFactRows, config,
  );

  const results: FkAssociation[] = [];

  for (let i = 0; i < eligibleJoins.length; i++) {
    for (let j = i + 1; j < eligibleJoins.length; j++) {
      const edge1 = eligibleJoins[i]!;
      const edge2 = eligibleJoins[j]!;
      const fk1   = edge1.fromColumns[0]!;
      const fk2   = edge2.fromColumns[0]!;

      try {
        // Cardinalities + sample size
        const cardRows = await runner.query(`
          SELECT
            COUNT(DISTINCT ${q(fk1)}) AS n1,
            COUNT(DISTINCT ${q(fk2)}) AS n2,
            COUNT(*)                  AS n_total
          FROM ${sample.tableRef}
          WHERE ${q(fk1)} IS NOT NULL
            AND ${q(fk2)} IS NOT NULL
        `);
        const cr = cardRows[0] ?? {};
        const n1      = num(cr, "n1");
        const n2      = num(cr, "n2");
        const nTotal  = num(cr, "n_total");
        if (n1 === 0 || n2 === 0 || nTotal === 0) continue;

        // Distinct pair count
        const pairRows = await runner.query(`
          SELECT COUNT(*) AS n_pairs
          FROM (
            SELECT DISTINCT ${q(fk1)}, ${q(fk2)}
            FROM ${sample.tableRef}
            WHERE ${q(fk1)} IS NOT NULL
              AND ${q(fk2)} IS NOT NULL
          ) pairs
        `);
        const nPairs = num(pairRows[0], "n_pairs");

        // Denominator: max possible pairs given the sample
        const maxPairs = Math.min(nTotal, n1 * n2);
        const score    = maxPairs > 0
          ? Math.max(0, Math.min(1, 1 - nPairs / maxPairs))
          : 0;

        results.push({
          dimensionId1:     idMapper.dimensionId(edge1.toDimension),
          dimensionId2:     idMapper.dimensionId(edge2.toDimension),
          associationScore: score,
        });
      } catch {
        // Non-fatal — skip this pair
      }
    }
  }

  return results;
}

function findHierarchyForLevel(
  dim: DimensionNode,
  levelUniqueName: string,
): string {
  for (const hier of dim.hierarchies) {
    if (hier.levels.some((l) => l.uniqueName === levelUniqueName)) {
      return hier.uniqueName;
    }
  }
  return dim.hierarchies[0]?.uniqueName ?? "unknown";
}
