/**
 * Shared helpers for the generate-sml-from-ddl and generate-sml-from-connection
 * operations.  Extracts the three pieces of logic that are identical in both:
 *
 *   resolvePiiSeverity  — normalise the --pii-severity CLI parameter
 *   writeSmlFiles       — write a Map<relativePath, yaml> to disk
 *   runInferenceAndWrite — call proposeSemanticModel, log warnings,
 *                          write SML files, and log a summary
 */
import fs from "fs";
import path from "path";
import type { Logger } from "../logging.js";
import type { JdbcDatabaseMetaData } from "../algorithm/types.js";
import type { ProposeOptions } from "../algorithm/jdbc-semantic-model.js";
import { proposeSemanticModel } from "../algorithm/jdbc-semantic-model.js";
import { createDefaultEngine } from "../algorithm/inference/index.js";

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
 * `outputDir`, and log warnings + a summary.
 *
 * @param tag  Short identifier used in log prefixes, e.g. "GenerateSMLFromDDL".
 */
export async function runInferenceAndWrite(
  db: JdbcDatabaseMetaData,
  modelName: string,
  options: InferenceOptions,
  outputDir: string,
  logger: Logger,
  tag: string,
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

  logger.log(
    `[${tag}] Done — ` +
    `${model.facts.length} fact(s), ` +
    `${model.dimensions.length} dimension(s), ` +
    `${model.facts.reduce((n, f) => n + f.measures.length, 0)} measure(s)`,
  );
}
