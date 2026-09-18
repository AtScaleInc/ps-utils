/**
 * Judges a Power BI report's DAX against what AtScale will accept.
 *
 * Two surfaces, deliberately reported separately because they have different
 * whitelists and a measure can pass one and fail the other:
 *
 *   **client** — the measure stays in the report and Power BI sends it to
 *   AtScale over XMLA. Judged against AtScale's client-side DAX list.
 *
 *   **server** — the measure is pushed down into the AtScale model as a
 *   calculation. Judged against the server-side DAX list, reusing the
 *   classifier from generate-sml-from-tabular.
 *
 * A measure unsupported client-side is not necessarily lost: if it converts
 * server-side it can be moved into the model. That pairing is the actionable
 * output, so both verdicts are computed for every measure.
 */

import {
  MeasureClassifier, DaxSyntaxError, parseDax, callsWithDepth,
  EMPTY_RESOLVER, type MeasureAssessment,
} from "../generate-sml-from-tabular/dax/index.js";
import {
  clientCaveat, clientRemediation, supportsClientDax,
} from "./client-dax-capabilities.js";
import type { PbixMeasure, PbixReport } from "./pbix-reader.js";

export type ClientVerdict = "supported" | "unsupported" | "parseError";

export type MeasureGap = {
  entity: string;
  name: string;
  expression: string;
  functionsUsed: string[];
  referencedModelMeasures: string[];

  /** Client-side (measure stays in the report). */
  clientVerdict: ClientVerdict;
  clientBlockers: string[];
  clientNotes: string[];
  /** Documented limitations that a whitelist check alone would not catch. */
  caveats: string[];

  /** Server-side (measure pushed into the AtScale model). */
  serverVerdict: MeasureAssessment["verdict"];
  serverBlockers: string[];

  /** What a modeller should actually do with this measure. */
  recommendation: Recommendation;
  parseError?: string;
};

export type Recommendation =
  | "keep-in-report"
  | "push-to-model"
  | "redesign"
  | "unparseable";

export type GapAnalysis = {
  report: PbixReport;
  measures: MeasureGap[];
  summary: {
    total: number;
    clientSupported: number;
    clientUnsupported: number;
    parseErrors: number;
    keepInReport: number;
    pushToModel: number;
    redesign: number;
    withCaveats: number;
  };
  /** Unsupported client-side functions, ranked by measures affected. */
  clientBlockerRanking: Array<{ fn: string; measures: number; remediation: string }>;
};

function recommend(
  client: ClientVerdict, server: MeasureAssessment["verdict"],
): Recommendation {
  if (client === "parseError") return "unparseable";
  if (client === "supported") return "keep-in-report";
  if (server === "daxNative" || server === "mdxTranslated" || server === "baseMetric") {
    return "push-to-model";
  }
  return "redesign";
}

export function analyzeMeasure(measure: PbixMeasure): MeasureGap {
  const base = {
    entity: measure.entity,
    name: measure.name,
    expression: measure.expression,
    referencedModelMeasures: measure.referencedModelMeasures,
  };

  let functions: string[];
  try {
    functions = [...new Set(callsWithDepth(parseDax(measure.expression)).map(([c]) => c.name))].sort();
  } catch (err) {
    const message = err instanceof DaxSyntaxError
      ? `${err.message} (position ${err.position})`
      : String(err);
    return {
      ...base, functionsUsed: [],
      clientVerdict: "parseError", clientBlockers: [], clientNotes: [], caveats: [],
      serverVerdict: "parseError", serverBlockers: [],
      recommendation: "unparseable", parseError: message,
    };
  }

  const clientBlockers = functions.filter((f) => !supportsClientDax(f));
  const clientVerdict: ClientVerdict = clientBlockers.length === 0 ? "supported" : "unsupported";
  const clientNotes = clientBlockers
    .map((f) => { const r = clientRemediation(f); return r ? `${f}: ${r}` : ""; })
    .filter(Boolean);
  const caveats = functions
    .map((f) => { const c = clientCaveat(f); return c ? `${f}: ${c}` : ""; })
    .filter(Boolean);

  // Server-side judgement. EMPTY_RESOLVER means no dimension paths resolve, so
  // MDX translation that depends on the model is conservatively refused -- this
  // is a gap report, not a conversion, and we must not overstate what converts.
  const classifier = new MeasureClassifier(EMPTY_RESOLVER);
  const server = classifier.classify(measure.entity, measure.name, measure.expression);

  return {
    ...base,
    functionsUsed: functions,
    clientVerdict, clientBlockers, clientNotes, caveats,
    serverVerdict: server.verdict,
    serverBlockers: [...new Set(server.blockers.map((b) => b.fn))].sort(),
    recommendation: recommend(clientVerdict, server.verdict),
  };
}

export function analyzeReport(report: PbixReport): GapAnalysis {
  const measures = report.measures.map(analyzeMeasure);

  const ranking = new Map<string, number>();
  for (const m of measures) {
    for (const fn of m.clientBlockers) ranking.set(fn, (ranking.get(fn) ?? 0) + 1);
  }

  const count = (p: (m: MeasureGap) => boolean): number => measures.filter(p).length;

  return {
    report,
    measures,
    summary: {
      total: measures.length,
      clientSupported: count((m) => m.clientVerdict === "supported"),
      clientUnsupported: count((m) => m.clientVerdict === "unsupported"),
      parseErrors: count((m) => m.clientVerdict === "parseError"),
      keepInReport: count((m) => m.recommendation === "keep-in-report"),
      pushToModel: count((m) => m.recommendation === "push-to-model"),
      redesign: count((m) => m.recommendation === "redesign"),
      withCaveats: count((m) => m.caveats.length > 0),
    },
    clientBlockerRanking: [...ranking.entries()]
      .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
      .map(([fn, n]) => ({ fn, measures: n, remediation: clientRemediation(fn) })),
  };
}
