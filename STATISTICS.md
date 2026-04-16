# Statistical Fingerprint Algorithm for Semantic Layer Data

This document describes an algorithm for capturing a statistical fingerprint of a
multidimensional database — sufficient to reconstruct plausible DDL and generate
synthetic data that is statistically indistinguishable from the original at an
aggregate level, without divulging any actual data values.

The algorithm is specific to semantic layers and OLAP models. It requires an SML
model as input and is organized around the model's structure, not raw database tables.

---

## Why Multidimensional Is Fundamentally Different

A general database profiler treats tables independently. A multidimensional profiler
must treat the **model** as the unit of analysis. The statistics that matter are not
per-column — they are per-**level-within-hierarchy**, per-**rollup-edge**, and
per-**fact-to-leaf-join**. Each of these drives a different class of query processing
decision.

The three statistics that dominate OLAP query cost are:

1. **Level cardinality chain** — how many members exist at each level of each hierarchy
2. **Rollup ratio between adjacent levels** — how many children each parent has, and
   how skewed that distribution is
3. **Leaf-level fact density** — how many fact rows join to each leaf member, and the
   shape of that distribution

All three must be captured with distribution shape, not just mean values.

---

## The SML Model as a Required Input

Without the SML model, the profiler must infer hierarchy structure from column naming
conventions, which is lossy. With the SML model, the profiler knows exactly:

- Which columns constitute each level key and label
- The ordered level sequence within each hierarchy (broadest → leaf)
- Which column on the fact table is the FK joining to which dimension leaf level key
- Which columns are secondary attributes (never hierarchy levels)
- Which aggregations are valid for each measure
- Which dimensions are conformed (shared across multiple facts)

The SML model is a prerequisite input to the capture phase, not an output. The profiling
algorithm walks the model and executes targeted SQL for each structural element it finds.

**The profiling queries themselves are structurally different depending on what the
model says.** A column that is a hierarchy level key needs rollup ratio queries against
its parent — you cannot derive this from column statistics alone. Running a generic
profiler and re-interpreting results through the model lens loses too much. The model
must drive what queries are executed.

---

## Phase 1: SML Model Parsing

Before any database queries, parse the SML output to build an in-memory graph:

```
Model
 ├── Fact: orders
 │    ├── Measure: revenue (SUM, decimal)
 │    ├── Measure: quantity (SUM, integer)
 │    ├── FK join → dim_customer.customer_key  (via relationship)
 │    ├── FK join → dim_product.product_key
 │    └── FK join → dim_date.date_key
 │
 ├── Dimension: dim_customer
 │    └── Hierarchy: Customer Hierarchy
 │         ├── Level 0 (broadest): region       key=region_key
 │         ├── Level 1:            country       key=country_key
 │         ├── Level 2:            state         key=state_key
 │         └── Level 3 (leaf):     customer      key=customer_key
 │
 └── Dimension: dim_product
      └── Hierarchy: Product Hierarchy
           ├── Level 0: category     key=category_key
           ├── Level 1: subcategory  key=subcategory_key
           └── Level 2 (leaf): product key=product_key
```

This graph drives every subsequent query. Nothing is inferred from column naming at
this stage.

---

## Phase 2: Hierarchy Level Chain Profiling

For each hierarchy, profile each level individually and the edges between levels.

### Per-level statistics

For every level in every hierarchy:

| Statistic | Query | Purpose |
|---|---|---|
| `member_count` | `COUNT(DISTINCT key_col)` | Absolute cardinality; determines memory footprint |
| `null_key_fraction` | `COUNT(NULL key) / COUNT(*)` | Data quality; affects join completeness |
| `label_uniqueness` | `COUNT(DISTINCT label_col) / member_count` | Whether labels are reliable for display |
| `has_orphan_keys` | Keys in fact absent from dimension | Referential integrity gap; affects aggregation completeness |

### Per-edge (rollup ratio) statistics

For every adjacent level pair `(parent_level, child_level)`:

