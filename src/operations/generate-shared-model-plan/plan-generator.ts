/**
 * plan-generator.ts
 *
 * Synthesises PlanOption objects from similarity analysis, generates Mermaid
 * diagrams, builds RECOMMENDATION.md, and serialises per-option YAML files.
 *
 * Three option kinds:
 *   1. shared-dimension-library  — identical/near-identical dims merged to one
 *   2. dataset-consolidation     — same physical table defined in multiple places
 *   3. base-model-extraction     — two models share a large structural core
 */

import { dump as toYaml } from "js-yaml";
import type { SmlProject, SmlDimension, SmlDataset, SmlColumn, SmlHierarchy, SmlLevel } from "./sml-loader.js";
import type {
  DimPair,
  DatasetPair,
  ModelPair,
  SimilarityAnalysis,
} from "./similarity.js";

// ============================================================
// Plan option types
// ============================================================

export type OptionKind =
  | "shared-dimension-library"
  | "dataset-consolidation"
  | "base-model-extraction";

interface SourceRef {
  project: string;
  dir: string;
  uniqueName: string;
  file: string;
}

export interface MergedHierarchy {
  unique_name: string;
  label: string;
  levels: Array<{ unique_name: string; label?: string }>;
  addedFrom: string[];  // project labels that contributed levels not in primary
}

export interface PlanOption {
  id: string;
  kind: OptionKind;
  title: string;
  description: string;
  score: number;
  sourceRefs: SourceRef[];

  // kind-specific payloads
  sharedDimension?: {
    proposed_unique_name: string;
    proposed_label: string;
    proposed_type: string;
    merged_hierarchies: MergedHierarchy[];
    consumers: Array<{ project: string; dir: string; model: string }>;
  };

  datasetConsolidation?: {
    proposed_unique_name: string;
    proposed_label: string;
    connection_id: string;
    table?: string;
    sql?: string;
    union_columns: SmlColumn[];
    consumers: Array<{ project: string; dir: string; dimension: string }>;
    /** Column presence per source: maps sourceRef uniqueName → Set of column names in that source. */
    source_column_sets: Map<string, Set<string>>;
  };

  baseModelExtraction?: {
    proposed_model_name: string;
    common_dimensions: string[];
    common_metrics: string[];
    source_models: Array<{ project: string; dir: string; model: string; specific_dimensions: string[]; specific_metrics: string[] }>;
  };

  // rendered fields
  mermaidDiagram: string;
  changeList: string[];
  pros: string[];
  cons: string[];
}

// ============================================================
// Expansion helpers
// ============================================================

/** Convert a SmlDimension's hierarchies to the MergedHierarchy representation. */
function dimToMergedHierarchies(dim: SmlDimension): MergedHierarchy[] {
  return dim.hierarchies.map((h) => ({
    unique_name: h.uniqueName,
    label:       h.label ?? h.uniqueName,
    levels:      h.levels.map((l) => ({ unique_name: l.uniqueName, label: l.label })),
    addedFrom:   [],
  }));
}

/** Fold `dim` into an existing MergedHierarchy[], returning the expanded union. */
function mergeInto(base: MergedHierarchy[], dim: SmlDimension): MergedHierarchy[] {
  const hierMap = new Map<string, MergedHierarchy>();
  for (const h of base) hierMap.set(h.unique_name, { ...h, levels: [...h.levels] });

  for (const h of dim.hierarchies) {
    const key = h.uniqueName;
    if (hierMap.has(key)) {
      const existing        = hierMap.get(key)!;
      const existingNames   = new Set(existing.levels.map((l) => l.unique_name));
      const added: string[] = [];
      for (const lv of h.levels) {
        if (!existingNames.has(lv.uniqueName)) {
          existing.levels.push({ unique_name: lv.uniqueName, label: lv.label });
          existingNames.add(lv.uniqueName);
          added.push(lv.uniqueName);
        }
      }
      if (added.length > 0) {
        existing.addedFrom.push(`${dim.label ?? dim.uniqueName} (levels: ${added.join(", ")})`);
      }
    } else {
      hierMap.set(key, {
        unique_name: h.uniqueName,
        label:       h.label ?? h.uniqueName,
        levels:      h.levels.map((l) => ({ unique_name: l.uniqueName, label: l.label })),
        addedFrom:   [dim.label ?? dim.uniqueName],
      });
    }
  }
  return [...hierMap.values()];
}

/** Merge all dimensions in `dims` into a single MergedHierarchy[]. */
function mergeAllDimensions(dims: SmlDimension[]): MergedHierarchy[] {
  if (dims.length === 0) return [];
  let merged = dimToMergedHierarchies(dims[0]);
  for (let i = 1; i < dims.length; i++) merged = mergeInto(merged, dims[i]);
  return merged;
}

/** @deprecated use mergeAllDimensions — kept for callers that pass exactly two dims */
function mergeDimensions(a: SmlDimension, b: SmlDimension): MergedHierarchy[] {
  return mergeAllDimensions([a, b]);
}

/** Return the union of two column lists, deduplicated by name (a wins on conflict). */
function mergeColumns(a: SmlColumn[], b: SmlColumn[]): SmlColumn[] {
  const map = new Map<string, SmlColumn>();
  for (const c of a) map.set(c.name.toLowerCase(), c);
  for (const c of b) {
    const k = c.name.toLowerCase();
    if (!map.has(k)) map.set(k, c);
  }
  return [...map.values()];
}

// ============================================================
// Mermaid diagram builders
// ============================================================

