/**
 * GenerateSMLFromBundle
 *
 * Converts every AtScale project.xml found inside one or more support bundles
 * to SML, one SML repository per project, using the same converter as
 * `generate-sml-from-xml`.  No database connection is required.
 *
 * Output layout:
 *   <output-dir>/<bundle>/<org>/<project>__<id8>/   one SML repo per project
 *   <output-dir>/summary.csv                        one row per project ever seen in this output dir
 *   <output-dir>/summary.md                         the same, readable
 *   <output-dir>/.logs/<bundle>/<org>/<project>.log converter output, kept only while a project is failing
 *
 * Re-runs skip projects whose output already exists unless --force is given.
 * A conversion is staged beside its destination and only replaces the previous
 * output when it succeeds, so a failing re-run never destroys a good repo.
 * The summary merges with the summary already on disk, so filtered or partial
 * re-runs keep describing the whole output directory.  The operation fails
 * (non-zero exit) if any project failed or a bundle held no metadata, but only
 * after every project has been attempted and the summary written.
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
  type EmptyBundle,
} from "./bundle-walker.js";

// ----------------------------------------------------------
// Parameter declarations
// ----------------------------------------------------------

class GenerateSMLFromBundleParamsSet extends ParameterSet {
  parameters = [
    new (class extends StringParameter {
      name        = "bundles";
      description = "Comma-separated support bundle paths: the engine's support-bundle .zip, a directory containing metadata/ or metadata.zip, or a zip of such a directory";
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
// Summary rows
// ----------------------------------------------------------

type ProjectStatus = "ok" | "ok-no-model" | "skipped" | "FAILED" | "NO-METADATA";

type SummaryRow = {
  bundle:       string;
  org:          string;
  project:      string;
  projectId:    string;
  status:       ProjectStatus;
  datasets:     number;
  dimensions:   number;
  metrics:      number;
  calculations: number;
  models:       number;
  outputDir:    string;   // relative to <output-dir>, "" when none
  log:          string;   // relative to <output-dir>, "" when none
};

const SUMMARY_COLUMNS = [
  "bundle", "org", "project", "project_id", "status",
  "datasets", "dimensions", "metrics", "calculations", "models", "output_dir", "log",
] as const;

function rowKey(r: Pick<SummaryRow, "bundle" | "org" | "projectId">): string {
  return `${r.bundle}\u0000${r.org}\u0000${r.projectId}`;
}

function csvCell(value: string | number): string {
  const text = String(value);
  return /[",\n\r]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

/** Minimal RFC 4180 reader: handles quoted cells with commas and doubled quotes. */
function parseCsvLine(line: string): string[] {
  const cells: string[] = [];
  let cell = "";
  let quoted = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (quoted) {
      if (ch === '"' && line[i + 1] === '"') { cell += '"'; i++; }
      else if (ch === '"') quoted = false;
      else cell += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === ",") { cells.push(cell); cell = ""; }
    else cell += ch;
  }
  cells.push(cell);
  return cells;
}

function readExistingSummary(outputDir: string): SummaryRow[] {
  const file = path.join(outputDir, "summary.csv");
  if (!fs.existsSync(file)) return [];
  const lines = fs.readFileSync(file, "utf8").split(/\r?\n/).filter((l) => l.length > 0);
  if (lines.length < 2 || parseCsvLine(lines[0]).join(",") !== SUMMARY_COLUMNS.join(",")) return [];
  const rows: SummaryRow[] = [];
  for (const line of lines.slice(1)) {
    const c = parseCsvLine(line);
    if (c.length !== SUMMARY_COLUMNS.length) continue;
    rows.push({
      bundle: c[0], org: c[1], project: c[2], projectId: c[3], status: c[4] as ProjectStatus,
      datasets: Number(c[5]) || 0, dimensions: Number(c[6]) || 0, metrics: Number(c[7]) || 0,
      calculations: Number(c[8]) || 0, models: Number(c[9]) || 0, outputDir: c[10], log: c[11],
    });
  }
  return rows;
}

