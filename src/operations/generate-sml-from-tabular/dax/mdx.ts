/**
 * DAX -> MDX translation for measures AtScale will not take as server-side DAX.
 *
 * Every emitted construct traces to the AtScale MDX reference. Where a DAX
 * construct has no faithful MDX equivalent this throws `Untranslatable` with a
 * reason and, where one exists, a remediation hint -- that is what lands in the
 * report. It never invents an MDX function to make a measure "work", and it
 * never emits a dimension path the resolver could not confirm.
 */

import { baseAggregationMethod } from "./capabilities.js";
import {
  callsWithDepth, qualifiedName, type CallNode, type Node,
} from "./parser.js";
import type { NameResolver } from "./resolver.js";
import { levelMember, levelMdx, currentMember, type LevelPath } from "./resolver.js";

export class Untranslatable extends Error {
  constructor(readonly reason: string, readonly hint: string = "") {
    super(reason);
    this.name = "Untranslatable";
  }
}

export type Confidence = "high" | "medium" | "low";

export type TranslationResult = {
  mdx: string;
  confidence: Confidence;
  notes: string[];
};

/** Functions whose name and argument order survive the trip unchanged. */
const IDENTITY: Readonly<Record<string, string>> = {
  ABS: "Abs", ROUND: "Round", CEILING: "Ceiling", FLOOR: "Floor",
  LOG: "Log", LOG10: "Log10", EXP: "Exp", SIGN: "Sign",
  LEFT: "Left", RIGHT: "Right", MID: "Mid", LEN: "Len", TRIM: "Trim",
  UPPER: "UCase", LOWER: "LCase",
  DAY: "Day", MONTH: "Month", YEAR: "Year",
  HOUR: "Hour", MINUTE: "Minute", SECOND: "Second", NOW: "Now",
  DIVIDE: "DIVIDE", POWER: "POW",
};

const BINARY_OPS: Readonly<Record<string, string>> = {
  "+": "+", "-": "-", "*": "*", "/": "/",
  "=": "=", "==": "=", "<>": "<>", "<": "<", "<=": "<=", ">": ">", ">=": ">=",
  "&&": "AND", "||": "OR",
};

/**
 * Remediation advice for DAX constructs with no MDX equivalent, so the report
 * says where the logic belongs rather than just "unsupported".
 */
export const REMEDIATION_HINTS: Readonly<Record<string, string>> = {
  BLANK: "maps to MDX NULL; converted automatically whenever the rest of the expression also translates",
  VALUES: "returns a table of distinct values; use the level's .Members set in MDX, or pre-aggregate in the dataset SQL",
  DATEADD: "only a whole-year shift maps cleanly (ParallelPeriod); other grains need Lag() on the matching level",
  ALLEXCEPT: "MDX ALLMEMBEREXCEPT clears every hierarchy except those listed -- the inverse of DAX ALLEXCEPT; confirm the intended semantics before substituting",
  FIRSTDATE: "point-in-time semantics: model as a base metric with a semi_additive: { position: first } block, not a calculation",
  LASTDATE: "point-in-time semantics: model as a base metric with a semi_additive: { position: last } block, not a calculation",
  FIRSTNONBLANK: "first/last-non-empty is a semi_additive base metric in SML, not a calculation",
  LASTNONBLANK: "first/last-non-empty is a semi_additive base metric in SML, not a calculation",
  ENDOFMONTH: "period-boundary date; model as a dimension attribute rather than a calculation",
  ENDOFYEAR: "period-boundary date; model as a dimension attribute rather than a calculation",
  STARTOFMONTH: "period-boundary date; model as a dimension attribute rather than a calculation",
  DATESBETWEEN: "express a bounded window as an MDX member range (member.Lag(N) : member) inside Aggregate()",
  DATESINPERIOD: "express a bounded window as an MDX member range (member.Lag(N) : member) inside Aggregate()",
  RANKX: "MDX Rank() ranks a tuple within a set; supply the set explicitly, e.g. Rank(member, level.Members, [Measures].[X])",
  GROUPBY: "row-context grouping has no cube-side equivalent; push the grouping into the dataset SQL",
  CURRENTGROUP: "only valid inside GROUPBY; push the grouping into the dataset SQL",
  LOOKUPVALUE: "resolve the lookup in the dataset SQL or as a calculated column",
  PATHITEM: "parent-child path navigation belongs in the dimension definition",
  RELATED: "the join is already expressed by the SML relationship; reference the related level directly",
  HASONEVALUE: "no MDX equivalent; guard with a level-count test or drop the guard",
  IFERROR: "no MDX equivalent; handle the specific failure, e.g. DIVIDE's alternate-result argument",
  MEDIAN: "model as a base metric with calculation_method: percentile and an explicit named_quantiles setting",
  VALUE: "cast in the dataset SQL, or use CDBL/CINT on a cube-side value",
  USERELATIONSHIP: "inactive relationships have no cube-side equivalent; model the alternate join as a role-played dimension",
  SUMMARIZE: "supported by AtScale on its own; blocked here only because something nested inside it is not",
  "STDEV.P": "model as a base metric with calculation_method: stddev_pop",
  "STDEV.S": "model as a base metric with calculation_method: stddev_samp",
  "STDEVX.P": "model as a base metric with calculation_method: stddev_pop",
  "STDEVX.S": "model as a base metric with calculation_method: stddev_samp",
};

