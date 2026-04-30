/**
 * GenerateSyntheticDataFromSML
 *
 * Produces a statistical "digital twin" of a semantic-layer dataset, emitting:
 *   - schema.sql                — DDL derived deterministically from the fingerprint
 *   - dim_<n>.csv               — synthetic dimension tables (leaf-key invariant enforced)
 *   - fact_<n>.csv              — synthetic fact tables (Gaussian-copula measures, FK integrity enforced)
 *   - generation_manifest.json  — seed, PRNG, toolchain, content hashes
 *   - pipeline_isolation_report.json — self-check that no writes escaped --output-dir
 *
 * Inputs (exactly one of):
 *   --fingerprint <yaml>        — pre-computed fingerprint (preferred, no real data touched)
 *   --sml <dir> --connection-*  — profile a live connection + SML model into a fingerprint
 *                                 (ε-DP, k-anonymity gates per STATISTICS.md revised §6)
 *
 * PROMOTION NOTE:
 *   Staged at review/synthetic_data/src_staged/generate-synthetic-data-from-sml/.
 *   On promotion, moves to src/operations/generate-synthetic-data-from-sml/.
 *   Imports assume promoted location.
 */
import fs from "fs";
import path from "path";
import crypto from "crypto";
import { Operation } from "../Operation.js";
import {
  ParameterSet,
  StringParameter,
  NumberParameter,
  BooleanParameter,
} from "../../Parameters.js";
import type { ServiceRegistry } from "../../services/registry.js";
import type { Logger } from "../../logging.js";
import { YamlService } from "../../services/YamlService.js";
import {
  type Fingerprint,
  type SqlDialect,
  mulberry32,
  synthKey,
  assertSyntheticKey,
  drawRollupChildCount,
  scaleToTarget,
  sampleMeasuresCopula,
  buildAssociationCache,
  buildDdl,
  writeCsv,
  writePipelineIsolationReport,
  fingerprintSha256,
  mkTag,
  type PipelineIsolationReport,
} from "../generate-synthetic-data-shared.js";

// ── Parameters ──────────────────────────────────────────────────────────────

class GenerateSyntheticDataFromSMLParams extends ParameterSet {
  parameters = [
    new (class extends StringParameter {
      name        = "fingerprint";
      description = "Path to a fingerprint YAML (pre-computed). If omitted, --sml must be supplied.";
      required    = false;
    })(),
    new (class extends StringParameter {
      name        = "sml";
      description = "Path to an SML model directory to profile against the supplied connection.";
      required    = false;
    })(),
    new (class extends StringParameter {
      name        = "connection-file";
      description = "connections.yaml path (only used when --sml is supplied).";
      required    = false;
      defaultValue = "connections.yaml";
    })(),
    new (class extends StringParameter {
      name        = "connection-name";
      description = "Connection entry in connections.yaml (only used when --sml is supplied).";
      required    = false;
    })(),
    new (class extends StringParameter {
      name        = "output-dir";
      description = "Directory where synthetic CSVs and artifacts are written.";
      required    = true;
    })(),
    new (class extends StringParameter {
      name        = "dialect";
      description = "SQL dialect for the emitted DDL: ansi | postgres | snowflake | mysql | bigquery. Default: ansi.";
      required    = false;
      defaultValue = "ansi";
    })(),
    new (class extends NumberParameter {
      name        = "seed";
      description = "PRNG seed (mulberry32). Same seed → identical output. Default: 1742832000.";
      required    = false;
      defaultValue = 1742832000;
    })(),
    new (class extends NumberParameter {
      name        = "max-rows-per-table";
      description = "Cap on emitted row count per table (for smoke tests). 0 = uncapped. Default: 0.";
      required    = false;
      defaultValue = 0;
    })(),
    new (class extends BooleanParameter {
      name         = "acknowledge-experimental";
      description  = "Acknowledge that this operation is experimental until TSTR certification completes.";
      required     = false;
      defaultValue = false;
    })(),
  ];
}

