/**
 * GenerateDDLFromAtScale
 *
 * Generates DDL (CREATE TABLE statements) by reading table metadata from an
 * AtScale data source via the public REST API.
 *
 * Discovery flow:
 *   1. GET /wapi/p/data-warehouses  → find connectionId from the data-source-name
 *   2. GET /v1/data-sources/conn/{connectionId}/databases/{database}/schemas/{schema}/tables
 *        → enumerate tables (applying --tables filter if provided)
 *   3. GET /v1/data-sources/conn/{connectionId}/databases/{database}/schemas/{schema}/tables/{table}/info
 *        → column metadata for each table
 *
 * Foreign keys:
 *   The AtScale data-source metadata API exposes column-level information only.
 *   FK relationships are not available via this API; the output will contain a
 *   header comment noting the omission.
 */
import fs from "fs";
import path from "path";
import { Operation } from "../Operation.js";
import { ParameterSet, StringParameter, BooleanParameter } from "../../Parameters.js";
import type { ServiceRegistry } from "../../services/registry.js";
import type { Logger } from "../../logging.js";
import { YamlService } from "../../services/YamlService.js";
import {
  AtScaleRestClientService,
  AtScaleEnvironment,
  type GetTableInfoArgs,
  type ListTablesArgs,
  type ColumnInfo,
} from "../../services/AtScaleRestClientService.js";

// ── Parameters ────────────────────────────────────────────────────────────────

class GenerateDDLFromAtScaleParamsSet extends ParameterSet {
  parameters = [
    new (class extends StringParameter {
      name         = "connection-file";
      description  = "Path to the connections YAML file";
      required     = false;
      defaultValue = "connections.yaml";
    })(),
    new (class extends StringParameter {
      name        = "atscale-connection-name";
      description = "Name of the AtScale connection entry in the connections file (must have an atscale: block)";
      required    = true;
    })(),
    new (class extends StringParameter {
      name        = "data-source-name";
      description = "Name of the data source as registered in AtScale (used to resolve the connection ID)";
      required    = true;
    })(),
    new (class extends StringParameter {
      name        = "database";
      description = "Database (catalog) name to read tables from";
      required    = true;
    })(),
    new (class extends StringParameter {
      name        = "schema";
      description = "Schema name to read tables from";
      required    = true;
    })(),
    new (class extends StringParameter {
      name        = "tables";
      description = 'Comma-separated table names or wildcard patterns to include (e.g. "Dim*,FactSales"). Omit to extract all tables.';
      required    = false;
    })(),
    new (class extends StringParameter {
      name        = "output-file";
      description = "Output file path for the generated DDL. Omit to print to stdout.";
      required    = false;
    })(),
    new (class extends BooleanParameter {
      name         = "insecure";
      description  = "Skip TLS certificate verification (overrides the connections file value). Defaults to true.";
      required     = false;
    })(),
  ];
}

type Params = {
  "connection-file":        string;
  "atscale-connection-name": string;
  "data-source-name":       string;
  database:                 string;
  schema:                   string;
  tables?:                  string;
  "output-file"?:           string;
  insecure?:                boolean;
};
export type GenerateDDLFromAtScaleParams = Params;

// ── Helpers ───────────────────────────────────────────────────────────────────

