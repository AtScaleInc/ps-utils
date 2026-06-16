/**
 * Shared helpers for the generate-sml-from-ddl and generate-sml-from-connection
 * operations.  Extracts the three pieces of logic that are identical in both:
 *
 *   resolvePiiSeverity  — normalise the --pii-severity CLI parameter
 *   writeSmlFiles       — write a Map<relativePath, yaml> to disk
 *   runInferenceAndWrite — call proposeSemanticModel, log warnings,
 *                          write SML files, write REPORT.md, and log a summary
 */
import fs from "fs";
import path from "path";
import type { Logger } from "../logging.js";
import type { DatabaseMetaData } from "../algorithm/types.js";
import type { ProposeOptions } from "../algorithm/semantic-model-builder.js";
import { proposeSemanticModel } from "../algorithm/semantic-model-builder.js";
import { createDefaultEngine } from "../algorithm/inference/index.js";
import { generateReport, generateStyleGuide, type ReportOptions, type StyleGuideOptions } from "../algorithm/report-generator.js";
import { type SmlStyleConfig, writeSmlStyleConfig } from "./sml-style-config.js";

// ----------------------------------------------------------
// PII severity resolver
// ----------------------------------------------------------

export type PiiSeverity = "HIGH" | "MEDIUM" | "LOW" | false;

export function resolvePiiSeverity(raw: string): PiiSeverity {
  switch (raw.toUpperCase()) {
    case "NONE":   return false;
    case "HIGH":   return "HIGH";
    case "LOW":    return "LOW";
    default:       return "MEDIUM";
  }
}

// ----------------------------------------------------------
// SML file writer
// ----------------------------------------------------------

export function writeSmlFiles(
  sml: Map<string, string>,
  outputDir: string,
  logger: Logger,
): void {
  for (const [relativePath, yamlContent] of sml) {
    const absolutePath = path.join(outputDir, relativePath);
    const dir = path.dirname(absolutePath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
    fs.writeFileSync(absolutePath, yamlContent, "utf8");
    logger.log(`  → ${relativePath}`);
  }
}

// ----------------------------------------------------------
// Inference + write orchestrator
// ----------------------------------------------------------

export type InferenceOptions = Omit<ProposeOptions, "inferenceEngine" | "suggestions">;

/**
 * Run semantic model inference on `db`, write the resulting SML files to
 * `outputDir`, write REPORT.md, STYLE.md, and sml.style.yaml, and log
 * warnings + a summary.
 *
 * @param tag         Short identifier used in log prefixes, e.g. "GenerateSMLFromDDL".
 * @param styleConfig When provided, the fully-resolved style settings are written
 *                    to `<outputDir>/sml.style.yaml` alongside STYLE.md.
 */
export async function runInferenceAndWrite(
  db: DatabaseMetaData,
  modelName: string,
  options: InferenceOptions,
  outputDir: string,
  logger: Logger,
  tag: string,
  styleConfig?: SmlStyleConfig,
): Promise<void> {
  logger.log(`[${tag}] Running inference on "${modelName}"…`);

  const model = await proposeSemanticModel(db, modelName, {
    ...options,
    inferenceEngine: createDefaultEngine(),
    suggestions: true,
  });

  if (model.warnings.length > 0) {
    logger.log(`\n[${tag}] Inference warnings:`);
    for (const w of model.warnings) {
      logger.log(`  ⚠  ${w}`);
    }
  }

  if (model.sml && model.sml.size > 0) {
    writeSmlFiles(model.sml, outputDir, logger);
    logger.log(`\n[${tag}] Wrote ${model.sml.size} SML file(s) to: ${outputDir}`);
  } else {
    logger.log(`[${tag}] No SML output was generated.`);
  }

  // Write REPORT.md
  const smlOpts = options.sml;
  const reportOpts: ReportOptions = {
    connectionName: smlOpts?.connectionName ?? "unknown",
    catalogName:    smlOpts?.catalogName,
    schema:         smlOpts?.schema,
    database:       smlOpts?.database,
    dialect:        smlOpts?.dialect,
  };
  const reportContent = generateReport(model, reportOpts);
  const reportPath    = path.join(outputDir, "REPORT.md");
  fs.mkdirSync(outputDir, { recursive: true });
  fs.writeFileSync(reportPath, reportContent, "utf8");
  logger.log(`  → REPORT.md`);
  if (styleConfig) {
    const styleGuideOpts: StyleGuideOptions = {
      catalogName:          smlOpts?.catalogName ?? model.name,
      piiSeverity:          styleConfig["pii-severity"] ?? "MEDIUM",
      camelCaseFiles:       styleConfig["camel-case-files"] ?? false,
      camelCaseMeasures:    styleConfig["camel-case-measures"] ?? false,
      labelStyle:           styleConfig["label-style"] ?? "title-case",
      factTables:           styleConfig["fact-tables"] ?? [],
      sampleSize:           styleConfig["sample-size"] ?? 0,
      minHierarchiesPerDim: styleConfig["min-hierarchies-per-dim"] ?? 1,
      maxHierarchiesPerDim: styleConfig["max-hierarchies-per-dim"] ?? 4,
    };
    if (generateStyleGuide(outputDir, styleGuideOpts)) {
      logger.log(`  → STYLE.md`);
    }
    writeSmlStyleConfig(path.join(outputDir, "sml.style.yaml"), styleConfig);
    logger.log(`  → sml.style.yaml`);
  }

  logger.log(
    `[${tag}] Done — ` +
    `${model.facts.length} fact(s), ` +
    `${model.dimensions.length} dimension(s), ` +
    `${model.facts.reduce((n, f) => n + f.measures.length, 0)} measure(s)`,
  );
}