/** Sanitise a string to a valid Mermaid node id. */
function mid(s: string): string {
  return s.replace(/[^a-zA-Z0-9]/g, "_").replace(/_{2,}/g, "_").replace(/^_|_$/g, "");
}

function buildDimLibraryDiagram(opt: PlanOption): string {
  const sharedId = mid(`shared_${opt.sharedDimension!.proposed_unique_name}`);
  const lines: string[] = ["```mermaid", "graph LR"];

  // Current state (left side)
  lines.push("  subgraph current[\"Current State\"]");
  for (const ref of opt.sourceRefs) {
    const mId = mid(`${ref.project}_${ref.uniqueName}`);
    lines.push(`    ${mId}["${ref.uniqueName} (${ref.project})"]`);
  }
  lines.push("  end");

  // Proposed state (right side)
  lines.push("  subgraph proposed[\"Proposed State\"]");
  lines.push(`    ${sharedId}["${opt.sharedDimension!.proposed_label} (shared)"]`);
  for (const c of opt.sharedDimension!.consumers) {
    const mId = mid(`${c.project}_${c.model}_new`);
    lines.push(`    ${mId}["${c.model} (${c.project})"]`);
    lines.push(`    ${mId} --> ${sharedId}`);
  }
  lines.push("  end");

  lines.push(`  style ${sharedId} fill:#c8f0c8,stroke:#2d7a2d`);
  lines.push("```");
  return lines.join("\n");
}

function buildDatasetConsolidationDiagram(opt: PlanOption): string {
  const sharedId = mid(`shared_${opt.datasetConsolidation!.proposed_unique_name}`);
  const lines: string[] = ["```mermaid", "graph LR"];

  lines.push("  subgraph current[\"Current State\"]");
  for (const ref of opt.sourceRefs) {
    const id = mid(`${ref.project}_${ref.uniqueName}`);
    lines.push(`    ${id}["${ref.uniqueName} (${ref.project})"]`);
  }
  lines.push("  end");

  lines.push("  subgraph proposed[\"Proposed State\"]");
  lines.push(`    ${sharedId}["${opt.datasetConsolidation!.proposed_label} (shared)"]`);
  for (const c of opt.datasetConsolidation!.consumers) {
    const id = mid(`${c.project}_${c.dimension}_new`);
    lines.push(`    ${id}["${c.dimension} (${c.project})"]`);
    lines.push(`    ${id} --> ${sharedId}`);
  }
  lines.push("  end");

  lines.push(`  style ${sharedId} fill:#c8f0c8,stroke:#2d7a2d`);
  lines.push("```");
  return lines.join("\n");
}

function buildBaseModelDiagram(opt: PlanOption): string {
  const bm     = opt.baseModelExtraction!;
  const baseId = mid(`base_${bm.proposed_model_name}`);
  const lines: string[] = ["```mermaid", "graph TD"];

  lines.push(`  ${baseId}["Base Model: ${bm.proposed_model_name} | ${bm.common_dimensions.length} shared dims, ${bm.common_metrics.length} shared metrics"]`);

  for (const s of bm.source_models) {
    const id = mid(`${s.project}_${s.model}`);
    lines.push(`  ${id}["${s.model} (${s.project}) +${s.specific_dimensions.length} specific dims"]`);
    lines.push(`  ${id} -->|extends| ${baseId}`);
  }

  lines.push(`  style ${baseId} fill:#c8f0c8,stroke:#2d7a2d`);
  lines.push("```");
  return lines.join("\n");
}

// ============================================================
// Pros/cons templates
// ============================================================

function dimLibraryProscons(opt: PlanOption): { pros: string[]; cons: string[] } {
  const dim = opt.sharedDimension!;
  const nConsumers = dim.consumers.length;
  const nExpanded = dim.merged_hierarchies.filter((h) => h.addedFrom.length > 0).length;
  return {
    pros: [
      `Single source of truth for "${dim.proposed_label}" across ${nConsumers} model(s)`,
      "Dimension changes only need to be made once, propagating automatically to all consumers",
      "Eliminates drift between near-identical dimension copies over time",
      `Score ${(opt.score * 100).toFixed(0)}% structural overlap — high confidence the dimensions are semantically equivalent`,
    ],
    cons: [
      "Introduces a dependency between previously independent model packages",
      nExpanded > 0
        ? `${nExpanded} hierarch${nExpanded === 1 ? "y" : "ies"} expanded to satisfy all consumers — the shared dim is broader than any single model needs`
        : "Shared location must be accessible to all consuming model packages",
      "Initial migration effort required to move and redirect references",
      "Future changes to the shared dimension affect all consumers simultaneously",
    ],
  };
}

function datasetConsolidationProscons(opt: PlanOption): { pros: string[]; cons: string[] } {
  const ds = opt.datasetConsolidation!;
  return {
    pros: [
      `Eliminates ${opt.sourceRefs.length} duplicate definitions of the same physical table ("${ds.proposed_label}")`,
      "Schema changes (add column, rename) need only one update",
      `Merged column list has ${ds.union_columns.length} columns — all consumers retain full column access`,
    ],
    cons: [
      "Shared dataset must reside in a location accessible to all referencing model packages",
      "Connection_id must be identical or aliased across all consumers",
      "If one model needs a subset of columns for performance, the shared definition includes all",
    ],
  };
}

