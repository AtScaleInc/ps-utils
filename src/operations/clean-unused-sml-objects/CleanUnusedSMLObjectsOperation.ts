/**
 * CleanUnusedSMLObjects
 *
 * Reads an SML directory and reports every connection, dataset, dimension, metric, and
 * calculation that no model reaches — directly or transitively through a dimension's own
 * level attributes, secondary attributes, or snowflake relationships. This is a structural
 * check (is the object wired into a model at all), not a usage audit (has it actually been
 * queried) — see sml-usage-analyzer.ts for the full reasoning and known scope limits.
 *
 * Defaults to a preview: nothing is deleted unless --apply true is passed. This is a
 * deliberately different default than most SML-mutating operations in this project (compare
 * apply-shared-model-plan-option, whose --dry-run defaults to false) because deleting files
 * is not easily reversible the way writing/moving them is — an operator should see the exact
 * list of what would be removed before ever actually removing it.
 *
 * Usage (preview only, the default):
 *   atscale-utils clean-unused-sml-objects --sml-dir ./sml
 *
 * Usage (actually delete the unused files):
 *   atscale-utils clean-unused-sml-objects --sml-dir ./sml --apply true
 */
import fs from "fs";
import path from "path";
import yaml from "js-yaml";
import { Operation } from "../Operation.js";
import { ParameterSet, StringParameter, BooleanParameter } from "../../Parameters.js";
import type { ServiceRegistry } from "../../services/registry.js";
import type { Logger } from "../../logging.js";
import { analyzeSmlUsage, buildCleanupReport, type SmlCollection, type SmlObject } from "./sml-usage-analyzer.js";

// ── Parameters ──────────────────────────────────────────────────────────────

class CleanUnusedSMLObjectsParamsSet extends ParameterSet {
  parameters = [
    new (class extends StringParameter {
      name        = "sml-dir";
      description = "Path to the SML directory to clean (contains catalog.yml plus datasets/, dimensions/, metrics/, models/, and optionally connections/ and calculations/)";
      required    = true;
    })(),
    new (class extends BooleanParameter {
      name         = "apply";
      description  = "Actually delete the unused files. Defaults to false — a preview report only, so nothing is removed until you've reviewed it.";
      required     = false;
      defaultValue = false;
    })(),
    new (class extends StringParameter {
      name        = "output-file";
      description = "Output Markdown report file path. Omit to print to stdout.";
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
  apply:           boolean;
  "output-file"?:  string;
  title?:          string;
};
export type CleanUnusedSMLObjectsParams = Params;

// ── Loading — independent copy of generate-sml-docs's directory walk, kept local so this
// never depends on, or risks destabilizing, the docs generator. ─────────────────────────────

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

// ── Operation ────────────────────────────────────────────────────────────────

export class CleanUnusedSMLObjectsOperation extends Operation<Params> {
  name        = "clean-unused-sml-objects";
  description = "Read an SML directory and report (optionally remove) every connection, dataset, dimension, metric, and calculation that no model reaches — a structural dead-code check, not a live usage audit";
  parameters  = new CleanUnusedSMLObjectsParamsSet();

  constructor(services: ServiceRegistry, logger: Logger) {
    super(services, logger);
  }

  async run(params: Params): Promise<void> {
    const smlDir = path.resolve(params["sml-dir"]);
    if (!fs.existsSync(smlDir) || !fs.statSync(smlDir).isDirectory()) {
      throw new Error(`SML directory not found: ${smlDir}`);
    }

    this.logger.log(`[CleanUnusedSMLObjects] Reading: ${smlDir}`);

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

    if (collection.models.length === 0) {
      throw new Error(`No models found under ${smlDir} — refusing to analyze usage with no entry points to reach anything from.`);
    }

    const analysis = analyzeSmlUsage(collection);
    const totalUnused =
      analysis.unusedConnections.length +
      analysis.unusedDatasets.length +
      analysis.unusedDimensions.length +
      analysis.unusedMetrics.length +
      analysis.unusedCalculations.length;
    this.logger.log(`[CleanUnusedSMLObjects] Found ${totalUnused} structurally unused object(s)`);

    if (params.apply && totalUnused > 0) {
      const allUnused = [
        ...analysis.unusedConnections,
        ...analysis.unusedDatasets,
        ...analysis.unusedDimensions,
        ...analysis.unusedMetrics,
        ...analysis.unusedCalculations,
      ];
      for (const obj of allUnused) {
        const filePath = path.join(smlDir, obj.file);
        fs.unlinkSync(filePath);
        this.logger.log(`  → removed ${obj.file}`);
      }
    }

    const catalog = collection.catalog ?? {};
    const report = buildCleanupReport(analysis, {
      title: params.title ?? String(catalog.label ?? catalog.unique_name ?? "SML Unused Object Cleanup"),
      applied: !!params.apply,
    });

    if (params["output-file"]) {
      const outputPath = path.resolve(params["output-file"]);
      fs.mkdirSync(path.dirname(outputPath), { recursive: true });
      fs.writeFileSync(outputPath, report, "utf8");
      this.logger.log(`[CleanUnusedSMLObjects] Written → ${outputPath}`);
    } else {
      process.stdout.write(report);
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
