/**
 * GenerateSMLFromTabular
 *
 * Reads an SSAS Tabular model export (TMSL/XMLA `createOrReplace` JSON) and
 * converts it to AtScale SML files by applying the algorithm documented in
 * tabular-converter.ts. No database connection is required — the conversion
 * runs entirely from the TMSL model definition (though partition queries are
 * parsed to recover real physical table/column names where possible).
 *
 * Output files are written to the specified directory following the SML layout:
 *   <output-dir>/catalog.yml
 *   <output-dir>/connections/<connectionName>.yml
 *   <output-dir>/datasets/<dataset>.yml
 *   <output-dir>/dimensions/<dimension>.yml
 *   <output-dir>/metrics/<metric>.yml
 *   <output-dir>/models/<modelName>.yml
 *   <output-dir>/README.md
 *   <output-dir>/DEFERRED_MEASURES.md
 *   <output-dir>/CONVERSION_REPORT.md
 *   <output-dir>/CONVERSION_REPORT.json
 *   <output-dir>/context/{ddl.sql, erd.mmd, use_case.md, build.yaml, <source file>}
 */
import fs from "fs";
import path from "path";
import { Operation } from "../Operation.js";
import { ParameterSet, StringParameter } from "../../Parameters.js";
import type { ServiceRegistry } from "../../services/registry.js";
import type { Logger } from "../../logging.js";
import { convertTabularToSml, type TmslDocument, type Warehouse } from "./tabular-converter.js";
import { writeSmlFiles } from "../generate-sml-shared.js";
import {
  applyModelCompatibilityPolicy,
  compatibilityReportMarkdown,
  formatExistingConflict,
  parseModelMode,
  type ModelMode,
} from "../model-query-name-compatibility.js";

// ----------------------------------------------------------
// Parameter declarations
// ----------------------------------------------------------

const WAREHOUSES = ["Snowflake", "Databricks", "BigQuery", "Postgres"];

function parseWarehouse(value: string): Warehouse {
  const match = WAREHOUSES.find((w) => w.toLowerCase() === value.toLowerCase());
  if (!match) {
    throw new Error(`--warehouse must be one of: ${WAREHOUSES.join(", ")} (got '${value}')`);
  }
  return match as Warehouse;
}

class GenerateSMLFromTabularParamsSet extends ParameterSet {
  parameters = [
    new (class extends StringParameter {
      name        = "xmla-file";
      description = "Path to the TMSL/XMLA export (createOrReplace JSON) to convert";
      required    = true;
    })(),
    new (class extends StringParameter {
      name        = "warehouse";
      description = "Target warehouse dialect: Snowflake, Databricks, BigQuery, or Postgres";
      required    = true;
      validate(value: string): void { parseWarehouse(value); }
    })(),
    new (class extends StringParameter {
      name        = "database";
      description = "Primary connection database/catalog name";
      required    = true;
    })(),
    new (class extends StringParameter {
      name        = "schema";
      description = "Primary connection schema name";
      required    = true;
    })(),
    new (class extends StringParameter {
      name        = "model-name";
      description = "SML model_unique_name (snake_case recommended)";
      required    = true;
    })(),
    new (class extends StringParameter {
      name        = "output-dir";
      description = "Directory where SML files will be written";
      required    = true;
    })(),
    new (class extends StringParameter {
      name        = "catalog-name";
      description = "Override the catalog unique_name (defaults to '{model-name}_catalog')";
      required    = false;
    })(),
    new (class extends StringParameter {
      name         = "currency";
      description  = "Currency code used for currency-formatted metrics";
      required     = false;
      defaultValue = "USD";
    })(),
    new (class extends StringParameter {
      name        = "description";
      description = "Optional catalog/model description override";
      required    = false;
    })(),
    new (class extends StringParameter {
      name        = "model-mode";
      description = 'Model compatibility policy used only when query-name collisions occur: "new" may rename colliding objects; "existing" preserves established names and reports a blocking conflict.';
      required    = false;
      validate(value: string): void { parseModelMode(value); }
    })(),
  ];
}

type Params = {
  "xmla-file":      string;
  "warehouse":      string;
  "database":       string;
  "schema":         string;
  "model-name":     string;
  "output-dir":     string;
  "catalog-name"?:  string;
  "currency":       string;
  "description"?:   string;
  "model-mode"?:    ModelMode;
};
export type GenerateSMLFromTabularParams = Params;

// ----------------------------------------------------------
// Operation
// ----------------------------------------------------------

export class GenerateSMLFromTabularOperation extends Operation<Params> {
  name        = "generate-sml-from-tabular";
  description = "Convert an SSAS Tabular model export (TMSL/XMLA) to AtScale SML files";
  parameters  = new GenerateSMLFromTabularParamsSet();

  constructor(services: ServiceRegistry, logger: Logger) {
    super(services, logger);
  }

  async run(params: Params): Promise<void> {
    const xmlaFile  = path.resolve(params["xmla-file"]);
    const outputDir = path.resolve(params["output-dir"]);

    if (!fs.existsSync(xmlaFile)) {
      throw new Error(`TMSL/XMLA file not found: ${xmlaFile}`);
    }

    this.logger.log(`[GenerateSMLFromTabular] Reading: ${xmlaFile}`);
    const rawContent = fs.readFileSync(xmlaFile, "utf8");
    const tmsl = JSON.parse(rawContent) as TmslDocument;

    const { sml: generatedSml } = convertTabularToSml(tmsl, {
      tmslFileName:    path.basename(xmlaFile),
      warehouse:       parseWarehouse(params["warehouse"]),
      database:        params["database"],
      schema:          params["schema"],
      modelName:       params["model-name"],
      catalogName:     params["catalog-name"],
      currency:        params["currency"],
      description:     params["description"],
      tmslRawContent:  rawContent,
    });

    const compatibility = await applyModelCompatibilityPolicy(
      generatedSml,
      params["model-mode"],
      this.logger,
    );
    const sml = compatibility.modelMode || compatibility.collisionSets.length > 0
      ? new Map(compatibility.sml).set(
          "README.md",
          (compatibility.sml.get("README.md") ?? "# Tabular to SML Conversion\n") +
            compatibilityReportMarkdown(compatibility),
        )
      : compatibility.sml;

    this.logger.log(`\n[GenerateSMLFromTabular] Writing ${sml.size} file(s) to: ${outputDir}`);
    writeSmlFiles(sml, outputDir, this.logger);

    const datasetCount = [...sml.keys()].filter((k) => k.startsWith("datasets/")).length;
    const dimCount     = [...sml.keys()].filter((k) => k.startsWith("dimensions/")).length;
    const metricCount  = [...sml.keys()].filter((k) => k.startsWith("metrics/")).length;
    const modelCount   = [...sml.keys()].filter((k) => k.startsWith("models/")).length;

    this.logger.log(
      `[GenerateSMLFromTabular] Done — ` +
      `${datasetCount} dataset(s), ${dimCount} dimension(s), ${metricCount} metric(s), ${modelCount} model(s)`,
    );

    if (compatibility.reviewRequired) {
      throw new Error(formatExistingConflict(compatibility));
    }
  }
}
