/**
 * apply-style-to-sml
 *
 * Reads an existing AtScale SML output directory and re-applies display labels
 * according to a style configuration (sml.style.yaml or CLI flags).
 *
 * Updated files: datasets/*.yml, dimensions/*.yml, metrics/*.yml
 * Written outputs: STYLE.md, STYLE_CHANGES.md
 */
import fs from "fs";
import path from "path";
import yaml from "js-yaml";
import { Operation } from "../Operation.js";
import { ParameterSet, StringParameter } from "../../Parameters.js";
import type { ServiceRegistry } from "../../services/registry.js";
import type { Logger } from "../../logging.js";
import {
  loadSmlStyleConfig,
  mergeSmlStyle,
  type MergedSmlStyle,
} from "../sml-style-config.js";
import {
  applyLabelStyle,
  dimensionLabel,
  levelLabel,
  toCamelCase,
  toTitleCase,
  type LabelStyle,
} from "../../algorithm/sml-serializer.js";
import {
  generateStyleGuide,
  type StyleGuideOptions,
} from "../../algorithm/report-generator.js";

// ----------------------------------------------------------
// Parameters
// ----------------------------------------------------------

class ApplyStyleToSMLParamsSet extends ParameterSet {
  parameters = [
    new (class extends StringParameter {
      name        = "sml-dir";
      description = "Path to the SML output directory to update (must contain datasets/, dimensions/, metrics/ subdirectories)";
      required    = true;
    })(),
    new (class extends StringParameter {
      name        = "sml-config-file";
      description = "Path to sml.style.yaml. Defaults to <sml-dir>/sml.style.yaml";
      required    = false;
    })(),
    new (class extends StringParameter {
      name        = "label-style";
      description = 'Label style to apply: "title-case" (default), "camel-case", or "none" (raw source names). Overrides sml.style.yaml.';
      required    = false;
    })(),
    new (class extends StringParameter {
      name        = "catalog-name";
      description = "Catalog display name written into STYLE.md. Defaults to the value in sml.style.yaml.";
      required    = false;
    })(),
  ];
}

type Params = {
  "sml-dir":         string;
  "sml-config-file"?: string;
  "label-style"?:    "title-case" | "camel-case" | "none";
  "catalog-name"?:   string;
};
export type ApplyStyleToSMLParams = Params;

// ----------------------------------------------------------
// Change record
// ----------------------------------------------------------

interface LabelChange {
  file:     string;
  kind:     string;
  name:     string;
  field:    string;
  oldLabel: string;
  newLabel: string;
}

// ----------------------------------------------------------
// Aggregation helpers (reverse-mapping calculation_method → label suffix)
// ----------------------------------------------------------

const CALC_METHOD_TO_AGG: Record<string, string> = {
  sum:                     "SUM",
  average:                 "AVG",
  minimum:                 "MIN",
  maximum:                 "MAX",
  count:                   "COUNT",
  distinct_count_estimate: "COUNT",
};

const AGG_TO_TITLE_SUFFIX: Record<string, string> = {
  SUM:   "Sum",
  AVG:   "Avg",
  MIN:   "Min",
  MAX:   "Max",
  COUNT: "Count",
};

function metricLabel(sourceColumn: string, calcMethod: string, style: LabelStyle): string {
  const agg = CALC_METHOD_TO_AGG[calcMethod] ?? calcMethod.toUpperCase();
  if (style === "none") {
    return `${sourceColumn}_${agg.toLowerCase()}`;
  }
  const baseTitle = toTitleCase(sourceColumn);
  const suffix = AGG_TO_TITLE_SUFFIX[agg] ?? toTitleCase(calcMethod);
  const titleLabel = `${baseTitle} ${suffix}`;
  return style === "camel-case" ? toCamelCase(titleLabel) : titleLabel;
}

function hierarchyLabel(uniqueName: string, style: LabelStyle): string {
  if (style === "none") return uniqueName;
  const titleVersion = toTitleCase(uniqueName);
  return style === "camel-case" ? toCamelCase(titleVersion) : titleVersion;
}

// ----------------------------------------------------------
// Helpers: update label fields inside a parsed YAML object
// ----------------------------------------------------------

type SmlYaml = Record<string, unknown>;
type NestedMap  = Record<string, unknown>;

