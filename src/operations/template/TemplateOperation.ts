/**
 * Shared base types for operations that render templates from YAML inputs.
 */
import { Operation } from "../Operation.js";
import { ParameterSet, StringParameter } from "../../Parameters.js";
import type { ServiceRegistry } from "../../services/registry.js";
import type { Logger } from "../../logging.js";

export type TemplateOperationParams = {
  "namespace-file": string;
  "connection-file"?: string;
  "model-file"?: string;
  "target-file"?: string;
  "aliases-file"?: string;
};

/**
 * Base parameter set for template-based operations.
 */
export abstract class TemplateParameterSet extends ParameterSet {
  protected baseParameters() {
    return [
      new (class extends StringParameter {
        name = "namespace-file";
        description = "The file where the namespace is contained";
        required = false;
        defaultValue = "analysis/namespace.yaml";
      })(),
      new (class extends StringParameter {
        name = "model-file";
        description = "The file where the models are defined";
        required = false;
        defaultValue = "model.yaml";
      })(),
      new (class extends StringParameter {
        name = "connection-file";
        description = "The file where the connections are defined";
        required = false;
        defaultValue = "connections.yaml";
      })(),
      new (class extends StringParameter {
        name = "aliases-file";
        description = "Optional YAML file containing column aliases (global / worksheets / dashboards sections)";
        required = false;
      })(),
    ];
  }

}

/**
 * Base operation for template-based generators.
 */
export abstract class TemplateOperation<TParams extends TemplateOperationParams> extends Operation<TParams> {
  abstract name: string;
  abstract description: string;
  abstract parameters: TemplateParameterSet;

  constructor(services: ServiceRegistry, logger: Logger) {
    super(services, logger);
  }


  public sanitizeNamespace(
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
      if (nextWorksheet.colorField && !columns[nextWorksheet.colorField]) {
        this.logger.verbose(`Missing colorField ${nextWorksheet.colorField} for worksheet ${name}, clearing.`);
        nextWorksheet.colorField = undefined;
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