export const remediationHint = (name: string): string =>
  REMEDIATION_HINTS[name.toUpperCase()] ?? "";

/**
 * Functions the translator handles on its own.
 *
 * These appear as "blockers" because they are off AtScale's server-side DAX
 * whitelist, but none of them blocks a measure by itself -- BLANK() is the
 * common case, present in 64 deferred BILLING measures and the actual cause of
 * none. Ranking a work list by raw blocker frequency therefore puts the least
 * actionable function at the top, so callers use this to separate incidental
 * blockers from the ones a modeller has to do something about.
 */
const TRANSLATABLE_ALONE: ReadonlySet<string> = new Set([
  "BLANK", "ISBLANK", "IF", "AND", "OR", "NOT", "SWITCH", "COALESCE", "INT",
  "CALCULATE", "TOTALYTD", "TOTALQTD", "TOTALMTD",
  ...Object.keys(IDENTITY),
]);

export const isIncidentalBlocker = (name: string): boolean =>
  TRANSLATABLE_ALONE.has(name.toUpperCase());

const CONFIDENCE_ORDER: Record<Confidence, number> = { high: 0, medium: 1, low: 2 };

export class MdxTranslator {
  private notes: string[] = [];
  private confidence: Confidence = "high";
  private vars = new Map<string, Node>();

  constructor(private readonly resolver: NameResolver) {}

  translate(node: Node): TranslationResult {
    this.notes = [];
    this.confidence = "high";
    this.vars = new Map();
    const mdx = this.emit(node);
    return { mdx, confidence: this.confidence, notes: [...this.notes] };
  }

  private note(message: string, confidence: Confidence = "medium"): void {
    if (!this.notes.includes(message)) this.notes.push(message);
    if (CONFIDENCE_ORDER[confidence] > CONFIDENCE_ORDER[this.confidence]) {
      this.confidence = confidence;
    }
  }

  private emit(node: Node): string {
    switch (node.type) {
      case "number": return node.value;
      case "string": return `"${node.value.replace(/"/g, '""')}"`;
      case "measureRef": {
        const resolved = this.resolver.resolveMeasure(node.name);
        if (!resolved) {
          throw new Untranslatable(
            `measure [${node.name}] is not present in the SML model`,
            "convert the referenced measure first, then re-run",
          );
        }
        return `[Measures].[${resolved}]`;
      }
      case "columnRef":
        throw new Untranslatable(
          `column reference ${qualifiedName(node)} used as a value`,
          "MDX calculations operate on metrics and levels, not columns; expose " +
            "the column as a level or a dataset calculated column",
        );
      case "tableRef":
        throw new Untranslatable(
          `table reference '${node.name}' used as a value`,
          "MDX has no table values; rewrite against metrics and levels",
        );
      case "identifier":
        throw new Untranslatable(`bare identifier ${node.name} in value position`);
      case "varRef": {
        const bound = this.vars.get(node.name.toUpperCase());
        if (!bound) throw new Untranslatable(`unbound VAR ${node.name}`);
        return this.emit(bound);
      }
      case "varExpr": {
        // AtScale MDX calculations have no VAR/RETURN, so inline the bindings.
        for (const [name, expr] of node.bindings) this.vars.set(name.toUpperCase(), expr);
        this.note(
          "VAR bindings were inlined (MDX has no VAR/RETURN); check for repeated sub-expression cost",
        );
        return this.emit(node.body);
      }
      case "unary": {
        const operand = this.emit(node.operand);
        return node.op === "NOT" ? `NOT (${operand})` : `(${node.op}${operand})`;
      }
      case "binary": return this.emitBinary(node);
      case "call": return this.emitCall(node);
      case "tableConstructor":
        throw new Untranslatable(
          "inline table constructor { ... } used as a value",
          "MDX has no table literal; express set membership with an Except() or " +
            "a level filter, or model the list as a dimension attribute",
        );
    }
  }

