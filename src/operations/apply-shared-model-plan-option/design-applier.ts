/**
 * design-applier.ts
 *
 * Core logic for applying a generate-shared-model-plan recommendation YAML.
 * Handles three kinds:
 *
 *   dataset-consolidation     — merge identical datasets into a shared file
 *   shared-dimension-library  — merge similar dimensions into a shared file
 *   base-model-extraction     — split common model core into a shared base
 *
 * All operations work on raw YAML objects so that SML-specific fields
 * (filter_empty, is_hidden_from_ui, allowed_calcs_for_dma, etc.) are
 * preserved exactly as written in the source files.
 */

import fs from "fs";
import path from "path";
import { load as parseYaml, dump as dumpYaml } from "js-yaml";

// ============================================================
// Plan YAML types (mirrors what plan-generator.ts writes)
// ============================================================

export interface PlanSourceRef {
  project:     string;
  directory:   string;
  unique_name: string;
  source_file: string;
}

interface SharedDimensionPlan {
  proposed_unique_name: string;
  proposed_label:       string;
  proposed_type:        string;
  output_path:          string;
  merged_hierarchies:   unknown[];
  consumers:            Array<{ project: string; dir: string; model: string }>;
}

interface DatasetConsolidationPlan {
  proposed_unique_name: string;
  proposed_label:       string;
  connection_id:        string;
  output_path:          string;
  table?:               unknown;
  sql?:                 string;
  union_columns:        Array<{ name: string; data_type: string }>;
  consumers:            Array<{ project: string; dir: string; dimension: string }>;
}

interface BaseModelPlan {
  proposed_model_name: string;
  output_path:         string;
  common_dimensions:   string[];
  common_metrics:      string[];
  source_models:       Array<{
    project:             string;
    dir:                 string;
    model:               string;
    specific_dimensions: string[];
    specific_metrics:    string[];
  }>;
}

export interface PlanYaml {
  schema_version:       string;
  option_id:            string;
  kind:                 "shared-dimension-library" | "dataset-consolidation" | "base-model-extraction";
  title:                string;
  description:          string;
  source_references:    PlanSourceRef[];
  shared_dimension?:    SharedDimensionPlan;
  dataset_consolidation?: DatasetConsolidationPlan;
  base_model_extraction?: BaseModelPlan;
  changes:              Array<{ step: number; description: string; type: string }>;
}

// ============================================================
// Apply result
// ============================================================

export interface ApplyAction {
  type:        "create" | "delete" | "skip" | "note";
  description: string;
  path?:       string;
}

export interface ApplyResult {
  kind:       string;
  title:      string;
  sharedDir:  string;
  actions:    ApplyAction[];
  warnings:   string[];
}

// ============================================================
// YAML helpers
// ============================================================

type RawYaml  = Record<string, unknown>;
type RawList  = RawYaml[];

function loadYaml(filePath: string): RawYaml {
  const raw = parseYaml(fs.readFileSync(filePath, "utf8"));
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw new Error(`Expected a YAML object in ${filePath}`);
  }
  return raw as RawYaml;
}

const YAML_DUMP_OPTS = { noRefs: true, lineWidth: 120, indent: 2 };

function writeYaml(filePath: string, obj: RawYaml, dryRun: boolean): ApplyAction {
  const dir = path.dirname(filePath);
  if (!dryRun) {
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(filePath, dumpYaml(obj, YAML_DUMP_OPTS), "utf8");
  }
  return { type: "create", description: `Write ${path.relative(process.cwd(), filePath)}`, path: filePath };
}

function deleteFile(filePath: string, dryRun: boolean): ApplyAction {
  if (!dryRun && fs.existsSync(filePath)) {
    fs.unlinkSync(filePath);
  }
  return {
    type: "delete",
    description: `Delete ${path.relative(process.cwd(), filePath)}`,
    path: filePath,
  };
}

/** Convert output_path like "shared/dimensions/foo.yml" → "<sharedDir>/dimensions/foo.yml". */
function resolveOutputPath(outputPath: string, sharedDir: string): string {
  const relative = outputPath.startsWith("shared/")
    ? outputPath.slice("shared/".length)
    : outputPath;
  return path.join(sharedDir, relative);
}

// ============================================================
// YAML merge helpers
// ============================================================

