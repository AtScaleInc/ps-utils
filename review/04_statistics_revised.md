# Statistical Fingerprint Algorithm for Semantic Layer Data — Revised

> **Revision note.** This file is the Phase-4 rewrite of `STATISTICS.md`. It **does not
> alter or supersede** the in-tree `STATISTICS.md` and **does not alter or supersede any
> existing pipeline configuration or data source connection**. The in-tree document
> remains the authoritative specification until a separate promotion step, outside this
> review, replaces it.

This document describes an algorithm for capturing a statistical fingerprint of a
multidimensional database — sufficient to reconstruct plausible DDL and generate
synthetic data that is statistically indistinguishable from the original at an
aggregate level, without divulging any actual data values.

The algorithm is specific to semantic layers and OLAP models. It requires an SML model
as input and is organized around the model's structure, not raw database tables.

---

## Section 0: Synthetic Digital Twin Strategy (new — opens the document)

**The real dataset is touched at most once, by the profiler, through a tokenized +
masked + DP-noised view tier.** Every downstream consumer operates on the synthetic
twin. Concretely:

```
Real DB (base tables, Restricted)
    │
    │  SELECT-only, via view layer only (Layer-1 tokenization)
    ▼
Profiler (ε-DP, k-anonymized, audit-logged)  ──► signed fingerprint (yaml)
                                                     │
                                                     ▼
                                              Generator (seeded, deterministic)
                                                     │
                                                     ▼
                                   Synthetic twin DB / CSV (Public / Internal)
                                                     │
                                                     ▼
                               Semantic layer, BI, analysts, dev/test
```

- **No PII ever enters the fingerprint.** The fingerprint carries aggregate statistics
  and structural metadata only. It is classified **Confidential** by default, and
  **Restricted** if derived from a Restricted input.
- **No real dataset feeds the semantic layer in dev / test / UAT.** The twin is the
  authoritative surface for all non-production work, and for any production work where
  the consuming role is not cleared for raw data.
- **Consumer drop-in replacement.** The SML model points at either the real or the twin
  via connection-string swap only; column names, types, cardinalities, and relationship
  edges are byte-identical between the two.

Sensitivity classification tier model (applied column-by-column at SML-annotation
time):

| Class | Examples | Profiler behavior |
|---|---|---|
| **Restricted** | SSN, account number, full name, full address, DOB | Profiler **refuses** to read without an explicit `--restricted-allow` flag AND a signed access ticket. Even then, only tokenized form reaches the profiler. |
| **Confidential** | Customer internal ID, email, phone, geographic micro-data | Profiler reads tokenized form only; full ε-DP budget applied. |
| **Internal** | Segment, region, product category | Profiler reads directly; k-anonymity enforced (k ≥ 10 default). |
| **Public** | Currency code, ISO country, fiscal year | Profiler reads directly; no DP required but logged. |

Default classification when an SML column carries no `classification` annotation:
**Restricted**. "Default to Restricted for ambiguous sensitivity" is a hard invariant,
not a soft recommendation.

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
- **Sensitivity classification per column** (new requirement — see §0 above)

Columns missing a classification default to **Restricted** and are not read by the
profiler until they are annotated.

---

## Phase 1: SML Model Parsing

Before any database queries, parse the SML output to build an in-memory graph annotated
with per-column classification. (Graph unchanged from the original; annotations added.)

```
Model
 ├── Fact: orders
 │    ├── Measure: revenue  (SUM, decimal)            [Confidential]
 │    ├── Measure: quantity (SUM, integer)            [Internal]
 │    ├── FK join → dim_customer.customer_key
 │    ├── FK join → dim_product.product_key
 │    └── FK join → dim_date.date_key
 │
 ├── Dimension: dim_customer                          [Restricted — leaf-level]
 │    └── Hierarchy: Customer Hierarchy
 │         ├── Level 0 (broadest): region             [Public]
 │         ├── Level 1:            country            [Public]
 │         ├── Level 2:            state              [Internal]
 │         └── Level 3 (leaf):     customer           [Restricted]
 │
 └── Dimension: dim_product                           [Internal]
      └── Hierarchy: Product Hierarchy
           ├── Level 0: category                      [Public]
           ├── Level 1: subcategory                   [Public]
           └── Level 2 (leaf): product                [Internal]
```