function setLabel(obj: NestedMap, newLabel: string): string | undefined {
  const old = typeof obj["label"] === "string" ? obj["label"] : undefined;
  obj["label"] = newLabel;
  return old;
}

function applyDatasetStyle(parsed: SmlYaml, style: LabelStyle, relPath: string): LabelChange[] {
  const changes: LabelChange[] = [];
  const sourceTable = typeof parsed["table"] === "string" ? parsed["table"] : undefined;
  if (!sourceTable) return changes;

  const newLabel = applyLabelStyle(sourceTable, style);
  const old = setLabel(parsed, newLabel);
  if (old !== undefined && old !== newLabel) {
    changes.push({ file: relPath, kind: "dataset", name: String(parsed["unique_name"] ?? ""), field: "label", oldLabel: old, newLabel });
  }
  return changes;
}

function applyMetricStyle(parsed: SmlYaml, style: LabelStyle, relPath: string): LabelChange[] {
  const changes: LabelChange[] = [];
  const column = typeof parsed["column"] === "string" ? parsed["column"] : undefined;
  const calc   = typeof parsed["calculation_method"] === "string" ? parsed["calculation_method"] : undefined;
  if (!column || !calc) return changes;

  const newLabel = metricLabel(column, calc, style);
  const old = setLabel(parsed, newLabel);
  if (old !== undefined && old !== newLabel) {
    changes.push({ file: relPath, kind: "metric", name: String(parsed["unique_name"] ?? ""), field: "label", oldLabel: old, newLabel });
  }
  return changes;
}

function applyDimensionStyle(parsed: SmlYaml, style: LabelStyle, relPath: string): LabelChange[] {
  const changes: LabelChange[] = [];

  // Determine source table from the first level_attribute's dataset field.
  const levelAttrs = Array.isArray(parsed["level_attributes"]) ? parsed["level_attributes"] as NestedMap[] : [];
  const firstDataset = levelAttrs.find((la) => typeof la["dataset"] === "string")?.["dataset"] as string | undefined;
  const sourceTable = firstDataset ? String(firstDataset).replace(/\.dataset$/, "") : undefined;

  // Dimension label
  if (sourceTable) {
    const newLabel = dimensionLabel(sourceTable, style);
    const old = setLabel(parsed, newLabel);
    if (old !== undefined && old !== newLabel) {
      changes.push({ file: relPath, kind: "dimension", name: String(parsed["unique_name"] ?? ""), field: "label", oldLabel: old, newLabel });
    }
  }

  // Hierarchy labels
  const hierarchies = Array.isArray(parsed["hierarchies"]) ? parsed["hierarchies"] as NestedMap[] : [];
  for (const h of hierarchies) {
    const hUniqueName = typeof h["unique_name"] === "string" ? h["unique_name"] : undefined;
    if (!hUniqueName) continue;
    const newLabel = hierarchyLabel(hUniqueName, style);
    const old = setLabel(h, newLabel);
    if (old !== undefined && old !== newLabel) {
      changes.push({ file: relPath, kind: "hierarchy", name: hUniqueName, field: "label", oldLabel: old, newLabel });
    }

    // Secondary attributes inside hierarchy levels
    const levels = Array.isArray(h["levels"]) ? h["levels"] as NestedMap[] : [];
    for (const lvl of levels) {
      const secAttrs = Array.isArray(lvl["secondary_attributes"]) ? lvl["secondary_attributes"] as NestedMap[] : [];
      for (const sa of secAttrs) {
        const keyCols = Array.isArray(sa["key_columns"]) ? sa["key_columns"] as string[] : [];
        const srcCol = keyCols[0];
        if (!srcCol) continue;
        const newSaLabel = levelLabel(srcCol, style);
        const oldSa = setLabel(sa, newSaLabel);
        if (oldSa !== undefined && oldSa !== newSaLabel) {
          changes.push({ file: relPath, kind: "secondary_attribute", name: String(sa["unique_name"] ?? srcCol), field: "label", oldLabel: oldSa, newLabel: newSaLabel });
        }
      }
    }
  }

  // Level attribute labels
  for (const la of levelAttrs) {
    if (la["is_hidden"] === true) continue; // hidden FK join attributes — leave unchanged
    const keyCols = Array.isArray(la["key_columns"]) ? la["key_columns"] as string[] : [];
    const srcCol = keyCols[0];
    if (!srcCol) continue;
    const newLabel = levelLabel(srcCol, style);
    const old = setLabel(la, newLabel);
    if (old !== undefined && old !== newLabel) {
      changes.push({ file: relPath, kind: "level_attribute", name: String(la["unique_name"] ?? srcCol), field: "label", oldLabel: old, newLabel });
    }

    // Secondary attributes on level attributes
    const secAttrs = Array.isArray(la["secondary_attributes"]) ? la["secondary_attributes"] as NestedMap[] : [];
    for (const sa of secAttrs) {
      const saKeyCols = Array.isArray(sa["key_columns"]) ? sa["key_columns"] as string[] : [];
      const saSrcCol = saKeyCols[0];
      if (!saSrcCol) continue;
      const newSaLabel = levelLabel(saSrcCol, style);
      const oldSa = setLabel(sa, newSaLabel);
      if (oldSa !== undefined && oldSa !== newSaLabel) {
        changes.push({ file: relPath, kind: "secondary_attribute", name: String(sa["unique_name"] ?? saSrcCol), field: "label", oldLabel: oldSa, newLabel: newSaLabel });
      }
    }
  }

  return changes;
}

