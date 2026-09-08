/**
 * generate-sml-docs
 *
 * Reads an SML directory and generates a single Markdown document (default
 * README.md, written into the sml-dir) describing every SML object: catalog,
 * connections, datasets (fact vs dimension), dimensions (hierarchies, levels,
 * level attributes, secondary attributes, snowflake/embedded joins), models
 * (fact→dimension relationships with a Mermaid diagram, metric references,
 * degenerate dimensions, perspectives, aggregates, overrides, drillthrough),
 * metrics, calculations, and any security objects.
 *
 * Objects are discovered by walking catalog.yml + the standard subdirectories
 * and grouped by their top-level `object_type` (falling back to the subdirectory
 * name), so objects that no typed loader models yet (perspectives, calculation
 * expressions, connections, security) are still documented.
 */
import fs from "fs";
import path from "path";
import yaml from "js-yaml";
import { Operation } from "../Operation.js";
import { ParameterSet, StringParameter } from "../../Parameters.js";
import type { ServiceRegistry } from "../../services/registry.js";
import type { Logger } from "../../logging.js";
import { generateSmlDocs, type SmlCollection, type SmlObject } from "./sml-docs-generator.js";

// ── Parameters ──────────────────────────────────────────────────────────────

class GenerateSMLDocsParamsSet extends ParameterSet {
  parameters = [
    new (class extends StringParameter {
      name        = "sml-dir";
      description = "Path to the SML directory to document (contains catalog.yml plus datasets/, dimensions/, metrics/, models/, and optionally connections/ and calculations/)";
      required    = true;
    })(),
    new (class extends StringParameter {
      name         = "output-file";
      description  = "Output Markdown file. A relative path is written inside the SML directory; an absolute path is used as-is. Defaults to README.md.";
      required     = false;
      defaultValue = "README.md";
    })(),
    new (class extends StringParameter {
      name        = "title";
      description = "H1 title for the document. Defaults to the catalog label / unique_name.";
      required    = false;
    })(),
  ];
}

type Params = {
  "sml-dir": string;
  "output-file": string;
  title?: string;
};
export type GenerateSMLDocsParams = Params;

// ── Loading ──────────────────────────────────────────────────────────────────

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

// ── Operation ──────────────────────────────────────────────────────────────────

export class GenerateSMLDocsOperation extends Operation<Params> {
  name        = "generate-sml-docs";
  description = "Read an SML directory and generate Markdown documentation (default README.md) of every SML object — models, dimensions, joins, datasets, metrics, calculations, and more";
  parameters  = new GenerateSMLDocsParamsSet();

  constructor(services: ServiceRegistry, logger: Logger) {
    super(services, logger);
  }

  async run(params: Params): Promise<void> {
    const smlDir = path.resolve(params["sml-dir"]);
    if (!fs.existsSync(smlDir) || !fs.statSync(smlDir).isDirectory()) {
      throw new Error(`SML directory not found: ${smlDir}`);
    }

    const collection: SmlCollection = {
      connections: [],
      datasets: [],
      dimensions: [],
      metrics: [],
      calculations: [],
      models: [],
      other: [],
    };

    // Root catalog.yml / catalog.yaml.
    for (const name of ["catalog.yml", "catalog.yaml"]) {
      const p = path.join(smlDir, name);
      if (fs.existsSync(p)) {
        collection.catalog = loadYaml(p);
        break;
      }
    }

    // Each known subdirectory.
    for (const { dir, key, objectType } of SUBDIRS) {
      const full = path.join(smlDir, dir);
      if (!fs.existsSync(full)) continue;
      for (const file of fs.readdirSync(full).filter((f) => YAML_RE.test(f))) {
        const raw = loadYaml(path.join(full, file));
        if (!raw) continue;
        const obj: SmlObject = { file: path.join(dir, file), raw };
        const ot = String(raw.object_type ?? "");
        // Trust object_type when present; otherwise place by subdirectory.
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
    this.logger.info(`[generate-sml-docs] Loaded ${total} object(s) from ${smlDir}`);

    const markdown = generateSmlDocs(collection, { title: params.title });

    const out = params["output-file"] || "README.md";
    const outPath = path.isAbsolute(out) ? out : path.join(smlDir, out);
    fs.mkdirSync(path.dirname(outPath), { recursive: true });
    fs.writeFileSync(outPath, markdown, "utf8");
    this.logger.info(`[generate-sml-docs] Written → ${outPath}`);
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
