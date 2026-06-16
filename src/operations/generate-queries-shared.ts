/**
 * Shared query-generation logic for generate-queries-from-sml and
 * generate-queries-from-model.
 *
 * Both operations reduce their respective inputs to MetricEntry[] and
 * LevelEntry[], then delegate to buildQueryPairs and writeQueryFiles here.
 */
import { createHash } from "crypto";
import fs from "fs";
import path from "path";
import type { QueryRecord } from "./extract-queries-from-atscale/ExtractQueriesFromAtScaleOperation.js";
import type { Logger } from "../logging.js";

// ── Intermediate types ─────────────────────────────────────────────────────────

/** One model metric reduced to what query generation needs. */
export interface MetricEntry {
  uniqueName: string;
  label: string;
}

/**
 * One hierarchy level reduced to what query generation needs.
 *   levelLabel      — the display caption used in MDX [Level] brackets
 *   levelNameColumn — the underlying column name used in SQL GROUP BY
 */
export interface LevelEntry {
  dimLabel: string;
  hierLabel: string;
  levelLabel: string;
  levelNameColumn: string;
}

// ── Helpers ────────────────────────────────────────────────────────────────────

export function sha256hex(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

export function makeQueryRecord(
  queryName: string,
  queryLanguage: string,
  originalText: string,
  cubeName: string,
): QueryRecord {
  return {
    queryName,
    queryLanguage,
    originalText,
    originalTextHash: sha256hex(originalText),
    outboundText: null,
    cubeName,
    projectId: "",
    aggregateUsed: false,
    numTimes: 1,
    elapsedTimeInSeconds: null,
    avgResultSetSize: 0,
    atscaleQueryId: "",
  };
}

// ── MDX builders ───────────────────────────────────────────────────────────────

/** Grand-total MDX for one metric — no ROWS axis. */
export function mdxMetricTotal(metricUniqueName: string, cubeName: string): string {
  return (
    `SELECT {[Measures].[${metricUniqueName}]} ON COLUMNS\n` +
    `FROM [${cubeName}]`
  );
}

/**
 * MDX with all model metrics on COLUMNS and one hierarchy level on ROWS.
 * NON EMPTY suppresses empty-cell rows for sparse dimensions.
 */
export function mdxLevelQuery(
  metricUniqueNames: string[],
  dimLabel: string,
  hierLabel: string,
  levelLabel: string,
  cubeName: string,
): string {
  const measures = metricUniqueNames.map((m) => `[Measures].[${m}]`).join(", ");
  return (
    `SELECT {${measures}} ON COLUMNS,\n` +
    `  NON EMPTY [${dimLabel}].[${hierLabel}].[${levelLabel}].MEMBERS ON ROWS\n` +
    `FROM [${cubeName}]`
  );
}

// ── SQL builders ───────────────────────────────────────────────────────────────

/** Grand-total SQL for one metric — no GROUP BY. */
export function sqlMetricTotal(metricUniqueName: string, cubeName: string): string {
  return `SELECT "${metricUniqueName}"\nFROM "${cubeName}"`;
}

/** SQL that groups by one level column and selects all model metrics. */
export function sqlLevelQuery(
  metricUniqueNames: string[],
  levelNameColumn: string,
  cubeName: string,
): string {
  const metricCols = metricUniqueNames.map((m) => `  "${m}"`).join(",\n");
  return (
    `SELECT\n  "${levelNameColumn}",\n${metricCols}\n` +
    `FROM "${cubeName}"\n` +
    `GROUP BY "${levelNameColumn}"\n` +
    `ORDER BY "${levelNameColumn}"`
  );
}

// ── Core generation ────────────────────────────────────────────────────────────

/**
 * Build XMLA and SQL QueryRecord arrays from a flat list of metrics and levels.
 *
 * Produces:
 *   Metric totals    — one grand-total query per metric (no dimensional breakdown)
 *   Level breakdowns — one query per hierarchy level; all metrics on COLUMNS/SELECT
 */
export function buildQueryPairs(
  metrics: MetricEntry[],
  levels: LevelEntry[],
  cubeName: string,
): { xmlaQueries: QueryRecord[]; sqlQueries: QueryRecord[] } {
  const allMetricNames = metrics.map((m) => m.uniqueName);
  const xmlaQueries: QueryRecord[] = [];
  const sqlQueries: QueryRecord[]  = [];

  for (const metric of metrics) {
    const name = `${metric.label} | Total`;
    xmlaQueries.push(makeQueryRecord(name, "analysis", mdxMetricTotal(metric.uniqueName, cubeName), cubeName));
    sqlQueries.push(makeQueryRecord(name, "sql",       sqlMetricTotal(metric.uniqueName, cubeName), cubeName));
  }

  for (const lvl of levels) {
    const name = `${lvl.dimLabel} | ${lvl.hierLabel} | ${lvl.levelLabel}`;
    xmlaQueries.push(makeQueryRecord(
      name, "analysis",
      mdxLevelQuery(allMetricNames, lvl.dimLabel, lvl.hierLabel, lvl.levelLabel, cubeName),
      cubeName,
    ));
    sqlQueries.push(makeQueryRecord(
      name, "sql",
      sqlLevelQuery(allMetricNames, lvl.levelNameColumn, cubeName),
      cubeName,
    ));
  }

  return { xmlaQueries, sqlQueries };
}

// ── Output ─────────────────────────────────────────────────────────────────────

/** Write both query JSON files, creating parent directories as needed. */
export function writeQueryFiles(
  xmlaQueries: QueryRecord[],
  sqlQueries: QueryRecord[],
  xmlaPath: string,
  sqlPath: string,
  logger: Logger,
): void {
  fs.mkdirSync(path.dirname(xmlaPath), { recursive: true });
  fs.mkdirSync(path.dirname(sqlPath),  { recursive: true });

  fs.writeFileSync(xmlaPath, JSON.stringify(xmlaQueries, null, 2) + "\n", "utf8");
  logger.info(`XMLA queries → ${xmlaPath}  (${xmlaQueries.length})`);

  fs.writeFileSync(sqlPath, JSON.stringify(sqlQueries, null, 2) + "\n", "utf8");
  logger.info(`SQL queries  → ${sqlPath}  (${sqlQueries.length})`);
}