function asRawList(val: unknown): RawList {
  if (!Array.isArray(val)) return [];
  return val.map((v) => (v && typeof v === "object" && !Array.isArray(v) ? (v as RawYaml) : {}));
}

function str(val: unknown): string | undefined {
  return typeof val === "string" ? val : undefined;
}

/**
 * Merge hierarchy lists A ∪ B.
 * For hierarchies sharing a unique_name, union their levels.
 * New hierarchies from B are appended.
 */
function mergeHierarchies(base: RawList, additions: RawList): RawList {
  const byName = new Map<string, RawYaml>();
  for (const h of base) byName.set(String(h.unique_name), { ...h });

  for (const h of additions) {
    const name = String(h.unique_name);
    if (byName.has(name)) {
      // Merge levels within the shared hierarchy
      const existing = byName.get(name)!;
      const baseLevels    = asRawList(existing.levels);
      const addedLevels   = asRawList(h.levels);
      const levelNames    = new Set(baseLevels.map((l) => String(l.unique_name)));
      for (const lv of addedLevels) {
        if (!levelNames.has(String(lv.unique_name))) {
          baseLevels.push({ ...lv });
          levelNames.add(String(lv.unique_name));
        }
      }
      existing.levels = baseLevels;
    } else {
      byName.set(name, { ...h });
    }
  }
  return [...byName.values()];
}

/**
 * Merge level_attributes lists A ∪ B (by unique_name; A wins on conflict).
 */
function mergeLevelAttributes(base: RawList, additions: RawList): RawList {
  const byName = new Map<string, RawYaml>();
  for (const a of base)      byName.set(String(a.unique_name), { ...a });
  for (const b of additions) {
    const name = String(b.unique_name);
    if (!byName.has(name)) byName.set(name, { ...b });
  }
  return [...byName.values()];
}

/**
 * Merge dataset column lists A ∪ B (by name; A wins on conflict).
 */
function mergeColumns(base: RawList, additions: RawList): RawList {
  const byName = new Map<string, RawYaml>();
  for (const c of base)      byName.set(String(c.name).toLowerCase(), { ...c });
  for (const c of additions) {
    const k = String(c.name).toLowerCase();
    if (!byName.has(k)) byName.set(k, { ...c });
  }
  return [...byName.values()];
}

// ============================================================
// Handler: dataset-consolidation
// ============================================================

function applyDatasetConsolidation(
  plan:          PlanYaml,
  sharedDir:     string,
  removeSources: boolean,
  dryRun:        boolean,
): ApplyResult {
  const result: ApplyResult = { kind: plan.kind, title: plan.title, sharedDir, actions: [], warnings: [] };
  const ds = plan.dataset_consolidation!;

  // Validate all source files exist
  const existingSources = plan.source_references.filter((ref) => {
    if (!fs.existsSync(ref.source_file)) {
      result.warnings.push(`Source file not found (skipped): ${ref.source_file}`);
      return false;
    }
    return true;
  });

  if (existingSources.length === 0) {
    result.warnings.push("No source files found — nothing to apply.");
    return result;
  }

  // Read and merge all source YAMLs, starting from the first
  const [first, ...rest] = existingSources;
  const baseYaml  = loadYaml(first.source_file);
  let   cols      = asRawList(baseYaml.columns);

  for (const src of rest) {
    try {
      const srcYaml = loadYaml(src.source_file);
      cols = mergeColumns(cols, asRawList(srcYaml.columns));
    } catch {
      result.warnings.push(`Could not read ${src.source_file} — skipped in column merge`);
    }
  }

  // Build the shared dataset YAML
  const sharedYaml: RawYaml = {
    ...baseYaml,
    unique_name: `${ds.proposed_unique_name}.dataset`,
    object_type: "dataset",
    label:       ds.proposed_label,
    columns:     cols,
  };

  // Remove fields that should not carry over
  delete sharedYaml.source_file;

  const outPath = resolveOutputPath(ds.output_path, sharedDir);
  result.actions.push(writeYaml(outPath, sharedYaml, dryRun));

  // Deduplicate source files (multiple refs may point to the same file)
  const uniquePaths = [...new Set(existingSources.map((r) => r.source_file))];
  if (removeSources) {
    for (const f of uniquePaths) {
      result.actions.push(deleteFile(f, dryRun));
    }
  } else {
    for (const f of uniquePaths) {
      result.actions.push({
        type: "note",
        description: `Local copy to remove once shared file is wired up: ${path.relative(process.cwd(), f)}`,
        path: f,
      });
    }
  }

  return result;
}

