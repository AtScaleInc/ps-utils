/**
 * GenerateReportFromXML
 *
 * Reads an AtScale XML project file (project_2_0 schema — the same source
 * format generate-sml-from-xml converts) and writes a single, human-readable
 * Markdown report describing every object found in the model: connections,
 * physical datasets (tables/queries/columns), the fact-to-dimension join
 * graph, the schema-level attribute library, dimensions (hierarchies, levels,
 * secondary attributes), cubes (measures, calculated members, User Defined
 * Aggregates, named sets, KPIs, drillthrough), and the schema-level
 * calculated-member formula library.
 *
 * Unlike generate-sml-from-xml, this is a read-only report — nothing is
 * renamed, deduplicated, or reshaped for SML compatibility, and objects the
 * converter skips (perspectives, roles, translations, named sets, KPIs) are
 * still listed, so the report is a complete inventory of the source model.
 *
 * No database connection is required — like generate-sml-from-xml, this runs
 * entirely from the XML model definition.
 */
import fs from "fs";
import path from "path";
import { Operation } from "../Operation.js";
import { ParameterSet, StringParameter } from "../../Parameters.js";
import type { ServiceRegistry } from "../../services/registry.js";
import type { Logger } from "../../logging.js";
import { generateReportFromXml } from "./xml-report-generator.js";

// ----------------------------------------------------------
// Parameter declarations
// ----------------------------------------------------------

class GenerateReportFromXMLParamsSet extends ParameterSet {
  parameters = [
    new (class extends StringParameter {
      name        = "xml-file";
      description = "Path to the AtScale XML project file to report on";
      required    = true;
    })(),
    new (class extends StringParameter {
      name        = "output-file";
      description = "Output Markdown file path. Omit to print to stdout.";
      required    = false;
    })(),
    new (class extends StringParameter {
      name        = "title";
      description = "H1 title for the report. Defaults to the XML schema name.";
      required    = false;
    })(),
  ];
}

type Params = {
  "xml-file":      string;
  "output-file"?:  string;
  title?:          string;
};
export type GenerateReportFromXMLParams = Params;

// ----------------------------------------------------------
// Operation
// ----------------------------------------------------------

export class GenerateReportFromXMLOperation extends Operation<Params> {
  name        = "generate-report-from-xml";
  description = "Read an AtScale XML project file and generate a complete, human-readable Markdown report of every object — connections, datasets, joins, dimensions, hierarchies, levels, attributes, measures, calculated members, aggregates, and more";
  parameters  = new GenerateReportFromXMLParamsSet();

  constructor(services: ServiceRegistry, logger: Logger) {
    super(services, logger);
  }

  async run(params: Params): Promise<void> {
    const xmlFile = path.resolve(params["xml-file"]);

    if (!fs.existsSync(xmlFile)) {
      throw new Error(`XML file not found: ${xmlFile}`);
    }

    this.logger.log(`[GenerateReportFromXML] Reading: ${xmlFile}`);
    const xmlContent = fs.readFileSync(xmlFile, "utf8");

    const markdown = await generateReportFromXml(xmlContent, {
      xmlFileName: path.basename(xmlFile),
      title:       params.title,
    });

    if (params["output-file"]) {
      const outputPath = path.resolve(params["output-file"]);
      fs.mkdirSync(path.dirname(outputPath), { recursive: true });
      fs.writeFileSync(outputPath, markdown, "utf8");
      this.logger.log(`[GenerateReportFromXML] Written → ${outputPath}`);
    } else {
      process.stdout.write(markdown);
    }
  }
}
