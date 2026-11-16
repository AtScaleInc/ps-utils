/**
 * GenerateDCCubeFromSML
 *
 * Reads an SML directory and generates a Data Catalog Cube: a small AtScale model whose rows are the
 * model / metric / fact join / dimension / attribute paths of every other model in the directory.
 * Deployed alongside the catalog, it lets BI users browse which metrics can be sliced by which
 * attributes, and through which fact join keys, from Tableau, Excel or Power BI.
 *
 * Also writes the model mapping tables (metrics, relationships, dimension attributes, metric coverage,
 * issues — the same tables generate-report-from-sml renders) as SQL and CSV, and as SML datasets.
 *
 * Writes, relative to --output-dir (default: --sml-dir):
 *   datasets/data_catalog_relationships.yml      the catalog rows as an inline VALUES query
 *                                                (or a physical table, with --dataset-table)
 *   dimensions/dc_*.yml                          four degenerate dimensions over that dataset
 *   metrics/m_dc_*.yml                           five count-distinct metrics
 *   models/data_catalog_cube.yml                 the model tying them together
 *   datasets/model_*.yml                         the five mapping tables as query datasets
 *                                                (skip with --include-mapping-datasets false)
 *   data_catalog/data_catalog_relationships.csv  the catalog rows as CSV
 *   data_catalog/mapping/model_*.csv             the mapping tables as CSV
 *   data_catalog/data_catalog.sql                DROP / CREATE / INSERT for all six tables
 *
 * The cube's own model is excluded from the catalog, so re-running is idempotent. Typically run after
 * generate-report-from-sml, as the next step of a catalog's documentation pipeline.
 *
 * Usage:
 *   atscale-utils generate-dc-cube-from-sml --sml-dir ./sml
 */
import fs from "fs";
import path from "path";
import yaml from "js-yaml";
import { Operation } from "../Operation.js";
import { ParameterSet, StringParameter, BooleanParameter } from "../../Parameters.js";
import type { ServiceRegistry } from "../../services/registry.js";
import type { Logger } from "../../logging.js";
import {
  CATALOG_COLUMNS,
  DEFAULT_DC_CUBE_NAMES,
  buildCatalogRows,
  buildDCCubeObjects,
  buildLoadSql,
  buildTableCsv,
  buildTableDataset,
  inferConnectionId,
  type Raw,
  type TableData,
} from "./dc-cube-builder.js";
import { buildModelMapping, mappingTables } from "../sml-model-mapping.js";

// ── Parameters ──────────────────────────────────────────────────────────────

class GenerateDCCubeFromSMLParamsSet extends ParameterSet {
  parameters = [
    new (class extends StringParameter {
      name        = "sml-dir";
      description = "Path to the SML directory to catalog (contains datasets/, dimensions/, metrics/, models/)";
      required    = true;
    })(),
    new (class extends StringParameter {
      name        = "output-dir";
      description = "Directory the Data Catalog Cube's SML files are written into. Defaults to --sml-dir, so the cube deploys with the catalog it describes.";
      required    = false;
    })(),
    new (class extends StringParameter {
      name        = "connection-id";
      description = "SML connection unique_name for the catalog datasets. Defaults to the connection of the first catalogued fact dataset.";
      required    = false;
    })(),
    new (class extends StringParameter {
      name        = "schema";
      description = "Schema the SQL load script creates its tables in. Defaults to the connection's schema; tables are unqualified if it has none.";
      required    = false;
    })(),
    new (class extends StringParameter {
      name        = "dataset-table";
      description = "Physical table for the catalog dataset (load it with the SQL script or CSV). Omit to embed the rows as an inline VALUES query, which needs no table.";
      required    = false;
    })(),
    new (class extends BooleanParameter {
      name         = "include-mapping-datasets";
      description  = "Also write the five mapping tables (model_metrics, model_relationships, model_dimension_attributes, model_metric_coverage, model_issues) as SML query datasets.";
      required     = false;
      defaultValue = true;
    })(),
    new (class extends StringParameter {
      name         = "csv-output-file";
      description  = "Path for the catalog rows as CSV. Relative paths are written inside --output-dir.";
      required     = false;
      defaultValue = "data_catalog/data_catalog_relationships.csv";
    })(),
    new (class extends StringParameter {
      name         = "mapping-output-dir";
      description  = "Directory for the mapping tables as CSV, one file per table. Relative paths are written inside --output-dir.";
      required     = false;
      defaultValue = "data_catalog/mapping";
    })(),
    new (class extends StringParameter {
      name         = "sql-output-file";
      description  = "Path for the SQL script that creates and loads the catalog and mapping tables. Relative paths are written inside --output-dir.";
      required     = false;
      defaultValue = "data_catalog/data_catalog.sql";
    })(),
  ];
}

type Params = {
  "sml-dir":                    string;
  "output-dir"?:                string;
  "connection-id"?:             string;
  schema?:                      string;
  "dataset-table"?:             string;
  "include-mapping-datasets"?:  boolean;
  "csv-output-file"?:           string;
  "mapping-output-dir"?:        string;
  "sql-output-file"?:           string;
};
export type GenerateDCCubeFromSMLParams = Params;

