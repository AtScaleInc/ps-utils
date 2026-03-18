/**
 * JDBC-based SQL service for Snowflake and Postgres connections.
 */
import Jdbc from "jdbc";
import jinst from "jdbc/lib/jinst.js";
import path from "path";
import fs from "fs";
import { fileURLToPath } from "url";
import { createPrivateKey, createHash } from "crypto";
import { ServiceProvider } from "./ServiceProvider.js";

export type JdbcConfig = {
  url: string;
  drivername: string;
  properties?: Record<string, string>;
  libpath?: string | string[];
  user?: string;
  password?: string;
  minpoolsize?: number;
  maxpoolsize?: number;
};

export type SqlConnection = {
  jdbc: any;
  conn: any;
};

export type ConnectionConfig = {
  connections?: Record<string, any>;
  users?: Record<string, any>;
  [key: string]: any;
};

/**
 * SQL service wrapper around the `jdbc` npm package.
 */
export class SqlService extends ServiceProvider {
  name = "sql";

  private defaultDrivers = this.getDefaultDriverPaths();

  constructor() {
    super();
  }

  async connect(
    config: ConnectionConfig,
    connectionName: string,
    connectionUser?: string
  ): Promise<SqlConnection> {
    const jdbcConfig = this.buildJdbcConfig(config, connectionName, connectionUser);
    this.debugJdbcConfig(jdbcConfig);
    this.ensureClasspath(jdbcConfig.libpath);
    const jdbc = new Jdbc(jdbcConfig);

    await new Promise<void>((resolve, reject) => {
      jdbc.initialize((err: Error | null) => {
        if (err) {
          reject(err);
          return;
        }
        resolve();
      });
    });

    const conn = await new Promise<any>((resolve, reject) => {
      jdbc.reserve((err: Error | null, connObj: any) => {
        if (err) {
          reject(err);
          return;
        }
        resolve(connObj);
      });
    });

    return { jdbc, conn };
  }

  async query(connection: SqlConnection, sql: string, params: unknown[] = []): Promise<any[]> {
    const { conn } = connection;
    const statement = await new Promise<any>((resolve, reject) => {
      conn.conn.createStatement((err: Error | null, stmt: any) => {
        if (err) {
          reject(err);
          return;
        }
        resolve(stmt);
      });
    });

    const result = await new Promise<any[]>((resolve, reject) => {
      if (params.length > 0 && statement.executeQuery) {
        statement.executeQuery(sql, params, (err: Error | null, rs: any) => {
          if (err) {
            reject(err);
            return;
          }
          rs.toObjArray((err2: Error | null, rows: any[]) => {
            if (err2) {
              reject(err2);
              return;
            }
            resolve(rows);
          });
        });
        return;
      }

      statement.executeQuery(sql, (err: Error | null, rs: any) => {
        if (err) {
          reject(err);
          return;
        }
        rs.toObjArray((err2: Error | null, rows: any[]) => {
          if (err2) {
            reject(err2);
            return;
          }
          resolve(rows);
        });
      });
    });

    return result;
  }

  async getSchemas(connection: SqlConnection): Promise<any[]> {
    const meta = await this.getMetadata(connection);
    return new Promise<any[]>((resolve, reject) => {
      meta.getSchemas((err: Error | null, rs: any) => {
        if (err) {
          reject(err);
          return;
        }
        rs.toObjArray((err2: Error | null, rows: any[]) => {
          if (err2) {
            reject(err2);
            return;
          }
          resolve(rows);
        });
      });
    });
  }

  async getTables(
    connection: SqlConnection,
    schema?: string,
    tablePattern: string = "%",
    types: string[] = ["TABLE"]
  ): Promise<any[]> {
    const meta = await this.getMetadata(connection);
    return new Promise<any[]>((resolve, reject) => {
      meta.getTables(null, schema ?? null, tablePattern, types, (err: Error | null, rs: any) => {
        if (err) {
          reject(err);
          return;
        }
        rs.toObjArray((err2: Error | null, rows: any[]) => {
          if (err2) {
            reject(err2);
            return;
          }
          resolve(rows);
        });
      });
    });
  }

