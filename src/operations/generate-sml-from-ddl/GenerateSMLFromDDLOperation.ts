/**
 * GenerateSMLFromDDL
 *
 * Parses a SQL DDL file (CREATE TABLE / CREATE VIEW statements) and generates
 * AtScale SML files by running the semantic model inference algorithm.
 *
 * Views are treated as datasets by default (views-as-tables).  View columns come
 * from the view's column list or SELECT aliases; their types are resolved from
 * source tables in the same DDL, CAST / :: expressions, or column-types
 * overrides.  Objects may be named with one-, two- or three-part names; when the
 * generated datasets span several schemas, one connection file is written per
 * schema.
 *
 * No database connection is required — inference runs entirely from the schema
 * definition.  This is useful for offline model generation, CI pipelines, or
 * environments where a live connection is not available.
 *
 * Output files are written to the specified directory following the SML layout:
 *   <output-dir>/catalog.yml
 *   <output-dir>/connections/<connectionName>.yml   (one per schema when datasets span schemas)
 *   <output-dir>/datasets/<table>.yml
 *   <output-dir>/dimensions/<dimension>.yml
 *   <output-dir>/metrics/<metric>.yml
 *   <output-dir>/models/<modelName>.yml
 *   <output-dir>/sml.style.yaml   (effective settings written after generation)
 */
import fs from "fs";
import path from "path";
import { Operation } from "../Operation.js";
import { ParameterSet, StringParameter, BooleanParameter, NumberParameter } from "../../Parameters.js";
import type { ServiceRegistry } from "../../services/registry.js";
import type { Logger } from "../../logging.js";
import { DdlDatabaseMetaData } from "../../algorithm/ddl-reader.js";
import { resolvePiiSeverity, runInferenceAndWrite } from "../generate-sml-shared.js";
import { loadSmlStyleConfig, mergeSmlStyle } from "../sml-style-config.js";

// ----------------------------------------------------------
// Parameter declarations
// ----------------------------------------------------------

class GenerateSMLFromDDLParamsSet extends ParameterSet {
  parameters = [
    new (class extends StringParameter {
      name        = "ddl-file";
      description = "Path to the SQL DDL file to parse (CREATE TABLE / CREATE VIEW statements)";
      required    = true;
    })(),
    new (class extends StringParameter {
      name        = "model-name";
      description = "Name for the generated semantic model (defaults to the DDL filename stem)";
      required    = false;
    })(),
    new (class extends StringParameter {
      name        = "output-dir";
      description = "Directory where SML files will be written";
      required    = true;
    })(),
    new (class extends StringParameter {
      name        = "connection-name";
      description = "Connection name to embed in the generated SML files (for AtScale to reference)";
      required    = false;
      defaultValue = "my_connection";
    })(),
    new (class extends StringParameter {
      name        = "sml-config-file";
      description = 'Path to the SML style configuration file (default: "sml.style.yaml"). Style file values are overridden by CLI flags. The effective settings are always written to <output-dir>/sml.style.yaml after generation.';
      required    = false;
      defaultValue = "sml.style.yaml";
    })(),
    new (class extends StringParameter {
      name        = "catalog-name";
      description = "Display name for the generated catalog (defaults to model-name). Can also be set in sml.style.yaml.";
      required    = false;
    })(),
    new (class extends StringParameter {
      name        = "pii-severity";
      description = 'Minimum PII severity to exclude: "HIGH", "MEDIUM" (default), "LOW", or "none". Can also be set in sml.style.yaml.';
      required    = false;
    })(),
    new (class extends StringParameter {
      name        = "schema";
      description = "Schema name, or comma-separated list of schema names, used to filter the DDL (only tables and views in these schemas, or unqualified, are included)";
      required    = false;
    })(),
    new (class extends StringParameter {
      name        = "database";
      description = "Database (catalog) name to embed in the SML connection file";
      required    = false;
    })(),
    new (class extends StringParameter {
      name        = "dialect";
      description = 'Database dialect (e.g. "snowflake", "postgresql"). When "snowflake", dataset table names are uppercased.';
      required    = false;
    })(),
    new (class extends StringParameter {
      name        = "fact-tables";
      description = "Comma-separated list of table names to treat as fact tables, overriding automatic classification. Can also be set as a list in sml.style.yaml.";
      required    = false;
    })(),
    new (class extends BooleanParameter {
      name        = "camel-case-files";
      description = "When true, dataset and dimension filenames use camelCase of the source table name (default: false). Can also be set in sml.style.yaml.";
      required    = false;
    })(),
    new (class extends BooleanParameter {
      name        = "camel-case-measures";
      description = "When true, metric labels use camelCase of the source column name (default: false). Can also be set in sml.style.yaml.";
      required    = false;
    })(),
    new (class extends StringParameter {
      name        = "label-style";
      description = 'Label style for all SML object labels: "title-case" (default), "camel-case", or "none" (raw source names). Overrides camel-case-measures. Can also be set in sml.style.yaml.';
      required    = false;
    })(),
    new (class extends NumberParameter {
      name        = "min-hierarchies-per-dim";
      description = "Minimum number of hierarchies a dimension must have to be included in the model (default: 1). Dimensions with fewer are dropped. Can also be set in sml.style.yaml.";
      required    = false;
    })(),
    new (class extends NumberParameter {
      name        = "max-hierarchies-per-dim";
      description = "Maximum number of hierarchies to keep per dimension (default: 4). Extra hierarchies are truncated. Can also be set in sml.style.yaml.";
      required    = false;
    })(),
    new (class extends BooleanParameter {
      name        = "views-as-tables";
      description = "When true (default), CREATE VIEW objects are treated as datasets and classified as facts / dimensions like tables. When false, views are ignored for SML generation. Can also be set in sml.style.yaml.";
      required    = false;
    })(),
    new (class extends StringParameter {
      name        = "column-types";
      description = 'Column data type overrides as "TABLE.COLUMN=TYPE" pairs separated by commas or semicolons, e.g. "VW_CASHFLOW.Amount=NUMBER(38,6);VW_DATE.Date=DATE". Use for view columns whose type cannot be resolved from the DDL. Merged over column-types in sml.style.yaml.';
      required    = false;
    })(),
    new (class extends StringParameter {
      name        = "relationships";
      description = 'Relationships to add, as "FROM_TABLE.COLUMN -> TO_TABLE.COLUMN" entries separated by commas, e.g. "VW_CASHFLOW.Flow -> VW_FLOW_SNAP.Flow". The target column becomes the target key when the target has none. Can also be set as a list in sml.style.yaml.';
      required    = false;
    })(),
    new (class extends BooleanParameter {
      name        = "infer-key-name-joins";
      description = "When true (default), a column whose name exactly matches another table's key column (its single-column PK, or the first column of a view) is inferred as a join. Only applies to tables with no declared foreign keys. Can also be set in sml.style.yaml.";
      required    = false;
    })(),
  ];
}

