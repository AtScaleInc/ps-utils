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

class GeneratePowerBIParameterSet extends TemplateParameterSet {
  parameters = [
    ...this.baseParameters(),
    new (class extends StringParameter {
      name = "target-folder";
      description = "Target folder to output the report";
      required = false;
      defaultValue = "powerbi";
    })(),
    new (class extends StringParameter {
      name = "connection-name";
      description = "The name of the connection to use";
      required = false;
      defaultValue = "default";
    })(),
  ];
}

type GeneratePowerBIParams = TemplateOperationParams & {
  "connection-name": string;
  "target-folder": string;
};

/**
 * Stub operation to generate PowerBI workbook from a namespace.
 */
export class GeneratePowerBIFromNamespaceOperation extends TemplateOperation<GeneratePowerBIParams> {
  name = "generate-powerbi-from-namespace";
  description = "Generate a PowerBI workbook from a namespace (stub)";
  parameters = new GeneratePowerBIParameterSet();

  constructor(services: ServiceRegistry, logger: Logger) {
    super(services, logger);
  }

  run(params: GeneratePowerBIParams): void {
    const yaml = this.services.get<YamlService>("yaml");
    const ejs = this.services.get<EjsTemplateService>("ejs");

    const modelFile = params["model-file"] ?? "model.yaml";
    const connectionFile = params["connection-file"] ?? "connections.yaml";
    const targetFolder = params["target-folder"] ?? "powerbi";

    this.logger.verbose(`Reading model file: ${modelFile}`);
    const modelData = yaml.readFromFile<Record<string, unknown>>(modelFile);

    this.logger.verbose(`Reading connection file: ${connectionFile}`);
    const connectionData = yaml.readFromFile<Record<string, unknown>>(connectionFile) as any;
    let connection = connectionData.connections[params["connection-name"]] as any;
    if (!connection) {
      this.logger.error(`Connection ${params["connection-name"]} not found in ${connectionFile}`);
      return;
    }

    this.logger.verbose("Reading overview namespace: " + params["namespace-file"]);
    const overviewData = yaml.readFromFile<Record<string, unknown>>(params["namespace-file"]);

    try {
      const models = modelData as Record<string, any>;
      const namespace = this.sanitizeNamespace(overviewData as Record<string, any>, models);
      const model = models[Object.values(namespace.worksheets as Record<string, any>)[0].model];

      this.logger.verbose("Generating folders");
      fs.mkdirSync('output/' + targetFolder, { recursive: true });
      fs.mkdirSync('output/' + targetFolder + '/' + targetFolder + '.SemanticModel', { recursive: true });
      fs.mkdirSync('output/' + targetFolder + '/' + targetFolder + '.Report', { recursive: true });
      fs.mkdirSync('output/' + targetFolder + '/' + targetFolder + '.Report/definition', { recursive: true });
      fs.mkdirSync('output/' + targetFolder + '/' + targetFolder + '.Report/definition/pages', { recursive: true });

      let template = fs.readFileSync(`${__dirname}/pbip.ejs`, "utf8");
      let output = ejs.render(template, {
        targetFolder
      });
      fs.writeFileSync('output/' + targetFolder + '/' + targetFolder + '.pbip', output, "utf8");

      template = fs.readFileSync(`${__dirname}/definition.pbism.ejs`, "utf8");
      output = ejs.render(template, {
      });
      fs.writeFileSync('output/' + targetFolder + '/' + targetFolder + '.SemanticModel/definition.pbism', output, "utf8");
      
      const connectionString = connection.mdx.url.replace(/\/$/, "") + '/' + connectionData.users[connection.mdx.user].token
      template = fs.readFileSync(`${__dirname}/modelReference.ejs`, "utf8");
      output = ejs.render(template, {
        model, connection, connectionString
      });
      fs.writeFileSync('output/' + targetFolder + '/' + targetFolder + '.SemanticModel/modelReference.json', output, "utf8");

      template = fs.readFileSync(`${__dirname}/definition.pbir.ejs`, "utf8");
      output = ejs.render(template, {
        targetFolder
      });
      fs.writeFileSync('output/' + targetFolder + '/' + targetFolder + '.Report/definition.pbir', output, "utf8");


      template = fs.readFileSync(`${__dirname}/report.ejs`, "utf8");
      output = ejs.render(template, {
      });
      fs.writeFileSync('output/' + targetFolder + '/' + targetFolder + '.Report/definition/report.json', output, "utf8");

      template = fs.readFileSync(`${__dirname}/version.ejs`, "utf8");
      output = ejs.render(template, {
      });
      fs.writeFileSync('output/' + targetFolder + '/' + targetFolder + '.Report/definition/version.json', output, "utf8");
      
      let pageNames = [] as any[];
      Object.entries<any>(namespace.worksheets).forEach(([worksheetName, worksheet]) => {
        this.logger.verbose("Generating visuals for worksheet: " + worksheetName);
        let pageName = crypto.randomUUID();
        pageNames.push(pageName);
        fs.mkdirSync('output/' + targetFolder + '/' + targetFolder + '.Report/definition/pages/' + pageName, { recursive: true });
        template = fs.readFileSync(`${__dirname}/page.ejs`, "utf8");
        output = ejs.render(template, {
          pageName,
          worksheet
        });
        fs.writeFileSync('output/' + targetFolder + '/' + targetFolder + '.Report/definition/pages/' + pageName + '/page.json', output, "utf8");
        
        let visualName = crypto.randomUUID();
        let visualType;
        fs.mkdirSync('output/' + targetFolder + '/' + targetFolder + '.Report/definition/pages/' + pageName + '/visuals/' + visualName, { recursive: true });
        if (worksheet.graphType == 'bar') {
          if (model.mdx.metrics.map((metric: any) => metric.query_name).includes(worksheet.xAxis)) {
            visualType = 'columnChart'
          }
          else {
            visualType = 'barChart'
          }
          template = fs.readFileSync(`${__dirname}/graph.ejs`, "utf8");
        }
        else if (worksheet.graphType == 'line') {
          visualType = 'lineChart'
          template = fs.readFileSync(`${__dirname}/graph.ejs`, "utf8");
        }
        else {
          visualType = 'cardVisual'
          template = fs.readFileSync(`${__dirname}/card.ejs`, "utf8");
        }
        output = ejs.render(template, {
          visualName,
          visualType,
          model,
          worksheet
        });
        fs.writeFileSync('output/' + targetFolder + '/' + targetFolder + '.Report/definition/pages/' + pageName + '/visuals/' + visualName + '/visual.json', output, "utf8");
      });

      template = fs.readFileSync(`${__dirname}/pages.ejs`, "utf8");
      output = ejs.render(template, {
        pageNames,
      });
      fs.writeFileSync('output/' + targetFolder + '/' + targetFolder + '.Report/definition/pages/pages.json', output, "utf8");
    } catch (error) {
      this.logger.error(`Failed to generate PowerBI workbook: ${error}`);
    }
    this.logger.info(`Wrote PowerBI report to ${targetFolder}`);
  }
}