/**
 * Decides which Tableau workbooks and data sources the Hive thrift → PGWire
 * switch affects, and how urgently each must be tested.
 *
 * A data source is *legacy* when one of its connections is a Hive / Spark SQL
 * connection, or targets the legacy AtScale thrift port. A workbook that uses
 * a published data source inherits that source's status when the source was
 * scanned too; otherwise it is reported as unresolved.
 *
 * Priorities follow the validation order in MIGRATE.md §4.4:
 *
 *   1  SQL passed to AtScale verbatim (RAWSQL_*, custom SQL, Initial SQL)
 *   2  live connection
 *   3  extract-based
 *   4  no calculated fields — a connection test and one measure comparison
 */

import {
  DRIVER_TRANSLATED_DATE_FUNCTIONS, extractRawSql, findHiveConstructs, mayBreak,
  type HiveHit, type PgwireStatus,
} from "./hive-rules.js";
import type {
  TableauCalculation, TableauConnection, TableauDatasource, TableauFile,
} from "./tableau-reader.js";

export type AnalyzerOptions = {
  /** Port of the legacy Hive thrift endpoint. */
  legacyPort: string;
  /** Port of the PGWire endpoint, to recognise already-migrated sources. */
  pgwirePort: string;
  /** When set, only connections whose server contains this text count as AtScale. */
  atscaleHost?: string;
};

export const DEFAULT_ANALYZER_OPTIONS: AnalyzerOptions = { legacyPort: "11111", pgwirePort: "15432" };

/** Tableau connection classes used for Hive thrift connections to AtScale. */
const HIVE_CLASSES = new Set(["hadoophive", "hive", "spark", "sparksql"]);

export type FindingKind =
  | "legacy-connection"
  | "initial-sql"
  | "custom-sql"
  | "rawsql"
  | "rawsql-dependent"
  | "date-function";

export type Severity = "high" | "medium" | "low";

export const FINDING_SEVERITY: Record<FindingKind, Severity> = {
  "legacy-connection": "medium",
  "initial-sql": "high",
  "custom-sql": "high",
  rawsql: "high",
  "rawsql-dependent": "medium",
  "date-function": "low",
};

export type Finding = {
  kind: FindingKind;
  severity: Severity;
  datasource: string;
  /** Field caption, custom SQL name or connection, as a person would see it. */
  object: string;
  /** The SQL or formula that triggered the finding. */
  snippet: string;
  hiveHits: Array<{ id: string; match: string; postgres: string; pgwire: PgwireStatus }>;
  /** Worksheets that use the object (workbooks only). */
  sheets: string[];
  dashboards: string[];
  note: string;
};

export type ConnectionStatus = "legacy" | "pgwire" | "other";

export type DatasourceSummary = {
  name: string;
  caption: string;
  status: ConnectionStatus | "published-unresolved";
  publishedSource?: string;
  connections: Array<TableauConnection & { status: ConnectionStatus }>;
  hasExtract: boolean;
  calculationCount: number;
};

export type Priority = 1 | 2 | 3 | 4;

export type FileAnalysis = {
  fileName: string;
  relPath: string;
  kind: TableauFile["kind"];
  /** affected: uses a legacy source; unresolved: uses an unscanned published source. */
  status: "affected" | "unresolved" | "not-affected" | "migrated" | "parse-error";
  priority?: Priority;
  datasources: DatasourceSummary[];
  findings: Finding[];
  /** Constructs that may break on PGWire (all but verified "accepted"), across findings. */
  hiveConstructCount: number;
  /** Of those, the ones verified to be rejected by PGWire. */
  verifiedBreakingCount: number;
  parseError?: string;
};

export type Analysis = {
  files: FileAnalysis[];
  /** Published sources referenced by workbooks but not found in the scan. */
  unresolvedPublishedSources: string[];
  summary: {
    files: number;
    affected: number;
    unresolved: number;
    notAffected: number;
    migrated: number;
    parseErrors: number;
    byPriority: Record<Priority, number>;
    findings: Record<FindingKind, number>;
  };
};

