// ============================================================
// DDL Reader
//
// Parses SQL DDL text (CREATE TABLE / CREATE VIEW statements)
// and produces a DatabaseMetaData implementation that can
// be passed directly to proposeSemanticModel().
//
// Supported DDL constructs:
//   CREATE [OR REPLACE] [TRANSIENT|TEMPORARY] TABLE [[database.]schema.]name ( ... )
//   CREATE [OR REPLACE] [SECURE|FORCE|RECURSIVE|MATERIALIZED] VIEW [[database.]schema.]name
//          [( col [COMMENT '...'], ... )] [COPY GRANTS] [COMMENT = '...'] AS [(] <select> [)]
//   View columns — from the explicit column list, else from the SELECT list aliases;
//          view column types resolved via lineage (source table in the same DDL),
//          CAST(x AS type) / x::type, or caller-supplied overrides; otherwise VARCHAR
//   One-, two- and three-part identifiers, quoted or unquoted (database.schema.name)
//   Column definitions with data types (single- and multi-word)
//   NULL / NOT NULL constraints
//   PRIMARY KEY — inline and table-level
//   FOREIGN KEY — table-level REFERENCES clause
//   INDEX / CREATE INDEX (parsed as a hint, not authoritative)
//   Block (/* */) and line (--) comments stripped
//
// Limitations:
//   • ALTER TABLE ADD CONSTRAINT FOREIGN KEY is supported; other ALTER TABLE forms are ignored
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
  databaseName: string | null;
  schemaName: string | null;
  tableName: string;
  columns: ParsedColumn[];
  foreignKeys: ParsedForeignKey[];
  indexes: ParsedIndex[];
}

interface ParsedView {
  databaseName: string | null;
  schemaName: string | null;
  viewName: string;
  definition: string;
  // Columns come from the explicit view column list when present, otherwise
  // from the aliases in the top-level SELECT list.  Types are resolved after
  // all statements are parsed (see resolveViewColumnTypes).
  columns: ParsedColumn[];
  /** Parsed top-level SELECT items, positionally aligned with `columns` when possible. */
  selectItems: SelectItem[];
  /** FROM/JOIN sources of the top-level SELECT: alias (upper) → source object name. */
  sources: Map<string, string>;
  /** Column names (upper) whose type could not be resolved and defaulted to VARCHAR. */
  untypedColumns: Set<string>;
}

/** One item from a SELECT list. */
interface SelectItem {
  /** The expression text (without the alias). */
  expr: string;
  /** Output column name: explicit alias, else the bare column name, else null. */
  outputName: string | null;
}

