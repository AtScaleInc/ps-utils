/**
 * execute-query-on-connection
 *
 * Loads one or more named queries from a query file (JSON produced by
 * extract-queries-from-atscale, or a CSV ingest file in Gatling format),
 * executes them against a named connection, and writes the results to output
 * file(s).
 *
 * --query-name supports shell-style wildcards:
 *   *   matches any sequence of characters
 *   ?   matches exactly one character
 *
 * When the pattern matches exactly one query the result is written to
 * --output-file directly.  When it matches multiple queries each result is
 * written to a separate file derived from --output-file:
 *   {dirname(output-file)}/{sanitized_query_name}{extname(output-file)}
 *
 * SQL:  results written as CSV (column headers + data rows)
 * XMLA: raw SOAP response body written as-is (XML)
 *
 * Connection file formats accepted:
 *   connections.yaml     — standard project connections file
 *   systems.properties   — legacy Gatling project config
 *
 * Query file formats accepted:
 *   *.json               — JSON array of QueryRecord (extract-queries-from-atscale output)
 *   *.csv                — Gatling ingest CSV  (sampler_name,sql_text  or
 *                          sampler_name,atscale_query_id,sql_text); header row assumed
 */
import { Operation } from "../Operation.js";
import { ParameterSet, StringParameter } from "../../Parameters.js";
import type { ServiceRegistry } from "../../services/registry.js";
import type { Logger } from "../../logging.js";
import { SqlService, type ConnectionConfig } from "../../services/SqlService.js";
import {
  parsePropertiesFile,
  parseJdbcPostgresUrl,
  type QueryRecord,
} from "../extract-queries-from-atscale/ExtractQueriesFromAtScaleOperation.js";
import axios from "axios";
import { createHash } from "crypto";
import fs from "fs";
import path from "path";
import { parse as parseYaml } from "yaml";

// ── Parameter set ──────────────────────────────────────────────────────────────

class ExecuteQueryOnConnectionParamsSet extends ParameterSet {
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
        "JSON file produced by extract-queries-from-atscale, or a CSV ingest file " +
        "(sampler_name,sql_text or sampler_name,atscale_query_id,sql_text)";
      required = true;
    })(),
    new (class extends StringParameter {
      name = "protocol";
      description = "Query protocol: xmla or sql (default: xmla)";
      required = false;
      defaultValue = "xmla";
    })(),
    new (class extends StringParameter {
      name = "query-name";
      description =
        "Name of the query (or queries) to execute. Supports shell-style wildcards: " +
        "* matches any sequence of characters, ? matches exactly one character. " +
        "When multiple queries match, each result is written to a separate file " +
        "derived from --output-file: {dir}/{query_name}{ext}.";
      required = true;
    })(),
    new (class extends StringParameter {
      name = "output-file";
      description =
        "Path to write query results. SQL results are written as CSV; " +
        "XMLA results are written as raw XML.";
      required = true;
    })(),
  ];
}

type Params = {
  "connection-file": string;
  "connection-name": string;
  "query-file": string;
  protocol: string;
  "query-name": string;
  "output-file": string;
};
export type ExecuteQueryOnConnectionParams = Params;

// ── Query file loading ─────────────────────────────────────────────────────────

