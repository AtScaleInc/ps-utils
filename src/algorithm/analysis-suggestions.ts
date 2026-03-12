// ============================================================
// Business Analysis Suggestion Generator
//
// Given a completed SemanticModel, produces a ranked list of
// measure × hierarchy pairs and tuples that are likely to yield
// valuable business insights.
//
// Terminology:
//   Pair  — one measure analysed across one hierarchy
//           e.g. "Total Revenue by Product Category"
//   Tuple — one measure analysed across two or more hierarchies
//           e.g. "Total Revenue by Product Category over Time"
//
// Scoring:
//   Each suggestion receives a relevanceScore in [0, 1] derived
//   from three additive factors:
//     1. Measure value    — financial SUM > quantity SUM > ratio AVG > other
//     2. Hierarchy value  — time > geography > product > org > other
//     3. Combination bonus — classic cross-industry analytical patterns
//
// Output is sorted by relevanceScore descending and capped at
// SuggestionOptions.maxSuggestions (default 25).
// ============================================================

import {
  AggregationType,
  SemanticModel,
  SemanticFact,
  SemanticMeasure,
  SemanticDimension,
  SemanticHierarchy,
  SemanticRelationship,
} from "./types.js";

// ----------------------------------------------------------
// Public types
// ----------------------------------------------------------

/** The shape of business question this analysis answers. */
export type AnalysisType =
  | "trend"        // measure over time — "How is X changing?"
  | "breakdown"    // measure by one non-time dimension — "How does X break down by Y?"
  | "comparison"   // measure across time AND at least one other dimension
  | "distribution" // how X is spread across the levels of a hierarchy
  | "ranking";     // which members rank highest / lowest on a measure

export interface MeasureRef {
  factName: string;
  measureName: string;
  sourceColumn: string;
  aggregation: AggregationType;
}

export interface HierarchyRef {
  dimensionName: string;
  hierarchyName: string;
  /** Ordered level names, broadest → most granular. */
  levels: string[];
}

export interface AnalysisSuggestion {
  /**
   * Short, human-readable business question this analysis answers.
   * e.g. "Total Revenue by Product Category over Time"
   */
  title: string;
  /** Explanation of why this combination is analytically valuable. */
  description: string;
  analysisType: AnalysisType;
  measure: MeasureRef;
  /**
   * Hierarchies to analyse by.
   * - Length 1 → pair
   * - Length 2+ → tuple
   */
  hierarchies: HierarchyRef[];
  /** Relevance score [0, 1]. Higher = more likely to be business-valuable. */
  relevanceScore: number;
  /** Descriptive tags for filtering and grouping suggestions. */
  tags: string[];
}

export interface SuggestionOptions {
  /**
   * Maximum number of suggestions to return.
   * Default: 25
   */
  maxSuggestions?: number;
  /**
   * Minimum relevance score [0, 1] for a suggestion to be included.
   * Default: 0.5
   */
  minRelevanceScore?: number;
  /**
   * When true, also generate tuple suggestions (measure × 2 hierarchies).
   * When false, only pairs are generated.
   * Default: true
   */
  includeTuples?: boolean;
  /**
   * When true, also generate tuple suggestions spanning 3 hierarchies.
   * Default: false (can produce a large number of suggestions)
   */
  includeTriples?: boolean;
}

// ----------------------------------------------------------
// Hierarchy classification
//
// Each hierarchy is assigned a class by scanning its name and level names
// for domain keywords.  The first matching rule wins (order is significant).
// ----------------------------------------------------------

type HierarchyClass =
  | "time"
  | "geography"
  | "product"
  | "customer"
  | "organization"
  | "financial"
  | "clinical"
  | "network"
  | "other";

