/**
 * AtScale REST client service.
 *
 * Implements concrete RestEnvironment and RestRequest subclasses for the
 * primary provisioning operations against the AtScale public/internal API:
 *
 *   1. Connect a git repository  — POST /wapi/p/repo
 *   2. List repositories         — GET  /wapi/p/repo
 *   3. Create a data source      — POST /wapi/p/data-warehouses/{dialect}
 *   4. List data sources         — GET  /wapi/p/data-warehouses
 *   5. Deploy a model (catalog)  — POST /wapi/p/catalogs
 *   5b. Deploy SML to git repo  — POST /wapi/git/deploy/catalog
 *   6. Validate model            — POST /wapi/p/catalog/validate-model
 *   7. List deployments          — GET  /wapi/p/projects/deployed
 *
 * Authentication: set `apiToken` in the connections file to a Design Center
 * API token (profile icon → API Token → Generate). The token is automatically
 * exchanged for a short-lived JWT via POST /v1/token on each auth cycle.
 * The JWT is cached and refreshed on 401.
 *
 * Usage:
 *
 *   const env = new AtScaleEnvironment({
 *     baseUrl:  "https://atscale.example.com",
 *     username: "admin",
 *     password: "secret",
 *   });
 *
 *   const svc = registry.get<AtScaleRestClientService>("atscale-rest");
 *
 *   const repo = await svc.connectGitRepo(env, {
 *     name: "my-sml-repo",
 *     url:  "https://github.com/myorg/sml.git",
 *   });
 *
 *   const dw = await svc.createDataSource(env, {
 *     config:         yaml.readFromFile("connections.yaml"),
 *     connectionName: "snow_prod",
 *     name:           "Production Snowflake",
 *     connectionId:   "snow_prod",
 *     aggregateSchema: "ATSCALE_AGGS",
 *     access: { users: [{ userName: "atscale-admin" }], groups: [] },
 *   });
 *
 *   await svc.deployModel(env, {
 *     catalogXml:   xml,
 *     repositoryId: repo.id,
 *   });
 */
import https from "https";
import { readFileSync } from "node:fs";
import axios from "axios";
import { ServiceProvider } from "./ServiceProvider.js";
import { RestClientService, KeycloakEnvironment, RestRequest, type RestAuth } from "./RestClientService.js";
import type { ConnectionConfig } from "./SqlService.js";

// ── AtScale environment ────────────────────────────────────────────────────────

export type AtScaleEnvironmentConfig = {
  /** Root URL of the AtScale instance, no trailing slash. */
  baseUrl: string;
  /** Required unless `apiToken` is set. */
  username?: string;
  /** Required unless `apiToken` is set. */
  password?: string;
  /** Keycloak realm. Defaults to "atscale". */
  realm?: string;
  /** Keycloak client_id. Defaults to "atscale-ai-link". */
  clientId?: string;
  /**
   * Keycloak client_secret. Required when the client is configured as confidential
   * (e.g. atscale-modeler). Find it in Keycloak → Clients → <client> → Credentials.
   */
  clientSecret?: string;
  /**
   * Static API token generated in the AtScale Design Center UI.
   * Profile icon (top-right) → API Token → Generate.
   *
   * When set, the token is automatically exchanged for a short-lived JWT via
   * `POST /v1/token` (per the AtScale Container API docs). The resulting JWT
   * is used as a Bearer token for all subsequent requests and is cached until
   * a 401 triggers a refresh. All Keycloak OIDC fields are ignored when this
   * is set.
   *
   * This is the recommended authentication approach.
   */
  apiToken?: string;
  /**
   * Authentication type.
   * - `"keycloak"` (default) — OIDC Resource Owner Password Credentials grant via Keycloak.
   * - `"basic"` — HTTP Basic auth (username:password). Use when the AtScale instance
   *   does not accept Keycloak JWT Bearer tokens (e.g. some installer-mode deployments).
   */
  authType?: "keycloak" | "basic";
  /**
   * Session cookie for the AtScale Design Center (`/wapi/git/` endpoints).
   * When omitted, the session cookie is acquired automatically by completing
   * the Keycloak authorization-code flow using `username` and `password`.
   *
   * Manual override: log in to the Design Center, copy the `auth_session`
   * cookie value from DevTools → Application → Cookies, and paste it here.
   * Useful for debugging when automatic acquisition fails.
   */
  sessionCookie?: string;
  /**
   * Disable TLS certificate verification. Defaults to `true` — AtScale
   * instances commonly use self-signed certificates. Set `insecure: false`
   * in the `atscale:` block of the connections file to enforce strict
   * certificate validation.
   */
  insecure?: boolean;
  /**
   * @internal — When true, `authenticate()` returns a cookie-based auth
   * credential instead of a Bearer JWT.  Set by the deploy operation so
   * that `/wapi/git/deploy/catalog` requests carry the `auth_session` cookie.
   */
  cookieAuth?: boolean;
  /**
   * When true and `apiToken` is set, the raw API token is sent directly as
   * `Authorization: Bearer <apiToken>` without exchanging it for a JWT via
   * `POST /v1/token`.  Required by the `/v1/data-sources/` metadata endpoints,
   * which accept the token directly but reject the exchanged JWT.
   */
  useRawApiToken?: boolean;
};