  private emitBinary(node: Extract<Node, { type: "binary" }>): string {
    if (node.op === "^") return `POW(${this.emit(node.left)}, ${this.emit(node.right)})`;
    if (node.op === "&") {
      this.note("DAX text concatenation '&' emitted as MDX '+'; verify operand types");
      return `(${this.emit(node.left)} + ${this.emit(node.right)})`;
    }
    if (node.op === "IN") {
      throw new Untranslatable(
        "IN set membership has no direct MDX equivalent",
        "pin the members with a tuple, or use Except() over the level's members",
      );
    }
    const mapped = BINARY_OPS[node.op];
    if (!mapped) throw new Untranslatable(`operator '${node.op}' has no MDX equivalent`);
    return `(${this.emit(node.left)} ${mapped} ${this.emit(node.right)})`;
  }

  private emitCall(node: CallNode): string {
    switch (node.name) {
      case "BLANK": return "NULL";
      case "ISBLANK": return this.fnIsBlank(node);
      case "IF": return this.fnIf(node);
      case "AND": return this.fnBoolean(node, "AND");
      case "OR": return this.fnBoolean(node, "OR");
      case "NOT": return this.fnNot(node);
      case "SWITCH": return this.fnSwitch(node);
      case "COALESCE": return this.fnCoalesce(node);
      case "INT": return this.fnInt(node);
      case "CALCULATE": return this.fnCalculate(node);
      case "TOTALYTD": return this.periodTotal(node, "Year");
      case "TOTALQTD": return this.periodTotal(node, "Quarter");
      case "TOTALMTD": return this.periodTotal(node, "Month");
      default: break;
    }

    const identity = IDENTITY[node.name];
    if (identity) {
      return `${identity}(${node.args.map((a) => this.emit(a)).join(", ")})`;
    }

    const method = baseAggregationMethod(node.name);
    if (method) {
      throw new Untranslatable(
        `${node.name} is a base aggregation, not a calculation`,
        `emit an SML metric with calculation_method: ${method}`,
      );
    }

    throw new Untranslatable(
      `${node.name} has no AtScale MDX equivalent`,
      remediationHint(node.name),
    );
  }

  private fnIsBlank(node: CallNode): string {
    if (node.args.length !== 1) throw new Untranslatable("ISBLANK expects one argument");
    return `ISEMPTY(${this.emit(node.args[0])})`;
  }

  private fnIf(node: CallNode): string {
    if (node.args.length < 2 || node.args.length > 3) {
      throw new Untranslatable("IF expects two or three arguments");
    }
    const otherwise = node.args.length === 3 ? this.emit(node.args[2]) : "NULL";
    return `IIF(${this.emit(node.args[0])}, ${this.emit(node.args[1])}, ${otherwise})`;
  }

  private fnBoolean(node: CallNode, op: "AND" | "OR"): string {
    if (node.args.length !== 2) throw new Untranslatable(`${op} expects two arguments`);
    return `(${this.emit(node.args[0])} ${op} ${this.emit(node.args[1])})`;
  }

  private fnNot(node: CallNode): string {
    if (node.args.length !== 1) throw new Untranslatable("NOT expects one argument");
    return `NOT (${this.emit(node.args[0])})`;
  }

  private fnInt(node: CallNode): string {
    if (node.args.length !== 1) throw new Untranslatable("INT expects one argument");
    this.note(
      "DAX INT truncates toward zero; emitted as MDX Floor(), which differs for negative values",
    );
    return `Floor(${this.emit(node.args[0])})`;
  }

  private fnSwitch(node: CallNode): string {
    if (node.args.length < 3) throw new Untranslatable("SWITCH expects at least three arguments");
    const subject = this.emit(node.args[0]);
    let pairs = node.args.slice(1);
    let fallback: string | null = null;
    if (pairs.length % 2 === 1) {
      fallback = this.emit(pairs[pairs.length - 1]);
      pairs = pairs.slice(0, -1);
    }
    const whens: string[] = [];
    for (let i = 0; i < pairs.length; i += 2) {
      whens.push(`WHEN ${this.emit(pairs[i])} THEN ${this.emit(pairs[i + 1])}`);
    }
    const tail = fallback === null ? "" : ` ELSE ${fallback}`;
    return `CASE ${subject} ${whens.join(" ")}${tail} END`;
  }

