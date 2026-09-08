/**
 * Hierarchy level chain profiler.
 *
 * For each level in each hierarchy:
 *   - Member cardinality (COUNT DISTINCT key column)
 *   - Null key fraction
 *   - Label uniqueness (when a label column exists)
 *   - Rollup ratio statistics from the parent level (avg, stddev, P50, P95, shape)
 *
 * Cold-member fraction (fraction of leaf members with zero fact rows) is NOT
 * computed here — it requires cross-referencing a fact table.  The extractor
 * fills it in after density profiling completes.
 */

import type {
  DatabaseQueryRunner,
  DimensionNode,
  HierarchyFingerprint,
  LevelFingerprint,
  RollupEdgeFingerprint,
  RollupTierProfile,
  SamplingConfig,
} from "../types.js";
import { q, qualifyTable, num } from "../sql-helpers.js";
import { classifyShape } from "../distribution.js";
import type { IdMapper } from "../id-mapper.js";

// ─── Public API ───────────────────────────────────────────────────────────────

export async function profileHierarchies(
  runner:    DatabaseQueryRunner,
  dim:       DimensionNode,
  _config:   SamplingConfig,   // reserved for future per-level sampling
  idMapper:  IdMapper,
): Promise<HierarchyFingerprint[]> {
  const results: HierarchyFingerprint[] = [];
  const defaultTableRef = qualifyTable(dim.sourceSchema, dim.sourceTable);

  for (const hier of dim.hierarchies) {
    const levelFps: LevelFingerprint[] = [];

    for (let i = 0; i < hier.levels.length; i++) {
      const level      = hier.levels[i]!;
      const parentLevel = i > 0 ? hier.levels[i - 1] : null;
      const keyCol      = level.keyColumns[0]!;

      // Snowflake-schema hierarchies normalize each level into its own physical
      // table (e.g. dimproductcategory → dimproductsubcategory → dimproduct).
      // Query the level's OWN table when one is recorded; fall back to the
      // dimension's default table for star-schema hierarchies where every
      // level lives in one denormalized row.
      const tableRef = level.sourceTable
        ? qualifyTable(level.sourceSchema ?? dim.sourceSchema, level.sourceTable)
        : defaultTableRef;

      // ── Cardinality + null fraction ──────────────────────────────────────
      const cardRows = await runner.query(`
        SELECT
          COUNT(DISTINCT ${q(keyCol)}) AS member_count,
          SUM(CASE WHEN ${q(keyCol)} IS NULL THEN 1 ELSE 0 END) * 1.0
            / NULLIF(COUNT(*), 0) AS null_key_fraction
        FROM ${tableRef}
      `);
      const cardRow = cardRows[0] ?? {};

      // ── Label uniqueness ─────────────────────────────────────────────────
      let labelUniqueness: number | undefined;
      if (level.labelColumn) {
        const labRows = await runner.query(`
          SELECT
            COUNT(DISTINCT ${q(level.labelColumn)}) * 1.0
              / NULLIF(COUNT(DISTINCT ${q(keyCol)}), 1) AS lbl_uniq
          FROM ${tableRef}
          WHERE ${q(keyCol)} IS NOT NULL
        `);
        labelUniqueness = num(labRows[0], "lbl_uniq");
      }

      // ── Rollup ratio from parent ─────────────────────────────────────────
      // In a snowflake-schema hierarchy, the child level's own table already
      // carries the FK column pointing at its parent (that's what makes it a
      // child) — no cross-table JOIN is needed, just the right column name.
      // `parentKeyColumn` (resolved from the dimension's `relationships`
      // block) gives that FK column when it differs from the parent's own
      // key column name; star-schema hierarchies (single shared table) fall
      // back to the parent's key column name unchanged.
      let rollupFromParent: RollupEdgeFingerprint | undefined;
      if (parentLevel) {
        const parentKeyCol = level.parentKeyColumn ?? parentLevel.keyColumns[0]!;
        rollupFromParent = await profileRollupEdge(
          runner, tableRef, parentKeyCol, keyCol,
        );
      }

      const role = i === 0 ? "root" : level.isLeaf ? "leaf" : "intermediate";

      const fp: LevelFingerprint = {
        id:              idMapper.levelId(dim.uniqueName, hier.uniqueName, level.uniqueName),
        role,
        memberCount:     num(cardRow, "member_count"),
        nullKeyFraction: num(cardRow, "null_key_fraction"),
        ...(labelUniqueness !== undefined ? { labelUniqueness } : {}),
        ...(rollupFromParent               ? { rollupFromParent } : {}),
      };

      levelFps.push(fp);
    }

    results.push({
      id:     idMapper.hierarchyId(dim.uniqueName, hier.uniqueName),
      levels: levelFps,
    });
  }

  return results;
}