```sql
SELECT
  COUNT(*)                          AS child_member_count,
  COUNT(DISTINCT parent_key_col)    AS parent_member_count,
  AVG(children_per_parent)          AS avg_rollup_ratio,
  STDDEV(children_per_parent)       AS stddev_rollup_ratio,
  MIN(children_per_parent)          AS min_children,
  PERCENTILE_CONT(0.50) WITHIN GROUP (ORDER BY children_per_parent) AS p50,
  PERCENTILE_CONT(0.95) WITHIN GROUP (ORDER BY children_per_parent) AS p95,
  MAX(children_per_parent)          AS max_children
FROM (
  SELECT parent_key_col, COUNT(*) AS children_per_parent
  FROM dim_table
  GROUP BY parent_key_col
)
```

The distribution shape of `children_per_parent` is critical. Classify as:
- **uniform** — all parents have similar child counts
- **power_law** — a few parents dominate (most common in business data)
- **bimodal** — two distinct population clusters

An average rollup ratio alone tells you almost nothing about query cost.

### Rollup tier buckets

The P50/P95 statistics above describe the global distribution but hide the structure that
matters for synthetic generation: some parents are "hubs" with many more children than
the median (California vs. Wyoming at the state→city edge).

To capture this, parents are sorted by child count and divided into four equal-size
quartiles (Q1 = fewest children, Q4 = most).  The average child count per tier and the
fraction of **all children** belonging to Q4 parents are stored in `rollupFromParent.tiers`:

```sql
SELECT
  ntile_bucket,
  AVG(children_per_parent) AS avg_children,
  SUM(children_per_parent) AS child_total
FROM (
  SELECT children_per_parent,
         NTILE(4) OVER (ORDER BY children_per_parent) AS ntile_bucket
  FROM (
    SELECT parent_key, COUNT(DISTINCT child_key) AS children_per_parent
    FROM dim_table WHERE parent_key IS NOT NULL GROUP BY parent_key
  ) counts
) tiered
GROUP BY ntile_bucket ORDER BY ntile_bucket
```

`q4ChildFraction = child_total[Q4] / sum(child_total)` captures the "fatness of the
head": if 80% of children belong to the top-quartile parents, synthetic generation must
assign child counts from a heavy-tailed distribution rather than a uniform one.

Tier statistics are omitted when there are fewer than 8 parents (not enough for
meaningful quartiles).

### Cold member fraction

The fraction of dimension members that appear in zero fact rows (dimension sparsity):

```sql
SELECT
  COUNT(CASE WHEN fact_rows = 0 THEN 1 END) * 1.0 / COUNT(*) AS cold_member_fraction
FROM (
  SELECT d.key_col, COUNT(f.fk_col) AS fact_rows
  FROM dim_table d
  LEFT JOIN fact_table f ON f.fk_col = d.leaf_key_col
  GROUP BY d.key_col
)
```

This affects aggregation completeness queries and pre-aggregated rollup table coverage.

---

## Phase 3: Leaf-Level Fact Density Profiling

The leaf level is the join anchor — every fact query touches the dimension through its
leaf. This statistic is most directly tied to query execution cost.

For each `fact → dimension_leaf` join:

```sql
SELECT
  COUNT(*)                          AS total_fact_rows,
  COUNT(DISTINCT fk_col)            AS distinct_leaf_members_with_facts,
  AVG(rows_per_leaf)                AS avg_fact_density,
  STDDEV(rows_per_leaf)             AS stddev_fact_density,
  PERCENTILE_CONT(0.50) WITHIN GROUP (ORDER BY rows_per_leaf) AS p50_density,
  PERCENTILE_CONT(0.90) WITHIN GROUP (ORDER BY rows_per_leaf) AS p90_density,
  PERCENTILE_CONT(0.99) WITHIN GROUP (ORDER BY rows_per_leaf) AS p99_density,
  MAX(rows_per_leaf)                AS max_density,
  SUM(CASE WHEN fk_col IS NULL THEN 1 ELSE 0 END) * 1.0
    / COUNT(*)                      AS null_fk_fraction
FROM (
  SELECT fk_col, COUNT(*) AS rows_per_leaf
  FROM fact_table
  GROUP BY fk_col
)
```

The density distribution shape drives:

- **Hash join cost** — the build side may need to be larger than leaf cardinality
  suggests if hash collisions cluster on hot members
