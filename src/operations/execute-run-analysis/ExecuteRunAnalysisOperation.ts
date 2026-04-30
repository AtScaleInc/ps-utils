/**
 * execute-run-analysis
 *
 * Compares two run logs produced by execute-atscale-query-harness, or two
 * enhanced CSVs produced by generate-enhanced-query-results, on a
 * query-by-query basis.
 *
 * Matching is performed by joining on a configurable key column:
 *   original_text_hash          — match queries with identical SQL text (default)
 *   original_atscale_query_id   — match by the query ID recorded at capture time
 *
 * When the same join-key value appears multiple times in a file the rows are
 * sorted by timestamp and paired positionally (1st with 1st, 2nd with 2nd …).
 * Extra occurrences on either side that cannot be paired are reported as
 * unmatched in the summary.
 *
 * Outputs two files:
 *
 *   --summary-file   Plain-text report:  input metadata, match statistics,
 *                    and listings of flagged queries (error mismatch, unmatched).
 *                    References --outliers-file for row-count / duration detail.
 *
 *   --comparison-file  CSV with one row per matched pair:
 *                    a_/b_ prefixed columns for status, duration, row_count,
 *                    checksum, error, timestamp; computed delta columns; boolean
 *                    flag columns; and enhanced timing columns (run_inbound_ms,
 *                    run_query_planning_ms, etc.) when present in either input.
 *
 *   --outliers-file  CSV containing only the pairs flagged for a row-count
 *                    mismatch or a duration outside the variance threshold.
 *                    Same schema as --comparison-file.
 */
import { Operation } from "../Operation.js";
import { ParameterSet, StringParameter } from "../../Parameters.js";
import type { ServiceRegistry } from "../../services/registry.js";
import type { Logger } from "../../logging.js";
import fs from "fs";
import path from "path";

// ── Parameter set ──────────────────────────────────────────────────────────────

class ExecuteRunAnalysisParams extends ParameterSet {
  parameters = [
    new (class extends StringParameter {
      name = "file-a";
      description =
        "Path to the first run log (execute-atscale-query-harness CSV) or " +
        "enhanced output (generate-enhanced-query-results CSV)";
      required = true;
    })(),
    new (class extends StringParameter {
      name = "file-b";
      description =
        "Path to the second run log or enhanced output to compare against file-a";
      required = true;
    })(),
    new (class extends StringParameter {
      name = "join-key";
      description =
        "Column to join queries across the two files. " +
        "Use 'original_text_hash' (default) to match queries by SQL text, or " +
        "'original_atscale_query_id' to match by the AtScale query ID recorded at capture time.";
      required = false;
      defaultValue = "original_text_hash";
    })(),
    new (class extends StringParameter {
      name = "duration-variance-pct";
      description =
        "Percentage threshold for flagging duration differences. " +
        "A pair is flagged when |(b_duration - a_duration) / a_duration| × 100 " +
        "exceeds this value. Default: 20.";
      required = false;
      defaultValue = "20";
    })(),
    new (class extends StringParameter {
      name = "summary-file";
      description = "Path to write the plain-text summary report";
      required = true;
    })(),
    new (class extends StringParameter {
      name = "comparison-file";
      description = "Path to write the row-by-row comparison CSV";
      required = true;
    })(),
    new (class extends StringParameter {
      name = "outliers-file";
      description =
        "Path to write the outliers CSV — a filtered subset of --comparison-file " +
        "containing only pairs flagged for a row-count mismatch or a duration " +
        "outside the variance threshold";
      required = true;
    })(),
  ];
}

type Params = {
  "file-a": string;
  "file-b": string;
  "join-key": string;
  "duration-variance-pct": string;
  "summary-file": string;
  "comparison-file": string;
  "outliers-file": string;
};

// ── CSV helpers ────────────────────────────────────────────────────────────────

type Row = Record<string, string>;

/**
 * Parse an RFC-4180 CSV string.
 * Returns the header row and data rows as objects keyed by column name.
 */
