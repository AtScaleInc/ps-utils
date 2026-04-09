/**
 * extract-queries-from-atscale
 *
 * Connects to the AtScale internal Postgres backend and extracts deduplicated
 * query history for one or more models.  Outputs one JSON file per
 * (model, protocol) pair that can be consumed directly by
 * execute-atscale-query-harness.
 *
 * Supports two config formats:
 *   systems.properties  — the existing Gatling project config file
 *   connections.yaml    — the standard connections file used by this project
 */
import { Operation } from "../Operation.js";
import { ParameterSet, StringParameter } from "../../Parameters.js";
import type { ServiceRegistry } from "../../services/registry.js";
import type { Logger } from "../../logging.js";
import { SqlService, type ConnectionConfig } from "../../services/SqlService.js";
import { createHash } from "crypto";
import fs from "fs";
import path from "path";
import { parse as parseYaml } from "yaml";

// ── Types ──────────────────────────────────────────────────────────────────────

export interface QueryRecord {
  queryName: string;
  queryLanguage: string;
  inboundText: string;
  inboundTextAsHash: string;
  outboundText: string | null;
  cubeName: string;
  projectId: string;
  aggregateUsed: boolean;
  numTimes: number;
  elapsedTimeInSeconds: number | null;
  avgResultSetSize: number;
  atscaleQueryId: string;
}

// ── Parameter set ──────────────────────────────────────────────────────────────

class ExtractQueriesParameterSet extends ParameterSet {
  parameters = [
    new (class extends StringParameter {
      name = "connection-file";
      description =
        "Path to connections.yaml or a Gatling systems.properties file";
      required = true;
    })(),
    new (class extends StringParameter {
      name = "connection-name";
      description =
        "Connection name within connections.yaml (ignored for .properties files)";
      required = false;
      defaultValue = "default";
    })(),
    new (class extends StringParameter {
      name = "models";
      description =
        "Comma-separated model/cube names to extract. " +
        "Required for YAML mode; overrides atscale.models for .properties mode.";
      required = false;
    })(),
    new (class extends StringParameter {
      name = "days";
      description = "Look-back window in days";
      required = false;
      defaultValue = "60";
    })(),
    new (class extends StringParameter {
      name = "output-dir";
      description = "Directory to write the output JSON files";
      required = false;
      defaultValue = "queries";
    })(),
    new (class extends StringParameter {
      name = "protocol";
      description = "Query protocol to extract: sql, xmla, or all";
      required = false;
      defaultValue = "all";
    })(),
    new (class extends StringParameter {
      name = "min-executions";
      description = "Exclude queries seen fewer than N times in the window";
      required = false;
      defaultValue = "1";
    })(),
    new (class extends StringParameter {
      name = "db-schema";
      description =
        "Postgres schema prefix for the AtScale backend tables " +
        "(e.g. 'engine' or 'atscale.engine'). Defaults to the schema in the connection file, " +
        "then 'engine' (standard container deployment).";
      required = false;
      defaultValue = "";
    })(),
  ];
}

type Params = {
  "connection-file": string;
  "connection-name": string;
  models?: string;
  days: string;
  "output-dir": string;
  protocol: string;
  "min-executions": string;
  "db-schema": string;
};

// ── Helpers ────────────────────────────────────────────────────────────────────