/**
 * Keycloak-backed environment for AtScale. Derives the token URL from the
 * instance base URL and caches the resulting Bearer token.
 */
export class AtScaleEnvironment extends KeycloakEnvironment {
  readonly baseUrl: string;
  readonly authUrl: string;
  readonly username: string;
  readonly password: string;
  readonly clientId: string;
  readonly clientSecret?: string;
  readonly authType: "keycloak" | "basic";
  readonly apiToken?: string;
  readonly sessionCookie?: string;
  readonly cookieAuth: boolean;
  readonly useRawApiToken: boolean;

  constructor(config: AtScaleEnvironmentConfig) {
    super();
    const realm = config.realm ?? "atscale";
    this.baseUrl        = config.baseUrl.replace(/\/$/, "");
    this.authUrl        = `${this.baseUrl}/auth/realms/${realm}/protocol/openid-connect/token`;
    this.username       = config.username ?? "";
    this.password       = config.password ?? "";
    this.clientId       = config.clientId ?? "atscale-ai-link";
    this.clientSecret   = config.clientSecret;
    this.authType       = config.authType ?? "keycloak";
    this.apiToken       = config.apiToken;
    this.sessionCookie  = config.sessionCookie;
    this.cookieAuth     = config.cookieAuth ?? false;
    this.useRawApiToken = config.useRawApiToken ?? false;
    this.insecure       = config.insecure !== false;
  }

  protected override async authenticate(): Promise<RestAuth> {
    if (!this.cookieAuth) {
      // Normal JWT / Basic / Keycloak OIDC path
      if (this.apiToken) {
        if (this.useRawApiToken) {
          this.logger?.verbose(`[REST:Auth] Using raw API token for ${this.baseUrl}`);
          return { type: "bearer", token: this.apiToken };
        }
        return this.exchangeApiToken();
      }
      if (this.authType === "basic") {
        this.logger?.verbose(`[REST:Auth] Using Basic auth for ${this.baseUrl}`);
        return { type: "basic", username: this.username, password: this.password };
      }
      return super.authenticate();
    }

    // Cookie-auth path (required by /wapi/git/deploy/catalog)
    if (this.sessionCookie) {
      this.logger?.verbose(`[REST:Auth] Using explicit session cookie for ${this.baseUrl}`);
      return { type: "cookie", name: "auth_session", value: this.sessionCookie };
    }
    // SSO environments do not support the Keycloak username/password form flow.
    // When an API token is available but no username is configured, fall back to
    // an exchanged JWT Bearer token. The Design Center metadata endpoints
    // (/wapi/p/data-sources/...) accept the exchanged JWT in addition to the
    // auth_session cookie.
    if (this.apiToken && !this.username) {
      this.logger?.verbose(`[REST:Auth] No username configured — using exchanged JWT Bearer (SSO-compatible)`);
      return this.exchangeApiToken();
    }
    // Acquire the cookie automatically via the Keycloak authorization-code flow.
    // Returns a full Cookie header: 2026.5.x sets `auth_session`, while
    // 2026.7.x (better-auth) sets `__Secure-better-auth.session_token` and
    // friends — the server needs the whole jar, so send everything we got.
    const cookieHeader = await this.acquireSessionCookie();
    return { type: "cookie-header", value: cookieHeader };
  }

  private async exchangeApiToken(): Promise<RestAuth> {
    const url = `${this.baseUrl}/v1/token`;
    this.logger?.verbose(`[REST:Auth] Exchanging API token for JWT → POST ${url}`);
    const agentConfig = this.insecure
      ? { httpsAgent: new https.Agent({ rejectUnauthorized: false }) }
      : {};
    const response = await axios.post<{ accessToken: string }>(
      url,
      {},
      { ...agentConfig, headers: { Authorization: `Bearer ${this.apiToken}` }, validateStatus: () => true },
    );
    this.logger?.verbose(`[REST:Auth] ← ${response.status}`);
    if (response.status < 200 || response.status >= 300) {
      throw new Error(
        `AtScale token exchange failed (${response.status}): ${JSON.stringify(response.data)}`,
      );
    }
    this.logger?.verbose(`[REST:Auth] JWT obtained`);
    return { type: "bearer", token: response.data.accessToken };
  }

