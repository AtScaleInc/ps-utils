import { describe, expect, it } from "vitest";
import {
  MeasureClassifier, MdxTranslator, Untranslatable, blockingFunctions,
  SUPPORTED_DAX_FUNCTIONS, baseAggregationMethod, buildResolver, defaultMetricName,
  isIncidentalBlocker, parseDax, printDax, supportsDax,
  tokenize,
  type ColumnLookup, type NameResolver,
} from "../generate-sml-from-tabular/dax/index.js";

/**
 * A resolver matching the converter's naming: dimension unique_name is the
 * table name, hierarchy is "<dimension> Hierarchy".
 */
const knownMeasures = new Set(["Rev", "a", "b", "Total", "Total Cases"]);
const resolver: NameResolver = buildResolver({
  measures: knownMeasures,
  dimensionOf: new Map([
    ["Payer", "Payer"],
    ["Date Of Service", "Date Of Service"],
  ]),
  levelsOf: new Map([
    ["Payer", new Set(["Tier", "Name"])],
    ["Date Of Service", new Set(["Serv Dte", "Year"])],
  ]),
  hierarchyOf: new Map([
    ["Payer", "Payer Hierarchy"],
    ["Date Of Service", "Date Of Service Hierarchy"],
  ]),
  timeDimensions: new Set(["Date Of Service"]),
  defaultLevelOf: new Map([["Payer", "Name"], ["Date Of Service", "Serv Dte"]]),
  yearLevelOf: new Map([["Date Of Service", "Year"]]),
});

const columns: ColumnLookup = {
  isColumn: (t, n) => t === "Fact" && ["amt", "qty", "both"].includes(n),
  isMeasure: (t, n) => t === "Fact" && ["Total", "both"].includes(n),
  knowsTable: (t) => t === "Fact",
};

const translator = new MdxTranslator(resolver);
const mdxOf = (dax: string): string => translator.translate(parseDax(dax)).mdx;
const classifier = new MeasureClassifier(resolver, columns);
const verdictOf = (dax: string): string => classifier.classify("Fact", "m", dax).verdict;

describe("dax lexer", () => {
  it("handles doubled-quote escapes in strings", () => {
    expect(tokenize('"he said ""hi"""')[0].value).toBe('he said "hi"');
  });

  it("handles escaped table names", () => {
    expect(tokenize("'O''Brien'[x]")[0].value).toBe("O'Brien");
  });

  it("prefers the longest operator", () => {
    expect(tokenize("a <= b").filter((t) => t.kind === "OP")[0].value).toBe("<=");
    expect(tokenize("a <> b").filter((t) => t.kind === "OP")[0].value).toBe("<>");
  });

  it("strips line and block comments", () => {
    const kinds = (s: string) => tokenize(s).filter((t) => t.kind !== "EOF").map((t) => t.kind);
    expect(kinds("1 -- trailing\n+ 2")).toEqual(["NUMBER", "OP", "NUMBER"]);
    expect(kinds("1 /* mid */ + 2")).toEqual(["NUMBER", "OP", "NUMBER"]);
  });

  it("keeps dotted function names whole", () => {
    expect(tokenize("STDEV.P(x)")[0].value).toBe("STDEV.P");
  });

  it("rejects an unterminated string", () => {
    expect(() => tokenize('"unclosed')).toThrow(/unterminated/);
  });
});

describe("dax parser", () => {
  it("distinguishes measure refs from table-qualified columns", () => {
    const tree = parseDax("[Total Cases] + 'Fact'[amount]");
    expect(tree).toMatchObject({
      type: "binary",
      left: { type: "measureRef", name: "Total Cases" },
      right: { type: "columnRef", table: "Fact", column: "amount" },
    });
  });

  it("accepts unquoted table names", () => {
    expect(parseDax("MAX(_ADAL[cnt])")).toMatchObject({
      args: [{ type: "columnRef", table: "_ADAL" }],
    });
  });

  it("binds multiplication tighter than addition", () => {
    expect(parseDax("1 + 2 * 3")).toMatchObject({ op: "+", right: { op: "*" } });
  });

  it("binds comparison looser than arithmetic", () => {
    expect(parseDax("1 + 2 > 3")).toMatchObject({ op: ">", left: { op: "+" } });
  });

  it("treats the AND keyword as the && operator", () => {
    expect(parseDax("a = 1 AND b = 2")).toMatchObject({ op: "&&" });
  });

  it("parses VAR/RETURN", () => {
    expect(parseDax("VAR x = 1 VAR y = 2 RETURN x + y")).toMatchObject({
      type: "varExpr", bindings: [["x", { value: "1" }], ["y", { value: "2" }]],
    });
  });

  it("rejects VAR without RETURN", () => {
    expect(() => parseDax("VAR x = 1")).toThrow(/RETURN/);
  });

  it("rejects an empty expression", () => {
    expect(() => parseDax("   ")).toThrow(/empty/);
  });

  it("rejects unbalanced parentheses", () => {
    expect(() => parseDax("DIVIDE(1, 2")).toThrow();
  });
});

