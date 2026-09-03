/**
 * REST client service.
 *
 * Provides a typed, auth-aware HTTP client built around two abstract primitives:
 *
 *   RestEnvironment  — where to call (base URL + authentication strategy)
 *   RestRequest      — what to call (method, path, body, parsing)
 *
 * Usage:
 *
 *   // 1. Describe the environment
 *   class MyEnv extends KeycloakEnvironment {
 *     baseUrl = "https://atscale.example.com";
 *     authUrl = "https://atscale.example.com/auth/realms/atscale/...";
 *     username = "admin";
 *     password = "secret";
 *   }
 *
 *   // 2. Describe a request
 *   class GetCatalogs extends RestRequest<void, Catalog[]> {
 *     method = "GET" as const;
 *     path = () => "/api/v1/orgs/default/catalogs";
 *     parse = (data: unknown) => data as Catalog[];
 *   }
 *
 *   // 3. Execute
 *   const result = await restService.execute(new GetCatalogs(), undefined, new MyEnv());
 */
import https from "https";
import axios, { type AxiosRequestConfig } from "axios";
import { ServiceProvider } from "./ServiceProvider.js";
import type { Logger } from "../logging.js";

// ── Authentication ─────────────────────────────────────────────────────────────

/**
 * Discriminated union of supported authentication schemes.
 */
export type RestAuth =
  | { type: "bearer"; token: string }
  | { type: "basic"; username: string; password: string }
  | { type: "api-key"; header: string; value: string }
  | { type: "cookie"; name: string; value: string }
  | { type: "cookie-header"; value: string }
  | { type: "none" };

// ── RestEnvironment ────────────────────────────────────────────────────────────

/**
 * Describes where a REST call is made and how to authenticate.
 *
 * Subclasses implement `authenticate()` to return a `RestAuth` value.
 * The result is cached for the lifetime of the environment instance and
 * refreshed automatically when a 401 is received.
 */
export abstract class RestEnvironment {
  /** Root URL prepended to every request path (no trailing slash). */
  abstract readonly baseUrl: string;

  /**
   * When true, TLS certificate verification is disabled for all requests
   * made against this environment. Use only for self-signed / dev certificates.
   */
  insecure: boolean = false;

  /**
   * Per-request timeout in milliseconds; `undefined` waits indefinitely.
   *
   * It applies to **authentication as well as** the request itself. An
   * unreachable host stalls on the token exchange long before it reaches the
   * endpoint being called, so a timeout that covered only `dispatch` would not
   * fire at all in the case it exists for.
   *
   * Left undefined by default because deploys and builds legitimately run for
   * minutes; operations that want a bound set it explicitly.
   */
  timeoutMs?: number;

  /** Injected by RestClientService before each call. Used for verbose logging. */
  logger?: Logger;

  /**
   * Axios options every request through this environment should carry.
   * Kept here so the auth paths, which build their own axios calls rather than
   * going through `RestClientService`, cannot silently miss them.
   */
  protected requestDefaults(): { timeout?: number } {
    return this.timeoutMs === undefined ? {} : { timeout: this.timeoutMs };
  }

  private _cachedAuth: RestAuth | undefined;

  /**
   * Produce authentication credentials for this environment.
   * Called once and cached; called again automatically on 401.
   */
  protected abstract authenticate(): Promise<RestAuth>;

  /** @internal — called by RestClientService. */
  async getAuth(forceRefresh = false): Promise<RestAuth> {
    if (!this._cachedAuth || forceRefresh) {
      this._cachedAuth = await this.authenticate();
    }
    return this._cachedAuth;
  }

  /** Clears the cached credentials (e.g. after a 401 response). */
  invalidate(): void {
    this._cachedAuth = undefined;
  }
}

// ── Built-in environment helpers ───────────────────────────────────────────────

/**
 * Environment that authenticates with a static Bearer token.
 */
export abstract class BearerTokenEnvironment extends RestEnvironment {
  abstract readonly token: string;

  protected async authenticate(): Promise<RestAuth> {
    return { type: "bearer", token: this.token };
  }
}

/**
 * Environment that authenticates with HTTP Basic credentials.
 */
export abstract class BasicAuthEnvironment extends RestEnvironment {
  abstract readonly username: string;
  abstract readonly password: string;

  protected async authenticate(): Promise<RestAuth> {
    return { type: "basic", username: this.username, password: this.password };
  }
}

/**
 * Environment that authenticates against a Keycloak OpenID Connect token endpoint
 * using the Resource Owner Password Credentials grant, then caches the Bearer token.
 */
