/**
 * Extract OLAP hierarchy metadata from the model YAML and resolve xAxis
 * namespace field names to cacheHierarchy unique names.
 */
import type { HierarchyInfo } from "./types.js";

/**
 * Extract all OLAP hierarchies (dimensions + measures) from the model YAML.
 * Dimensions come from sql.columns (role=dimension) and mdx.columns (hierarchy tree).
 * Measures come from mdx.metrics.
 * Returns [] if the model is not found.
 */
export function extractModelHierarchies(
  models: Record<string, unknown>,
  modelName: string,
): HierarchyInfo[] {
  const model =
    (models[modelName] as Record<string, unknown> | undefined) ??
    (models[modelName.split(".").pop()!] as Record<string, unknown> | undefined) ??
    (models[modelName.split(".")[0]] as Record<string, unknown> | undefined);

  if (!model || typeof model !== "object") return [];

  const mdx = (model["mdx"] ?? {}) as Record<string, unknown>;
  const sql = (model["sql"] ?? {}) as Record<string, unknown>;
  const measureGroup = modelName.split(".").pop()!;

  const hierarchies: HierarchyInfo[] = [];

  // Dimensions: sql.columns has role:"dimension" + label metadata.
  // mdx.columns has a hierarchy tree (DimName -> HierarchyName -> levels) with
  // no role field, so it requires different parsing.
  //
  // We first build a map from mdx.columns so that sql.columns-derived entries
  // can inherit the authoritative leaf-level name from the hierarchy tree.
  // Use a Set to avoid duplicates when both sources describe the same dimension.
  const seenDimUniques = new Set<string>();

  // Build a lookup: hierUnique -> sorted levels array from mdx.columns
  // mdx.columns: { DimName: { HierarchyName: [{ caption, level_number, ... }, ...] } }
  type LevelEntry = { caption: string; queryName: string; levelNumber: number };
  const mdxLevels = new Map<string, LevelEntry[]>();
  const mdxLeafLevel = new Map<string, string>();
  // query_names of every level in the real hierarchy tree, so the sql.columns
  // fallback below can tell "this column IS a real attribute/level" apart from
  // "this column has no counterpart in mdx.attributes at all".
  const mdxLevelQueryNames = new Set<string>();

  // Real models store the hierarchy tree under mdx.attributes; some legacy or
  // test fixtures may use mdx.columns instead.  Accept either.
  const mdxCols = (mdx["attributes"] ?? mdx["columns"] ?? {}) as Record<string, unknown>;
  for (const [dimName, hierMap] of Object.entries(mdxCols)) {
    if (!hierMap || typeof hierMap !== "object") continue;
    for (const [hierName, rawLevels] of Object.entries(hierMap as Record<string, unknown>)) {
      const hierUnique = `[${dimName}].[${hierName}]`;
      const levelArr: LevelEntry[] = [];

      if (Array.isArray(rawLevels)) {
        for (const lv of rawLevels) {
          if (!lv || typeof lv !== "object") continue;
          const lvObj = lv as Record<string, unknown>;
          const qn = lvObj["query_name"] as string | undefined;
          levelArr.push({
            caption:     (lvObj["caption"] as string | undefined) ?? dimName,
            queryName:   qn ?? (lvObj["caption"] as string | undefined) ?? dimName,
            levelNumber: (lvObj["level_number"] as number | undefined) ?? 0,
          });
          if (qn) mdxLevelQueryNames.add(qn);
        }
        levelArr.sort((a, b) => a.levelNumber - b.levelNumber);
      }

      mdxLevels.set(hierUnique, levelArr);
      // Leaf = entry with the highest levelNumber. Use queryName (the real
      // MDX LEVEL_NAME), not caption — the two can differ, and MDX addressing
      // (".[LevelName].Members") requires the actual level name.
      const leaf = levelArr.at(-1);
      mdxLeafLevel.set(hierUnique, leaf?.queryName ?? dimName);
    }
  }

  // --- sql.columns (role: "dimension") ---
  // This is a fallback for columns with no real counterpart in mdx.attributes
  // (e.g. simpler models/test fixtures that only have sql.columns). When a
  // column IS a real attribute/level in mdx.attributes, skip synthesizing a
  // "[Label].[Label Hierarchy]" name here — it doesn't exist in the live cube,
  // and the real mdx.attributes-derived hierarchy is added below instead.
  const sqlCols = (sql["columns"] ?? {}) as Record<string, unknown>;
  for (const [colKey, colInfo] of Object.entries(sqlCols)) {
    if (!colInfo || typeof colInfo !== "object") continue;
    const ci = colInfo as Record<string, unknown>;
    if (ci["role"] !== "dimension") continue;

    const label = (ci["label"] as string | undefined) ?? colKey;
    if (mdxLevelQueryNames.has(colKey) || mdxLevelQueryNames.has(label)) continue;

    const dimName = label.replace(/ /g, "_");
    const dimUnique = `[${dimName}]`;
    const hierUnique = `[${dimName}].[${dimName} Hierarchy]`;

    if (seenDimUniques.has(hierUnique)) continue;
    seenDimUniques.add(hierUnique);

    // Prefer the leaf level caption from mdx.columns if available
    const leafLevelName = mdxLeafLevel.get(hierUnique) ?? dimName;

    hierarchies.push({
      uniqueName:              hierUnique,
      caption:                 `${dimName} Hierarchy`,
      defaultMemberUniqueName: `${hierUnique}.[All]`,
      allUniqueName:           `${hierUnique}.[All]`,
      dimensionUniqueName:     dimUnique,
      displayFolder:           (ci["folder"] as string | undefined) ?? "",
      isMeasure:               false,
      measureGroup:            null,
      leafLevelName,
      levels:                  mdxLevels.get(hierUnique) ?? [],
    });
  }

  // --- mdx.attributes / mdx.columns (hierarchy tree: DimName -> { HierarchyName: [...levels] }) ---
  for (const [dimName, hierMap] of Object.entries(mdxCols)) {
    if (!hierMap || typeof hierMap !== "object") continue;
    const dimUnique = `[${dimName}]`;
    for (const hierName of Object.keys(hierMap as Record<string, unknown>)) {
      const hierUnique = `[${dimName}].[${hierName}]`;
      if (seenDimUniques.has(hierUnique)) continue;
      seenDimUniques.add(hierUnique);

      const leafLevelName = mdxLeafLevel.get(hierUnique) ?? dimName;

      hierarchies.push({
        uniqueName:              hierUnique,
        caption:                 hierName,
        defaultMemberUniqueName: `${hierUnique}.[All]`,
        allUniqueName:           `${hierUnique}.[All]`,
        dimensionUniqueName:     dimUnique,
        displayFolder:           "",
        isMeasure:               false,
        measureGroup:            null,
        leafLevelName,
        levels:                  mdxLevels.get(hierUnique) ?? [],
      });
    }
  }

  // Measures: from mdx.metrics
  const metrics = mdx["metrics"] as unknown[] | undefined;
  if (Array.isArray(metrics)) {
    for (const metric of metrics) {
      if (!metric || typeof metric !== "object") continue;
      const m = metric as Record<string, unknown>;
      const queryName = (m["query_name"] as string | undefined) ?? "";
      if (!queryName) continue;

      hierarchies.push({
        uniqueName:              `[Measures].[${queryName}]`,
        caption:                 (m["caption"] as string | undefined) ?? queryName,
        displayFolder:           (m["folder"] as string | undefined) ?? "",
        isMeasure:               true,
        measureGroup,
        defaultMemberUniqueName: null,
        allUniqueName:           null,
        dimensionUniqueName:     null,
        leafLevelName:           null,
        levels:                  [],
      });
    }
  }

  return hierarchies;
}

