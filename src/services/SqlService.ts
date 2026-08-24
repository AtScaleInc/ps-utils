/**
 * Native SQL service supporting Postgres, Redshift, and Snowflake
 * without a JVM dependency.
 */
import { Client as PgClient } from "pg";
import type { Client as PgClientType } from "pg";
import snowflake from "snowflake-sdk";
import type { Connection as SnowflakeConnection } from "snowflake-sdk";
import path from "path";
import fs from "fs";
import net from "net";
import { createPrivateKey } from "crypto";
import { ServiceProvider } from "./ServiceProvider.js";
import type { Logger } from "../logging.js";

// ── Public types ──────────────────────────────────────────────────────────────

export type SqlConnection =
  | { dialect: "postgres"; client: PgClientType }
  | { dialect: "redshift"; client: PgClientType }
  | { dialect: "snowflake"; connection: SnowflakeConnection };

export type ConnectionConfig = {
  connections?: Record<string, any>;
  users?: Record<string, any>;
  [key: string]: any;
};

// ── SqlService ────────────────────────────────────────────────────────────────

export class SqlService extends ServiceProvider {
  name = "sql";
  private logger: Logger | undefined;

  constructor(logger?: Logger) {
    super();
    this.logger = logger;
  }

  // ── connect ───────────────────────────────────────────────────────────────

  async connect(
    config: ConnectionConfig,
    connectionName: string,
    connectionUser?: string,
  ): Promise<SqlConnection> {
    const { connection, users } = this.resolveConnectionEntry(config, connectionName);
    const sql = connection.sql ?? connection;
    const dialect: string = sql.dialect ?? "postgres";

    if (dialect === "postgres" || dialect === "redshift") {
      return this.connectPostgres(dialect as "postgres" | "redshift", sql, users, connectionUser);
    }
    if (dialect === "snowflake") {
      return this.connectSnowflake(sql, users, connectionUser);
    }
    throw new Error(
      `Unsupported SQL dialect: '${dialect}'. Supported dialects: postgres, redshift, snowflake.`,
    );
  }