function parseCsv(content: string): { header: string[]; rows: Row[] } {
  const rawRows: string[][] = [];
  let i = 0;
  const n = content.length;

  while (i < n) {
    const row: string[] = [];

    while (i < n && content[i] !== "\n" && content[i] !== "\r") {
      if (content[i] === '"') {
        i++;
        let field = "";
        while (i < n) {
          if (content[i] === '"' && content[i + 1] === '"') {
            field += '"';
            i += 2;
          } else if (content[i] === '"') {
            i++;
            break;
          } else {
            field += content[i++];
          }
        }
        row.push(field);
      } else {
        let field = "";
        while (i < n && content[i] !== "," && content[i] !== "\n" && content[i] !== "\r") {
          field += content[i++];
        }
        row.push(field.trim());
      }
      if (i < n && content[i] === ",") {
        i++;
      } else {
        break;
      }
    }
    if (i < n && content[i] === "\r") i++;
    if (i < n && content[i] === "\n") i++;
    if (row.length > 0 && !(row.length === 1 && row[0] === "")) {
      rawRows.push(row);
    }
  }

  if (rawRows.length === 0) return { header: [], rows: [] };
  const header = rawRows[0];
  const rows = rawRows.slice(1).map((cells) => {
    const obj: Row = {};
    header.forEach((col, idx) => {
      obj[col] = cells[idx] ?? "";
    });
    return obj;
  });
  return { header, rows };
}

/** Escape a single CSV field value. */
function csvField(value: string | number | null | undefined): string {
  const s = value == null ? "" : String(value);
  if (s.includes(",") || s.includes('"') || s.includes("\n")) {
    return `"${s.replace(/"/g, '""')}"`;
  }
  return s;
}

// ── Enhanced timing column names ───────────────────────────────────────────────

/**
 * The timing columns appended by generate-enhanced-query-results.
 * Included in the comparison output only when present in at least one input file.
 */
const ENHANCED_TIMING_COLS = [
  "run_duration_ms",
  "run_inbound_ms",
  "run_query_planning_ms",
  "run_outbound_ms",
  "run_wait_ms",
  "run_execute",
  "run_fetch_ms",
] as const;

type EnhancedTimingCol = (typeof ENHANCED_TIMING_COLS)[number];

// ── Comparison types ───────────────────────────────────────────────────────────

interface MatchedPair {
  joinKeyValue: string;
  queryName: string;
  occurrence: number;
  // flag columns
  rowCountMismatch: boolean;
  durationOutsideVariance: boolean;
  errorMismatch: boolean;
  // a side
  aStatus: string;
  aDurationMs: string;
  aRowCount: string;
  aChecksum: string;
  aError: string;
  aTimestamp: string;
  // b side
  bStatus: string;
  bDurationMs: string;
  bRowCount: string;
  bChecksum: string;
  bError: string;
  bTimestamp: string;
  // deltas
  durationDeltaMs: string;
  durationDeltaPct: string;
  // enhanced timing — present keys are those active for this run
  enhancedA: Partial<Record<EnhancedTimingCol, string>>;
  enhancedB: Partial<Record<EnhancedTimingCol, string>>;
}

interface UnmatchedGroup {
  joinKeyValue: string;
  queryName: string;
  side: "a" | "b";
  occurrences: number;
}

// ── Core comparison logic ──────────────────────────────────────────────────────

/**
 * Group CSV rows by the join-key column value, sorted ascending by timestamp
 * within each group so positional pairing is deterministic.
 */
function groupByKey(rows: Row[], joinKey: string): Map<string, Row[]> {
  const map = new Map<string, Row[]>();
  for (const row of rows) {
    const key = row[joinKey] ?? "";
    if (!key) continue;
    if (!map.has(key)) map.set(key, []);
    map.get(key)!.push(row);
  }
  // Sort each group by timestamp ascending (lexicographic sort works for epoch ms)
  for (const group of map.values()) {
    group.sort((a, b) => {
      const ta = parseInt(a.timestamp ?? "0", 10) || 0;
      const tb = parseInt(b.timestamp ?? "0", 10) || 0;
      return ta - tb;
    });
  }
  return map;
}

