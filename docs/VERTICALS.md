# Verticals Guide

This repository includes pre-built DDL schemas, SML semantic models, and analysis namespaces for 15 industry verticals. Each vertical is a complete, ready-to-use starting point for building BI reports on top of AtScale.

## Available Verticals

| Vertical | DDL | SML | Namespace |
|---|---|---|---|
| `education` | `resources/verticals/ddl/education.ddl.sql` | `resources/verticals/sml/education/` | `resources/namespaces/education/overview.yaml` |
| `energy-utilities` | `resources/verticals/ddl/energy-utilities.ddl.sql` | `resources/verticals/sml/energy-utilities/` | `resources/namespaces/energy-utilities/overview.yaml` |
| `financial-services` | `resources/verticals/ddl/financial-services.ddl.sql` | `resources/verticals/sml/financial-services/` | `resources/namespaces/financial-services/overview.yaml` |
| `government` | `resources/verticals/ddl/government.ddl.sql` | `resources/verticals/sml/government/` | `resources/namespaces/government/overview.yaml` |
| `healthcare` | `resources/verticals/ddl/healthcare.ddl.sql` | `resources/verticals/sml/healthcare/` | `resources/namespaces/healthcare/overview.yaml` |
| `human-resources` | `resources/verticals/ddl/human-resources.ddl.sql` | `resources/verticals/sml/human-resources/` | `resources/namespaces/human-resources/overview.yaml` |
| `insurance` | `resources/verticals/ddl/insurance.ddl.sql` | `resources/verticals/sml/insurance/` | `resources/namespaces/insurance/overview.yaml` |
| `logistics` | `resources/verticals/ddl/logistics.ddl.sql` | `resources/verticals/sml/logistics/` | `resources/namespaces/logistics/overview.yaml` |
| `manufacturing` | `resources/verticals/ddl/manufacturing.ddl.sql` | `resources/verticals/sml/manufacturing/` | `resources/namespaces/manufacturing/overview.yaml` |
| `media-advertising` | `resources/verticals/ddl/media-advertising.ddl.sql` | `resources/verticals/sml/media-advertising/` | `resources/namespaces/media-advertising/overview.yaml` |
| `pharma` | `resources/verticals/ddl/pharma.ddl.sql` | `resources/verticals/sml/pharma/` | `resources/namespaces/pharma/overview.yaml` |
| `real-estate` | `resources/verticals/ddl/real-estate.ddl.sql` | `resources/verticals/sml/real-estate/` | `resources/namespaces/real-estate/overview.yaml` |
| `retail-ecommerce` | `resources/verticals/ddl/retail-ecommerce.ddl.sql` | `resources/verticals/sml/retail-ecommerce/` | `resources/namespaces/retail-ecommerce/overview.yaml` |
| `telecom` | `resources/verticals/ddl/telecom.ddl.sql` | `resources/verticals/sml/telecom/` | `resources/namespaces/telecom/overview.yaml` |
| `travel-hospitality` | `resources/verticals/ddl/travel-hospitality.ddl.sql` | `resources/verticals/sml/travel-hospitality/` | `resources/namespaces/travel-hospitality/overview.yaml` |

Each DDL is a normalized star schema: a central `*_fact` table joined to 4–6 `dim_*` dimension tables via explicit foreign keys. The SML and namespace files were generated from those DDL files using the pipeline described below.

---

## Pipeline Overview

```
Step 1: Run DDL          → creates tables in your database
Step 2: Generate SML     → infers a semantic model from the schema
Step 3: Deploy to AtScale → uploads the SML project
Step 4: Extract model    → exports model metadata to model.yaml
Step 5: Generate namespace → auto-generates an analysis namespace
Step 6: Generate BI output → produces a Tableau, Excel, or Power BI file
```

Steps 2 and 4 each have two paths: **offline** (from DDL/SML files already in this repo) and **online** (from a live database or AtScale instance).

---

## Step 1 — Run the DDL

Execute the DDL for your chosen vertical against your database to create the schema. Replace `<vertical>` with one of the vertical names from the table above.

```bash
node dist/cli.js execute-sql-on-connection \
  --connection-file connections.yaml \
  --connection-name my_connection \
  --sql-file resources/verticals/ddl/<vertical>.ddl.sql
```

**Example — healthcare:**
```bash
node dist/cli.js execute-sql-on-connection \
  --connection-file connections.yaml \
  --connection-name my_connection \
  --sql-file resources/verticals/ddl/healthcare.ddl.sql
```

> The DDL creates dimension tables (`dim_*`) and a fact table (`*_fact`) with foreign key relationships. The tables are empty after creation — load your own data or use the schema as a template.

---

## Step 2 — Generate SML

Choose **one** of the two paths below.

### Path A — From DDL (offline, no database required)

Use this path when you want to regenerate or customise the SML without a live database connection. The pre-generated SML is already committed to `resources/verticals/sml/<vertical>/`.

```bash
node dist/cli.js generate-sml-from-ddl \
  --ddl-file resources/verticals/ddl/<vertical>.ddl.sql \
  --model-name <vertical> \
  --output-dir resources/verticals/sml/<vertical> \
  --connection-name my_connection
```

