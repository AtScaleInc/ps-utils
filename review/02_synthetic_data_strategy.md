# 02 — Synthetic Digital Twin Architecture

> **Goal.** Produce a drop-in replacement for the real dataset that is statistically
> indistinguishable across every dimension the semantic model cares about, with zero real
> customer records surviving the pipeline.

> **Outputs produced by this phase.**
> * This strategy document.
> * Schema + worked-example synthetic data files under `/review/synthetic_data/`.
> * None outside `/review/`.

---

## 0. Pipeline shape

```
           ┌─────────────────────┐        ┌──────────────────────┐
Real DB ──▶│  Profiler (R/O)     │──fpr──▶│  Generator           │──▶ Synthetic DB / CSV
           │  SML-aware,         │        │  Seeded, deterministic│
           │  ε-DP, k-anon gated │        │  Gaussian copula      │
           └─────────────────────┘        └──────────────────────┘
                   ▲                                ▲
                   │ signed fingerprint (yaml)      │ same fingerprint, different seed
                   │                                │
                 WORM run record                  public schema twin
```

Profiler ≡ Phase 1–6 of `STATISTICS.md` (hardened per §01 Risk Register).
Generator ≡ Phase 7–8 of `STATISTICS.md` (hardened per `03_obfuscation_tactics.md`).

The real dataset is touched **only** by the profiler, and only through a masked
`SELECT`-only view tier (§R-1, §R-19). Every downstream consumer sees the synthetic twin.

---

## 1. Fidelity requirements (statistical indistinguishability targets)

For a twin `T` of a real dataset `R`, the twin is **fit** if, for every dimension or
measure `X` materially used by the semantic model:

| Class | Metric | Target |
|---|---|---|
| First moment | `|mean(T_X) − mean(R_X)| / stddev(R_X)` | ≤ 0.05 |
| Second moment | `stddev(T_X) / stddev(R_X)` | in `[0.90, 1.10]` |
| Third moment | `|skew(T_X) − skew(R_X)|` | ≤ 0.2 |
| Fourth moment | `|kurtosis(T_X) − kurtosis(R_X)|` | ≤ 0.5 |
| Null rate | `|null_rate(T_X) − null_rate(R_X)|` | ≤ 0.01 |
| Outlier rate (∣z∣ > 3) | `|outrate(T) − outrate(R)|` | ≤ 0.01 |
| Pairwise Pearson r | `|r(T_i,T_j) − r(R_i,R_j)|` | ≤ 0.05 |
| KS statistic (continuous) | two-sided `D` | ≤ 0.05 |
| Categorical cardinality | `|card(T_X) − card(R_X)| / card(R_X)` | ≤ 0.02 |
| Categorical frequency shape | chi-squared `p` (T vs. R) | ≥ 0.05 |
| Referential integrity | orphan FK rate in `T` | 0 |
| Temporal | autocorrelation at lag 1 (per grain) | within ± 0.05 of `R` |
| Temporal | seasonal strength (STL) | within ± 0.05 of `R` |
| Rollup ratio | per-edge ratio of T rollup vs. R rollup | in `[0.95, 1.05]` |
| Leaf density shape | KS on rows-per-leaf | ≤ 0.05 |

Phase 6 (TSTR) exercises these programmatically.

---

## 2. Per-column-type generation strategy

The generator is a **deterministic, seeded copula** (as `STATISTICS.md` Phase 8 already
describes) layered with column-type-specific marginal samplers:

### 2.1 Numerical columns (measures, numeric attributes)
- Multivariate Gaussian copula, parametrized from the fingerprint's measure-correlation
  matrix (§Phase 4 in STATISTICS.md) and the eight-point percentile ladder.
- **Tool recommendation:** **SDV**'s `GaussianCopulaSynthesizer` (mature, MIT license,
  handles marginal + correlation jointly) OR, for higher-fidelity tails, **CTGAN** when
  `skew > 2.0` or `kurtosis > 7.0`.
- Fallback for low-cardinality integer measures (e.g. count of checks written): treat as
  categorical-integer and use a frequency-weighted sampler.

### 2.2 Categorical columns (low-cardinality strings, status codes)
- Frequency-weighted sampling from the fingerprint's **sorted normalized frequency
  vector** — values are invented at generation time per §R-2, §Phase 6 Rule 2.
