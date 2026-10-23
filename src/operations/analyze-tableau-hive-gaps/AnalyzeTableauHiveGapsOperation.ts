/**
 * AnalyzeTableauHiveGaps
 *
 * Scans Tableau workbooks and data sources (.twb, .twbx, .tds, .tdsx) for the
 * installer → container migration, where AtScale's Hive thrift endpoint
 * (port 11111) is replaced by PGWire (port 15432). Reports:
 *
 *   - which files connect to the legacy endpoint, in validation-priority order
 *   - SQL that is sent to AtScale verbatim — RAWSQL_* fields, custom SQL,
 *     Initial SQL — and the HiveQL constructs in it, with PostgreSQL rewrites
 *   - fields that depend on RAWSQL fields, and driver-translated date functions
 *   - the worksheets and dashboards that use each of them
 *
 * No connection is required — everything is read from the files. Download the
 * workbooks and published data sources from Tableau Server first (see
 * docs/workflows/MIGRATE.md).
 *
 * Output:
 *   <output-dir>/TABLEAU_GAP_REPORT.md
 *   <output-dir>/TABLEAU_GAP_REPORT.json
 *   <output-dir>/TABLEAU_GAP_FILES.csv
 *   <output-dir>/TABLEAU_GAP_FINDINGS.csv
 */

import fs from "fs";
import path from "path";
import { Operation } from "../Operation.js";
import { ParameterSet, StringParameter } from "../../Parameters.js";
import type { ServiceRegistry } from "../../services/registry.js";
import type { Logger } from "../../logging.js";
import { readTableauFile, TABLEAU_EXTENSIONS, type TableauFile } from "./tableau-reader.js";
import { analyzeFiles, DEFAULT_ANALYZER_OPTIONS } from "./gap-analyzer.js";
import {
  renderFilesCsv, renderFindingsCsv, renderGapJson, renderGapMarkdown,
} from "./gap-report.js";

class AnalyzeTableauHiveGapsParamsSet extends ParameterSet {
  parameters = [
    new (class extends StringParameter {
      name        = "tableau-path";
      description = "Tableau file (.twb, .twbx, .tds, .tdsx) or a directory scanned recursively for them";
      required    = true;
    })(),
    new (class extends StringParameter {
      name        = "output-dir";
      description = "Directory where the gap report will be written";
      required    = true;
    })(),
    new (class extends StringParameter {
      name        = "atscale-host";
      description = "Only count connections whose server contains this text (use when other Hive or Spark sources exist)";
      required    = false;
    })(),
    new (class extends StringParameter {
      name         = "legacy-port";
      description  = "Port of the legacy AtScale Hive thrift endpoint";
      required     = false;
      defaultValue = DEFAULT_ANALYZER_OPTIONS.legacyPort;
    })(),
    new (class extends StringParameter {
      name         = "pgwire-port";
      description  = "Port of the AtScale PGWire endpoint, to recognise files already migrated";
      required     = false;
      defaultValue = DEFAULT_ANALYZER_OPTIONS.pgwirePort;
    })(),
  ];
}

type Params = {
  "tableau-path":  string;
  "output-dir":    string;
  "atscale-host"?: string;
  "legacy-port"?:  string;
  "pgwire-port"?:  string;
};
export type AnalyzeTableauHiveGapsParams = Params;

function listTableauFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...listTableauFiles(full));
    else if (TABLEAU_EXTENSIONS.includes(path.extname(entry.name).toLowerCase())) out.push(full);
  }
  return out.sort();
}

export class AnalyzeTableauHiveGapsOperation extends Operation<Params> {
  name        = "analyze-tableau-hive-gaps";
  description = "Find Tableau workbooks and data sources affected by the Hive thrift → PGWire switch, and the RAWSQL / custom SQL in them that needs rewriting";
  parameters  = new AnalyzeTableauHiveGapsParamsSet();

  constructor(services: ServiceRegistry, logger: Logger) {
    super(services, logger);
  }

  async run(params: Params): Promise<void> {
    const input     = path.resolve(params["tableau-path"]);
    const outputDir = path.resolve(params["output-dir"]);

    if (!fs.existsSync(input)) {
      throw new Error(`Tableau input not found: ${input}`);
    }
    const isDir = fs.statSync(input).isDirectory();
    const paths = isDir ? listTableauFiles(input) : [input];
    if (paths.length === 0) {
      throw new Error(`No ${TABLEAU_EXTENSIONS.join(", ")} files found under ${input}`);
    }

    this.logger.log(`[AnalyzeTableauHiveGaps] Reading ${paths.length} Tableau file(s) from ${input}`);
    const files: TableauFile[] = [];
    for (const p of paths) {
      const rel = isDir ? path.relative(input, p) : path.basename(p);
      const file = await readTableauFile(p, rel);
      if (file.parseError) this.logger.log(`  ! ${rel}: ${file.parseError}`);
      files.push(file);
    }

    const analysis = analyzeFiles(files, {
      atscaleHost: params["atscale-host"] || undefined,
      legacyPort:  params["legacy-port"] || DEFAULT_ANALYZER_OPTIONS.legacyPort,
      pgwirePort:  params["pgwire-port"] || DEFAULT_ANALYZER_OPTIONS.pgwirePort,
    });

    fs.mkdirSync(outputDir, { recursive: true });
    const outputs: Array<[string, string]> = [
      ["TABLEAU_GAP_REPORT.md", renderGapMarkdown(analysis)],
      ["TABLEAU_GAP_REPORT.json", renderGapJson(analysis)],
      ["TABLEAU_GAP_FILES.csv", renderFilesCsv(analysis)],
      ["TABLEAU_GAP_FINDINGS.csv", renderFindingsCsv(analysis)],
    ];
    for (const [name, content] of outputs) {
      fs.writeFileSync(path.join(outputDir, name), content, "utf8");
      this.logger.log(`  → ${name}`);
    }

    const { summary } = analysis;
    this.logger.log(
      `[AnalyzeTableauHiveGaps] Done — ${summary.affected} affected, ` +
      `${summary.unresolved} on unscanned published sources, ` +
      `${summary.migrated} already on PGWire, ${summary.notAffected} not on AtScale` +
      (summary.parseErrors ? `, ${summary.parseErrors} unreadable` : "") +
      `. Priority 1 (verbatim SQL): ${summary.byPriority[1]}.`,
    );
  }
}
