/**
 * ExtractDataShapeFromConnection
 *
 * Connects to a live database, reads an SML model to understand the semantic
 * layer structure, and extracts a statistical fingerprint of the data —
 * capturing hierarchy level cardinalities, rollup ratios, leaf-level fact
 * densities, measure distributions, and conformed dimension overlap.
 *
 * No actual data values are written.  The output is a YAML fingerprint file
 * that fully describes the statistical shape of the model without divulging
 * any specific records.  The file contains enough information to reconstruct
 * plausible DDL and generate synthetic data that is statistically equivalent
 * to the original.
 *
 * Output:
 *   <output-file>   (default: data-shape.yaml in the current directory)
 *
 * Large fact tables are automatically sampled via TABLESAMPLE SYSTEM or a
 * LIMIT-based fallback (see --target-fact-rows and --no-tablesample).
 */
import path from "path";
import { Operation } from "../Operation.js";
import { ParameterSet, StringParameter, NumberParameter, BooleanParameter } from "../../Parameters.js";
import type { ServiceRegistry } from "../../services/registry.js";
import type { Logger } from "../../logging.js";
import { YamlService } from "../../services/YamlService.js";
import { SqlService, type ConnectionConfig, type SqlConnection } from "../../services/SqlService.js";
import {
  extractFingerprint,
  writeFingerprintFile,
} from "../../statistics/index.js";
import type { DatabaseQueryRunner } from "../../statistics/index.js";

// ─── Parameters ────────────────────────────────────────────────────────────────

class ExtractDataShapeParams extends ParameterSet {
  parameters = [
    new (class extends StringParameter {
      name         = "connection-file";
      description  = "Path to the connections.yaml file (default: connections.yaml)";
      required     = false;
      defaultValue = "connections.yaml";
    })(),
    new (class extends StringParameter {
      name        = "connection-name";
      description = "Name of the connection entry in the connections.yaml file";
      required    = true;
    })(),
    new (class extends StringParameter {
      name        = "sml-path";
      description = "Path to the SML output directory or a model.yml file produced by generate-sml-from-connection / generate-sml-from-ddl";
      required    = true;
    })(),
    new (class extends StringParameter {
      name         = "output-file";
      description  = "Output path for the fingerprint YAML (default: data-shape.yaml)";
      required     = false;
      defaultValue = "data-shape.yaml";
    })(),
    new (class extends NumberParameter {
      name         = "target-fact-rows";
      description  = "Target row count when sampling large fact tables for density profiling (default: 100000; 0 = no sampling)";
      required     = false;
      defaultValue = 100_000;
    })(),
    new (class extends NumberParameter {
      name         = "target-column-rows";
      description  = "Target row count for measure column distribution sampling (default: 10000; 0 = no sampling)";
      required     = false;
      defaultValue = 10_000;
    })(),
    new (class extends BooleanParameter {
      name         = "tablesample";
      description  = "Use TABLESAMPLE SYSTEM for fact sampling when true (default: true). Set to false for databases that do not support TABLESAMPLE (e.g. MySQL).";
      required     = false;
      defaultValue = true;
    })(),
    new (class extends BooleanParameter {
      name         = "serial";
      description  = "Profile dimensions one at a time instead of in parallel (default: false). Use when the database enforces a low per-user connection limit.";
      required     = false;
      defaultValue = false;
    })(),
    new (class extends BooleanParameter {
      name         = "preserve-meta-data";
      description  = "Store original table and column names in the fingerprint so data generation uses real names instead of synthetic ones (default: false)";
      required     = false;
      defaultValue = false;
    })(),
  ];
}

type Params = {
  "connection-file":    string;
  "connection-name":    string;
  "sml-path":           string;
  "output-file":        string;
  "target-fact-rows":   number;
  "target-column-rows": number;
  "tablesample":        boolean;
  "serial":             boolean;
  "preserve-meta-data": boolean;
};
export type ExtractDataShapeFromConnectionParams = Params;

// ─── DatabaseQueryRunner adapter ──────────────────────────────────────────────

/**
 * Thin adapter that bridges SqlService + SqlConnection to the statistics
 * module's DatabaseQueryRunner interface.
 */