/**
 * Compute |delta| / a * 100 as a signed percentage (b relative to a).
 * Returns null when a is 0 or not a valid number.
 */
function durationDeltaPct(aDuration: string, bDuration: string): number | null {
  const a = parseFloat(aDuration);
  const b = parseFloat(bDuration);
  if (!isFinite(a) || !isFinite(b) || a === 0) return null;
  return ((b - a) / a) * 100;
}

/**
 * Compare two groups of rows (already keyed by join value) and produce:
 *   - matched pairs (positionally paired within each join-key group)
 *   - unmatched entries (present in one side only, or with extra occurrences)
 */
function buildComparisons(
  groupA: Map<string, Row[]>,
  groupB: Map<string, Row[]>,
  durationVariancePct: number,
  activeTiming: Set<EnhancedTimingCol>,
): {
  pairs: MatchedPair[];
  unmatched: UnmatchedGroup[];
} {
  const pairs: MatchedPair[] = [];
  const unmatched: UnmatchedGroup[] = [];
  const allKeys = new Set([...groupA.keys(), ...groupB.keys()]);

  for (const key of allKeys) {
    const aRows = groupA.get(key) ?? [];
    const bRows = groupB.get(key) ?? [];
    const pairCount = Math.min(aRows.length, bRows.length);

    for (let idx = 0; idx < pairCount; idx++) {
      const a = aRows[idx];
      const b = bRows[idx];
      const queryName = a.query_name || b.query_name || "";

      const aDur = a.duration_ms ?? "";
      const bDur = b.duration_ms ?? "";
      const deltaMs = (isFinite(parseFloat(aDur)) && isFinite(parseFloat(bDur)))
        ? String(Math.round(parseFloat(bDur) - parseFloat(aDur)))
        : "";
      const pct = durationDeltaPct(aDur, bDur);
      const deltaPctStr = pct !== null ? pct.toFixed(1) : "";

      const rowCountMismatch = (a.row_count ?? "") !== (b.row_count ?? "");
      const durationOutsideVariance =
        pct !== null && Math.abs(pct) > durationVariancePct;
      const errorMismatch =
        (a.status ?? "") !== (b.status ?? "") ||
        (a.error ?? "") !== (b.error ?? "");

      const enhancedA: Partial<Record<EnhancedTimingCol, string>> = {};
      const enhancedB: Partial<Record<EnhancedTimingCol, string>> = {};
      for (const col of activeTiming) {
        enhancedA[col] = a[col] ?? "";
        enhancedB[col] = b[col] ?? "";
      }

      pairs.push({
        joinKeyValue: key,
        queryName,
        occurrence: idx + 1,
        rowCountMismatch,
        durationOutsideVariance,
        errorMismatch,
        aStatus: a.status ?? "",
        aDurationMs: aDur,
        aRowCount: a.row_count ?? "",
        aChecksum: a.checksum ?? "",
        aError: a.error ?? "",
        aTimestamp: a.timestamp ?? "",
        bStatus: b.status ?? "",
        bDurationMs: bDur,
        bRowCount: b.row_count ?? "",
        bChecksum: b.checksum ?? "",
        bError: b.error ?? "",
        bTimestamp: b.timestamp ?? "",
        durationDeltaMs: deltaMs,
        durationDeltaPct: deltaPctStr,
        enhancedA,
        enhancedB,
      });
    }

    // Extra A rows beyond what B can match
    if (aRows.length > bRows.length) {
      unmatched.push({
        joinKeyValue: key,
        queryName: aRows[0].query_name ?? "",
        side: "a",
        occurrences: aRows.length - bRows.length,
      });
    }

    // Key present only in B, or B has extra rows
    if (bRows.length > aRows.length) {
      unmatched.push({
        joinKeyValue: key,
        queryName: bRows[0].query_name ?? "",
        side: "b",
        occurrences: bRows.length - aRows.length,
      });
    }
  }

  return { pairs, unmatched };
}

