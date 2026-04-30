# `src_staged/` — Diff-Ready Prototypes of the Two New Operations

This directory holds the **full, staged** implementation of
`generate-synthetic-data-from-sml` and `generate-synthetic-data-from-connection`,
awaiting the explicit user-led promotion step described in `PROMOTION.md`.

Nothing here is wired to the TypeScript build. All files assume their **post-promotion
locations** for their `import` paths (i.e. `../Operation.js` resolves only after the
files are moved under `src/operations/`). That is intentional — it keeps the staged
code a byte-for-byte drop-in.

## File map

| Staged | Moves to |
|---|---|
| `shared.ts` | `src/operations/generate-synthetic-data-shared.ts` |
| `generate-synthetic-data-from-sml/GenerateSyntheticDataFromSMLOperation.ts` | `src/operations/generate-synthetic-data-from-sml/GenerateSyntheticDataFromSMLOperation.ts` |
| `generate-synthetic-data-from-connection/GenerateSyntheticDataFromConnectionOperation.ts` | `src/operations/generate-synthetic-data-from-connection/GenerateSyntheticDataFromConnectionOperation.ts` |
| `index.ts.patch` | Applied to `src/operations/index.ts` |
| `action.yml.patch` | Applied to `action.yml` |
| `package.json.patch` | Applied (as a no-op, documented only) |
| `PROMOTION.md` | Step-by-step guide |

## What the prototypes implement

- **Shared module (`shared.ts`)**
  - Fingerprint types matching `STATISTICS.md` §"Fingerprint File Format" v2.0.
  - `mulberry32` PRNG, `randNormal` (Box-Muller), `normalCdf` (Abramowitz & Stegun
    7.1.26, max error 7.5e-8).
  - `quantileFromU` — 8-point percentile ladder interpolation (supports the
    `p10/p90` collapsed ladder for small tables).
  - `drawRollupChildCount` — tier-aware per-parent child sampler (power_law /
    log_normal / normal / uniform), matching STATISTICS.md §8.2.
  - `scaleToTarget` — cumulative-drift-corrected rescale to exact target totals.
  - `sampleMeasuresCopula` — Gaussian copula through the percentile ladder,
    pairwise adjusted by the `r·z[i] + √(1−r²)·z[j]` formula from §8.3.
  - `buildAssociationCache` — synthetic-index-keyed FK association cache (enforces
    review §R-16 fails-closed invariant).
  - `buildDdl` — deterministic DDL emitter (ansi / postgres / snowflake / mysql /
    bigquery) matching STATISTICS.md §7.
  - `writeCsv`, `writePipelineIsolationReport`, `fingerprintSha256`, `mkTag`.
  - `SYNTH_KEY_REGEX` + `assertSyntheticKey` — fail-closed synthetic-key invariant
    per review §R-15.

- **`generate-synthetic-data-from-sml`**
  - CSV path for the twin (§8.4 of the revised STATISTICS.md).
  - Takes `--fingerprint <yaml>` (primary) or `--sml + --connection-*` (the profile
    path, left as a TODO hook for the promoter to wire to the real-data profiler).
  - Emits `schema.sql`, `dim_<id>.csv`, `fact_<id>.csv`, `generation_manifest.json`,
    `pipeline_isolation_report.json`.
  - Enforces `--acknowledge-experimental` gate until TSTR certification completes.

- **`generate-synthetic-data-from-connection`**
  - DB path for the twin (§8.4).
  - `--drop-if-exists` drops facts before dims; create order reversed. Multi-value
    INSERTs in configurable `--batch-size` batches.
  - Emits `manifest_<runId>.json` + `pipeline_isolation_report_<runId>.json` to
    `--report-dir`.

## Not implemented here (on purpose)

The Phase-1 real-data profiler — the component that reads the live warehouse through
the tokenized/masked view tier and emits the signed fingerprint YAML — is **not
included** in this staged prototype. It involves:

- A new `src/algorithm/statistical-fingerprint.ts` module (issues ε-DP-gated
  aggregate SQL against `DatabaseMetaData`-shaped inputs).
- Integration with the `SqlService` + existing `AtScaleRestClientService`.
- The WORM audit log writer (review §Layer 6).
- The Ed25519 fingerprint signer.

All of these are described in `/review/02_synthetic_data_strategy.md` and
`/review/03_obfuscation_tactics.md` and are the natural next implementation wave.
The staged operations here already accept a pre-computed fingerprint so the generator
side can be promoted and exercised independently of the profiler, which is the
safest sequence given the Critical-severity findings in `/review/01_risk_register.md`.

## Smoke test (post-promotion)

```bash
./atscale-utils generate-synthetic-data-from-sml \
  --fingerprint review/synthetic_data/fingerprint_synthetic.yaml \
  --output-dir /tmp/synth_smoke \
  --seed 1742832000 \
  --dialect ansi \
  --acknowledge-experimental true
```

Expected outputs: `/tmp/synth_smoke/{schema.sql, dim_1.csv, dim_2.csv, dim_3.csv,
fact_1.csv, generation_manifest.json, pipeline_isolation_report.json}`.

All CSV `l*_key` leaf values match `^syn_[0-9a-f]{8}$`. All fact FK columns contain
values that appear in the corresponding dim CSV.
