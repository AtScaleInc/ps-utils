# Operation CLI

CLI framework with typed operations, a service provider registry, and a GitHub Action wrapper.

## CLI Usage

```bash
npm install
npm run build
node dist/cli.js echo --message "hello"
```

YAML on stdin (no CLI args):

```bash
cat input.yml | node dist/cli.js
```

Example YAML:

```yaml
operation: extract-atscale-model
parameters:
  model: sales-model
  connection-file: ./connection.yml
  connection-name: prod
  output: ./model.yml
```

Example file you can pass to STDIN (e.g. `cat input.yml | node dist/cli.js`):

```yaml
operation: echo
parameters:
  message: "hello from stdin"
```

Global parameters:
- `--logfile <path>` Path to the output log file.
- `--output <path>` Path to the output file or empty for stdout.
- `--verbose <bool>` Flag set to use verbose logging.

## Quickstart

1. Add a new service provider in `src/services/` and register it in `src/services/index.ts`.
2. Add a new operation in `src/operations/` and register it in `src/operations/index.ts`.
3. Define or customize parameters in `src/operations/Parameters.ts`.

## Operations

Each operation defines a parameter set with typed parameters.

Example (`src/operations/EchoOperation.ts`):

```ts
class MessageParameter extends StringParameter {
  name = "message";
  description = "Message to echo";
  required = true;
}
```

Parameter types:
- `StringParameter`
- `NumberParameter`
- `BooleanParameter`

Example operation usage:

```bash
node dist/cli.js extract-atscale-model --model "sales-model" --connection-file "./connection.json" --connection-name "prod" --output "./model.json"
```

Note: for `extract-atscale-model`, `--output` writes to the specified file instead of stdout.

Example generate-tableau-from-namespace usage:

```bash
node dist/cli.js generate-tableau-from-namespace --namespace "sales" --connection-file "./connections.yaml" --model-file "./model.yaml" --connection-file-name "./connections.yaml" --model-file-name "./model.yaml" --tableau-version 2025 --target-file "./tableau.twb"
```

Example echo-connection-metadata usage:

```bash
node dist/cli.js echo-connection-metadata --connection-file "./example/connections.yaml" --connection-name "snow_demo"
```

Example echo-connection-metadata with schema override:

```bash
node dist/cli.js echo-connection-metadata --connection-file "./example/connections.yaml" --connection-name "snow_demo" --schema "RUN_LOG"
```

## Python Operations

Operations can run Python scripts via `PythonService`, which spawns `python3` and passes parameters as `--key value` CLI arguments.

### Reference operation

```bash
node dist/cli.js python-hello-world --name "Alice"
# Hello, Alice!

node dist/cli.js python-hello-world
# Hello, World!
```

### Extending with your own Python operation

1. Add a `.py` script next to your operation file (it will be copied to `dist/` automatically):

```python
# src/operations/my-op/my_script.py
import argparse
parser = argparse.ArgumentParser()
parser.add_argument("--input")
args = parser.parse_args()
print(f"Result: {args.input}")
```

2. Create the operation and call `PythonService.execute()`:

```ts
// src/operations/my-op/MyOperation.ts
import path from "path";
import { fileURLToPath } from "url";
import { Operation } from "../Operation.js";
import { ParameterSet, StringParameter } from "../Parameters.js";
import type { PythonService } from "../../services/PythonService.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

export class MyOperation extends Operation<{ input: string }> {
  name = "my-operation";
  description = "Run my Python script";
  parameters = new MyParameterSet();

  run(params: { input: string }): void {
    const python = this.services.get<PythonService>("python");
    const result = python.execute(path.join(__dirname, "my_script.py"), { input: params.input });
    if (result.exitCode !== 0) throw new Error(result.stderr);
    this.logger.log(result.stdout.trimEnd());
  }
}
```

3. Register it in `src/operations/index.ts`.

## Extract AtScale Model Workflow