// ── Output builders ────────────────────────────────────────────────────────────

/** Emit the comparison CSV. */
function buildComparisonCsv(
  pairs: MatchedPair[],
  activeTiming: Set<EnhancedTimingCol>,
): string {
  const timingCols = ENHANCED_TIMING_COLS.filter((c) => activeTiming.has(c));

  const header = [
    "join_key_value",
    "query_name",
    "occurrence",
    "row_count_mismatch",
    "duration_outside_variance",
    "error_mismatch",
    "a_status", "b_status",
    "a_duration_ms", "b_duration_ms",
    "duration_delta_ms", "duration_delta_pct",
    "a_row_count", "b_row_count",
    "a_checksum", "b_checksum",
    "a_error", "b_error",
    "a_timestamp", "b_timestamp",
    ...timingCols.map((c) => `a_${c}`),
    ...timingCols.map((c) => `b_${c}`),
  ];

  const dataRows = pairs.map((p) => {
    const base = [
      p.joinKeyValue,
      p.queryName,
      String(p.occurrence),
      String(p.rowCountMismatch),
      String(p.durationOutsideVariance),
      String(p.errorMismatch),
      p.aStatus, p.bStatus,
      p.aDurationMs, p.bDurationMs,
      p.durationDeltaMs, p.durationDeltaPct,
      p.aRowCount, p.bRowCount,
      p.aChecksum, p.bChecksum,
      p.aError, p.bError,
      p.aTimestamp, p.bTimestamp,
    ];
    const timingA = timingCols.map((c) => p.enhancedA[c] ?? "");
    const timingB = timingCols.map((c) => p.enhancedB[c] ?? "");
    return [...base, ...timingA, ...timingB].map(csvField).join(",");
  });

  return [header.map(csvField).join(","), ...dataRows].join("\n") + "\n";
}

/** Format a float string with a sign and fixed decimal places. */
function fmtPct(pctStr: string): string {
  const n = parseFloat(pctStr);
  if (!isFinite(n)) return pctStr;
  return (n >= 0 ? "+" : "") + n.toFixed(1) + "%";
}

/** Truncate a string to `len` characters for summary display. */
function trunc(s: string, len: number): string {
  return s.length > len ? s.slice(0, len - 1) + "…" : s;
}

/** Right-pad a string to exactly `len` characters. */
function pad(s: string, len: number): string {
  return s.length >= len ? s : s + " ".repeat(len - s.length);
}

/**
 * Render a list of rows as a fixed-width plain-text table.
 * `cols` is an array of [header, accessor] pairs where accessor is a function
 * that returns the cell value for a given row.
 * Column widths are determined by the max of the header and all cell values.
 */
function textTable<T>(
  rows: T[],
  cols: Array<[header: string, accessor: (row: T) => string]>,
  indent: string,
): string[] {
  const widths = cols.map(([hdr, fn]) =>
    Math.max(hdr.length, ...rows.map((r) => fn(r).length)),
  );
  const separator = indent + widths.map((w) => "-".repeat(w)).join("  ");
  const header = indent + cols.map(([hdr], i) => pad(hdr, widths[i])).join("  ");
  const dataLines = rows.map((r) =>
    indent + cols.map(([, fn], i) => pad(fn(r), widths[i])).join("  "),
  );
  return [header, separator, ...dataLines];
}