  private fnCoalesce(node: CallNode): string {
    if (node.args.length === 0) throw new Untranslatable("COALESCE expects at least one argument");
    let expr = this.emit(node.args[node.args.length - 1]);
    for (let i = node.args.length - 2; i >= 0; i -= 1) {
      const emitted = this.emit(node.args[i]);
      expr = `IIF(ISEMPTY(${emitted}), ${expr}, ${emitted})`;
    }
    if (node.args.length > 1) {
      this.note(
        "COALESCE expanded to nested IIF(ISEMPTY(...)); the guarded expression is evaluated twice",
      );
    }
    return expr;
  }

  // ---- CALCULATE and time intelligence ---------------------------------

  private fnCalculate(node: CallNode): string {
    if (node.args.length === 0) throw new Untranslatable("CALCULATE expects at least one argument");
    if (node.args.length === 1) return this.emit(node.args[0]);

    const [body, ...filters] = node.args;

    if (filters.length === 1 && filters[0].type === "call") {
      const filterFn = filters[0];
      if (filterFn.name === "DATEADD") return this.parallelPeriod(body, filterFn);
      if (filterFn.name === "DATESYTD") return this.periodsToDate(body, filterFn, "Year");
      if (filterFn.name === "DATESQTD") return this.periodsToDate(body, filterFn, "Quarter");
      if (filterFn.name === "DATESMTD") return this.periodsToDate(body, filterFn, "Month");
      if (filterFn.name === "ALL") return this.allMember(body, filterFn);
    }

    const members = filters.map((f) => this.filterToMember(f));
    const bodyMdx = this.requireMetricBody(body, "CALCULATE with member filters");
    return `(${[...members, bodyMdx].join(", ")})`;
  }

  /** MDX tuples pin a metric at a coordinate, so the body must be a metric. */
  private requireMetricBody(body: Node, what: string): string {
    const mdx = this.emit(body);
    if (!mdx.startsWith("[Measures].")) {
      throw new Untranslatable(
        `${what} requires a plain metric body`,
        "extract the inner expression into its own calculation first",
      );
    }
    return mdx;
  }

  private filterToMember(node: Node): string {
    if (node.type !== "binary" || !["=", "==", "<>"].includes(node.op)) {
      throw new Untranslatable(
        "CALCULATE filter is not a simple column = value comparison",
        "MDX tuple coordinates pin a single member; move complex predicates into " +
          "the dataset or a dimension level",
      );
    }
    if (node.op === "<>") {
      throw new Untranslatable(
        "CALCULATE filter uses <> (set exclusion)",
        "MDX tuples cannot express exclusion; use Except() over the level members " +
          "inside Aggregate(), or model an exclusion flag",
      );
    }
    if (node.left.type !== "columnRef" || node.right.type !== "string") {
      throw new Untranslatable("CALCULATE filter must compare a column to a string literal");
    }
    const path = this.resolver.resolveLevel(node.left.table, node.left.column);
    if (!path) {
      throw new Untranslatable(
        `${qualifiedName(node.left)} is not exposed as a level in the SML model`,
        "expose the column as a dimension level, or filter in the dataset",
      );
    }
    return levelMember(path, node.right.value);
  }

  /**
   * `CALCULATE(<m>, ALL(...))` -> pin the hierarchy at its All member.
   *
   * DAX `ALL('T')` clears the filter on T while leaving every other hierarchy in
   * context. The MDX equivalent is a tuple coordinate on T's All member -- NOT
   * `ALLMEMBER`, which clears every hierarchy and is strictly broader.
   */
  private allMember(body: Node, filterFn: CallNode): string {
    const bodyMdx = this.requireMetricBody(body, "CALCULATE(..., ALL(...))");

    if (filterFn.args.length === 0) {
      // Bare ALL() clears everything -- that is exactly ALLMEMBER.
      return `ALLMEMBER(${bodyMdx})`;
    }

    const target = filterFn.args[0];
    let path: LevelPath | undefined;

    if (target.type === "tableRef") {
      path = this.resolver.resolveDimensionDefault(target.name);
      if (!path) {
        throw new Untranslatable(
          `'${target.name}' is not mapped to a dimension`,
          "expose the table as a dimension in the converter",
        );
      }
      this.note(
        `ALL('${target.name}') mapped to the All member of [${path.dimension}].` +
          `[${path.hierarchy}]; if the table backs more than one hierarchy, pin each`,
      );
    } else if (target.type === "columnRef") {
      path = this.resolver.resolveLevel(target.table, target.column);
      if (!path) {
        throw new Untranslatable(
          `${qualifiedName(target)} is not exposed as a level`,
          "expose the column as a dimension level in the converter",
        );
      }
    } else {
      throw new Untranslatable("ALL() argument must be a table or column");
    }

    // AtScale treats the All member name as case-sensitive.
    return `([${path.dimension}].[${path.hierarchy}].[All], ${bodyMdx})`;
  }

