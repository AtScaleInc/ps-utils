/**
 * execute-atscale-query-harness
 *
 * Loads a set of queries from a JSON file (output of extract-queries-from-atscale)
 * or a CSV ingest file (compatible with the existing Gatling ingest/ format), then
 * fires them against an AtScale instance with configurable concurrency.
 *
 * Supports:
 *   XMLA (MDX) — via HTTP SOAP/XMLA, both container and installer auth modes
 *   SQL        — via SqlService (native pg/snowflake drivers)
 *
 * Config file formats:
 *   systems.properties  — existing Gatling project config
 *   connections.yaml    — standard connections file used by this project
 *
 * Task files:
 *   The --task-file flag accepts YAML or JSON arrays in the existing Gatling
 *   executor_tasks/ schema.  All tasks in the file are run sequentially;
 *   each task produces its own output CSV.
 */
import { Operation } from "../Operation.js";
import { ParameterSet, StringParameter } from "../../Parameters.js";
import type { ServiceRegistry } from "../../services/registry.js";
import type { Logger } from "../../logging.js";
import { SqlService, type ConnectionConfig } from "../../services/SqlService.js";
import { parsePropertiesFile, parseJdbcPostgresUrl } from "../extract-queries-from-atscale/ExtractQueriesFromAtScaleOperation.js";
import type { QueryRecord } from "../extract-queries-from-atscale/ExtractQueriesFromAtScaleOperation.js";
import axios from "axios";
import { createHash, randomBytes } from "crypto";
import fs from "fs";
import path from "path";
import { parse as parseYaml } from "yaml";

// ── Types ──────────────────────────────────────────────────────────────────────

interface ResultRecord {
  runId: string;
  taskName: string;
  model: string;
  queryName: string;
  atscaleQueryId: string;
  protocol: string;
  status: "SUCCEEDED" | "FAILED";
  durationMs: number;
  rowCount: number;
  error: string;
  timestamp: number;
  inboundTextAsHash: string;
  inboundText: string;
}

/** Minimal representation of one Gatling injection step from a task file. */
interface InjectionStep {
  type: string;
  users?: number;
  from?: number;
  to?: number;
  durationMinutes?: number;
  rate?: number;
}

/** One task entry from an executor_tasks YAML/JSON file. */
interface TaskDefinition {
  taskName: string;
  simulationClass?: string;
  model: string;
  runId?: string;
  runLogFileName?: string;
  injectionSteps?: InjectionStep[];
  ingestionFileName?: string | null;
  ingestionFileHasHeader?: boolean;
  additionalProperties?: Record<string, string>;
}

// ── Parameter set ──────────────────────────────────────────────────────────────

class ExecuteHarnessParameterSet extends ParameterSet {
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
        "Connection name within connections.yaml, or model name for .properties files";
      required = true;
    })(),
    new (class extends StringParameter {
      name = "query-file";
      description =
        "JSON file produced by extract-queries-from-atscale. " +
        "Ignored when --task-file is set.";
      required = false;
    })(),
    new (class extends StringParameter {
      name = "ingest-file";
      description =
        "CSV query file in Gatling ingest/ format (sampler_name,sql_text or " +
        "sampler_name,atscale_query_id,sql_text). Ignored when --task-file is set.";
      required = false;
    })(),
    new (class extends StringParameter {
      name = "task-file";
      description =
        "YAML or JSON executor task file (executor_tasks/*.yaml schema). " +
        "All tasks in the file are run sequentially.";
      required = false;
    })(),
    new (class extends StringParameter {
      name = "protocol";
      description = "Query protocol: xmla or sql";
      required = false;
      defaultValue = "xmla";
    })(),
    new (class extends StringParameter {
      name = "concurrent-users";
      description =
        "Number of simultaneous query workers. Overridden by --task-file injection steps.";
      required = false;
      defaultValue = "1";
    })(),
    new (class extends StringParameter {
      name = "throttle-ms";
      description =
        "Milliseconds to pause between queries per worker " +
        "(matches atscale.gatling.throttle.ms)";
      required = false;
      defaultValue = "5";
    })(),
    new (class extends StringParameter {
      name = "run-id";
      description =
        "Identifier stamped on every output row. Auto-generated (YYYY-MM-DD-XXXXXXXXXX) if omitted.";
      required = false;
    })(),
    new (class extends StringParameter {
      name = "output-dir";
      description = "Directory to write the results CSV file(s)";
      required = false;
      defaultValue = "run_results";
    })(),
    new (class extends StringParameter {
      name = "redact";
      description =
        "When true, omit query text from the output and replace with the hash only";
      required = false;
      defaultValue = "false";
    })(),
    new (class extends StringParameter {
      name = "duration-minutes";
      description =
        "For timed runs: how long to keep cycling through the query list. " +
        "When 0 (default), each query is executed exactly once. " +
        "Overridden by --task-file injection steps.";
      required = false;
      defaultValue = "0";
    })(),
  ];
}