// ============================================================
// Handler: shared-dimension-library
// ============================================================

function applySharedDimensionLibrary(
  plan:          PlanYaml,
  sharedDir:     string,
  removeSources: boolean,
  dryRun:        boolean,
): ApplyResult {
  const result: ApplyResult = { kind: plan.kind, title: plan.title, sharedDir, actions: [], warnings: [] };
  const dimPlan = plan.shared_dimension!;

  const existingSources = plan.source_references.filter((ref) => {
    if (!fs.existsSync(ref.source_file)) {
      result.warnings.push(`Source file not found (skipped): ${ref.source_file}`);
      return false;
    }
    return true;
  });

  if (existingSources.length === 0) {
    result.warnings.push("No source files found — nothing to apply.");
    return result;
  }

  // Read all source dimension YAMLs
  const sourceYamls: RawYaml[] = [];
  for (const src of existingSources) {
    try {
      sourceYamls.push(loadYaml(src.source_file));
    } catch {
      result.warnings.push(`Could not read ${src.source_file} — skipped`);
    }
  }

  if (sourceYamls.length === 0) {
    result.warnings.push("Could not read any source files — nothing to apply.");
    return result;
  }

  // Start with the first source as the base, then fold in the rest
  const [baseYaml, ...additionalYamls] = sourceYamls;
  let mergedHierarchies  = asRawList(baseYaml.hierarchies);
  let mergedLevelAttrs   = asRawList(baseYaml.level_attributes);

  for (const addYaml of additionalYamls) {
    mergedHierarchies = mergeHierarchies(mergedHierarchies, asRawList(addYaml.hierarchies));
    mergedLevelAttrs  = mergeLevelAttributes(mergedLevelAttrs, asRawList(addYaml.level_attributes));
  }

  // Build the shared dimension YAML
  const sharedYaml: RawYaml = {
    ...baseYaml,
    unique_name:  dimPlan.proposed_unique_name,
    object_type:  "dimension",
    label:        dimPlan.proposed_label,
    type:         dimPlan.proposed_type,
    hierarchies:  mergedHierarchies,
  };
  if (mergedLevelAttrs.length > 0) {
    sharedYaml.level_attributes = mergedLevelAttrs;
  }
  delete sharedYaml.source_file;

  const outPath = resolveOutputPath(dimPlan.output_path, sharedDir);
  result.actions.push(writeYaml(outPath, sharedYaml, dryRun));

  const uniquePaths = [...new Set(existingSources.map((r) => r.source_file))];
  if (removeSources) {
    for (const f of uniquePaths) result.actions.push(deleteFile(f, dryRun));
  } else {
    for (const f of uniquePaths) {
      result.actions.push({
        type: "note",
        description: `Local copy to remove once shared file is deployed: ${path.relative(process.cwd(), f)}`,
        path: f,
      });
    }
  }

  return result;
}

// ============================================================
// Handler: base-model-extraction
// ============================================================

