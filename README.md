# AtScale PS Template CLI

CLI tool for extracting AtScale models, generating SML semantic models, and generating BI workbooks (Tableau, Excel, Power BI).

Upcoming features:
- Google Sheets
- Rudy's aggregate util
- Perspectives
- -- apply plan should show command
- graphql output not going to output
- web interface better + REST
- tableau, mstr, ssas conversion
  - find Hive dialect in a workbook
  


### Model Extraction

Connect to a live AtScale instance or read local SML files to produce a portable model.yaml capturing all metrics and dimension hierarchies.

```mermaid
flowchart LR
    ATS["AtScale Instance"] --> A["extract-model-from-atscale"] --> MODEL["model.yaml"]
    SML["SML Files"] --> B["extract-model-from-sml"] --> MODEL
```


### SML Creation and Manipulation

Generate a complete AtScale SML semantic model from a live database connection or a DDL file, extract existing schema DDL for inspection, or run ad-hoc SQL against any registered connection, or run the analysis-suggestions engine against an extracted model to surface the highest-value metric combinations.

```mermaid
flowchart LR
    DB[("Database")] --> A["extract-ddl-from-connection"] --> DDL["DDL (.sql)"]
    ATS["AtScale Instance"] --> B["generate-ddl-from-atscale"] --> DDL
    DDL --> C["generate-sml-from-ddl"] --> SML["SML Files"]
    DB --> D["generate-sml-from-connection"] --> SML
    XML["AtScale XML"] --> G["generate-sml-from-xml"] --> SML
    SML2A["SML Dir A"] --> H["generate-shared-model-plan"] --> PLAN["RECOMMENDATION.md + option-N.yml"]
    SML2B["SML Dir B"] --> H
    PLAN --> I["apply-shared-model-plan-option"] --> SHARED["shared/dimensions, datasets, models"]
    DB --> E["execute-sql-on-connection"] --> OUT["Results (stdout)"]
    MODEL["model.yaml"] --> F["generate-metrics-from-model"] --> METRICS["metrics/*.yml"]
```

### Synthetic Data Generation

Profile an existing database's schema and value distributions, then generate matching synthetic DDL and CSV data — either written to local files or loaded directly into a target database.

```mermaid
flowchart LR
    DB[("Source Database")] --> A["extract-data-shape-from-connection"] --> SHAPE["data-shape.json"]
    SHAPE --> B["generate-ddl-from-data-shape"] --> DDL["DDL (.sql)"]
    SHAPE --> C["generate-data-from-data-shape"] --> CSV["Synthetic CSVs"]
    SHAPE --> D["generate-data-from-data-shape-to-connection"] --> TARGET[("Target Database")]
```

### Visualization and Namespace Processing

Generate a namespace definition from a model, then produce ready-to-open Tableau, Excel, and Power BI workbooks with optional field-label aliases.

```mermaid
flowchart LR
    MODEL["model.yaml"] --> A["generate-namespace-from-model"] --> NS["namespace.yaml"]
    NS --> B["generate-tableau-from-namespace"] --> TWB["tableau.twb"]
    NS --> C["generate-excel-from-namespace"] --> XLSX["workbook.xlsx"]
    NS --> D["generate-powerbi-from-namespace"] --> PBI["output/powerbi/"]
    CONN["connections.yaml"] --> B & C & D
    ALIASES["aliases.yaml (opt.)"] -.-> B & C & D
```

### Testing / Query Processing

Capture queries from AtScale's Postgres backend, replay them through a load harness, enrich results with execution metadata, and compare two runs side-by-side to detect regressions in row counts, duration, or error behavior.

```mermaid
flowchart TD
    SML["SML Files"] --> G["generate-queries-from-sml"] --> QJSON["queries/*.json"]
    MODEL["model.yaml"] --> H["generate-queries-from-model"] --> QJSON
    ATSDB[("AtScale Postgres")] --> A["extract-query-stats-from-atscale"] --> STATS["occurrences.csv"]
    ATSDB --> B["extract-queries-from-atscale"] --> QJSON
    QJSON --> C["execute-atscale-query-harness"] --> RUN["run_results/*.csv"]
    ATS["AtScale Instance"] --> C
    CONN["connections.yaml"] --> D["execute-query-on-connection"] --> QOUT["Query Output"]
    RUN --> E["generate-enhanced-query-results"] --> ECSV["*_enhanced.csv"]
    ATSDB --> E
    RUN --> F["execute-run-analysis"]
    ECSV --> F
    F --> SUMMARY["summary.txt"]
    F --> COMPARISON["comparison.csv"]
    F --> OUTLIERS["outliers.csv"]
```

### Web Services

Expose every operation as a GraphQL mutation and REST endpoint via an embedded HTTP server.

```mermaid
flowchart LR
    CLIENT["HTTP Client"] --> A["execute-web-services"] --> OPS["All Operations (GraphQL / REST)"]
```

### Utilities

```mermaid
flowchart LR
    A["version"] --> VER["@atscale/ps-utils@x.y.z (stdout)"]
```

### AtScale Config

Bootstrap and manage an AtScale instance — generate Helm install values, register data sources and SML repositories, deploy catalogs, and inspect live configuration state.

```mermaid
flowchart LR
    HOSTNAME["Hostname"] --> A["generate-atscale-install-yaml"] --> VALUES["values.yaml (Helm)"]
    CONN["connections.yaml"] --> B["atscale-create-data-source"] --> ATS["AtScale Instance"]
    CONN --> C["atscale-create-repo"] --> ATS
    CONN --> D["atscale-deploy-catalog"] --> ATS
    ATS --> E["atscale-list-data-sources"] --> INFO["AtScale Info (stdout)"]
    ATS --> F["atscale-list-repos"] --> INFO
    ATS --> G["atscale-list-deployments"] --> INFO
    ATS --> H["atscale-list-model-errors"] --> INFO
```

## Table of Contents