describe("atscale capability registry", () => {
  it("excludes SUM but includes SUMX", () => {
    // The whole reason baseMetric is checked before the whitelist.
    expect(supportsDax("SUM")).toBe(false);
    expect(supportsDax("SUMX")).toBe(true);
  });
});

describe("dax -> mdx translation", () => {
  it("qualifies measure references", () => {
    expect(mdxOf("[Total Cases]")).toBe("[Measures].[Total Cases]");
  });

  it("maps BLANK() to NULL", () => {
    expect(mdxOf("BLANK()")).toBe("NULL");
  });

  it("keeps DIVIDE with its alternate result", () => {
    expect(mdxOf("DIVIDE([a],[b],0)")).toBe("DIVIDE([Measures].[a], [Measures].[b], 0)");
  });

  it("maps IF to IIF and defaults the else branch to NULL", () => {
    expect(mdxOf("IF([a] > 0, [b])")).toBe("IIF(([Measures].[a] > 0), [Measures].[b], NULL)");
  });

  it("maps ISBLANK to ISEMPTY", () => {
    expect(mdxOf("ISBLANK([a])")).toBe("ISEMPTY([Measures].[a])");
  });

  it("maps SWITCH to CASE", () => {
    expect(mdxOf('SWITCH([a], 1, "one", 2, "two", "other")')).toBe(
      'CASE [Measures].[a] WHEN 1 THEN "one" WHEN 2 THEN "two" ELSE "other" END',
    );
  });

  it("unwraps CALCULATE with no filters", () => {
    expect(mdxOf("CALCULATE([a])")).toBe("[Measures].[a]");
  });

  it("turns an equality filter into a tuple coordinate", () => {
    expect(mdxOf('CALCULATE([Rev], \'Payer\'[Tier] = "Gold")')).toBe(
      "([Payer].[Payer Hierarchy].[Tier].[Gold], [Measures].[Rev])",
    );
  });

  it("refuses set exclusion, which a tuple cannot express", () => {
    expect(() => mdxOf('CALCULATE([Rev], \'Payer\'[Tier] <> "Gold")')).toThrow(Untranslatable);
  });

  it("maps a year DATEADD to ParallelPeriod", () => {
    expect(mdxOf("CALCULATE([Rev], DATEADD('Date Of Service'[Serv Dte], -1, YEAR))")).toBe(
      "(ParallelPeriod([Date Of Service].[Date Of Service Hierarchy].[Year], 1, " +
        "[Date Of Service].[Date Of Service Hierarchy].CurrentMember), [Measures].[Rev])",
    );
  });

  it("refuses a month DATEADD rather than emitting a wrong ParallelPeriod", () => {
    expect(() => mdxOf("CALCULATE([Rev], DATEADD('Date Of Service'[Serv Dte], -1, MONTH))"))
      .toThrow(/no direct MDX equivalent/);
  });

  it("refuses a forward DATEADD offset", () => {
    expect(() => mdxOf("CALCULATE([Rev], DATEADD('Date Of Service'[Serv Dte], 1, YEAR))"))
      .toThrow(/forward offset/);
  });

  it("maps TOTALYTD to Aggregate(PeriodsToDate(...))", () => {
    expect(mdxOf("TOTALYTD([Rev], 'Date Of Service'[Serv Dte])")).toBe(
      "Aggregate(PeriodsToDate([Date Of Service].[Date Of Service Hierarchy].[Year], " +
        "[Date Of Service].[Date Of Service Hierarchy].CurrentMember), [Measures].[Rev])",
    );
  });

  it("pins ALL('T') at the All member, not the broader ALLMEMBER", () => {
    const out = mdxOf("CALCULATE([Rev], ALL('Payer'))");
    expect(out).toBe("([Payer].[Payer Hierarchy].[All], [Measures].[Rev])");
    expect(out).not.toContain("ALLMEMBER");
  });

  it("uses ALLMEMBER only for a bare ALL()", () => {
    expect(mdxOf("CALCULATE([Rev], ALL())")).toBe("ALLMEMBER([Measures].[Rev])");
  });

  it("inlines VAR bindings and lowers confidence", () => {
    const result = translator.translate(parseDax("VAR x = [a] RETURN x + x"));
    expect(result.mdx).toBe("([Measures].[a] + [Measures].[a])");
    expect(result.confidence).toBe("medium");
    expect(result.notes.join(" ")).toMatch(/VAR/);
  });

  it("refuses a bare column reference used as a value", () => {
    expect(() => mdxOf("'Fact'[amount] * 2")).toThrow(Untranslatable);
  });

  it("attaches a remediation hint to unsupported functions", () => {
    try {
      mdxOf("FIRSTDATE('Date Of Service'[Serv Dte])");
      expect.unreachable("should have thrown");
    } catch (err) {
      expect((err as Untranslatable).hint).toMatch(/semi_additive/);
    }
  });

  it("routes a base aggregation to a metric instead of MDX", () => {
    try {
      mdxOf("SUM('Fact'[amt]) + 1");
      expect.unreachable("should have thrown");
    } catch (err) {
      expect((err as Untranslatable).hint).toMatch(/calculation_method: sum/);
    }
  });

  it("flags a measure the resolver does not know rather than guessing", () => {
    expect(() => mdxOf("[Nonexistent]")).toThrow(/not present in the SML model/);
  });

  it("flags a level the resolver does not know rather than guessing", () => {
    expect(() => mdxOf('CALCULATE([Rev], \'Payer\'[Unknown] = "x")'))
      .toThrow(/not exposed as a level/);
  });
});