  private async connectPostgres(
    dialect: "postgres" | "redshift",
    sql: Record<string, any>,
    users: Record<string, any>,
    connectionUser?: string,
  ): Promise<SqlConnection> {
    const userEntry = this.resolveUserEntry(users, sql.user ?? sql.username, connectionUser);
    const server = sql.server;
    const port = Number(sql.port ?? (dialect === "redshift" ? 5439 : 5432));
    const database = sql.database;
    const username = userEntry?.username ?? sql.username;
    const password = userEntry?.password ?? sql.password;

    if (!server || !database) {
      throw new Error(`${dialect} connection requires 'server' and 'database'.`);
    }

    const timeoutMs = sql.connectionTimeoutMillis ?? 15_000;

    // ssl parameter (postgres only):
    //   false / "false" — disable SSL entirely
    //   true  / "true"  — enable SSL; rejectUnauthorized: false (accepts self-signed certs)
    //   "default" or omitted — let pg negotiate (tries SSL, falls back to plain)
    // Redshift always requires SSL regardless of the ssl setting.
    const rawSsl = sql.ssl;
    const sslDisabled = rawSsl === false || rawSsl === "false";
    const sslEnabled  = rawSsl === true  || rawSsl === "true";

    const sslMode = sslDisabled
      ? "disabled"
      : sslEnabled
        ? "enabled"
        : dialect === "redshift"
          ? "enabled (redshift)"
          : "default (negotiated)";

    this.logger?.verbose(
      `[SqlService] Connecting to ${dialect}: ${server}:${port}/${database}` +
      `  user=${username ?? "(none)"}  ssl=${sslMode}` +
      `  timeout=${timeoutMs}ms`,
    );

    // TCP-level probe: verify the port is reachable before handing off to pg.
    // This distinguishes a TCP timeout (network/firewall) from a Postgres
    // handshake hang (protocol issue after the socket is established).
    await this.probeTcp(server, port, timeoutMs).then(
      (ms) => this.logger?.verbose(`[SqlService] TCP probe OK (${ms}ms): ${server}:${port}`),
      (err) => {
        this.logger?.verbose(`[SqlService] TCP probe FAILED: ${server}:${port} — ${err.message}`);
        throw err;
      },
    );

    // Raw Postgres startup probe: send a minimal startup message on a separate
    // socket and read the first response byte. Diagnoses what the server speaks
    // before handing control to pg, and detects the AtScale "SSL dance required"
    // behaviour (server responds 'N' to a startup message).
    const probeUser = username ?? "postgres";
    let probeFirstByte: string | undefined;
    await this.probePostgresStartup(server, port, probeUser, database, timeoutMs).then(
      ({ byte, hex }) => {
        probeFirstByte = byte;
        // 'N' (0x4e) here is NOT a Postgres NoticeResponse. In this position it
        // is the SSL-negotiation "No SSL" byte, meaning the server sent its
        // SSLRequest rejection in response to our startup message. This happens
        // when the server requires the SSL negotiation handshake to occur first,
        // even when SSL is not actually used.
        const meaning =
          byte === "R" ? "AuthenticationRequest — server is Postgres, auth required" :
          byte === "E" ? "ErrorResponse — server is Postgres, startup rejected" :
          byte === "N" ? "SSL 'No' byte — server requires SSL negotiation before startup message" :
          `0x${hex} — unexpected; server may not speak standard Postgres protocol`;
        this.logger?.verbose(
          `[SqlService] Startup probe: server responded '${byte}' (${hex}) — ${meaning}`,
        );
      },
      (err) => {
        this.logger?.verbose(`[SqlService] Startup probe FAILED: ${err.message}`);
        // Don't throw — let pg attempt the connection and surface its own error.
      },
    );

    const clientConfig: Record<string, any> = {
      host: server, port, database, user: username, password,
      connectionTimeoutMillis: timeoutMs,
      // No-op type parser prevents pg from issuing pg_catalog.pg_type queries
      // after connecting. AtScale's Postgres-compatible proxy may not support
      // catalog access, which would cause the first query to hang.
      types: {
        getTypeParser: () => (val: string) => val,
      },
    };

    if (sslDisabled) {
      clientConfig.ssl = false;
    } else if (sslEnabled || dialect === "redshift") {
      clientConfig.ssl = { rejectUnauthorized: false };
    }

    // AtScale's SQL analytics port requires the SSL negotiation handshake to
    // happen before it will accept a startup message — even when SSL is not
    // actually used. We detect this by the 'N' response above and work around
    // it by performing the SSLRequest/N exchange on a raw socket, then passing
    // the pre-negotiated socket directly to pg so pg skips its own TCP+SSL
    // setup and sends the startup message on the already-open socket.
    if (probeFirstByte === "N" && sslDisabled) {
      this.logger?.verbose(
        `[SqlService] Server requires SSL negotiation before startup — pre-negotiating plain-text socket`,
      );
      let preSocket: net.Socket | undefined;
      try {
        preSocket = await this.preNegotiateSslPlaintext(server, port, timeoutMs);
        this.logger?.verbose(`[SqlService] SSL pre-negotiation complete (plain-text mode)`);
        // Pass the pre-negotiated socket as pg's transport. pg will skip its own
        // TCP connect + SSLRequest phase and go straight to the startup message.
        (clientConfig as any).stream = preSocket;
        // ssl must be false so pg does not attempt another SSL handshake on the stream.
        clientConfig.ssl = false;
      } catch (preErr) {
        const msg = preErr instanceof Error ? preErr.message : String(preErr);
        this.logger?.verbose(`[SqlService] SSL pre-negotiation failed: ${msg} — falling back to direct connection`);
        preSocket?.destroy();
        delete (clientConfig as any).stream;
      }
    }

    this.logger?.verbose(`[SqlService] Starting Postgres handshake: ${server}:${port}/${database}`);
    const client = new PgClient(clientConfig);
    try {
      await client.connect();
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this.logger?.verbose(`[SqlService] Postgres handshake failed: ${msg}`);
      throw err;
    }
    this.logger?.verbose(`[SqlService] Postgres handshake complete: ${server}:${port}/${database}`);
    return { dialect, client };
  }

