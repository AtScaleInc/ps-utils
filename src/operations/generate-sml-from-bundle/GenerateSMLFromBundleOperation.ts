/**
 * GenerateSMLFromBundle
 *
 * Converts every AtScale project.xml found inside one or more support bundles
 * to SML, one SML repository per project, using the same converter as
 * `generate-sml-from-xml`.  No database connection is required.
 *
 * Output layout:
 *   <output-dir>/<bundle>/<org>/<project>__<id8>/   one SML repo per project
 *   <output-dir>/summary.csv                        one row per project
 *   <output-dir>/summary.md                         the same, readable
 *   <output-dir>/.logs/<bundle>/<org>/<project>.log converter output, kept only on failure
 *
 * Re-runs skip projects whose output already exists unless --force is given.
 * The operation fails (non-zero exit) if any project failed to convert, but
 * only after every project has been attempted and the summary written.
 */
import fs from "fs";
import path from "path";
import { Operation } from "../Operation.js";
import { BooleanParameter, ParameterSet, StringParameter } from "../../Parameters.js";
import type { ServiceRegistry } from "../../services/registry.js";
import type { Logger } from "../../logging.js";
import { convertXmlToSml } from "../generate-sml-from-xml/xml-converter.js";
import { writeSmlFiles } from "../generate-sml-shared.js";
import {
  applyModelCompatibilityPolicy,
  compatibilityReportMarkdown,
  formatExistingConflict,
  parseModelMode,
  type ModelMode,
} from "../model-query-name-compatibility.js";
import {
  discoverBundleProjects,
  slug,
  splitList,
  type BundleProject,
} from "./bundle-walker.js";

// ----------------------------------------------------------
// Parameter declarations
// ----------------------------------------------------------

class GenerateSMLFromBundleParamsSet extends ParameterSet {
  parameters = [
    new (class extends StringParameter {
      name        = "bundles";
      description = "Comma-separated support bundle paths (directories or .zip files), each containing a metadata/ folder";
      required    = true;
    })(),
    new (class extends StringParameter {
      name        = "output-dir";
      description = "Directory that receives one SML repository per project plus summary.csv and summary.md";
      required    = true;
    })(),
    new (class extends BooleanParameter {
      name        = "force";
      description = "Re-convert projects whose output directory already exists";
      required    = false;
      defaultValue = false;
      isFlag      = true;
    })(),
    new (class extends StringParameter {
      name        = "org";
      description = "Comma-separated organisation folder names to include (installer bundles); default is all";
      required    = false;
    })(),
    new (class extends StringParameter {
      name        = "connection-name";
      description = "SML connection unique_name to embed in generated files (auto-detected from each XML if omitted)";
      required    = false;
    })(),
    new (class extends StringParameter {
      name        = "connection-type";
      description = 'Database dialect for the connection files (e.g. "snowflake", "bigquery")';
      required    = false;
    })(),
    new (class extends StringParameter {
      name        = "connection-db";
      description = "Database name written into the connection files; when set, every dataset shares one connection";
      required    = false;
    })(),
    new (class extends StringParameter {
      name        = "connection-schema";
      description = "Schema name written into the connection files; when set, every dataset shares one connection";
      required    = false;
    })(),
    new (class extends StringParameter {
      name        = "model-mode";
      description = 'Model compatibility policy applied to every project when query-name collisions occur: "new" renames colliding objects; "existing" preserves names and marks the project failed for review. Pass "new" for unattended runs.';
      required    = false;
      validate(value: string): void { parseModelMode(value); }
    })(),
  ];
}

type Params = {
  "bundles":            string;
  "output-dir":         string;
  "force"?:             boolean;
  "org"?:               string;
  "connection-name"?:   string;
  "connection-type"?:   string;
  "connection-db"?:     string;
  "connection-schema"?: string;
  "model-mode"?:        ModelMode;
};
export type GenerateSMLFromBundleParams = Params;

// ----------------------------------------------------------
// Result bookkeeping
// ----------------------------------------------------------

type ProjectStatus = "ok" | "ok-no-model" | "skipped" | "FAILED";

type ProjectResult = {
  project:      BundleProject;
  outputDir:    string;
  status:       ProjectStatus;
  datasets:     number;
  dimensions:   number;
  metrics:      number;
  calculations: number;
  models:       number;
  logPath:      string;
  error?:       string;
};

const SUMMARY_HEADER =
  "bundle,org,project,project_id,status,datasets,dimensions,metrics,calculations,models,output_dir,log";

