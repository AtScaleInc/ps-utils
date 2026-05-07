import { StringParameter } from "../../Parameters.js";
import { TemplateOperation, TemplateOperationParams, TemplateParameterSet } from "../template/TemplateOperation.js";
import type { ServiceRegistry } from "../../services/registry.js";
import type { Logger } from "../../logging.js";
import { YamlService } from "../../services/YamlService.js";
import { EjsTemplateService } from "../../services/EjsTemplateService.js";
import crypto from 'node:crypto';
import fs from "fs";
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

class GenerateGSheetParameterSet extends TemplateParameterSet {
  parameters = [
    ...this.baseParameters(),
    new (class extends StringParameter {
      name = "target-folder";
      description = "Target folder to output the report";
      required = false;
      defaultValue = "gsheet";
    })(),
    new (class extends StringParameter {
      name = "connection-name";
      description = "The name of the connection to use";
      required = false;
      defaultValue = "default";
    })(),
  ];
}

type GenerateGSheetParams = TemplateOperationParams & {
  "connection-name": string;
  "target-folder": string;
};

/**
 * Stub operation to generate GSheet workbook from a namespace.
 */
export class GenerateGSheetFromNamespaceOperation extends TemplateOperation<GenerateGSheetParams> {
  name = "generate-gsheet-from-namespace";
  description = "Generate a GSheet workbook from a namespace (stub)";
  parameters = new GenerateGSheetParameterSet();

  constructor(services: ServiceRegistry, logger: Logger) {
    super(services, logger);
  }

  run(params: GenerateGSheetParams): void {
    const yaml = this.services.get<YamlService>("yaml");
    const ejs = this.services.get<EjsTemplateService>("ejs");

    const modelFile = params["model-file"] ?? "model.yaml";
    const connectionFile = params["connection-file"] ?? "connections.yaml";
    const targetFolder = params["target-folder"] ?? "gsheet";
    const outDir     = path.resolve(targetFolder);
    const folderName = path.basename(outDir);

    this.logger.verbose(`Reading model file: ${modelFile}`);
    const rawModelData = yaml.readFromFile<Record<string, unknown>>(modelFile);
    const aliasesFile  = params["aliases-file"];
    const aliasesData  = aliasesFile
      ? yaml.readFromFile<Record<string, unknown>>(aliasesFile)
      : null;
    const modelData = yaml.augmentModelData(rawModelData, aliasesData);

    this.logger.verbose(`Reading connection file: ${connectionFile}`);
    const connectionData = yaml.readFromFile<Record<string, unknown>>(connectionFile) as any;
    let connection = connectionData.connections?.[params["connection-name"]] as any;
    if (!connection) {
      this.logger.error(`Connection ${params["connection-name"]} not found in ${connectionFile}`);
      return;
    }
    if (!connection.mdx) {
      this.logger.error(`Connection '${params["connection-name"]}' is missing an 'mdx:' block in ${connectionFile}`);
      return;
    }

    this.logger.verbose("Reading overview namespace: " + params["namespace-file"]);
    const overviewData = yaml.readFromFile<Record<string, unknown>>(params["namespace-file"]);

    try {
      const models = modelData as Record<string, any>;
      const namespace = this.sanitizeNamespace(overviewData as Record<string, any>, models);
      const worksheetValues = Object.values(namespace.worksheets as Record<string, any>);
      if (worksheetValues.length === 0) {
        this.logger.error("No worksheets found in namespace — cannot generate Power BI report.");
        return;
      }
      const model = models[worksheetValues[0].model];

      this.logger.verbose("Generating folder");
      fs.mkdirSync(outDir, { recursive: true });
  
      const mdxUser = (connectionData.users ?? {})[connection.mdx.user];
      if (!mdxUser) {
        throw new Error(`User '${connection.mdx.user}' not found in ${connectionFile}`);
      }
      const baseUrl = connection.mdx.url.replace(/\/$/, "");
      const token = mdxUser.xmla_token ? `/${mdxUser.xmla_token}` : "";
      const connectionString = connection.installer
        ? `${baseUrl}:10502/xmla/${connection.mdx.organization_id}${token}`
        : `${baseUrl}/engine/xmla${token}`;
      
      Object.entries<any>(namespace.dashboards).forEach(([dashboardName, dashboard]) => {
        this.logger.verbose("Generating visuals for dashboard: " + dashboardName);


        Object.entries<any>(dashboard.tiles ?? {}).forEach(([tileName, tile]) => {
          const worksheet = namespace.worksheets[tile.worksheet];
          if (!worksheet) {
            this.logger.verbose(`Skipping tile '${tileName}': worksheet '${tile.worksheet}' not found.`);
            return;
          }

          let template = fs.readFileSync(`${__dirname}/sheet.ejs`, "utf8");
          let output = ejs.render(template, {
            worksheet,
            model,
            connectionString,
            connection
          });
          fs.writeFileSync(`${outDir}/${worksheet.title}.json`, output, "utf8");
        });
      });
    } catch (error) {
      this.logger.error(`Failed to generate GSheet workbook: ${error}`);
    }
    this.logger.info(`Wrote GSheet report to ${targetFolder}`);
  }
}