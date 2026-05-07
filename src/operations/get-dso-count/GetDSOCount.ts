import { Operation } from "../Operation.js";
import { ParameterSet, StringParameter } from "../../Parameters.js";
import type { ServiceRegistry } from "../../services/registry.js";
import type { Logger } from "../../logging.js";
import { SqlService, type ConnectionConfig } from "../../services/SqlService.js";
import { YamlService } from "../../services/YamlService.js";



class DSOParameterSet extends ParameterSet {
  parameters = [
    new (class extends StringParameter {
      name = "connection-file";
      description = "File that defines all the connections";
      required = false;
      defaultValue = "connections.yaml";
    })(),
    new (class extends StringParameter {
      name = "connection-name";
      description = "The name of the connection in the connection file";
      required = true;
    })(),
    new (class extends StringParameter {
      name = "catalog";
      description = "The name of the catalog to pull the DSO count for. Ignore to pull all catalogs";
      required = false;
    })(),
    new (class extends StringParameter {
      name = "model";
      description = "The name of the model to pull the DSO count for. Ignore to pull all models";
      required = false;
    })(),
  ];
}

type DSOParams = {
  "connection-file": string;
  "connection-name": string;
  catalog?: string;
  model?: string;
};

export class GetDSOCount extends Operation<DSOParams> {
  name = "get-dso-count";
  description = "Get the DSO count from models";
  parameters = new DSOParameterSet();

  constructor(services: ServiceRegistry, logger: Logger) {
    super(services, logger);
  }

    async run(params: DSOParams): Promise<void> {
        const yaml = this.services.get<YamlService>("yaml");
        const sql = this.services.get<SqlService>("sql");

        const connectionFile = params["connection-file"] ?? "connections.yaml";
        const connectionName = params["connection-name"];

        const config = yaml.readFromFile(connectionFile) as ConnectionConfig;
      
        const conn = await sql.connect(config, connectionName);
        var modelRows = [] as any[];
        try {
            modelRows = await sql.query(conn, "SELECT table_schema, table_name FROM information_schema.tables");
        } catch (err) {
            this.logger.error(`Failed to pull models`);
            if (conn) {
                try { sql.close(conn); } catch { /* ignore */ }
            }
            return
        }
      
        const models: any[] = modelRows.map(
            (r) => ({ catalogName:  String(r["TABLE_SCHEMA"] ?? r["table_schema"] ?? ""),
                      modelName: String(r["TABLE_NAME"] ?? r["table_name"] ?? "")
        }));
      
        var dso = 0
        for (const model of models) {
        if (!params["catalog"] || params["catalog"] == model.catalogName) {
            if (!params["model"] || params["model"] == model.modelName) {
                try {
                    const objectRows = await sql.query(conn, `SELECT column_name FROM information_schema.columns WHERE table_schema = '${model.catalogName}' AND table_name   = '${model.modelName}';`);
                    this.logger.info(`${objectRows.length} objects in Catalog: ${model.catalogName} Model: ${model.modelName}`);
                    dso = dso + objectRows.length
                } catch (err) {
                    this.logger.error(`Failed to pull DSOs for Catalog: ${model.catalogName} Model: ${model.modelName}`);
                }
            }
        }
        }
        this.logger.info(`Total DSO Count: ${dso}`);
        if (conn) {
                try { sql.close(conn); } catch { /* ignore */ }
            }
  }
}