- **Broadcast vs. shuffle join** — determined by whether the dimension fits in memory,
  which is a function of leaf cardinality
- **Partition pruning effectiveness** — selective filters on high-density leaf members
  are highly effective; filters on cold members almost never prune
- **Pre-aggregation value** — if 1% of leaf members account for 80% of fact rows,
  pre-aggregation at the leaf level has very low compression ratio

---

## Phase 4: General Column Profiling

For columns not covered by hierarchy-specific passes (secondary attributes, degenerate
dimensions, measures), apply standard statistical profiling.

### Numeric columns (measures, IDs)

| Statistic | Purpose |
|---|---|
| `MIN`, `MAX`, `MEAN`, `STDDEV` | Scalar bounds and spread |
| Percentiles: P5, P25, P50, P75, P95, P99 | Distribution shape without storing values |
| Shape hint | log-normal, normal, uniform, power-law (from skewness/kurtosis) |

### Measure-to-measure Pearson correlation

Measures on the same fact row are typically correlated — `quantity × unit_price ≈ revenue`,
or `calls_handled` and `handle_time` move together.  A generator that draws each measure
independently from its marginal distribution will violate these implicit constraints,
producing synthetic rows where revenue is high but quantity is zero.

Pairwise Pearson r is computed using `CORR(m1, m2)` on the column sample, with a
manual `(AVG(m1·m2) − AVG(m1)·AVG(m2)) / (STDDEV(m1)·STDDEV(m2))` fallback for
databases that do not support the `CORR()` aggregate (e.g. MySQL).  Values near ±1
indicate strong linear dependence; values near 0 indicate independence.

Pairs where either measure has zero variance (constant column) are skipped.
Capped at the first 10 numeric measures per fact (45 pairs maximum).

### Categorical columns (low-cardinality strings/integers)

| Statistic | Purpose |
|---|---|
| Distinct count `K` | Number of categories |
| Normalized frequency vector | Sorted probability vector e.g. `[0.42, 0.31, 0.18, 0.09]` — shape without labels |
| Entropy score | How skewed vs. uniform the distribution is |

No actual category values are stored.

### String attribute columns

| Statistic | Purpose |
|---|---|
| Length distribution: min, max, mean, stddev | Drives synthetic string generator |
| Character class composition | Fraction alpha / digit / special |
| Structural pattern | UUID, email-like, phone-like, code-like — described structurally, not by example |

### Date/timestamp columns

| Statistic | Purpose |
|---|---|
| Span in days (relative, not absolute) | Absolute dates are identifying |
| Distribution shape | uniform, right-skewed, seasonal-periodic |
| Granularity | day / hour / second |

### Semi-additive measures

Measures like inventory balance or headcount that cannot be simply summed across time
require their distribution to be captured at **multiple hierarchy levels**, not just
globally. Verify additivity:

```sql
-- Does SUM(leaf) ≈ SUM(parent) for each level transition?
-- Non-additive divergence here flags semi-additive behavior.
```

---

## Phase 5: Conformed Dimension Cross-Fact Profiling

When multiple facts share a dimension, capture the overlap — what fraction of dimension
members appear in each fact and in the intersection:

```
dim_date used by: fact_orders, fact_inventory, fact_budget
  → fact_orders covers 92% of date members
  → fact_inventory covers 87% of date members
  → fact_budget covers 45% of date members  (monthly only, not daily)
  → overlap(orders, inventory): 84%
  → overlap(orders, budget): 41%
```

This determines whether drill-across queries will produce dense or sparse results and
whether the semantic layer can optimize them with early filtering.

### FK pairwise association

When multiple FK columns appear on the same fact table, their values are often
correlated — high-value customers buy premium products; seasonal products sell in
specific periods.  A generator that samples FK values independently will produce
cross-dimension combinations that never occur in the real data.

For each pair of FK columns `(fk1, fk2)` in the fact, a normalized non-independence
score is captured:

```
associationScore = 1 − distinctPairs / min(sampleSize, card₁ × card₂)
```

- `distinctPairs` — `COUNT(*)` of `(DISTINCT fk1, fk2)` observed in the fact sample
- `card₁`, `card₂` — `COUNT(DISTINCT fk1)`, `COUNT(DISTINCT fk2)` in the same sample

