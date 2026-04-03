/**
 * GenerateNamespaceFromModel
 *
 * Reads a model.yaml file, reconstructs a SemanticModel from its mdx and sql
 * sections, runs the analysis-suggestions engine, and emits a namespace YAML
 * file that is ready for use with generate-tableau-from-namespace.
 *
 * Each AnalysisSuggestion maps to one worksheet:
 *   trend       → graphType: line  (measure over time)
 *   comparison  → graphType: line  (measure over time, colored by dimension)
 *   breakdown   → graphType: bar
 *   distribution→ graphType: bar
 *   ranking     → graphType: bar   (with limit: 10, sortDirection: desc)
 *
 * A "Summary Statistics" section of text (scorecard) worksheets is prepended
 * for up to six measures from the model.
 *
 * All worksheets are laid out in a single dashboard with category headers for
 * "Summary Statistics", "Trends", and "Rankings & Breakdowns".
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
import {
  INTEGER_TYPES,
  DECIMAL_TYPES,
  DATETIME_TYPES,
  reconstructSemanticModel,
  selectModel,
} from "../model-yaml-reader.js";

// ----------------------------------------------------------
// Parameters
// ----------------------------------------------------------

class GenerateNamespaceFromModelParams extends ParameterSet {
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
      name        = "title";
      description = "Title for the generated workbook (defaults to \"<ModelName> Analysis\")";
      required    = false;
    })(),
    new (class extends StringParameter {
      name        = "max-suggestions";
      description = "Maximum number of analysis suggestions to generate (default: 25)";
      required    = false;
      defaultValue = "25";
    })(),
    new (class extends StringParameter {
      name        = "min-score";
      description = "Minimum relevance score [0-1] for a suggestion to be included (default: 0.5)";
      required    = false;
      defaultValue = "0.5";
    })(),
    new (class extends StringParameter {
      name        = "output-file";
      description = "Output path for the namespace YAML (omit to print to stdout)";
      required    = false;
    })(),
  ];
}

type Params = {
  "model-file":         string;
  "model-name"?:        string;
  "title"?:             string;
  "max-suggestions":    string;
  "min-score":          string;
  "output-file"?:       string;
};

// ----------------------------------------------------------
// Local helpers (namespace-specific)
// ----------------------------------------------------------

/** Determine xAxisGranularity based on column data type. */
function granularityFor(dataType: string): string {
  return dataType === "DATE_DOUBLE" ? "day" : "week";
}

/** Embed the granularity word into a worksheet title.
 *  "Sum Errors Over Time" → "Sum Errors by Week"
 *  "Sum Errors by Host Over Time" → "Sum Errors by Host by Week"
 *  Titles without "Over Time" get " by <Gran>" appended.
 */
function titleWithGranularity(title: string, gran: string): string {
  const cap = gran.charAt(0).toUpperCase() + gran.slice(1);
  if (title.endsWith(" Over Time")) {
    return title.slice(0, -" Over Time".length) + ` by ${cap}`;
  }
  return `${title} by ${cap}`;
}

/** Determine a sensible format hint for a measure column. */
function formatFor(dataType: string): string | undefined {
  if (INTEGER_TYPES.has(dataType)) return "integer";
  if (DECIMAL_TYPES.has(dataType)) return "decimal:2";
  return undefined;
}

// ----------------------------------------------------------
// Namespace YAML builder
// ----------------------------------------------------------

/** Slugify a string into a valid YAML mapping key. */
function toSlug(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9\s_]/g, "")
    .trim()
    .replace(/\s+/g, "_")
    .slice(0, 60);
}

/** Return a deduplicating key-generation function. */
function makeKeyGen(): (title: string) => string {
  const seen = new Map<string, number>();
  return (title: string) => {
    const base = toSlug(title);
    const count = (seen.get(base) ?? 0) + 1;
    seen.set(base, count);
    return count === 1 ? base : `${base}_${count}`;
  };
}

