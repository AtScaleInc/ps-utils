/**
 * Generate Notebook workbooks from namespace and model YAML inputs.
 */
import { StringParameter } from "../../Parameters.js";
import { TemplateOperation, TemplateOperationParams, TemplateParameterSet } from "../template/TemplateOperation.js";
import type { ServiceRegistry } from "../../services/registry.js";
import type { Logger } from "../../logging.js";
import { YamlService } from "../../services/YamlService.js";
import { EjsTemplateService } from "../../services/EjsTemplateService.js";
import { operationAssetDir } from "../../assets.js";
import fs from "fs";
import path from 'path';



/** Directory of this operation's .ejs templates (dist tree or bundled assets). */
const templateDir = (): string => operationAssetDir(() => import.meta.url, "generate-notebook-from-connection");

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
export class GenerateNotebookFromConnectionOperation extends TemplateOperation<GenerateNotebookParams> {
  name = "generate-notebook-from-connection";
  description = "Generate a Notebook from a namespace (stub)";
  parameters = new GenerateNotebookParameterSet();

  constructor(services: ServiceRegistry, logger: Logger) {
    super(services, logger);
  }

  run(params: GenerateNotebookParams): void {
    const yaml = this.services.get<YamlService>("yaml");
    const ejs = this.services.get<EjsTemplateService>("ejs");

    const connectionFile = params["connection-file"] ?? "connections.yaml";
    const targetFile = params["target-file"] ?? "notebook.ipynb";

    this.logger.verbose(`Reading connection file: ${connectionFile}`);
    const connectionData = yaml.readFromFile<Record<string, unknown>>(connectionFile) as any;
    var connection = connectionData.connections[params["connection-name"]] as any;
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

    const templatePath = `${templateDir()}/notebook.ejs`;
    this.logger.verbose(`Reading EJS template: ${templatePath}`);
    const template = fs.readFileSync(templatePath, "utf8");

    try {
      const output = ejs.render(template, {
        connection,
        mdxUser
      });
      fs.writeFileSync(targetFile, output, "utf8");
      this.logger.info(`Wrote Notebook workbook to ${targetFile}`);
    } catch (error) {
      this.logger.error(`Failed to generate Notebook workbook: ${error}`);
    }
  }

}