describe("measure classification", () => {
  it("treats a plain SUM as a base metric", () => {
    expect(classifier.classify("Fact", "Total", "SUM('Fact'[amt])")).toMatchObject({
      verdict: "baseMetric", calculationMethod: "sum", sourceColumn: "amt",
    });
  });

  it("maps DISTINCTCOUNT to count distinct", () => {
    expect(classifier.classify("Fact", "P", "DISTINCTCOUNT('Fact'[qty])").calculationMethod)
      .toBe("count distinct");
  });

  it("passes a fully whitelisted expression through as DAX", () => {
    expect(verdictOf("DIVIDE([a], [b], 0)")).toBe("daxNative");
    expect(verdictOf("ABS(DIVIDE([a],[b],0))")).toBe("daxNative");
    expect(verdictOf("IF(ISBLANK([a]), 0, [a])")).toBe("daxNative");
  });

  it("disqualifies a supported function nested inside an unsupported one", () => {
    const result = classifier.classify("Fact", "m", "FIRSTNONBLANK(DIVIDE([a],[b]), 1)");
    expect(result.verdict).not.toBe("daxNative");
    expect(blockingFunctions(result)).toContain("FIRSTNONBLANK");
  });

  it("records how deeply a blocker is buried", () => {
    const result = classifier.classify("Fact", "m", "ABS(CALCULATE(FIRSTDATE('D'[d])))");
    expect(result.blockers.find((b) => b.fn === "FIRSTDATE")?.depth).toBe(2);
  });

  it("does not treat an inline SUM as native DAX", () => {
    const result = classifier.classify("Fact", "m", "SUM('F'[a]) - SUM('F'[b])");
    expect(result.verdict).not.toBe("daxNative");
    expect(blockingFunctions(result)).toContain("SUM");
  });

  it("translates when BLANK() is the only blocker", () => {
    const result = classifier.classify("Fact", "m", "IF(ISBLANK([a]), BLANK(), [a])");
    expect(result.verdict).toBe("mdxTranslated");
    expect(result.mdx).toBe("IIF(ISEMPTY([Measures].[a]), NULL, [Measures].[a])");
    expect(blockingFunctions(result)).toEqual(["BLANK"]);
  });

  it("defers an untranslatable measure with notes", () => {
    const result = classifier.classify("Fact", "m", "LASTDATE('D'[d])");
    expect(result.verdict).toBe("unsupported");
    expect(result.error).toBeTruthy();
    expect(result.notes.length).toBeGreaterThan(0);
  });

  it("reports bad syntax instead of throwing", () => {
    const result = classifier.classify("Fact", "m", "DIVIDE(1,");
    expect(result.verdict).toBe("parseError");
    expect(result.error).toBeTruthy();
  });

  it("collects referenced measures", () => {
    expect(classifier.classify("Fact", "m", "DIVIDE([a], [b])").referencedMeasures)
      .toEqual(["a", "b"]);
  });
});

