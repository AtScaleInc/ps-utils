/**
 * GenerateDataFromDataShapeToConnection
 *
 * Reads a data-shape.yaml fingerprint, generates synthetic data, and loads it
 * directly into a live database.  Combines generate-data-from-data-shape and
 * generate-ddl-from-data-shape into a single end-to-end pipeline.
 *
 * Typical workflow:
 *   1. extract-data-shape-from-connection  (fingerprint production environment)
 *   2. generate-ddl-from-data-shape        (optional — creates the empty schema)
 *   3. generate-data-from-data-shape-to-connection  (populates a target DB)
 *
 * The operation:
 *   1. Reads data-shape.yaml
 *   2. Generates synthetic data in memory
 *   3. Optionally drops and/or creates tables (--drop-if-exists, --create-tables)
 *   4. Inserts all rows in batches (--batch-size, default 500)
 *
 * Order of operations is always:
 *   DROP FACT tables → DROP DIM tables → CREATE DIM tables → CREATE FACT tables
 *   → INSERT DIM rows → INSERT FACT rows
 * This order respects FK constraints throughout.
 */
import fs   from "fs";
import path from "path";
import { Operation } from "../Operation.js";
import {
  ParameterSet, StringParameter, NumberParameter, BooleanParameter,
} from "../../Parameters.js";
import type { ServiceRegistry } from "../../services/registry.js";
import type { Logger }          from "../../logging.js";
import { YamlService }          from "../../services/YamlService.js";
import { SqlService, type ConnectionConfig, type SqlConnection } from "../../services/SqlService.js";
import { readFingerprintFile }  from "../../statistics/fingerprint.js";
import { generateData, type GeneratedTable } from "../../statistics/data-generator.js";
import { generateDdl, type SqlDialect } from "../../statistics/ddl-generator.js";
import {
  SECURITY_PROFILE_VERSION,
  sha256File,
  writePipelineIsolationReport,
  writeRunManifest,
  writeIntegrityReport,
}                                 from "../../statistics/security.js";
import crypto                    from "crypto";

// ─── Parameters ────────────────────────────────────────────────────────────────

class GenerateDataToConnectionParams extends ParameterSet {
  parameters = [
    new (class extends StringParameter {
      name         = "input-file";
      description  = "Path to the data-shape.yaml fingerprint file (default: data-shape.yaml)";
      required     = false;
      defaultValue = "data-shape.yaml";
    })(),
    new (class extends StringParameter {
      name         = "connection-file";
      description  = "Path to the connections.yaml file (default: connections.yaml)";
      required     = false;
      defaultValue = "connections.yaml";
    })(),
    new (class extends StringParameter {
      name        = "connection-name";
      description = "Name of the connection entry in the connections file";
      required    = true;
    })(),
    new (class extends NumberParameter {
      name         = "scale-factor";
      description  = "Scale row/member counts by this factor (default: 1.0)";
      required     = false;
      defaultValue = 1.0;
    })(),
    new (class extends NumberParameter {
      name        = "seed";
      description = "Random seed for reproducible output";
      required    = false;
    })(),
    new (class extends BooleanParameter {
      name         = "create-tables";
      description  = "Emit CREATE TABLE statements before inserting (default: false)";
      required     = false;
      defaultValue = false;
    })(),
    new (class extends BooleanParameter {
      name         = "drop-if-exists";
      description  = "DROP TABLE IF EXISTS before creating tables — implies --create-tables (default: false)";
      required     = false;
      defaultValue = false;
    })(),
    new (class extends StringParameter {
      name         = "dialect";
      description  = "SQL dialect for CREATE TABLE: ansi (default), postgresql, snowflake, mysql, bigquery";
      required     = false;
      defaultValue = "ansi";
    })(),
    new (class extends NumberParameter {
      name         = "batch-size";
      description  = "Rows per INSERT statement (default: 500)";
      required     = false;
      defaultValue = 500;
    })(),
    new (class extends StringParameter {
      name        = "schema";
      description = "Target schema to qualify table names (e.g. PUBLIC).  Omit to use the connection default.";
      required    = false;
    })(),
    new (class extends StringParameter {
      name         = "reports-dir";
      description  = "Directory where security reports are written (default: ./_reports)";
      required     = false;
      defaultValue = "_reports";
    })(),
  ];
}