export abstract class KeycloakEnvironment extends RestEnvironment {
  /** Full URL of the Keycloak token endpoint. */
  abstract readonly authUrl: string;
  abstract readonly username: string;
  abstract readonly password: string;
  /** Keycloak client_id. Defaults to "atscale-ai-link". */
  readonly clientId: string = "atscale-ai-link";
  /** Keycloak client_secret. Required when the client is configured as confidential. */
  readonly clientSecret?: string;

  protected async authenticate(): Promise<RestAuth> {
    const params = new URLSearchParams();
    params.append("client_id", this.clientId);
    if (this.clientSecret) {
      params.append("client_secret", this.clientSecret);
    }
    params.append("grant_type", "password");
    params.append("username", this.username);
    params.append("password", this.password);
    params.append("scope", "openid");

    const agentConfig = this.insecure
      ? { httpsAgent: new https.Agent({ rejectUnauthorized: false }) }
      : {};
    this.logger?.verbose(`[REST:Auth] → POST ${this.authUrl}`);
    this.logger?.verbose(
      `[REST:Auth]   client_id=${this.clientId}` +
      ` client_secret=${this.clientSecret ? "<set>" : "<not set>"}` +
      ` username=${this.username}`,
    );
    const response = await axios.post<{ access_token: string }>(
      this.authUrl, params, { ...agentConfig, ...this.requestDefaults(), validateStatus: () => true },
    );
    this.logger?.verbose(`[REST:Auth] ← ${response.status}`);
    if (response.status < 200 || response.status >= 300) {
      this.logger?.verbose(`[REST:Auth]   Body: ${JSON.stringify(response.data)}`);
      const body = response.data as Record<string, string> | undefined;
      const hint = this.buildAuthHint(response.status, body?.error);
      throw new Error(
        `Authentication failed (${response.status}): ${JSON.stringify(response.data)}${hint}`,
      );
    }
    return { type: "bearer", token: response.data.access_token };
  }

  private buildAuthHint(status: number, error?: string): string {
    if (status === 401 && error === "invalid_grant") {
      return (
        "\nHint: 'invalid_grant' can mean: (1) wrong username/password, " +
        `(2) the Keycloak client '${this.clientId}' does not have Direct Access Grants enabled, ` +
        "or (3) the user has a pending required action in Keycloak (e.g. must change password). " +
        "Check Keycloak admin → Users → <user> → Details tab for Required Actions. " +
        "Also try a different clientId in the atscale: block of your connections file."
      );
    }
    if (status === 401 && error === "unauthorized_client") {
      return (
        "\nHint: 'unauthorized_client' means the Keycloak client requires a client_secret for " +
        "the password grant. Add clientSecret to the atscale: block of your connections file. " +
        "Find the secret in Keycloak admin → Clients → " +
        `${this.clientId} → Credentials tab.`
      );
    }
    return "";
  }
}

/**
 * Unauthenticated environment (open APIs or environments using network-level auth).
 */
export abstract class UnauthenticatedEnvironment extends RestEnvironment {
  protected async authenticate(): Promise<RestAuth> {
    return { type: "none" };
  }
}

// ── RestRequest ────────────────────────────────────────────────────────────────

/**
 * Describes a single REST call: its HTTP method, URL path, optional body and
 * query parameters, and how to parse the response into a typed result.
 *
 * @typeParam TArgs   Input value passed when the request is executed.
 * @typeParam TResult Parsed return type produced by `parse()`.
 */
export abstract class RestRequest<TArgs, TResult> {
  abstract readonly method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE";

  /** Build the path segment appended to `RestEnvironment.baseUrl`. */
  abstract path(args: TArgs): string;

  /** Parse the raw response body into the typed result. */
  abstract parse(data: unknown, status: number): TResult;

  /** Optional request body. Return `undefined` to send no body. */
  body(_args: TArgs): unknown {
    return undefined;
  }

  /** Optional query-string parameters. */
  query(_args: TArgs): Record<string, string> {
    return {};
  }

  /**
   * Optional extra request headers (merged with auth headers; these take
   * precedence over the defaults but not over the auth header).
   */
  headers(_args: TArgs): Record<string, string> {
    return {};
  }
}

// ── Error ──────────────────────────────────────────────────────────────────────

/**
 * Thrown by `RestClientService.execute()` for non-2xx responses after any
 * retry/refresh has been attempted.
 */