const HIERARCHY_CLASS_RULES: Array<{ pattern: RegExp; class: HierarchyClass }> = [
  { pattern: /time|date|fiscal|calendar|period|year|quarter|month|week|day|hour|interval/i, class: "time" },
  { pattern: /geo|geography|location|region|country|state|city|zip|territory|market|district|store|dma/i, class: "geography" },
  { pattern: /product|sku|category|department|brand|item|inventory|bom|taxonomy/i, class: "product" },
  { pattern: /customer|segment|tier|loyalty|member|audience|subscriber/i, class: "customer" },
  { pattern: /org|organization|department|division|business_unit|team|employee|headcount|workforce/i, class: "organization" },
  { pattern: /portfolio|fund|asset|gics|exchange|industry|sector|credit|listing/i, class: "financial" },
  { pattern: /clinical|diagnosis|icd|cpt|drg|facility|provider|payer|drug|pharmacy/i, class: "clinical" },
  { pattern: /network|topology|cell|feeder|substation|carrier|route|flight|telecom/i, class: "network" },
];

function classifyHierarchy(hierarchy: SemanticHierarchy): HierarchyClass {
  const text = [
    hierarchy.name,
    ...hierarchy.levels.map((l) => l.name),
  ].join(" ").toLowerCase();

  for (const rule of HIERARCHY_CLASS_RULES) {
    if (rule.pattern.test(text)) return rule.class;
  }
  return "other";
}

// ----------------------------------------------------------
// Measure classification
// ----------------------------------------------------------

type MeasureClass =
  | "financial_sum"   // SUM of revenue, cost, price, etc.
  | "quantity_sum"    // SUM of units, orders, count
  | "ratio"           // AVG of rate, pct, score
  | "duration_sum"    // SUM of elapsed time, LOS, etc.
  | "other_sum"       // SUM of something unrecognised
  | "other_avg"       // AVG of something unrecognised
  | "other";

const FINANCIAL_PATTERN =
  /cost|price|amount|revenue|sales|gross|net|fee|charge|spend|budget|expense|profit|margin|discount|tax|salary|wage|earning|payment|total/i;
const QUANTITY_PATTERN =
  /qty|quantity|units|volume|count|num_|number_of|pieces|items|orders|transactions|shipments/i;
const RATIO_PATTERN =
  /rate|ratio|pct|percent|percentage|share|proportion|factor|score|index|yield|efficiency|utilization/i;
const DURATION_PATTERN =
  /duration|elapsed|latency|delay|lead_time|cycle_time|age|tenure|days|hours|minutes|seconds|los|stay/i;

function classifyMeasure(measure: SemanticMeasure): MeasureClass {
  const col = measure.sourceColumn.toLowerCase();
  const agg = measure.aggregation;

  if (agg === "SUM") {
    if (FINANCIAL_PATTERN.test(col)) return "financial_sum";
    if (QUANTITY_PATTERN.test(col)) return "quantity_sum";
    if (DURATION_PATTERN.test(col)) return "duration_sum";
    return "other_sum";
  }
  if (agg === "AVG") {
    if (RATIO_PATTERN.test(col)) return "ratio";
    return "other_avg";
  }
  return "other";
}

// ----------------------------------------------------------
// Scoring tables
//
// A suggestion's relevanceScore is the average of its component base scores
// (measure + hierarchy) plus a combination bonus that rewards analytically
// proven patterns (e.g., financial revenue × time = classic trend analysis).
//
// Base scores reflect how broadly useful the measure/hierarchy type is across
// industries.  Financial SUM measures (revenue, cost) and time hierarchies
// score highest because they appear in virtually every analytical workload.
//
// Combination bonuses are additive and capped so the final score stays ≤ 1.0.
// ----------------------------------------------------------

/** Base value of a measure class [0, 1]. Higher = more universally useful. */
const MEASURE_BASE_SCORE: Record<MeasureClass, number> = {
  financial_sum: 0.90,  // Revenue, cost, profit — core KPIs in every industry
  quantity_sum:  0.80,  // Units, orders, transactions — operationally critical
  ratio:         0.72,  // Rates and percentages — important but context-specific
  duration_sum:  0.68,  // Elapsed time / LOS — key in ops, healthcare, logistics
  other_sum:     0.60,  // Unrecognised summable numeric
  other_avg:     0.52,  // Unrecognised average
  other:         0.40,  // MIN/MAX or unclassifiable
};