**Example — retail-ecommerce:**
```bash
node dist/cli.js generate-sml-from-ddl \
  --ddl-file resources/verticals/ddl/retail-ecommerce.ddl.sql \
  --model-name retail-ecommerce \
  --output-dir resources/verticals/sml/retail-ecommerce \
  --connection-name my_connection
```

Optional flags:

| Flag | Description |
|---|---|
| `--schema <name>` | Filter to a specific database schema |
| `--database <name>` | Database/catalog name to embed in the connection file |
| `--dialect snowflake` | Database dialect (uppercases table names for Snowflake) |
| `--pii-severity LOW` | Exclude columns at or above this PII risk level (`HIGH`, `MEDIUM`, `LOW`, `none`) |
| `--camel-case-files true` | Use camelCase filenames for datasets and dimensions |
| `--camel-case-measures true` | Use camelCase labels for metrics |

### Path B — From a live database (online)

Use this path when you want to generate SML by introspecting an existing database that already has the vertical schema loaded.

```bash
node dist/cli.js generate-sml-from-connection \
  --connection-file connections.yaml \
  --connection-name my_connection \
  --model-name <vertical> \
  --output-dir resources/verticals/sml/<vertical> \
  --schema PUBLIC
```

**Example — manufacturing:**
```bash
node dist/cli.js generate-sml-from-connection \
  --connection-file connections.yaml \
  --connection-name my_connection \
  --model-name manufacturing \
  --output-dir resources/verticals/sml/manufacturing \
  --schema PUBLIC
```

> Tables whose names end in `_fact` are automatically classified as fact tables. All other tables are classified as dimensions.

---

## Step 3 — Deploy SML to AtScale

Upload the generated SML directory to your AtScale instance using the AtScale CLI or UI.

**Using the AtScale CLI (`atscale-utils`):**
```bash
atscale-utils deploy \
  --sml-dir resources/verticals/sml/<vertical> \
  --connection-name my_connection
```

**Using the AtScale UI:**
1. Open your AtScale instance in a browser.
2. Navigate to **Projects → Import**.
3. Upload the contents of `resources/verticals/sml/<vertical>/`.
4. Confirm the connection mapping matches `my_connection` (or update `connections/<connection>.yml` before uploading).

> **Note:** The SML connection file embeds the connection name you passed in Step 2. If you need to change it, edit `resources/verticals/sml/<vertical>/connections/<connection>.yml` before deploying.

---

## Step 4 — Extract the Model

Extract the model metadata into a `model.yaml` file that the namespace and BI generators use. Choose the path that matches whether you have a live AtScale instance available.

### Path A — From SML files (offline)

Use this path when AtScale is not yet available or you want to stay fully offline.

```bash
node dist/cli.js extract-model-from-sml \
  --sml-dir resources/verticals/sml/<vertical> \
  --output-model-file model.yaml
```

**Example — government:**
```bash
node dist/cli.js extract-model-from-sml \
  --sml-dir resources/verticals/sml/government \
  --output-model-file model.yaml
```

### Path B — From a live AtScale instance (online)

Use this path after deploying to AtScale. It pulls the full model definition including any customisations made in the AtScale UI.

```bash
node dist/cli.js extract-model-from-atscale \
  --connection-file connections.yaml \
  --connection-name my_connection \
  --model <vertical> \
  --output-model-file model.yaml
```

**Example — financial-services:**
```bash
node dist/cli.js extract-model-from-atscale \
  --connection-file connections.yaml \
  --connection-name my_connection \
  --model financial-services \
  --output-model-file model.yaml
```

> The `model.yaml` produced by both paths is interchangeable — Step 5 and Step 6 work the same regardless of which path you used.

---

## Step 5 — Generate the Namespace

The namespace is the analysis definition that drives all BI output: it specifies which worksheets to create, which measures and dimensions to use, and how to lay them out in a dashboard. A pre-generated namespace is already committed for each vertical at `resources/namespaces/<vertical>/overview.yaml`.

To regenerate it (e.g. after customising the model):

```bash
node dist/cli.js generate-namespace-from-model \
  --model-file model.yaml \
  --output-file resources/namespaces/<vertical>/overview.yaml
```

**Example — telecom:**
```bash
node dist/cli.js generate-namespace-from-model \
  --model-file model.yaml \
  --output-file resources/namespaces/telecom/overview.yaml
```

Optional flags:

| Flag | Default | Description |
|---|---|---|
| `--title "My Title"` | `"<Model> Analysis"` | Workbook title shown in the BI tool |
| `--max-suggestions 20` | `25` | Maximum number of worksheets to generate |
| `--min-score 0.6` | `0.5` | Minimum relevance score (0–1) for a suggestion to be included |

> You can hand-edit the generated namespace YAML to rename worksheets, change chart types (`text`, `bar`, `line`), add or remove measures, or rearrange dashboard tiles before passing it to Step 6.

---

## Step 6 — Generate BI Output