The `extract-atscale-model` workflow (`.github/workflows/extract-atscale-model.yml`) runs manually from the Actions tab and extracts an AtScale model's metrics and attributes into a YAML file.

### Setup

Add a repository secret named `ATSCALE_CONNECTION_FILE` containing the full contents of your connection YAML file:

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
3. Once complete, download the extracted model from the **Artifacts** section of the run

### Example (calling from another workflow)

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
    node dist/cli.js extract-atscale-model \
      --model "sales-model" \
      --connection-file connection.yml \
      --connection-name "prod" \
      --output-model-file "model.yml"
```

## GitHub Action

`action.yml` exposes two inputs:
- `operation` (required)
- `parameters` (optional JSON object string)

Example:

```yaml
- uses: your-org/operation-cli@v1
  with:
    operation: echo
    parameters: '{"message":"hello from action"}'
```

Example (echo-connection-metadata):

```yaml
- uses: your-org/operation-cli@v1
  with:
    operation: echo-connection-metadata
    parameters: '{"connection-file":"./example/connections.yaml","connection-name":"snow_demo"}'
```

## How To

### Add a New Service

1. Create a service provider that extends `ServiceProvider`.

```ts
// src/services/MyService.ts
import { ServiceProvider } from "./ServiceProvider.js";

export class MyService extends ServiceProvider {
  name = "my-service";

  doWork(): string {
    return "ok";
  }
}
```

2. Register the service in `buildServiceRegistry()`.

```ts
// src/services/index.ts
import { MyService } from "./MyService.js";

export function buildServiceRegistry(): ServiceRegistry {
  const registry = new ServiceRegistry();
  registry.register(new MyService());
  return registry;
}
```

3. Consume it in an operation via DI:

```ts
const service = this.services.get<MyService>("my-service");
```

### Add a New Operation

1. Create an operation and parameter set.

```ts
// src/operations/MyOperation.ts
import { Operation } from "./Operation.js";
import { ParameterSet, StringParameter } from "./Parameters.js";
import type { ServiceRegistry } from "../services/registry.js";

class MyParameterSet extends ParameterSet {
  parameters = [
    new (class extends StringParameter {
      name = "input";
      description = "Input value";
      required = true;
    })(),
  ];
}

type MyParams = { input: string };

export class MyOperation extends Operation<MyParams> {
  name = "my-operation";
  description = "Example operation";
  parameters = new MyParameterSet();

  constructor(services: ServiceRegistry) {
    super(services);
  }

  run(params: MyParams): void {
    console.log(params.input);
  }
}
```

2. Register it in `buildRegistry()`.

```ts
// src/operations/index.ts
registry.register(new MyOperation(services));
```

### Configure Custom Parameters for an Operation

1. Extend a parameter type and override parsing/validation.

```ts
class PortParameter extends NumberParameter {
  name = "port";
  description = "Port number";
  required = false;
  defaultValue = 3000;

  validate(value: number): void {
    if (value < 1 || value > 65535) {
      throw new Error("port must be between 1 and 65535");
    }
  }
}
```

2. Add it to your `ParameterSet`.

```ts
class ServerParameterSet extends ParameterSet {
  parameters = [new PortParameter()];
}
```

## Connection YAML (`connections.yaml`)

Passed to operations via `--connection-file`. Contains user credentials and named connection definitions. The file has two top-level sections: `users` and `connections`.

> **Security:** Do not commit this file to source control. Add it to `.gitignore` or supply it via a CI secret.

### `users` section

Defines named credential sets referenced by connections. Two authentication methods are supported.

#### Password authentication (Postgres)

```yaml
users:
  <user_key>:
    username: <db_username>
    password: "<password>"
```

#### Key-pair authentication (Snowflake)

```yaml
users:
  <user_key>:
    username: <snowflake_login_email>
    privateKeyPath: resources/keys/snowflake_key.p8   # path to PKCS8 private key file
    privateKeyPassword: "<passphrase>"                 # leave empty string if unencrypted
    # Alternative: supply pre-encoded PKCS8 DER directly instead of a file
    privateKeyBase64: "<base64-der-pkcs8>"
