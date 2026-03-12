// ============================================================
// AbstractVerticalPlugin — convenience base class for verticals
//
// Vertical implementations extend this class and provide:
//   - signalPatterns    : column-name regexes that identify the vertical
//   - detectionThreshold: how many signal matches = score of 1.0
//   - verticalHierarchies: ordered level-pattern sequences
//
// The base class handles detect(), inferHierarchies(), and inferMeasures()
// using those declarations; subclasses override as needed.
// ============================================================

import { JdbcColumnMeta, SemanticHierarchy, SemanticMeasure, toTitleCase } from "../types.js";
import { InferencePlugin } from "./plugin.js";

// ----------------------------------------------------------
// Hierarchy sequence definition
// ----------------------------------------------------------

/**
 * Declares one named hierarchy as an ordered list of regex patterns.
 * Each pattern is tested against lowercased column names; the first
 * matching column for each level is used.  The hierarchy is emitted
 * only when ≥ minLevels patterns match.
 */
export interface HierarchySequence {
  name: string;
  /** Ordered from broadest → most granular. */
  levelPatterns: RegExp[];
  /** Minimum number of levels that must match to emit the hierarchy. Default: 2. */
  minLevels?: number;
}

// ----------------------------------------------------------
// Abstract base
// ----------------------------------------------------------

export abstract class AbstractVerticalPlugin implements InferencePlugin {
  abstract readonly name: string;
  abstract readonly description: string;

  /**
   * Column-name regexes that strongly indicate this vertical.
   * The more patterns match, the higher the detect() score.
   */
  protected abstract readonly signalPatterns: RegExp[];

  /**
   * Number of signal matches that yields a detect() score of 1.0.
   * Scores are capped at 1.0, so 2–4 is typically a good value.
   */
  protected abstract readonly detectionThreshold: number;

  /** Hierarchy sequences to attempt for this vertical. */
  protected abstract readonly verticalHierarchies: HierarchySequence[];

  // ----------------------------------------------------------
  // Default implementations
  // ----------------------------------------------------------

  detect(columns: JdbcColumnMeta[]): number {
    const lowerNames = columns.map((c) => c.columnName.toLowerCase());
    const matches = this.signalPatterns.filter((p) =>
      lowerNames.some((n) => p.test(n)),
    ).length;
    return Math.min(matches / this.detectionThreshold, 1.0);
  }

  inferHierarchies(columns: JdbcColumnMeta[]): SemanticHierarchy[] {
    const hierarchies: SemanticHierarchy[] = [];
    const usedColumns = new Set<string>();

    for (const seq of this.verticalHierarchies) {
      const hierarchy = this.buildHierarchy(columns, seq, usedColumns);
      if (hierarchy) {
        hierarchies.push(hierarchy);
        hierarchy.levels.forEach((l) => usedColumns.add(l.sourceColumn.toLowerCase()));
      }
    }

    return hierarchies;
  }

  /** Default: no additional measures. Subclasses override when needed. */
  inferMeasures(_columns: JdbcColumnMeta[]): SemanticMeasure[] {
    return [];
  }

  // ----------------------------------------------------------
  // Protected helpers available to subclasses
  // ----------------------------------------------------------

  /**
   * Attempt to build one SemanticHierarchy from an ordered sequence of
   * level patterns.  Returns null when fewer than minLevels columns match.
   */
  protected buildHierarchy(
    columns: JdbcColumnMeta[],
    seq: HierarchySequence,
    alreadyUsed: Set<string> = new Set(),
  ): SemanticHierarchy | null {
    const min = seq.minLevels ?? 2;
    const levels: Array<{ name: string; sourceColumn: string }> = [];

    for (const pattern of seq.levelPatterns) {
      const col = columns.find(
        (c) =>
          !alreadyUsed.has(c.columnName.toLowerCase()) &&
          pattern.test(c.columnName.toLowerCase()),
      );
      if (col) {
        levels.push({ name: toTitleCase(col.columnName), sourceColumn: col.columnName });
      }
    }

    if (levels.length < min) return null;

    return { name: seq.name, levels };
  }

  /** Find the first column matching a pattern (case-insensitive). */
  protected findColumn(
    columns: JdbcColumnMeta[],
    pattern: RegExp,
  ): JdbcColumnMeta | undefined {
    return columns.find((c) => pattern.test(c.columnName.toLowerCase()));
  }

  /** Find all columns matching a pattern (case-insensitive). */
  protected findColumns(
    columns: JdbcColumnMeta[],
    pattern: RegExp,
  ): JdbcColumnMeta[] {
    return columns.filter((c) => pattern.test(c.columnName.toLowerCase()));
  }
}
