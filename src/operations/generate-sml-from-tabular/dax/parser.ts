/**
 * Recursive-descent parser producing a DAX AST.
 *
 * Precedence, loosest to tightest:
 *   ||  ->  &&  ->  comparison  ->  &  ->  + -  ->  * /  ->  unary  ->  ^
 */

import { DaxSyntaxError, tokenize, type Token } from "./lexer.js";

export type Node =
  | { type: "number"; value: string }
  | { type: "string"; value: string }
  | { type: "measureRef"; name: string }
  | { type: "columnRef"; table: string; column: string }
  | { type: "tableRef"; name: string }
  | { type: "identifier"; name: string }
  | { type: "varRef"; name: string }
  | { type: "call"; name: string; rawName: string; args: Node[] }
  | { type: "binary"; op: string; left: Node; right: Node }
  | { type: "unary"; op: string; operand: Node }
  | { type: "varExpr"; bindings: Array<[string, Node]>; body: Node }
  | { type: "tableConstructor"; items: Node[] };

export type CallNode = Extract<Node, { type: "call" }>;

/** Bare words that are date-part enums rather than tables or functions. */
const DATE_PARTS = new Set(["DAY", "MONTH", "QUARTER", "YEAR", "WEEK", "HOUR", "MINUTE", "SECOND"]);

const COMPARISON = new Set(["=", "==", "<>", "<", "<=", ">", ">="]);

export function qualifiedName(node: Extract<Node, { type: "columnRef" }>): string {
  return `'${node.table}'[${node.column}]`;
}

/** Direct children of a node, for tree walks. */
export function childrenOf(node: Node): Node[] {
  switch (node.type) {
    case "call": return node.args;
    case "binary": return [node.left, node.right];
    case "unary": return [node.operand];
    case "varExpr": return [...node.bindings.map(([, e]) => e), node.body];
    case "tableConstructor": return node.items;
    default: return [];
  }
}

export function walk(node: Node): Node[] {
  const out: Node[] = [node];
  for (const child of childrenOf(node)) out.push(...walk(child));
  return out;
}

/** Every call in the tree with its nesting depth (0 = outermost). */
export function callsWithDepth(node: Node, depth = 0): Array<[CallNode, number]> {
  const out: Array<[CallNode, number]> = [];
  if (node.type === "call") {
    out.push([node, depth]);
    for (const arg of node.args) out.push(...callsWithDepth(arg, depth + 1));
  } else {
    for (const child of childrenOf(node)) out.push(...callsWithDepth(child, depth));
  }
  return out;
}

class Parser {
  private i = 0;
  private scopes: Array<Set<string>> = [];

  constructor(private readonly tokens: Token[]) {}

  private get cur(): Token { return this.tokens[this.i]; }

  private advance(): Token { return this.tokens[this.i++]; }

  private atOp(...values: string[]): boolean {
    return this.cur.kind === "OP" && values.includes(this.cur.value);
  }

  private atKeyword(word: string): boolean {
    return this.cur.kind === "IDENT" && this.cur.value.toUpperCase() === word;
  }

  private expect(kind: Token["kind"], value?: string): Token {
    const tok = this.cur;
    if (tok.kind !== kind || (value !== undefined && tok.value !== value)) {
      throw new DaxSyntaxError(`expected '${value ?? kind}' but found '${tok.value}'`, tok.pos);
    }
    return this.advance();
  }

  private inScope(name: string): boolean {
    return this.scopes.some((s) => s.has(name.toUpperCase()));
  }

  parse(): Node {
    const node = this.expression();
    if (this.cur.kind !== "EOF") {
      throw new DaxSyntaxError(`unexpected trailing input '${this.cur.value}'`, this.cur.pos);
    }
    return node;
  }

  private expression(): Node {
    return this.atKeyword("VAR") ? this.varBlock() : this.or();
  }

  private varBlock(): Node {
    const bindings: Array<[string, Node]> = [];
    const scope = new Set<string>();
    this.scopes.push(scope);
    try {
      while (this.atKeyword("VAR")) {
        this.advance();
        const name = this.expect("IDENT");
        this.expect("OP", "=");
        bindings.push([name.value, this.or()]);
        scope.add(name.value.toUpperCase());
      }
      if (!this.atKeyword("RETURN")) {
        throw new DaxSyntaxError("VAR block without RETURN", this.cur.pos);
      }
      this.advance();
      return { type: "varExpr", bindings, body: this.or() };
    } finally {
      this.scopes.pop();
    }
  }

  private or(): Node {
    let node = this.and();
    while (this.atOp("||") || this.atKeyword("OR")) {
      this.advance();
      node = { type: "binary", op: "||", left: node, right: this.and() };
    }
    return node;
  }

