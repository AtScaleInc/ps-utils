/**
 * Renders a DAX AST back to DAX text.
 *
 * Needed because aggregation extraction rewrites the tree: once
 * `SUM('F'[a]) - SUM('F'[b])` becomes `[Sum of a] - [Sum of b]`, the result has
 * to be emitted as an expression string for the `metric_calc`. Printing from
 * the AST rather than doing string surgery on the original keeps the output
 * consistent with what was actually parsed and classified.
 */

import type { Node } from "./parser.js";

/** Quote a table name only when DAX requires it. */
const tableRef = (name: string): string =>
  /^[A-Za-z_][A-Za-z0-9_]*$/.test(name) ? name : `'${name.replace(/'/g, "''")}'`;

export function printDax(node: Node): string {
  switch (node.type) {
    case "number":
      return node.value;
    case "string":
      return `"${node.value.replace(/"/g, '""')}"`;
    case "measureRef":
      return `[${node.name}]`;
    case "columnRef":
      return `${tableRef(node.table)}[${node.column}]`;
    case "tableRef":
      return tableRef(node.name);
    case "identifier":
      return node.name;
    case "varRef":
      return node.name;
    case "call":
      return `${node.rawName || node.name}(${node.args.map(printDax).join(", ")})`;
    case "unary":
      return node.op === "NOT" ? `NOT ${printDax(node.operand)}` : `${node.op}${printDax(node.operand)}`;
    case "binary":
      return `(${printDax(node.left)} ${node.op} ${printDax(node.right)})`;
    case "tableConstructor":
      return `{${node.items.map(printDax).join(", ")}}`;
    case "varExpr": {
      const bindings = node.bindings
        .map(([name, expr]) => `VAR ${name} = ${printDax(expr)}`)
        .join("\n");
      return `${bindings}\nRETURN ${printDax(node.body)}`;
    }
  }
}