export const PRIORITY_LABEL: Record<Priority, string> = {
  1: "SQL passed through verbatim (RAWSQL / custom SQL / Initial SQL)",
  2: "Live connection",
  3: "Extract-based",
  4: "No calculated fields",
};

function connectionStatus(c: TableauConnection, o: AnalyzerOptions): ConnectionStatus {
  if (o.atscaleHost && !c.server.toLowerCase().includes(o.atscaleHost.toLowerCase())) return "other";
  if (HIVE_CLASSES.has(c.connectionClass) || c.port === o.legacyPort) return "legacy";
  if (c.connectionClass === "postgres" || c.port === o.pgwirePort) return "pgwire";
  return "other";
}

// Workbooks name a published source by its content URL ("SalesSource"), while
// downloads are named after its display name ("Sales Source"); compare both
// with everything but letters and digits removed.
const sourceKey = (s: string): string => s.toLowerCase().replace(/[^a-z0-9]/g, "");

const hits = (h: HiveHit[]): Finding["hiveHits"] =>
  h.map(({ rule, match }) => ({ id: rule.id, match, postgres: rule.postgres, pgwire: rule.pgwire }));

/** Field references in a Tableau formula: `[Calculation_1]`, `[Sales]`, `[ds].[f]`. */
function references(formula: string): Set<string> {
  const out = new Set<string>();
  for (const m of formula.matchAll(/\[([^\]]+)\]/g)) out.add(`[${m[1]}]`);
  return out;
}

/** Calculations that reach a RAWSQL calculation through other calculations. */
function rawSqlDependents(calcs: TableauCalculation[], rawNames: Set<string>): Map<string, string[]> {
  const byName = new Map(calcs.map((c) => [c.name, c]));
  const captionToName = new Map(calcs.filter((c) => c.caption).map((c) => [`[${c.caption}]`, c.name]));
  const out = new Map<string, string[]>();
  for (const calc of calcs) {
    if (rawNames.has(calc.name)) continue;
    const reached: string[] = [];
    const seen = new Set<string>([calc.name]);
    const stack = [calc.name];
    while (stack.length) {
      const cur = byName.get(stack.pop()!);
      if (!cur) continue;
      for (const ref of references(cur.formula)) {
        const name = byName.has(ref) ? ref : captionToName.get(ref);
        if (!name || seen.has(name)) continue;
        seen.add(name);
        if (rawNames.has(name)) reached.push(name);
        stack.push(name);
      }
    }
    if (reached.length) out.set(calc.name, reached);
  }
  return out;
}