  /**
   * Acquire an `auth_session` cookie from the AtScale Design Center by
   * completing the Keycloak authorization-code flow headlessly:
   *
   *   1. GET /signin             → state cookie + Keycloak redirect URL
   *   2. GET <Keycloak login>    → form-action URL (includes `execution` param)
   *   3. POST username+password  → 302 redirect to /signin/callback?code=…
   *   4. GET /signin/callback    → Set-Cookie: auth_session=…
   *
   * Requires `username` and `password` to be set on this environment.
   */
  private async acquireSessionCookie(): Promise<string> {
    if (!this.username || !this.password) {
      throw new Error(
        `atscale-deploy-repo requires Keycloak credentials to acquire the Design Center ` +
        `session cookie automatically. ` +
        `Add 'username' and 'password' (or a 'user:' reference) to the atscale: block ` +
        `in your connections file.`,
      );
    }

    const agentCfg = this.insecure
      ? { httpsAgent: new https.Agent({ rejectUnauthorized: false }) }
      : {};
    const cookies: Record<string, string> = {};

    const addCookies = (headers: Record<string, any>) => {
      const sc = headers["set-cookie"];
      if (!sc) return;
      for (const c of Array.isArray(sc) ? sc : [sc]) {
        const m = c.match(/^([^=]+)=([^;]*)/);
        if (m) cookies[m[1]] = m[2];
      }
    };

    const cookieHdr = () =>
      Object.entries(cookies).map(([k, v]) => `${k}=${v}`).join("; ");

    const req = (cfg: Record<string, any>) =>
      axios({ ...agentCfg, validateStatus: () => true, maxRedirects: 0, ...cfg });

    this.logger?.verbose(`[REST:Auth] Acquiring auth_session via Keycloak form flow`);

    // Step 1: GET /signin → keycloak_oauth_state cookie + Keycloak redirect URL
    const r1 = await req({ url: `${this.baseUrl}/signin` });
    addCookies(r1.headers);
    const kcUrl: string = r1.headers["location"] ?? "";
    if (!kcUrl) {
      throw new Error(
        `[REST:Auth] ${this.baseUrl}/signin did not redirect to Keycloak ` +
        `(status ${r1.status}). Verify the AtScale URL is correct.`,
      );
    }

    // Step 2: GET Keycloak login page → form-action URL (includes execution param)
    const r2 = await req({ url: kcUrl, headers: { Cookie: cookieHdr() } });
    addCookies(r2.headers);
    const formActionMatches = [
      ...String(r2.data).matchAll(
        /["'`](https?:[^"'`]+login-actions\/authenticate[^"'`]+)[`"']/g,
      ),
    ];
    const formActionUrl = formActionMatches[0]?.[1];
    if (!formActionUrl) {
      throw new Error(
        `[REST:Auth] Could not extract Keycloak login form-action URL from the login page. ` +
        `The Keycloak theme may have changed.`,
      );
    }

    // Step 3: POST credentials → 302 redirect to /signin/callback?code=…
    const r3 = await req({
      method: "POST",
      url: formActionUrl,
      headers: { Cookie: cookieHdr(), "Content-Type": "application/x-www-form-urlencoded" },
      data: new URLSearchParams({ username: this.username, password: this.password }).toString(),
    });
    addCookies(r3.headers);

    if (r3.status < 300 || r3.status >= 400) {
      throw new Error(
        `[REST:Auth] Keycloak login failed (status ${r3.status}). ` +
        `Check username/password in the atscale: block of your connections file.`,
      );
    }

    const rawLocation: string = r3.headers["location"] ?? "";
    const callbackUrl = rawLocation.startsWith("http")
      ? rawLocation
      : `${this.baseUrl}${rawLocation}`;

    // Step 4: GET /signin/callback?code=… → session cookie(s).
    // 2026.5.x: Set-Cookie: auth_session=…
    // 2026.7.x: better-auth cookies (__Secure-better-auth.session_token, …)
    const r4 = await req({ url: callbackUrl, headers: { Cookie: cookieHdr() } });
    addCookies(r4.headers);

    const sessionCookieName = ["auth_session", "__Secure-better-auth.session_token"]
      .find((n) => cookies[n]);
    if (!sessionCookieName) {
      throw new Error(
        `[REST:Auth] /signin/callback did not set a session cookie ` +
        `(expected auth_session or __Secure-better-auth.session_token; status ${r4.status}). ` +
        `The Keycloak code exchange may have failed.`,
      );
    }

    this.logger?.verbose(`[REST:Auth] session cookie acquired (${sessionCookieName})`);
    return cookieHdr();
  }
}

// ── Shared types ───────────────────────────────────────────────────────────────

export type RepoType = "catalog" | "global_settings";

/** Query roles assignable to a data warehouse connection. */
export enum QueryRole {
  LargeUserQuery  = "large_user_query_role",
  SmallUserQuery  = "small_user_query_role",
  AggCreation     = "agg_creation_role",
  SystemQuery     = "system_query_role",
  CanaryQuery     = "canary_query_role",
}

const DEFAULT_QUERY_ROLES: QueryRole[] = [
  QueryRole.LargeUserQuery,
  QueryRole.SmallUserQuery,
  QueryRole.AggCreation,
  QueryRole.SystemQuery,
];

export type AccessConfig = {
  users:  Array<{ userName: string }>;
  groups: Array<{ name: string }>;
};

// ── 1. Connect git repository ─────────────────────────────────────────────────

export type ConnectGitRepoArgs = {
  /** Human-readable name for the repository. */
  name: string;
  /** Git remote URL (HTTPS or SSH). */
  url: string;
  /** Defaults to "catalog". */
  type?: RepoType;
  /** Glob pattern controlling which branches are visible in the UI. */
  visibleBranchesPattern?: string;
  /** Default branch name (e.g. "main"). */
  defaultBranch?: string;
};

export type ConnectGitRepoResult = {
  id: string;
  name: string;
  url: string;
  type: string;
  visibleBranchesPattern?: string | null;
  defaultBranch?: string | null;
};

class ConnectGitRepoRequest extends RestRequest<ConnectGitRepoArgs, ConnectGitRepoResult> {
  readonly method = "POST" as const;