function sha256hex(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

/**
 * Parse an RFC-4180 CSV string into rows.
 * Handles double-quoted fields with embedded commas, newlines, and escaped quotes.
 */
function parseCsvRows(content: string): string[][] {
  const rows: string[][] = [];
  let i = 0;
  const n = content.length;

  while (i < n) {
    const row: string[] = [];

    while (i < n && content[i] !== "\n" && content[i] !== "\r") {
      if (content[i] === '"') {
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
        let field = "";
        while (i < n && content[i] !== "," && content[i] !== "\n" && content[i] !== "\r") {
          field += content[i++];
        }
        row.push(field.trim());
      }

      if (i < n && content[i] === ",") {
        i++;
      } else {
        break;
      }
    }

    if (i < n && content[i] === "\r") i++;
    if (i < n && content[i] === "\n") i++;

    if (row.length > 0 && !(row.length === 1 && row[0] === "")) {
      rows.push(row);
    }
  }

  return rows;
}

/** Load queries from a Gatling ingest CSV (header row assumed). */
function loadQueriesFromCsv(filePath: string): QueryRecord[] {
  const content = fs.readFileSync(path.resolve(filePath), "utf8");
  const rows = parseCsvRows(content).slice(1); // drop header

  return rows
    .filter((row) => row.length >= 2)
    .map((row): QueryRecord => {
      const queryName = row[0];
      const isTwoColumn = row.length === 2;
      const atscaleQueryId = isTwoColumn ? "" : row[1];
      const originalText = isTwoColumn ? row[1] : row[2];
      return {
        queryName,
        queryLanguage: "",
        originalText,
        originalTextHash: sha256hex(originalText),
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

/** Load queries from a file, dispatching on extension. */
function loadQueries(filePath: string): QueryRecord[] {
  return filePath.toLowerCase().endsWith(".json")
    ? loadQueriesFromJson(filePath)
    : loadQueriesFromCsv(filePath);
}

// ── XMLA helpers ───────────────────────────────────────────────────────────────

interface XmlaConfig {
  url: string;
  cube: string;
  catalog: string;
  authUrl?: string;
  authUsername?: string;
  authPassword?: string;
  isContainer: boolean;
  useAggregates: boolean;
  generateAggregates: boolean;
  useQueryCache: boolean;
  useAggregateCache: boolean;
}

function escapeXml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

function buildSoapEnvelope(mdxQuery: string, cfg: XmlaConfig): string {
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

async function getBearerToken(
  authUrl: string,
  username: string,
  password: string,
  proxyConfig: Record<string, any>
): Promise<string> {
  try {
    const config: Record<string, any> = {
      auth: { username, password },
    }
    if (Object.keys(proxyConfig).length != 0) {
      config.proxy = proxyConfig
    }
    const response = await axios.get(authUrl, config);
    return String(response.data).trim();
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new Error(`Failed to obtain bearer token from ${authUrl}: ${msg}`);
  }
}

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

function xmlaConfigFromProperties(
  props: Record<string, string>,
  model: string,
): XmlaConfig {
  const key = (k: string) => props[`atscale.${model}.xmla.${k}`] ?? "";
  const url = key("url");
  if (!url) {
    throw new Error(`systems.properties is missing atscale.${model}.xmla.url`);
  }
  return {
    url,
    cube: key("cube") || model,
    catalog: key("catalog"),
    authUrl: key("auth.url") || undefined,
    authUsername: key("auth.username") || undefined,
    authPassword: key("auth.password") || undefined,
    isContainer: url.toLowerCase().includes("/engine/xmla"),
    useAggregates: (props["atscale.xmla.useAggregates"] ?? "true") === "true",
    generateAggregates: (props["atscale.xmla.generateAggregates"] ?? "false") === "true",
    useQueryCache: (props["atscale.xmla.useQueryCache"] ?? "false") === "true",
    useAggregateCache: (props["atscale.xmla.useAggregateCache"] ?? "true") === "true",
  };
}

// ── SQL config helpers ─────────────────────────────────────────────────────────

interface SqlConfig {
  connectionConfig: ConnectionConfig;
  connectionName: string;
}

function sqlConfigFromYaml(
  connectionFile: Record<string, any>,
  connectionName: string,
): SqlConfig {
  const connection = connectionFile.connections?.[connectionName];
  if (!connection) {
    throw new Error(`Connection '${connectionName}' not found in connections.yaml`);
  }
  if (!connection.sql) {
    throw new Error(
      `Connection '${connectionName}' is missing a sql: block required for SQL query execution.`,
    );
  }
  return { connectionConfig: connectionFile as ConnectionConfig, connectionName };
}

function sqlConfigFromProperties(
  props: Record<string, string>,
  model: string,
): SqlConfig {
  const key = (k: string) => props[`atscale.${model}.jdbc.${k}`] ?? "";
  const url = key("url");
  const username = key("username");
  const password = key("password");
  if (!url) throw new Error(`systems.properties is missing atscale.${model}.jdbc.url`);
  if (!username) throw new Error(`systems.properties is missing atscale.${model}.jdbc.username`);
  if (!password) throw new Error(`systems.properties is missing atscale.${model}.jdbc.password`);

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

// ── Wildcard matching ──────────────────────────────────────────────────────────

/**
 * Returns true when `text` matches the shell-style `pattern`.
 * Supported metacharacters:
 *   *  — matches any sequence of characters (including empty)
 *   ?  — matches exactly one character
 * All other characters match literally (case-sensitive).
 */
function wildcardMatch(pattern: string, text: string): boolean {
  // Escape all regex special chars except * and ?, then convert them.
  const regexSource = pattern
    .replace(/[.+^${}()|[\]\\]/g, "\\$&")
    .replace(/\*/g, ".*")
    .replace(/\?/g, ".");
  return new RegExp(`^${regexSource}$`).test(text);
}

/**
 * Derive an output file path for one query when multiple queries matched.
 * Uses the directory and extension of the template path, inserting the
 * sanitized query name as the basename.
 *
 * Sanitization: characters that are not alphanumeric, hyphen, or underscore
 * are replaced with underscores; runs of underscores are collapsed to one.
 */
function deriveOutputFile(templatePath: string, queryName: string): string {
  const dir = path.dirname(templatePath);
  const ext = path.extname(templatePath);
  const safe = queryName
    .replace(/[^A-Za-z0-9_-]/g, "_")
    .replace(/_+/g, "_")
    .replace(/^_|_$/g, "");
  return path.join(dir, `${safe}${ext}`);
}

// ── CSV output helpers ─────────────────────────────────────────────────────────

function csvField(value: unknown): string {
  const s = value == null ? "" : String(value);
  if (s.includes(",") || s.includes('"') || s.includes("\n")) {
    return `"${s.replace(/"/g, '""')}"`;
  }
  return s;
}

function rowsToCsv(rows: Record<string, unknown>[]): string {
  if (rows.length === 0) return "";
  const cols = Object.keys(rows[0]);
  const header = cols.map(csvField).join(",");
  const body = rows.map((row) => cols.map((c) => csvField(row[c])).join(","));
  return [header, ...body].join("\n") + "\n";
}

// ── Operation ──────────────────────────────────────────────────────────────────

export class ExecuteQueryOnConnectionOperation extends Operation<Params> {
  name = "execute-query-on-connection";
  description =
    "Execute one or more named queries (wildcard-matched) against a connection " +
    "and write the results to file(s)";
  parameters = new ExecuteQueryOnConnectionParamsSet();

  constructor(services: ServiceRegistry, logger: Logger) {
    super(services, logger);
  }

  async run(params: Params): Promise<void> {
    const sqlSvc = this.services.get<SqlService>("sql");
    const isProperties = params["connection-file"].endsWith(".properties");
    const protocol = params.protocol.toLowerCase() as "xmla" | "sql";
    const model = params["connection-name"];
    const pattern = params["query-name"];
    const outTemplate = path.resolve(params["output-file"]);

    // ── Load connection config ────────────────────────────────────────────────
    let props: Record<string, string> = {};
    let yamlConfig: Record<string, any> = {};

    if (isProperties) {
      props = parsePropertiesFile(
        fs.readFileSync(path.resolve(params["connection-file"]), "utf8"),
      );
    } else {
      yamlConfig = parseYaml(
        fs.readFileSync(path.resolve(params["connection-file"]), "utf8"),
      ) as Record<string, any>;
    }

    const proxyConfig: Record<string, any> = {};
    if (yamlConfig.proxy && yamlConfig.proxy.host) {
      proxyConfig.host = yamlConfig.proxy.host;
      if (yamlConfig.proxy.password) {
        proxyConfig.port = yamlConfig.proxy.port;
      }
      else {
        throw new Error(
          `Connection '${params["connection-name"]}' contains a proxy host but is missing the required port`,
        );
      }
      if (yamlConfig.proxy.protocol) {
        proxyConfig.protocol = yamlConfig.proxy.protocol;
      }
      if (yamlConfig.proxy.username) {
        proxyConfig.auth = {};
        proxyConfig.auth.username = yamlConfig.proxy.username;
        if (yamlConfig.proxy.password) {
          proxyConfig.password = yamlConfig.proxy.password;
        }
      }
    }
    // ── Select matching queries ───────────────────────────────────────────────
    const allQueries = loadQueries(params["query-file"]);
    const matched = allQueries.filter((q) => wildcardMatch(pattern, q.queryName));

    if (matched.length === 0) {
      const available = allQueries.map((q) => `  ${q.queryName}`).join("\n");
      throw new Error(
        `No queries matched '${pattern}' in ${params["query-file"]}.\n` +
        `Available queries:\n${available}`,
      );
    }

    this.logger.info(
      `Matched ${matched.length} query/queries for pattern '${pattern}' ` +
      `— executing via ${protocol} on '${model}'…`,
    );

    // Resolve output path for one query: use the template directly when there
    // is only a single match, otherwise derive per-query filenames.
    const resolveOut = (q: QueryRecord): string =>
      matched.length === 1
        ? outTemplate
        : deriveOutputFile(outTemplate, q.queryName);

    // Ensure output directory exists for all resolved paths.
    for (const q of matched) {
      fs.mkdirSync(path.dirname(resolveOut(q)), { recursive: true });
    }

    // ── Execute ──────────────────────────────────────────────────────────────
    if (protocol === "xmla") {
      const cfg = isProperties
        ? xmlaConfigFromProperties(props, model)
        : xmlaConfigFromYaml(yamlConfig, model, model);

      this.logger.info(`  XMLA URL: ${cfg.url}`);

      // Authenticate once and reuse the token for all queries in the batch.
      const token = cfg.isContainer
        ? ""
        : await getBearerToken(cfg.authUrl!, cfg.authUsername!, cfg.authPassword!, proxyConfig);

      const headers: Record<string, string> = {
        "Content-Type": "text/xml; charset=UTF-8",
        Accept: "text/xml",
      };
      if (!cfg.isContainer && token) {
        headers["Authorization"] = `Bearer ${token}`;
      }

      for (const query of matched) {
        const outFile = resolveOut(query);
        const envelope = buildSoapEnvelope(query.originalText, cfg);

        const config: Record<string, any> = {
          headers,
          validateStatus: null, // capture all HTTP statuses
        }
        if (Object.keys(proxyConfig).length != 0) {
          config.proxy = proxyConfig
        }

        const start = Date.now();
        const response = await axios.post(cfg.url, envelope, config);
        const durationMs = Date.now() - start;

        const responseBody: string = typeof response.data === "string"
          ? response.data
          : JSON.stringify(response.data);

        if (response.status !== 200) {
          throw new Error(
            `XMLA request failed for '${query.queryName}' with HTTP ${response.status}: ` +
            responseBody.slice(0, 400),
          );
        }

        fs.writeFileSync(outFile, responseBody, "utf8");

        let valueCount = 0;
        const cellDataMatch = responseBody.match(
          /<[A-Za-z0-9_]*:?CellData[^>]*>([\s\S]*?)<\/[A-Za-z0-9_]*:?CellData>/i,
        );
        if (cellDataMatch) {
          valueCount = (cellDataMatch[1].match(/<[A-Za-z0-9_]*:?Value[\s>\/]/gi) ?? []).length;
        }

        this.logger.info(
          `  ${query.queryName}  ${durationMs}ms  values=${valueCount}  → ${outFile}`,
        );
      }
    } else {
      // SQL — open one connection and reuse it for all matched queries.
      const { connectionConfig, connectionName } = isProperties
        ? sqlConfigFromProperties(props, model)
        : sqlConfigFromYaml(yamlConfig, model);

      const conn = await sqlSvc.connect(connectionConfig, connectionName);
      try {
        for (const query of matched) {
          const outFile = resolveOut(query);

          const start = Date.now();
          const rows = await sqlSvc.query(conn, query.originalText);
          const durationMs = Date.now() - start;

          fs.writeFileSync(outFile, rowsToCsv(rows as Record<string, unknown>[]), "utf8");

          this.logger.info(
            `  ${query.queryName}  ${durationMs}ms  rows=${rows.length}  → ${outFile}`,
          );
        }
      } finally {
        await sqlSvc.close(conn);
      }
    }
  }
}