export class RestError extends Error {
  constructor(
    public readonly status: number,
    public readonly body: unknown,
    public readonly url: string,
  ) {
    const detail =
      body !== null && typeof body === "object" && "message" in (body as object)
        ? String((body as Record<string, unknown>).message)
        : typeof body === "string"
          ? body
          : JSON.stringify(body);
    super(`REST ${status} from ${url}: ${detail}`);
    this.name = "RestError";
  }
}

// ── RestClientService ──────────────────────────────────────────────────────────

/**
 * Stateless service that executes `RestRequest` instances against a `RestEnvironment`.
 *
 * Auth is applied automatically via the environment. A single retry is performed
 * on 401 after calling `environment.invalidate()` to force a credential refresh.
 */
export class RestClientService extends ServiceProvider {
  name = "rest";

  constructor(private readonly logger?: Logger) {
    super();
  }

  async execute<TArgs, TResult>(
    request: RestRequest<TArgs, TResult>,
    args: TArgs,
    environment: RestEnvironment,
  ): Promise<TResult> {
    return this.dispatch(request, args, environment, false);
  }

  private async dispatch<TArgs, TResult>(
    request: RestRequest<TArgs, TResult>,
    args: TArgs,
    environment: RestEnvironment,
    isRetry: boolean,
  ): Promise<TResult> {
    environment.logger = this.logger;
    const auth = await environment.getAuth(isRetry);
    const url = environment.baseUrl.replace(/\/$/, "") + request.path(args);
    const requestHeaders: Record<string, string> = {
      ...request.headers(args),
    };
    if (request.method !== "GET") {
      requestHeaders["Content-Type"] = "application/json";
    }

    this.applyAuth(auth, requestHeaders);

    const query = request.query(args);
    const body = request.body(args);

    const config: AxiosRequestConfig = {
      method: request.method,
      url,
      headers: requestHeaders,
      params: Object.keys(query).length > 0 ? query : undefined,
      data: body,
      validateStatus: () => true, // handle status manually
      httpsAgent: environment.insecure
        ? new https.Agent({ rejectUnauthorized: false })
        : undefined,
      ...(environment.timeoutMs === undefined ? {} : { timeout: environment.timeoutMs }),
    };

    this.logger?.verbose(`[REST] → ${request.method} ${url}`);
    this.logger?.verbose(`[REST]   Headers: ${this.formatHeaders(requestHeaders)}`);
    if (body !== undefined) {
      this.logger?.verbose(`[REST]   Body: ${JSON.stringify(body)}`);
    }

    const t0 = Date.now();
    const response = await axios(config);
    const ms = Date.now() - t0;

    this.logger?.verbose(`[REST] ← ${response.status} (${ms}ms)`);
    this.logger?.verbose(`[REST]   Response: ${this.formatBody(response.data)}`);

    if (response.status === 401 && !isRetry) {
      environment.invalidate();
      return this.dispatch(request, args, environment, true);
    }

    if (response.status < 200 || response.status >= 300) {
      const body = response.data as Record<string, string> | undefined;
      if (response.status === 401 && body?.message === "Invalid token format") {
        this.logger?.verbose(
          "[REST] Hint: 'Invalid token format' means the API rejected the Keycloak Bearer token. " +
          "Try setting authType: basic in the atscale: block of your connections file.",
        );
      }
      throw new RestError(response.status, response.data, url);
    }

    return request.parse(response.data, response.status);
  }

  private formatHeaders(headers: Record<string, string>): string {
    const redacted = { ...headers };
    if (redacted["Authorization"]) {
      const parts = redacted["Authorization"].split(" ");
      const token = parts[1] ?? "";
      redacted["Authorization"] = `${parts[0]} ${token.slice(0, 8)}…`;
    }
    return JSON.stringify(redacted);
  }

  private formatBody(data: unknown): string {
    const str = typeof data === "string" ? data : JSON.stringify(data);
    return str.length > 2000 ? str.slice(0, 2000) + "…" : str;
  }

  private applyAuth(auth: RestAuth, headers: Record<string, string>): void {
    switch (auth.type) {
      case "bearer":
        headers["Authorization"] = `Bearer ${auth.token}`;
        break;
      case "basic": {
        const encoded = Buffer.from(`${auth.username}:${auth.password}`).toString("base64");
        headers["Authorization"] = `Basic ${encoded}`;
        break;
      }
      case "api-key":
        headers[auth.header] = auth.value;
        break;
      case "cookie":
        headers["Cookie"] = `${auth.name}=${auth.value}`;
        break;
      case "cookie-header":
        headers["Cookie"] = auth.value;
        break;
      case "none":
        break;
    }
  }
}
