# 00 — Environment Scan & Conflict Register

> **Purpose.** Document every pre-existing artifact, instruction, or naming choice in this
> repository that conflicts with the review directive **before** any subsequent review phase
> is produced, per the governing principle:
>
> *"If any phase detects a potential conflict with existing infrastructure, **halt and
> document** the conflict in `/review/00_environment_scan.md` before continuing."*

Date of scan: 2026-03-27
Scan scope: `/Users/nate/ps-template/ps-template` @ `origin/main` (`22697cc`)
Scanner: review pipeline, pre-flight phase

---

## C-1 — Governing-principle contradiction between "zero footprint" and requested operation implementation

**Where.** User directive, final paragraph of the review prompt.

**What.** Two directives in the same prompt are mutually exclusive:

| Directive | Implication |
|---|---|
| *"This exercise must have zero footprint outside `/review/`"* | No file under `src/`, `action.yml`, `scripts/`, `resources/`, `package.json`, etc. may be created or modified. |
| *"…add the operation as `generate-synthetic-data-from-sml` and an operation `generate-synthetic-data-from-connection`."* | New TypeScript operation directories, registry entries in `src/operations/index.ts`, and CLI wiring in `action.yml` must be added. |

**Resolution posture.** The review phases (1–6) are fully executed in-tree under `/review/`
only. The implementation of the two operations is **staged but not applied** — the source
shape, file-by-file plan, and diff-ready listings live in `/review/synthetic_data/`
prototypes, awaiting explicit user confirmation that the "zero footprint" clause is
relaxed for the promotion step. **No file under `src/`, `action.yml`, `resources/`,
`scripts/`, `package.json`, or `package-lock.json` has been modified by this review.**

---

## C-2 — Naming collision with operation names already published in `STATISTICS.md`

**Where.** `STATISTICS.md` (newly pulled, `@ec95c1a..22697cc`), Phases 7–8.

**What.** `STATISTICS.md` already advertises three operation names by contract:

| Name referenced in STATISTICS.md | Status in `src/operations/` |
|---|---|
| `generate-ddl-from-data-shape` | Not implemented (no directory) |
| `generate-data-from-data-shape` | Not implemented (no directory) |
| `generate-data-from-data-shape-to-connection` | Not implemented (no directory) |

The user is now requesting two **new, differently-named** operations covering the same
responsibility surface:

| Proposed name | Overlaps with |
|---|---|
| `generate-synthetic-data-from-sml` | `generate-data-from-data-shape` (Phase 8 §8.4 CSV path) |
| `generate-synthetic-data-from-connection` | `generate-data-from-data-shape-to-connection` (Phase 8 §8.4 database path) |

The overlap is semantic (same output, different entry point). If both name sets ship,
users will see duplicated functionality; if the new names replace the old, `STATISTICS.md`
must be amended.

**Resolution posture (recommended, awaiting confirmation).**

1. Treat the `*-synthetic-data-*` names as the canonical public names.
2. Retain the `*-data-shape-*` terminology *inside* `STATISTICS.md` as internal algorithm
   phases (i.e. the fingerprint + reconstruction pipeline) but retarget Phase 7/8 callouts
   to the `generate-synthetic-data-from-*` operation names.
3. Keep `generate-ddl-from-data-shape` as a private internal helper (not a public CLI
   operation) since the new `generate-synthetic-data-from-sml` bundles DDL emission
   with data emission (a superset of capability).

Confirmation required before any rewrite of `STATISTICS.md`. Phase 4 produces the revised
copy to `/review/04_statistics_revised.md`; the in-tree `STATISTICS.md` is **untouched**.

---

## C-3 — No sample / reference dataset present in-tree

**Where.** `example/`, `query_results/`, `resources/`.

**What.** The only non-synthetic dataset in-tree at scan time is
`query_results/2026-04-04-9C37A93B30_ats_connection.csv` (34 rows) — AtScale connection
metadata, not customer-identifying data. There is no real PII surface in the repo to
profile or twin against. The review therefore treats the hypothetical customer dataset
described in `STATISTICS.md` as the referent, not any file in-tree.

**Resolution posture.** All Phase 2 synthetic outputs describe schema and generation
recipes referenced to `STATISTICS.md`'s own worked example (dim_customer × dim_product ×
dim_date around `fact_orders`). If the user wants the twin generated against a real
connection, that happens downstream of the promoted operation — not inside `/review/`.

---

## C-4 — Ambient uncommitted change in `resources/namespaces/telemetry/overview.yaml`