function buildNamespace(
  modelName:  string,
  modelData:  Record<string, any>,
  suggestions: AnalysisSuggestion[],
  levelColMap: Map<string, Map<string, string>>,
  colTypeMap:  Map<string, string>,
  title:       string,
): Record<string, any> {
  const sqlColumns = ((modelData.sql ?? {}).columns ?? {}) as Record<string, any>;

  /** Resolve a level caption to its sql.columns key. */
  function resolveLevel(dimName: string, levelCaption: string): string {
    return levelColMap.get(dimName)?.get(levelCaption) ?? levelCaption;
  }

  /** Check whether a column is a time (date/datetime) column. */
  function isTimeColumn(colKey: string): boolean {
    const dt = colTypeMap.get(colKey) ?? sqlColumns[colKey]?.data_type ?? "";
    return DATETIME_TYPES.has(dt);
  }

  const keyGen = makeKeyGen();

  // ---- Text (scorecard) worksheets — one per measure, capped at 6 ----
  const textWs: Record<string, any>  = {};
  let scoreCardCount = 0;

  for (const [, col] of Object.entries(sqlColumns)) {
    const c = col as any;
    if (c.role !== "measure") continue;
    if (scoreCardCount >= 6) break;
    scoreCardCount++;

    const ws: Record<string, any> = {
      title:       c.label ?? c.name,
      model:       modelName,
      graphType:   "text",
      measures:    [c.name],
      description: `Summary statistic: ${c.label ?? c.name}`,
    };
    const fmt = formatFor(c.data_type ?? "");
    if (fmt) ws.format = fmt;
    textWs[keyGen(c.label ?? c.name)] = ws;
  }

  // ---- Line and bar worksheets from suggestions ----
  const lineWs: Record<string, any> = {};
  const barWs:  Record<string, any> = {};

  for (const s of suggestions) {
    const measureCol = s.measure.sourceColumn;

    if (s.analysisType === "trend") {
      // measure over a single time hierarchy
      const hier      = s.hierarchies[0];
      const timeLevel = resolveLevel(hier.dimensionName, hier.levels[0]);
      const gran      = granularityFor(colTypeMap.get(timeLevel) ?? "DATETIME");
      const wsTitle   = titleWithGranularity(s.title, gran);
      const ws: Record<string, any> = {
        title:             wsTitle,
        model:             modelName,
        graphType:         "line",
        xAxis:             timeLevel,
        xAxisGranularity:  gran,
        yAxis:             measureCol,
        description:       s.description,
      };
      lineWs[keyGen(wsTitle)] = ws;

    } else if (s.analysisType === "comparison") {
      // measure over time, broken down by a second dimension
      const timeHier  = s.hierarchies.find((h) => {
        const col = resolveLevel(h.dimensionName, h.levels[0]);
        return isTimeColumn(col);
      }) ?? s.hierarchies[0];

      const otherHier = s.hierarchies.find((h) => h !== timeHier);
      const timeLevel = resolveLevel(timeHier.dimensionName, timeHier.levels[0]);
      const gran      = granularityFor(colTypeMap.get(timeLevel) ?? "DATETIME");
      const wsTitle   = titleWithGranularity(s.title, gran);

      const ws: Record<string, any> = {
        title:             wsTitle,
        model:             modelName,
        graphType:         "line",
        xAxis:             timeLevel,
        xAxisGranularity:  gran,
        yAxis:             measureCol,
        description:       s.description,
      };
      if (otherHier) {
        ws.colorField = resolveLevel(otherHier.dimensionName, otherHier.levels[0]);
      }
      lineWs[keyGen(wsTitle)] = ws;

    } else {
      // breakdown, distribution, ranking → bar chart
      const primaryHier  = s.hierarchies[0];
      const primaryLevel = resolveLevel(primaryHier.dimensionName, primaryHier.levels[0]);

      const ws: Record<string, any> = {
        title:       s.title,
        model:       modelName,
        graphType:   "bar",
        xAxis:       measureCol,
        yAxis:       primaryLevel,
        description: s.description,
      };
      if (s.analysisType === "ranking") {
        ws.limit          = 10;
        ws.sortDirection  = "desc";
      }
      if (s.hierarchies.length > 1) {
        const secondHier = s.hierarchies[1];
        ws.colorField = resolveLevel(secondHier.dimensionName, secondHier.levels[0]);
      }
      barWs[keyGen(s.title)] = ws;
    }
  }

  const worksheets = { ...textWs, ...lineWs, ...barWs };

  // ---- Dashboard layout ----
  const HEADER_ROWS      = 1;
  const TEXT_ROWS_EACH   = 2;
  const TEXT_COLS        = 3;
  const CHART_ROWS_EACH  = 5;

  const textKeys  = Object.keys(textWs);
  const lineKeys  = Object.keys(lineWs);
  const barKeys   = Object.keys(barWs);

  const categoryHeaders: any[] = [];
  const tiles: any[]           = [];
  let   y = 0;

  // Summary Statistics
  if (textKeys.length > 0) {
    categoryHeaders.push({ label: "Summary Statistics", x: 0, y, colSpan: 3, rowSpan: 1 });
    y += HEADER_ROWS;

    for (let i = 0; i < textKeys.length; i++) {
      tiles.push({
        worksheet: textKeys[i],
        x:         i % TEXT_COLS,
        y:         y + Math.floor(i / TEXT_COLS) * TEXT_ROWS_EACH,
        colSpan:   1,
        rowSpan:   TEXT_ROWS_EACH,
        category:  "Summary Statistics",
      });
    }
    y += Math.ceil(textKeys.length / TEXT_COLS) * TEXT_ROWS_EACH;
  }

  // Trends
  if (lineKeys.length > 0) {
    categoryHeaders.push({ label: "Trends", x: 0, y, colSpan: 3, rowSpan: 1 });
    y += HEADER_ROWS;

    for (let i = 0; i < lineKeys.length; i++) {
      tiles.push({
        worksheet: lineKeys[i],
        x:         0,
        y:         y + i * CHART_ROWS_EACH,
        colSpan:   3,
        rowSpan:   CHART_ROWS_EACH,
        category:  "Trends",
      });
    }
    y += lineKeys.length * CHART_ROWS_EACH;
  }

  // Rankings & Breakdowns
  if (barKeys.length > 0) {
    categoryHeaders.push({ label: "Rankings & Breakdowns", x: 0, y, colSpan: 3, rowSpan: 1 });
    y += HEADER_ROWS;

    for (let i = 0; i < barKeys.length; i++) {
      tiles.push({
        worksheet: barKeys[i],
        x:         0,
        y:         y + i * CHART_ROWS_EACH,
        colSpan:   3,
        rowSpan:   CHART_ROWS_EACH,
        category:  "Rankings & Breakdowns",
      });
    }
    y += barKeys.length * CHART_ROWS_EACH;
  }

  const vSegments   = Math.max(y, 5);
  const totalHeight = vSegments * 100;

  const dashboardKey = toSlug(modelName) + "_dashboard";
  const dashboard: Record<string, any> = {
    [dashboardKey]: {
      title:       `${title} Dashboard`,
      description: `Auto-generated dashboard for ${modelName}`,
      size: {
        width:     1800,
        height:    totalHeight,
        hSegments: 3,
        vSegments,
      },
      ...(categoryHeaders.length > 0 ? { categoryHeaders } : {}),
      tiles,
    },
  };

  return {
    version:     1,
    title,
    description: `Auto-generated analysis namespace for the ${modelName} model`,
    worksheets,
    dashboards:  dashboard,
  };
}

