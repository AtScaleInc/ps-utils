# @atscale-ps/ps-utils — Node.js Library API

Typed Node.js API that wraps every CLI operation as an `async` function. Install once, call from any TypeScript or JavaScript project.

## Installation

```bash
npm install @atscale-ps/ps-utils
```

## Quick Start

```typescript
import { generateSMLFromConnection } from "@atscale-ps/ps-utils";

await generateSMLFromConnection({
  connectionName: "snow_prod",
  modelName:      "Sales",
  outputDir:      "./sml-output",
  // connectionFile and smlConfigFile have library defaults — omit to use them
});
```

## LibraryOptions

Every function accepts an optional second argument:

```typescript
interface LibraryOptions {
  logger?: Logger;   // custom logger; defaults to the same console logger as the CLI
}
```

`Logger` and `LoggerOptions` are also exported if you need to construct a logger manually:

```typescript
import { buildLogger } from "@atscale-ps/ps-utils";
const logger = buildLogger({ verbose: true, logfile: "run.log" });
```

## Parameters

All parameters use **camelCase** keys. Fields marked **Optional** in the table below may be omitted; the library supplies the listed default at runtime.

## Stream Support

Every file and directory parameter accepts a Node.js stream in place of a path. Four type aliases are exported:

```typescript
import type { FileInput, DirInput, FileOutput, DirOutput } from "@atscale-ps/ps-utils";
```

| Type | Definition | Usage |
|---|---|---|
| `FileInput` | `string \| Readable` | Input file: pass a path **or** a `Readable` of the file's contents |
| `DirInput` | `string \| Readable` | Input directory: pass a path **or** a `Readable` of a ZIP archive |
| `FileOutput` | `string \| Writable` | Output file: pass a path **or** a `Writable` that receives the file's contents |
| `DirOutput` | `string \| Writable` | Output directory: pass a path **or** a `Writable` that receives a ZIP archive |

**Example — pipe SML output directly to a ZIP stream:**

```typescript
import { createWriteStream } from "node:fs";
import { generateSMLFromConnection } from "@atscale-ps/ps-utils";

const zip = createWriteStream("sml-output.zip");
await generateSMLFromConnection({
  connectionName: "snow_prod",
  modelName:      "Sales",
  outputDir:      zip,   // Writable → receives a ZIP of the generated SML directory
});
```

**`generateSharedModelPlan` — special ZIP input:**

The `inputDirs` parameter normally takes a comma-separated string of paths. When a `Readable` ZIP is passed instead, the top-level folders inside the archive become the directory list automatically.

---

## Table of Contents