/** Base value of a hierarchy class [0, 1]. Higher = more universally useful. */
const HIERARCHY_BASE_SCORE: Record<HierarchyClass, number> = {
  time:         0.90,  // Time hierarchies are relevant to almost every measure
  product:      0.82,  // Product breakdown is the second most common slice
  geography:    0.80,  // Geographic drill-down is near-universal
  customer:     0.75,  // Customer segmentation is common in B2C/B2B analytics
  financial:    0.78,  // Financial hierarchies (GICS, fund) are highly specific
  clinical:     0.72,  // Clinical classification is critical in healthcare
  organization: 0.65,  // Org hierarchies are useful for cost/HR analysis
  network:      0.62,  // Network/topology hierarchies are domain-specific
  other:        0.50,  // Unclassified
};

/**
 * Bonus applied when a specific measure class is combined with a specific
 * hierarchy class — reflects classic cross-industry analytical patterns.
 * Keys: `${measureClass}:${hierarchyClass}` → bonus in [0, 0.15].
 *
 * Only the most proven pairings receive a bonus; unlisted combos get 0.
 */
const COMBINATION_BONUS: Record<string, number> = {
  // "Revenue over Time" is the single most-requested analysis pattern
  "financial_sum:time":         0.12,
  "financial_sum:product":      0.10,
  "financial_sum:geography":    0.10,
  "financial_sum:customer":     0.09,
  "financial_sum:financial":    0.09,
  // Volume trends and product mix are core operations analytics
  "quantity_sum:time":          0.10,
  "quantity_sum:product":       0.10,
  "quantity_sum:geography":     0.08,
  "quantity_sum:customer":      0.07,
  // Rate/KPI trending is widely used for performance tracking
  "ratio:time":                 0.09,
  "ratio:product":              0.07,
  "ratio:customer":             0.07,
  // Healthcare-specific: LOS by facility, volume by DRG
  "duration_sum:clinical":      0.10,
  "duration_sum:time":          0.08,
  "duration_sum:organization":  0.07,
  "quantity_sum:clinical":      0.09,
};

function scorePair(
  measureClass: MeasureClass,
  hierarchyClass: HierarchyClass,
): number {
  const base =
    (MEASURE_BASE_SCORE[measureClass] + HIERARCHY_BASE_SCORE[hierarchyClass]) / 2;
  const bonus = COMBINATION_BONUS[`${measureClass}:${hierarchyClass}`] ?? 0;
  return Math.min(base + bonus, 1.0);
}

/**
 * Extra bonus for tuple combinations (measure × 2 hierarchies).
 * A tuple earns a bonus when the two hierarchies are orthogonal — e.g.,
 * analysing revenue by Product AND by Time is more valuable than either alone
 * because it enables comparison across both dimensions simultaneously.
 *
 * Keys are order-independent: `time:product` === `product:time`.
 * Unlisted pairs receive a small default bonus (0.03) to reflect the inherent
 * value of multi-dimensional analysis even for less-proven combinations.
 */
const TUPLE_COMBINATION_BONUS: Record<string, number> = {
  "time:product":      0.10,  // Classic: sales/volume trend by product
  "time:geography":    0.10,  // Classic: regional performance over time
  "time:financial":    0.09,  // Portfolio or sector performance over time
  "time:customer":     0.08,  // Customer cohort / retention analysis
  "product:geography": 0.08,  // Regional product mix / market basket
  "product:customer":  0.07,  // Customer × product affinity
  "geography:customer":0.07,  // Regional customer segmentation
  "time:organization": 0.06,  // Headcount / cost by org over time
  "time:clinical":     0.08,  // Episode / admission trends over time
  "clinical:geography":0.06,  // Geographic variation in clinical outcomes
};

/** Default bonus (0.03) when the pair of hierarchy classes is not in the bonus table. */
const DEFAULT_TUPLE_BONUS = 0.03;

function tupleBonusForPair(classA: HierarchyClass, classB: HierarchyClass): number {
  return (
    TUPLE_COMBINATION_BONUS[`${classA}:${classB}`] ??
    TUPLE_COMBINATION_BONUS[`${classB}:${classA}`] ??
    DEFAULT_TUPLE_BONUS
  );
}

// ----------------------------------------------------------
// Title and description generation
// ----------------------------------------------------------

