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
import { Operation } from "../Operation.js";
import { ParameterSet, StringParameter } from "../../Parameters.js";
import type { ServiceRegistry } from "../../services/registry.js";
import type { Logger } from "../../logging.js";
import { YamlService } from "../../services/YamlService.js";
import {
  generateAnalysisSuggestions,
  type AnalysisSuggestion,
} from "../../algorithm/analysis-suggestions.js";
import { stringify } from "yaml";
import fs from "fs";
import {
  reconstructSemanticModel,
  selectModel,
} from "../model-yaml-reader.js";

// ----------------------------------------------------------
// Parameters
// ----------------------------------------------------------

class GenerateMetricsFromModelParams extends ParameterSet {
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
      name         = "max-suggestions";
      description  = "Maximum number of suggestions to generate (default: 25)";
      required     = false;
      defaultValue = "25";
    })(),
    new (class extends StringParameter {
      name         = "min-score";
      description  = "Minimum relevance score [0-1] for a suggestion to be included (default: 0.5)";
      required     = false;
      defaultValue = "0.5";
    })(),
    new (class extends StringParameter {
      name         = "include-tuples";
      description  = "Include multi-dimension suggestions (true/false, default: true)";
      required     = false;
      defaultValue = "true";
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
  "max-suggestions":  string;
  "min-score":        string;
  "include-tuples":   string;
  "format":           string;
  "output-file"?:     string;
};

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
  parameters  = new GenerateMetricsFromModelParams();

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

    // ---- Parse options ----
    const maxSuggestions  = Math.max(1, parseInt(params["max-suggestions"] ?? "25", 10) || 25);
    const minScore        = Math.min(1, Math.max(0, parseFloat(params["min-score"] ?? "0.5") || 0.5));
    const includeTuples   = (params["include-tuples"] ?? "true").toLowerCase() !== "false";
    const outputFormat    = (params["format"] ?? "text").toLowerCase();

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
    if (params["output-file"]?.trim()) {
      fs.writeFileSync(params["output-file"], output, "utf8");
      this.logger.info(`Wrote suggestions to ${params["output-file"]}`);
    } else {
      this.logger.log(output);
    }
  }
}