const YAML_RE = /\.ya?ml$/i;
const YAML_DUMP_OPTS: yaml.DumpOptions = { lineWidth: -1, indent: 2, noRefs: true, sortKeys: false };

function loadDir(smlDir: string, dir: string): Raw[] {
  const full = path.join(smlDir, dir);
  if (!fs.existsSync(full)) return [];
  return fs
    .readdirSync(full)
    .filter((f) => YAML_RE.test(f))
    .sort()
    .map((f) => yaml.load(fs.readFileSync(path.join(full, f), "utf8")))
    .filter((d): d is Raw => !!d && typeof d === "object" && "unique_name" in (d as Raw));
}

// ── Operation ────────────────────────────────────────────────────────────────

export class GenerateDCCubeFromSMLOperation extends Operation<Params> {
  name        = "generate-dc-cube-from-sml";
  description = "Read an SML directory and generate a Data Catalog Cube — an AtScale model of every metric → fact → dimension → attribute path — plus the model mapping tables as SQL, CSV and SML datasets";
  parameters  = new GenerateDCCubeFromSMLParamsSet();

  constructor(services: ServiceRegistry, logger: Logger) {
    super(services, logger);
  }

  async run(params: Params): Promise<void> {
    const smlDir = path.resolve(params["sml-dir"]);
    if (!fs.existsSync(smlDir) || !fs.statSync(smlDir).isDirectory()) {
      throw new Error(`SML directory not found: ${smlDir}`);
    }
    const outputDir = path.resolve(params["output-dir"] ?? smlDir);
    this.logger.log(`[GenerateDCCubeFromSML] Reading: ${smlDir}`);

    const datasets = loadDir(smlDir, "datasets");
    const connections = loadDir(smlDir, "connections");
    const input = {
      models: loadDir(smlDir, "models"),
      metrics: loadDir(smlDir, "metrics"),
      dimensions: loadDir(smlDir, "dimensions"),
    };

    const { rows, warnings } = buildCatalogRows(input);
    for (const w of warnings) this.logger.log(`  ⚠  ${w}`);
    if (rows.length === 0) {
      throw new Error(`No metric → dimension paths found under ${smlDir}; nothing to catalog.`);
    }

    const connectionId = params["connection-id"] ?? inferConnectionId(rows, datasets);
    if (!connectionId) {
      throw new Error("Could not infer a connection for the catalog dataset; pass --connection-id.");
    }
    const schema = params.schema ?? (connections.find((c) => String(c.unique_name) === connectionId)?.schema as string | undefined);

    const write = (rel: string, content: string) => {
      const file = path.resolve(outputDir, rel);
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, content, "utf8");
      this.logger.log(`  → ${path.relative(outputDir, file)}`);
    };

    // The Data Catalog Cube.
    const objects = buildDCCubeObjects(rows, { ...DEFAULT_DC_CUBE_NAMES, connectionId, table: params["dataset-table"] });
    for (const [rel, obj] of Object.entries(objects)) write(rel, yaml.dump(obj, YAML_DUMP_OPTS));
    const catalogTable: TableData = { name: DEFAULT_DC_CUBE_NAMES.datasetName, columns: [...CATALOG_COLUMNS], rows };
    write(params["csv-output-file"] ?? "data_catalog/data_catalog_relationships.csv", buildTableCsv(catalogTable));

    // The model mapping tables: the cube's own datasets are excluded so they never describe themselves.
    const mapping = buildModelMapping(
      { ...input, datasets, calculations: loadDir(smlDir, "calculations") },
      { excludeModels: [DEFAULT_DC_CUBE_NAMES.modelName] },
    );
    const mappingDir = params["mapping-output-dir"] ?? "data_catalog/mapping";
    const tables: TableData[] = [catalogTable];
    for (const t of mappingTables(mapping)) {
      if (!t.rows.length) continue;
      const table: TableData = { name: t.name, columns: Object.keys(t.rows[0]), rows: t.rows };
      tables.push(table);
      write(path.join(mappingDir, `${t.name}.csv`), buildTableCsv(table));
      if (params["include-mapping-datasets"] !== false) {
        const description = `Model mapping table generated by ps-utils generate-dc-cube-from-sml (${t.rows.length} rows).`;
        write(`datasets/${t.name}.yml`, yaml.dump(buildTableDataset(table, t.label, connectionId, description), YAML_DUMP_OPTS));
      }
    }
    write(params["sql-output-file"] ?? "data_catalog/data_catalog.sql", buildLoadSql(tables, schema));

    const models = new Set(rows.map((r) => r.model_name)).size;
    const measures = new Set(rows.map((r) => `${r.model_name}/${r.measure_name}`)).size;
    this.logger.log(
      `[GenerateDCCubeFromSML] ${rows.length} catalog rows from ${models} model(s), ${measures} measure(s); ${mapping.issues.length} issue(s); connection ${connectionId}${schema ? `, schema ${schema}` : ""}`,
    );
  }
}