**Where.** Local working tree.

**What.** The working tree contains a pre-existing modification to
`resources/namespaces/telemetry/overview.yaml` that predates this review. The review does
not touch this file, and the stash/pop flow that produced it is unrelated to the
synthetic-data exercise.

**Resolution posture.** Out of scope. Noted here so that any diff the user sees which
includes that file can be immediately recognized as unrelated.

---

## C-5 — No existing test harness for data-shape / synthetic-data code paths

**Where.** `test/`, `src/operations/__tests__/`.

**What.** No vitest spec currently exercises statistical-fingerprint or synthetic-data
code paths. A TSTR validation harness (Phase 6) therefore has no host to extend —
either a new `review/validation/` harness is spun up (review-internal) or, at
implementation time, a `src/operations/__tests__/generate-synthetic-data.spec.ts` is
introduced.

**Resolution posture.** Phase 6 produces a validation methodology + runnable skeleton
inside `/review/validation/` only.

---

## C-6 — `.DS_Store` deletion upstream vs. local macOS regeneration

**Where.** Historical: upstream deleted `.DS_Store`; macOS regenerates it on directory
browsing.

**What.** No review action. Noted so that the reviewer is aware transient `.DS_Store`
entries are not introduced by this review.

---

## C-7 — Upstream has landed the entire synthetic-data pipeline under the `*-data-shape` names

**Where.** `origin/main` @ `288300a` (pulled 2026-03-27, after the review was complete).

**What.** The upstream maintainers have committed, registered, wired-through-CLI, and
documented the full pipeline — profiler + DDL generator + CSV generator + DB generator
+ enhanced-query-results helper — **under the `*-data-shape` names that the original
`STATISTICS.md` advertised**, not under the `generate-synthetic-data-from-*` names
chosen in resolution B1.

New in-tree artifacts (not present at review start):

| In-tree path | Purpose |
|---|---|
| `src/operations/extract-data-shape-from-connection/ExtractDataShapeFromConnectionOperation.ts` | Profiler entrypoint |
| `src/operations/generate-ddl-from-data-shape/GenerateDDLFromDataShapeOperation.ts` | DDL emitter |
| `src/operations/generate-data-from-data-shape/GenerateDataFromDataShapeOperation.ts` | CSV generator (overlaps staged `generate-synthetic-data-from-sml`) |
| `src/operations/generate-data-from-data-shape-to-connection/GenerateDataFromDataShapeToConnectionOperation.ts` | DB generator (overlaps staged `generate-synthetic-data-from-connection`) |
| `src/operations/generate-enhanced-query-results/GenerateEnhancedQueryResultsOperation.ts` | New helper, out of our review scope |
| `src/statistics/{data-generator,ddl-generator,distribution,extractor,fingerprint,id-mapper,index,sampling,sml-reader,sql-helpers,types}.ts` | Full algorithm implementation (~2.5 kLOC) |
| `src/statistics/profilers/{columns,conformed,density,hierarchy}.ts` | Per-class profilers |
| Full `action.yml` dispatch + inputs for all five operations | Already wired |
| Full `ACTIONS.md` + `README.md` documentation entries for all five operations | Already written |

**Consequences.**

