/**
 * Shared SQL operation logic for printing database metadata.
 */
import { Operation } from "../Operation.js";
import { ParameterSet, StringParameter } from "../../Parameters.js";
import type { ServiceRegistry } from "../../services/registry.js";
import type { Logger } from "../../logging.js";
import { YamlService } from "../../services/YamlService.js";
import { SqlService, type ConnectionConfig } from "../../services/SqlService.js";

class SQLParameterSet extends ParameterSet {
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
      name = "schema";
      description = "Override schema name for metadata queries";
      required = false;
    })(),
  ];
}

type SQLParams = {
  "connection-file": string;
  "connection-name": string;
  schema?: string;
};

/**
 * Base SQL operation that prints database metadata.
 */
export abstract class SQLOperation extends Operation<SQLParams> {
  name = "sql";
  description = "Print SQL metadata for a connection";
  parameters = new SQLParameterSet();

  constructor(services: ServiceRegistry, logger: Logger) {
    super(services, logger);
  }

  async run(params: SQLParams): Promise<void> {
    const yaml = this.services.get<YamlService>("yaml");
    const sql = this.services.get<SqlService>("sql");

    const connectionFile = params["connection-file"] ?? "connections.yaml";
    const connectionName = params["connection-name"];

    const config = yaml.readFromFile(connectionFile) as ConnectionConfig;
    const conn = await sql.connect(config, connectionName);

    const schema =
      (params.schema ??
        (config.connections?.[connectionName]?.sql?.schema as string | undefined) ??
        "PUBLIC")
        .toUpperCase();

    const schemas = await sql.query(
      conn,
      "SELECT CURRENT_DATABASE() AS DB, CURRENT_SCHEMA() AS SCHEMA"
    );
    const tables = await sql.query(
      conn,
      `SELECT * FROM INFORMATION_SCHEMA.TABLES WHERE TABLE_SCHEMA = '${schema}'`
    );
    const columns = await sql.query(
      conn,
      `SELECT * FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_SCHEMA = '${schema}'`
    );
    const foreignKeys = await sql.query(
      conn,
      `SELECT * FROM INFORMATION_SCHEMA.REFERENTIAL_CONSTRAINTS WHERE CONSTRAINT_SCHEMA = '${schema}'`
    );

    this.logger.log(JSON.stringify({ schemas, tables, columns, foreignKeys }, null, 2));

    await sql.close(conn);
  }
}