function baseModelProscons(opt: PlanOption): { pros: string[]; cons: string[] } {
  const bm = opt.baseModelExtraction!;
  return {
    pros: [
      `${bm.common_dimensions.length} dimensions and ${bm.common_metrics.length} metrics defined once in the base`,
      "Specialised models remain lean — only their unique dimensions and metrics are defined locally",
      "Consistent dimension handling across all models that extend the base",
    ],
    cons: [
      "Adds a new abstraction layer; developers must understand the inheritance structure",
      `Model score was ${(opt.score * 100).toFixed(0)}% — the remaining ${100 - Math.round(opt.score * 100)}% divergence may indicate materially different business domains`,
      "AtScale SML does not natively support model inheritance; the 'base model' would need to be implemented as a shared dimension/metric set, not a true parent model",
      "Refactoring both source models in lock-step increases release coordination overhead",
    ],
  };
}

// ============================================================
// Change list builders
// ============================================================

function dimLibraryChanges(opt: PlanOption): string[] {
  const dim = opt.sharedDimension!;
  const sharedPath = `shared/dimensions/${dim.proposed_unique_name.toLowerCase().replace(/[^a-z0-9]/g, "-")}.yml`;
  const changes: string[] = [
    `Create \`${sharedPath}\` — merged dimension with ${dim.merged_hierarchies.length} hierarch${dim.merged_hierarchies.length === 1 ? "y" : "ies"}`,
  ];
  const expanded = dim.merged_hierarchies.filter((h) => h.addedFrom.length > 0);
  if (expanded.length > 0) {
    changes.push(`Expand ${expanded.map((h) => `"${h.unique_name}"`).join(", ")} to include all levels from both sources`);
  }
  for (const ref of opt.sourceRefs) {
    const localPath = ref.file.replace(ref.dir, ".");
    changes.push(`Remove \`${localPath}\` from ${ref.project} and redirect references to the shared path`);
  }
  for (const c of dim.consumers) {
    changes.push(`Update model \`${c.model}\` in ${c.project} to reference \`${sharedPath}\``);
  }
  return changes;
}

function datasetConsolidationChanges(opt: PlanOption): string[] {
  const ds = opt.datasetConsolidation!;
  const sharedPath = `shared/datasets/${ds.proposed_unique_name.toLowerCase().replace(/[^a-z0-9]/g, "-")}.yml`;
  const changes: string[] = [
    `Create \`${sharedPath}\` with the union of ${ds.union_columns.length} columns`,
  ];
  for (const ref of opt.sourceRefs) {
    const localPath = ref.file.replace(ref.dir, ".");
    changes.push(`Remove \`${localPath}\` from ${ref.project}`);
  }
  for (const c of opt.datasetConsolidation!.consumers) {
    changes.push(`Update dimension \`${c.dimension}\` in ${c.project} to reference \`${sharedPath}\``);
  }
  return changes;
}

function baseModelChanges(opt: PlanOption): string[] {
  const bm = opt.baseModelExtraction!;
  const basePath = `shared/models/${bm.proposed_model_name.toLowerCase().replace(/[^a-z0-9]/g, "-")}.yml`;
  const changes: string[] = [
    `Create \`${basePath}\` — base model containing ${bm.common_dimensions.length} shared dimension(s) and ${bm.common_metrics.length} shared metric(s)`,
  ];
  for (const sm of bm.source_models) {
    changes.push(
      `Refactor \`${sm.model}\` in ${sm.project}: remove the ${bm.common_dimensions.length} shared dimension(s) and reference the base model; retain ${sm.specific_dimensions.length} specific dimension(s)`,
    );
  }
  return changes;
}

// ============================================================
// Option builders
// ============================================================

/**
 * Union-Find helpers (path-compression, union-by-key).
 * Used to build connected components from pairwise similarity edges.
 */
function makeUnionFind() {
  const parent = new Map<string, string>();
  function root(k: string): string {
    if (!parent.has(k)) parent.set(k, k);
    if (parent.get(k) !== k) parent.set(k, root(parent.get(k)!));
    return parent.get(k)!;
  }
  function union(a: string, b: string): void {
    const ra = root(a), rb = root(b);
    if (ra !== rb) parent.set(rb, ra);
  }
  function groups(): Map<string, string[]> {
    const g = new Map<string, string[]>();
    for (const k of parent.keys()) {
      const r = root(k);
      const arr = g.get(r) ?? [];
      arr.push(k);
      g.set(r, arr);
    }
    return g;
  }
  return { root, union, groups };
}