This graph drives every subsequent query, **and** gates which queries are even allowed
to execute. Nothing is inferred from column naming at this stage.

---

## Phase 2: Hierarchy Level Chain Profiling (unchanged algorithmically; hardened controls)

### Per-level statistics

For every level in every hierarchy:

| Statistic | Query | Purpose | Classification gate |
|---|---|---|---|
| `member_count` | `COUNT(DISTINCT key_col)` | Absolute cardinality; determines memory footprint | Any class |
| `null_key_fraction` | `COUNT(NULL key) / COUNT(*)` | Data quality; affects join completeness | Any class |
| `label_uniqueness` | Boolean `is_unique_label` only | Whether labels are reliable for display | **Suppressed** when column is Restricted or member_count < k threshold (default 10) |
| `has_orphan_keys` | `orphan_key_fraction` (scalar) | Referential integrity gap | Confidential / Internal / Public; Restricted requires DP noise |

The `label_uniqueness` column is replaced by a **boolean** `is_unique_label` to avoid
the quantile-attack surface identified in `01_risk_register.md §R-2`. The exact ratio is
no longer emitted.

### Per-edge (rollup ratio) statistics

Unchanged query shape:

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

**New controls.** All eight scalars are DP-noised with the per-column ε budget
(`03_obfuscation_tactics.md §4`). If the parent level has fewer than `k` members
(default 50 for tier emission, 10 for ratio emission), tiers are suppressed and the
ratio statistics are coarsened to `{p50, p95}` only.

### Rollup tier buckets

Unchanged query; same k-gate as above. `q4_child_fraction` is **rounded to 5 % buckets**
before emission. Tier statistics are omitted when there are fewer than 8 parents (as
before) **and** when the parent-level classification is Restricted.

### Cold member fraction

Emitted as a **binned bucket** (`<5%`, `5–15%`, `15–35%`, `>35%`) rather than the raw
fraction, per `01_risk_register.md §R-4`.

---

## Phase 3: Leaf-Level Fact Density Profiling

Unchanged shape; hardened tail controls:

```sql
SELECT
  COUNT(*)                          AS total_fact_rows,
  COUNT(DISTINCT fk_col)            AS distinct_leaf_members_with_facts,
  AVG(rows_per_leaf)                AS avg_fact_density,
  STDDEV(rows_per_leaf)             AS stddev_fact_density,
  PERCENTILE_CONT(0.50) WITHIN GROUP (ORDER BY rows_per_leaf) AS p50_density,
  PERCENTILE_CONT(0.90) WITHIN GROUP (ORDER BY rows_per_leaf) AS p90_density,
  PERCENTILE_CONT(0.99) WITHIN GROUP (ORDER BY rows_per_leaf) AS p99_density,
  PERCENTILE_CONT(0.999) WITHIN GROUP (ORDER BY rows_per_leaf) AS p999_density,
  SUM(CASE WHEN fk_col IS NULL THEN 1 ELSE 0 END) * 1.0
    / COUNT(*)                      AS null_fk_fraction
FROM (
  SELECT fk_col, COUNT(*) AS rows_per_leaf
  FROM fact_table
  GROUP BY fk_col
)
```

**New: `max_density` is no longer emitted.** It is replaced by `p999_density` which is
itself winsorized at generation time to protect against singleton tails — see
`01_risk_register.md §R-5`.

The density distribution shape drives, as before:

- Hash join cost, broadcast vs. shuffle decision, partition pruning effectiveness,
  pre-aggregation value. All four consumers accept the P99.9 ceiling as equivalent to
  the old P99 + max pair for cost estimation.

---

## Phase 4: General Column Profiling

For columns not covered by hierarchy-specific passes (secondary attributes, degenerate
dimensions, measures), apply standard statistical profiling, **with per-type
classification gates**.

### Numeric columns (measures, IDs) [Classification: Confidential default]

