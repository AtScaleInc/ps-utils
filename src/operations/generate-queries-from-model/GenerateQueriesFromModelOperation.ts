/**
 * generate-queries-from-model
 *
 * Reads a model.yaml file (produced by extract-model-from-atscale or
 * extract-model-from-sml) and generates two query JSON files, both compatible
 * with execute-atscale-query-harness:
 *
 *   --xmla-output-file  JSON array of XMLA (MDX) queries.
 *   --sql-output-file   JSON array of SQL queries.
 *
 * Coverage per file:
 *
 *   Metric totals — one query per metric entry in mdx.metrics with no
 *     dimensional breakdown.
 *   Level breakdowns — one query per level across every hierarchy in
 *     mdx.attributes, selecting all metrics broken down by that level.
 *
 * Query generation is delegated to generate-queries-shared.ts.
 */
import { Operation } from "../Operation.js";
import { ParameterSet, StringParameter } from "../../Parameters.js";
import type { ServiceRegistry } from "../../services/registry.js";
import type { Logger } from "../../logging.js";
import { YamlService } from "../../services/YamlService.js";
import {
  type MetricEntry,
  type LevelEntry,
  buildQueryPairs,
  writeQueryFiles,
} from "../generate-queries-shared.js";
import fs from "fs";
import path from "path";

// ── Parameter set ──────────────────────────────────────────────────────────────

class GenerateQueriesFromModelParamsSet extends ParameterSet {
  parameters = [
    new (class extends StringParameter {
      name = "model-file";
      description =
        "Path to the model.yaml file (output of extract-model-from-atscale or extract-model-from-sml)";
      required = true;
    })(),
    new (class extends StringParameter {
      name = "model-name";
      description =
        "Top-level model key to use when model.yaml contains multiple models. " +
        "Defaults to the first model found.";
      required = false;
    })(),
    new (class extends StringParameter {
      name = "cube-name";
      description =
        "Override the cube name used in MDX FROM and SQL FROM clauses. " +
        "Defaults to the model name (top-level key).";
      required = false;
    })(),
    new (class extends StringParameter {
      name = "xmla-output-file";
      description = "Path to write the XMLA (MDX) query JSON file";
      required = true;
    })(),
    new (class extends StringParameter {
      name = "sql-output-file";
      description = "Path to write the SQL query JSON file";
      required = true;
    })(),
  ];
}

type Params = {
  "model-file": string;
  "model-name"?: string;
  "cube-name"?: string;
  "xmla-output-file": string;
  "sql-output-file": string;
};
export type GenerateQueriesFromModelParams = Params;

// ── Operation ──────────────────────────────────────────────────────────────────

export class GenerateQueriesFromModelOperation extends Operation<Params> {
  name = "generate-queries-from-model";
  description =
    "Read a model.yaml file and generate XMLA and SQL query JSON files " +
    "covering every metric (grand-total) and every hierarchy level " +
    "(per-level breakdown), compatible with execute-atscale-query-harness";
  parameters = new GenerateQueriesFromModelParamsSet();

  constructor(services: ServiceRegistry, logger: Logger) {
    super(services, logger);
  }

  async run(params: Params): Promise<void> {
    const modelFilePath = path.resolve(params["model-file"]);
    if (!fs.existsSync(modelFilePath)) {
      throw new Error(`Model file not found: ${modelFilePath}`);
    }

    const yaml = this.services.get<YamlService>("yaml");
    const modelFile = yaml.readFromFile<Record<string, any>>(modelFilePath);

    // ── Select model ─────────────────────────────────────────────────────────
    const modelKeys = Object.keys(modelFile);
    if (modelKeys.length === 0) {
      throw new Error(`No models found in ${modelFilePath}`);
    }

    let modelName: string;
    if (params["model-name"]) {
      if (!modelFile[params["model-name"]]) {
        throw new Error(
          `Model "${params["model-name"]}" not found in ${modelFilePath}. ` +
          `Available: ${modelKeys.join(", ")}`,
        );
      }
      modelName = params["model-name"];
    } else {
      modelName = modelKeys[0];
    }

    const modelData = modelFile[modelName];
    const cubeName: string = params["cube-name"]?.trim() || modelName;
    this.logger.info(`Model: ${modelName}  cube: ${cubeName}`);

    // ── Extract metrics from mdx.metrics ─────────────────────────────────────
    // Each entry: { query_name, caption, agg_type_string, ... }
    const metrics: MetricEntry[] = [];
    for (const m of (modelData.mdx?.metrics ?? [])) {
      if (!m.query_name) continue;
      metrics.push({
        uniqueName: m.query_name,
        label:      m.caption ?? m.query_name,
      });
    }

    if (metrics.length === 0) {
      throw new Error(`Model "${modelName}" has no metrics in mdx.metrics`);
    }
    this.logger.info(`  Metrics: ${metrics.length}`);

    // ── Extract hierarchy levels from mdx.attributes ──────────────────────────
    // Structure: attributes[dimLabel][hierLabel] = [{ query_name, caption, level_number }]
    const levels: LevelEntry[] = [];
    const attributes: Record<string, Record<string, any[]>> = modelData.mdx?.attributes ?? {};

    for (const dimLabel of Object.keys(attributes)) {
      const hierarchies = attributes[dimLabel];
      for (const hierLabel of Object.keys(hierarchies)) {
        const levelArray: any[] = hierarchies[hierLabel] ?? [];
        // Sort by level_number so levels are added broadest → most granular
        const sorted = [...levelArray].sort((a, b) => (a.level_number ?? 0) - (b.level_number ?? 0));
        for (const lvl of sorted) {
          if (!lvl.query_name) continue;
          levels.push({
            dimLabel,
            hierLabel,
            levelLabel:      lvl.caption ?? lvl.query_name,
            levelNameColumn: lvl.query_name,
          });
        }
      }
    }

    this.logger.info(`  Hierarchy levels: ${levels.length}`);

    // ── Generate and write ────────────────────────────────────────────────────
    const { xmlaQueries, sqlQueries } = buildQueryPairs(metrics, levels, cubeName);

    this.logger.info(
      `Generated ${xmlaQueries.length} XMLA and ${sqlQueries.length} SQL queries ` +
      `(${metrics.length} metric totals + ${levels.length} level breakdowns each)`,
    );

    writeQueryFiles(
      xmlaQueries, sqlQueries,
      path.resolve(params["xmla-output-file"]),
      path.resolve(params["sql-output-file"]),
      this.logger,
    );
  }
}
