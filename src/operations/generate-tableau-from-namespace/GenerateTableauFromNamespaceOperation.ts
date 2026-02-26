/**
 * Generate Tableau workbooks from namespace and model YAML inputs.
 */
import { StringParameter } from "../Parameters.js";
import { TemplateOperation, TemplateOperationParams, TemplateParameterSet } from "../template/TemplateOperation.js";
import type { ServiceRegistry } from "../../services/registry.js";
import type { Logger } from "../../logging.js";
import { YamlService } from "../../services/YamlService.js";
import { EjsTemplateService } from "../../services/EjsTemplateService.js";
import fs from "fs";
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);


class GenerateTableauParameterSet extends TemplateParameterSet {
  parameters = [
    ...this.baseParameters(),
    new (class extends StringParameter {
      name = "tableau-version";
      description = "The target version of tableau";
      required = false;
      defaultValue = "2025";

      validate(value: string): void {
        if (value !== "2025" && value !== "2024") {
          throw new Error("tableau-version must be 2025 or 2024");
        }
      }
    })(),
    new (class extends StringParameter {
      name = "target-file";
      description = "Target file to output the workbook";
      required = false;
      defaultValue = "tableau.twb";
    })(),
  ];
}

type GenerateTableauParams = TemplateOperationParams & {
  "tableau-version": string;
};

/**
 * Stub operation to generate Tableau workbook from a namespace.
 */
export class GenerateTableauFromNamespaceOperation extends TemplateOperation<GenerateTableauParams> {
  name = "generate-tableau-from-namespace";
  description = "Generate a Tableau workbook from a namespace (stub)";
  parameters = new GenerateTableauParameterSet();

  constructor(services: ServiceRegistry, logger: Logger) {
    super(services, logger);
  }

  run(params: GenerateTableauParams): void {
    const yaml = this.services.get<YamlService>("yaml");
    const ejs = this.services.get<EjsTemplateService>("ejs");

    const modelFile = params["model-file"] ?? "model.yaml";
    const connectionFile = params["connection-file"] ?? "connections.yaml";
    const targetFile = params["target-file"] ?? "tableau.twb";
    const version = params["tableau-version"];

    this.logger.verbose(`Reading model file: ${modelFile}`);
    const modelData = yaml.readFromFile<Record<string, unknown>>(modelFile);

    this.logger.verbose(`Reading connection file: ${connectionFile}`);
    const connectionData = yaml.readFromFile<Record<string, unknown>>(connectionFile);

    this.logger.verbose("Reading overview namespace: " + params.namespace);
    const overviewData = yaml.readFromFile<Record<string, unknown>>(params.namespace);

    const templatePath = `${__dirname}/tableau.${version}.twb.ejs`;
    this.logger.verbose(`Reading EJS template: ${templatePath}`);
    const template = fs.readFileSync(templatePath, "utf8");

    try  {
      const models = modelData as Record<string, any>;
      const namespace = this.sanitizeNamespace(overviewData as Record<string, any>, models);

      const output = ejs.render(template, {
        models,
        connections: connectionData,
        namespace,
      });
      fs.writeFileSync(targetFile, output, "utf8");
      this.logger.info(`Wrote Tableau workbook to ${targetFile}`);
    } catch (error) {
      this.logger.error(`Failed to generate Tableau workbook: ${error}`);
    }
  }

  private sanitizeNamespace(
    namespace: Record<string, any>,
    models: Record<string, any>
  ): Record<string, any> {
    if (!namespace.worksheets || typeof namespace.worksheets !== "object") {
      return namespace;
    }

    const sanitizedWorksheets: Record<string, any> = {};
    for (const [name, worksheet] of Object.entries(namespace.worksheets)) {
      if (!worksheet || typeof worksheet !== "object") {
        this.logger.verbose(`Skipping worksheet ${name}: invalid definition.`);
        continue;
      }
      const worksheetObj = worksheet as Record<string, any>;
      const modelName = worksheetObj.model;
      const columns = models?.[modelName]?.sql?.columns;
      if (!columns) {
        this.logger.verbose(`Skipping worksheet ${name}: model ${modelName} not found.`);
        continue;
      }

      const nextWorksheet = { ...worksheetObj };

      if (Array.isArray(nextWorksheet.measures)) {
        const filtered = nextWorksheet.measures.filter((measure: string) => {
          if (columns[measure]) return true;
          this.logger.verbose(`Missing measure ${measure} for worksheet ${name}, dropping.`);
          return false;
        });
        nextWorksheet.measures = filtered;
      }

      if (nextWorksheet.xAxis && !columns[nextWorksheet.xAxis]) {
        this.logger.verbose(`Missing xAxis ${nextWorksheet.xAxis} for worksheet ${name}, dropping.`);
        continue;
      }
      if (nextWorksheet.yAxis && !columns[nextWorksheet.yAxis]) {
        this.logger.verbose(`Missing yAxis ${nextWorksheet.yAxis} for worksheet ${name}, dropping.`);
        continue;
      }

      if (Array.isArray(nextWorksheet.measures) && nextWorksheet.measures.length === 0) {
        this.logger.verbose(`Skipping worksheet ${name}: no valid measures.`);
        continue;
      }

      const requiresAxes = nextWorksheet.graphType === "bar" || nextWorksheet.graphType === "line";
      if (requiresAxes && (!nextWorksheet.xAxis || !nextWorksheet.yAxis)) {
        this.logger.verbose(`Skipping worksheet ${name}: missing xAxis or yAxis for ${nextWorksheet.graphType}.`);
        continue;
      }

      sanitizedWorksheets[name] = nextWorksheet;
    }

    const sanitizedDashboards: Record<string, any> = {};
    if (namespace.dashboards && typeof namespace.dashboards === "object") {
      for (const [name, dashboard] of Object.entries(namespace.dashboards)) {
        if (!dashboard || typeof dashboard !== "object") {
          this.logger.verbose(`Skipping dashboard ${name}: invalid definition.`);
          continue;
        }
        const dashboardObj = dashboard as Record<string, any>;
        if (!Array.isArray(dashboardObj.tiles)) {
          sanitizedDashboards[name] = dashboardObj;
          continue;
        }

        const nextDashboard = { ...dashboardObj };
        nextDashboard.tiles = dashboardObj.tiles.filter((tile: any) => {
          const worksheetName = tile?.worksheet;
          if (worksheetName && sanitizedWorksheets[worksheetName]) {
            return true;
          }
          this.logger.verbose(
            `Dropping dashboard tile for missing worksheet ${worksheetName ?? "<unknown>"} in ${name}.`
          );
          return false;
        });

        if (nextDashboard.tiles.length === 0) {
          this.logger.verbose(`Skipping dashboard ${name}: no valid tiles.`);
          continue;
        }

        sanitizedDashboards[name] = nextDashboard;
      }
    }

    return {
      ...namespace,
      worksheets: sanitizedWorksheets,
      dashboards: Object.keys(sanitizedDashboards).length > 0 ? sanitizedDashboards : namespace.dashboards,
    };
  }
}