describe("unqualified column references", () => {
  it("reads a bare bracket inside SUM as a column", () => {
    expect(classifier.classify("Fact", "Charges", "SUM([amt])")).toMatchObject({
      verdict: "baseMetric", sourceTable: "Fact", sourceColumn: "amt", referencedMeasures: [],
    });
  });

  it("rejects a bare bracket that is not a column of the table", () => {
    const result = classifier.classify("Fact", "Bad", "SUM([Total])");
    expect(result.verdict).toBe("unsupported");
    expect(result.error).toMatch(/not a column/);
  });

  it("binds an ambiguous name to the column and says so", () => {
    const result = classifier.classify("Fact", "Amb", "SUM([both])");
    expect(result.verdict).toBe("baseMetric");
    expect(result.notes.join(" ")).toMatch(/both a column and a measure/);
  });

  it("assumes and annotates when no schema is available", () => {
    const bare = new MeasureClassifier(resolver);
    const result = bare.classify("Fact", "Charges", "SUM([amt])");
    expect(result.verdict).toBe("baseMetric");
    expect(result.notes.join(" ")).toMatch(/without a schema/);
  });

  it("leaves a bare bracket outside an aggregation as a measure", () => {
    const result = classifier.classify("Fact", "Ratio", "DIVIDE([Total],[Total],0)");
    expect(result.verdict).toBe("daxNative");
    expect(result.referencedMeasures).toEqual(["Total"]);
  });
});

describe("inline aggregation extraction", () => {
  const provider = (existing: Record<string, string> = {}) => {
    const created: string[] = [];
    const fn = ({ method, column }: { method: string; table: string; column: string }) => {
      const reuse = existing[`${method}:${column}`];
      if (reuse) return { metric: reuse, created: false };
      const name = defaultMetricName(method, column);
      created.push(name);
      knownMeasures.add(name); // mirrors the converter registering a lifted metric
      return { metric: name, created: true };
    };
    return { fn, created };
  };

  it("lifts inline aggregations so the expression becomes native DAX", () => {
    const p = provider();
    const c = new MeasureClassifier(resolver, columns, p.fn);
    const result = c.classify("Fact", "Net", "SUM('Fact'[amt]) - SUM('Fact'[qty])");

    expect(result.verdict).toBe("daxNative");
    expect(result.rewrittenExpression).toBe("([Sum of amt] - [Sum of qty])");
    expect(result.extracted.map((e) => e.metric)).toEqual(["Sum of amt", "Sum of qty"]);
    expect(p.created).toEqual(["Sum of amt", "Sum of qty"]);
  });

  it("reuses an existing base metric rather than minting a duplicate", () => {
    const p = provider({ "sum:amt": "Gross Charge" });
    const c = new MeasureClassifier(resolver, columns, p.fn);
    const result = c.classify("Fact", "Net", "DIVIDE(SUM('Fact'[amt]), 3600)");

    expect(result.rewrittenExpression).toBe("DIVIDE([Gross Charge], 3600)");
    expect(result.extracted[0]).toMatchObject({ metric: "Gross Charge", created: false });
    expect(p.created).toEqual([]);
  });

  it("lifts an unqualified column against the measure's own table", () => {
    const p = provider();
    const c = new MeasureClassifier(resolver, columns, p.fn);
    const result = c.classify("Fact", "Hrs", "DIVIDE(SUM([amt]),3600)");
    expect(result.extracted[0]).toMatchObject({ table: "Fact", column: "amt" });
  });

  it("lowers confidence, because a lifted expression deserves a look", () => {
    const c = new MeasureClassifier(resolver, columns, provider().fn);
    const result = c.classify("Fact", "Net", "SUM('Fact'[amt]) - SUM('Fact'[qty])");
    expect(result.confidence).toBe("medium");
    expect(result.notes.join(" ")).toMatch(/lifted into base metrics/);
  });

  it("leaves aggregations over non-column arguments alone", () => {
    // Lifting SUMX(FILTER(...)) would relocate evaluation context, not just the
    // aggregation, so it must not be extracted.
    const p = provider();
    const c = new MeasureClassifier(resolver, columns, p.fn);
    c.classify("Fact", "m", "SUMX(FILTER('Fact', [a] > 0), [b])");
    expect(p.created).toEqual([]);
  });

  it("does not extract when no provider is supplied", () => {
    const result = classifier.classify("Fact", "Net", "SUM('Fact'[amt]) - SUM('Fact'[qty])");
    expect(result.extracted).toEqual([]);
    expect(result.verdict).not.toBe("daxNative");
  });

  it("still translates to MDX when extraction alone is not enough", () => {
    const c = new MeasureClassifier(resolver, columns, provider().fn);
    const result = c.classify("Fact", "m", "IF(ISBLANK(SUM('Fact'[amt])), BLANK(), SUM('Fact'[amt]))");
    expect(result.verdict).toBe("mdxTranslated");
    expect(result.mdx).toContain("[Measures].[Sum of amt]");
  });
});

