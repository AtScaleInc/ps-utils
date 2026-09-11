/**
 * Structural usage analysis for an existing SML directory.
 *
 * Answers "could this object ever be queried" — is it wired into at least one model, the
 * only real entry point a live catalog is ever queried through — by walking the reference
 * graph outward from every model: relationships/dimensions/metrics on the model itself, then
 * transitively through each reached dimension's own level_attributes, secondary attributes,
 * and snowflake relationships, to every dataset and connection they touch. Anything never
 * reached this way is structurally unused.
 *
 * This is deliberately structural, not usage-based: it does not answer "has this object
 * actually been queried" — that needs real query history (see extract-query-stats-from-
 * atscale), which reports occurrence counts by attribute/measure name. Joining that against
 * these unique_names to add a genuine usage-based pass is a natural follow-up, not attempted
 * here.
 *
 * Known scope limits (why the caller should always review the report before deleting
 * anything): row_security objects and any object's cross-references into an unrecognized
 * ("other") object_type are not analyzed, so an object reachable only through one of those
 * paths will be misreported as unused.
 */

/* eslint-disable @typescript-eslint/no-explicit-any */
type Raw = Record<string, any>;

/** One parsed SML object plus the file it came from (relative to the sml-dir). */
export interface SmlObject {
  file: string;
  raw: Raw;
}

/** Everything collected from an SML directory, grouped by kind. */
export interface SmlCollection {
  catalog?: Raw;
  connections: SmlObject[];
  datasets: SmlObject[];
  dimensions: SmlObject[];
  metrics: SmlObject[];
  calculations: SmlObject[];
  models: SmlObject[];
  /** Objects whose object_type didn't match a known kind — never analyzed or flagged. */
  other: SmlObject[];
}

export interface UsageAnalysis {
  unusedConnections: SmlObject[];
  unusedDatasets: SmlObject[];
  unusedDimensions: SmlObject[];
  unusedMetrics: SmlObject[];
  unusedCalculations: SmlObject[];
  reachableCounts: {
    connections: number;
    datasets: number;
    dimensions: number;
    metrics: number;
    calculations: number;
  };
}

function asArray<T = any>(v: unknown): T[] {
  if (Array.isArray(v)) return v as T[];
  if (v === undefined || v === null) return [];
  return [v as T];
}

/** Normalize a dataset reference by dropping a trailing `.dataset` suffix. */
function normDataset(ref: unknown): string {
  return String(ref ?? "").replace(/\.dataset$/, "");
}

function byUniqueName(list: SmlObject[]): Map<string, SmlObject> {
  const map = new Map<string, SmlObject>();
  for (const o of list) {
    const n = String(o.raw.unique_name ?? "");
    if (n) map.set(n, o);
  }
  return map;
}

export function analyzeSmlUsage(c: SmlCollection): UsageAnalysis {
  // A dataset's own unique_name is written with a trailing ".dataset" by this project's own
  // converter (e.g. "CUSTOMER_DIM_V.dataset") but not by the vendored reference verticals
  // (plain "dim_room") — normDataset() on BOTH sides of every comparison below is what makes
  // this indifferent to which convention a given SML directory actually uses.
  const datasetsByName = new Map<string, SmlObject>();
  for (const o of c.datasets) {
    const n = normDataset(o.raw.unique_name);
    if (n) datasetsByName.set(n, o);
  }
  const dimensionsByName = byUniqueName(c.dimensions);

  const reachedConnections = new Set<string>();
  const reachedDatasets = new Set<string>();
  const reachedDimensions = new Set<string>();
  // One set for both metrics/ and calculations/ — a model's metrics: list doesn't
  // distinguish the two, it just names a unique_name that happens to live in either folder.
  const reachedMetricNames = new Set<string>();

  function touchDataset(ref: unknown): void {
    const name = normDataset(ref);
    if (!name || reachedDatasets.has(name)) return;
    const ds = datasetsByName.get(name);
    if (!ds) return;
    reachedDatasets.add(name);
    if (ds.raw.connection_id) reachedConnections.add(String(ds.raw.connection_id));
  }

  const dimQueue: string[] = [];
  function touchDimension(ref: unknown): void {
    const name = String((ref as Raw)?.unique_name ?? ref ?? "");
    if (!name || reachedDimensions.has(name) || !dimensionsByName.has(name)) return;
    reachedDimensions.add(name);
    dimQueue.push(name);
  }

  function touchMetric(ref: unknown): void {
    const name = String((ref as Raw)?.unique_name ?? ref ?? "");
    if (name) reachedMetricNames.add(name);
  }

  for (const m of c.models) {
    for (const rel of asArray<Raw>(m.raw.relationships)) {
      touchDataset(rel?.from?.dataset);
      touchDimension(rel?.to?.dimension);
    }
    // Degenerate dimensions attach to the model directly (dimensions:), not via a relationship.
    for (const d of asArray<Raw>(m.raw.dimensions)) touchDimension(d);
    for (const met of asArray<Raw>(m.raw.metrics)) touchMetric(met);
  }

  // A metric/calc's own semi_additive.degenerate_dimensions names a dimension directly, a
  // second path to reachability beyond the model's own dimensions: list. Only meaningful for
  // metrics the model loop above already reached — an unreferenced metric's own internals
  // don't make anything else "used".
  for (const m of [...c.metrics, ...c.calculations]) {
    const name = String(m.raw.unique_name ?? "");
    if (!name || !reachedMetricNames.has(name)) continue;
    for (const dd of asArray<Raw>(m.raw.semi_additive?.degenerate_dimensions)) {
      touchDimension(dd?.name);
    }
  }

  while (dimQueue.length > 0) {
    const dimName = dimQueue.shift()!;
    const dim = dimensionsByName.get(dimName);
    if (!dim) continue;
    for (const la of asArray<Raw>(dim.raw.level_attributes)) {
      touchDataset(la?.dataset);
      for (const sdc of asArray<Raw>(la?.shared_degenerate_columns)) touchDataset(sdc?.dataset);
    }
    for (const h of asArray<Raw>(dim.raw.hierarchies)) {
      for (const lvl of asArray<Raw>(h?.levels)) {
        for (const sa of asArray<Raw>(lvl?.secondary_attributes)) touchDataset(sa?.dataset);
        for (const m of asArray<Raw>(lvl?.metrics)) touchDataset(m?.dataset);
      }
    }
    // Snowflake/embedded joins to another dimension.
    for (const rel of asArray<Raw>(dim.raw.relationships)) {
      touchDataset(rel?.from?.dataset);
      touchDimension(rel?.to?.dimension);
    }
  }

  const isReachedMetric = (o: SmlObject) => reachedMetricNames.has(String(o.raw.unique_name ?? ""));
  const isReachedName = (set: Set<string>) => (o: SmlObject) => set.has(String(o.raw.unique_name ?? ""));

  return {
    unusedConnections: c.connections.filter((o) => !isReachedName(reachedConnections)(o)),
    unusedDatasets: c.datasets.filter((o) => !reachedDatasets.has(normDataset(o.raw.unique_name))),
    unusedDimensions: c.dimensions.filter((o) => !isReachedName(reachedDimensions)(o)),
    unusedMetrics: c.metrics.filter((o) => !isReachedMetric(o)),
    unusedCalculations: c.calculations.filter((o) => !isReachedMetric(o)),
    reachableCounts: {
      connections: reachedConnections.size,
      datasets: reachedDatasets.size,
      dimensions: reachedDimensions.size,
      metrics: c.metrics.filter(isReachedMetric).length,
      calculations: c.calculations.filter(isReachedMetric).length,
    },
  };
}