- Rare categories (< k=5 real members) collapse to `other` pre-publication.
- **Tool recommendation:** **Mimesis** or **Faker** for producing synthetic labels that
  match domain surface (e.g. `iso_country`, `currency_code`); wrap with a provider
  that enforces the invented-label invariant (R-15).

### 2.3 Temporal columns (dates, timestamps)
- Time-series-aware generation. Span-only (relative) from fingerprint; anchor date is
  chosen at generation time from a user-configurable `--anchor-date` flag, defaulting to
  `today - span_days/2`.
- Seasonality: STL decomposition at profile time → seasonal, trend, residual components
  are each summarized; at generation time, a low-rank reconstruction is re-sampled from
  a Gaussian on the residual plus the deterministic seasonal/trend.
- **Tool recommendation:** **SDV** `PARSynthesizer` for sequential fidelity; **synthpop**
  as a cross-check for the non-sequential case.
- Never emit absolute real dates (§R-9); the anchor date comes from the flag, not from
  the fingerprint.

### 2.4 Free text and identifiers
- Faker/Mimesis providers parameterized by the fingerprint's length distribution and
  character-class composition. Pattern-driven (UUID, email-ish, phone-ish) only — never
  template by example.
- Surrogate SSNs / account numbers: **Gretel.ai** tokenization (vault-backed reversible)
  when operating against a real-data window; **pure Faker** (non-reversible) in
  twin-only mode.
- Every identifier must match the synthetic-key regex (`^syn_[0-9a-f]{8}$` or
  operation-specified) per §R-15.

### 2.5 Geospatial columns (postal, lat/lon, region)
- Postal codes drawn from a regional-distribution-matched generator (e.g. Mimesis's
  `Address.postal_code(region=…)` with regional weights derived from the fingerprint's
  categorical frequency vector for the geography column).
- Lat/Lon: jittered around regional centroid at a radius calibrated to the fingerprint's
  geographic spread (one scalar per region). Never near the real centroid of an
  individual record.

### 2.6 High-cardinality free text (comments, notes)
- Not typically required by the semantic model (degenerate dimensions only). If
  included, **ydata-profiling** for measuring, **Gretel.ai LLM-based synthesizer** for
  generating at comparable length + linguistic profile. Opt-in only — off by default
  because it expands the attack surface and rarely drives OLAP query cost.

---

## 3. Referential integrity preservation

The generator must honor the full relationship graph from SML:

1. **Build synthetic dimensions first**, leaf-last (top-down hierarchy walk, §Phase 8.2).
2. **Generate synthetic FK universes** from the leaf key sets of each dimension.
3. **Build fact rows** via the STATISTICS.md Phase 8.3 process:
   - Anchor leaf assignment via cold-fraction gate + density sampling.
   - Multi-FK assignment via the FK-pair association subset cache (keyed by **synthetic
     positional index**, never by real FK — §R-16).
4. **Assert referential integrity** post-generation: every fact FK value exists in the
   corresponding synthetic dimension leaf. Zero tolerance for orphan FKs in the twin.
5. Emit a `integrity_report.json` into `/review/synthetic_data/validation/`
   (review-scope; in production the report is emitted next to the operation output).

---

## 4. Drop-in replacement — zero schema change

Because the generator reuses the SML model as the structural source of truth, the
emitted DDL (`STATISTICS.md` Phase 7) matches, column-for-column, the DDL that a human
would derive from the same SML. The semantic layer therefore points at either the real
or the twin by changing **only the connection string** — no catalog, no role, no
measure definition is touched.

Invariants enforced (Phase 3 hardening):

- Column names in the twin DDL match SML-derived column names *exactly*, byte-for-byte.
- Column types are the dialect-appropriate mapping from SML dataType, per
  `STATISTICS.md` §Phase 7 table.
- Primary key / foreign key positions identical.
- Nullability matches (null fractions captured in fingerprint drive nullability at
  generation time).

---

## 5. Tool-selection matrix