type Params = {
  "ddl-file":             string;
  "model-name"?:          string;
  "output-dir":           string;
  "connection-name":      string;
  "sml-config-file":      string;
  "catalog-name"?:        string;
  "pii-severity"?:        string;
  schema?:                string;
  database?:              string;
  dialect?:               string;
  "fact-tables"?:         string;
  "camel-case-files"?:          boolean;
  "camel-case-measures"?:       boolean;
  "label-style"?:               "title-case" | "camel-case" | "none";
  "min-hierarchies-per-dim"?:   number;
  "max-hierarchies-per-dim"?:   number;
  "views-as-tables"?:           boolean;
  "column-types"?:              string;
  relationships?:               string;
  "infer-key-name-joins"?:      boolean;
};
export type GenerateSMLFromDDLParams = Params;

// ----------------------------------------------------------
// Helpers
// ----------------------------------------------------------

const DIALECT_PATTERNS: Array<[RegExp, string]> = [
  [/snowflake/i, "snowflake"],
  [/postgres|postgresql|pg\b/i, "postgresql"],
  [/bigquery|bq\b/i, "bigquery"],
  [/redshift/i, "redshift"],
  [/databricks/i, "databricks"],
];

/**
 * Parse --column-types: "T.C=TYPE" entries separated by commas or semicolons.
 * Commas inside parentheses (e.g. NUMBER(38,6)) do not split entries.
 */
export function parseColumnTypesParam(raw: string | undefined): Record<string, string> | undefined {
  if (!raw || !raw.trim()) return undefined;
  const entries: string[] = [];
  let depth = 0;
  let current = "";
  for (const ch of raw) {
    if (ch === "(") depth++;
    else if (ch === ")") depth--;
    if ((ch === "," || ch === ";") && depth === 0) {
      entries.push(current);
      current = "";
      continue;
    }
    current += ch;
  }
  entries.push(current);
  const result: Record<string, string> = {};
  for (const entry of entries) {
    const eq = entry.indexOf("=");
    if (eq === -1) {
      if (entry.trim()) throw new Error(`Invalid --column-types entry "${entry.trim()}" — expected TABLE.COLUMN=TYPE`);
      continue;
    }
    const key = entry.slice(0, eq).trim();
    const type = entry.slice(eq + 1).trim();
    if (!key || !type) throw new Error(`Invalid --column-types entry "${entry.trim()}" — expected TABLE.COLUMN=TYPE`);
    result[key] = type;
  }
  return result;
}

function detectDialectFromFilename(filePath: string): string | undefined {
  const name = path.basename(filePath);
  for (const [pattern, dialect] of DIALECT_PATTERNS) {
    if (pattern.test(name)) return dialect;
  }
  return undefined;
}

// ----------------------------------------------------------
// Operation
// ----------------------------------------------------------

