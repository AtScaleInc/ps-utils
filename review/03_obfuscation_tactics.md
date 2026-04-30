# 03 — Obfuscation Tactics for Residual Real-Data Touchpoints

> Defines the layered defense that applies **only during the profiler window** — the
> narrow interval where real data is read to produce the fingerprint that seeds the
> synthetic twin. Outside that window, the generator operates on the fingerprint only
> and never touches real data.
>
> **Pipeline isolation confirmation.** Every control below writes, logs, encrypts, or
> tokenizes within `/review/` for the review scope, and within the operation's own
> output directory or the WORM audit store at production time. **None** of these controls
> write to any path outside `/review/` during this review exercise; no existing file,
> table, or data connection is shadowed or modified.

---

## Layer 1 — Tokenization

Applied before any profiler query reads a field carrying a direct identifier.

| Field class | Tokenization mode | Implementation |
|---|---|---|
| SSN / SIN / TIN | Non-reversible HMAC-SHA256 + salt (per-run salt, discarded) | In-database UDF or server-side view column alias |
| Account ID / customer ID | Vault-backed reversible (needed for FK integrity during profile) | Gretel.ai Tokenizer OR in-house AES-FF3-1 vault; vault keys live in HSM, never in profiler memory |
| Email / phone | Non-reversible bcrypt (cost 12) | View column alias |
| Free-text names | Dropped at the view layer; profiler never sees the column | Column removed from the `_profile_view_` projection |
| Geographic (ZIP+4, full address) | Truncation + tokenization (ZIP-3 only, street/unit hashed) | View column alias |

Invariant: **the profiler connection string points at a view schema, never at the base
schema**. The view layer is the tokenization boundary.

---

## Layer 2 — Format-Preserving Encryption (FPE)

Used when a downstream consumer requires format constraints to be preserved (e.g. a
credit-card-format check) while the profiler is still running.

- **Algorithm:** AES-FF3-1 (NIST SP 800-38G Rev. 1). 128-bit or 256-bit key.
- **Tweak:** per-field, per-run, stored in the WORM run record (not in the fingerprint).
- **Scope:** only fields where format downstream matters; other fields use Layer-1
  non-reversible tokens.

FPE is **never** applied to the synthetic twin output — once the fingerprint exists,
the generator invents new identifiers from scratch, so encryption round-tripping is
moot.

---

## Layer 3 — Static vs. Dynamic Masking

| Environment | Posture |
|---|---|
| Dev / Test | **Static.** The real-data replica is permanently masked at ingest. Profiler always reads from the masked replica in these envs. |
| UAT / Pre-prod | **Static.** Same as dev/test; additionally the fingerprint signing key differs, so UAT fingerprints cannot pretend to be prod. |
| Prod | **Dynamic.** Role-based views in the semantic layer. Profiler's service role sees the tokenized projection. Analyst roles see masked PII; admin roles see raw only through a break-glass path with MFA + audit log entry. |

The masking layer is authoritative — no "profiler bypass" grant exists.

---

## Layer 4 — Differential Privacy

Every aggregate query the profiler emits injects calibrated noise before the result
leaves the database.

### 4.1 Primitive

- Numeric aggregates (`COUNT`, `AVG`, `STDDEV`, percentiles): Laplace noise with scale
  `Δf / ε` for financial contexts, Gaussian noise with `σ = Δf · √(2 ln(1.25/δ)) / ε`
  for federal / HNW contexts (where `δ = 10⁻⁶`).
- Categorical frequency vectors: Laplace noise per-bucket, re-normalized after noise so
  they sum to 1.0 ± tolerance.

### 4.2 ε budget per context

(Copied from `/review/02_synthetic_data_strategy.md §6`.)

| Context | Per-column ε budget | k threshold |
|---|---|---|
| Financial (GLBA) | 1.0 | 5 |
| Federal employee (Privacy Act) | 0.3 | 10 |
| Health-adjacent (HIPAA-like) | 0.5 | 10 |
| GDPR personal data | 0.5 | 5 |
| Ambiguous / default | **0.3** | **10** |

### 4.3 Budget tracking

Every profiler query records `(column, ε_used)` in the WORM run record. When the column's
running total would exceed the budget, the next query is refused with a structured error
— the operation exits non-zero and the fingerprint is not written.

### 4.4 Budget distribution (recommended default)

For a column with ε = 0.3 total:

| Statistic | ε share |
|---|---|
| `member_count` / `row_count` | 0.05 |
| Percentiles (P5…P99) collectively | 0.10 |
| `mean`, `stddev` | 0.05 |
| Rollup ratios (per edge) | 0.05 |
| Correlation / association scores | 0.03 |
| Reserve for re-run / QA | 0.02 |

---

## Layer 5 — K-Anonymity / L-Diversity

No published dimension slice may have effective group size below `k`, and no sensitive
attribute within a slice may have fewer than `l` distinct values.

