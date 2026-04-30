# Promotion Guide — `generate-synthetic-data-from-sml` / `-from-connection`

> This directory holds **diff-ready prototypes** for the two new operations the user
> requested. They are staged here (under `/review/`) per resolution **A2** of
> `/review/00_environment_scan.md` §C-1 — the review itself has **zero footprint
> outside `/review/`**. When promoted, these files move to `src/operations/` and the
> in-tree `STATISTICS.md` is replaced by `/review/04_statistics_revised.md` per
> resolution **B1**.

Do not edit anything under `src/`, `action.yml`, `package.json`, `scripts/`,
`resources/`, or `STATISTICS.md` automatically. A human reviewer must perform the steps
below.

---

## File inventory

| Staged path | Target path (on promotion) | Purpose |
|---|---|---|
| `shared.ts` | `src/operations/generate-synthetic-data-shared.ts` | PRNG, fingerprint types, copula / rollup / DDL generator, invariants |
| `generate-synthetic-data-from-sml/GenerateSyntheticDataFromSMLOperation.ts` | `src/operations/generate-synthetic-data-from-sml/GenerateSyntheticDataFromSMLOperation.ts` | CSV-output operation |
| `generate-synthetic-data-from-connection/GenerateSyntheticDataFromConnectionOperation.ts` | `src/operations/generate-synthetic-data-from-connection/GenerateSyntheticDataFromConnectionOperation.ts` | DB-output operation |
| `index.ts.patch` | Applied to `src/operations/index.ts` | Register both operations |
| `action.yml.patch` | Applied to `action.yml` | Wire the CLI surface |
| `package.json.patch` | Applied to `package.json` | Document (optional) dependency additions |
| `README.promotion.md` — this file | n/a | These instructions |

---

## Prerequisites

1. `STATISTICS.md` should be replaced with the contents of
   `/review/04_statistics_revised.md` (resolution B1). The revised doc advertises the
   new operation names; keeping the old `STATISTICS.md` in place creates a naming
   inconsistency.
2. Confirm that `Phase 6 §TSTR` has been executed against a reference dataset and
   produced a **Fit for Semantic Model Use** certification before promotion. Until then,
   these operations are promoted as **experimental** and gated behind a
   `--acknowledge-experimental` flag (plumbed through in the staged code).

---

## Step-by-step promotion

### 1. Move the TypeScript files

```bash
# From the repo root
mkdir -p src/operations/generate-synthetic-data-from-sml \
         src/operations/generate-synthetic-data-from-connection

cp review/synthetic_data/src_staged/shared.ts \
   src/operations/generate-synthetic-data-shared.ts

cp review/synthetic_data/src_staged/generate-synthetic-data-from-sml/GenerateSyntheticDataFromSMLOperation.ts \
   src/operations/generate-synthetic-data-from-sml/GenerateSyntheticDataFromSMLOperation.ts

cp review/synthetic_data/src_staged/generate-synthetic-data-from-connection/GenerateSyntheticDataFromConnectionOperation.ts \
   src/operations/generate-synthetic-data-from-connection/GenerateSyntheticDataFromConnectionOperation.ts
```

### 2. Apply the registry patch

See `index.ts.patch`. The two import lines and two `registry.register(...)` lines must
be added to `src/operations/index.ts` next to the other `register(new Generate…)`
entries. Order: alphabetical within the `generate-…` block, or immediately after
`GenerateSMLFromDDLOperation` registrations — either is consistent with the current
file.

### 3. Apply the CLI surface patch

See `action.yml.patch`. Two new operation stanzas are added. Each stanza follows the
same parameter → env-var mapping convention as `generate-ddl-from-atscale` and
`generate-sml-from-connection`. Keep them grouped with the other `generate-*`
operations.

### 4. Apply the package.json patch (optional)

See `package.json.patch`. The staged code is dependency-free beyond what the repo
already ships (no SDV / CTGAN at runtime — Gaussian-copula implementation is native
TypeScript). The patch is mostly commentary documenting the recommended optional
Python-based profilers for the Phase-1 real-data window. No npm package additions are
required to compile the new operations.

### 5. Replace `STATISTICS.md`

```bash
cp review/04_statistics_revised.md STATISTICS.md
```

### 6. Build + test

```bash
npm install          # no new deps, but a clean install confirms lock integrity
npm run build        # TypeScript compile
npm test             # vitest — add new spec files under test/ as needed
```

### 7. Smoke test

```bash
# CSV path (no DB connection needed — uses a bundled fingerprint)
./atscale-utils generate-synthetic-data-from-sml \
  --fingerprint review/synthetic_data/fingerprint_synthetic.yaml \
  --output-dir /tmp/synth_smoke \
  --seed 1742832000 \
  --dialect ansi

# DB path (requires a connections.yaml target)
./atscale-utils generate-synthetic-data-from-connection \
  --fingerprint review/synthetic_data/fingerprint_synthetic.yaml \
  --connection-file example/connections.yaml \
  --connection-name local_postgres \
  --target-schema synth_smoke \
  --seed 1742832000 \
  --drop-if-exists
```

Both commands should produce a `pipeline_isolation_report.json` alongside their output
that lists every emitted file/table and confirms no writes outside the declared
output boundary.

### 8. Post-promotion review checklist

Run `/review/05_cube_security_checklist.md` against the promoted code. All checkboxes
in §1, §3, §7, §9 must pass before any real data is pointed at the profile path.

---

## Rollback

If a post-promotion issue is found, revert in this order:

```bash
git checkout -- STATISTICS.md
git rm -r src/operations/generate-synthetic-data-from-sml \
           src/operations/generate-synthetic-data-from-connection
git checkout -- src/operations/generate-synthetic-data-shared.ts    # if present
git checkout -- src/operations/index.ts action.yml
npm run build
```

The staged copies under `/review/synthetic_data/src_staged/` remain untouched by a
rollback so you can re-attempt promotion after fixing the issue.
