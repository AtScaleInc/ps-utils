/**
 * generate-enhanced-query-results
 *
 * Takes a run-results CSV produced by execute-atscale-query-harness and
 * enriches each row with the AtScale query_id that was assigned when the query
 * actually ran.  The correlation works because execute-atscale-query-harness
 * prepends a comment to every executed query:
 *
 *   /* {"run_query_id":"<uuid>","original_text_hash":"<sha256>"} *\/
 *
 * This operation searches the AtScale internal Postgres backend for queries
 * whose query_text starts with that comment, extracts the run_query_id, and
 * joins it back to the CSV rows, writing the result as a new CSV with these
 * additional columns:
 *
 *   run_atscale_query_id  — AtScale's internal query_id
 *   outbound_text         — SQL AtScale sent to the underlying database
 *   used_agg              — 'true' if the query used an AtScale aggregate table
 *   elapsed_ms            — total query time from planning start to last result (ms)
 *   parse_ms              — planning phase duration (ms; only when backend exposes finish ts)
 *   execute_ms            — total execution time across all subqueries (ms; best-effort)
 *   fetch_ms              — total fetch time across all subqueries (ms; best-effort)
 *   execution_plan        — EXPLAIN output from the target database (optional;
 *                           requires --target-connection-name)
 */
import { Operation } from "../Operation.js";
import { ParameterSet, StringParameter } from "../../Parameters.js";
import type { ServiceRegistry } from "../../services/registry.js";
import type { Logger } from "../../logging.js";
import { SqlService, type ConnectionConfig, type SqlConnection } from "../../services/SqlService.js";
import fs from "fs";
import path from "path";
import { parse as parseYaml } from "yaml";

// ── Parameter set ──────────────────────────────────────────────────────────────

class GenerateEnhancedQueryResultsParameterSet extends ParameterSet {
  parameters = [
    new (class extends StringParameter {
      name = "results-file";
      description =
        "Path to the run-results CSV produced by execute-atscale-query-harness";
      required = true;
    })(),
    new (class extends StringParameter {
      name = "connection-file";
      description = "Path to connections.yaml";
      required = true;
    })(),
    new (class extends StringParameter {
      name = "connection-name";
      description =
        "Connection name within connections.yaml. The metadata: block is used " +
        "when present; falls back to the sql: block.";
      required = true;
    })(),
    new (class extends StringParameter {
      name = "output-file";
      description =
        "Output path for the enhanced CSV. " +
        "Defaults to {results-file-stem}_enhanced.csv in the same directory.";
      required = false;
    })(),
    new (class extends StringParameter {
      name = "db-schema";
      description =
        "Postgres schema prefix for the AtScale backend tables " +
        "(e.g. 'engine' or 'atscale'). Auto-detected from the connection file " +
        "when omitted (installer → 'atscale', container → 'engine').";
      required = false;
      defaultValue = "";
    })(),
    new (class extends StringParameter {
      name = "days";
      description =
        "How far back in the AtScale query log to search (default: 7). " +
        "Increase if the harness run was more than a week ago.";
      required = false;
      defaultValue = "7";
    })(),
    new (class extends StringParameter {
      name = "target-connection-name";
      description =
        "Connection name within connections.yaml for the target data source. " +
        "When provided, the operation connects to the target database and fetches " +
        "an execution plan (EXPLAIN) for each outbound query, stored in the " +
        "'execution_plan' column. Supported dialects: snowflake, postgres, redshift.";
      required = false;
    })(),
  ];
}

type Params = {
  "results-file": string;
  "connection-file": string;
  "connection-name": string;
  "output-file"?: string;
  "db-schema": string;
  days: string;
  "target-connection-name"?: string;
};

// ── CSV helpers ────────────────────────────────────────────────────────────────

/**
 * Parse an RFC-4180 CSV string into rows of string arrays.
 * Handles double-quoted fields (embedded commas, quotes, newlines).
 */
function parseCsv(content: string): string[][] {
  const rows: string[][] = [];
  let i = 0;
  const n = content.length;

  while (i < n) {
    const row: string[] = [];

    while (i < n && content[i] !== "\n" && content[i] !== "\r") {
      if (content[i] === '"') {
        i++;
        let field = "";
        while (i < n) {
          if (content[i] === '"' && content[i + 1] === '"') {
            field += '"';
            i += 2;
          } else if (content[i] === '"') {
            i++;
            break;
          } else {
            field += content[i++];
          }
        }
        row.push(field);
      } else {
        let field = "";
        while (i < n && content[i] !== "," && content[i] !== "\n" && content[i] !== "\r") {
          field += content[i++];
        }
        row.push(field.trim());
      }
      if (i < n && content[i] === ",") {
        i++;
      } else {
        break;
      }
    }

    if (i < n && content[i] === "\r") i++;
    if (i < n && content[i] === "\n") i++;

    if (row.length > 0 && !(row.length === 1 && row[0] === "")) {
      rows.push(row);
    }
  }

  return rows;
}