// ----------------------------------------------------------
// YAML dump options
// ----------------------------------------------------------

const YAML_DUMP_OPTS: yaml.DumpOptions = {
  lineWidth:  -1,
  indent:     2,
  noRefs:     true,
  sortKeys:   false,
};

// ----------------------------------------------------------
// STYLE_CHANGES.md builder
// ----------------------------------------------------------

function buildChangesReport(changes: LabelChange[], style: LabelStyle, smlDir: string): string {
  const lines: string[] = [];
  lines.push(`# SML Label Changes`);
  lines.push(``);
  lines.push(`> Applied by \`apply-style-to-sml\` with \`label-style: ${style}\`.`);
  lines.push(`> SML directory: \`${smlDir}\``);
  lines.push(``);

  if (changes.length === 0) {
    lines.push(`No label changes were necessary — all labels already match the requested style.`);
    return lines.join("\n");
  }

  lines.push(`## Summary`);
  lines.push(``);
  lines.push(`${changes.length} label(s) updated.`);
  lines.push(``);

  // Group by file
  const byFile = new Map<string, LabelChange[]>();
  for (const ch of changes) {
    const arr = byFile.get(ch.file) ?? [];
    arr.push(ch);
    byFile.set(ch.file, arr);
  }

  lines.push(`## Changes by File`);
  lines.push(``);
  for (const [file, fileChanges] of byFile) {
    lines.push(`### \`${file}\``);
    lines.push(``);
    lines.push(`| Object | Kind | Old Label | New Label |`);
    lines.push(`|---|---|---|---|`);
    for (const ch of fileChanges) {
      lines.push(`| \`${ch.name}\` | ${ch.kind} | \`${ch.oldLabel}\` | \`${ch.newLabel}\` |`);
    }
    lines.push(``);
  }

  return lines.join("\n");
}

// ----------------------------------------------------------
// Operation
// ----------------------------------------------------------

export class ApplyStyleToSMLOperation extends Operation<Params> {
  name        = "apply-style-to-sml";
  description = "Re-apply display labels to an existing SML directory using a style config; outputs STYLE.md and STYLE_CHANGES.md";
  parameters  = new ApplyStyleToSMLParamsSet();

  constructor(services: ServiceRegistry, logger: Logger) {
    super(services, logger);
  }