1. Resolution **B1** ("`*-synthetic-data-*` are canonical, rename `STATISTICS.md`
   accordingly") now conflicts with upstream's active name choice. Applying B1 as
   originally planned would require either deleting upstream work (destructive) or
   creating parallel duplicate operations (confusing and maintenance-hostile).
2. The staged code under `/review/synthetic_data/src_staged/` is a strict subset of
   what upstream shipped — the generator side only, without the profiler, without
   the dialect-specialized DDL generator, without the sampling / ID-mapping modules.
   Promoting it as-written would regress capability.

**Resolution posture (halt).** Do not promote the staged code without an explicit user
decision from the options below:

| # | Option | Cost | Risk |
|---|---|---|---|
| **R1** | **Abandon promotion.** Upstream already covers the same functional surface. Keep `/review/` as a signed audit record of the security audit; optionally update review artifacts to refer to upstream names. **No code under `src/` is changed.** | Lowest | Lowest |
| R2 | **Add the `generate-synthetic-data-from-*` names as CLI aliases** routed to the upstream `generate-data-from-data-shape{,-to-connection}` implementations, with a note in ACTIONS.md/README.md that both names dispatch to the same code. No duplicate TypeScript files. | Low | Low — but two names for one thing forever. |
| R3 | **Coexist with duplicate ops.** Promote the staged code verbatim; both sets of names live in the registry. | High | High (duplication, maintenance). |
| R4 | **Replacement (destructive).** Delete the upstream `*-data-shape` operations, rename to `*-synthetic-data-*`, rewrite STATISTICS.md + ACTIONS.md + README.md + action.yml. | Very high | Very high — contradicts a just-merged upstream change. |

**Recommended.** **R1** is the highest-integrity choice. The review's security findings
(`/review/01_risk_register.md`) apply identically to the shipped upstream code, so the
value of the review is preserved without any merge-conflict-inviting changes.

---

## Halt gate summary

| # | Conflict | Blocks which phase? | Resolution action |
|---|---|---|---|
| C-1 | "Zero footprint" vs. `src/` implementation | Operation promotion step | **Resolved (hybrid).** User directed integration into upstream `*-data-shape` ops; the footprint is now contained to a new `src/statistics/security.ts` module + surgical additions to existing files. |
| C-2 | Operation naming collision with STATISTICS.md | Phase 4 rewrite and operation names | **Resolved.** Canonical names are upstream's `extract-data-shape-from-connection`, `generate-ddl-from-data-shape`, `generate-data-from-data-shape`, `generate-data-from-data-shape-to-connection`. Review docs refer to upstream names from this commit forward. |
| C-3 | No real dataset in-tree | None | Proceed, twin referent is STATISTICS.md worked example. |
| C-4 | Ambient working-tree change | None | Ignored. |
| C-5 | No test harness | Phase 6 scope | **Resolved.** `src/statistics/__tests__/security.test.ts` provides 17 regression tests covering every review-derived invariant. |
| C-6 | `.DS_Store` | None | Ignored. |
| C-7 | Upstream shipped the same pipeline under `*-data-shape` names | Promotion step | **Resolved.** Chose neither R1 (abandon) nor R2-R4 but a hybrid: keep upstream code/names, add the review's enforceable invariants as a dedicated `src/statistics/security.ts` module wired into the extractor, fingerprint I/O, generator, and both output operations. |

### C-7 resolution — hybrid path

The review's value was always the **security controls**, not the operation names. The
hybrid resolution keeps upstream's naming and code shape intact and inserts every
enforceable control as an additive layer:

| Control | Source | Integration point |
|---|---|---|
| `coldMemberBucket` / `overlapBucket` binning | R-4, R-10 | `hardenFingerprint()` in `security.ts`, called from `extractor.ts` step 7 |
| `pearsonR` 2-dp rounding | R-7 | `hardenFingerprint()` |
| Absolute-date rejector | R-9 | `validateFingerprint()` in `security.ts`, called from `fingerprint.ts` read + write |
| `isNearFunctional` flag on FK associations ≥ 0.90 | R-11 | `hardenFingerprint()` |
| Generated-key shape invariant (positive integer, in-process) | R-15 (adapted) | `assertGeneratedKeyShape()`, called after every table build in `data-generator.ts` |
| Small-table warning (<5,000 rows) | R-21 | `smallTableWarnings()`, logged during extraction |
| Sensitivity classification (Public/Internal/Confidential/Restricted) | review/04 | `sensitivityFor()` stamped onto every level and measure during hardening |
| FK closure assertion | review/05 §Referential Integrity | `assertFkClosure()`, called after generation; throws on orphans |
| Pipeline isolation report | review/03 §Layer 7 | `writePipelineIsolationReport()`, emitted from both output operations |
| Run manifest (SHA-256 lineage) | review/03 §Layer 6 (simplified) | `writeRunManifest()`, emitted from both output operations |
| Integrity report | review/05 §Promotion Gate | `writeIntegrityReport()`, emitted from both output operations |

**Deferred controls** (documented as `deferredControls` stubs in `security.ts`, each
throwing a named error with a pointer to the review spec): ε-DP noise, Ed25519 signing,
WORM audit log, dynamic RBAC masking. Each of these requires infrastructure not present
in the repository today; leaving explicit fail-loud stubs is safer than silent omission.

**Staged code disposition.** `/review/synthetic_data/src_staged/` was written under the
pre-pull assumption that `generate-synthetic-data-from-*` were the canonical names. That
name choice is superseded by C-7; the staged TypeScript under `src_staged/` is no longer
a promotion candidate. It remains in the review directory as a historical audit record
of the operations that would have been promoted had upstream not beaten us to it.
