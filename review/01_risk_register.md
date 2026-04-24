# 01 — Risk Register: Adversarial Audit of `STATISTICS.md`

> Adversarial read of `STATISTICS.md` @ `22697cc`. Every section is evaluated as if the
> data underneath is a federal-employee or HNW-individual customer register under the
> strictest applicable regime (GLBA for financial, Privacy Act §552a for federal,
> HIPAA-equivalent handling for health-adjacent fields, GDPR Art. 4(1) quasi-identifier
> logic as the global floor).

Source: `/Users/nate/ps-template/ps-template/STATISTICS.md`
Date: 2026-03-27

---

## Methodology

1. Walk `STATISTICS.md` phase by phase.
2. For each statistic, measure, or SQL template, ask:
   - Does this require real data to be *read* at any point?
   - Does the statistic, even in aggregate form, leak individual membership or attribute?
   - Does combining two or more published statistics re-identify?
   - Is there a sanitization, access-tier, or masking step between real data and output?
3. Severity scale:
   - **Critical** — direct PII or near-certain re-identification from disclosed outputs
   - **High** — re-identification plausible with modest auxiliary information
   - **Medium** — residual disclosure risk, requires accumulation of multiple outputs
   - **Low** — defense-in-depth recommendation, not an immediate exposure

---

## Risk Register

