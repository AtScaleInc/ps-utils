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
    const sql = connection.sql ?? connection.jdbc ?? connection;
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

    const clientConfig: Record<string, any> = { host: server, port, database, user: username, password };
    if (sql.ssl === false) {
      clientConfig.ssl = false;
    } else if (dialect === "redshift") {
      clientConfig.ssl = { rejectUnauthorized: false };
    }

    this.logger?.verbose(`[SqlService] Connecting to ${dialect}: ${server}:${port}/${database}`);
    const client = new PgClient(clientConfig);
    await client.connect();
    return { dialect, client };
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

    if (privateKeyPath || privateKeyBase64) {
      connConfig.authenticator = "SNOWFLAKE_JWT";
      connConfig.privateKey = privateKeyPath
        ? this.readPrivateKeyAsPem(privateKeyPath)
        : Buffer.from(privateKeyBase64!, "base64").toString("utf8");
      if (userEntry?.privateKeyPassword) {
        connConfig.privateKeyPass = userEntry.privateKeyPassword;
      }
    } else if (password) {
      connConfig.password = password;
    } else {
      throw new Error("Snowflake connection requires a password or private key.");
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
      await connection.client.end();
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