  path(_args: ConnectGitRepoArgs): string {
    return "/wapi/p/repo";
  }

  body(args: ConnectGitRepoArgs): unknown {
    return {
      name:                   args.name,
      url:                    args.url,
      type:                   args.type ?? "catalog",
      visibleBranchesPattern: args.visibleBranchesPattern,
      defaultBranch:          args.defaultBranch,
    };
  }

  parse(data: unknown): ConnectGitRepoResult {
    return data as ConnectGitRepoResult;
  }
}

// ── 2. List repositories ──────────────────────────────────────────────────────

export type ListReposResult = Array<{
  id: string;
  name: string;
  url: string;
  visibleBranchesPattern?: string | null;
  defaultBranch?: string | null;
}>;

class ListReposRequest extends RestRequest<void, ListReposResult> {
  readonly method = "GET" as const;

  path(_args: void): string {
    return "/wapi/p/repo";
  }

  parse(data: unknown): ListReposResult {
    return data as ListReposResult;
  }
}

// ── 3. Create data source (all dialects) ──────────────────────────────────────

export type CreateDataSourceArgs = {
  /**
   * Full connections YAML config (as loaded by YamlService).
   * The relevant connection entry is selected by `connectionName`.
   */
  config: ConnectionConfig;
  /** Key of the connection entry within `config.connections` (or top-level). */
  connectionName: string;
  /** Display name for the data warehouse (max 128 chars). */
  name: string;
  /** Logical connection ID embedded in SML. */
  connectionId: string;
  /** Schema used for aggregate storage. For BigQuery this is the dataset. */
  aggregateSchema: string;
  access: AccessConfig;
  /**
   * BigQuery only: GCP project ID used for aggregate storage.
   * Defaults to `sql.project` from the connection config.
   */
  aggregateProjectId?: string;
  /**
   * Query roles to assign to the connection.
   * Defaults to LargeUserQuery, SmallUserQuery, AggCreation, SystemQuery.
   */
  queryRoles?: QueryRole[];
};

export type CreateDataSourceResult = {
  id?: string;
  created?: boolean;
};

class CreateDataSourceRequest extends RestRequest<CreateDataSourceArgs, CreateDataSourceResult> {
  readonly method = "POST" as const;

  private resolveSql(args: CreateDataSourceArgs): Record<string, any> {
    const { config, connectionName } = args;
    const connections = config.connections ?? {};
    const entry = connections[connectionName] ?? (config as any)[connectionName];
    if (!entry) {
      throw new Error(`Connection not found: '${connectionName}'`);
    }
    const sql = { ...(entry.sql ?? entry) };

    // Resolve user key → users block (same pattern as AtScale connections).
    // snowctl fragments reference the users block via `snowflake_user`.
    const userKey = sql.user ?? sql.snowflake_user;
    if (userKey) {
      const users: Record<string, any> = (config as any).users ?? {};
      const userEntry = users[userKey];
      if (userEntry) {
        sql.username ??= userEntry.username;
        sql.password ??= userEntry.password;
        sql.privateKeyPath     ??= userEntry.privateKeyPath;
        sql.privateKeyPassword ??= userEntry.privateKeyPassword;
      }
    }

    return sql;
  }

