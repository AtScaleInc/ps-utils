/**
 * GenerateMetricsFromModel
 *
 * Reads a model.yaml file, reconstructs a SemanticModel from its mdx and sql
 * sections, and runs the analysis-suggestions engine to produce a ranked list
 * of suggested metric × dimension combinations.
 *
 * Output formats:
 *   text (default) — human-readable numbered list printed to stdout or a file
 *   yaml           — structured YAML suitable for downstream processing
 */
import path from "path";
import fs from "fs";
import { Operation } from "../Operation.js";
import { ParameterSet, StringParameter, NumberParameter, BooleanParameter } from "../../Parameters.js";
import type { ServiceRegistry } from "../../services/registry.js";
import type { Logger } from "../../logging.js";
import { YamlService } from "../../services/YamlService.js";
import {
  generateAnalysisSuggestions,
  type AnalysisSuggestion,
} from "../../algorithm/analysis-suggestions.js";
import { stringify } from "yaml";
import {
  reconstructSemanticModel,
  selectModel,
} from "../model-yaml-reader.js";
import { loadSmlStyleConfig, mergeSmlStyle, writeSmlStyleConfig } from "../sml-style-config.js";

// ----------------------------------------------------------
// Parameters
// ----------------------------------------------------------

class GenerateMetricsFromModelParamsSet extends ParameterSet {
  parameters = [
    new (class extends StringParameter {
      name        = "model-file";
      description = "Path to the model.yaml file produced by extract-model-from-atscale or extract-model-from-sml";
      required    = true;
    })(),
    new (class extends StringParameter {
      name        = "model-name";
      description = "Model name to use when model.yaml contains multiple models (defaults to first)";
      required    = false;
    })(),
    new (class extends StringParameter {
      name        = "sml-config-file";
      description = 'Path to the SML style configuration file (default: "sml.style.yaml"). Style file values are overridden by CLI flags. The effective settings are written to sml.style.yaml in the output file\'s directory (or the working directory when writing to stdout).';
      required    = false;
      defaultValue = "sml.style.yaml";
    })(),
    new (class extends NumberParameter {
      name        = "max-suggestions";
      description = "Maximum number of suggestions to generate (default: 25). Can also be set in sml.style.yaml.";
      required    = false;
    })(),
    new (class extends NumberParameter {
      name        = "min-score";
      description = "Minimum relevance score [0-1] for a suggestion to be included (default: 0.5). Can also be set in sml.style.yaml.";
      required    = false;
    })(),
    new (class extends BooleanParameter {
      name        = "include-tuples";
      description = "Include multi-dimension suggestions (default: true). Can also be set in sml.style.yaml.";
      required    = false;
    })(),
    new (class extends StringParameter {
      name        = "format";
      description = "Output format: text (default) or yaml";
      required    = false;
      defaultValue = "text";
    })(),
    new (class extends StringParameter {
      name        = "output-file";
      description = "Output path (omit to print to stdout)";
      required    = false;
    })(),
  ];
}

type Params = {
  "model-file":       string;
  "model-name"?:      string;
  "sml-config-file":  string;
  "max-suggestions"?: number;
  "min-score"?:       number;
  "include-tuples"?:  boolean;
  "format":           string;
  "output-file"?:     string;
};
export type GenerateMetricsFromModelParams = Params;

// ----------------------------------------------------------
// Text formatter
// ----------------------------------------------------------

function formatText(suggestions: AnalysisSuggestion[], modelName: string): string {
  const lines: string[] = [
    `Suggested metrics for model: ${modelName}`,
    `${"─".repeat(60)}`,
    "",
  ];

  for (let i = 0; i < suggestions.length; i++) {
    const s = suggestions[i];
    const scoreStr = (s.relevanceScore * 100).toFixed(0).padStart(3);
    lines.push(`${String(i + 1).padStart(3)}. [${scoreStr}%] ${s.title}`);
    lines.push(`      Type:     ${s.analysisType}`);
    lines.push(`      Measure:  ${s.measure.measureName} (${s.measure.aggregation})`);
    if (s.hierarchies.length > 0) {
      const dims = s.hierarchies.map((h) => `${h.dimensionName} → ${h.hierarchyName}`).join(", ");
      lines.push(`      By:       ${dims}`);
    }
    lines.push(`      ${s.description}`);
    if (s.tags.length > 0) {
      lines.push(`      Tags:     ${s.tags.join(", ")}`);
    }
    lines.push("");
  }

  if (suggestions.length === 0) {
    lines.push("No suggestions met the minimum relevance threshold.");
  }

  return lines.join("\n");
}