export function buildDimLibraryOptions(
  pairs: DimPair[],
  projects: SmlProject[],
  threshold: number,
): PlanOption[] {
  // ── Build connected components from qualifying pairs ─────────────────────
  // Each node is a "dir::uniqueName" key. An edge exists for every pair whose
  // score ≥ threshold.  One component → one merged option (not one per pair).
  const uf       = makeUnionFind();
  const nodeInfo = new Map<string, { project: string; dir: string; dim: SmlDimension }>();
  const edgeScores = new Map<string, number>();   // sorted-pair-key → score

  for (const pair of pairs) {
    if (pair.score < threshold) continue;
    const kA = `${pair.dirA}::${pair.dim.uniqueName}`;
    const kB = `${pair.dirB}::${pair.otherDim.uniqueName}`;
    nodeInfo.set(kA, { project: pair.projectA, dir: pair.dirA, dim: pair.dim });
    nodeInfo.set(kB, { project: pair.projectB, dir: pair.dirB, dim: pair.otherDim });
    uf.union(kA, kB);
    const ek = [kA, kB].sort().join("|");
    // keep the min score for the edge (conservative bound for the group)
    edgeScores.set(ek, Math.min(edgeScores.get(ek) ?? 1, pair.score));
  }

  const options: PlanOption[] = [];

  for (const [, keys] of uf.groups()) {
    if (keys.length < 2) continue;

    const members = keys.map((k) => nodeInfo.get(k)!);

    // Score = minimum pairwise score within the component (weakest link)
    const groupScore = Math.min(
      ...keys.flatMap((kA, i) =>
        keys.slice(i + 1).map((kB) => {
          const ek = [kA, kB].sort().join("|");
          return edgeScores.get(ek) ?? threshold;   // missing edge = threshold
        }),
      ),
    );

    // Proposed name: most-frequent unique_name across members
    const nameFreq = new Map<string, number>();
    for (const m of members) nameFreq.set(m.dim.uniqueName, (nameFreq.get(m.dim.uniqueName) ?? 0) + 1);
    const proposedName  = [...nameFreq.entries()].sort((a, b) => b[1] - a[1])[0][0];
    const allSameName   = [...nameFreq.keys()].every((n) => n === proposedName);
    const proposedLabel = allSameName ? proposedName : `${proposedName} (shared)`;

    const mergedHierarchies = mergeAllDimensions(members.map((m) => m.dim));

    // Consumers: every model that references any member dimension
    const memberDimNames = new Set(members.map((m) => m.dim.uniqueName));
    const consumers: Array<{ project: string; dir: string; model: string }> = [];
    for (const proj of projects) {
      for (const [, model] of proj.models) {
        if ([...memberDimNames].some((n) => model.dimensionNames.has(n))) {
          if (!consumers.some((c) => c.dir === proj.dir && c.model === model.uniqueName)) {
            consumers.push({ project: proj.label, dir: proj.dir, model: model.uniqueName });
          }
        }
      }
    }

    const sourceRefs: SourceRef[] = members.map((m) => ({
      project:    m.project,
      dir:        m.dir,
      uniqueName: m.dim.uniqueName,
      file:       m.dim.sourceFile,
    }));

    const copyCount  = members.length;
    const projectLabels = [...new Set(members.map((m) => m.project))].join(", ");
    const hierWord   = mergedHierarchies.length === 1 ? "hierarchy" : "hierarchies";

    const option: PlanOption = {
      id:    "",
      kind:  "shared-dimension-library",
      title: copyCount > 2
        ? `Share Dimension "${proposedLabel}" (${copyCount} copies)`
        : `Share Dimension "${proposedLabel}"`,
      description: copyCount > 2
        ? `Dimension "${proposedLabel}" exists in ${copyCount} projects (${projectLabels}). ` +
          `Merge into a single shared definition with ${mergedHierarchies.length} ${hierWord}.`
        : `Dimensions "${members[0].dim.uniqueName}" (${members[0].project}) and ` +
          `"${members[1].dim.uniqueName}" (${members[1].project}) are ` +
          `${Math.round(groupScore * 100)}% structurally similar. ` +
          `Merge into a single shared definition with ${mergedHierarchies.length} ${hierWord}.`,
      score: groupScore,
      sourceRefs,
      sharedDimension: {
        proposed_unique_name: proposedName,
        proposed_label:       proposedLabel,
        proposed_type:        members[0].dim.type,
        merged_hierarchies:   mergedHierarchies,
        consumers,
      },
      mermaidDiagram: "",
      changeList:     [],
      pros:           [],
      cons:           [],
    };

    option.mermaidDiagram = buildDimLibraryDiagram(option);
    option.changeList     = dimLibraryChanges(option);
    const pc = dimLibraryProscons(option);
    option.pros = pc.pros;
    option.cons = pc.cons;
    options.push(option);
  }

  // Sort descending by score so the cap keeps the most confident groups
  options.sort((a, b) => b.score - a.score);
  return options;
}