  private dateTableOf(node: Node): string {
    if (node.type === "columnRef") return node.table;
    if (node.type === "tableRef") return node.name;
    throw new Untranslatable("time-intelligence filter has no date-column argument");
  }

  private parallelPeriod(body: Node, filterFn: CallNode): string {
    if (filterFn.args.length !== 3) throw new Untranslatable("DATEADD expects three arguments");
    const table = this.dateTableOf(filterFn.args[0]);
    const grainNode = filterFn.args[2];

    if (grainNode.type !== "identifier" && grainNode.type !== "tableRef") {
      throw new Untranslatable("DATEADD grain must be a date-part keyword");
    }
    const grain = grainNode.name.toUpperCase();
    if (grain !== "YEAR") {
      throw new Untranslatable(
        `DATEADD over ${grain} has no direct MDX equivalent`,
        "ParallelPeriod shifts whole ancestor periods, so only YEAR maps cleanly; " +
          "for month/quarter shifts use Lag() on the matching level",
      );
    }

    const offset = this.backwardOffset(filterFn.args[1]);
    const level = this.resolver.resolveYearLevel(table);
    if (!level) {
      throw new Untranslatable(
        `'${table}' is not mapped to a time dimension`,
        "mark the table as the model's date dimension in the converter",
      );
    }
    const bodyMdx = this.emit(body);
    this.note(
      `ParallelPeriod requires a parallel_periods block on every non-Year level of ` +
        `${level.dimension} (see the SML dimension spec)`,
    );
    return `(ParallelPeriod(${levelMdx(level)}, ${offset}, ${currentMember(level)}), ${bodyMdx})`;
  }

  /** DAX DATEADD(-1, YEAR) shifts back; MDX ParallelPeriod takes +1. */
  private backwardOffset(node: Node): string {
    if (node.type === "unary" && node.op === "-" && node.operand.type === "number") {
      return node.operand.value;
    }
    if (node.type === "number") {
      throw new Untranslatable(
        "DATEADD with a forward offset shifts into future periods",
        "ParallelPeriod only looks back; model a forward shift with Lead()",
      );
    }
    throw new Untranslatable("DATEADD offset must be a numeric literal");
  }

  private periodsToDate(body: Node, filterFn: CallNode, grain: string): string {
    if (filterFn.args.length === 0) {
      throw new Untranslatable(`${filterFn.name} expects a date column`);
    }
    return this.aggregateToDate(this.dateTableOf(filterFn.args[0]), grain, body);
  }

  private periodTotal(node: CallNode, grain: string): string {
    if (node.args.length < 2) {
      throw new Untranslatable(`${node.name} expects an expression and a dates column`);
    }
    return this.aggregateToDate(this.dateTableOf(node.args[1]), grain, node.args[0]);
  }

  private aggregateToDate(table: string, grain: string, body: Node): string {
    const pair = this.resolver.resolveDateHierarchy(table);
    if (!pair) {
      throw new Untranslatable(
        `'${table}' is not mapped to a time dimension`,
        "mark the table as the model's date dimension in the converter",
      );
    }
    const level: LevelPath = { dimension: pair.dimension, hierarchy: pair.hierarchy, level: grain };
    return `Aggregate(PeriodsToDate(${levelMdx(level)}, ${currentMember(level)}), ${this.emit(body)})`;
  }
}

/** Functions in the tree that AtScale's server-side DAX does not accept. */
export function unsupportedCalls(root: Node): Array<{ fn: string; depth: number }> {
  const out: Array<{ fn: string; depth: number }> = [];
  for (const [call, depth] of callsWithDepth(root)) {
    out.push({ fn: call.name, depth });
  }
  return out;
}
