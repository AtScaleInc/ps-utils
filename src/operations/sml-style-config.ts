/**
 * SML style configuration — shared settings file for SML generation operations.
 *
 * `sml.style.yaml` persists SML generation parameters between runs.  Operations
 * that generate SML read from this file (CLI flags take priority) and write back
 * the fully-resolved settings after generation so the file serves as both a
 * configuration source and an accurate record of what was used.
 *
 * Priority order: CLI flags  >  sml.style.yaml  >  hardcoded defaults
 *
 * Fields are partitioned by operation but the file is shared — each operation
 * reads only the keys it uses and ignores the rest.
 */
import fs from "fs";
import path from "path";
import yaml from "js-yaml";

// ─── Types ─────────────────────────────────────────────────────────────────────

/**
 * Shape of `sml.style.yaml`.  All fields are optional; missing fields fall back
 * to hardcoded defaults when an operation runs.
 */
export interface SmlStyleConfig {
  // ── generate-sml-from-ddl / generate-sml-from-connection ─────────────────
  /** PII column exclusion threshold: "HIGH" | "MEDIUM" | "LOW" | "none".  Default: "MEDIUM". */
  "pii-severity"?:        string;
  /** Tables to force-classify as fact tables, overriding automatic detection. */
  "fact-tables"?:         string[];
  /** Catalog display name.  Omit (or leave empty) to default to the model name. */
  "catalog-name"?:        string;
  /** Use camelCase for SML filenames.  Default: false (raw table name). */
  "camel-case-files"?:    boolean;
  /** Use camelCase for metric labels.  Default: false (raw column name).
   * @deprecated Prefer `label-style` for a unified label style across all objects. */
  "camel-case-measures"?: boolean;
  /**
   * Label style applied to all SML object labels (datasets, dimensions, hierarchies,
   * level attributes, secondary attributes, metrics).
   *   "title-case" — strip affixes, apply Title Case (default)
   *   "camel-case" — strip affixes, apply lowerCamelCase
   *   "none"       — use raw source names without transformation
   */
  "label-style"?: "title-case" | "camel-case" | "none";
  /** Max rows to sample per table for column type inference.  0 to disable.  Default: 250.
   *  Only applies to generate-sml-from-connection — DDL operations always use 0. */
  "sample-size"?:         number;

  // ── generate-metrics-from-model ───────────────────────────────────────────
  /** Maximum number of metric suggestions to output.  Default: 25. */
  "max-suggestions"?:  number;
  /** Minimum relevance score [0–1] to include a suggestion.  Default: 0.5. */
  "min-score"?:        number;
  /** Include multi-dimension (tuple) suggestions.  Default: true. */
  "include-tuples"?:   boolean;

  // ── generate-sml-from-ddl / generate-sml-from-connection (hierarchy limits) ─
  /** Minimum number of hierarchies a dimension must have to be included.  Default: 1. */
  "min-hierarchies-per-dim"?: number;
  /** Maximum number of hierarchies to keep per dimension (truncates extras).  Default: 4. */
  "max-hierarchies-per-dim"?: number;
}

/** Fully-resolved style — every field has a concrete value after merging. */
export interface MergedSmlStyle {
  "pii-severity":       string;
  "fact-tables":        string[];
  "catalog-name":       string | undefined;   // undefined → caller applies model-name fallback
  "camel-case-files":   boolean;
  "camel-case-measures": boolean;
  "label-style": "title-case" | "camel-case" | "none";
  "sample-size":        number;
  "max-suggestions":    number;
  "min-score":          number;
  "include-tuples":     boolean;
  "min-hierarchies-per-dim": number;
  "max-hierarchies-per-dim": number;
}

// ─── Defaults ──────────────────────────────────────────────────────────────────