```

### `connections` section

Each key is a named connection referenced by `--connection-name`.

```yaml
connections:
  <connection_name>:
    installer: true | false     # optional: marks this as an AtScale installer connection
    mdx:                        # optional: required for extract-atscale-model
      url: http://<atscale_host>
      user: <user_key>          # references a key in the users section
      organization_id: default
      catalog_name: <AtScale catalog name>
    sql:                        # required for Tableau generation and direct SQL queries
      dialect: postgres | snowflake
      ...                       # dialect-specific fields below
```

#### Postgres `sql` fields

| Field | Required | Description |
|---|---|---|
| `dialect` | Yes | Must be `postgres` |
| `server` | Yes | Hostname or IP of the Postgres server |
| `port` | Yes | Port number (e.g. `15432`) |
| `database` | Yes | Database name |
| `schema` | Yes | Schema name |
| `user` | Yes | Key from the `users` section |
| `libpath` | No | Path to JDBC driver JAR. Defaults to `resources/drivers/postgresql-42.7.3.jar` |

#### Snowflake `sql` fields

| Field | Required | Description |
|---|---|---|
| `dialect` | Yes | Must be `snowflake` |
| `account` | Yes | Snowflake account identifier (e.g. `da37161`) |
| `warehouse` | Yes | Warehouse name |
| `database` | Yes | Database name |
| `schema` | Yes | Schema name |
| `snowflake_user` | Yes | Key from the `users` section |
| `role` | No | Snowflake role (e.g. `SYSADMIN`) |
| `authenticator` | No | Authentication method (e.g. `snowflake`) |
| `libpath` | No | Path to JDBC driver JAR. Defaults to `resources/drivers/snowflake-jdbc-4.0.1.jar` |

### Full Postgres example

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

### Full Snowflake example

```yaml
users:
  snowflake_user:
    username: USER@EXAMPLE.COM
    privateKeyPath: resources/keys/snowflake_key.p8
    privateKeyPassword: ""

connections:
  snow_demo:
    installer: true
    sql:
      dialect: snowflake
      account: da37161
      warehouse: COMPUTE_WH
      database: MY_DATABASE
      schema: MY_SCHEMA
      role: SYSADMIN
      snowflake_user: snowflake_user
```

## Model YAML (`model.yaml`)

The model file is auto-generated by `extract-atscale-model` and describes one or more AtScale models. It has two parallel sections per model: `mdx` (for MDX query metadata) and `sql` (for SQL column metadata used by the Tableau generator).

### Top-level structure

```yaml
<ModelName>:           # Matches the AtScale model/cube name (e.g. "Telemetry")
  data_source: <connection-name>
  mdx:
    metrics: [...]
    attributes: {...}
  sql:
    table_name: <ModelName>
    columns: {...}
```

### `sql.columns` entry

Each key is the column's SQL name. This is what you reference in namespace YAML (`xAxis`, `yAxis`, `measures`, `colorField`, `filters[].field`).

```yaml
sql:
  columns:
    <column_name>:
      alias: false
      name: <column_name>
      data_type: <DATA_TYPE>   # See data types below
      label: <Human-readable label>
      description: ""
      role: measure | dimension
      type: quantitative | nominal | ordinal
      aggregation: sum | avg | min | max | count | countd  # measures only
      folder: ""
```

#### Supported `data_type` values

| `data_type` | Tableau type | Notes |
|---|---|---|
| `WSTR`, `STRING`, `BSTR`, `GUID` | string | Dimensions |
| `BOOL` | boolean | Dimensions |
| `INT1`–`INT8`, `INT_UNSIGNED1`–`INT_UNSIGNED8` | integer | Measures |
| `FLOAT32`, `FLOAT64` | real | Measures |
| `DATE_DOUBLE` | date | Use `role: dimension` |
| `DATETIME` | datetime | Dimensions; supports granularity in line charts |
| `DECIMAL`, `NUMERIC` | decimal/numeric | Measures |

> **Note:** `DATE_DOUBLE` columns must have `role: dimension` and `type: ordinal`. Setting them as measures will cause a Tableau warning.

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

The namespace file drives the Tableau workbook generator (`generate-tableau-from-namespace`). It defines worksheets and dashboards.

### Top-level structure

```yaml
version: 1
title: <Workbook title>
description: <Description>

