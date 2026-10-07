/**
 * SQL generation helpers shared across all profilers.
 *
 * Identifier quoting is dialect-aware. PostgreSQL, Redshift, Snowflake and DuckDB
 * use double-quotes (ANSI SQL standard); Databricks and BigQuery use backticks and
 * read a double-quoted token as a string literal, so they need `quoter(dialect)`
 * rather than the default `q` / `qualifyTable`.
 *
 * Percentile queries use PERCENTILE_CONT … WITHIN GROUP (ORDER BY …), which is
 * SQL:2003 ordered-set aggregate syntax supported by PostgreSQL ≥ 9.4, Snowflake,
 * Redshift, and DuckDB.  An NTILE(100)-based fallback is attempted automatically
 * when the primary form fails.
 */

import type { DatabaseQueryRunner, PercentileSet } from "./types.js";

// ─── Identifier & table helpers ───────────────────────────────────────────────

/** Dialects that quote identifiers with backticks instead of double-quotes. */
const BACKTICK_DIALECTS = ["databricks", "bigquery", "spark", "hive", "mysql", "mariadb"];

/** True when `dialect` reads a double-quoted token as a string literal. */
export function usesBacktickQuoting(dialect?: string): boolean {
  if (!dialect) return false;
  const d = dialect.toLowerCase();
  return BACKTICK_DIALECTS.some((b) => d.includes(b));
}

/** Quote a single SQL identifier (column or table name). ANSI double-quotes. */
export function q(identifier: string): string {
  return `"${identifier.replace(/"/g, '""')}"`;
}

/** Build a schema-qualified table reference. ANSI double-quotes. */
export function qualifyTable(schema: string, table: string): string {
  return schema ? `${q(schema)}.${q(table)}` : q(table);
}

export interface Quoter {
  q:            (identifier: string) => string;
  qualifyTable: (schema: string, table: string) => string;
}

/**
 * Identifier quoting bound to a dialect.
 *
 * Destructure it at the top of a profiler — `const { q, qualifyTable } = quoter(dialect)`
 * — so the existing call sites in that scope pick up the dialect-aware versions
 * instead of the ANSI defaults exported above.
 */
export function quoter(dialect?: string): Quoter {
  if (!usesBacktickQuoting(dialect)) return { q, qualifyTable };
  const bq = (identifier: string) => `\`${identifier.replace(/`/g, "``")}\``;
  return {
    q:            bq,
    qualifyTable: (schema: string, table: string) => (schema ? `${bq(schema)}.${bq(table)}` : bq(table)),
  };
}

// ─── Row extraction helpers ───────────────────────────────────────────────────

/**
 * Extract a numeric value from a query result row, with a safe fallback.
 * Handles null, undefined, string-encoded numbers (common with JDBC drivers).
 */
export function num(
  row: Record<string, unknown> | undefined,
  key: string,
  fallback = 0,
): number {
  if (!row) return fallback;
  const v = row[key] ?? row[key.toUpperCase()] ?? row[key.toLowerCase()];
  if (v === null || v === undefined) return fallback;
  const n = Number(v);
  return isNaN(n) ? fallback : n;
}

// ─── Percentile query ─────────────────────────────────────────────────────────

/**
 * Query the six percentile points (P5, P25, P50, P75, P95, P99) for a numeric
 * expression drawn from `fromClause`.
 *
 * Strategy:
 *   1. PERCENTILE_CONT … WITHIN GROUP  (SQL:2003 — Snowflake, PG, Redshift, DuckDB)
 *   2. NTILE(100) window fallback       (works everywhere that has window functions)
 */
export async function queryPercentiles(
  runner: DatabaseQueryRunner,
  valueExpr: string,
  fromClause: string,
  whereClause = "",
): Promise<PercentileSet> {
  const where = whereClause ? `WHERE ${whereClause}` : "";

  try {
    const rows = await runner.query(`
      SELECT
        PERCENTILE_CONT(0.05) WITHIN GROUP (ORDER BY ${valueExpr}) AS p5,
        PERCENTILE_CONT(0.25) WITHIN GROUP (ORDER BY ${valueExpr}) AS p25,
        PERCENTILE_CONT(0.50) WITHIN GROUP (ORDER BY ${valueExpr}) AS p50,
        PERCENTILE_CONT(0.75) WITHIN GROUP (ORDER BY ${valueExpr}) AS p75,
        PERCENTILE_CONT(0.95) WITHIN GROUP (ORDER BY ${valueExpr}) AS p95,
        PERCENTILE_CONT(0.99) WITHIN GROUP (ORDER BY ${valueExpr}) AS p99
      FROM ${fromClause}
      ${where}
    `);
    const row = rows[0] ?? {};
    return {
      p5:  num(row, "p5"),
      p25: num(row, "p25"),
      p50: num(row, "p50"),
      p75: num(row, "p75"),
      p95: num(row, "p95"),
      p99: num(row, "p99"),
    };
  } catch {
    // Fallback: NTILE(100) ordered window function
    const rows = await runner.query(`
      SELECT
        MAX(CASE WHEN tile =  5 THEN v END) AS p5,
        MAX(CASE WHEN tile = 25 THEN v END) AS p25,
        MAX(CASE WHEN tile = 50 THEN v END) AS p50,
        MAX(CASE WHEN tile = 75 THEN v END) AS p75,
        MAX(CASE WHEN tile = 95 THEN v END) AS p95,
        MAX(CASE WHEN tile = 99 THEN v END) AS p99
      FROM (
        SELECT ${valueExpr} AS v,
               NTILE(100) OVER (ORDER BY ${valueExpr}) AS tile
        FROM ${fromClause}
        ${where}
      ) ranked
    `);
    const row = rows[0] ?? {};
    return {
      p5:  num(row, "p5"),
      p25: num(row, "p25"),
      p50: num(row, "p50"),
      p75: num(row, "p75"),
      p95: num(row, "p95"),
      p99: num(row, "p99"),
    };
  }
}

/**
 * Quick row count for a table.  Runs SELECT COUNT(*) — exact but may be slow
 * for very large tables.  The operation layer may override this with an
 * INFORMATION_SCHEMA-based estimate if needed.
 */
export async function countRows(
  runner: DatabaseQueryRunner,
  schema: string,
  table: string,
  dialect?: string,
): Promise<number> {
  const qualified = quoter(dialect).qualifyTable(schema, table);
  const rows = await runner.query(`SELECT COUNT(*) AS n FROM ${qualified}`);
  return num(rows[0], "n");
}