| Statistic | Purpose | Control |
|---|---|---|
| `MIN`, `MAX` | Scalar bounds | **Winsorized** to `[P1, P99]`; raw MIN/MAX no longer emitted |
| `MEAN`, `STDDEV` | Spread | DP-noised |
| Percentiles: P5, P25, P50, P75, P95, P99 | Distribution shape without storing values | DP-noised; collapsed to P10, P50, P90 when `member_count < 1000` |
| Shape hint | log-normal / normal / uniform / power-law | Derived from noised moments |

### Measure-to-measure Pearson correlation

Unchanged formula. New controls:

- Rounded to 2 decimals before emission.
- Suppressed for any pair where either measure has `contributor_count < 500`.
- `CORR()` fallback runs server-side only (`SELECT (AVG(m1*m2) - …) FROM fact`); client-side
  materialization is disabled (`01_risk_register.md §R-22`).

Capped at the first 10 numeric measures per fact (45 pairs maximum).

### Categorical columns (low-cardinality strings/integers)

| Statistic | Purpose | Control |
|---|---|---|
| Distinct count `K` | Number of categories | DP-noised |
| Normalized frequency vector | Sorted probability vector | Values with real count < k=5 are **collapsed into an `other` bucket** before emission |
| Entropy score | Skew vs. uniform | Computed from the collapsed vector |

No actual category values are stored.

### String attribute columns

Pattern-based descriptor only, unchanged from the original, classified at the level of
the containing column.

### Date/timestamp columns

Unchanged: relative span, distribution shape, granularity. **Explicit invariant**
added: the fingerprint writer rejects any `date_column` section containing an absolute
ISO-8601 value (`01_risk_register.md §R-9`).

### Semi-additive measures

Unchanged. Additivity verification query now runs server-side only, no client-side
join.

---

## Phase 5: Conformed Dimension Cross-Fact Profiling

Unchanged in algorithm; `overlap_fraction` rounded to 5 % buckets before emission
(`01_risk_register.md §R-10`).

### FK pairwise association

Unchanged formula. Controls added:

- Suppressed and replaced by boolean `is_near_functional` when
  `associationScore > 0.9` and either FK has k-anonymity below the default k threshold.
- Rounded to 2 decimals.

---

## Phase 6: Obfuscation Rules — Now Enforced

The seven rules in the original document are no longer advisory. They are a schema
validator that runs on every fingerprint write. Violation aborts the run.

1. **Table and column names** → synthetic identifiers; mapping discarded, never
   emitted.
2. **Categorical frequency vectors** store only relative frequencies, never actual
   values. Rare categories (< k=5) collapsed to `other`.
3. **Numeric ranges and percentiles** are stored with DP noise and winsorization
   as specified in Phase 3/4 above.
4. **String patterns** are structural; no example strings stored.
5. **Dates** are relative spans only; absolute dates explicitly rejected at write time.
6. **No sample rows** are ever stored. The entire file is derived from aggregate SQL.
   A validator scans the emitted YAML for any structure resembling a row and rejects.
7. **Small tables** (`row_count < 5000`) always run under DP-on mode with noise at the
   tighter budget. This replaces the original "special treatment" prose with an
   enforced numeric constant.

---

## Phase 7: Reconstruction — DDL Generation

Implemented by the new operation `generate-synthetic-data-from-sml` (DDL emission is a
sub-phase of that operation, rather than a standalone CLI). The algorithm is identical
to the original document's Phase 7:

- Deterministic mapping from fingerprint IDs to structural names.
- Dialect-appropriate type mapping (ANSI, Snowflake, MySQL, BigQuery).
- PK on first-hierarchy leaf, FK per fact join; constraints omitted for `bigquery`
  dialect.

(See the original STATISTICS.md Phase 7 tables for the full mapping; they are
reproduced verbatim in the implementation.)

---

## Phase 8: Reconstruction — Synthetic Data Generation

Implemented by the two new operations:

- `generate-synthetic-data-from-sml` — emits CSV under the supplied output directory.
- `generate-synthetic-data-from-connection` — emits DDL + multi-value `INSERT` against
  the supplied connection, respecting FK order (dimensions before facts on create, facts
  before dimensions on drop).

### 8.1 Seeded PRNG