/** Escape a CSV field value. */
function csvField(value: string | number | null | undefined): string {
  const s = value == null ? "" : String(value);
  if (s.includes(",") || s.includes('"') || s.includes("\n")) {
    return `"${s.replace(/"/g, '""')}"`;
  }
  return s;
}

// ── Query text annotation parser ───────────────────────────────────────────────

/**
 * Extract the run_query_id from an annotated query text.
 * Expects the comment injected by execute-atscale-query-harness at the start:
 *   /* {"run_id":"<run_id>","run_query_id":"<uuid>","original_text_hash":"<hash>"} *\/
 * Returns null if no annotation is found or the JSON cannot be parsed.
 */
function extractRunQueryId(queryText: string): string | null {
  const match = queryText.match(/^\/\*\s*(\{[^*]+\})\s*\*\//);
  if (!match) return null;
  try {
    const obj = JSON.parse(match[1]) as Record<string, unknown>;
    return typeof obj.run_query_id === "string" ? obj.run_query_id : null;
  } catch {
    return null;
  }
}

// ── Metadata connection builder ────────────────────────────────────────────────

/**
 * Build a ConnectionConfig that points to the AtScale internal Postgres backend.
 * Uses the metadata: block when present (same pattern as extract-queries-from-atscale).
 * Returns the config, the effective connection name, and a flag indicating installer mode.
 */
function buildMetadataConfig(
  yamlConfig: Record<string, any>,
  connectionName: string,
): { connConfig: ConnectionConfig; connName: string; installer: boolean } {
  const entry = yamlConfig.connections?.[connectionName];
  if (!entry) {
    throw new Error(`Connection '${connectionName}' not found in connections.yaml`);
  }

  if (entry.metadata) {
    // Prefer the dedicated metadata: block for AtScale internal backend access.
    const connConfig: ConnectionConfig = {
      connections: {
        [connectionName]: {
          installer: entry.installer,
          sql: { dialect: "postgres", ...entry.metadata },
        },
      },
      users: yamlConfig.users ?? {},
    };
    return { connConfig, connName: connectionName, installer: !!(entry.installer) };
  }

  if (entry.sql) {
    return {
      connConfig: yamlConfig as ConnectionConfig,
      connName: connectionName,
      installer: !!(entry.installer),
    };
  }

  throw new Error(
    `Connection '${connectionName}' has neither a metadata: nor a sql: block.`,
  );
}

// ── Lookup SQL builder ─────────────────────────────────────────────────────────

/** Escape a value for use in a SQL single-quoted string literal. */
function sqEscape(value: string): string {
  return value.replace(/'/g, "''");
}

/**
 * Actual column names for query-phase timing, discovered via information_schema.
 *
 * Only resultsFinish is required (confirmed present in all known AtScale builds as
 * query_results.finished).  All other timing columns are optional — when absent,
 * the corresponding expression is emitted as NULL::bigint.
 *
 *   parse_ms   = plannedFinish - planning_started                   (queries_planned finish col)
 *   execute_ms = SUM(subqFetchStart - subqSubmittedCol)            (WAIT: DB execution time)
 *              — fallback: MAX(subqFetchStart) - planning_started   (planning+execution combined)
 *   fetch_ms   = SUM(subqFetchFinish - subqFetchStart)             (FETCH: row retrieval time)
 *   elapsed_ms = resultsFinish  - planning_started                 (always present)
 */
type TimingCols = {
  plannedFinish: string | null;      // finish column in queries_planned; null → parse_ms = null
  resultsTable: string;              // 'query_results' or 'query_result'
  resultsFinish: string;             // finish column in results table (required for elapsed_ms)
  // subquery_results join
  subqPkCol: string | null;          // PK column of subqueries table (join key to subquery_results)
  subqFkCol: string | null;          // FK column in subquery_results referencing subqueries
  // subqueries timing (WAIT phase start — when the subquery was submitted to the underlying DB)
  subqSubmittedCol: string | null;   // column in subqueries for when subquery was sent to DB
  // subquery_results timing columns
  subqExecStart: string | null;      // explicit execute start in subquery_results (rare)
  subqExecFinish: string | null;     // explicit execute finish in subquery_results (rare)
  subqFetchStart: string | null;     // WAIT ends / FETCH begins (e.g. subquery_fetch_started)
  subqFetchFinish: string | null;    // FETCH ends / subquery done (e.g. subquery_finished)
};

/** Return value from discoverTimingColumns — includes diagnostics even on failure. */
type TimingDiscovery = {
  timing: TimingCols | null;
  plannedCols: string[];       // all columns found in queries_planned (for diagnostics)
  resultsCols: string[];       // all columns found in query_results / query_result
  subqueriesCols: string[];    // all columns found in subqueries
  subqResultsCols: string[];   // all columns found in subquery_results
};

/**
 * Probe the AtScale backend to find the actual column names for timing fields.
 * Succeeds as long as query_results contains a finish timestamp (confirmed in all
 * known builds as "finished").  All other timing fields are best-effort, discovered
 * by pattern-matching column names in queries_planned and subquery_results.
 */
async function discoverTimingColumns(
  sqlSvc: SqlService,
  conn: SqlConnection,
  schema: string,
): Promise<TimingDiscovery> {
  const empty: TimingDiscovery = {
    timing: null,
    plannedCols: [],
    resultsCols: [],
    subqueriesCols: [],
    subqResultsCols: [],
  };
  try {
    const rows = await sqlSvc.query(conn, `
      SELECT table_name, column_name
      FROM   information_schema.columns
      WHERE  table_schema = '${sqEscape(schema)}'
        AND  table_name IN ('queries_planned', 'query_results', 'query_result',
                            'subqueries', 'subquery_results')
      ORDER BY table_name, ordinal_position
    `);

    const byTable = new Map<string, string[]>();
    for (const r of rows) {
      const tbl = String(r.table_name ?? r.TABLE_NAME ?? "");
      const col = String(r.column_name ?? r.COLUMN_NAME ?? "");
      if (tbl && col) {
        if (!byTable.has(tbl)) byTable.set(tbl, []);
        byTable.get(tbl)!.push(col);
      }
    }

    const planned = byTable.get("queries_planned") ?? [];
    const resultsTable = byTable.has("query_results") ? "query_results" : "query_result";
    const results = byTable.get(resultsTable) ?? [];
    const subqueriesCols = byTable.get("subqueries") ?? [];
    const subqResultsCols = byTable.get("subquery_results") ?? [];

    // results finish — required; "finished" is confirmed in all known AtScale builds
    const resultsFinish =
      results.find((c) => /^finished?$/i.test(c)) ??
      results.find((c) => /finish/i.test(c) && !/start/i.test(c)) ??
      results.find((c) => /\bend\b/i.test(c) && !/start/i.test(c)) ??
      null;

    const diag: TimingDiscovery = {
      timing: null,
      plannedCols: planned,
      resultsCols: results,
      subqueriesCols,
      subqResultsCols,
    };
    if (!resultsFinish) return diag;

    // planning finish — optional; enables parse_ms breakdown
    const plannedFinish =
      planned.find((c) => /planning_finish/i.test(c)) ??
      planned.find((c) => /finish/i.test(c) && !/start/i.test(c)) ??
      planned.find((c) => /\bend\b/i.test(c) && !/start/i.test(c)) ??
      null;

    // subquery_results join key: PK of subqueries + FK in subquery_results
    const subqPkCol =
      subqueriesCols.find((c) => /^subquery_id$/i.test(c)) ??
      subqueriesCols.find((c) => /^id$/i.test(c)) ??
      null;
    const subqFkCol =
      subqResultsCols.find((c) => /^subquery_id$/i.test(c)) ??
      (subqPkCol
        ? subqResultsCols.find((c) => c.toLowerCase() === subqPkCol.toLowerCase())
        : undefined) ??
      null;

    // subqueries submission timestamp: marks when AtScale sent the subquery to the
    // underlying database — the start of the WAIT (DB execution) phase.
    const subqSubmittedCol =
      subqueriesCols.find((c) => /^subquery_started?$/i.test(c)) ??
      subqueriesCols.find((c) => /^outbound_started?$/i.test(c)) ??
      subqueriesCols.find((c) => /submit.*at|at.*submit|submitted/i.test(c)) ??
      subqueriesCols.find((c) => /^sent_at$/i.test(c)) ??
      subqueriesCols.find((c) => /^created_at$/i.test(c)) ??
      subqueriesCols.find((c) =>
        /start/i.test(c) &&
        !/finish|end|id|text|hash|type|count|size|cache|agg/i.test(c) &&
        c !== subqPkCol
      ) ??
      null;

    // execute timing columns in subquery_results
    const subqExecStart =
      subqResultsCols.find((c) => /execut.*start|start.*execut/i.test(c)) ??
      subqResultsCols.find((c) => /exec.*start|start.*exec/i.test(c)) ??
      null;
    const subqExecFinish =
      subqResultsCols.find((c) => /execut.*finish|finish.*execut/i.test(c)) ??
      subqResultsCols.find((c) => /execut.*end(?!_)|end.*execut/i.test(c)) ??
      subqResultsCols.find((c) => /exec.*finish|finish.*exec/i.test(c)) ??
      null;

    // fetch timing columns in subquery_results
    const subqFetchStart =
      subqResultsCols.find((c) => /fetch.*start|start.*fetch/i.test(c)) ??
      null;
    const subqFetchFinish =
      subqResultsCols.find((c) => /fetch.*finish|finish.*fetch/i.test(c)) ??
      subqResultsCols.find((c) => /fetch.*end(?!_)|end.*fetch/i.test(c)) ??
      // Fallback: the overall subquery finish column (e.g. "subquery_finished") marks
      // the end of the fetch phase when no fetch-specific finish column exists.
      subqResultsCols.find((c) => /finished?$/i.test(c) && !/start/i.test(c)) ??
      null;

    return {
      ...diag,
      timing: {
        plannedFinish,
        resultsTable,
        resultsFinish,
        subqPkCol,
        subqFkCol,
        subqSubmittedCol,
        subqExecStart,
        subqExecFinish,
        subqFetchStart,
        subqFetchFinish,
      },
    };
  } catch {
    return empty;
  }
}

/**
 * Build the SQL to retrieve annotated queries from the AtScale backend for
 * the given run IDs and look-back window.
 *
 * The annotation comment starts with /* {"run_id":"<run_id>", so filtering on
 * that prefix is a left-anchored LIKE that can use a btree index if one exists.
 * One OR condition is emitted per unique run_id found in the results CSV.
 * Row-to-CSV correlation is done in TypeScript via the run_query_id embedded
 * in the returned query_text.
 *
 * Subqueries are aggregated with STRING_AGG so multiple subquery texts for
 * one AtScale query_id are joined with a separator.  An INNER JOIN on
 * queries_planned (with the date condition in the ON clause) limits results to
 * queries planned within the look-back window and supplies parse timing.
 * query_results is LEFT JOINed for elapsed_ms (absent on failed queries).
 * subquery_results is LEFT JOINed (through subqueries) for execute_ms and fetch_ms;
 * SUM aggregates per-subquery durations into a query-level total.
 * Timing expressions are NULL when column names could not be discovered.
 */
function buildLookupSql(
  schema: string,
  days: number,
  runIds: string[],
  timing: TimingCols | null,
): string {
  const safeSchema = schema.replace(/[^a-zA-Z0-9_.]/g, "");
  const clauses = runIds
    .map((id) => `q.query_text LIKE '/* {"run_id":"${sqEscape(id)}",%'`)
    .join("\n    OR    ");

  // parse_ms: planning_started → planning finish (requires plannedFinish in queries_planned)
  const parseMsExpr = timing?.plannedFinish
    ? `ROUND(EXTRACT(EPOCH FROM (MAX(p.${timing.plannedFinish}) - MAX(p.planning_started))) * 1000)::bigint`
    : `NULL::bigint`;
  // elapsed_ms: planning_started → last result row (always available when timing is non-null)
  const elapsedMsExpr = timing
    ? `ROUND(EXTRACT(EPOCH FROM (MAX(r.${timing.resultsFinish}) - MAX(p.planning_started))) * 1000)::bigint`
    : `NULL::bigint`;
  const resultsTable = timing ? timing.resultsTable : "query_results";

  // execute_ms / fetch_ms: derived from subqueries + subquery_results.
  // Requires a valid join key (subqPkCol in subqueries, subqFkCol in subquery_results).
  //
  // execute_ms (WAIT phase in AtScale UI):
  //   Preferred: SUM(srl.fetch_start - s.submitted) — DB execution time per subquery.
  //   Second: SUM of explicit exec start/finish cols in subquery_results (rare).
  //   Fallback: MAX(srl.fetch_start) - planning_started — planning + execution combined.
  //
  // fetch_ms (FETCH phase in AtScale UI):
  //   SUM(srl.finish - srl.fetch_start) — row retrieval time per subquery.
  //   Typically 0–2 ms for small result sets; larger for wide/many-row results.
  const hasSubqBase = !!(timing?.subqFkCol && timing?.subqPkCol);

  // Preferred: explicit execute columns in subquery_results (dedicated start+finish)
  const hasSubqExec = hasSubqBase && !!(timing?.subqExecStart && timing?.subqExecFinish);
  // WAIT calculation: subquery submission timestamp (in subqueries table) → fetch_start
  const hasExecFromWait = !hasSubqExec && hasSubqBase && !!(timing?.subqSubmittedCol && timing?.subqFetchStart);
  // Fallback: plan start → max fetch_start (includes planning time)
  const hasExecFromFetch = !hasSubqExec && !hasExecFromWait && hasSubqBase && !!timing?.subqFetchStart;
  // Fetch phase
  const hasSubqFetch = hasSubqBase && !!(timing?.subqFetchStart && timing?.subqFetchFinish);

  const hasSubqJoin = hasSubqBase && (hasSubqExec || hasExecFromWait || hasExecFromFetch || hasSubqFetch);

  const executeMsExpr = hasSubqExec
    ? `ROUND(SUM(EXTRACT(EPOCH FROM (srl.${timing!.subqExecFinish} - srl.${timing!.subqExecStart})) * 1000))::bigint`
    : hasExecFromWait
      ? `ROUND(SUM(EXTRACT(EPOCH FROM (srl.${timing!.subqFetchStart} - s.${timing!.subqSubmittedCol})) * 1000))::bigint`
      : hasExecFromFetch
        ? `ROUND(EXTRACT(EPOCH FROM (MAX(srl.${timing!.subqFetchStart}) - MAX(p.planning_started))) * 1000)::bigint`
        : `NULL::bigint`;
  const fetchMsExpr = hasSubqFetch
    ? `ROUND(SUM(EXTRACT(EPOCH FROM (srl.${timing!.subqFetchFinish} - srl.${timing!.subqFetchStart})) * 1000))::bigint`
    : `NULL::bigint`;

  // Only emit the subquery_results join when at least one timing column pair is available.
  const subqJoin = hasSubqJoin
    ? `LEFT JOIN ${safeSchema}.subquery_results srl ON srl.${timing!.subqFkCol} = s.${timing!.subqPkCol}`
    : "";

  return `
SELECT q.query_id::text AS run_atscale_query_id,
       q.query_text,
       STRING_AGG(s.subquery_text, E'\\n---\\n' ORDER BY s.subquery_text) AS outbound_text,
       CASE WHEN MAX(s.subquery_text) LIKE '%as_agg_%' THEN 'true' ELSE 'false' END AS used_agg,
       ${elapsedMsExpr} AS elapsed_ms,
       ${parseMsExpr} AS parse_ms,
       ${executeMsExpr} AS execute_ms,
       ${fetchMsExpr} AS fetch_ms
FROM   ${safeSchema}.queries    q
LEFT JOIN ${safeSchema}.subqueries       s ON s.query_id = q.query_id
${subqJoin}
JOIN      ${safeSchema}.queries_planned  p ON p.query_id = q.query_id
                                          AND p.planning_started > current_timestamp - INTERVAL '${sqEscape(String(days))} days'
LEFT JOIN ${safeSchema}.${resultsTable}  r ON r.query_id = q.query_id
WHERE  q.service = 'user-query'
AND    (${clauses})
GROUP BY q.query_id, q.query_text
`.trim();
}

// ── Explain plan helpers ───────────────────────────────────────────────────────

/**
 * The STRING_AGG separator used when assembling outbound_text from multiple
 * subqueries.  Split on this to explain each subquery independently.
 */
const SUBQUERY_SEPARATOR = "\n---\n";

/**
 * Build the EXPLAIN statement for the given dialect.
 *
 * Snowflake: SYSTEM$EXPLAIN_PLAN_JSON returns a JSON plan as a string in one
 *   result row.  The query is passed as a single-quoted SQL string literal
 *   (with interior single quotes doubled per standard SQL escaping).
 *
 * PostgreSQL: EXPLAIN (FORMAT JSON) returns a single row whose "QUERY PLAN"
 *   column is a JSON-array string of the plan nodes.
 *
 * Redshift: EXPLAIN returns text rows, one line per row, in a "QUERY PLAN"
 *   column.  Redshift does not support FORMAT JSON.
 *
 * Fallback: plain EXPLAIN — used for any unrecognised dialect.
 */
function buildExplainSql(dialect: string, querySql: string): string {
  switch (dialect) {
    case "snowflake": {
      const escaped = querySql.replace(/'/g, "''");
      return `SELECT SYSTEM$EXPLAIN_PLAN_JSON('${escaped}')`;
    }
    case "postgres":
      return `EXPLAIN (FORMAT JSON) ${querySql}`;
    case "redshift":
      return `EXPLAIN ${querySql}`;
    default:
      return `EXPLAIN ${querySql}`;
  }
}

/** Collapse the result rows from an EXPLAIN statement into a single string. */
function parseExplainRows(dialect: string, rows: any[]): string {
  if (rows.length === 0) return "";
  switch (dialect) {
    case "snowflake": {
      // Single row, single column — the JSON plan string.
      const val = Object.values(rows[0])[0];
      return typeof val === "string" ? val : JSON.stringify(val);
    }
    case "postgres": {
      // Single row, "QUERY PLAN" column — already a JSON string.
      const r = rows[0];
      const val = r["QUERY PLAN"] ?? r["query_plan"] ?? Object.values(r)[0];
      return typeof val === "string" ? val : JSON.stringify(val);
    }
    default: {
      // Text plan, one line per row.
      return rows
        .map((r) => {
          const val = r["QUERY PLAN"] ?? r["query_plan"] ?? Object.values(r)[0];
          return String(val ?? "");
        })
        .join("\n");
    }
  }
}

/** Result from fetchExplainPlan — plan text plus per-call error counts for summary logging. */
type ExplainResult = {
  plan: string;
  errorCount: number;
  atscaleErrorCount: number;
};

/**
 * Fetch the EXPLAIN plan for an outbound_text value.  If the text contains
 * multiple subqueries (joined by SUBQUERY_SEPARATOR), each is explained
 * separately and the plans are joined with the same separator.
 * Per-subquery errors leave the individual plan slot empty and are counted
 * in the returned errorCount so the caller can build a summary without
 * writing error text into the CSV.
 */
async function fetchExplainPlan(
  sqlSvc: SqlService,
  conn: SqlConnection,
  outboundText: string,
  logger: Logger,
): Promise<ExplainResult> {
  const subqueries = outboundText
    .split(SUBQUERY_SEPARATOR)
    .map((s) => s.trim())
    .filter(Boolean);
  if (subqueries.length === 0) return { plan: "", errorCount: 0, atscaleErrorCount: 0 };

  const plans: string[] = [];
  let errorCount = 0;
  let atscaleErrorCount = 0;

  for (const sq of subqueries) {
    try {
      const explainSql = buildExplainSql(conn.dialect, sq);
      const rows = await sqlSvc.query(conn, explainSql);
      plans.push(parseExplainRows(conn.dialect, rows));
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      const isAtscaleError = /couldn't find consistent cube name|cannot support:|error during query planning/i.test(msg);
      if (!isAtscaleError) {
        logger.log(`WARN: EXPLAIN failed: ${msg.split("\n")[0]}`);
      } else {
        atscaleErrorCount++;
      }
      errorCount++;
      plans.push("");
    }
  }

  return { plan: plans.join(SUBQUERY_SEPARATOR), errorCount, atscaleErrorCount };
}

// ── Operation ──────────────────────────────────────────────────────────────────

export class GenerateEnhancedQueryResultsOperation extends Operation<Params> {
  name = "generate-enhanced-query-results";
  description =
    "Enrich a execute-atscale-query-harness results CSV with the AtScale " +
    "query_id, outbound SQL text, and optionally the execution plan from the " +
    "target data source (requires --target-connection-name)";
  parameters = new GenerateEnhancedQueryResultsParameterSet();

  constructor(services: ServiceRegistry, logger: Logger) {
    super(services, logger);
  }

  async run(params: Params): Promise<void> {
    const sqlSvc = this.services.get<SqlService>("sql");

    // ── Read and parse the results CSV ───────────────────────────────────────
    const resultsPath = path.resolve(params["results-file"]);
    if (!fs.existsSync(resultsPath)) {
      throw new Error(`Results file not found: ${resultsPath}`);
    }
    const csvContent = fs.readFileSync(resultsPath, "utf8");
    const rows = parseCsv(csvContent);
    if (rows.length < 2) {
      throw new Error(`Results file has no data rows: ${resultsPath}`);
    }

    const header = rows[0];
    const dataRows = rows.slice(1);

    const runQueryIdIdx = header.indexOf("run_query_id");
    if (runQueryIdIdx === -1) {
      throw new Error(
        `Column 'run_query_id' not found in ${resultsPath}. ` +
        `Was the file produced by execute-atscale-query-harness with --annotate-queries true?`,
      );
    }

    const runQueryIds = new Set(
      dataRows.map((r) => r[runQueryIdIdx]).filter(Boolean),
    );
    const runIdIdx = header.indexOf("run_id");
    const runIds = runIdIdx !== -1
      ? [...new Set(dataRows.map((r) => r[runIdIdx]).filter(Boolean))]
      : [];
    this.logger.info(
      `Read ${dataRows.length} row(s) with ${runQueryIds.size} unique run_query_id(s)` +
      (runIds.length ? ` across ${runIds.length} run_id(s)` : "") +
      ` from ${resultsPath}`,
    );

    if (runIds.length === 0) {
      throw new Error(
        `Column 'run_id' not found in ${resultsPath}. ` +
        `The file must be produced by execute-atscale-query-harness.`,
      );
    }

    // ── Build metadata connection config ─────────────────────────────────────
    const yamlRaw = fs.readFileSync(path.resolve(params["connection-file"]), "utf8");
    const yamlConfig = parseYaml(yamlRaw) as Record<string, any>;
    const { connConfig, connName, installer } = buildMetadataConfig(yamlConfig, params["connection-name"]);

    // Resolve schema: explicit flag > connection schema field > installer default
    const connSql = connConfig.connections?.[connName]?.sql ?? {};
    const schema = params["db-schema"] || connSql.schema || (installer ? "atscale" : "engine");
    const days = Math.max(1, parseInt(params.days, 10) || 7);

    this.logger.info(`Connecting to AtScale backend (schema: ${schema}, look-back: ${days} day(s))…`);

    // ── Query the AtScale backend ─────────────────────────────────────────────
    const conn = await sqlSvc.connect(connConfig, connName);
    let atscaleRows: any[];
    try {
      const { timing, plannedCols, resultsCols, subqueriesCols, subqResultsCols } = await discoverTimingColumns(sqlSvc, conn, schema);
      if (timing) {
        const hasSubqBase = !!(timing.subqFkCol && timing.subqPkCol);
        const hasSubqExec = hasSubqBase && !!(timing.subqExecStart && timing.subqExecFinish);
        const hasExecFromWait = !hasSubqExec && hasSubqBase && !!(timing.subqSubmittedCol && timing.subqFetchStart);
        const hasExecFromFetch = !hasSubqExec && !hasExecFromWait && hasSubqBase && !!timing.subqFetchStart;
        const hasSubqFetch = hasSubqBase && !!(timing.subqFetchStart && timing.subqFetchFinish);
        const executeSource = hasSubqExec ? "execute_ms (explicit cols)"
          : hasExecFromWait ? "execute_ms (WAIT: fetch_start - submitted)"
          : hasExecFromFetch ? "execute_ms (fallback: fetch_start - planning_started)"
          : null;
        const phases = [
          timing.plannedFinish ? "parse_ms" : null,
          executeSource,
          hasSubqFetch ? "fetch_ms" : null,
        ].filter(Boolean);
        this.logger.verbose(
          `Timing: elapsed_ms always present; phase breakdown: ${phases.length ? phases.join(", ") : "none (intermediate timestamps absent)"}`,
        );
        const subqSummary = subqueriesCols.length
          ? `subqueries columns: [${subqueriesCols.join(", ")}]`
          : `${schema}.subqueries not found`;
        const subqResultsSummary = subqResultsCols.length
          ? `subquery_results columns: [${subqResultsCols.join(", ")}]`
          : `${schema}.subquery_results not found`;
        this.logger.verbose(
          `Subquery timing discovery:\n` +
          `  join_key=${timing.subqPkCol ?? "not found"} / ${timing.subqFkCol ?? "not found"}\n` +
          `  submitted=${timing.subqSubmittedCol ?? "not found"} (WAIT start, in subqueries)\n` +
          `  fetch_start=${timing.subqFetchStart ?? "not found"}, fetch_finish=${timing.subqFetchFinish ?? "not found"}\n` +
          `  ${subqSummary}\n` +
          `  ${subqResultsSummary}`,
        );
      } else {
        const plannedSummary = plannedCols.length
          ? `queries_planned columns: [${plannedCols.join(", ")}]`
          : `${schema}.queries_planned not found`;
        const resultsSummary = resultsCols.length
          ? `query_results columns: [${resultsCols.join(", ")}]`
          : `${schema}.query_results not found`;
        this.logger.log(
          `WARN: Could not identify timing columns — all timing fields will be empty.\n` +
          `      ${plannedSummary}\n` +
          `      ${resultsSummary}`,
        );
      }
      const sql = buildLookupSql(schema, days, runIds, timing);
      this.logger.verbose(`Lookup SQL:\n${sql}`);
      atscaleRows = await sqlSvc.query(conn, sql);
    } finally {
      await sqlSvc.close(conn);
    }

    this.logger.info(`Found ${atscaleRows.length} annotated query row(s) in the AtScale backend`);

    // ── Build run_query_id → enriched-fields map ────────────────────────────────
    // A run_query_id is a UUID unique to one execution, so at most one row should
    // match. If multiple rows somehow match the same run_query_id, keep the first.
    const lookupMap = new Map<string, {
      atscaleQueryId: string;
      outboundText: string;
      usedAgg: string;
      elapsedMs: string;
      parseMs: string;
      executeMs: string;
      fetchMs: string;
    }>();
    let parseErrors = 0;

    for (const row of atscaleRows) {
      const queryText: string = row.query_text ?? row.QUERY_TEXT ?? "";
      const atscaleQueryId: string = row.run_atscale_query_id ?? row.RUN_ATSCALE_QUERY_ID ?? "";
      const outboundText: string = row.outbound_text ?? row.OUTBOUND_TEXT ?? "";
      const usedAgg: string = row.used_agg ?? row.USED_AGG ?? "";
      const elapsedMs: string = row.elapsed_ms != null ? String(row.elapsed_ms) : "";
      const parseMs: string = row.parse_ms != null ? String(row.parse_ms) : "";
      const executeMs: string = row.execute_ms != null ? String(row.execute_ms) : "";
      const fetchMs: string = row.fetch_ms != null ? String(row.fetch_ms) : "";
      const runQueryId = extractRunQueryId(queryText);
      if (runQueryId && !lookupMap.has(runQueryId)) {
        lookupMap.set(runQueryId, { atscaleQueryId, outboundText, usedAgg, elapsedMs, parseMs, executeMs, fetchMs });
      } else if (!runQueryId) {
        parseErrors++;
      }
    }

    if (parseErrors > 0) {
      this.logger.log(
        `WARN: ${parseErrors} row(s) from the AtScale backend had a matching LIKE prefix ` +
        `but the run_query_id could not be parsed from the comment.`,
      );
    }

    const matched = dataRows.filter((r) => lookupMap.has(r[runQueryIdIdx])).length;
    const unmatched = dataRows.length - matched;
    this.logger.info(
      `Matched ${matched}/${dataRows.length} row(s). ` +
      (unmatched > 0
        ? `${unmatched} row(s) have no match (annotations disabled, query failed before reaching AtScale, or outside the ${days}-day window).`
        : ""),
    );

    // ── Fetch execution plans from target database (optional) ─────────────────
    const targetConnName = params["target-connection-name"];
    const explainMap = new Map<string, string>(); // runQueryId → execution_plan

    if (targetConnName) {
      this.logger.info(`Fetching execution plans via '${targetConnName}'…`);
      const targetConn = await sqlSvc.connect(
        yamlConfig as ConnectionConfig,
        targetConnName,
      );
      // Cache by outbound text so identical SQL is only EXPLAINed once.
      const planCache = new Map<string, string>();
      let explained = 0;
      let cacheHits = 0;
      let explainErrors = 0;
      let atscaleErrorCount = 0;
      try {
        for (const [runQueryId, { outboundText }] of lookupMap) {
          if (!outboundText) {
            explainMap.set(runQueryId, "");
            continue;
          }
          if (planCache.has(outboundText)) {
            explainMap.set(runQueryId, planCache.get(outboundText)!);
            cacheHits++;
          } else {
            const result = await fetchExplainPlan(sqlSvc, targetConn, outboundText, this.logger);
            explainErrors += result.errorCount;
            atscaleErrorCount += result.atscaleErrorCount;
            planCache.set(outboundText, result.plan);
            explainMap.set(runQueryId, result.plan);
            explained++;
          }
        }
      } finally {
        await sqlSvc.close(targetConn);
      }
      this.logger.info(
        `Execution plans: ${explained - explainErrors} succeeded, ${explainErrors} failed, ${cacheHits} from cache`,
      );
      if (atscaleErrorCount > 0 && atscaleErrorCount === explainErrors) {
        this.logger.log(
          `WARN: All EXPLAIN failures look like AtScale analytics-port errors ` +
          `("Couldn't find consistent cube name"). ` +
          `'${targetConnName}' appears to be an AtScale connection — ` +
          `--target-connection-name must point directly to the underlying data warehouse ` +
          `(e.g. a Snowflake or Redshift connection), not to AtScale's SQL port.`,
        );
      }
    }

    // ── Build enhanced CSV ────────────────────────────────────────────────────
    // Insert enriched columns after run_query_id.
    const insertAfterIdx = runQueryIdIdx + 1;
    const enhancedHeader = [
      ...header.slice(0, insertAfterIdx),
      "run_atscale_query_id",
      "outbound_text",
      "used_agg",
      "elapsed_ms",
      "parse_ms",
      "execute_ms",
      "fetch_ms",
      ...(targetConnName ? ["execution_plan"] : []),
      ...header.slice(insertAfterIdx),
    ];

    const enhancedRows = dataRows.map((row) => {
      const runQueryId = row[runQueryIdIdx] ?? "";
      const match = lookupMap.get(runQueryId);
      return [
        ...row.slice(0, insertAfterIdx),
        match?.atscaleQueryId ?? "",
        match?.outboundText ?? "",
        match?.usedAgg ?? "",
        match?.elapsedMs ?? "",
        match?.parseMs ?? "",
        match?.executeMs ?? "",
        match?.fetchMs ?? "",
        ...(targetConnName ? [explainMap.get(runQueryId) ?? ""] : []),
        ...row.slice(insertAfterIdx),
      ];
    });

    const csvLines = [
      enhancedHeader.map(csvField).join(","),
      ...enhancedRows.map((row) => row.map(csvField).join(",")),
    ];
    const csvOut = csvLines.join("\n") + "\n";

    // ── Write output ──────────────────────────────────────────────────────────
    let outFile: string;
    if (params["output-file"]) {
      outFile = path.resolve(params["output-file"]);
    } else {
      const parsed = path.parse(resultsPath);
      outFile = path.join(parsed.dir, `${parsed.name}_enhanced${parsed.ext}`);
    }

    fs.mkdirSync(path.dirname(outFile), { recursive: true });
    fs.writeFileSync(outFile, csvOut, "utf8");
    this.logger.info(`Wrote enhanced CSV (${enhancedRows.length} row(s)) → ${outFile}`);
  }
}