describe("dax printer", () => {
  it("round-trips an expression through parse and print", () => {
    expect(printDax(parseDax("DIVIDE([a],[b],0)"))).toBe("DIVIDE([a], [b], 0)");
  });

  it("quotes table names only when required", () => {
    expect(printDax(parseDax("SUM(Fact[amt])"))).toBe("SUM(Fact[amt])");
    expect(printDax(parseDax("SUM('My Fact'[amt])"))).toBe("SUM('My Fact'[amt])");
  });

  it("preserves string escaping", () => {
    expect(printDax(parseDax('IF([a] = "x""y", 1, 0)'))).toBe('IF(([a] = "x""y"), 1, 0)');
  });
});

describe("report quality", () => {
  it("does not repeat the same remediation hint twice", () => {
    const result = classifier.classify("Fact", "m", "IFERROR([a]/[b], BLANK())");
    expect(result.verdict).toBe("unsupported");
    const texts = result.notes.map((n) => n.replace(/^[A-Z.]+: /, ""));
    expect(new Set(texts).size).toBe(texts.length);
  });

  it("marks functions the translator handles alone as incidental", () => {
    // BLANK is the common case: off the whitelist, but never the real blocker.
    expect(isIncidentalBlocker("BLANK")).toBe(true);
    expect(isIncidentalBlocker("DIVIDE")).toBe(true);
    expect(isIncidentalBlocker("GROUPBY")).toBe(false);
    expect(isIncidentalBlocker("FIRSTDATE")).toBe(false);
  });
});

describe("server-side capability registry parity", () => {
  /**
   * Pins the shape of the transcribed list against the container docs. These
   * exist because the installer and container copies of AtScale's DAX pages
   * disagree, and silently transcribing the wrong one changes every verdict
   * the converter produces.
   */
  it("has exactly the documented number of functions", () => {
    expect(SUPPORTED_DAX_FUNCTIONS.size).toBe(79);
  });

  it("includes the functions unique to the container list", () => {
    for (const fn of ["ALLSELECTED", "SELECTEDVALUE", "AVERAGEX", "ISFILTERED", "ERROR"]) {
      expect(supportsDax(fn)).toBe(true);
    }
  });

  it("excludes the plain aggregations AtScale models as base metrics", () => {
    for (const fn of ["SUM", "MIN", "MAX", "AVERAGE", "COUNT", "DISTINCTCOUNT"]) {
      expect(supportsDax(fn)).toBe(false);
      expect(baseAggregationMethod(fn)).toBeTruthy();
    }
  });

  it("excludes functions on neither the server list nor a base aggregation", () => {
    for (const fn of ["VALUES", "GROUPBY", "FIRSTDATE", "DATESBETWEEN", "IFERROR"]) {
      expect(supportsDax(fn)).toBe(false);
    }
  });
});