type Params = {
  "connection-file": string;
  "connection-name": string;
  "query-file"?: string;
  "ingest-file"?: string;
  "task-file"?: string;
  protocol: string;
  "concurrent-users": string;
  "throttle-ms": string;
  "run-id"?: string;
  "output-dir": string;
  redact: string;
  "duration-minutes": string;
};

// ── Small utilities ────────────────────────────────────────────────────────────

function sha256hex(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

function generateRunId(): string {
  const today = new Date().toISOString().slice(0, 10);
  const rand = randomBytes(5).toString("hex").toUpperCase();
  return `${today}-${rand}`;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Escape XML special characters in MDX query text. */
function escapeXml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

/** Escape a CSV field value. */
function csvField(value: string | number | null | undefined): string {
  const s = value == null ? "" : String(value);
  if (s.includes(",") || s.includes('"') || s.includes("\n")) {
    return `"${s.replace(/"/g, '""')}"`;
  }
  return s;
}

/** Convert an array of ResultRecords to a CSV string. */
function toCsv(records: ResultRecord[], redact: boolean): string {
  const baseColumns = [
    "run_id", "task_name", "model", "query_name", "atscale_query_id",
    "protocol", "status", "duration_ms", "row_count", "error",
    "timestamp", "inbound_text_hash",
  ];
  const header = redact
    ? baseColumns.join(",")
    : [...baseColumns, "inbound_text"].join(",");

  const rows = records.map((r) => {
    const base = [
      r.runId, r.taskName, r.model, r.queryName,
      r.atscaleQueryId, r.protocol, r.status,
      r.durationMs, r.rowCount, r.error, r.timestamp,
      r.inboundTextAsHash,
    ];
    return (redact ? base : [...base, r.inboundText]).map(csvField).join(",");
  });

  return [header, ...rows].join("\n") + "\n";
}

// ── CSV ingest parser ──────────────────────────────────────────────────────────

/**
 * Parse an RFC-4180 CSV string, handling:
 *   - Double-quoted fields (including embedded newlines and quotes)
 *   - Optional header row
 * Returns rows as string arrays (header row included as the first element).
 */
function parseCsv(content: string): string[][] {
  const rows: string[][] = [];
  let i = 0;
  const n = content.length;

  while (i < n) {
    const row: string[] = [];

    while (i < n && content[i] !== "\n" && content[i] !== "\r") {
      if (content[i] === '"') {
        // Quoted field
        i++;
        let field = "";
        while (i < n) {
          if (content[i] === '"' && content[i + 1] === '"') {
            field += '"';
            i += 2;
          } else if (content[i] === '"') {
            i++;
            break;
          } else {
            field += content[i++];
          }
        }
        row.push(field);
      } else {
        // Unquoted field — read up to comma or end-of-line
        let field = "";
        while (i < n && content[i] !== "," && content[i] !== "\n" && content[i] !== "\r") {
          field += content[i++];
        }
        row.push(field.trim());
      }

      if (i < n && content[i] === ",") {
        i++; // consume comma, continue to next field
      } else {
        break; // end of record
      }
    }

    // Consume line ending
    if (i < n && content[i] === "\r") i++;
    if (i < n && content[i] === "\n") i++;

    if (row.length > 0 && !(row.length === 1 && row[0] === "")) {
      rows.push(row);
    }
  }

  return rows;
}

/**
 * Load queries from a CSV ingest file.
 * Format A (2 columns): sampler_name, sql_text
 * Format B (3 columns): sampler_name, atscale_query_id, sql_text
 */
function loadQueriesFromCsv(filePath: string, hasHeader: boolean): QueryRecord[] {
  const content = fs.readFileSync(path.resolve(filePath), "utf8");
  const rows = parseCsv(content);
  const dataRows = hasHeader ? rows.slice(1) : rows;

  return dataRows
    .filter((row) => row.length >= 2)
    .map((row): QueryRecord => {
      const queryName = row[0];
      const isTwoColumn = row.length === 2;
      const atscaleQueryId = isTwoColumn ? "" : row[1];
      const inboundText = isTwoColumn ? row[1] : row[2];
      return {
        queryName,
        queryLanguage: "",
        inboundText,
        inboundTextAsHash: sha256hex(inboundText),
        outboundText: null,
        cubeName: "",
        projectId: "",
        aggregateUsed: false,
        numTimes: 0,
        elapsedTimeInSeconds: null,
        avgResultSetSize: 0,
        atscaleQueryId,
      };
    });
}

/** Load queries from a JSON file (output of extract-queries-from-atscale). */
function loadQueriesFromJson(filePath: string): QueryRecord[] {
  const raw = fs.readFileSync(path.resolve(filePath), "utf8");
  return JSON.parse(raw) as QueryRecord[];
}

// ── Config helpers ─────────────────────────────────────────────────────────────

interface XmlaConfig {
  url: string;
  cube: string;
  catalog: string;
  /** installer mode: auth URL to obtain a bearer token via HTTP Basic */
  authUrl?: string;
  authUsername?: string;
  authPassword?: string;
  /** container mode: token embedded in the XMLA URL path */
  isContainer: boolean;
  useAggregates: boolean;
  generateAggregates: boolean;
  useQueryCache: boolean;
  useAggregateCache: boolean;
}

interface SqlConfig {
  connectionConfig: ConnectionConfig;
  connectionName: string;
}

/**
 * Determine XMLA config from systems.properties for a given model name.
 * Container mode: URL contains /engine/xmla (token is part of the URL path).
 * Installer mode: separate auth URL/credentials required.
 */
function xmlaConfigFromProperties(
  props: Record<string, string>,
  model: string,
): XmlaConfig {
  const key = (k: string) => props[`atscale.${model}.xmla.${k}`] ?? "";
  const url = key("url");
  const cube = key("cube");
  const catalog = key("catalog");

  if (!url) {
    throw new Error(
      `systems.properties is missing atscale.${model}.xmla.url`,
    );
  }

  const isContainer = url.toLowerCase().includes("/engine/xmla");

  return {
    url,
    cube: cube || model,
    catalog,
    authUrl: key("auth.url") || undefined,
    authUsername: key("auth.username") || undefined,
    authPassword: key("auth.password") || undefined,
    isContainer,
    useAggregates: (props["atscale.xmla.useAggregates"] ?? "true") === "true",
    generateAggregates: (props["atscale.xmla.generateAggregates"] ?? "false") === "true",
    useQueryCache: (props["atscale.xmla.useQueryCache"] ?? "false") === "true",
    useAggregateCache: (props["atscale.xmla.useAggregateCache"] ?? "true") === "true",
  };
}

/**
 * Determine XMLA config from a connections.yaml connection entry.
 * Uses the same installer/cloud flag pattern as the other operations.
 */
function xmlaConfigFromYaml(
  connectionFile: Record<string, any>,
  connectionName: string,
  model: string,
): XmlaConfig {
  const connection = connectionFile.connections?.[connectionName];
  if (!connection) {
    throw new Error(`Connection '${connectionName}' not found in connections.yaml`);
  }
  const mdx = connection.mdx;
  if (!mdx) {
    throw new Error(
      `Connection '${connectionName}' is missing an mdx: block for XMLA execution`,
    );
  }

  const userEntry = connectionFile.users?.[mdx.user] ?? {};
  const installer: boolean = connection.installer ?? true;
  const baseUrl: string = mdx.url ?? "";
  const orgId: string = mdx.organization_id ?? "";
  const catalog: string = mdx.catalog_name ?? "";

  const xmlaUrl = installer
    ? `${baseUrl}:10502/xmla/${orgId}`
    : `${baseUrl}/engine/xmla`;

  const authUrl = installer
    ? `${baseUrl}:10500/${orgId}/auth`
    : `${baseUrl}/auth/realms/atscale/protocol/openid-connect/token`;

  return {
    url: xmlaUrl,
    cube: model,
    catalog,
    authUrl,
    authUsername: userEntry.username,
    authPassword: userEntry.password,
    isContainer: !installer,
    useAggregates: true,
    generateAggregates: false,
    useQueryCache: false,
    useAggregateCache: true,
  };
}

/**
 * Determine SQL connection config from systems.properties for a given model name.
 */
function sqlConfigFromProperties(
  props: Record<string, string>,
  model: string,
): SqlConfig {
  const key = (k: string) => props[`atscale.${model}.jdbc.${k}`] ?? "";
  const url = key("url");
  const username = key("username");
  const password = key("password");

  if (!url) {
    throw new Error(`systems.properties is missing atscale.${model}.jdbc.url`);
  }
  if (!username) {
    throw new Error(`systems.properties is missing atscale.${model}.jdbc.username`);
  }
  if (!password) {
    throw new Error(`systems.properties is missing atscale.${model}.jdbc.password`);
  }

  const { server, port, database, schema } = parseJdbcPostgresUrl(url);
  const connName = `_${model}_sql`;
  return {
    connectionConfig: {
      connections: {
        [connName]: {
          sql: { dialect: "postgres", server, port, database, schema, username, password },
        },
      },
      users: {},
    },
    connectionName: connName,
  };
}

// ── XMLA execution ─────────────────────────────────────────────────────────────

/** Obtain a bearer token for installer-mode XMLA. */
async function getBearerToken(
  authUrl: string,
  username: string,
  password: string,
  isContainer: boolean,
): Promise<string> {
  if (isContainer) {
    // Container mode: token is embedded in the XMLA URL, no auth call needed.
    return "";
  }

  try {
    const response = await axios.get(authUrl, {
      auth: { username, password },
    });
    return String(response.data).trim();
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new Error(`Failed to obtain bearer token from ${authUrl}: ${msg}`);
  }
}

/** Build a SOAP/XMLA request envelope. */
function buildSoapEnvelope(
  mdxQuery: string,
  cfg: XmlaConfig,
): string {
  const escaped = escapeXml(mdxQuery);
  return `<Envelope xmlns="http://schemas.xmlsoap.org/soap/envelope/">
  <Body>
    <Execute xmlns="urn:schemas-microsoft-com:xml-analysis">
      <Command><Statement>${escaped}</Statement></Command>
      <Properties>
        <PropertyList>
          <Cube>${escapeXml(cfg.cube)}</Cube>
          <Catalog>${escapeXml(cfg.catalog)}</Catalog>
          <UseAggregates>${cfg.useAggregates}</UseAggregates>
          <GenerateAggregates>${cfg.generateAggregates}</GenerateAggregates>
          <UseQueryCache>${cfg.useQueryCache}</UseQueryCache>
          <UseAggregateCache>${cfg.useAggregateCache}</UseAggregateCache>
        </PropertyList>
      </Properties>
    </Execute>
  </Body>
</Envelope>`;
}

/**
 * Execute one XMLA query and return timing/row-count result.
 * Returns rowCount = -1 when the response cannot be parsed.
 */
async function executeXmlaQuery(
  query: QueryRecord,
  cfg: XmlaConfig,
  token: string,
): Promise<{ status: "SUCCEEDED" | "FAILED"; durationMs: number; rowCount: number; error: string }> {
  const envelope = buildSoapEnvelope(query.inboundText, cfg);
  const headers: Record<string, string> = {
    "Content-Type": "text/xml; charset=UTF-8",
    Accept: "text/xml",
  };

  if (!cfg.isContainer && token) {
    headers["Authorization"] = `Bearer ${token}`;
  }

  const start = Date.now();
  try {
    const response = await axios.post(cfg.url, envelope, {
      headers,
      validateStatus: null, // capture all HTTP statuses
    });

    const durationMs = Date.now() - start;
    const body: string = typeof response.data === "string"
      ? response.data
      : JSON.stringify(response.data);

    if (response.status !== 200) {
      return {
        status: "FAILED",
        durationMs,
        rowCount: 0,
        error: `HTTP ${response.status}: ${body.slice(0, 200)}`,
      };
    }

    // Count <row> elements as a rough result-set size proxy
    const rowCount = (body.match(/<row>/g) ?? []).length;
    return { status: "SUCCEEDED", durationMs, rowCount, error: "" };
  } catch (err) {
    const durationMs = Date.now() - start;
    const msg = err instanceof Error ? err.message : String(err);
    return { status: "FAILED", durationMs, rowCount: 0, error: msg };
  }
}

// ── SQL execution ──────────────────────────────────────────────────────────────

async function executeSqlQuery(
  query: QueryRecord,
  sqlSvc: SqlService,
  connCfg: ConnectionConfig,
  connName: string,
): Promise<{ status: "SUCCEEDED" | "FAILED"; durationMs: number; rowCount: number; error: string }> {
  const start = Date.now();
  let conn: any;
  try {
    conn = await sqlSvc.connect(connCfg, connName);
    const rows = await sqlSvc.query(conn, query.inboundText);
    const durationMs = Date.now() - start;
    return {
      status: "SUCCEEDED",
      durationMs,
      rowCount: rows.length,
      error: "",
    };
  } catch (err) {
    const durationMs = Date.now() - start;
    const msg = err instanceof Error ? err.message : String(err);
    return { status: "FAILED", durationMs, rowCount: 0, error: msg };
  } finally {
    if (conn) {
      try { await sqlSvc.close(conn); } catch { /* ignore */ }
    }
  }
}

// ── Worker pool ────────────────────────────────────────────────────────────────

/**
 * Run all queries exactly once, with `concurrency` workers executing in
 * parallel.  Each worker pulls from a shared queue until it is empty.
 */
async function runQueriesOnce(
  queries: QueryRecord[],
  concurrency: number,
  throttleMs: number,
  execute: (q: QueryRecord) => Promise<{ status: "SUCCEEDED" | "FAILED"; durationMs: number; rowCount: number; error: string }>,
  runId: string,
  taskName: string,
  model: string,
  protocol: string,
  redact: boolean,
  logger: Logger,
): Promise<ResultRecord[]> {
  const results: ResultRecord[] = [];
  const queue = [...queries];

  async function worker(): Promise<void> {
    while (queue.length > 0) {
      // queue.shift() is safe here: Node.js event loop is single-threaded;
      // two workers cannot both observe the same non-empty queue at the
      // same await boundary.
      const q = queue.shift()!;
      const r = await execute(q);
      const record: ResultRecord = {
        runId,
        taskName,
        model,
        queryName: q.queryName,
        atscaleQueryId: q.atscaleQueryId,
        protocol,
        status: r.status,
        durationMs: r.durationMs,
        rowCount: r.rowCount,
        error: r.error,
        timestamp: Date.now(),
        inboundTextAsHash: q.inboundTextAsHash,
        inboundText: q.inboundText,
      };
      results.push(record);
      logger.log(
        `  ${r.status.padEnd(9)} ${q.queryName.padEnd(16)} ${r.durationMs}ms  rows=${r.rowCount}` +
        (r.error ? `  ERROR: ${r.error.slice(0, 100)}` : ""),
      );
      if (throttleMs > 0) await sleep(throttleMs);
    }
  }

  await Promise.all(Array.from({ length: concurrency }, () => worker()));
  return results;
}

/**
 * Run queries in a loop for `durationMs` milliseconds, cycling through the
 * list indefinitely.  Mirrors the Gatling closed injection step behaviour.
 */
async function runQueriesForDuration(
  queries: QueryRecord[],
  concurrency: number,
  throttleMs: number,
  durationMs: number,
  execute: (q: QueryRecord) => Promise<{ status: "SUCCEEDED" | "FAILED"; durationMs: number; rowCount: number; error: string }>,
  runId: string,
  taskName: string,
  model: string,
  protocol: string,
  redact: boolean,
  logger: Logger,
): Promise<ResultRecord[]> {
  const results: ResultRecord[] = [];
  const startTime = Date.now();
  let idx = 0;

  async function worker(): Promise<void> {
    while (Date.now() - startTime < durationMs) {
      const q = queries[idx++ % queries.length];
      const r = await execute(q);
      const record: ResultRecord = {
        runId,
        taskName,
        model,
        queryName: q.queryName,
        atscaleQueryId: q.atscaleQueryId,
        protocol,
        status: r.status,
        durationMs: r.durationMs,
        rowCount: r.rowCount,
        error: r.error,
        timestamp: Date.now(),
        inboundTextAsHash: q.inboundTextAsHash,
        inboundText: q.inboundText,
      };
      results.push(record);
      logger.log(
        `  ${r.status.padEnd(9)} ${q.queryName.padEnd(16)} ${r.durationMs}ms  rows=${r.rowCount}` +
        (r.error ? `  ERROR: ${r.error.slice(0, 100)}` : ""),
      );
      if (throttleMs > 0) await sleep(throttleMs);
    }
  }

  await Promise.all(Array.from({ length: concurrency }, () => worker()));
  return results;
}

// ── Injection step → concurrency/duration ────────────────────────────────────

/**
 * Derive the number of concurrent workers and optional run duration from the
 * first injection step in a task definition.
 *
 * Open steps (AtOnce, Ramp, Constant rate) → run each query once.
 * Closed steps (Constant/Ramp concurrent)  → run for durationMinutes.
 */
function deriveLoadPattern(steps: InjectionStep[] | undefined): {
  concurrency: number;
  durationMs: number;
  warned: string | null;
} {
  if (!steps || steps.length === 0) {
    return { concurrency: 1, durationMs: 0, warned: null };
  }

  const step = steps[0];
  const type = step.type ?? "";

  switch (type) {
    case "AtOnceUsersOpenInjectionStep":
      return { concurrency: step.users ?? 1, durationMs: 0, warned: null };

    case "ConstantUsersPerSecondOpenInjectionStep":
    case "RampUsersOpenInjectionStep":
    case "RampUsersPerSecOpenInjectionStep":
    case "StressPeakUsersOpenInjectionStep":
      return {
        concurrency: step.users ?? step.to ?? 1,
        durationMs: 0,
        warned: null,
      };

    case "NothingForOpenInjectionStep":
      return { concurrency: 1, durationMs: 0, warned: null };

    case "ConstantConcurrentUsersClosedInjectionStep":
      return {
        concurrency: step.users ?? 1,
        durationMs: (step.durationMinutes ?? 1) * 60_000,
        warned: null,
      };

    case "RampConcurrentUsersClosedInjectionStep":
      return {
        concurrency: step.to ?? step.users ?? 1,
        durationMs: (step.durationMinutes ?? 1) * 60_000,
        warned: null,
      };

    case "IncrementConcurrentUsersClosedInjectionStep":
      return {
        concurrency: step.users ?? 1,
        durationMs: (step.durationMinutes ?? 1) * 60_000,
        warned: null,
      };

    default:
      return {
        concurrency: step.users ?? step.to ?? step.from ?? 1,
        durationMs: 0,
        warned: `Unknown injection step type '${type}'; falling back to ${step.users ?? step.to ?? step.from ?? 1} concurrent user(s).`,
      };
  }
}

/**
 * Infer the query protocol from a Gatling simulation class name.
 * Returns "xmla" if the class name contains "Xmla", otherwise "sql".
 */
function inferProtocol(simulationClass: string | undefined): "xmla" | "sql" {
  if (!simulationClass) return "xmla";
  return simulationClass.toLowerCase().includes("xmla") ? "xmla" : "sql";
}

// ── Operation ──────────────────────────────────────────────────────────────────

export class ExecuteAtScaleQueryHarnessOperation extends Operation<Params> {
  name = "execute-atscale-query-harness";
  description =
    "Execute a set of AtScale queries (XMLA or SQL) with configurable concurrency " +
    "and write a timestamped CSV results file";
  parameters = new ExecuteHarnessParameterSet();

  constructor(services: ServiceRegistry, logger: Logger) {
    super(services, logger);
  }

  async run(params: Params): Promise<void> {
    const sqlSvc = this.services.get<SqlService>("sql");
    const isProperties = params["connection-file"].endsWith(".properties");

    const outputDir = path.resolve(params["output-dir"]);
    fs.mkdirSync(outputDir, { recursive: true });

    const redact = params.redact.toLowerCase() === "true";
    const globalRunId = params["run-id"] ?? generateRunId();
    const globalThrottleMs = Math.max(0, parseInt(params["throttle-ms"], 10) || 5);
    const globalConcurrency = Math.max(1, parseInt(params["concurrent-users"], 10) || 1);
    const globalDurationMs = Math.max(0, parseInt(params["duration-minutes"], 10) || 0) * 60_000;
    const globalProtocol = params.protocol.toLowerCase() as "xmla" | "sql";

    // ── Load config ──────────────────────────────────────────────────────────
    let props: Record<string, string> = {};
    let yamlConfig: Record<string, any> = {};

    if (isProperties) {
      const raw = fs.readFileSync(path.resolve(params["connection-file"]), "utf8");
      props = parsePropertiesFile(raw);
    } else {
      const raw = fs.readFileSync(path.resolve(params["connection-file"]), "utf8");
      yamlConfig = parseYaml(raw) as Record<string, any>;
    }

    // ── Determine task list ──────────────────────────────────────────────────
    let tasks: Array<{
      taskDef: TaskDefinition;
      queries: QueryRecord[];
      protocol: "xmla" | "sql";
      concurrency: number;
      durationMs: number;
      runId: string;
    }> = [];

    if (params["task-file"]) {
      // ── Task-file mode: all tasks in the file run sequentially ────────────
      const taskFileRaw = fs.readFileSync(path.resolve(params["task-file"]), "utf8");
      const taskDefs: TaskDefinition[] = params["task-file"].endsWith(".json")
        ? JSON.parse(taskFileRaw)
        : parseYaml(taskFileRaw);

      for (const taskDef of taskDefs) {
        const taskProtocol = inferProtocol(taskDef.simulationClass);
        const { concurrency, durationMs, warned } = deriveLoadPattern(taskDef.injectionSteps);
        if (warned) this.logger.log(`WARN: ${warned}`);

        let queries: QueryRecord[];
        if (taskDef.ingestionFileName) {
          const csvPath = path.resolve("ingest", taskDef.ingestionFileName);
          if (!fs.existsSync(csvPath)) {
            this.logger.log(
              `WARN: ingest file not found for task '${taskDef.taskName}': ${csvPath} — skipping`,
            );
            continue;
          }
          queries = loadQueriesFromCsv(csvPath, taskDef.ingestionFileHasHeader ?? true);
        } else {
          // Fall back to the JSON file from extract-queries-from-atscale
          const jsonPath = path.resolve(
            "queries",
            `${taskDef.model.replace(/[^a-zA-Z0-9_-]/g, "_")}_${taskProtocol}_queries.json`,
          );
          if (!fs.existsSync(jsonPath)) {
            this.logger.log(
              `WARN: query JSON not found for task '${taskDef.taskName}': ${jsonPath} — skipping`,
            );
            continue;
          }
          queries = loadQueriesFromJson(jsonPath);
        }

        tasks.push({
          taskDef,
          queries,
          protocol: taskProtocol,
          concurrency,
          durationMs,
          runId: taskDef.runId ?? globalRunId,
        });
      }
    } else {
      // ── Direct mode: single task from CLI params ──────────────────────────
      let queries: QueryRecord[];

      if (params["ingest-file"]) {
        queries = loadQueriesFromCsv(params["ingest-file"], true);
      } else if (params["query-file"]) {
        queries = loadQueriesFromJson(params["query-file"]);
      } else {
        throw new Error(
          "Provide one of --ingest-file, --query-file, or --task-file",
        );
      }

      tasks.push({
        taskDef: {
          taskName: params["connection-name"],
          model: params["connection-name"],
        },
        queries,
        protocol: globalProtocol,
        concurrency: globalConcurrency,
        durationMs: globalDurationMs,
        runId: globalRunId,
      });
    }

    if (tasks.length === 0) {
      throw new Error("No tasks to execute. Check your --task-file or query/ingest files.");
    }

    // ── Execute each task ────────────────────────────────────────────────────
    for (const task of tasks) {
      const { taskDef, queries, protocol, concurrency, durationMs, runId } = task;
      const model = taskDef.model ?? params["connection-name"];

      this.logger.info(
        `\nTask: '${taskDef.taskName}'  model=${model}  protocol=${protocol}  ` +
        `workers=${concurrency}  queries=${queries.length}  run-id=${runId}`,
      );

      // Build the executor for this protocol / config mode
      let execute: (q: QueryRecord) => Promise<{
        status: "SUCCEEDED" | "FAILED";
        durationMs: number;
        rowCount: number;
        error: string;
      }>;

      if (protocol === "xmla") {
        const cfg = isProperties
          ? xmlaConfigFromProperties(props, model)
          : xmlaConfigFromYaml(yamlConfig, params["connection-name"], model);

        this.logger.info(`  XMLA URL: ${cfg.url}`);
        const token = cfg.isContainer
          ? ""
          : await getBearerToken(cfg.authUrl!, cfg.authUsername!, cfg.authPassword!, false);

        execute = (q) => executeXmlaQuery(q, cfg, token);
      } else {
        const { connectionConfig, connectionName } = isProperties
          ? sqlConfigFromProperties(props, model)
          : {
              connectionConfig: yamlConfig as ConnectionConfig,
              connectionName: params["connection-name"],
            };

        execute = (q) => executeSqlQuery(q, sqlSvc, connectionConfig, connectionName);
      }

      // Run the queries
      let results: ResultRecord[];
      if (durationMs > 0) {
        this.logger.info(
          `  Running for ${durationMs / 60_000} minute(s) with ${concurrency} worker(s)…`,
        );
        results = await runQueriesForDuration(
          queries, concurrency, globalThrottleMs, durationMs,
          execute, runId, taskDef.taskName, model, protocol, redact, this.logger,
        );
      } else {
        this.logger.info(
          `  Running ${queries.length} query/queries with ${concurrency} worker(s)…`,
        );
        results = await runQueriesOnce(
          queries, concurrency, globalThrottleMs,
          execute, runId, taskDef.taskName, model, protocol, redact, this.logger,
        );
      }

      // Write CSV
      const safeName = (taskDef.runLogFileName
        ? taskDef.runLogFileName.replace(/\.log$/, "")
        : `${runId}_${model.replace(/[^a-zA-Z0-9_-]/g, "_")}`
      );
      const outFile = path.join(outputDir, `${safeName}.csv`);
      fs.writeFileSync(outFile, toCsv(results, redact), "utf8");

      const succeeded = results.filter((r) => r.status === "SUCCEEDED").length;
      const failed = results.filter((r) => r.status === "FAILED").length;
      const avgMs = results.length
        ? Math.round(results.reduce((s, r) => s + r.durationMs, 0) / results.length)
        : 0;

      this.logger.info(
        `  Done — ${succeeded} SUCCEEDED  ${failed} FAILED  avg=${avgMs}ms  → ${outFile}`,
      );
    }

    this.logger.info("\nexecute-atscale-query-harness complete.");
  }
}
