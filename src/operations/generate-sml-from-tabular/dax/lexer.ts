/**
 * Tokenizer for the DAX subset that SSAS Tabular emits in measure expressions.
 *
 * Handles the constructs that actually occur: bracketed references
 * (`[Total Cases]`), single-quoted table names with `''` escapes, string
 * literals with `""` escapes, numbers, dotted function names (`STDEV.P`), and
 * line/block comments.
 */

export class DaxSyntaxError extends Error {
  constructor(message: string, readonly position: number = -1) {
    super(message);
    this.name = "DaxSyntaxError";
  }
}

export type TokenKind =
  | "NUMBER" | "STRING" | "TABLE" | "BRACKET" | "IDENT" | "OP"
  | "(" | ")" | "," | "{" | "}" | "EOF";

export type Token = { kind: TokenKind; value: string; pos: number };

/** Longest first, so "<=" never lexes as "<" then "=". */
const OPERATORS = [
  "<>", "==", "<=", ">=", "&&", "||",
  "=", "<", ">", "+", "-", "*", "/", "^", "&",
];

const IDENT_RE = /^[A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z_][A-Za-z0-9_]*)*/;
const NUMBER_RE = /^(?:\d+\.\d*|\.\d+|\d+)(?:[eE][+-]?\d+)?/;

const isSpace = (c: string): boolean => /\s/.test(c);
const isDigit = (c: string): boolean => c >= "0" && c <= "9";
const isAlpha = (c: string): boolean => /[A-Za-z]/.test(c);

/** Read a quoted run, honouring doubled-quote escapes. */
function readQuoted(src: string, start: number, quote: string, what: string): [string, number] {
  let i = start + 1;
  let out = "";
  while (i < src.length) {
    if (src[i] === quote) {
      if (src[i + 1] === quote) { out += quote; i += 2; continue; }
      return [out, i + 1];
    }
    out += src[i];
    i += 1;
  }
  throw new DaxSyntaxError(`unterminated ${what}`, start);
}

export function tokenize(source: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;
  const n = source.length;

  while (i < n) {
    const ch = source[i];

    if (isSpace(ch)) { i += 1; continue; }

    if (source.startsWith("--", i) || source.startsWith("//", i)) {
      const nl = source.indexOf("\n", i);
      i = nl === -1 ? n : nl + 1;
      continue;
    }

    if (source.startsWith("/*", i)) {
      const end = source.indexOf("*/", i + 2);
      if (end === -1) throw new DaxSyntaxError("unterminated block comment", i);
      i = end + 2;
      continue;
    }

    if (ch === '"') {
      const [value, next] = readQuoted(source, i, '"', "string literal");
      tokens.push({ kind: "STRING", value, pos: i });
      i = next;
      continue;
    }

    if (ch === "'") {
      const [value, next] = readQuoted(source, i, "'", "table name");
      tokens.push({ kind: "TABLE", value, pos: i });
      i = next;
      continue;
    }

    if (ch === "[") {
      const end = source.indexOf("]", i + 1);
      if (end === -1) throw new DaxSyntaxError("unterminated bracketed reference", i);
      tokens.push({ kind: "BRACKET", value: source.slice(i + 1, end), pos: i });
      i = end + 1;
      continue;
    }

    if (isDigit(ch) || (ch === "." && isDigit(source[i + 1] ?? ""))) {
      const m = NUMBER_RE.exec(source.slice(i))!;
      tokens.push({ kind: "NUMBER", value: m[0], pos: i });
      i += m[0].length;
      continue;
    }

    if (isAlpha(ch) || ch === "_") {
      const m = IDENT_RE.exec(source.slice(i))!;
      tokens.push({ kind: "IDENT", value: m[0], pos: i });
      i += m[0].length;
      continue;
    }

    if (ch === "(" || ch === ")" || ch === "," || ch === "{" || ch === "}") {
      tokens.push({ kind: ch, value: ch, pos: i });
      i += 1;
      continue;
    }

    const op = OPERATORS.find((o) => source.startsWith(o, i));
    if (!op) throw new DaxSyntaxError(`unexpected character '${ch}'`, i);
    tokens.push({ kind: "OP", value: op, pos: i });
    i += op.length;
  }

  tokens.push({ kind: "EOF", value: "", pos: n });
  return tokens;
}
