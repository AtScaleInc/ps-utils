# Statistical Fingerprint Algorithm for Semantic Layer Data

This document describes an algorithm for capturing a statistical fingerprint of a
multidimensional database — sufficient to reconstruct plausible DDL and generate
synthetic data that is statistically indistinguishable from the original at an
aggregate level, without divulging any actual data values.

> **Security hardening:** every fingerprint produced by `extract-data-shape-from-connection`
> and every dataset produced by `generate-data-from-data-shape[-to-connection]` is passed
> through the controls centralized in [`src/statistics/security.ts`](src/statistics/security.ts).
> The controls are **strictly additive**: existing fields and behavior are preserved, and
> additional metadata (`coldMemberBucket`, `overlapBucket`, `sensitivity`, `isNearFunctional`,
> `security`) is attached for downstream auditors. A `_reports/` directory alongside each output
> carries three audit artifacts — `pipeline_isolation_report.json`,
> `generation_manifest.json`, and `integrity_report.json`.
> See [§Security & Compliance Controls](#security--compliance-controls) below for the full list.

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
| `memberCount` | `COUNT(DISTINCT key_col)` | Absolute cardinality; determines memory footprint |
| `nullKeyFraction` | `COUNT(NULL key) / COUNT(*)` | Data quality; affects join completeness |
| `labelUniqueness` | `COUNT(DISTINCT label_col) / COUNT(DISTINCT key_col)` | Whether labels are reliable for display; present only when a label column exists |

### Per-edge (rollup ratio) statistics

For every adjacent level pair `(parent_level, child_level)`:

```sql
SELECT
  AVG(children_per_parent)    AS avg_ratio,
  STDDEV(children_per_parent) AS stddev_ratio,
  MIN(children_per_parent)    AS min_children,
  MAX(children_per_parent)    AS max_children,
  PERCENTILE_CONT(0.50) WITHIN GROUP (ORDER BY children_per_parent) AS p50,
  PERCENTILE_CONT(0.95) WITHIN GROUP (ORDER BY children_per_parent) AS p95
FROM (
  SELECT parent_key_col, COUNT(DISTINCT child_key_col) AS children_per_parent
  FROM dim_table
  WHERE parent_key_col IS NOT NULL
  GROUP BY parent_key_col
) rollup_counts
```

The distribution shape of `children_per_parent` is classified (see
[§Distribution Shape Classification](#distribution-shape-classification)) as one of:
- **uniform** — all parents have similar child counts
- **power_law** — a few parents dominate (most common in business data)
- **log_normal** — moderate to high variance with positive skew
- **normal** — roughly symmetric, moderate spread

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
  AVG(children_per_parent)  AS avg_children,
  SUM(children_per_parent)  AS child_total,
  COUNT(*)                  AS parent_count
FROM (
  SELECT
    children_per_parent,
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

Tier statistics are omitted when the query returns fewer than 4 buckets or when any
bucket contains fewer than 2 parents — the minimum needed for meaningful quartiles.

### Cold member fraction

The fraction of dimension leaf members that appear in zero fact rows is computed during
Phase 3 (density profiling) when the fact table is available. The density query counts
distinct FK values seen in the fact; that count is compared against the total leaf
member count from the dimension:

```
coverageFraction  = min(1, distinct_fk_values_in_fact / total_leaf_members)
coldMemberFraction = max(0, 1 - coverageFraction)
```

When the density query ran on a sample, the `distinct_fk_values_in_fact` count is
projected to the full table before the division (`sampled_count × scale_factor`).

The result is stamped onto the leaf `LevelFingerprint` after density profiling completes.

---

### Snowflake-schema hierarchies

Every query example above assumes a **star schema** — every level of a hierarchy lives
in one denormalized `dim_table`, so a single `parent_key_col` / `child_key_col` pair on
that one table is enough to profile a rollup edge.

Not every hierarchy is laid out that way. In a **snowflake schema**, each level is
normalized into its own physical table (e.g. `dimproductcategory` → `dimproductsubcategory`
→ `dimproduct`), and the FK connecting a child level's table back to its parent lives on
the child's own table, not on a shared row.

The SML reader resolves this per level, not per dimension, from two places in the model:

- **Per-level table** — a `level_attributes` entry naming a `dataset` other than the
  dimension's default is recorded as that level's own `sourceTable` / `sourceSchema`.
- **Parent FK column** — the dimension's `relationships` block maps a child dataset to
  the FK column (`from.join_columns`) it carries back to its parent. This is only
  resolved when a level's dataset actually differs from its immediate parent's —
  consecutive levels sharing one table behave exactly like a star schema and simply use
  the parent's own key column name.

Every profiling query that touches a dimension table — rollup ratio (Phase 2), leaf
density and null-FK fraction (Phase 3), and conformed-dimension cross-fact profiling
(Phase 5) — queries the level's own resolved table when one is recorded, and falls back
to the dimension's default `sourceTable` / `sourceSchema` otherwise. Star-schema
dimensions (no per-level dataset, no `relationships` block) are unaffected: every level
resolves to the same default table, exactly as before.

---

## Phase 3: Leaf-Level Fact Density Profiling

The leaf level is the join anchor — every fact query touches the dimension through its
leaf. This statistic is most directly tied to query execution cost.

### Null FK fraction

A separate query captures the null FK fraction before any sampling is applied:

```sql
SELECT
  SUM(CASE WHEN fk_col IS NULL THEN 1 ELSE 0 END) * 1.0
    / NULLIF(COUNT(*), 0) AS null_fk_fraction
FROM fact_table
```

### Density distribution

Large fact tables are sampled via `TABLESAMPLE SYSTEM(pct)` (or a `LIMIT`-based fallback
for databases that do not support `TABLESAMPLE`). The `sampled` flag and the
`sampleFraction` are stored in the fingerprint so downstream tools know when the density
statistics are estimates rather than exact counts.

```sql
SELECT
  COUNT(*)                    AS group_count,     -- distinct leaf members with facts
  AVG(rows_per_leaf)          AS avg_density,
  STDDEV(rows_per_leaf)       AS stddev_density,
  MAX(rows_per_leaf)          AS max_density,
  PERCENTILE_CONT(0.50) WITHIN GROUP (ORDER BY rows_per_leaf) AS p50,
  PERCENTILE_CONT(0.90) WITHIN GROUP (ORDER BY rows_per_leaf) AS p90,
  PERCENTILE_CONT(0.99) WITHIN GROUP (ORDER BY rows_per_leaf) AS p99
FROM (
  SELECT fk_col, COUNT(*) AS rows_per_leaf
  FROM [sample of] fact_table
  WHERE fk_col IS NOT NULL
  GROUP BY fk_col
) density_counts
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

## Phase 4: Measure Column Profiling

For each numeric measure in the fact table, apply statistical profiling on a sampled
slice of the fact table (default: 10,000 rows; configurable via `targetColumnRows`).

### Null fraction and scalar statistics

```sql
SELECT
  MIN(expr)    AS v_min,
  MAX(expr)    AS v_max,
  AVG(expr)    AS v_mean,
  STDDEV(expr) AS v_stddev
FROM [sample] WHERE expr IS NOT NULL

-- Null fraction (separate query):
SELECT SUM(CASE WHEN expr IS NULL THEN 1 ELSE 0 END) * 1.0
         / NULLIF(COUNT(*), 0) AS null_frac
FROM [sample]
```

### Percentile distribution

Six percentile points are captured using `PERCENTILE_CONT … WITHIN GROUP (ORDER BY …)`
(SQL:2003; supported by Snowflake, PostgreSQL ≥ 9.4, Redshift, DuckDB). When this
syntax fails, an `NTILE(100)`-based window function fallback is attempted automatically.

| Percentile | Purpose |
|---|---|
| P5, P25, P50, P75, P95, P99 | Distribution shape without storing values |

### Distribution shape classification

Given the mean, stddev, P50, and P95, the shape is classified as:

| Condition | Shape |
|---|---|
| `P95/P50 > 8` and `(mean − P50)/P50 > 1.0` | `power_law` |
| `stddev/mean < 0.25` and `|(mean − P50)/P50| < 0.10` | `uniform` |
| `(mean − P50)/P50 > 0.25` or `stddev/mean > 0.6` | `log_normal` |
| default | `normal` |

### Additivity classification

Additivity is determined by a two-step heuristic — no cross-hierarchy SQL verification
is performed:

1. If the measure's only declared aggregation is `AVG` → `non_additive`
2. If the measure name contains any of `balance`, `stock`, `inventory`, `headcount`,
   `open_`, `_open`, `on_hand` → `semi_additive`
3. Otherwise → `additive`

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

The overlap formula:

```
overlapFraction(F1, F2) = |{FK values in F1} ∩ {FK values in F2}| / leafMemberCount
```

Implemented as a self-join of two `SELECT DISTINCT fk_val FROM fact_i` subqueries.

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
- `sampleSize` — total row count of the sample

A score near 0 means the FK values are independently distributed.  A score near 1
means knowing `fk1` almost fully determines `fk2` (near one-to-one mapping).  No
actual FK values are stored.

Capped at the first 6 FK joins per fact (15 pairs maximum).

---

## Phase 6: Obfuscation Rules

1. **Table and column names** → opaque sequential IDs (`D1`, `D2`; `F1`, `F2`; level
   keys within a hierarchy become `D1.H1.L1`, `D1.H1.L2`, etc.).
   The mapping from original names to IDs is discarded after extraction.

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

7. **Small tables** (fewer than 5,000 rows) require special treatment — absolute counts
   in frequency vectors become re-identifying. A warning is emitted; differential-privacy
   noise addition is a deferred control (see §Security & Compliance Controls).

---

## The Fingerprint File Format

The file is organized around the model, not the database tables. All field names use
camelCase (the YAML is serialized directly from the TypeScript object graph). The IDs
use a dot-hierarchical convention: `D1.H1.L3` means dimension 1, hierarchy 1, level 3.

```yaml
version: '2.0'
capturedAt: '2024-01-15T10:30:00.000Z'
sampling:
  targetFactRows: 100000
  targetColumnRows: 10000
  confidenceLevel: 0.95
  marginOfError: 0.05

dimensions:
  - id: D1
    rowCount: 42000
    hierarchies:
      - id: D1.H1
        levels:
          - id: D1.H1.L1
            role: root
            memberCount: 5
            nullKeyFraction: 0
            sensitivity: Confidential
          - id: D1.H1.L2
            role: intermediate
            memberCount: 52
            nullKeyFraction: 0
            sensitivity: Confidential
            rollupFromParent:
              avgRatio: 10.4
              stddevRatio: 3.1
              shape: uniform
              min: 8
              p50: 10
              p95: 17
              max: 12
          - id: D1.H1.L3
            role: intermediate
            memberCount: 28000
            nullKeyFraction: 0.003
            sensitivity: Confidential
            rollupFromParent:
              avgRatio: 538
              stddevRatio: 612
              shape: power_law     # a few states have many cities
              min: 1
              p50: 220
              p95: 1800
              max: 12000
              tiers:               # quartile breakdown of parents by child count
                q1AvgChildren: 12
                q2AvgChildren: 85
                q3AvgChildren: 310
                q4AvgChildren: 1740
                q4ChildFraction: 0.81  # 81% of cities belong to top-quartile states
          - id: D1.H1.L4
            role: leaf
            memberCount: 42000
            nullKeyFraction: 0
            coldMemberFraction: 0.08   # 8% of customers have never ordered
            coldMemberBucket: 0-10%
            sensitivity: Confidential

facts:
  - id: F1
    rowCount: 3200000
    joins:
      - toDimensionId: D1
        toLeafLevelId: D1.H1.L4
        nullFkFraction: 0.001
        coverageFraction: 0.92   # 92% of leaf members appear in this fact
        density:
          avg: 76.2
          stddev: 149.4
          shape: power_law
          p50: 28
          p90: 198
          p99: 980
          max: 14200
          sampled: false
    measures:
      - id: F1.M1
        aggregation: SUM
        dataType: decimal
        additivity: additive
        nullFraction: 0
        sensitivity: Confidential
        distribution:
          shape: log_normal
          min: 1.5
          max: 50000
          mean: 347
          stddev: 912
          percentiles:
            p5: 8.2
            p25: 42.1
            p50: 142.5
            p75: 390
            p95: 1820
            p99: 4200
    measureCorrelations:          # pairwise Pearson r between numeric measures
      - measureId1: F1.M1
        measureId2: F1.M2
        pearsonR: 0.84            # quantity and revenue are strongly correlated
    fkAssociations:               # normalized non-independence scores between FK pairs
      - dimensionId1: D1
        dimensionId2: D2
        associationScore: 0.31    # moderate correlation between customer and product FKs
        isNearFunctional: false

conformedDimensions:
  - dimensionId: D1
    factIds:
      - F1
      - F2
    pairwiseOverlap:
      - factId1: F1
        factId2: F2
        overlapFraction: 0.84
        overlapBucket: 80-100%

security:
  profileVersion: '1.0.0'
  appliedAt: '2024-01-15T10:30:05.000Z'
  appliedControls:
    - applyBinning
    - applyRounding
    - applySensitivity
    - applyNearFunctional
  deferredControls:
    - differential_privacy_noise
    - ed25519_signing
    - worm_audit_log
    - dynamic_rbac_masking
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

1. **Root level** — generate `memberCount` synthetic integer keys starting at 1.
2. **Each rollup edge** — for every parent, sample a child count:
   - If `tiers` are present (Phase 2 §rollup tier buckets), the parent is assigned a
     tier via `idx % 4` round-robin, and its child count is drawn from that tier's
     average using the edge's distribution shape (`power_law`, `log_normal`, or
     `normal`).  `power_law` uses an exponential draw (`−avg × ln(U)`); `log_normal`
     computes σ² from the mean/stddev relationship; `normal` uses Box-Muller.  `uniform`
     samples between `edge.min` and `edge.max`.
   - Without tiers, the child count is drawn directly from the global distribution using
     the same shape-based sampler.
   - All per-parent counts are scaled proportionally so the total leaf count matches the
     recorded `memberCount` exactly (`scaleToTarget`).
3. **Secondary hierarchies** — assign ancestors by distributing leaf indices across the
   secondary level's `memberCount` using modular arithmetic, preserving cardinality
   ratios without requiring a separate walk.

### 8.3 Fact table generation

1. **Anchor leaves** — taken from the first FK join column; the first
   `coldFraction × leafCount` leaves (deterministic slice) are treated as cold members
   and receive zero rows.
2. **Density budget** — for each hot leaf, sample a row budget from the density
   distribution shape (`power_law`, `log_normal`, `uniform`).  Budgets are scaled to
   the target `totalRows` using `scaleToTarget`.
3. **FK assignment** — for each row, the anchor FK is assigned by weighted sampling over
   hot-leaf budgets.  Non-anchor FK columns are filled by:
   - **Association constraints** (Phase 5): for each FK pair with `associationScore >
     0.05`, a `Map<dim1Key, number[]>` of allowed dim2 keys is precomputed; the subset
     size is `max(1, round((1 − score) × dim2Count))`.  The FK value is drawn from this
     allowed subset.
   - **Independent sampling**: FK pairs below the threshold draw uniformly from all
     leaf keys.
4. **Measure generation** — uses a **Gaussian copula** for correlated pairs
   (Phase 4 §pairwise Pearson r):
   - One standard-normal draw `z[i]` per measure via Box-Muller.
   - For each correlated pair `(i, j)` with `j > i` and Pearson `r`:
     `z[j] = r·z[i] + √(1−r²)·z[j]`.  The `j > i` guard ensures each pair is
     processed exactly once (from the lower-index measure as the driver).
   - Each `z[i]` is mapped to `U[0,1]` via `normalCdf` (Abramowitz & Stegun
     approximation, max error 7.5×10⁻⁸), then mapped to the target distribution via
     piecewise-linear interpolation through the eight percentile control points
     (0%, 5%, 25%, 50%, 75%, 95%, 99%, 100%).
   - Measures without correlations are sampled the same way: a standard-normal draw
     mapped through normalCdf and then through the percentile inverse CDF.
   - For `uniform` and `normal` shapes without a full percentile set, the code falls
     back to direct sampling from the shape parameters.

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

---

## Security & Compliance Controls

The fingerprint algorithm is designed to produce a publishable artifact: the output
files may be checked into source control, shared with partner teams, or used as the
seed for external synthetic-data environments. To make that publication safe, every
fingerprint passes through a hardening stage implemented in
[`src/statistics/security.ts`](src/statistics/security.ts).

### Controls enforced automatically

| Review ref | Control | Enforcement point |
|---|---|---|
| R-4  | `coldMemberFraction` bucketed into `0-10%` / `10-30%` / `30-60%` / `60-100%` | `hardenFingerprint()` — attaches `coldMemberBucket` |
| R-7  | Pearson `r` rounded to 2 decimal places | `hardenFingerprint()` — mutates `measureCorrelations[].pearsonR` |
| R-9  | Absolute ISO-8601 date strings rejected in fingerprint data | `validateFingerprint()` — throws on read/write |
| R-10 | Conformed-dimension `overlapFraction` bucketed into `0-20%` / `20-50%` / `50-80%` / `80-100%` | `hardenFingerprint()` — attaches `overlapBucket` |
| R-11 | `fkAssociation` scores ≥ 0.90 flagged with `isNearFunctional: true` | `hardenFingerprint()` |
| R-15 | Every generated `*_key` value must be a positive integer allocated in-process (no real-data key ever reaches the generator) | `assertGeneratedKeyShape()` — runs after every table is built |
| R-21 | Small-table warning (< 5,000 rows) emitted for any dim or fact that would require DP noise before external distribution | `smallTableWarnings()` — surfaced through `onProgress` |
| —    | Sensitivity classification (`Public` / `Internal` / `Confidential` / `Restricted`) attached to every level and measure | `hardenFingerprint()` — via `sensitivityFor()` |
| —    | Pipeline-isolation report emitted alongside every output batch | `writePipelineIsolationReport()` |
| —    | Run manifest (`fingerprint SHA-256`, seed, scale, row counts, output digest) | `writeRunManifest()` |
| —    | Every fact-FK value verified to resolve to a dim leaf key | `assertFkClosure()` — throws on orphans |

Each generator output directory therefore contains a `_reports/` subdirectory with three JSON artifacts:

```
data/
├── dim_1.csv
├── fact_1.csv
└── _reports/
    ├── pipeline_isolation_report.json
    ├── generation_manifest.json
    └── integrity_report.json
```

For the `generate-data-from-data-shape-to-connection` operation the reports are
written to `./_reports/` (configurable via `--reports-dir`) since the data output
destination is a database rather than a filesystem location.

### Controls deliberately deferred

The following controls require infrastructure not present in this repository today.
They are exposed as explicit stubs on `deferredControls` in `security.ts` so a future
implementer cannot miss them:

| Control | Deferred because |
|---|---|
| ε-differential-privacy noise on aggregate queries | Requires an ε-budget ledger and a SQL-noise injection layer |
| Ed25519 fingerprint signing | Requires a key-management service and rotation policy |
| Append-only WORM audit log | Requires object-lock storage integration |
| Dynamic RBAC / column masking | Runtime concern of the semantic layer, not the fingerprint |

Each stub throws a descriptive error so the controls cannot silently no-op after a
future refactor.

### Validation contract

`readFingerprintFile()` and `writeFingerprintFile()` both pass the fingerprint through
`validateFingerprint()`. **Errors** (currently: absolute ISO-date strings in data
fields) halt processing. **Warnings** (small-table rows, unrounded `pearsonR`,
unbucketed fractions — signs the fingerprint was produced by an earlier unhardened
version of the code) are logged to stderr and do not halt processing, so older
fingerprints remain readable while surfacing remediation signals.