function csvCell(value: string | number): string {
  const text = String(value);
  return /[",\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

function countFiles(dir: string): number {
  if (!fs.existsSync(dir)) return 0;
  return fs.readdirSync(dir).filter((f) => f.endsWith(".yml") || f.endsWith(".yaml")).length;
}

function countsFromDir(dir: string): Pick<ProjectResult, "datasets" | "dimensions" | "metrics" | "calculations" | "models"> {
  return {
    datasets:     countFiles(path.join(dir, "datasets")),
    dimensions:   countFiles(path.join(dir, "dimensions")),
    metrics:      countFiles(path.join(dir, "metrics")),
    calculations: countFiles(path.join(dir, "calculations")),
    models:       countFiles(path.join(dir, "models")),
  };
}

function countsFromSml(sml: Map<string, string>): Pick<ProjectResult, "datasets" | "dimensions" | "metrics" | "calculations" | "models"> {
  const count = (prefix: string) => [...sml.keys()].filter((k) => k.startsWith(prefix)).length;
  return {
    datasets:     count("datasets/"),
    dimensions:   count("dimensions/"),
    metrics:      count("metrics/"),
    calculations: count("calculations/"),
    models:       count("models/"),
  };
}

/** A logger that records everything so the transcript can be kept only on failure. */
function capturingLogger(lines: string[]): Logger {
  const push = (m: string) => { lines.push(m); };
  return { log: push, info: push, error: push, verbose: push };
}

// ----------------------------------------------------------
// Operation
// ----------------------------------------------------------

export class GenerateSMLFromBundleOperation extends Operation<Params> {
  name        = "generate-sml-from-bundle";
  description = "Convert every AtScale project.xml inside one or more support bundles to SML, one repository per project, with a summary";
  parameters  = new GenerateSMLFromBundleParamsSet();

  constructor(services: ServiceRegistry, logger: Logger) {
    super(services, logger);
  }

  async run(params: Params): Promise<void> {
    const bundlePaths = splitList(params["bundles"]);
    if (bundlePaths.length === 0) {
      throw new Error("--bundles must name at least one bundle directory or .zip file");
    }
    const outputDir = path.resolve(params["output-dir"]);
    const orgFilter = new Set(splitList(params["org"]));
    const force     = params["force"] === true;

    fs.mkdirSync(outputDir, { recursive: true });

    const discovery = await discoverBundleProjects(bundlePaths);
    try {
      for (const empty of discovery.emptyBundles) {
        this.logger.error(`[GenerateSMLFromBundle] No metadata/ folder found under: ${empty}`);
      }

      const selected = discovery.projects.filter((p) => orgFilter.size === 0 || orgFilter.has(p.org));
      this.logger.log(
        `[GenerateSMLFromBundle] ${selected.length} project(s) across ${bundlePaths.length} bundle(s)` +
        (orgFilter.size ? ` (org filter: ${[...orgFilter].join(", ")})` : ""),
      );

      const results: ProjectResult[] = [];
      for (const project of selected) {
        results.push(await this.convertOne(project, outputDir, force, params));
      }

      this.writeSummary(outputDir, results);

      const converted = results.filter((r) => r.status === "ok" || r.status === "ok-no-model").length;
      const skipped   = results.filter((r) => r.status === "skipped").length;
      const failed    = results.filter((r) => r.status === "FAILED");
      this.logger.log(
        `\n[GenerateSMLFromBundle] converted: ${converted}  skipped (already present): ${skipped}  failed: ${failed.length}`,
      );
      this.logger.log(`[GenerateSMLFromBundle] summary: ${path.join(outputDir, "summary.md")}`);

      if (failed.length > 0 || discovery.emptyBundles.length > 0) {
        const parts: string[] = [];
        if (failed.length > 0) {
          const names = failed.map((r) => `${r.project.bundleSlug}/${r.project.org}/${r.project.projectName}`);
          parts.push(`${failed.length} project(s) failed to convert: ${names.join(", ")} (logs under ${path.join(outputDir, ".logs")})`);
        }
        if (discovery.emptyBundles.length > 0) {
          parts.push(`No metadata/ folder found under: ${discovery.emptyBundles.join(", ")}`);
        }
        throw new Error(parts.join("; "));
      }
    } finally {
      discovery.cleanup();
    }
  }

  private async convertOne(
    project: BundleProject,
    outputDir: string,
    force: boolean,
    params: Params,
  ): Promise<ProjectResult> {
    const projectSlug = `${slug(project.projectName)}__${project.projectId.slice(0, 8)}`;
    const dest        = path.join(outputDir, project.bundleSlug, project.org, projectSlug);
    const logDir      = path.join(outputDir, ".logs", project.bundleSlug, project.org);
    const logPath     = path.join(logDir, `${projectSlug}.log`);
    const label       = `${project.bundleSlug} / ${project.org} / ${project.projectName}`;

    if (!force && fs.existsSync(path.join(dest, "catalog.yml"))) {
      this.logger.verbose(`[skipped] ${label} (already present)`);
      return { project, outputDir: dest, status: "skipped", logPath: "", ...countsFromDir(dest) };
    }

    const lines: string[] = [
      `# bundle:  ${project.bundlePath}`,
      `# xml:     ${project.xmlPath}`,
      `# project: ${project.projectName}  id: ${project.projectId}  org: ${project.org}`,
      `# run:     ${new Date().toISOString()}`,
      "",
    ];
    const quiet = capturingLogger(lines);

    fs.rmSync(dest, { recursive: true, force: true });
    fs.mkdirSync(dest, { recursive: true });

    try {
      const xmlContent   = fs.readFileSync(project.xmlPath, "utf8");
      const generatedSml = await convertXmlToSml(
        xmlContent,
        {
          xmlFileName:      path.basename(project.xmlPath),
          connectionName:   params["connection-name"],
          connectionType:   params["connection-type"],
          connectionDb:     params["connection-db"],
          connectionSchema: params["connection-schema"],
        },
        quiet,
      );

      const compatibility = await applyModelCompatibilityPolicy(generatedSml, params["model-mode"], quiet);
      const sml = compatibility.modelMode || compatibility.collisionSets.length > 0
        ? new Map(compatibility.sml).set(
            "README.md",
            (compatibility.sml.get("README.md") ?? "# XML to SML Conversion\n") +
              compatibilityReportMarkdown(compatibility),
          )
        : compatibility.sml;

      if (compatibility.reviewRequired) {
        throw new Error(formatExistingConflict(compatibility));
      }

      writeSmlFiles(sml, dest, quiet);
      const counts = countsFromSml(sml);
      const status: ProjectStatus = counts.models === 0 ? "ok-no-model" : "ok";
      this.logger.log(
        `[${status}] ${label} → ${counts.datasets} dataset(s), ${counts.dimensions} dimension(s), ` +
        `${counts.metrics} metric(s), ${counts.calculations} calculation(s), ${counts.models} model(s)`,
      );
      return { project, outputDir: dest, status, logPath: "", ...counts };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      lines.push("", `ERROR: ${message}`);
      fs.mkdirSync(logDir, { recursive: true });
      fs.writeFileSync(logPath, lines.join("\n") + "\n", "utf8");
      fs.rmSync(dest, { recursive: true, force: true });
      this.logger.error(`[FAILED] ${label}: ${message.split("\n")[0]}  (log: ${logPath})`);
      return {
        project, outputDir: dest, status: "FAILED", logPath, error: message,
        datasets: 0, dimensions: 0, metrics: 0, calculations: 0, models: 0,
      };
    }
  }

  private writeSummary(outputDir: string, results: ProjectResult[]): void {
    const csv = [SUMMARY_HEADER];
    const md  = [
      "| bundle | org | project | status | datasets | dimensions | metrics | calculations | models | log (failures only) |",
      "|---|---|---|---|---|---|---|---|---|---|",
    ];
    for (const r of results) {
      const row = [
        r.project.bundleSlug, r.project.org, r.project.projectName, r.project.projectId, r.status,
        r.datasets, r.dimensions, r.metrics, r.calculations, r.models,
        path.relative(outputDir, r.outputDir), r.logPath ? path.relative(outputDir, r.logPath) : "",
      ];
      csv.push(row.map(csvCell).join(","));
      md.push(
        `| ${r.project.bundleSlug} | ${r.project.org} | ${r.project.projectName} | ${r.status} | ` +
        `${r.datasets} | ${r.dimensions} | ${r.metrics} | ${r.calculations} | ${r.models} | ` +
        `${r.logPath ? path.relative(outputDir, r.logPath) : ""} |`,
      );
    }
    const failed = results.filter((r) => r.status === "FAILED").length;
    md.push("", `${results.length} project(s), ${failed} failed.`);
    fs.writeFileSync(path.join(outputDir, "summary.csv"), csv.join("\n") + "\n", "utf8");
    fs.writeFileSync(path.join(outputDir, "summary.md"),  md.join("\n")  + "\n", "utf8");
  }
}
