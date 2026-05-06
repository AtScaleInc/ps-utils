/**
 * GenerateSharedModelPlan
 *
 * Analyses one or more SML output directories to identify opportunities for
 * sharing or reusing dimensions, datasets, and model structures across
 * projects.  Uses Jaccard-based fuzzy subtree matching to compute similarity
 * scores and generates:
 *
 *   <output-dir>/RECOMMENDATION.md   — human-readable options with diagrams,
 *                                      change lists, and pros/cons
 *   <output-dir>/option-N-<kind>.yml — machine-readable change instructions
 *                                      for each option (one file per option)
 */
import fs from "fs";
import path from "path";
import { Operation } from "../Operation.js";
import { ParameterSet, StringParameter, NumberParameter } from "../../Parameters.js";
import type { ServiceRegistry } from "../../services/registry.js";
import type { Logger } from "../../logging.js";
import { loadSmlProject } from "./sml-loader.js";
import { analyzeProjects } from "./similarity.js";
import {
  buildAllOptions,
  renderRecommendationMarkdown,
  renderOptionYaml,
} from "./plan-generator.js";

// ----------------------------------------------------------
// Parameter declarations
// ----------------------------------------------------------

class GenerateSharedModelPlanParamsSet extends ParameterSet {
  parameters = [
    new (class extends StringParameter {
      name        = "input-dirs";
      description = "Comma-separated list of SML output directories to analyse (at least one required)";
      required    = true;
    })(),
    new (class extends StringParameter {
      name        = "output-dir";
      description = "Directory where RECOMMENDATION.md and option YAML files will be written";
      required    = true;
    })(),
    new (class extends NumberParameter {
      name         = "threshold";
      description  = "Similarity threshold 0–1; lower values surface more options (default 0.5)";
      required     = false;
      defaultValue = 0.5;
    })(),
    new (class extends NumberParameter {
      name         = "max-per-subject";
      description  = "Maximum number of recommendations to emit per subject entity (dataset, dimension, or model pair); prevents flooding the output with near-duplicate options for the same entity (default 3)";
      required     = false;
      defaultValue = 3;
    })(),
  ];
}

type Params = {
  "input-dirs":       string;
  "output-dir":       string;
  "threshold"?:       number;
  "max-per-subject"?: number;
};
export type GenerateSharedModelPlanParams = Params;

// ----------------------------------------------------------
// Operation
// ----------------------------------------------------------

export class GenerateSharedModelPlanOperation extends Operation<Params> {
  name        = "generate-shared-model-plan";
  description = "Analyse SML directories for sharing opportunities and generate a refactoring recommendation plan";
  parameters  = new GenerateSharedModelPlanParamsSet();

  constructor(services: ServiceRegistry, logger: Logger) {
    super(services, logger);
  }

  async run(params: Params): Promise<void> {
    const threshold     = params["threshold"] ?? 0.5;
    const maxPerSubject = params["max-per-subject"] ?? 3;
    const outputDir     = path.resolve(params["output-dir"]);

    // Parse and resolve input directories
    const inputDirs = params["input-dirs"]
      .split(",")
      .map((d) => d.trim())
      .filter((d) => d.length > 0)
      .map((d) => path.resolve(d));

    if (inputDirs.length === 0) {
      throw new Error("--input-dirs must contain at least one directory path");
    }

    for (const dir of inputDirs) {
      if (!fs.existsSync(dir)) {
        throw new Error(`Input directory not found: ${dir}`);
      }
    }

    if (inputDirs.length === 1) {
      this.logger.log(
        "[GenerateSharedModelPlan] Warning: only one input directory provided. " +
        "Cross-catalog comparison requires at least two directories. " +
        "Analysing for within-catalog reuse only.",
      );
    }

    // Load all projects
    this.logger.log(`[GenerateSharedModelPlan] Loading ${inputDirs.length} SML project(s)…`);
    const projects = inputDirs.map((dir) => {
      const project = loadSmlProject(dir);
      this.logger.log(
        `  ${project.label}: ` +
        `${project.dimensions.size} dim(s), ${project.datasets.size} dataset(s), ` +
        `${project.metrics.size} metric(s), ${project.models.size} model(s)`,
      );
      return project;
    });

    // Run similarity analysis
    this.logger.log(`[GenerateSharedModelPlan] Analysing with threshold=${threshold}…`);
    const analysis = analyzeProjects(projects, threshold);
    this.logger.log(
      `  ${analysis.dimPairs.length} dimension pair(s), ` +
      `${analysis.datasetPairs.length} dataset pair(s), ` +
      `${analysis.modelPairs.length} model pair(s) above threshold`,
    );

    // Build plan options
    const options = buildAllOptions(analysis, projects, threshold, maxPerSubject);
    this.logger.log(`[GenerateSharedModelPlan] Generated ${options.length} option(s)`);

    // Ensure output directory exists
    fs.mkdirSync(outputDir, { recursive: true });

    // Write RECOMMENDATION.md
    const mdPath = path.join(outputDir, "RECOMMENDATION.md");
    const mdContent = renderRecommendationMarkdown(options, projects, threshold, inputDirs);
    fs.writeFileSync(mdPath, mdContent, "utf8");
    this.logger.log(`[GenerateSharedModelPlan] Wrote: ${mdPath}`);

    // Write one YAML file per option
    for (let i = 0; i < options.length; i++) {
      const opt      = options[i];
      const safeName = opt.kind.replace(/[^a-z0-9-]/gi, "-").toLowerCase();
      const yamlFile = `option-${i + 1}-${safeName}.yml`;
      const yamlPath = path.join(outputDir, yamlFile);
      fs.writeFileSync(yamlPath, renderOptionYaml(opt, threshold), "utf8");
      this.logger.log(`[GenerateSharedModelPlan] Wrote: ${yamlPath}`);
    }

    this.logger.log(
      `\n[GenerateSharedModelPlan] Done — ` +
      `${options.length} option(s) written to ${outputDir}`,
    );
  }
}