  /**
   * Opens a TCP connection, sends a Postgres SSLRequest, waits for the server's
   * single-byte response ('N' = no SSL accepted), and returns the raw socket
   * ready for plain-text Postgres protocol.
   *
   * This is needed for servers (like AtScale's SQL analytics port) that require
   * the SSL negotiation handshake before they will accept a startup message,
   * even when SSL is not actually used.
   */
  private preNegotiateSslPlaintext(
    host: string,
    port: number,
    timeoutMs: number,
  ): Promise<net.Socket> {
    return new Promise((resolve, reject) => {
      const socket = new net.Socket();
      let settled = false;
      const fail = (err: Error) => {
        if (settled) return;
        settled = true;
        socket.destroy();
        reject(err);
      };
      socket.setTimeout(timeoutMs);
      socket.once("timeout", () => fail(new Error(`SSL pre-negotiation timed out after ${timeoutMs}ms`)));
      socket.once("error", fail);
      socket.once("connect", () => {
        // SSLRequest: length=8, then the SSL magic number 80877103.
        const req = Buffer.allocUnsafe(8);
        req.writeInt32BE(8, 0);
        req.writeInt32BE(80877103, 4);
        socket.write(req);
        socket.once("data", (chunk) => {
          if (settled) return;
          const byte = chunk.length > 0 ? (chunk[0] as number) : -1;
          if (byte === 78) { // 'N' — no SSL, socket is now ready for plain Postgres
            settled = true;
            socket.removeAllListeners("timeout");
            socket.removeAllListeners("error");
            resolve(socket);
          } else if (byte === 83) { // 'S' — server wants to upgrade to TLS
            fail(new Error(`Server at ${host}:${port} requires TLS; set ssl:true in the connection config`));
          } else {
            fail(new Error(
              `Unexpected SSL negotiation response from ${host}:${port}: ` +
              `0x${byte >= 0 ? byte.toString(16).padStart(2, "0") : "??"}`,
            ));
          }
        });
      });
      socket.connect(port, host);
    });
  }

  /**
   * Opens a raw TCP socket to host:port and resolves with the elapsed
   * milliseconds, or rejects with an error if the connection cannot be
   * established within timeoutMs.
   */
  private probeTcp(host: string, port: number, timeoutMs: number): Promise<number> {
    return new Promise((resolve, reject) => {
      const start = Date.now();
      const socket = new net.Socket();
      const cleanup = (err?: Error) => {
        socket.destroy();
        if (err) reject(err);
        else resolve(Date.now() - start);
      };
      socket.setTimeout(timeoutMs);
      socket.once("connect", () => cleanup());
      socket.once("timeout", () => cleanup(new Error(`TCP connect timed out after ${timeoutMs}ms`)));
      socket.once("error", (err) => cleanup(err));
      socket.connect(port, host);
    });
  }

  /**
   * Sends a minimal Postgres startup message over a raw socket and reads the
   * first response byte. Used to diagnose whether the server speaks Postgres
   * at all, before handing the connection to the pg library.
   *
   * Response byte meanings:
   *   'R' (0x52) — AuthenticationRequest — server is Postgres, expects auth
   *   'E' (0x45) — ErrorResponse         — server is Postgres, rejected startup
   *   'N' (0x4E) — NoticeResponse        — server is Postgres, sent a notice
   *   other / none                       — server is NOT speaking Postgres protocol
   */
  private probePostgresStartup(
    host: string,
    port: number,
    username: string,
    database: string,
    timeoutMs: number,
  ): Promise<{ byte: string; hex: string }> {
    return new Promise((resolve, reject) => {
      const socket = new net.Socket();
      let resolved = false;

      const done = (result?: { byte: string; hex: string }, err?: Error) => {
        if (resolved) return;
        resolved = true;
        socket.destroy();
        if (err) reject(err);
        else resolve(result!);
      };

      socket.setTimeout(timeoutMs);
      socket.once("timeout", () => done(undefined, new Error(`startup probe timed out after ${timeoutMs}ms (server not responding to Postgres startup message)`)));
      socket.once("error", (err) => done(undefined, err));

      socket.once("connect", () => {
        // Build a minimal Postgres v3.0 startup message.
        const params = [
          "user", username,
          "database", database,
          "application_name", "atscale-probe",
        ];
        const body = Buffer.from(
          params.map((s) => s + "\0").join("") + "\0",
          "binary",
        );
        // protocol version 3.0 = 196608 = 0x00030000
        const msg = Buffer.allocUnsafe(8 + body.length);
        msg.writeInt32BE(8 + body.length, 0); // total length
        msg.writeInt32BE(196608, 4);           // protocol 3.0
        body.copy(msg, 8);
        socket.write(msg);

        socket.once("data", (chunk) => {
          const val  = chunk.length > 0 ? (chunk[0] as number) : -1;
          const byte = val >= 0 ? String.fromCharCode(val) : "?";
          const hex  = val >= 0 ? `0x${val.toString(16).padStart(2, "0")}` : "0x??";
          done({ byte, hex });
        });
      });

      socket.connect(port, host);
    });
  }

