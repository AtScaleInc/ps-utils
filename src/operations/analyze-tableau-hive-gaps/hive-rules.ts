/**
 * SQL constructs that may not carry over from AtScale's Hive thrift endpoint
 * to its PGWire (PostgreSQL) endpoint.
 *
 * Applied only to SQL that Tableau sends to AtScale verbatim: the string
 * arguments of RAWSQL_* calls, custom SQL relations and Initial SQL. Tableau's
 * own functions (DATEDIFF, SPLIT, YEAR, IF ...) are translated by the driver,
 * so the rules must never run over a whole Tableau formula.
 *
 * A HiveQL construct does not always break. Tested end to end with Tableau
 * against the same model on a Snowflake warehouse (installer 2025.7.2 over
 * Hive, container C2026.7.0 over PGWire), AtScale handled them three ways:
 *
 *   rejected     PGWire refuses it: works today, breaks on migration (nvl,
 *                backtick identifiers, and also TRIM, which is not HiveQL)
 *   passthrough  sent to the warehouse on both endpoints, so migration does
 *                not change it; it works only if the warehouse has it
 *                (date_format: Snowflake has none, so it fails on both)
 *   accepted     PGWire understands it: no change needed (<=>)
 *
 * Everything else is "unverified" and has to be run once against PGWire.
 * Kept in step with the "HiveQL vs PostgreSQL Dialect Reference" in
 * docs/workflows/MIGRATE.md.
 */

export type PgwireStatus = "rejected" | "passthrough" | "accepted" | "unverified";

export type HiveRule = {
  id: string;
  /** Matched case-insensitively against the SQL text. */
  pattern: RegExp;
  hive: string;
  postgres: string;
  /** Observed behaviour on AtScale's PGWire endpoint; see the note above. */
  pgwire: PgwireStatus;
};

const fn = (name: string): RegExp => new RegExp(`\\b${name}\\s*\\(`, "i");

