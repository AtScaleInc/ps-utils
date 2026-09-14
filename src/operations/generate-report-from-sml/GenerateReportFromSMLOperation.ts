/**
 * GenerateReportFromSML
 *
 * Reads an SML directory (catalog.yml plus datasets/, dimensions/, metrics/,
 * models/, and optionally connections/ and calculations/) and writes a
 * single, human-readable Markdown report describing every object found in
 * the model: connections, physical datasets (tables/queries/columns), the
 * fact-to-dimension join graph, dimensions (hierarchies, levels, secondary
 * attributes), models (relationships, metrics used, calculations used,
 * degenerate dimensions, perspectives, aggregates, overrides, drillthrough),
 * the metrics library, the calculations library, and security.
 *
 * This mirrors generate-report-from-xml — same report shape, same read-only
 * intent (nothing is renamed, deduplicated, or reshaped) — but reads
 * directly from an SML directory instead of an AtScale XML project file.
 * No database connection is required.
 */
import fs from "fs";
import path from "path";
import yaml from "js-yaml";
import { Operation } from "../Operation.js";
import { ParameterSet, StringParameter } from "../../Parameters.js";
import type { ServiceRegistry } from "../../services/registry.js";
import type { Logger } from "../../logging.js";
import { generateReportFromSml, type SmlCollection, type SmlObject } from "./sml-report-generator.js";

// ----------------------------------------------------------
// Parameter declarations
// ----------------------------------------------------------

class GenerateReportFromSMLParamsSet extends ParameterSet {
  parameters = [
    new (class extends StringParameter {
      name        = "sml-dir";
      description = "Path to the SML directory to report on (contains catalog.yml plus datasets/, dimensions/, metrics/, models/, and optionally connections/ and calculations/)";
      required    = true;
    })(),
    new (class extends StringParameter {
      name        = "output-file";
      description = "Output Markdown file path. Omit to print to stdout.";
      required    = false;
    })(),
    new (class extends StringParameter {
      name        = "title";
      description = "H1 title for the report. Defaults to the catalog label / unique_name.";
      required    = false;
    })(),
  ];
}

type Params = {
  "sml-dir":       string;
  "output-file"?:  string;
  title?:          string;
};
export type GenerateReportFromSMLParams = Params;

// ----------------------------------------------------------
// Loading — independent copy of generate-sml-docs's directory walk, kept
// local so this read-only report never depends on, or risks destabilizing,
// the docs generator.
// ----------------------------------------------------------

/** Subdirectory → collection key, and the object_type expected within it. */
const SUBDIRS: { dir: string; key: keyof Omit<SmlCollection, "catalog" | "other">; objectType: string }[] = [
  { dir: "connections", key: "connections", objectType: "connection" },
  { dir: "datasets", key: "datasets", objectType: "dataset" },
  { dir: "dimensions", key: "dimensions", objectType: "dimension" },
  { dir: "metrics", key: "metrics", objectType: "metric" },
  { dir: "calculations", key: "calculations", objectType: "metric_calc" },
  { dir: "models", key: "models", objectType: "model" },
];

const YAML_RE = /\.ya?ml$/i;

function loadYaml(file: string): Record<string, unknown> | undefined {
  const parsed = yaml.load(fs.readFileSync(file, "utf8"));
  return parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : undefined;
}

// ----------------------------------------------------------
// Operation
// ----------------------------------------------------------

export class GenerateReportFromSMLOperation extends Operation<Params> {
  name        = "generate-report-from-sml";
  description = "Read an SML directory and generate a complete, human-readable Markdown report of every object — connections, datasets, joins, dimensions, hierarchies, levels, attributes, models, metrics, calculations, and more";
  parameters  = new GenerateReportFromSMLParamsSet();

  constructor(services: ServiceRegistry, logger: Logger) {
    super(services, logger);
  }

  async run(params: Params): Promise<void> {
    const smlDir = path.resolve(params["sml-dir"]);
    if (!fs.existsSync(smlDir) || !fs.statSync(smlDir).isDirectory()) {
      throw new Error(`SML directory not found: ${smlDir}`);
    }

    this.logger.log(`[GenerateReportFromSML] Reading: ${smlDir}`);

    const collection: SmlCollection = {
      connections: [],
      datasets: [],
      dimensions: [],
      metrics: [],
      calculations: [],
      models: [],
      other: [],
    };

    for (const name of ["catalog.yml", "catalog.yaml"]) {
      const p = path.join(smlDir, name);
      if (fs.existsSync(p)) {
        collection.catalog = loadYaml(p);
        break;
      }
    }

    for (const { dir, key, objectType } of SUBDIRS) {
      const full = path.join(smlDir, dir);
      if (!fs.existsSync(full)) continue;
      for (const file of fs.readdirSync(full).filter((f) => YAML_RE.test(f))) {
        const raw = loadYaml(path.join(full, file));
        if (!raw) continue;
        const obj: SmlObject = { file: path.join(dir, file), raw };
        const ot = String(raw.object_type ?? "");
        if (!ot || ot === objectType) {
          collection[key].push(obj);
        } else {
          this.routeByObjectType(collection, obj, ot);
        }
      }
    }

    const total =
      collection.connections.length +
      collection.datasets.length +
      collection.dimensions.length +
      collection.metrics.length +
      collection.calculations.length +
      collection.models.length +
      collection.other.length;
    this.logger.log(`[GenerateReportFromSML] Loaded ${total} object(s) from ${smlDir}`);

    const markdown = generateReportFromSml(collection, {
      smlDirName: path.basename(smlDir),
      title:      params.title,
    });

    if (params["output-file"]) {
      const outputPath = path.resolve(params["output-file"]);
      fs.mkdirSync(path.dirname(outputPath), { recursive: true });
      fs.writeFileSync(outputPath, markdown, "utf8");
      this.logger.log(`[GenerateReportFromSML] Written → ${outputPath}`);
    } else {
      process.stdout.write(markdown);
    }
  }

  /** Place an object whose object_type disagrees with its subdirectory. */
  private routeByObjectType(collection: SmlCollection, obj: SmlObject, objectType: string): void {
    switch (objectType) {
      case "connection": collection.connections.push(obj); break;
      case "dataset":    collection.datasets.push(obj); break;
      case "dimension":  collection.dimensions.push(obj); break;
      case "metric":     collection.metrics.push(obj); break;
      case "metric_calc": collection.calculations.push(obj); break;
      case "model":      collection.models.push(obj); break;
      default:           collection.other.push(obj); break;
    }
  }
}
