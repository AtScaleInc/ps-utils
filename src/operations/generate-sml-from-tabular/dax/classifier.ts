/**
 * Routes each Tabular measure to the AtScale conversion path that will actually
 * publish.
 *
 * Verdicts, checked in this order:
 *
 *   baseMetric     a plain aggregation over one column -> SML `metric` with a
 *                  calculation_method. Checked FIRST because SUM, MIN, MAX,
 *                  AVERAGE, COUNT and DISTINCTCOUNT are absent from AtScale's
 *                  server-side DAX whitelist -- emitting them as a calculation
 *                  parses locally and fails at publish.
 *   daxNative      every function is on the whitelist -> expression verbatim.
 *   mdxTranslated  off the whitelist, but the whole tree has a faithful MDX
 *                  equivalent -> emit MDX.
 *   unsupported    neither -> defer, with the blocking functions, their nesting
 *                  depth, and a remediation hint.
 *   parseError /
 *   translatorError  so one bad measure annotates a row instead of aborting a
 *                    546-measure batch.
 */

import { baseAggregationMethod, supportsDax } from "./capabilities.js";
import { extractAggregations, type ExtractedAggregation, type MetricProvider } from "./extract.js";
import { printDax } from "./printer.js";
import { DaxSyntaxError } from "./lexer.js";
import { MdxTranslator, Untranslatable, remediationHint } from "./mdx.js";
import { callsWithDepth, parseDax, walk, type Node } from "./parser.js";
import type { NameResolver } from "./resolver.js";

export type Verdict =
  | "baseMetric" | "daxNative" | "mdxTranslated"
  | "unsupported" | "parseError" | "translatorError";

export const CONVERTIBLE_VERDICTS: readonly Verdict[] = ["baseMetric", "daxNative", "mdxTranslated"];

/** A function that kept a measure off the server-side DAX path. */
export type Blocker = {
  fn: string;
  /** 0 = outermost call; >0 means it is buried inside other calls. */
  depth: number;
  hint: string;
};

export type MeasureAssessment = {
  table: string;
  name: string;
  expression: string;
  verdict: Verdict;
  /** baseMetric only. */
  calculationMethod?: string;
  sourceTable?: string;
  sourceColumn?: string;
  /** mdxTranslated only. */
  mdx?: string;
  /**
   * Base metrics lifted out of the expression before classification, and the
   * expression as rewritten against them. Empty when nothing was extracted.
   */
  extracted: ExtractedAggregation[];
  rewrittenExpression?: string;
  confidence: "high" | "medium" | "low";
  notes: string[];
  blockers: Blocker[];
  functionsUsed: string[];
  referencedMeasures: string[];
  error?: string;
};

export type ColumnLookup = {
  /** Is `name` a column of `table`? */
  isColumn(table: string, name: string): boolean;
  /** Is `name` a measure of `table`? */
  isMeasure(table: string, name: string): boolean;
  /** Does the model know this table at all? */
  knowsTable(table: string): boolean;
};

export const isConvertible = (a: MeasureAssessment): boolean =>
  CONVERTIBLE_VERDICTS.includes(a.verdict);

export const blockingFunctions = (a: MeasureAssessment): string[] =>
  [...new Set(a.blockers.map((b) => b.fn))].sort();

/** Strip leading unary +/- to find the aggregation underneath. */
function unwrapUnary(node: Node): Node {
  let current = node;
  while (current.type === "unary" && (current.op === "-" || current.op === "+")) {
    current = current.operand;
  }
  return current;
}

/**
 * The expression is exactly one aggregation over one column.
 *
 * A bare `[name]` argument counts: DAX aggregations take a *column*, so an
 * unqualified bracket inside SUM/MIN/MAX/... is a column of the measure's own
 * table, never a measure reference.
 */
function singleAggregation(root: Node): Extract<Node, { type: "call" }> | undefined {
  const node = unwrapUnary(root);
  if (node.type !== "call" || node.args.length !== 1) return undefined;
  const arg = node.args[0];
  if (arg.type === "columnRef" || arg.type === "tableRef" || arg.type === "measureRef") {
    return node;
  }
  return undefined;
}

export class MeasureClassifier {
  private readonly translator: MdxTranslator;

  constructor(
    resolver: NameResolver,
    private readonly columns?: ColumnLookup,
    /**
     * When supplied, an expression blocked only by inline aggregations is
     * retried with those aggregations lifted into base metrics.
     */
    private readonly metricProvider?: MetricProvider,
  ) {
    this.translator = new MdxTranslator(resolver);
  }

