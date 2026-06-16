// ============================================================
// InferencePlugin — the contract every vertical plugin must satisfy
// ============================================================

import { ColumnMeta, SemanticHierarchy, SemanticMeasure } from "../types.js";

// ----------------------------------------------------------
// Core interface
// ----------------------------------------------------------

/**
 * A vertical inference plugin encapsulates domain knowledge for a specific
 * industry (e.g. Financial Services, Healthcare, Retail).
 *
 * The InferenceEngine calls detect() on every plugin for each dimension table,
 * then activates plugins whose score meets the configured threshold.
 *
 * To add a custom vertical:
 *   1. Implement this interface (or extend AbstractVerticalPlugin).
 *   2. Register the instance with InferenceEngine.addPlugin().
 */
export interface InferencePlugin {
  /** Unique, human-readable vertical name (e.g. "Financial Services"). */
  readonly name: string;

  /** One-sentence description of what this plugin covers. */
  readonly description: string;

  /**
   * Returns a confidence score in [0, 1] indicating how strongly the given
   * columns suggest this vertical.
   *
   * - 0.0  → no evidence
   * - 0.3+ → worth considering (below typical threshold)
   * - 0.6+ → moderate confidence
   * - 1.0  → maximum confidence
   *
   * The engine calls this for every table and activates the plugin only when
   * the score meets or exceeds the configured detectionThreshold.
   */
  detect(columns: ColumnMeta[]): number;

  /**
   * Infer vertical-specific hierarchies from the supplied columns.
   * Only called when detect() returns at or above the threshold.
   * Return an empty array when no hierarchies are applicable.
   */
  inferHierarchies(columns: ColumnMeta[]): SemanticHierarchy[];

  /**
   * Infer vertical-specific measures (additional aggregations beyond the
   * generic column-name rules in measure-inference.ts).
   * Return an empty array when not applicable.
   */
  inferMeasures(columns: ColumnMeta[]): SemanticMeasure[];
}

// ----------------------------------------------------------
// Supporting types
// ----------------------------------------------------------

/** Result of running detect() across all registered plugins. */
export interface VerticalMatch {
  plugin: InferencePlugin;
  /** Raw detect() score in [0, 1]. */
  score: number;
}

/** Options for InferenceEngine. */
export interface InferenceEngineOptions {
  /**
   * Minimum detect() score to activate a plugin for a given table.
   * Default: 0.4
   */
  detectionThreshold?: number;

  /**
   * When true, all plugins whose score ≥ threshold are activated and their
   * results merged.  When false (default), only the highest-scoring plugin
   * fires (ties are resolved alphabetically by plugin name).
   */
  allowMultipleVerticals?: boolean;
}
