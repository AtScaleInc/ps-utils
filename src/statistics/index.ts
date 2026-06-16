/**
 * src/statistics — statistical fingerprint algorithm for semantic layer data.
 *
 * Public API used by the extract-data-shape-from-connection operation (and any
 * future callers).
 *
 * Typical usage:
 *
 *   import { extractFingerprint, writeFingerprintFile } from "../statistics/index.js";
 *   import type { DatabaseQueryRunner } from "../statistics/index.js";
 *
 *   // Wrap your SqlService connection:
 *   const runner: DatabaseQueryRunner = {
 *     query: (sql) => sqlService.query(conn, sql),
 *   };
 *
 *   const fp = await extractFingerprint(runner, {
 *     smlPath:    "./sml-output",
 *     sampling:   { targetFactRows: 50_000 },
 *     onProgress: (msg) => logger.log(msg),
 *   });
 *
 *   writeFingerprintFile(fp, "./data-shape.yaml");
 */

// Types
export type {
  DatabaseQueryRunner,
  SamplingConfig,
  ModelGraph,
  FactNode,
  DimensionNode,
  HierarchyNode,
  LevelNode,
  JoinEdge,
  MeasureNode,
  SchemaFingerprint,
  DimensionFingerprint,
  HierarchyFingerprint,
  LevelFingerprint,
  RollupEdgeFingerprint,
  RollupTierProfile,
  FactFingerprint,
  JoinFingerprint,
  MeasureFingerprint,
  PairwiseMeasureCorrelation,
  FkAssociation,
  ConformedDimensionFingerprint,
  NumericDistribution,
  DistributionShape,
} from "./types.js";

export { DEFAULT_SAMPLING_CONFIG } from "./types.js";

// Core pipeline
export { extractFingerprint }           from "./extractor.js";
export type { ExtractOptions }          from "./extractor.js";
export { readModelGraph }               from "./sml-reader.js";
export { writeFingerprintFile, fingerprintToYaml, readFingerprintFile } from "./fingerprint.js";
export { generateDdl } from "./ddl-generator.js";
export type { SqlDialect, DdlOptions } from "./ddl-generator.js";

// Building blocks (available for custom pipelines or testing)
export { profileHierarchies }           from "./profilers/hierarchy.js";
export { profileFactJoins }             from "./profilers/density.js";
export { profileMeasures }              from "./profilers/columns.js";
export { profileConformedDimensions }   from "./profilers/conformed.js";
export { classifyShape }                from "./distribution.js";
export { computeRequiredSampleSize, buildSampleClause } from "./sampling.js";
export { IdMapper }                     from "./id-mapper.js";
