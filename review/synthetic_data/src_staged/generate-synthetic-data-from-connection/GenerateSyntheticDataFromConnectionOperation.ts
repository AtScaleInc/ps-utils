/**
 * GenerateSyntheticDataFromConnection
 *
 * DB-output sibling of generate-synthetic-data-from-sml. Emits the synthetic twin
 * directly against a target connection: CREATE TABLE statements in FK-correct order
 * (dimensions before facts), optional DROP if --drop-if-exists (facts before
 * dimensions), and multi-value INSERT statements in configurable batches.
 *
 * PROMOTION NOTE:
 *   Staged at review/synthetic_data/src_staged/generate-synthetic-data-from-connection/.
 *   On promotion, moves to src/operations/generate-synthetic-data-from-connection/.
 *   Imports assume the promoted location.
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
import { SqlService, type ConnectionConfig, type SqlConnection } from "../../services/SqlService.js";
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
  writePipelineIsolationReport,
  fingerprintSha256,
  mkTag,
  type PipelineIsolationReport,
} from "../generate-synthetic-data-shared.js";

// ── Parameters ──────────────────────────────────────────────────────────────

class GenerateSyntheticDataFromConnectionParams extends ParameterSet {
  parameters = [
    new (class extends StringParameter {
      name        = "fingerprint";
      description = "Path to a fingerprint YAML. Required in this staged prototype.";
      required    = true;
    })(),
    new (class extends StringParameter {
      name        = "connection-file";
      description = "Path to connections.yaml.";
      required    = false;
      defaultValue = "connections.yaml";
    })(),
    new (class extends StringParameter {
      name        = "connection-name";
      description = "Target connection name in connections.yaml.";
      required    = true;
    })(),
    new (class extends StringParameter {
      name        = "target-schema";
      description = "Target schema where synthetic tables will be created.";
      required    = true;
    })(),
    new (class extends StringParameter {
      name        = "dialect";
      description = "SQL dialect for the emitted DDL + INSERTs: ansi | postgres | snowflake | mysql | bigquery. Default: postgres.";
      required    = false;
      defaultValue = "postgres";
    })(),
    new (class extends NumberParameter {
      name        = "seed";
      description = "PRNG seed (mulberry32). Default: 1742832000.";
      required    = false;
      defaultValue = 1742832000;
    })(),
    new (class extends NumberParameter {
      name        = "batch-size";
      description = "Rows per multi-value INSERT. Default: 500.";
      required    = false;
      defaultValue = 500;
    })(),
    new (class extends NumberParameter {
      name        = "max-rows-per-table";
      description = "Cap on emitted row count per table (for smoke tests). 0 = uncapped. Default: 0.";
      required    = false;
      defaultValue = 0;
    })(),
    new (class extends BooleanParameter {
      name         = "drop-if-exists";
      description  = "Drop fact tables then dimension tables before creating (FK-safe). Default: false.";
      required     = false;
      defaultValue = false;
    })(),
    new (class extends BooleanParameter {
      name         = "acknowledge-experimental";
      description  = "Acknowledge that this operation is experimental until TSTR certification completes.";
      required     = false;
      defaultValue = false;
    })(),
    new (class extends StringParameter {
      name        = "report-dir";
      description = "Directory to write the pipeline-isolation + manifest artifacts. Default: ./synthetic_data_reports.";
      required    = false;
      defaultValue = "synthetic_data_reports";
    })(),
  ];
}

type Params = {
  fingerprint:                  string;
  "connection-file":            string;
  "connection-name":            string;
  "target-schema":              string;
  dialect:                      string;
  seed:                         number;
  "batch-size":                 number;
  "max-rows-per-table":         number;
  "drop-if-exists":             boolean;
  "acknowledge-experimental":   boolean;
  "report-dir":                 string;
};

// ── Helpers ─────────────────────────────────────────────────────────────────

function sqlLiteral(v: unknown): string {
  if (v === null || v === undefined) return "NULL";
  if (typeof v === "number") return Number.isFinite(v) ? String(v) : "NULL";
  if (typeof v === "boolean") return v ? "TRUE" : "FALSE";
  return `'${String(v).replace(/'/g, "''")}'`;
}

// ── Operation ───────────────────────────────────────────────────────────────

export class GenerateSyntheticDataFromConnectionOperation extends Operation<Params> {
  name        = "generate-synthetic-data-from-connection";
  description = "Generate a statistical digital twin and write it directly to a target database connection.";
  parameters  = new GenerateSyntheticDataFromConnectionParams();

  constructor(services: ServiceRegistry, logger: Logger) {
    super(services, logger);
  }

  async run(params: Params): Promise<void> {
    const tag = mkTag("GenerateSyntheticDataFromConnection", this.logger);
    const runId = crypto.randomUUID();
    const startedAt = new Date().toISOString();

    if (!params["acknowledge-experimental"]) {
      tag.warn(
        "This operation is experimental until TSTR certification completes. " +
        "Pass --acknowledge-experimental true to proceed.",
      );
      throw new Error("experimental gate not acknowledged");
    }

    const reportDir = path.resolve(params["report-dir"]);
    fs.mkdirSync(reportDir, { recursive: true });

    const yaml = this.services.get<YamlService>("yaml");
    const sql  = this.services.get<SqlService>("sql");

    const fingerprintPath = path.resolve(params.fingerprint);
    const fingerprintRaw = fs.readFileSync(fingerprintPath, "utf8");
    const fingerprint: Fingerprint = yaml.readFromFile<Fingerprint>(fingerprintPath);

    const config = yaml.readFromFile<ConnectionConfig>(params["connection-file"]);
    const conn: SqlConnection = await sql.connect(config, params["connection-name"]);

    const dialect = (params.dialect.toLowerCase() as SqlDialect);
    const schema = params["target-schema"];
    const rand = mulberry32(params.seed >>> 0);
    const rowCap = params["max-rows-per-table"] | 0;
    const batchSize = Math.max(1, params["batch-size"] | 0);

    const emittedTables: string[] = [];

    try {
      // ── 1. Optionally drop (facts first, then dimensions) ────────────────
      if (params["drop-if-exists"]) {
        for (const f of fingerprint.facts) {
          const table = `${schema}.fact_${f.id.replace(/^F/, "")}`;
          tag.log(`Dropping ${table}`);
          await sql.execute(conn, `DROP TABLE IF EXISTS ${table}`);
        }
        for (const d of fingerprint.dimensions) {
          const table = `${schema}.dim_${d.id.replace(/^D/, "")}`;
          tag.log(`Dropping ${table}`);
          await sql.execute(conn, `DROP TABLE IF EXISTS ${table}`);
        }
      }

      // ── 2. DDL — dimensions first, then facts ────────────────────────────
      const ddl = buildDdl(fingerprint, dialect);
      for (const stmt of ddl.split(";").map((s) => s.trim()).filter(Boolean)) {
        const qualified = stmt.replace(/CREATE TABLE (\w+)/i, `CREATE TABLE ${schema}.$1`);
        await sql.execute(conn, qualified);
      }

      // ── 3. Generate + INSERT ─────────────────────────────────────────────
      const dimLeafKeys = new Map<string, string[]>();

      for (const d of fingerprint.dimensions) {
        const hier = d.hierarchies[0];
        const leafLevel = hier.levels[hier.levels.length - 1];
        const leafTarget = rowCap > 0 ? Math.min(leafLevel.member_count, rowCap) : leafLevel.member_count;

        const levelCounts: number[] = [hier.levels[0].member_count];
        for (let li = 1; li < hier.levels.length; li++) {
          const lv = hier.levels[li];
          const parentCount = levelCounts[li - 1];
          if (!lv.rollup_from_parent) { levelCounts.push(lv.member_count); continue; }
          const counts: number[] = [];
          for (let p = 0; p < parentCount; p++) {
            const tierIdx = lv.rollup_from_parent.tiers ? ((p % 4) as 0 | 1 | 2 | 3) : undefined;
            counts.push(drawRollupChildCount(rand, lv.rollup_from_parent, tierIdx));
          }
          const target = li === hier.levels.length - 1 ? leafTarget : lv.member_count;
          const scaled = scaleToTarget(counts, target);
          levelCounts.push(scaled.reduce((a, b) => a + b, 0));
        }

        const actualLeafCount = levelCounts[levelCounts.length - 1];
        const l1SpanPer = Math.max(1, Math.ceil(actualLeafCount / hier.levels[0].member_count));
        const l2SpanPer = hier.levels.length > 2
          ? Math.max(1, Math.ceil(actualLeafCount / levelCounts[1]))
          : actualLeafCount;

        const colNames: string[] = [];
        for (let i = 0; i < hier.levels.length; i++) colNames.push(`l${i + 1}_key`);
        if (leafLevel.is_unique_label) colNames.push(`l${hier.levels.length}_label`);

        const table = `${schema}.dim_${d.id.replace(/^D/, "")}`;
        emittedTables.push(table);
        const leafKeys: string[] = [];
        let buffer: string[] = [];

        for (let i = 0; i < actualLeafCount; i++) {
          const l1Key = Math.min(hier.levels[0].member_count, Math.floor(i / l1SpanPer) + 1);
          const l2Key = hier.levels.length > 2
            ? Math.min(levelCounts[1], Math.floor(i / l2SpanPer) + 1)
            : l1Key;
          const leafKey = synthKey(rand);
          assertSyntheticKey(leafKey);
          leafKeys.push(leafKey);
          const values = [l1Key];
          if (hier.levels.length > 2) values.push(l2Key);
          values.push(leafKey as unknown as number);
          if (leafLevel.is_unique_label) values.push(`syn_label_${i + 1}` as unknown as number);
          buffer.push(`(${values.map(sqlLiteral).join(",")})`);
          if (buffer.length >= batchSize) {
            await sql.execute(conn, `INSERT INTO ${table} (${colNames.join(",")}) VALUES ${buffer.join(",")}`);
            buffer = [];
          }
        }
        if (buffer.length > 0) {
          await sql.execute(conn, `INSERT INTO ${table} (${colNames.join(",")}) VALUES ${buffer.join(",")}`);
        }
        dimLeafKeys.set(d.id, leafKeys);
        tag.log(`Inserted ${leafKeys.length} rows into ${table}`);
      }

      for (const f of fingerprint.facts) {
        const anchorJoin = f.joins[0];
        if (!anchorJoin) continue;
        const anchorKeys = dimLeafKeys.get(anchorJoin.to_dimension) ?? [];
        if (anchorKeys.length === 0) continue;

        const targetRows = rowCap > 0 ? Math.min(f.row_count, rowCap) : f.row_count;
        const densityBudgets = anchorKeys.map(() => {
          const u = rand();
          const dens = anchorJoin.density;
          if (u <= 0.5) return dens.p50;
          if (u <= 0.9) return dens.p50 + (dens.p90 - dens.p50) * ((u - 0.5) / 0.4);
          if (u <= 0.99) return dens.p90 + (dens.p99 - dens.p90) * ((u - 0.9) / 0.09);
          return dens.p999 ?? dens.p99;
        });
        const scaledBudgets = scaleToTarget(densityBudgets, targetRows);

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
              buildAssociationCache(rand, anchorKeys.length, dimLeafKeys.get(j.to_dimension)?.length ?? 0, score),
            );
          }
        }

        const corrSpec = { measures: f.measures, correlations: f.measure_correlations ?? [] };

        const table = `${schema}.fact_${f.id.replace(/^F/, "")}`;
        emittedTables.push(table);
        const colNames: string[] = [];
        for (const j of f.joins) colNames.push(`dim_${j.to_dimension.replace(/^D/, "")}_key`);
        for (const m of f.measures) colNames.push(m.id.replace(/^.*\./, "").toLowerCase());

        let buffer: string[] = [];
        let totalRows = 0;
        outer: for (let hi = 0; hi < anchorKeys.length; hi++) {
          const rowsForLeaf = scaledBudgets[hi] ?? 0;
          for (let ri = 0; ri < rowsForLeaf; ri++) {
            const values: unknown[] = [anchorKeys[hi]];
            for (const j of nonAnchorJoins) {
              const pool = dimLeafKeys.get(j.to_dimension) ?? [];
              const cache = assocCaches.get(j.to_dimension);
              const allowed = cache?.get(hi);
              const pick = allowed && allowed.length > 0
                ? allowed[Math.floor(rand() * allowed.length)]
                : Math.floor(rand() * pool.length);
              values.push(pool[pick]);
            }
            const measures = sampleMeasuresCopula(rand, corrSpec);
            for (const m of f.measures) values.push(measures[m.id]);
            buffer.push(`(${values.map(sqlLiteral).join(",")})`);
            totalRows++;
            if (buffer.length >= batchSize) {
              await sql.execute(conn, `INSERT INTO ${table} (${colNames.join(",")}) VALUES ${buffer.join(",")}`);
              buffer = [];
            }
            if (totalRows >= targetRows) break outer;
          }
        }
        if (buffer.length > 0) {
          await sql.execute(conn, `INSERT INTO ${table} (${colNames.join(",")}) VALUES ${buffer.join(",")}`);
        }
        tag.log(`Inserted ${totalRows} rows into ${table}`);
      }

      // ── 4. Manifest + pipeline-isolation report ──────────────────────────
      const completedAt = new Date().toISOString();
      const manifest = {
        manifest_version: "1.0" as const,
        operation: this.name,
        run_id: runId,
        fingerprint_source: fingerprintPath,
        fingerprint_sha256: fingerprintSha256(fingerprintRaw),
        prng: "mulberry32",
        seed: params.seed,
        dialect,
        target: { connection: params["connection-name"], schema },
        tables: emittedTables,
      };
      const manifestPath = path.join(reportDir, `manifest_${runId}.json`);
      fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + "\n", "utf8");

      const isolationReport: PipelineIsolationReport = {
        report_version: "1.0",
        operation: this.name,
        run_id: runId,
        output_root: `${params["connection-name"]}:${schema}`,
        emitted_paths: emittedTables,
        started_at: startedAt,
        completed_at: completedAt,
        outside_boundary_writes: [],   // DB-level writes are constrained to the target schema
      };
      writePipelineIsolationReport(
        isolationReport,
        path.join(reportDir, `pipeline_isolation_report_${runId}.json`),
      );

      tag.log(`Done. ${emittedTables.length} table(s) materialized in ${params["connection-name"]}:${schema}.`);
    } finally {
      await sql.close(conn);
    }
  }
}
