/**
 * ExtractDDLFromConnection
 *
 * Connects to a live database, reads JDBC metadata for each table in the
 * target schema, and writes the equivalent CREATE TABLE DDL to a file (or
 * stdout).
 *
 * Table filtering:
 *   --tables accepts a comma-separated list of table names or wildcard
 *   patterns.  '*' matches any sequence of characters; '?' matches exactly
 *   one character.  Matching is case-insensitive.
 *
 *   Examples:
 *     --tables "Dim*"                → all tables starting with "Dim"
 *     --tables "FactSales,FactReturns"
 *     --tables "Fact*,Dim*"
 */
import fs from "fs";
import path from "path";
import { Operation } from "../Operation.js";
import { ParameterSet, StringParameter } from "../Parameters.js";
import type { ServiceRegistry } from "../../services/registry.js";
import type { Logger } from "../../logging.js";
import { YamlService } from "../../services/YamlService.js";
import { SqlService, type ConnectionConfig, type SqlConnection } from "../../services/SqlService.js";

// ----------------------------------------------------------
// Parameters
// ----------------------------------------------------------

class ExtractDDLFromConnectionParams extends ParameterSet {
  parameters = [
    new (class extends StringParameter {
      name         = "connection-file";
      description  = "Path to the connections.yaml file";
      required     = false;
      defaultValue = "connections.yaml";
    })(),
    new (class extends StringParameter {
      name        = "connection-name";
      description = "Name of the connection entry in the connections.yaml file";
      required    = true;
    })(),
    new (class extends StringParameter {
      name        = "schema";
      description = "Database schema to introspect";
      required    = true;
    })(),
    new (class extends StringParameter {
      name        = "tables";
      description = 'Comma-separated list of table names or wildcard patterns to include (e.g. "Dim*,FactSales"). Omit to extract all tables.';
      required    = false;
    })(),
    new (class extends StringParameter {
      name        = "output-file";
      description = "Output file path for the DDL. Omit to print to stdout.";
      required    = false;
    })(),
  ];
}

type Params = {
  "connection-file": string;
  "connection-name": string;
  schema:            string;
  tables?:           string;
  "output-file"?:    string;
};

// ----------------------------------------------------------
// Wildcard matching
// ----------------------------------------------------------

/** Convert a glob-style pattern (only * and ?) to a RegExp. */
function globToRegex(pattern: string): RegExp {
  const escaped = pattern
    .replace(/[.+^${}()|[\]\\]/g, "\\$&")  // escape regex specials
    .replace(/\*/g, ".*")
    .replace(/\?/g, ".");
  return new RegExp(`^${escaped}$`, "i");
}

/**
 * Return true if `name` matches any of the patterns.
 * Patterns are comma-separated; each may contain * or ?.
 */
function matchesFilter(name: string, patterns: string[]): boolean {
  return patterns.some((p) => globToRegex(p.trim()).test(name));
}

// ----------------------------------------------------------
// SQL-based column introspection
// ----------------------------------------------------------

// JDBC DatabaseMetaData.getColumns() hangs on Snowflake's driver (known driver
// issue with metadata enumeration). We use INFORMATION_SCHEMA SQL queries
// instead, which are supported by all target databases (Snowflake, Postgres, …)
// and run over the same connection that already works for table listing.

type ColumnInfo = {
  columnName:       string;
  dataType:         string;
  characterMaxLen:  number | null;
  numericPrecision: number | null;
  nullable:         boolean;
  isPrimaryKey:     boolean;
};

async function fetchColumns(
  sql: SqlService,
  conn: SqlConnection,
  schema: string,
  tableName: string,
): Promise<ColumnInfo[]> {
  const colRows = await sql.query(
    conn,
    `SELECT COLUMN_NAME, DATA_TYPE, CHARACTER_MAXIMUM_LENGTH, NUMERIC_PRECISION, IS_NULLABLE
       FROM INFORMATION_SCHEMA.COLUMNS
      WHERE TABLE_SCHEMA = '${schema}'
        AND TABLE_NAME   = '${tableName}'
      ORDER BY ORDINAL_POSITION`,
  );

  let pkSet = new Set<string>();
  try {
    const pkRows = await sql.query(
      conn,
      `SELECT kcu.COLUMN_NAME
         FROM INFORMATION_SCHEMA.TABLE_CONSTRAINTS tc
         JOIN INFORMATION_SCHEMA.KEY_COLUMN_USAGE kcu
           ON  tc.CONSTRAINT_NAME = kcu.CONSTRAINT_NAME
           AND tc.TABLE_SCHEMA    = kcu.TABLE_SCHEMA
           AND tc.TABLE_NAME      = kcu.TABLE_NAME
        WHERE tc.CONSTRAINT_TYPE = 'PRIMARY KEY'
          AND tc.TABLE_SCHEMA    = '${schema}'
          AND tc.TABLE_NAME      = '${tableName}'`,
    );
    pkSet = new Set(
      pkRows.map((r) => String(r["COLUMN_NAME"] ?? r["column_name"] ?? "").toUpperCase()),
    );
  } catch {
    // KEY_COLUMN_USAGE may not be accessible (e.g. Snowflake privilege restrictions).
    // Omit PRIMARY KEY constraints rather than failing.
  }

  return colRows.map((r) => {
    const name = String(r["COLUMN_NAME"] ?? r["column_name"] ?? "");
    return {
      columnName:       name,
      dataType:         String(r["DATA_TYPE"] ?? r["data_type"] ?? "VARCHAR"),
      characterMaxLen:  r["CHARACTER_MAXIMUM_LENGTH"] != null ? Number(r["CHARACTER_MAXIMUM_LENGTH"] ?? r["character_maximum_length"]) : null,
      numericPrecision: r["NUMERIC_PRECISION"] != null ? Number(r["NUMERIC_PRECISION"] ?? r["numeric_precision"]) : null,
      nullable:         String(r["IS_NULLABLE"] ?? r["is_nullable"] ?? "YES").toUpperCase() !== "NO",
      isPrimaryKey:     pkSet.has(name.toUpperCase()),
    };
  });
}

