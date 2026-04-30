# `/review/synthetic_data/` — Review-Scope Synthetic Fixtures

These files are **review artifacts only**. They exist to:

1. Demonstrate the drop-in shape of a synthetic digital twin derived from
   `STATISTICS.md`'s worked example.
2. Anchor the Phase 6 TSTR validation harness.
3. Provide diff-ready prototypes for the future `generate-synthetic-data-from-sml` and
   `generate-synthetic-data-from-connection` operations.

None of these files are read, imported, or referenced by any code under `src/`,
`scripts/`, `resources/`, or `example/`. They are **not** wired into the build.

## File list

| File | Purpose |
|---|---|
| `fingerprint_synthetic.yaml` | Worked example of the fingerprint format (no real data). |
| `schema_synthetic.sql` | DDL emitted deterministically from the fingerprint (ANSI dialect). |
| `dim_1_synthetic.csv` | Synthetic customer dimension rows (leaf keys prefixed `syn_`). |
| `dim_2_synthetic.csv` | Synthetic product dimension rows. |
| `dim_3_synthetic.csv` | Synthetic date dimension rows (anchor = `today − span/2`). |
| `fact_1_synthetic.csv` | Synthetic orders fact rows (FK integrity enforced at generation time). |
| `generation_manifest.json` | Seed, PRNG, toolchain, version, content hashes. |
| `validation/integrity_report.json` | FK-resolution + null + count invariants. |
| `validation/fidelity_report.json` | Phase 6 TSTR metric values (populated when TSTR runs). |

## Invariants

Every row in every file here satisfies:

- No real customer name, SSN, account number, address, email, phone, or DOB.
- Every key begins with `syn_` and is exactly 12 chars long (`^syn_[0-9a-f]{8}$`).
- Every FK value appears in the corresponding dimension CSV.
- Categorical columns never contain a value with population count < `k=5`.
- Numeric columns never contain values outside the fingerprint's advertised
  `[p5 − 3σ, p95 + 3σ]` envelope.

## Regeneration

Because the intent of this folder is illustrative, the files are deliberately short and
human-legible. A production run driven by the future operations will produce the same
shape at the true row counts; until then, these are sized for visual review and
skim-readability only.
