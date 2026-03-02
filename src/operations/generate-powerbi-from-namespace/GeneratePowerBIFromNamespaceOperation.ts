import { StringParameter } from "../Parameters.js";
import { TemplateOperation, TemplateOperationParams, TemplateParameterSet } from "../template/TemplateOperation.js";
import type { ServiceRegistry } from "../../services/registry.js";
import type { Logger } from "../../logging.js";
import { YamlService } from "../../services/YamlService.js";
import { EjsTemplateService } from "../../services/EjsTemplateService.js";
import fs from "fs";

class GeneratePowerBIParameterSet extends TemplateParameterSet {
  parameters = [
    ...this.baseParameters(),
    new (class extends StringParameter {
      name = "target-folder";
      description = "Target folder to output the report";
      required = false;
      defaultValue = "powerbi";
    })(),
  ];
}

type GeneratePowerBIParams = TemplateOperationParams & {
  "powerbi-version": string;
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
    const version = params["powerbi-version"];

    this.logger.verbose(`Reading model file: ${modelFile}`);
    const modelData = yaml.readFromFile<Record<string, unknown>>(modelFile);

    this.logger.verbose(`Reading connection file: ${connectionFile}`);
    const connectionData = yaml.readFromFile<Record<string, unknown>>(connectionFile);

    this.logger.verbose("Reading overview template: resources/namespaces/telemetry/overview.yaml");
    const overviewData = yaml.readFromFile<Record<string, unknown>>(
      "resources/namespaces/telemetry/overview.yaml"
    );

    const templatePath = `resources/namespaces/telemetry/powerbi.${version}.twb.ejs`;
    this.logger.verbose(`Reading EJS template: ${templatePath}`);
    const template = fs.readFileSync(templatePath, "utf8");

    const output = ejs.render(template, {
      model: modelData,
      connections: connectionData,
      overview: overviewData,
      namespace: params.namespace,
    });
    
    fs.mkdirSync('output/' + targetFolder, { recursive: true });
    fs.mkdirSync('output/' + targetFolder + '/' + targetFolder + '.SemanticModel', { recursive: true });
    fs.mkdirSync('output/' + targetFolder + '/' + targetFolder + '.Report', { recursive: true });
    fs.mkdirSync('output/' + targetFolder + '/' + targetFolder + '.Report/definition', { recursive: true });
    fs.mkdirSync('output/' + targetFolder + '/' + targetFolder + '.Report/definition/pages', { recursive: true });

    functions.writeTemplateFromRepo("pbi/pbip.ejs", {visuals}, 'output/' + targetFolder + '/' + targetFolder + '.pbip');
    functions.writeTemplateFromRepo("pbi/definition.ejs", {}, 'output/' + targetFolder + '/' + targetFolder + '.SemanticModel/definition.pbism');
    functions.writeTemplateFromRepo("pbi/modelReference.ejs", {model, connection}, 'output/' + targetFolder + '/' + targetFolder + '.SemanticModel/modelReference.json');
    functions.writeTemplateFromRepo("pbi/report.ejs", {}, 'output/' + targetFolder + '/' + targetFolder + '.Report/definition/report.json');
    functions.writeTemplateFromRepo("pbi/version.ejs", {}, 'output/' + targetFolder + '/' + targetFolder + '.Report/definition/version.json');

    fs.writeFileSync(targetFile, output, "utf8");
    this.logger.info(`Wrote PowerBI report to ${targetFolder}`);
  }
}


  functions.writeTemplateFromRepo("pbi/pbip.ejs", {visuals}, 'output/' + targetFolder + '/' + targetFolder + '.pbip');
  functions.writeTemplateFromRepo("pbi/definition.ejs", {}, 'output/' + targetFolder + '/' + targetFolder + '.SemanticModel/definition.pbism');
  functions.writeTemplateFromRepo("pbi/modelReference.ejs", {model, connection}, 'output/' + targetFolder + '/' + targetFolder + '.SemanticModel/modelReference.json');
  functions.writeTemplateFromRepo("pbi/report.ejs", {}, 'output/' + targetFolder + '/' + targetFolder + '.Report/definition/report.json');
  functions.writeTemplateFromRepo("pbi/version.ejs", {}, 'output/' + targetFolder + '/' + targetFolder + '.Report/definition/version.json');

  Object.entries(visuals.dashboards).forEach(([dashboardName, dashboard]) => {
    pageName = crypto.randomUUID()
    fs.mkdirSync('output/' + targetFolder + '/' + targetFolder + '.Report/definition/pages/' + pageName, { recursive: true });
    functions.writeTemplateFromRepo("pbi/page.ejs", {...ref, pageName, dashboard}, 'output/' + targetFolder + '/' + targetFolder + '.Report/definition/pages/' + pageName + '/page.json');
    Object.entries(dashboard.tiles).forEach((tile) => {
        visualName = crypto.randomUUID()
        fs.mkdirSync('output/' + targetFolder + '/' + targetFolder + '.Report/definition/pages/' + pageName + '/visuals/' + visualName , { recursive: true });
        functions.writeTemplateFromRepo("pbi/visual.ejs", {...ref, visualName, tile}, 'output/' + targetFolder + '/' + targetFolder + '.Report/definition/pages/' + pageName + '/visuals/' + visualName + '/visual.json');
    });
  });