type ForeignKeyInfo = {
  constraintName:   string;
  columnName:       string;
  referencedTable:  string;
  referencedColumn: string;
  ordinalPosition:  number;
};

async function fetchForeignKeys(
  sql: SqlService,
  conn: SqlConnection,
  schema: string,
  tableName: string,
): Promise<ForeignKeyInfo[]> {
  try {
    const rows = await sql.query(
      conn,
      `SELECT kcu.CONSTRAINT_NAME, kcu.COLUMN_NAME,
              ccu.TABLE_NAME  AS REFERENCED_TABLE_NAME,
              ccu.COLUMN_NAME AS REFERENCED_COLUMN_NAME,
              kcu.ORDINAL_POSITION
         FROM INFORMATION_SCHEMA.TABLE_CONSTRAINTS tc
         JOIN INFORMATION_SCHEMA.KEY_COLUMN_USAGE kcu
           ON  tc.CONSTRAINT_NAME = kcu.CONSTRAINT_NAME
           AND tc.TABLE_SCHEMA    = kcu.TABLE_SCHEMA
           AND tc.TABLE_NAME      = kcu.TABLE_NAME
         JOIN INFORMATION_SCHEMA.REFERENTIAL_CONSTRAINTS rc
           ON  tc.CONSTRAINT_NAME  = rc.CONSTRAINT_NAME
           AND tc.TABLE_SCHEMA     = rc.CONSTRAINT_SCHEMA
         JOIN INFORMATION_SCHEMA.KEY_COLUMN_USAGE ccu
           ON  rc.UNIQUE_CONSTRAINT_NAME   = ccu.CONSTRAINT_NAME
           AND rc.UNIQUE_CONSTRAINT_SCHEMA = ccu.CONSTRAINT_SCHEMA
           AND kcu.ORDINAL_POSITION        = ccu.ORDINAL_POSITION
        WHERE tc.CONSTRAINT_TYPE = 'FOREIGN KEY'
          AND tc.TABLE_SCHEMA    = '${schema}'
          AND tc.TABLE_NAME      = '${tableName}'
        ORDER BY kcu.CONSTRAINT_NAME, kcu.ORDINAL_POSITION`,
    );
    return rows.map((r) => ({
      constraintName:   String(r["CONSTRAINT_NAME"]        ?? r["constraint_name"]        ?? ""),
      columnName:       String(r["COLUMN_NAME"]            ?? r["column_name"]            ?? ""),
      referencedTable:  String(r["REFERENCED_TABLE_NAME"]  ?? r["referenced_table_name"]  ?? ""),
      referencedColumn: String(r["REFERENCED_COLUMN_NAME"] ?? r["referenced_column_name"] ?? ""),
      ordinalPosition:  Number(r["ORDINAL_POSITION"]       ?? r["ordinal_position"]       ?? 0),
    }));
  } catch {
    // REFERENTIAL_CONSTRAINTS may not be accessible on some databases/configurations.
    // Omit FOREIGN KEY constraints rather than failing.
    return [];
  }
}

// ----------------------------------------------------------
// DDL generation
// ----------------------------------------------------------