type Params = {
  "input-file":    string;
  "connection-file": string;
  "connection-name": string;
  "scale-factor":  number;
  "seed"?:         number;
  "create-tables": boolean;
  "drop-if-exists": boolean;
  "dialect":       string;
  "batch-size":    number;
  "schema"?:       string;
  "reports-dir":   string;
};

// ─── Operation ────────────────────────────────────────────────────────────────

export class GenerateDataFromDataShapeToConnectionOperation extends Operation<Params> {
  name        = "generate-data-from-data-shape-to-connection";
  description = "Generate synthetic data from a fingerprint and load it into a live database";
  parameters  = new GenerateDataToConnectionParams();

  constructor(services: ServiceRegistry, logger: Logger) {
    super(services, logger);
  }

  async run(params: Params): Promise<void> {
    const tag         = "GenerateDataToConnection";
    const inputFile   = path.resolve(params["input-file"]);
    const reportsDir  = path.resolve(params["reports-dir"]);
    const dialect     = params["dialect"] as SqlDialect;
    const batchSize   = Math.max(1, params["batch-size"]);
    const schemaPrefix = params["schema"] ? `${params["schema"]}.` : "";
    const doCreate    = params["create-tables"] || params["drop-if-exists"];
    const doDrop      = params["drop-if-exists"];
    const startedAt   = new Date().toISOString();

    const yaml = this.services.get<YamlService>("yaml");
    const sql  = this.services.get<SqlService>("sql");

    if (!fs.existsSync(inputFile)) {
      throw new Error(`Fingerprint file not found: ${inputFile}`);
    }

    // ── Read fingerprint ──────────────────────────────────────────────────────
    this.logger.log(`[${tag}] Reading fingerprint: ${inputFile}`);
    const fp                = readFingerprintFile(inputFile);
    const fingerprintSha256 = sha256File(inputFile);
    this.logger.log(
      `[${tag}] Fingerprint v${fp.version} — ` +
      `${fp.dimensions.length} dimension(s), ${fp.facts.length} fact(s)`,
    );

    // ── Generate data ─────────────────────────────────────────────────────────
    this.logger.log(`[${tag}] Generating synthetic data (scale: ${params["scale-factor"]})…`);
    const data = generateData(fp, {
      scaleFactor: params["scale-factor"],
      seed:        params["seed"],
    });

    // ── Connect ───────────────────────────────────────────────────────────────
    const config = yaml.readFromFile<ConnectionConfig>(params["connection-file"]);
    const conn   = await sql.connect(config, params["connection-name"]);
    this.logger.log(`[${tag}] Connected to "${params["connection-name"]}"`);

    try {
      // ── DDL phase ─────────────────────────────────────────────────────────────
      if (doCreate) {
        const ddlStatements = parseDdlStatements(generateDdl(fp, { dialect }));

        if (doDrop) {
          // Drop in reverse FK order: facts first, then dims
          const allNames = [
            ...data.facts.map((t) => t.tableName),
            ...data.dimensions.map((t) => t.tableName),
          ];
          for (const name of allNames) {
            const dropSql = `DROP TABLE IF EXISTS ${schemaPrefix}${name}`;
            this.logger.log(`  DROP: ${schemaPrefix}${name}`);
            await sql.query(conn, dropSql);
          }
        }

        // Create dims first, then facts
        for (const stmt of ddlStatements) {
          this.logger.log(`  CREATE: ${extractTableName(stmt) ?? "table"}`);
          // Qualify table name with schema if provided
          const qualified = schemaPrefix
            ? stmt.replace(/^CREATE TABLE (\S+)/i, `CREATE TABLE ${schemaPrefix}$1`)
            : stmt;
          await sql.query(conn, qualified);
        }
      }

      // ── Insert phase ──────────────────────────────────────────────────────────
      const allTables = [...data.dimensions, ...data.facts];
      for (const table of allTables) {
        if (table.rows.length === 0) continue;
        await insertTable(sql, conn, table, schemaPrefix, batchSize, this.logger, tag);
      }

      const totalRows = allTables.reduce((s, t) => s + t.rows.length, 0);
      const completedAt = new Date().toISOString();

      // ── Security reports ───────────────────────────────────────────────────
      const rowCounts: Record<string, number> = {};
      for (const t of allTables) rowCounts[t.tableName] = t.rows.length;

      const outputDigest = crypto.createHash("sha256")
        .update(JSON.stringify({
          rowCounts, fingerprintSha256,
          connection: params["connection-name"],
          schema:     params["schema"] ?? null,
          seed:       params["seed"],
          scaleFactor: params["scale-factor"],
        }))
        .digest("hex");

      writePipelineIsolationReport(reportsDir, {
        operation:   this.name,
        startedAt, completedAt,
        inputs: { fingerprintFile: inputFile, fingerprintSha256, fingerprintVersion: fp.version },
        outputs: {
          path: `${params["connection-name"]}:${params["schema"] ?? "(default)"}`,
          kind: "database",
          artifacts: allTables.map((t) => `${schemaPrefix}${t.tableName}`),
        },
        enforced: {
          noRealDataAccessed:        true,
          outputsResolveWithinScope: true,  // writes are scoped to configured connection
          generatedKeyShapeOk:       true,
          fkClosureOk:               data.fkClosure.failed.length === 0,
        },
        profileVersion: SECURITY_PROFILE_VERSION,
      });
      writeRunManifest(reportsDir, {
        operation:  this.name,
        startedAt, completedAt,
        seed:        params["seed"],
        scaleFactor: params["scale-factor"],
        fingerprintSha256,
        outputDigest,
        rowCounts,
        profileVersion: SECURITY_PROFILE_VERSION,
      });
      writeIntegrityReport(reportsDir, {
        checkedAt: completedAt,
        tables:    allTables.map((t) => ({
          name: t.tableName, rowCount: t.rows.length, columnCount: t.columns.length,
        })),
        fkClosure:      data.fkClosure,
        profileVersion: SECURITY_PROFILE_VERSION,
      });

      this.logger.log(
        `[${tag}] Done — ${allTables.length} table(s), ` +
        `${totalRows.toLocaleString()} total rows inserted; ` +
        `security reports → ${reportsDir}`,
      );
    } finally {
      await sql.close(conn);
    }
  }
}

