import { describe, expect, it } from "vitest";
import {
  SOURCES, diff, parseFunctionList, readRegion, writeRegion,
} from "../check-atscale-capabilities.js";

/**
 * Fixture shaped like AtScale's Docusaurus capability pages: `<h3>` category
 * headings with `<li>` function items, plus the Operators/Statements sections
 * that must NOT be folded into the function list.
 */
const PAGE = `
<article>
<h2 class="anchor" id="functions">Functions<a href="#functions">​</a></h2>
<h3 class="anchor" id="aggregation-functions">Aggregation functions<a>​</a></h3>
<ul>
  <li>AVERAGEX</li>
  <li>COUNTA</li>
  <li>SUMX</li>
</ul>
<h3 class="anchor" id="math">Math and trig functions</h3>
<ul>
  <li>ABS</li>
  <li>ACOS, ACOSH, ACOT, ATAN</li>
  <li>ROUND, CEILING, FLOOR, ISO.CEILING</li>
</ul>
<h3 class="anchor" id="table">Table manipulation functions</h3>
<ul>
  <li>ADDCOLUMNS</li>
  <li>DISTINCT (table)</li>
  <li>SUMMARIZE</li>
</ul>
<h2 class="anchor" id="operators">Operators</h2>
<ul>
  <li>Arithmetic: + - / * () ^</li>
  <li>Logical: IN</li>
</ul>
<h2 class="anchor" id="statements">Statements</h2>
<ul>
  <li>RETURN</li>
  <li>VAR</li>
</ul>
</article>
`;

describe("capability page parser", () => {
  const parsed = parseFunctionList(PAGE);

  it("collects functions from every category", () => {
    expect(parsed).toContain("AVERAGEX");
    expect(parsed).toContain("SUMX");
    expect(parsed).toContain("ADDCOLUMNS");
  });

  it("splits comma-separated items onto one function each", () => {
    for (const fn of ["ACOS", "ACOSH", "ACOT", "ATAN"]) expect(parsed).toContain(fn);
  });

  it("keeps dotted function names intact", () => {
    expect(parsed).toContain("ISO.CEILING");
  });

  it("drops parenthetical qualifiers", () => {
    expect(parsed).toContain("DISTINCT");
    expect(parsed.some((f) => f.includes("("))).toBe(false);
  });

  it("does NOT fold in operators or statements", () => {
    // Folding these in would silently widen the whitelist.
    for (const token of ["IN", "RETURN", "VAR"]) expect(parsed).not.toContain(token);
  });

  it("returns a sorted, de-duplicated list", () => {
    expect(parsed).toEqual([...new Set(parsed)].sort());
  });

  it("returns nothing for a page it cannot understand", () => {
    // The caller treats this as a hard failure rather than real drift.
    expect(parseFunctionList("<html><body><p>no lists here</p></body></html>")).toEqual([]);
  });
});

describe("generated region round-trip", () => {
  const file = `
// <generated:server-dax> -- npm run check:capabilities -- --write
export const SUPPORTED_DAX_FUNCTIONS: ReadonlySet<string> = new Set([
  "ABS", "CALCULATE",
]);
// </generated:server-dax>

export const OTHER = 1;
`;

  it("reads the encoded set back out", () => {
    expect(readRegion(file, "server-dax")).toEqual(["ABS", "CALCULATE"]);
  });

  it("rewrites the set and round-trips", () => {
    const updated = writeRegion(file, "server-dax", ["ABS", "CALCULATE", "DIVIDE"]);
    expect(readRegion(updated, "server-dax")).toEqual(["ABS", "CALCULATE", "DIVIDE"]);
  });

  it("leaves everything outside the region untouched", () => {
    const updated = writeRegion(file, "server-dax", ["ZZZ"]);
    expect(updated).toContain("export const OTHER = 1;");
    expect(updated).toContain("// </generated:server-dax>");
  });

  it("throws rather than silently doing nothing for an unknown region", () => {
    expect(() => readRegion(file, "nope")).toThrow(/not found/);
    expect(() => writeRegion(file, "nope", ["A"])).toThrow(/not found/);
  });
});

describe("drift reporting", () => {
  it("names what was added and removed upstream", () => {
    const d = diff("Server-side DAX", "server-dax", "u", ["A", "B", "C"], ["A", "B", "D"]);
    expect(d.added).toEqual(["C"]);
    expect(d.removed).toEqual(["D"]);
  });

  it("reports nothing when the lists agree", () => {
    const d = diff("x", "r", "u", ["A", "B"], ["B", "A"]);
    expect(d.added).toEqual([]);
    expect(d.removed).toEqual([]);
  });
});

describe("configured sources", () => {
  it("covers both the server-side and client-side surfaces", () => {
    expect(SOURCES.map((s) => s.region).sort()).toEqual(["client-dax", "server-dax"]);
  });

  it("always reads the container docs, never the installer copy", () => {
    // The installer copies of these pages are older and materially narrower.
    for (const s of SOURCES) {
      expect(s.url).toContain("documentation.atscale.com/container/");
      expect(s.url).not.toContain("/installer/");
    }
  });

  it("carries sentinels so a structural change fails loudly", () => {
    for (const s of SOURCES) expect(s.sentinels.length).toBeGreaterThan(0);
  });
});