  path(args: CreateDataSourceArgs): string {
    const sql = this.resolveSql(args);
    const dialect: string = sql.dialect ?? "snowflake";
    switch (dialect) {
      case "snowflake":   return "/wapi/p/data-warehouses/snowflake";
      case "bigquery":    return "/wapi/p/data-warehouses/google-big-query";
      case "databricks":  return "/wapi/p/data-warehouses/databricks";
      case "postgres":
      case "postgresql":  return "/wapi/p/data-warehouses/postgresql";
      default:
        throw new Error(`Unsupported dialect for AtScale data source: '${dialect}'`);
    }
  }

  body(args: CreateDataSourceArgs): unknown {
    const sql = this.resolveSql(args);
    const dialect: string = sql.dialect ?? "snowflake";
    switch (dialect) {
      case "snowflake":   return this.snowflakeBody(args, sql);
      case "bigquery":    return this.bigQueryBody(args, sql);
      case "databricks":  return this.databricksBody(args, sql);
      case "postgres":
      case "postgresql":  return this.postgresBody(args, sql);
      default:
        throw new Error(`Unsupported dialect for AtScale data source: '${dialect}'`);
    }
  }

  parse(data: unknown): CreateDataSourceResult {
    return data as CreateDataSourceResult;
  }

  private snowflakeBody(args: CreateDataSourceArgs, sql: Record<string, any>): unknown {
    const roles = args.queryRoles ?? DEFAULT_QUERY_ROLES;
    const password   = sql.password;
    // key-pair auth: accept inline PEM (private_key) or a path
    // (privateKeyPath, as emitted into `users:` blocks by snowctl fragments)
    const keyPath    = sql.privateKeyPath ?? sql.private_key_path;
    const privateKey = sql.private_key ?? (keyPath ? readFileSync(keyPath, "utf8") : undefined);
    return {
      name:            args.name,
      connectionId:    args.connectionId,
      database:        sql.database,
      aggregateSchema: args.aggregateSchema,
      access:          args.access,
      // required by the 2026.7.x data-warehouse API (validation 400s without them)
      isImpersonationEnabled: false,
      isCanaryAlwaysEnabled:  false,
      isPartialAggHitEnabled: false,
      connections: [{
        name:        args.connectionName,
        queryRoles:  roles,
        hosts:       sql.account,
        username:    sql.username ?? sql.user,
        isKerberosClientEnabled: false,
        extraProperties: {
          warehouse:  sql.warehouse,
          accessType: sql.access_type,
          file:       sql.key_file,
        },
        secretProperties: (password || privateKey) ? {
          password:   password,
          privateKey: privateKey,
          passphrase: sql.private_key_passphrase ?? sql.privateKeyPassword,
        } : null,
        extraJdbcFlags: sql.extra_jdbc_flags ?? "",
      }],
    };
  }

  private databricksBody(args: CreateDataSourceArgs, sql: Record<string, any>): unknown {
    const roles = args.queryRoles ?? DEFAULT_QUERY_ROLES;
    return {
      name:            args.name,
      connectionId:    args.connectionId,
      database:        sql.database,
      aggregateSchema: args.aggregateSchema,
      access:          args.access,
      connections: [{
        name:       args.connectionName,
        queryRoles: roles,
        hosts:      sql.server,
        port:       Number(sql.port ?? 443),
        username:   sql.username ?? sql.user,
        httpPath:   sql.http_path ?? sql.httpPath,
        secretProperties: {
          password: sql.password,
        },
        extraJdbcFlags: sql.extra_jdbc_flags ?? "",
      }],
    };
  }

  private postgresBody(args: CreateDataSourceArgs, sql: Record<string, any>): unknown {
    const roles = args.queryRoles ?? DEFAULT_QUERY_ROLES;
    return {
      name:                   args.name,
      connectionId:           args.connectionId,
      database:               sql.database,
      aggregateSchema:        args.aggregateSchema,
      isImpersonationEnabled: false,
      isCanaryAlwaysEnabled:  false,
      isPartialAggHitEnabled: false,
      extraProperties:        { udafMode: "udaf_disabled", udafSchema: "" },
      access:                 args.access,
      connections: [{
        name:                  args.connectionName,
        queryRoles:            roles,
        hosts:                 sql.server ?? sql.host,
        port:                  Number(sql.port ?? 5432),
        username:              sql.username ?? sql.user,
        isKerberosClientEnabled: false,
        secretProperties: {
          password: sql.password,
        },
        extraJdbcFlags: sql.extra_jdbc_flags ?? "",
      }],
    };
  }