A score near 0 means the FK values are independently distributed.  A score near 1
means knowing `fk1` almost fully determines `fk2` (near one-to-one mapping).  No
actual FK values are stored.

Capped at the first 6 FK joins per fact (15 pairs maximum).

---

## Phase 6: Obfuscation Rules

1. **Table and column names** → synthetic identifiers (`T1`, `T2`; `C1`, `C2`) or
   semantic role labels (`fact_orders`, `dim_product`, `pk`, `fk_to_dim_product`).
   The mapping is discarded. Names may optionally be hashed.

2. **Categorical frequency vectors** store only relative frequencies, never actual
   values. `["Male", "Female"]` → `[0.51, 0.49]`. Synthetic labels are invented at
   generation time.

3. **Numeric ranges and percentiles** are stored as-is — these are low-sensitivity
   aggregate facts. If even this is too identifying, express as ratios (P50/P95 ratio)
   rather than absolute values.

4. **String patterns** are described structurally. An email column becomes
   `pattern: local-part(4-12 alphanum) @ domain(3-10 alphanum) . tld(2-4 alpha)`.
   No actual strings stored.

5. **Dates** are relative spans only: `span_days: 1095, shape: right_skewed`.

6. **No sample rows** are ever stored. The entire file is derived from aggregate SQL.

7. **Small tables** (fewer than ~1000 rows) require special treatment — absolute counts
   in frequency vectors become re-identifying. Apply noise addition or coarser bucketing.

---

## The Fingerprint File Format

The file is organized around the model, not the database tables:

```yaml
fingerprint_version: "2.0"
model_role: "semantic_layer"

dimensions:
  - id: D1
    row_count: 42000
    hierarchies:
      - id: H1
        levels:
          - id: L0
            role: root
            member_count: 5
            null_key_fraction: 0.0
          - id: L1
            member_count: 52
            null_key_fraction: 0.0
            rollup_from_parent:
              avg_ratio: 10.4
              stddev_ratio: 3.1
              shape: uniform
              p50: 10
              p95: 17
          - id: L2
            member_count: 28000
            null_key_fraction: 0.003
            rollup_from_parent:
              avg_ratio: 538.0
              stddev_ratio: 612.0
              shape: power_law     # a few states have many cities
              p50: 220
              p95: 1800
              tiers:               # quartile breakdown of parents by child count
                q1_avg_children: 12
                q2_avg_children: 85
                q3_avg_children: 310
                q4_avg_children: 1740
                q4_child_fraction: 0.81  # 81% of cities belong to top-quartile states
          - id: L3
            role: leaf
            member_count: 42000
            cold_member_fraction: 0.08   # 8% of customers have never ordered
            null_key_fraction: 0.0

facts:
  - id: F1
    row_count: 3200000
    joins:
      - to_dimension: D1
        to_leaf: D1.H1.L3
        null_fk_fraction: 0.001
        coverage_fraction: 0.92   # 92% of leaf members appear in this fact
        density:
          avg: 76.2
          stddev: 149.4
          shape: power_law
          p50: 28
          p90: 198
          p99: 980
          max: 14200
    measures:
      - id: M1
        aggregation: SUM
        type: decimal
        additivity: additive
        distribution:
          shape: log_normal
          percentiles: { p5: 8.2, p25: 42.1, p50: 142.5, p75: 390.0, p95: 1820.0 }
    measure_correlations:          # pairwise Pearson r between numeric measures
      - measure_id_1: F1.M1
        measure_id_2: F1.M2
        pearson_r: 0.84            # quantity and revenue are strongly correlated
    fk_associations:               # normalized non-independence scores between FK pairs
      - dimension_id_1: D1
        dimension_id_2: D2
        association_score: 0.31    # moderate correlation between customer and product FKs

conformed_dimensions:
  - dimension: D1
    facts: [F1, F2]
    overlap_fraction: 0.84
```

---

## Phase 7: Reconstruction — DDL Generation

Implemented by `generate-ddl-from-data-shape`.  DDL is derived deterministically from
the fingerprint — the same fingerprint always produces identical output.

### Naming

All table and column names are synthetic, derived from opaque IDs:

