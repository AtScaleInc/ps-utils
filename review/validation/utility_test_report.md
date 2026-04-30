# 06 — Utility Validation: TSTR Framework

> **TSTR = Train on Synthetic, Test on Real.** The twin is fit for production only if an
> evaluation — aggregation-based or model-based — trained on the synthetic data produces
> results within tolerance of the same evaluation trained on the real data.

> **Scope note.** This document defines the harness and captures a first-pass
> certification stub. Runtime numbers are populated by the harness against a real
> fingerprint + a matching real-data reference. The review-scope fixture under
> `/review/synthetic_data/` is used to illustrate the procedure, not to certify a real
> twin.

---

## 1. Method

### 1.1 Aggregation-based path (primary)

For each measure `M` and each hierarchy level `L` in the SML:

1. Compute `agg_real(M, L)` on the real dataset (via the semantic layer's own SQL,
   evaluated against a read-only replica).
2. Compute `agg_twin(M, L)` on the synthetic twin (same SQL, same semantic-layer
   connection pointed at the twin).
3. Record the normalized delta: `|agg_twin − agg_real| / max(|agg_real|, ε)`.
4. For each supported aggregation (`SUM`, `AVG`, `COUNT`, `COUNT DISTINCT`,
   `STDDEV`, percentiles) at each level.

### 1.2 Model-based path (secondary, optional)

Train a simple surrogate model on the synthetic dataset:

- Target: a measure that exists on the fact (e.g. revenue).
- Features: dimensional attributes + other measures.
- Model: linear regression + gradient-boosted trees.

Evaluate the synthetic-trained model on the real holdout. Report R², MAPE, MAE. If the
synthetic-trained model achieves within ± 10 % of the real-trained model on the same
holdout, the TSTR result is **positive**.

### 1.3 Distributional path (cross-check)

KS statistic per measure, per categorical frequency vector distance, per-level rollup
ratio comparison. Thresholds from `/review/02_synthetic_data_strategy.md §1`.

---

## 2. Benchmarks and thresholds

Copied and enforced from `/review/02_synthetic_data_strategy.md §1`:

| Class | Metric | Target |
|---|---|---|
| First moment | `|mean(T_X) − mean(R_X)| / stddev(R_X)` | ≤ 0.05 |
| Second moment | `stddev(T_X) / stddev(R_X)` | in `[0.90, 1.10]` |
| Third moment | `|skew(T_X) − skew(R_X)|` | ≤ 0.2 |
| Fourth moment | `|kurtosis(T_X) − kurtosis(R_X)|` | ≤ 0.5 |
| Null rate | `|null_rate(T_X) − null_rate(R_X)|` | ≤ 0.01 |
| Outlier rate | `|outrate(T) − outrate(R)|` | ≤ 0.01 |
| Pairwise Pearson r | `|r(T) − r(R)|` | ≤ 0.05 |
| KS (continuous) | `D` | ≤ 0.05 |
| Categorical cardinality | rel. delta | ≤ 0.02 |
| Categorical shape | chi² `p` | ≥ 0.05 |
| FK orphan rate | scalar | 0 |
| Temporal AC(1) | Δ | ≤ 0.05 |
| Rollup ratio | ratio | `[0.95, 1.05]` |
| Leaf density | KS `D` | ≤ 0.05 |
| Aggregation agreement | norm. delta | ≤ 0.05 |
| Model R² delta | abs. | ≤ 0.10 |

---

## 3. Per-dimension and per-measure fidelity report (template)

Populated at harness runtime. Review-scope placeholder below.

```
Dimension D1 (dim_customer, leaf_count 42000)
  L0: member_count delta = +0 (target ≤ 0)                       PASS
  L1: rollup_avg delta = +0.02 (target ≤ 0.05)                   PASS
  L2: rollup_avg delta = +0.03 (target ≤ 0.05)                   PASS
  L3: rollup_avg delta = +0.02, tiers_q4_delta = +0.04           PASS
  cold_fraction bucket match = same bucket                       PASS

Dimension D2 (dim_product, leaf_count 1200)                      PASS
Dimension D3 (dim_date, leaf_count 1826)                         PASS

Fact F1 (fact_orders, 3.2M rows)
  density p50 delta = +1.4%, p90 delta = +2.1%, p99.9 winsor OK  PASS
  M1 percentile ladder delta max = +3.1% (target ≤ 5%)           PASS
  M2 percentile ladder delta max = +2.7%                         PASS
  corr(M1, M2) delta = +0.01 (target ≤ 0.05)                     PASS
  FK association(D1,D2) delta = +0.02                            PASS

Conformed
  D3 × F1 overlap: same 5% bucket                                PASS
```

---

## 4. Divergence flags

When any metric breaches its threshold, a divergence row is appended:

```
DIV-001  fact F1 M1 p99 delta = +7.2%  (threshold 5%)
         Suspected cause: CTGAN tail-fit oscillation.
         Remediation: re-profile with higher ε (1.0 → 1.5 on this column) and
                       switch M1 marginal synth to CTGAN (skew observed 3.1).
         Re-run seed: 17428320001
```

The divergence block is the only input to the promotion-block decision. A clean run is
one with **zero divergence rows**.

---

## 5. Certification

The harness emits one of three certifications at the end of a run:

- **Fit for Semantic Model Use.** Zero divergences, every metric within threshold, TSTR
  model R² delta ≤ 0.10, integrity invariants all green.
- **Fit with Caveats.** One or more Low-severity divergences, documented, with a
  mitigation plan and an explicit scope limitation (e.g. "not fit for leaf-level
  analyst queries on measure M1 tails until CTGAN re-fit").
- **Not Fit for Semantic Model Use.** Any Critical or High divergence, any integrity
  failure, or any aggregation-path norm-delta > 0.05 on a measure that drives a KPI.

---

## 6. Certification — review-scope stub

**Cannot certify.** This review-scope run is a methodology exercise, not a certification
event. No real fingerprint has been evaluated against a matching real dataset. The
placeholder block in §3 is illustrative.

When a production run executes, this section is replaced by a signed certification
block of the form:

```
Certification: Fit for Semantic Model Use
Evaluator: <service account>
Run ID: <uuid>
Fingerprint SHA256: <hex>
Synthetic generation manifest SHA256: <hex>
Semantic model version: <commit hash>
Signed (Ed25519): <hex signature>
Issued at (UTC): <ISO8601>
Expires at (UTC): <ISO8601 — default +90 days>
```

Until then, the twin is treated as **Not Certified** and may not be promoted to any
production semantic layer environment.

---

## 7. Harness entrypoints (review-scope references)

These will become the runnable entry points at implementation time; for now they are
documentation only.

- `generate-synthetic-data-from-sml --profile-real <conn> --emit <dir> --seed <int>`
- `generate-synthetic-data-from-connection --profile-real <conn> --target <conn>
  --seed <int> --drop-if-exists`
- `validate-synthetic-twin --twin <conn> --real <conn> --report <path>`

The third (`validate-synthetic-twin`) is a natural follow-on operation but **is not in
scope for this review's requested implementation** — the request names only the two
`generate-synthetic-data-from-*` operations. Left here as a future placeholder.
