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
import {
  choosePrimaryKey,
  inferForeignKeys,
  keyCandidates,
  type InferTable,
  type Uniqueness,
} from "./bigquery-key-inference.js";

/** BigQuery only: skip the uniqueness check on a table if it would scan more than this. */
const MAX_VERIFY_BYTES = 1_000_000_000;
/** BigQuery only: most key candidates checked per table in one query. */
const MAX_VERIFIED_CANDIDATES = 8;
/** BigQuery only: how many foreign-key checks run at once. */
const FK_CHECK_CONCURRENCY = 6;
/** BigQuery only: reject an inferred foreign key if more than this share of its values have no match. */
const MAX_ORPHAN_SHARE = 0.05;

interface BigQueryKeyModel {
  /** Table -> primary-key columns, declared or inferred. */
  primaryKeys: Map<string, string[]>;
  /** Table -> foreign keys. Populated only when keys were inferred. */
  foreignKeys: Map<string, ForeignKeyMeta[]>;
}

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
    /** Receives progress notes; used by the BigQuery key inference. */
    private readonly log?: (message: string) => void,
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
    const pkSet   = this.conn.dialect === "bigquery"
      ? await this.bigQueryPrimaryKeySet(tableName)
      : await this.fetchPrimaryKeys(tableName);

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
    if (this.conn.dialect === "bigquery") return this.getForeignKeysBigQuery(tableName);

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
  // BigQuery keys
  //
  // BigQuery constraints are optional and unenforced, and most datasets declare
  // none. INFORMATION_SCHEMA is also dataset-qualified there, so the generic
  // key queries above cannot run. Everything below is BigQuery-only.
  // ----------------------------------------------------------

  private bigQueryKeyModel?: Promise<BigQueryKeyModel>;

  private bigQueryKeys(): Promise<BigQueryKeyModel> {
    this.bigQueryKeyModel ??= this.buildBigQueryKeyModel();
    return this.bigQueryKeyModel;
  }

  private async bigQueryPrimaryKeySet(tableName: string): Promise<Set<string>> {
    const model = await this.bigQueryKeys();
    return new Set((model.primaryKeys.get(tableName) ?? []).map((c) => c.toUpperCase()));
  }

  private async getForeignKeysBigQuery(tableName: string): Promise<ForeignKeyMeta[]> {
    // Declared foreign keys first (SqlService reads them dataset-qualified).
    try {
      const rows = await this.sql.getForeignKeys(this.conn, this.schema, tableName);
      if (rows.length > 0) {
        return rows.map((r) => ({
          fkTableName:    str(r, "FKTABLE_NAME", tableName),
          fkColumnName:   str(r, "FKCOLUMN_NAME"),
          pkTableName:    str(r, "PKTABLE_NAME"),
          pkColumnName:   str(r, "PKCOLUMN_NAME"),
          keySeq:         num(r, "KEY_SEQ", 1),
          constraintName: str(r, "FK_NAME"),
        }));
      }
    } catch {
      // fall through to inferred keys
    }
    return (await this.bigQueryKeys()).foreignKeys.get(tableName) ?? [];
  }

  private async buildBigQueryKeyModel(): Promise<BigQueryKeyModel> {
    const conn = this.conn;
    if (conn.dialect !== "bigquery") throw new Error("BigQuery key model requested for another dialect.");
    const dataset = this.schema;
    if (/[`\\]/.test(dataset)) throw new Error(`Invalid BigQuery dataset name: '${dataset}'.`);
    const project = conn.client.projectId;
    const from = (view: string) => `\`${project}.${dataset}\`.INFORMATION_SCHEMA.${view}`;

    // 1. Declared primary keys always win.
    let declaredRows: any[] = [];
    try {
      declaredRows = await this.sql.query(
        conn,
        `SELECT kcu.table_name AS table_name, kcu.column_name AS column_name
           FROM ${from("TABLE_CONSTRAINTS")} tc
           JOIN ${from("KEY_COLUMN_USAGE")} kcu
             ON  tc.constraint_name = kcu.constraint_name
             AND tc.table_name      = kcu.table_name
          WHERE tc.constraint_type = 'PRIMARY KEY'
          ORDER BY kcu.table_name, kcu.ordinal_position`,
      );
    } catch {
      // no permission or no constraints view: treat as none declared
    }
    if (declaredRows.length > 0) {
      const declared = new Map<string, string[]>();
      for (const r of declaredRows) {
        const t = str(r, "TABLE_NAME");
        declared.set(t, [...(declared.get(t) ?? []), str(r, "COLUMN_NAME")]);
      }
      return { primaryKeys: declared, foreignKeys: new Map() };
    }

    // 2. None declared: infer from names, confirmed by uniqueness in the data.
    const tableNames = (await this.getTables()).map((t) => t.tableName);
    const tables: InferTable[] = await Promise.all(
      tableNames.map(async (name) => {
        const cols = await this.sql.getColumns(conn, dataset, name);
        return {
          name,
          columns: cols.map((r) => ({
            name:     str(r, "COLUMN_NAME"),
            dataType: str(r, "TYPE_NAME", "STRING"),
          })),
        };
      }),
    );

    const pks = new Map<string, string>();
    for (const t of tables) {
      const candidates = keyCandidates(t).slice(0, MAX_VERIFIED_CANDIDATES);
      if (candidates.length === 0) continue;
      const verdicts = await this.verifyUniqueness(t.name, candidates.map((c) => c.column));
      const pk = choosePrimaryKey(candidates, (c) => verdicts.get(c) ?? "unknown");
      if (pk) pks.set(t.name, pk);
    }

    const inferred = inferForeignKeys(tables, pks);
    const ambiguous = inferred.ambiguous;
    // A column that merely ends in a key's name (citystatekey vs statekey) is the
    // riskiest match, so confirm those against the data: the values must exist in
    // the key they point at.
    const foreignKeys: typeof inferred.foreignKeys = [];
    const rejected: string[] = [];
    const toCheck = inferred.foreignKeys.filter((fk) => !fk.exact);
    const violated = new Set<(typeof toCheck)[number]>();
    for (let i = 0; i < toCheck.length; i += FK_CHECK_CONCURRENCY) {
      const batch = toCheck.slice(i, i + FK_CHECK_CONCURRENCY);
      const verdicts = await Promise.all(batch.map((fk) => this.foreignKeyHolds(fk)));
      batch.forEach((fk, j) => { if (verdicts[j] === "violated") violated.add(fk); });
    }
    for (const fk of inferred.foreignKeys) {
      if (!violated.has(fk)) foreignKeys.push(fk);
      else rejected.push(`${fk.fkTable}.${fk.fkColumn} -> ${fk.pkTable}.${fk.pkColumn}`);
    }
    const fkByTable = new Map<string, ForeignKeyMeta[]>();
    for (const fk of foreignKeys) {
      fkByTable.set(fk.fkTable, [
        ...(fkByTable.get(fk.fkTable) ?? []),
        {
          fkTableName:    fk.fkTable,
          fkColumnName:   fk.fkColumn,
          pkTableName:    fk.pkTable,
          pkColumnName:   fk.pkColumn,
          keySeq:         1,
          constraintName: `inferred_${fk.fkTable}_${fk.fkColumn}`,
        },
      ]);
    }

    this.log?.(
      `[BigQuery] No PRIMARY KEY constraints declared in "${dataset}"; inferred ` +
      `${pks.size} primary key(s) and ${foreignKeys.length} foreign key(s) from column ` +
      `names and uniqueness. These are heuristics — review them.`,
    );
    for (const [t, c] of pks) this.log?.(`  PK  ${t}.${c}`);
    for (const fk of foreignKeys) this.log?.(`  FK  ${fk.fkTable}.${fk.fkColumn} -> ${fk.pkTable}.${fk.pkColumn}`);
    for (const r of rejected) this.log?.(`  rejected ${r}: values do not exist in the target key`);
    for (const a of ambiguous) {
      this.log?.(`  skipped ${a.fkTable}.${a.fkColumn}: ambiguous between ${a.candidates.join(", ")}`);
    }

    const primaryKeys = new Map<string, string[]>([...pks].map(([t, c]) => [t, [c]]));
    return { primaryKeys, foreignKeys: fkByTable };
  }

  /**
   * For each candidate column, whether every row has a distinct, non-null value.
   * One query per table; skipped (all "unknown") when it would scan more than
   * MAX_VERIFY_BYTES, or the table is empty, or the query fails.
   */
  private async verifyUniqueness(tableName: string, columns: string[]): Promise<Map<string, Uniqueness>> {
    const result = new Map<string, Uniqueness>(columns.map((c) => [c, "unknown"]));
    const conn = this.conn;
    if (conn.dialect !== "bigquery") return result;
    if ([tableName, ...columns].some((n) => /`/.test(n))) return result;

    const select = columns
      .map((c, i) => `COUNT(\`${c}\`) AS nn_${i}, COUNT(DISTINCT \`${c}\`) AS d_${i}`)
      .join(", ");
    const query = `SELECT COUNT(*) AS total, ${select} FROM \`${conn.client.projectId}.${this.schema}.${tableName}\``;
    try {
      const stats = await this.sql.dryRun(conn, query);
      if (Number(stats.totalBytesProcessed ?? 0) > MAX_VERIFY_BYTES) return result;
      const row = (await this.sql.query(conn, query))[0] ?? {};
      const total = Number(row.total ?? 0);
      if (total === 0) return result;
      columns.forEach((c, i) => {
        const unique = Number(row[`nn_${i}`]) === total && Number(row[`d_${i}`]) === total;
        result.set(c, unique ? "unique" : "duplicate");
      });
    } catch {
      // leave everything "unknown"
    }
    return result;
  }

  /**
   * Whether the values of an inferred foreign key exist in the key it points at.
   * "unknown" when the check would scan more than MAX_VERIFY_BYTES or fails.
   */
  private async foreignKeyHolds(fk: {
    fkTable: string; fkColumn: string; pkTable: string; pkColumn: string;
  }): Promise<"holds" | "violated" | "unknown"> {
    const conn = this.conn;
    if (conn.dialect !== "bigquery") return "unknown";
    if ([fk.fkTable, fk.fkColumn, fk.pkTable, fk.pkColumn].some((n) => /`/.test(n))) return "unknown";
    const ref = (t: string) => `\`${conn.client.projectId}.${this.schema}.${t}\``;
    const query =
      `SELECT COUNT(*) AS checked, COUNTIF(p.k IS NULL) AS orphans
         FROM (SELECT DISTINCT \`${fk.fkColumn}\` AS k FROM ${ref(fk.fkTable)} WHERE \`${fk.fkColumn}\` IS NOT NULL) f
         LEFT JOIN (SELECT DISTINCT \`${fk.pkColumn}\` AS k FROM ${ref(fk.pkTable)}) p ON f.k = p.k`;
    try {
      const stats = await this.sql.dryRun(conn, query);
      if (Number(stats.totalBytesProcessed ?? 0) > MAX_VERIFY_BYTES) return "unknown";
      const row = (await this.sql.query(conn, query))[0] ?? {};
      const checked = Number(row.checked ?? 0);
      if (checked === 0) return "unknown";
      return Number(row.orphans ?? 0) / checked > MAX_ORPHAN_SHARE ? "violated" : "holds";
    } catch {
      return "unknown";
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