function analyzeFile(
  file: TableauFile,
  publishedStatus: Map<string, ConnectionStatus>,
  o: AnalyzerOptions,
): FileAnalysis {
  const base = { fileName: file.fileName, relPath: file.relPath, kind: file.kind };
  if (file.parseError) {
    return {
      ...base, status: "parse-error", datasources: [], findings: [],
      hiveConstructCount: 0, verifiedBreakingCount: 0, parseError: file.parseError,
    };
  }

  const findings: Finding[] = [];
  const datasources: DatasourceSummary[] = [];

  const sheetsUsing = (ds: string, column?: string): string[] =>
    file.worksheets
      .filter((w) => ds in w.dependencies && (!column || w.dependencies[ds].includes(column)))
      .map((w) => w.name);
  const dashboardsFor = (sheets: string[]): string[] =>
    [...new Set(sheets.flatMap((s) => file.dashboardsBySheet[s] ?? []))];
  const push = (f: Omit<Finding, "severity" | "dashboards">): void => {
    findings.push({ ...f, severity: FINDING_SEVERITY[f.kind], dashboards: dashboardsFor(f.sheets) });
  };

  for (const ds of file.datasources) {
    const conns = ds.connections.map((c) => ({ ...c, status: connectionStatus(c, o) }));
    let status: DatasourceSummary["status"];
    if (conns.some((c) => c.status === "legacy")) status = "legacy";
    else if (ds.publishedSource) status = publishedStatus.get(sourceKey(ds.publishedSource)) ?? "published-unresolved";
    else if (conns.some((c) => c.status === "pgwire")) status = "pgwire";
    else status = "other";

    datasources.push({
      name: ds.name, caption: ds.caption, status, publishedSource: ds.publishedSource,
      connections: conns, hasExtract: ds.hasExtract, calculationCount: ds.calculations.length,
    });

    // Only legacy sources need fixing; unresolved ones are still scanned so the
    // report is complete once the published source turns out to be legacy.
    if (status !== "legacy" && status !== "published-unresolved") continue;
    const dsLabel = ds.caption || ds.name;
    const allSheets = sheetsUsing(ds.name);

    for (const c of conns.filter((x) => x.status === "legacy")) {
      push({
        kind: "legacy-connection", datasource: dsLabel,
        object: `${c.connectionClass} ${c.server}:${c.port}${c.dbname ? ` / ${c.dbname}` : ""}`,
        snippet: "", hiveHits: [], sheets: allSheets,
        note: `Repoint to PostgreSQL on port ${o.pgwirePort}; Database becomes the AtScale catalog name.`,
      });
      if (c.initialSql.trim()) {
        push({
          kind: "initial-sql", datasource: dsLabel, object: c.caption || c.name || c.server,
          snippet: c.initialSql, hiveHits: hits(findHiveConstructs(c.initialSql)), sheets: allSheets,
          note: "Initial SQL runs on every connect; rewrite any HiveQL for PostgreSQL.",
        });
      }
    }

    for (const sql of ds.customSql) {
      // In a cross-database join, custom SQL against the other database is unaffected.
      const target = conns.find((c) => c.name === sql.connectionName);
      if (target && target.status !== "legacy" && status === "legacy") continue;
      push({
        kind: "custom-sql", datasource: dsLabel, object: sql.name || "Custom SQL Query",
        snippet: sql.sql, hiveHits: hits(findHiveConstructs(sql.sql)), sheets: allSheets,
        note: "Custom SQL is sent verbatim; review every function call for HiveQL syntax.",
      });
    }

    const rawNames = new Set<string>();
    for (const calc of ds.calculations) {
      const raw = extractRawSql(calc.formula);
      if (!raw.length) continue;
      rawNames.add(calc.name);
      const sheets = sheetsUsing(ds.name, calc.name);
      const found = raw.flatMap(findHiveConstructs);
      push({
        kind: "rawsql", datasource: dsLabel, object: calc.caption || calc.name,
        snippet: calc.formula, hiveHits: hits(found), sheets,
        note: found.some(mayBreak)
          ? "RAWSQL text is sent verbatim; rewrite the constructs PGWire rejects."
          : "RAWSQL text is sent verbatim; no breaking construct found, but run it once against PGWire.",
      });
    }

    const captionOf = new Map(ds.calculations.map((c) => [c.name, c.caption || c.name]));
    for (const [name, reached] of rawSqlDependents(ds.calculations, rawNames)) {
      const calc = ds.calculations.find((c) => c.name === name)!;
      push({
        kind: "rawsql-dependent", datasource: dsLabel, object: calc.caption || calc.name,
        snippet: calc.formula, hiveHits: [], sheets: sheetsUsing(ds.name, name),
        note: `Depends on RAWSQL field(s): ${reached.map((r) => captionOf.get(r)).join(", ")}.`,
      });
    }

    for (const calc of ds.calculations) {
      if (rawNames.has(calc.name) || !DRIVER_TRANSLATED_DATE_FUNCTIONS.test(calc.formula)) continue;
      push({
        kind: "date-function", datasource: dsLabel, object: calc.caption || calc.name,
        snippet: calc.formula, hiveHits: [], sheets: sheetsUsing(ds.name, calc.name),
        note: "Date function is translated by the driver; compare results in UAT.",
      });
    }
  }

  const legacy = datasources.filter((d) => d.status === "legacy");
  const unresolved = datasources.filter((d) => d.status === "published-unresolved");
  const allHits = findings.flatMap((f) => f.hiveHits);
  const hiveConstructCount = allHits.filter((h) => h.pgwire !== "accepted").length;
  const verifiedBreakingCount = allHits.filter((h) => h.pgwire === "rejected").length;

  let fileStatus: FileAnalysis["status"];
  if (legacy.length) fileStatus = "affected";
  else if (unresolved.length) fileStatus = "unresolved";
  else if (datasources.some((d) => d.status === "pgwire")) fileStatus = "migrated";
  else fileStatus = "not-affected";

  let priority: Priority | undefined;
  if (fileStatus === "affected" || fileStatus === "unresolved") {
    const relevant = [...legacy, ...unresolved];
    if (findings.some((f) => f.severity === "high")) priority = 1;
    else if (relevant.every((d) => d.calculationCount === 0)) priority = 4;
    else if (relevant.some((d) => !d.hasExtract)) priority = 2;
    else priority = 3;
  }

  return {
    ...base, status: fileStatus, priority, datasources, findings,
    hiveConstructCount, verifiedBreakingCount,
  };
}