  private async connectSnowflake(
    sql: Record<string, any>,
    users: Record<string, any>,
    connectionUser?: string,
  ): Promise<SqlConnection> {
    const userKey = sql.snowflake_user ?? sql.user ?? sql.username;
    const userEntry = this.resolveUserEntry(users, userKey, connectionUser);
    const username = userEntry?.username ?? (typeof userKey === "string" && !users[userKey] ? userKey : undefined);
    const password = userEntry?.password ?? sql.password;
    const { account, warehouse, database, schema, role } = sql;

    const missing = (["account", "warehouse", "database", "schema"] as const).filter((f) => !sql[f]);
    if (missing.length > 0) {
      throw new Error(`Snowflake connection missing required field(s): ${missing.join(", ")}.`);
    }
    if (!username) {
      throw new Error("Snowflake connection requires a username.");
    }

    const connConfig: Record<string, any> = { account, username, warehouse, database, schema };
    if (role) connConfig.role = role;

    // Private key auth
    const privateKeyPath = userEntry?.privateKeyPath
      ? path.isAbsolute(userEntry.privateKeyPath)
        ? userEntry.privateKeyPath
        : path.resolve(process.cwd(), userEntry.privateKeyPath)
      : undefined;
    const privateKeyBase64 = userEntry?.privateKeyBase64?.replace(/\s+/g, "");

    // Programmatic Access Token (PAT) auth — a password-replacement token
    // generated in Snowsight (User → Programmatic Access Tokens) that doesn't
    // require MFA or a key-pair to be assigned to the user. Takes priority
    // over a plain password when both are present, but yields to key-pair
    // auth so existing JWT-based connections keep working unchanged.
    const token = userEntry?.token ?? userEntry?.pat;

    if (privateKeyPath || privateKeyBase64) {
      connConfig.authenticator = "SNOWFLAKE_JWT";
      connConfig.privateKey = privateKeyPath
        ? this.readPrivateKeyAsPem(privateKeyPath)
        : Buffer.from(privateKeyBase64!, "base64").toString("utf8");
      if (userEntry?.privateKeyPassword) {
        connConfig.privateKeyPass = userEntry.privateKeyPassword;
      }
    } else if (token) {
      connConfig.authenticator = "PROGRAMMATIC_ACCESS_TOKEN";
      connConfig.token = token;
    } else if (password) {
      connConfig.password = password;
    } else {
      throw new Error(
        "Snowflake connection requires a password, private key, or programmatic access token (PAT).",
      );
    }

    this.logger?.verbose(`[SqlService] Connecting to Snowflake: ${account}/${database}/${schema}`);
    const connection = snowflake.createConnection(connConfig as any);
    await new Promise<void>((resolve, reject) => {
      connection.connect((err) => {
        if (err) reject(err);
        else resolve();
      });
    });
    return { dialect: "snowflake", connection };
  }

  // ── query ─────────────────────────────────────────────────────────────────

  async query(connection: SqlConnection, sql: string, params: unknown[] = []): Promise<any[]> {
    this.logger?.verbose(`[SQL] ${sql.trim()}`);
    if (connection.dialect === "postgres" || connection.dialect === "redshift") {
      const result = await connection.client.query(sql, params.length ? (params as any[]) : undefined);
      return result.rows;
    }
    return new Promise<any[]>((resolve, reject) => {
      connection.connection.execute({
        sqlText: sql,
        binds: params.length ? (params as any[]) : undefined,
        complete: (err: any, _stmt: any, rows: any[] | undefined) => {
          if (err) reject(err);
          else resolve(rows ?? []);
        },
      });
    });
  }

  // ── execute ───────────────────────────────────────────────────────────────

