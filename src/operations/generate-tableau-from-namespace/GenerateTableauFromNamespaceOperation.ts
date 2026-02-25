import { StringParameter } from "../Parameters.js";
import { TemplateOperation, TemplateOperationParams, TemplateParameterSet } from "../template/TemplateOperation.js";
import type { ServiceRegistry } from "../../services/registry.js";
import type { Logger } from "../../logging.js";
import { YamlService } from "../../services/YamlService.js";
import { EjsTemplateService } from "../../services/EjsTemplateService.js";
import fs from "fs";

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

    this.logger.verbose("Reading overview template: resources/namespaces/telemetry/overview.yaml");
    const overviewData = yaml.readFromFile<Record<string, unknown>>(
      "resources/namespaces/telemetry/overview.yaml"
    );

    const templatePath = `resources/namespaces/telemetry/tableau.${version}.twb.ejs`;
    this.logger.verbose(`Reading EJS template: ${templatePath}`);
    const template = fs.readFileSync(templatePath, "utf8");

    const output = ejs.render(template, {
      model: modelData,
      connections: connectionData,
      overview: overviewData,
      namespace: params.namespace,
    });

    fs.writeFileSync(targetFile, output, "utf8");
    this.logger.info(`Wrote Tableau workbook to ${targetFile}`);
  }
}