function buildPairTitle(
  measure: SemanticMeasure,
  hierarchy: SemanticHierarchy,
  hClass: HierarchyClass,
): string {
  if (hClass === "time") {
    return `${measure.name} Over Time`;
  }
  return `${measure.name} by ${hierarchy.name.replace(/ Hierarchy$/, "")}`;
}

function buildTupleTitle(
  measure: SemanticMeasure,
  hierarchies: Array<{ h: SemanticHierarchy; hClass: HierarchyClass }>,
): string {
  // When one of the hierarchies is time, put it last ("... Over Time") which
  // matches natural business language.
  const timeH = hierarchies.find(({ hClass }) => hClass === "time");
  const others = hierarchies.filter(({ hClass }) => hClass !== "time");

  if (timeH && others.length === 1) {
    return `${measure.name} by ${others[0].h.name.replace(/ Hierarchy$/, "")} Over Time`;
  }
  const dimNames = hierarchies
    .map(({ h }) => h.name.replace(/ Hierarchy$/, ""))
    .join(" and ");
  return `${measure.name} by ${dimNames}`;
}

function buildDescription(
  measure: SemanticMeasure,
  mClass: MeasureClass,
  hierarchies: Array<{ h: SemanticHierarchy; hClass: HierarchyClass }>,
  analysisType: AnalysisType,
): string {
  // Strip the " Hierarchy" suffix from names to produce natural-language text
  const hierNames = hierarchies
    .map(({ h }) => `**${h.name.replace(/ Hierarchy$/, "")}**`)
    .join(" and ");

  switch (analysisType) {
    case "trend":
      return `Track how ${measure.name} changes over time using the ${hierNames} hierarchy. ` +
        `Useful for identifying seasonality, growth trends, and forecasting.`;

    case "breakdown":
      return `Decompose ${measure.name} across ${hierNames} to identify top and bottom ` +
        `contributors and reveal performance disparities.`;

    case "comparison":
      return `Cross-analyse ${measure.name} by ${hierNames} to see how performance ` +
        `differs across segments at each point in time — supports period-over-period comparisons.`;

    case "distribution":
      return `Understand how ${measure.name} is distributed across the levels of ${hierNames}. ` +
        `Highlights concentration, long tails, and outliers.`;

    case "ranking":
      return `Rank members of ${hierNames} by their ${measure.name} to surface top ` +
        `performers and identify areas needing attention.`;
  }
}

function determineAnalysisType(
  hierarchies: Array<{ h: SemanticHierarchy; hClass: HierarchyClass }>,
  mClass: MeasureClass,
): AnalysisType {
  const hasTime = hierarchies.some(({ hClass }) => hClass === "time");
  const count = hierarchies.length;

  if (hasTime && count === 1) return "trend";
  if (hasTime && count > 1) return "comparison";
  if (mClass === "ratio" || mClass === "other_avg") return "distribution";
  if (count === 1) return "breakdown";
  return "ranking";
}

function buildTags(
  mClass: MeasureClass,
  hierarchies: Array<{ h: SemanticHierarchy; hClass: HierarchyClass }>,
  analysisType: AnalysisType,
  factName: string,
): string[] {
  const tags = new Set<string>([analysisType, factName.toLowerCase()]);
  tags.add(mClass.replace(/_/g, "-"));
  hierarchies.forEach(({ hClass }) => tags.add(hClass));
  return Array.from(tags);
}

// ----------------------------------------------------------
// Main generator
// ----------------------------------------------------------

/**
 * Build a map of dimension name → dimension for quick lookup.
 */
function buildDimensionMap(
  dimensions: SemanticDimension[],
): Map<string, SemanticDimension> {
  return new Map(dimensions.map((d) => [d.name, d]));
}

/**
 * For a given fact, find all dimensions that are directly joined to it
 * (via relationships where fromDataset === fact.name).
 */
function findConnectedDimensions(
  fact: SemanticFact,
  relationships: SemanticRelationship[],
  dimensionMap: Map<string, SemanticDimension>,
): SemanticDimension[] {
  const connected: SemanticDimension[] = [];
  for (const rel of relationships) {
    if (rel.fromDataset === fact.name) {
      const dim = dimensionMap.get(rel.toDataset);
      if (dim) connected.push(dim);
    }
  }
  return connected;
}