Pass the namespace and model files to whichever BI generator you need. All three generators accept the same core inputs.

### Tableau

```bash
node dist/cli.js generate-tableau-from-namespace \
  --connection-file connections.yaml \
  --connection-name my_connection \
  --namespace-file resources/namespaces/<vertical>/overview.yaml \
  --model-file model.yaml \
  --target-file <vertical>.twb
```

**Example — logistics:**
```bash
node dist/cli.js generate-tableau-from-namespace \
  --connection-file connections.yaml \
  --connection-name my_connection \
  --namespace-file resources/namespaces/logistics/overview.yaml \
  --model-file model.yaml \
  --target-file logistics.twb
```

Open the resulting `.twb` in Tableau Desktop. It connects to AtScale via the MDX/SQL connection configured in `connections.yaml`.

### Excel

```bash
node dist/cli.js generate-excel-from-namespace \
  --connection-file connections.yaml \
  --connection-name my_connection \
  --namespace-file resources/namespaces/<vertical>/overview.yaml \
  --model-file model.yaml \
  --target-file <vertical>.xlsx
```

**Example — human-resources:**
```bash
node dist/cli.js generate-excel-from-namespace \
  --connection-file connections.yaml \
  --connection-name my_connection \
  --namespace-file resources/namespaces/human-resources/overview.yaml \
  --model-file model.yaml \
  --target-file human-resources.xlsx
```

Open in Excel and click **Data → Refresh All** to load live data from AtScale via XMLA/MDX. Each dashboard in the namespace becomes a sheet with charts and CUBE formula data sections.

### Power BI

```bash
node dist/cli.js generate-powerbi-from-namespace \
  --connection-file connections.yaml \
  --connection-name my_connection \
  --namespace-file resources/namespaces/<vertical>/overview.yaml \
  --model-file model.yaml \
  --target-folder <vertical>
```

**Example — insurance:**
```bash
node dist/cli.js generate-powerbi-from-namespace \
  --connection-file connections.yaml \
  --connection-name my_connection \
  --namespace-file resources/namespaces/insurance/overview.yaml \
  --model-file model.yaml \
  --target-folder insurance
```

This writes a `.pbip` project folder to `<vertical>/`. Open `<vertical>/<vertical>.pbip` in Power BI Desktop.

> **Power BI auth:** The connection must include a `token` field under the user entry in `connections.yaml`. Power BI uses token-based MDX authentication.

---

## Full Pipeline — Single Command Sequence

The complete sequence for a vertical from scratch, using offline paths (no live database or AtScale required):

```bash
VERTICAL=healthcare   # change to any vertical name

# Step 2A: generate SML from DDL
node dist/cli.js generate-sml-from-ddl \
  --ddl-file resources/verticals/ddl/${VERTICAL}.ddl.sql \
  --model-name ${VERTICAL} \
  --output-dir resources/verticals/sml/${VERTICAL} \
  --connection-name my_connection

# Step 4A: extract model from SML
node dist/cli.js extract-model-from-sml \
  --sml-dir resources/verticals/sml/${VERTICAL} \
  --output-model-file model.yaml

# Step 5: generate namespace
node dist/cli.js generate-namespace-from-model \
  --model-file model.yaml \
  --output-file resources/namespaces/${VERTICAL}/overview.yaml

# Step 6: generate BI output (pick one or all three)
node dist/cli.js generate-tableau-from-namespace \
  --connection-file connections.yaml \
  --connection-name my_connection \
  --namespace-file resources/namespaces/${VERTICAL}/overview.yaml \
  --model-file model.yaml \
  --target-file ${VERTICAL}.twb

node dist/cli.js generate-excel-from-namespace \
  --connection-file connections.yaml \
  --connection-name my_connection \
  --namespace-file resources/namespaces/${VERTICAL}/overview.yaml \
  --model-file model.yaml \
  --target-file ${VERTICAL}.xlsx

node dist/cli.js generate-powerbi-from-namespace \
  --connection-file connections.yaml \
  --connection-name my_connection \
  --namespace-file resources/namespaces/${VERTICAL}/overview.yaml \
  --model-file model.yaml \
  --target-folder ${VERTICAL}
```

---

## Using the Pre-Generated Artifacts

Steps 2–5 have already been run for all 15 verticals and the outputs are committed to this repository. If you only need to produce BI output for an existing vertical without modifying the schema or model, you can skip directly to Step 6 using the committed files:

```bash
VERTICAL=retail-ecommerce

node dist/cli.js generate-tableau-from-namespace \
  --connection-file connections.yaml \
  --connection-name my_connection \
  --namespace-file resources/namespaces/${VERTICAL}/overview.yaml \
  --model-file resources/verticals/sml/${VERTICAL}/models/${VERTICAL}.yml \
  --target-file ${VERTICAL}.twb
```

> When using the SML model file directly (rather than an extracted `model.yaml`), pass `--model-file` pointing to the `.yml` inside `resources/verticals/sml/<vertical>/models/`. Alternatively, run Step 4A first to produce a standalone `model.yaml`.
