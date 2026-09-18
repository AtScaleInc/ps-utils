/**
 * Renders the Power BI DAX gap analysis.
 *
 * Mirrors the shape of the tabular converter's CONVERSION_REPORT: a Markdown
 * report for people, a JSON one for tooling, plus a per-measure work list. The
 * report is organised by *what to do* -- keep in report, push into the model,
 * redesign -- rather than by function, because the function ranking alone does
 * not tell a modeller which measures they can actually rescue.
 */

import type { GapAnalysis, MeasureGap } from "./gap-analyzer.js";

const esc = (s: string): string => s.replace(/\|/g, "\\|").replace(/\n/g, " ").trim();

const oneLine = (s: string, limit = 120): string => {
  const flat = s.split(/\s+/).join(" ").trim();
  return flat.length <= limit ? flat : `${flat.slice(0, limit - 1)}…`;
};

const pct = (part: number, total: number): string =>
  total ? `${((100 * part) / total).toFixed(1)}%` : "0.0%";

const RECOMMENDATION_LABEL: Record<MeasureGap["recommendation"], string> = {
  "keep-in-report": "Keep in the report (client-side DAX is supported)",
  "push-to-model": "Push into the AtScale model (unsupported client-side, converts server-side)",
  redesign: "Redesign (supported by neither surface)",
  unparseable: "Could not parse",
};

export function renderGapMarkdown(analysis: GapAnalysis): string {
  const { report, summary, measures, clientBlockerRanking } = analysis;
  const out: string[] = [];
  const w = (line = ""): void => { out.push(line); };

  w("# Power BI DAX gap analysis");
  w();
  w(`Report: \`${report.fileName}\``);
  w();

  // --- connection context -------------------------------------------------
  if (report.connections.length) {
    w("## Connection");
    w();
    for (const c of report.connections) {
      w(`- **${esc(c.name || "(unnamed)")}** — \`${esc(c.connectionType)}\``);
      if (c.dataSource) w(`  - Data source: \`${esc(c.dataSource)}\``);
      if (c.catalog) w(`  - Catalog: \`${esc(c.catalog)}\`${c.cube ? `, cube \`${esc(c.cube)}\`` : ""}`);
      w(`  - DAX dialect: ${c.daxDialect ? `\`${esc(c.daxDialect)}\`` : "not set (server default)"}`);
    }
    w();
  }

  if (report.hasEmbeddedDataModel) {
    w("> This report carries an embedded `DataModel`. That part is an");
    w("> XPress9-compressed Analysis Services backup and cannot be read here, so");
    w("> **only report-scoped measures were analysed** — any measure defined in the");
    w("> embedded model is invisible to this report. Extract the model with");
    w("> `pbi-tools` (or publish it and export TMSL) and run");
    w("> `generate-sml-from-tabular` on that for the model-side picture.");
    w();
  } else if (report.isLiveConnection) {
    w("> Live connection: the model lives on the server, so every measure below is");
    w("> **report-scoped** — DAX that Power BI sends to AtScale at query time. The");
    w("> model's own measures are analysed separately by `generate-sml-from-tabular`.");
    w();
  }

  // --- headline -----------------------------------------------------------
  w("## Summary");
  w();
  if (summary.total === 0) {
    w("No report-scoped DAX measures were found in this file.");
    w();
    return out.join("\n");
  }

  w(`**${summary.total}** report-scoped measures analysed.`);
  w();
  w("| Outcome | Measures | Share |");
  w("|---|---:|---:|");
  w(`| Supported client-side, keep as is | ${summary.keepInReport} | ${pct(summary.keepInReport, summary.total)} |`);
  w(`| Unsupported client-side, converts server-side | ${summary.pushToModel} | ${pct(summary.pushToModel, summary.total)} |`);
  w(`| Supported by neither surface | ${summary.redesign} | ${pct(summary.redesign, summary.total)} |`);
  w(`| Could not parse | ${summary.parseErrors} | ${pct(summary.parseErrors, summary.total)} |`);
  w(`| **Total** | **${summary.total}** | **100.0%** |`);
  w();
  if (summary.withCaveats) {
    w(`${summary.withCaveats} measure(s) pass the whitelist but hit a documented ` +
      "limitation — see *Caveats* below. These are the ones that fail in ways a " +
      "function check alone does not predict.");
    w();
  }

  // --- blocker ranking ----------------------------------------------------
  if (clientBlockerRanking.length) {
    w("## Functions outside client-side DAX support");
    w();
    w("Ranked by measures affected. This is the list to work down.");
    w();
    w("| Function | Measures | What to do instead |");
    w("|---|---:|---|");
    for (const b of clientBlockerRanking) {
      w(`| \`${b.fn}\` | ${b.measures} | ${esc(b.remediation) || "—"} |`);
    }
    w();
  }

  // --- work lists ---------------------------------------------------------
  const section = (
    kind: MeasureGap["recommendation"], heading: string, blurb: string,
  ): void => {
    const rows = measures.filter((m) => m.recommendation === kind);
    if (!rows.length) return;
    w(`## ${heading} (${rows.length})`);
    w();
    w(blurb);
    w();
    for (const m of rows) {
      w(`**${esc(m.name)}**${m.entity ? ` — \`${esc(m.entity)}\`` : ""}`);
      w();
      w("```dax");
      w(oneLine(m.expression, 400));
      w("```");
      if (m.clientBlockers.length) {
        w(`- Unsupported client-side: ${m.clientBlockers.map((f) => `\`${f}\``).join(", ")}`);
      }
      for (const note of m.clientNotes) w(`- ${esc(note)}`);
      if (kind === "push-to-model") {
        w(`- Server-side verdict: \`${m.serverVerdict}\` — this converts as an AtScale model calculation`);
      }
      if (kind === "redesign" && m.serverBlockers.length) {
        w(`- Also unsupported server-side: ${m.serverBlockers.map((f) => `\`${f}\``).join(", ")}`);
      }
      if (m.referencedModelMeasures.length) {
        w(`- References model measures: ${m.referencedModelMeasures.map((x) => `\`${esc(x)}\``).join(", ")}`);
      }
      if (m.parseError) w(`- Parse error: ${esc(m.parseError)}`);
      w();
    }
  };

  section("push-to-model", "Move into the AtScale model", 
    "Unsupported as report-scoped DAX, but each converts as a server-side model " +
    "calculation. Defining these in AtScale removes the gap and makes them " +
    "reusable outside this report.");

  section("redesign", "Needs redesign",
    "Supported by neither surface. The logic has to be expressed differently — " +
    "usually by modelling it as a metric, or by restructuring against levels the " +
    "model exposes.");

  section("unparseable", "Could not parse",
    "These expressions could not be parsed. Usually a DAX construct the grammar " +
    "does not yet cover — each is worth filing against ps-utils.");

  // --- caveats ------------------------------------------------------------
  const caveated = measures.filter((m) => m.caveats.length > 0);
  if (caveated.length) {
    w("## Caveats");
    w();
    w("These measures use supported functions but hit a documented limitation. " +
      "A whitelist check alone would pass them.");
    w();
    w("| Measure | Caveat |");
    w("|---|---|");
    for (const m of caveated) {
      w(`| ${esc(m.name)} | ${esc(m.caveats.join("; "))} |`);
    }
    w();
  }

  // --- kept ---------------------------------------------------------------
  const kept = measures.filter((m) => m.recommendation === "keep-in-report");
  if (kept.length) {
    w(`## Supported client-side (${kept.length})`);
    w();
    w("These work as report-scoped DAX against AtScale and need no change.");
    w();
    for (const m of kept) w(`- ${esc(m.name)}`);
    w();
  }

  w("## How to read this");
  w();
  w("- **Client-side DAX** is what Power BI sends to AtScale over XMLA for a " +
    "report-scoped measure. AtScale publishes a specific supported list; " +
    "anything not on it is unsupported.");
  w("- **Server-side DAX** is what an AtScale model calculation may contain. It " +
    "is a *different* list — a measure can pass one surface and fail the other, " +
    "which is why both verdicts are shown.");
  w("- A measure in *Move into the AtScale model* is not broken. It just cannot " +
    "live in the report; defining it in the model fixes it and makes it " +
    "available to every other tool.");
  return out.join("\n");
}