  private bigQueryBody(args: CreateDataSourceArgs, sql: Record<string, any>): unknown {
    const roles = args.queryRoles ?? DEFAULT_QUERY_ROLES;
    const project = args.aggregateProjectId ?? sql.project;
    return {
      name:                   args.name,
      connectionId:           args.connectionId,
      aggregateProjectId:     project,
      aggregateSchema:        args.aggregateSchema,
      isImpersonationEnabled: false,
      isCanaryAlwaysEnabled:  false,
      isPartialAggHitEnabled: false,
      access:                 args.access,
      connections: [{
        name:       args.connectionName,
        queryRoles: roles,
        extraProperties: {
          gcProjectId: sql.project,
        },
        fileContent: "{}",
      }],
    };
  }
}

// ── 4. List data sources ──────────────────────────────────────────────────────

export type ListDataSourcesResult = Array<{
  id: string;
  name: string;
  connectionId: string;
  connections: Array<{ id: string; name: string }>;
}>;

class ListDataSourcesRequest extends RestRequest<void, ListDataSourcesResult> {
  readonly method = "GET" as const;

  path(_args: void): string {
    return "/wapi/p/data-warehouses";
  }

  parse(data: unknown): ListDataSourcesResult {
    return data as ListDataSourcesResult;
  }
}

// ── 5. Deploy model (catalog) ─────────────────────────────────────────────────

export type TableauServerTarget = {
  /** Name of the Tableau server as registered in AtScale. */
  name: string;
  /** Tableau site names to publish to. */
  sites: string[];
};

export type DeployModelArgs = {
  /** Full catalog XML content (project XML). */
  catalogXml: string;
  /** UUID of the repository to deploy against. */
  repositoryId: string;
  /** Optional Tableau servers to publish the catalog to after deployment. */
  tableauServers?: TableauServerTarget[];
};

export type DeployModelResult = {
  tableau?: Array<{
    serverId: string;
    name: string;
    siteName: string;
    isSuccessful: boolean;
    errorMessage?: string;
  }>;
};

class DeployModelRequest extends RestRequest<DeployModelArgs, DeployModelResult> {
  readonly method = "POST" as const;

  path(_args: DeployModelArgs): string {
    return "/wapi/p/catalogs";
  }

  body(args: DeployModelArgs): unknown {
    return {
      catalogXml:     args.catalogXml,
      repositoryId:   args.repositoryId,
      tableauServers: args.tableauServers,
    };
  }

  parse(data: unknown): DeployModelResult {
    return (data ?? {}) as DeployModelResult;
  }
}

// ── 5b. Deploy SML files to git repo + publish ────────────────────────────────

export type SmlRawFile = {
  /** Relative path of the file within the SML directory, e.g. "models/telemetry.yml". */
  relativePath: string;
  /** Raw YAML content of the file. */
  rawContent: string;
};

export type DeployRepoArgs = {
  /** UUID of the repository already configured in AtScale (from atscale-list-repos). */
  repoId: string;
  /** SML files to deploy. Typically all *.yml files under the SML project directory. */
  smlRawFiles: SmlRawFile[];
  /**
   * Compiled catalog XML (project_2_0 schema).  Required by the endpoint; generated
   * automatically from the SML files by the operation layer.
   */
  projectXml: string;
  /** Catalog name in the format `{catalog.unique_name}_{defaultBranch}`. */
  projectName: string;
  /** Connection IDs referenced by the SML datasets. */
  conIds: string[];
  /** UUID of the project to deploy. For new deploys, generate a new v4 UUID. For updates, use the existing project UUID. */
  projectId: string;
  /** Optional Tableau servers to publish to after deployment. */
  tableauServers?: TableauServerTarget[];
};

export type DeployRepoResult = {
  projectId?:   string;
  projectName?: string;
  [key: string]: unknown;
};

class DeployRepoRequest extends RestRequest<DeployRepoArgs, DeployRepoResult> {
  readonly method = "POST" as const;

  path(_args: DeployRepoArgs): string {
    return "/wapi/git/deploy/catalog";
  }

  body(args: DeployRepoArgs): unknown {
    return {
      repoId:         args.repoId,
      projectId:      args.projectId,
      projectName:    args.projectName,
      conIds:         args.conIds,
      smlRawFiles:    args.smlRawFiles,
      projectXml:     args.projectXml,
      cubes:          [],
      tableauServers: args.tableauServers ?? [],
      perspectives:   [],
    };
  }

