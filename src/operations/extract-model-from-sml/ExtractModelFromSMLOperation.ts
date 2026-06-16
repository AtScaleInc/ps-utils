/**
 * Extract model metadata from an SML directory and serialize it into model.yaml.
 *
 * Reads the SML file layout produced by generate-sml-from-connection /
 * generate-sml-from-ddl:
 *
 *   <sml-dir>/
 *     catalog.yml
 *     connections/<name>.yml
 *     datasets/<table>.yml
 *     dimensions/<dimension>.yml
 *     metrics/<metric>.yml
 *     models/<model>.yml
 *
 * Outputs the same model.yaml format as extract-model-from-atscale so the
 * result can be fed directly into generate-tableau-from-namespace.
 */
import fs from "fs";
import path from "path";
import { Operation } from "../Operation.js";
import { ParameterSet, StringParameter } from "../../Parameters.js";
import type { ServiceRegistry } from "../../services/registry.js";
import type { Logger } from "../../logging.js";
import { YamlService } from "../../services/YamlService.js";
import { stringify } from "yaml";

// ----------------------------------------------------------
// Parameter declarations
// ----------------------------------------------------------

class ExtractModelFromSMLParamsSet extends ParameterSet {
  parameters = [
    new (class extends StringParameter {
      name        = "sml-dir";
      description = "Path to the SML directory (must contain models/, metrics/, dimensions/, datasets/ sub-directories)";
      required    = true;
    })(),
    new (class extends StringParameter {
      name        = "model-name";
      description = "Model label or unique_name to extract (defaults to the first model found)";
      required    = false;
    })(),
    new (class extends StringParameter {
      name        = "connection-name";
      description = "Override the data_source connection name written to the output model.yaml";
      required    = false;
    })(),
    new (class extends StringParameter {
      name        = "output-model-file";
      description = "Output file path for the model YAML (omit to print to stdout)";
      required    = false;
    })(),
  ];
}

type Params = {
  "sml-dir":             string;
  "model-name"?:         string;
  "connection-name"?:    string;
  "output-model-file"?:  string;
};
export type ExtractModelFromSMLParams = Params;

// ----------------------------------------------------------
// Data-type and aggregation mappings
// ----------------------------------------------------------

/** SML column data_type → model.yaml data_type_string */
const SML_TO_MODEL_DTYPE: Record<string, string> = {
  string:   "WSTR",
  int:      "INT4",
  bigint:   "INT8",
  float:    "FLOAT32",
  double:   "FLOAT64",
  decimal:  "DECIMAL",
  numeric:  "DECIMAL",
  boolean:  "BOOL",
  date:     "DATE_DOUBLE",
  datetime: "DATETIME",
};

/** SML calculation_method → model.yaml agg_type_string */
const SML_TO_AGG: Record<string, string> = {
  "sum":            "sum",
  "average":        "avg",
  "minimum":        "min",
  "maximum":        "max",
  "count non-null": "count",
  "count":          "count",
};

/** Approximate agg_type numeric for the mdx section. */
const AGG_TYPE_NUM: Record<string, number> = {
  sum: 1, avg: 5, min: 3, max: 4, count: 8,
};

/**
 * Determine the role and type for a sql.columns entry given its data type.
 * DATE_DOUBLE dimensions are ordinal; all other non-numeric types are nominal.
 * Numeric types become measures (quantitative).
 */
function roleAndType(dataTypeString: string): { role: string; type: string } {
  if (dataTypeString === "DATE_DOUBLE") {
    return { role: "dimension", type: "ordinal" };
  }
  const dimensionTypes = new Set([
    "WSTR", "STRING", "BSTR", "GUID", "BOOL", "DATETIME",
  ]);
  if (dimensionTypes.has(dataTypeString)) {
    return { role: "dimension", type: "nominal" };
  }
  return { role: "measure", type: "quantitative" };
}

// ----------------------------------------------------------
// Operation
// ----------------------------------------------------------

export class ExtractModelFromSMLOperation extends Operation<Params> {
  name        = "extract-model-from-sml";
  description = "Read an SML directory and output the same model.yaml format as extract-model-from-atscale";
  parameters  = new ExtractModelFromSMLParamsSet();

  constructor(services: ServiceRegistry, logger: Logger) {
    super(services, logger);
  }

