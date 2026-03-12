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
import fs from "fs";
import path from "path";
import { Operation } from "../Operation.js";
import { ParameterSet, StringParameter, NumberParameter } from "../Parameters.js";
import type { ServiceRegistry } from "../../services/registry.js";
import type { Logger } from "../../logging.js";
import { YamlService } from "../../services/YamlService.js";
import { SqlService, type ConnectionConfig } from "../../services/SqlService.js";
import { SqlJdbcAdapter } from "./SqlJdbcAdapter.js";
import { proposeSemanticModel } from "../../algorithm/jdbc-semantic-model.js";
import { createDefaultEngine } from "../../algorithm/inference/index.js";

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

    // Read connection config and establish connection
    const config = yaml.readFromFile<ConnectionConfig>(connectionFile);
    const conn   = await sql.connect(config, connectionName);

    // Resolve schema: CLI param > connection config > "PUBLIC"
    const schema = (
      params.schema ??
      (config.connections?.[connectionName]?.sql?.schema as string | undefined) ??
      "PUBLIC"
    ).toUpperCase();

    this.logger.log(`[GenerateSMLFromConnection] Connected to "${connectionName}" (schema: ${schema})`);

    try {
      // Build the JDBC adapter that wraps SqlService
      const adapter = new SqlJdbcAdapter(sql, conn, schema);

      // Resolve PII severity
      const piiRaw = (params["pii-severity"] ?? "MEDIUM").toUpperCase();
      const piiExclusionSeverity =
        piiRaw === "NONE"   ? false as const :
        piiRaw === "HIGH"   ? "HIGH" as const :
        piiRaw === "LOW"    ? "LOW"  as const :
                              "MEDIUM" as const;

      // Run semantic model inference
      this.logger.log(`[GenerateSMLFromConnection] Running inference on "${modelName}"…`);
      const model = await proposeSemanticModel(adapter, modelName, {
        schemaPattern: schema,
        inferenceEngine: createDefaultEngine(),
        piiExclusionSeverity,
        sampleSize: params["sample-size"],
        suggestions: true,
        sml: {
          connectionName,
          catalogName: params["catalog-name"] ?? modelName,
        },
      });

      // Surface inference warnings
      if (model.warnings.length > 0) {
        this.logger.log(`\n[GenerateSMLFromConnection] Inference warnings:`);
        for (const w of model.warnings) {
          this.logger.log(`  ⚠  ${w}`);
        }
      }

      // Write SML files to disk
      if (model.sml && model.sml.size > 0) {
        writeSmlFiles(model.sml, outputDir, this.logger);
        this.logger.log(`\n[GenerateSMLFromConnection] Wrote ${model.sml.size} SML file(s) to: ${outputDir}`);
      } else {
        this.logger.log("[GenerateSMLFromConnection] No SML output was generated.");
      }

      // Summary
      this.logger.log(
        `[GenerateSMLFromConnection] Done — ` +
        `${model.facts.length} fact(s), ` +
        `${model.dimensions.length} dimension(s), ` +
        `${model.facts.reduce((n, f) => n + f.measures.length, 0)} measure(s)`,
      );

    } finally {
      await sql.close(conn);
    }
  }
}

// ----------------------------------------------------------
// File writer
// ----------------------------------------------------------

function writeSmlFiles(sml: Map<string, string>, outputDir: string, logger: Logger): void {
  for (const [relativePath, yamlContent] of sml) {
    const absolutePath = path.join(outputDir, relativePath);
    const dir = path.dirname(absolutePath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
    fs.writeFileSync(absolutePath, yamlContent, "utf8");
    logger.log(`  → ${relativePath}`);
  }
}