// ── small Markdown helpers (same conventions as the other SML report generators) ──

function cell(v: unknown): string {
  if (v === undefined || v === null || v === "") return "";
  return String(v).replace(/\|/g, "\\|").replace(/\r?\n/g, " ").trim();
}

function code(v: unknown): string {
  const c = cell(v);
  return c ? `\`${c}\`` : "";
}

function table(headers: string[], rows: string[][]): string[] {
  if (rows.length === 0) return [];
  const sep = headers.map(() => "---");
  return [`| ${headers.join(" | ")} |`, `| ${sep.join(" | ")} |`, ...rows.map((r) => `| ${r.join(" | ")} |`), ""];
}

export interface CleanupReportOptions {
  title?: string;
  /** Whether unused files were actually deleted (true) or this is a preview only (false). */
  applied: boolean;
}

export function buildCleanupReport(analysis: UsageAnalysis, opts: CleanupReportOptions = { applied: false }): string {
  const out: string[] = [];
  const title = opts.title ?? "SML Unused Object Cleanup";
  out.push(`# ${title}`, "");
  out.push(
    opts.applied
      ? "The objects below were **removed** — deleted from disk because none of this SML directory's models reach them, directly or transitively."
      : "The objects below are **structurally unused** — none of this SML directory's models reach them, directly or transitively. This is a preview only; nothing has been deleted. Re-run with `--apply true` to actually remove these files.",
    "",
  );
  out.push(
    "This is a structural check, not a usage audit: it answers whether an object is wired into any model at all, not whether it has actually been queried. It also can't see row_security references or cross-references from an unrecognized object type — review this list before applying it.",
    "",
  );

  const totalUnused =
    analysis.unusedConnections.length +
    analysis.unusedDatasets.length +
    analysis.unusedDimensions.length +
    analysis.unusedMetrics.length +
    analysis.unusedCalculations.length;

  out.push("## Summary", "");
  out.push(
    ...table(
      ["Object", "Reachable", "Unused"],
      [
        ["Connections", String(analysis.reachableCounts.connections), String(analysis.unusedConnections.length)],
        ["Datasets", String(analysis.reachableCounts.datasets), String(analysis.unusedDatasets.length)],
        ["Dimensions", String(analysis.reachableCounts.dimensions), String(analysis.unusedDimensions.length)],
        ["Metrics", String(analysis.reachableCounts.metrics), String(analysis.unusedMetrics.length)],
        ["Calculations", String(analysis.reachableCounts.calculations), String(analysis.unusedCalculations.length)],
      ],
    ),
  );

  if (totalUnused === 0) {
    out.push("_No structurally unused objects found._", "");
    return out.join("\n");
  }

  const sections: Array<{ title: string; objs: SmlObject[] }> = [
    { title: "Unused Connections", objs: analysis.unusedConnections },
    { title: "Unused Datasets", objs: analysis.unusedDatasets },
    { title: "Unused Dimensions", objs: analysis.unusedDimensions },
    { title: "Unused Metrics", objs: analysis.unusedMetrics },
    { title: "Unused Calculations", objs: analysis.unusedCalculations },
  ];
  for (const { title: sectionTitle, objs } of sections) {
    if (objs.length === 0) continue;
    out.push(`## ${sectionTitle}`, "");
    out.push(
      ...table(
        ["Unique name", "Label", "File"],
        objs.map((o) => [code(o.raw.unique_name), cell(o.raw.label), code(o.file)]),
      ),
    );
  }

  out.push("---", "", "_Generated by `atscale-utils clean-unused-sml-objects`._", "");
  return out.join("\n");
}