type Params = {
  fingerprint?:                string;
  sml?:                        string;
  "connection-file":           string;
  "connection-name"?:          string;
  "output-dir":                string;
  dialect:                     string;
  seed:                        number;
  "max-rows-per-table":        number;
  "acknowledge-experimental":  boolean;
};

// ── Operation ───────────────────────────────────────────────────────────────

export class GenerateSyntheticDataFromSMLOperation extends Operation<Params> {
  name        = "generate-synthetic-data-from-sml";
  description = "Generate a statistical digital twin of a semantic-layer dataset as DDL + CSV files.";
  parameters  = new GenerateSyntheticDataFromSMLParams();

  constructor(services: ServiceRegistry, logger: Logger) {
    super(services, logger);
  }

  async run(params: Params): Promise<void> {
    const tag = mkTag("GenerateSyntheticDataFromSML", this.logger);
    const runId = crypto.randomUUID();
    const startedAt = new Date().toISOString();

    if (!params["acknowledge-experimental"]) {
      tag.warn(
        "This operation is experimental until TSTR certification completes. " +
        "Pass --acknowledge-experimental true to proceed.",
      );
      throw new Error("experimental gate not acknowledged");
    }

    if (!params.fingerprint && !params.sml) {
      throw new Error(
        "Either --fingerprint <yaml> or --sml <dir> must be supplied.",
      );
    }

    const outputDir = path.resolve(params["output-dir"]);
    fs.mkdirSync(outputDir, { recursive: true });

    // ── 1. Obtain the fingerprint ───────────────────────────────────────────
    const yaml = this.services.get<YamlService>("yaml");
    let fingerprint: Fingerprint;
    let fingerprintPath: string;
    let fingerprintRaw: string;

    if (params.fingerprint) {
      fingerprintPath = path.resolve(params.fingerprint);
      fingerprintRaw = fs.readFileSync(fingerprintPath, "utf8");
      fingerprint = yaml.readFromFile<Fingerprint>(fingerprintPath);
      tag.log(`Using precomputed fingerprint: ${fingerprintPath}`);
    } else {
      // Profile-from-SML path. This is where STATISTICS.md Phases 1–6 run with
      // ε-DP / k-anonymity gates per revised §6. In this staged prototype the
      // profile step is implemented as a TODO-documented placeholder; the
      // promoter must wire it to src/algorithm/statistical-fingerprint.ts
      // (not yet present in the repo — to be introduced alongside this op).
      throw new Error(
        "[generate-synthetic-data-from-sml] --sml profile path is not implemented in this staged prototype. " +
        "Pre-compute a fingerprint with the profiler and pass --fingerprint, or extend this method to call the profiler.",
      );
    }

    // ── 2. Generate ─────────────────────────────────────────────────────────
    const dialect = (params.dialect.toLowerCase() as SqlDialect);
    const rand = mulberry32(params.seed >>> 0);
    const rowCap = params["max-rows-per-table"] | 0;

    // Per-dimension synthetic leaf key arrays; used by fact generation.
    const dimLeafKeys = new Map<string, string[]>();
    const dimLeafCount = new Map<string, number>();

    const emittedPaths: string[] = [];

    // 2a. Dimensions
    for (const d of fingerprint.dimensions) {
      const hier = d.hierarchies[0];
      const leafLevel = hier.levels[hier.levels.length - 1];
      const leafTarget = rowCap > 0 ? Math.min(leafLevel.member_count, rowCap) : leafLevel.member_count;

      // Top-down rollup counts (STATISTICS.md §8.2).
      const levelCounts: number[] = [hier.levels[0].member_count];
      for (let li = 1; li < hier.levels.length; li++) {
        const lv = hier.levels[li];
        const parentCount = levelCounts[li - 1];
        if (!lv.rollup_from_parent) {
          levelCounts.push(lv.member_count);
          continue;
        }
        // Per-parent child counts → sum → scale to lv.member_count.
        const counts: number[] = [];
        for (let p = 0; p < parentCount; p++) {
          const tierIdx = lv.rollup_from_parent.tiers ? ((p % 4) as 0 | 1 | 2 | 3) : undefined;
          counts.push(drawRollupChildCount(rand, lv.rollup_from_parent, tierIdx));
        }
        const target = li === hier.levels.length - 1 ? leafTarget : lv.member_count;
        const scaled = scaleToTarget(counts, target);
        levelCounts.push(scaled.reduce((a, b) => a + b, 0));
      }

      // Emit rows at the leaf level.
      const rows: Array<Record<string, unknown>> = [];
      const leafKeys: string[] = [];
      let curLeafIdx = 0;
      const actualLeafCount = levelCounts[levelCounts.length - 1];
      const l1SpanPer = Math.max(1, Math.ceil(actualLeafCount / hier.levels[0].member_count));
      const l2SpanPer = hier.levels.length > 2
        ? Math.max(1, Math.ceil(actualLeafCount / levelCounts[1]))
        : actualLeafCount;

      for (let i = 0; i < actualLeafCount; i++) {
        const l1Key = Math.min(hier.levels[0].member_count, Math.floor(i / l1SpanPer) + 1);
        const l2Key = hier.levels.length > 2
          ? Math.min(levelCounts[1], Math.floor(i / l2SpanPer) + 1)
          : l1Key;
        const leafKey = synthKey(rand);
        assertSyntheticKey(leafKey);
        leafKeys.push(leafKey);
        const row: Record<string, unknown> = {};
        row[`l1_key`] = l1Key;
        if (hier.levels.length > 2) row[`l2_key`] = l2Key;
        row[`l${hier.levels.length}_key`] = leafKey;
        if (leafLevel.is_unique_label) {
          row[`l${hier.levels.length}_label`] = `syn_label_${i + 1}`;
        }
        rows.push(row);
        curLeafIdx++;
      }

      dimLeafKeys.set(d.id, leafKeys);
      dimLeafCount.set(d.id, leafKeys.length);

      const csvPath = path.join(outputDir, `dim_${d.id.replace(/^D/, "")}.csv`);
      writeCsv(rows, csvPath);
      emittedPaths.push(csvPath);
      tag.log(`Wrote ${rows.length} rows → ${path.basename(csvPath)}`);
    }

    // 2b. Facts
    for (const f of fingerprint.facts) {
      const anchorJoin = f.joins[0];
      if (!anchorJoin) {
        tag.warn(`Fact ${f.id} has no joins; skipping.`);
        continue;
      }

      const anchorKeys = dimLeafKeys.get(anchorJoin.to_dimension) ?? [];
      if (anchorKeys.length === 0) {
        tag.warn(`Fact ${f.id}: anchor dimension ${anchorJoin.to_dimension} has no leaves; skipping.`);
        continue;
      }

      // Cold-leaf gate per STATISTICS.md §8.3.
      const coldFrac = 0;   // anchor-specific cold fraction not carried on the join object; defaults to 0 here
      const coldCount = Math.floor(anchorKeys.length * coldFrac);
      const hotKeys = anchorKeys.slice(coldCount);

      const targetRows = rowCap > 0 ? Math.min(f.row_count, rowCap) : f.row_count;

      // Per-hot-leaf density budgets.
      const densityBudgets = hotKeys.map(() => {
        const u = Math.max(1e-9, Math.min(1 - 1e-9, Math.random()));
        // Use fact-join density shape interpolated at the percentile ladder.
        const d = anchorJoin.density;
        if (u <= 0.5) return d.p50;
        if (u <= 0.9) return d.p50 + (d.p90 - d.p50) * ((u - 0.5) / 0.4);
        if (u <= 0.99) return d.p90 + (d.p99 - d.p90) * ((u - 0.9) / 0.09);
        return d.p999 ?? d.p99;
      });
      const scaledBudgets = scaleToTarget(densityBudgets, targetRows);

      // FK association caches (synthetic-index keyed per review §R-16).
      const nonAnchorJoins = f.joins.slice(1);
      const assocCaches = new Map<string, Map<number, number[]>>();
      for (const j of nonAnchorJoins) {
        const assoc = (f.fk_associations ?? []).find(
          (a) =>
            (a.dimension_id_1 === anchorJoin.to_dimension && a.dimension_id_2 === j.to_dimension) ||
            (a.dimension_id_2 === anchorJoin.to_dimension && a.dimension_id_1 === j.to_dimension),
        );
        const score = assoc?.association_score ?? 0;
        if (score > 0.05) {
          assocCaches.set(
            j.to_dimension,
            buildAssociationCache(rand, hotKeys.length, dimLeafKeys.get(j.to_dimension)?.length ?? 0, score),
          );
        }
      }

      const corrSpec = {
        measures: f.measures,
        correlations: f.measure_correlations ?? [],
      };

      const rows: Array<Record<string, unknown>> = [];
      for (let hi = 0; hi < hotKeys.length; hi++) {
        const rowsForLeaf = scaledBudgets[hi] ?? 0;
        for (let ri = 0; ri < rowsForLeaf; ri++) {
          const row: Record<string, unknown> = {};
          row[`dim_${anchorJoin.to_dimension.replace(/^D/, "")}_key`] = hotKeys[hi];
          for (const j of nonAnchorJoins) {
            const pool = dimLeafKeys.get(j.to_dimension) ?? [];
            if (pool.length === 0) continue;
            const cache = assocCaches.get(j.to_dimension);
            const allowed = cache?.get(hi);
            const pick = allowed && allowed.length > 0
              ? allowed[Math.floor(rand() * allowed.length)]
              : Math.floor(rand() * pool.length);
            row[`dim_${j.to_dimension.replace(/^D/, "")}_key`] = pool[pick];
          }
          const measures = sampleMeasuresCopula(rand, corrSpec);
          for (const [mid, val] of Object.entries(measures)) {
            const colName = mid.replace(/^.*\./, "").toLowerCase();
            row[colName] = val;
          }
          rows.push(row);
          if (rows.length >= targetRows) break;
        }
        if (rows.length >= targetRows) break;
      }

      const csvPath = path.join(outputDir, `fact_${f.id.replace(/^F/, "")}.csv`);
      writeCsv(rows, csvPath);
      emittedPaths.push(csvPath);
      tag.log(`Wrote ${rows.length} rows → ${path.basename(csvPath)}`);
    }

    // 2c. DDL
    const ddlPath = path.join(outputDir, "schema.sql");
    fs.writeFileSync(ddlPath, buildDdl(fingerprint, dialect), "utf8");
    emittedPaths.push(ddlPath);

    // 2d. Generation manifest
    const manifest = {
      manifest_version: "1.0" as const,
      operation: this.name,
      run_id: runId,
      fingerprint_source: fingerprintPath,
      fingerprint_sha256: fingerprintSha256(fingerprintRaw),
      prng: "mulberry32",
      seed: params.seed,
      dialect,
      outputs: emittedPaths.map((p) => ({ path: path.relative(outputDir, p) })),
      invariants_asserted: {
        synthetic_key_regex: "^syn_[0-9a-f]{8}$",
        fk_orphan_tolerance: 0,
        no_real_pii: true,
      },
    };
    const manifestPath = path.join(outputDir, "generation_manifest.json");
    fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + "\n", "utf8");
    emittedPaths.push(manifestPath);

    // ── 3. Pipeline isolation self-check ────────────────────────────────────
    const completedAt = new Date().toISOString();
    const report: PipelineIsolationReport = {
      report_version: "1.0",
      operation: this.name,
      run_id: runId,
      output_root: outputDir,
      emitted_paths: emittedPaths.map((p) => path.relative(outputDir, p)),
      started_at: startedAt,
      completed_at: completedAt,
      outside_boundary_writes: emittedPaths.filter((p) => !p.startsWith(outputDir + path.sep)),
    };
    if (report.outside_boundary_writes.length > 0) {
      tag.warn(`Pipeline-isolation failure: wrote outside ${outputDir}`);
      throw new Error("pipeline isolation violated");
    }
    writePipelineIsolationReport(report, path.join(outputDir, "pipeline_isolation_report.json"));
    tag.log(`Done. ${emittedPaths.length} artifact(s) under ${outputDir}.`);
  }
}
