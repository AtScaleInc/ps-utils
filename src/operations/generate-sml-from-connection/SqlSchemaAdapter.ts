/**
 * Adapts SqlService + SqlConnection to the DatabaseMetaData interface
 * expected by proposeSemanticModel().
 *
 * Row-mapping note: SqlService returns INFORMATION_SCHEMA result rows with
 * UPPERCASE column aliases (TABLE_NAME, COLUMN_NAME, etc.).  We read
 * properties with uppercase keys and fall back to lowercase for safety.
 */
import type { SqlService, SqlConnection } from "../../services/SqlService.js";
import type {
  DatabaseMetaData,
  TableMeta,
  ColumnMeta,
  ForeignKeyMeta,
  IndexMeta,
  ViewMeta,
} from "../../algorithm/types.js";

/** Read a property that may be uppercase or lowercase in the result row. */
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

export class SqlSchemaAdapter implements DatabaseMetaData {
  constructor(
    private readonly sql: SqlService,
    private readonly conn: SqlConnection,
    private readonly schema: string,
  ) {}

  // ----------------------------------------------------------
  // Tables
  // ----------------------------------------------------------

  async getTables(schemaPattern?: string): Promise<TableMeta[]> {
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

  async getColumns(tableName: string): Promise<ColumnMeta[]> {
    // Sequential awaits: run these one at a time to avoid connection contention.
    const colRows = await this.sql.getColumns(this.conn, this.schema, tableName);
    const pkSet   = await this.fetchPrimaryKeys(tableName);

    return colRows
      .map((r) => ({
        tableName:       str(r, "TABLE_NAME", tableName),
        columnName:      str(r, "COLUMN_NAME"),
        // TYPE_NAME contains the SQL type name (e.g. "VARCHAR", "INTEGER")
        dataType:        str(r, "TYPE_NAME", "VARCHAR"),
        columnSize:      num(r, "COLUMN_SIZE"),
        // NULLABLE: 0 = columnNoNulls, 1 = columnNullable, 2 = columnNullableUnknown
        nullable:        num(r, "NULLABLE", 1) !== 0,
        isPrimaryKey:    pkSet.has(str(r, "COLUMN_NAME").toUpperCase()),
        ordinalPosition: num(r, "ORDINAL_POSITION", 1),
      }))
      .sort((a, b) => a.ordinalPosition - b.ordinalPosition);
  }

  private async fetchPrimaryKeys(tableName: string): Promise<Set<string>> {
    // Query INFORMATION_SCHEMA for primary keys ordered by key sequence.
    // Ordering by ORDINAL_POSITION ensures composite PK columns are returned
    // in declaration order, matching the key_columns array in AtScale SML.
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
            AND tc.TABLE_NAME      = '${tableName}'
          ORDER BY kcu.ORDINAL_POSITION`,
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

  async getForeignKeys(tableName: string): Promise<ForeignKeyMeta[]> {
    // Prefer INFORMATION_SCHEMA — it correctly handles composite foreign keys
    // and is portable across PostgreSQL, Snowflake (via compatibility view),
    // and most ANSI-SQL databases.  Fall back to the driver-level API when
    // the INFORMATION_SCHEMA query fails (permission issue or unsupported dialect).
    const fromInfoSchema = await this.fetchForeignKeysFromInfoSchema(tableName);
    if (fromInfoSchema.length > 0) return fromInfoSchema;

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

  /**
   * Query INFORMATION_SCHEMA for foreign key metadata.
   *
   * Uses the standard four-table join across REFERENTIAL_CONSTRAINTS,
   * KEY_COLUMN_USAGE, and CONSTRAINT_COLUMN_USAGE, which returns one row per
   * FK column (supporting composite keys) with the correct ORDINAL_POSITION.
   *
   * Works with PostgreSQL and databases that implement the ANSI INFORMATION_SCHEMA
   * views (SQL Server, MySQL ≥8, BigQuery, etc.).  Snowflake does not populate
   * KEY_COLUMN_USAGE for FK relationships; the query will return 0 rows and the
   * caller falls back to the driver-level API.
   *
   * Returns [] on any error so the caller can degrade gracefully.
   */
  private async fetchForeignKeysFromInfoSchema(tableName: string): Promise<ForeignKeyMeta[]> {
    try {
      const rows = await this.sql.query(
        this.conn,
        `SELECT
             kcu.TABLE_NAME       AS FKTABLE_NAME,
             kcu.COLUMN_NAME      AS FKCOLUMN_NAME,
             ccu.TABLE_NAME       AS PKTABLE_NAME,
             ccu.COLUMN_NAME      AS PKCOLUMN_NAME,
             kcu.ORDINAL_POSITION AS KEY_SEQ,
             rc.CONSTRAINT_NAME   AS FK_NAME
           FROM INFORMATION_SCHEMA.REFERENTIAL_CONSTRAINTS rc
           JOIN INFORMATION_SCHEMA.KEY_COLUMN_USAGE kcu
             ON  rc.CONSTRAINT_NAME   = kcu.CONSTRAINT_NAME
             AND rc.CONSTRAINT_SCHEMA = kcu.CONSTRAINT_SCHEMA
           JOIN INFORMATION_SCHEMA.CONSTRAINT_COLUMN_USAGE ccu
             ON  rc.UNIQUE_CONSTRAINT_NAME   = ccu.CONSTRAINT_NAME
             AND rc.UNIQUE_CONSTRAINT_SCHEMA = ccu.CONSTRAINT_SCHEMA
          WHERE kcu.TABLE_SCHEMA = '${this.schema}'
            AND kcu.TABLE_NAME   = '${tableName}'
          ORDER BY rc.CONSTRAINT_NAME, kcu.ORDINAL_POSITION`,
      );
      return rows.map((r) => ({
        fkTableName:    str(r, "FKTABLE_NAME", tableName),
        fkColumnName:   str(r, "FKCOLUMN_NAME"),
        pkTableName:    str(r, "PKTABLE_NAME"),
        pkColumnName:   str(r, "PKCOLUMN_NAME"),
        keySeq:         num(r, "KEY_SEQ", 1),
        constraintName: str(r, "FK_NAME"),
      }));
    } catch {
      return [];
    }
  }

  // ----------------------------------------------------------
  // Index info
  // ----------------------------------------------------------

  async getIndexInfo(_tableName: string): Promise<IndexMeta[]> {
    // Index metadata is not queried — hierarchy inference falls back gracefully
    // to name-based strategies.
    // Hierarchy inference falls back gracefully to name-based strategies.
    return [];
  }

  // ----------------------------------------------------------
  // Views
  // ----------------------------------------------------------

  async getViews(schemaPattern?: string): Promise<ViewMeta[]> {
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
