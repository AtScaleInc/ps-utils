/**
 * Core types for the statistical fingerprint algorithm.
 *
 * Three type groups live here:
 *   1. DatabaseQueryRunner — the minimal SQL interface the profilers use
 *   2. ModelGraph          — the parsed SML model (intermediate representation)
 *   3. SchemaFingerprint   — the obfuscated output file
 */

// ─── SQL interface ────────────────────────────────────────────────────────────

/**
 * Minimal SQL interface consumed by the profilers.
 *
 * Implement this against any database driver.  The statistics module has no
 * dependency on SqlService so it can be tested and extended independently.
 * The operation layer wraps SqlService + SqlConnection into this interface.
 */
export interface DatabaseQueryRunner {
  /** Execute SQL and return rows as plain objects. Column names are the keys. */
  query(sql: string): Promise<Record<string, unknown>[]>;
}

// ─── Sampling configuration ───────────────────────────────────────────────────

export interface SamplingConfig {
  /**
   * Target row count when sampling large fact tables for density GROUP BY queries.
   * A TABLESAMPLE clause is injected when the estimated row count exceeds this.
   * Default: 100_000
   */
  targetFactRows: number;

  /**
   * Target row count when profiling measure column distributions.
   * Default: 10_000
   */
  targetColumnRows: number;

  /**
   * Confidence level for the Cochran sample-size formula: 0.90 | 0.95 | 0.99.
   * Default: 0.95
   */
  confidenceLevel: number;

  /**
   * Target margin of error [0..1] for proportion estimates (null fractions, etc.).
   * Default: 0.05
   */
  marginOfError: number;

  /**
   * Whether the target database supports TABLESAMPLE SYSTEM(pct) syntax.
   * When false, a LIMIT-based fallback is used.
   * Default: true
   */
  supportsTablesample: boolean;

  /**
   * Optional dialect hint for minor SQL differences (e.g. "snowflake", "postgresql").
   * Affects identifier quoting and fallback strategies.
   */
  dialect?: string;
}

export const DEFAULT_SAMPLING_CONFIG: SamplingConfig = {
  targetFactRows:     100_000,
  targetColumnRows:   10_000,
  confidenceLevel:    0.95,
  marginOfError:      0.05,
  supportsTablesample: true,
};

// ─── Model graph (parsed SML) ─────────────────────────────────────────────────

/** In-memory model graph derived from parsing SML YAML files. */
export interface ModelGraph {
  modelName: string;
  facts:      FactNode[];
  dimensions: DimensionNode[];
}

export interface FactNode {
  uniqueName:   string;
  sourceTable:  string;
  sourceSchema: string;
  measures:     MeasureNode[];
  /** FK edges declared in the model relationships. */
  joins:        JoinEdge[];
}

export interface DimensionNode {
  uniqueName:   string;
  sourceTable:  string;
  sourceSchema: string;
  hierarchies:  HierarchyNode[];
}

export interface HierarchyNode {
  uniqueName: string;
  label:      string;
  /** Ordered broadest (root) → most granular (leaf). */
  levels:     LevelNode[];
}

export interface LevelNode {
  uniqueName:   string;
  label:        string;
  /** Physical column(s) that form the level key. Usually one; composite for multi-col PKs. */
  keyColumns:   string[];
  /** Optional companion column that holds the human-readable display value. */
  labelColumn?: string;
  isLeaf:       boolean;
  /**
   * Physical table/schema this level's own columns actually live in, when it
   * differs from the dimension's default sourceTable — i.e. a snowflake-schema
   * hierarchy where each level is normalized into its own physical table
   * (e.g. dimproductcategory → dimproductsubcategory → dimproduct), rather than
   * a single denormalized star-schema table shared by every level.
   * Falls back to the dimension's sourceTable/sourceSchema when absent.
   */
  sourceTable?:  string;
  sourceSchema?: string;
  /**
   * FK column — present in THIS level's own sourceTable — that references the
   * parent level's key column. Only needed when this level's table differs
   * from the parent level's table; resolved from the dimension's internal
   * `relationships` block (snowflake-schema hierarchies). Falls back to using
   * the parent level's own key column name when absent, which is correct for
   * single-table (star-schema) hierarchies where every level's key is just
   * another column on the same shared row.
   */
  parentKeyColumn?: string;
}