function resolveAtScaleEnv(
  config: Record<string, any>,
  connectionName: string,
  insecureOverride?: boolean,
  opts: { authType?: "keycloak" | "basic"; useRawApiToken?: boolean; cookieAuth?: boolean } = {},
): AtScaleEnvironment {
  const connections: Record<string, any> = config.connections ?? {};
  const entry = connections[connectionName];
  if (!entry) {
    throw new Error(`Connection '${connectionName}' not found in connections file`);
  }
  const atscale = entry.atscale;
  if (!atscale) {
    throw new Error(`Connection '${connectionName}' is missing an 'atscale:' block`);
  }
  const url = atscale.url;
  if (!url) {
    throw new Error(`Connection '${connectionName}'.atscale is missing 'url'`);
  }

  let username: string | undefined = atscale.username;
  let password: string | undefined = atscale.password;
  if (atscale.user) {
    const users: Record<string, any> = config.users ?? {};
    const userEntry = users[atscale.user];
    if (userEntry) {
      username ??= userEntry.username;
      password ??= userEntry.password;
    }
  }

  if (!atscale.apiToken) {
    if (!username) {
      throw new Error(
        `Connection '${connectionName}'.atscale is missing 'username' (or a 'user' key referencing the users block). ` +
        "Alternatively, set 'apiToken' to use a Design Center API token instead.",
      );
    }
    if (!password) {
      throw new Error(
        `Connection '${connectionName}'.atscale is missing 'password'. ` +
        "Alternatively, set 'apiToken' to use a Design Center API token instead.",
      );
    }
  }

  return new AtScaleEnvironment({
    baseUrl:        url,
    username,
    password,
    realm:          atscale.realm,
    clientId:       atscale.clientId,
    clientSecret:   atscale.clientSecret,
    authType:       opts.authType ?? atscale.authType,
    apiToken:       atscale.apiToken,
    sessionCookie:  atscale.sessionCookie,
    insecure:       insecureOverride ?? atscale.insecure,
    useRawApiToken: opts.useRawApiToken,
    cookieAuth:     opts.cookieAuth,
  });
}

/** Convert a glob-style pattern (* and ?) to a case-insensitive RegExp. */
function globToRegex(pattern: string): RegExp {
  const escaped = pattern
    .replace(/[.+^${}()|[\]\\]/g, "\\$&")
    .replace(/\*/g, ".*")
    .replace(/\?/g, ".");
  return new RegExp(`^${escaped}$`, "i");
}

function matchesFilter(name: string, patterns: string[]): boolean {
  return patterns.some((p) => globToRegex(p.trim()).test(name));
}

// ── DDL generation ─────────────────────────────────────────────────────────────

function buildColumnDef(col: ColumnInfo): string {
  const dataType = col.dataType ?? "VARCHAR";
  const nullable = col.nullable === false ? " NOT NULL" : "";
  const pk       = col.primaryKey ? " -- PK" : "";
  return `    ${col.name.padEnd(40)} ${dataType}${nullable}${pk}`;
}

function buildCreateTable(schema: string, tableName: string, cols: ColumnInfo[]): string {
  const pkCols = cols.filter((c) => c.primaryKey).map((c) => c.name);
  const lines  = cols.map(buildColumnDef);

  if (pkCols.length > 0) {
    lines.push(`    CONSTRAINT pk_${tableName.toLowerCase()} PRIMARY KEY (${pkCols.join(", ")})`);
  }

  return `CREATE TABLE ${schema}.${tableName} (\n${lines.join(",\n")}\n);`;
}

// ── Operation ──────────────────────────────────────────────────────────────────

export class GenerateDDLFromAtScaleOperation extends Operation<Params> {
  name        = "generate-ddl-from-atscale";
  description = "Generate DDL from an AtScale data source by reading table metadata via the REST API";
  parameters  = new GenerateDDLFromAtScaleParamsSet();

  constructor(services: ServiceRegistry, logger: Logger) {
    super(services, logger);
  }

