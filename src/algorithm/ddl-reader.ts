// ============================================================
// DDL Reader
//
// Parses SQL DDL text (CREATE TABLE / CREATE VIEW statements)
// and produces a DatabaseMetaData implementation that can
// be passed directly to proposeSemanticModel().
//
// Supported DDL constructs:
//   CREATE [OR REPLACE] TABLE [schema.]name ( ... )
//   CREATE [OR REPLACE] [FORCE] VIEW  [schema.]name AS <sql>
//   Column definitions with data types (single- and multi-word)
//   NULL / NOT NULL constraints
//   PRIMARY KEY — inline and table-level
//   FOREIGN KEY — table-level REFERENCES clause
//   INDEX / CREATE INDEX (parsed as a hint, not authoritative)
//   Block (/* */) and line (--) comments stripped
//
// Limitations:
//   • No support for ALTER TABLE — run DDL through a migration tool first
//   • CHECK / DEFAULT / GENERATED constraints are ignored
//   • Index cardinality/type is always reported as "OTHER"
//   • Compound foreign keys are supported (col1, col2) REFERENCES tbl(c1, c2)
// ============================================================

import {
  DatabaseMetaData,
  TableMeta,
  ColumnMeta,
  ForeignKeyMeta,
  IndexMeta,
  ViewMeta,
} from "./types.js";

// ----------------------------------------------------------
// Internal parsed structures
// ----------------------------------------------------------

interface ParsedColumn {
  columnName: string;
  dataType: string;
  columnSize: number;
  nullable: boolean;
  isPrimaryKey: boolean;
  ordinalPosition: number;
}

interface ParsedForeignKey {
  constraintName: string;
  fkColumns: string[];
  pkTable: string;
  pkColumns: string[];
}

interface ParsedIndex {
  indexName: string;
  columns: string[];
  nonUnique: boolean;
  indexType: "CLUSTERED" | "HASHED" | "OTHER";
}

interface ParsedTable {
  schemaName: string | null;
  tableName: string;
  columns: ParsedColumn[];
  foreignKeys: ParsedForeignKey[];
  indexes: ParsedIndex[];
}

interface ParsedView {
  schemaName: string | null;
  viewName: string;
  definition: string;
  // Views don't carry column metadata in DDL unless explicitly listed;
  // columns are inferred from the SELECT when available, otherwise empty.
  columns: ParsedColumn[];
}

// ----------------------------------------------------------
// Tokenisation helpers
// ----------------------------------------------------------

/**
 * Remove SQL Server / Sybase batch-separator keywords and non-DDL preamble
 * that would otherwise confuse the statement splitter:
 *   GO           — batch separator (no semicolon)
 *   USE database — not a table/view/index statement
 *   CREATE DATABASE / CREATE SCHEMA — not parsed
 *   INCLUDE (...) on CREATE INDEX — key-only columns are what we want
 */