export function buildDatasetConsolidationOptions(
  pairs: DatasetPair[],
  projects: SmlProject[],
  threshold: number,
): PlanOption[] {
  const options: PlanOption[] = [];

  // ── Pass 1: group every dataset by its physical tableRef across all projects ──
  // One option per unique physical table that appears in 2+ projects.
  // This replaces the O(n²) pair-based approach and avoids emitting one option
  // per (projectA, projectB) combination for the same physical table.
  const tableGroups = new Map<string, Array<{ proj: SmlProject; dataset: SmlDataset }>>();
  for (const proj of projects) {
    for (const [, ds] of proj.datasets) {
      if (!ds.tableRef) continue;  // skip datasets with no physical binding
      const arr = tableGroups.get(ds.tableRef) ?? [];
      arr.push({ proj, dataset: ds });
      tableGroups.set(ds.tableRef, arr);
    }
  }

  // Track which datasets are covered so pass 2 skips them
  const coveredDatasets = new Set<string>();  // "dir::uniqueName"

  for (const [, entries] of tableGroups) {
    if (entries.length < 2) continue;

    let unionCols: SmlColumn[] = [];
    const sourceColSets = new Map<string, Set<string>>();
    for (const { dataset } of entries) {
      unionCols = mergeColumns(unionCols, dataset.columns);
      sourceColSets.set(dataset.uniqueName, new Set(dataset.columns.map((c) => c.name.toLowerCase())));
    }

    const firstDs = entries[0].dataset;
    const allLabels = [...new Set(entries.map((e) => e.dataset.label))];
    const proposedLabel = allLabels.length === 1 ? allLabels[0] : `${allLabels[0]}_consolidated`;

    const sourceRefs: SourceRef[] = entries.map((e) => ({
      project: e.proj.label,
      dir: e.proj.dir,
      uniqueName: e.dataset.uniqueName,
      file: e.dataset.sourceFile,
    }));

    const consumers: Array<{ project: string; dir: string; dimension: string }> = [];
    for (const { proj, dataset } of entries) {
      const refName = dataset.uniqueName.replace(/\.dataset$/, "");
      for (const [, dim] of proj.dimensions) {
        if (dim.backingDatasets.has(refName)) {
          if (!consumers.some((c) => c.dir === proj.dir && c.dimension === dim.uniqueName)) {
            consumers.push({ project: proj.label, dir: proj.dir, dimension: dim.uniqueName });
          }
        }
      }
    }

    for (const { proj, dataset } of entries) {
      coveredDatasets.add(`${proj.dir}::${dataset.uniqueName}`);
    }

    const option: PlanOption = {
      id: "",
      kind: "dataset-consolidation",
      title: `Consolidate Dataset "${proposedLabel}" (${entries.length} copies)`,
      description:
        `Dataset "${proposedLabel}" is defined identically in ${entries.length} project(s): ` +
        `${entries.map((e) => e.proj.label).join(", ")}. ` +
        `Consolidate to a single shared definition with ${unionCols.length} column(s).`,
      score: 1.0,
      sourceRefs,
      datasetConsolidation: {
        proposed_unique_name: proposedLabel,
        proposed_label: proposedLabel,
        connection_id: firstDs.connectionId,
        table: firstDs.table,
        sql: firstDs.sql,
        union_columns: unionCols,
        consumers,
        source_column_sets: sourceColSets,
      },
      mermaidDiagram: "",
      changeList: [],
      pros: [],
      cons: [],
    };
    option.mermaidDiagram = buildDatasetConsolidationDiagram(option);
    option.changeList = datasetConsolidationChanges(option);
    const pc = datasetConsolidationProscons(option);
    option.pros = pc.pros;
    option.cons = pc.cons;
    options.push(option);
  }

  // Sort pass-1 options by number of copies (most impactful first)
  options.sort((a, b) => b.sourceRefs.length - a.sourceRefs.length);

  // ── Pass 2: high-similarity non-identical pairs not covered by pass 1 ────
  // Deduplicate by canonical label pair, keeping the highest-scoring match.
  const pairSeen = new Map<string, DatasetPair>();
  for (const pair of pairs) {
    if (pair.isIdentical) continue;
    if (pair.score < threshold) continue;
    if (coveredDatasets.has(`${pair.dirA}::${pair.dataset.uniqueName}`)) continue;
    if (coveredDatasets.has(`${pair.dirB}::${pair.otherDataset.uniqueName}`)) continue;
    const key = [pair.dataset.label, pair.otherDataset.label].sort().join("|");
    const existing = pairSeen.get(key);
    if (!existing || pair.score > existing.score) pairSeen.set(key, pair);
  }

  for (const pair of pairSeen.values()) {
    const unionColumns = mergeColumns(pair.dataset.columns, pair.otherDataset.columns);
    const proposedName = pair.dataset.label === pair.otherDataset.label
      ? pair.dataset.label
      : `${pair.dataset.label}_consolidated`;

    const sourceRefs: SourceRef[] = [
      { project: pair.projectA, dir: pair.dirA, uniqueName: pair.dataset.uniqueName, file: pair.dataset.sourceFile },
      { project: pair.projectB, dir: pair.dirB, uniqueName: pair.otherDataset.uniqueName, file: pair.otherDataset.sourceFile },
    ];

    const consumers: Array<{ project: string; dir: string; dimension: string }> = [];
    for (const proj of projects) {
      for (const [, dim] of proj.dimensions) {
        const refA = pair.dataset.uniqueName.replace(/\.dataset$/, "");
        const refB = pair.otherDataset.uniqueName.replace(/\.dataset$/, "");
        if (dim.backingDatasets.has(refA) || dim.backingDatasets.has(refB)) {
          if (!consumers.some((c) => c.dir === proj.dir && c.dimension === dim.uniqueName)) {
            consumers.push({ project: proj.label, dir: proj.dir, dimension: dim.uniqueName });
          }
        }
      }
    }

    const pairColSets = new Map<string, Set<string>>([
      [pair.dataset.uniqueName,      new Set(pair.dataset.columns.map((c) => c.name.toLowerCase()))],
      [pair.otherDataset.uniqueName, new Set(pair.otherDataset.columns.map((c) => c.name.toLowerCase()))],
    ]);

    const option: PlanOption = {
      id: "",
      kind: "dataset-consolidation",
      title: `Consolidate Dataset "${proposedName}"`,
      description:
        `Datasets "${pair.dataset.uniqueName}" (${pair.projectA}) and ` +
        `"${pair.otherDataset.uniqueName}" (${pair.projectB}) share ` +
        `${Math.round(pair.score * 100)}% of their columns. ` +
        `Consolidate to a single shared definition with ${unionColumns.length} column(s).`,
      score: pair.score,
      sourceRefs,
      datasetConsolidation: {
        proposed_unique_name: proposedName,
        proposed_label: proposedName,
        connection_id: pair.dataset.connectionId,
        table: pair.dataset.table ?? pair.otherDataset.table,
        sql: pair.dataset.sql ?? pair.otherDataset.sql,
        union_columns: unionColumns,
        consumers,
        source_column_sets: pairColSets,
      },
      mermaidDiagram: "",
      changeList: [],
      pros: [],
      cons: [],
    };
    option.mermaidDiagram = buildDatasetConsolidationDiagram(option);
    option.changeList = datasetConsolidationChanges(option);
    const pc = datasetConsolidationProscons(option);
    option.pros = pc.pros;
    option.cons = pc.cons;
    options.push(option);
  }

  return options;
}

