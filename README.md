# AtScale PS Template CLI

CLI tool for extracting AtScale models, generating SML semantic models, and generating BI workbooks (Tableau, Excel, Power BI).

Upcoming features:
- Google Sheets
- Rudy's aggregate util
- Complete GitActions
- SSO



```mermaid
flowchart TD
    DDL["DDL File<br/>(.sql)"]
    DB[("Database<br/>(Postgres / Snowflake)")]
    ATS["AtScale<br/>Instance"]
    ATSDB[("AtScale<br/>Postgres Backend")]
    NS["Namespace YAML<br/>(namespace.yaml)"]
    CONN["Connections YAML<br/>(connections.yaml)"]
    ALIASES["Aliases YAML<br/>(aliases.yaml)<br/>[optional]"]

    DDL -->|generate-sml-from-ddl| SML
    DB  -->|generate-sml-from-connection| SML

    subgraph SML["SML Output"]
        direction TB
        catalog["catalog.yml"]
        datasets["datasets/"]
        dims["dimensions/"]
        metrics["metrics/"]
        models["models/"]
    end

    SML -->|deploy to| ATS
    ATS -->|extract-model-from-atscale| MODEL["model.yaml"]
    SML -->|extract-model-from-sml| MODEL

    MODEL -->|generate-namespace-from-model| NS
    MODEL --> TWB
    MODEL --> XLSX
    NS    --> TWB
    NS    --> XLSX
    CONN  --> TWB
    CONN  --> XLSX
    ALIASES -.->|optional| TWB
    ALIASES -.->|optional| XLSX
    ALIASES -.->|optional| PBI
    MODEL --> PBI
    NS    --> PBI
    CONN  --> PBI
    TWB["generate-tableau-from-namespace<br/>→ tableau.twb"]
    XLSX["generate-excel-from-namespace<br/>→ workbook.xlsx"]
    PBI["generate-powerbi-from-namespace<br/>→ output/powerbi/"]

    ATSDB -->|extract-queries-from-atscale| QJSON["Query JSON<br/>(queries/*.json)"]
    QJSON -->|execute-atscale-query-harness| RCSV["Results CSV<br/>(run_results/*.csv)"]
    ATS   -->|execute-atscale-query-harness| RCSV
    ATS   -->|extract-query-stats-from-atscale| STATSCSV["Stats CSV<br/>(occurrences.csv)"]

    HOSTNAME["Hostname"] -->|generate-atscale-install-yaml| VALUESYAML["values.yaml<br/>(Helm install)"]

    click MODEL href "#extract-model-from-atscale" "extract-model-from-atscale"
    click TWB href "#generate-tableau-from-namespace" "generate-tableau-from-namespace"
    click XLSX href "#generate-excel-from-namespace" "generate-excel-from-namespace"
    click PBI href "#generate-powerbi-from-namespace" "generate-powerbi-from-namespace"
    click QJSON href "#extract-queries-from-atscale" "extract-queries-from-atscale"
    click RCSV href "#execute-atscale-query-harness" "execute-atscale-query-harness"
    click STATSCSV href "#extract-query-stats-from-atscale" "extract-query-stats-from-atscale"
    click VALUESYAML href "#generate-atscale-install-yaml" "generate-atscale-install-yaml"
```

## Table of Contents