// ----------------------------------------------------------
// YAML formatter
// ----------------------------------------------------------

function formatYaml(suggestions: AnalysisSuggestion[], modelName: string): string {
  const output = {
    model: modelName,
    suggestion_count: suggestions.length,
    suggestions: suggestions.map((s, i) => ({
      rank:           i + 1,
      title:          s.title,
      description:    s.description,
      analysis_type:  s.analysisType,
      relevance_score: Math.round(s.relevanceScore * 100) / 100,
      measure: {
        fact:         s.measure.factName,
        name:         s.measure.measureName,
        source_column: s.measure.sourceColumn,
        aggregation:  s.measure.aggregation,
      },
      dimensions: s.hierarchies.map((h) => ({
        dimension:  h.dimensionName,
        hierarchy:  h.hierarchyName,
        levels:     h.levels,
      })),
      tags: s.tags,
    })),
  };
  return stringify(output, { lineWidth: 0 });
}

// ----------------------------------------------------------
// Operation
// ----------------------------------------------------------

export class GenerateMetricsFromModelOperation extends Operation<Params> {
  name        = "generate-metrics-from-model";
  description = "Generate ranked metric suggestions from a model.yaml file using the analysis-suggestions engine";
  parameters  = new GenerateMetricsFromModelParamsSet();

  constructor(services: ServiceRegistry, logger: Logger) {
    super(services, logger);
  }

  async run(params: Params): Promise<void> {
    const yaml = this.services.get<YamlService>("yaml");

    // ---- Load model.yaml ----
    this.logger.info(`Reading model file: ${params["model-file"]}`);
    const modelFile = yaml.readFromFile<Record<string, any>>(params["model-file"]);

    // ---- Select model ----
    const { modelName, modelData } = selectModel(
      modelFile,
      params["model-name"],
      params["model-file"],
    );
    this.logger.info(`Using model: ${modelName}`);

    // ---- Reconstruct SemanticModel ----
    const { model } = reconstructSemanticModel(modelName, modelData);
    this.logger.info(
      `Reconstructed SemanticModel: ${model.facts[0].measures.length} measure(s), ` +
      `${model.dimensions.length} dimension(s)`,
    );

    // ---- Merge CLI params + sml.style.yaml ----
    const styleFileConfig = loadSmlStyleConfig(params["sml-config-file"]);
    const style = mergeSmlStyle(
      {
        "max-suggestions": params["max-suggestions"],
        "min-score":       params["min-score"],
        "include-tuples":  params["include-tuples"],
      },
      styleFileConfig,
    );

    const maxSuggestions = Math.max(1, style["max-suggestions"]);
    const minScore       = Math.min(1, Math.max(0, style["min-score"]));
    const includeTuples  = style["include-tuples"];
    const outputFormat   = (params["format"] ?? "text").toLowerCase();

    // ---- Run analysis suggestions ----
    const suggestions = generateAnalysisSuggestions(model, {
      maxSuggestions,
      minRelevanceScore: minScore,
      includeTuples,
      includeTriples:    false,
    });
    this.logger.info(`Generated ${suggestions.length} suggestion(s)`);

    // ---- Format output ----
    const output = outputFormat === "yaml"
      ? formatYaml(suggestions, modelName)
      : formatText(suggestions, modelName);

    // ---- Write output ----
    const outputFile = params["output-file"]?.trim() || undefined;
    if (outputFile) {
      fs.writeFileSync(outputFile, output, "utf8");
      this.logger.info(`Wrote suggestions to ${outputFile}`);
    } else {
      this.logger.log(output);
    }

    // ---- Write effective style config ----
    const styleDir = outputFile ? path.dirname(path.resolve(outputFile)) : process.cwd();
    const styleConfigPath = path.join(styleDir, "sml.style.yaml");
    writeSmlStyleConfig(styleConfigPath, {
      "max-suggestions": maxSuggestions,
      "min-score":       minScore,
      "include-tuples":  includeTuples,
    });
    this.logger.info(`Wrote style config to ${styleConfigPath}`);
  }
}