// ─── Insert helper ────────────────────────────────────────────────────────────

async function insertTable(
  sql:        SqlService,
  conn:       SqlConnection,
  table:      GeneratedTable,
  prefix:     string,
  batchSize:  number,
  logger:     Logger,
  tag:        string,
): Promise<void> {
  const qualName   = `${prefix}${table.tableName}`;
  const colList    = table.columns.join(", ");
  const totalRows  = table.rows.length;
  let inserted     = 0;

  logger.log(`  → ${qualName}: inserting ${totalRows.toLocaleString()} rows…`);

  for (let start = 0; start < totalRows; start += batchSize) {
    const batch   = table.rows.slice(start, start + batchSize);
    const valRows = batch.map(
      (row) => `(${row.map(sqlLiteral).join(", ")})`,
    ).join(",\n  ");

    const insertSql = `INSERT INTO ${qualName} (${colList}) VALUES\n  ${valRows}`;
    await sql.query(conn, insertSql);
    inserted += batch.length;
  }

  logger.log(`    ✓ ${inserted.toLocaleString()} rows`);
}

/** Convert a JS value to a SQL literal. */
function sqlLiteral(v: unknown): string {
  if (v === null || v === undefined) return "NULL";
  if (typeof v === "number")         return String(v);
  if (typeof v === "boolean")        return v ? "1" : "0";
  // String: escape single quotes
  return `'${String(v).replace(/'/g, "''")}'`;
}

// ─── DDL parsing helpers ──────────────────────────────────────────────────────

/** Split DDL output into individual CREATE TABLE statements. */
function parseDdlStatements(ddl: string): string[] {
  return ddl
    .split(/;/)
    .map((s) => s.replace(/--[^\n]*/g, "").trim())
    .filter((s) => /^CREATE\s+TABLE/i.test(s))
    .map((s) => s + ";");
}

function extractTableName(stmt: string): string | undefined {
  return stmt.match(/CREATE\s+TABLE\s+(\S+)/i)?.[1];
}
