/**
 * GenerateSMLFromDDL
 *
 * Parses a SQL DDL file (CREATE TABLE / CREATE VIEW statements) and generates
 * AtScale SML files by running the semantic model inference algorithm.
 *
 * No database connection is required — inference runs entirely from the schema
 * definition.  This is useful for offline model generation, CI pipelines, or
 * environments where a live connection is not available.
 *
 * Output files are written to the specified directory following the SML layout:
 *   <output-dir>/catalog.yml
 *   <output-dir>/connections/<connectionName>.yml   (optional — requires connection-name)
 *   <output-dir>/datasets/<table>.yml
 *   <output-dir>/dimensions/<dimension>.yml
 *   <output-dir>/metrics/<metric>.yml
 *   <output-dir>/models/<modelName>.yml
 */
import fs from "fs";
import path from "path";
import { Operation } from "../Operation.js";
import { ParameterSet, StringParameter } from "../Parameters.js";
import type { ServiceRegistry } from "../../services/registry.js";
import type { Logger } from "../../logging.js";
import { DdlDatabaseMetaData } from "../../algorithm/ddl-reader.js";
import { resolvePiiSeverity, runInferenceAndWrite } from "../generate-sml-shared.js";

// ----------------------------------------------------------
// Parameter declarations
// ----------------------------------------------------------

class GenerateSMLFromDDLParams extends ParameterSet {
  parameters = [
    new (class extends StringParameter {
      name        = "ddl-file";
      description = "Path to the SQL DDL file to parse (CREATE TABLE / CREATE VIEW statements)";
      required    = true;
    })(),
    new (class extends StringParameter {
      name        = "model-name";
      description = "Name for the generated semantic model (defaults to the DDL filename stem)";
      required    = false;
    })(),
    new (class extends StringParameter {
      name        = "output-dir";
      description = "Directory where SML files will be written";
      required    = true;
    })(),
    new (class extends StringParameter {
      name        = "connection-name";
      description = "Connection name to embed in the generated SML files (for AtScale to reference)";
      required    = false;
      defaultValue = "my_connection";
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
    new (class extends StringParameter {
      name        = "schema";
      description = "Schema name used to filter the DDL (only tables in this schema will be included)";
      required    = false;
    })(),
    new (class extends StringParameter {
      name        = "database";
      description = "Database (catalog) name to embed in the SML connection file";
      required    = false;
    })(),
  ];
}

type Params = {
  "ddl-file":        string;
  "model-name"?:     string;
  "output-dir":      string;
  "connection-name": string;
  "catalog-name"?:   string;
  "pii-severity":    string;
  schema?:           string;
  database?:         string;
};

// ----------------------------------------------------------
// Operation
// ----------------------------------------------------------

export class GenerateSMLFromDDLOperation extends Operation<Params> {
  name        = "generate-sml-from-ddl";
  description = "Parse a DDL file and generate AtScale SML files from the inferred semantic model";
  parameters  = new GenerateSMLFromDDLParams();

  constructor(services: ServiceRegistry, logger: Logger) {
    super(services, logger);
  }

  async run(params: Params): Promise<void> {
    const ddlFile   = path.resolve(params["ddl-file"]);
    const outputDir = path.resolve(params["output-dir"]);
    const modelName = params["model-name"] ?? path.basename(ddlFile, path.extname(ddlFile));

    if (!fs.existsSync(ddlFile)) {
      throw new Error(`DDL file not found: ${ddlFile}`);
    }

    this.logger.log(`[GenerateSMLFromDDL] Parsing DDL file: ${ddlFile}`);
    const db = await DdlDatabaseMetaData.fromFile(ddlFile);

    const tableNames = db.getTableNames();
    const viewNames  = db.getViewNames();
    this.logger.log(
      `[GenerateSMLFromDDL] Found ${tableNames.length} table(s) and ${viewNames.length} view(s)`,
    );

    await runInferenceAndWrite(
      db,
      modelName,
      {
        schemaPattern:        params.schema,
        piiExclusionSeverity: resolvePiiSeverity(params["pii-severity"]),
        sampleSize:           0,  // DDL has no row data; disable sampling
        sml: {
          connectionName: params["connection-name"],
          catalogName:    params["catalog-name"] ?? modelName,
          database:       params.database,
          schema:         params.schema,
        },
      },
      outputDir,
      this.logger,
      "GenerateSMLFromDDL",
    );
  }
}
