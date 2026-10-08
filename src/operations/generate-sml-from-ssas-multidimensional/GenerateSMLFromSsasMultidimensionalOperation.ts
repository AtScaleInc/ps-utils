/**
 * GenerateSMLFromSsasMultidimensional
 *
 * Reads an SSAS Multidimensional (classic OLAP cube) XMLA export and converts
 * it to AtScale SML files. Internally this is a two-stage pipeline:
 *
 *   1. ssas-md-converter.ts converts the SSAS XMLA into an AtScale project XML
 *      string (project_2_0 schema).
 *   2. That XML is handed to generate-sml-from-xml's `convertXmlToSml` —
 *      reused unmodified — to produce the actual SML files.
 *
 * No database connection is required — the conversion runs entirely from the
 * XMLA model definition, using each cube's DataSourceView to recover physical
 * table/column names.
 *
 * Output files are written to the specified directory following the SML layout:
 *   <output-dir>/catalog.yml
 *   <output-dir>/connections/<connectionName>.yml
 *   <output-dir>/datasets/<dataset>.yml
 *   <output-dir>/dimensions/<dimension>.yml
 *   <output-dir>/metrics/<metric>.yml
 *   <output-dir>/models/<cubeName>.yml (one per SSAS cube)
 *   <output-dir>/context/generated-project.xml (the intermediate AtScale XML, for traceability)
 */
import fs from "fs";
import path from "path";
import { Operation } from "../Operation.js";
import { ParameterSet, StringParameter } from "../../Parameters.js";
import type { ServiceRegistry } from "../../services/registry.js";
import type { Logger } from "../../logging.js";
import { convertSsasMultidimensionalToXml, type Issue } from "./ssas-md-converter.js";
import { convertXmlToSml } from "../generate-sml-from-xml/xml-converter.js";
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

class GenerateSMLFromSsasMultidimensionalParamsSet extends ParameterSet {
  parameters = [
    new (class extends StringParameter {
      name        = "xmla-file";
      description = "Path to the SSAS Multidimensional XMLA export (Create/ObjectDefinition/Database script) to convert";
      required    = true;
    })(),
    new (class extends StringParameter {
      name        = "output-dir";
      description = "Directory where SML files will be written";
      required    = true;
    })(),
    new (class extends StringParameter {
      name        = "catalog-name";
      description = "Override the catalog label (defaults to a name derived from the XMLA file)";
      required    = false;
    })(),
    new (class extends StringParameter {
      name        = "connection-type";
      description = 'Database dialect for the connection file (e.g. "snowflake", "postgresql")';
      required    = false;
    })(),
    new (class extends StringParameter {
      name        = "connection-db";
      description = "Database name written into the connection file";
      required    = false;
    })(),
    new (class extends StringParameter {
      name        = "connection-schema";
      description = "Schema name written into the connection file";
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
  "xmla-file":          string;
  "output-dir":         string;
  "catalog-name"?:      string;
  "connection-type"?:   string;
  "connection-db"?:     string;
  "connection-schema"?: string;
  "model-mode"?:        ModelMode;
};
export type GenerateSMLFromSsasMultidimensionalParams = Params;

// ----------------------------------------------------------
// Report helpers
// ----------------------------------------------------------

function issuesMarkdown(issues: Issue[]): string {
  if (issues.length === 0) return "";
  const sevOrder: Record<string, number> = { error: 0, action_needed: 1, warning: 2, info: 3 };
  const sorted = [...issues].sort((a, b) => (sevOrder[a.severity] ?? 9) - (sevOrder[b.severity] ?? 9));
  const lines = [
    "", "## SSAS Multidimensional Import Notes", "",
    "Issues noticed while converting the source SSAS XMLA to AtScale SML, sorted by severity " +
      "(error > action_needed > warning > info). See `context/generated-project.xml` for the " +
      "intermediate AtScale project XML this was derived from.", "",
    "| Severity | Category | Object | Message |", "|---|---|---|---|",
  ];
  for (const i of sorted) {
    lines.push(`| ${i.severity} | ${i.category} | \`${i.object}\` | ${i.message.replace(/\|/g, "\\|")} |`);
  }
  return lines.join("\n") + "\n";
}

// ----------------------------------------------------------
// Operation
// ----------------------------------------------------------

export class GenerateSMLFromSsasMultidimensionalOperation extends Operation<Params> {
  name        = "generate-sml-from-ssas-multidimensional";
  description = "Convert an SSAS Multidimensional XMLA export to AtScale SML files";
  parameters  = new GenerateSMLFromSsasMultidimensionalParamsSet();

  constructor(services: ServiceRegistry, logger: Logger) {
    super(services, logger);
  }

  async run(params: Params): Promise<void> {
    const xmlaFile  = path.resolve(params["xmla-file"]);
    const outputDir = path.resolve(params["output-dir"]);

    if (!fs.existsSync(xmlaFile)) {
      throw new Error(`XMLA file not found: ${xmlaFile}`);
    }

    this.logger.log(`[GenerateSMLFromSsasMultidimensional] Reading: ${xmlaFile}`);
    const xmlaContent = fs.readFileSync(xmlaFile, "utf8");

    const { projectXml, issues } = await convertSsasMultidimensionalToXml(
      xmlaContent,
      { xmlaFileName: path.basename(xmlaFile), catalogName: params["catalog-name"] },
      this.logger,
    );

    for (const i of issues) {
      this.logger.verbose(`[GenerateSMLFromSsasMultidimensional] [${i.severity}][${i.category}] ${i.object}: ${i.message}`);
    }

    const generatedSml = await convertXmlToSml(
      projectXml,
      {
        xmlFileName:      path.basename(xmlaFile),
        catalogName:      params["catalog-name"],
        connectionType:   params["connection-type"],
        connectionDb:     params["connection-db"],
        connectionSchema: params["connection-schema"],
      },
      this.logger,
    );

    const compatibility = await applyModelCompatibilityPolicy(
      generatedSml,
      params["model-mode"],
      this.logger,
    );

    const notes = issuesMarkdown(issues);
    const readme = (compatibility.sml.get("README.md") ?? "# SSAS Multidimensional to SML Conversion\n") +
      notes +
      (compatibility.modelMode || compatibility.collisionSets.length > 0 ? compatibilityReportMarkdown(compatibility) : "");
    const sml = new Map(compatibility.sml)
      .set("README.md", readme)
      .set("context/generated-project.xml", projectXml);

    this.logger.log(`\n[GenerateSMLFromSsasMultidimensional] Writing ${sml.size} file(s) to: ${outputDir}`);
    writeSmlFiles(sml, outputDir, this.logger);

    const datasetCount = [...sml.keys()].filter((k) => k.startsWith("datasets/")).length;
    const dimCount     = [...sml.keys()].filter((k) => k.startsWith("dimensions/")).length;
    const metricCount  = [...sml.keys()].filter((k) => k.startsWith("metrics/")).length;
    const modelCount   = [...sml.keys()].filter((k) => k.startsWith("models/")).length;

    this.logger.log(
      `[GenerateSMLFromSsasMultidimensional] Done — ` +
      `${datasetCount} dataset(s), ${dimCount} dimension(s), ${metricCount} metric(s), ${modelCount} model(s), ` +
      `${issues.length} issue(s) noted`,
    );

    if (compatibility.reviewRequired) {
      throw new Error(formatExistingConflict(compatibility));
    }
  }
}