| # | Field / Section | Risk Type | Severity | Recommended Remediation |
|---|---|---|---|---|
| R-1 | "Phase 1: SML Model Parsing" — graph walks the live model; no PII sanitization gate | Input-path PII exposure: the profiler is presumed to connect to a production warehouse and issue SQL against live tables containing raw PII before any synthetic surrogate exists. | **Critical** | Insert a **pre-flight sensitivity classification** step: profiler refuses to read any column whose `classification` in SML metadata is `Restricted` or unannotated. Require explicit allow-list. Run the profiler inside a **read-only replica** or masked view, never production primary. |
| R-2 | "Phase 2 §Per-level statistics — `label_uniqueness`" — `COUNT(DISTINCT label_col) / member_count` on `customer` leaf level | For leaf-level dimensions with `label_uniqueness ≈ 1.0` over a small `member_count`, the label column almost certainly contains a **direct identifier** (full name, account number). The query itself doesn't emit values, but the statistic signals to a downstream attacker that this column is a near-unique key. | **High** | Require SML-tier annotation `is_direct_identifier: true` on any column feeding `label_uniqueness`. If so, **do not emit** `label_uniqueness` — emit only a boolean `is_unique_label`. Add k-anonymity gate: if `member_count / label_uniqueness < k=5`, suppress the statistic entirely. |
| R-3 | "Phase 2 §Per-edge rollup ratio" + `tiers.q4ChildFraction` | On small dimensions (e.g. a customer hierarchy where the top-quartile parent is a single identifiable region — "District of Columbia" for federal employees), `q4ChildFraction` + `q4_avg_children` together can uniquely fingerprint a geographic cohort, enabling cross-reference against public rosters. | **High** | Enforce the `STATISTICS.md` Phase 6 Rule 7 (small-table rule) **programmatically**: refuse to emit tier statistics when the *parent* level has `member_count < 50` or when any tier's child total is < 25. Add Laplace noise at ε ≤ 1.0 to `q4_avg_children` and `q4_child_fraction` for all tiers. |
| R-4 | "Phase 2 §Cold member fraction" | `cold_member_fraction = 0.08` tells an attacker that ~8% of members are dormant. Combined with `member_count`, that is an absolute count of dormant members — a useful signal for fraud actors to target inactive-account takeover. | **Medium** | Bin `cold_member_fraction` into coarse buckets (`<5%`, `5–15%`, `15–35%`, `>35%`) before export. Never emit the raw fraction alongside `member_count` at leaf level without a bucketing transform. |
| R-5 | "Phase 3: Leaf-Level Fact Density" `p99`, `max_density` | High-cardinality tails (`p99 = 980`, `max = 14200`) for a customer-keyed fact can identify the top customer as a statistical outlier — combined with any public "largest customer by X" disclosure, membership inference becomes trivial. | **High** | Clip `max_density` to `p99.9` before storage; winsorize `p99` if `p99 / p50 > 50`. Apply ε-DP noise to all percentiles above P95 with ε scaled to `1 / member_count`. |
| R-6 | "Phase 4 §Numeric columns" percentile ladder | Seven percentiles (P5, P25, P50, P75, P95, P99) over a sparse measure column form a **quantile attack surface**: given auxiliary knowledge of one customer's bucket, the attacker can narrow their value to a tight interval. | **Medium** | Collapse the ladder to P10, P50, P90 when `member_count < 1000`. Apply smooth sensitivity noise to all percentiles at the leaf-join surface. |
| R-7 | "Phase 4 §Measure-to-measure Pearson correlation" | Pearson r values in `measureCorrelations` are second-moment summaries of the joint distribution. On their own they are low risk; combined with published marginals they reconstruct a bivariate Gaussian approximation that may re-identify extreme records. | **Medium** | Gate behind a per-fact k-anonymity check on the FK cardinality of the fact. Round Pearson r to two decimal places; do not publish r for any pair where either measure has `member_count < 500` contributors. |
| R-8 | "Phase 4 §String attribute columns — Structural pattern" | The stated patterns (`email-like`, `phone-like`, `UUID`) plus length-distribution leak schema purpose. Combined with `label_uniqueness` (R-2), a regex pattern of "email-like" on a `member_count = 42 000` column confirms a customer email column exists — an exfiltration target hint. | **Low** | No structural change, but ensure the fingerprint file itself is classified **Confidential** at rest and in transit, and never shipped to a lower-trust environment without the user's written classification override. |
| R-9 | "Phase 4 §Date/timestamp columns — span" | "Span in days (relative)" is safe; but absolute anchor — if emitted alongside span in any downstream enrichment — becomes re-identifying (e.g. "account opened 2019-07-03" is near-unique for many customers). | **Medium** | Enforce at serialization time: date-column section may not contain any absolute-date key. Add a linting pass to the fingerprint writer that refuses `date`, `timestamp`, or `ISO8601` regex-matching values anywhere under a `date_column` key. |
| R-10 | "Phase 5 §Conformed dimension overlap_fraction" | A conformed-dim overlap of 41 % for `fact_budget` combined with its `row_count` pinpoints the budget table's dimension membership set — potentially re-identifying the specific budget cycles included. | **Low** | Round `overlap_fraction` to 5 % buckets. |
| R-11 | "Phase 5 §FK pairwise association" score formula | Even though no FK values are emitted, `associationScore` approaches 1.0 when a dimension pair is near one-to-one (e.g. a personal-advisor ↔ HNW-client mapping). At that score, the *existence* of such a mapping is itself a disclosure. | **Medium** | Suppress `associationScore` above 0.9 and replace with a boolean `is_near_functional` if k-anonymity on either FK is below 5. |
| R-12 | "Phase 6: Obfuscation Rules" — advisory, not enforced | Rules 1–7 describe obfuscations but the algorithm as written does not *require* them to be applied — there is no programmatic gate that prevents a profiler run from emitting raw column names, raw category labels, or sample rows. | **Critical** | Convert Rule 1–7 from prose into a **schema validator** that every fingerprint file is checked against before write. Any violation aborts the profiler run with a non-zero exit. This validator is authored in Phase 4's revised proposal. |
| R-13 | "Phase 6 §Rule 2" category frequency vectors | `[0.51, 0.49]` on a gender column is safe; `[0.98, 0.02]` on a race column in a small dimension is a group-level disclosure (Title VII, 42 U.S.C. §2000e) and a membership-inference enabler. | **High** | Introduce `min_category_count` floor (≥ k=5 members per published category) and bucket sub-floor categories into `other`. |
| R-14 | "Phase 7: DDL Generation — PRIMARY KEY on leaf" | Leaf PK on a customer-keyed dimension makes individual-row-join against any other table trivial for anyone with read on both. | **Low** | No algorithmic change — documentation only. Annotate in the revised proposal that the PK is expected only against *synthetic* leaf keys generated by the mulberry32 PRNG, never real keys. |
| R-15 | "Phase 8.2 §Root level — generate `memberCount` synthetic string keys" | The algorithm generates synthetic *string* keys. If an implementer mistakenly echoes real keys through this path (copy-paste error, silent fallback), the output contains real PII while labeled "synthetic." | **Critical** | Add an invariant check: every emitted key must match a regex of known synthetic-key shape (e.g. `^syn_[0-9a-f]{8}$`) before write. Fail closed. Equivalent check on label columns against the real-label bloom filter (below, R-17). |
| R-16 | "Phase 8.3 §FK assignment" | If the profiler reads real FK values into the `Map<dim1Key, number[]>` allowed-subset cache and that cache leaks into the synthetic output, every "synthetic" fact row carries a real FK. | **Critical** | The allowed-subset cache must store **synthetic** key references keyed by **synthetic-dim positional index**, never by the real FK value. Unit test: boot the generator with a sentinel real FK in the cache; assert no sentinel appears in output. |
| R-17 | No adversarial-leak test in the proposal | The algorithm is never tested for information leakage of individual real rows through its outputs. | **High** | Add a **membership-inference test suite** (Phase 6): train a binary classifier on `(was_this_customer_in_source_data, synthetic_fingerprint_vector)` and certify AUC ≤ 0.55 (random-chance ± 5%). Ship a real-key bloom filter that the generator asserts against at emit time. |
| R-18 | Data lineage not tracked | `STATISTICS.md` never names a lineage system, audit log, or retention policy for the profiler's run artifacts (SQL plans, intermediate statistics, debug outputs). | **High** | Require the profiler to emit an immutable run record: `{run_id, profiler_version, sml_model_hash, source_connection_hash, ε_values, k_values, emitted_files[], started_at, completed_at}` to a WORM log. |
| R-19 | Access tiering absent | No statement that profiler access credentials differ from application or analyst credentials. | **High** | Specify: profiler uses a dedicated service account with `SELECT`-only grant on a *masked view layer*, never on base tables. Credential rotation on every run. No interactive grant path. |
| R-20 | Visualization / export surface unbounded | The doc describes writing the fingerprint YAML and CSV/SQL outputs without specifying classification, encryption, or export control on those artifacts. | **High** | Default classification **Confidential**; AES-256-GCM at rest; TLS 1.3 in transit; blocked from any Tableau / Power BI / Excel export path without a Restricted-data-review sign-off. |
| R-21 | Phase 6 Rule 7 small-table threshold is advisory ("~1000 rows") and unquantified | "~1000" in prose, no enforced numeric constant. | **High** | Replace with an enforced constant `MIN_ROWS_FOR_UNMASKED_FINGERPRINT = 5000` (configurable), below which the profiler switches to DP noise mode automatically. |
| R-22 | `CORR()` fallback executes `(AVG(m1·m2) − …)` on the raw sample | The fallback path computes on raw measure values — correct mathematically, but it requires the sample to be materialized in the profiler process memory. A crash dump or swap of that process leaks raw values. | **Medium** | Require server-side evaluation of the fallback (wrapped as a single `SELECT (AVG(m1*m2) - AVG(m1)*AVG(m2)) / (STDDEV(m1)*STDDEV(m2)) FROM fact`) and disable any client-side materialization path. Disable core dumps on the profiler process; run with `ulimit -c 0`. |
| R-23 | Orphan-key check reads real keys | "`has_orphan_keys` — Keys in fact absent from dimension" implies a set-difference on the key universe — requires the profiler to see key values. | **Medium** | Replace with `orphan_key_fraction = COUNT(*) FILTER (fk NOT IN dim_keys) / COUNT(*)` evaluated server-side; profiler receives only the scalar fraction. |
| R-24 | No differential-privacy ε budget | Multiple queries against the same column compound disclosure. | **High** | Adopt a per-column ε budget (financial: ε ≤ 1.0 total across all profile statistics; federal / HNW: ε ≤ 0.3). Track budget consumption in the run record (R-18) and refuse queries that would exceed it. |
| R-25 | No threat model for the fingerprint file itself | The fingerprint YAML is itself an asset requiring protection; STATISTICS.md treats it as a low-sensitivity artifact. | **High** | Classify the fingerprint file as **Confidential** by default, **Restricted** when any input source was Restricted. Sign the file (Ed25519) with the profiler service key; downstream generators reject unsigned or mis-signed inputs. |

---

## Aggregate severity summary

| Severity | Count |
|---|---|
| Critical | 4 |
| High | 11 |
| Medium | 7 |
| Low | 3 |

Four **Critical** findings (R-1, R-12, R-15, R-16) must be remediated before any
profiler run against real data. They are addressed structurally in Phase 2 (synthetic
twin as primary input) and Phase 3 (obfuscation gates + fail-closed invariants).