class SqlQueryRunner implements DatabaseQueryRunner {
  constructor(
    private readonly sql:  SqlService,
    private readonly conn: SqlConnection,
  ) {}

  async query(sqlStr: string): Promise<Record<string, unknown>[]> {
    const rows = await this.sql.query(this.conn, sqlStr);
    return rows as Record<string, unknown>[];
  }
}

// ─── Dialect detection ────────────────────────────────────────────────────────

/**
 * Dialects known to accept a TABLESAMPLE clause. The exact form differs per
 * dialect — see `tablesampleClause` in statistics/sampling.ts.
 *
 * Deliberately an allowlist: a denylist lets any new dialect through and hands
 * it syntax it may not accept, which fails mid-profile rather than falling back.
 * Anything not listed here uses the LIMIT-based fallback, which is universally
 * valid and only costs randomness.
 */
const TABLESAMPLE_DIALECTS = [
  "postgres",    // includes "postgresql"
  "snowflake",
  "databricks",
  "spark",
  "bigquery",
  "duckdb",
];

/**
 * Infer whether the connected database supports a TABLESAMPLE clause from the
 * dialect string in the connection config.
 *
 * Users can override with --no-tablesample.
 */
function dialectSupportsTablesample(dialect?: string): boolean {
  if (!dialect) return false; // unknown dialect — use the portable fallback
  const d = dialect.toLowerCase();
  return TABLESAMPLE_DIALECTS.some((s) => d.includes(s));
}

// ─── Operation ────────────────────────────────────────────────────────────────

export class ExtractDataShapeFromConnectionOperation extends Operation<Params> {
  name        = "extract-data-shape-from-connection";
  description = "Connect to a database and extract a statistical fingerprint of the SML model data shape";
  parameters  = new ExtractDataShapeParams();

  constructor(services: ServiceRegistry, logger: Logger) {
    super(services, logger);
  }

  async run(params: Params): Promise<void> {
    const tag  = "ExtractDataShape";
    const yaml = this.services.get<YamlService>("yaml");
    const sql  = this.services.get<SqlService>("sql");

    const connectionName = params["connection-name"];
    const smlPath        = path.resolve(params["sml-path"]);
    const outputFile     = path.resolve(params["output-file"]);

    // ── Connect ────────────────────────────────────────────────────────────────
    const config = yaml.readFromFile<ConnectionConfig>(params["connection-file"]);
    const conn   = await sql.connect(config, connectionName);
    this.logger.log(`[${tag}] Connected to "${connectionName}"`);

    // Detect dialect for TABLESAMPLE support
    const dialect = (config.connections?.[connectionName]?.sql?.dialect as string | undefined);
    const tablesampleSupported =
      params["tablesample"] && dialectSupportsTablesample(dialect);

    if (!tablesampleSupported && params["tablesample"]) {
      this.logger.log(
        `[${tag}] Dialect "${dialect ?? "unknown"}" does not support TABLESAMPLE — ` +
        `using LIMIT-based sampling fallback`,
      );
    }

    try {
      const runner = new SqlQueryRunner(sql, conn);

      // ── Extract fingerprint ─────────────────────────────────────────────────
      const fingerprint = await extractFingerprint(runner, {
        smlPath,
        sampling: {
          targetFactRows:      params["target-fact-rows"],
          targetColumnRows:    params["target-column-rows"],
          supportsTablesample: tablesampleSupported,
          dialect,
        },
        parallel:         !params["serial"],
        preserveMetadata: params["preserve-meta-data"],
        onProgress:       (msg) => this.logger.log(`[${tag}] ${msg}`),
      });

      // ── Write output ────────────────────────────────────────────────────────
      writeFingerprintFile(fingerprint, outputFile);
      this.logger.log(`[${tag}] Fingerprint written to: ${outputFile}`);

      // ── Summary ─────────────────────────────────────────────────────────────
      this.logger.log(
        `[${tag}] Done — ` +
        `${fingerprint.dimensions.length} dimension(s), ` +
        `${fingerprint.facts.length} fact(s), ` +
        `${fingerprint.conformedDimensions.length} conformed dimension(s)`,
      );
    } finally {
      await sql.close(conn);
    }
  }
}