function preprocessDdl(ddl: string): string {
  return ddl
    // Remove IDENTITY(...) modifiers on column definitions (SQL Server)
    .replace(/\s+IDENTITY\s*\(\s*\d+\s*,\s*\d+\s*\)/gi, "")
    // Remove AUTOINCREMENT modifiers (Snowflake / SQLite)
    .replace(/\s+AUTOINCREMENT\b/gi, "")
    // Remove INCLUDE (...) clauses on CREATE INDEX (SQL Server)
    .replace(/\s+INCLUDE\s*\([^)]*\)/gi, "")
    // Remove GO batch separators (must be on its own line, SQL Server)
    .replace(/^\s*GO\s*$/gim, ";")
    // Remove USE [DATABASE|SCHEMA] statements (SQL Server, Snowflake)
    .replace(/^\s*USE\s+(?:DATABASE\s+|SCHEMA\s+)?[\w.]+\s*;?/gim, "")
    // Remove CREATE DATABASE [IF NOT EXISTS] statements
    .replace(/^\s*CREATE\s+DATABASE\s+(?:IF\s+NOT\s+EXISTS\s+)?[\w."'`]+\s*;?/gim, "")
    // Remove CREATE SCHEMA [IF NOT EXISTS] statements
    .replace(/^\s*CREATE\s+SCHEMA\s+(?:IF\s+NOT\s+EXISTS\s+)?[\w."'`]+\s*;?/gim, "")
    // Remove ALTER TABLE ... CLUSTER BY (...) (Snowflake cluster keys)
    .replace(/^\s*ALTER\s+TABLE\s+[\w."'`]+\s+CLUSTER\s+BY\s*\([^)]*\)\s*;?/gim, "")
    // Remove DROP DATABASE / IF EXISTS guards
    .replace(/^\s*IF\s+EXISTS[\s\S]*?DROP\s+DATABASE[\s\S]*?;/gim, "")
    .replace(/^\s*DROP\s+DATABASE[\s\S]*?;/gim, "");
}

/**
 * Strip SQL block comments (/* ... *\/) and line comments (-- ...).
 * Preserves string literals so comments inside quotes aren't stripped.
 */
function stripComments(sql: string): string {
  let result = "";
  let i = 0;
  while (i < sql.length) {
    // Block comment
    if (sql[i] === "/" && sql[i + 1] === "*") {
      const end = sql.indexOf("*/", i + 2);
      i = end === -1 ? sql.length : end + 2;
      result += " ";
      continue;
    }
    // Line comment
    if (sql[i] === "-" && sql[i + 1] === "-") {
      while (i < sql.length && sql[i] !== "\n") i++;
      result += " ";
      continue;
    }
    // Single-quoted string — pass through verbatim
    if (sql[i] === "'") {
      result += sql[i++];
      while (i < sql.length) {
        if (sql[i] === "'" && sql[i + 1] === "'") {
          result += "''";
          i += 2;
        } else if (sql[i] === "'") {
          result += sql[i++];
          break;
        } else {
          result += sql[i++];
        }
      }
      continue;
    }
    result += sql[i++];
  }
  return result;
}

/**
 * Extract the body inside the outermost matching parentheses,
 * starting the search from `startIdx`.
 * Returns { body, endIdx } or null if not found.
 */
function extractParenBody(
  sql: string,
  startIdx: number,
): { body: string; endIdx: number } | null {
  const open = sql.indexOf("(", startIdx);
  if (open === -1) return null;

  let depth = 0;
  let i = open;
  while (i < sql.length) {
    if (sql[i] === "(") depth++;
    else if (sql[i] === ")") {
      depth--;
      if (depth === 0) return { body: sql.slice(open + 1, i), endIdx: i };
    }
    i++;
  }
  return null; // unbalanced
}

/**
 * Split a comma-delimited list, respecting nested parentheses.
 * e.g. "id INT, name VARCHAR(100), CONSTRAINT ..." → three items
 */
function splitTopLevelCommas(s: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let current = "";
  for (const ch of s) {
    if (ch === "(") depth++;
    else if (ch === ")") depth--;
    else if (ch === "," && depth === 0) {
      parts.push(current.trim());
      current = "";
      continue;
    }
    current += ch;
  }
  if (current.trim()) parts.push(current.trim());
  return parts;
}

/** Normalise whitespace and uppercased keywords for easy matching. */
function normalise(s: string): string {
  return s.replace(/\s+/g, " ").trim();
}

/** Parse a possibly-qualified identifier like `schema.table` or `"My Table"`. */
function parseQualifiedName(s: string): { schema: string | null; name: string } {
  // Strip wrapping quotes
  const unquote = (t: string): string =>
    t.replace(/^["'`\[]|["`'\]]$/g, "").trim();

  const dotIdx = s.search(/[`"']?\.[`"']?/);
  if (dotIdx !== -1) {
    const parts = s.split(/[`"']?\.[`"']?/, 2);
    return { schema: unquote(parts[0]), name: unquote(parts[1]) };
  }
  return { schema: null, name: unquote(s) };
}

// ----------------------------------------------------------
// Data type extraction
// ----------------------------------------------------------

/**
 * Multi-word SQL types that should be kept together.
 * Listed longest-first so we match greedily.
 */
const MULTI_WORD_TYPES = [
  "TIMESTAMP WITH TIME ZONE",
  "TIMESTAMP WITHOUT TIME ZONE",
  "CHARACTER VARYING",
  "DOUBLE PRECISION",
  "NATIONAL CHARACTER VARYING",
  "NATIONAL CHARACTER",
  "BINARY VARYING",
  "BINARY LARGE OBJECT",
  "CHARACTER LARGE OBJECT",
];

/**
 * Given the remainder of a column definition after the column name,
 * extract the SQL data type and optional size.
 * Returns { dataType, columnSize }.
 */
function extractDataType(rest: string): { dataType: string; columnSize: number } {
  const upper = rest.toUpperCase().trim();

  // Try multi-word types first
  for (const mw of MULTI_WORD_TYPES) {
    if (upper.startsWith(mw)) {
      return { dataType: mw, columnSize: 0 };
    }
  }

  // Single-word type, possibly followed by (size) or (precision, scale)
  const match = upper.match(/^([A-Z_]+)\s*(?:\((\d+)(?:\s*,\s*\d+)?\))?/);
  if (match) {
    return {
      dataType: match[1],
      columnSize: match[2] ? parseInt(match[2], 10) : 0,
    };
  }

  return { dataType: "VARCHAR", columnSize: 0 };
}

// ----------------------------------------------------------
// Column definition parser
// ----------------------------------------------------------

function parseColumnDef(
  def: string,
  ordinal: number,
  pkColumns: Set<string>,
): ParsedColumn | null {
  const norm = normalise(def);

  // Quoted identifier (handles names with spaces or reserved words)
  const nameMatch =
    norm.match(/^["'`\[]([^\]"'`]+)["`'\]]\s+(.+)$/) ||
    norm.match(/^(\w+)\s+(.+)$/);

  if (!nameMatch) return null;

  const columnName = nameMatch[1];
  const rest = nameMatch[2];

  // Skip table-level constraints
  const upper = norm.toUpperCase();
  if (
    upper.startsWith("PRIMARY KEY") ||
    upper.startsWith("FOREIGN KEY") ||
    upper.startsWith("UNIQUE") ||
    upper.startsWith("CHECK") ||
    upper.startsWith("INDEX") ||
    upper.startsWith("CONSTRAINT") ||
    upper.startsWith("KEY ")
  ) {
    return null;
  }

  const { dataType, columnSize } = extractDataType(rest);
  const nullable = !/\bNOT\s+NULL\b/i.test(rest);
  const isPrimaryKey =
    /\bPRIMARY\s+KEY\b/i.test(rest) || pkColumns.has(columnName.toUpperCase());

  return {
    columnName,
    dataType,
    columnSize,
    nullable,
    isPrimaryKey,
    ordinalPosition: ordinal,
  };
}

// ----------------------------------------------------------
// Table-level constraint parsers
// ----------------------------------------------------------

function parsePrimaryKeyConstraint(def: string): string[] {
  const match = def.match(/PRIMARY\s+KEY\s*\(([^)]+)\)/i);
  if (!match) return [];
  return match[1].split(",").map((c) =>
    c.trim().replace(/^["'`\[]|["`'\]]$/g, "").trim().toUpperCase(),
  );
}

function parseForeignKeyConstraint(
  def: string,
  constraintName: string,
): ParsedForeignKey | null {
  // FOREIGN KEY (col1, col2) REFERENCES table (col3, col4)
  const match = def.match(
    /FOREIGN\s+KEY\s*\(([^)]+)\)\s+REFERENCES\s+([\w."'`\[\]]+)\s*(?:\(([^)]+)\))?/i,
  );
  if (!match) return null;

  const fkColumns = match[1]
    .split(",")
    .map((c) => c.trim().replace(/^["'`\[]|["`'\]]$/g, "").trim());
  const { name: pkTable } = parseQualifiedName(match[2]);
  const pkColumns = match[3]
    ? match[3]
        .split(",")
        .map((c) => c.trim().replace(/^["'`\[]|["`'\]]$/g, "").trim())
    : fkColumns; // assume same name if not specified

  return { constraintName, fkColumns, pkTable, pkColumns };
}

// ----------------------------------------------------------
// CREATE TABLE parser
// ----------------------------------------------------------

function parseCreateTable(statement: string): ParsedTable | null {
  const norm = normalise(statement);

  // Match: CREATE [OR REPLACE] [TEMPORARY] TABLE [IF NOT EXISTS] [schema.]name (...)
  const headerMatch = norm.match(
    /CREATE\s+(?:OR\s+REPLACE\s+)?(?:TEMPORARY\s+)?TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?([\w."'`\[\]]+)\s*\(/i,
  );
  if (!headerMatch) return null;

  const { schema: schemaName, name: tableName } = parseQualifiedName(
    headerMatch[1],
  );

  const bodyResult = extractParenBody(
    norm,
    norm.indexOf("(", headerMatch.index ?? 0),
  );
  if (!bodyResult) return null;

  const items = splitTopLevelCommas(bodyResult.body);

  // First pass: collect inline PK and table-level PK columns
  const pkColumns = new Set<string>();
  for (const item of items) {
    const upper = item.toUpperCase().trim();
    if (/^(?:CONSTRAINT\s+\w+\s+)?PRIMARY\s+KEY/.test(upper)) {
      parsePrimaryKeyConstraint(item).forEach((c) => pkColumns.add(c));
    }
    // Also catch inline PRIMARY KEY on the column line
    if (/\bPRIMARY\s+KEY\b/i.test(item)) {
      const nameM = item.match(/^["'`\[]?(\w+)["'`\]]?/);
      if (nameM) pkColumns.add(nameM[1].toUpperCase());
    }
  }

  const columns: ParsedColumn[] = [];
  const foreignKeys: ParsedForeignKey[] = [];
  let ordinal = 1;
  let constraintCounter = 1;

  for (const item of items) {
    const upper = item.toUpperCase().trim();

    // Table-level PRIMARY KEY — already handled above
    if (/^(?:CONSTRAINT\s+\w+\s+)?PRIMARY\s+KEY/.test(upper)) continue;

    // Table-level FOREIGN KEY
    if (/^(?:CONSTRAINT\s+(\w+)\s+)?FOREIGN\s+KEY/.test(upper)) {
      const cNameMatch = item.match(/^CONSTRAINT\s+(\w+)/i);
      const constraintName =
        cNameMatch?.[1] ?? `fk_${tableName}_${constraintCounter++}`;
      const fk = parseForeignKeyConstraint(item, constraintName);
      if (fk) foreignKeys.push(fk);
      continue;
    }

    // Table-level UNIQUE — skip (not mapped to FK or PK)
    if (/^(?:CONSTRAINT\s+\w+\s+)?UNIQUE\s*\(/.test(upper)) continue;

    // Table-level CHECK — skip
    if (/^(?:CONSTRAINT\s+\w+\s+)?CHECK\s*\(/.test(upper)) continue;

    // Table-level INDEX (MySQL/MariaDB extension)
    if (/^(?:UNIQUE\s+)?(?:KEY|INDEX)\s+/.test(upper)) continue;

    // Column definition
    const col = parseColumnDef(item, ordinal, pkColumns);
    if (col) {
      columns.push(col);
      ordinal++;
    }
  }

  return {
    schemaName,
    tableName,
    columns,
    foreignKeys,
    indexes: [], // filled later by CREATE INDEX statements
  };
}

// ----------------------------------------------------------
// CREATE INDEX parser
// ----------------------------------------------------------

function parseCreateIndex(statement: string): {
  tableName: string;
  index: ParsedIndex;
} | null {
  const norm = normalise(statement);

  // CREATE [UNIQUE] [CLUSTERED|NONCLUSTERED|HASHED] INDEX name ON table (cols)
  const match = norm.match(
    /CREATE\s+(UNIQUE\s+)?(CLUSTERED\s+|NONCLUSTERED\s+|HASHED\s+)?INDEX\s+(\w+)\s+ON\s+([\w."'`\[\]]+)\s*\(([^)]+)\)/i,
  );
  if (!match) return null;

  const isUnique = !!match[1];
  const indexTypeRaw = (match[2] ?? "").trim().toUpperCase();
  const indexName = match[3];
  const { name: tableName } = parseQualifiedName(match[4]);
  const columns = match[5].split(",").map((c) =>
    c.trim().replace(/\s+(ASC|DESC)$/i, "").replace(/^["'`\[]|["`'\]]$/g, "").trim(),
  );

  const indexType: ParsedIndex["indexType"] =
    indexTypeRaw === "CLUSTERED" ? "CLUSTERED" :
    indexTypeRaw === "HASHED"    ? "HASHED"    : "OTHER";

  return {
    tableName,
    index: { indexName, columns, nonUnique: !isUnique, indexType },
  };
}

// ----------------------------------------------------------
// CREATE VIEW parser
// ----------------------------------------------------------

function parseCreateView(statement: string): ParsedView | null {
  const norm = normalise(statement);

  const match = norm.match(
    /CREATE\s+(?:OR\s+REPLACE\s+)?(?:FORCE\s+)?(?:MATERIALIZED\s+)?VIEW\s+(?:IF\s+NOT\s+EXISTS\s+)?([\w."'`\[\]]+)\s+AS\s+([\s\S]+)/i,
  );
  if (!match) return null;

  const { schema: schemaName, name: viewName } = parseQualifiedName(match[1]);
  const definition = match[2].trim();

  return { schemaName, viewName, definition, columns: [] };
}

// ----------------------------------------------------------
// DDL splitter — split a multi-statement DDL file
// ----------------------------------------------------------

/**
 * Split a DDL string into individual statements at semicolons,
 * respecting string literals and nested parens.
 */
function splitStatements(ddl: string): string[] {
  const statements: string[] = [];
  let current = "";
  let depth = 0;
  let inString = false;
  let i = 0;

  while (i < ddl.length) {
    const ch = ddl[i];

    if (!inString && ch === "'") {
      inString = true;
      current += ch;
      i++;
      continue;
    }
    if (inString) {
      current += ch;
      if (ch === "'" && ddl[i + 1] === "'") {
        current += ddl[++i]; // escaped quote
      } else if (ch === "'") {
        inString = false;
      }
      i++;
      continue;
    }

    if (ch === "(") depth++;
    else if (ch === ")") depth--;
    else if (ch === ";" && depth === 0) {
      const stmt = current.trim();
      if (stmt) statements.push(stmt);
      current = "";
      i++;
      continue;
    }

    current += ch;
    i++;
  }
  const last = current.trim();
  if (last) statements.push(last);
  return statements;
}

// ----------------------------------------------------------
// DdlDatabaseMetaData — implements DatabaseMetaData
// ----------------------------------------------------------

/**
 * A DatabaseMetaData implementation backed by parsed DDL.
 *
 * Construct it from a DDL string via `DdlDatabaseMetaData.fromDdl(ddlText)`,
 * or use the static `fromFile(path)` helper to read from disk.
 *
 * @example
 * const meta = DdlDatabaseMetaData.fromDdl(ddlText);
 * const model = await proposeSemanticModel(meta, "SalesModel");
 */
export class DdlDatabaseMetaData implements DatabaseMetaData {
  private readonly tables = new Map<string, ParsedTable>();
  private readonly views = new Map<string, ParsedView>();

  private constructor() {}

  // ----------------------------------------------------------
  // Factory methods
  // ----------------------------------------------------------

  /**
   * Parse a DDL string and return a ready-to-use DatabaseMetaData.
   *
   * @param ddl  Raw SQL DDL text (may contain multiple statements).
   */
  static fromDdl(ddl: string): DdlDatabaseMetaData {
    const instance = new DdlDatabaseMetaData();
    const preprocessed = preprocessDdl(ddl);
    const clean = stripComments(preprocessed);
    const statements = splitStatements(clean);

    for (const stmt of statements) {
      const upper = stmt.trimStart().toUpperCase();

      if (/^CREATE\s+(?:OR\s+REPLACE\s+)?(?:TEMPORARY\s+)?TABLE/i.test(upper)) {
        const table = parseCreateTable(stmt);
        if (table) {
          instance.tables.set(table.tableName.toUpperCase(), table);
        }
      } else if (/^CREATE\s+(?:UNIQUE\s+)?(?:CLUSTERED\s+|NONCLUSTERED\s+|HASHED\s+)?INDEX/i.test(upper)) {
        const result = parseCreateIndex(stmt);
        if (result) {
          const table = instance.tables.get(result.tableName.toUpperCase());
          if (table) table.indexes.push(result.index);
        }
      } else if (/^CREATE\s+(?:OR\s+REPLACE\s+)?(?:FORCE\s+)?(?:MATERIALIZED\s+)?VIEW/i.test(upper)) {
        const view = parseCreateView(stmt);
        if (view) {
          instance.views.set(view.viewName.toUpperCase(), view);
        }
      }
      // ALTER TABLE, CREATE SEQUENCE, etc. are silently ignored
    }

    return instance;
  }

  /**
   * Read a DDL file from disk and parse it.
   *
   * @param filePath  Absolute or relative path to the DDL file.
   */
  static async fromFile(filePath: string): Promise<DdlDatabaseMetaData> {
    const { readFile } = await import("fs/promises");
    const ddl = await readFile(filePath, "utf8");
    return DdlDatabaseMetaData.fromDdl(ddl);
  }

  // ----------------------------------------------------------
  // Diagnostic helpers
  // ----------------------------------------------------------

  /** Returns all table names found in the DDL (original casing). */
  getTableNames(): string[] {
    return Array.from(this.tables.values()).map((t) => t.tableName);
  }

  /** Returns all view names found in the DDL (original casing). */
  getViewNames(): string[] {
    return Array.from(this.views.values()).map((v) => v.viewName);
  }

  // ----------------------------------------------------------
  // DatabaseMetaData implementation
  // ----------------------------------------------------------

  async getTables(schemaPattern?: string): Promise<TableMeta[]> {
    return Array.from(this.tables.values())
      .filter(
        (t) =>
          !schemaPattern ||
          t.schemaName === null ||
          t.schemaName.toUpperCase() === schemaPattern.toUpperCase(),
      )
      .map((t) => ({
        tableName: t.tableName,
        tableType: "TABLE" as const,
      }));
  }

  async getColumns(tableName: string): Promise<ColumnMeta[]> {
    const table = this.tables.get(tableName.toUpperCase());
    if (!table) return [];
    return table.columns.map((c) => ({
      tableName: table.tableName,
      columnName: c.columnName,
      dataType: c.dataType,
      columnSize: c.columnSize,
      nullable: c.nullable,
      isPrimaryKey: c.isPrimaryKey,
      ordinalPosition: c.ordinalPosition,
    }));
  }

  async getForeignKeys(tableName: string): Promise<ForeignKeyMeta[]> {
    const table = this.tables.get(tableName.toUpperCase());
    if (!table) return [];

    const result: ForeignKeyMeta[] = [];
    for (const fk of table.foreignKeys) {
      fk.fkColumns.forEach((fkCol, idx) => {
        result.push({
          fkTableName: table.tableName,
          fkColumnName: fkCol,
          pkTableName: fk.pkTable,
          pkColumnName: fk.pkColumns[idx] ?? fk.pkColumns[0],
          keySeq: idx + 1,
          constraintName: fk.constraintName,
        });
      });
    }
    return result;
  }

  async getIndexInfo(tableName: string): Promise<IndexMeta[]> {
    const table = this.tables.get(tableName.toUpperCase());
    if (!table) return [];

    const result: IndexMeta[] = [];
    for (const idx of table.indexes) {
      idx.columns.forEach((col, pos) => {
        result.push({
          tableName: table.tableName,
          indexName: idx.indexName,
          columnName: col,
          nonUnique: idx.nonUnique,
          ordinalPosition: pos + 1,
          indexType: idx.indexType,
        });
      });
    }
    return result;
  }

  async getViews(schemaPattern?: string): Promise<ViewMeta[]> {
    return Array.from(this.views.values())
      .filter(
        (v) =>
          !schemaPattern ||
          v.schemaName === null ||
          v.schemaName.toUpperCase() === schemaPattern.toUpperCase(),
      )
      .map((v) => ({
        viewName: v.viewName,
        definition: v.definition,
        columns: v.columns.map((c) => ({
          tableName: v.viewName,
          columnName: c.columnName,
          dataType: c.dataType,
          columnSize: c.columnSize,
          nullable: c.nullable,
          isPrimaryKey: false,
          ordinalPosition: c.ordinalPosition,
        })),
      }));
  }

  /**
   * DDL has no actual row data — always returns an empty array.
   * Live database implementations should override this to run a TABLESAMPLE query.
   */
  async sampleRows(_tableName: string, _limit = 250): Promise<Record<string, unknown>[]> {
    return [];
  }
}
