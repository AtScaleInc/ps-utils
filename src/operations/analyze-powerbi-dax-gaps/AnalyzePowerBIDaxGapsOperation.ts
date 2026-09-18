/**
 * AnalyzePowerBIDaxGaps
 *
 * Reads a Power BI .pbix and reports which of its report-scoped DAX measures
 * AtScale can evaluate, against two distinct surfaces:
 *
 *   - client-side DAX (the measure stays in the report, Power BI sends it to
 *     AtScale over XMLA)
 *   - server-side DAX (the measure is pushed down into the AtScale model)
 *
 * No connection is required — everything is read from the file.
 *
 * Output:
 *   <output-dir>/PBIX_GAP_REPORT.md
 *   <output-dir>/PBIX_GAP_REPORT.json
 *   <output-dir>/PBIX_GAP_REPORT.csv
 */

import fs from "fs";
import path from "path";
import { Operation } from "../Operation.js";
import { ParameterSet, StringParameter } from "../../Parameters.js";
import type { ServiceRegistry } from "../../services/registry.js";
import type { Logger } from "../../logging.js";
import { readPbix } from "./pbix-reader.js";
import { analyzeReport } from "./gap-analyzer.js";
import { renderGapCsv, renderGapJson, renderGapMarkdown } from "./gap-report.js";

class AnalyzePowerBIDaxGapsParamsSet extends ParameterSet {
  parameters = [
    new (class extends StringParameter {
      name        = "pbix-file";
      description = "Path to the Power BI .pbix file to analyse";
      required    = true;
    })(),
    new (class extends StringParameter {
      name        = "output-dir";
      description = "Directory where the gap report will be written";
      required    = true;
    })(),
  ];
}

type Params = {
  "pbix-file":  string;
  "output-dir": string;
};
export type AnalyzePowerBIDaxGapsParams = Params;

export class AnalyzePowerBIDaxGapsOperation extends Operation<Params> {
  name        = "analyze-powerbi-dax-gaps";
  description = "Analyse a Power BI .pbix and report which report-scoped DAX measures AtScale supports";
  parameters  = new AnalyzePowerBIDaxGapsParamsSet();

  constructor(services: ServiceRegistry, logger: Logger) {
    super(services, logger);
  }

  async run(params: Params): Promise<void> {
    const pbixFile  = path.resolve(params["pbix-file"]);
    const outputDir = path.resolve(params["output-dir"]);

    if (!fs.existsSync(pbixFile)) {
      throw new Error(`Power BI file not found: ${pbixFile}`);
    }

    this.logger.log(`[AnalyzePowerBIDaxGaps] Reading: ${pbixFile}`);
    const report = await readPbix(pbixFile, path.basename(pbixFile));

    if (report.hasEmbeddedDataModel) {
      this.logger.log(
        "[AnalyzePowerBIDaxGaps] This .pbix contains an embedded DataModel, which is " +
        "an XPress9-compressed Analysis Services backup and cannot be read here. " +
        "Only report-scoped measures are analysed; extract the model with pbi-tools " +
        "and run generate-sml-from-tabular for the model-side picture.",
      );
    }

    const analysis = analyzeReport(report);
    const { summary } = analysis;

    if (summary.total === 0) {
      this.logger.log(
        "[AnalyzePowerBIDaxGaps] No report-scoped DAX measures found. " +
        (report.hasEmbeddedDataModel
          ? "This report's measures are likely in its embedded model."
          : "This report may use only model-defined measures."),
      );
    }

    fs.mkdirSync(outputDir, { recursive: true });
    const files: Array<[string, string]> = [
      ["PBIX_GAP_REPORT.md", renderGapMarkdown(analysis)],
      ["PBIX_GAP_REPORT.json", renderGapJson(analysis)],
      ["PBIX_GAP_REPORT.csv", renderGapCsv(analysis)],
    ];
    for (const [name, content] of files) {
      const target = path.join(outputDir, name);
      fs.writeFileSync(target, content, "utf8");
      this.logger.log(`  → ${name}`);
    }

    this.logger.log(
      `[AnalyzePowerBIDaxGaps] Done — ${summary.total} report-scoped measure(s): ` +
      `${summary.keepInReport} supported client-side, ` +
      `${summary.pushToModel} convert server-side, ` +
      `${summary.redesign} need redesign` +
      (summary.parseErrors ? `, ${summary.parseErrors} unparseable` : ""),
    );
  }
}