| Requirement | Primary | Backup | Why |
|---|---|---|---|
| Correlated numerical measures | **SDV `GaussianCopulaSynthesizer`** | `CTGAN` | Deterministic, seedable, trivially round-trips a copula; CTGAN for heavy-tailed cases. |
| Heavy-tailed numeric (skew > 2, kurt > 7) | **CTGAN** (`sdv-single-table[ctgan]`) | `synthpop` | Generative adversarial model fits tails SDV copula misses. |
| Sequential / temporal | **SDV `PARSynthesizer`** | `synthpop` | Preserves autocorrelation and seasonality. |
| Categorical labels (domain-realistic) | **Mimesis** | `Faker` | Locale-rich, faster than Faker, invented-label guarantee. |
| PII surrogates (names, addresses, emails) | **Faker** | `Mimesis` | Largest provider set in Python ecosystem. |
| Reversible tokens for brief real-data window | **Gretel.ai `Tokenizer`** | In-house AES-FF3-1 vault | Vendor vault + audit log; for FPE constraints. |
| Multi-table joint distribution (when copula insufficient) | **SDV `HMASynthesizer`** | **DataSynthesizer** | Hierarchical multi-table fits star schemas natively. |
| Utility assessment (TSTR) | **SDV evaluation suite** + **ydata-profiling** | `synthpop.compare` | Needed for Phase 6. |
| Differential-privacy noise on aggregate statistics | **DataSynthesizer** (DP mode) | In-house Laplace / Gaussian primitives | DP-calibrated at the fingerprint level, not the row level. |

**Default stack for this proposal:** SDV (`GaussianCopulaSynthesizer` + `PARSynthesizer`
+ evaluation), Mimesis for labels, Faker for PII surrogates, DataSynthesizer for
DP-noised aggregates, ydata-profiling for profile-vs-profile diffs. CTGAN reserved for
heavy-tail measures detected at profile time.

**Why not Gretel by default:** SaaS-hosted; data must leave the perimeter. Acceptable
only for the narrow reversible-tokenization role in Phase 3.

---

## 6. Compliance posture matrix

| Regime | Default ε budget (per column) | Default k threshold | DP primitive |
|---|---|---|---|
| Financial (GLBA) | 1.0 | 5 | Laplace |
| Federal employee (Privacy Act) | 0.3 | 10 | Gaussian |
| Health-adjacent (HIPAA-like) | 0.5 | 10 | Gaussian |
| EU personal data (GDPR) | 0.5 | 5 | Laplace |
| Default (ambiguous) | 0.3 | 10 | Gaussian |

These values feed the Phase 3 obfuscation layer and the Phase 5 gate checklist.

---

## 7. Synthetic data layout (under `/review/synthetic_data/`)

```
review/synthetic_data/
├── README_synthetic.md
├── fingerprint_synthetic.yaml       # Worked example from STATISTICS.md §"The Fingerprint File Format"
├── schema_synthetic.sql              # DDL derived from fingerprint, ANSI dialect
├── dim_1_synthetic.csv               # Synthetic customer dimension
├── dim_2_synthetic.csv               # Synthetic product dimension
├── dim_3_synthetic.csv               # Synthetic date dimension
├── fact_1_synthetic.csv              # Synthetic orders fact
├── generation_manifest.json          # Seed, PRNG, toolchain, version, hash
└── validation/
    ├── integrity_report.json         # FK + null + count invariants
    └── fidelity_report.json          # Phase 6 TSTR outputs (runtime-populated)
```

All paths resolve only within `/review/synthetic_data/`. No reference to any existing
path under `example/`, `query_results/`, `resources/`, `src/`, or the user's real
warehouse is made.

---

## 8. Generation recipe (the one-pager)

1. **Ingest**: read the signed fingerprint YAML (Ed25519 per §R-25). Abort on bad
   signature.
2. **Plan**: derive per-dimension hierarchy walk order; validate that every fact's FK
   targets a known dimension leaf.
3. **Seed**: mulberry32(`--seed`). Record seed in `generation_manifest.json`.
4. **Dimensions**: for each dim, emit leaf keys matching synthetic-key invariant.
5. **Rollup**: apply tier-aware or flat rollup per §Phase 8.2, scaling to target counts.
6. **Facts**: anchor-leaf density budget, FK assignment via synthetic-index cache,
   measures via Gaussian copula through the percentile ladder.
7. **Integrity**: assert every FK resolves; assert no real-key regex match anywhere in
   output; assert category vector invariants (no rare value < k).
8. **Sign + emit**: write CSV or DB via the operation; sign manifest; emit WORM record.

Phase 6 wraps this with the TSTR check before any "Fit for Semantic Model Use" stamp.
