/**
 * Maps Tabular names onto the SML names the converter actually emitted.
 *
 * MDX needs fully-qualified `[Dimension].[Hierarchy].[Level]` paths, and only
 * the converter knows those: it chose the dimension names, collapsed role-play
 * families, and picked each hierarchy label. Guessing them produces MDX that
 * parses and then resolves to nothing at query time, so the translator takes a
 * resolver and flags whatever the resolver cannot confirm.
 *
 * `buildResolver` is fed from the converter's live maps in tabular-converter.ts.
 */

export type LevelPath = {
  dimension: string;
  hierarchy: string;
  level: string;
};

export const levelMdx = (p: LevelPath): string =>
  `[${p.dimension}].[${p.hierarchy}].[${p.level}]`;

export const currentMember = (p: LevelPath): string =>
  `[${p.dimension}].[${p.hierarchy}].CurrentMember`;

export const levelMember = (p: LevelPath, value: string): string =>
  `[${p.dimension}].[${p.hierarchy}].[${p.level}].[${value}]`;

export type NameResolver = {
  /** Tabular measure name -> MDX measure name, or undefined if absent. */
  resolveMeasure(name: string): string | undefined;
  /** Tabular table+column -> level path, or undefined if not a level. */
  resolveLevel(table: string, column: string): LevelPath | undefined;
  /** Table -> its dimension's default level, for ALL() pinning. */
  resolveDimensionDefault(table: string): LevelPath | undefined;
  /** Date table -> (dimension, hierarchy), or undefined if not a time dim. */
  resolveDateHierarchy(table: string): { dimension: string; hierarchy: string } | undefined;
  /** Date table -> its Year level, for ParallelPeriod. */
  resolveYearLevel(table: string): LevelPath | undefined;
};

export type ResolverInput = {
  /**
   * Measure names known to the target model.
   *
   * Held by reference, not copied: aggregation extraction mints new base
   * metrics while classification is running, and MDX emitted afterwards has to
   * be able to resolve them.
   */
  measures: ReadonlySet<string>;
  /**
   * Tabular table name -> the SML dimension `unique_name` it became. The
   * converter collapses role-play families, so this is not always identity.
   */
  dimensionOf: ReadonlyMap<string, string>;
  /** Dimension unique_name -> the level names it exposes. */
  levelsOf: ReadonlyMap<string, ReadonlySet<string>>;
  /**
   * Dimension unique_name -> its hierarchy unique_name.
   *
   * Recorded explicitly rather than derived: the converter names a standalone
   * dimension's hierarchy "<dimension> Hierarchy" but a consolidated role-play
   * family's hierarchy just "<label>". A convention would emit paths that
   * resolve to nothing for every role-played dimension.
   */
  hierarchyOf: ReadonlyMap<string, string>;
  /** Dimension unique_names whose SML `type` is `time`. */
  timeDimensions: ReadonlySet<string>;
  /** Dimension unique_name -> its default (base) level. */
  defaultLevelOf: ReadonlyMap<string, string>;
  /** Level name used for the year grain in time dimensions. */
  yearLevelOf?: ReadonlyMap<string, string>;
};

export function buildResolver(input: ResolverInput): NameResolver {
  const measures = input.measures;
  const yearLevels = input.yearLevelOf ?? new Map<string, string>();

  const dimensionFor = (table: string): string | undefined => input.dimensionOf.get(table);
  const hierarchyFor = (dimension: string): string | undefined => input.hierarchyOf.get(dimension);

  return {
    resolveMeasure(name) {
      return measures.has(name) ? name : undefined;
    },

    resolveLevel(table, column) {
      const dimension = dimensionFor(table);
      if (!dimension) return undefined;
      const levels = input.levelsOf.get(dimension);
      if (!levels || !levels.has(column)) return undefined;
      const hierarchy = hierarchyFor(dimension);
      if (!hierarchy) return undefined;
      return { dimension, hierarchy, level: column };
    },

    resolveDimensionDefault(table) {
      const dimension = dimensionFor(table);
      if (!dimension) return undefined;
      const level = input.defaultLevelOf.get(dimension);
      const hierarchy = hierarchyFor(dimension);
      if (!level || !hierarchy) return undefined;
      return { dimension, hierarchy, level };
    },

    resolveDateHierarchy(table) {
      const dimension = dimensionFor(table);
      if (!dimension || !input.timeDimensions.has(dimension)) return undefined;
      const hierarchy = hierarchyFor(dimension);
      if (!hierarchy) return undefined;
      return { dimension, hierarchy };
    },

    resolveYearLevel(table) {
      const dimension = dimensionFor(table);
      if (!dimension || !input.timeDimensions.has(dimension)) return undefined;
      const level = yearLevels.get(dimension);
      const hierarchy = hierarchyFor(dimension);
      if (!level || !hierarchy) return undefined;
      return { dimension, hierarchy, level };
    },
  };
}

/** A resolver that knows nothing -- every path lookup fails and is flagged. */
export const EMPTY_RESOLVER: NameResolver = {
  resolveMeasure: () => undefined,
  resolveLevel: () => undefined,
  resolveDimensionDefault: () => undefined,
  resolveDateHierarchy: () => undefined,
  resolveYearLevel: () => undefined,
};