export function analyzeFiles(files: TableauFile[], options: Partial<AnalyzerOptions> = {}): Analysis {
  const o = { ...DEFAULT_ANALYZER_OPTIONS, ...options };

  // Resolve published data sources from the .tds/.tdsx files in the same scan,
  // keyed by caption, internal name and file stem.
  const publishedStatus = new Map<string, ConnectionStatus>();
  for (const f of files.filter((x) => x.kind === "datasource" && !x.parseError)) {
    const ds = f.datasources[0] as TableauDatasource | undefined;
    if (!ds) continue;
    const statuses = ds.connections.map((c) => connectionStatus(c, o));
    const status: ConnectionStatus = statuses.includes("legacy")
      ? "legacy" : statuses.includes("pgwire") ? "pgwire" : "other";
    const stem = f.fileName.replace(/\.(tds|tdsx)$/i, "");
    for (const key of [ds.caption, ds.name, stem]) if (key) publishedStatus.set(sourceKey(key), status);
  }

  const analyzed = files.map((f) => analyzeFile(f, publishedStatus, o));

  const unresolvedPublishedSources = [...new Set(
    analyzed.flatMap((f) => f.datasources)
      .filter((d) => d.status === "published-unresolved" && d.publishedSource)
      .map((d) => d.publishedSource!),
  )].sort();

  const findings = {
    "legacy-connection": 0, "initial-sql": 0, "custom-sql": 0,
    rawsql: 0, "rawsql-dependent": 0, "date-function": 0,
  } as Record<FindingKind, number>;
  for (const f of analyzed) for (const x of f.findings) findings[x.kind]++;

  const byPriority = { 1: 0, 2: 0, 3: 0, 4: 0 } as Record<Priority, number>;
  for (const f of analyzed) if (f.priority) byPriority[f.priority]++;

  const count = (s: FileAnalysis["status"]): number => analyzed.filter((f) => f.status === s).length;

  // Most urgent first, then by path.
  analyzed.sort((a, b) =>
    (a.priority ?? 9) - (b.priority ?? 9) || a.relPath.localeCompare(b.relPath));

  return {
    files: analyzed,
    unresolvedPublishedSources,
    summary: {
      files: analyzed.length,
      affected: count("affected"),
      unresolved: count("unresolved"),
      notAffected: count("not-affected"),
      migrated: count("migrated"),
      parseErrors: count("parse-error"),
      byPriority,
      findings,
    },
  };
}
