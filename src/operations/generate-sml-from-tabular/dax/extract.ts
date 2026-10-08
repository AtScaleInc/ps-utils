/**
 * Lifts inline aggregations out of a measure expression into base metrics.
 *
 * AtScale's server-side DAX whitelist has no SUM/MIN/MAX/AVERAGE/COUNT/
 * DISTINCTCOUNT -- those are base metrics with a `calculation_method`. So an
 * expression like
 *
 *     SUM('F'[charge]) - SUM('F'[refund])
 *
 * cannot convert as written even though nothing else about it is exotic. It is
 * the single most common shape among otherwise-convertible measures.
 *
 * Extraction rewrites it to
 *
 *     [Gross Charge] - [Sum of refund]
 *
 * reusing an existing base metric when the model already has one over the same
 * dataset/column/method, and minting a hidden one only when it does not. The
 * rewritten tree is then re-classified normally.
 *
 * Deliberately conservative: an aggregation whose argument is anything other
 * than a plain column is left alone, because lifting `SUMX(FILTER(...), ...)`
 * would change evaluation context rather than just relocate it.
 */

import { baseAggregationMethod } from "./capabilities.js";
import type { Node } from "./parser.js";

export type ExtractedAggregation = {
  /** DAX function that was lifted, e.g. "SUM". */
  fn: string;
  /** SML calculation_method it maps to. */
  method: string;
  /** Table the column belongs to (the measure's own table when unqualified). */
  table: string;
  column: string;
  /** Name of the base metric the call was replaced with. */
  metric: string;
  /** True when a new metric had to be minted rather than an existing one reused. */
  created: boolean;
};

/**
 * Resolves an aggregation to a base metric name, creating one if needed.
 * Supplied by the converter, which owns naming and emission.
 */
export type MetricProvider = (
  input: { fn: string; method: string; table: string; column: string },
) => { metric: string; created: boolean } | undefined;

export type ExtractionResult = {
  tree: Node;
  extracted: ExtractedAggregation[];
};

/** Is this call a base aggregation over a single plain column? */
function liftable(
  node: Node, ownTable: string,
): { fn: string; method: string; table: string; column: string } | undefined {
  if (node.type !== "call" || node.args.length !== 1) return undefined;
  const method = baseAggregationMethod(node.name);
  if (!method) return undefined;

  const arg = node.args[0];
  if (arg.type === "columnRef") {
    return { fn: node.name, method, table: arg.table, column: arg.column };
  }
  // A bare [name] inside an aggregation is a column of the measure's own table.
  if (arg.type === "measureRef") {
    return { fn: node.name, method, table: ownTable, column: arg.name };
  }
  return undefined;
}

export function extractAggregations(
  tree: Node, ownTable: string, provide: MetricProvider,
): ExtractionResult {
  const extracted: ExtractedAggregation[] = [];

  const rewrite = (node: Node): Node => {
    const candidate = liftable(node, ownTable);
    if (candidate) {
      const provided = provide(candidate);
      if (provided) {
        extracted.push({ ...candidate, ...provided });
        return { type: "measureRef", name: provided.metric };
      }
      return node;
    }

    switch (node.type) {
      case "call":
        return { ...node, args: node.args.map(rewrite) };
      case "binary":
        return { ...node, left: rewrite(node.left), right: rewrite(node.right) };
      case "unary":
        return { ...node, operand: rewrite(node.operand) };
      case "varExpr":
        return {
          ...node,
          bindings: node.bindings.map(([n, e]) => [n, rewrite(e)] as [string, Node]),
          body: rewrite(node.body),
        };
      default:
        return node;
    }
  };

  return { tree: rewrite(tree), extracted };
}

/** Readable default name for a minted metric, e.g. "Sum of charge_amt". */
export function defaultMetricName(method: string, column: string): string {
  const label = method
    .split(/[\s_]+/)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(" ");
  return `${label} of ${column}`;
}
