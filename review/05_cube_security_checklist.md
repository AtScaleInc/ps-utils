# 05 — Semantic Model Security Checklist

> A **gate** before promoting any semantic model (cube / perspective / catalog) to
> production. Every item must be checked and signed off. Any unchecked item blocks
> promotion. The checklist is designed to be filled in by a release manager with
> evidence links (run IDs, commit hashes, log extracts).

---

## Project metadata

- Semantic model name: `___________________________________________`
- Repo / catalog: `___________________________________________`
- Release tag: `___________________________________________`
- Release manager: `___________________________________________`
- Target environment: `dev` ☐ `test` ☐ `uat` ☐ `prod` ☐
- Date of gate review: `____________`

---

## 1. PII absence

- [ ] No real PII fields are present in any dimension table of the model.
      *Evidence:* column scan report for each `dim_*` table, comparing emitted columns
      against the `Restricted`/`Confidential` classification list. Report path:
      `__________________________`.
- [ ] No real PII fields are present in any fact table of the model.
      *Evidence:* same as above for `fact_*`. Report path:
      `__________________________`.
- [ ] No real PII fields are referenced by any measure formula, calculated member, or
      secure dimension expression.
- [ ] Every `dim_*` / `fact_*` primary or foreign key matches the synthetic-key invariant
      regex (`^syn_[0-9a-f]{8}$` or the project-specified equivalent) in all dev / test /
      uat environments. *Evidence:* generator run log hash: `__________________________`.

## 2. Synthetic data utility

- [ ] The synthetic twin has a completed TSTR run (`/review/validation/utility_test_report.md`
      or its production equivalent).
- [ ] Per-dimension fidelity scores meet the thresholds in
      `/review/02_synthetic_data_strategy.md §1` (first through fourth moments, KS,
      categorical cardinality and shape, pairwise Pearson r).
- [ ] Any dimension that fails the threshold is **documented and justified** below, or
      the promotion is blocked.
      | Dimension | Metric | Observed | Threshold | Decision |
      |---|---|---|---|---|
      | `__________________________` | `________` | `________` | `________` | `________` |

## 3. Referential integrity

- [ ] Every fact-to-dimension FK resolves to a leaf key present in the corresponding
      dimension table. Orphan FK rate = 0. *Evidence:* `integrity_report.json` from the
      generator run. Path: `__________________________`.
- [ ] Every conformed-dimension overlap is within ± 0.05 of the fingerprint's
      advertised value. *Evidence:* same report.
- [ ] No NULL FK on any required relationship.

## 4. Role-based access & dynamic masking

- [ ] Every Restricted column has an active dynamic masking policy in the semantic
      layer. *Evidence:* masking policy ID(s): `__________________________`.
- [ ] Every Confidential column is masked for roles below the data-handler tier.
- [ ] The profiler service role has `SELECT` only on the view-layer projection, never on
      base tables. *Evidence:* grant report: `__________________________`.
- [ ] No "break-glass" grant exists without MFA and audit-log entry. *Evidence:* grant
      audit extract: `__________________________`.

## 5. Audit logging

- [ ] Audit logging is enabled on all sensitive-field (`Restricted` or `Confidential`)
      access.
- [ ] Audit log records are written to a WORM store with Ed25519 signing and
      `prev_event_hash` chaining.
- [ ] Retention is configured to the longer of 7 years (financial) or the
      organization's records-policy minimum.
- [ ] Log-reader access is scoped to the security / compliance role only. Profiler and
      generator service accounts are write-only.
- [ ] A log-sample spot-check (10 random events from the last 24 hours) returns valid
      schema, valid signature, and intact hash chain. *Evidence:* spot-check report:
      `__________________________`.

## 6. K-anonymity & L-diversity

- [ ] Every dimensional slice emitted by the fingerprint has `k ≥` the project-specified
      threshold (default `k=10` for Restricted, `k=5` for Confidential).
- [ ] Every slice carrying a sensitive attribute has `l ≥ 3` distinct values for that
      attribute.
- [ ] The suppression report from the fingerprint writer
      (`suppression_report.json`) is reviewed and no suppressed statistic is material to
      downstream consumers. *Evidence:* path: `__________________________`.

## 7. Pipeline isolation

- [ ] The generator run produced a `pipeline_isolation_report.json` confirming zero
      writes outside the declared `--output` directory (for `generate-synthetic-data-from-sml`)
      or zero writes to any connection other than the specified target (for
      `generate-synthetic-data-from-connection`). *Evidence:* path:
      `__________________________`.
- [ ] No existing data source connection, deployment, schedule, or catalog role was
      modified by the synthetic-data exercise. *Evidence:* deployment diff:
      `__________________________`.
- [ ] No file under `src/`, `action.yml`, `scripts/`, `resources/`, `package.json`, or
      `package-lock.json` was modified by the **review** exercise (this item stays true
      even after the operations are implemented; the review itself is required to be
      footprint-free).

## 8. Differential privacy budget

- [ ] Per-column ε usage in the profiler run is within the context-appropriate budget
      (`/review/03_obfuscation_tactics.md §4.2`): financial ≤ 1.0, federal ≤ 0.3,
      GDPR ≤ 0.5, default ≤ 0.3.
- [ ] The run record (WORM) contains every `(column, ε_consumed)` pair and totals are
      within budget. *Evidence:* run record ID: `__________________________`.

## 9. Fingerprint integrity

- [ ] The fingerprint YAML has a valid Ed25519 signature by the profiler service key.
- [ ] The generator refused to run against an unsigned or mis-signed fingerprint during
      the most recent failure-mode test. *Evidence:* test artifact:
      `__________________________`.
- [ ] The fingerprint hash recorded in the generation manifest matches the current file.

## 10. Classification inheritance

- [ ] The synthetic twin's column-level classification matches the SML-declared
      classification of the source columns (e.g. a column sourced from a Confidential
      real column is marked Confidential on the twin even though its values are
      synthetic). This avoids accidental re-classification drift.
- [ ] Any twin column sourced from a Restricted real column carries the "derived from
      Restricted" tag even if the twin column's values cannot re-identify.

## 11. Operator sign-offs

| Role | Name | Date | Signature |
|---|---|---|---|
| Release manager | | | |
| Security / compliance | | | |
| Data steward | | | |
| SRE / platform | | | |

**Promotion is blocked** until every row in this checklist is checked and every named
role has signed off.
