/**
 * Conformed dimension overlap profiler.
 *
 * A dimension is "conformed" when two or more fact tables reference it through
 * the same leaf level.  The overlap fraction measures what share of the
 * dimension's leaf members appear in BOTH facts — a critical input for
 * drill-across query planning.
 *
 * Overlap fraction = |members in F1 ∩ members in F2| / |leaf members in dim|
 */

import type {
  DatabaseQueryRunner,
  DimensionNode,
  FactNode,
  ConformedDimensionFingerprint,
  SamplingConfig,
} from "../types.js";
import { q, qualifyTable, num } from "../sql-helpers.js";
import type { IdMapper }        from "../id-mapper.js";

// ─── Public API ───────────────────────────────────────────────────────────────

export async function profileConformedDimensions(
  runner:     DatabaseQueryRunner,
  facts:      FactNode[],
  dimensions: DimensionNode[],
  _config:    SamplingConfig,
  idMapper:   IdMapper,
): Promise<ConformedDimensionFingerprint[]> {
  const dimByName = new Map(dimensions.map((d) => [d.uniqueName, d]));
  const results: ConformedDimensionFingerprint[] = [];

  // Build: dimName → [ { fact, fkCol, leafKeyCol } ]
  const dimJoins = new Map<string, Array<{
    fact:       FactNode;
    fkCol:      string;
    leafKeyCol: string;
  }>>();

  for (const fact of facts) {
    for (const edge of fact.joins) {
      const dim = dimByName.get(edge.toDimension);
      if (!dim) continue;

      const leafLevel = findLeafLevel(dim, edge.toLevel);
      const leafKeyCol = leafLevel?.keyColumns[0];
      const fkCol      = edge.fromColumns[0];
      if (!fkCol || !leafKeyCol) continue;

      const existing = dimJoins.get(dim.uniqueName) ?? [];
      existing.push({ fact, fkCol, leafKeyCol });
      dimJoins.set(dim.uniqueName, existing);
    }
  }

  // Only include dimensions that appear in 2+ facts
  for (const [dimName, joins] of dimJoins) {
    if (joins.length < 2) continue;

    const dim = dimByName.get(dimName)!;
    const dimTable = qualifyTable(dim.sourceSchema, dim.sourceTable);

    // Leaf member count for the denominator
    const leafKeyCol  = joins[0]!.leafKeyCol;
    const leafCntRows = await runner.query(`
      SELECT COUNT(DISTINCT ${q(leafKeyCol)}) AS leaf_count
      FROM ${dimTable}
    `);
    const leafCount = num(leafCntRows[0], "leaf_count");

    const factIds     = joins.map((j) => idMapper.factId(j.fact.uniqueName));
    const pairwise: ConformedDimensionFingerprint["pairwiseOverlap"] = [];

    // Compute pairwise overlap for every (Fi, Fj) pair
    for (let i = 0; i < joins.length - 1; i++) {
      for (let j = i + 1; j < joins.length; j++) {
        const ji = joins[i]!;
        const jj = joins[j]!;

        const fi = qualifyTable(ji.fact.sourceSchema, ji.fact.sourceTable);
        const fj = qualifyTable(jj.fact.sourceSchema, jj.fact.sourceTable);

        // Intersection: FK values present in BOTH fact tables
        const overlapRows = await runner.query(`
          SELECT COUNT(*) AS overlap_count
          FROM (
            SELECT DISTINCT ${q(ji.fkCol)} AS fk_val FROM ${fi}
            WHERE ${q(ji.fkCol)} IS NOT NULL
          ) a
          JOIN (
            SELECT DISTINCT ${q(jj.fkCol)} AS fk_val FROM ${fj}
            WHERE ${q(jj.fkCol)} IS NOT NULL
          ) b ON a.fk_val = b.fk_val
        `);
        const overlapCount   = num(overlapRows[0], "overlap_count");
        const overlapFraction = leafCount > 0 ? overlapCount / leafCount : 0;

        pairwise.push({
          factId1:         idMapper.factId(ji.fact.uniqueName),
          factId2:         idMapper.factId(jj.fact.uniqueName),
          overlapFraction: Math.min(1, overlapFraction),
        });
      }
    }

    results.push({
      dimensionId: idMapper.dimensionId(dimName),
      factIds,
      pairwiseOverlap: pairwise,
    });
  }

  return results;
}

// ─── Helper ───────────────────────────────────────────────────────────────────

function findLeafLevel(dim: DimensionNode, levelUniqueName: string) {
  for (const hier of dim.hierarchies) {
    const found = hier.levels.find((l) => l.uniqueName === levelUniqueName);
    if (found) return found;
  }
  return dim.hierarchies[0]?.levels.at(-1) ?? null;
}