| Fingerprint ID | Table / column name |
|---|---|
| `D1`, `D2` | `dim_1`, `dim_2` |
| Level 3 key in D1.H1 (single hierarchy) | `l3_key` |
| Level 3 key in D1.H2 (multi-hierarchy) | `h2_l3_key` |
| Label column for level 3 | `l3_label` (present when `labelUniqueness` was recorded) |
| `F1`, `F2` | `fact_1`, `fact_2` |
| FK to `dim_1` on `fact_1` | `dim_1_key` |
| Measure `F1.M2` | `m2` |

### Column types

Level key types are inferred from member count:

| Member count | ANSI / PostgreSQL / MySQL | Snowflake |
|---|---|---|
| ≤ 32,767 | `SMALLINT` | `NUMBER(5,0)` |
| ≤ 2,147,483,647 | `INTEGER` | `NUMBER(10,0)` |
| > 2,147,483,647 | `BIGINT` | `NUMBER(19,0)` |

Measure types are inferred from `dataType`:

| dataType | ANSI / PostgreSQL / MySQL | Snowflake | BigQuery |
|---|---|---|---|
| `integer` | `BIGINT` | `NUMBER(19,0)` | `INT64` |
| `decimal` / `unknown` | `DECIMAL(18,4)` | `NUMBER(18,4)` | `FLOAT64` |

### Constraints

Dimension tables receive a `PRIMARY KEY` on the leaf key column of the first hierarchy.
Fact tables receive a `FOREIGN KEY` per join referencing the appropriate dimension leaf
key.  Both constraints are omitted for the `bigquery` dialect.

### Example output (ansi)

```sql
-- Dimension D1 (~42,000 rows)
CREATE TABLE dim_1 (
    l1_key     SMALLINT     NOT NULL  -- root, 5 members
    l2_key     SMALLINT     NOT NULL  -- 52 members
    l3_key     INTEGER      NOT NULL  -- leaf, 42,000 members
    l3_label   VARCHAR(200)           -- label
    PRIMARY KEY (l3_key)
);

-- Fact F1 (~3,200,000 rows, 1 join, 2 measures)
CREATE TABLE fact_1 (
    dim_1_key  INTEGER      -- → D1 leaf
    m1         DECIMAL(18,4) -- additive SUM
    m2         BIGINT        -- additive SUM
    FOREIGN KEY (dim_1_key) REFERENCES dim_1 (l3_key)
);
```

---

## Phase 8: Reconstruction — Synthetic Data Generation

The `generate-data-from-data-shape` and `generate-data-from-data-shape-to-connection`
operations implement this phase.

### 8.1 Seeded PRNG

All random draws use **mulberry32**, a 32-bit seeded PRNG, so the same `--seed` always
produces identical output.  `randNormal` uses the Box-Muller transform.

### 8.2 Dimension table generation

For each dimension, hierarchies are walked top-down:

1. **Root level** — generate `memberCount` synthetic string keys.
2. **Each rollup edge** — for every parent, sample a child count:
   - If `tiers` are present (Phase 2 §rollup tier buckets), the parent is assigned a
     tier via `idx % 4` round-robin, and its child count is drawn from that tier's
     average using the edge's distribution shape (`power_law`, `log_normal`, or
     `normal`).  `power_law` uses an exponential draw; `log_normal` computes σ² from
     the mu/sigma relationship; `normal` uses Box-Muller.
   - Without tiers, the child count is drawn directly from the global distribution.
   - All per-parent counts are scaled proportionally so the total leaf count matches the
     recorded `memberCount` exactly (`scaleToTarget`).
3. **Secondary hierarchies** — assign ancestors by distributing leaf indices across the
   secondary level's `memberCount` using modular arithmetic, preserving cardinality
   ratios without requiring a separate walk.

### 8.3 Fact table generation

1. **Anchor leaves** — taken from the first FK join column; cold members (first
   `coldFraction × leafCount` leaves) receive zero rows.
2. **Density budget** — for each hot leaf, sample a row budget from the density
   distribution shape (`power_law`, `log_normal`, `uniform`).  Budgets are scaled to
   the target `totalRows` using `scaleToTarget`.
