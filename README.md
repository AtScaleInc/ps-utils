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

## SQL Connection YAML

Postgres example:

```yaml
users:
  admin:
    username: admin
    password: "@Scale800"

connections:
  ats_connection:
    sql:
      dialect: postgres
      # Optional. Defaults to resources/drivers/postgresql-42.7.3.jar
      libpath: ./resources/drivers/postgresql-42.7.3.jar
      server: class-i.training.atscale-se-demo.com
      port: 15432
      database: atscale
      schema: Telemetry
      user: admin
```

Snowflake example:

```yaml
users:
  snowflake_user:
    username: SNOWFLAKE_USER
    # Optional: pre-encoded PKCS8 DER base64 to bypass file parsing
    privateKeyBase64: "<base64-der-pkcs8>"
    privateKeyPath: /path/to/your/rsa_key.p8
    privateKeyPassword: "<your_passphrase>"

connections:
  snow_demo:
    sql:
      dialect: snowflake
      # Optional. Defaults to resources/drivers/snowflake-jdbc-4.0.1.jar
      libpath: ./resources/drivers/snowflake-jdbc-4.0.1.jar
      account: atscale-se-demo
      warehouse: COMPUTE_WH
      database: SNOWFLAKE_SAMPLE_DATA
      schema: TPCH_SF1
      role: SYSADMIN
      authenticator: snowflake
      snowflake_user: snowflake_user
```