// ----------------------------------------------------------
// Operation
// ----------------------------------------------------------

export class GenerateNamespaceFromModelOperation extends Operation<Params> {
  name        = "generate-namespace-from-model";
  description = "Generate a namespace YAML from a model.yaml file using analysis suggestions";
  parameters  = new GenerateNamespaceFromModelParams();

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
    const { model, levelColMap, colTypeMap } =
      reconstructSemanticModel(modelName, modelData);

    this.logger.info(
      `Reconstructed SemanticModel: ${model.facts[0].measures.length} measure(s), ` +
      `${model.dimensions.length} dimension(s)`,
    );

    // ---- Run analysis suggestions ----
    const maxSuggestions = Math.max(1, parseInt(params["max-suggestions"] ?? "25", 10) || 25);
    const minScore       = Math.min(1, Math.max(0, parseFloat(params["min-score"] ?? "0.5") || 0.5));

    const suggestions = generateAnalysisSuggestions(model, {
      maxSuggestions,
      minRelevanceScore: minScore,
      includeTuples:     true,
      includeTriples:    false,
    });

    this.logger.info(`Generated ${suggestions.length} suggestion(s)`);

    // ---- Build namespace YAML ----
    const title     = params.title ?? `${modelName} Analysis`;
    const namespace = buildNamespace(
      modelName,
      modelData,
      suggestions,
      levelColMap,
      colTypeMap,
      title,
    );

    const wsCount   = Object.keys(namespace.worksheets ?? {}).length;
    this.logger.info(`Namespace contains ${wsCount} worksheet(s)`);

    // ---- Write output ----
    if (params["output-file"]?.trim()) {
      yaml.saveToFile(params["output-file"], namespace);
      this.logger.info(`Wrote namespace to ${params["output-file"]}`);
    } else {
      this.logger.log(stringify(namespace, { lineWidth: 0 }));
    }
  }
}