**mulberry32** 32-bit seeded PRNG, unchanged. `randNormal` via Box-Muller.

### 8.2 Dimension table generation

Unchanged from the original. Every emitted leaf key must match the
synthetic-key regex. The allowed-subset cache for the next phase is keyed by
**synthetic positional index**, never by a real FK value (fails-closed invariant,
`01_risk_register.md §R-16`).

### 8.3 Fact table generation

Unchanged. FK pairwise-association logic as in the original, but the allowed-subset
cache is restricted to synthetic keys only.

### 8.4 Output

- **CSV output** — `generate-synthetic-data-from-sml`: dimensions first, then facts, to
  the `--output` directory.
- **Database output** — `generate-synthetic-data-from-connection`: multi-value `INSERT`
  statements in configurable batches. When `--drop-if-exists` is set the operation drops
  fact tables before dimension tables and creates dimension tables before fact tables,
  respecting FK constraints throughout.

Both operations write a `pipeline_isolation_report.json` next to their output
(`03_obfuscation_tactics.md §7.3`).

### 8.5 Naming conventions

Unchanged from the original STATISTICS.md §8.5 table.

---

## Key Design Tensions

**Fidelity vs. privacy.** Higher-order moments produce a better twin but increase
disclosure risk on small tables. Mitigated by the Phase 6 §Rule 7 enforced constant
(`row_count < 5000 ⇒ DP-on`) and by the k-anonymity / l-diversity gates in
`03_obfuscation_tactics.md §5`.

**Column independence vs. correlation.** Handled as in the original document, by three
aggregate-only statistics (tiers, measure Pearson r, FK association score), each now
classification-gated and DP-noised.

**Schema inference vs. explicit FK metadata.** Unchanged treatment; the inference path
still exists as a fallback when declared FK constraints are missing.

---

## Deviations from the original STATISTICS.md (summary)

| # | Deviation | Source finding |
|---|---|---|
| 1 | New §0 opens the document with the twin strategy | Prompt Phase 4 requirement |
| 2 | Every measure/dimension annotated with sensitivity class | Prompt Phase 4 requirement |
| 3 | Operation names changed to `generate-synthetic-data-from-{sml,connection}` | User directive at prompt end |
| 4 | `label_uniqueness` → `is_unique_label` boolean | §R-2 |
| 5 | `cold_member_fraction` binned | §R-4 |
| 6 | `max_density` dropped; `p999_density` added and winsorized | §R-5 |
| 7 | Percentile ladder collapsed for small tables | §R-6 |
| 8 | Pearson r rounded + k-gated | §R-7 |
| 9 | Absolute-date rejector | §R-9 |
| 10 | `overlap_fraction` binned | §R-10 |
| 11 | `associationScore > 0.9` replaced by boolean | §R-11 |
| 12 | Phase 6 obfuscation rules now enforced by a validator | §R-12 |
| 13 | Rare categorical values collapse to `other` | §R-13 |
| 14 | Synthetic-key regex invariant, fail-closed | §R-15, §R-16 |
| 15 | Run record + WORM audit log | §R-18, Layer 6 |
| 16 | Access tier spec | §R-19, Layer 3 |
| 17 | Export classification | §R-20 |
| 18 | Small-table threshold set to 5000 | §R-21 |
| 19 | `CORR()` fallback server-side only | §R-22 |
| 20 | Orphan check returns scalar | §R-23 |
| 21 | DP ε budget per column | §R-24, Layer 4 |
| 22 | Fingerprint file signed Ed25519 | §R-25 |
| 23 | Pipeline isolation report at run end | `03_obfuscation_tactics.md §7` |

**Analytical utility is unchanged.** Every statistic that drives OLAP cost estimation or
copula reconstruction survives the revision; only re-identification-relevant parameters
are coarsened or suppressed. Phase 6 (TSTR) certifies the utility envelope holds.

---

## Non-alteration declaration

This file is the Phase-4 rewrite and resides under `/review/`. It does not alter or
supersede any existing pipeline configuration, data source connection, SML model,
catalog, repository, deployment, role, permission, or schedule. The in-tree
`STATISTICS.md` remains authoritative until an explicit promotion step, separate from
this review, replaces it.
