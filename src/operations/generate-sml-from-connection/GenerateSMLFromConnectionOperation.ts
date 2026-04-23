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
 *   <output-dir>/sml.style.yaml   (effective settings written after generation)
 */
import path from "path";
import { Operation } from "../Operation.js";
import { ParameterSet, StringParameter, NumberParameter, BooleanParameter } from "../../Parameters.js";
import type { ServiceRegistry } from "../../services/registry.js";
import type { Logger } from "../../logging.js";
import { YamlService } from "../../services/YamlService.js";
import { SqlService, type ConnectionConfig } from "../../services/SqlService.js";
import { SqlSchemaAdapter } from "./SqlSchemaAdapter.js";
import { resolvePiiSeverity, runInferenceAndWrite } from "../generate-sml-shared.js";
import { loadSmlStyleConfig, mergeSmlStyle } from "../sml-style-config.js";

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
      name        = "sml-config-file";
      description = 'Path to the SML style configuration file (default: "sml.style.yaml"). Style file values are overridden by CLI flags. The effective settings are always written to <output-dir>/sml.style.yaml after generation.';
      required    = false;
      defaultValue = "sml.style.yaml";
    })(),
    new (class extends StringParameter {
      name        = "schema";
      description = "Database schema to introspect (overrides the schema in the connection config)";
      required    = false;
    })(),
    new (class extends StringParameter {
      name        = "catalog-name";
      description = "Display name for the generated catalog (defaults to model-name). Can also be set in sml.style.yaml.";
      required    = false;
    })(),
    new (class extends StringParameter {
      name        = "pii-severity";
      description = 'Minimum PII severity to exclude: "HIGH", "MEDIUM" (default), "LOW", or "none". Can also be set in sml.style.yaml.';
      required    = false;
    })(),
    new (class extends NumberParameter {
      name        = "sample-size";
      description = "Maximum rows to sample per table for type inference (default: 250; 0 to disable). Can also be set in sml.style.yaml.";
      required    = false;
    })(),
    new (class extends StringParameter {
      name        = "fact-tables";
      description = "Comma-separated list of table names to treat as fact tables, overriding automatic classification. Can also be set as a list in sml.style.yaml.";
      required    = false;
    })(),
    new (class extends BooleanParameter {
      name        = "camel-case-files";
      description = "When true, dataset and dimension filenames use camelCase of the source table name (default: false). Can also be set in sml.style.yaml.";
      required    = false;
    })(),
    new (class extends BooleanParameter {
      name        = "camel-case-measures";
      description = "When true, metric labels use camelCase of the source column name (default: false). Can also be set in sml.style.yaml.";
      required    = false;
    })(),
    new (class extends NumberParameter {
      name        = "min-hierarchies-per-dim";
      description = "Minimum number of hierarchies a dimension must have to be included in the model (default: 1). Dimensions with fewer are dropped. Can also be set in sml.style.yaml.";
      required    = false;
    })(),
    new (class extends NumberParameter {
      name        = "max-hierarchies-per-dim";
      description = "Maximum number of hierarchies to keep per dimension (default: 4). Extra hierarchies are truncated. Can also be set in sml.style.yaml.";
      required    = false;
    })(),
  ];
}

type Params = {
  "connection-file":      string;
  "connection-name":      string;
  "model-name":           string;
  "output-dir":           string;
  "sml-config-file":      string;
  schema?:                string;
  "catalog-name"?:        string;
  "pii-severity"?:        string;
  "sample-size"?:         number;
  "fact-tables"?:         string;
  "camel-case-files"?:          boolean;
  "camel-case-measures"?:       boolean;
  "min-hierarchies-per-dim"?:   number;
  "max-hierarchies-per-dim"?:   number;
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

    // Resolve database name and dialect from connection config
    const database =
      (config.connections?.[connectionName]?.sql?.database as string | undefined) ??
      (config.connections?.[connectionName]?.sql?.dbname   as string | undefined);

    const dialect =
      (config.connections?.[connectionName]?.sql?.dialect as string | undefined);

    this.logger.log(`[GenerateSMLFromConnection] Connected to "${connectionName}" (schema: ${schema})`);

    // ---- Merge CLI params + sml.style.yaml ----
    const styleFileConfig = loadSmlStyleConfig(params["sml-config-file"]);
    const cliFact = params["fact-tables"]?.split(",").map((t) => t.trim()).filter(Boolean);
    const style = mergeSmlStyle(
      {
        "pii-severity":            params["pii-severity"],
        "fact-tables":             cliFact,
        "catalog-name":            params["catalog-name"],
        "camel-case-files":        params["camel-case-files"],
        "camel-case-measures":     params["camel-case-measures"],
        "sample-size":             params["sample-size"],
        "min-hierarchies-per-dim": params["min-hierarchies-per-dim"],
        "max-hierarchies-per-dim": params["max-hierarchies-per-dim"],
      },
      styleFileConfig,
    );

    const catalogName   = style["catalog-name"] || modelName;
    const factTablesEff = style["fact-tables"].length > 0 ? style["fact-tables"] : undefined;

    try {
      await runInferenceAndWrite(
        new SqlSchemaAdapter(sql, conn, schema),
        modelName,
        {
          schemaPattern:           schema,
          piiExclusionSeverity:    resolvePiiSeverity(style["pii-severity"]),
          sampleSize:              style["sample-size"],
          factTables:              factTablesEff,
          minHierarchiesPerDim:    style["min-hierarchies-per-dim"],
          maxHierarchiesPerDim:    style["max-hierarchies-per-dim"],
          sml: {
            connectionName,
            catalogName,
            database,
            schema,
            dialect,
            camelCaseFiles:    style["camel-case-files"],
            camelCaseMeasures: style["camel-case-measures"],
          },
        },
        outputDir,
        this.logger,
        "GenerateSMLFromConnection",
        // Effective settings written to <outputDir>/sml.style.yaml
        {
          "pii-severity":        style["pii-severity"],
          "fact-tables":         style["fact-tables"],
          "catalog-name":        catalogName,
          "camel-case-files":          style["camel-case-files"],
          "camel-case-measures":       style["camel-case-measures"],
          "sample-size":               style["sample-size"],
          "min-hierarchies-per-dim":   style["min-hierarchies-per-dim"],
          "max-hierarchies-per-dim":   style["max-hierarchies-per-dim"],
        },
      );
    } finally {
      await sql.close(conn);
    }
  }
}