- [Setup](#setup)
- [Operations](#operations)
  - [`extract-model-from-atscale`](#extract-model-from-atscale)
  - [`extract-model-from-sml`](#extract-model-from-sml)
  - [`generate-namespace-from-model`](#generate-namespace-from-model)
  - [`execute-sql-on-connection`](#execute-sql-on-connection)
  - [`extract-ddl-from-connection`](#extract-ddl-from-connection)
  - [`generate-sml-from-connection`](#generate-sml-from-connection)
  - [`generate-sml-from-ddl`](#generate-sml-from-ddl)
  - [BI Tool Feature Comparison](#bi-tool-feature-comparison)
  - [`generate-tableau-from-namespace`](#generate-tableau-from-namespace)
  - [`generate-excel-from-namespace`](#generate-excel-from-namespace)
  - [`generate-powerbi-from-namespace`](#generate-powerbi-from-namespace)
  - [`extract-query-stats-from-atscale`](#extract-query-stats-from-atscale)
  - [`extract-queries-from-atscale`](#extract-queries-from-atscale)
  - [`execute-atscale-query-harness`](#execute-atscale-query-harness)
  - [`generate-atscale-install-yaml`](#generate-atscale-install-yaml)
- [Extract AtScale Model Workflow](#extract-atscale-model-workflow)
- [Connection YAML (`connections.yaml`)](#connection-yaml-connectionsyaml)
- [Model YAML (`model.yaml`)](#model-yaml-modelyaml)
- [Namespace YAML (`namespace.yaml`)](#namespace-yaml-namespaceyaml)
- [Aliases YAML (`aliases.yaml`)](#aliases-yaml-aliasesyaml)

---

## Setup

```bash
npm install
npm run build
```

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

### `generate-sml-from-connection`

[↑ Table of Contents](#table-of-contents)

Connects to a live database, introspects its schema, runs semantic model inference, and writes a complete set of AtScale SML files to a directory.

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

| Parameter | Required | Default | Description |
|---|---|---|---|
| `--connection-file` | No | `connections.yaml` | Path to connections file |
| `--connection-name` | Yes | | Connection name in the file |
| `--model-name` | Yes | | Name for the generated semantic model |
| `--output-dir` | Yes | | Directory to write SML files |
| `--schema` | No | From connection config | Override the database schema to introspect |
| `--catalog-name` | No | `model-name` | Display name for the generated catalog |
| `--pii-severity` | No | `MEDIUM` | Minimum PII severity to exclude: `HIGH`, `MEDIUM`, `LOW`, or `none` |
| `--sample-size` | No | `250` | Rows to sample per table for type inference (`0` to disable) |
| `--fact-tables` | No | Auto-detected | Comma-separated table names to treat as facts, overriding automatic classification |
| `--camel-case-files` | No | `false` | When `true`, dataset and dimension filenames use camelCase of the source table name |
| `--camel-case-measures` | No | `false` | When `true`, metric labels use camelCase of the source column name |

**Output layout:**

```
<output-dir>/
  catalog.yml
  connections/<connectionName>.yml
  datasets/<table>.yml
  dimensions/<dimension>.yml
  metrics/<metric>.yml
  models/<modelName>.yml
```

---

### `generate-sml-from-ddl`

[↑ Table of Contents](#table-of-contents)

Parses a SQL DDL file (`CREATE TABLE` / `CREATE VIEW` statements) and generates AtScale SML files without a live database connection. Useful for offline model generation and CI pipelines.

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

| Parameter | Required | Default | Description |
|---|---|---|---|
| `--ddl-file` | Yes | | Path to the SQL DDL file |
| `--model-name` | No | DDL filename stem | Name for the generated semantic model |
| `--output-dir` | Yes | | Directory to write SML files |
| `--connection-name` | No | `my_connection` | Connection name to embed in SML files |
| `--catalog-name` | No | `model-name` | Display name for the generated catalog |
| `--schema` | No | | Filter DDL to only tables in this schema |
| `--database` | No | | Database name to embed in the SML connection file |
| `--dialect` | No | Auto-detected from filename | Database dialect (`snowflake`, `postgresql`). When `snowflake`, dataset table names are uppercased. |
| `--pii-severity` | No | `MEDIUM` | Minimum PII severity to exclude: `HIGH`, `MEDIUM`, `LOW`, or `none` |
| `--fact-tables` | No | Auto-detected | Comma-separated table names to treat as facts, overriding automatic classification |
| `--camel-case-files` | No | `false` | When `true`, dataset and dimension filenames use camelCase of the source table name |
| `--camel-case-measures` | No | `false` | When `true`, metric labels use camelCase of the source column name |

**Output layout:** Same as `generate-sml-from-connection`.

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
| `--tables` | No | All tables | Comma-separated table names or wildcard patterns (`*` = any chars, `?` = one char). Matching is case-insensitive. |
| `--output-file` | No | stdout | Output path for the DDL |

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
- **`systems.properties`** — the Gatling project config file; connection details and model list are read automatically

```bash
# Using a connections.yaml file
./atscale-utils extract-queries-from-atscale \
  --connection-file "./connections.yaml" \
  --connection-name "ats_postgres" \
  --models "SalesModel,InventoryModel" \
  --days 60 \
  --protocol all \
  --output-dir "./queries"

# Using a Gatling systems.properties file
./atscale-utils extract-queries-from-atscale \
  --connection-file "./systems.properties" \
  --models "SalesModel"
```

| Parameter | Required | Default | Description |
|---|---|---|---|
| `--connection-file` | Yes | | Path to `connections.yaml` or a Gatling `systems.properties` file |
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

Each file is a JSON array of query records with fields: `queryName`, `queryLanguage`, `inboundText`, `inboundTextAsHash` (SHA-256), `outboundText`, `cubeName`, `projectId`, `aggregateUsed`, `numTimes`, `elapsedTimeInSeconds`, `avgResultSetSize`, `atscaleQueryId`.

The `connections.yaml` entry must have a `sql:` block with `dialect: postgres` pointing at the AtScale Postgres backend (typically port `25432`, database `atscale`).

---

### `execute-atscale-query-harness`

[↑ Table of Contents](#table-of-contents)

Replays extracted queries against a live AtScale instance, measuring response time and row count for each query. Supports SQL and XMLA/MDX protocols, concurrent workers, throttling, and both one-pass and timed-duration run modes. Output is a CSV suitable for performance analysis.

Supports three input modes:
- **`--query-file`** — JSON file produced by `extract-queries-from-atscale`
- **`--ingest-file`** — Gatling-style CSV (`sampler_name,sql_text` or `sampler_name,atscale_query_id,sql_text`)
- **`--task-file`** — Gatling executor task YAML/JSON (runs all tasks sequentially, inferring protocol from `simulationClass`)

Supports two connection config formats: `connections.yaml` or Gatling `systems.properties`.

```bash
# Direct mode — XMLA queries from a JSON file
./atscale-utils execute-atscale-query-harness \
  --connection-file "./connections.yaml" \
  --connection-name "ats_connection" \
  --query-file "./queries/SalesModel_xmla_queries.json" \
  --protocol xmla \
  --concurrent-users 5 \
  --output-dir "./run_results"

# Direct mode — SQL queries from a Gatling ingest CSV
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

# Task-file mode — run all Gatling executor tasks from a YAML file
./atscale-utils execute-atscale-query-harness \
  --connection-file "./systems.properties" \
  --connection-name "SalesModel" \
  --task-file "./executor_tasks/tasks.yaml"
```

| Parameter | Required | Default | Description |
|---|---|---|---|
| `--connection-file` | Yes | | Path to `connections.yaml` or a Gatling `systems.properties` file |
| `--connection-name` | Yes | | Connection name (YAML mode) or model name (`.properties` mode) |
| `--query-file` | No | | JSON file from `extract-queries-from-atscale` |
| `--ingest-file` | No | | Gatling ingest CSV (`sampler_name,sql_text` or `sampler_name,atscale_query_id,sql_text`) |
| `--task-file` | No | | Gatling executor task YAML or JSON file |
| `--protocol` | No | `xmla` | Query protocol: `xmla` or `sql` (ignored in task-file mode) |
| `--concurrent-users` | No | `1` | Number of parallel workers (ignored in task-file mode) |
| `--throttle-ms` | No | `5` | Minimum milliseconds between query dispatches per worker |
| `--run-id` | No | | Label embedded in every output row; auto-generated if omitted |
| `--output-dir` | No | `run_results` | Directory to write the output CSV file |
| `--redact` | No | `false` | When `true`, omits `inbound_text` from log output |
| `--duration-minutes` | No | `0` | Run for this many minutes cycling the query list (0 = one pass) |

**Output CSV columns:** `run_id`, `task_name`, `model`, `query_name`, `atscale_query_id`, `protocol`, `status`, `duration_ms`, `row_count`, `error`, `timestamp`, `inbound_text_hash`

**Output filename:**
- Task-file mode: derived from `runLogFileName` in the task definition (`.log` → `.csv`)
- Direct mode: `{run-id}_{connection-name}.csv`

**Injection step compatibility (task-file mode):**

| Gatling step type | Behaviour |
|---|---|
| `AtOnceUsers`, `RampUsers`, `ConstantUsersPerSec`, `RampUsersPerSec` | One-pass — runs each query once with the specified concurrency |
| `ConstantConcurrentUsers`, `RampConcurrentUsers` | Timed loop — cycles the query list for `durationMinutes` |

---

### `generate-atscale-install-yaml`

[↑ Table of Contents](#table-of-contents)

Generates a Helm `values.yaml` for deploying AtScale on Kubernetes. Accepts a hostname for the ingress domain and optionally a pre-existing TLS certificate. If no certificate is supplied, a self-signed RSA-2048 / SHA-256 certificate is generated automatically for the provided hostname (valid 365 days).

The `tlsCrt` and `tlsKey` fields in the output are base64-encoded PEM strings — the PEM content is base64-encoded a second time, as required by the AtScale Helm chart.

```bash
# Generate with a self-signed certificate (auto-generated)
./atscale-utils generate-atscale-install-yaml \
  --hostname "atscale.example.com"

# Use an existing certificate
./atscale-utils generate-atscale-install-yaml \
  --hostname     "atscale.example.com" \
  --cert-file    "./tls.crt" \
  --key-file     "./tls.key" \
  --output-file  "./helm/values.yaml"
```

| Parameter | Required | Default | Description |
|---|---|---|---|
| `--hostname` | Yes | | FQDN or IP used as the ingress domain and certificate CN/SAN |
| `--cert-file` | No | | Path to an existing PEM certificate file |
| `--key-file` | No | | Path to an existing PEM private key file (required when `--cert-file` is set) |
| `--output-file` | No | `values.yaml` | Output path for the generated `values.yaml` |

**Output:** A `values.yaml` ready to pass to `helm install atscale ... --values values.yaml`.

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
    password: "@Scale800"

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