function ddlType(col: ColumnInfo): string {
  const t = col.dataType.toUpperCase();

  if (t.includes("VARCHAR") || t === "NVARCHAR" || t === "CHARACTER VARYING" || t === "NATIONAL CHARACTER VARYING") {
    return col.characterMaxLen != null && col.characterMaxLen > 0 ? `${t}(${col.characterMaxLen})` : t;
  }
  if (t === "CHAR" || t === "NCHAR" || t === "CHARACTER" || t === "NATIONAL CHARACTER") {
    return col.characterMaxLen != null && col.characterMaxLen > 0 ? `${t}(${col.characterMaxLen})` : t;
  }
  if (t === "DECIMAL" || t === "NUMERIC" || t === "NUMBER") {
    return col.numericPrecision != null && col.numericPrecision > 0 ? `${t}(${col.numericPrecision})` : t;
  }
  return t;
}

function buildCreateTable(tableName: string, cols: ColumnInfo[], fks: ForeignKeyInfo[]): string {
  const pkCols = cols.filter((c) => c.isPrimaryKey).map((c) => c.columnName);

  const lines = cols.map((c) => {
    const nullable = c.nullable ? "" : " NOT NULL";
    return `    ${c.columnName} ${ddlType(c)}${nullable}`;
  });

  if (pkCols.length > 0) {
    lines.push(`    PRIMARY KEY (${pkCols.join(", ")})`);
  }

  // Group FK columns by constraint name (composite FKs span multiple rows)
  const fkGroups = new Map<string, ForeignKeyInfo[]>();
  for (const fk of fks) {
    const group = fkGroups.get(fk.constraintName) ?? [];
    group.push(fk);
    fkGroups.set(fk.constraintName, group);
  }
  for (const group of fkGroups.values()) {
    const localCols = group.map((f) => f.columnName).join(", ");
    const refTable  = group[0].referencedTable;
    const refCols   = group.map((f) => f.referencedColumn).join(", ");
    lines.push(`    FOREIGN KEY (${localCols}) REFERENCES ${refTable} (${refCols})`);
  }

  return `CREATE TABLE ${tableName} (\n${lines.join(",\n")}\n);`;
}

// ----------------------------------------------------------
// Operation
// ----------------------------------------------------------

export class ExtractDDLFromConnectionOperation extends Operation<Params> {
  name        = "extract-ddl-from-connection";
  description = "Connect to a database and extract CREATE TABLE DDL for each table in the schema";
  parameters  = new ExtractDDLFromConnectionParams();

  constructor(services: ServiceRegistry, logger: Logger) {
    super(services, logger);
  }

  async run(params: Params): Promise<void> {
    const yaml = this.services.get<YamlService>("yaml");
    const sql  = this.services.get<SqlService>("sql");

    const connectionName = params["connection-name"];
    const config = yaml.readFromFile<ConnectionConfig>(params["connection-file"]);
    const conn   = await sql.connect(config, connectionName);

    const schema = params.schema;

    // Parse table filter patterns
    const filterPatterns = params.tables
      ? params.tables.split(",").map((p) => p.trim()).filter(Boolean)
      : [];

    this.logger.log(`[ExtractDDLFromConnection] Connected to "${connectionName}" (schema: ${schema})`);

    try {
      const tableRows = await sql.query(
        conn,
        `SELECT TABLE_NAME FROM INFORMATION_SCHEMA.TABLES
          WHERE TABLE_SCHEMA = '${schema}'
            AND TABLE_TYPE   = 'BASE TABLE'
          ORDER BY TABLE_NAME`,
      );
      const allTableNames: string[] = tableRows.map(
        (r) => String(r["TABLE_NAME"] ?? r["table_name"] ?? ""),
      ).filter(Boolean);

      const tableNames = filterPatterns.length > 0
        ? allTableNames.filter((name) => matchesFilter(name, filterPatterns))
        : allTableNames;

      if (tableNames.length === 0) {
        this.logger.log("[ExtractDDLFromConnection] No tables matched — nothing to extract.");
        return;
      }

      this.logger.log(`[ExtractDDLFromConnection] Extracting DDL for ${tableNames.length} table(s)…`);

      const blocks: string[] = [];

      for (const tableName of tableNames) {
        const cols = await fetchColumns(sql, conn, schema, tableName);
        if (cols.length === 0) {
          this.logger.log(`  ⚠  ${tableName}: no columns returned — skipped`);
          continue;
        }
        const fks = await fetchForeignKeys(sql, conn, schema, tableName);
        blocks.push(buildCreateTable(tableName, cols, fks));
        this.logger.log(`  → ${tableName} (${cols.length} column(s), ${fks.length} FK(s))`);
      }

      const ddl = blocks.join("\n\n") + "\n";

      if (params["output-file"]) {
        const outputPath = path.resolve(params["output-file"]);
        fs.mkdirSync(path.dirname(outputPath), { recursive: true });
        fs.writeFileSync(outputPath, ddl, "utf8");
        this.logger.log(`\n[ExtractDDLFromConnection] Wrote ${blocks.length} table(s) to: ${outputPath}`);
      } else {
        process.stdout.write(ddl);
      }
    } finally {
      await sql.close(conn);
    }
  }
}