export class GenerateSMLFromDDLOperation extends Operation<Params> {
  name        = "generate-sml-from-ddl";
  description = "Parse a DDL file and generate AtScale SML files from the inferred semantic model";
  parameters  = new GenerateSMLFromDDLParamsSet();

  constructor(services: ServiceRegistry, logger: Logger) {
    super(services, logger);
  }

  async run(params: Params): Promise<void> {
    const ddlFile   = path.resolve(params["ddl-file"]);
    const outputDir = path.resolve(params["output-dir"]);
    const modelName = params["model-name"] ?? path.basename(ddlFile, path.extname(ddlFile));

    if (!fs.existsSync(ddlFile)) {
      throw new Error(`DDL file not found: ${ddlFile}`);
    }

    // ---- Merge CLI params + sml.style.yaml ----
    const styleFileConfig = loadSmlStyleConfig(params["sml-config-file"]);
    const cliFact = params["fact-tables"]?.split(",").map((t) => t.trim()).filter(Boolean);
    const cliRelationships = params.relationships?.split(",").map((r) => r.trim()).filter(Boolean);
    const style = mergeSmlStyle(
      {
        "views-as-tables":         params["views-as-tables"],
        "column-types":            parseColumnTypesParam(params["column-types"]),
        "relationships":           cliRelationships,
        "infer-key-name-joins":    params["infer-key-name-joins"],
        "pii-severity":            params["pii-severity"],
        "fact-tables":             cliFact,
        "catalog-name":            params["catalog-name"],
        "camel-case-files":        params["camel-case-files"],
        "camel-case-measures":     params["camel-case-measures"],
        "label-style":             params["label-style"],
        "min-hierarchies-per-dim": params["min-hierarchies-per-dim"],
        "max-hierarchies-per-dim": params["max-hierarchies-per-dim"],
      },
      styleFileConfig,
    );

    this.logger.log(`[GenerateSMLFromDDL] Parsing DDL file: ${ddlFile}`);
    const db = await DdlDatabaseMetaData.fromFile(ddlFile, {
      viewsAsTables: style["views-as-tables"],
      columnTypes:   style["column-types"],
    });

    const tableNames  = db.getTableNames();
    const viewNames   = db.getViewNames();
    const schemaNames = db.getSchemaNames();
    this.logger.log(
      `[GenerateSMLFromDDL] Found ${tableNames.length} table(s) and ${viewNames.length} view(s)` +
      (schemaNames.length > 0 ? ` across ${schemaNames.length} schema(s): ${schemaNames.join(", ")}` : ""),
    );
    for (const warning of [...db.getDuplicateTableWarnings(), ...db.getReaderWarnings()]) {
      this.logger.log(`  ⚠  ${warning}`);
    }

    const catalogName      = style["catalog-name"] || modelName;
    const factTablesEff    = style["fact-tables"].length > 0 ? style["fact-tables"] : undefined;

    // --schema may be a comma-separated list; only a single schema is embedded
    // in the connection file as the fallback for unqualified objects.
    const schemaFilter = params.schema?.split(",").map((s) => s.trim()).filter(Boolean) ?? [];
    const connectionSchema = schemaFilter.length === 1 ? schemaFilter[0] : undefined;

    await runInferenceAndWrite(
      db,
      modelName,
      {
        schemaPattern:           schemaFilter.length > 0 ? schemaFilter.join(",") : undefined,
        piiExclusionSeverity:    resolvePiiSeverity(style["pii-severity"]),
        sampleSize:              0,  // DDL has no row data; disable sampling
        factTables:              factTablesEff,
        minHierarchiesPerDim:    style["min-hierarchies-per-dim"],
        maxHierarchiesPerDim:    style["max-hierarchies-per-dim"],
        relationships:           style["relationships"],
        inferKeyNameJoins:       style["infer-key-name-joins"],
        sml: {
          connectionName:    params["connection-name"],
          catalogName,
          database:          params.database,
          schema:            connectionSchema,
          dialect:           params.dialect ?? detectDialectFromFilename(ddlFile),
          camelCaseFiles:    style["camel-case-files"],
          camelCaseMeasures: style["camel-case-measures"],
          labelStyle:        style["label-style"],
        },
      },
      outputDir,
      this.logger,
      "GenerateSMLFromDDL",
      // Effective settings written to <outputDir>/sml.style.yaml
      {
        "pii-severity":        style["pii-severity"],
        "fact-tables":         style["fact-tables"],
        "catalog-name":        catalogName,
        "camel-case-files":          style["camel-case-files"],
        "camel-case-measures":       style["camel-case-measures"],
        "label-style":               style["label-style"],
        "sample-size":               0,
        "min-hierarchies-per-dim":   style["min-hierarchies-per-dim"],
        "max-hierarchies-per-dim":   style["max-hierarchies-per-dim"],
        "views-as-tables":           style["views-as-tables"],
        "column-types":              style["column-types"],
        "relationships":             style["relationships"],
        "infer-key-name-joins":      style["infer-key-name-joins"],
      },
    );
  }
}