  parse(data: unknown): DeployRepoResult {
    return (data ?? {}) as DeployRepoResult;
  }
}

// ── 6. Validate model (engine checks) ────────────────────────────────────────

export type ValidateModelCheckColumn = {
  name:     string;   // field name expected by NestJS DTO (becomes "name" after kebab-case conversion)
  type:     string;
  dataType: string;
};

export type ValidateModelCheckSide = {
  dsId:    string;
  dsType:  string;
  columns: ValidateModelCheckColumn[];
};

export type ValidateModelCheck = {
  id:           string;
  checkType:    string;
  from:         ValidateModelCheckSide;
  to:           ValidateModelCheckSide;
  connectionId: string;
  database:     string;
  schema:       string;
  isSnowflake:  boolean;
};

export type ValidateModelArgs = {
  connectionId: string;
  database:     string;
  schema:       string;
  checks:       ValidateModelCheck[];
};

export type ValidateModelResult = {
  checks: Array<{
    id:     string;
    result: string; // engine returns e.g. "correct", "incorrect", "warning", "unknown" (case may vary)
  }>;
};

class ValidateModelRequest extends RestRequest<ValidateModelArgs, ValidateModelResult> {
  readonly method = "POST" as const;

  path(_args: ValidateModelArgs): string {
    return "/wapi/p/catalog/validate-model";
  }

  body(args: ValidateModelArgs): unknown {
    return {
      connectionId: args.connectionId,
      database:     args.database,
      schema:       args.schema,
      checks:       args.checks,
    };
  }

  parse(data: unknown): ValidateModelResult {
    return (data ?? { checks: [] }) as ValidateModelResult;
  }
}

// ── 7. List models (catalogs) ─────────────────────────────────────────────────

/**
 * Actual response shape from GET /wapi/p/projects/deployed:
 *   [{repoId, name, projects: [{id, name, caption, models: [...]}]}]
 */
export type ListModelsResult = Array<{
  repoId: string;
  name: string;
  projects: Array<{
    id: string;
    name: string;
    caption?: string;
    models?: Array<{
      id: string;
      name: string;
      caption?: string;
    }>;
  }>;
}>;

class ListModelsRequest extends RestRequest<void, ListModelsResult> {
  readonly method = "GET" as const;

  path(_args: void): string {
    return "/wapi/p/projects/deployed";
  }

  parse(data: unknown): ListModelsResult {
    return data as ListModelsResult;
  }
}

// ── 8. List tables in a schema ────────────────────────────────────────────────

export type ListTablesArgs = {
  connectionId: string;
  database:     string;
  schema:       string;
};

export type TableEntry = {
  name: string;
  [key: string]: unknown;
};

export type ListTablesResult = TableEntry[];

class ListTablesRequest extends RestRequest<ListTablesArgs, ListTablesResult> {
  readonly method = "GET" as const;

  path(args: ListTablesArgs): string {
    return (
      `/wapi/p/data-sources/conn/${encodeURIComponent(args.connectionId)}` +
      `/databases/${encodeURIComponent(args.database)}` +
      `/schemas/${encodeURIComponent(args.schema)}/tables`
    );
  }

  parse(data: unknown): ListTablesResult {
    return (Array.isArray(data) ? data : []) as ListTablesResult;
  }
}

// ── 9. Get table info (columns) ───────────────────────────────────────────────

export type GetTableInfoArgs = {
  connectionId: string;
  database:     string;
  schema:       string;
  table:        string;
};

export type ColumnInfo = {
  name:        string;
  dataType:    string;
  nullable?:   boolean;
  primaryKey?: boolean;
  [key: string]: unknown;
};

export type TableInfoResult = {
  name?:    string;
  columns?: ColumnInfo[];
  [key: string]: unknown;
};

class GetTableInfoRequest extends RestRequest<GetTableInfoArgs, TableInfoResult> {
  readonly method = "GET" as const;

  path(args: GetTableInfoArgs): string {
    return (
      `/wapi/p/data-sources/conn/${encodeURIComponent(args.connectionId)}` +
      `/databases/${encodeURIComponent(args.database)}` +
      `/schemas/${encodeURIComponent(args.schema)}` +
      `/tables/${encodeURIComponent(args.table)}/info`
    );
  }

  parse(data: unknown): TableInfoResult {
    return (data ?? {}) as TableInfoResult;
  }
}

// ── AtScaleRestClientService ───────────────────────────────────────────────────

/**
 * High-level service for AtScale provisioning operations.
 * Resolves `RestClientService` from the registry on construction.
 */
export class AtScaleRestClientService extends ServiceProvider {
  name = "atscale-rest";