// ─── Rollup edge ──────────────────────────────────────────────────────────────

/**
 * Compute how many distinct child-key values each parent-key value has.
 * The distribution of that count describes the rollup ratio at this hierarchy edge.
 */
async function profileRollupEdge(
  runner:       DatabaseQueryRunner,
  tableRef:     string,
  parentKeyCol: string,
  childKeyCol:  string,
): Promise<RollupEdgeFingerprint> {
  const rows = await runner.query(`
    SELECT
      AVG(children_per_parent)    AS avg_ratio,
      STDDEV(children_per_parent) AS stddev_ratio,
      MIN(children_per_parent)    AS min_children,
      MAX(children_per_parent)    AS max_children,
      PERCENTILE_CONT(0.50) WITHIN GROUP (ORDER BY children_per_parent) AS p50,
      PERCENTILE_CONT(0.95) WITHIN GROUP (ORDER BY children_per_parent) AS p95
    FROM (
      SELECT ${q(parentKeyCol)},
             COUNT(DISTINCT ${q(childKeyCol)}) AS children_per_parent
      FROM ${tableRef}
      WHERE ${q(parentKeyCol)} IS NOT NULL
      GROUP BY ${q(parentKeyCol)}
    ) rollup_counts
  `);

  const row    = rows[0] ?? {};
  const avg    = num(row, "avg_ratio");
  const stddev = num(row, "stddev_ratio");
  const p50    = num(row, "p50");
  const p95    = num(row, "p95");

  // ── Tier buckets ─────────────────────────────────────────────────────────
  // Meaningful only when there are enough parents to form four distinct tiers.
  const tiers = await profileRollupTiers(runner, tableRef, parentKeyCol, childKeyCol);

  return {
    avgRatio:    avg,
    stddevRatio: stddev,
    shape:       classifyShape(avg, stddev, p50, p95),
    min:         num(row, "min_children"),
    p50,
    p95,
    max:         num(row, "max_children"),
    ...(tiers ? { tiers } : {}),
  };
}

// ─── Rollup tier buckets ──────────────────────────────────────────────────────

/**
 * Divide parents into quartiles by child count, returning the average child
 * count per tier and the fraction of total children in the top quartile.
 *
 * Returns undefined when there are fewer than 8 parents — the minimum needed
 * for four tiers of at least 2 parents each.
 */
async function profileRollupTiers(
  runner:       DatabaseQueryRunner,
  tableRef:     string,
  parentKeyCol: string,
  childKeyCol:  string,
): Promise<RollupTierProfile | undefined> {
  try {
    const rows = await runner.query(`
      SELECT
        ntile_bucket,
        AVG(children_per_parent)  AS avg_children,
        SUM(children_per_parent)  AS child_total,
        COUNT(*)                  AS parent_count
      FROM (
        SELECT
          children_per_parent,
          NTILE(4) OVER (ORDER BY children_per_parent) AS ntile_bucket
        FROM (
          SELECT ${q(parentKeyCol)},
                 COUNT(DISTINCT ${q(childKeyCol)}) AS children_per_parent
          FROM ${tableRef}
          WHERE ${q(parentKeyCol)} IS NOT NULL
          GROUP BY ${q(parentKeyCol)}
        ) counts
      ) tiered
      GROUP BY ntile_bucket
      ORDER BY ntile_bucket
    `);

    // Need all four buckets; bail if query returned fewer (e.g. too few parents)
    if (rows.length < 4) return undefined;

    // Verify minimum parent count in each tier
    const minParents = rows.reduce((m, r) => Math.min(m, num(r, "parent_count")), Infinity);
    if (minParents < 2) return undefined;

    const totalChildren = rows.reduce((s, r) => s + num(r, "child_total"), 0);
    if (totalChildren === 0) return undefined;

    const tier = (n: number) => rows.find((r) => num(r, "ntile_bucket") === n) ?? {};

    return {
      q1AvgChildren:   num(tier(1), "avg_children"),
      q2AvgChildren:   num(tier(2), "avg_children"),
      q3AvgChildren:   num(tier(3), "avg_children"),
      q4AvgChildren:   num(tier(4), "avg_children"),
      q4ChildFraction: num(tier(4), "child_total") / totalChildren,
    };
  } catch {
    // NTILE not supported or query failed — skip silently
    return undefined;
  }
}
