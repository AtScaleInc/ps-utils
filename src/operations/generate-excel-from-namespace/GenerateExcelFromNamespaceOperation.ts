/**
 * GenerateExcelFromNamespace
 *
 * Reads a namespace YAML, model YAML, and connections YAML and produces an
 * Excel workbook (.xlsx) with:
 *   - One sheet per dashboard
 *   - An OLAP pivot table per tile connected to AtScale via MDX (XMLA)
 *   - A chart per tile styled according to the worksheet graphType
 *
 * Delegates all workbook construction to the ExcelService (ExcelJS + JSZip).
 */
import path from "path";
import { StringParameter } from "../../Parameters.js";
import {
  TemplateOperation,
  TemplateOperationParams,
  TemplateParameterSet,
} from "../template/TemplateOperation.js";
import type { ServiceRegistry } from "../../services/registry.js";
import type { Logger }          from "../../logging.js";
import { YamlService }          from "../../services/YamlService.js";
import { ExcelService }         from "../../services/ExcelService.js";

// ------------------------------------------------------------------
// Parameters
// ------------------------------------------------------------------

class GenerateExcelParameterSet extends TemplateParameterSet {
  parameters = [
    ...this.baseParameters(),
    new (class extends StringParameter {
      name         = "connection-name";
      description  = "Name of the connection in the connection file";
      required     = false;
      defaultValue = "default";
    })(),
    new (class extends StringParameter {
      name         = "target-file";
      description  = "Output path for the generated Excel workbook (.xlsx)";
      required     = false;
      defaultValue = "analysis/workbook.xlsx";
    })(),
  ];
}

type GenerateExcelParams = TemplateOperationParams & {
  "connection-name": string;
  "target-file":     string;
};

// ------------------------------------------------------------------
// Operation
// ------------------------------------------------------------------

export class GenerateExcelFromNamespaceOperation
  extends TemplateOperation<GenerateExcelParams>
{
  name        = "generate-excel-from-namespace";
  description = "Generate an Excel workbook with OLAP pivot tables from a namespace";
  parameters  = new GenerateExcelParameterSet();

  constructor(services: ServiceRegistry, logger: Logger) {
    super(services, logger);
  }

  async run(params: GenerateExcelParams): Promise<void> {
    const yaml  = this.services.get<YamlService>("yaml");
    const excel = this.services.get<ExcelService>("excel");

    const namespaceFile  = params["namespace-file"]  ?? "analysis/namespace.yaml";
    const modelFile      = params["model-file"]      ?? "model.yaml";
    const connectionFile = params["connection-file"] ?? "connections.yaml";
    const connectionName = params["connection-name"];
    const targetFile     = params["target-file"];

    this.logger.verbose(`Reading namespace:  ${namespaceFile}`);
    const namespace = yaml.readFromFile<Record<string, unknown>>(namespaceFile);

    this.logger.verbose(`Reading model:      ${modelFile}`);
    const models = yaml.readFromFile<Record<string, unknown>>(modelFile);

    this.logger.verbose(`Reading connection: ${connectionFile}`);
    const connections = yaml.readFromFile<Record<string, unknown>>(connectionFile);

    const dashboards = (namespace["dashboards"] ?? {}) as Record<string, unknown>;
    if (Object.keys(dashboards).length === 0) {
      this.logger.log("Warning: no dashboards found in namespace — workbook will be empty.");
    }

    this.logger.log(
      `Generating Excel workbook: ${Object.keys(dashboards).length} dashboard(s) → ${targetFile}`,
    );

    await excel.generate({
      namespace,
      models,
      connections,
      connectionName,
      targetFile: path.resolve(targetFile),
    });

    this.logger.info(`Wrote Excel workbook to ${targetFile}`);
  }
}