  /**
   * Read every .yml / .yaml file in `dir` and return a Map from
   * file stem (e.g. "my-metric") to the parsed YAML object.
   */
  private readYamlDir(dir: string, yaml: YamlService): Map<string, any> {
    const result = new Map<string, any>();
    if (!fs.existsSync(dir)) return result;
    for (const file of fs.readdirSync(dir).sort()) {
      if (!file.endsWith(".yml") && !file.endsWith(".yaml")) continue;
      const fullPath = path.join(dir, file);
      try {
        const parsed = yaml.readFromFile<any>(fullPath);
        result.set(path.basename(file, path.extname(file)), parsed);
      } catch (e) {
        this.logger.verbose(`Skipping ${file}: ${e}`);
      }
    }
    return result;
  }

  async run(params: Params): Promise<void> {
    const smlDir = path.resolve(params["sml-dir"]);
    if (!fs.existsSync(smlDir)) {
      throw new Error(`SML directory not found: ${smlDir}`);
    }

    const yaml = this.services.get<YamlService>("yaml");

    // ---- Load all SML sub-directories ----
    const modelsMap     = this.readYamlDir(path.join(smlDir, "models"),      yaml);
    const metricsMap    = this.readYamlDir(path.join(smlDir, "metrics"),     yaml);
    const dimensionsMap = this.readYamlDir(path.join(smlDir, "dimensions"),  yaml);
    const datasetsMap   = this.readYamlDir(path.join(smlDir, "datasets"),    yaml);
    const connectionsMap = this.readYamlDir(path.join(smlDir, "connections"), yaml);

    this.logger.info(
      `Loaded ${modelsMap.size} model(s), ${metricsMap.size} metric(s), ` +
      `${dimensionsMap.size} dimension(s), ${datasetsMap.size} dataset(s)`,
    );

    // ---- Select model ----
    let modelData: any;
    let modelName: string;

    if (params["model-name"]) {
      for (const [, m] of modelsMap) {
        if (
          m.unique_name === params["model-name"] ||
          m.label       === params["model-name"]
        ) {
          modelData = m;
          break;
        }
      }
      if (!modelData) {
        throw new Error(
          `Model "${params["model-name"]}" not found in ${smlDir}/models/`,
        );
      }
    } else {
      const first = modelsMap.values().next();
      if (first.done) {
        throw new Error(`No model files found in ${smlDir}/models/`);
      }
      modelData = first.value;
    }

    modelName = modelData.label ?? modelData.unique_name;
    this.logger.info(`Extracting model: ${modelName}`);

    // ---- Determine connection name ----
    let connectionName = params["connection-name"];
    if (!connectionName) {
      const firstConn = connectionsMap.values().next();
      if (!firstConn.done) {
        connectionName =
          firstConn.value.as_connection ?? firstConn.value.unique_name;
      } else {
        connectionName = "default";
      }
    }

    // ---- Dataset column-type lookup: table → column → data_type_string ----
    const datasetColumnTypes = new Map<string, Map<string, string>>();
    for (const [, ds] of datasetsMap) {
      const tableKey = ds.unique_name ?? ds.table ?? ds.label;
      const colMap   = new Map<string, string>();
      for (const col of (ds.columns ?? [])) {
        const smlType = (col.data_type ?? "string").toLowerCase();
        colMap.set(col.name, SML_TO_MODEL_DTYPE[smlType] ?? "WSTR");
      }
      datasetColumnTypes.set(tableKey, colMap);
    }

    // ---- Build dimensions lookup: unique_name → dimension data ----
    const dimensionsLookup = new Map<string, any>();
    for (const [, d] of dimensionsMap) {
      dimensionsLookup.set(d.unique_name, d);
    }

    // ---- Build metrics lookup: unique_name → metric data ----
    const metricsLookup = new Map<string, any>();
    for (const [, m] of metricsMap) {
      metricsLookup.set(m.unique_name, m);
    }

    // ---- Build MDX metrics array + SQL columns for measures ----
    const mdxMetrics: any[]               = [];
    const sqlColumns: Record<string, any> = {};

    for (const metricRef of (modelData.metrics ?? [])) {
      const metricUniqueName = metricRef.unique_name ?? metricRef;
      const m = metricsLookup.get(metricUniqueName);
      if (!m) {
        this.logger.verbose(`Metric not found: ${metricUniqueName}`);
        continue;
      }

      const aggString     = SML_TO_AGG[(m.calculation_method ?? "sum").toLowerCase()] ?? "sum";
      const aggTypeNum    = AGG_TYPE_NUM[aggString] ?? 1;
      const colTypes      = datasetColumnTypes.get(m.dataset);
      const dataTypeStr   = colTypes?.get(m.column) ?? "FLOAT64";

      mdxMetrics.push({
        query_name:        m.unique_name,
        caption:           m.label ?? m.unique_name,
        agg_type:          aggTypeNum,
        agg_type_string:   aggString,
        format_string:     "",
        description:       m.description ?? "",
        data_type:         0,
        data_type_string:  dataTypeStr,
        folder:            m.folder ?? "",
      });

      sqlColumns[m.unique_name] = {
        alias:       false,
        name:        m.unique_name,
        data_type:   dataTypeStr,
        label:       m.label ?? m.unique_name,
        description: m.description ?? "",
        role:        "measure",
        type:        "quantitative",
        aggregation: aggString,
        folder:      m.folder ?? "",
      };
    }

    // ---- Build MDX attributes + SQL columns for dimensions ----
    // All dimension names referenced via relationships + degenerate dims
    const relatedDimNames = new Set<string>(
      (modelData.relationships ?? [])
        .map((r: any) => r.to?.dimension)
        .filter(Boolean),
    );
    const degenerateDims: string[] = modelData.dimensions ?? [];
    const allDimNames = [...relatedDimNames, ...degenerateDims];

    const mdxAttributes: Record<string, Record<string, any[]>> = {};

    for (const dimUniqueName of allDimNames) {
      const dim = dimensionsLookup.get(dimUniqueName);
      if (!dim) {
        this.logger.verbose(`Dimension not found: ${dimUniqueName}`);
        continue;
      }

      const dimLabel = dim.label ?? dimUniqueName;

      // level_attr lookup: unique_name → level_attr data
      const laLookup = new Map<string, any>();
      for (const la of (dim.level_attributes ?? [])) {
        laLookup.set(la.unique_name, la);
      }

      const dimHierarchies: Record<string, any[]> = {};

      for (const hier of (dim.hierarchies ?? [])) {
        const hierLabel = hier.label ?? hier.unique_name;
        const levels: any[] = [];
        let levelNum = 1;

        for (const levelRef of (hier.levels ?? [])) {
          const la = laLookup.get(levelRef.unique_name);
          if (!la) continue;

          const colTypes    = datasetColumnTypes.get(la.dataset);
          const dataTypeStr = colTypes?.get(la.name_column) ?? "WSTR";

          levels.push({
            query_name:       la.name_column,
            caption:          la.label ?? la.name_column,
            level_number:     levelNum++,
            description:      "",
            data_type_string: dataTypeStr,
            folder:           "",
          });

          // Add to sql.columns (first occurrence wins)
          if (!sqlColumns[la.name_column]) {
            const { role, type } = roleAndType(dataTypeStr);
            sqlColumns[la.name_column] = {
              alias:       false,
              name:        la.name_column,
              data_type:   dataTypeStr,
              label:       la.label ?? la.name_column,
              description: "",
              role,
              type,
              folder:      "",
            };
          }
        }

        if (levels.length > 0) {
          dimHierarchies[`${hierLabel} Hierarchy`] = levels;
        }
      }

      if (Object.keys(dimHierarchies).length > 0) {
        mdxAttributes[dimLabel] = dimHierarchies;
      }
    }

    // ---- Assemble output ----
    const output: Record<string, any> = {
      [modelName]: {
        data_source: connectionName,
        mdx: {
          metrics:    mdxMetrics,
          attributes: mdxAttributes,
        },
        sql: {
          table_name: modelName,
          columns:    sqlColumns,
        },
      },
    };

    const outputYaml = stringify(output);

    if (params["output-model-file"]?.trim()) {
      yaml.saveToFile(params["output-model-file"], output);
      this.logger.info(`Wrote model output to ${params["output-model-file"]}`);
    } else {
      this.logger.log(outputYaml);
    }
  }
}