export interface JoinEdge {
  /** FK column(s) on the fact source table. */
  fromColumns:  string[];
  /** Dimension unique_name this join targets. */
  toDimension:  string;
  /** Level unique_name (leaf) within the dimension. */
  toLevel:      string;
}

export interface MeasureNode {
  uniqueName:   string;
  /** The sql_expression from SML — may be a column name or a SQL expression. */
  sourceColumn: string;
  dataType:     "integer" | "decimal" | "unknown";
  aggregations: string[];
}

// ─── Schema fingerprint ───────────────────────────────────────────────────────

/** Distribution shape classification used for synthetic data generation strategy. */
export type DistributionShape =
  | "uniform"
  | "normal"
  | "log_normal"
  | "power_law"
  | "bimodal"
  | "unknown";

/**
 * Optional metadata block that maps opaque IDs back to the original physical
 * names.  Only present when extraction was run with --preserve-meta-data true.
 * When present, DDL and data generation use the real names instead of synthetic
 * ones so the created tables match the original SML model schema.
 */
export interface FingerprintMetadata {
  /** Maps dimension opaque ID (e.g. "D1") → physical source table name. */
  dimensionTables:   Record<string, string>;
  /** Maps level opaque ID (e.g. "D1.H1.L2") → physical key column name. */
  levelKeyColumns:   Record<string, string>;
  /** Maps level opaque ID → physical label column name (only when a label column exists). */
  levelLabelColumns: Record<string, string>;
  /** Maps fact opaque ID (e.g. "F1") → physical source table name. */
  factTables:        Record<string, string>;
  /** Maps measure opaque ID (e.g. "F1.M3") → physical source column name. */
  measureColumns:    Record<string, string>;
  /**
   * Maps "${factId}:${joinIndex}" → FK column name on the fact table.
   * Only populated when the model has relationships with join_columns defined.
   */
  joinColumns:       Record<string, string>;
}

/** Top-level fingerprint output file. All names are replaced by opaque IDs. */
export interface SchemaFingerprint {
  version:              "2.0";
  capturedAt:           string;   // ISO-8601 timestamp
  sampling:             SamplingMetadata;
  dimensions:           DimensionFingerprint[];
  facts:                FactFingerprint[];
  conformedDimensions:  ConformedDimensionFingerprint[];
  /**
   * Optional metadata mapping opaque IDs to original physical names.
   * Present only when extraction ran with --preserve-meta-data true.
   */
  metadata?:            FingerprintMetadata;
}

export interface SamplingMetadata {
  targetFactRows:    number;
  targetColumnRows:  number;
  confidenceLevel:   number;
  marginOfError:     number;
}

export interface DimensionFingerprint {
  /** Opaque sequential ID — original table name is NOT included. */
  id:         string;
  rowCount:   number;
  hierarchies: HierarchyFingerprint[];
}

export interface HierarchyFingerprint {
  id:     string;
  levels: LevelFingerprint[];
}

export interface LevelFingerprint {
  id:               string;
  role:             "root" | "intermediate" | "leaf";
  memberCount:      number;
  nullKeyFraction:  number;
  /** Ratio of distinct label values to distinct key values. Present when a label column exists. */
  labelUniqueness?: number;
  /** Fraction of leaf members with zero associated fact rows. Leaf levels only. */
  coldMemberFraction?: number;
  /** Rollup statistics from the parent level. Absent for root. */
  rollupFromParent?:   RollupEdgeFingerprint;
}

export interface RollupEdgeFingerprint {
  avgRatio:    number;
  stddevRatio: number;
  shape:       DistributionShape;
  min:         number;
  p50:         number;
  p95:         number;
  max:         number;
  /**
   * Per-quartile child count breakdown.
   * Parents are sorted by child count and split into four equal-size buckets
   * (Q1 = fewest children, Q4 = most).  Captures the "fat-head" phenomenon
   * (e.g. California has 500 cities, Wyoming has 5) which the global P50/P95
   * cannot represent.
   *
   * Absent when the dimension has fewer than 8 parents (tiers are not meaningful).
   */
  tiers?: RollupTierProfile;
}