- [Setup](#setup)
- [Operations](#operations)
  - Model Extraction
    - [`extract-model-from-atscale`](#extract-model-from-atscale)
    - [`extract-model-from-sml`](#extract-model-from-sml)
  - SML Creation and Manipulation
    - [`execute-sql-on-connection`](#execute-sql-on-connection)
    - [`extract-ddl-from-connection`](#extract-ddl-from-connection)
    - [`generate-sml-from-connection`](#generate-sml-from-connection)
    - [`generate-sml-from-ddl`](#generate-sml-from-ddl)
    - [`generate-sml-from-xml`](#generate-sml-from-xml)
    - [`generate-shared-model-plan`](#generate-shared-model-plan)
    - [`apply-shared-model-plan-option`](#apply-shared-model-plan-option)
    - [`generate-ddl-from-atscale`](#generate-ddl-from-atscale)
    - [`generate-metrics-from-model`](#generate-metrics-from-model)
  - Synthetic Data Generation
    - [`extract-data-shape-from-connection`](#extract-data-shape-from-connection)
    - [`generate-ddl-from-data-shape`](#generate-ddl-from-data-shape)
    - [`generate-data-from-data-shape`](#generate-data-from-data-shape)
    - [`generate-data-from-data-shape-to-connection`](#generate-data-from-data-shape-to-connection)
  - Visualization and Namespace Processing
    - [BI Tool Feature Comparison](#bi-tool-feature-comparison)
    - [`generate-namespace-from-model`](#generate-namespace-from-model)
    - [`generate-tableau-from-namespace`](#generate-tableau-from-namespace)
    - [`generate-excel-from-namespace`](#generate-excel-from-namespace)
    - [`generate-powerbi-from-namespace`](#generate-powerbi-from-namespace)
  - Testing / Query Processing
    - [`generate-queries-from-sml`](#generate-queries-from-sml)
    - [`generate-queries-from-model`](#generate-queries-from-model)
    - [`extract-query-stats-from-atscale`](#extract-query-stats-from-atscale)
    - [`extract-queries-from-atscale`](#extract-queries-from-atscale)
    - [`execute-atscale-query-harness`](#execute-atscale-query-harness)
    - [`execute-query-on-connection`](#execute-query-on-connection)
    - [`generate-enhanced-query-results`](#generate-enhanced-query-results)
    - [`execute-run-analysis`](#execute-run-analysis)
  - AtScale Config
    - [`generate-atscale-install-yaml`](#generate-atscale-install-yaml)
    - [`atscale-list-data-sources`](#atscale-list-data-sources)
    - [`atscale-create-data-source`](#atscale-create-data-source)
    - [`atscale-list-repos`](#atscale-list-repos)
    - [`atscale-create-repo`](#atscale-create-repo)
    - [`atscale-list-deployments`](#atscale-list-deployments)
    - [`atscale-deploy-catalog`](#atscale-deploy-catalog)
    - [`atscale-list-model-errors`](#atscale-list-model-errors)
  - Web Services
    - [`execute-web-services`](#execute-web-services)
  - Utilities
    - [`version`](#version)
- [Reference Documentation](#reference-documentation)
- [Extract AtScale Model Workflow](#extract-atscale-model-workflow)
- [Connection YAML (`connections.yaml`)](#connection-yaml-connectionsyaml)
- [SML Style Config (`sml.style.yaml`)](#sml-style-config-smlstyleyaml)
- [Model YAML (`model.yaml`)](#model-yaml-modelyaml)
- [Namespace YAML (`namespace.yaml`)](#namespace-yaml-namespaceyaml)
- [Aliases YAML (`aliases.yaml`)](#aliases-yaml-aliasesyaml)

---

## Setup

**Prerequisites:**

- Node.js 18+
- **macOS only:** Xcode Command Line Tools (required for native module compilation):
  ```bash
  xcode-select --install
  brew install npm 
  brew install tsc
  ```

**Install globally from npm:**
```bash
sudo npm install -g @atscale/ps-utils
```

**Build from source:**
```bash
npm install
npm run build
```

## Reference Documentation

The `docs/` directory contains extended reference material:

| File | Description |
|------|-------------|
| [docs/ACTIONS.md](docs/ACTIONS.md) | GitHub Actions guide — run any operation as a composite workflow step |
| [docs/NODE.md](docs/NODE.md) | Node.js library API reference — typed `async` functions for every operation |
| [docs/GRAPHQL.md](docs/GRAPHQL.md) | GraphQL API reference for the web services server (auto-generated) |
| [docs/REST.md](docs/REST.md) | REST API reference for the web services server (auto-generated) |
| [docs/DEVELOPER.md](docs/DEVELOPER.md) | Developer guide — CLI framework architecture and how to add new operations |
| [docs/CONVERSION.md](docs/CONVERSION.md) | Algorithm documentation for converting AtScale XML projects to SML |
| [docs/STATISTICS.md](docs/STATISTICS.md) | Statistical fingerprint algorithm used for synthetic data generation |
| [docs/VERTICALS.md](docs/VERTICALS.md) | Pre-built DDL schemas and SML models for 15 industry verticals |

---

## Operations

### `extract-model-from-atscale`

[↑ Table of Contents](#table-of-contents)

Connects to a live AtScale instance via MDX and extracts a model's metrics and attributes into a `model.yaml` file. This file is the input for `generate-tableau-from-namespace`.

```bash
./atscale-utils extract-model-from-atscale \
  --model "Telemetry" \
  --connection-file "./connections.yaml" \
  --connection-name "ats_connection" \
  --output-model-file "./model.yaml"
```

| Parameter | Required | Default | Description |
|---|---|---|---|
| `--model` | Yes | | AtScale model/cube name |
| `--connection-file` | Yes | | Path to connections file |
| `--connection-name` | Yes | | Connection name in the file |
| `--output-model-file` | No | stdout | Output path for the model YAML |

**GitHub Actions workflow:** See [Extract AtScale Model Workflow](#extract-model-from-atscale-workflow).

---

### `extract-model-from-sml`

[↑ Table of Contents](#table-of-contents)

Reads a local SML directory (produced by `generate-sml-from-connection` or `generate-sml-from-ddl`) and outputs a `model.yaml` file in the same format as `extract-model-from-atscale`. Use this to generate a Tableau workbook without a live AtScale connection.

```bash
./atscale-utils extract-model-from-sml \
  --sml-dir "./sml-output" \
  --output-model-file "./model.yaml"
```

With optional overrides:

```bash
./atscale-utils extract-model-from-sml \
  --sml-dir "./sml-output" \
  --model-name "SalesModel" \
  --connection-name "snow_demo" \
  --output-model-file "./model.yaml"
```

| Parameter | Required | Default | Description |
|---|---|---|---|
| `--sml-dir` | Yes | | Path to the SML directory |
| `--model-name` | No | First model found | Model label or `unique_name` to extract |
| `--connection-name` | No | From connections file | Override the `data_source` in the output |
| `--output-model-file` | No | stdout | Output path for the model YAML |

---

### `execute-sql-on-connection`

[↑ Table of Contents](#table-of-contents)

Reads a SQL file, splits it into individual statements, and executes each one against a named database connection. Works with DDL (`CREATE TABLE`, `DROP TABLE`, `ALTER TABLE`, `CREATE VIEW`), DML (`INSERT`, `UPDATE`, `DELETE`), and mixed files.

```bash
./atscale-utils execute-sql-on-connection \
  --sql-file "./schema/migrations/001_init.sql" \
  --connection-file "./connections.yaml" \
  --connection-name "snow_demo"
```

Preview statements without running them:

```bash
./atscale-utils execute-sql-on-connection \
  --sql-file "./schema.sql" \
  --connection-name "snow_demo" \
  --dry-run true
```

Skip failed statements and continue:

```bash
./atscale-utils execute-sql-on-connection \
  --sql-file "./schema.sql" \
  --connection-name "snow_demo" \
  --on-error continue
```

| Parameter | Required | Default | Description |
|---|---|---|---|
| `--sql-file` | Yes | | Path to the SQL file to execute |
| `--connection-file` | No | `connections.yaml` | Path to connections file |
| `--connection-name` | Yes | | Connection name in the file |
| `--on-error` | No | `stop` | `stop` halts on first failure; `continue` logs errors and proceeds |
| `--dry-run` | No | | Pass `true` to print statements without executing them |

---

### `extract-ddl-from-connection`

[↑ Table of Contents](#table-of-contents)

Connects to a live database, reads schema metadata for each table in the target schema, and writes `CREATE TABLE` DDL statements to a file (or stdout). Useful for capturing schema snapshots, seeding DDL files for `generate-sml-from-ddl`, or comparing schema drift.

```bash
./atscale-utils extract-ddl-from-connection \
  --connection-file "./connections.yaml" \
  --connection-name "snow_demo" \
  --schema "PUBLIC" \
  --output-file "./schema.ddl"
```

Extract only specific tables or wildcard patterns:

```bash
./atscale-utils extract-ddl-from-connection \
  --connection-file "./connections.yaml" \
  --connection-name "snow_demo" \
  --schema "PUBLIC" \
  --tables "Dim*,FactInternetSales" \
  --output-file "./schema.ddl"
```

| Parameter | Required | Default | Description |
|---|---|---|---|
| `--connection-name` | Yes | | Connection name in the file |
| `--schema` | Yes | | Database schema to introspect |
| `--connection-file` | No | `connections.yaml` | Path to connections file |
| `--tables` | No | All tables | Comma-separated table names or wildcard patterns (`*` = any chars, `?` = one char). Matching is case-sensitive by default. |
| `--case-insensitive` | No | `false` | Match table names case-insensitively |
| `--output-file` | No | stdout | Output path for the DDL |

---

### `generate-sml-from-connection`

[↑ Table of Contents](#table-of-contents)

Connects to a live database, introspects its schema, runs semantic model inference, and writes a complete set of AtScale SML files to a directory.

**Inference engine capabilities:**
- **Composite keys** — tables with multi-column primary keys produce `key_columns` arrays in SML level attributes.
- **FK-based classification** — fact vs. dimension classification uses foreign key graph topology. Tables that only receive FKs (high in-degree) are classified as dimensions. Tables with FK references to multiple tables plus numeric payload columns are classified as facts.
- **Bridge / cross-reference tables** — junction tables with FKs to ≥2 tables and ≤1 payload column are automatically classified as shared dimensions (the AtScale pattern for bridge tables). A `[BRIDGE TABLE]` advisory is emitted in the model warnings.
- **Naming convention patterns** — prefix/suffix patterns take priority over structural heuristics: `dim_*` / `*_dim`, `fct_*` / `*_fct` / `fact_*` / `*_fact`, `lkp_*` / `ref_*` / `lookup_*`, `bridge_*` / `xref_*` / `junction_*` / `map_*`, etc.
- **`information_schema` FK queries** — foreign key metadata is read from `INFORMATION_SCHEMA.REFERENTIAL_CONSTRAINTS` and `KEY_COLUMN_USAGE` for accurate composite-key support. Falls back to the driver-level API when `information_schema` is not accessible (e.g. Snowflake).
- **One relationship per hierarchy** — when a dimension has multiple hierarchies, one model relationship is emitted per hierarchy leaf level so all hierarchies are visible in BI tools.
- **Distinct count estimate** — measures inferred as distinct-countable entities use `distinct count estimate` aggregation (preferred over `distinct count` for AtScale aggregation engine compatibility).

```bash
./atscale-utils generate-sml-from-connection \
  --connection-file "./connections.yaml" \
  --connection-name "ats_connection" \
  --model-name "Telemetry" \
  --output-dir "./sml-output"
```

With optional overrides:

```bash
./atscale-utils generate-sml-from-connection \
  --connection-file "./connections.yaml" \
  --connection-name "snow_demo" \
  --model-name "SalesModel" \
  --output-dir "./sml-output" \
  --schema "SALES" \
  --catalog-name "Sales Analytics" \
  --pii-severity "HIGH" \
  --sample-size 500 \
  --fact-tables "FactInternetSales,FactResellerSales" \
  --camel-case-files true \
  --camel-case-measures true
```

Style parameters (`--pii-severity`, `--fact-tables`, `--catalog-name`, `--camel-case-files`, `--camel-case-measures`, `--sample-size`, `--min-hierarchies-per-dim`, `--max-hierarchies-per-dim`) can also be set in an [SML style config file](#sml-style-config-smlstyleyaml). CLI flags take priority over the file. After generation, effective settings are always written to `<output-dir>/sml.style.yaml` regardless of the input config path.

| Parameter | Required | Default | Description |
|---|---|---|---|
| `--connection-file` | No | `connections.yaml` | Path to connections file |
| `--connection-name` | Yes | | Connection name in the file |
| `--model-name` | Yes | | Name for the generated semantic model |
| `--output-dir` | Yes | | Directory to write SML files |
| `--sml-config-file` | No | `sml.style.yaml` | Path to the [SML style config](#sml-style-config-smlstyleyaml) to read settings from |
| `--schema` | No | From connection config | Override the database schema to introspect |
| `--catalog-name` | No | `model-name` | Display name for the generated catalog |
| `--pii-severity` | No | `MEDIUM` | Minimum PII severity to exclude: `HIGH`, `MEDIUM`, `LOW`, or `none` |
| `--sample-size` | No | `250` | Rows to sample per table for type inference (`0` to disable) |
| `--fact-tables` | No | Auto-detected | Comma-separated table names to treat as facts, overriding automatic classification |
| `--camel-case-files` | No | `false` | When `true`, dataset and dimension filenames use camelCase of the source table name |
| `--camel-case-measures` | No | `false` | When `true`, metric labels use camelCase of the source column name |
| `--min-hierarchies-per-dim` | No | `1` | Minimum hierarchies a dimension must have to be included; dimensions with fewer are dropped |
| `--max-hierarchies-per-dim` | No | `4` | Maximum hierarchies kept per dimension; extras are truncated |

**Output layout:**

```
<output-dir>/
  catalog.yml
  connections/<connectionName>.yml
  datasets/<table>.yml
  dimensions/<dimension>.yml
  metrics/<metric>.yml
  models/<modelName>.yml
  sml.style.yaml   ← effective settings used for this generation
```

---

### `generate-sml-from-ddl`

[↑ Table of Contents](#table-of-contents)

Parses a SQL DDL file (`CREATE TABLE` / `CREATE VIEW` statements) and generates AtScale SML files without a live database connection. Useful for offline model generation and CI pipelines.

All inference capabilities described under `generate-sml-from-connection` (composite keys, bridge table detection, naming patterns, one-relationship-per-hierarchy) apply equally to the DDL path. FK constraints declared in the DDL (`FOREIGN KEY (col1, col2) REFERENCES …`) are parsed and used for composite join inference.

```bash
./atscale-utils generate-sml-from-ddl \
  --ddl-file "./schema.sql" \
  --output-dir "./sml-output"
```

With optional overrides:

```bash
./atscale-utils generate-sml-from-ddl \
  --ddl-file "./schema.sql" \
  --model-name "SalesModel" \
  --output-dir "./sml-output" \
  --connection-name "my_warehouse" \
  --catalog-name "Sales Analytics" \
  --schema "SALES" \
  --pii-severity "LOW" \
  --fact-tables "FactInternetSales,FactResellerSales" \
  --camel-case-files true \
  --camel-case-measures true
```

Style parameters (`--pii-severity`, `--fact-tables`, `--catalog-name`, `--camel-case-files`, `--camel-case-measures`, `--min-hierarchies-per-dim`, `--max-hierarchies-per-dim`) can also be set in an [SML style config file](#sml-style-config-smlstyleyaml). CLI flags take priority over the file. After generation, effective settings are always written to `<output-dir>/sml.style.yaml` regardless of the input config path.

| Parameter | Required | Default | Description |
|---|---|---|---|
| `--ddl-file` | Yes | | Path to the SQL DDL file |
| `--model-name` | No | DDL filename stem | Name for the generated semantic model |
| `--output-dir` | Yes | | Directory to write SML files |
| `--connection-name` | No | `my_connection` | Connection name to embed in SML files |
| `--sml-config-file` | No | `sml.style.yaml` | Path to the [SML style config](#sml-style-config-smlstyleyaml) to read settings from |
| `--catalog-name` | No | `model-name` | Display name for the generated catalog |
| `--schema` | No | | Filter DDL to only tables in this schema |
| `--database` | No | | Database name to embed in the SML connection file |
| `--dialect` | No | Auto-detected from filename | Database dialect (`snowflake`, `postgresql`). When `snowflake`, dataset table names are uppercased. |
| `--pii-severity` | No | `MEDIUM` | Minimum PII severity to exclude: `HIGH`, `MEDIUM`, `LOW`, or `none` |
| `--fact-tables` | No | Auto-detected | Comma-separated table names to treat as facts, overriding automatic classification |
| `--camel-case-files` | No | `false` | When `true`, dataset and dimension filenames use camelCase of the source table name |
| `--camel-case-measures` | No | `false` | When `true`, metric labels use camelCase of the source column name |
| `--min-hierarchies-per-dim` | No | `1` | Minimum hierarchies a dimension must have to be included; dimensions with fewer are dropped |
| `--max-hierarchies-per-dim` | No | `4` | Maximum hierarchies kept per dimension; extras are truncated |

**Output layout:** Same as `generate-sml-from-connection` (including `sml.style.yaml`).

---

### `generate-sml-from-xml`

[↑ Table of Contents](#table-of-contents)

Reads an AtScale XML project file (schema version `project_2_0`) and converts it to AtScale SML YAML files. No database connection is required — the conversion runs entirely from the XML model definition.

Dimensions, metrics, datasets, catalog, connection, and model files are all emitted based on the XML structure. Relationships are inferred from the cube's key-ref logical sections: cross-table FKs (`complete="false"`) are mapped to separate dimension datasets, and degenerate dimensions (`complete="true"`) are mapped as self-joins within the fact table. Role-played dimensions (`role_play`), `include_default_drillthrough`, metric folders, dataset column definitions, and the `immutable` flag are all extracted from the XML when present. The connection name is auto-detected from `<physical><connection id="...">` if `--connection-name` is not supplied. Schema-level dimensions that have no join path to the cube are omitted.

```bash
./atscale-utils generate-sml-from-xml \
  --xml-file "./MyModel.xml" \
  --output-dir "./sml-output"
```

With optional overrides:

```bash
./atscale-utils generate-sml-from-xml \
  --xml-file "./MyModel.xml" \
  --output-dir "./sml-output" \
  --connection-name "my_bq_conn" \
  --connection-type "bigquery" \
  --connection-db "my-project-id" \
  --connection-schema "my_dataset" \
  --catalog-name "My Catalog"
```

| Parameter | Required | Default | Description |
|---|---|---|---|
| `--xml-file` | Yes | | Path to the AtScale XML project file (`project_2_0` format) |
| `--output-dir` | Yes | | Directory to write SML files |
| `--connection-name` | No | Auto-detected from XML | Connection `unique_name` to embed in generated files |
| `--connection-type` | No | | Database dialect written to the connection file (e.g. `snowflake`, `bigquery`) |
| `--connection-db` | No | | Database/project name written to the connection file. When set, datasets use a plain table name instead of a nested `db`/`schema`/`name` object |
| `--connection-schema` | No | | Schema/dataset name written to the connection file. When set, datasets use a plain table name instead of a nested `db`/`schema`/`name` object |
| `--catalog-name` | No | XML schema name | Override the catalog label |

**Output layout:**
```
<output-dir>/
  catalog.yml
  connections/<connection-name>.yml
  datasets/<dataset-name>.yml      (one per XML <data-set>)
  dimensions/<dim-name>.yml        (one per referenced dimension)
  metrics/<metric-name>.yml        (one per measure or inline expression)
  calculations/<calc-name>.yml     (one per schema-level calculated member)
  models/<cube-name>.yml           (one per XML <cube>)
```

---

### `generate-shared-model-plan`

[↑ Table of Contents](#table-of-contents)

Analyses one or more SML output directories to identify opportunities for sharing or reusing dimensions, datasets, and model structures across projects. Uses Jaccard-based fuzzy subtree matching to compute similarity scores and emits a human-readable recommendation report plus machine-readable option YAML files.

Each option falls into one of three categories:

| Kind | What it does |
|------|-------------|
| `shared-dimension-library` | Extract near-identical dimensions from multiple projects into a shared library |
| `dataset-consolidation` | Merge datasets that reference the same physical table or share similar column sets |
| `base-model-extraction` | Factor out a common base model when two models share most dimensions and metrics |

```bash
./atscale-utils generate-shared-model-plan \
  --input-dirs "./project-a,./project-b" \
  --output-dir "./plan-output"
```

With threshold override:

```bash
./atscale-utils generate-shared-model-plan \
  --input-dirs "./project-a,./project-b,./project-c" \
  --output-dir "./plan-output" \
  --threshold 0.5
```

| Parameter | Required | Default | Description |
|---|---|---|---|
| `--input-dirs` | Yes | | Comma-separated list of SML output directories to analyse |
| `--output-dir` | Yes | | Directory where output files are written |
| `--threshold` | No | `0.5` | Similarity threshold 0–1; lower values surface more options |
| `--max-per-subject` | No | `3` | Maximum recommendations per subject entity (dataset, dimension, or model pair); prevents flooding output with near-duplicate options for the same entity |

**Output layout:**
```
<output-dir>/
  RECOMMENDATION.md              — options with diagrams, change lists, and pros/cons
  option-1-<kind>.yml            — machine-readable changes for option 1
  option-2-<kind>.yml            — machine-readable changes for option 2
  ...
```

---

### `apply-shared-model-plan-option`

[↑ Table of Contents](#table-of-contents)

Applies a machine-readable recommendation YAML produced by `generate-shared-model-plan` to create shared SML files. Three kinds are supported:

| Kind | What is written |
|------|----------------|
| `dataset-consolidation` | `<shared-dir>/datasets/<name>.yml` — merged column union of all source copies |
| `shared-dimension-library` | `<shared-dir>/dimensions/<name>.yml` — merged dimension preserving all SML attributes |
| `base-model-extraction` | `<shared-dir>/models/<base>.yml` — common core; slim models for any project-specific content |

```bash
./atscale-utils apply-shared-model-plan-option \
  --plan-file "./shared-plan/option-1-dataset-consolidation.yml" \
  --shared-dir "./shared"
```

To also delete the local source copies after writing the shared file:

```bash
./atscale-utils apply-shared-model-plan-option \
  --plan-file "./shared-plan/option-11-shared-dimension-library.yml" \
  --shared-dir "./shared" \
  --remove-sources
```

Preview without touching disk:

```bash
./atscale-utils apply-shared-model-plan-option \
  --plan-file "./shared-plan/option-31-base-model-extraction.yml" \
  --shared-dir "./shared" \
  --dry-run
```

| Parameter | Required | Default | Description |
|---|---|---|---|
| `--plan-file` | Yes | | Path to the option YAML file from `generate-shared-model-plan` |
| `--shared-dir` | Yes | | Base directory where shared files are written |
| `--remove-sources` | No | `false` | Delete local source copies after writing the shared version |
| `--dry-run` | No | `false` | Print all actions without writing or deleting any files |

An `APPLY_REPORT.md` is written to `<shared-dir>` summarising every action taken and the deployment steps required.

---

### `generate-ddl-from-atscale`

[↑ Table of Contents](#table-of-contents)

Generates DDL (`CREATE TABLE` statements) by reading table and column metadata from an AtScale data source via the REST API. No direct database connection is required — AtScale acts as the metadata broker.

```bash
./atscale-utils generate-ddl-from-atscale \
  --connection-file "./connections.yaml" \
  --atscale-connection-name "my_atscale" \
  --data-source-name "snowflake_prod" \
  --database "MY_DATABASE" \
  --schema "PUBLIC"
```

With optional filters and output file:

```bash
./atscale-utils generate-ddl-from-atscale \
  --connection-file "./connections.yaml" \
  --atscale-connection-name "my_atscale" \
  --data-source-name "snowflake_prod" \
  --database "MY_DATABASE" \
  --schema "PUBLIC" \
  --tables "fact_*,dim_*" \
  --output-file "./schema.ddl"
```

| Parameter | Required | Default | Description |
|---|---|---|---|
| `--atscale-connection-name` | Yes | | Name of the AtScale connection entry (must have an `atscale:` block) |
| `--data-source-name` | Yes | | Name of the data source as registered in AtScale (display name or `connectionId`) |
| `--database` | Yes | | Database (catalog) name |
| `--schema` | Yes | | Schema name |
| `--tables` | No | all tables | Comma-separated table names or glob patterns (`*`, `?`) — e.g. `"fact_*,dim_*"` |
| `--connection-file` | No | `connections.yaml` | Path to the connections file |
| `--output-file` | No | stdout | Output file path for the generated DDL |
| `--insecure` | No | `true` | Skip TLS certificate verification |

**Output:** One `CREATE TABLE` statement per matched table. Output includes a header comment with data source name, database, schema, and timestamp.

**Foreign keys:** The AtScale metadata API does not expose FK relationships. FK constraints are not included in the output; a header comment documents this. Use `extract-ddl-from-connection` if FK constraints are required.

---

### `generate-metrics-from-model`

[↑ Table of Contents](#table-of-contents)

Reads a `model.yaml` file, reconstructs a SemanticModel from its `mdx` and `sql` sections, and runs the analysis-suggestions engine to produce a ranked list of suggested metric × dimension combinations. Each suggestion includes a relevance score, analysis type, the measure being analysed, and the dimension hierarchy to slice by.

```bash
./atscale-utils generate-metrics-from-model \
  --model-file "./model.yaml"
```

With options:

```bash
./atscale-utils generate-metrics-from-model \
  --model-file "./model.yaml" \
  --model-name "SalesModel" \
  --max-suggestions 20 \
  --min-score 0.6 \
  --include-tuples true \
  --format yaml \
  --output-file "./suggestions.yaml"
```

The suggestion-tuning parameters (`--max-suggestions`, `--min-score`, `--include-tuples`) can also be set in an [SML style config file](#sml-style-config-smlstyleyaml). CLI flags take priority over the file. After generation, effective settings are written to `sml.style.yaml` in the output file's directory (or the working directory when writing to stdout).

| Parameter | Required | Default | Description |
|---|---|---|---|
| `--model-file` | Yes | | Path to the `model.yaml` file |
| `--model-name` | No | First model | Model name when `model.yaml` contains multiple models |
| `--sml-config-file` | No | `sml.style.yaml` | Path to the [SML style config](#sml-style-config-smlstyleyaml) to read settings from |
| `--max-suggestions` | No | `25` | Maximum number of suggestions to output |
| `--min-score` | No | `0.5` | Minimum relevance score `[0–1]` |
| `--include-tuples` | No | `true` | Include multi-dimension suggestions |
| `--format` | No | `text` | Output format: `text` or `yaml` |
| `--output-file` | No | stdout | File to write output to |

---

### `extract-data-shape-from-connection`

[↑ Table of Contents](#table-of-contents)

Connects to a live database, reads an SML model to understand the semantic layer structure, and extracts a statistical fingerprint of the data — capturing hierarchy level cardinalities, rollup ratios, leaf-level fact densities, measure distributions, and conformed dimension overlap.

No actual data values are written. The output is a YAML fingerprint file that fully describes the _statistical shape_ of the model without divulging any specific records. The file contains enough information to reconstruct plausible DDL and generate synthetic data that is statistically equivalent to the original.

Large fact tables are automatically sampled via `TABLESAMPLE SYSTEM` or a `LIMIT`-based fallback (see `--target-fact-rows` and `--no-tablesample`). Sample sizes are computed using the Cochran formula (z² × 0.25 / e²) with finite-population correction, guaranteeing statistical significance without reading the entire table.

```bash
./atscale-utils extract-data-shape-from-connection \
  --connection-file "./connections.yaml" \
  --connection-name "snow_demo" \
  --sml-path        "./sml-output" \
  --output-file     "./data-shape.yaml"
```

With sampling tuning:

```bash
./atscale-utils extract-data-shape-from-connection \
  --connection-file    "./connections.yaml" \
  --connection-name    "snow_demo" \
  --sml-path           "./sml-output" \
  --target-fact-rows   50000 \
  --target-column-rows 5000 \
  --no-tablesample          # use for MySQL / MariaDB
```

| Parameter | Required | Default | Description |
|---|---|---|---|
| `--connection-name` | Yes | | Connection name in the file |
| `--sml-path` | Yes | | Path to the SML output directory or a model.yml file |
| `--connection-file` | No | `connections.yaml` | Path to the connections file |
| `--output-file` | No | `data-shape.yaml` | Output path for the fingerprint YAML |
| `--target-fact-rows` | No | `100000` | Target row count when sampling large fact tables (0 = no sampling) |
| `--target-column-rows` | No | `10000` | Target row count for measure column distribution sampling (0 = no sampling) |
| `--tablesample` / `--no-tablesample` | No | `true` | Use `TABLESAMPLE SYSTEM` for fact sampling. Set `--no-tablesample` for databases that do not support it (e.g. MySQL) |

**Output:** A `data-shape.yaml` fingerprint file containing:
- Dimension hierarchy level cardinalities, null key fractions, and rollup ratios (P50/P95/shape)
- Leaf-level fact densities (avg/stddev/P50/P90/P99), coverage fraction, and cold-member fraction
- Measure distributions (null fraction, min/max/mean, percentiles, additivity classification)
- Pairwise conformed dimension overlap across facts (intersection/union fraction)

All entity names are replaced with opaque sequential IDs (`D1`, `D1.H1`, `D1.H1.L3`, `F1`, `F1.M2`). The mapping from original names to IDs is discarded at the end of each run.

See [STATISTICS.md](docs/STATISTICS.md) for the full algorithm description.

---

### `generate-ddl-from-data-shape`

[↑ Table of Contents](#table-of-contents)

Reads a `data-shape.yaml` fingerprint file produced by `extract-data-shape-from-connection` and emits `CREATE TABLE` DDL statements. No database connection is required.

Table and column names are synthetic — the original names are not stored in the fingerprint. The same fingerprint always produces identical DDL regardless of when it is run.

```bash
./atscale-utils generate-ddl-from-data-shape \
  --input-file "./data-shape.yaml" \
  --output-file "./schema.sql"
```

With dialect selection:

```bash
./atscale-utils generate-ddl-from-data-shape \
  --input-file  "./data-shape.yaml" \
  --dialect     snowflake \
  --output-file "./schema.sql"
```

| Parameter | Required | Default | Description |
|---|---|---|---|
| `--input-file` | No | `data-shape.yaml` | Path to the fingerprint YAML file |
| `--output-file` | No | stdout | Output path for the generated DDL |
| `--dialect` | No | `ansi` | SQL dialect: `ansi`, `postgresql`, `snowflake`, `mysql`, `bigquery` |

**Output:** One `CREATE TABLE` statement per dimension and fact. Dimension tables are emitted first so `FOREIGN KEY` references resolve correctly.

**Dialect notes:**
- `bigquery` — `PRIMARY KEY` and `FOREIGN KEY` constraints are omitted (not supported)
- `snowflake` — integer types are mapped to `NUMBER(n,0)`, decimals to `NUMBER(18,4)`
- All other dialects — standard ANSI SQL types (`SMALLINT`, `INTEGER`, `BIGINT`, `DECIMAL(18,4)`, `VARCHAR(200)`)

See [STATISTICS.md](docs/STATISTICS.md) §Phase 7 for the reconstruction algorithm.

---

### `generate-data-from-data-shape`

[↑ Table of Contents](#table-of-contents)

Reads a `data-shape.yaml` fingerprint file and generates statistically equivalent synthetic data, writing one CSV file per table to an output directory. No database connection is required.

```bash
./atscale-utils generate-data-from-data-shape \
  --input-file "./data-shape.yaml" \
  --output-dir "./data"
```

With a scale factor and reproducible seed:

```bash
./atscale-utils generate-data-from-data-shape \
  --input-file    "./data-shape.yaml" \
  --output-dir    "./data" \
  --scale-factor  0.01 \
  --seed          42
```

| Parameter | Required | Default | Description |
|---|---|---|---|
| `--input-file` | No | `data-shape.yaml` | Path to the fingerprint YAML file |
| `--output-dir` | No | `data` | Directory where CSV files are written |
| `--scale-factor` | No | `1.0` | Scale row and member counts (e.g. `0.01` = 1% of real size) |
| `--seed` | No | — | Integer random seed for reproducible output |

**Output:** One CSV per table — dimensions first, then facts. Column names match those produced by `generate-ddl-from-data-shape`.

See [STATISTICS.md](docs/STATISTICS.md) §Phase 8 for the generation algorithm.

---

### `generate-data-from-data-shape-to-connection`

[↑ Table of Contents](#table-of-contents)

End-to-end pipeline: reads a `data-shape.yaml` fingerprint, generates synthetic data in memory, and loads it directly into a live database. Combines `generate-data-from-data-shape` and `generate-ddl-from-data-shape` into a single step.

```bash
./atscale-utils generate-data-from-data-shape-to-connection \
  --connection-file "./connections.yaml" \
  --connection-name "snow_demo" \
  --input-file      "./data-shape.yaml" \
  --drop-if-exists  true \
  --create-tables   true \
  --dialect         snowflake
```

With scale factor and batch tuning:

```bash
./atscale-utils generate-data-from-data-shape-to-connection \
  --connection-file "./connections.yaml" \
  --connection-name "pg_sandbox" \
  --input-file      "./data-shape.yaml" \
  --scale-factor    0.1 \
  --seed            42 \
  --schema          PUBLIC \
  --batch-size      1000
```

| Parameter | Required | Default | Description |
|---|---|---|---|
| `--connection-file` | No | `connections.yaml` | Path to the connections YAML file |
| `--connection-name` | Yes | — | Name of the connection to use |
| `--input-file` | No | `data-shape.yaml` | Path to the fingerprint YAML file |
| `--scale-factor` | No | `1.0` | Scale row and member counts |
| `--seed` | No | — | Integer random seed for reproducible output |
| `--create-tables` | No | `false` | Emit `CREATE TABLE` before inserting |
| `--drop-if-exists` | No | `false` | `DROP TABLE IF EXISTS` before creating — implies `--create-tables` |
| `--dialect` | No | `ansi` | SQL dialect for `CREATE TABLE`: `ansi`, `postgresql`, `snowflake`, `mysql`, `bigquery` |
| `--batch-size` | No | `500` | Rows per `INSERT` statement |
| `--schema` | No | — | Schema prefix to qualify table names (e.g. `PUBLIC`) |

**Operation order:** DROP facts → DROP dims → CREATE dims → CREATE facts → INSERT dims → INSERT facts. This order respects FK constraints throughout.

See [STATISTICS.md](docs/STATISTICS.md) §Phase 8 for the generation algorithm.

---

### BI Tool Feature Comparison

| Feature | Tableau Desktop | Power BI Desktop | Excel | Jupyter | Sheets |
|---|---|---|---|---|---|
| Text Output | Yes | Yes | Yes | — | — |
| Bar Chart | Yes | Yes | — | — | — |
| &nbsp;&nbsp; Ticks as color | Yes | | — | — | — |
| &nbsp;&nbsp; Filter Nulls | Yes | | — | — | — |
| &nbsp;&nbsp; Sort Categories | Yes | | — | — | — |
| Line Chart | Yes | Yes | Yes | — | — |
| &nbsp;&nbsp; Ticks as color | Yes | | — | — | — |
| Text / KPI | Yes | Yes | Yes | — | — |
| &nbsp;&nbsp; Format Options | — | — | Yes | — | — |
| &nbsp;&nbsp; Number Format | — | — | Yes | — | — |
| OLAP Pivot Table | — | — | Yes | — | — |
| xAxisGranularity | — | — | Yes | — | — |
| Column Chart | — | Yes | — | — | — |

---

### `generate-namespace-from-model`

[↑ Table of Contents](#table-of-contents)

Reads a `model.yaml` file and automatically generates a namespace YAML by running the analysis-suggestions engine against the model's measures and dimensions. The output is ready to pass directly to `generate-tableau-from-namespace` or `generate-excel-from-namespace`.

Each suggestion becomes a worksheet:
- **trend** → `graphType: line` (measure over time, title suffixed with granularity e.g. "by Week")
- **comparison** → `graphType: line` with `colorField` (measure over time, broken down by a second dimension)
- **breakdown / distribution** → `graphType: bar`
- **ranking** → `graphType: bar` with `limit: 10` and `sortDirection: desc`

Up to six summary-statistic scorecards (`graphType: text`) are prepended automatically. All worksheets are arranged in a single auto-sized dashboard. Time-based line charts include an `xAxisGranularity` field (`"day"` for `DATE_DOUBLE` columns, `"week"` for `DATETIME` columns).

```bash
./atscale-utils generate-namespace-from-model \
  --model-file "./model.yaml" \
  --output-file "./namespace.yaml"
```

With optional overrides:

```bash
./atscale-utils generate-namespace-from-model \
  --model-file "./model.yaml" \
  --model-name "SalesModel" \
  --title "Sales Analytics" \
  --max-suggestions 20 \
  --min-score 0.6 \
  --output-file "./namespace.yaml"
```

| Parameter | Required | Default | Description |
|---|---|---|---|
| `--model-file` | Yes | | Path to the `model.yaml` file |
| `--model-name` | No | First model | Model name when `model.yaml` contains multiple models |
| `--title` | No | `<ModelName> Analysis` | Workbook title written into the namespace |
| `--max-suggestions` | No | `25` | Maximum number of analysis suggestions to generate |
| `--min-score` | No | `0.5` | Minimum relevance score `[0–1]` for a suggestion to be included |
| `--output-file` | No | stdout | Output path for the namespace YAML |

---

### `generate-tableau-from-namespace`

[↑ Table of Contents](#table-of-contents)

Generates a Tableau `.twb` workbook from a namespace YAML definition and a model YAML file.

```bash
./atscale-utils generate-tableau-from-namespace \
  --namespace-file "./resources/namespaces/telemetry/overview.yaml" \
  --model-file "./model.yaml" \
  --connection-file "./connections.yaml" \
  --connection-name "ats_connection" \
  --tableau-version 2025 \
  --target-file "./tableau.twb"
```

With an aliases file:

```bash
./atscale-utils generate-tableau-from-namespace \
  --namespace-file "./namespace.yaml" \
  --model-file "./model.yaml" \
  --connection-file "./connections.yaml" \
  --connection-name "ats_connection" \
  --aliases-file "./aliases.yaml" \
  --target-file "./tableau.twb"
```

| Parameter | Required | Default | Description |
|---|---|---|---|
| `--namespace-file` | No | `analysis/namespace.yaml` | Path to the namespace YAML |
| `--model-file` | No | `model.yaml` | Path to the model YAML |
| `--connection-file` | No | `connections.yaml` | Path to the connections file |
| `--connection-name` | No | `default` | Connection name in the file |
| `--aliases-file` | No | | Path to an optional aliases YAML (see [Aliases YAML](#aliases-yaml-aliasesyaml)) |
| `--tableau-version` | No | `2025` | Target Tableau version: `2025` or `2024` |
| `--target-file` | No | `tableau.twb` | Output path for the generated workbook |

See [Namespace YAML](#namespace-yaml-namespaceyaml) for the full namespace format reference.

---

### `generate-excel-from-namespace`

[↑ Table of Contents](#table-of-contents)

Generates an Excel workbook (`.xlsx`) from a namespace YAML and a model YAML. No external dependencies beyond the npm packages.

Each dashboard in the namespace produces one visible sheet containing:
- One **chart** per tile (`bar`, `line`, `pie`, or `area`) styled from the worksheet `graphType`
- **CUBE formula data sections** in far-right columns of the dashboard sheet — Excel evaluates these against AtScale via MDX/XMLA when the workbook is connected
- An **OLAP pivot table** on the hidden `_Connections` sheet — click **Data → Refresh All** in Excel to load live data
- **Number formatting** applied from the worksheet `format` field (`integer`, `decimal:N`, `percent:N`, `currency:N`)
- **Granularity-aware set expressions** for time axes when `xAxisGranularity` is set and the model hierarchy has a matching level

```bash
./atscale-utils generate-excel-from-namespace \
  --namespace-file "analysis/namespace.yaml" \
  --model-file     "model.yaml" \
  --connection-file "connections.yaml" \
  --connection-name "ats_connection" \
  --target-file    "analysis/workbook.xlsx"
```

With an aliases file:

```bash
./atscale-utils generate-excel-from-namespace \
  --namespace-file "analysis/namespace.yaml" \
  --model-file     "model.yaml" \
  --connection-file "connections.yaml" \
  --connection-name "ats_connection" \
  --aliases-file   "aliases.yaml" \
  --target-file    "analysis/workbook.xlsx"
```

| Parameter | Required | Default | Description |
|---|---|---|---|
| `--namespace-file` | No | `analysis/namespace.yaml` | Path to the namespace YAML |
| `--model-file` | No | `model.yaml` | Path to the model YAML |
| `--connection-file` | No | `connections.yaml` | Path to the connections file |
| `--connection-name` | No | `default` | Connection name in the file |
| `--aliases-file` | No | | Path to an optional aliases YAML (see [Aliases YAML](#aliases-yaml-aliasesyaml)) |
| `--target-file` | No | `analysis/workbook.xlsx` | Output path for the Excel workbook |

The MDX connection uses `Provider=MSOLAP.8` pointed at the AtScale XMLA endpoint (`<mdx.url>/xmla/<organization_id>`). Open the workbook in Excel and click **Data → Refresh All** to load live data.

---

### `generate-powerbi-from-namespace`

[↑ Table of Contents](#table-of-contents)

Generates a Power BI project folder (`.pbip`) from a namespace YAML and a model YAML. The output can be opened directly in Power BI Desktop.

One page is created per worksheet in the namespace. The `graphType` controls the visual type on each page:

| `graphType` | Visual | Notes |
|---|---|---|
| `bar` | `columnChart` | When `xAxis` is a measure column |
| `bar` | `barChart` | When `xAxis` is a dimension column |
| `line` | `lineChart` | |
| `text` | `cardVisual` | |

**Connection requirement:** The named connection must have an `mdx:` block, and the referenced user must have a `token` field (not `password`) — Power BI connects via the AtScale MDX URL with token authentication.

**Output layout:**

```
output/<target-folder>/
  <target-folder>.pbip
  <target-folder>.SemanticModel/
    definition.pbism
    modelReference.json
  <target-folder>.Report/
    definition.pbir
    definition/
      report.json
      version.json
      pages/
        <uuid>/
          page.json
          visuals/<uuid>/visual.json
```

```bash
./atscale-utils generate-powerbi-from-namespace \
  --namespace-file "analysis/namespace.yaml" \
  --model-file     "model.yaml" \
  --connection-file "connections.yaml" \
  --connection-name "ats_connection" \
  --target-folder  "powerbi"
```

| Parameter | Required | Default | Description |
|---|---|---|---|
| `--namespace-file` | No | `analysis/namespace.yaml` | Path to the namespace YAML |
| `--model-file` | No | `model.yaml` | Path to the model YAML |
| `--connection-file` | No | `connections.yaml` | Path to the connections file |
| `--connection-name` | No | `default` | Connection name in the file |
| `--aliases-file` | No | | Path to an optional aliases YAML (see [Aliases YAML](#aliases-yaml-aliasesyaml)) |
| `--target-folder` | No | `powerbi` | Folder name for the report (written under `output/`) |

The `connections.yaml` user entry for Power BI must include a `token` field:

```yaml
users:
  admin:
    username: admin
    token: "<AtScale API token>"

connections:
  ats_connection:
    mdx:
      url: http://template.atscale-se-demo.com
      user: admin
      organization_id: default
      catalog_name: Telemetry
```

---

### `generate-queries-from-sml`

[↑ Table of Contents](#table-of-contents)

Reads an SML directory and generates two query JSON files — one XMLA (MDX) and one SQL — both compatible with `execute-atscale-query-harness`. Each file provides complete coverage of the model:

- **Metric totals** — one query per metric with no dimensional breakdown (verifies the measure computes without errors and returns a value)
- **Level breakdowns** — one query per hierarchy level across all dimensions, selecting all model metrics broken down by that level (verifies dimensional slicing at every granularity)

**XMLA query formats:**

Metric total:
```mdx
SELECT {[Measures].[m_metric_name]} ON COLUMNS
FROM [ModelName]
```

Level breakdown:
```mdx
SELECT {[Measures].[m1], [Measures].[m2], …} ON COLUMNS,
  NON EMPTY [Dim Name].[Hierarchy Name].[Level Name].MEMBERS ON ROWS
FROM [ModelName]
```

**SQL query formats:**

Metric total:
```sql
SELECT "m_metric_name"
FROM "ModelName"
```

Level breakdown:
```sql
SELECT "level_column", "m1", "m2", …
FROM "ModelName"
GROUP BY "level_column"
ORDER BY "level_column"
```

```bash
# Generate queries from an SML directory
./atscale-utils generate-queries-from-sml \
  --sml-dir "./sml" \
  --xmla-output-file "./queries/model_xmla.json" \
  --sql-output-file "./queries/model_sql.json"

# Pass the output directly to the harness
./atscale-utils execute-atscale-query-harness \
  --connection-file "./connections.yaml" \
  --connection-name "my_model" \
  --query-file "./queries/model_xmla.json" \
  --protocol xmla \
  --output-dir "./run_results"
```

| Parameter | Required | Default | Description |
|---|---|---|---|
| `--sml-dir` | Yes | | Path to the SML directory (must contain `models/`, `metrics/`, `dimensions/` sub-directories) |
| `--model-name` | No | First model found | Model `label` or `unique_name` to use |
| `--cube-name` | No | Model label | Override the cube name used in MDX `FROM` and SQL `FROM` clauses |
| `--xmla-output-file` | Yes | | Path to write the XMLA (MDX) query JSON |
| `--sql-output-file` | Yes | | Path to write the SQL query JSON |

---

### `generate-queries-from-model`

[↑ Table of Contents](#table-of-contents)

Reads a `model.yaml` file (output of `extract-model-from-atscale` or `extract-model-from-sml`) and generates the same XMLA and SQL query JSON files as `generate-queries-from-sml`. Use this operation when a model.yaml is already available instead of a raw SML directory.

Coverage is identical: one grand-total query per metric and one per-level breakdown query per hierarchy level across all dimensions.

```bash
# Generate queries from a model.yaml
./atscale-utils generate-queries-from-model \
  --model-file "./model.yaml" \
  --xmla-output-file "./queries/model_xmla.json" \
  --sql-output-file "./queries/model_sql.json"

# Multiple models in one file — select by name
./atscale-utils generate-queries-from-model \
  --model-file "./model.yaml" \
  --model-name "Telemetry" \
  --xmla-output-file "./queries/telemetry_xmla.json" \
  --sql-output-file "./queries/telemetry_sql.json"
```

| Parameter | Required | Default | Description |
|---|---|---|---|
| `--model-file` | Yes | | Path to the `model.yaml` file |
| `--model-name` | No | First model found | Top-level model key to use when the file contains multiple models |
| `--cube-name` | No | Model name | Override the cube name used in MDX `FROM` and SQL `FROM` clauses |
| `--xmla-output-file` | Yes | | Path to write the XMLA (MDX) query JSON |
| `--sql-output-file` | Yes | | Path to write the SQL query JSON |

---

### `extract-query-stats-from-atscale`

[↑ Table of Contents](#table-of-contents)

Paginates through the AtScale query history REST API and writes a CSV occurrence matrix showing how many user queries involved each (dimension attribute × measure) pair. Mirrors the `query_histogram_updated.ipynb` notebook analysis.

```bash
./atscale-utils extract-query-stats-from-atscale \
  --connection-file "./connections.yaml" \
  --connection-name "ats_connection" \
  --model "MyModel" \
  --output-dir "./query-stats" \
  --window-days 30
```

With a monthly breakdown:

```bash
./atscale-utils extract-query-stats-from-atscale \
  --connection-file "./connections.yaml" \
  --connection-name "ats_connection" \
  --model "MyModel" \
  --output-dir "./query-stats" \
  --monthly true \
  --monthly-year 2025
```

| Parameter | Required | Default | Description |
|---|---|---|---|
| `--connection-file` | Yes | | Path to connections file |
| `--connection-name` | Yes | | Connection name in the file |
| `--model` | Yes | | AtScale model (cube) name to analyse |
| `--output-dir` | No | `.` | Directory to write the output CSV files |
| `--window-days` | No | `30` | Days to look back when no explicit date range is given |
| `--start-date` | No | | Explicit window start (ISO-8601, e.g. `2025-01-01T00:00:00Z`). Overrides `--window-days`. |
| `--end-date` | No | now | Explicit window end (ISO-8601). Only used when `--start-date` is set. |
| `--monthly` | No | `false` | When `true`, also writes `{catalog}_{model}_monthly_occurrences.csv` |
| `--monthly-year` | No | current year | Calendar year for the monthly breakdown |
| `--limit` | No | `100` | Page size for the query history API |
| `--num-queries` | No | `10` | Max sample query IDs retained per (attribute, measure) pair via reservoir sampling |

**Outputs:**
- `{output-dir}/{catalog}_{model}_occurrences.csv` — occurrence count for every (attribute, measure) pair in the model
- `{output-dir}/{catalog}_{model}_monthly_occurrences.csv` — month-by-month counts (only when `--monthly true`)

The `connections.yaml` entry must have an `mdx:` block with `url`, `organization_id`, `catalog_name`, and `user`. The user entry needs `username` and `password` (installer mode) or `username` and `password` for cloud OAuth2.

---

### `extract-queries-from-atscale`

[↑ Table of Contents](#table-of-contents)

Connects to the AtScale internal Postgres backend and extracts deduplicated query history for one or more models. Outputs one JSON file per (model, protocol) pair that can be consumed directly by `execute-atscale-query-harness`.

Supports two config formats:
- **`connections.yaml`** — the standard connections file used by this project (pass `--connection-name` to select the entry)
- **`systems.properties`** — legacy properties file; connection details and model list are read automatically

```bash
# Using a connections.yaml file
./atscale-utils extract-queries-from-atscale \
  --connection-file "./connections.yaml" \
  --connection-name "ats_postgres" \
  --models "SalesModel,InventoryModel" \
  --days 60 \
  --protocol all \
  --output-dir "./queries"

# Using a systems.properties file
./atscale-utils extract-queries-from-atscale \
  --connection-file "./systems.properties" \
  --models "SalesModel"
```

| Parameter | Required | Default | Description |
|---|---|---|---|
| `--connection-file` | Yes | | Path to `connections.yaml` or a `systems.properties` file |
| `--connection-name` | No | `default` | Connection name within `connections.yaml` (ignored for `.properties` files) |
| `--models` | No* | | Comma-separated model/cube names to extract. Required for YAML mode; overrides `atscale.models` for `.properties` mode |
| `--days` | No | `60` | Look-back window in days |
| `--output-dir` | No | `queries` | Directory to write the output JSON files |
| `--protocol` | No | `all` | Query protocol to extract: `sql`, `xmla`, or `all` |
| `--min-executions` | No | `1` | Exclude queries seen fewer than N times in the window |
| `--db-schema` | No | `engine` | Postgres schema prefix for the AtScale backend tables (e.g. `engine` or `atscale.engine`) |

\* Required when using a `connections.yaml` file.

**Outputs:** One JSON file per (model, protocol) pair written to `--output-dir`:
- `{model}_sql_queries.json` — container SQL queries (`pgsql` language)
- `{model}_sql_installer_queries.json` — installer SQL queries (`sql`/Hive language)
- `{model}_xmla_queries.json` — XMLA/MDX queries (`analysis` language)

Each file is a JSON array of query records with fields: `queryName`, `queryLanguage`, `originalText`, `originalTextHash` (SHA-256), `outboundText`, `cubeName`, `projectId`, `aggregateUsed`, `numTimes`, `elapsedTimeInSeconds`, `avgResultSetSize`, `atscaleQueryId`.

The `connections.yaml` entry must have a `sql:` block with `dialect: postgres` pointing at the AtScale Postgres backend (typically port `25432`, database `atscale`).

---

### `execute-atscale-query-harness`

[↑ Table of Contents](#table-of-contents)

Replays extracted queries against a live AtScale instance, measuring response time and row count for each query. Supports SQL and XMLA/MDX protocols, concurrent workers, throttling, and both one-pass and timed-duration run modes. Output is a CSV suitable for performance analysis.

Supports three input modes:
- **`--query-file`** — JSON file produced by `extract-queries-from-atscale`
- **`--ingest-file`** — ingest CSV (`sampler_name,sql_text` or `sampler_name,atscale_query_id,sql_text`)
- **`--task-file`** — executor task YAML/JSON (runs all tasks sequentially, inferring protocol from `simulationClass`)

Supports two connection config formats: `connections.yaml` or `systems.properties`.

```bash
# Direct mode — XMLA queries from a JSON file
./atscale-utils execute-atscale-query-harness \
  --connection-file "./connections.yaml" \
  --connection-name "ats_connection" \
  --query-file "./queries/SalesModel_xmla_queries.json" \
  --protocol xmla \
  --concurrent-users 5 \
  --output-dir "./run_results"

# Direct mode — SQL queries from an ingest CSV
./atscale-utils execute-atscale-query-harness \
  --connection-file "./connections.yaml" \
  --connection-name "ats_connection" \
  --ingest-file "./ingest/sales_queries.csv" \
  --protocol sql \
  --concurrent-users 3 \
  --throttle-ms 100

# Timed duration run (loop queries for 10 minutes with 5 concurrent users)
./atscale-utils execute-atscale-query-harness \
  --connection-file "./connections.yaml" \
  --connection-name "ats_connection" \
  --query-file "./queries/SalesModel_xmla_queries.json" \
  --protocol xmla \
  --concurrent-users 5 \
  --duration-minutes 10

# Task-file mode — run all executor tasks from a YAML file
./atscale-utils execute-atscale-query-harness \
  --connection-file "./systems.properties" \
  --connection-name "SalesModel" \
  --task-file "./executor_tasks/tasks.yaml"
```

| Parameter | Required | Default | Description |
|---|---|---|---|
| `--connection-file` | Yes | | Path to `connections.yaml` or a `systems.properties` file |
| `--connection-name` | Yes | | Connection name (YAML mode) or model name (`.properties` mode) |
| `--query-file` | No | | JSON file from `extract-queries-from-atscale` |
| `--ingest-file` | No | | Ingest CSV (`sampler_name,sql_text` or `sampler_name,atscale_query_id,sql_text`) |
| `--task-file` | No | | Executor task YAML or JSON file |
| `--protocol` | No | `xmla` | Query protocol: `xmla` or `sql` (ignored in task-file mode) |
| `--concurrent-users` | No | `1` | Number of parallel workers (ignored in task-file mode) |
| `--throttle-ms` | No | `5` | Minimum milliseconds between query dispatches per worker |
| `--run-id` | No | | Label embedded in every output row; auto-generated if omitted |
| `--output-dir` | No | `run_results` | Directory to write the output CSV file |
| `--redact` | No | `false` | When `true`, omits `original_text` from log output |
| `--duration-minutes` | No | `0` | Run for this many minutes cycling the query list (0 = one pass) |
| `--annotate-queries` | No | `true` | When `true`, prepends a `/* {run_query_uuid, original_text_hash} */` comment to each executed query so AtScale's query log carries correlation fields. Set to `false` to send queries unmodified. |

**Output CSV columns:** `run_id`, `task_name`, `model`, `query_name`, `run_query_uuid`, `original_atscale_query_id`, `protocol`, `status`, `duration_ms`, `row_count`, `checksum`, `error`, `timestamp`, `original_text_hash`

- **`run_query_uuid`** — UUID generated per individual query execution; correlates this CSV row with the comment injected into the executed query (when `--annotate-queries true`)
- **`original_atscale_query_id`** — the query ID recorded in AtScale's query log when the query was originally captured
- **`row_count`** — number of rows returned (SQL) or number of `<Value>` elements within `<CellData>` in the XMLA response (MDX). `0` when no data is returned or on error.
- **`checksum`** — SHA1 hex digest of the result data. For SQL, computed over all rows serialised deterministically (columns sorted alphabetically, values tab-separated, rows newline-separated). For XMLA, computed over the SOAP `<Body>` content only (the `<Header>` is excluded because it contains per-request session IDs and timestamps). Empty when `row_count = 0` or when the query fails.

**Output filename:**
- Task-file mode: derived from `runLogFileName` in the task definition (`.log` → `.csv`)
- Direct mode: `{run-id}_{connection-name}.csv`

**Injection step compatibility (task-file mode):**

| Step type | Behaviour |
|---|---|
| `AtOnceUsers`, `RampUsers`, `ConstantUsersPerSec`, `RampUsersPerSec` | One-pass — runs each query once with the specified concurrency |
| `ConstantConcurrentUsers`, `RampConcurrentUsers` | Timed loop — cycles the query list for `durationMinutes` |

---

### `execute-query-on-connection`

[↑ Table of Contents](#table-of-contents)

Executes one or more queries from a query file against a live connection and writes the results to output file(s). Intended for ad-hoc inspection and debugging without the overhead of a full harness run.

`--query-name` supports shell-style wildcards:
- `*` — matches any sequence of characters
- `?` — matches exactly one character

When the pattern matches a single query, results are written to `--output-file` directly. When it matches multiple queries, each result is written to a separate file derived from `--output-file`: `{dir}/{query_name}{ext}`.

Accepts the same query file formats as `execute-atscale-query-harness`:
- **JSON** — array of `QueryRecord` objects produced by `extract-queries-from-atscale`
- **CSV** — Gatling ingest format (`sampler_name,sql_text` or `sampler_name,atscale_query_id,sql_text`)

Output format depends on protocol:
- **SQL** — CSV with column headers and data rows
- **XMLA** — raw SOAP XML response body

```bash
# Execute one query by exact name
./atscale-utils execute-query-on-connection \
  --connection-file "./connections.yaml" \
  --connection-name "ats_connection" \
  --query-file "./queries/SalesModel_xmla_queries.json" \
  --protocol xmla \
  --query-name "Total Revenue by Region" \
  --output-file "./output/revenue_by_region.xml"

# Execute all queries whose names start with "sales_" — writes one CSV per query
# to ./output/sales_<query_name>.csv
./atscale-utils execute-query-on-connection \
  --connection-file "./connections.yaml" \
  --connection-name "ats_connection" \
  --query-file "./ingest/sales_queries.csv" \
  --protocol sql \
  --query-name "sales_*" \
  --output-file "./output/placeholder.csv"

# Execute all queries in the file
./atscale-utils execute-query-on-connection \
  --connection-file "./connections.yaml" \
  --connection-name "ats_connection" \
  --query-file "./queries/SalesModel_xmla_queries.json" \
  --protocol xmla \
  --query-name "*" \
  --output-file "./output/placeholder.xml"
```

| Parameter | Required | Default | Description |
|---|---|---|---|
| `--connection-file` | Yes | | Path to `connections.yaml` or a `systems.properties` file |
| `--connection-name` | Yes | | Connection name (YAML mode) or model name (`.properties` mode) |
| `--query-file` | Yes | | JSON file from `extract-queries-from-atscale` or a Gatling ingest CSV |
| `--protocol` | No | `xmla` | Query protocol: `xmla` or `sql` |
| `--query-name` | Yes | | Name or wildcard pattern (`*`, `?`) to select queries from the file |
| `--output-file` | Yes | | Output path for a single match; used as a dir+extension template for multiple matches |

---

### `generate-enhanced-query-results`

[↑ Table of Contents](#table-of-contents)

Enriches a run-results CSV from `execute-atscale-query-harness` with the AtScale `query_id`, outbound SQL, and optionally the execution plan from the target data source. The correlation relies on the annotation comment that `execute-atscale-query-harness` prepends to every query:

```
/* {"run_id":"<run_id>","run_query_uuid":"<uuid>","original_text_hash":"<sha256>"} */
```

The operation connects to the AtScale internal Postgres backend, searches the `queries`, `subqueries`, `queries_planned`, and `query_results` tables for rows whose `query_text` starts with that comment, extracts the `run_query_uuid`, and joins enriched data back to the CSV. When `--target-connection-name` is provided the operation also connects to the target database and runs `EXPLAIN` on each outbound query. Identical outbound queries are cached so each unique SQL is explained only once.

**Requirements:** `--annotate-queries` must have been `true` (the default) when the harness run was executed.

```bash
./atscale-utils generate-enhanced-query-results \
  --results-file "./run_results/2026-04-21-ABC123_ats_connection.csv" \
  --connection-file "./connections.yaml" \
  --connection-name "ats_connection"

# Custom output path and wider look-back window
./atscale-utils generate-enhanced-query-results \
  --results-file "./run_results/2026-04-21-ABC123_ats_connection.csv" \
  --connection-file "./connections.yaml" \
  --connection-name "ats_connection" \
  --output-file "./run_results/enhanced.csv" \
  --days 14
```

| Parameter | Required | Default | Description |
|---|---|---|---|
| `--results-file` | Yes | | Path to the CSV from `execute-atscale-query-harness` |
| `--connection-file` | Yes | | Path to `connections.yaml` |
| `--connection-name` | Yes | | Connection name; uses `metadata:` block if present, otherwise `sql:` block |
| `--output-file` | No | `{stem}_enhanced.csv` | Output file path |
| `--db-schema` | No | auto | Postgres schema for AtScale backend tables (`atscale` or `engine`) |
| `--days` | No | `7` | Look-back window when searching the AtScale query log |
| `--target-connection-name` | No | | Connection name for the target data source. When provided, fetches an execution plan for each outbound query via `EXPLAIN` and stores it in `execution_plan`. Supports `snowflake`, `postgres`, `redshift`. |

**Output:** The input CSV with the following columns appended on the right. Rows with no AtScale match have empty values.

| Column | Populated | Description |
|---|---|---|
| `run_atscale_query_id` | Always | AtScale's internal `query_id` for the inbound query |
| `run_inbound_query_id` | Always | AtScale's `query_id` for the inbound annotated query (same source as `run_atscale_query_id`) |
| `run_outbound_text` | Always | SQL AtScale sent to the underlying data source (multiple subqueries joined by `\n---\n`) |
| `run_outbound_execution_plan` | When `--target-connection-name` is set | Dialect-specific EXPLAIN output: JSON for Snowflake (`SYSTEM$EXPLAIN_PLAN_JSON`) and PostgreSQL (`EXPLAIN (FORMAT JSON)`), text for Redshift |
| `run_used_agg` | Always | `true` if any subquery references an AtScale aggregate table (`as_agg_*`), `false` otherwise |
| `run_duration_ms` | When matched | Total wall-clock time from query receipt to last result row (ms). Computed as `query_results.finished − queries.received`. Falls back to `finished − planning_started` if `received` is unavailable. |
| `run_inbound_ms` | Best-effort | **INBOUND phase** — time from query receipt to start of planning (ms). Computed as `queries_planned.planning_started − queries.received`. Matches the "INBOUND" metric in the AtScale query monitor. |
| `run_query_planning_ms` | Best-effort | **QUERY PLANNING phase** — time AtScale spent planning the query (ms). Computed as `queries_planned.<finish_col> − planning_started`. Matches the "QUERY PLANNING" metric in the AtScale query monitor. |
| `run_outbound_ms` | Best-effort | **OUTBOUND total** — time from planning completion to last subquery result (ms). Computed as `MAX(subquery_finished) − planning_completed`. Matches the "OUTBOUND SUMMARY" metric in the AtScale query monitor. |
| `run_wait_ms` | Best-effort | **WAIT phase** — time from planning completion to first subquery execution start (ms). Computed as `MIN(subquery_started) − planning_completed`. Matches the "WAIT" metric in the AtScale query monitor. |
| `run_execute` | Best-effort | **EXECUTE phase** — total DB execution time across all subqueries (ms). Computed as `SUM(subquery_fetch_started − subquery_started)`. Matches the "EXECUTE" metric in the AtScale query monitor. |
| `run_fetch_ms` | Best-effort | **FETCH phase** — total time to retrieve result rows across all subqueries (ms). Computed as `SUM(subquery_finished − subquery_fetch_started)`. Matches the "FETCH" metric in the AtScale query monitor. |

---

### `execute-run-analysis`

[↑ Table of Contents](#table-of-contents)

Compares two run logs from `execute-atscale-query-harness`, or two enhanced CSVs from `generate-enhanced-query-results`, on a query-by-query basis. Queries are matched by a configurable join key.

When the same join-key value appears multiple times in a file (e.g. the same query was run several times), rows are sorted by timestamp and paired positionally. Extra occurrences that cannot be paired are reported as unmatched in the summary.

**Output files:**

- **`--summary-file`** — plain-text report containing:
  - Input file metadata (paths, types, row counts, run IDs, unique join-key counts)
  - Match statistics
  - Queries only present in file A
  - Queries only present in file B
  - Row-count and duration mismatch counts (with a reference to `--outliers-file`)
  - Queries with mismatched status or error messages

- **`--comparison-file`** — CSV with one row per matched pair:
  - `join_key_value`, `query_name`, `occurrence`
  - Flag columns: `row_count_mismatch`, `duration_outside_variance`, `error_mismatch`
  - Per-side columns: `a_status`, `b_status`, `a_duration_ms`, `b_duration_ms`, `a_row_count`, `b_row_count`, `a_checksum`, `b_checksum`, `a_error`, `b_error`, `a_timestamp`, `b_timestamp`
  - Delta columns: `duration_delta_ms`, `duration_delta_pct`
  - Enhanced timing columns (when present in either input): `a_run_duration_ms`, `b_run_duration_ms`, `a_run_inbound_ms`, `b_run_inbound_ms`, `a_run_query_planning_ms`, `b_run_query_planning_ms`, `a_run_outbound_ms`, `b_run_outbound_ms`, `a_run_wait_ms`, `b_run_wait_ms`, `a_run_execute`, `b_run_execute`, `a_run_fetch_ms`, `b_run_fetch_ms`

- **`--outliers-file`** — filtered subset of `--comparison-file` containing only the pairs flagged for a row-count mismatch or a duration outside the variance threshold. Same CSV schema as `--comparison-file`.

```bash
# Compare two run logs using the default join key (original_text_hash)
./atscale-utils execute-run-analysis \
  --file-a "./run_results/2026-04-21-ABC123_model.csv" \
  --file-b "./run_results/2026-04-22-DEF456_model.csv" \
  --summary-file "./analysis/summary.txt" \
  --comparison-file "./analysis/comparison.csv" \
  --outliers-file "./analysis/outliers.csv"

# Compare enhanced outputs with a 10% duration variance threshold
./atscale-utils execute-run-analysis \
  --file-a "./run_results/2026-04-21_enhanced.csv" \
  --file-b "./run_results/2026-04-22_enhanced.csv" \
  --duration-variance-pct 10 \
  --summary-file "./analysis/summary.txt" \
  --comparison-file "./analysis/comparison.csv" \
  --outliers-file "./analysis/outliers.csv"

# Join by original_atscale_query_id instead of text hash
./atscale-utils execute-run-analysis \
  --file-a "./run_results/run_a.csv" \
  --file-b "./run_results/run_b.csv" \
  --join-key original_atscale_query_id \
  --summary-file "./analysis/summary.txt" \
  --comparison-file "./analysis/comparison.csv" \
  --outliers-file "./analysis/outliers.csv"
```

| Parameter | Required | Default | Description |
|---|---|---|---|
| `--file-a` | Yes | | First run log or enhanced output CSV |
| `--file-b` | Yes | | Second run log or enhanced output CSV |
| `--join-key` | No | `original_text_hash` | Column to join on: `original_text_hash` or `original_atscale_query_id` |
| `--duration-variance-pct` | No | `20` | Flag pairs where `|(b−a)/a| × 100` exceeds this percentage |
| `--summary-file` | Yes | | Path to write the plain-text summary report |
| `--comparison-file` | Yes | | Path to write the row-by-row comparison CSV |
| `--outliers-file` | Yes | | Path to write the filtered outliers CSV (row-count and duration mismatches only) |

---

### `generate-atscale-install-yaml`

[↑ Table of Contents](#table-of-contents)

Generates a Helm `values.yaml` for deploying AtScale on Kubernetes. Accepts a hostname for the ingress domain and optionally a pre-existing TLS certificate. If no certificate is supplied, a self-signed RSA-2048 / SHA-256 certificate is generated automatically for the provided hostname (valid 365 days).

The `tlsCrt` and `tlsKey` fields in the output are base64-encoded PEM strings — the PEM content is base64-encoded a second time, as required by the AtScale Helm chart.

```bash
# Generate with a self-signed certificate (auto-generated)
./atscale-utils generate-atscale-install-yaml \
  --hostname "atscale.example.com"

# With a license key and existing certificate
./atscale-utils generate-atscale-install-yaml \
  --hostname     "atscale.example.com" \
  --license-key  "XXXX-XXXX-XXXX-XXXX" \
  --cert-file    "./tls.crt" \
  --key-file     "./tls.key" \
  --output-file  "./helm/values.yaml"
```

| Parameter | Required | Default | Description |
|---|---|---|---|
| `--hostname` | Yes | | FQDN or IP used as the ingress domain and certificate CN/SAN |
| `--license-key` | No | | AtScale license key; written to `atscale-entitlement.entitlement.licenseKey`. If omitted the key can be uploaded via the UI after install |
| `--cert-file` | No | | Path to an existing PEM certificate file |
| `--key-file` | No | | Path to an existing PEM private key file (required when `--cert-file` is set) |
| `--enable-mcp` | No | `false` | Enable the AtScale MCP server sub-chart (`atscale-mcp.enabled`). Accepts `true`/`false`, `yes`/`no`, `1`/`0`, `on`/`off`. |
| `--minimal` | No | `false` | Append values that reduce hardware footprint: disables telemetry, removes the Redis replica, and shrinks default PVC sizes (`db` 20 Gi, Redis master 8 Gi, telemetry 10 Gi). Verified against chart 2026.1.0. |
| `--output-file` | No | `values.yaml` | Output path for the generated `values.yaml` |

**Output:** A `values.yaml` ready to pass to `helm install atscale ... --values values.yaml`.

---

### `atscale-list-data-sources`

[↑ Table of Contents](#table-of-contents)

Lists the data warehouses (data sources) registered in an AtScale instance and writes the result as JSON to stdout.

```bash
./atscale-utils atscale-list-data-sources \
  --connection-file "./connections.yaml" \
  --atscale-connection-name "my_atscale"
```

| Parameter | Required | Default | Description |
|---|---|---|---|
| `--atscale-connection-name` | Yes | | Name of the AtScale connection entry in the connections file |
| `--connection-file` | No | `connections.yaml` | Path to the connections file |
| `--insecure` | No | `true` | Skip TLS certificate verification. Overrides the `insecure` field in the connections file. |

**Output:** Pretty-printed JSON array to stdout. Each entry contains `id`, `name`, `connectionId`, and a `connections` array of `{id, name}` sub-connection objects.

The connections file must have an `atscale:` block in the named entry. See [AtScale REST `atscale` fields](#atscale-rest-atscale-fields) for the connection format.

---

### `atscale-create-data-source`

[↑ Table of Contents](#table-of-contents)

Registers a data warehouse (data source) in an AtScale instance. Reads the connection details from a named `sql:` entry in the connections file and posts them to the appropriate AtScale API endpoint based on the dialect (`snowflake`, `databricks`, or `bigquery`).

```bash
./atscale-utils atscale-create-data-source \
  --connection-file "./connections.yaml" \
  --atscale-connection-name "my_atscale" \
  --new-connection-name "snow_prod" \
  --aggregate-schema "ATSCALE_AGGS"
```

With all options:

```bash
./atscale-utils atscale-create-data-source \
  --connection-file "./connections.yaml" \
  --atscale-connection-name "my_atscale" \
  --new-connection-name "snow_prod" \
  --aggregate-schema "ATSCALE_AGGS" \
  --name "Production Snowflake" \
  --connection-id "snow_prod" \
  --access-users "admin,atscale-user"
```

| Parameter | Required | Default | Description |
|---|---|---|---|
| `--atscale-connection-name` | Yes | | Name of the AtScale connection entry (must have an `atscale:` block) |
| `--new-connection-name` | Yes | | Name of the SQL connection entry to register (must have a `sql:` block) |
| `--aggregate-schema` | Yes | | Schema (or BigQuery dataset) for aggregate table storage |
| `--connection-file` | No | `connections.yaml` | Path to the connections file |
| `--name` | No | `--new-connection-name` | Display name for the data warehouse in AtScale (max 128 chars) |
| `--connection-id` | No | `--new-connection-name` | Logical connection ID embedded in SML files |
| `--access-users` | No | `""` (everyone group) | Comma-separated AtScale usernames to grant access. Empty string grants access to the built-in `everyone` group. |
| `--aggregate-project-id` | No | `sql.project` | BigQuery only: GCP project ID for aggregate storage |
| `--insecure` | No | `true` | Skip TLS certificate verification. Overrides the `insecure` field in the connections file. |

**Output:** JSON response from AtScale (`{id, created}`) written to stdout.

The SQL connection's `sql.dialect` controls which API endpoint is called:

| Dialect | Endpoint |
|---|---|
| `snowflake` | `POST /wapi/p/data-warehouses/snowflake` |
| `databricks` | `POST /wapi/p/data-warehouses/databricks` |
| `bigquery` | `POST /wapi/p/data-warehouses/google-big-query` |
| `postgresql` | `POST /wapi/p/data-warehouses/postgresql` |

---

### `atscale-list-repos`

[↑ Table of Contents](#table-of-contents)

Lists the git repositories registered in an AtScale instance.

```bash
./atscale-utils atscale-list-repos \
  --connection-file "./connections.yaml" \
  --atscale-connection-name "my_atscale"
```

| Parameter | Required | Default | Description |
|---|---|---|---|
| `--atscale-connection-name` | Yes | | Name of the AtScale connection entry in the connections file |
| `--connection-file` | No | `connections.yaml` | Path to the connections file |
| `--insecure` | No | `true` | Skip TLS certificate verification. Overrides the `insecure` field in the connections file. |

**Output:** Pretty-printed JSON array to stdout. Each entry contains `id`, `name`, `url`, and optional `visibleBranchesPattern` and `defaultBranch`.

---

### `atscale-create-repo`

[↑ Table of Contents](#table-of-contents)

Registers a git repository in an AtScale instance.

```bash
./atscale-utils atscale-create-repo \
  --connection-file "./connections.yaml" \
  --atscale-connection-name "my_atscale" \
  --name "my-sml-repo" \
  --url "https://github.com/myorg/sml.git" \
  --default-branch "main"
```

| Parameter | Required | Default | Description |
|---|---|---|---|
| `--atscale-connection-name` | Yes | | Name of the AtScale connection entry (must have an `atscale:` block) |
| `--name` | Yes | | Human-readable name for the repository |
| `--url` | Yes | | Git remote URL (HTTPS or SSH) |
| `--connection-file` | No | `connections.yaml` | Path to the connections file |
| `--type` | No | `catalog` | Repository type: `catalog` or `global_settings` |
| `--visible-branches-pattern` | No | | Glob pattern controlling which branches are visible in the UI |
| `--default-branch` | No | | Default branch name (e.g. `main`) |
| `--insecure` | No | `true` | Skip TLS certificate verification. Overrides the `insecure` field in the connections file. |

**Output:** JSON response from AtScale containing the created repository `{id, name, url, type}`.

---

### `atscale-list-deployments`

[↑ Table of Contents](#table-of-contents)

Lists the deployed catalogs (semantic models) in an AtScale instance.

```bash
./atscale-utils atscale-list-deployments \
  --connection-file "./connections.yaml" \
  --atscale-connection-name "my_atscale"
```

| Parameter | Required | Default | Description |
|---|---|---|---|
| `--atscale-connection-name` | Yes | | Name of the AtScale connection entry in the connections file |
| `--connection-file` | No | `connections.yaml` | Path to the connections file |
| `--insecure` | No | `true` | Skip TLS certificate verification. Overrides the `insecure` field in the connections file. |

**Output:** Pretty-printed JSON array to stdout. Each entry contains `id`, `name`, `caption`, `publishedAt`, `publishedBy`, and a `models` array.

---

### `atscale-deploy-catalog`

[↑ Table of Contents](#table-of-contents)

Reads local SML files, uploads them to an AtScale git-backed repository, and publishes the catalog. The operation:
1. Collects all `*.yml` files from `--sml-dir`
2. Looks up the repository by `--repo-name` (or uses `--repo-id` directly)
3. Derives the project name as `{catalog.unique_name}_{repo.defaultBranch}` (overridable via `--project-name`)
4. Generates the catalog XML and calls the AtScale deploy endpoint
5. Automatically acquires an `auth_session` cookie via Keycloak when the deploy endpoint requires one — no manual browser cookie needed

Either `apiToken` (on the user entry in the `users:` block) or username/password credentials must be available. When `apiToken` is set on the user entry, the username/password from the same entry are used to acquire the session cookie for the deploy endpoint, while the API token is used for all other REST calls.

```bash
./atscale-utils atscale-deploy-catalog \
  --connection-file "./connections.yaml" \
  --atscale-connection-name "my_atscale" \
  --sml-dir "./sml-output" \
  --repo-name "my-sml-repo"
```

Either `--repo-id` or `--repo-name` must be provided. When only `--repo-name` is given, the operation calls `atscale-list-repos` to look up the corresponding UUID.

| Parameter | Required | Default | Description |
|---|---|---|---|
| `--atscale-connection-name` | Yes | | Name of the AtScale connection entry (must have an `atscale:` block) |
| `--sml-dir` | Yes | | Path to the local directory containing SML `*.yml` files to deploy |
| `--repo-id` | One of | | UUID of the git repository already configured in AtScale (from `atscale-list-repos`) |
| `--repo-name` | One of | | Name of the git repository already configured in AtScale. Looked up automatically if `--repo-id` is omitted. |
| `--project-name` | No | `{catalog.unique_name}_{defaultBranch}` | Override the catalog project name |
| `--connection-file` | No | `connections.yaml` | Path to the connections file |
| `--tableau-servers` | No | | JSON array of Tableau servers to publish to, e.g. `[{"name":"ts1","sites":["Default"]}]` |
| `--insecure` | No | `true` | Skip TLS certificate verification. Overrides the `insecure` field in the connections file. |

**Output:** JSON response from AtScale, e.g. `{"tableau":[],"permissions":{"isSuccessful":true}}`.

**Connection format** (`apiToken` and credentials both live on the user entry — the API token is used for all REST calls, while username/password are used to acquire the session cookie for the deploy endpoint):

```yaml
users:
  vm_user:
    apiToken: "<api-token>"       # used for /wapi/p/ endpoints
    username: atscale-kc-admin    # used to acquire auth_session cookie for deploy
    password: "<password>"

connections:
  my_atscale:
    atscale:
      url: https://atscale.example.com
      user: vm_user
```

---

### `atscale-list-model-errors`

[↑ Table of Contents](#table-of-contents)

Validates an SML model and lists any structural or engine-level problems.

Runs in two phases:
1. **Structural** — local cross-reference check of all SML YAML files (datasets, dimensions, level attributes, model relationships).
2. **Engine** (if Phase 1 passes) — calls `POST /catalog/validate-model` to validate column joinability and uniqueness against the actual data warehouse.

Supports two source modes — provide exactly one of `--sml-dir`, `--repo-name`, or `--repo-id`.

**Local mode** (validate SML files on disk):

```bash
./atscale-utils atscale-list-model-errors \
  --connection-file "./connections.yaml" \
  --atscale-connection-name "my_atscale" \
  --sml-dir "./sml" \
  --model-name "sales_demo"
```

**Remote mode** (clone an AtScale-connected git repo and validate):

```bash
./atscale-utils atscale-list-model-errors \
  --connection-file "./connections.yaml" \
  --atscale-connection-name "my_atscale" \
  --repo-name "my-sml-repo" \
  --branch "main" \
  --model-name "sales_demo"
```

| Parameter | Required | Default | Description |
|---|---|---|---|
| `--atscale-connection-name` | Yes | | Name of the AtScale connection entry (must have an `atscale:` block) |
| `--sml-dir` | †One of | | Path to the SML directory (must contain `models/`, `dimensions/`, `datasets/`) |
| `--repo-name` | †One of | | Name of an AtScale-connected git repository to validate |
| `--repo-id` | †One of | | UUID of an AtScale-connected git repository to validate |
| `--branch` | No | repo default | Branch to check out (remote mode only) |
| `--model-name` | No | first model | Model `label` or `unique_name` to validate |
| `--connection-file` | No | `connections.yaml` | Path to the connections file |
| `--insecure` | No | `true` | Skip TLS certificate verification |

† Provide exactly one of `--sml-dir`, `--repo-name`, or `--repo-id`.

**Output:** JSON with `model`, `problems` array (each entry has `phase`, `severity`, `message`, optional `location`), and `summary` with `errors`/`warnings` counts.

---

### `execute-web-services`

[↑ Table of Contents](#table-of-contents)

Starts a GraphQL HTTP server that dynamically exposes every registered operation as a mutation. The schema is built at startup from the live operation registry — no configuration required.

File parameters (names ending in `-file`) accept either a local path string or a multipart-uploaded file via the `Upload` scalar.

See [GRAPHQL.md](docs/GRAPHQL.md) for the full schema reference and per-operation documentation.

```bash
./atscale-utils execute-web-services
./atscale-utils execute-web-services --port 4000 --host 0.0.0.0
```

| Parameter | Required | Default | Description |
|---|---|---|---|
| `--port` | No | `4000` | Port to listen on |
| `--host` | No | `localhost` | Bind address (`0.0.0.0` to accept external connections) |

**Example GraphQL call:**

```graphql
mutation {
  generateSmlFromXml(input: {
    xmlFile: "/data/project.xml"
    outputDir: "/output/sml"
  }) {
    success
    output
    error
  }
}
```

---

#### Utilities

### `version`

[↑ Table of Contents](#table-of-contents)

Prints the installed version of `atscale-utils` to stdout.

```bash
atscale-utils version
atscale-utils --version
```

**Output:** `@atscale/ps-utils@<version>`

This operation takes no parameters.

---

## Extract AtScale Model Workflow

The `extract-model-from-atscale` workflow (`.github/workflows/extract-model-from-atscale.yml`) runs manually from the Actions tab.

### Setup

Add a repository secret named `ATSCALE_CONNECTION_FILE` containing the full contents of your connections YAML:

> Settings → Secrets and variables → Actions → New repository secret

### Inputs

| Input | Required | Description |
|---|---|---|
| `model` | Yes | AtScale model identifier |
| `connection-name` | Yes | Connection name within the connection file |
| `output-model-file` | No | Output file path (defaults to `model.yml`) |

### Running the workflow

1. Go to **Actions → Extract AtScale Model → Run workflow**
2. Fill in the inputs and click **Run workflow**
3. Download the extracted model from the **Artifacts** section of the run

### Calling from another workflow

```yaml
- uses: actions/checkout@v4
- uses: actions/setup-node@v4
  with:
    node-version: 20
    cache: npm
- run: npm install && npm run build
- name: Write connection file
  run: echo "${{ secrets.ATSCALE_CONNECTION_FILE }}" > connection.yml
- name: Extract AtScale model
  run: |
    ./atscale-utils extract-model-from-atscale \
      --model "Telemetry" \
      --connection-file connection.yml \
      --connection-name "ats_connection" \
      --output-model-file "model.yml"
```

---

## Connection YAML (`connections.yaml`)

Passed to operations via `--connection-file`. Contains user credentials and named connection definitions.

> **Security:** Do not commit this file to source control. Add it to `.gitignore` or supply it via a CI secret.

### Structure

```yaml
users:
  <user_key>:
    ...           # credentials — see below

connections:
  <connection_name>:
    installer: true | false     # optional: marks as an AtScale installer connection
    mdx:                        # optional: required for extract-model-from-atscale
      url: http://<atscale_host>
      user: <user_key>
      organization_id: default
      catalog_name: <AtScale catalog name>
    sql:                        # required for SQL operations and SML generation
      dialect: postgres | snowflake | redshift | databricks | bigquery | iris
      ...
    atscale:                    # required for atscale-list-data-sources and other REST operations
      url: https://<atscale_host>
      user: <user_key>          # key from users block, or use username/password inline
      # username: admin         # alternative: inline credentials
      # password: secret
```

---

### User credentials

#### Password authentication (Postgres, Redshift, IRIS)

```yaml
users:
  db_user:
    username: myuser
    password: mypassword
```

#### Key-pair authentication (Snowflake)

```yaml
users:
  snowflake_user:
    username: USER@EXAMPLE.COM
    privateKeyPath: resources/keys/snowflake_key.p8   # PKCS8 private key file
    privateKeyPassword: ""                             # empty string if unencrypted
    # Alternative: pre-encoded PKCS8 DER base64
    # privateKeyBase64: "<base64-der-pkcs8>"
```

#### Personal access token (Databricks)

```yaml
users:
  databricks_user:
    token: "dapi1234567890abcdef"
```

#### Service account (BigQuery)

```yaml
users:
  bigquery_sa:
    key_file: resources/keys/bigquery-service-account.json
    # Alternative: inline base64-encoded JSON key
    # key_base64: "<base64-encoded-json>"
```

#### AtScale API token

```yaml
users:
  my_user:
    apiToken: "<api-token>"   # profile icon → API Token → Generate
    # Optional: also add username/password if atscale-deploy-catalog is needed
    # username: atscale-kc-admin
    # password: "<password>"
```

---

### Postgres `sql` fields

| Field | Required | Default | Description |
|---|---|---|---|
| `dialect` | Yes | | `postgres` |
| `server` | Yes | | Hostname or IP |
| `port` | No | `5432` | Port number |
| `database` | Yes | | Database name |
| `schema` | No | | Default schema (appended as `?currentSchema=`) |
| `user` | Yes | | Key from `users` section |

#### Full Postgres example

```yaml
users:
  admin:
    username: admin
    password: "<password>"

connections:
  ats_connection:
    installer: true
    mdx:
      url: http://template.atscale-se-demo.com
      user: admin
      organization_id: default
      catalog_name: Telemetry
    sql:
      dialect: postgres
      server: template.atscale-se-demo.com
      port: 15432
      database: atscale
      schema: Telemetry
      user: admin
```

---

### Snowflake `sql` fields

| Field | Required | Default | Description |
|---|---|---|---|
| `dialect` | Yes | | `snowflake` |
| `account` | Yes | | Snowflake account identifier (e.g. `xy12345` or `xy12345.us-east-1`) |
| `warehouse` | Yes | | Warehouse name |
| `database` | Yes | | Database name |
| `schema` | Yes | | Schema name |
| `snowflake_user` | Yes | | Key from `users` section |
| `role` | No | | Snowflake role (e.g. `SYSADMIN`) |

#### Full Snowflake example

```yaml
users:
  snowflake_user:
    username: USER@EXAMPLE.COM
    privateKeyPath: resources/keys/snowflake_key.p8
    privateKeyPassword: ""

connections:
  snow_demo:
    sql:
      dialect: snowflake
      account: da37161
      warehouse: COMPUTE_WH
      database: MY_DATABASE
      schema: MY_SCHEMA
      role: SYSADMIN
      snowflake_user: snowflake_user
```

---

### Redshift `sql` fields

Redshift uses the Postgres wire protocol. The `pg` driver is used directly — no AWS SDK required.

| Field | Required | Default | Description |
|---|---|---|---|
| `dialect` | Yes | | `redshift` |
| `server` | Yes | | Cluster endpoint (e.g. `my-cluster.abc123.us-east-1.redshift.amazonaws.com`) |
| `port` | No | `5439` | Port number |
| `database` | Yes | | Database name |
| `schema` | No | `public` | Default schema |
| `user` | Yes | | Key from `users` section |
| `ssl` | No | `true` | Set to `false` to disable SSL (not recommended) |

#### Full Redshift example

```yaml
users:
  rs_user:
    username: awsuser
    password: mypassword

connections:
  redshift_prod:
    sql:
      dialect: redshift
      server: my-cluster.abc123.us-east-1.redshift.amazonaws.com
      port: 5439
      database: analytics
      schema: public
      user: rs_user
```

---

### Databricks `sql` fields

Connects to a Databricks SQL Warehouse via the official `@databricks/sql` driver.

| Field | Required | Default | Description |
|---|---|---|---|
| `dialect` | Yes | | `databricks` |
| `host` | Yes | | Databricks workspace hostname (e.g. `abc123.azuredatabricks.net`) |
| `path` | Yes | | HTTP path for the SQL Warehouse (found in Warehouse → Connection Details) |
| `catalog` | No | `hive_metastore` | Unity Catalog name |
| `schema` | No | `default` | Schema name |
| `databricks_user` | Yes | | Key from `users` section (must have a `token` field) |

#### Full Databricks example

```yaml
users:
  databricks_user:
    token: "dapi1234567890abcdef1234567890abcdef"

connections:
  databricks_prod:
    sql:
      dialect: databricks
      host: adb-1234567890123456.7.azuredatabricks.net
      path: /sql/1.0/warehouses/abc1234567890def
      catalog: main
      schema: sales
      databricks_user: databricks_user
```

---

### BigQuery `sql` fields

Connects via the `@google-cloud/bigquery` client. Authentication uses a service account key file or Application Default Credentials (ADC).

| Field | Required | Default | Description |
|---|---|---|---|
| `dialect` | Yes | | `bigquery` |
| `project_id` | Yes | | GCP project ID |
| `dataset` | Yes | | Default BigQuery dataset (equivalent to schema) |
| `location` | No | `US` | Dataset location (e.g. `US`, `EU`, `us-central1`) |
| `bigquery_user` | No | | Key from `users` section. Omit to use Application Default Credentials |

> **ADC:** If `bigquery_user` is omitted, the driver uses the environment's Application Default Credentials (`GOOGLE_APPLICATION_CREDENTIALS` env var or gcloud login). This is the recommended approach when running in GCP (Cloud Run, GKE, etc.).

#### Full BigQuery example — service account key file

```yaml
users:
  bigquery_sa:
    key_file: resources/keys/bigquery-service-account.json

connections:
  bq_prod:
    sql:
      dialect: bigquery
      project_id: my-gcp-project-123
      dataset: analytics
      location: US
      bigquery_user: bigquery_sa
```

#### BigQuery example — Application Default Credentials

```yaml
connections:
  bq_adc:
    sql:
      dialect: bigquery
      project_id: my-gcp-project-123
      dataset: analytics
```

---

### AtScale REST `atscale` fields

Used by `atscale-list-data-sources` and other operations that call the AtScale public REST API. Authenticates via Keycloak OIDC (the standard AtScale auth flow — the same token endpoint used by `atscale-ai-link`).

| Field | Required | Default | Description |
|---|---|---|---|
| `url` | Yes | | Root URL of the AtScale instance (no trailing slash), e.g. `https://atscale.example.com` |
| `user` | No† | | Key from the `users` block. Resolves `username`, `password`, and `apiToken` from that entry. |
| `username` | No† | | Inline username for Keycloak OIDC. Used when `user` is not set. |
| `password` | No† | | Inline password for Keycloak OIDC. Used when `user` is not set. |
| `realm` | No | `atscale` | Keycloak realm name |
| `clientId` | No | `atscale-ai-link` | Keycloak client ID |
| `clientSecret` | No | | Keycloak client secret. Required when the client is configured as confidential (e.g. `atscale-modeler`). Find it in Keycloak → Clients → \<client\> → Credentials. |
| `authType` | No | `keycloak` | Authentication type: `keycloak` (OIDC password grant, default) or `basic` (HTTP Basic auth). |
| `sessionCookie` | No | | Pre-obtained `auth_session` cookie value. If omitted, the cookie is acquired automatically via Keycloak when needed (e.g. for `atscale-deploy-catalog`). Rarely needed — provide username/password instead and let the tool acquire it. |
| `insecure` | No | `true` | Skip TLS certificate verification. Defaults to `true` because AtScale instances commonly use self-signed certificates. Set to `false` to enforce strict certificate validation. |

† Either `user` (referencing a `users:` entry with `apiToken` or `username`/`password`) or inline `username`/`password` must be provided.

**Keycloak client troubleshooting:**

| Error | Meaning | Fix |
|---|---|---|
| `invalid_grant` | Client doesn't have Direct Access Grants enabled, or wrong credentials | Try `clientId: atscale-modeler` (or another client with ROPC enabled) |
| `unauthorized_client` | Client requires a `client_secret` | Add `clientSecret` — find it in Keycloak admin → Clients → \<client\> → Credentials tab |
| `Invalid token format` (from AtScale API) | The AtScale API does not accept Keycloak JWT Bearer tokens | Set `authType: basic` in the `atscale:` block |

#### API token example (recommended)

```yaml
users:
  my_user:
    apiToken: "<api-token>"   # profile icon → API Token → Generate

connections:
  my_atscale:
    atscale:
      url: https://atscale.example.com
      user: my_user
```

#### Username/password example

```yaml
users:
  admin:
    username: admin
    password: "<password>"

connections:
  my_atscale:
    atscale:
      url: https://atscale.example.com
      user: admin
```

#### Inline credentials example

```yaml
connections:
  my_atscale:
    atscale:
      url: https://atscale.example.com
      username: admin
      password: "<password>"
```

---

### IRIS `sql` fields

Connects to InterSystems IRIS via the `intersystems-iris` community driver.

> **Note:** The IRIS community npm package has a single-connection-per-process limitation. It is suitable for sequential operations but not concurrent workloads.

| Field | Required | Default | Description |
|---|---|---|---|
| `dialect` | Yes | | `iris` |
| `server` | Yes | | Hostname or IP |
| `port` | No | `1972` | Superserver port |
| `namespace` | Yes | | IRIS namespace (e.g. `USER`) |
| `user` | Yes | | Key from `users` section |

#### Full IRIS example

```yaml
users:
  iris_user:
    username: _SYSTEM
    password: SYS

connections:
  iris_prod:
    sql:
      dialect: iris
      server: iris.example.com
      port: 1972
      namespace: MYAPP
      user: iris_user
```

---

## SML Style Config (`sml.style.yaml`)

An optional YAML file that stores SML generation parameters so you don't have to repeat them on every command. Used by `generate-sml-from-ddl`, `generate-sml-from-connection`, and `generate-metrics-from-model`.

**Priority:** CLI flags always override the file. Any parameter not supplied on the CLI falls back to the file, then to the hardcoded default.

**Input vs. output:** `--sml-config-file` is the *input* path only. After generation, the **effective settings** (all values including defaults) are always written to `<output-dir>/sml.style.yaml` — a fixed location independent of the input path. If `--sml-config-file` points to the same file (e.g. you pass `--sml-config-file sml-output/sml.style.yaml`), it is simply overwritten.

**Reference copy:** A fully annotated reference file with all parameters and their defaults lives at [`docs/sml.style.yaml`](docs/sml.style.yaml). Copy it to your working directory as a starting point.

**Style guide:** [`docs/STYLE.md`](docs/STYLE.md) documents the naming conventions, casing rules, and generation settings that `sml.style.yaml` controls.

### All fields

```yaml
# ── generate-sml-from-ddl / generate-sml-from-connection ─────────────────────
pii-severity: MEDIUM          # "HIGH" | "MEDIUM" | "LOW" | "none"
fact-tables:                  # force-classify tables as facts (list or empty)
  - FactSales
  - FactOrders
catalog-name: My Catalog      # display name; omit to default to model-name
camel-case-files: false       # camelCase SML filenames
camel-case-measures: false    # camelCase metric labels
sample-size: 250              # rows per table for type inference (0 to disable)
                              # note: always 0 for generate-sml-from-ddl
min-hierarchies-per-dim: 1   # drop dimensions with fewer than this many hierarchies
max-hierarchies-per-dim: 4   # keep at most this many hierarchies per dimension

# ── generate-metrics-from-model ───────────────────────────────────────────────
max-suggestions: 25           # maximum suggestions to output
min-score: 0.5                # minimum relevance score [0–1]
include-tuples: true          # include multi-dimension suggestions
```

### Typical workflow

First run (no file yet — all defaults apply):

```bash
./atscale-utils generate-sml-from-ddl \
  --ddl-file schema.sql \
  --output-dir sml-output
# → sml-output/sml.style.yaml written with all effective settings
```

Edit `sml-output/sml.style.yaml`, then re-run pointing `--sml-config-file` at it. The output overwrites the same file:

```bash
./atscale-utils generate-sml-from-ddl \
  --ddl-file schema.sql \
  --output-dir sml-output \
  --sml-config-file sml-output/sml.style.yaml
# → sml-output/sml.style.yaml overwritten with updated effective settings
```

Or keep a project-level `sml.style.yaml` in the working directory (the default input path) and let the output land separately in the output directory:

```bash
# Reads from ./sml.style.yaml (CWD default), writes to sml-output/sml.style.yaml
./atscale-utils generate-sml-from-connection \
  --connection-file connections.yaml \
  --connection-name snow_demo \
  --model-name SalesModel \
  --output-dir sml-output
```

---

## Model YAML (`model.yaml`)

Auto-generated by `extract-model-from-atscale` or `extract-model-from-sml`. Describes one or more AtScale models with two parallel sections per model: `mdx` (MDX query metadata) and `sql` (column metadata used by the BI generators).

### Structure

```yaml
<ModelName>:
  data_source: <connection-name>
  mdx:
    metrics: [...]
    attributes: {...}
  sql:
    table_name: <ModelName>
    columns:
      <column_name>:
        alias: false
        name: <column_name>
        data_type: <DATA_TYPE>
        label: <Human-readable label>
        description: ""
        role: measure | dimension
        type: quantitative | nominal | ordinal
        aggregation: sum | avg | min | max | count | countd   # measures only
        folder: ""
```

Column names in `sql.columns` are what you reference in namespace YAML fields (`xAxis`, `yAxis`, `measures`, `colorField`, `filters[].field`). When an `--aliases-file` is supplied, `sql.columns` is extended with alias entries and the original columns are preserved under `sql.rawColumns`.

### Supported `data_type` values

| `data_type` | Tableau type | Notes |
|---|---|---|
| `WSTR`, `STRING`, `BSTR`, `GUID` | string | Dimensions |
| `BOOL` | boolean | Dimensions |
| `INT1`–`INT8`, `INT_UNSIGNED1`–`INT_UNSIGNED8` | integer | Measures |
| `FLOAT32`, `FLOAT64` | real | Measures |
| `DATE_DOUBLE` | date | Must use `role: dimension`, `type: ordinal` |
| `DATETIME` | datetime | Dimensions; supports `xAxisGranularity` in line charts |
| `DECIMAL`, `NUMERIC` | decimal/numeric | Measures |

### Example

```yaml
Telemetry:
  data_source: ats_connection
  sql:
    table_name: Telemetry
    columns:
      m_query_id_count:
        alias: false
        name: m_query_id_count
        data_type: INT8
        label: Total Queries
        description: ""
        role: measure
        type: quantitative
        aggregation: count
        folder: ""
      query_hour:
        alias: false
        name: query_hour
        data_type: DATETIME
        label: Query Hour
        description: ""
        role: dimension
        type: nominal
        folder: ""
```

---

## Namespace YAML (`namespace.yaml`)

Drives the BI workbook generators. Defines worksheets and dashboards.

### Structure

```yaml
version: 1
title: <Workbook title>
description: <Description>

worksheets:
  <worksheet_key>:
    title: <Display name>
    model: <ModelName>          # key from model.yaml
    graphType: bar | line | text
    ...

dashboards:
  <dashboard_key>:
    ...
```

### `graphType: bar`

Horizontal bar chart. `xAxis` = measure (bar length), `yAxis` = dimension (bar labels).

```yaml
top_users:
  title: Top 10 Most Active Users
  model: Telemetry
  graphType: bar
  xAxis: m_query_id_count       # measure column
  yAxis: user_hash              # dimension column
  limit: 10                     # optional: top-N rows
  sortDirection: desc           # optional: asc | desc
  colorField: service           # optional: dimension for color encoding
  format: integer               # optional: integer | decimal:N | percent:N | currency:N
  filters:
    - field: user_hash
      excludeNull: true
```

### `graphType: line`

Time-series line chart. `xAxisGranularity` selects a specific level from the time hierarchy when the AtScale model has named levels (e.g. "Day", "Week"). If the hierarchy has only one level the field is recorded but has no effect on the set expression.

```yaml
queries_over_time:
  title: Queries by Week
  model: Telemetry
  graphType: line
  xAxis: query_hour             # typically a DATETIME dimension
  xAxisGranularity: week        # optional: day | week | month | quarter | year
  yAxis: m_query_id_count       # measure (Y axis)
  colorField: service           # optional: dimension for series breakdown
  filters:
    - field: succeeded
      excludeNull: true
```

### `graphType: text`

Single-number KPI scorecard.

```yaml
total_queries:
  title: Total Queries
  model: Telemetry
  graphType: text
  measures:
    - m_query_id_count
  format: integer               # optional: integer | decimal:N | percent:N | currency:N
```

### `format` field

Applies a number format to measure values in Excel. Accepted values:

| Value | Excel format | Example |
|---|---|---|
| `integer` | `#,##0` | `1,234` |
| `decimal:N` | `#,##0.00…` | `1,234.56` |
| `percent:N` | `0.00…%` | `98.76%` |
| `currency:N` | `$#,##0.00…` | `$1,234.56` |

### `filters` array

```yaml
filters:
  - field: <column_name>        # must exist in model's sql.columns (or aliases)
    excludeNull: true           # exclude null/blank members
```

### Dashboard definition

```yaml
dashboards:
  my_dashboard:
    title: Telemetry Dashboard
    description: ""

    size:
      width: 1800               # total pixel width
      height: 4900              # total pixel height
      hSegments: 3              # grid columns
      vSegments: 49             # grid rows

    categoryHeaders:            # optional: full-width section title zones
      - label: "Summary Statistics"
        x: 0
        y: 0
        colSpan: 3
        rowSpan: 1

    tiles:
      - worksheet: total_queries
        x: 0                    # grid column (0-based)
        y: 1                    # grid row (0-based)
        colSpan: 1
        rowSpan: 2
        category: Summary Statistics
```

Grid cell size = `width / hSegments` × `height / vSegments` px. `x + colSpan` must not exceed `hSegments`.

### Full example

See [`resources/namespaces/telemetry/overview.yaml`](resources/namespaces/telemetry/overview.yaml).

---

## Aliases YAML (`aliases.yaml`)

An optional file passed via `--aliases-file` to `generate-tableau-from-namespace` and `generate-excel-from-namespace`. It lets you define friendly names for model columns so that namespace files can reference an alias instead of the underlying column key.

### How it works

When an aliases file is provided, `sql.columns` in the model is extended: each alias entry adds a copy of the referenced column under the alias name. The original columns remain unchanged. The pre-merge snapshot is preserved as `sql.rawColumns`, and the aliases map is attached as `model.aliases`.

Any field in the namespace that accepts a column name (`xAxis`, `yAxis`, `measures`, `colorField`, `filters[].field`) can use either the original column key or any defined alias.

### Structure

The file is a flat YAML map of `alias_name: original_column_key`:

```yaml
<alias>: <original_column_key>
```

### Example

```yaml
query_time: query_hour
total_queries: m_query_id_count
response_time_avg: m_epoch_sql_wall_time_avg
subquery_count: m_subquery_count_sum
success_rate: cm_query_success_pct
```

With this file, a namespace worksheet can use `response_time_avg` as a `yAxis` and it will resolve to the `m_epoch_sql_wall_time_avg` column in the model.

See [`example/aliases.yaml`](example/aliases.yaml) for the full example.