  async execute(connection: SqlConnection, sql: string): Promise<number> {
    this.logger?.verbose(`[SQL] ${sql.trim()}`);
    if (connection.dialect === "postgres" || connection.dialect === "redshift") {
      const result = await connection.client.query(sql);
      return result.rowCount ?? 0;
    }
    return new Promise<number>((resolve, reject) => {
      connection.connection.execute({
        sqlText: sql,
        complete: (err: any, stmt: any) => {
          if (err) reject(err);
          else resolve(stmt?.getNumRowsAffected?.() ?? 0);
        },
      });
    });
  }

  // ── close ─────────────────────────────────────────────────────────────────

  async close(connection: SqlConnection): Promise<void> {
    if (connection.dialect === "postgres" || connection.dialect === "redshift") {
      // client.end() sends the Postgres Terminate message, but the server may
      // never send the corresponding close (especially AtScale's SQL proxy).
      // Race it against a short timeout so we never hang here, then
      // unconditionally destroy the underlying socket.
      await Promise.race([
        connection.client.end().catch(() => {}),
        new Promise<void>((resolve) => setTimeout(resolve, 1_000)),
      ]);
      const stream = (connection.client as any).connection?.stream;
      if (stream && typeof stream.destroy === "function") {
        stream.destroy();
      }
      return;
    }
    await new Promise<void>((resolve, reject) => {
      connection.connection.destroy((err: any) => {
        if (err) reject(err);
        else resolve();
      });
    });
  }

  // ── metadata ──────────────────────────────────────────────────────────────

  async getSchemas(connection: SqlConnection): Promise<any[]> {
    return this.query(
      connection,
      "SELECT schema_name FROM information_schema.schemata ORDER BY schema_name",
    );
  }

  async getTables(
    connection: SqlConnection,
    schema?: string,
    tablePattern = "%",
    types = ["TABLE"],
  ): Promise<any[]> {
    // INFORMATION_SCHEMA uses 'BASE TABLE' for regular tables; accept 'TABLE' as a shorthand.
    const mappedTypes = types.map((t) => (t === "TABLE" ? "BASE TABLE" : t));
    const typeList = mappedTypes.map((t) => `'${this.esc(t)}'`).join(", ");
    const schemaClause = schema ? `AND table_schema = '${this.esc(schema)}'` : "";
    return this.query(
      connection,
      `SELECT table_name  AS TABLE_NAME,
              table_schema AS TABLE_SCHEM,
              table_type   AS TABLE_TYPE
       FROM   information_schema.tables
       WHERE  table_name LIKE '${this.esc(tablePattern)}'
         AND  table_type IN (${typeList})
         ${schemaClause}
       ORDER BY table_name`,
    );
  }

  async getViews(connection: SqlConnection, schema?: string, viewPattern = "%"): Promise<any[]> {
    const schemaClause = schema ? `AND table_schema = '${this.esc(schema)}'` : "";
    return this.query(
      connection,
      `SELECT table_name       AS TABLE_NAME,
              view_definition  AS VIEW_DEFINITION
       FROM   information_schema.views
       WHERE  table_name LIKE '${this.esc(viewPattern)}'
         ${schemaClause}
       ORDER BY table_name`,
    );
  }

  async getColumns(
    connection: SqlConnection,
    schema?: string,
    tablePattern = "%",
    columnPattern = "%",
  ): Promise<any[]> {
    const schemaClause = schema ? `AND table_schema = '${this.esc(schema)}'` : "";
    return this.query(
      connection,
      `SELECT table_name        AS TABLE_NAME,
              column_name       AS COLUMN_NAME,
              data_type         AS TYPE_NAME,
              COALESCE(character_maximum_length, numeric_precision, 0) AS COLUMN_SIZE,
              ordinal_position  AS ORDINAL_POSITION,
              CASE WHEN is_nullable = 'YES' THEN 1 ELSE 0 END AS NULLABLE
       FROM   information_schema.columns
       WHERE  table_name   LIKE '${this.esc(tablePattern)}'
         AND  column_name  LIKE '${this.esc(columnPattern)}'
         ${schemaClause}
       ORDER BY table_name, ordinal_position`,
    );
  }

  async getForeignKeys(
    connection: SqlConnection,
    schema?: string,
    tablePattern = "%",
  ): Promise<any[]> {
    if (connection.dialect === "snowflake") {
      return this.getForeignKeysSnowflake(connection, schema, tablePattern);
    }
    return this.getForeignKeysPg(connection, schema, tablePattern);
  }