worksheets:
  <worksheet_key>:
    ...

dashboards:
  <dashboard_key>:
    ...
```

### Worksheet definition

All worksheets require:

| Field | Type | Description |
|---|---|---|
| `title` | string | Worksheet display name in Tableau |
| `model` | string | Model name key from `model.yaml` |
| `graphType` | `bar` \| `line` \| `text` | Chart type |

#### `graphType: bar`

Horizontal bar chart. Rows = `yAxis` dimension, Columns = `xAxis` measure.

```yaml
my_bar_chart:
  title: Top 10 Users by Query Count
  model: Telemetry
  graphType: bar
  xAxis: m_query_id_count      # measure column (horizontal extent)
  yAxis: user_hash              # dimension column (bar labels)
  limit: 10                     # optional: top-N rows
  sortDirection: desc           # optional: asc | desc — natural sort on the yAxis dimension members
  colorField: service           # optional: dimension column for color encoding
  format: integer               # optional: integer | decimal:N | percent:N | currency:N
  filters:                      # optional
    - field: user_hash
      excludeNull: true
```

#### `graphType: line`

Time-series line chart.

```yaml
my_line_chart:
  title: Queries Over Time
  model: Telemetry
  graphType: line
  xAxis: query_hour             # typically a DATETIME dimension
  xAxisGranularity: week        # optional: day | week | month | quarter | year
  yAxis: m_query_id_count       # measure column (Y axis)
  colorField: service           # optional: dimension for color/series breakdown
  filters:
    - field: succeeded
      excludeNull: true
```

#### `graphType: text`

Single-number KPI scorecard or crosstab.

```yaml
my_kpi:
  title: Total Queries
  model: Telemetry
  graphType: text
  measures:                     # list of measure column names
    - m_query_id_count
  format: integer               # optional: integer | decimal:N | percent:N | currency:N
  description: Count of all queries
```

Or using `xAxis`/`yAxis` instead of `measures`:

```yaml
my_kpi:
  title: Total Queries
  model: Telemetry
  graphType: text
  xAxis: query_hour
  yAxis: m_query_id_count
  format: decimal:2
```

#### `filters` array

Each entry in `filters` adds a Tableau view filter to the worksheet.

```yaml
filters:
  - field: <column_name>        # must exist in model's sql.columns
    excludeNull: true           # if true, excludes null/blank members
```

### Dashboard definition

```yaml
dashboards:
  <dashboard_key>:
    title: <Dashboard title>
    description: <Description>

    size:
      width: 1800               # total pixel width
      height: 4900              # total pixel height
      hSegments: 3              # number of horizontal grid columns
      vSegments: 49             # number of vertical grid rows

    categoryHeaders:            # optional: full-width section header labels
      - label: "Summary Statistics"
        x: 0                    # grid column (0-based)
        y: 0                    # grid row (0-based)
        colSpan: 3
        rowSpan: 1

    tiles:
      - worksheet: <worksheet_key>
        x: 0                    # grid column (0-based)
        y: 1                    # grid row (0-based)
        colSpan: 1              # number of columns to span
        rowSpan: 2              # number of rows to span
        category: Summary Statistics   # optional label
```

The grid cell size is `width / hSegments` × `height / vSegments` pixels. `x + colSpan` must not exceed `hSegments`.

### Full example

See [`resources/namespaces/telemetry/overview.yaml`](resources/namespaces/telemetry/overview.yaml) for a complete working example with summary statistics, KPI line charts, and top-10 bar charts.
