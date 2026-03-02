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
      name = "connection-name";
      description = "The name of the connection to use";
      required = false;
      defaultValue = "default";
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
  "connection-name": string;
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
    const connectionData = yaml.readFromFile<Record<string, unknown>>(connectionFile) as any;
    var connection = connectionData.connections[params["connection-name"]] as any;
    if (!connection) {
      this.logger.error(`Connection ${params["connection-name"]} not found in ${connectionFile}`);
      return;
    }
    /*
    sql:
      dialect: postgres
      port: 15432
      server: template.atscale-se-demo.com
      database: atscale
      schema: Telemetry
      user: admin

<named-connection caption='jdbc:postgresql://class-i.training.atscale-se-demo.com:15432/Telemetry' name='genericjdbc.0w0lhpd1d6ifhq10hiwbx0augav7'>
<connection class='genericjdbc' dbname='atscale' dialect='postgres' jdbcproperties='' 
jdbcurl='jdbc:postgresql://class-i.training.atscale-se-demo.com:15432/Telemetry' port='15432' 
schema='Telemetry' server='class-i.training.atscale-se-demo.com' username='admin' warehouse=''>

      
*/
    connection={...connection, jdbcUrl: `jdbc:${connection.sql.dialect}ql://${connection.sql.server}:${connection.sql.port}/${connection.sql.schema}`};
    connection={...connection, class: "genericjdbc"};
    connection={...connection, user: connectionData.users[connection.sql.user]};

    this.logger.verbose("Reading overview namespace: " + params["namespace-file"]);
    const overviewData = yaml.readFromFile<Record<string, unknown>>(params["namespace-file"]);

    const templatePath = `${__dirname}/tableau.${version}.twb.ejs`;
    this.logger.verbose(`Reading EJS template: ${templatePath}`);
    const template = fs.readFileSync(templatePath, "utf8");

    try {
      const models = modelData as Record<string, any>;
      const namespace = this.sanitizeNamespace(overviewData as Record<string, any>, models);

      const functions = {
        typeMap: {
          "STRING": "string",
          "INT1": "integer",
          "INT2": "integer",
          "INT4": "integer",
          "INT8": "integer",
          "INT_UNSIGNED1": "integer",
          "INT_UNSIGNED2": "integer",
          "INT_UNSIGNED4": "integer",
          "INT_UNSIGNED8": "integer",
          "FLOAT32": "real",
          "FLOAT64": "real",
          "DATE_DOUBLE": "date",
          "BSTR": "string",
          "BOOL": "boolean",
          "DECIMAL": "decimal",
          "GUID": "string",
          "BYTES": "binary",
          "WSTR": "string",
          "NUMERIC": "numeric",
          "TIME": "time",
          "DATETIME": "datetime"
        } as Record<string, string>,

        derivationMap: {
          "sum": "Sum",
          "avg": "Avg",
          "max": "Max",
          "min": "Min",
          "count": "Count",
          "countd": "CountD",
          "median": "Median",
          "std": "Stdev",
          "var": "Var",
        } as Record<string, string>,

        toTableauType: function (type: string): string {
          return this.typeMap[type] || "string";
        },
        toTableauDerivation: function (derivation: string): string {
          return this.derivationMap[derivation] || "None";
        }
      };

      const output = ejs.render(template, {
        models,
        connection,
        connections: connectionData,
        namespace,
        functions,
      });
      fs.writeFileSync(targetFile, output, "utf8");
      this.logger.info(`Wrote Tableau workbook to ${targetFile}`);
    } catch (error) {
      this.logger.error(`Failed to generate Tableau workbook: ${error}`);
    }
  }

}