  async run(params: Params): Promise<void> {
    const smlDir = path.resolve(params["sml-dir"]);
    if (!fs.existsSync(smlDir)) {
      throw new Error(`SML directory not found: ${smlDir}`);
    }

    const configFile = params["sml-config-file"] ?? path.join(smlDir, "sml.style.yaml");
    const styleFileConfig = loadSmlStyleConfig(configFile);
    const style = mergeSmlStyle(
      {
        "label-style":  params["label-style"],
        "catalog-name": params["catalog-name"],
      },
      styleFileConfig,
    );

    const labelStyle: LabelStyle = style["label-style"];
    this.logger.log(`[ApplyStyleToSML] label-style: ${labelStyle}`);

    const allChanges: LabelChange[] = [];

    // ── Datasets ─────────────────────────────────────────────────────────────
    const datasetsDir = path.join(smlDir, "datasets");
    if (fs.existsSync(datasetsDir)) {
      for (const file of fs.readdirSync(datasetsDir).filter((f) => f.endsWith(".yml"))) {
        const filePath = path.join(datasetsDir, file);
        const relPath  = path.join("datasets", file);
        const parsed   = yaml.load(fs.readFileSync(filePath, "utf8")) as SmlYaml;
        if (!parsed || parsed["object_type"] !== "dataset") continue;

        const changes = applyDatasetStyle(parsed, labelStyle, relPath);
        allChanges.push(...changes);
        if (changes.length > 0) {
          fs.writeFileSync(filePath, yaml.dump(parsed, YAML_DUMP_OPTS), "utf8");
          this.logger.log(`  updated ${relPath} (${changes.length} change(s))`);
        }
      }
    }

    // ── Metrics ───────────────────────────────────────────────────────────────
    const metricsDir = path.join(smlDir, "metrics");
    if (fs.existsSync(metricsDir)) {
      for (const file of fs.readdirSync(metricsDir).filter((f) => f.endsWith(".yml"))) {
        const filePath = path.join(metricsDir, file);
        const relPath  = path.join("metrics", file);
        const parsed   = yaml.load(fs.readFileSync(filePath, "utf8")) as SmlYaml;
        if (!parsed || parsed["object_type"] !== "metric") continue;

        const changes = applyMetricStyle(parsed, labelStyle, relPath);
        allChanges.push(...changes);
        if (changes.length > 0) {
          fs.writeFileSync(filePath, yaml.dump(parsed, YAML_DUMP_OPTS), "utf8");
          this.logger.log(`  updated ${relPath} (${changes.length} change(s))`);
        }
      }
    }

    // ── Dimensions ────────────────────────────────────────────────────────────
    const dimensionsDir = path.join(smlDir, "dimensions");
    if (fs.existsSync(dimensionsDir)) {
      for (const file of fs.readdirSync(dimensionsDir).filter((f) => f.endsWith(".yml"))) {
        const filePath = path.join(dimensionsDir, file);
        const relPath  = path.join("dimensions", file);
        const parsed   = yaml.load(fs.readFileSync(filePath, "utf8")) as SmlYaml;
        if (!parsed || parsed["object_type"] !== "dimension") continue;

        const changes = applyDimensionStyle(parsed, labelStyle, relPath);
        allChanges.push(...changes);
        if (changes.length > 0) {
          fs.writeFileSync(filePath, yaml.dump(parsed, YAML_DUMP_OPTS), "utf8");
          this.logger.log(`  updated ${relPath} (${changes.length} change(s))`);
        }
      }
    }

    // ── STYLE.md ──────────────────────────────────────────────────────────────
    const catalogName = style["catalog-name"] ?? "Unknown Catalog";
    const styleGuideOpts: StyleGuideOptions = {
      catalogName,
      piiSeverity:          style["pii-severity"],
      camelCaseFiles:       style["camel-case-files"],
      camelCaseMeasures:    style["camel-case-measures"],
      labelStyle:           labelStyle,
      factTables:           style["fact-tables"],
      sampleSize:           style["sample-size"],
      minHierarchiesPerDim: style["min-hierarchies-per-dim"],
      maxHierarchiesPerDim: style["max-hierarchies-per-dim"],
    };
    if (generateStyleGuide(smlDir, styleGuideOpts)) {
      this.logger.log(`  → STYLE.md`);
    }

    // ── STYLE_CHANGES.md ──────────────────────────────────────────────────────
    const changesContent = buildChangesReport(allChanges, labelStyle, smlDir);
    fs.writeFileSync(path.join(smlDir, "STYLE_CHANGES.md"), changesContent, "utf8");
    this.logger.log(`  → STYLE_CHANGES.md`);

    this.logger.log(
      `[ApplyStyleToSML] Done — ${allChanges.length} label(s) updated across ` +
      `${new Set(allChanges.map((c) => c.file)).size} file(s).`,
    );
  }
}
