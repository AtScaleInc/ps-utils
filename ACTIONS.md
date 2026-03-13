# GitHub Actions Guide

This document describes how to run every CLI operation as a GitHub Actions workflow — either via the **composite action** (`action.yml`) bundled in this repository, as a standalone `workflow_dispatch` job with raw CLI steps, or as steps embedded in a larger pipeline.

## Table of Contents

- [Prerequisites](#prerequisites)
  - [Required secrets](#required-secrets)
  - [Using the composite action](#using-the-composite-action)
  - [Shared setup steps](#shared-setup-steps)
- [Operations](#operations)
  - [`execute-sql-on-connection`](#execute-sql-on-connection)
  - [`extract-model-from-atscale`](#extract-model-from-atscale)
  - [`extract-model-from-sml`](#extract-model-from-sml)
  - [`generate-namespace-from-model`](#generate-namespace-from-model)
  - [`generate-sml-from-connection`](#generate-sml-from-connection)
  - [`generate-sml-from-ddl`](#generate-sml-from-ddl)
  - [`generate-tableau-from-namespace`](#generate-tableau-from-namespace)
- [End-to-end pipelines](#end-to-end-pipelines)
  - [DDL → Tableau (fully offline)](#ddl--tableau-fully-offline)
  - [Database → Tableau](#database--tableau)
  - [AtScale → Tableau](#atscale--tableau)
  - [DDL → SML → AtScale → Tableau](#ddl--sml--atscale--tableau)
  - [SQL migration on every push](#sql-migration-on-every-push)

---

## Prerequisites

### Required secrets

Add secrets at **Settings → Secrets and variables → Actions → New repository secret**.

| Secret | Used by | Contents |
|---|---|---|
| `CONNECTIONS_FILE` | `extract-model-from-atscale`, `generate-sml-from-connection`, `generate-tableau-from-namespace`, `execute-sql-on-connection` | Full contents of your `connections.yaml` file |

A single `CONNECTIONS_FILE` secret can serve all operations because they all read from the same connections YAML format. See [Connection YAML](README.md#connection-yaml-connectionsyaml) for the full format reference.

> **Security:** Never commit `connections.yaml` to source control. Always supply it via a secret.

---

### Using the composite action

`action.yml` at the root of this repository is a GitHub [composite action](https://docs.github.com/en/actions/sharing-automations/creating-actions/creating-a-composite-action). It handles Node.js setup, dependency installation, build, and credential writing automatically.

```yaml
- uses: AtScaleInc/ps-template@main
  with:
    operation: extract-model-from-atscale
    connection-file: ${{ secrets.CONNECTIONS_FILE }}
    connection-name: my_connection
    model: MyModel
    output-model-file: model.yaml
```

The `operation` input is required. All other inputs are optional and operation-specific — see each operation section below for the full `with:` block.

---

### Shared setup steps

When **not** using the composite action, every workflow needs Node.js and a built CLI. Use these steps at the start of any job:

```yaml
- uses: actions/checkout@v4

- uses: actions/setup-node@v4
  with:
    node-version: 20
    cache: npm

- name: Install and build
  run: npm install && npm run build
```

When a connections file is needed, write it from the secret immediately after the build step:

```yaml
- name: Write connections file
  run: echo "${{ secrets.CONNECTIONS_FILE }}" > connections.yml
```

---

## Operations

### `extract-model-from-atscale`

Connects to a live AtScale instance via MDX and extracts a model's metrics and attributes into `model.yaml`.

**Requires:** `CONNECTIONS_FILE` secret with an `mdx:` block in the named connection.

#### Using the composite action

```yaml
- uses: AtScaleInc/ps-template@main
  with:
    operation: extract-model-from-atscale
    connection-file: ${{ secrets.CONNECTIONS_FILE }}
    connection-name: ats_connection
    model: Telemetry
    output-model-file: model.yaml
```

#### Standalone workflow

```yaml
# .github/workflows/extract-model-from-atscale.yml
name: Extract AtScale Model

on:
  workflow_dispatch:
    inputs:
      model:
        description: AtScale model identifier
        required: true
        type: string
      connection-name:
        description: Connection name within the connections file
        required: true
        type: string
      output-model-file:
        description: Output file path for the extracted model
        required: false
        type: string
        default: model.yml

jobs:
  extract:
    runs-on: ubuntu-latest
    steps:
      - uses: AtScaleInc/ps-template@main
        with:
          operation: extract-model-from-atscale
          connection-file: ${{ secrets.CONNECTIONS_FILE }}
          connection-name: ${{ inputs.connection-name }}
          model: ${{ inputs.model }}
          output-model-file: ${{ inputs.output-model-file }}

      - name: Upload model artifact
        uses: actions/upload-artifact@v4
        with:
          name: atscale-model
          path: ${{ inputs.output-model-file }}
```

#### As steps in another workflow

```yaml
- uses: AtScaleInc/ps-template@main
  with:
    operation: extract-model-from-atscale
    connection-file: ${{ secrets.CONNECTIONS_FILE }}
    connection-name: ats_connection
    model: Telemetry
    output-model-file: model.yaml
```

---

### `extract-model-from-sml`

Reads a local SML directory and outputs a `model.yaml` in the same format as `extract-model-from-atscale`. Use this when an SML directory is already present in the repository (e.g. committed or produced by a prior step) and no live AtScale connection is available.

**Requires:** No secrets if the SML directory is committed to the repo.

#### Using the composite action

```yaml
- uses: actions/checkout@v4

- uses: AtScaleInc/ps-template@main
  with:
    operation: extract-model-from-sml
    sml-dir: sml-output
    model-name: SalesModel        # optional — omit to use first model found
    output-model-file: model.yaml
```

#### Standalone workflow

```yaml
# .github/workflows/extract-model-from-sml.yml
name: Extract Model from SML

on:
  workflow_dispatch:
    inputs:
      sml-dir:
        description: Path to the SML directory in the repository
        required: true
        type: string
        default: sml-output
      model-name:
        description: Model name to extract (leave blank for first model found)
        required: false
        type: string
      output-model-file:
        description: Output path for model.yaml
        required: false
        type: string
        default: model.yml

jobs:
  extract:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4

      - uses: AtScaleInc/ps-template@main
        with:
          operation: extract-model-from-sml
          sml-dir: ${{ inputs.sml-dir }}
          model-name: ${{ inputs.model-name }}
          output-model-file: ${{ inputs.output-model-file }}

      - name: Upload model artifact
        uses: actions/upload-artifact@v4
        with:
          name: sml-model
          path: ${{ inputs.output-model-file }}
```

#### As steps in another workflow

```yaml
- uses: AtScaleInc/ps-template@main
  with:
    operation: extract-model-from-sml
    sml-dir: sml-output
    output-model-file: model.yaml
```

---

### `generate-namespace-from-model`

Reads a `model.yaml` file and auto-generates a namespace YAML using the analysis-suggestions engine. Each suggestion becomes a worksheet (`line`, `bar`, or `text`). The output is ready to pass directly to `generate-tableau-from-namespace`.

**Requires:** No secrets — only a `model.yaml` file produced by a prior step or committed to the repo.

#### Using the composite action

```yaml
- uses: actions/checkout@v4

- uses: AtScaleInc/ps-template@main
  with:
    operation: generate-namespace-from-model
    model-file: model.yaml
    title: "Sales Analytics"      # optional
    max-suggestions: "20"         # optional, default 25
    min-score: "0.5"              # optional, default 0.5
    output-file: namespace.yaml
```

#### Standalone workflow

```yaml
# .github/workflows/generate-namespace-from-model.yml
name: Generate Namespace from Model

on:
  workflow_dispatch:
    inputs:
      model-file:
        description: Path to the model.yaml file
        required: false
        type: string
        default: model.yml
      model-name:
        description: Model name to use (leave blank for first model in file)
        required: false
        type: string
      title:
        description: Workbook title (defaults to "<ModelName> Analysis")
        required: false
        type: string
      max-suggestions:
        description: Maximum number of analysis suggestions (default 25)
        required: false
        type: string
        default: "25"
      min-score:
        description: Minimum relevance score 0-1 (default 0.5)
        required: false
        type: string
        default: "0.5"
      output-file:
        description: Output path for the namespace YAML
        required: false
        type: string
        default: namespace.yml

jobs:
  generate:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4

      - uses: AtScaleInc/ps-template@main
        with:
          operation: generate-namespace-from-model
          model-file: ${{ inputs.model-file }}
          model-name: ${{ inputs.model-name }}
          title: ${{ inputs.title }}
          max-suggestions: ${{ inputs.max-suggestions }}
          min-score: ${{ inputs.min-score }}
          output-file: ${{ inputs.output-file }}

      - name: Upload namespace artifact
        uses: actions/upload-artifact@v4
        with:
          name: generated-namespace
          path: ${{ inputs.output-file }}
```

#### As steps in another workflow

```yaml
- uses: AtScaleInc/ps-template@main
  with:
    operation: generate-namespace-from-model
    model-file: model.yaml
    title: "Sales Analytics"
    max-suggestions: "20"
    output-file: namespace.yaml
```

---

### `execute-sql-on-connection`

Reads a SQL file, splits it into individual statements (handling string literals, quoted identifiers, and comments), and executes each one against a named database connection. Supports DDL, DML, and mixed files. Use `--dry-run true` to preview without executing, and `--on-error continue` to log failures and keep going.

**Requires:** `CONNECTIONS_FILE` secret with a `sql:` block in the named connection.

#### Using the composite action

```yaml
- uses: actions/checkout@v4

- uses: AtScaleInc/ps-template@main
  with:
    operation: execute-sql-on-connection
    connection-file: ${{ secrets.CONNECTIONS_FILE }}
    connection-name: snow_demo
    sql-file: migrations/001_init.sql
    on-error: stop
```

**Dry-run mode** (preview statements without executing):

```yaml
- uses: AtScaleInc/ps-template@main
  with:
    operation: execute-sql-on-connection
    connection-file: ${{ secrets.CONNECTIONS_FILE }}
    connection-name: snow_demo
    sql-file: migrations/001_init.sql
    dry-run: "true"
```

#### Standalone workflow

```yaml
# .github/workflows/execute-sql-on-connection.yml
name: Execute SQL on Connection

on:
  workflow_dispatch:
    inputs:
      sql-file:
        description: Path to the SQL file in the repository
        required: true
        type: string
      connection-name:
        description: Connection name within CONNECTIONS_FILE
        required: true
        type: string
      on-error:
        description: "Behaviour on failure: stop or continue"
        required: false
        type: string
        default: stop
      dry-run:
        description: Print statements without executing (true/false)
        required: false
        type: boolean
        default: false

jobs:
  execute:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4

      - uses: AtScaleInc/ps-template@main
        with:
          operation: execute-sql-on-connection
          connection-file: ${{ secrets.CONNECTIONS_FILE }}
          connection-name: ${{ inputs.connection-name }}
          sql-file: ${{ inputs.sql-file }}
          on-error: ${{ inputs.on-error }}
          dry-run: ${{ inputs.dry-run && 'true' || '' }}
```

#### Trigger automatically on SQL file changes

```yaml
on:
  push:
    paths:
      - 'migrations/**/*.sql'
```

#### As steps in another workflow

```yaml
- uses: AtScaleInc/ps-template@main
  with:
    operation: execute-sql-on-connection
    connection-file: ${{ secrets.CONNECTIONS_FILE }}
    connection-name: snow_demo
    sql-file: migrations/001_init.sql
    on-error: stop
```

---

### `generate-sml-from-connection`

Connects to a live database, introspects its schema, runs semantic model inference, and writes a complete SML directory.

**Requires:** `CONNECTIONS_FILE` secret with a `sql:` block in the named connection.

#### Using the composite action

```yaml
- uses: AtScaleInc/ps-template@main
  with:
    operation: generate-sml-from-connection
    connection-file: ${{ secrets.CONNECTIONS_FILE }}
    connection-name: snow_demo
    model-name: SalesModel
    output-dir: sml-output
    pii-severity: MEDIUM          # optional
    schema: PUBLIC                # optional
```

#### Standalone workflow

```yaml
# .github/workflows/generate-sml-from-connection.yml
name: Generate SML from Connection

on:
  workflow_dispatch:
    inputs:
      connection-name:
        description: Connection name within the connections file
        required: true
        type: string
      model-name:
        description: Name for the generated semantic model
        required: true
        type: string
      output-dir:
        description: Directory to write SML files
        required: false
        type: string
        default: sml-output
      schema:
        description: Override the database schema to introspect
        required: false
        type: string
      pii-severity:
        description: Minimum PII severity to exclude (HIGH, MEDIUM, LOW, none)
        required: false
        type: string
        default: MEDIUM

jobs:
  generate:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4

      - uses: AtScaleInc/ps-template@main
        with:
          operation: generate-sml-from-connection
          connection-file: ${{ secrets.CONNECTIONS_FILE }}
          connection-name: ${{ inputs.connection-name }}
          model-name: ${{ inputs.model-name }}
          output-dir: ${{ inputs.output-dir }}
          schema: ${{ inputs.schema }}
          pii-severity: ${{ inputs.pii-severity }}

      - name: Upload SML artifact
        uses: actions/upload-artifact@v4
        with:
          name: sml-output
          path: ${{ inputs.output-dir }}/

      - name: Commit SML files
        if: github.ref == 'refs/heads/main'
        run: |
          git config user.name  "github-actions[bot]"
          git config user.email "github-actions[bot]@users.noreply.github.com"
          git add "${{ inputs.output-dir }}"
          git diff --cached --quiet || git commit -m "chore: regenerate SML from ${{ inputs.connection-name }}"
          git push
```

#### As steps in another workflow

```yaml
- uses: AtScaleInc/ps-template@main
  with:
    operation: generate-sml-from-connection
    connection-file: ${{ secrets.CONNECTIONS_FILE }}
    connection-name: snow_demo
    model-name: SalesModel
    output-dir: sml-output
```

---

### `generate-sml-from-ddl`

Parses a SQL DDL file from the repository and generates SML files without a live database connection. No secrets required.

**Requires:** No secrets — the DDL file must be present in the repository.

#### Using the composite action

```yaml
- uses: actions/checkout@v4

- uses: AtScaleInc/ps-template@main
  with:
    operation: generate-sml-from-ddl
    ddl-file: schema/sales.sql
    model-name: SalesModel        # optional
    output-dir: sml-output
    connection-name: snow_demo    # optional — embedded in SML files
    pii-severity: MEDIUM          # optional
```

#### Standalone workflow

```yaml
# .github/workflows/generate-sml-from-ddl.yml
name: Generate SML from DDL

on:
  push:
    paths:
      - '**.sql'
  workflow_dispatch:
    inputs:
      ddl-file:
        description: Path to the SQL DDL file
        required: true
        type: string
      model-name:
        description: Name for the generated semantic model
        required: false
        type: string
      output-dir:
        description: Directory to write SML files
        required: false
        type: string
        default: sml-output
      connection-name:
        description: Connection name to embed in SML files
        required: false
        type: string
        default: my_connection
      pii-severity:
        description: Minimum PII severity to exclude (HIGH, MEDIUM, LOW, none)
        required: false
        type: string
        default: MEDIUM

jobs:
  generate:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4

      - uses: AtScaleInc/ps-template@main
        with:
          operation: generate-sml-from-ddl
          ddl-file: ${{ inputs.ddl-file }}
          model-name: ${{ inputs.model-name }}
          output-dir: ${{ inputs.output-dir }}
          connection-name: ${{ inputs.connection-name }}
          pii-severity: ${{ inputs.pii-severity }}

      - name: Upload SML artifact
        uses: actions/upload-artifact@v4
        with:
          name: sml-output
          path: ${{ inputs.output-dir }}/
```

#### On push to any `.sql` file (automatic trigger)

```yaml
on:
  push:
    paths:
      - '**.sql'
```

This triggers the workflow automatically whenever a DDL file is committed to the repository. Pair this with a commit step to keep the SML directory in sync with the schema.

#### As steps in another workflow

```yaml
- uses: AtScaleInc/ps-template@main
  with:
    operation: generate-sml-from-ddl
    ddl-file: schema/sales.sql
    model-name: SalesModel
    output-dir: sml-output
    connection-name: snow_demo
```

---

### `generate-tableau-from-namespace`

Generates a Tableau `.twb` workbook from a namespace YAML and a model YAML.

**Requires:** `CONNECTIONS_FILE` secret with a `sql:` block in the named connection.

#### Using the composite action

```yaml
- uses: actions/checkout@v4

- uses: AtScaleInc/ps-template@main
  with:
    operation: generate-tableau-from-namespace
    connection-file: ${{ secrets.CONNECTIONS_FILE }}
    connection-name: ats_connection
    namespace-file: namespace.yaml
    model-file: model.yaml
    tableau-version: "2025"       # optional, default 2025
    target-file: tableau.twb
```

#### Standalone workflow

```yaml
# .github/workflows/generate-tableau-from-namespace.yml
name: Generate Tableau Workbook

on:
  workflow_dispatch:
    inputs:
      namespace-file:
        description: Path to the namespace YAML file
        required: false
        type: string
        default: namespace.yml
      model-file:
        description: Path to the model YAML file
        required: false
        type: string
        default: model.yml
      connection-name:
        description: Connection name within the connections file
        required: false
        type: string
        default: default
      tableau-version:
        description: Target Tableau version (2025 or 2024)
        required: false
        type: string
        default: "2025"
      target-file:
        description: Output path for the Tableau workbook
        required: false
        type: string
        default: tableau.twb

jobs:
  generate:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4

      - uses: AtScaleInc/ps-template@main
        with:
          operation: generate-tableau-from-namespace
          connection-file: ${{ secrets.CONNECTIONS_FILE }}
          connection-name: ${{ inputs.connection-name }}
          namespace-file: ${{ inputs.namespace-file }}
          model-file: ${{ inputs.model-file }}
          tableau-version: ${{ inputs.tableau-version }}
          target-file: ${{ inputs.target-file }}

      - name: Upload Tableau workbook artifact
        uses: actions/upload-artifact@v4
        with:
          name: tableau-workbook
          path: ${{ inputs.target-file }}
```

#### As steps in another workflow

```yaml
- uses: AtScaleInc/ps-template@main
  with:
    operation: generate-tableau-from-namespace
    connection-file: ${{ secrets.CONNECTIONS_FILE }}
    connection-name: ats_connection
    namespace-file: namespace.yaml
    model-file: model.yaml
    target-file: tableau.twb
```

---

## End-to-end pipelines

The pipelines below use the composite action for each step. Each `uses: AtScaleInc/ps-template@main` call handles setup, install, and build internally — no separate setup steps are needed.

### DDL → Tableau (fully offline)

Takes a DDL file committed to the repository all the way to a Tableau workbook with no live connections or secrets required. Ideal for CI validation and offline model development.

```
schema.sql
  → generate-sml-from-ddl   → sml-output/
  → extract-model-from-sml  → model.yaml
  → generate-namespace-from-model → namespace.yaml
  → generate-tableau-from-namespace → tableau.twb
```

```yaml
# .github/workflows/ddl-to-tableau.yml
name: DDL to Tableau (Offline)

on:
  push:
    paths:
      - 'schema/**/*.sql'
  workflow_dispatch:
    inputs:
      ddl-file:
        description: Path to the DDL file
        required: false
        type: string
        default: schema/schema.sql
      model-name:
        description: Semantic model name
        required: false
        type: string
        default: MyModel
      connection-name:
        description: Connection name to embed in SML and workbook
        required: false
        type: string
        default: my_connection

jobs:
  build:
    runs-on: ubuntu-latest
    env:
      DDL_FILE:   ${{ inputs.ddl-file || 'schema/schema.sql' }}
      MODEL_NAME: ${{ inputs.model-name || 'MyModel' }}
      CONN_NAME:  ${{ inputs.connection-name || 'my_connection' }}

    steps:
      - uses: actions/checkout@v4

      - uses: AtScaleInc/ps-template@main
        with:
          operation: generate-sml-from-ddl
          ddl-file: ${{ env.DDL_FILE }}
          model-name: ${{ env.MODEL_NAME }}
          output-dir: sml-output
          connection-name: ${{ env.CONN_NAME }}

      - uses: AtScaleInc/ps-template@main
        with:
          operation: extract-model-from-sml
          sml-dir: sml-output
          output-model-file: model.yaml

      - uses: AtScaleInc/ps-template@main
        with:
          operation: generate-namespace-from-model
          model-file: model.yaml
          title: "${{ env.MODEL_NAME }} Analysis"
          output-file: namespace.yaml

      - uses: AtScaleInc/ps-template@main
        with:
          operation: generate-tableau-from-namespace
          connection-file: ${{ secrets.CONNECTIONS_FILE }}
          connection-name: ${{ env.CONN_NAME }}
          namespace-file: namespace.yaml
          model-file: model.yaml
          target-file: tableau.twb

      - name: Upload artifacts
        uses: actions/upload-artifact@v4
        with:
          name: tableau-package
          path: |
            model.yaml
            namespace.yaml
            tableau.twb
```

---

### Database → Tableau

Connects to a live database to introspect the schema, then generates a Tableau workbook. The `CONNECTIONS_FILE` secret must include a `sql:` block.

```
Database
  → generate-sml-from-connection → sml-output/
  → extract-model-from-sml       → model.yaml
  → generate-namespace-from-model → namespace.yaml
  → generate-tableau-from-namespace → tableau.twb
```

```yaml
# .github/workflows/database-to-tableau.yml
name: Database to Tableau

on:
  workflow_dispatch:
    inputs:
      connection-name:
        description: Connection name within CONNECTIONS_FILE
        required: true
        type: string
      model-name:
        description: Semantic model name
        required: true
        type: string

jobs:
  build:
    runs-on: ubuntu-latest
    steps:
      - uses: AtScaleInc/ps-template@main
        with:
          operation: generate-sml-from-connection
          connection-file: ${{ secrets.CONNECTIONS_FILE }}
          connection-name: ${{ inputs.connection-name }}
          model-name: ${{ inputs.model-name }}
          output-dir: sml-output

      - uses: AtScaleInc/ps-template@main
        with:
          operation: extract-model-from-sml
          sml-dir: sml-output
          output-model-file: model.yaml

      - uses: AtScaleInc/ps-template@main
        with:
          operation: generate-namespace-from-model
          model-file: model.yaml
          title: "${{ inputs.model-name }} Analysis"
          output-file: namespace.yaml

      - uses: AtScaleInc/ps-template@main
        with:
          operation: generate-tableau-from-namespace
          connection-file: ${{ secrets.CONNECTIONS_FILE }}
          connection-name: ${{ inputs.connection-name }}
          namespace-file: namespace.yaml
          model-file: model.yaml
          target-file: tableau.twb

      - name: Upload artifacts
        uses: actions/upload-artifact@v4
        with:
          name: tableau-package
          path: |
            model.yaml
            namespace.yaml
            tableau.twb
```

---

### AtScale → Tableau

Extracts the model directly from a live AtScale instance. The `CONNECTIONS_FILE` secret must include both an `mdx:` block (for extraction) and a `sql:` block (for workbook generation).

```
AtScale Instance
  → extract-model-from-atscale      → model.yaml
  → generate-namespace-from-model   → namespace.yaml
  → generate-tableau-from-namespace → tableau.twb
```

```yaml
# .github/workflows/atscale-to-tableau.yml
name: AtScale to Tableau

on:
  workflow_dispatch:
    inputs:
      model:
        description: AtScale model/cube name
        required: true
        type: string
      connection-name:
        description: Connection name within CONNECTIONS_FILE
        required: true
        type: string

jobs:
  build:
    runs-on: ubuntu-latest
    steps:
      - uses: AtScaleInc/ps-template@main
        with:
          operation: extract-model-from-atscale
          connection-file: ${{ secrets.CONNECTIONS_FILE }}
          connection-name: ${{ inputs.connection-name }}
          model: ${{ inputs.model }}
          output-model-file: model.yaml

      - uses: AtScaleInc/ps-template@main
        with:
          operation: generate-namespace-from-model
          model-file: model.yaml
          title: "${{ inputs.model }} Analysis"
          output-file: namespace.yaml

      - uses: AtScaleInc/ps-template@main
        with:
          operation: generate-tableau-from-namespace
          connection-file: ${{ secrets.CONNECTIONS_FILE }}
          connection-name: ${{ inputs.connection-name }}
          namespace-file: namespace.yaml
          model-file: model.yaml
          target-file: tableau.twb

      - name: Upload artifacts
        uses: actions/upload-artifact@v4
        with:
          name: tableau-package
          path: |
            model.yaml
            namespace.yaml
            tableau.twb
```

---

### DDL → SML → AtScale → Tableau

Full pipeline: generate SML from a DDL file, commit it, deploy to AtScale, then extract the live model and produce a workbook. The deploy step is a placeholder — fill in your AtScale deployment mechanism.

```
schema.sql
  → generate-sml-from-ddl        → sml-output/  (committed to repo)
  → [deploy sml-output to AtScale]
  → extract-model-from-atscale   → model.yaml
  → generate-namespace-from-model → namespace.yaml
  → generate-tableau-from-namespace → tableau.twb
```

```yaml
# .github/workflows/ddl-to-atscale-to-tableau.yml
name: DDL → AtScale → Tableau

on:
  workflow_dispatch:
    inputs:
      ddl-file:
        description: Path to the DDL file
        required: true
        type: string
      model-name:
        description: AtScale model/cube name
        required: true
        type: string
      connection-name:
        description: Connection name within CONNECTIONS_FILE
        required: true
        type: string

jobs:
  build:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4

      - uses: AtScaleInc/ps-template@main
        with:
          operation: generate-sml-from-ddl
          ddl-file: ${{ inputs.ddl-file }}
          model-name: ${{ inputs.model-name }}
          output-dir: sml-output
          connection-name: ${{ inputs.connection-name }}

      - name: Commit SML files
        run: |
          git config user.name  "github-actions[bot]"
          git config user.email "github-actions[bot]@users.noreply.github.com"
          git add sml-output
          git diff --cached --quiet || git commit -m "chore: regenerate SML from ${{ inputs.ddl-file }}"
          git push

      # Replace this step with your AtScale deployment process
      - name: Deploy SML to AtScale
        run: echo "Deploy sml-output/ to AtScale here"

      - uses: AtScaleInc/ps-template@main
        with:
          operation: extract-model-from-atscale
          connection-file: ${{ secrets.CONNECTIONS_FILE }}
          connection-name: ${{ inputs.connection-name }}
          model: ${{ inputs.model-name }}
          output-model-file: model.yaml

      - uses: AtScaleInc/ps-template@main
        with:
          operation: generate-namespace-from-model
          model-file: model.yaml
          title: "${{ inputs.model-name }} Analysis"
          output-file: namespace.yaml

      - uses: AtScaleInc/ps-template@main
        with:
          operation: generate-tableau-from-namespace
          connection-file: ${{ secrets.CONNECTIONS_FILE }}
          connection-name: ${{ inputs.connection-name }}
          namespace-file: namespace.yaml
          model-file: model.yaml
          target-file: tableau.twb

      - name: Upload artifacts
        uses: actions/upload-artifact@v4
        with:
          name: tableau-package
          path: |
            model.yaml
            namespace.yaml
            tableau.twb
```

---

### SQL migration on every push

Runs all changed SQL files in a `migrations/` directory against a target database whenever they are pushed, then regenerates the SML and Tableau workbook so the BI layer stays in sync with the schema.

```yaml
# .github/workflows/migrate-and-rebuild.yml
name: Migrate and Rebuild

on:
  push:
    paths:
      - 'migrations/**/*.sql'

jobs:
  migrate:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
        with:
          fetch-depth: 2   # needed to diff against previous commit

      - name: Execute changed migrations
        run: |
          git diff --name-only HEAD~1 HEAD -- 'migrations/**/*.sql' | sort | while read f; do
            echo "==> $f"
            # Run each changed file as a separate composite-action call is not
            # possible inside a loop, so we use the CLI directly here.
            # Install once outside the loop in a real workflow.
            node dist/cli.js execute-sql-on-connection \
              --sql-file "$f" \
              --connection-file connections.yml \
              --connection-name "${{ vars.CONNECTION_NAME }}" \
              --on-error stop
          done
        # Requires a prior build step; see note below.

  rebuild:
    needs: migrate
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4

      - uses: AtScaleInc/ps-template@main
        with:
          operation: generate-sml-from-connection
          connection-file: ${{ secrets.CONNECTIONS_FILE }}
          connection-name: ${{ vars.CONNECTION_NAME }}
          model-name: ${{ vars.MODEL_NAME }}
          output-dir: sml-output

      - uses: AtScaleInc/ps-template@main
        with:
          operation: extract-model-from-sml
          sml-dir: sml-output
          output-model-file: model.yaml

      - uses: AtScaleInc/ps-template@main
        with:
          operation: generate-namespace-from-model
          model-file: model.yaml
          title: "${{ vars.MODEL_NAME }} Analysis"
          output-file: namespace.yaml

      - uses: AtScaleInc/ps-template@main
        with:
          operation: generate-tableau-from-namespace
          connection-file: ${{ secrets.CONNECTIONS_FILE }}
          connection-name: ${{ vars.CONNECTION_NAME }}
          namespace-file: namespace.yaml
          model-file: model.yaml
          target-file: tableau.twb

      - name: Commit updated artifacts
        run: |
          git config user.name  "github-actions[bot]"
          git config user.email "github-actions[bot]@users.noreply.github.com"
          git add sml-output model.yaml namespace.yaml tableau.twb
          git diff --cached --quiet || git commit -m "chore: rebuild SML and workbook after migration"
          git push

      - name: Upload artifacts
        uses: actions/upload-artifact@v4
        with:
          name: rebuilt-package
          path: |
            model.yaml
            namespace.yaml
            tableau.twb
```

> **Note:** `vars.CONNECTION_NAME` and `vars.MODEL_NAME` are repository variables (not secrets). Set them at **Settings → Variables → Actions → New repository variable**.
>
> The `migrate` job's loop calls the CLI directly rather than via `uses: AtScaleInc/ps-template@main` because composite actions cannot be invoked inside a shell loop. For a single-file migration, replace the loop with a single `uses: AtScaleInc/ps-template@main` step using `operation: execute-sql-on-connection`.