/** Emit the plain-text summary report. */
function buildSummary(
  pathA: string,
  pathB: string,
  headerA: string[],
  headerB: string[],
  rowsA: Row[],
  rowsB: Row[],
  joinKey: string,
  durationVariancePct: number,
  pairs: MatchedPair[],
  unmatched: UnmatchedGroup[],
  outliersPath: string,
  elapsedMs: number,
): string {
  const lines: string[] = [];
  const ts = new Date().toISOString();

  // Metadata helpers
  const uniqueValues = (rows: Row[], col: string): string[] =>
    [...new Set(rows.map((r) => r[col] ?? "").filter(Boolean))];

  const runIdsA = uniqueValues(rowsA, "run_id");
  const runIdsB = uniqueValues(rowsB, "run_id");
  const uniqueKeysA = new Set(rowsA.map((r) => r[joinKey]).filter(Boolean)).size;
  const uniqueKeysB = new Set(rowsB.map((r) => r[joinKey]).filter(Boolean)).size;

  const unmatchedA = unmatched.filter((u) => u.side === "a");
  const unmatchedB = unmatched.filter((u) => u.side === "b");
  const rcMismatches = pairs.filter((p) => p.rowCountMismatch);
  const durMismatches = pairs.filter((p) => p.durationOutsideVariance);
  const errMismatches = pairs.filter((p) => p.errorMismatch);

  const isEnhancedA = headerA.includes("run_duration_ms");
  const isEnhancedB = headerB.includes("run_duration_ms");

  const elapsedSec = (elapsedMs / 1000).toFixed(1);
  lines.push("# Run Analysis Summary");
  lines.push(`Generated:    ${ts}`);
  lines.push(`Total runtime: ${elapsedSec}s (${elapsedMs}ms)`);
  lines.push("");

  // ── Input files ──────────────────────────────────────────────────────────────
  lines.push("## Input Files");
  lines.push("");
  lines.push(`File A: ${pathA}`);
  lines.push(`  Type:     ${isEnhancedA ? "enhanced (generate-enhanced-query-results)" : "run log (execute-atscale-query-harness)"}`);
  lines.push(`  Rows:     ${rowsA.length}`);
  lines.push(`  Run IDs:  ${runIdsA.length ? runIdsA.join(", ") : "(not found)"}`);
  lines.push(`  Unique ${joinKey}s: ${uniqueKeysA}`);
  lines.push("");
  lines.push(`File B: ${pathB}`);
  lines.push(`  Type:     ${isEnhancedB ? "enhanced (generate-enhanced-query-results)" : "run log (execute-atscale-query-harness)"}`);
  lines.push(`  Rows:     ${rowsB.length}`);
  lines.push(`  Run IDs:  ${runIdsB.length ? runIdsB.join(", ") : "(not found)"}`);
  lines.push(`  Unique ${joinKey}s: ${uniqueKeysB}`);
  lines.push("");

  // ── Configuration ────────────────────────────────────────────────────────────
  lines.push("## Configuration");
  lines.push("");
  lines.push(`  Join key:                   ${joinKey}`);
  lines.push(`  Duration variance threshold: ${durationVariancePct}%`);
  lines.push("");

  // ── Match statistics ──────────────────────────────────────────────────────────
  const totalUnmatchedA = unmatchedA.reduce((s, u) => s + u.occurrences, 0);
  const totalUnmatchedB = unmatchedB.reduce((s, u) => s + u.occurrences, 0);

  lines.push("## Match Statistics");
  lines.push("");
  lines.push(`  Matched pairs:              ${pairs.length}`);
  lines.push(`  Unmatched rows in A:        ${totalUnmatchedA}`);
  lines.push(`  Unmatched rows in B:        ${totalUnmatchedB}`);
  lines.push(`  Row-count mismatches:       ${rcMismatches.length}`);
  lines.push(`  Duration outside variance:  ${durMismatches.length}`);
  lines.push(`  Error mismatches:           ${errMismatches.length}`);
  lines.push("");

  // ── Unmatched in A ────────────────────────────────────────────────────────────
  lines.push(`## Queries Only in File A (${totalUnmatchedA} row(s) across ${unmatchedA.length} join key(s))`);
  lines.push("");
  if (unmatchedA.length === 0) {
    lines.push("  (none)");
  } else {
    for (const u of unmatchedA) {
      lines.push(
        `  query_name=${trunc(u.queryName || "(unknown)", 60)}` +
        `  ${joinKey}=${trunc(u.joinKeyValue, 20)}` +
        `  occurrences=${u.occurrences}`,
      );
    }
  }
  lines.push("");

  // ── Unmatched in B ────────────────────────────────────────────────────────────
  lines.push(`## Queries Only in File B (${totalUnmatchedB} row(s) across ${unmatchedB.length} join key(s))`);
  lines.push("");
  if (unmatchedB.length === 0) {
    lines.push("  (none)");
  } else {
    for (const u of unmatchedB) {
      lines.push(
        `  query_name=${trunc(u.queryName || "(unknown)", 60)}` +
        `  ${joinKey}=${trunc(u.joinKeyValue, 20)}` +
        `  occurrences=${u.occurrences}`,
      );
    }
  }
  lines.push("");

  // ── Row-count and duration mismatches (reference to outliers file) ──────────
  const combinedMismatches = pairs.filter((p) => p.rowCountMismatch || p.durationOutsideVariance);
  lines.push(
    `## Row-Count and Duration Mismatches` +
    ` (${combinedMismatches.length} pair(s);` +
    ` RC=${rcMismatches.length}, DUR=outside ±${durationVariancePct}%)`,
  );
  lines.push("");
  if (combinedMismatches.length === 0) {
    lines.push("  (none)");
  } else {
    lines.push(`  See: ${outliersPath}`);
  }
  lines.push("");

  // ── Error mismatches ──────────────────────────────────────────────────────────
  lines.push(`## Error Mismatches (${errMismatches.length})`);
  lines.push("");
  if (errMismatches.length === 0) {
    lines.push("  (none)");
  } else {
    for (const p of errMismatches) {
      const occ = p.occurrence > 1 ? ` [occ ${p.occurrence}]` : "";
      lines.push(`  ${trunc(p.queryName || p.joinKeyValue, 60)}${occ}`);
      lines.push(`    a: status=${p.aStatus}  error=${trunc(p.aError || "(none)", 80)}`);
      lines.push(`    b: status=${p.bStatus}  error=${trunc(p.bError || "(none)", 80)}`);
    }
  }
  lines.push("");

  return lines.join("\n");
}

