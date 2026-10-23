/**
 * Renders the Tableau Hive → PGWire gap analysis.
 *
 *   - Markdown for people: the workbook list in test-priority order, then the
 *     details a BI developer needs to fix each one.
 *   - JSON for tooling.
 *   - Two CSVs for tracking in a spreadsheet: one row per file (the list of
 *     problematic workbooks) and one row per finding (the work items).
 */

import type { Analysis, FileAnalysis, Finding } from "./gap-analyzer.js";
import { PRIORITY_LABEL } from "./gap-analyzer.js";
import { PGWIRE_STATUS_LABEL } from "./hive-rules.js";

const esc = (s: string): string => s.replace(/\|/g, "\\|").replace(/\r?\n/g, " ").trim();

/** Inline code that survives backticks in the content (HiveQL identifiers). */
const code = (s: string): string => {
  const runs = s.match(/`+/g) ?? [];
  const fence = "`".repeat(Math.max(0, ...runs.map((r) => r.length)) + 1);
  return fence.length > 1 ? `${fence} ${s} ${fence}` : `\`${s}\``;
};

const oneLine = (s: string, limit = 140): string => {
  const flat = s.split(/\s+/).join(" ").trim();
  return flat.length <= limit ? flat : `${flat.slice(0, limit - 1)}…`;
};

const STATUS_LABEL: Record<FileAnalysis["status"], string> = {
  affected: "Affected",
  unresolved: "Uses unscanned published source",
  "not-affected": "Not affected",
  migrated: "Already on PGWire",
  "parse-error": "Could not read",
};

const KIND_LABEL: Record<Finding["kind"], string> = {
  "legacy-connection": "Legacy Hive connection",
  "initial-sql": "Initial SQL",
  "custom-sql": "Custom SQL",
  rawsql: "RAWSQL field",
  "rawsql-dependent": "Depends on RAWSQL field",
  "date-function": "Driver-translated date function",
};

const legacyConnections = (f: FileAnalysis): string =>
  [...new Set(f.datasources.flatMap((d) =>
    d.status === "published-unresolved"
      ? [`published: ${d.publishedSource}`]
      : d.connections.filter((c) => c.status === "legacy").map((c) => `${c.server}:${c.port}`),
  ))].join(", ");

/** Sheets named by a specific finding; otherwise every sheet on a legacy source. */
const affectedSheets = (f: FileAnalysis): string[] => {
  const specific = f.findings.filter((x) => x.kind !== "legacy-connection").flatMap((x) => x.sheets);
  return [...new Set(specific.length ? specific : f.findings.flatMap((x) => x.sheets))];
};

export function renderGapMarkdown(analysis: Analysis): string {
  const { summary, files, unresolvedPublishedSources } = analysis;
  const out: string[] = [];
  const w = (line = ""): void => { out.push(line); };

  w("# Tableau Hive thrift → PGWire gap analysis");
  w();
  w(`**${summary.files}** Tableau file(s) scanned.`);
  w();
  w("| Status | Files |");
  w("|---|---:|");
  w(`| Affected — must be repointed and tested | ${summary.affected} |`);
  w(`| Uses a published data source that was not scanned | ${summary.unresolved} |`);
  w(`| Already on PGWire | ${summary.migrated} |`);
  w(`| Not connected to AtScale | ${summary.notAffected} |`);
  if (summary.parseErrors) w(`| Could not read | ${summary.parseErrors} |`);
  w();

  const todo = files.filter((f) => f.priority);
  if (todo.length) {
    w("## Validation priority");
    w();
    w("Order from docs/workflows/MIGRATE.md §4.4.");
    w();
    w("| Priority | Meaning | Files |");
    w("|---:|---|---:|");
    for (const p of [1, 2, 3, 4] as const) w(`| ${p} | ${PRIORITY_LABEL[p]} | ${summary.byPriority[p]} |`);
    w();

    w("## Workbooks and data sources to migrate");
    w();
    w("| Priority | File | Type | Legacy connection | RAWSQL | Custom / Initial SQL | May break | Verified breaking | Sheets to test |");
    w("|---:|---|---|---|---:|---:|---:|---:|---|");
    for (const f of todo) {
      const n = (k: Finding["kind"]): number => f.findings.filter((x) => x.kind === k).length;
      const sheets = affectedSheets(f);
      w(`| ${f.priority} | \`${esc(f.relPath)}\` | ${f.kind} | ${esc(legacyConnections(f))} | ` +
        `${n("rawsql")} | ${n("custom-sql") + n("initial-sql")} | ${f.hiveConstructCount} | ${f.verifiedBreakingCount} | ` +
        `${esc(oneLine(sheets.join(", "), 80)) || "—"} |`);
    }
    w();
  }

  if (unresolvedPublishedSources.length) {
    w("## Published data sources not in the scan");
    w();
    w("These workbooks connect through Tableau Server published data sources. Download the");
    w("sources (`.tdsx`) into the same scan to resolve whether they are on the legacy endpoint.");
    w();
    for (const s of unresolvedPublishedSources) w(`- \`${esc(s)}\``);
    w();
  }

  const detailed = todo.filter((f) => f.findings.some((x) => x.kind !== "legacy-connection"));
  if (detailed.length) {
    w("## Findings");
    w();
    for (const f of detailed) {
      w(`### \`${esc(f.relPath)}\``);
      w();
      for (const x of f.findings.filter((y) => y.kind !== "legacy-connection")) {
        w(`- **${KIND_LABEL[x.kind]}** — \`${esc(x.object)}\` in data source \`${esc(x.datasource)}\` (${x.severity})`);
        if (x.snippet) w(`  - ${code(esc(oneLine(x.snippet)))}`);
        for (const h of x.hiveHits) {
          w(`  - ${code(esc(h.match))} → ${esc(h.postgres)} — ${PGWIRE_STATUS_LABEL[h.pgwire]}`);
        }
        if (x.sheets.length) w(`  - Sheets: ${esc(x.sheets.join(", "))}`);
        if (x.dashboards.length) w(`  - Dashboards: ${esc(x.dashboards.join(", "))}`);
        w(`  - ${x.note}`);
      }
      w();
    }
  }

  const errors = files.filter((f) => f.status === "parse-error");
  if (errors.length) {
    w("## Files that could not be read");
    w();
    for (const f of errors) w(`- \`${esc(f.relPath)}\`: ${esc(f.parseError ?? "")}`);
    w();
  }

  w("## Limits");
  w();
  w("- Only SQL sent verbatim (RAWSQL arguments, custom SQL, Initial SQL) is checked.");
  w("- \"Verified\" statuses come from one test: installer 2025.7.2 (Hive) and container C2026.7.0 (PGWire)");
  w("  on a Snowflake warehouse. Functions passed to the warehouse depend on which warehouse it is.");
  w("  A field with no Hive construct listed still has to be run once against PGWire.");
  w("- Hive constructs are matched by pattern; double-quoted string literals inside SQL are not detected.");
  w("- Workbooks connected through a published data source are only resolved when that source is in the scan.");
  w();
  return out.join("\n");
}

export function renderGapJson(analysis: Analysis): string {
  return JSON.stringify(analysis, null, 2);
}

const csvCell = (v: string | number | undefined): string => {
  const s = v === undefined ? "" : String(v);
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};
const csvRow = (cells: Array<string | number | undefined>): string => cells.map(csvCell).join(",");

/** One row per scanned file — the list of problematic workbooks. */
export function renderFilesCsv(analysis: Analysis): string {
  const rows = [csvRow([
    "file", "type", "status", "priority", "legacy_connections", "rawsql_fields",
    "custom_sql", "initial_sql", "may_break", "verified_breaking", "sheets_to_test", "has_extract",
  ])];
  for (const f of analysis.files) {
    const n = (k: Finding["kind"]): number => f.findings.filter((x) => x.kind === k).length;
    rows.push(csvRow([
      f.relPath, f.kind, STATUS_LABEL[f.status], f.priority, legacyConnections(f),
      n("rawsql"), n("custom-sql"), n("initial-sql"), f.hiveConstructCount, f.verifiedBreakingCount,
      affectedSheets(f).join("; "), f.datasources.some((d) => d.hasExtract) ? "yes" : "no",
    ]));
  }
  return rows.join("\n") + "\n";
}

/** One row per finding — the work list. */
export function renderFindingsCsv(analysis: Analysis): string {
  const rows = [csvRow([
    "file", "priority", "finding", "severity", "datasource", "object",
    "hive_constructs", "postgres_replacement", "pgwire_status", "sheets", "dashboards", "snippet",
  ])];
  for (const f of analysis.files) {
    for (const x of f.findings) {
      rows.push(csvRow([
        f.relPath, f.priority, KIND_LABEL[x.kind], x.severity, x.datasource, x.object,
        x.hiveHits.map((h) => h.match).join("; "), x.hiveHits.map((h) => h.postgres).join("; "),
        x.hiveHits.map((h) => h.pgwire).join("; "),
        x.sheets.join("; "), x.dashboards.join("; "), oneLine(x.snippet, 500),
      ]));
    }
  }
  return rows.join("\n") + "\n";
}
