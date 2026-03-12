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
import { proposeSemanticModel } from "../../algorithm/jdbc-semantic-model.js";
import { createDefaultEngine } from "../../algorithm/inference/index.js";

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
    const ddlFile  = path.resolve(params["ddl-file"]);
    const outputDir = path.resolve(params["output-dir"]);

    // Derive model name from filename if not provided
    const modelName = params["model-name"] ?? path.basename(ddlFile, path.extname(ddlFile));

    if (!fs.existsSync(ddlFile)) {
      throw new Error(`DDL file not found: ${ddlFile}`);
    }

    this.logger.log(`[GenerateSMLFromDDL] Parsing DDL file: ${ddlFile}`);

    // Parse the DDL into a metadata source
    const db = await DdlDatabaseMetaData.fromFile(ddlFile);

    const tableNames = db.getTableNames();
    const viewNames  = db.getViewNames();
    this.logger.log(
      `[GenerateSMLFromDDL] Found ${tableNames.length} table(s) and ${viewNames.length} view(s)`,
    );

    // Resolve PII severity
    const piiRaw = (params["pii-severity"] ?? "MEDIUM").toUpperCase();
    const piiExclusionSeverity =
      piiRaw === "NONE"   ? false as const :
      piiRaw === "HIGH"   ? "HIGH" as const :
      piiRaw === "LOW"    ? "LOW"  as const :
                            "MEDIUM" as const;

    // Run semantic model inference
    this.logger.log(`[GenerateSMLFromDDL] Running inference on "${modelName}"…`);
    const model = await proposeSemanticModel(db, modelName, {
      schemaPattern: params.schema,
      inferenceEngine: createDefaultEngine(),
      piiExclusionSeverity,
      sampleSize: 0,  // DDL has no row data; disable sampling
      suggestions: true,
      sml: {
        connectionName: params["connection-name"],
        catalogName:    params["catalog-name"] ?? modelName,
      },
    });

    // Surface inference warnings
    if (model.warnings.length > 0) {
      this.logger.log(`\n[GenerateSMLFromDDL] Inference warnings:`);
      for (const w of model.warnings) {
        this.logger.log(`  ⚠  ${w}`);
      }
    }

    // Write SML files to disk
    if (model.sml && model.sml.size > 0) {
      writeSmlFiles(model.sml, outputDir, this.logger);
      this.logger.log(`\n[GenerateSMLFromDDL] Wrote ${model.sml.size} SML file(s) to: ${outputDir}`);
    } else {
      this.logger.log("[GenerateSMLFromDDL] No SML output was generated.");
    }

    // Summary
    this.logger.log(
      `[GenerateSMLFromDDL] Done — ` +
      `${model.facts.length} fact(s), ` +
      `${model.dimensions.length} dimension(s), ` +
      `${model.facts.reduce((n, f) => n + f.measures.length, 0)} measure(s)`,
    );
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