  private async getForeignKeysPg(
    connection: SqlConnection,
    schema?: string,
    tablePattern = "%",
  ): Promise<any[]> {
    const schemaClause = schema ? `AND tc.table_schema = '${this.esc(schema)}'` : "";
    return this.query(
      connection,
      `SELECT kcu.table_name  AS FKTABLE_NAME,
              kcu.column_name AS FKCOLUMN_NAME,
              ccu.table_name  AS PKTABLE_NAME,
              ccu.column_name AS PKCOLUMN_NAME,
              kcu.position_in_unique_constraint AS KEY_SEQ,
              tc.constraint_name AS FK_NAME
       FROM   information_schema.table_constraints        tc
       JOIN   information_schema.key_column_usage         kcu
              ON  tc.constraint_name = kcu.constraint_name
              AND tc.table_schema    = kcu.table_schema
       JOIN   information_schema.constraint_column_usage  ccu
              ON  ccu.constraint_name = tc.constraint_name
              AND ccu.table_schema    = tc.table_schema
       WHERE  tc.constraint_type = 'FOREIGN KEY'
         AND  kcu.table_name LIKE '${this.esc(tablePattern)}'
         ${schemaClause}
       ORDER BY kcu.table_name, kcu.ordinal_position`,
    );
  }

  private async getForeignKeysSnowflake(
    connection: SqlConnection,
    schema?: string,
    tablePattern = "%",
  ): Promise<any[]> {
    try {
      const schemaClause = schema ? `AND kcu.table_schema = '${this.esc(schema)}'` : "";
      return await this.query(
        connection,
        `SELECT kcu.table_name  AS FKTABLE_NAME,
                kcu.column_name AS FKCOLUMN_NAME,
                kcu2.table_name AS PKTABLE_NAME,
                kcu2.column_name AS PKCOLUMN_NAME,
                kcu.position_in_unique_constraint AS KEY_SEQ,
                rc.constraint_name AS FK_NAME
         FROM   information_schema.referential_constraints rc
         JOIN   information_schema.key_column_usage kcu
                ON  kcu.constraint_name   = rc.constraint_name
                AND kcu.constraint_schema = rc.constraint_schema
         JOIN   information_schema.key_column_usage kcu2
                ON  kcu2.constraint_name   = rc.unique_constraint_name
                AND kcu2.constraint_schema = rc.unique_constraint_schema
                AND kcu2.ordinal_position  = kcu.position_in_unique_constraint
         WHERE  kcu.table_name LIKE '${this.esc(tablePattern)}'
           ${schemaClause}
         ORDER BY kcu.table_name, kcu.ordinal_position`,
      );
    } catch {
      return [];
    }
  }

  // ── private helpers ───────────────────────────────────────────────────────

  /** Escape single quotes for SQL string literals. */
  private esc(value: string): string {
    return value.replace(/'/g, "''");
  }

  private resolveConnectionEntry(
    config: ConnectionConfig,
    connectionName: string,
  ): { connection: Record<string, any>; users: Record<string, any> } {
    const connections = config.connections ?? {};
    const connection = connections[connectionName] ?? config[connectionName];
    if (!connection) {
      throw new Error(`Connection not found: '${connectionName}'`);
    }
    return { connection, users: config.users ?? {} };
  }

  private resolveUserEntry(
    users: Record<string, any>,
    userKey?: string,
    connectionUser?: string,
  ): Record<string, any> | undefined {
    if (userKey && users[userKey]) return users[userKey];
    if (connectionUser && users[connectionUser]) return users[connectionUser];
    return undefined;
  }

  private readPrivateKeyAsPem(filePath: string): string {
    const raw = fs.readFileSync(filePath);
    const text = raw.toString("utf8");
    let keyObject;
    try {
      keyObject = text.includes("BEGIN")
        ? createPrivateKey({ key: text, format: "pem" })
        : createPrivateKey({ key: raw, format: "der", type: "pkcs8" });
    } catch {
      keyObject = createPrivateKey({ key: raw, format: "der", type: "pkcs8" });
    }
    return keyObject.export({ format: "pem", type: "pkcs8" }) as string;
  }
}