function sha256hex(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

/** Parse a Java-style key=value properties file. */
export function parsePropertiesFile(content: string): Record<string, string> {
  const props: Record<string, string> = {};
  for (const line of content.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#") || trimmed.startsWith("!")) continue;
    const eqIdx = trimmed.indexOf("=");
    if (eqIdx === -1) continue;
    props[trimmed.slice(0, eqIdx).trim()] = trimmed.slice(eqIdx + 1).trim();
  }
  return props;
}

/** Escape a value for inclusion in a SQL single-quoted string literal. */
function sqEscape(value: string): string {
  return value.replace(/'/g, "''");
}

/**
 * Parse a JDBC postgresql URL into connection fields for the native pg driver.
 * e.g. jdbc:postgresql://host:10520/atscale?currentSchema=engine
 */
export function parseJdbcPostgresUrl(jdbcUrl: string): {
  server: string;
  port: number;
  database: string;
  schema?: string;
} {
  const url = new URL(jdbcUrl.replace(/^jdbc:/, ""));
  return {
    server: url.hostname,
    port: url.port ? parseInt(url.port, 10) : 5432,
    database: url.pathname.replace(/^\//, ""),
    schema: url.searchParams.get("currentSchema") ?? undefined,
  };
}

/**
 * Build the query-history extraction SQL.
 *
 * schema       — Postgres schema prefix (e.g. "engine" or "atscale.engine")
 * queryLang    — AtScale query_language value: "pgsql", "analysis", or "sql"
 * cubeName     — AtScale model/cube name
 * days         — look-back window (days)
 * minExec      — minimum execution count (HAVING COUNT(*) >= N)
 */
function buildExtractionSql(
  schema: string,
  queryLang: string,
  cubeName: string,
  days: number,
  minExec: number,
): string {
  // Allow letters, digits, underscores, dots, hyphens in the schema prefix only.
  const safeSchema = schema.replace(/[^a-zA-Z0-9_.]/g, "");
  return `
SELECT
    q.service,
    q.query_language,
    q.query_text                                                                  AS inbound_text,
    MAX(q.query_id::text)                                                         AS atscale_query_id,
    MAX(s.subquery_text)                                                          AS outbound_text,
    p.cube_name,
    p.project_id,
    CASE WHEN MAX(s.subquery_text) LIKE '%as_agg_%' THEN true ELSE false END      AS used_agg,
    COUNT(*)                                                                      AS num_times,
    EXTRACT(EPOCH FROM AVG(r.finished - p.planning_started))                      AS elapsed_time_in_seconds,
    AVG(r.result_size)                                                            AS avg_result_size
FROM   ${safeSchema}.queries          q
JOIN   ${safeSchema}.query_results    r ON q.query_id = r.query_id
JOIN   ${safeSchema}.queries_planned  p ON q.query_id = p.query_id
JOIN   ${safeSchema}.subqueries       s ON q.query_id = s.query_id
WHERE  q.query_language = '${sqEscape(queryLang)}'
AND    p.planning_started > current_timestamp - INTERVAL '${days} days'
AND    p.cube_name        = '${sqEscape(cubeName)}'
AND    q.service          = 'user-query'
AND    r.succeeded        = true
AND    LENGTH(q.query_text) > 1
AND    q.query_text NOT LIKE '/* Virtual query to get the members of a level */%'
AND    q.query_text NOT LIKE '-- statement does not return rows%'
GROUP  BY 1, 2, 3, 6, 7
HAVING COUNT(*) >= ${minExec}
ORDER  BY 3
`.trim();
}

/** Map a result row (case-insensitive key access) to a QueryRecord. */
function rowToRecord(row: Record<string, any>, idx: number, fallbackLang: string, fallbackCube: string): QueryRecord {
  const get = (key: string): any => row[key] ?? row[key.toUpperCase()] ?? row[key.toLowerCase()];
  const text: string = get("inbound_text") ?? "";
  return {
    queryName: `Query ${idx + 1}`,
    queryLanguage: get("query_language") ?? fallbackLang,
    inboundText: text,
    inboundTextAsHash: sha256hex(text),
    outboundText: get("outbound_text") ?? null,
    cubeName: get("cube_name") ?? fallbackCube,
    projectId: String(get("project_id") ?? ""),
    aggregateUsed: Boolean(get("used_agg")),
    numTimes: Number(get("num_times") ?? 0),
    elapsedTimeInSeconds:
      get("elapsed_time_in_seconds") != null
        ? Number(get("elapsed_time_in_seconds"))
        : null,
    avgResultSetSize: Number(get("avg_result_size") ?? 0),
    atscaleQueryId: String(get("atscale_query_id") ?? ""),
  };
}

// ── Operation ──────────────────────────────────────────────────────────────────

export class ExtractQueriesFromAtScaleOperation extends Operation<Params> {
  name = "extract-queries-from-atscale";
  description =
    "Extract deduplicated query history from the AtScale Postgres backend " +
    "and write JSON files for use with execute-atscale-query-harness";
  parameters = new ExtractQueriesParameterSet();

  constructor(services: ServiceRegistry, logger: Logger) {
    super(services, logger);
  }

  async run(params: Params): Promise<void> {
    const sqlSvc = this.services.get<SqlService>("sql");
    const isProperties = params["connection-file"].endsWith(".properties");

    // ── Load connection config ───────────────────────────────────────────────
    let connConfig: ConnectionConfig;
    let connName: string;
    let models: string[];

    if (isProperties) {
      const raw = fs.readFileSync(path.resolve(params["connection-file"]), "utf8");
      const props = parsePropertiesFile(raw);

      const jdbcUrl = props["atscale.postgres.jdbc.url"];
      const username = props["atscale.postgres.jdbc.username"];
      const password = props["atscale.postgres.jdbc.password"];

      if (!jdbcUrl) {
        throw new Error(
          "systems.properties is missing atscale.postgres.jdbc.url",
        );
      }
      if (!username) {
        throw new Error(
          "systems.properties is missing atscale.postgres.jdbc.username",
        );
      }
      if (!password) {
        throw new Error(
          "systems.properties is missing atscale.postgres.jdbc.password",
        );
      }

      connName = "_atscale_postgres";
      const { server, port, database, schema } = parseJdbcPostgresUrl(jdbcUrl);
      connConfig = {
        connections: {
          [connName]: {
            sql: { dialect: "postgres", server, port, database, schema, username, password },
          },
        },
        users: {},
      };

      const modelsCsv = params.models ?? props["atscale.models"];
      if (!modelsCsv) {
        throw new Error(
          "Provide --models or set atscale.models in systems.properties",
        );
      }
      models = modelsCsv.split(",").map((m) => m.trim()).filter(Boolean);
    } else {
      // YAML mode
      const raw = fs.readFileSync(path.resolve(params["connection-file"]), "utf8");
      connConfig = parseYaml(raw) as ConnectionConfig;
      connName = params["connection-name"];

      if (!params.models) {
        throw new Error(
          "--models is required when using a connections.yaml file",
        );
      }
      models = params.models.split(",").map((m) => m.trim()).filter(Boolean);
    }

    const days = Math.max(1, parseInt(params.days, 10) || 60);
    const minExec = Math.max(1, parseInt(params["min-executions"], 10) || 1);
    // Resolve the Postgres schema to query.  Priority:
    //   1. Explicit --db-schema CLI flag (user override)
    //   2. schema field on the connection entry in the connection file
    //   3. Hard-coded fallback "engine" (standard container deployment)
    const connEntry = connConfig.connections?.[connName];
    const connSchema = connEntry?.sql?.schema;
    const installerMode = !!(connEntry as any)?.installer;
    const schema = params["db-schema"] || connSchema || (installerMode ? "atscale" : "engine");
    const protocol = params.protocol.toLowerCase();
    const outputDir = path.resolve(params["output-dir"]);
    fs.mkdirSync(outputDir, { recursive: true });

    // Determine which (language, output-suffix) pairs to extract.
    // pgsql   = container/cloud SQL
    // sql     = installer SQL (Hive)
    // analysis = XMLA/MDX
    type ProtocolEntry = { lang: string; suffix: string };
    const toExtract: ProtocolEntry[] = [];
    if (protocol === "all" || protocol === "sql") {
      toExtract.push({ lang: "pgsql", suffix: "sql" });
      toExtract.push({ lang: "sql", suffix: "sql_installer" });
    }
    if (protocol === "all" || protocol === "xmla") {
      toExtract.push({ lang: "analysis", suffix: "xmla" });
    }

    // ── Connect ──────────────────────────────────────────────────────────────
    this.logger.info("Connecting to AtScale Postgres backend…");
    const conn = await sqlSvc.connect(connConfig, connName);

    let totalWritten = 0;

    try {
      for (const model of models) {
        for (const { lang, suffix } of toExtract) {
          this.logger.info(
            `  Extracting '${lang}' queries for model '${model}'…`,
          );
          const sql = buildExtractionSql(schema, lang, model, days, minExec);
          this.logger.verbose(`SQL:\n${sql}`);

          let rows: any[];
          try {
            rows = await sqlSvc.query(conn, sql);
          } catch (err) {
            const raw = err instanceof Error ? err.message : String(err);
            const msg = raw.split("\n")[0].trim();
            const connSql = connEntry?.sql ?? {};
            const serverDesc = [connSql.server, connSql.port].filter(Boolean).join(":");
            const dbDesc = connSql.database ?? "(unknown)";
            this.logger.log(
              `  WARN: query failed (language=${lang}, model=${model}): ${msg}`,
            );
            this.logger.log(
              `  Connection: ${serverDesc}  database: ${dbDesc}  schema: ${schema}`,
            );
            this.logger.log(
              `  The table '${schema}.queries' was not found. ` +
              `Try a different --db-schema value. Common values:`,
            );
            this.logger.log(`    --db-schema engine          (standard container / cloud deployment)`);
            this.logger.log(`    --db-schema atscale         (older on-premise installer)`);
            this.logger.log(`    --db-schema atscale.engine  (installer with explicit schema path)`);
            this.logger.log(
              `  To discover the correct schema, connect to the Postgres database and run:`,
            );
            this.logger.log(
              `    SELECT table_schema, table_name FROM information_schema.tables` +
              ` WHERE table_name = 'queries' ORDER BY table_schema;`,
            );
            continue;
          }

          if (rows.length === 0) {
            this.logger.log(
              `  No '${lang}' queries found for model '${model}' ` +
              `in the last ${days} days. ` +
              `Verify the model name and query language match what AtScale recorded.`,
            );
            continue;
          }

          const records: QueryRecord[] = rows.map((row, idx) =>
            rowToRecord(row, idx, lang, model),
          );

          const safeModel = model.replace(/[^a-zA-Z0-9_-]/g, "_");
          const outFile = path.join(outputDir, `${safeModel}_${suffix}_queries.json`);
          fs.writeFileSync(outFile, JSON.stringify(records, null, 2), "utf8");
          this.logger.info(
            `  Wrote ${records.length} record(s) → ${outFile}`,
          );
          totalWritten += records.length;
        }
      }
    } finally {
      await sqlSvc.close(conn);
    }

    this.logger.info(
      `Done — ${totalWritten} total query record(s) written to ${outputDir}`,
    );
  }
}
