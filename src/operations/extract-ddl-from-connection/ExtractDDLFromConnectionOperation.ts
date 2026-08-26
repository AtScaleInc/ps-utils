/**
 * ExtractDDLFromConnection
 *
 * Connects to a live database, reads schema metadata for each table in the
 * target schema(s), and writes the equivalent CREATE TABLE DDL to a file (or
 * stdout).
 *
 * Schema filtering:
 *   --schema accepts one or more comma-separated schema names, e.g.
 *   --schema "DIM, SYSTEM". When more than one schema is given, output table
 *   names (and any foreign keys that cross schema boundaries) are qualified
 *   as "<schema>.<table>" so generate-sml-from-ddl can tell same-named tables
 *   in different schemas apart. With a single schema, output stays
 *   unqualified, matching prior behavior.
 *
 * Table filtering:
 *   --tables accepts a comma-separated list of table names or wildcard
 *   patterns.  '*' matches any sequence of characters; '?' matches exactly
 *   one character.  Matching is case-sensitive by default.
 *
 *   Pass --case-insensitive to match regardless of case.
 *
 *   Examples:
 *     --tables "Dim*"                → all tables starting with "Dim"
 *     --tables "FactSales,FactReturns"
 *     --tables "Fact*,Dim*"
 */
import fs from "fs";
import path from "path";
import { Operation } from "../Operation.js";
import { ParameterSet, StringParameter, BooleanParameter } from "../../Parameters.js";
import type { ServiceRegistry } from "../../services/registry.js";
import type { Logger } from "../../logging.js";
import { YamlService } from "../../services/YamlService.js";
import { SqlService, type ConnectionConfig, type SqlConnection } from "../../services/SqlService.js";

// ----------------------------------------------------------
// Parameters
// ----------------------------------------------------------

class ExtractDDLFromConnectionParamsSet extends ParameterSet {
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
      description = 'Database schema(s) to introspect. Comma-separated for multiple (e.g. "DIM, SYSTEM") when fact and dimension tables live in different schemas.';
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
    new (class extends BooleanParameter {
      name        = "case-insensitive";
      description = "Match table names case-insensitively. Default is case-sensitive matching.";
      required    = false;
    })(),
  ];
}

type Params = {
  "connection-file":  string;
  "connection-name":  string;
  schema:             string;
  tables?:            string;
  "output-file"?:     string;
  "case-insensitive": boolean;
};
export type ExtractDDLFromConnectionParams = Params;

// ----------------------------------------------------------
// Wildcard matching
// ----------------------------------------------------------

/** Convert a glob-style pattern (only * and ?) to a RegExp. */
function globToRegex(pattern: string, caseInsensitive: boolean): RegExp {
  const escaped = pattern
    .replace(/[.+^${}()|[\]\\]/g, "\\$&")  // escape regex specials
    .replace(/\*/g, ".*")
    .replace(/\?/g, ".");
  return new RegExp(`^${escaped}$`, caseInsensitive ? "i" : "");
}

/**
 * Return true if `name` matches any of the patterns.
 * Patterns are comma-separated; each may contain * or ?.
 */