  private readonly connectGitRepoRequest    = new ConnectGitRepoRequest();
  private readonly listReposRequest         = new ListReposRequest();
  private readonly createDataSourceRequest  = new CreateDataSourceRequest();
  private readonly listDataSourcesRequest   = new ListDataSourcesRequest();
  private readonly deployModelRequest       = new DeployModelRequest();
  private readonly deployRepoRequest        = new DeployRepoRequest();
  private readonly validateModelRequest     = new ValidateModelRequest();
  private readonly listModelsRequest        = new ListModelsRequest();
  private readonly listTablesRequest        = new ListTablesRequest();
  private readonly getTableInfoRequest      = new GetTableInfoRequest();

  constructor(private readonly restClient: RestClientService) {
    super();
  }

  /**
   * Register a new git repository in AtScale.
   * Maps to: POST /repo
   */
  async connectGitRepo(
    env: AtScaleEnvironment,
    args: ConnectGitRepoArgs,
  ): Promise<ConnectGitRepoResult> {
    return this.restClient.execute(this.connectGitRepoRequest, args, env);
  }

  /**
   * List all catalog repositories registered in AtScale.
   * Maps to: GET /v1/public/repos
   */
  async listRepos(env: AtScaleEnvironment): Promise<ListReposResult> {
    return this.restClient.execute(this.listReposRequest, undefined, env);
  }

  /**
   * Create a new data warehouse (data source) in AtScale.
   * Dispatches to the appropriate dialect endpoint based on `sql.dialect`
   * in the connection config (snowflake, databricks, bigquery).
   * Maps to: POST /v1/public/data-warehouses/{dialect}
   */
  async createDataSource(
    env: AtScaleEnvironment,
    args: CreateDataSourceArgs,
  ): Promise<CreateDataSourceResult> {
    return this.restClient.execute(this.createDataSourceRequest, args, env);
  }

  /**
   * List all data warehouses registered in AtScale.
   * Maps to: GET /v1/public/data-warehouses
   */
  async listDataSources(env: AtScaleEnvironment): Promise<ListDataSourcesResult> {
    return this.restClient.execute(this.listDataSourcesRequest, undefined, env);
  }

  /**
   * Validate an SML model against the AtScale engine.
   * Sends column-joinability and uniqueness checks and returns pass/fail results.
   * Maps to: POST /wapi/p/catalog/validate-model
   */
  async validateModel(
    env: AtScaleEnvironment,
    args: ValidateModelArgs,
  ): Promise<ValidateModelResult> {
    return this.restClient.execute(this.validateModelRequest, args, env);
  }

  /**
   * Deploy a catalog (semantic model) to AtScale.
   * Maps to: POST /v1/public/catalogs
   */
  async deployModel(
    env: AtScaleEnvironment,
    args: DeployModelArgs,
  ): Promise<DeployModelResult> {
    return this.restClient.execute(this.deployModelRequest, args, env);
  }

  /**
   * Deploy local SML files to a configured git repo in AtScale and publish.
   * Requires `sessionCookie` auth in the AtScale connection (the Design Center
   * `auth_session` cookie value); the API token JWT is not accepted by this endpoint.
   * Maps to: POST /wapi/git/deploy/catalog
   */
  async deployRepo(
    env: AtScaleEnvironment,
    args: DeployRepoArgs,
  ): Promise<DeployRepoResult> {
    return this.restClient.execute(this.deployRepoRequest, args, env);
  }

  /**
   * List all deployed catalogs (models) in AtScale.
   * Maps to: GET /v1/public/catalogs
   */
  async listModels(env: AtScaleEnvironment): Promise<ListModelsResult> {
    return this.restClient.execute(this.listModelsRequest, undefined, env);
  }

  /**
   * List all tables in a given database/schema via the data source connection.
   * Maps to: GET /v1/data-sources/conn/{connectionId}/databases/{database}/schemas/{schema}/tables
   */
  async listTables(env: AtScaleEnvironment, args: ListTablesArgs): Promise<ListTablesResult> {
    return this.restClient.execute(this.listTablesRequest, args, env);
  }

  /**
   * Get column metadata for a specific table.
   * Maps to: GET /v1/data-sources/conn/{connectionId}/databases/{database}/schemas/{schema}/tables/{table}/info
   */
  async getTableInfo(env: AtScaleEnvironment, args: GetTableInfoArgs): Promise<TableInfoResult> {
    return this.restClient.execute(this.getTableInfoRequest, args, env);
  }
}