/**
 * Describes how the rollup ratio varies across parent members.
 * Enables synthetic generators to assign per-parent child counts that
 * reproduce the real skew rather than sampling from the global distribution.
 */
export interface RollupTierProfile {
  /** Average children per parent for parents in the bottom 25% (fewest children). */
  q1AvgChildren: number;
  q2AvgChildren: number;
  q3AvgChildren: number;
  /** Average children per parent for parents in the top 25% (most children). */
  q4AvgChildren: number;
  /**
   * Fraction of ALL children that belong to Q4 (top-quartile) parents.
   * High values (e.g. 0.8) mean a small number of "hub" parents dominate the
   * hierarchy — the classic power-law / long-tail structure.
   */
  q4ChildFraction: number;
}

export interface FactFingerprint {
  id:       string;
  rowCount: number;
  joins:    JoinFingerprint[];
  measures: MeasureFingerprint[];
  /**
   * Pairwise Pearson r between numeric measures on this fact table.
   * Absent when fewer than 2 measures exist.
   *
   * Correlated measures (e.g. quantity × unit_price ≈ revenue) must be
   * generated jointly; without this, synthetic data will have independent
   * measure distributions that violate basic business constraints.
   */
  measureCorrelations?: PairwiseMeasureCorrelation[];
  /**
   * Pairwise association scores between FK columns on this fact table.
   * Absent when fewer than 2 FK joins exist.
   *
   * If high-value customers only buy premium products, this score will be
   * elevated for (customer_fk, product_fk).  A generator can use this to
   * decide whether to sample FK values independently or conditionally.
   */
  fkAssociations?: FkAssociation[];
}

/**
 * Pearson correlation between two measure columns, computed on a sample of
 * the fact table.  Original measure names are replaced by their opaque IDs.
 */
export interface PairwiseMeasureCorrelation {
  measureId1: string;
  measureId2: string;
  /** Pearson r in [-1, 1].  Values near 0 mean the measures are independent. */
  pearsonR:   number;
}

/**
 * Normalized non-independence score between two FK columns on the same fact.
 *
 *   0 = completely independent  (each FK1 value pairs with every FK2 value)
 *   1 = perfectly correlated    (one-to-one mapping between FK1 and FK2 values)
 *
 * Formula: 1 − distinctPairs / min(sampleSize, card₁ × card₂)
 *
 * "distinctPairs" is COUNT(*) of (DISTINCT fk1, fk2) pairs observed in the
 * sample.  No actual FK values are stored.
 */
export interface FkAssociation {
  dimensionId1:     string;
  dimensionId2:     string;
  associationScore: number;
}

export interface JoinFingerprint {
  toDimensionId:    string;
  toLeafLevelId:    string;
  nullFkFraction:   number;
  /** Fraction of dimension leaf members that appear in at least one fact row. */
  coverageFraction: number;
  density:          DensityFingerprint;
}

export interface DensityFingerprint {
  /** Average fact rows per leaf member. */
  avg:     number;
  stddev:  number;
  shape:   DistributionShape;
  p50:     number;
  p90:     number;
  p99:     number;
  max:     number;
  /** True when density was estimated from a sample rather than a full table scan. */
  sampled:          boolean;
  sampleFraction?:  number;
}

export interface MeasureFingerprint {
  id:           string;
  aggregation:  string;
  dataType:     "integer" | "decimal" | "unknown";
  additivity:   "additive" | "semi_additive" | "non_additive";
  nullFraction: number;
  distribution: NumericDistribution;
}

export interface NumericDistribution {
  shape:    DistributionShape;
  min:      number;
  max:      number;
  mean:     number;
  stddev:   number;
  percentiles: PercentileSet;
}

export interface PercentileSet {
  p5:  number;
  p25: number;
  p50: number;
  p75: number;
  p95: number;
  p99: number;
}

export interface ConformedDimensionFingerprint {
  dimensionId: string;
  factIds:     string[];
  pairwiseOverlap: Array<{
    factId1:         string;
    factId2:         string;
    overlapFraction: number;
  }>;
}