### 5.1 k-anonymity

- Applied at fingerprint-write time (not at query time): before any `member_count`,
  category frequency vector, or rollup statistic is written, a check runs against the
  corresponding real-data slice (computed server-side as a scalar) to confirm each
  slice's row count ≥ k.
- Violation → the statistic is **suppressed** (omitted from fingerprint) and a
  `suppression_report.json` entry logged; it is not silently bucketized.

### 5.2 l-diversity

Required for any dimension flagged as carrying a sensitive attribute (e.g. ethnicity,
religion, health status). Without l ≥ 3 distinct values per slice, the fingerprint
suppresses that categorical vector entirely.

### 5.3 Default thresholds

| Context | k | l |
|---|---|---|
| Financial | 5 | 3 |
| Federal / HNW | 10 | 3 |
| GDPR | 5 | 3 |
| Default | **10** | **3** |

---

## Layer 6 — Audit Logging

Every query against a sensitive field emits an **immutable** log line to a WORM store.

### 6.1 Log record schema

```json
{
  "event_id": "uuid-v4",
  "occurred_at_utc": "ISO8601",
  "actor": { "principal": "profiler-svc@domain", "run_id": "uuid" },
  "action": "profile_query",
  "target": { "catalog": "…", "schema": "…", "table": "…", "column": "…" },
  "classification": "Restricted|Confidential|Internal|Public",
  "query_hash_sha256": "hex",
  "epsilon_consumed": 0.0,
  "k_threshold_applied": 10,
  "outcome": "emit|suppress|reject_over_budget|reject_below_k",
  "fingerprint_target_path": "…",
  "prev_event_hash": "hex"   // chain
}
```

### 6.2 Properties

- WORM: append-only, no delete path, integrity via rolling `prev_event_hash` Merkle
  chain.
- Signed per-run with Ed25519 (same key family as the fingerprint itself).
- Retention: 7 years for financial, 3 years for all others, matching the longer of the
  applicable regulatory minimum and the organization's own records policy.

### 6.3 Who reads the log

Only the security / compliance role. The profiler service account writes but cannot read.

---

## Layer 7 — Pipeline Isolation Confirmation

This layer is procedural, not cryptographic. It asserts, at run start and run end, that
no control in Layers 1–6 has written to any path outside the declared output boundary.

### 7.1 Review-scope isolation (this exercise)

- Declared output root: `/review/` (including `/review/synthetic_data/`,
  `/review/validation/`).
- Asserted by this review: no file outside `/review/` was created or modified by Phases
  1 – 6 of this exercise.
- Verification evidence: `git status` after the review produces modifications only
  under `review/…` (plus any ambient uncommitted changes that predate this review, e.g.
  `resources/namespaces/telemetry/overview.yaml` — see `00_environment_scan.md` C-4).

### 7.2 Production-scope isolation (future operations)

- Declared output root at runtime: the `--output` directory supplied to
  `generate-synthetic-data-from-sml`, or the target schema+connection supplied to
  `generate-synthetic-data-from-connection`.
- Explicit negative guarantees the operations must carry (enforced in code at
  implementation time):
  * Do not write outside the `--output` directory.
  * Do not write to any connection other than the one specified.
  * Do not modify the SML input file (read-only open).
  * Do not modify any AtScale catalog, data source, or deployment entity.
  * Do not touch the `resources/`, `scripts/`, `example/`, `query_results/` paths.
  * Emit a self-check `pipeline_isolation_report.json` next to the output, listing every
    file written and confirming no unexpected paths appear.

### 7.3 Run-start and run-end self-checks

At run-start, the operation records the working-tree inventory (file list + mtimes)
under the constrained output root. At run-end, it diffs the inventory and emits
`pipeline_isolation_report.json` showing the exact delta. Any delta outside the expected
output paths fails the run and the fingerprint/data output is refused.

---

## Layer summary

| # | Control | Scope | Enforced by |
|---|---|---|---|
| 1 | Tokenization | Column-level | DB view layer, vault (Gretel / AES-FF3-1) |
| 2 | FPE | Format-critical fields | NIST SP 800-38G Rev.1 |
| 3 | Static vs. dynamic masking | Environment-wide | RBAC in semantic layer |
| 4 | Differential privacy | Every aggregate | Per-column ε budget tracker |
| 5 | k-anonymity / l-diversity | Fingerprint write-gate | k ≥ 10 default, l ≥ 3 |
| 6 | Audit logging | All sensitive touches | WORM append-only log, Ed25519-signed |
| 7 | Pipeline isolation | Process-wide | Run-start/end inventory diff |

All seven layers are **additive and fail-closed**: any single layer's failure aborts the
run and produces no fingerprint. None of them write outside `/review/` during this
review exercise, and none of them write outside the operation's declared output root at
production time.