  private and(): Node {
    let node = this.notExpr();
    while (this.atOp("&&") || this.atKeyword("AND")) {
      this.advance();
      node = { type: "binary", op: "&&", left: node, right: this.notExpr() };
    }
    return node;
  }

  /**
   * NOT binds looser than comparison in DAX, so `NOT [c] IN {...}` means
   * `NOT ([c] IN {...})`. Handling it at the unary level would bind it to the
   * column alone and silently invert the wrong thing.
   */
  private notExpr(): Node {
    if (this.atKeyword("NOT")) {
      this.advance();
      return { type: "unary", op: "NOT", operand: this.notExpr() };
    }
    return this.comparison();
  }

  private comparison(): Node {
    let node = this.concat();
    for (;;) {
      if (this.cur.kind === "OP" && COMPARISON.has(this.cur.value)) {
        const op = this.advance().value;
        node = { type: "binary", op, left: node, right: this.concat() };
        continue;
      }
      // `<expr> IN {a, b}` / `<expr> IN <table>` -- IN is a supported operator.
      if (this.atKeyword("IN")) {
        this.advance();
        node = { type: "binary", op: "IN", left: node, right: this.concat() };
        continue;
      }
      return node;
    }
  }

  private concat(): Node {
    let node = this.additive();
    while (this.atOp("&")) {
      this.advance();
      node = { type: "binary", op: "&", left: node, right: this.additive() };
    }
    return node;
  }

  private additive(): Node {
    let node = this.multiplicative();
    while (this.atOp("+", "-")) {
      const op = this.advance().value;
      node = { type: "binary", op, left: node, right: this.multiplicative() };
    }
    return node;
  }

  private multiplicative(): Node {
    let node = this.unary();
    while (this.atOp("*", "/")) {
      const op = this.advance().value;
      node = { type: "binary", op, left: node, right: this.unary() };
    }
    return node;
  }

  private unary(): Node {
    if (this.atOp("-", "+")) {
      const op = this.advance().value;
      return { type: "unary", op, operand: this.unary() };
    }
    if (this.atKeyword("NOT")) {
      this.advance();
      return { type: "unary", op: "NOT", operand: this.unary() };
    }
    return this.power();
  }

  private power(): Node {
    const node = this.primary();
    if (this.atOp("^")) {
      this.advance();
      return { type: "binary", op: "^", left: node, right: this.unary() };
    }
    return node;
  }

  private primary(): Node {
    const tok = this.cur;

    if (tok.kind === "NUMBER") { this.advance(); return { type: "number", value: tok.value }; }
    if (tok.kind === "STRING") { this.advance(); return { type: "string", value: tok.value }; }

    if (tok.kind === "(") {
      this.advance();
      const node = this.expression();
      this.expect(")");
      return node;
    }

    if (tok.kind === "BRACKET") { this.advance(); return { type: "measureRef", name: tok.value }; }

    // Table constructor: { "a", "b" } or {(1, 2), (3, 4)}
    if (tok.kind === "{") {
      this.advance();
      const items: Node[] = [];
      if (this.cur.kind !== "}") {
        items.push(this.expression());
        while (this.cur.kind === ",") { this.advance(); items.push(this.expression()); }
      }
      this.expect("}");
      return { type: "tableConstructor", items };
    }

    if (tok.kind === "TABLE") {
      this.advance();
      if (this.cur.kind === "BRACKET") {
        const col = this.advance();
        return { type: "columnRef", table: tok.value, column: col.value };
      }
      return { type: "tableRef", name: tok.value };
    }

    if (tok.kind === "IDENT") {
      this.advance();
      if (this.cur.kind === "(") return this.call(tok.value);
      if (this.cur.kind === "BRACKET") {
        const col = this.advance();
        return { type: "columnRef", table: tok.value, column: col.value };
      }
      if (this.inScope(tok.value)) return { type: "varRef", name: tok.value };
      if (DATE_PARTS.has(tok.value.toUpperCase())) {
        return { type: "identifier", name: tok.value.toUpperCase() };
      }
      // DAX only requires quoting when a table name contains a space.
      return { type: "tableRef", name: tok.value };
    }

    throw new DaxSyntaxError(`unexpected token '${tok.value}'`, tok.pos);
  }

  private call(name: string): Node {
    this.expect("(");
    const args: Node[] = [];
    if (this.cur.kind !== ")") {
      args.push(this.expression());
      while (this.cur.kind === ",") {
        this.advance();
        args.push(this.expression());
      }
    }
    this.expect(")");
    return { type: "call", name: name.toUpperCase(), rawName: name, args };
  }
}

export function parseDax(source: string): Node {
  if (!source || !source.trim()) throw new DaxSyntaxError("empty expression", 0);
  return new Parser(tokenize(source)).parse();
}
