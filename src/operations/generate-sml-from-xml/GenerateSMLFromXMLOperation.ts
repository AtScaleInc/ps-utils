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
      description = "SML connection unique_name to embed in generated files";
      required    = false;
      defaultValue = "my_connection";
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
  ];
}

type Params = {
  "xml-file":         string;
  "output-dir":       string;
  "connection-name":  string;
  "connection-type"?: string;
  "catalog-name"?:    string;
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
        connectionName: params["connection-name"],
        connectionType: params["connection-type"],
        catalogName:    params["catalog-name"],
      },
      this.logger,
    );

    this.logger.log(`\n[GenerateSMLFromXML] Writing ${sml.size} SML file(s) to: ${outputDir}`);
    writeSmlFiles(sml, outputDir, this.logger);

    const datasetCount   = [...sml.keys()].filter((k) => k.startsWith("datasets/")).length;
    const dimCount       = [...sml.keys()].filter((k) => k.startsWith("dimensions/")).length;
    const metricCount    = [...sml.keys()].filter((k) => k.startsWith("metrics/")).length;
    const modelCount     = [...sml.keys()].filter((k) => k.startsWith("models/")).length;

    this.logger.log(
      `[GenerateSMLFromXML] Done — ` +
      `${datasetCount} dataset(s), ${dimCount} dimension(s), ` +
      `${metricCount} metric(s), ${modelCount} model(s)`,
    );
  }
}