  async getViews(connection: SqlConnection, schema?: string, viewPattern: string = "%"): Promise<any[]> {
    return this.getTables(connection, schema, viewPattern, ["VIEW"]);
  }

  async getColumns(
    connection: SqlConnection,
    schema?: string,
    tablePattern: string = "%",
    columnPattern: string = "%"
  ): Promise<any[]> {
    const meta = await this.getMetadata(connection);
    return new Promise<any[]>((resolve, reject) => {
      meta.getColumns(null, schema ?? null, tablePattern, columnPattern, (err: Error | null, rs: any) => {
        if (err) {
          reject(err);
          return;
        }
        rs.toObjArray((err2: Error | null, rows: any[]) => {
          if (err2) {
            reject(err2);
            return;
          }
          resolve(rows);
        });
      });
    });
  }

  async getForeignKeys(
    connection: SqlConnection,
    schema?: string,
    tablePattern: string = "%"
  ): Promise<any[]> {
    const meta = await this.getMetadata(connection);
    return new Promise<any[]>((resolve, reject) => {
      meta.getImportedKeys(null, schema ?? null, tablePattern, (err: Error | null, rs: any) => {
        if (err) {
          reject(err);
          return;
        }
        rs.toObjArray((err2: Error | null, rows: any[]) => {
          if (err2) {
            reject(err2);
            return;
          }
          resolve(rows);
        });
      });
    });
  }

  /**
   * Execute a single SQL statement that does not return rows (DDL, DML).
   * Returns the update count (0 for DDL, N for INSERT/UPDATE/DELETE).
   * Use `query()` for SELECT statements.
   */
  async execute(connection: SqlConnection, sql: string): Promise<number> {
    const { conn } = connection;
    const statement = await new Promise<any>((resolve, reject) => {
      conn.conn.createStatement((err: Error | null, stmt: any) => {
        if (err) reject(err);
        else resolve(stmt);
      });
    });

    const isQuery = /^\s*select\b/i.test(sql);

    if (isQuery) {
      return new Promise<number>((resolve, reject) => {
        statement.executeQuery(sql, (err: Error | null, _rs: any) => {
          if (err) reject(err);
          else resolve(0);
        });
      });
    }

    return new Promise<number>((resolve, reject) => {
      statement.executeUpdate(sql, (err: Error | null, updateCount: number) => {
        if (err) reject(err);
        else resolve(updateCount ?? 0);
      });
    });
  }

  async close(connection: SqlConnection): Promise<void> {
    const { jdbc, conn } = connection;
    await new Promise<void>((resolve, reject) => {
      jdbc.release(conn, (err: Error | null) => {
        if (err) {
          reject(err);
          return;
        }
        resolve();
      });
    });
  }

  private async getMetadata(connection: SqlConnection): Promise<any> {
    return new Promise<any>((resolve, reject) => {
      connection.conn.conn.getMetaData((err: Error | null, meta: any) => {
        if (err) {
          reject(err);
          return;
        }
        resolve(meta);
      });
    });
  }

  private buildJdbcConfig(
    config: ConnectionConfig,
    connectionName: string,
    connectionUser?: string
  ): JdbcConfig {
    const connections = config.connections ?? {};
    const connection = connections[connectionName] ?? config[connectionName];
    if (!connection) {
      throw new Error(`Connection not found: ${connectionName}`);
    }

    const users = config.users ?? {};
    const userConfig = connectionUser ? users[connectionUser] : undefined;

    const jdbc = connection.jdbc ?? connection.sql ?? connection;
    if (!jdbc) {
      throw new Error("JDBC connection requires configuration.");
    }

    const { url, drivername, properties, user, password, libpath } = this.normalizeJdbcConfig(
      config,
      jdbc,
      userConfig
    );

    if (!url || !drivername) {
      throw new Error("JDBC connection requires url and drivername.");
    }

    const resolvedProperties: Record<string, string> = {};
    for (const [key, value] of Object.entries(properties ?? {})) {
      if (value !== undefined && value !== null) {
        resolvedProperties[key] = String(value);
      }
    }

    if (user) {
      resolvedProperties.user = user;
    }
    if (password) {
      resolvedProperties.password = password;
    }

    return {
      url,
      drivername,
      properties: resolvedProperties,
      libpath: this.normalizeLibpath(libpath ?? jdbc.libpath),
      minpoolsize: jdbc.minpoolsize,
      maxpoolsize: jdbc.maxpoolsize,
    };
  }