3. **FK assignment** — for each row, the anchor FK is assigned by weighted sampling over
   hot-leaf budgets.  Non-anchor FK columns are filled by:
   - **Association constraints** (Phase 3): for each FK pair with `associationScore >
     0.05`, a `Map<dim1Key, number[]>` of allowed dim2 keys is precomputed; the subset
     size is `max(1, round((1 − score) × dim2Count))`.  The FK value is drawn from this
     allowed subset.
   - **Independent sampling**: FK pairs below the threshold draw uniformly from all
     leaf keys.
4. **Measure generation** — uses a **Gaussian copula** for correlated pairs
   (Phase 4 §pairwise Pearson r):
   - One standard-normal draw per measure.
   - For each correlated pair `(i, j)` with Pearson `r`: `z[j] = r·z[i] + √(1−r²)·z[j]`.
   - Each `z` is mapped to `U[0,1]` via `normalCdf` (Abramowitz & Stegun approximation,
     max error 7.5×10⁻⁸), then mapped to the target distribution via piecewise-linear
     interpolation through the eight percentile control points
     (0%, 5%, 25%, 50%, 75%, 95%, 99%, 100%).
   - Measures without correlations are sampled directly from their marginal distribution
     via the same percentile interpolation.

### 8.4 Output

- **CSV output** (`generate-data-from-data-shape`): dimensions first, then facts.
  Column names are identical to those produced by Phase 7 (`generate-ddl-from-data-shape`).
- **Database output** (`generate-data-from-data-shape-to-connection`): multi-value
  `INSERT` statements in configurable batches.  When `--drop-if-exists` is set the
  operation drops fact tables before dimension tables and creates dimension tables before
  fact tables, respecting FK constraints throughout.

### 8.5 Naming conventions (shared with Phase 7)

| Synthetic name | Derivation |
|---|---|
| `dim_1`, `dim_2`, … | Dimension index in fingerprint order |
| `fact_1`, `fact_2`, … | Fact index in fingerprint order |
| `l1_key` | Level key (single hierarchy) |
| `h1_l1_key` | Level key (multiple hierarchies) |
| `l1_label` | Level label column |
| `m1`, `m2`, … | Measure index within fact |

---

## Key Design Tensions

**Fidelity vs. privacy**: More statistical moments (higher-order percentiles,
correlation matrices) produce better synthetic data but increase re-identification risk
for small tables.

**Column independence vs. correlation**: This is mitigated by three aggregate-only
statistics, each targeting a different class of correlation:

1. **Rollup tier buckets** (`RollupEdgeFingerprint.tiers`): Parents are sorted by child
   count and split into quartiles.  Each tier stores its average child count, and the
   fraction of all children belonging to the top tier is recorded as `q4ChildFraction`.
   This captures the fat-head phenomenon (California has 500 cities; Wyoming has 5)
   that the global P50/P95 cannot represent, without storing which specific parent is
   large.

2. **Pairwise measure Pearson r** (`FactFingerprint.measureCorrelations`): Computed
   via `CORR(m1, m2)` (with AVG/STDDEV fallback) on the column sample.  Enables
   synthetic generators to reproduce correlated measures (e.g. quantity × unit_price ≈
   revenue) rather than drawing them independently from their marginal distributions.
   Capped at the first 10 numeric measures (45 pairs maximum).

3. **FK pairwise association score** (`FactFingerprint.fkAssociations`): Measures
   whether FK column pairs are independent or correlated:
   `score = 1 − distinctPairs / min(sampleSize, card₁ × card₂)`.
   A score near 0 means customers and products are independently distributed; a score
   near 1 means customer identity strongly predicts which products they buy.  No actual
   FK values are stored.  Capped at the first 6 FK joins (15 pairs maximum).

Higher-order correlations (3-way tensors, per-value conditional distributions) are
deliberately excluded: they increase fingerprint size, risk re-identification for small
tables, and provide diminishing returns beyond these three.

**Schema inference vs. explicit FK metadata**: Analytical warehouses frequently omit
declared FK constraints. When this happens, the FK topology must be inferred from
naming conventions and cardinality analysis — the same inference engine used during SML
generation — before hierarchy-aware profiling can begin.