export function buildBaseModelOptions(
  pairs: ModelPair[],
  projects: SmlProject[],
  threshold: number,
): PlanOption[] {
  const options: PlanOption[] = [];
  const seen = new Set<string>();

  for (const pair of pairs) {
    if (pair.overallScore < threshold) continue;
    if (pair.commonDimensions.length < 2) continue;  // not worth extracting for trivial overlap

    const key = [
      `${pair.dirA}::${pair.model.uniqueName}`,
      `${pair.dirB}::${pair.otherModel.uniqueName}`,
    ].sort().join("|");
    if (seen.has(key)) continue;
    seen.add(key);

    const proposedName = `Base_${pair.model.label.replace(/[^a-zA-Z0-9]/g, "_")}_${pair.otherModel.label.replace(/[^a-zA-Z0-9]/g, "_")}`;

    const sourceRefs: SourceRef[] = [
      { project: pair.projectA, dir: pair.dirA, uniqueName: pair.model.uniqueName, file: pair.model.sourceFile },
      { project: pair.projectB, dir: pair.dirB, uniqueName: pair.otherModel.uniqueName, file: pair.otherModel.sourceFile },
    ];

    const option: PlanOption = {
      id: "",
      kind: "base-model-extraction",
      title: `Extract Base Model from "${pair.model.label}" and "${pair.otherModel.label}"`,
      description:
        `Models "${pair.model.uniqueName}" (${pair.projectA}) and ` +
        `"${pair.otherModel.uniqueName}" (${pair.projectB}) are ${Math.round(pair.overallScore * 100)}% ` +
        `similar, sharing ${pair.commonDimensions.length} dimension(s) and ` +
        `${pair.commonMetrics.length} metric(s). Extract the common core into a reusable base model.`,
      score: pair.overallScore,
      sourceRefs,
      baseModelExtraction: {
        proposed_model_name: proposedName,
        common_dimensions: pair.commonDimensions,
        common_metrics: pair.commonMetrics,
        source_models: [
          {
            project: pair.projectA,
            dir: pair.dirA,
            model: pair.model.uniqueName,
            specific_dimensions: pair.onlyInA,
            specific_metrics: pair.model.metricRefs.filter((m) => !pair.commonMetrics.includes(m)),
          },
          {
            project: pair.projectB,
            dir: pair.dirB,
            model: pair.otherModel.uniqueName,
            specific_dimensions: pair.onlyInB,
            specific_metrics: pair.otherModel.metricRefs.filter((m) => !pair.commonMetrics.includes(m)),
          },
        ],
      },
      mermaidDiagram: "",
      changeList: [],
      pros: [],
      cons: [],
    };

    option.mermaidDiagram = buildBaseModelDiagram(option);
    option.changeList = baseModelChanges(option);
    const pc = baseModelProscons(option);
    option.pros = pc.pros;
    option.cons = pc.cons;

    options.push(option);
  }

  return options;
}

// ============================================================
// Assign option IDs and combine
// ============================================================

/** Maximum options emitted per kind. Keeps the output tractable for large codebases. */
const MAX_PER_KIND: Record<OptionKind, number> = {
  "dataset-consolidation":    10,
  "shared-dimension-library": 20,
  "base-model-extraction":     5,
};

/**
 * Remove any option whose source-reference set is a strict subset of another
 * option's source-reference set.  The superset option already covers every
 * file the subset would touch, so applying both would be redundant.
 *
 * Identity key per reference: "<dir>::<uniqueName>".
 */
function pruneContainedOptions(options: PlanOption[]): PlanOption[] {
  const sets = options.map((o) =>
    new Set(o.sourceRefs.map((r) => `${r.dir}::${r.uniqueName}`)),
  );

  return options.filter((_, i) => {
    const si = sets[i];
    // Keep this option unless some other option j has a strictly larger set that
    // contains every element of si.
    return !options.some((_, j) => {
      if (i === j) return false;
      const sj = sets[j];
      return sj.size > si.size && [...si].every((k) => sj.has(k));
    });
  });
}

/**
 * For each subject entity (a physical dataset, a logical dimension group, or a
 * model pair), keep at most `maxPerSubject` options by score.  This prevents the
 * output from being flooded with near-duplicate recommendations for the same
 * entity while still allowing different-kind options for distinct entities to
 * surface.
 *
 * Subject key derivation (stable across kind):
 *   dataset-consolidation    → "ds:" + normalized proposed_unique_name
 *   shared-dimension-library → "dim:" + normalized proposed_unique_name
 *   base-model-extraction    → "model:" + sorted source unique-names joined
 */
function pruneToTopNPerSubject(options: PlanOption[], maxPerSubject: number): PlanOption[] {
  if (maxPerSubject <= 0) return options;

  function subjectKey(opt: PlanOption): string {
    const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, "_").replace(/_+/g, "_");
    switch (opt.kind) {
      case "dataset-consolidation":
        return "ds:" + norm(opt.datasetConsolidation!.proposed_unique_name);
      case "shared-dimension-library":
        return "dim:" + norm(opt.sharedDimension!.proposed_unique_name);
      case "base-model-extraction":
        return "model:" + opt.sourceRefs.map((r) => norm(r.uniqueName)).sort().join("|");
    }
  }

  const countBySubject = new Map<string, number>();
  const kept: PlanOption[] = [];

  for (const opt of options) {
    const key = subjectKey(opt);
    const count = countBySubject.get(key) ?? 0;
    if (count < maxPerSubject) {
      kept.push(opt);
      countBySubject.set(key, count + 1);
    }
  }
  return kept;
}

