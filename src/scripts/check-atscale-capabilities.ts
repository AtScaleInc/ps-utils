/**
 * Checks (and optionally rewrites) the AtScale capability whitelists against
 * the live documentation.
 *
 *   npm run check:atscale-capabilities            # report drift, exit 1 if any
 *   npm run check:atscale-capabilities -- --write # rewrite the generated regions
 *   npm run check:atscale-capabilities -- --json  # machine-readable drift report
 *
 * Why this exists: three hand-transcribed lists drive every DAX verdict
 * ps-utils produces. They are snapshots, so they go stale silently as AtScale
 * adds support — and a stale list does not error, it just quietly returns wrong
 * answers. Transcribing the wrong *copy* of one page once reported 16% of a
 * real report as supported instead of 62%.
 *
 * Always reads the `container` docs. AtScale also publishes an `installer` copy
 * of these pages and they are not interchangeable.
 *
 * Needs outbound network access to documentation.atscale.com.
 */

import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

export type CapabilitySource = {
  /** Region marker name in the source file. */
  region: string;
  label: string;
  url: string;
  file: string;
  /**
   * Headings whose lists are NOT functions (operators, statements). Compared
   * case-insensitively against the heading text.
   */
  skipHeadings?: string[];
  /**
   * Functions known to be on this page. If the parser cannot find them the
   * page structure has changed and the result is untrustworthy, so the check
   * fails loudly instead of reporting a huge fake drift (or, worse, emptying
   * the whitelist under --write).
   */
  sentinels: string[];
};

const DOCS = "https://documentation.atscale.com/container";

export const SOURCES: CapabilitySource[] = [
  {
    region: "server-dax",
    label: "Server-side DAX",
    url: `${DOCS}/creating-and-sharing-cubes/creating-cubes/modeling-cube-measures/add-calculated-measures/server-side-dax`,
    file: "src/operations/generate-sml-from-tabular/dax/capabilities.ts",
    sentinels: ["CALCULATE", "SUMX", "DIVIDE", "TOTALYTD"],
  },
  {
    region: "client-dax",
    label: "Client-side DAX",
    url: `${DOCS}/connect-integrate/connect-with-bi-tools/microsoft-power-bi/using-dax-tabular/supported-dax-language-elements`,
    file: "src/operations/analyze-powerbi-dax-gaps/client-dax-capabilities.ts",
    sentinels: ["CALCULATE", "SELECTEDVALUE", "SUM", "FORMAT"],
  },
];

const SKIP_HEADING = /operator|statement/i;

const decodeEntities = (s: string): string =>
  s.replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&nbsp;/g, " ");

const stripTags = (s: string): string => decodeEntities(s.replace(/<[^>]*>/g, " "));

/** A token that looks like a DAX/MDX function name. */
const FUNCTION_TOKEN = /^[A-Z][A-Z0-9_]*(?:\.[A-Z][A-Z0-9_]*)*$/;

/**
 * Extract the function names from an AtScale capability page.
 *
 * The pages are Docusaurus: functions live in `<li>` items under `<h3>`
 * headings, one per category. Some items list several comma-separated
 * functions on one line ("ACOS, ACOSH, ACOT, ..."), and some carry a
 * parenthetical qualifier ("DISTINCT (table)"), so each item is split and
 * filtered rather than taken verbatim.
 *
 * Headings for operators and statements are skipped: their items are symbols
 * and keywords, not functions, and folding them in would silently widen the
 * whitelist.
 */
export function parseFunctionList(html: string): string[] {
  const found = new Set<string>();

  // Split the document at each heading so items can be attributed to one.
  const headingRe = /<h[23][^>]*>([\s\S]*?)<\/h[23]>/g;
  const sections: Array<{ heading: string; start: number; end: number }> = [];
  let match: RegExpExecArray | null;
  while ((match = headingRe.exec(html)) !== null) {
    sections.push({
      heading: stripTags(match[1]).replace(/\u200b/g, "").trim(),
      start: headingRe.lastIndex,
      end: html.length,
    });
    if (sections.length > 1) sections[sections.length - 2].end = match.index;
  }

  for (const section of sections) {
    if (SKIP_HEADING.test(section.heading)) continue;
    const body = html.slice(section.start, section.end);
    for (const item of body.matchAll(/<li[^>]*>([\s\S]*?)<\/li>/g)) {
      const text = stripTags(item[1]);
      // Drop parentheticals: "DISTINCT (table)" -> "DISTINCT"
      for (const piece of text.split(",")) {
        const token = piece.replace(/\([^)]*\)/g, " ").trim();
        if (FUNCTION_TOKEN.test(token)) found.add(token);
      }
    }
  }
  return [...found].sort();
}

