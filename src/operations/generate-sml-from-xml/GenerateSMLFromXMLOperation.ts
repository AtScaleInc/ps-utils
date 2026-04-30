/**
 * GenerateSMLFromXML
 *
 * Reads an AtScale XML project file (schema version project_2_0) and converts
 * it to AtScale SML YAML files by applying the algorithm documented in
 * CONVERSION.md.  No database connection is required — the conversion runs
 * entirely from the XML model definition.
 *
 * Output files are written to the specified directory following the SML layout:
 *   <output-dir>/catalog.yml
 *   <output-dir>/connections/<connectionName>.yml
 *   <output-dir>/datasets/<dataset>.yml
 *   <output-dir>/dimensions/<dimension>.yml
 *   <output-dir>/metrics/<metric>.yml
 *   <output-dir>/models/<modelName>.yml
 */
import fs from "fs";
import path from "path";
import { Operation } from "../Operation.js";
import { ParameterSet, StringParameter } from "../../Parameters.js";
import type { ServiceRegistry } from "../../services/registry.js";
import type { Logger } from "../../logging.js";
import { convertXmlToSml } from "./xml-converter.js";
import { writeSmlFiles } from "../generate-sml-shared.js";

// ----------------------------------------------------------
// Parameter declarations
// ----------------------------------------------------------

class GenerateSMLFromXMLParams extends ParameterSet {
  parameters = [
    new (class extends StringParameter {
      name        = "xml-file";
      description = "Path to the AtScale XML project file to convert";
      required    = true;
    })(),
    new (class extends StringParameter {
      name        = "output-dir";
      description = "Directory where SML files will be written";
      required    = true;
    })(),
    new (class extends StringParameter {
      name        = "connection-name";
      description = "SML connection unique_name to embed in generated files (auto-detected from XML if omitted)";
      required    = false;
    })(),
    new (class extends StringParameter {
      name        = "connection-type";
      description = 'Database dialect for the connection file (e.g. "snowflake", "postgresql")';
      required    = false;
    })(),
    new (class extends StringParameter {
      name        = "catalog-name";
      description = "Override the catalog label (defaults to the XML schema name)";
      required    = false;
    })(),
    new (class extends StringParameter {
      name        = "connection-db";
      description = "Database name written into the connection file; when set, datasets use a plain table name instead of a nested db/schema/name object";
      required    = false;
    })(),
    new (class extends StringParameter {
      name        = "connection-schema";
      description = "Schema name written into the connection file; when set, datasets use a plain table name instead of a nested db/schema/name object";
      required    = false;
    })(),
  ];
}

type Params = {
  "xml-file":           string;
  "output-dir":         string;
  "connection-name"?:   string;
  "connection-type"?:   string;
  "catalog-name"?:      string;
  "connection-db"?:     string;
  "connection-schema"?: string;
};

// ----------------------------------------------------------
// Operation
// ----------------------------------------------------------

export class GenerateSMLFromXMLOperation extends Operation<Params> {
  name        = "generate-sml-from-xml";
  description = "Convert an AtScale XML project file (project_2_0 format) to AtScale SML files";
  parameters  = new GenerateSMLFromXMLParams();

  constructor(services: ServiceRegistry, logger: Logger) {
    super(services, logger);
  }

  async run(params: Params): Promise<void> {
    const xmlFile   = path.resolve(params["xml-file"]);
    const outputDir = path.resolve(params["output-dir"]);

    if (!fs.existsSync(xmlFile)) {
      throw new Error(`XML file not found: ${xmlFile}`);
    }

    this.logger.log(`[GenerateSMLFromXML] Reading: ${xmlFile}`);
    const xmlContent = fs.readFileSync(xmlFile, "utf8");

    const sml = await convertXmlToSml(
      xmlContent,
      {
        connectionName:   params["connection-name"],
        connectionType:   params["connection-type"],
        catalogName:      params["catalog-name"],
        connectionDb:     params["connection-db"],
        connectionSchema: params["connection-schema"],
      },
      this.logger,
    );

    this.logger.log(`\n[GenerateSMLFromXML] Writing ${sml.size} SML file(s) to: ${outputDir}`);
    writeSmlFiles(sml, outputDir, this.logger);

    const datasetCount   = [...sml.keys()].filter((k) => k.startsWith("datasets/")).length;
    const dimCount       = [...sml.keys()].filter((k) => k.startsWith("dimensions/")).length;
    const metricCount    = [...sml.keys()].filter((k) => k.startsWith("metrics/")).length;
    const calcCount      = [...sml.keys()].filter((k) => k.startsWith("calculations/")).length;
    const modelCount     = [...sml.keys()].filter((k) => k.startsWith("models/")).length;

    this.logger.log(
      `[GenerateSMLFromXML] Done — ` +
      `${datasetCount} dataset(s), ${dimCount} dimension(s), ` +
      `${metricCount} metric(s)${calcCount ? `, ${calcCount} calculation(s)` : ""}, ${modelCount} model(s)`,
    );
  }
}
