// ============================================================
// InferenceEngine
//
// Maintains a registry of InferencePlugins and orchestrates:
//   1. Vertical detection  — which plugin(s) apply to a table's columns
//   2. Hierarchy inference — generic base + activated vertical plugins
//   3. Measure inference   — vertical-specific additions
//
// Usage:
//   const engine = createDefaultEngine();
//   engine.addPlugin(myCustomPlugin);
//
//   const hierarchies = engine.inferHierarchies(columns, indexes);
//   const extraMeasures = engine.inferMeasures(columns);
// ============================================================

import { JdbcColumnMeta, JdbcIndexMeta, SemanticHierarchy, SemanticMeasure } from "../types.js";
import { inferHierarchies as baseInferHierarchies, hierarchyColumnSet } from "../hierarchy-inference.js";
import { InferencePlugin, InferenceEngineOptions, VerticalMatch } from "./plugin.js";

export class InferenceEngine {
  private readonly plugins: InferencePlugin[] = [];
  private readonly threshold: number;
  private readonly allowMultiple: boolean;

  constructor(
    plugins: InferencePlugin[] = [],
    options: InferenceEngineOptions = {},
  ) {
    this.plugins = [...plugins];
    this.threshold = options.detectionThreshold ?? 0.4;
    this.allowMultiple = options.allowMultipleVerticals ?? false;
  }

  // ----------------------------------------------------------
  // Plugin management
  // ----------------------------------------------------------

  /** Register one additional plugin. Returns `this` for chaining. */
  addPlugin(plugin: InferencePlugin): this {
    this.plugins.push(plugin);
    return this;
  }

  /** Replace a plugin by name. Throws if not found. */
  replacePlugin(name: string, replacement: InferencePlugin): this {
    const idx = this.plugins.findIndex((p) => p.name === name);
    if (idx === -1) throw new Error(`Plugin "${name}" not found in engine.`);
    this.plugins[idx] = replacement;
    return this;
  }

  /** Remove a plugin by name. Returns `this` for chaining. */
  removePlugin(name: string): this {
    const idx = this.plugins.findIndex((p) => p.name === name);
    if (idx !== -1) this.plugins.splice(idx, 1);
    return this;
  }

  /** Returns a read-only list of all registered plugins. */
  getPlugins(): ReadonlyArray<InferencePlugin> {
    return this.plugins;
  }

  // ----------------------------------------------------------
  // Detection
  // ----------------------------------------------------------

  /**
   * Run all plugins' detect() against the supplied columns and return matches
   * sorted by score descending.  Only matches at or above the threshold are
   * returned.
   */
  detectVerticals(columns: JdbcColumnMeta[]): VerticalMatch[] {
    const matches: VerticalMatch[] = this.plugins
      .map((plugin) => ({ plugin, score: plugin.detect(columns) }))
      .filter(({ score }) => score >= this.threshold)
      .sort((a, b) => b.score - a.score);

    if (!this.allowMultiple && matches.length > 1) {
      return [matches[0]];
    }
    return matches;
  }

  // ----------------------------------------------------------
  // Hierarchy inference
  // ----------------------------------------------------------

  /**
   * Full hierarchy inference pipeline:
   *   1. Generic base inference (index-based + naming conventions)
   *   2. Vertical-specific inference for detected plugin(s)
   *
   * Results are deduplicated: a column already used in a hierarchy
   * from an earlier step is not reused in a later step.
   */
  inferHierarchies(
    columns: JdbcColumnMeta[],
    indexes: JdbcIndexMeta[],
  ): { hierarchies: SemanticHierarchy[]; warnings: string[] } {
    // Step 1: generic base inference (returns hierarchies + any advisory warnings)
    const { hierarchies: baseHierarchies, warnings } = baseInferHierarchies(columns, indexes);
    const result: SemanticHierarchy[] = [...baseHierarchies];
    const used = hierarchyColumnSet(result);

    // Step 2: vertical plugin inference
    const matches = this.detectVerticals(columns);
    for (const { plugin } of matches) {
      const remaining = columns.filter((c) => !used.has(c.columnName.toLowerCase()));
      const vertical = plugin.inferHierarchies(remaining);

      for (const h of vertical) {
        // Only add hierarchies whose levels aren't already claimed
        const fresh = h.levels.filter((l) => !used.has(l.sourceColumn.toLowerCase()));
        if (fresh.length >= 2) {
          const dedupedHierarchy: SemanticHierarchy = { ...h, levels: fresh };
          result.push(dedupedHierarchy);
          fresh.forEach((l) => used.add(l.sourceColumn.toLowerCase()));
        }
      }
    }

    return { hierarchies: result, warnings };
  }

  // ----------------------------------------------------------
  // Measure inference
  // ----------------------------------------------------------

  /**
   * Returns vertical-specific SemanticMeasure additions from detected plugins.
   * The caller is responsible for merging these with the generic measure list.
   */
  inferMeasures(columns: JdbcColumnMeta[]): SemanticMeasure[] {
    const matches = this.detectVerticals(columns);
    return matches.flatMap(({ plugin }) => plugin.inferMeasures(columns));
  }

  // ----------------------------------------------------------
  // Diagnostic helpers
  // ----------------------------------------------------------

  /**
   * Returns all plugin scores for the supplied columns, regardless of
   * threshold.  Useful for debugging detection.
   */
  diagnose(columns: JdbcColumnMeta[]): Array<{ name: string; score: number }> {
    return this.plugins
      .map((p) => ({ name: p.name, score: p.detect(columns) }))
      .sort((a, b) => b.score - a.score);
  }
}