/** Pull the current set out of a `// <generated:NAME>` region. */
export function readRegion(source: string, region: string): string[] {
  const re = new RegExp(
    `// <generated:${region}>[\\s\\S]*?new Set\\(\\[([\\s\\S]*?)\\]\\);`,
  );
  const m = re.exec(source);
  if (!m) throw new Error(`region '${region}' not found`);
  return [...m[1].matchAll(/"([^"]+)"/g)].map((x) => x[1]);
}

/** Replace the set inside a region, preserving everything around it. */
export function writeRegion(source: string, region: string, functions: string[]): string {
  const re = new RegExp(
    `(// <generated:${region}>[\\s\\S]*?new Set\\(\\[)([\\s\\S]*?)(\\]\\);)`,
  );
  if (!re.test(source)) throw new Error(`region '${region}' not found`);

  const lines: string[] = [];
  let current = " ";
  for (const fn of functions) {
    const token = `"${fn}", `;
    if (current.length + token.length > 78) { lines.push(current.trimEnd()); current = " "; }
    current += token;
  }
  if (current.trim()) lines.push(current.trimEnd());
  const body = `\n${lines.join("\n").replace(/,$/, ",")}\n`;
  return source.replace(re, `$1${body}$3`);
}

export type Drift = {
  label: string;
  region: string;
  url: string;
  added: string[];
  removed: string[];
};

export function diff(label: string, region: string, url: string, live: string[], encoded: string[]): Drift {
  const liveSet = new Set(live);
  const encodedSet = new Set(encoded);
  return {
    label, region, url,
    added: live.filter((f) => !encodedSet.has(f)),
    removed: encoded.filter((f) => !liveSet.has(f)),
  };
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const write = args.includes("--write");
  const asJson = args.includes("--json");
  const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

  const drifts: Drift[] = [];

  for (const source of SOURCES) {
    let html: string;
    try {
      const response = await fetch(source.url, { headers: { "user-agent": "ps-utils-capability-check" } });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      html = await response.text();
    } catch (err) {
      console.error(
        `[check:atscale-capabilities] Could not fetch ${source.label} (${source.url}): ${
          err instanceof Error ? err.message : String(err)
        }\n` +
        "  This check needs outbound access to documentation.atscale.com. If you " +
        "are behind a proxy or an egress allowlist, add that host.",
      );
      process.exitCode = 2;
      return;
    }

    const live = parseFunctionList(html);
    const missing = source.sentinels.filter((s) => !live.includes(s));
    if (live.length === 0 || missing.length > 0) {
      console.error(
        `[check:atscale-capabilities] Parse of ${source.label} looks wrong: found ` +
        `${live.length} function(s)` +
        (missing.length ? `, missing expected ${missing.join(", ")}` : "") +
        ".\n  The page structure has probably changed. Refusing to report or " +
        "write anything rather than corrupting the whitelist — update " +
        "parseFunctionList() in src/scripts/check-atscale-capabilities.ts.",
      );
      process.exitCode = 2;
      return;
    }

    const filePath = path.join(repoRoot, source.file);
    const contents = await readFile(filePath, "utf8");
    const encoded = readRegion(contents, source.region);
    const drift = diff(source.label, source.region, source.url, live, encoded);
    drifts.push(drift);

    if (write && (drift.added.length || drift.removed.length)) {
      await writeFile(filePath, writeRegion(contents, source.region, live), "utf8");
    }
  }

  if (asJson) {
    console.log(JSON.stringify({ drifts }, null, 2));
  } else {
    for (const d of drifts) {
      const clean = d.added.length === 0 && d.removed.length === 0;
      console.log(`\n${d.label} — ${clean ? "up to date" : "DRIFT"}`);
      if (d.added.length) console.log(`  + added upstream:   ${d.added.join(", ")}`);
      if (d.removed.length) console.log(`  - removed upstream: ${d.removed.join(", ")}`);
    }
  }

  const drifted = drifts.some((d) => d.added.length || d.removed.length);
  if (!drifted) {
    if (!asJson) console.log("\nAll capability lists match the container docs.");
    return;
  }

  if (write) {
    console.log(
      "\nRewrote the generated regions. Now: bump `captured` in each file, " +
      "update the count assertions in the parity tests, add remediation hints " +
      "for any new unsupported-adjacent functions, and run `npm test`.",
    );
    console.log(
      "Note: adding a function to a whitelist makes ps-utils *accept* it. " +
      "DAX->MDX translation of a structurally new function still needs a rule " +
      "in dax/mdx.ts — the whitelist says 'allowed', the translator has to know how.",
    );
    return;
  }

  console.log("\nRun with --write to update, or edit the generated regions by hand.");
  process.exitCode = 1;
}

// Only run when invoked directly, so the parser can be imported by tests.
const invokedDirectly = process.argv[1]
  && path.resolve(process.argv[1]).endsWith(path.join("scripts", "check-atscale-capabilities.js"));
if (invokedDirectly) {
  main().catch((err) => {
    console.error(err);
    process.exitCode = 2;
  });
}
