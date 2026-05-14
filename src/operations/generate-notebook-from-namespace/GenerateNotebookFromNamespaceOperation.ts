/**
 * Generate Notebook workbooks from namespace and model YAML inputs.
 */
import { StringParameter } from "../../Parameters.js";
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


class GenerateNotebookParameterSet extends TemplateParameterSet {
  parameters = [
    ...this.baseParameters(),
    new (class extends StringParameter {
      name = "connection-name";
      description = "The name of the connection to use";
      required = false;
      defaultValue = "default";
    })(),
    new (class extends StringParameter {
      name = "target-file";
      description = "Target file to output the notebook";
      required = false;
      defaultValue = "notebook.ipynb";
    })(),
  ];
}

type GenerateNotebookParams = TemplateOperationParams & {
  "connection-name": string;
};
export type GenerateNotebookFromConnectionParams = GenerateNotebookParams;

/**
 * Stub operation to generate Notebook workbook from a namespace.
 */
export class GenerateNotebookFromNamespaceOperation extends TemplateOperation<GenerateNotebookParams> {
  name = "generate-notebook-from-namespace";
  description = "Generate a Notebook from a namespace (stub)";
  parameters = new GenerateNotebookParameterSet();

  constructor(services: ServiceRegistry, logger: Logger) {
    super(services, logger);
  }

  run(params: GenerateNotebookParams): void {
    const yaml = this.services.get<YamlService>("yaml");
    const ejs = this.services.get<EjsTemplateService>("ejs");

    const modelFile = params["model-file"] ?? "model.yaml";
    const connectionFile = params["connection-file"] ?? "connections.yaml";
    const targetFile = params["target-file"] ?? "tableau.twb";

    this.logger.verbose(`Reading model file: ${modelFile}`);
    const rawModelData = yaml.readFromFile<Record<string, unknown>>(modelFile);
    const aliasesFile  = params["aliases-file"];
    const aliasesData  = aliasesFile
      ? yaml.readFromFile<Record<string, unknown>>(aliasesFile)
      : null;
    const modelData = yaml.augmentModelData(rawModelData, aliasesData);
    const models = modelData as Record<string, any>;


    this.logger.verbose("Reading overview namespace: " + params["namespace-file"]);
    const overviewData = yaml.readFromFile<Record<string, unknown>>(params["namespace-file"]);
    const namespace = this.sanitizeNamespace(overviewData as Record<string, any>, models);

    this.logger.verbose(`Reading connection file: ${connectionFile}`);
    const connectionData = yaml.readFromFile<Record<string, unknown>>(connectionFile) as any;
    var connection = connectionData.connections?.[params["connection-name"]] as any;
    if (!connection) {
      this.logger.error(`Connection ${params["connection-name"]} not found in ${connectionFile}`);
      return;
    }
    if (!connection.mdx) {
      this.logger.error(`Connection '${params["connection-name"]}' is missing an 'mdx:' block in ${connectionFile}`);
      return;
    }

    const mdxUser = (connectionData.users ?? {})[connection.mdx.user];
    if (!mdxUser) {
      throw new Error(`User '${connection.mdx.user}' not found in ${connectionFile}`);
    }

    const templatePath = `${__dirname}/notebook.ejs`;
    this.logger.verbose(`Reading EJS template: ${templatePath}`);
    const template = fs.readFileSync(templatePath, "utf8");

    try {
      const output = ejs.render(template, {
        models,
        connection,
        mdxUser,
        namespace
      });
      fs.writeFileSync(targetFile, output, "utf8");
      this.logger.info(`Wrote Notebook workbook to ${targetFile}`);
    } catch (error) {
      this.logger.error(`Failed to generate Notebook workbook: ${error}`);
    }
  }

}