function matchesFilter(name: string, patterns: string[], caseInsensitive: boolean): boolean {
  return patterns.some((p) => globToRegex(p.trim(), caseInsensitive).test(name));
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

/** Build a composite map key from a schema + table name pair. */
function rowKey(schema: string, table: string): string {
  return `${schema}\u0001${table}`;
}

/** Fetch columns and PK flags for all tables (across one or more schemas) in one pair of bulk queries. */
async function fetchAllColumns(
  sql: SqlService,
  conn: SqlConnection,
  schemas: string[],
  tableNames: string[],
): Promise<Map<string, ColumnInfo[]>> {
  const inList       = tableNames.map((t) => `'${t}'`).join(", ");
  const schemaInList = schemas.map((s) => `'${s}'`).join(", ");

  const colRows = await sql.query(
    conn,
    `SELECT TABLE_SCHEMA, TABLE_NAME, COLUMN_NAME, DATA_TYPE, CHARACTER_MAXIMUM_LENGTH, NUMERIC_PRECISION, IS_NULLABLE
       FROM INFORMATION_SCHEMA.COLUMNS
      WHERE TABLE_SCHEMA IN (${schemaInList})
        AND TABLE_NAME IN (${inList})
      ORDER BY TABLE_SCHEMA, TABLE_NAME, ORDINAL_POSITION`,
  );

  // Build per-table PK sets in one query.
  const pkMap = new Map<string, Set<string>>();
  try {
    const pkRows = await sql.query(
      conn,
      `SELECT tc.TABLE_SCHEMA, kcu.TABLE_NAME, kcu.COLUMN_NAME
         FROM INFORMATION_SCHEMA.TABLE_CONSTRAINTS tc
         JOIN INFORMATION_SCHEMA.KEY_COLUMN_USAGE kcu
           ON  tc.CONSTRAINT_NAME = kcu.CONSTRAINT_NAME
           AND tc.TABLE_SCHEMA    = kcu.TABLE_SCHEMA
           AND tc.TABLE_NAME      = kcu.TABLE_NAME
        WHERE tc.CONSTRAINT_TYPE = 'PRIMARY KEY'
          AND tc.TABLE_SCHEMA    IN (${schemaInList})
          AND tc.TABLE_NAME      IN (${inList})`,
    );
    for (const r of pkRows) {
      const tSchema = String(r["TABLE_SCHEMA"] ?? r["table_schema"] ?? "");
      const tName   = String(r["TABLE_NAME"]   ?? r["table_name"]   ?? "");
      const cName   = String(r["COLUMN_NAME"]  ?? r["column_name"]  ?? "").toUpperCase();
      const key = rowKey(tSchema, tName);
      if (!pkMap.has(key)) pkMap.set(key, new Set());
      pkMap.get(key)!.add(cName);
    }
  } catch {
    // KEY_COLUMN_USAGE may not be accessible (e.g. Snowflake privilege restrictions).
  }

  const result = new Map<string, ColumnInfo[]>();
  for (const r of colRows) {
    const tSchema = String(r["TABLE_SCHEMA"] ?? r["table_schema"] ?? "");
    const tName   = String(r["TABLE_NAME"]   ?? r["table_name"]   ?? "");
    const cName   = String(r["COLUMN_NAME"]  ?? r["column_name"]  ?? "");
    const key = rowKey(tSchema, tName);
    if (!result.has(key)) result.set(key, []);
    result.get(key)!.push({
      columnName:       cName,
      dataType:         String(r["DATA_TYPE"] ?? r["data_type"] ?? "VARCHAR"),
      characterMaxLen:  r["CHARACTER_MAXIMUM_LENGTH"] != null ? Number(r["CHARACTER_MAXIMUM_LENGTH"] ?? r["character_maximum_length"]) : null,
      numericPrecision: r["NUMERIC_PRECISION"] != null ? Number(r["NUMERIC_PRECISION"] ?? r["numeric_precision"]) : null,
      nullable:         String(r["IS_NULLABLE"] ?? r["is_nullable"] ?? "YES").toUpperCase() !== "NO",
      isPrimaryKey:     (pkMap.get(key) ?? new Set()).has(cName.toUpperCase()),
    });
  }
  return result;
}

type ForeignKeyInfo = {
  constraintName:   string;
  columnName:       string;
  referencedTable:  string;
  referencedSchema: string;
  referencedColumn: string;
  ordinalPosition:  number;
};

/** Fetch foreign keys for all tables (across one or more schemas) in one bulk query. */
async function fetchAllForeignKeys(
  sql: SqlService,
  conn: SqlConnection,
  schemas: string[],
  tableNames: string[],
): Promise<Map<string, ForeignKeyInfo[]>> {
  const result = new Map<string, ForeignKeyInfo[]>();
  try {
    const inList       = tableNames.map((t) => `'${t}'`).join(", ");
    const schemaInList = schemas.map((s) => `'${s}'`).join(", ");
    const rows = await sql.query(
      conn,
      `SELECT tc.TABLE_SCHEMA, kcu.TABLE_NAME, kcu.CONSTRAINT_NAME, kcu.COLUMN_NAME,
              ccu.TABLE_SCHEMA AS REFERENCED_TABLE_SCHEMA,
              ccu.TABLE_NAME   AS REFERENCED_TABLE_NAME,
              ccu.COLUMN_NAME  AS REFERENCED_COLUMN_NAME,
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
          AND tc.TABLE_SCHEMA    IN (${schemaInList})
          AND tc.TABLE_NAME      IN (${inList})
        ORDER BY tc.TABLE_SCHEMA, kcu.TABLE_NAME, kcu.CONSTRAINT_NAME, kcu.ORDINAL_POSITION`,
    );
    for (const r of rows) {
      const tSchema = String(r["TABLE_SCHEMA"] ?? r["table_schema"] ?? "");
      const tName   = String(r["TABLE_NAME"]   ?? r["table_name"]   ?? "");
      const key = rowKey(tSchema, tName);
      if (!result.has(key)) result.set(key, []);
      result.get(key)!.push({
        constraintName:   String(r["CONSTRAINT_NAME"]         ?? r["constraint_name"]         ?? ""),
        columnName:       String(r["COLUMN_NAME"]             ?? r["column_name"]             ?? ""),
        referencedTable:  String(r["REFERENCED_TABLE_NAME"]   ?? r["referenced_table_name"]   ?? ""),
        referencedSchema: String(r["REFERENCED_TABLE_SCHEMA"] ?? r["referenced_table_schema"] ?? tSchema),
        referencedColumn: String(r["REFERENCED_COLUMN_NAME"]  ?? r["referenced_column_name"]  ?? ""),
        ordinalPosition:  Number(r["ORDINAL_POSITION"]        ?? r["ordinal_position"]        ?? 0),
      });
    }
  } catch {
    // REFERENTIAL_CONSTRAINTS may not be accessible on some databases/configurations.
  }
  return result;
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

function buildCreateTable(
  tableName: string,
  cols: ColumnInfo[],
  fks: ForeignKeyInfo[],
  qualifySchemas: boolean,
  ownSchema: string,
): string {
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
    const refSchema = group[0].referencedSchema;
    const refTable  = qualifySchemas && refSchema && refSchema !== ownSchema
      ? `${refSchema}.${group[0].referencedTable}`
      : group[0].referencedTable;
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
  parameters  = new ExtractDDLFromConnectionParamsSet();

  constructor(services: ServiceRegistry, logger: Logger) {
    super(services, logger);
  }

  async run(params: Params): Promise<void> {
    const yaml = this.services.get<YamlService>("yaml");
    const sql  = this.services.get<SqlService>("sql");

    const connectionName = params["connection-name"];
    const config = yaml.readFromFile<ConnectionConfig>(params["connection-file"]);
    const conn   = await sql.connect(config, connectionName);

    // --schema accepts one or more comma-separated schemas (e.g. "DIM, SYSTEM")
    // so DDL can be extracted in one pass for databases that split fact and
    // dimension tables across schemas.
    const schemas = params.schema.split(",").map((s) => s.trim()).filter(Boolean);
    if (schemas.length === 0) {
      throw new Error('--schema must name at least one schema (comma-separated for multiple, e.g. "DIM, SYSTEM").');
    }
    const multiSchema = schemas.length > 1;

    // Parse table filter patterns
    const filterPatterns = params.tables
      ? params.tables.split(",").map((p) => p.trim()).filter(Boolean)
      : [];

    this.logger.log(`[ExtractDDLFromConnection] Connected to "${connectionName}" (schema${multiSchema ? "s" : ""}: ${schemas.join(", ")})`);

    try {
      const schemaInList = schemas.map((s) => `'${s}'`).join(", ");
      const tableRows = await sql.query(
        conn,
        `SELECT TABLE_SCHEMA, TABLE_NAME FROM INFORMATION_SCHEMA.TABLES
          WHERE TABLE_SCHEMA IN (${schemaInList})
            AND TABLE_TYPE   = 'BASE TABLE'
          ORDER BY TABLE_SCHEMA, TABLE_NAME`,
      );
      const allTables = tableRows.map((r) => ({
        schema: String(r["TABLE_SCHEMA"] ?? r["table_schema"] ?? ""),
        name:   String(r["TABLE_NAME"]   ?? r["table_name"]   ?? ""),
      })).filter((t) => t.schema && t.name);

      const tableEntries = filterPatterns.length > 0
        ? allTables.filter((t) => matchesFilter(t.name, filterPatterns, params["case-insensitive"]))
        : allTables;

      if (tableEntries.length === 0) {
        this.logger.log("[ExtractDDLFromConnection] No tables matched — nothing to extract.");
        return;
      }

      this.logger.log(`[ExtractDDLFromConnection] Extracting DDL for ${tableEntries.length} table(s)…`);

      const uniqueTableNames = Array.from(new Set(tableEntries.map((t) => t.name)));
      const [allColumns, allForeignKeys] = await Promise.all([
        fetchAllColumns(sql, conn, schemas, uniqueTableNames),
        fetchAllForeignKeys(sql, conn, schemas, uniqueTableNames),
      ]);

      const blocks: string[] = [];

      for (const { schema: tableSchema, name: tableName } of tableEntries) {
        const key = rowKey(tableSchema, tableName);
        const cols = allColumns.get(key) ?? [];
        const displayName = multiSchema ? `${tableSchema}.${tableName}` : tableName;
        if (cols.length === 0) {
          this.logger.log(`  ⚠  ${displayName}: no columns returned — skipped`);
          continue;
        }
        const fks = allForeignKeys.get(key) ?? [];
        blocks.push(buildCreateTable(displayName, cols, fks, multiSchema, tableSchema));
        this.logger.log(`  → ${displayName} (${cols.length} column(s), ${fks.length} FK(s))`);
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