  private normalizeJdbcConfig(
    config: ConnectionConfig,
    jdbc: Record<string, any>,
    userConfig?: Record<string, any>
  ): {
    url?: string;
    drivername?: string;
    properties?: Record<string, string>;
    user?: string;
    password?: string;
    libpath?: string;
  } {
    if (jdbc.url && jdbc.drivername) {
      return {
        url: jdbc.url,
        drivername: jdbc.drivername,
        properties: jdbc.properties,
        user: userConfig?.username ?? jdbc.user ?? jdbc.username,
        password: userConfig?.password ?? jdbc.password,
        libpath: jdbc.libpath,
      };
    }

    if (jdbc.dialect === "postgres") {
      const server = jdbc.server;
      const port = jdbc.port ?? 5432;
      const database = jdbc.database;
      const schema = jdbc.schema;
      if (!server || !database) {
        throw new Error("Postgres JDBC config requires server and database.");
      }

      const schemaParam = schema ? `?currentSchema=${schema}` : "";
      return {
        url: `jdbc:postgresql://${server}:${port}/${database}${schemaParam}`,
        drivername: "org.postgresql.Driver",
        user: userConfig?.username ?? jdbc.user ?? jdbc.username,
        password: userConfig?.password ?? jdbc.password,
        libpath: jdbc.libpath,
      };
    }

    if (jdbc.dialect === "snowflake") {
      const account = jdbc.account;
      const warehouse = jdbc.warehouse;
      const database = jdbc.database;
      const schema = jdbc.schema;
      const role = jdbc.role;
      const authenticator = jdbc.authenticator;
      const userKey = jdbc.snowflake_user;

      const missing: string[] = [];
      if (!account) missing.push("account");
      if (!warehouse) missing.push("warehouse");
      if (!database) missing.push("database");
      if (!schema) missing.push("schema");
      if (missing.length > 0) {
        throw new Error(
          `Snowflake JDBC config missing required field(s): ${missing.join(", ")}.`
        );
      }

      const snowUser = userKey ? (config.users ?? {})[userKey] : userConfig;
      const username = snowUser?.username ?? userConfig?.username ?? jdbc.user ?? jdbc.username;
      if (!username) {
        throw new Error("Snowflake JDBC config requires a username.");
      }

      const params: Record<string, string> = {
        warehouse,
        db: database,
        schema,
      };
      if (role) {
        params.role = role;
      }
      if (authenticator) {
        params.authenticator = authenticator;
      }

      const paramString = Object.entries(params)
        .map(([key, value]) => `${key}=${encodeURIComponent(value)}`)
        .join("&");

      const resolvedKeyPath = snowUser?.privateKeyPath
        ? (path.isAbsolute(snowUser.privateKeyPath)
            ? snowUser.privateKeyPath
            : path.resolve(process.cwd(), snowUser.privateKeyPath))
        : undefined;

      const providedKeyBase64 = snowUser?.privateKeyBase64
        ? snowUser.privateKeyBase64.replace(/\s+/g, "")
        : undefined;

      const privateKeyBase64 =
        providedKeyBase64 ??
        (resolvedKeyPath ? this.readPrivateKeyAsPkcs8Base64(resolvedKeyPath) : undefined);

      const resolvedAuthenticator =
        authenticator ?? (resolvedKeyPath || privateKeyBase64 ? "SNOWFLAKE_JWT" : undefined);

      return {
        url: `jdbc:snowflake://${account}.snowflakecomputing.com/?${paramString}`,
        drivername: "net.snowflake.client.jdbc.SnowflakeDriver",
        user: username,
        password: snowUser?.password ?? userConfig?.password ?? jdbc.password,
        properties: {
          ...(resolvedKeyPath ? { private_key_file: resolvedKeyPath } : {}),
          ...(privateKeyBase64 && !resolvedKeyPath ? { private_key_base64: privateKeyBase64 } : {}),
          ...(snowUser?.privateKeyPassword
            ? { private_key_pwd: snowUser.privateKeyPassword }
            : {}),
          ...(resolvedAuthenticator ? { authenticator: resolvedAuthenticator } : {}),
          ...(role ? { role } : {}),
        },
        libpath: jdbc.libpath,
      };
    }

    if (jdbc.dialect) {
      throw new Error(`Unsupported SQL dialect: ${jdbc.dialect}`);
    }

    return {
      url: jdbc.url,
      drivername: jdbc.drivername,
      properties: jdbc.properties,
      user: userConfig?.username ?? jdbc.user ?? jdbc.username,
      password: userConfig?.password ?? jdbc.password,
      libpath: jdbc.libpath,
    };
  }