/** Options accepted by DdlDatabaseMetaData.fromDdl / fromFile. */
export interface DdlReaderOptions {
  /**
   * When true (default), CREATE VIEW objects are exposed through getTables()
   * with tableType "VIEW" so that they are classified as facts / dimensions and
   * emitted as SML datasets, exactly like tables.  When false, views are only
   * returned from getViews() (attribute collections — no measures or joins).
   */
  viewsAsTables?: boolean;
  /**
   * Column data type overrides, keyed by "TABLE.COLUMN" or "SCHEMA.TABLE.COLUMN"
   * (case-insensitive).  Applied to both tables and views after parsing, e.g.
   * { "VW_CASHFLOW.Amount": "NUMBER(38,6)" }.
   */
  columnTypes?: Record<string, string>;
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

/**
 * Regex source matching one identifier part: "quoted", `quoted`, [quoted] or bare.
 * Quoted parts may contain dots and spaces.
 */
const IDENT_PART = String.raw`(?:"(?:[^"]|"")+"|\`[^\`]+\`|\[[^\]]+\]|[\w$]+)`;
/** Regex source matching a one- to three-part qualified name. */
const QUALIFIED_NAME = String.raw`${IDENT_PART}(?:\s*\.\s*${IDENT_PART}){0,2}`;

/** Remove wrapping identifier quotes from a single identifier part. */
function unquoteIdent(t: string): string {
  const s = t.trim();
  if (s.length >= 2) {
    const first = s[0];
    const last = s[s.length - 1];
    if (first === '"' && last === '"') return s.slice(1, -1).replace(/""/g, '"');
    if ((first === "`" && last === "`") || (first === "[" && last === "]") || (first === "'" && last === "'")) {
      return s.slice(1, -1);
    }
  }
  return s;
}

/**
 * Split a qualified identifier into its parts on dots that are outside quotes.
 * e.g. `DB."My.Schema".tbl` → ["DB", "My.Schema", "tbl"]
 */
function splitQualifiedName(s: string): string[] {
  const parts: string[] = [];
  let current = "";
  let quote: string | null = null;
  for (const ch of s.trim()) {
    if (quote) {
      current += ch;
      if (ch === quote) quote = null;
      continue;
    }
    if (ch === '"' || ch === "`") { quote = ch; current += ch; continue; }
    if (ch === "[") { quote = "]"; current += ch; continue; }
    if (ch === ".") { parts.push(current); current = ""; continue; }
    current += ch;
  }
  parts.push(current);
  return parts.map((p) => unquoteIdent(p)).filter((p) => p.length > 0);
}

/**
 * Parse a possibly-qualified identifier: `name`, `schema.name` or
 * `database.schema.name` (each part optionally quoted).
 */
function parseQualifiedName(s: string): { database: string | null; schema: string | null; name: string } {
  const parts = splitQualifiedName(s);
  if (parts.length === 0) return { database: null, schema: null, name: s.trim() };
  const name = parts[parts.length - 1];
  const schema = parts.length >= 2 ? parts[parts.length - 2] : null;
  const database = parts.length >= 3 ? parts[parts.length - 3] : null;
  return { database, schema, name };
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

  // Match: CREATE [OR REPLACE] [TRANSIENT|TEMPORARY] TABLE [IF NOT EXISTS] [[db.]schema.]name (...)
  const headerMatch = norm.match(
    new RegExp(
      String.raw`CREATE\s+(?:OR\s+REPLACE\s+)?(?:(?:LOCAL|GLOBAL)\s+)?(?:(?:TEMPORARY|TEMP|TRANSIENT|VOLATILE)\s+)?TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?(${QUALIFIED_NAME})\s*\(`,
      "i",
    ),
  );
  if (!headerMatch) return null;

  const { database: databaseName, schema: schemaName, name: tableName } = parseQualifiedName(
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
    databaseName,
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
// SQL scanning helpers (quote- and parenthesis-aware)
// ----------------------------------------------------------

/**
 * Walk `sql` and call `visit(index, depth)` for every character that is outside
 * string literals and quoted identifiers.  `depth` is the parenthesis depth
 * *before* the character is processed.
 */
function scanSql(sql: string, visit: (i: number, depth: number) => boolean | void): void {
  let depth = 0;
  let i = 0;
  while (i < sql.length) {
    const ch = sql[i];
    // String literal
    if (ch === "'") {
      i++;
      while (i < sql.length) {
        if (sql[i] === "'" && sql[i + 1] === "'") { i += 2; continue; }
        if (sql[i] === "'") { i++; break; }
        i++;
      }
      continue;
    }
    // Quoted identifier
    if (ch === '"' || ch === "`") {
      const close = sql.indexOf(ch, i + 1);
      i = close === -1 ? sql.length : close + 1;
      continue;
    }
    if (visit(i, depth) === true) return;
    if (ch === "(") depth++;
    else if (ch === ")") depth--;
    i++;
  }
}

/**
 * Find the first occurrence of `keyword` (a whole word, case-insensitive) at
 * parenthesis depth `atDepth`, outside quotes, starting from `from`.
 * Returns the index or -1.
 */
function findTopLevelKeyword(sql: string, keyword: string, from = 0, atDepth = 0): number {
  const kw = keyword.toUpperCase();
  let found = -1;
  scanSql(sql, (i, depth) => {
    if (i < from || depth !== atDepth) return;
    const prev = i > 0 ? sql[i - 1] : " ";
    const next = sql[i + kw.length] ?? " ";
    if (
      sql.substr(i, kw.length).toUpperCase() === kw &&
      !/[\w$"]/.test(prev) &&
      !/[\w$"]/.test(next)
    ) {
      found = i;
      return true;
    }
  });
  return found;
}

/** Split on commas at parenthesis depth 0, ignoring commas inside quotes. */
function splitTopLevelCommasQuoted(s: string): string[] {
  const cuts: number[] = [];
  scanSql(s, (i, depth) => {
    if (depth === 0 && s[i] === ",") cuts.push(i);
  });
  const parts: string[] = [];
  let startIdx = 0;
  for (const c of cuts) {
    parts.push(s.slice(startIdx, c).trim());
    startIdx = c + 1;
  }
  parts.push(s.slice(startIdx).trim());
  return parts.filter((p) => p.length > 0);
}

/** Strip parentheses that wrap the whole expression, e.g. "( select ... )" → "select ...". */
function stripWrappingParens(sql: string): string {
  let t = sql.trim();
  for (;;) {
    if (!t.startsWith("(")) return t;
    const body = extractParenBody(t, 0);
    if (!body || body.endIdx !== t.length - 1) return t;
    t = body.body.trim();
  }
}

/** Pattern for a (possibly qualified) column reference such as `cf."VALUE"` or `t.col`. */
const COLUMN_REF = new RegExp(String.raw`^(?:(${IDENT_PART})\s*\.\s*)?(${IDENT_PART})$`);

/**
 * Parse one SELECT-list item into its expression and output column name.
 *   `expr AS alias`, `expr alias`, `t.col`, `"col"`, `*`, `t.*`
 */
function parseSelectItem(item: string): SelectItem {
  const text = item.trim();
  // Explicit AS alias — the last top-level AS in the item
  let asIdx = -1;
  let searchFrom = 0;
  for (;;) {
    const idx = findTopLevelKeyword(text, "AS", searchFrom);
    if (idx === -1) break;
    asIdx = idx;
    searchFrom = idx + 2;
  }
  if (asIdx !== -1) {
    const alias = text.slice(asIdx + 2).trim();
    if (new RegExp(`^${IDENT_PART}$`).test(alias)) {
      return { expr: text.slice(0, asIdx).trim(), outputName: unquoteIdent(alias) };
    }
  }
  // Bare column reference
  const ref = text.match(COLUMN_REF);
  if (ref) return { expr: text, outputName: unquoteIdent(ref[2]) };
  // Implicit alias: "<expr> alias" where alias is a trailing identifier
  const implicit = text.match(new RegExp(String.raw`^([\s\S]*[)\w"'\]` + "`" + String.raw`])\s+(${IDENT_PART})$`));
  if (implicit && !/^(END|NULL|TRUE|FALSE)$/i.test(implicit[2])) {
    return { expr: implicit[1].trim(), outputName: unquoteIdent(implicit[2]) };
  }
  return { expr: text, outputName: null };
}

/**
 * Parse the top-level SELECT list and FROM/JOIN sources of a view body.
 * CTE bodies, sub-queries and UNION branches after the first are ignored.
 */
function parseSelect(definition: string): { items: SelectItem[]; sources: Map<string, string> } {
  const body = stripWrappingParens(definition);
  const sources = new Map<string, string>();
  const selectIdx = findTopLevelKeyword(body, "SELECT");
  if (selectIdx === -1) return { items: [], sources };

  const fromIdx = findTopLevelKeyword(body, "FROM", selectIdx + 6);
  let listText = body.slice(selectIdx + 6, fromIdx === -1 ? body.length : fromIdx).trim();
  listText = listText.replace(/^(?:DISTINCT|ALL)\s+/i, "").replace(/^TOP\s+\d+\s+/i, "");
  const items = splitTopLevelCommasQuoted(listText).map(parseSelectItem);

  if (fromIdx !== -1) {
    // FROM / JOIN sources up to the first clause that ends the FROM section
    let endIdx = body.length;
    for (const kw of ["WHERE", "GROUP", "HAVING", "QUALIFY", "ORDER", "LIMIT", "UNION", "EXCEPT", "MINUS", "INTERSECT", "WINDOW"]) {
      const k = findTopLevelKeyword(body, kw, fromIdx + 4);
      if (k !== -1 && k < endIdx) endIdx = k;
    }
    const fromText = body.slice(fromIdx + 4, endIdx);
    const sourceRe = new RegExp(
      String.raw`(?:^|,|\bJOIN\b)\s*(${QUALIFIED_NAME})(?:\s+(?:AS\s+)?(?!ON\b|USING\b|WHERE\b|JOIN\b|INNER\b|LEFT\b|RIGHT\b|FULL\b|CROSS\b|NATURAL\b|LATERAL\b)(${IDENT_PART}))?`,
      "gi",
    );
    let m: RegExpExecArray | null;
    while ((m = sourceRe.exec(fromText)) !== null) {
      const objectName = parseQualifiedName(m[1]).name;
      if (/^(SELECT|LATERAL|TABLE)$/i.test(objectName)) continue;
      const alias = m[2] ? unquoteIdent(m[2]) : objectName;
      sources.set(alias.toUpperCase(), objectName);
      sources.set(objectName.toUpperCase(), objectName);
    }
  }
  return { items, sources };
}

/** Return the first identifier of a view column-list entry (drops COMMENT '...' etc.). */
function viewColumnListName(entry: string): string | null {
  const m = entry.trim().match(new RegExp(`^(${IDENT_PART})`));
  return m ? unquoteIdent(m[1]) : null;
}

// ----------------------------------------------------------
// CREATE VIEW parser
// ----------------------------------------------------------

const VIEW_HEADER = new RegExp(
  String.raw`^CREATE\s+(?:OR\s+REPLACE\s+)?(?:(?:SECURE|FORCE|NOFORCE|RECURSIVE|MATERIALIZED|TEMPORARY|TEMP|VOLATILE|LOCAL|GLOBAL)\s+)*VIEW\s+(?:IF\s+NOT\s+EXISTS\s+)?(${QUALIFIED_NAME})`,
  "i",
);

function parseCreateView(statement: string): ParsedView | null {
  const norm = normalise(statement);

  const match = norm.match(VIEW_HEADER);
  if (!match) return null;

  const { database: databaseName, schema: schemaName, name: viewName } = parseQualifiedName(match[1]);
  let rest = norm.slice(match[0].length).trim();

  // Optional explicit column list: VIEW name ("c1", "c2" COMMENT '...', ...)
  const listNames: string[] = [];
  if (rest.startsWith("(")) {
    const list = extractParenBody(rest, 0);
    // A parenthesised SELECT directly after the name is not a column list
    if (list && !/^\s*(SELECT|WITH)\b/i.test(list.body)) {
      for (const entry of splitTopLevelCommasQuoted(list.body)) {
        const name = viewColumnListName(entry);
        if (name) listNames.push(name);
      }
      rest = rest.slice(list.endIdx + 1).trim();
    }
  }

  // Skip modifiers (COPY GRANTS, COMMENT = '...', WITH TAG (...), ...) up to AS
  const asIdx = findTopLevelKeyword(rest, "AS");
  if (asIdx === -1) return null;
  const definition = rest.slice(asIdx + 2).trim();

  const { items, sources } = parseSelect(definition);

  // Column names: explicit list wins, else SELECT output names (skipping * items)
  const names = listNames.length > 0
    ? listNames
    : items.map((it) => it.outputName).filter((n): n is string => !!n);

  const columns: ParsedColumn[] = names.map((columnName, idx) => ({
    columnName,
    dataType: "VARCHAR",
    columnSize: 0,
    nullable: true,
    isPrimaryKey: false,
    ordinalPosition: idx + 1,
  }));

  return {
    databaseName,
    schemaName,
    viewName,
    definition,
    columns,
    selectItems: listNames.length > 0 || items.every((it) => it.outputName) ? items : items.filter((it) => it.outputName),
    sources,
    untypedColumns: new Set(columns.map((c) => c.columnName.toUpperCase())),
  };
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
  private readonly duplicateTableWarnings: string[] = [];
  private readonly readerWarnings: string[] = [];
  private viewsAsTables = true;

  private constructor() {}

  // ----------------------------------------------------------
  // Factory methods
  // ----------------------------------------------------------

  /**
   * Parse a DDL string and return a ready-to-use DatabaseMetaData.
   *
   * @param ddl      Raw SQL DDL text (may contain multiple statements).
   * @param options  Reader options (views-as-tables, column type overrides).
   */
  static fromDdl(ddl: string, options: DdlReaderOptions = {}): DdlDatabaseMetaData {
    const instance = new DdlDatabaseMetaData();
    instance.viewsAsTables = options.viewsAsTables ?? true;
    const preprocessed = preprocessDdl(ddl);
    const clean = stripComments(preprocessed);
    const statements = splitStatements(clean);

    for (const stmt of statements) {
      const upper = stmt.trimStart().toUpperCase();

      if (/^CREATE\s+(?:OR\s+REPLACE\s+)?(?:(?:LOCAL|GLOBAL)\s+)?(?:(?:TEMPORARY|TEMP|TRANSIENT|VOLATILE)\s+)?TABLE\b/i.test(upper)) {
        const table = parseCreateTable(stmt);
        if (table) {
          const key = table.tableName.toUpperCase();
          const existing = instance.tables.get(key);
          if (existing && (existing.schemaName ?? "").toUpperCase() !== (table.schemaName ?? "").toUpperCase()) {
            instance.duplicateTableWarnings.push(
              `Table "${table.tableName}" is defined in both schema "${existing.schemaName ?? "(none)"}" and schema "${table.schemaName ?? "(none)"}" — this DDL parser keys tables by name only, so the schema "${table.schemaName ?? "(none)"}" definition overwrote the earlier one and both will be treated as a single table during semantic model inference.`,
            );
          }
          instance.tables.set(key, table);
        }
      } else if (/^CREATE\s+(?:UNIQUE\s+)?(?:CLUSTERED\s+|NONCLUSTERED\s+|HASHED\s+)?INDEX/i.test(upper)) {
        const result = parseCreateIndex(stmt);
        if (result) {
          const table = instance.tables.get(result.tableName.toUpperCase());
          if (table) table.indexes.push(result.index);
        }
      } else if (VIEW_HEADER.test(normalise(stmt))) {
        const view = parseCreateView(stmt);
        if (view) {
          const key = view.viewName.toUpperCase();
          const existing = instance.views.get(key);
          if (existing && (existing.schemaName ?? "").toUpperCase() !== (view.schemaName ?? "").toUpperCase()) {
            instance.duplicateTableWarnings.push(
              `View "${view.viewName}" is defined in both schema "${existing.schemaName ?? "(none)"}" and schema "${view.schemaName ?? "(none)"}" — views are keyed by name only, so the later definition overwrote the earlier one.`,
            );
          }
          instance.views.set(key, view);
        }
      } else if (/^ALTER\s+TABLE\s+/i.test(upper) && /\bFOREIGN\s+KEY\b/i.test(upper)) {
        // ALTER TABLE [schema.]table ADD [CONSTRAINT name] FOREIGN KEY (...) REFERENCES ...
        const headerMatch = stmt.match(
          /ALTER\s+TABLE\s+([\w."'`\[\]]+)\s+ADD\s+(?:CONSTRAINT\s+(\w+)\s+)?FOREIGN\s+KEY/i,
        );
        if (headerMatch) {
          const { name: tableName } = parseQualifiedName(headerMatch[1]);
          const constraintName = headerMatch[2] ?? `fk_${tableName}_alter`;
          const fk = parseForeignKeyConstraint(stmt, constraintName);
          if (fk) {
            const table = instance.tables.get(tableName.toUpperCase());
            if (table) table.foreignKeys.push(fk);
          }
        }
      }
      // CREATE SEQUENCE, etc. are silently ignored
    }

    for (const key of instance.views.keys()) {
      if (instance.tables.has(key)) {
        instance.duplicateTableWarnings.push(
          `"${instance.views.get(key)!.viewName}" is defined as both a table and a view — the table definition is used.`,
        );
      }
    }

    instance.resolveViewColumnTypes();
    instance.applyColumnTypeOverrides(options.columnTypes ?? {});

    for (const view of instance.views.values()) {
      if (view.columns.length === 0) {
        instance.readerWarnings.push(
          `[VIEW COLUMNS] View "${view.viewName}" has no resolvable columns (no column list and no named SELECT items) — it will be skipped.`,
        );
      } else if (view.untypedColumns.size > 0) {
        const names = view.columns
          .filter((c) => view.untypedColumns.has(c.columnName.toUpperCase()))
          .map((c) => c.columnName);
        const detail = names.length === view.columns.length
          ? `all ${names.length} column(s) default to VARCHAR (source objects are not defined in the DDL)`
          : `${names.length} column(s) default to VARCHAR (${names.slice(0, 8).join(", ")}${names.length > 8 ? ", …" : ""})`;
        instance.readerWarnings.push(
          `[VIEW TYPES] View "${view.viewName}": ${detail}. ` +
          `Only typed numeric columns become measures — use column-types to set types.`,
        );
      }
    }

    return instance;
  }

  // ----------------------------------------------------------
  // View column type resolution
  // ----------------------------------------------------------

  /** Look up a column's type on a table or (already resolved) view. */
  private lookupColumnType(objectName: string, columnName: string): { dataType: string; columnSize: number } | null {
    const key = objectName.toUpperCase();
    const colKey = columnName.toUpperCase();
    const table = this.tables.get(key);
    if (table) {
      const c = table.columns.find((col) => col.columnName.toUpperCase() === colKey);
      return c ? { dataType: c.dataType, columnSize: c.columnSize } : null;
    }
    const view = this.views.get(key);
    if (view) {
      const c = view.columns.find((col) => col.columnName.toUpperCase() === colKey);
      if (c && !view.untypedColumns.has(colKey)) return { dataType: c.dataType, columnSize: c.columnSize };
    }
    return null;
  }

  /** Resolve the type of one SELECT expression: CAST / :: / column lineage. */
  private resolveExprType(
    expr: string,
    sources: Map<string, string>,
  ): { dataType: string; columnSize: number } | null {
    const e = stripWrappingParens(expr.trim());

    // CAST(x AS type) / TRY_CAST(x AS type)
    const cast = e.match(/^(?:TRY_)?CAST\s*\(([\s\S]+)\)$/i);
    if (cast) {
      const asIdx = (() => {
        let last = -1;
        let from = 0;
        for (;;) {
          const i = findTopLevelKeyword(cast[1], "AS", from);
          if (i === -1) return last;
          last = i;
          from = i + 2;
        }
      })();
      if (asIdx !== -1) return extractDataType(cast[1].slice(asIdx + 2));
    }

    // x::type
    const colons = e.lastIndexOf("::");
    if (colons !== -1) {
      let topLevel = false;
      scanSql(e, (i, depth) => {
        if (i === colons && depth === 0) { topLevel = true; return true; }
      });
      if (topLevel) return extractDataType(e.slice(colons + 2));
    }

    // Plain column reference, optionally qualified by a source alias
    const ref = e.match(COLUMN_REF);
    if (ref) {
      const qualifier = ref[1] ? unquoteIdent(ref[1]).toUpperCase() : null;
      const column = unquoteIdent(ref[2]);
      if (qualifier) {
        const source = sources.get(qualifier);
        return source ? this.lookupColumnType(source, column) : null;
      }
      // Unqualified: accept only when exactly one source has the column
      const distinctSources = Array.from(new Set(sources.values()));
      const hits = distinctSources
        .map((src) => this.lookupColumnType(src, column))
        .filter((t): t is { dataType: string; columnSize: number } => t !== null);
      return hits.length === 1 ? hits[0] : null;
    }
    return null;
  }

  /**
   * Resolve view column types from their SELECT expressions.  Runs several
   * passes so that views selecting from other views resolve once their source
   * view is typed.  Columns that cannot be resolved remain VARCHAR and are
   * recorded in `untypedColumns`.
   */
  private resolveViewColumnTypes(): void {
    for (let pass = 0; pass < 5; pass++) {
      let changed = false;
      for (const view of this.views.values()) {
        if (view.selectItems.length !== view.columns.length) continue; // cannot align positionally
        view.columns.forEach((col, idx) => {
          const colKey = col.columnName.toUpperCase();
          if (!view.untypedColumns.has(colKey)) return;
          const t = this.resolveExprType(view.selectItems[idx].expr, view.sources);
          if (t) {
            col.dataType = t.dataType;
            col.columnSize = t.columnSize;
            view.untypedColumns.delete(colKey);
            changed = true;
          }
        });
      }
      if (!changed) break;
    }
  }

  /** Apply caller-supplied "TABLE.COLUMN" → type overrides to tables and views. */
  private applyColumnTypeOverrides(overrides: Record<string, string>): void {
    for (const [rawKey, rawType] of Object.entries(overrides)) {
      const parts = splitQualifiedName(rawKey);
      if (parts.length < 2) {
        this.readerWarnings.push(`[COLUMN TYPES] Ignoring override "${rawKey}" — expected "TABLE.COLUMN".`);
        continue;
      }
      const columnName = parts[parts.length - 1].toUpperCase();
      const objectName = parts[parts.length - 2].toUpperCase();
      const schemaName = parts.length >= 3 ? parts[parts.length - 3].toUpperCase() : null;
      const { dataType, columnSize } = extractDataType(String(rawType));

      const target = this.tables.get(objectName) ?? this.views.get(objectName);
      const targetSchema = target?.schemaName?.toUpperCase() ?? null;
      const col = target?.columns.find((c) => c.columnName.toUpperCase() === columnName);
      if (!target || !col || (schemaName && targetSchema && schemaName !== targetSchema)) {
        this.readerWarnings.push(`[COLUMN TYPES] Override "${rawKey}" did not match any column in the DDL.`);
        continue;
      }
      col.dataType = dataType;
      col.columnSize = columnSize;
      if ("untypedColumns" in target) target.untypedColumns.delete(columnName);
    }
  }

  /**
   * Read a DDL file from disk and parse it.
   *
   * @param filePath  Absolute or relative path to the DDL file.
   */
  static async fromFile(filePath: string, options: DdlReaderOptions = {}): Promise<DdlDatabaseMetaData> {
    const { readFile } = await import("fs/promises");
    const ddl = await readFile(filePath, "utf8");
    return DdlDatabaseMetaData.fromDdl(ddl, options);
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

  /**
   * Returns warnings for table names that appear in more than one schema
   * within the parsed DDL. Tables are keyed by name only (schema-unaware),
   * so a name collision across schemas silently merges two distinct tables
   * into one during inference — surfacing it here lets callers log it.
   */
  getDuplicateTableWarnings(): string[] {
    return [...this.duplicateTableWarnings];
  }

  /**
   * Returns reader diagnostics other than duplicate-name warnings: views whose
   * columns could not be typed, views with no resolvable columns, and
   * column-type overrides that matched nothing.
   */
  getReaderWarnings(): string[] {
    return [...this.readerWarnings];
  }

  /** Returns the distinct schema names found on parsed tables and views. */
  getSchemaNames(): string[] {
    const names = new Set<string>();
    for (const t of this.tables.values()) if (t.schemaName) names.add(t.schemaName);
    for (const v of this.views.values()) if (v.schemaName) names.add(v.schemaName);
    return Array.from(names);
  }

  // ----------------------------------------------------------
  // Internal lookup helpers
  // ----------------------------------------------------------

  /** True when `schemaName` passes a (possibly comma-separated) schema filter. */
  private static schemaMatches(schemaName: string | null, schemaPattern?: string): boolean {
    if (!schemaPattern) return true;
    if (schemaName === null) return true;
    const allowed = schemaPattern.split(",").map((s) => s.trim().toUpperCase()).filter(Boolean);
    return allowed.length === 0 || allowed.includes(schemaName.toUpperCase());
  }

  /** Views that should be exposed as tables (views-as-tables mode, not shadowed by a table). */
  private tableLikeViews(): ParsedView[] {
    if (!this.viewsAsTables) return [];
    return Array.from(this.views.values()).filter(
      (v) => v.columns.length > 0 && !this.tables.has(v.viewName.toUpperCase()),
    );
  }

  /** Resolve a name to a parsed table, or to a table-like view in views-as-tables mode. */
  private lookupTableLike(tableName: string): { name: string; columns: ParsedColumn[] } | null {
    const key = tableName.toUpperCase();
    const table = this.tables.get(key);
    if (table) return { name: table.tableName, columns: table.columns };
    if (this.viewsAsTables) {
      const view = this.views.get(key);
      if (view) return { name: view.viewName, columns: view.columns };
    }
    return null;
  }

  // ----------------------------------------------------------
  // DatabaseMetaData implementation
  // ----------------------------------------------------------

  async getTables(schemaPattern?: string): Promise<TableMeta[]> {
    const tables: TableMeta[] = Array.from(this.tables.values())
      .filter((t) => DdlDatabaseMetaData.schemaMatches(t.schemaName, schemaPattern))
      .map((t) => ({
        tableName: t.tableName,
        tableType: "TABLE" as const,
        ...(t.schemaName ? { schemaName: t.schemaName } : {}),
        ...(t.databaseName ? { databaseName: t.databaseName } : {}),
      }));
    const views: TableMeta[] = this.tableLikeViews()
      .filter((v) => DdlDatabaseMetaData.schemaMatches(v.schemaName, schemaPattern))
      .map((v) => ({
        tableName: v.viewName,
        tableType: "VIEW" as const,
        ...(v.schemaName ? { schemaName: v.schemaName } : {}),
        ...(v.databaseName ? { databaseName: v.databaseName } : {}),
      }));
    return [...tables, ...views];
  }

  async getColumns(tableName: string): Promise<ColumnMeta[]> {
    const table = this.lookupTableLike(tableName);
    if (!table) return [];
    return table.columns.map((c) => ({
      tableName: table.name,
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
    // In views-as-tables mode, views are returned from getTables() instead.
    if (this.viewsAsTables) return [];
    return Array.from(this.views.values())
      .filter((v) => DdlDatabaseMetaData.schemaMatches(v.schemaName, schemaPattern))
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