  classify(table: string, name: string, expression: string): MeasureAssessment {
    const assessment: MeasureAssessment = {
      table, name, expression,
      verdict: "parseError",
      confidence: "high",
      notes: [],
      blockers: [],
      functionsUsed: [],
      referencedMeasures: [],
      extracted: [],
    };

    let tree: Node;
    try {
      tree = parseDax(expression);
    } catch (err) {
      assessment.error = err instanceof DaxSyntaxError
        ? `${err.message} (position ${err.position})`
        : String(err);
      return assessment;
    }

    const calls = callsWithDepth(tree);
    assessment.functionsUsed = [...new Set(calls.map(([c]) => c.name))].sort();
    assessment.referencedMeasures = [...new Set(
      walk(tree).flatMap((n) => (n.type === "measureRef" ? [n.name] : [])),
    )].sort();

    // 1. base aggregation -> SML metric
    const agg = singleAggregation(tree);
    if (agg) {
      const method = baseAggregationMethod(agg.name);
      if (method) {
        const arg = agg.args[0];
        if (arg.type === "columnRef") {
          return { ...assessment, verdict: "baseMetric", calculationMethod: method,
            sourceTable: arg.table, sourceColumn: arg.column };
        }
        if (arg.type === "measureRef") {
          const resolved = this.bindUnqualifiedColumn(assessment, table, arg.name);
          if (!resolved) return assessment;
          return { ...assessment, verdict: "baseMetric", calculationMethod: method,
            sourceTable: table, sourceColumn: arg.name, referencedMeasures: [] };
        }
        if (arg.type === "tableRef") {
          // COUNTROWS('Table') -- a row count, so there is no source column.
          return { ...assessment, verdict: "baseMetric", calculationMethod: method,
            sourceTable: arg.name };
        }
      }
    }

    // 2. server-side DAX passthrough
    const blockers: Blocker[] = calls
      .filter(([call]) => !supportsDax(call.name))
      .map(([call, depth]) => ({ fn: call.name, depth, hint: this.hintFor(call.name) }));

    if (blockers.length === 0) {
      return { ...assessment, verdict: "daxNative" };
    }
    assessment.blockers = blockers;

    // 3. lift inline aggregations, then retry
    if (this.metricProvider && blockers.some((b) => baseAggregationMethod(b.fn))) {
      const lifted = this.retryWithExtraction(assessment, tree, table);
      if (lifted) return lifted;
    }

    // 4. MDX translation
    try {
      const result = this.translator.translate(tree);
      return { ...assessment, verdict: "mdxTranslated", mdx: result.mdx,
        confidence: result.confidence, notes: result.notes };
    } catch (err) {
      if (err instanceof Untranslatable) {
        const notes = err.hint ? [err.hint] : [];
        for (const blocker of blockers) {
          const line = `${blocker.fn}: ${blocker.hint}`;
          if (blocker.hint && !notes.includes(line)) notes.push(line);
        }
        return { ...assessment, verdict: "unsupported", error: err.reason, notes };
      }
      // Defensive: one bad measure must not abort a whole-model run.
      return {
        ...assessment,
        verdict: "translatorError",
        error: err instanceof Error ? `${err.name}: ${err.message}` : String(err),
        notes: ["internal translator error -- please file this against ps-utils"],
      };
    }
  }

  /**
   * Re-classify with inline aggregations replaced by base-metric references.
   * Returns undefined if extraction changed nothing or did not help, so the
   * caller falls through to MDX translation unchanged.
   */
  private retryWithExtraction(
    assessment: MeasureAssessment, tree: Node, table: string,
  ): MeasureAssessment | undefined {
    const { tree: rewritten, extracted } = extractAggregations(
      tree, table, this.metricProvider!,
    );
    if (extracted.length === 0) return undefined;

    const remaining = callsWithDepth(rewritten)
      .filter(([call]) => !supportsDax(call.name))
      .map(([call, depth]) => ({ fn: call.name, depth, hint: this.hintFor(call.name) }));

    const expression = printDax(rewritten);
    const created = extracted.filter((e) => e.created).map((e) => e.metric);
    const notes = [
      `inline aggregations lifted into base metrics: ${
        extracted.map((e) => `${e.fn}(${e.column}) -> [${e.metric}]`).join(", ")
      }`,
    ];
    if (created.length) {
      notes.push(`new base metrics created: ${[...new Set(created)].join(", ")}`);
    }

    if (remaining.length === 0) {
      return {
        ...assessment, verdict: "daxNative", blockers: [], extracted,
        rewrittenExpression: expression, notes: [...assessment.notes, ...notes],
        confidence: "medium",
      };
    }

    try {
      const result = this.translator.translate(rewritten);
      return {
        ...assessment, verdict: "mdxTranslated", mdx: result.mdx, blockers: remaining,
        extracted, rewrittenExpression: expression,
        notes: [...assessment.notes, ...notes, ...result.notes],
        confidence: result.confidence === "high" ? "medium" : result.confidence,
      };
    } catch {
      // Extraction did not unblock it; fall back to the unrewritten path.
      return undefined;
    }
  }

  /** Confirm an unqualified `[name]` really is a column of `table`. */
  private bindUnqualifiedColumn(
    assessment: MeasureAssessment, table: string, name: string,
  ): boolean {
    const lookup = this.columns;
    if (!lookup || !lookup.knowsTable(table)) {
      assessment.notes.push(
        `unqualified column [${name}] bound to table '${table}' without a schema to confirm it`,
      );
      return true;
    }
    if (lookup.isColumn(table, name)) {
      if (lookup.isMeasure(table, name)) {
        assessment.notes.push(
          `'${name}' is both a column and a measure on '${table}'; bound as a column ` +
            "(DAX aggregations take columns)",
        );
      }
      return true;
    }
    assessment.verdict = "unsupported";
    assessment.error = `aggregation argument [${name}] is not a column of '${table}'`;
    assessment.notes.push("qualify the reference ('Table'[Column]) or check the source model");
    return false;
  }

  private hintFor(fn: string): string {
    const method = baseAggregationMethod(fn);
    if (method) return `base aggregation: emit calculation_method: ${method}`;
    return remediationHint(fn);
  }
}