  private getDefaultDriverPaths(): string[] {
    const __filename = fileURLToPath(import.meta.url);
    const __dirname = path.dirname(__filename);
    const driversDir = path.resolve(__dirname, "..", "..", "resources", "drivers");
    if (!fs.existsSync(driversDir)) return [];
    return fs
      .readdirSync(driversDir)
      .filter((f) => f.endsWith(".jar"))
      .map((f) => path.join(driversDir, f));
  }

  private ensureClasspath(libpath?: string | string[]): void {
    const normalized = this.normalizeLibpath(libpath);
    const defaults = this.defaultDrivers;
    const jars = [...(normalized ?? []), ...defaults].filter((jar) => fs.existsSync(jar));

    if (jinst.isJvmCreated()) {
      const allowed = new Set(defaults);
      const hasCustom = (normalized ?? []).some((entry) => !allowed.has(entry));
      if (hasCustom) {
        throw new Error(
          "JVM already created; cannot add custom JDBC driver to classpath. " +
            "Restart the process or use the default drivers in resources/drivers."
        );
      }
      return;
    }

    jinst.addOption("-Xrs");
    jinst.addOption("--add-opens=java.base/java.nio=ALL-UNNAMED");
    jinst.setupClasspath(jars);
  }

  private normalizeLibpath(libpath?: string | string[]): string[] | undefined {
    if (!libpath) {
      return undefined;
    }
    if (Array.isArray(libpath)) {
      return libpath;
    }
    return [libpath];
  }

  private debugJdbcConfig(config: JdbcConfig): void {
    const safeProps: Record<string, string> = {};
    for (const [key, value] of Object.entries(config.properties ?? {})) {
      if (key.includes("private") || key.includes("password")) {
        safeProps[key] = "<redacted>";
      } else {
        safeProps[key] = value;
      }
    }

    console.log("[SqlService] JDBC config:", {
      url: config.url,
      drivername: config.drivername,
      libpath: config.libpath,
      properties: safeProps,
    });

    const privateKey = config.properties?.private_key;
    if (privateKey) {
      console.log("[SqlService] private_key length:", privateKey.length);
    }
    const privateKeyFile = config.properties?.private_key_file;
    if (privateKeyFile) {
      const exists = fs.existsSync(privateKeyFile);
      const size = exists ? fs.statSync(privateKeyFile).size : 0;
      console.log("[SqlService] private_key_file:", privateKeyFile, "exists:", exists, "size:", size);
    }
  }

  private readPrivateKeyAsPkcs8Base64(filePath: string): string {
    const raw = fs.readFileSync(filePath);
    const text = raw.toString("utf8");
    let keyObject;

    try {
      if (text.includes("BEGIN")) {
        keyObject = createPrivateKey({ key: text, format: "pem" });
      } else {
        keyObject = createPrivateKey({ key: raw, format: "der", type: "pkcs8" });
      }
    } catch {
      keyObject = createPrivateKey({ key: raw, format: "der", type: "pkcs8" });
    }

    if (keyObject.asymmetricKeyType && keyObject.asymmetricKeyType !== "rsa") {
      throw new Error(`Unsupported private key type: ${keyObject.asymmetricKeyType}`);
    }

    const pem = Buffer.from(keyObject.export({ format: "pem", type: "pkcs8" }) as string);
    const hash = createHash("sha256").update(pem).digest("base64");
    console.log("[SqlService] private_key PEM sha256:", hash);
    return pem.toString("base64");
  }
}