export function buildAllOptions(
  analysis: SimilarityAnalysis,
  projects: SmlProject[],
  threshold: number,
  maxPerSubject = 3,
): PlanOption[] {
  // Build each kind independently so the per-kind cap applies before combining.
  const dsOptions  = buildDatasetConsolidationOptions(analysis.datasetPairs, projects, threshold)
    .slice(0, MAX_PER_KIND["dataset-consolidation"]);
  const dimOptions = buildDimLibraryOptions(analysis.dimPairs, projects, threshold)
    .slice(0, MAX_PER_KIND["shared-dimension-library"]);
  const bmOptions  = buildBaseModelOptions(analysis.modelPairs, projects, threshold)
    .slice(0, MAX_PER_KIND["base-model-extraction"]);

  // Sort by kind priority first (base-model-extraction is the most impactful refactoring,
  // shared-dimension-library is a logical-level fix, dataset-consolidation is the most
  // granular), then by score descending within each kind.
  const kindOrder: Record<OptionKind, number> = {
    "base-model-extraction":     0,
    "shared-dimension-library":  1,
    "dataset-consolidation":     2,
  };
  const combined = [...bmOptions, ...dimOptions, ...dsOptions];
  combined.sort((a, b) => {
    const ko = kindOrder[a.kind] - kindOrder[b.kind];
    return ko !== 0 ? ko : b.score - a.score;
  });

  // Remove options whose source set is entirely covered by another option.
  const afterContainment = pruneContainedOptions(combined);

  // For each subject entity keep at most maxPerSubject options (already sorted by
  // score descending, so we naturally keep the highest-scoring ones first).
  const options = pruneToTopNPerSubject(afterContainment, maxPerSubject);

  options.forEach((o, i) => { o.id = `option-${i + 1}`; });
  return options;
}

// ============================================================
// Column coverage table
// ============================================================

/**
 * Builds a markdown table showing which columns each source dataset/dimension has.
 * Rows = all columns in the union, columns = each source (by uniqueName), cells = ✓ or blank.
 */
function buildColumnCoverageTable(opt: PlanOption): string[] {
  const ds      = opt.datasetConsolidation!;
  const sources = opt.sourceRefs;
  const colSets = ds.source_column_sets;
  const n       = sources.length;

  // Partition columns into those present in every source (identical) vs. those
  // that differ (missing from at least one source).
  const diffCols: Array<{ name: string; cells: string[] }> = [];
  let identicalCount = 0;

  for (const col of ds.union_columns) {
    const key   = col.name.toLowerCase();
    const cells = sources.map((r) => (colSets.get(r.uniqueName)?.has(key) ? "✓" : ""));
    if (cells.every((c) => c === "✓")) {
      identicalCount++;
    } else {
      diffCols.push({ name: col.name, cells });
    }
  }

  // All columns are identical across every source — no table needed.
  if (diffCols.length === 0) {
    return [`All ${n} source(s) share the same ${identicalCount} column(s) — no column-level differences.`];
  }

  const lines: string[] = [];

  if (identicalCount > 0) {
    lines.push(
      `${identicalCount} column(s) are identical across all sources and are omitted. ` +
      `The table shows only the ${diffCols.length} column(s) that differ.`,
      "",
    );
  }

  lines.push(`| Column | ${sources.map((r) => r.uniqueName).join(" | ")} |`);
  lines.push(`|--------|${sources.map(() => "--------").join("|")}|`);
  for (const { name, cells } of diffCols) {
    lines.push(`| \`${name}\` | ${cells.join(" | ")} |`);
  }
  return lines;
}

// ============================================================
// RECOMMENDATION.md renderer
// ============================================================

