/**
 * generate-queries-from-sml
 *
 * Reads an SML directory and generates two query JSON files, both compatible
 * with execute-atscale-query-harness:
 *
 *   --xmla-output-file  JSON array of XMLA (MDX) queries.
 *   --sql-output-file   JSON array of SQL queries.
 *
 * Coverage per file:
 *
 *   Metric totals — one query per metric with no dimensional breakdown.
 *   Level breakdowns — one query per hierarchy level across every dimension,
 *     selecting all model metrics broken down by that level.
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

class GenerateQueriesFromSMLParamsSet extends ParameterSet {
  parameters = [
    new (class extends StringParameter {
      name = "sml-dir";
      description =
        "Path to the SML directory (must contain models/, metrics/, dimensions/ sub-directories)";
      required = true;
    })(),
    new (class extends StringParameter {
      name = "model-name";
      description =
        "Model label or unique_name to use (defaults to the first model found)";
      required = false;
    })(),
    new (class extends StringParameter {
      name = "cube-name";
      description =
        "Override the cube name used in MDX FROM and SQL FROM clauses. " +
        "Defaults to the model label from the SML model file.";
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
  "sml-dir": string;
  "model-name"?: string;
  "cube-name"?: string;
  "xmla-output-file": string;
  "sql-output-file": string;
};
export type GenerateQueriesFromSMLParams = Params;

// ── Operation ──────────────────────────────────────────────────────────────────

export class GenerateQueriesFromSMLOperation extends Operation<Params> {
  name = "generate-queries-from-sml";
  description =
    "Read an SML directory and generate XMLA and SQL query JSON files " +
    "covering every metric (grand-total) and every hierarchy level " +
    "(per-level breakdown), compatible with execute-atscale-query-harness";
  parameters = new GenerateQueriesFromSMLParamsSet();

  constructor(services: ServiceRegistry, logger: Logger) {
    super(services, logger);
  }

  private readYamlDir(dir: string, yaml: YamlService): Map<string, any> {
    const result = new Map<string, any>();
    if (!fs.existsSync(dir)) return result;
    for (const file of fs.readdirSync(dir).sort()) {
      if (!file.endsWith(".yml") && !file.endsWith(".yaml")) continue;
      try {
        const parsed = yaml.readFromFile<any>(path.join(dir, file));
        result.set(path.basename(file, path.extname(file)), parsed);
      } catch (e) {
        this.logger.verbose(`Skipping ${file}: ${e}`);
      }
    }
    return result;
  }

  async run(params: Params): Promise<void> {
    const smlDir = path.resolve(params["sml-dir"]);
    if (!fs.existsSync(smlDir)) {
      throw new Error(`SML directory not found: ${smlDir}`);
    }

    const yaml = this.services.get<YamlService>("yaml");

    const modelsMap     = this.readYamlDir(path.join(smlDir, "models"),     yaml);
    const metricsMap    = this.readYamlDir(path.join(smlDir, "metrics"),    yaml);
    const dimensionsMap = this.readYamlDir(path.join(smlDir, "dimensions"), yaml);

    this.logger.info(
      `Loaded ${modelsMap.size} model(s), ${metricsMap.size} metric(s), ` +
      `${dimensionsMap.size} dimension(s)`,
    );

    // ── Select model ─────────────────────────────────────────────────────────
    let modelData: any;
    if (params["model-name"]) {
      for (const [, m] of modelsMap) {
        if (m.unique_name === params["model-name"] || m.label === params["model-name"]) {
          modelData = m;
          break;
        }
      }
      if (!modelData) {
        throw new Error(`Model "${params["model-name"]}" not found in ${smlDir}/models/`);
      }
    } else {
      const first = modelsMap.values().next();
      if (first.done) throw new Error(`No model files found in ${smlDir}/models/`);
      modelData = first.value;
    }

    const modelLabel: string = modelData.label ?? modelData.unique_name;
    const cubeName: string   = params["cube-name"]?.trim() || modelLabel;
    this.logger.info(`Model: ${modelLabel}  cube: ${cubeName}`);

    // ── Collect metrics in model order ────────────────────────────────────────
    const metricsLookup = new Map<string, any>();
    for (const [, m] of metricsMap) metricsLookup.set(m.unique_name, m);

    const metrics: MetricEntry[] = [];
    for (const ref of (modelData.metrics ?? [])) {
      const uniqueName: string = typeof ref === "string" ? ref : (ref.unique_name ?? "");
      const m = metricsLookup.get(uniqueName);
      if (!m) { this.logger.verbose(`Metric not found: ${uniqueName}`); continue; }
      metrics.push({ uniqueName, label: m.label ?? uniqueName });
    }

    if (metrics.length === 0) {
      throw new Error(`Model "${modelLabel}" has no metrics`);
    }
    this.logger.info(`  Metrics: ${metrics.length}`);

    // ── Collect hierarchy levels from all related dimensions ──────────────────
    const dimensionsLookup = new Map<string, any>();
    for (const [, d] of dimensionsMap) dimensionsLookup.set(d.unique_name, d);

    const relatedDimNames = new Set<string>(
      (modelData.relationships ?? [])
        .map((r: any) => r.to?.dimension)
        .filter(Boolean),
    );
    const allDimNames = [...relatedDimNames, ...(modelData.dimensions ?? [])];

    const levels: LevelEntry[] = [];

    for (const dimUniqueName of allDimNames) {
      const dim = dimensionsLookup.get(dimUniqueName);
      if (!dim) { this.logger.verbose(`Dimension not found: ${dimUniqueName}`); continue; }

      const dimLabel: string = dim.label ?? dimUniqueName;
      const laLookup = new Map<string, any>();
      for (const la of (dim.level_attributes ?? [])) laLookup.set(la.unique_name, la);

      for (const hier of (dim.hierarchies ?? [])) {
        const hierLabel: string = hier.label ?? hier.unique_name;
        for (const levelRef of (hier.levels ?? [])) {
          const la = laLookup.get(levelRef.unique_name);
          if (!la) continue;
          levels.push({
            dimLabel,
            hierLabel,
            levelLabel:      la.label ?? la.name_column,
            levelNameColumn: la.name_column,
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