function writeSummary(outputDir: string, rows: SummaryRow[]): void {
  const sorted = [...rows].sort((a, b) =>
    a.bundle.localeCompare(b.bundle) || a.org.localeCompare(b.org) ||
    a.project.localeCompare(b.project) || a.projectId.localeCompare(b.projectId));
  const csv = [SUMMARY_COLUMNS.join(",")];
  const md  = [
    "| bundle | org | project | status | datasets | dimensions | metrics | calculations | models | log |",
    "|---|---|---|---|---|---|---|---|---|---|",
  ];
  for (const r of sorted) {
    csv.push([
      r.bundle, r.org, r.project, r.projectId, r.status,
      r.datasets, r.dimensions, r.metrics, r.calculations, r.models, r.outputDir, r.log,
    ].map(csvCell).join(","));
    md.push(`| ${r.bundle} | ${r.org} | ${r.project} | ${r.status} | ${r.datasets} | ${r.dimensions} | ${r.metrics} | ${r.calculations} | ${r.models} | ${r.log} |`);
  }
  const failed = sorted.filter((r) => r.status === "FAILED" || r.status === "NO-METADATA").length;
  md.push("", `${sorted.length} row(s), ${failed} failed. Logs are kept only for failing projects.`);
  fs.writeFileSync(path.join(outputDir, "summary.csv"), csv.join("\n") + "\n", "utf8");
  fs.writeFileSync(path.join(outputDir, "summary.md"),  md.join("\n")  + "\n", "utf8");
}

// ----------------------------------------------------------
// Counting helpers
// ----------------------------------------------------------

type Counts = Pick<SummaryRow, "datasets" | "dimensions" | "metrics" | "calculations" | "models">;

function countFiles(dir: string): number {
  if (!fs.existsSync(dir)) return 0;
  return fs.readdirSync(dir).filter((f) => f.endsWith(".yml") || f.endsWith(".yaml")).length;
}

function countsFromDir(dir: string): Counts {
  return {
    datasets:     countFiles(path.join(dir, "datasets")),
    dimensions:   countFiles(path.join(dir, "dimensions")),
    metrics:      countFiles(path.join(dir, "metrics")),
    calculations: countFiles(path.join(dir, "calculations")),
    models:       countFiles(path.join(dir, "models")),
  };
}