function applyBaseModelExtraction(
  plan:      PlanYaml,
  sharedDir: string,
  dryRun:    boolean,
): ApplyResult {
  const result: ApplyResult = { kind: plan.kind, title: plan.title, sharedDir, actions: [], warnings: [] };
  const bmPlan = plan.base_model_extraction!;

  const commonDims    = new Set(bmPlan.common_dimensions);
  const commonMetrics = new Set(bmPlan.common_metrics);

  // ── 1. Create the shared base model ──────────────────────────────────────
  // Use the first source model as the template; filter down to common content.
  const firstSrcModel = plan.source_references[0];
  if (!firstSrcModel || !fs.existsSync(firstSrcModel.source_file)) {
    result.warnings.push(`Source model not found: ${firstSrcModel?.source_file ?? "(none)"}`);
    return result;
  }

  const baseTemplate = loadYaml(firstSrcModel.source_file);

  const baseRelationships = asRawList(baseTemplate.relationships).filter((r) => {
    const to  = r.to && typeof r.to === "object" ? (r.to as RawYaml) : {};
    const dim = str(to.dimension);
    return dim !== undefined && commonDims.has(dim);
  });

  const baseDimensions = asRawList(baseTemplate.dimensions).filter((d) => {
    const name = str(d.unique_name);
    return name !== undefined && commonDims.has(name);
  });

  const baseMetrics = asRawList(baseTemplate.metrics).filter((m) => {
    const name = str(m.unique_name);
    return name !== undefined && commonMetrics.has(name);
  });

  const baseModelYaml: RawYaml = {
    ...baseTemplate,
    unique_name:   bmPlan.proposed_model_name,
    object_type:   "model",
    label:         bmPlan.proposed_model_name.replace(/_/g, " "),
    relationships: baseRelationships,
    dimensions:    baseDimensions,
    metrics:       baseMetrics,
  };
  delete baseModelYaml.source_file;

  const basePath = resolveOutputPath(bmPlan.output_path, sharedDir);
  result.actions.push(writeYaml(basePath, baseModelYaml, dryRun));

  // ── 2. Create slim source models (specific-only content) ─────────────────
  for (const sm of bmPlan.source_models) {
    if (!fs.existsSync(sm.model === firstSrcModel.unique_name ? firstSrcModel.source_file
                                                              : plan.source_references.find((r) => r.unique_name === sm.model)?.source_file ?? "")) {
      // fall back: try to find the file
    }

    const srcRef = plan.source_references.find((r) => r.unique_name === sm.model);
    if (!srcRef || !fs.existsSync(srcRef.source_file)) {
      result.warnings.push(`Source model not found for slim version: ${sm.model}`);
      continue;
    }

    const srcYaml = loadYaml(srcRef.source_file);
    const specificDims    = new Set(sm.specific_dimensions);
    const specificMetrics = new Set(sm.specific_metrics);

    if (specificDims.size === 0 && specificMetrics.size === 0) {
      // 100% overlap — this model is fully covered by the base
      result.actions.push({
        type: "note",
        description:
          `"${sm.model}" (${sm.project}) is 100% covered by the base model — ` +
          `it can be removed and replaced by the base model after review`,
      });
      continue;
    }

    const slimRelationships = asRawList(srcYaml.relationships).filter((r) => {
      const to  = r.to && typeof r.to === "object" ? (r.to as RawYaml) : {};
      const dim = str(to.dimension);
      return dim !== undefined && specificDims.has(dim);
    });

    const slimDimensions = asRawList(srcYaml.dimensions).filter((d) => {
      const name = str(d.unique_name);
      return name !== undefined && specificDims.has(name);
    });

    const slimMetrics = asRawList(srcYaml.metrics).filter((m) => {
      const name = str(m.unique_name);
      return name !== undefined && specificMetrics.has(name);
    });

    const slug     = sm.model.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
    const slimPath = path.join(sharedDir, "models", `${slug}-specific.yml`);
    const slimYaml: RawYaml = {
      ...srcYaml,
      relationships: slimRelationships,
      dimensions:    slimDimensions,
      metrics:       slimMetrics,
    };
    delete slimYaml.source_file;
    result.actions.push(writeYaml(slimPath, slimYaml, dryRun));
  }

  result.actions.push({
    type: "note",
    description:
      "Source model files have NOT been modified. Review the generated base and slim models, " +
      "then manually update each source project once you are satisfied.",
  });

  return result;
}

// ============================================================
// Public entry point
// ============================================================

export function parsePlanYaml(filePath: string): PlanYaml {
  const raw = parseYaml(fs.readFileSync(filePath, "utf8"));
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw new Error(`Expected a YAML object in ${filePath}`);
  }
  const plan = raw as PlanYaml;
  if (!plan.kind || !plan.source_references) {
    throw new Error(`${filePath} does not look like a valid option YAML (missing kind or source_references)`);
  }
  return plan;
}

export function applyPlan(
  plan:          PlanYaml,
  sharedDir:     string,
  removeSources: boolean,
  dryRun:        boolean,
): ApplyResult {
  switch (plan.kind) {
    case "dataset-consolidation":
      return applyDatasetConsolidation(plan, sharedDir, removeSources, dryRun);
    case "shared-dimension-library":
      return applySharedDimensionLibrary(plan, sharedDir, removeSources, dryRun);
    case "base-model-extraction":
      return applyBaseModelExtraction(plan, sharedDir, dryRun);
    default:
      throw new Error(`Unknown plan kind: ${(plan as PlanYaml).kind}`);
  }
}