/**
 * Resolve a namespace xAxis field name (e.g. "query_hour") to its
 * cacheHierarchy unique name (e.g. "[Query_Hour].[Query_Hour Hierarchy]").
 * Returns undefined if the field cannot be resolved.
 */
export function resolveXaxisUnique(
  xAxis: string | undefined,
  model: Record<string, unknown> | undefined,
  hierarchies: HierarchyInfo[],
): string | undefined {
  if (!xAxis) return undefined;

  // Strategy 0: exact match against a real hierarchy's caption. Hierarchies
  // sourced from mdx.attributes carry AtScale's actual hierarchy name as their
  // caption (e.g. "Order Quarter Number" under dimension "Order Date
  // Dimension"), which namespace xAxis values commonly reference directly.
  // This must run before the sql.columns-derived guess below, which
  // fabricates a "[Label].[Label Hierarchy]" name that may not exist in the
  // live cube at all.
  const exactCaption = hierarchies.find(
    h => !h.isMeasure && h.caption.toLowerCase() === xAxis.toLowerCase(),
  );
  if (exactCaption) return exactCaption.uniqueName;

  // Strategy 0.5: xAxis may name a single LEVEL inside a larger, shared
  // multi-level hierarchy (e.g. "Order Custom Year" is a level within the
  // "Order Custom PP445" hierarchy, not a hierarchy of its own). Search every
  // hierarchy's levels for a caption OR query_name match (the two can differ,
  // e.g. query_name "Order Year Week Hierarchy" vs caption "Order Year") and
  // return its owning hierarchy.
  const xLower = xAxis.toLowerCase();
  const ownerOfLevel = hierarchies.find(
    h => !h.isMeasure && h.levels.some(
      l => l.caption.toLowerCase() === xLower || l.queryName.toLowerCase() === xLower,
    ),
  );
  if (ownerOfLevel) return ownerOfLevel.uniqueName;

  // Strategy 1: look up in sql.columns via label
  if (model) {
    const sql = (model["sql"] ?? {}) as Record<string, unknown>;
    const cols = (sql["columns"] ?? {}) as Record<string, unknown>;
    const col = cols[xAxis] as Record<string, unknown> | undefined;
    if (col) {
      const label = (col["label"] as string | undefined) ?? xAxis;
      const dimName  = label.replace(/ /g, "_");
      const candidate = `[${dimName}].[${dimName} Hierarchy]`;
      if (hierarchies.some(h => h.uniqueName === candidate)) return candidate;
    }
  }

  // Strategy 2: fuzzy match on dimension unique name
  const xNorm = xAxis.toLowerCase().replace(/[_ ]/g, "");
  for (const h of hierarchies) {
    if (h.isMeasure) continue;
    const dimNorm = (h.dimensionUniqueName ?? "")
      .replace(/^\[|\]$/g, "")
      .toLowerCase()
      .replace(/[_ ]/g, "");
    if (xNorm === dimNorm) return h.uniqueName;
  }

  return undefined;
}

/**
 * Return the level caption from a hierarchy whose name matches `granularity`
 * (case-insensitive substring match, e.g. "week" matches "Week" or "Weekly").
 * Returns null if no matching level is found (caller should fall back to leaf level).
 */
export function levelForGranularity(
  hier: import("./types.js").HierarchyInfo,
  granularity: string,
): string | null {
  if (!granularity || hier.levels.length === 0) return null;
  const g = granularity.toLowerCase();
  // Match against the human-readable caption (e.g. "week" substring-matches
  // "Order Custom Week"), but return queryName — the real MDX LEVEL_NAME,
  // which can differ from caption and is what addressing requires.
  const match = hier.levels.find(l => l.caption.toLowerCase().includes(g));
  return match?.queryName ?? null;
}

/**
 * Look up a model object by name (tries full name, last component, first component).
 */
export function getModelObj(
  models: Record<string, unknown>,
  modelName: string,
): Record<string, unknown> | undefined {
  return (
    (models[modelName] as Record<string, unknown> | undefined) ??
    (models[modelName.split(".").pop()!] as Record<string, unknown> | undefined) ??
    (models[modelName.split(".")[0]] as Record<string, unknown> | undefined)
  );
}
