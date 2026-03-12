/**
 * Adapts SqlService + SqlConnection to the JdbcDatabaseMetaData interface
 * expected by proposeSemanticModel().
 *
 * Row-mapping note: node-jdbc returns JDBC ResultSet column names as-is from
 * the Java driver.  Snowflake and Postgres both use UPPERCASE column names
 * for JDBC metadata calls, so we read properties with uppercase keys and fall
 * back to lowercase for safety.
 */
import type { SqlService, SqlConnection } from "../../services/SqlService.js";
import type {
  JdbcDatabaseMetaData,
  JdbcTableMeta,
  JdbcColumnMeta,
  JdbcForeignKeyMeta,
  JdbcIndexMeta,
  JdbcViewMeta,
} from "../../algorithm/types.js";

/** Read a property that may be uppercase or lowercase in the raw JDBC row. */
function prop(row: Record<string, unknown>, upper: string): unknown {
  return row[upper] ?? row[upper.toLowerCase()];
}

function str(row: Record<string, unknown>, upper: string, fallback = ""): string {
  const v = prop(row, upper);
  return v !== null && v !== undefined ? String(v) : fallback;
}

function num(row: Record<string, unknown>, upper: string, fallback = 0): number {
  const v = prop(row, upper);
  return v !== null && v !== undefined ? Number(v) : fallback;
}

export class SqlJdbcAdapter implements JdbcDatabaseMetaData {
  constructor(
    private readonly sql: SqlService,
    private readonly conn: SqlConnection,
    private readonly schema: string,
  ) {}

  // ----------------------------------------------------------
  // Tables
  // ----------------------------------------------------------

  async getTables(schemaPattern?: string): Promise<JdbcTableMeta[]> {
    const schema = schemaPattern ?? this.schema;
    const rows = await this.sql.getTables(this.conn, schema, "%", ["TABLE"]);
    return rows.map((r) => ({
      tableName: str(r, "TABLE_NAME"),
      tableType: "TABLE" as const,
      remarks: str(r, "REMARKS") || undefined,
    }));
  }

  // ----------------------------------------------------------
  // Columns
  // ----------------------------------------------------------

  async getColumns(tableName: string): Promise<JdbcColumnMeta[]> {
    const [colRows, pkSet] = await Promise.all([
      this.sql.getColumns(this.conn, this.schema, tableName),
      this.fetchPrimaryKeys(tableName),
    ]);

    return colRows
      .map((r) => ({
        tableName:       str(r, "TABLE_NAME", tableName),
        columnName:      str(r, "COLUMN_NAME"),
        // JDBC returns TYPE_NAME for the SQL type name (e.g. "VARCHAR", "INTEGER")
        dataType:        str(r, "TYPE_NAME", "VARCHAR"),
        columnSize:      num(r, "COLUMN_SIZE"),
        // JDBC NULLABLE: 0 = columnNoNulls, 1 = columnNullable, 2 = columnNullableUnknown
        nullable:        num(r, "NULLABLE", 1) !== 0,
        isPrimaryKey:    pkSet.has(str(r, "COLUMN_NAME").toUpperCase()),
        ordinalPosition: num(r, "ORDINAL_POSITION", 1),
      }))
      .sort((a, b) => a.ordinalPosition - b.ordinalPosition);
  }

  private async fetchPrimaryKeys(tableName: string): Promise<Set<string>> {
    // Query INFORMATION_SCHEMA instead of relying on JDBC getPrimaryKeys()
    // because SqlService does not expose that metadata method.
    try {
      const rows = await this.sql.query(
        this.conn,
        `SELECT kcu.COLUMN_NAME
           FROM INFORMATION_SCHEMA.TABLE_CONSTRAINTS tc
           JOIN INFORMATION_SCHEMA.KEY_COLUMN_USAGE kcu
             ON  tc.CONSTRAINT_NAME = kcu.CONSTRAINT_NAME
             AND tc.TABLE_SCHEMA    = kcu.TABLE_SCHEMA
             AND tc.TABLE_NAME      = kcu.TABLE_NAME
          WHERE tc.CONSTRAINT_TYPE = 'PRIMARY KEY'
            AND tc.TABLE_SCHEMA    = '${this.schema}'
            AND tc.TABLE_NAME      = '${tableName}'`,
      );
      return new Set(rows.map((r) => str(r, "COLUMN_NAME").toUpperCase()));
    } catch {
      // If INFORMATION_SCHEMA query fails (e.g. permission issue), return empty set.
      return new Set();
    }
  }

  // ----------------------------------------------------------
  // Foreign keys
  // ----------------------------------------------------------

  async getForeignKeys(tableName: string): Promise<JdbcForeignKeyMeta[]> {
    const rows = await this.sql.getForeignKeys(this.conn, this.schema, tableName);
    return rows.map((r) => ({
      fkTableName:    str(r, "FKTABLE_NAME", tableName),
      fkColumnName:   str(r, "FKCOLUMN_NAME"),
      pkTableName:    str(r, "PKTABLE_NAME"),
      pkColumnName:   str(r, "PKCOLUMN_NAME"),
      keySeq:         num(r, "KEY_SEQ", 1),
      constraintName: str(r, "FK_NAME"),
    }));
  }

  // ----------------------------------------------------------
  // Index info
  // ----------------------------------------------------------

  async getIndexInfo(_tableName: string): Promise<JdbcIndexMeta[]> {
    // Snowflake does not expose index metadata via JDBC; Postgres does but
    // the operational risk of a missing index isn't worth a separate call.
    // Hierarchy inference falls back gracefully to name-based strategies.
    return [];
  }

  // ----------------------------------------------------------
  // Views
  // ----------------------------------------------------------

  async getViews(schemaPattern?: string): Promise<JdbcViewMeta[]> {
    const schema = schemaPattern ?? this.schema;
    const rows = await this.sql.getViews(this.conn, schema);
    return rows.map((r) => ({
      viewName:   str(r, "TABLE_NAME"),
      definition: str(r, "VIEW_DEFINITION"),
      columns:    [],
    }));
  }

  // ----------------------------------------------------------
  // Row sampling (enables column profiling)
  // ----------------------------------------------------------

  async sampleRows(tableName: string, limit = 250): Promise<Record<string, unknown>[]> {
    try {
      const schemaPrefix = this.schema ? `"${this.schema}".` : "";
      return await this.sql.query(
        this.conn,
        `SELECT * FROM ${schemaPrefix}"${tableName}" LIMIT ${limit}`,
      );
    } catch {
      return [];
    }
  }
}