export const SML_STYLE_DEFAULTS: Omit<MergedSmlStyle, "catalog-name"> & { "catalog-name": undefined } = {
  "pii-severity":        "MEDIUM",
  "fact-tables":         [],
  "catalog-name":        undefined,
  "camel-case-files":    false,
  "camel-case-measures": false,
  "label-style":         "title-case",
  "sample-size":         250,
  "max-suggestions":     25,
  "min-score":           0.5,
  "include-tuples":      true,
  "min-hierarchies-per-dim": 1,
  "max-hierarchies-per-dim": 4,
};

// ─── Load ───────────────────────────────────────────────────────────────────────

/**
 * Load `sml.style.yaml` from `filePath`.  Returns an empty object if the file
 * does not exist — never throws.
 */
export function loadSmlStyleConfig(filePath: string): SmlStyleConfig {
  if (!fs.existsSync(filePath)) return {};
  try {
    const raw = yaml.load(fs.readFileSync(filePath, "utf8")) as SmlStyleConfig | null;
    return raw ?? {};
  } catch {
    return {};
  }
}

// ─── Merge ──────────────────────────────────────────────────────────────────────

/**
 * Merge CLI values (highest priority) over style-file values over hardcoded
 * defaults.  A CLI value of `undefined` means "not explicitly set" and falls
 * through to the style file.
 */
export function mergeSmlStyle(
  cliValues: Partial<SmlStyleConfig>,
  styleConfig: SmlStyleConfig,
): MergedSmlStyle {
  return {
    "pii-severity":        cliValues["pii-severity"]        ?? styleConfig["pii-severity"]        ?? SML_STYLE_DEFAULTS["pii-severity"],
    "fact-tables":         cliValues["fact-tables"]         ?? styleConfig["fact-tables"]         ?? [...SML_STYLE_DEFAULTS["fact-tables"]],
    "catalog-name":        cliValues["catalog-name"]        ?? styleConfig["catalog-name"]        ?? SML_STYLE_DEFAULTS["catalog-name"],
    "camel-case-files":    cliValues["camel-case-files"]    ?? styleConfig["camel-case-files"]    ?? SML_STYLE_DEFAULTS["camel-case-files"],
    "camel-case-measures": cliValues["camel-case-measures"] ?? styleConfig["camel-case-measures"] ?? SML_STYLE_DEFAULTS["camel-case-measures"],
    "label-style":         cliValues["label-style"]         ?? styleConfig["label-style"]         ?? SML_STYLE_DEFAULTS["label-style"],
    "sample-size":         cliValues["sample-size"]         ?? styleConfig["sample-size"]         ?? SML_STYLE_DEFAULTS["sample-size"],
    "max-suggestions":     cliValues["max-suggestions"]     ?? styleConfig["max-suggestions"]     ?? SML_STYLE_DEFAULTS["max-suggestions"],
    "min-score":           cliValues["min-score"]           ?? styleConfig["min-score"]           ?? SML_STYLE_DEFAULTS["min-score"],
    "include-tuples":      cliValues["include-tuples"]      ?? styleConfig["include-tuples"]      ?? SML_STYLE_DEFAULTS["include-tuples"],
    "min-hierarchies-per-dim": cliValues["min-hierarchies-per-dim"] ?? styleConfig["min-hierarchies-per-dim"] ?? SML_STYLE_DEFAULTS["min-hierarchies-per-dim"],
    "max-hierarchies-per-dim": cliValues["max-hierarchies-per-dim"] ?? styleConfig["max-hierarchies-per-dim"] ?? SML_STYLE_DEFAULTS["max-hierarchies-per-dim"],
  };
}

// ─── Write ──────────────────────────────────────────────────────────────────────

/**
 * Write the effective style settings (with all values resolved, including
 * defaulted ones) to `filePath`.  Creates parent directories as needed.
 */
export function writeSmlStyleConfig(filePath: string, config: SmlStyleConfig): void {
  const resolved = path.resolve(filePath);
  const dir = path.dirname(resolved);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(resolved, yaml.dump(config, { lineWidth: 120, sortKeys: false }), "utf8");
}
