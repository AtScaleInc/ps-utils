/**
 * Statistical fingerprint extractor — main orchestrator.
 *
 * Coordinates all profiling passes in the correct dependency order:
 *
 *   1. Parse the SML model into a ModelGraph
 *   2. Profile each dimension (hierarchy level chain + rollup ratios)
 *   3. Profile each fact (density distributions, measure columns)
 *   4. Apply cold-member fractions to leaf levels (uses density pass output)
 *   5. Profile conformed dimension overlap (cross-fact)
 *   6. Assemble and return a SchemaFingerprint
 *
 * Callers may also pass a pre-built ModelGraph (e.g. from an in-memory SML
 * object) instead of a file path.
 */

import type {
  DatabaseQueryRunner,
  DimensionFingerprint,
  FactFingerprint,
  HierarchyFingerprint,
  LevelFingerprint,
  SamplingConfig,
  SchemaFingerprint,
  ModelGraph,
} from "./types.js";
import { DEFAULT_SAMPLING_CONFIG } from "./types.js";
import { readModelGraph }           from "./sml-reader.js";
import { IdMapper }                 from "./id-mapper.js";
import { profileHierarchies }       from "./profilers/hierarchy.js";
import { profileFactJoins }         from "./profilers/density.js";
import { profileMeasures }          from "./profilers/columns.js";
import { profileConformedDimensions } from "./profilers/conformed.js";
import { countRows }                from "./sql-helpers.js";

// ─── Public API ───────────────────────────────────────────────────────────────

export interface ExtractOptions {
  /**
   * Path to the SML output directory or a model.yml file.
   * Required unless `modelGraph` is provided directly.
   */
  smlPath?: string;

  /**
   * Pre-built model graph. When provided, `smlPath` is ignored.
   */
  modelGraph?: ModelGraph;

  /** Sampling tuning. Defaults to DEFAULT_SAMPLING_CONFIG. */
  sampling?: Partial<SamplingConfig>;

  /** Optional progress callback called before each major step. */
  onProgress?: (message: string) => void;
}

/**
 * Run the full profiling pipeline and return a SchemaFingerprint.
 *
 * @param runner   Database query runner (wraps SqlService + SqlConnection)
 * @param options  Extraction options (SML path, sampling config, etc.)
 */
export async function extractFingerprint(
  runner:  DatabaseQueryRunner,
  options: ExtractOptions,
): Promise<SchemaFingerprint> {
  const config: SamplingConfig = { ...DEFAULT_SAMPLING_CONFIG, ...(options.sampling ?? {}) };
  const log = options.onProgress ?? (() => undefined);

  // ── Step 1: Parse SML model ─────────────────────────────────────────────────
  log("Parsing SML model…");
  const graph: ModelGraph = options.modelGraph
    ?? readModelGraph(options.smlPath ?? process.cwd());

  const idMapper  = new IdMapper();
  const dimByName = new Map(graph.dimensions.map((d) => [d.uniqueName, d]));

  // ── Step 2: Profile dimensions ──────────────────────────────────────────────
  log(`Profiling ${graph.dimensions.length} dimension(s)…`);
  const dimFingerprints: DimensionFingerprint[] = [];

  for (const dim of graph.dimensions) {
    log(`  Dimension: ${dim.sourceTable}`);
    const rowCount   = await countRows(runner, dim.sourceSchema, dim.sourceTable);
    const hierarchies = await profileHierarchies(runner, dim, config, idMapper);

    dimFingerprints.push({
      id:         idMapper.dimensionId(dim.uniqueName),
      rowCount,
      hierarchies,
    });
  }

  // ── Step 3: Profile facts ────────────────────────────────────────────────────
  log(`Profiling ${graph.facts.length} fact table(s)…`);
  const factFingerprints: FactFingerprint[] = [];

  // Accumulate cold-member fractions from all density passes
  // Key: leafLevelId, Value: coldMemberFraction (last writer wins — typically only one fact joins to a given leaf)
  const coldMembersByLevel = new Map<string, number>();

  for (const fact of graph.facts) {
    log(`  Fact: ${fact.sourceTable}`);
    const rowCount = await countRows(runner, fact.sourceSchema, fact.sourceTable);

    log(`    → density profiling (${fact.joins.length} join(s))…`);
    const { joins, coldMembers, fkAssociations } = await profileFactJoins(
      runner, fact, dimByName, config, idMapper,
    );
    for (const [levelId, fraction] of coldMembers) {
      coldMembersByLevel.set(levelId, fraction);
    }

    log(`    → measure profiling (${fact.measures.length} measure(s))…`);
    const { measures, correlations: measureCorrelations } =
      await profileMeasures(runner, fact, config, idMapper);

    factFingerprints.push({
      id: idMapper.factId(fact.uniqueName),
      rowCount,
      joins,
      measures,
      ...(measureCorrelations ? { measureCorrelations } : {}),
      ...(fkAssociations      ? { fkAssociations }      : {}),
    });
  }

  // ── Step 4: Apply cold-member fractions to leaf level fingerprints ───────────
  applyCold(dimFingerprints, coldMembersByLevel);

  // ── Step 5: Conformed dimension overlap ──────────────────────────────────────
  log("Profiling conformed dimension overlap…");
  const conformedFps = await profileConformedDimensions(
    runner, graph.facts, graph.dimensions, config, idMapper,
  );

  // ── Step 6: Assemble fingerprint ─────────────────────────────────────────────
  log("Assembling fingerprint…");
  return {
    version:    "2.0",
    capturedAt: new Date().toISOString(),
    sampling: {
      targetFactRows:   config.targetFactRows,
      targetColumnRows: config.targetColumnRows,
      confidenceLevel:  config.confidenceLevel,
      marginOfError:    config.marginOfError,
    },
    dimensions:          dimFingerprints,
    facts:               factFingerprints,
    conformedDimensions: conformedFps,
  };
}

// ─── Cold-member annotation ───────────────────────────────────────────────────

/**
 * Walk the dimension fingerprints and stamp coldMemberFraction onto each
 * leaf level whose ID appears in the map produced by the density profiler.
 */
function applyCold(
  dimensions:         DimensionFingerprint[],
  coldMembersByLevel: Map<string, number>,
): void {
  if (coldMembersByLevel.size === 0) return;

  for (const dim of dimensions) {
    for (const hier of dim.hierarchies) {
      for (const level of hier.levels) {
        if (level.role === "leaf" && coldMembersByLevel.has(level.id)) {
          (level as LevelFingerprint).coldMemberFraction =
            coldMembersByLevel.get(level.id)!;
        }
      }
    }
  }
}

// ─── Re-export for convenience ────────────────────────────────────────────────

export { readModelGraph } from "./sml-reader.js";
export { writeFingerprintFile, fingerprintToYaml } from "./fingerprint.js";