  async run(params: Params): Promise<void> {
    const yaml       = this.services.get<YamlService>("yaml");
    const atScaleSvc = this.services.get<AtScaleRestClientService>("atscale-rest");

    const config = yaml.readFromFile<Record<string, any>>(params["connection-file"]);
    const env    = resolveAtScaleEnv(config, params["atscale-connection-name"], params["insecure"]);

    // The /wapi/p/data-sources/... metadata endpoints use the Design Center
    // auth_session cookie — the same mechanism as atscale-deploy-catalog.
    // Build a cookie-auth environment for those calls; the standard env (JWT)
    // is used only for listDataSources to resolve the connectionId.
    const cookieEnv = resolveAtScaleEnv(
      config, params["atscale-connection-name"], params["insecure"], { cookieAuth: true },
    );

    // ── 1. Resolve connectionId from the data source name ──────────────────────
    this.logger.verbose(`[GenerateDDLFromAtScale] Looking up data source '${params["data-source-name"]}'`);
    const dataSources = await atScaleSvc.listDataSources(env);
    const dataSource  = dataSources.find(
      (ds) => ds.name.toLowerCase() === params["data-source-name"].toLowerCase() ||
              ds.connectionId.toLowerCase() === params["data-source-name"].toLowerCase(),
    );
    if (!dataSource) {
      const names = dataSources.map((ds) => `'${ds.name}' (connectionId: ${ds.connectionId})`).join(", ");
      throw new Error(
        `Data source '${params["data-source-name"]}' not found in AtScale. ` +
        `Available: ${names || "(none)"}`,
      );
    }
    const connectionId = dataSource.connectionId;
    this.logger.verbose(`[GenerateDDLFromAtScale] Resolved connectionId: ${connectionId}`);

    const { database, schema } = params;

    // ── 2. List tables ─────────────────────────────────────────────────────────
    const filterPatterns = params.tables
      ? params.tables.split(",").map((p) => p.trim()).filter(Boolean)
      : [];

    this.logger.verbose(`[GenerateDDLFromAtScale] Listing tables in ${database}.${schema}`);
    const listArgs: ListTablesArgs = { connectionId, database, schema };
    const tableEntries = await atScaleSvc.listTables(cookieEnv, listArgs);

    const allTableNames: string[] = tableEntries
      .map((t) => t.name ?? (t as any).tableName ?? String(t))
      .filter(Boolean);

    const tableNames = filterPatterns.length > 0
      ? allTableNames.filter((name) => matchesFilter(name, filterPatterns))
      : allTableNames;

    if (tableNames.length === 0) {
      this.logger.log("[GenerateDDLFromAtScale] No tables matched — nothing to extract.");
      return;
    }

    this.logger.log(`[GenerateDDLFromAtScale] Generating DDL for ${tableNames.length} table(s)…`);

    // ── 3. Fetch table info and build DDL ──────────────────────────────────────
    const blocks: string[] = [];

    for (const tableName of tableNames) {
      const infoArgs: GetTableInfoArgs = { connectionId, database, schema, table: tableName };
      const info = await atScaleSvc.getTableInfo(cookieEnv, infoArgs);

      const cols: ColumnInfo[] = info.columns ?? [];
      if (cols.length === 0) {
        this.logger.log(`  ⚠  ${tableName}: no column metadata returned — skipped`);
        continue;
      }

      const pkCount = cols.filter((c) => c.primaryKey).length;
      blocks.push(buildCreateTable(schema, tableName, cols));
      this.logger.log(`  → ${tableName} (${cols.length} column(s), ${pkCount} PK col(s))`);
    }

    if (blocks.length === 0) {
      this.logger.log("[GenerateDDLFromAtScale] No DDL generated.");
      return;
    }

    // ── 4. Assemble output ─────────────────────────────────────────────────────
    const header = [
      `-- Generated from AtScale data source: ${params["data-source-name"]} (connectionId: ${connectionId})`,
      `-- Database: ${database}  Schema: ${schema}`,
      `-- Generated at: ${new Date().toISOString()}`,
      `-- Note: Foreign key constraints are not available via the AtScale metadata API`,
      `--       and are therefore not included in this DDL.`,
      `--       Use extract-ddl-from-connection for FK support via direct database access.`,
      "",
    ].join("\n");

    const ddl = header + blocks.join("\n\n") + "\n";

    if (params["output-file"]) {
      const outputPath = path.resolve(params["output-file"]);
      fs.mkdirSync(path.dirname(outputPath), { recursive: true });
      fs.writeFileSync(outputPath, ddl, "utf8");
      this.logger.log(`\n[GenerateDDLFromAtScale] Wrote ${blocks.length} table(s) to: ${outputPath}`);
    } else {
      process.stdout.write(ddl);
    }
  }
}