export function renderRecommendationMarkdown(
  options: PlanOption[],
  projects: SmlProject[],
  threshold: number,
  inputDirs: string[],
): string {
  const date = new Date().toISOString().split("T")[0];
  const lines: string[] = [];

  lines.push("# Shared Model Plan", "");
  lines.push(`**Generated:** ${date}  `);
  lines.push(`**Threshold:** ${threshold}  `);
  lines.push(`**Input directories:** ${inputDirs.join(", ")}  `);
  lines.push(`**Projects analysed:** ${projects.map((p) => p.label).join(", ")}`, "");

  // Summary table
  lines.push("## Summary", "");
  lines.push("| Project | Models | Dimensions | Datasets | Metrics |");
  lines.push("|---------|--------|------------|----------|---------|");
  for (const p of projects) {
    lines.push(
      `| **${p.label}** | ${p.models.size} | ${p.dimensions.size} | ${p.datasets.size} | ${p.metrics.size} |`,
    );
  }
  lines.push("");

  if (options.length === 0) {
    lines.push(
      `> No sharing opportunities found above threshold ${threshold}. ` +
      `Try lowering \`--threshold\` to surface partial matches.`,
    );
    return lines.join("\n");
  }

  const byKind: Record<OptionKind, number> = {
    "shared-dimension-library": options.filter((o) => o.kind === "shared-dimension-library").length,
    "dataset-consolidation":    options.filter((o) => o.kind === "dataset-consolidation").length,
    "base-model-extraction":    options.filter((o) => o.kind === "base-model-extraction").length,
  };

  lines.push(
    `Found **${options.length}** refactoring option(s): ` +
    `${byKind["dataset-consolidation"]} dataset consolidation, ` +
    `${byKind["shared-dimension-library"]} shared dimension librar${byKind["shared-dimension-library"] === 1 ? "y" : "ies"}, ` +
    `${byKind["base-model-extraction"]} base model extraction.`,
    "",
  );

  // TOC
  // Anchors are derived from heading text using the GitHub Markdown algorithm:
  // lowercase → strip non-word chars (keep spaces/hyphens) → spaces to hyphens.
  function headingAnchor(text: string): string {
    return text
      .toLowerCase()
      .replace(/[^a-z0-9\s-]/g, "")
      .trim()
      .replace(/\s+/g, "-")
      .replace(/-+/g, "-");
  }

  lines.push("## Table of Contents", "");
  for (const opt of options) {
    const headingText = `${opt.id}: ${opt.title}`;
    lines.push(`- [${headingText}](#${headingAnchor(headingText)})`);
  }
  lines.push("", "---", "");

  // Per-option sections
  for (const opt of options) {
    lines.push(`## ${opt.id}: ${opt.title}`, "");
    lines.push(`**Kind:** \`${opt.kind}\`  `);
    lines.push(`**Similarity Score:** ${(opt.score * 100).toFixed(0)}%  `);
    lines.push(`**Affected projects:** ${opt.sourceRefs.map((r) => r.project).join(", ")}`, "");
    lines.push(opt.description, "");

    lines.push("### Schema Diagram", "");
    lines.push(opt.mermaidDiagram, "");

    lines.push("### Changes Required", "");
    for (const c of opt.changeList) lines.push(`- ${c}`);
    lines.push("");

    if (opt.kind === "dataset-consolidation" && opt.datasetConsolidation) {
      lines.push("### Column Coverage", "");
      lines.push(
        "Rows are all columns in the proposed union; ✓ indicates the source has that column.",
        "",
      );
      lines.push(...buildColumnCoverageTable(opt), "");
    }

    lines.push("### Pros", "");
    for (const p of opt.pros) lines.push(`- ${p}`);
    lines.push("");

    lines.push("### Cons", "");
    for (const c of opt.cons) lines.push(`- ${c}`);
    lines.push("");

    lines.push("---", "");
  }

  return lines.join("\n");
}

// ============================================================
// Option YAML serialiser
// ============================================================

export function renderOptionYaml(opt: PlanOption, threshold: number): string {
  // Strip Mermaid and rendered prose — keep machine-readable fields only
  const payload: Record<string, unknown> = {
    schema_version: "1",
    option_id: opt.id,
    kind: opt.kind,
    title: opt.title,
    description: opt.description,
    similarity_score: parseFloat((opt.score).toFixed(4)),
    threshold_used: threshold,
    source_references: opt.sourceRefs.map((r) => ({
      project: r.project,
      directory: r.dir,
      unique_name: r.uniqueName,
      source_file: r.file,
    })),
  };

  if (opt.sharedDimension) {
    payload.shared_dimension = {
      proposed_unique_name: opt.sharedDimension.proposed_unique_name,
      proposed_label: opt.sharedDimension.proposed_label,
      proposed_type: opt.sharedDimension.proposed_type,
      output_path: `shared/dimensions/${opt.sharedDimension.proposed_unique_name.toLowerCase().replace(/[^a-z0-9]/g, "-")}.yml`,
      merged_hierarchies: opt.sharedDimension.merged_hierarchies.map((h) => ({
        unique_name: h.unique_name,
        label: h.label,
        levels: h.levels,
        expansion_sources: h.addedFrom,
      })),
      consumers: opt.sharedDimension.consumers,
    };
    payload.changes = opt.changeList.map((c, i) => ({
      step: i + 1,
      description: c,
      type: i === 0 ? "create_shared_dimension"
        : i <= opt.sourceRefs.length ? "remove_local_dimension"
        : "update_model_dimension_ref",
    }));
  }

  if (opt.datasetConsolidation) {
    payload.dataset_consolidation = {
      proposed_unique_name: opt.datasetConsolidation.proposed_unique_name,
      proposed_label: opt.datasetConsolidation.proposed_label,
      connection_id: opt.datasetConsolidation.connection_id,
      output_path: `shared/datasets/${opt.datasetConsolidation.proposed_unique_name.toLowerCase().replace(/[^a-z0-9]/g, "-")}.yml`,
      table: opt.datasetConsolidation.table,
      sql: opt.datasetConsolidation.sql,
      union_columns: opt.datasetConsolidation.union_columns,
      consumers: opt.datasetConsolidation.consumers,
    };
    payload.changes = opt.changeList.map((c, i) => ({
      step: i + 1,
      description: c,
      type: i === 0 ? "create_shared_dataset"
        : i <= opt.sourceRefs.length ? "remove_local_dataset"
        : "update_dataset_reference",
    }));
  }

  if (opt.baseModelExtraction) {
    payload.base_model_extraction = {
      proposed_model_name: opt.baseModelExtraction.proposed_model_name,
      output_path: `shared/models/${opt.baseModelExtraction.proposed_model_name.toLowerCase().replace(/[^a-z0-9]/g, "-")}.yml`,
      common_dimensions: opt.baseModelExtraction.common_dimensions,
      common_metrics: opt.baseModelExtraction.common_metrics,
      source_models: opt.baseModelExtraction.source_models,
    };
    payload.changes = opt.changeList.map((c, i) => ({
      step: i + 1,
      description: c,
      type: i === 0 ? "create_base_model" : "refactor_source_model",
    }));
  }

  return toYaml(payload, { noRefs: true, lineWidth: 120 });
}