export function renderGapJson(analysis: GapAnalysis): string {
  return JSON.stringify(
    {
      report: {
        fileName: analysis.report.fileName,
        hasEmbeddedDataModel: analysis.report.hasEmbeddedDataModel,
        isLiveConnection: analysis.report.isLiveConnection,
        connections: analysis.report.connections,
        pages: analysis.report.pages,
      },
      summary: analysis.summary,
      clientBlockerRanking: analysis.clientBlockerRanking,
      measures: analysis.measures,
    },
    null,
    2,
  );
}

const CSV_COLUMNS = [
  "entity", "name", "recommendation", "clientVerdict", "clientBlockers",
  "serverVerdict", "serverBlockers", "caveats", "referencedModelMeasures",
  "functionsUsed", "expression",
] as const;

const csvCell = (value: string): string => `"${value.replace(/"/g, '""')}"`;

export function renderGapCsv(analysis: GapAnalysis): string {
  const lines = [CSV_COLUMNS.join(",")];
  for (const m of analysis.measures) {
    lines.push([
      m.entity, m.name, m.recommendation, m.clientVerdict,
      m.clientBlockers.join(";"), m.serverVerdict, m.serverBlockers.join(";"),
      m.caveats.join(" | "), m.referencedModelMeasures.join(";"),
      m.functionsUsed.join(";"), m.expression.split(/\s+/).join(" "),
    ].map(csvCell).join(","));
  }
  return `${lines.join("\n")}\n`;
}