- [Model Extraction](#model-extraction)
  - [`extractModelFromAtScale`](#extractmodelfromatscale)
  - [`extractModelFromSML`](#extractmodelfromsml)
- [SML Creation and Manipulation](#sml-creation-and-manipulation)
  - [`executeSQLOnConnection`](#executesqlonconnection)
  - [`extractDDLFromConnection`](#extractddlfromconnection)
  - [`generateSMLFromConnection`](#generatesmlfromconnection)
  - [`generateSMLFromDDL`](#generatesmlfromddl)
  - [`generateSMLFromXML`](#generatesmlfromxml)
  - [`generateSharedModelPlan`](#generatesharedmodelplan)
  - [`applySharedModelPlanOption`](#generatesmlFromsharedmodelplan)
  - [`applyStyleToSML`](#applystyletosml)
  - [`generateSMLDocs`](#generatesmldocs)
  - [`generateDDLFromAtScale`](#generateddlfromatscale)
  - [`generateMetricsFromModel`](#generatemetricsfrommodel)
  - [`echoConnectionMetadata`](#echoconnectionmetadata)
- [Synthetic Data Generation](#synthetic-data-generation)
  - [`extractDataShapeFromConnection`](#extractdatashapefromconnection)
  - [`generateDDLFromDataShape`](#generateddlfromdatashape)
  - [`generateDataFromDataShape`](#generatedatafromdatashape)
  - [`generateDataFromDataShapeToConnection`](#generatedatafromdatashapetoconnection)
- [Visualization and Namespace Processing](#visualization-and-namespace-processing)
  - [`generateNamespaceFromModel`](#generatenamespacefrommodel)
  - [`generateTableauFromNamespace`](#generatetableaufromnamespace)
  - [`generateExcelFromNamespace`](#generateexcelfromnamespace)
  - [`generateNotebookFromConnection`](#generatenotebookfromconnection)
- [Testing / Query Processing](#testing--query-processing)
  - [`generateQueriesFromSML`](#generatequeriesfromsml)
  - [`generateQueriesFromModel`](#generatequeriesfrommodel)
  - [`extractQueryStatsFromAtScale`](#extractquerystatsfromatscale)
  - [`extractQueriesFromAtScale`](#extractqueriesfromatscale)
  - [`executeAtScaleQueryHarness`](#executeatscalequeryharness)
  - [`executeQueryOnConnection`](#executequeryonconnection)
  - [`generateEnhancedQueryResults`](#generateenhancedqueryresults)
  - [`executeRunAnalysis`](#executerunanalysis)
- [AtScale Config](#atscale-config)
  - [`generateAtScaleInstallYaml`](#generateatscaleinstallyaml)
  - [`atScaleListDataSources`](#atscalelistdatasources)
  - [`atScaleCreateDataSource`](#atscalecreatedatasource)
  - [`atScaleListRepos`](#atscalelistrepos)
  - [`atScaleCreateRepo`](#atscalecreaterepo)
  - [`atScaleListDeployments`](#atscalelistdeployments)
  - [`atScaleDeployCatalog`](#atscaledeploycatalog)
  - [`atScaleListModelErrors`](#atscalelistmodelerrors)
  - [`getDsoCount`](#getDsoCount)
- [Web Services](#web-services)
  - [`executeWebServices`](#executewebservices)
- [Utilities](#utilities)
  - [`version`](#version)

---

## Operations

#### Model Extraction

### `extractModelFromAtScale`

[↑ Table of Contents](#table-of-contents)

Connects to a live AtScale instance and extracts a model's metrics and dimension hierarchies into a `model.yaml` file.

```typescript
import { extractModelFromAtScale } from "@atscale-ps/ps-utils";

await extractModelFromAtScale({
  model:            "Sales",
  connectionFile:   "connections.yaml",
  connectionName:   "ats_prod",
  outputModelFile:  "./model.yaml",
});
```

```typescript
function extractModelFromAtScale(
  params: ExtractModelFromAtScaleParams,
  options?: LibraryOptions
): Promise<void>
```

| Key | Type | Required | Default | Description |
|---|---|---|---|---|
| `model` | `string` | Yes | | AtScale model/cube name |
| `connectionFile` | `FileInput` | Yes | | Path to connections file, or a `Readable` of its contents |
| `connectionName` | `string` | Yes | | Connection name in the file |
| `outputModelFile` | `FileOutput` | No | | Output path for model YAML, or a `Writable` to receive it (stdout if omitted) |

---

### `extractModelFromSML`

[↑ Table of Contents](#table-of-contents)

Reads a local SML directory and outputs a `model.yaml` in the same format as `extractModelFromAtScale`. Use when no live AtScale connection is available.

```typescript
import { extractModelFromSML } from "@atscale-ps/ps-utils";

await extractModelFromSML({
  smlDir:          "./sml-output",
  outputModelFile: "./model.yaml",
});
```

```typescript
function extractModelFromSML(
  params: ExtractModelFromSMLParams,
  options?: LibraryOptions
): Promise<void>
```

| Key | Type | Required | Default | Description |
|---|---|---|---|---|
| `smlDir` | `DirInput` | Yes | | Path to SML directory, or a `Readable` ZIP archive of it |
| `modelName` | `string` | No | | Model label or `unique_name` to extract (first found if omitted) |
| `connectionName` | `string` | No | | Override the `data_source` connection name |
| `outputModelFile` | `FileOutput` | No | | Output path for model YAML, or a `Writable` to receive it |

---

#### SML Creation and Manipulation

### `executeSQLOnConnection`

[↑ Table of Contents](#table-of-contents)

Reads a SQL file and executes each statement against a named database connection.

```typescript
import { executeSQLOnConnection } from "@atscale-ps/ps-utils";

await executeSQLOnConnection({
  sqlFile:        "./schema.sql",
  connectionName: "snow_prod",
});
```

```typescript
function executeSQLOnConnection(
  params: ExecuteSQLOnConnectionParams,
  options?: LibraryOptions
): Promise<void>
```

| Key | Type | Required | Default | Description |
|---|---|---|---|---|
| `sqlFile` | `FileInput` | Yes | | Path to SQL file, or a `Readable` of its contents |
| `connectionName` | `string` | Yes | | Connection name in the file |
| `connectionFile` | `FileInput` | No | `"connections.yaml"` | Path to connections file, or a `Readable` of its contents |
| `onError` | `string` | No | `"stop"` | `stop` halts on first failure; `continue` logs and proceeds |
| `dryRun` | `boolean` | No | `false` | Print statements without executing |

---

### `extractDDLFromConnection`

[↑ Table of Contents](#table-of-contents)

Connects to a live database and writes `CREATE TABLE` DDL statements for each table in the target schema.

```typescript
import { extractDDLFromConnection } from "@atscale-ps/ps-utils";

await extractDDLFromConnection({
  connectionName: "snow_prod",
  schema:         "PUBLIC",
  outputFile:     "./schema.ddl",
});
```

```typescript
function extractDDLFromConnection(
  params: ExtractDDLFromConnectionParams,
  options?: LibraryOptions
): Promise<void>
```

| Key | Type | Required | Default | Description |
|---|---|---|---|---|
| `connectionName` | `string` | Yes | | Connection name in the file |
| `schema` | `string` | Yes | | Database schema to introspect |
| `connectionFile` | `FileInput` | No | `"connections.yaml"` | Path to connections file, or a `Readable` of its contents |
| `tables` | `string` | No | | Comma-separated table names or wildcard patterns |
| `outputFile` | `FileOutput` | No | | Output path for DDL, or a `Writable` to receive it (stdout if omitted) |

---

### `generateSMLFromConnection`

[↑ Table of Contents](#table-of-contents)

Connects to a live database, introspects its schema, and writes a complete set of AtScale SML files.

```typescript
import { generateSMLFromConnection } from "@atscale-ps/ps-utils";

await generateSMLFromConnection({
  connectionName: "snow_prod",
  modelName:      "Sales",
  outputDir:      "./sml-output",
});
```

```typescript
function generateSMLFromConnection(
  params: GenerateSMLFromConnectionParams,
  options?: LibraryOptions
): Promise<void>
```

| Key | Type | Required | Default | Description |
|---|---|---|---|---|
| `connectionName` | `string` | Yes | | Connection name in the file |
| `modelName` | `string` | Yes | | Name for the generated semantic model |
| `outputDir` | `DirOutput` | Yes | | Directory where SML files will be written, or a `Writable` to receive a ZIP |
| `connectionFile` | `FileInput` | No | `"connections.yaml"` | Path to connections file, or a `Readable` of its contents |
| `smlConfigFile` | `FileInput` | No | `"sml.style.yaml"` | Path to SML style configuration file, or a `Readable` of its contents |
| `schema` | `string` | No | | Override schema name (overrides connection config) |
| `catalogName` | `string` | No | | Catalog display name (defaults to `modelName`) |
| `piiSeverity` | `string` | No | | PII exclusion level: `HIGH`, `MEDIUM`, `LOW`, or `none` |
| `sampleSize` | `number` | No | | Max rows per table for type inference (default 250; 0 to disable) |
| `factTables` | `string` | No | | Comma-separated fact table names (overrides auto-classification) |
| `camelCaseFiles` | `boolean` | No | | Use camelCase for dataset/dimension filenames |
| `camelCaseMeasures` | `boolean` | No | | Use camelCase for metric labels (deprecated — use `labelStyle`) |
| `labelStyle` | `"title-case" \| "camel-case" \| "none"` | No | `"title-case"` | Label style for all SML object labels; overrides `camelCaseMeasures` |
| `minHierarchiesPerDim` | `number` | No | | Min hierarchies per dimension (default 1) |
| `maxHierarchiesPerDim` | `number` | No | | Max hierarchies per dimension (default 4) |

---

### `generateSMLFromDDL`

[↑ Table of Contents](#table-of-contents)

Parses a DDL file and generates a complete set of AtScale SML files without a live database connection.

```typescript
import { generateSMLFromDDL } from "@atscale-ps/ps-utils";

await generateSMLFromDDL({
  ddlFile:  "./schema.sql",
  outputDir: "./sml-output",
});
```

```typescript
function generateSMLFromDDL(
  params: GenerateSMLFromDDLParams,
  options?: LibraryOptions
): Promise<void>
```

| Key | Type | Required | Default | Description |
|---|---|---|---|---|
| `ddlFile` | `FileInput` | Yes | | Path to SQL DDL file, or a `Readable` of its contents |
| `outputDir` | `DirOutput` | Yes | | Directory where SML files will be written, or a `Writable` to receive a ZIP |
| `connectionName` | `string` | No | `"my_connection"` | Connection name embedded in generated SML |
| `smlConfigFile` | `FileInput` | No | `"sml.style.yaml"` | Path to SML style configuration file, or a `Readable` of its contents |
| `modelName` | `string` | No | | Model name (defaults to DDL filename stem) |
| `catalogName` | `string` | No | | Catalog display name |
| `piiSeverity` | `string` | No | | PII exclusion level |
| `schema` | `string` | No | | Schema filter |
| `database` | `string` | No | | Database name to embed in connection file |
| `dialect` | `string` | No | | Database dialect (e.g. `snowflake`, `postgresql`) |
| `factTables` | `string` | No | | Comma-separated fact table names |
| `camelCaseFiles` | `boolean` | No | | Use camelCase for dataset/dimension filenames |
| `camelCaseMeasures` | `boolean` | No | | Use camelCase for metric labels (deprecated — use `labelStyle`) |
| `labelStyle` | `"title-case" \| "camel-case" \| "none"` | No | `"title-case"` | Label style for all SML object labels; overrides `camelCaseMeasures` |
| `minHierarchiesPerDim` | `number` | No | | Min hierarchies per dimension |
| `maxHierarchiesPerDim` | `number` | No | | Max hierarchies per dimension |

---

### `generateSMLFromXML`

[↑ Table of Contents](#table-of-contents)

Converts an AtScale XML project file to SML files.

```typescript
import { generateSMLFromXML } from "@atscale-ps/ps-utils";

await generateSMLFromXML({
  xmlFile:   "./project.xml",
  outputDir: "./sml-output",
});
```

```typescript
function generateSMLFromXML(
  params: GenerateSMLFromXMLParams,
  options?: LibraryOptions
): Promise<void>
```

| Key | Type | Required | Default | Description |
|---|---|---|---|---|
| `xmlFile` | `FileInput` | Yes | | Path to AtScale XML project file, or a `Readable` of its contents |
| `outputDir` | `DirOutput` | Yes | | Directory where SML files will be written, or a `Writable` to receive a ZIP |
| `connectionName` | `string` | No | | SML connection `unique_name` (auto-detected from XML if omitted) |
| `connectionType` | `string` | No | | Database dialect for the connection file |
| `catalogName` | `string` | No | | Override the catalog label |
| `connectionDb` | `string` | No | | Database name written into the connection file; when set, every dataset shares one connection instead of a separate connection per distinct database/schema pair found in the XML |
| `connectionSchema` | `string` | No | | Schema name written into the connection file; when set, every dataset shares one connection instead of a separate connection per distinct database/schema pair found in the XML |

---

### `generateSharedModelPlan`

[↑ Table of Contents](#table-of-contents)

Analyses two or more SML output directories and writes a `RECOMMENDATION.md` plus option YAML files describing how to consolidate shared dimensions, datasets, and models.

```typescript
import { generateSharedModelPlan } from "@atscale-ps/ps-utils";

await generateSharedModelPlan({
  inputDirs: "./project-a/sml,./project-b/sml",
  outputDir: "./shared-plan",
});
```

```typescript
function generateSharedModelPlan(
  params: GenerateSharedModelPlanParams,
  options?: LibraryOptions
): Promise<void>
```

| Key | Type | Required | Default | Description |
|---|---|---|---|---|
| `inputDirs` | `DirInput` | Yes | | Comma-separated SML directories to analyse, or a `Readable` ZIP whose top-level folders become the list |
| `outputDir` | `DirOutput` | Yes | | Output directory for `RECOMMENDATION.md` and option YAML files, or a `Writable` to receive a ZIP |
| `threshold` | `number` | No | `0.5` | Similarity threshold 0–1; lower surfaces more options |
| `maxPerSubject` | `number` | No | `3` | Maximum recommendations per subject entity (dataset, dimension, or model pair); prevents flooding output with near-duplicate options for the same entity |

---

### `applySharedModelPlanOption`

[↑ Table of Contents](#table-of-contents)

Applies a `generateSharedModelPlan` recommendation YAML to produce shared SML files.

```typescript
import { applySharedModelPlanOption } from "@atscale-ps/ps-utils";

await applySharedModelPlanOption({
  planFile:  "./shared-plan/option-1.yml",
  sharedDir: "./shared",
});
```

```typescript
function applySharedModelPlanOption(
  params: ApplySharedModelPlanOptionParams,
  options?: LibraryOptions
): Promise<void>
```

| Key | Type | Required | Default | Description |
|---|---|---|---|---|
| `planFile` | `FileInput` | Yes | | Path to option YAML produced by `generateSharedModelPlan`, or a `Readable` of its contents |
| `sharedDir` | `DirOutput` | Yes | | Base directory for shared output files, or a `Writable` to receive a ZIP |
| `removeSources` | `boolean` | No | `false` | Delete local source files after writing shared version |
| `dryRun` | `boolean` | No | `false` | Print all actions without writing or deleting files |

---

### `applyStyleToSML`

[↑ Table of Contents](#table-of-contents)

Re-applies display labels to an existing SML directory using a style config. Updates `label` fields in datasets, dimensions, and metrics YAML files in-place, and writes `STYLE.md` and `STYLE_CHANGES.md`.

```typescript
import { applyStyleToSML } from "@atscale-ps/ps-utils";

await applyStyleToSML({
  smlDir: "./sml-output",
});
```

```typescript
function applyStyleToSML(
  params: ApplyStyleToSMLParams,
  options?: LibraryOptions
): Promise<void>
```

| Key | Type | Required | Default | Description |
|---|---|---|---|---|
| `smlDir` | `DirInput` | Yes | | Path to the SML output directory to update, or a `Readable` ZIP archive of it |
| `smlConfigFile` | `FileInput` | No | `"<smlDir>/sml.style.yaml"` | Path to SML style configuration file, or a `Readable` of its contents |
| `labelStyle` | `"title-case" \| "camel-case" \| "none"` | No | `"title-case"` | Label style for all SML object labels; overrides `camelCaseMeasures` |
| `catalogName` | `string` | No | | Catalog display name for `STYLE.md` |

---

### `generateSMLDocs`

[↑ Table of Contents](#table-of-contents)

Reads an SML directory and generates a single Markdown reference of every SML object — catalog, connections, datasets (fact vs dimension), dimensions (hierarchies, levels, level attributes, secondary attributes, snowflake/embedded joins), models (fact→dimension relationships with a Mermaid diagram, metric references, degenerate dimensions, perspectives, aggregates, overrides, drillthrough), metrics, calculations, and any security objects.

```typescript
import { generateSMLDocs } from "@atscale/ps-utils";

await generateSMLDocs({
  smlDir: "./sml-output",
});
```

```typescript
function generateSMLDocs(
  params: GenerateSMLDocsParams,
  options?: LibraryOptions
): Promise<void>
```

| Key | Type | Required | Default | Description |
|---|---|---|---|---|
| `smlDir` | `DirInput` | Yes | | Path to the SML directory to document, or a `Readable` ZIP archive of it |
| `outputFile` | `string` | No | `"README.md"` | Output Markdown file. A relative path is written inside `smlDir`; an absolute path is used as-is. |
| `title` | `string` | No | | H1 title for the document. Defaults to the catalog label / `unique_name`. |

---

### `generateDDLFromAtScale`

[↑ Table of Contents](#table-of-contents)

Generates `CREATE TABLE` DDL by reading table metadata from an AtScale data source via the REST API.

```typescript
import { generateDDLFromAtScale } from "@atscale-ps/ps-utils";

await generateDDLFromAtScale({
  atscaleConnectionName: "ats_prod",
  dataSourceName:        "snow_prod_ds",
  database:              "MY_DB",
  schema:                "PUBLIC",
});
```

```typescript
function generateDDLFromAtScale(
  params: GenerateDDLFromAtScaleParams,
  options?: LibraryOptions
): Promise<void>
```

| Key | Type | Required | Default | Description |
|---|---|---|---|---|
| `atscaleConnectionName` | `string` | Yes | | AtScale connection entry (must have an `atscale:` block) |
| `dataSourceName` | `string` | Yes | | Data source name as registered in AtScale |
| `database` | `string` | Yes | | Database (catalog) name |
| `schema` | `string` | Yes | | Schema name |
| `connectionFile` | `FileInput` | No | `"connections.yaml"` | Path to connections file, or a `Readable` of its contents |
| `tables` | `string` | No | | Comma-separated table names or wildcard patterns |
| `outputFile` | `FileOutput` | No | | Output path for DDL, or a `Writable` to receive it (stdout if omitted) |
| `insecure` | `boolean` | No | | Skip TLS certificate verification |

---

### `generateMetricsFromModel`

[↑ Table of Contents](#table-of-contents)

Runs the analysis-suggestions engine against a `model.yaml` and outputs ranked metric combinations.

```typescript
import { generateMetricsFromModel } from "@atscale-ps/ps-utils";

await generateMetricsFromModel({
  modelFile: "./model.yaml",
});
```

```typescript
function generateMetricsFromModel(
  params: GenerateMetricsFromModelParams,
  options?: LibraryOptions
): Promise<void>
```

| Key | Type | Required | Default | Description |
|---|---|---|---|---|
| `modelFile` | `FileInput` | Yes | | Path to `model.yaml`, or a `Readable` of its contents |
| `smlConfigFile` | `FileInput` | No | `"sml.style.yaml"` | Path to SML style configuration file, or a `Readable` of its contents |
| `format` | `string` | No | `"text"` | Output format: `text` or `yaml` |
| `modelName` | `string` | No | | Model name when `model.yaml` contains multiple models |
| `maxSuggestions` | `number` | No | | Max suggestions to generate (default 25) |
| `minScore` | `number` | No | | Min relevance score 0–1 (default 0.5) |
| `includeTuples` | `boolean` | No | | Include multi-dimension suggestions |
| `outputFile` | `FileOutput` | No | | Output path, or a `Writable` to receive it (stdout if omitted) |

---

### `echoConnectionMetadata`

[↑ Table of Contents](#table-of-contents)

Prints schemas, tables, columns, and foreign keys for a database connection. Useful for verifying connection config.

```typescript
import { echoConnectionMetadata } from "@atscale-ps/ps-utils";

await echoConnectionMetadata({
  connectionName: "snow_prod",
});
```

```typescript
function echoConnectionMetadata(
  params: EchoConnectionMetadataParams,
  options?: LibraryOptions
): Promise<void>
```

| Key | Type | Required | Default | Description |
|---|---|---|---|---|
| `connectionName` | `string` | Yes | | Connection name in the file |
| `connectionFile` | `FileInput` | No | `"connections.yaml"` | Path to connections file, or a `Readable` of its contents |
| `schema` | `string` | No | | Override schema name for metadata queries |

---

#### Synthetic Data Generation

### `extractDataShapeFromConnection`

[↑ Table of Contents](#table-of-contents)

Profiles an existing database and writes a statistical fingerprint to `data-shape.yaml`.

```typescript
import { extractDataShapeFromConnection } from "@atscale-ps/ps-utils";

await extractDataShapeFromConnection({
  connectionName: "snow_prod",
  smlPath:        "./sml-output",
});
```

```typescript
function extractDataShapeFromConnection(
  params: ExtractDataShapeFromConnectionParams,
  options?: LibraryOptions
): Promise<void>
```

| Key | Type | Required | Default | Description |
|---|---|---|---|---|
| `connectionName` | `string` | Yes | | Connection name in the file |
| `smlPath` | `DirInput` | Yes | | Path to SML output directory or `model.yml`, or a `Readable` ZIP of the directory |
| `connectionFile` | `FileInput` | No | `"connections.yaml"` | Path to connections file, or a `Readable` of its contents |
| `outputFile` | `FileOutput` | No | `"data-shape.yaml"` | Output path for fingerprint, or a `Writable` to receive it |
| `targetFactRows` | `number` | No | `100000` | Target row sample for fact tables |
| `targetColumnRows` | `number` | No | `10000` | Target row sample for dimension tables |
| `tablesample` | `boolean` | No | `true` | Use `TABLESAMPLE` for faster sampling |
| `serial` | `boolean` | No | `false` | Profile dimensions one at a time instead of in parallel |
| `preserveMetadata` | `boolean` | No | `false` | Store original table and column names in the fingerprint so data generation creates tables matching the SML model schema |

---

### `generateDDLFromDataShape`

[↑ Table of Contents](#table-of-contents)

Generates `CREATE TABLE` DDL from a `data-shape.yaml` fingerprint.

```typescript
import { generateDDLFromDataShape } from "@atscale-ps/ps-utils";

await generateDDLFromDataShape({});  // all params have defaults
```

```typescript
function generateDDLFromDataShape(
  params: GenerateDDLFromDataShapeParams,
  options?: LibraryOptions
): Promise<void>
```

| Key | Type | Required | Default | Description |
|---|---|---|---|---|
| `inputFile` | `FileInput` | No | `"data-shape.yaml"` | Path to `data-shape.yaml`, or a `Readable` of its contents |
| `dialect` | `string` | No | `"ansi"` | SQL dialect (e.g. `ansi`, `snowflake`) |
| `outputFile` | `FileOutput` | No | | Output path for DDL, or a `Writable` to receive it (stdout if omitted) |
| `preserveMetadata` | `boolean` | No | `false` | Use original table and column names from the fingerprint metadata block |

---

### `generateDataFromDataShape`

[↑ Table of Contents](#table-of-contents)

Generates synthetic CSV data from a `data-shape.yaml` fingerprint.

```typescript
import { generateDataFromDataShape } from "@atscale-ps/ps-utils";

await generateDataFromDataShape({});  // all params have defaults
```

```typescript
function generateDataFromDataShape(
  params: GenerateDataFromDataShapeParams,
  options?: LibraryOptions
): Promise<void>
```

| Key | Type | Required | Default | Description |
|---|---|---|---|---|
| `inputFile` | `FileInput` | No | `"data-shape.yaml"` | Path to `data-shape.yaml`, or a `Readable` of its contents |
| `outputDir` | `DirOutput` | No | `"data"` | Output directory for CSV files, or a `Writable` to receive a ZIP |
| `scaleFactor` | `number` | No | `1.0` | Scale factor for row counts |
| `seed` | `number` | No | | Random seed for reproducible output |
| `preserveMetadata` | `boolean` | No | `false` | Use original table and column names from the fingerprint metadata block |

---

### `generateDataFromDataShapeToConnection`

[↑ Table of Contents](#table-of-contents)

Generates synthetic data from a fingerprint and loads it directly into a target database.

```typescript
import { generateDataFromDataShapeToConnection } from "@atscale-ps/ps-utils";

await generateDataFromDataShapeToConnection({
  connectionName: "snow_target",
});
```

```typescript
function generateDataFromDataShapeToConnection(
  params: GenerateDataFromDataShapeToConnectionParams,
  options?: LibraryOptions
): Promise<void>
```

| Key | Type | Required | Default | Description |
|---|---|---|---|---|
| `connectionName` | `string` | Yes | | Connection name in the file |
| `inputFile` | `FileInput` | No | `"data-shape.yaml"` | Path to `data-shape.yaml`, or a `Readable` of its contents |
| `connectionFile` | `FileInput` | No | `"connections.yaml"` | Path to connections file, or a `Readable` of its contents |
| `scaleFactor` | `number` | No | `1.0` | Scale factor for row counts |
| `createTables` | `boolean` | No | `false` | Create tables before inserting |
| `dropIfExists` | `boolean` | No | `false` | Drop existing tables before creating |
| `dialect` | `string` | No | auto / `"ansi"` | SQL dialect. When omitted, read from the connection config (`sql.dialect`); falls back to `"ansi"` |
| `batchSize` | `number` | No | `500` | Insert batch size |
| `reportsDir` | `string` | No | `"_reports"` | Directory for load reports |
| `seed` | `number` | No | | Random seed for reproducible output |
| `schema` | `string` | No | | Target schema to qualify table names |
| `preserveMetadata` | `boolean` | No | `false` | Use original table and column names from the fingerprint metadata block |

---

#### Visualization and Namespace Processing

### `generateNamespaceFromModel`

[↑ Table of Contents](#table-of-contents)

Generates a namespace YAML from a `model.yaml` file, enriched with analysis suggestions.

```typescript
import { generateNamespaceFromModel } from "@atscale-ps/ps-utils";

await generateNamespaceFromModel({
  modelFile:   "./model.yaml",
  outputFile:  "./analysis/namespace.yaml",
});
```

```typescript
function generateNamespaceFromModel(
  params: GenerateNamespaceFromModelParams,
  options?: LibraryOptions
): Promise<void>
```

| Key | Type | Required | Default | Description |
|---|---|---|---|---|
| `modelFile` | `FileInput` | Yes | | Path to `model.yaml`, or a `Readable` of its contents |
| `maxSuggestions` | `string` | No | `"25"` | Maximum analysis suggestions to generate |
| `minScore` | `string` | No | `"0.5"` | Minimum relevance score 0–1 |
| `modelName` | `string` | No | | Model name when `model.yaml` contains multiple models |
| `title` | `string` | No | | Workbook title |
| `outputFile` | `FileOutput` | No | | Output path for namespace YAML, or a `Writable` to receive it (stdout if omitted) |

---

### `generateTableauFromNamespace`

[↑ Table of Contents](#table-of-contents)

Generates a ready-to-open Tableau workbook from a namespace YAML.

```typescript
import { generateTableauFromNamespace } from "@atscale-ps/ps-utils";

await generateTableauFromNamespace({
  // all params have defaults — omit any you want to keep as default
  targetFile: "./output/sales.twb",
});
```

```typescript
function generateTableauFromNamespace(
  params: GenerateTableauFromNamespaceParams,
  options?: LibraryOptions
): Promise<void>
```

| Key | Type | Required | Default | Description |
|---|---|---|---|---|
| `namespaceFile` | `FileInput` | No | `"analysis/namespace.yaml"` | Path to namespace YAML, or a `Readable` of its contents |
| `connectionFile` | `FileInput` | No | `"connections.yaml"` | Path to connections file, or a `Readable` of its contents |
| `modelFile` | `FileInput` | No | `"model.yaml"` | Path to `model.yaml`, or a `Readable` of its contents |
| `targetFile` | `FileOutput` | No | `"tableau.twb"` | Output path for the workbook, or a `Writable` to receive it |
| `tableauVersion` | `string` | No | `"2025"` | Target Tableau version |
| `connectionName` | `string` | No | `"default"` | Connection name |
| `aliasesFile` | `FileInput` | No | | Optional aliases YAML path, or a `Readable` of its contents |

---

### `generateExcelFromNamespace`

[↑ Table of Contents](#table-of-contents)

Generates an Excel workbook with OLAP pivot tables from a namespace YAML.

```typescript
import { generateExcelFromNamespace } from "@atscale-ps/ps-utils";

await generateExcelFromNamespace({
  targetFile: "./output/sales.xlsx",
});
```

```typescript
function generateExcelFromNamespace(
  params: GenerateExcelFromNamespaceParams,
  options?: LibraryOptions
): Promise<void>
```

| Key | Type | Required | Default | Description |
|---|---|---|---|---|
| `namespaceFile` | `FileInput` | No | `"analysis/namespace.yaml"` | Path to namespace YAML, or a `Readable` of its contents |
| `connectionFile` | `FileInput` | No | `"connections.yaml"` | Path to connections file, or a `Readable` of its contents |
| `modelFile` | `FileInput` | No | `"model.yaml"` | Path to `model.yaml`, or a `Readable` of its contents |
| `targetFile` | `FileOutput` | No | `"analysis/workbook.xlsx"` | Output path for the workbook, or a `Writable` to receive it |
| `connectionName` | `string` | No | `"default"` | Connection name |
| `aliasesFile` | `FileInput` | No | | Optional aliases YAML path, or a `Readable` of its contents |

---

### `generateNotebookFromConnection`

[↑ Table of Contents](#table-of-contents)

Generates a Jupyter notebook from a namespace and model YAML.

```typescript
import { generateNotebookFromConnection } from "@atscale-ps/ps-utils";

await generateNotebookFromConnection({
  targetFile: "./output/analysis.ipynb",
});
```

```typescript
function generateNotebookFromConnection(
  params: GenerateNotebookFromConnectionParams,
  options?: LibraryOptions
): Promise<void>
```

| Key | Type | Required | Default | Description |
|---|---|---|---|---|
| `namespaceFile` | `FileInput` | No | `"analysis/namespace.yaml"` | Path to namespace YAML, or a `Readable` of its contents |
| `connectionFile` | `FileInput` | No | `"connections.yaml"` | Path to connections file, or a `Readable` of its contents |
| `modelFile` | `FileInput` | No | `"model.yaml"` | Path to `model.yaml`, or a `Readable` of its contents |
| `targetFile` | `FileOutput` | No | `"notebook.ipynb"` | Output path for the notebook, or a `Writable` to receive it |
| `connectionName` | `string` | No | `"default"` | Connection name |
| `aliasesFile` | `FileInput` | No | | Optional aliases YAML path, or a `Readable` of its contents |

---

#### Testing / Query Processing

### `generateQueriesFromSML`

[↑ Table of Contents](#table-of-contents)

Reads an SML directory and generates XMLA (MDX) and SQL query JSON files for use with `executeAtScaleQueryHarness`.

```typescript
import { generateQueriesFromSML } from "@atscale-ps/ps-utils";

await generateQueriesFromSML({
  smlDir:         "./sml-output",
  xmlaOutputFile: "./queries/xmla.json",
  sqlOutputFile:  "./queries/sql.json",
});
```

```typescript
function generateQueriesFromSML(
  params: GenerateQueriesFromSMLParams,
  options?: LibraryOptions
): Promise<void>
```

| Key | Type | Required | Default | Description |
|---|---|---|---|---|
| `smlDir` | `DirInput` | Yes | | Path to SML directory, or a `Readable` ZIP archive of it |
| `xmlaOutputFile` | `FileOutput` | Yes | | Output path for XMLA query JSON, or a `Writable` to receive it |
| `sqlOutputFile` | `FileOutput` | Yes | | Output path for SQL query JSON, or a `Writable` to receive it |
| `modelName` | `string` | No | | Model name to use |
| `cubeName` | `string` | No | | Cube name to use |

---

### `generateQueriesFromModel`

[↑ Table of Contents](#table-of-contents)

Reads a `model.yaml` and generates XMLA (MDX) and SQL query JSON files.

```typescript
import { generateQueriesFromModel } from "@atscale-ps/ps-utils";

await generateQueriesFromModel({
  modelFile:      "./model.yaml",
  xmlaOutputFile: "./queries/xmla.json",
  sqlOutputFile:  "./queries/sql.json",
});
```

```typescript
function generateQueriesFromModel(
  params: GenerateQueriesFromModelParams,
  options?: LibraryOptions
): Promise<void>
```

| Key | Type | Required | Default | Description |
|---|---|---|---|---|
| `modelFile` | `FileInput` | Yes | | Path to `model.yaml`, or a `Readable` of its contents |
| `xmlaOutputFile` | `FileOutput` | Yes | | Output path for XMLA query JSON, or a `Writable` to receive it |
| `sqlOutputFile` | `FileOutput` | Yes | | Output path for SQL query JSON, or a `Writable` to receive it |
| `modelName` | `string` | No | | Model name to use |
| `cubeName` | `string` | No | | Cube name to use |

---

### `extractQueryStatsFromAtScale`

[↑ Table of Contents](#table-of-contents)

Paginates through AtScale's query history API and writes a CSV occurrence matrix showing attribute × measure query frequency.

```typescript
import { extractQueryStatsFromAtScale } from "@atscale-ps/ps-utils";

await extractQueryStatsFromAtScale({
  connectionFile: "connections.yaml",
  connectionName: "ats_prod",
  model:          "Sales",
});
```

```typescript
function extractQueryStatsFromAtScale(
  params: ExtractQueryStatsFromAtScaleParams,
  options?: LibraryOptions
): Promise<void>
```

| Key | Type | Required | Default | Description |
|---|---|---|---|---|
| `connectionFile` | `FileInput` | Yes | | Path to connections file, or a `Readable` of its contents |
| `connectionName` | `string` | Yes | | Connection name in the file |
| `model` | `string` | Yes | | AtScale model (cube) name to analyse |
| `outputDir` | `DirOutput` | No | `"."` | Output directory for CSV files, or a `Writable` to receive a ZIP |
| `windowDays` | `string` | No | `"30"` | Look-back window in days |
| `monthly` | `string` | No | `"false"` | Generate monthly breakdown CSV |
| `limit` | `string` | No | `"100"` | Page size for query history API |
| `numQueries` | `string` | No | `"10"` | Max sample query IDs per attribute × measure pair |
| `startDate` | `string` | No | | Explicit window start (ISO-8601); overrides `windowDays` |
| `endDate` | `string` | No | | Explicit window end (ISO-8601) |
| `monthlyYear` | `string` | No | | Calendar year for monthly breakdown |

---

### `extractQueriesFromAtScale`

[↑ Table of Contents](#table-of-contents)

Extracts historical queries from AtScale's Postgres backend and writes them as JSON files for use with the query harness.

```typescript
import { extractQueriesFromAtScale } from "@atscale-ps/ps-utils";

await extractQueriesFromAtScale({
  connectionFile: "connections.yaml",
});
```

```typescript
function extractQueriesFromAtScale(
  params: ExtractQueriesFromAtScaleParams,
  options?: LibraryOptions
): Promise<void>
```

| Key | Type | Required | Default | Description |
|---|---|---|---|---|
| `connectionFile` | `FileInput` | Yes | | Path to connections file, or a `Readable` of its contents |
| `connectionName` | `string` | No | `"default"` | Connection name |
| `days` | `string` | No | `"60"` | Look-back window in days |
| `outputDir` | `DirOutput` | No | `"queries"` | Output directory for JSON files, or a `Writable` to receive a ZIP |
| `protocol` | `string` | No | `"all"` | Protocol to extract: `sql`, `xmla`, or `all` |
| `minExecutions` | `string` | No | `"1"` | Exclude queries seen fewer than N times |
| `dbSchema` | `string` | No | `""` | Schema filter |
| `models` | `string` | No | | Model names to filter |

---

### `executeAtScaleQueryHarness`

[↑ Table of Contents](#table-of-contents)

Replays queries against an AtScale instance with configurable concurrency and writes results to CSV.

```typescript
import { executeAtScaleQueryHarness } from "@atscale-ps/ps-utils";

await executeAtScaleQueryHarness({
  connectionFile: "connections.yaml",
  connectionName: "ats_prod",
  queryFile:      "./queries/xmla.json",
});
```

```typescript
function executeAtScaleQueryHarness(
  params: ExecuteAtScaleQueryHarnessParams,
  options?: LibraryOptions
): Promise<void>
```

| Key | Type | Required | Default | Description |
|---|---|---|---|---|
| `connectionFile` | `FileInput` | Yes | | Path to connections file, or a `Readable` of its contents |
| `connectionName` | `string` | Yes | | Connection name |
| `protocol` | `string` | No | `"xmla"` | Query protocol: `xmla` or `sql` |
| `concurrentUsers` | `string` | No | `"1"` | Number of concurrent users |
| `throttleMs` | `string` | No | `"5"` | Milliseconds between requests |
| `outputDir` | `DirOutput` | No | `"run_results"` | Output directory for result CSVs, or a `Writable` to receive a ZIP |
| `redact` | `string` | No | `"false"` | Redact sensitive data |
| `durationMinutes` | `string` | No | `"0"` | Max run duration in minutes (0 = no limit) |
| `annotateQueries` | `string` | No | `"true"` | Add metadata annotations to results |
| `queryFile` | `FileInput` | No | | Path to query JSON file, or a `Readable` of its contents |
| `ingestFile` | `FileInput` | No | | Path to ingest file, or a `Readable` of its contents |
| `taskFile` | `FileInput` | No | | Path to task file, or a `Readable` of its contents |
| `runId` | `string` | No | | Run identifier |

---

### `executeQueryOnConnection`

[↑ Table of Contents](#table-of-contents)

Executes a single named query from a query JSON file against a connection and writes the result.

```typescript
import { executeQueryOnConnection } from "@atscale-ps/ps-utils";

await executeQueryOnConnection({
  connectionFile: "connections.yaml",
  connectionName: "ats_prod",
  queryFile:      "./queries/xmla.json",
  queryName:      "TotalRevenue",
  outputFile:     "./results/revenue.json",
});
```

```typescript
function executeQueryOnConnection(
  params: ExecuteQueryOnConnectionParams,
  options?: LibraryOptions
): Promise<void>
```

| Key | Type | Required | Default | Description |
|---|---|---|---|---|
| `connectionFile` | `FileInput` | Yes | | Path to connections file, or a `Readable` of its contents |
| `connectionName` | `string` | Yes | | Connection name |
| `queryFile` | `FileInput` | Yes | | Path to query JSON file, or a `Readable` of its contents |
| `queryName` | `string` | Yes | | Name of the query to execute |
| `outputFile` | `FileOutput` | Yes | | Output path for results, or a `Writable` to receive them |
| `protocol` | `string` | No | `"xmla"` | Query protocol: `xmla` or `sql` |

---

### `generateEnhancedQueryResults`

[↑ Table of Contents](#table-of-contents)

Joins a harness results CSV with AtScale query history to add execution metadata and produce an `_enhanced.csv`.

```typescript
import { generateEnhancedQueryResults } from "@atscale-ps/ps-utils";

await generateEnhancedQueryResults({
  resultsFile:    "./run_results/run1.csv",
  connectionFile: "connections.yaml",
  connectionName: "ats_prod",
});
```

```typescript
function generateEnhancedQueryResults(
  params: GenerateEnhancedQueryResultsParams,
  options?: LibraryOptions
): Promise<void>
```

| Key | Type | Required | Default | Description |
|---|---|---|---|---|
| `resultsFile` | `FileInput` | Yes | | Path to harness results CSV, or a `Readable` of its contents |
| `connectionFile` | `FileInput` | Yes | | Path to connections file, or a `Readable` of its contents |
| `connectionName` | `string` | Yes | | Connection name |
| `dbSchema` | `string` | No | `""` | Schema filter |
| `days` | `string` | No | `"7"` | Look-back window in days |
| `outputFile` | `FileOutput` | No | | Output path for enhanced CSV, or a `Writable` to receive it |
| `targetConnectionName` | `string` | No | | Target connection name |

---

### `executeRunAnalysis`

[↑ Table of Contents](#table-of-contents)

Compares two harness run result CSVs and outputs a summary, row-by-row comparison, and outliers report.

```typescript
import { executeRunAnalysis } from "@atscale-ps/ps-utils";

await executeRunAnalysis({
  fileA:          "./run_results/run1.csv",
  fileB:          "./run_results/run2.csv",
  summaryFile:    "./analysis/summary.txt",
  comparisonFile: "./analysis/comparison.csv",
  outliersFile:   "./analysis/outliers.csv",
});
```

```typescript
function executeRunAnalysis(
  params: ExecuteRunAnalysisParams,
  options?: LibraryOptions
): Promise<void>
```

| Key | Type | Required | Default | Description |
|---|---|---|---|---|
| `fileA` | `FileInput` | Yes | | First run results CSV path, or a `Readable` of its contents |
| `fileB` | `FileInput` | Yes | | Second run results CSV path, or a `Readable` of its contents |
| `summaryFile` | `FileOutput` | Yes | | Output path for plain-text summary, or a `Writable` to receive it |
| `comparisonFile` | `FileOutput` | Yes | | Output path for row-by-row comparison CSV, or a `Writable` to receive it |
| `outliersFile` | `FileOutput` | Yes | | Output path for outliers CSV, or a `Writable` to receive it |
| `joinKey` | `string` | No | `"original_text_hash"` | Column used to join the two runs |
| `durationVariancePct` | `string` | No | `"20"` | Duration variance threshold % |

---

#### AtScale Config

### `generateAtScaleInstallYaml`

[↑ Table of Contents](#table-of-contents)

Generates a Helm `values.yaml` for installing AtScale on Kubernetes.

```typescript
import { generateAtScaleInstallYaml } from "@atscale-ps/ps-utils";

await generateAtScaleInstallYaml({
  hostname: "atscale.example.com",
});
```

```typescript
function generateAtScaleInstallYaml(
  params: GenerateAtScaleInstallYamlParams,
  options?: LibraryOptions
): Promise<void>
```

| Key | Type | Required | Default | Description |
|---|---|---|---|---|
| `hostname` | `string` | Yes | | AtScale hostname |
| `outputFile` | `FileOutput` | No | `"values.yaml"` | Output path for Helm values, or a `Writable` to receive it |
| `enableMcp` | `boolean` | No | `false` | Enable the MCP server |
| `minimal` | `boolean` | No | `false` | Generate minimal configuration |
| `externalPostgres` | `boolean` | No | `false` | Wire AtScale to an externally-managed PostgreSQL instance instead of the bundled `db` sub-chart: disables the in-cluster database (`global.atscale.db.enabled=false`, `db.enabled=false`) and sets each service's `externalDatabase` block to read from Kubernetes secrets. Credentials are not taken as inputs — stubbed secret manifests are emitted as a header comment for the operator to fill in and apply. Keycloak is pinned to a dedicated `keycloak` Postgres schema (`KC_DB_SCHEMA`) rather than `public`; the operator must create that schema before install (a `CREATE SCHEMA` statement is included in the emitted header comment). |
| `gatekeeperCompliant` | `boolean` | No | `false` | Emit values satisfying common OPA Gatekeeper constraints (`image.pullPolicy=Always`, `serviceAccount.create=true`, and resource requests/limits via `global.resourcesPreset` — `poc` with `minimal`, else `prod`). Residual constraints needing a namespace exemption are listed in a header comment in the output. |
| `certFile` | `FileInput` | No | | TLS certificate file path, or a `Readable` of its contents |
| `keyFile` | `FileInput` | No | | TLS key file path, or a `Readable` of its contents |
| `licenseKey` | `string` | No | | License key |

---

### `atScaleListDataSources`

[↑ Table of Contents](#table-of-contents)

Lists data sources (data warehouses) registered in an AtScale instance.

```typescript
import { atScaleListDataSources } from "@atscale-ps/ps-utils";

await atScaleListDataSources({
  atscaleConnectionName: "ats_prod",
});
```

```typescript
function atScaleListDataSources(
  params: AtScaleListDataSourcesParams,
  options?: LibraryOptions
): Promise<void>
```

| Key | Type | Required | Default | Description |
|---|---|---|---|---|
| `atscaleConnectionName` | `string` | Yes | | AtScale connection entry (must have an `atscale:` block) |
| `connectionFile` | `FileInput` | No | `"connections.yaml"` | Path to connections file, or a `Readable` of its contents |
| `insecure` | `boolean` | No | | Skip TLS certificate verification |

---

### `atScaleCreateDataSource`

[↑ Table of Contents](#table-of-contents)

Registers a SQL connection as a data source (data warehouse) in an AtScale instance.

```typescript
import { atScaleCreateDataSource } from "@atscale-ps/ps-utils";

await atScaleCreateDataSource({
  atscaleConnectionName: "ats_prod",
  newConnectionName:     "snow_prod",
  aggregateSchema:       "AGG_SCHEMA",
});
```

```typescript
function atScaleCreateDataSource(
  params: AtScaleCreateDataSourceParams,
  options?: LibraryOptions
): Promise<void>
```

| Key | Type | Required | Default | Description |
|---|---|---|---|---|
| `atscaleConnectionName` | `string` | Yes | | AtScale connection entry (must have an `atscale:` block) |
| `newConnectionName` | `string` | Yes | | SQL connection to register (must have a `sql:` block) |
| `aggregateSchema` | `string` | Yes | | Schema for aggregate table storage |
| `connectionFile` | `FileInput` | No | `"connections.yaml"` | Path to connections file, or a `Readable` of its contents |
| `accessUsers` | `string` | No | `""` | Comma-separated AtScale usernames; empty grants access to `everyone` |
| `name` | `string` | No | | Display name (defaults to `newConnectionName`) |
| `connectionId` | `string` | No | | Logical connection ID embedded in SML (defaults to `newConnectionName`) |
| `aggregateProjectId` | `string` | No | | BigQuery only: GCP project for aggregate storage |
| `insecure` | `boolean` | No | | Skip TLS certificate verification |

---

### `atScaleListRepos`

[↑ Table of Contents](#table-of-contents)

Lists git repositories registered in an AtScale instance.

```typescript
import { atScaleListRepos } from "@atscale-ps/ps-utils";

await atScaleListRepos({
  atscaleConnectionName: "ats_prod",
});
```

```typescript
function atScaleListRepos(
  params: AtScaleListReposParams,
  options?: LibraryOptions
): Promise<void>
```

| Key | Type | Required | Default | Description |
|---|---|---|---|---|
| `atscaleConnectionName` | `string` | Yes | | AtScale connection entry |
| `connectionFile` | `FileInput` | No | `"connections.yaml"` | Path to connections file, or a `Readable` of its contents |
| `insecure` | `boolean` | No | | Skip TLS certificate verification |

---

### `atScaleCreateRepo`

[↑ Table of Contents](#table-of-contents)

Registers a git repository in an AtScale instance.

```typescript
import { atScaleCreateRepo } from "@atscale-ps/ps-utils";

await atScaleCreateRepo({
  atscaleConnectionName: "ats_prod",
  name:                  "my-sml-repo",
  url:                   "https://github.com/org/repo.git",
});
```

```typescript
function atScaleCreateRepo(
  params: AtScaleCreateRepoParams,
  options?: LibraryOptions
): Promise<void>
```

| Key | Type | Required | Default | Description |
|---|---|---|---|---|
| `atscaleConnectionName` | `string` | Yes | | AtScale connection entry |
| `name` | `string` | Yes | | Repository display name |
| `url` | `string` | Yes | | Git remote URL (HTTPS or SSH) |
| `connectionFile` | `FileInput` | No | `"connections.yaml"` | Path to connections file, or a `Readable` of its contents |
| `type` | `string` | No | `"catalog"` | Repository type: `catalog` or `global_settings` |
| `visibleBranchesPattern` | `string` | No | | Glob pattern for visible branches |
| `defaultBranch` | `string` | No | | Default branch name |
| `insecure` | `boolean` | No | | Skip TLS certificate verification |

---

### `atScaleListDeployments`

[↑ Table of Contents](#table-of-contents)

Lists deployed catalogs (semantic models) in an AtScale instance.

```typescript
import { atScaleListDeployments } from "@atscale-ps/ps-utils";

await atScaleListDeployments({
  atscaleConnectionName: "ats_prod",
});
```

```typescript
function atScaleListDeployments(
  params: AtScaleListDeploymentsParams,
  options?: LibraryOptions
): Promise<void>
```

| Key | Type | Required | Default | Description |
|---|---|---|---|---|
| `atscaleConnectionName` | `string` | Yes | | AtScale connection entry |
| `connectionFile` | `FileInput` | No | `"connections.yaml"` | Path to connections file, or a `Readable` of its contents |
| `insecure` | `boolean` | No | | Skip TLS certificate verification |

---

### `atScaleDeployCatalog`

[↑ Table of Contents](#table-of-contents)

Deploys local SML files to an AtScale git repository and publishes the catalog.

```typescript
import { atScaleDeployCatalog } from "@atscale-ps/ps-utils";

await atScaleDeployCatalog({
  atscaleConnectionName: "ats_prod",
  smlDir:                "./sml-output",
  repoName:              "my-sml-repo",
});
```

```typescript
function atScaleDeployCatalog(
  params: AtScaleDeployCatalogParams,
  options?: LibraryOptions
): Promise<void>
```

| Key | Type | Required | Default | Description |
|---|---|---|---|---|
| `atscaleConnectionName` | `string` | Yes | | AtScale connection entry |
| `smlDir` | `DirInput` | Yes | | Path to directory containing SML files, or a `Readable` ZIP archive |
| `connectionFile` | `FileInput` | No | `"connections.yaml"` | Path to connections file, or a `Readable` of its contents |
| `repoId` | `string` | No | | Repository UUID (from `atScaleListRepos`); either this or `repoName` is required |
| `repoName` | `string` | No | | Repository name; used to look up `repoId` |
| `projectName` | `string` | No | | Catalog project name to deploy as |
| `tableauServers` | `string` | No | | JSON array of Tableau servers to publish to |
| `insecure` | `boolean` | No | | Skip TLS certificate verification |

---

### `atScaleListModelErrors`

[↑ Table of Contents](#table-of-contents)

Validates an SML model and lists structural and engine-level errors. Accepts a local SML directory or a connected git repository.

```typescript
import { atScaleListModelErrors } from "@atscale-ps/ps-utils";

await atScaleListModelErrors({
  atscaleConnectionName: "ats_prod",
  smlDir:                "./sml-output",
});
```

```typescript
function atScaleListModelErrors(
  params: AtScaleListModelErrorsParams,
  options?: LibraryOptions
): Promise<void>
```

| Key | Type | Required | Default | Description |
|---|---|---|---|---|
| `atscaleConnectionName` | `string` | Yes | | AtScale connection entry |
| `connectionFile` | `FileInput` | No | `"connections.yaml"` | Path to connections file, or a `Readable` of its contents |
| `smlDir` | `DirInput` | No | | Local SML directory path or `Readable` ZIP (mutually exclusive with `repoName`/`repoId`) |
| `repoName` | `string` | No | | Connected git repository name (mutually exclusive with `smlDir`) |
| `repoId` | `string` | No | | Connected git repository UUID |
| `branch` | `string` | No | | Branch to validate (defaults to repository default branch) |
| `modelName` | `string` | No | | Model to validate (defaults to first model found) |
| `insecure` | `boolean` | No | | Skip TLS certificate verification |

---

### `getDsoCount`

[↑ Table of Contents](#table-of-contents)

Gests the unique and total DSO count for the specified model or catalog or entire system if none specified.

```typescript
import { getDsoCount } from "@atscale-ps/ps-utils";

await getDsoCount({
  connectionFile:   "connections.yaml",
  connectionName:   "ats_prod",
  catalog:            "Sales",
  model:          "Sales",
});
```

```typescript
function getDsoCount(
  params: GetDsoCountParams,
  options?: LibraryOptions
): Promise<void>
```

| Key | Type | Required | Default | Description |
|---|---|---|---|---|
| `connectionName` | `string` | Yes | | AtScale connection entry |
| `connectionFile` | `FileInput` | No | `"connections.yaml"` | Path to connections file, or a `Readable` of its contents |
| `catalog` | No | all available catalogs | Count only models from the specified catalog |
| `model` | No | all available models | Count only the specified model |

---

#### Web Services

### `executeWebServices`

[↑ Table of Contents](#table-of-contents)

Starts an HTTP server that exposes all operations as GraphQL mutations and REST endpoints. Returns a `Promise` that **never resolves** under normal operation — kill the process to stop.

```typescript
import { executeWebServices } from "@atscale-ps/ps-utils";

// This call does not return until the process is killed.
await executeWebServices({ port: 4000 });
```

```typescript
function executeWebServices(
  params?: ExecuteWebServicesParams,
  options?: LibraryOptions
): Promise<void>
```

| Key | Type | Required | Default | Description |
|---|---|---|---|---|
| `port` | `number` | No | `4000` | Port to listen on |
| `host` | `string` | No | `"localhost"` | Bind address |

---

#### Utilities

### `version`

[↑ Table of Contents](#table-of-contents)

Prints the installed package name and version to stdout.

```typescript
import { version } from "@atscale-ps/ps-utils";

await version();
```

```typescript
function version(
  params?: VersionParams,
  options?: LibraryOptions
): Promise<void>
```

This operation takes no parameters.