/**
 * Generate all pair and (optionally) tuple/triple suggestions for a given fact.
 *
 * Generation strategy:
 *   1. Pairs   — every measure × every connected hierarchy
 *   2. Tuples  — every measure × every ordered pair of distinct hierarchies
 *   3. Triples — every measure × every ordered triple of distinct hierarchies
 *
 * Combinations that score below opts.minRelevanceScore are discarded early to
 * keep output manageable before final deduplication and sorting.
 */
function suggestionsForFact(
  fact: SemanticFact,
  connectedDimensions: SemanticDimension[],
  opts: Required<SuggestionOptions>,
): AnalysisSuggestion[] {
  const suggestions: AnalysisSuggestion[] = [];

  // Flatten all connected dimension hierarchies into a single classified list.
  // Each entry carries the parent dimension (needed for HierarchyRef) and the
  // pre-computed HierarchyClass (avoids re-classifying in the inner loops).
  type ClassifiedHierarchy = {
    dim: SemanticDimension;
    h: SemanticHierarchy;
    hClass: HierarchyClass;
  };

  const allHierarchies: ClassifiedHierarchy[] = connectedDimensions.flatMap((dim) =>
    dim.hierarchies.map((h) => ({ dim, h, hClass: classifyHierarchy(h) })),
  );

  for (const measure of fact.measures) {
    const mClass = classifyMeasure(measure);

    // Build the measure reference once; reused by all suggestions for this measure.
    const measureRef: MeasureRef = {
      factName: fact.name,
      measureName: measure.name,
      sourceColumn: measure.sourceColumn,
      aggregation: measure.aggregation,
    };

    // ------------------------------------------------------------------
    // Step 1: Pairs — one measure × one hierarchy
    // ------------------------------------------------------------------
    for (const { dim, h, hClass } of allHierarchies) {
      const score = scorePair(mClass, hClass);
      if (score < opts.minRelevanceScore) continue;

      const pairContext = [{ h, hClass }];
      const analysisType = determineAnalysisType(pairContext, mClass);

      suggestions.push({
        title: buildPairTitle(measure, h, hClass),
        description: buildDescription(measure, mClass, pairContext, analysisType),
        analysisType,
        measure: measureRef,
        hierarchies: [
          {
            dimensionName: dim.name,
            hierarchyName: h.name,
            levels: h.levels.map((l) => l.name),
          },
        ],
        relevanceScore: score,
        tags: buildTags(mClass, pairContext, analysisType, fact.name),
      });
    }

    if (!opts.includeTuples) continue;

    // ------------------------------------------------------------------
    // Step 2: Tuples — one measure × two hierarchies from distinct dimensions
    // ------------------------------------------------------------------
    for (let i = 0; i < allHierarchies.length; i++) {
      for (let j = i + 1; j < allHierarchies.length; j++) {
        const hierA = allHierarchies[i];
        const hierB = allHierarchies[j];

        // Hierarchies from the same dimension are correlated, not orthogonal —
        // skip them to avoid misleading multi-dimensional analysis suggestions.
        if (hierA.dim.name === hierB.dim.name) continue;

        // Tuple score = average of the two pair scores + orthogonality bonus
        const avgPairScore = (scorePair(mClass, hierA.hClass) + scorePair(mClass, hierB.hClass)) / 2;
        const orthogonalityBonus = tupleBonusForPair(hierA.hClass, hierB.hClass);
        const tupleScore = Math.min(avgPairScore + orthogonalityBonus, 1.0);

        if (tupleScore < opts.minRelevanceScore) continue;

        const tupleContext = [
          { h: hierA.h, hClass: hierA.hClass },
          { h: hierB.h, hClass: hierB.hClass },
        ];
        const analysisType = determineAnalysisType(tupleContext, mClass);

        suggestions.push({
          title: buildTupleTitle(measure, tupleContext),
          description: buildDescription(measure, mClass, tupleContext, analysisType),
          analysisType,
          measure: measureRef,
          hierarchies: [
            {
              dimensionName: hierA.dim.name,
              hierarchyName: hierA.h.name,
              levels: hierA.h.levels.map((l) => l.name),
            },
            {
              dimensionName: hierB.dim.name,
              hierarchyName: hierB.h.name,
              levels: hierB.h.levels.map((l) => l.name),
            },
          ],
          relevanceScore: tupleScore,
          tags: buildTags(mClass, tupleContext, analysisType, fact.name),
        });

        if (!opts.includeTriples) continue;

        // ---------------------------------------------------------------
        // Step 3: Triples — extend the tuple with a third hierarchy
        // ---------------------------------------------------------------
        for (let k = j + 1; k < allHierarchies.length; k++) {
          const hierC = allHierarchies[k];

          // All three hierarchies must come from distinct dimensions.
          if (hierC.dim.name === hierA.dim.name || hierC.dim.name === hierB.dim.name) continue;

          // Triple score = average of the three pair scores + half the A×B
          // orthogonality bonus (the third dimension adds value but with
          // diminishing returns compared to the core pair).
          const tripleScore = Math.min(
            (scorePair(mClass, hierA.hClass) +
              scorePair(mClass, hierB.hClass) +
              scorePair(mClass, hierC.hClass)) / 3 +
            tupleBonusForPair(hierA.hClass, hierB.hClass) * 0.5,
            1.0,
          );

          if (tripleScore < opts.minRelevanceScore) continue;

          const tripleContext = [
            { h: hierA.h, hClass: hierA.hClass },
            { h: hierB.h, hClass: hierB.hClass },
            { h: hierC.h, hClass: hierC.hClass },
          ];
          const tripleAnalysisType = determineAnalysisType(tripleContext, mClass);

          suggestions.push({
            title: buildTupleTitle(measure, tripleContext),
            description: buildDescription(measure, mClass, tripleContext, tripleAnalysisType),
            analysisType: tripleAnalysisType,
            measure: measureRef,
            hierarchies: [hierA, hierB, hierC].map(({ dim, h }) => ({
              dimensionName: dim.name,
              hierarchyName: h.name,
              levels: h.levels.map((l) => l.name),
            })),
            relevanceScore: tripleScore,
            tags: buildTags(mClass, tripleContext, tripleAnalysisType, fact.name),
          });
        }
      }
    }
  }

  return suggestions;
}