// ── Operation ──────────────────────────────────────────────────────────────────

export class ExecuteRunAnalysisOperation extends Operation<Params> {
  name = "execute-run-analysis";
  description =
    "Compare two execute-atscale-query-harness run logs (or enhanced outputs) " +
    "query-by-query; writes a plain-text summary report, a full row-by-row " +
    "comparison CSV, and a filtered outliers CSV for row-count and duration mismatches";
  parameters = new ExecuteRunAnalysisParams();

  constructor(services: ServiceRegistry, logger: Logger) {
    super(services, logger);
  }

  async run(params: Params): Promise<void> {
    const startTime = Date.now();
    const joinKey = params["join-key"];
    const durationVariancePct = Math.max(0, parseFloat(params["duration-variance-pct"]) || 20);
    const summaryPath = path.resolve(params["summary-file"]);
    const comparisonPath = path.resolve(params["comparison-file"]);
    const outliersPath = path.resolve(params["outliers-file"]);

    // Validate join key early.
    const validJoinKeys = ["original_text_hash", "original_atscale_query_id"];
    if (!validJoinKeys.includes(joinKey)) {
      throw new Error(
        `Invalid --join-key '${joinKey}'. Must be one of: ${validJoinKeys.join(", ")}`,
      );
    }

    // ── Load files ───────────────────────────────────────────────────────────
    const pathA = path.resolve(params["file-a"]);
    const pathB = path.resolve(params["file-b"]);

    for (const [label, p] of [["file-a", pathA], ["file-b", pathB]] as const) {
      if (!fs.existsSync(p)) {
        throw new Error(`${label} not found: ${p}`);
      }
    }

    this.logger.info(`Loading file A: ${pathA}`);
    const { header: headerA, rows: rowsA } = parseCsv(fs.readFileSync(pathA, "utf8"));

    this.logger.info(`Loading file B: ${pathB}`);
    const { header: headerB, rows: rowsB } = parseCsv(fs.readFileSync(pathB, "utf8"));

    // Validate join key is present in both files.
    for (const [label, header, p] of [
      ["file-a", headerA, pathA],
      ["file-b", headerB, pathB],
    ] as const) {
      if (!header.includes(joinKey)) {
        throw new Error(
          `Column '${joinKey}' not found in ${label} (${p}). ` +
          `Available columns: ${header.join(", ")}`,
        );
      }
    }

    this.logger.info(`  A: ${rowsA.length} row(s)   B: ${rowsB.length} row(s)   join-key: ${joinKey}`);

    // ── Determine which enhanced timing columns are active ───────────────────
    // Include a timing column in the comparison when it is present in at least
    // one of the two input files.
    const allHeaders = new Set([...headerA, ...headerB]);
    const activeTiming = new Set(
      ENHANCED_TIMING_COLS.filter((c) => allHeaders.has(c)),
    );
    if (activeTiming.size > 0) {
      this.logger.info(`  Enhanced timing columns detected: ${[...activeTiming].join(", ")}`);
    }

    // ── Build comparison ─────────────────────────────────────────────────────
    const groupA = groupByKey(rowsA, joinKey);
    const groupB = groupByKey(rowsB, joinKey);
    const { pairs, unmatched } = buildComparisons(groupA, groupB, durationVariancePct, activeTiming);

    const unmatchedA = unmatched.filter((u) => u.side === "a");
    const unmatchedB = unmatched.filter((u) => u.side === "b");
    const rcMismatches = pairs.filter((p) => p.rowCountMismatch).length;
    const durMismatches = pairs.filter((p) => p.durationOutsideVariance).length;
    const errMismatches = pairs.filter((p) => p.errorMismatch).length;

    this.logger.info(
      `  Matched ${pairs.length} pair(s)  |  ` +
      `unmatched A=${unmatched.filter((u) => u.side === "a").reduce((s, u) => s + u.occurrences, 0)}  ` +
      `B=${unmatched.filter((u) => u.side === "b").reduce((s, u) => s + u.occurrences, 0)}`,
    );
    this.logger.info(
      `  Flags: row_count_mismatch=${rcMismatches}  ` +
      `duration_outside_variance=${durMismatches}  ` +
      `error_mismatch=${errMismatches}`,
    );

    // ── Write outputs ─────────────────────────────────────────────────────────
    fs.mkdirSync(path.dirname(summaryPath), { recursive: true });
    fs.mkdirSync(path.dirname(comparisonPath), { recursive: true });
    fs.mkdirSync(path.dirname(outliersPath), { recursive: true });

    const outlierPairs = pairs.filter((p) => p.rowCountMismatch || p.durationOutsideVariance);
    const outliersCsv = buildComparisonCsv(outlierPairs, activeTiming);
    fs.writeFileSync(outliersPath, outliersCsv, "utf8");
    this.logger.info(`Outliers     → ${outliersPath}  (${outlierPairs.length} row(s))`);

    const elapsedMs = Date.now() - startTime;

    const summary = buildSummary(
      pathA, pathB,
      headerA, headerB,
      rowsA, rowsB,
      joinKey, durationVariancePct,
      pairs, unmatched,
      outliersPath,
      elapsedMs,
    );
    fs.writeFileSync(summaryPath, summary, "utf8");
    this.logger.info(`Summary      → ${summaryPath}`);

    const comparisonCsv = buildComparisonCsv(pairs, activeTiming);
    fs.writeFileSync(comparisonPath, comparisonCsv, "utf8");
    this.logger.info(`Comparison   → ${comparisonPath}`);
  }
}