export const HIVE_RULES: HiveRule[] = [
  { id: "date_format", pattern: fn("date_format"), hive: "DATE_FORMAT(d, fmt)", postgres: "TO_CHAR(d, fmt)", pgwire: "passthrough" },
  { id: "datediff", pattern: fn("datediff"), hive: "DATEDIFF(end, start)", postgres: "end - start", pgwire: "unverified" },
  { id: "date_add", pattern: fn("date_add"), hive: "DATE_ADD(d, n)", postgres: "d + INTERVAL 'n days'", pgwire: "unverified" },
  { id: "date_sub", pattern: fn("date_sub"), hive: "DATE_SUB(d, n)", postgres: "d - INTERVAL 'n days'", pgwire: "unverified" },
  { id: "year_month_day", pattern: /\b(year|month|day|hour|minute|second|weekofyear|quarter)\s*\(/i, hive: "YEAR(d) / MONTH(d) / ...", postgres: "EXTRACT(YEAR FROM d)", pgwire: "unverified" },
  { id: "unix_timestamp", pattern: fn("unix_timestamp"), hive: "UNIX_TIMESTAMP(d)", postgres: "EXTRACT(EPOCH FROM d)", pgwire: "unverified" },
  { id: "from_unixtime", pattern: fn("from_unixtime"), hive: "FROM_UNIXTIME(n)", postgres: "TO_TIMESTAMP(n)", pgwire: "unverified" },
  { id: "to_date_1arg", pattern: /\bto_date\s*\(([^(),]|\([^()]*\))*\)/i, hive: "TO_DATE(ts)", postgres: "CAST(ts AS DATE) (Postgres TO_DATE needs a format)", pgwire: "unverified" },
  { id: "nvl", pattern: fn("nvl"), hive: "NVL(x, d)", postgres: "COALESCE(x, d)", pgwire: "rejected" },
  { id: "nvl2", pattern: fn("nvl2"), hive: "NVL2(x, a, b)", postgres: "CASE WHEN x IS NOT NULL THEN a ELSE b END", pgwire: "unverified" },
  { id: "if", pattern: fn("if"), hive: "IF(cond, a, b)", postgres: "CASE WHEN cond THEN a ELSE b END", pgwire: "unverified" },
  { id: "null_safe_eq", pattern: /<=>/, hive: "x <=> y", postgres: "x IS NOT DISTINCT FROM y", pgwire: "accepted" },
  { id: "regexp_extract", pattern: fn("regexp_extract"), hive: "REGEXP_EXTRACT(s, pat, idx)", postgres: "SUBSTRING(s FROM pat) / REGEXP_MATCH(s, pat)", pgwire: "unverified" },
  { id: "rlike", pattern: /\brlike\b/i, hive: "s RLIKE pat", postgres: "s ~ pat", pgwire: "unverified" },
  { id: "split", pattern: fn("split"), hive: "SPLIT(s, delim)", postgres: "STRING_TO_ARRAY(s, delim)", pgwire: "unverified" },
  { id: "instr_locate", pattern: /\b(instr|locate)\s*\(/i, hive: "INSTR(s, sub) / LOCATE(sub, s)", postgres: "STRPOS(s, sub)", pgwire: "unverified" },
  { id: "size", pattern: fn("size"), hive: "SIZE(arr)", postgres: "CARDINALITY(arr)", pgwire: "unverified" },
  { id: "collect_list", pattern: /\bcollect_(list|set)\s*\(/i, hive: "COLLECT_LIST / COLLECT_SET", postgres: "ARRAY_AGG(x) / ARRAY_AGG(DISTINCT x)", pgwire: "unverified" },
  { id: "explode", pattern: /\b(explode\s*\(|lateral\s+view\b)/i, hive: "EXPLODE / LATERAL VIEW", postgres: "UNNEST(arr)", pgwire: "unverified" },
  { id: "percentile_approx", pattern: fn("percentile_approx"), hive: "PERCENTILE_APPROX(col, p)", postgres: "PERCENTILE_CONT(p) WITHIN GROUP (ORDER BY col)", pgwire: "unverified" },
  { id: "pmod", pattern: fn("pmod"), hive: "PMOD(a, b)", postgres: "MOD(a, b) (sign differs for negatives)", pgwire: "unverified" },
  { id: "cast_string", pattern: /\bas\s+string\b/i, hive: "CAST(x AS STRING)", postgres: "CAST(x AS VARCHAR)", pgwire: "unverified" },
  // Not HiveQL: PostgreSQL rewrites TRIM(x) to btrim(x), which PGWire rejects.
  { id: "trim", pattern: /\b(b?trim)\s*\(/i, hive: "TRIM(s)", postgres: "No PGWire equivalent verified; match with LIKE 'x%' or trim the column in the model", pgwire: "rejected" },
  { id: "backtick", pattern: /`[^`]+`/, hive: "`identifier`", postgres: "\"identifier\"", pgwire: "rejected" },
];

export type HiveHit = { rule: HiveRule; match: string };

/** Constructs that can break on migration: everything PGWire did not accept. */
export const mayBreak = (h: HiveHit): boolean => h.rule.pgwire !== "accepted";

export const PGWIRE_STATUS_LABEL: Record<PgwireStatus, string> = {
  rejected: "rejected by PGWire (verified)",
  passthrough: "passed to the warehouse on both endpoints (verified); works only if the warehouse supports it",
  accepted: "accepted by PGWire (verified); no change needed",
  unverified: "not verified on PGWire; run once to check",
};

export function findHiveConstructs(sql: string): HiveHit[] {
  const hits: HiveHit[] = [];
  for (const rule of HIVE_RULES) {
    const m = rule.pattern.exec(sql);
    if (m) hits.push({ rule, match: m[0] });
  }
  return hits;
}

/**
 * Pull the SQL string arguments out of every RAWSQL_* / RAWSQLAGG_* call in a
 * Tableau formula. Tableau string literals use either quote and escape a quote
 * by doubling it.
 */
export function extractRawSql(formula: string): string[] {
  const out: string[] = [];
  const re = /\bRAWSQL(?:AGG)?_[A-Z]+\s*\(\s*(["'])/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(formula))) {
    const quote = m[1];
    let i = re.lastIndex;
    let s = "";
    while (i < formula.length) {
      const ch = formula[i];
      if (ch === quote) {
        if (formula[i + 1] === quote) { s += quote; i += 2; continue; }
        break;
      }
      s += ch;
      i++;
    }
    out.push(s);
    re.lastIndex = i + 1;
  }
  return out;
}

/** Tableau date functions the PGWire driver translates differently — test in UAT. */
export const DRIVER_TRANSLATED_DATE_FUNCTIONS = /\b(DATEPART|DATEDIFF|DATETRUNC|DATEADD|DATENAME|MAKEDATE|MAKEDATETIME|ISOWEEK|ISOYEAR|ISOWEEKDAY|ISOQUARTER)\s*\(/i;
