/**
 * GenerateSMLFromConnection
 *
 * Connects to a live database using a connections.yaml file and generates
 * AtScale SML files by running the semantic model inference algorithm.
 *
 * Output files are written to the specified directory following the SML layout:
 *   <output-dir>/catalog.yml
 *   <output-dir>/connections/<connectionName>.yml
 *   <output-dir>/datasets/<table>.yml
 *   <output-dir>/dimensions/<dimension>.yml
 *   <output-dir>/metrics/<metric>.yml
 *   <output-dir>/models/<modelName>.yml
 */
import path from "path";
import { Operation } from "../Operation.js";
import { ParameterSet, StringParameter, NumberParameter } from "../Parameters.js";
import type { ServiceRegistry } from "../../services/registry.js";
import type { Logger } from "../../logging.js";
import { YamlService } from "../../services/YamlService.js";
import { SqlService, type ConnectionConfig } from "../../services/SqlService.js";
import { SqlJdbcAdapter } from "./SqlJdbcAdapter.js";
import { resolvePiiSeverity, runInferenceAndWrite } from "../generate-sml-shared.js";

// ----------------------------------------------------------
// Parameter declarations
// ----------------------------------------------------------

class GenerateSMLFromConnectionParams extends ParameterSet {
  parameters = [
    new (class extends StringParameter {
      name        = "connection-file";
      description = "Path to the connections.yaml file (default: connections.yaml)";
      required    = false;
      defaultValue = "connections.yaml";
    })(),
    new (class extends StringParameter {
      name        = "connection-name";
      description = "Name of the connection entry in the connections.yaml file";
      required    = true;
    })(),
    new (class extends StringParameter {
      name        = "model-name";
      description = "Name for the generated semantic model";
      required    = true;
    })(),
    new (class extends StringParameter {
      name        = "output-dir";
      description = "Directory where SML files will be written";
      required    = true;
    })(),
    new (class extends StringParameter {
      name        = "schema";
      description = "Database schema to introspect (overrides the schema in the connection config)";
      required    = false;
    })(),
    new (class extends StringParameter {
      name        = "catalog-name";
      description = "Display name for the generated catalog (defaults to model-name)";
      required    = false;
    })(),
    new (class extends StringParameter {
      name        = "pii-severity";
      description = 'Minimum PII severity to exclude: "HIGH", "MEDIUM" (default), "LOW", or "none"';
      required    = false;
      defaultValue = "MEDIUM";
    })(),
    new (class extends NumberParameter {
      name        = "sample-size";
      description = "Maximum rows to sample per table for type inference (default: 250; 0 to disable)";
      required    = false;
      defaultValue = 250;
    })(),
  ];
}

type Params = {
  "connection-file": string;
  "connection-name": string;
  "model-name":      string;
  "output-dir":      string;
  schema?:           string;
  "catalog-name"?:   string;
  "pii-severity":    string;
  "sample-size":     number;
};

// ----------------------------------------------------------
// Operation
// ----------------------------------------------------------

export class GenerateSMLFromConnectionOperation extends Operation<Params> {
  name        = "generate-sml-from-connection";
  description = "Connect to a database and generate AtScale SML files from the inferred semantic model";
  parameters  = new GenerateSMLFromConnectionParams();

  constructor(services: ServiceRegistry, logger: Logger) {
    super(services, logger);
  }

  async run(params: Params): Promise<void> {
    const yaml = this.services.get<YamlService>("yaml");
    const sql  = this.services.get<SqlService>("sql");

    const connectionFile = params["connection-file"];
    const connectionName = params["connection-name"];
    const modelName      = params["model-name"];
    const outputDir      = path.resolve(params["output-dir"]);

    const config = yaml.readFromFile<ConnectionConfig>(connectionFile);
    const conn   = await sql.connect(config, connectionName);

    // Resolve schema: CLI param > connection config > "PUBLIC"
    const schema = (
      params.schema ??
      (config.connections?.[connectionName]?.sql?.schema as string | undefined) ??
      "PUBLIC"
    ).toUpperCase();

    // Resolve database name from connection config
    const database =
      (config.connections?.[connectionName]?.sql?.database as string | undefined) ??
      (config.connections?.[connectionName]?.sql?.dbname   as string | undefined);

    this.logger.log(`[GenerateSMLFromConnection] Connected to "${connectionName}" (schema: ${schema})`);

    try {
      await runInferenceAndWrite(
        new SqlJdbcAdapter(sql, conn, schema),
        modelName,
        {
          schemaPattern:        schema,
          piiExclusionSeverity: resolvePiiSeverity(params["pii-severity"]),
          sampleSize:           params["sample-size"],
          sml: {
            connectionName,
            catalogName: params["catalog-name"] ?? modelName,
            database,
            schema,
          },
        },
        outputDir,
        this.logger,
        "GenerateSMLFromConnection",
      );
    } finally {
      await sql.close(conn);
    }
  }
}