/**
 * Deduplicate suggestions: keep only the highest-scoring entry when
 * multiple suggestions share the same measure + hierarchy set.
 */
function deduplicate(suggestions: AnalysisSuggestion[]): AnalysisSuggestion[] {
  const seen = new Map<string, AnalysisSuggestion>();
  for (const s of suggestions) {
    const key = [
      s.measure.factName,
      s.measure.sourceColumn,
      s.measure.aggregation,
      ...s.hierarchies
        .map((h) => `${h.dimensionName}::${h.hierarchyName}`)
        .sort(),
    ].join("|");

    const existing = seen.get(key);
    if (!existing || s.relevanceScore > existing.relevanceScore) {
      seen.set(key, s);
    }
  }
  return Array.from(seen.values());
}

// ----------------------------------------------------------
// Public entry point
// ----------------------------------------------------------

/**
 * Generate a ranked list of analysis suggestions from a SemanticModel.
 *
 * @param model   The fully built SemanticModel (must have facts, dimensions,
 *                relationships, and hierarchies populated).
 * @param options Fine-tune the number and type of suggestions returned.
 */
export function generateAnalysisSuggestions(
  model: SemanticModel,
  options: SuggestionOptions = {},
): AnalysisSuggestion[] {
  const opts: Required<SuggestionOptions> = {
    maxSuggestions:   options.maxSuggestions   ?? 25,
    minRelevanceScore: options.minRelevanceScore ?? 0.50,
    includeTuples:    options.includeTuples    ?? true,
    includeTriples:   options.includeTriples   ?? false,
  };

  const dimensionMap = buildDimensionMap(model.dimensions);
  const all: AnalysisSuggestion[] = [];

  for (const fact of model.facts) {
    const connectedDims = findConnectedDimensions(
      fact,
      model.relationships,
      dimensionMap,
    );
    all.push(...suggestionsForFact(fact, connectedDims, opts));
  }

  return deduplicate(all)
    .sort((a, b) => b.relevanceScore - a.relevanceScore)
    .slice(0, opts.maxSuggestions);
}