function countsFromSml(sml: Map<string, string>): Counts {
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
      const selected = discovery.projects.filter((p) => orgFilter.size === 0 || orgFilter.has(p.org));
      this.logger.log(
        `[GenerateSMLFromBundle] ${selected.length} project(s) across ${bundlePaths.length} bundle(s)` +
        (orgFilter.size ? ` (org filter: ${[...orgFilter].join(", ")})` : ""),
      );

      const rows: SummaryRow[] = [];
      for (const project of selected) {
        rows.push(await this.convertOne(project, outputDir, force, params));
      }
      for (const empty of discovery.emptyBundles) {
        this.logger.error(`[NO-METADATA] ${empty.bundleSlug}: no metadata/ directory or metadata.zip found under ${empty.bundlePath}`);
        rows.push(this.emptyBundleRow(empty));
      }

      // Merge with what is already on disk so a filtered or partial re-run
      // still describes the whole output directory.
      const merged = new Map(readExistingSummary(outputDir).map((r) => [rowKey(r), r]));
      for (const r of rows) merged.set(rowKey(r), r);
      writeSummary(outputDir, [...merged.values()]);

      const converted = rows.filter((r) => r.status === "ok" || r.status === "ok-no-model").length;
      const skipped   = rows.filter((r) => r.status === "skipped").length;
      const failed    = rows.filter((r) => r.status === "FAILED");
      this.logger.log(
        `\n[GenerateSMLFromBundle] converted: ${converted}  skipped (already present): ${skipped}  failed: ${failed.length}`,
      );
      this.logger.log(`[GenerateSMLFromBundle] summary: ${path.join(outputDir, "summary.md")}`);

      const problems: string[] = [];
      if (failed.length > 0) {
        const names = failed.map((r) => `${r.bundle}/${r.org}/${r.project}`);
        problems.push(`${failed.length} project(s) failed to convert: ${names.join(", ")} (logs under ${path.join(outputDir, ".logs")})`);
      }
      if (discovery.emptyBundles.length > 0) {
        problems.push(`No metadata/ directory or metadata.zip found under: ${discovery.emptyBundles.map((e) => e.bundlePath).join(", ")}`);
      }
      if (problems.length > 0) {
        throw new Error(problems.join("; "));
      }
    } finally {
      discovery.cleanup();
    }
  }

  private emptyBundleRow(empty: EmptyBundle): SummaryRow {
    return {
      bundle: empty.bundleSlug, org: "", project: "", projectId: "", status: "NO-METADATA",
      datasets: 0, dimensions: 0, metrics: 0, calculations: 0, models: 0, outputDir: "", log: "",
    };
  }

  private async convertOne(
    project: BundleProject,
    outputDir: string,
    force: boolean,
    params: Params,
  ): Promise<SummaryRow> {
    const projectSlug = `${slug(project.projectName)}__${project.projectId.slice(0, 8)}`;
    const dest        = path.join(outputDir, project.bundleSlug, project.org, projectSlug);
    const staging     = `${dest}.converting`;
    const logDir      = path.join(outputDir, ".logs", project.bundleSlug, project.org);
    const logPath     = path.join(logDir, `${projectSlug}.log`);
    const label       = `${project.bundleSlug} / ${project.org} / ${project.projectName}`;
    const base: Omit<SummaryRow, "status" | keyof Counts | "log"> = {
      bundle: project.bundleSlug, org: project.org, project: project.projectName,
      projectId: project.projectId, outputDir: path.relative(outputDir, dest),
    };

    if (!force && fs.existsSync(path.join(dest, "catalog.yml"))) {
      this.logger.verbose(`[skipped] ${label} (already present)`);
      return { ...base, status: "skipped", log: "", ...countsFromDir(dest) };
    }

    const lines: string[] = [
      `# bundle:  ${project.bundlePath}`,
      `# xml:     ${project.xmlPath}`,
      `# project: ${project.projectName}  id: ${project.projectId}  org: ${project.org}`,
      `# run:     ${new Date().toISOString()}`,
      "",
    ];
    const quiet = capturingLogger(lines);

    fs.rmSync(staging, { recursive: true, force: true });
    fs.mkdirSync(staging, { recursive: true });

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

      writeSmlFiles(sml, staging, quiet);

      // Success: swap the staged repo into place, drop any stale failure log.
      fs.rmSync(dest, { recursive: true, force: true });
      fs.renameSync(staging, dest);
      fs.rmSync(logPath, { force: true });

      const counts = countsFromSml(sml);
      const status: ProjectStatus = counts.models === 0 ? "ok-no-model" : "ok";
      this.logger.log(
        `[${status}] ${label} → ${counts.datasets} dataset(s), ${counts.dimensions} dimension(s), ` +
        `${counts.metrics} metric(s), ${counts.calculations} calculation(s), ${counts.models} model(s)`,
      );
      return { ...base, status, log: "", ...counts };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      lines.push("", `ERROR: ${message}`);
      fs.mkdirSync(logDir, { recursive: true });
      fs.writeFileSync(logPath, lines.join("\n") + "\n", "utf8");
      fs.rmSync(staging, { recursive: true, force: true });
      this.logger.error(`[FAILED] ${label}: ${message.split("\n")[0]}  (log: ${logPath})`);
      return {
        ...base,
        status: "FAILED",
        log: path.relative(outputDir, logPath),
        outputDir: fs.existsSync(dest) ? base.outputDir : "",
        datasets: 0, dimensions: 0, metrics: 0, calculations: 0, models: 0,
      };
    }
  }
}
