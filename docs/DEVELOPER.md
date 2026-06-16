# Developer Guide

This document covers the CLI framework architecture, extending the tool with new operations and services, diagnostic operations, and the semantic model inference engine.

## Table of Contents

- [CLI Framework](#cli-framework)
  - [YAML on stdin](#yaml-on-stdin)
  - [Global parameters](#global-parameters)
- [Diagnostic Operations](#diagnostic-operations)
  - [`echo`](#echo)
  - [`echo-connection-metadata`](#echo-connection-metadata)
  - [`python-hello-world`](#python-hello-world)
- [Adding a New Service](#adding-a-new-service)
- [Adding a New Operation](#adding-a-new-operation)
  - [Parameter types](#parameter-types)
  - [Custom parameter validation](#custom-parameter-validation)
- [Python Operations](#python-operations)
- [GitHub Action](#github-action)
- [Semantic Model Inference Engine (`src/algorithm/`)](#semantic-model-inference-engine-srcalgorithm)
  - [Architecture overview](#architecture-overview)
  - [Inference pipeline (per dimension table)](#inference-pipeline-per-dimension-table)
  - [File reference](#file-reference)
  - [Using the inference engine directly](#using-the-inference-engine-directly)
  - [Detection threshold](#detection-threshold)
  - [Multiple verticals per table](#multiple-verticals-per-table)
  - [Diagnostics](#diagnostics)
  - [Replacing / removing a built-in plugin](#replacing--removing-a-built-in-plugin)
  - [Extending with a custom vertical plugin](#extending-with-a-custom-vertical-plugin)
    - [Option A — Extend `AbstractVerticalPlugin` (recommended)](#option-a--extend-abstractverticalplugin-recommended)
    - [Option B — Implement `InferencePlugin` directly](#option-b--implement-inferenceplugin-directly)
    - [Hierarchy level pattern tips](#hierarchy-level-pattern-tips)
  - [Built-in verticals](#built-in-verticals)
  - [AtScale SML output](#atscale-sml-output)
  - [DDL Reader](#ddl-reader)
  - [Analysis suggestions](#analysis-suggestions)
  - [PII and HIPAA column exclusion](#pii-and-hipaa-column-exclusion)
  - [Semantic model output reference](#semantic-model-output-reference)

---

## CLI Framework

### YAML on stdin

Any operation can be driven via YAML piped to stdin instead of CLI flags:

```bash
cat input.yml | ./atscale-utils
```

```yaml
operation: extract-model-from-atscale
parameters:
  model: sales-model
  connection-file: ./connection.yml
  connection-name: prod
  output-model-file: ./model.yml
```

### Global parameters

| Flag | Description |
|---|---|
| `--logfile <path>` | Write log output to a file |
| `--output <path>` | Write operation output to a file instead of stdout |
| `--verbose` | Enable verbose logging |

---

## Diagnostic Operations

### `echo`

Prints a message. Useful for verifying the CLI is wired up correctly.

```bash
./atscale-utils echo --message "hello"
```

### `echo-connection-metadata`

Connects to a database and echoes back its schema metadata. Useful for testing a connection definition.

```bash
./atscale-utils echo-connection-metadata \
  --connection-file "./connections.yaml" \
  --connection-name "snow_demo"

# Override schema at runtime
./atscale-utils echo-connection-metadata \
  --connection-file "./connections.yaml" \
  --connection-name "snow_demo" \
  --schema "RUN_LOG"
```

### `python-hello-world`

Reference operation that invokes a Python script via `PythonService`.

```bash
./atscale-utils python-hello-world --name "Alice"
# Hello, Alice!

./atscale-utils python-hello-world
# Hello, World!
```

---

## Adding a New Service

1. Create a service provider that extends `ServiceProvider`:

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

2. Register it in `buildServiceRegistry()`:

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

---

## Adding a New Operation

1. Create an operation and parameter set:

```ts
// src/operations/my-op/MyOperation.ts
import { Operation } from "../Operation.js";
import { ParameterSet, StringParameter } from "../Parameters.js";
import type { ServiceRegistry } from "../../services/registry.js";
import type { Logger } from "../../logging.js";

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

  constructor(services: ServiceRegistry, logger: Logger) {
    super(services, logger);
  }

  run(params: MyParams): void {
    this.logger.log(params.input);
  }
}
```

2. Register it in `buildRegistry()`:

```ts
// src/operations/index.ts
registry.register(new MyOperation(services, logger));
```

### Parameter types

| Type | Description |
|---|---|
| `StringParameter` | String value |
| `NumberParameter` | Numeric value |
| `BooleanParameter` | Boolean flag |

### Custom parameter validation

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

---

## Python Operations

Operations can invoke Python scripts via `PythonService`, which spawns `python3` and passes parameters as `--key value` CLI arguments.

1. Add a `.py` script next to your operation file (it will be copied to `dist/` automatically):

```python
# src/operations/my-op/my_script.py
import argparse
parser = argparse.ArgumentParser()
parser.add_argument("--input")
args = parser.parse_args()
print(f"Result: {args.input}")
```

2. Create the operation:

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

---

## GitHub Action

`action.yml` exposes the CLI as a reusable GitHub Action with two inputs:
- `operation` (required)
- `parameters` (optional JSON object string)

```yaml
- uses: your-org/ps-utils@v1
  with:
    operation: echo
    parameters: '{"message":"hello from action"}'
```

```yaml
- uses: your-org/ps-utils@v1
  with:
    operation: echo-connection-metadata
    parameters: '{"connection-file":"./connections.yaml","connection-name":"snow_demo"}'
```

---

## Semantic Model Inference Engine (`src/algorithm/`)

The inference engine backs the `generate-sml-from-connection` and `generate-sml-from-ddl` operations. It reads database metadata via a JDBC-style TypeScript interface and automatically proposes a dimensional semantic model — facts, dimensions, measures, hierarchies, and relationships.

### Architecture overview

```
semantic-model-builder.ts          ← orchestrator; call proposeSemanticModel() here
│
├── types.ts                    ← all shared interfaces and utility functions
├── hierarchy-inference.ts      ← generic hierarchy inference (indexes + naming)
├── attribute-inference.ts      ← _name / _description secondary attribute grouping
├── measure-inference.ts        ← column-name → aggregation rule table
│
└── inference/
    ├── plugin.ts               ← InferencePlugin interface (the extension contract)
    ├── base-plugin.ts          ← AbstractVerticalPlugin (convenience base class)
    ├── engine.ts               ← InferenceEngine (registry + orchestrator)
    ├── index.ts                ← public API + createDefaultEngine()
    └── verticals/
        ├── education.ts
        ├── energy-utilities.ts
        ├── financial-services.ts
        ├── government.ts
        ├── healthcare.ts
        ├── human-resources.ts
        ├── insurance.ts
        ├── logistics.ts
        ├── manufacturing.ts
        ├── media-advertising.ts
        ├── pharma.ts
        ├── real-estate.ts
        ├── retail-ecommerce.ts
        ├── telecom.ts
        └── travel-hospitality.ts
```

### Inference pipeline (per dimension table)

```
columns + indexes
      │
      ▼
1. Generic hierarchy inference (hierarchy-inference.ts)
   ├── Index-based        multi-column indexes → ordered levels
   ├── Known sequences    year/quarter/month, country/state/city, …
   ├── sub-prefix pairs   subcategory → category
   └── Shared-prefix      product_category + product_subcategory
      │
      ▼
2. Vertical detection (InferenceEngine.detectVerticals)
   └── All registered plugins run detect() → score [0,1]
       Only plugins ≥ detectionThreshold fire
      │
      ▼
3. Vertical hierarchy inference (active plugin(s))
   └── Plugin-specific sequences (e.g. GICS for finance, ICD for healthcare)
       Columns already used in step 1 are skipped
      │
      ▼
4. Attribute label grouping (attribute-inference.ts)
   └── category_name → label on category
       product_description → description on product_code
      │
      ▼
SemanticDimension { hierarchies, attributes (with labels) }
```

### File reference

| File | Purpose |
|---|---|
| `types.ts` | All TypeScript interfaces (`JdbcColumnMeta`, `SemanticModel`, `SemanticMeasure`, …) and shared utilities |
| `hierarchy-inference.ts` | Generic hierarchy inference: index-based, known domain sequences, sub-prefix pairing, shared-prefix grouping, date fallback |
| `attribute-inference.ts` | Groups columns ending in `_name`, `_description`, `_label`, `_title` as secondary labels on their parent attribute |
| `measure-inference.ts` | Maps column name patterns (cost, qty, rate, …) to appropriate aggregation sets (SUM/AVG/MIN/MAX) |
| `inference/plugin.ts` | `InferencePlugin` interface, `VerticalMatch`, `InferenceEngineOptions` |
| `inference/base-plugin.ts` | `AbstractVerticalPlugin` — extend this for new verticals |
| `inference/engine.ts` | `InferenceEngine` — manages plugins, runs detection, merges results |
| `inference/index.ts` | Re-exports everything; provides `createDefaultEngine()` |
| `inference/verticals/*.ts` | One file per built-in vertical |
| `pii-detection.ts` | PII and HIPAA column exclusion rules and scanner |
| `analysis-suggestions.ts` | Business analysis suggestion generator (pairs & tuples) |
| `sml-serializer.ts` | AtScale SML YAML serializer |
| `ddl-reader.ts` | DDL text → `JdbcDatabaseMetaData` implementation |
| `semantic-model-builder.ts` | Main entry point: `proposeSemanticModel()`, `printSemanticModel()` |

---

### Using the inference engine directly

```typescript
import { proposeSemanticModel, printSemanticModel } from "./semantic-model-builder";
import { createDefaultEngine } from "./inference";

// 1. Implement JdbcDatabaseMetaData for your driver
class MyPostgresMetaData implements JdbcDatabaseMetaData {
  async getTables(schema = "public") { /* query pg_tables */ }
  async getColumns(tableName: string) { /* query information_schema.columns */ }
  async getForeignKeys(tableName: string) { /* query information_schema.referential_constraints */ }
  async getIndexInfo(tableName: string) { /* query pg_indexes */ }
  async getViews(schema = "public") { /* query information_schema.views */ }
}

// 2. Create the engine (all built-in verticals)
const engine = createDefaultEngine();

// 3. Propose a model
const model = await proposeSemanticModel(
  new MyPostgresMetaData(),
  "SalesModel",
  { schemaPattern: "public", inferenceEngine: engine },
);

// 4. Inspect it
printSemanticModel(model);
```

Without an engine, only generic inference runs (index-based hierarchies, name-pattern hierarchies, column-name aggregations):

```typescript
const model = await proposeSemanticModel(db, "SimpleModel");
```

### Detection threshold

Controls how confident the engine must be before activating a vertical plugin. Expressed as a fraction [0, 1] of signal column matches.

```typescript
// Default: ~40% of signal patterns must match
const engine = createDefaultEngine({ detectionThreshold: 0.4 });

// More permissive
const engine = createDefaultEngine({ detectionThreshold: 0.2 });
```

### Multiple verticals per table

By default only the highest-scoring plugin fires. Set `allowMultipleVerticals: true` to activate all above-threshold plugins (useful for blended schemas):

```typescript
const engine = createDefaultEngine({ allowMultipleVerticals: true });
```

### Diagnostics

`engine.diagnose(columns)` returns every plugin's score regardless of threshold — useful for tuning:

```typescript
const scores = engine.diagnose(myColumns);
// [{ name: "Financial Services", score: 0.85 }, { name: "Healthcare", score: 0.07 }, …]
```

### Replacing / removing a built-in plugin

```typescript
const engine = createDefaultEngine()
  .replacePlugin("Financial Services", new MyFinancialPlugin());

const engine = createDefaultEngine().removePlugin("Telecommunications");
```

---

### Extending with a custom vertical plugin

#### Option A — Extend `AbstractVerticalPlugin` (recommended)

```typescript
// my-plugins/logistics.ts
import { AbstractVerticalPlugin, HierarchySequence } from "../inference/base-plugin";

export class LogisticsPlugin extends AbstractVerticalPlugin {
  readonly name = "Logistics";
  readonly description = "Freight, parcel, and last-mile delivery schemas.";

  protected readonly signalPatterns: RegExp[] = [
    /^tracking_number$|^pro_number$|^waybill_number$/,
    /^carrier_id$|^carrier_code$|^carrier_name$/,
    /^origin_zip$|^destination_zip$|^origin_postal$|^destination_postal$/,
    /^freight_class$|^nmfc_code$/,
    /^delivery_date$|^promised_date$|^actual_delivery$|^estimated_delivery$/,
    /^shipment_id$|^shipment_number$/,
    /^pod_date$|^proof_of_delivery$/,
    /^mode_of_transport$|^transport_mode$/,
  ];

  protected readonly detectionThreshold = 5;

  protected readonly verticalHierarchies: HierarchySequence[] = [
    {
      name: "Shipment Geography Hierarchy",
      levelPatterns: [
        /^origin_country$|^ship_from_country$/,
        /^origin_state$|^ship_from_state$/,
        /^origin_city$|^ship_from_city$/,
        /^origin_zip$|^ship_from_zip$|^origin_postal$/,
      ],
    },
    {
      name: "Carrier Service Hierarchy",
      levelPatterns: [
        /^carrier_id$|^carrier_code$|^carrier_name$/,
        /^service_type$|^service_level$|^service_code$/,
        /^mode_of_transport$|^transport_mode$/,
      ],
    },
  ];
}
```

Register it:

```typescript
import { createDefaultEngine } from "./inference";
import { LogisticsPlugin } from "./my-plugins/logistics";

const engine = createDefaultEngine().addPlugin(new LogisticsPlugin());
```

#### Option B — Implement `InferencePlugin` directly

Use when you need full control over detection (e.g. ML scores, external registry):

```typescript
import { InferencePlugin } from "../inference/plugin";
import { JdbcColumnMeta, SemanticHierarchy, SemanticMeasure } from "../types";

export class MLScoredPlugin implements InferencePlugin {
  readonly name = "ML-Scored Custom Vertical";
  readonly description = "Uses an external scoring service for detection.";

  detect(columns: JdbcColumnMeta[]): number {
    const names = columns.map((c) => c.columnName.toLowerCase()).join(" ");
    return myMLModel.predict(names);   // returns [0, 1]
  }

  inferHierarchies(columns: JdbcColumnMeta[]): SemanticHierarchy[] {
    return [];
  }

  inferMeasures(columns: JdbcColumnMeta[]): SemanticMeasure[] {
    return [];
  }
}
```

#### Hierarchy level pattern tips

- Patterns are tested against the **lowercased** column name with `RegExp.test()`.
- Anchor with `^`/`$` to avoid partial matches: `/^ticker$/` not `/ticker/`.
- Use `|` for aliases: `/^sku$|^sku_code$|^sku_number$/`.
- A hierarchy is only emitted when **≥ minLevels** (default: 2) patterns find a column.
- Columns already consumed by an earlier hierarchy are **not reused**.

---

### Built-in verticals

| Plugin | Key signals | Hierarchies |
|---|---|---|
| **Education** | student_id, course_id, enrollment_id, GPA, academic_year, district_id, grade_level | Academic Calendar, District, Course Taxonomy, Credential |
| **Energy / Utilities** | meter_id, consumption_kwh, rate_class, SAIDI, feeder_id, balancing_authority | Grid Topology, Service Territory, Customer Class, Energy Source, ISO Market, Interval Time |
| **Financial Services** | ticker, CUSIP, ISIN, SEDOL, FIGI, exchange_code, GICS codes | GICS Industry, Exchange Listing, Asset Class, Portfolio, SIC, Credit Rating |
| **Government** | fund_code, agency_code, program_code, CFDA number, appropriation, obligation | Budget Structure, Fund Type, Object Classification, Geography |
| **Healthcare** | MRN, NPI, ICD-10, CPT, NDC, DRG, encounter_id | Care Facility, ICD Diagnosis, CPT Procedure, Drug Taxonomy, Provider, DRG, Payer |
| **Human Resources** | employee_id, hire_date, job_code, pay_grade, cost_center, FTE | Organization, Job Classification, Compensation Band, Work Location, Recruiting Funnel |
| **Insurance** | policy_number, claim_id, premium, loss_ratio, combined_ratio, peril_code | Policy Lifecycle, Risk Classification, Claim Type, Distribution Channel |
| **Logistics** | shipment_id, tracking_number, SCAC code, BOL number, origin_zip, transit_days | Origin Geography, Destination Geography, Carrier Network, Warehouse |
| **Manufacturing / Supply Chain** | work_order, part_number, BOM, lot_number, plant_code, OEE | Facility, Product BOM, Supplier, Org Cost, Production Shift, Quality Classification |
| **Media / Advertising** | campaign_id, creative_id, insertion_order, CPM/ROAS, DMA | Campaign, Media Buy, Publisher Inventory, Media Channel, Audience, DMA Geography |
| **Pharma** | clinical_trial_id, compound_id, NDC, adverse_event_id, IND/NDA number, therapeutic_area | Compound Taxonomy, Clinical Phase, Regulatory Pathway, Manufacturing Site |
| **Real Estate** | APN, MLS number, DOM, cap_rate, NOI, price_per_sqft | Property Geography, Property Type, Commercial Portfolio, MLS Region, Brokerage |
| **Retail / E-Commerce** | SKU, UPC/EAN, store_number, promo_code, fiscal_week | Product Taxonomy, Store Geography, Promotion, Brand, Fiscal Calendar, Customer Segment |
| **Telecommunications** | MSISDN, IMSI, IMEI, cell_id, MCC/MNC, ARPU | Network Topology, Technology Generation, Subscriber Account, Product Plan, Coverage Geography, Roaming |
| **Travel / Hospitality** | reservation_id, check_in/out, rate_code, ADR, RevPAR, PNR | Hotel Portfolio, Revenue Management, Hotel Geography, Loyalty Program, Airline Network, Booking Lead Time |

---

### AtScale SML output

```typescript
import { proposeSemanticModel } from "./semantic-model-builder";
import { createDefaultEngine } from "./inference";
import * as fs from "fs/promises";
import * as path from "path";

const engine = createDefaultEngine();
const model = await proposeSemanticModel(db, "SalesModel", {
  inferenceEngine: engine,
  sml: { connectionName: "My Snowflake Connection" },
});

for (const [filePath, yaml] of model.sml!) {
  const fullPath = path.join("./sml-output", filePath);
  await fs.mkdir(path.dirname(fullPath), { recursive: true });
  await fs.writeFile(fullPath, yaml, "utf8");
}
```

**SML file layout:**

```
sml-output/
  catalog.yml
  connections/my-snowflake-connection.yml
  datasets/
    store_sales.yml
    dim_product.yml
  dimensions/
    product-dimension.yml
    date-dimension.yml
  metrics/
    m_revenue_sum.yml
    m_revenue_average.yml
  models/
    sales-model.yml
```

**SML object mapping:**

| SemanticModel concept | SML object |
|---|---|
| Fact / Dimension source table | `dataset` (one per table) |
| `SemanticDimension` | `dimension` with `level_attributes` + `hierarchies` |
| Hierarchy level | `level_attribute` with `key_columns`, `name_column`, optional `time_unit` |
| Secondary label (`_name`, `_description`) | `secondary_attributes` on the parent level_attribute |
| All non-system columns (when DDL/metadata available) | `secondary_attributes` on the hierarchy leaf level |
| `SemanticMeasure` | `metric` with `calculation_method` |
| `SemanticRelationship` | entry in `model.relationships` |
| Degenerate dimensions (no FK) | listed under `model.dimensions` |
| Time dimension | `dimension.type: time` + `time_unit` per level |

**Secondary attributes:**

When full column metadata is available (i.e., `SmlSerializerOptions.columnsByTable` is populated — always the case when using `generate-sml-from-connection` or `generate-sml-from-ddl`), every non-system column in a dimension's source table is emitted as a `secondary_attribute` on the leaf level of each hierarchy. This makes every column directly accessible in AtScale without needing a dedicated level_attribute entry.

Inclusion / exclusion rules:
- **Excluded**: columns matching system/ETL patterns (`au_*`, `source_create*`, `source_update*`, `qlik_last*`) — same patterns as `isSystemColumn()` in `attribute-inference.ts`
- **PK columns**: included but their `unique_name` receives a `_sa` suffix (e.g., `customer_key` → `customer_key_sa`) to avoid collision with the `level_attribute` of the same name that carries `is_unique_key: true`
- **All other columns**: emitted with `unique_name` equal to the column name, `contains_unique_names: false`, `is_unique_key: false`

Example (source table has columns `customer_key`, `customer_name`, `batch_id`, `au_created_by`):

```yaml
hierarchies:
  - unique_name: dim_customer_hierarchy
    label: Customer Hierarchy
    levels:
      - unique_name: customer_key
        visualize_in_bi_tool: false
        secondary_attributes:
          - unique_name: customer_key_sa      # PK → _sa suffix
            label: Customer Key
            contains_unique_names: false
            dataset: dim_customer
            is_unique_key: false
            key_columns: [customer_key]
            name_column: customer_key
          - unique_name: customer_name
            label: Customer Name
            contains_unique_names: false
            dataset: dim_customer
            is_unique_key: false
            key_columns: [customer_name]
            name_column: customer_name
          - unique_name: batch_id
            label: Batch Id
            contains_unique_names: false
            dataset: dim_customer
            is_unique_key: false
            key_columns: [batch_id]
            name_column: batch_id
          # au_created_by excluded (system column pattern)
```

The REPORT.md summary includes a **Secondary Attributes** count showing the total across all dimensions when column metadata is available.

**SML options:**

```typescript
sml: {
  connectionName: string;          // required — AtScale connection unique_name
  catalogName?: string;            // default: model name
  metricPrefix?: string;           // default "m_"  → "m_revenue_sum"
  levelAttributePrefix?: string;   // default "la_" → "la_year"
}
```

---

### DDL Reader

`DdlDatabaseMetaData` parses SQL DDL text into a `JdbcDatabaseMetaData` implementation for offline model generation.

```typescript
import { DdlDatabaseMetaData } from "./ddl-reader";

// From a file
const meta = await DdlDatabaseMetaData.fromFile("./schema.sql");

// From a string
const meta = DdlDatabaseMetaData.fromDdl(`
  CREATE TABLE dim_product (
    product_id   INTEGER      PRIMARY KEY,
    category     VARCHAR(50)  NOT NULL,
    subcategory  VARCHAR(50),
    product_name VARCHAR(200) NOT NULL
  );
  CREATE TABLE fact_sales (
    sale_id    BIGINT       PRIMARY KEY,
    product_id INTEGER      NOT NULL,
    revenue    DECIMAL(18,2),
    quantity   INTEGER,
    FOREIGN KEY (product_id) REFERENCES dim_product(product_id)
  );
`);
```

**Supported DDL constructs:**

| Construct | Notes |
|---|---|
| `CREATE TABLE` | Standard syntax; `IF NOT EXISTS`, `TEMPORARY` supported |
| `CREATE VIEW … AS` | `OR REPLACE`, `FORCE`, `MATERIALIZED` keywords stripped |
| `CREATE [UNIQUE] INDEX … ON table (cols)` | `CLUSTERED`, `NONCLUSTERED`, `HASHED` index types mapped |
| Column data types | Single-word and multi-word (e.g. `TIMESTAMP WITH TIME ZONE`) |
| `NOT NULL` | Sets `nullable: false` |
| `PRIMARY KEY` | Inline and table-level `CONSTRAINT … PRIMARY KEY (cols)` |
| `FOREIGN KEY … REFERENCES` | Single and compound keys; optional constraint name; inline in CREATE TABLE or via `ALTER TABLE … ADD CONSTRAINT … FOREIGN KEY` |
| `--` and `/* */` comments | Stripped before parsing |
| Multi-statement files | Statements split at `;` boundaries |

---

### Analysis suggestions

```typescript
// All defaults: up to 25 suggestions, pairs + tuples, relevance ≥ 0.5
const model = await proposeSemanticModel(db, "SalesModel", {
  inferenceEngine: engine,
  suggestions: true,
});

// Custom
const model = await proposeSemanticModel(db, "SalesModel", {
  inferenceEngine: engine,
  suggestions: {
    maxSuggestions: 10,
    includeTuples: false,
    minRelevanceScore: 0.75,
  },
});
```

**Suggestion types:**

| `analysisType` | When generated | Example |
|---|---|---|
| `trend` | Measure × time hierarchy | "Total Revenue Over Time" |
| `breakdown` | Measure × one non-time hierarchy | "Total Revenue by Product Category" |
| `comparison` | Measure × time + at least one other | "Total Revenue by Product Category Over Time" |
| `distribution` | Ratio/AVG measure × any hierarchy | "Average Conversion Rate by Channel" |
| `ranking` | Measure × 2+ non-time hierarchies | "Total Revenue by Product and Geography" |

**`generate-namespace-from-model` exposes this engine as a CLI operation.** It reads a `model.yaml` file, reconstructs a `SemanticModel` from its `mdx` and `sql` sections, calls `generateAnalysisSuggestions`, and emits a namespace YAML ready for `generate-tableau-from-namespace`.

Each `AnalysisSuggestion` maps to a worksheet:
- `trend` / `comparison` → `graphType: line`
- `breakdown` / `distribution` / `ranking` → `graphType: bar` (`ranking` also sets `limit: 10`)
- Up to six `graphType: text` scorecards are prepended from the model's measures

---

### PII and HIPAA column exclusion

Columns identified as PII or HIPAA PHI are automatically excluded from the semantic model.

| Severity | Examples | Excluded by default? |
|---|---|---|
| `HIGH` | SSN, MRN, email, card numbers, NPI | Yes |
| `MEDIUM` | IP address, coordinates, username, member_id | Yes (default) |
| `LOW` | gender, marital_status | No (default) |

```typescript
// Exclude HIGH + MEDIUM (default)
const model = await proposeSemanticModel(db, "Model", { piiExclusionSeverity: "MEDIUM" });

// Exclude everything including LOW
const model = await proposeSemanticModel(db, "Model", { piiExclusionSeverity: "LOW" });

// Only exclude HIGH
const model = await proposeSemanticModel(db, "Model", { piiExclusionSeverity: "HIGH" });

// Disable PII filtering entirely
const model = await proposeSemanticModel(db, "Model", { piiExclusionSeverity: false });
```

**Adding custom PII rules** — add an entry to `PII_RULES` in `pii-detection.ts`:

```typescript
{
  pattern: /^loyalty_barcode$|^loyalty_card_number$/,
  reason: "Loyalty card number linkable to an individual",
  severity: "HIGH",
  category: "PII",
},
```

Every excluded column produces a warning in `SemanticModel.warnings`:

```
[PHI HIGH] "patient"."mrn" excluded: HIPAA PHI: Medical Record Number (Safe Harbor #8)
[PII MEDIUM] "event"."ip_address" excluded: Network/device identifier linkable to an individual
```

---

### Semantic model output reference

```typescript
SemanticModel {
  name: string
  generatedAt: string            // ISO-8601
  facts: SemanticFact[]
  dimensions: SemanticDimension[]
  relationships: SemanticRelationship[]
  views: SemanticView[]
  warnings: string[]
  sml?: Map<string, string>      // relative path → YAML content
  suggestions: AnalysisSuggestion[]
}

SemanticFact {
  kind: "fact"
  name: string
  sourceTable: string
  primaryKey?: string
  measures: SemanticMeasure[]
  degenerateDimensions: SemanticAttribute[]
}

SemanticMeasure {
  name: string                   // e.g. "Total Cost", "Average Price"
  sourceColumn: string
  dataType: "integer" | "decimal"
  aggregation: "SUM" | "AVG" | "MIN" | "MAX" | "COUNT"
}

SemanticDimension {
  kind: "dimension"
  name: string
  sourceTable: string
  primaryKey: string
  hierarchies: SemanticHierarchy[]
  attributes: SemanticAttribute[]
}

SemanticHierarchy {
  name: string
  levels: Array<{ name: string; sourceColumn: string }>  // broadest → most granular
  sourceIndex?: string
}

SemanticAttribute {
  name: string
  sourceColumn: string
  dataType: SemanticDataType
  nullable: boolean
  labels?: SemanticLabel[]       // companion _name / _description columns
}
```
