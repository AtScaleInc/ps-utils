# Converting AtScale XML Projects to SML

This document describes the algorithm for converting an AtScale XML project file
(schema version `project_2_0`) into a set of AtScale SML YAML files compatible
with this toolkit.

## Background

The AtScale XML project format is the legacy representation produced by the
AtScale Design Center before SML was introduced. It encodes the same semantic
concepts — datasets, dimensions, hierarchies, levels, measures, and model
relationships — but uses a UUID-based indirection system that has no direct
parallel in SML. A conversion requires multi-pass resolution before any output
can be written.

### XML file structure

```
<schema name="ModelName" version="2">
  <attributes>           <!-- flat UUID registry for all attribute keys -->
  <dimensions>           <!-- shared dimensions (cross-cube) -->
  <data-sets>            <!-- physical/logical dataset definitions -->
  <cubes>
    <cube>
      <attributes>       <!-- keyed-attributes (levels) + measure attributes -->
      <dimensions>       <!-- cube-local dimensions -->
      <data-sets>        <!-- fact dataset references with logical mappings -->
    </cube>
  </cubes>
</schema>
```

### SML output structure

```
<output-dir>/
  catalog.yml
  connections/<connectionName>.yml
  datasets/<dataset>.yml      -- one per data-set
  dimensions/<dimension>.yml  -- one per dimension (shared and cube-local)
  metrics/<metric>.yml        -- one per measure
  models/<modelName>.yml      -- model with relationships
```

---

## The UUID indirection chain

Every level, join column, and sort attribute in the XML resolves through a
three-hop UUID chain. This chain must be fully resolved before any SML can
be emitted.

```
<level primary-attribute="UUID-A">
    → <keyed-attribute id="UUID-A" key-ref="UUID-B" name="LevelName">
        → <data-set><logical><key-ref id="UUID-B">
            → <column>PHYSICAL_COLUMN_NAME</column>
```

The same chain applies to secondary (sort/display) attributes:

```
<level><keyed-attribute-ref attribute-id="UUID-C">
    → <attribute-ref id="UUID-C">
        → <column>SORT_COLUMN_NAME</column>
```

---

## Phase 1 — Build UUID resolution maps

This is a two-pass scan over the entire XML document. No SML is written during
this phase.

### Pass 1a: collect key-ref and attribute-ref mappings from all datasets

For every `<data-set>`, scan its `<logical>` block:

```
<key-ref id="UUID" complete="true|false">
  <column>COL1</column>
  <column>COL2</column>   <!-- multiple columns = composite key -->
</key-ref>
```

Build:
- `keyMap[UUID] = { dataset: datasetName, columns: [COL1, COL2, ...], complete: bool }`

```
<attribute-ref id="UUID" complete="true|false">
  <column>COL</column>
</attribute-ref>
```

Build:
- `attrMap[UUID] = { dataset: datasetName, column: COL }`

The `complete` flag is used later in Phase 5 to infer join relationships:
`complete="true"` in a dimension dataset means that dataset owns the level's
key; `complete="false"` in the fact dataset means the fact contributes columns
to the join but the authoritative key lives elsewhere.

### Pass 1b: collect keyed-attribute definitions from cube and dimensions

For every `<keyed-attribute id="UUID" name="N" key-ref="KEY_UUID">` found in
both `<cube><attributes>` and any `<dimension>` block:

Build:
- `attrDef[UUID] = { name: N, caption, keyUUID: KEY_UUID, formatString, sortOrder, visible }`

After both passes the full resolution is:

```
levelUUID
  → attrDef[levelUUID].keyUUID
    → keyMap[keyUUID].columns     (physical key columns, may be composite)
  → attrDef[levelUUID].caption    (display label for the level)
  → attrDef[levelUUID].keyUUID
    → keyMap[keyUUID].dataset     (which dataset owns this level)
```

---

## Phase 2 — Emit datasets

For each `<data-set>`:

### Physical table datasets

```xml
<data-set name="FACT_DATASET">
  <physical>
    <table>
      <database>LAKE</database>
      <schema>ONESEARCH</schema>
      <name>FACT_DATASET</name>
    </table>
  </physical>
</data-set>
```

Emits:

```yaml
unique_name: FACT_DATASET
label: Fact Dataset
table:
  db: LAKE
  schema: ONESEARCH
  name: FACT_DATASET
```

### SQL query datasets

```xml
<data-set name="Bookability Date">
  <physical>
    <query>
      <sql>SELECT &#xA; Date AS Holiday_Start_Date&#xA; ...</sql>
    </query>
  </physical>
</data-set>
```

The SQL is HTML-entity-encoded. Unescape before embedding:

| Entity   | Replacement |
|----------|-------------|
| `&#xA;`  | newline     |
| `&#x9;`  | tab         |
| `&#39;`  | `'`         |
| `&amp;`  | `&`         |
| `&lt;`   | `<`         |
| `&gt;`   | `>`         |

Emits:

```yaml
unique_name: Bookability Date
label: Bookability Date
sql: |
  SELECT
    Date AS Holiday_Start_Date,
    YEAR(Date) AS Calendar_Year,
    ...
  FROM STAR.DIM.DIMDATE
  WHERE YEAR(Date) BETWEEN YEAR(CURRENT_DATE) - 1 AND YEAR(CURRENT_DATE) + 2
```

---

## Phase 3 — Emit dimensions

For each dimension (both schema-level shared dimensions and cube-local
dimensions), emit one YAML file per dimension.

For each `<hierarchy>`, for each `<level primary-attribute="UUID">`:

1. Resolve `UUID → attrDef → KEY_UUID → keyMap[KEY_UUID] → columns`
2. Single column → `name_column: COL`
3. Multiple columns → `key_columns: [C1, C2, ...]`
4. For each `<keyed-attribute-ref attribute-id="UUID2">` on the level (secondary
   attributes used for sorting or alternate display): resolve `UUID2 → attrMap →
   column` and emit as an additional `level_attribute` entry.

```yaml
unique_name: Property
label: Property
hierarchies:
  - unique_name: Property Hierarchy
    label: Property Hierarchy
    levels:
      - unique_name: Owner Group
        label: Owner Group
        level_attributes:
          - unique_name: Owner Group
            label: Owner Group
            name_column: OWNER_GROUP_NAME
            key_columns: [OWNER_GROUP_CODE, PARENT_BRAND]
      - unique_name: Owner
        label: Owner
        level_attributes:
          - unique_name: Owner
            label: Owner
            name_column: OWNER_NAME
            key_columns: [PARENT_BRAND, OWNER_CODE]
```

### Composite keys

When `keyMap[UUID].columns` contains more than one column, the XML is expressing
a composite (multi-column) level key. This is common in region hierarchies where
each level's key includes all ancestor columns:

```
Region 1:  [Region_1]
Region 2:  [Region_1, Region_2]
Region 3:  [Region_1, Region_2, Region_3]
```

All of these become `key_columns` arrays in the SML level attribute.

### Denormalised (in-fact) dimensions

If all `key-ref` entries for a dimension's levels resolve exclusively to
`complete="true"` entries in the **fact dataset's** logical section (i.e., no
separate dimension dataset owns any of the keys), the dimension is fully
denormalised into the fact table. In SML this is modelled as a dimension
referencing the fact dataset directly, with no relationship join needed.

Examples in this model: Geography - Destination, Contracting Brand, Length of
Stay, Tenure — all columns resolve to `FACT_DATASET`.

---

## Phase 4 — Emit metrics

For each `<attribute>` inside `<cube><attributes>` with a `<measure>` or
`<count-distinct>` type:

### Aggregation type mapping

| XML type | SML aggregation |
|----------|-----------------|
| `<measure><default-aggregation>SUM</default-aggregation>` | `sum` |
| `<measure><default-aggregation>AVG</default-aggregation>` | `avg` |
| `<measure><default-aggregation>MIN</default-aggregation>` | `min` |
| `<measure><default-aggregation>MAX</default-aggregation>` | `max` |
| `<measure><default-aggregation>COUNT</default-aggregation>` | `count` |
| `<count-distinct>` | `distinct count estimate` |

Use `distinct count estimate` rather than `distinct count` for AtScale
aggregation engine compatibility.

### Format string mapping

| XML format-string | SML format |
|-------------------|------------|
| `#,##0`           | `integer`  |
| `#,##0.00`        | `decimal:2` |
| `0%`              | `percent:0` |
| `#,##0.0%`        | `percent:1` |
| `$#,##0`          | `currency:0` |

### Output

```yaml
unique_name: Bookability
label: Bookability
folder: Exact holiday start date
aggregation: sum
format: integer
datasets:
  - dataset: FACT_DATASET
    column_name: UNIT_AVAILABILITY
```

The physical column backing the measure is resolved the same way as dimension
levels: the measure `<attribute>` in the cube carries a `key-ref` UUID that
resolves through `keyMap` to the column name.

---

## Phase 5 — Infer and emit relationships

The XML format contains no explicit join definitions. Relationships must be
reconstructed from the `complete` flags in the `<logical>` sections.

### Detection rule

A relationship between the fact dataset and a dimension dataset exists when the
same `key-ref` UUID appears in:
- The **dimension dataset's** `<logical>` block with `complete="true"` — the
  dimension dataset owns the key.
- The **fact dataset's** `<logical>` block with `complete="false"` — the fact
  provides the foreign key columns.

The join columns are those listed under that UUID's `<key-ref>` entries.

### Example relationship detection

```xml
<!-- In Bookability Date logical -->
<key-ref id="b434d939-..." complete="true">
  <column>HOLIDAY_START_DATE</column>
</key-ref>

<!-- In FACT_DATASET logical (fact) -->
<key-ref id="b434d939-..." complete="false">
  <column>HOLIDAY_START_DATE</column>
</key-ref>
```

→ Join: `FACT_DATASET.HOLIDAY_START_DATE =
Bookability_Date.HOLIDAY_START_DATE`

### Model output

```yaml
unique_name: Bookability
label: Bookability
relationships:
  - unique_name: Bookability_to_Bookability_Date
    from:
      dataset: FACT_DATASET
      join_columns: [HOLIDAY_START_DATE]
    to:
      dimension: Holiday Start Date
      dataset: Bookability Date
      join_columns: [HOLIDAY_START_DATE]
  - unique_name: Bookability_to_Arrival_Flexibility
    from:
      dataset: FACT_DATASET
      join_columns: [PROPERTYCODE, PARENT_BRAND]
    to:
      dimension: Flex
      dataset: Arrival Flexibility
      join_columns: [PROPERTYCODE, PARENT_BRAND]
dimensions:
  - unique_name: Reporting Date
  - unique_name: Geography - Destination
  - unique_name: Property
  - unique_name: Holiday Start Date
  - unique_name: Price and discount
  - unique_name: Flex
  - unique_name: Contracting Brand
  - unique_name: Length of Stay
  - unique_name: Tenure
  - unique_name: Achieved Trip Prior Commercial Year
```

---

## Phase 6 — Emit catalog and connection

### Connection

The XML connection placeholder `id="ATSCALE"` is not a real connection
definition. The converter must accept a connection name as an input parameter
and write it as the `data_source` reference in all datasets and the connection
file.

```yaml
# connections/<connectionName>.yml
unique_name: <connectionName>
label: <connectionName>
type: snowflake       # or postgresql, bigquery, etc. — supplied as a parameter
```

### Catalog

```yaml
# catalog.yml
unique_name: Bookability
label: Bookability
default_data_source: <connectionName>
```

---

## Known complications

### SQL unescaping

Two of the three datasets in the Bookability model use SQL query definitions
encoded with HTML entities. The `Bookability Date` query in particular is a
multi-line, multi-CTE statement. The unescaping step must run before the SQL
is written to the YAML block literal (`sql: |`), otherwise the YAML will
contain literal entity strings.

### Composite key ordering

When a `key-ref` returns multiple columns, their order in the XML is the key
order. Preserve it exactly — AtScale uses column order to distinguish composite
key members.

### Shared vs cube-local dimensions

The XML can define dimensions at two scopes:

- **Schema-level** (`<schema><dimensions>`) — shared across all cubes in the
  project. In the Bookability model: Property, Flex, Holiday Start Date, Price
  and discount.
- **Cube-level** (`<cube><dimensions>`) — local to one cube. In the Bookability
  model: Reporting Date, Geography - Destination, Contracting Brand, Length of
  Stay, Tenure, Achieved Trip Prior Commercial Year.

In SML, all dimensions are separate YAML files regardless of original scope.
Process both locations with identical logic.

### Calculated measures

If any `<attribute>` in the cube contains an `<expression>` child element
rather than a `<measure>` type, it is a calculated measure. These map to SML
metrics with a `formula:` field instead of `aggregation:` and `column_name:`.
The Bookability model does not contain calculated measures, but the algorithm
should handle them for general use.

### `filter-empty` values

XML hierarchies carry a `<filter-empty>` element with values `Yes` or `Always`.
- `Yes` → filter empty members from query results
- `Always` → always filter, even when explicitly selected

Map both to the SML `filter_empty` flag; note `Always` may require an
additional annotation depending on the target AtScale version.

### Invisible attributes

Attributes with `<visible>false</visible>` should be emitted as
`is_hidden_from_ui: true` in SML rather than omitted, so that the model
structure is fully preserved and visibility can be toggled without a re-import.

---

## Phase 7 — Calculated members

Schema-level calculated members are defined once and referenced by one or more
cubes.

### Schema-level definition

```xml
<calculated-members>
  <calculated-member id="UUID" name="Cancellation Rate" caption="Cancellation Rate"
      visible="true" folder="Cancellations">
    <formatting>
      <format-string>#,##0.0%</format-string>
      <!-- OR: <named-format>Percent</named-format> -->
    </formatting>
    <description>Cancellations as a percentage of total bookings</description>
    <expression>[Measures].[Cancellations] / [Measures].[Bookings]</expression>
    <mdx-aggregate-function>Aggregate</mdx-aggregate-function>
  </calculated-member>
</calculated-members>
```

The `<expression>` content is HTML-entity-encoded MDX (same escaping rules as
SQL datasets). Unescape before embedding.

### Cube-level reference

```xml
<cube>
  <calculated-members>
    <calculated-member-ref id="UUID" default="true"/>
  </calculated-members>
</cube>
```

`default="true"` indicates the member should be selected by default in client
tools. Map this to a `default: true` annotation if the target SML supports it;
otherwise include it as a comment.

### Named formats

Some calculated members use a named format instead of a format string:

| XML named-format | SML format |
|------------------|------------|
| `Percent`        | `percent:1` |
| `Standard`       | `decimal:2` |
| `Currency`       | `currency:0` |

### SML output

```yaml
unique_name: Cancellation Rate
label: Cancellation Rate
folder: Cancellations
formula: "[Measures].[Cancellations] / [Measures].[Bookings]"
format: percent:1
```

### MDX functions in scope

AtScale XML models commonly use the following MDX functions in calculated member
expressions; the converter should preserve them verbatim:
`IIF`, `CASE/WHEN/THEN/ELSE/END`, `PARALLELPERIOD`, `Aggregate`,
`PeriodsToDate`, `Lag`, `Ancestor`, `Descendants`, `CurrentMember`,
`prevmember`, `lastchild`, `firstchild`, `firstsibling`, `LEVEL_NUMBER`,
`member_caption`.

---

## Phase 8 — Time dimensions

### Detection

A dimension with `<dimension-type>Time</dimension-type>` is a time dimension.
Mark it with `type: time` in the SML dimension file.

### Level type mapping

Levels inside a time dimension carry a `<level-type>` element:

| XML level-type | SML level type |
|----------------|----------------|
| `TimeYears`    | `year`         |
| `TimeMonths`   | `month`        |
| `TimeDays`     | `day`          |
| `TimeWeeks`    | `week`         |

```yaml
unique_name: Date
label: Date
type: time
hierarchies:
  - unique_name: Date Hierarchy
    label: Date Hierarchy
    levels:
      - unique_name: Year
        label: Year
        level_type: year
        ...
      - unique_name: Month
        label: Month
        level_type: month
        ...
      - unique_name: Day
        label: Day
        level_type: day
        ...
```

---

## Phase 9 — Role-playing dimensions

The same dimension UUID can appear multiple times in a cube's dimension list
under different semantic names using the `<ref-path>` / `<ref-naming>` pattern.

### Detection

Inside a `<level primary-attribute="UUID">` or `<key-ref>` element:

```xml
<ref-path>
  <new-ref ref-id="DATASET_UUID" attribute-id="ATTR_UUID">
    <ref-naming>{0} Termination</ref-naming>
  </new-ref>
</ref-path>
```

The `{0}` placeholder is substituted with the base level or attribute name at
runtime. This creates a renamed alias of the referenced dimension.

### SML output

In SML, a role-playing dimension is expressed by including the same dimension
multiple times in the model's `dimensions` list, each with a distinct
`unique_name` alias:

```yaml
dimensions:
  - unique_name: Date                    # base instance
  - unique_name: Date Termination        # role-playing alias
    dimension: Date
```

Each alias must also have its own relationship entry in the model pointing from
the fact dataset's join columns to the role-specific columns.

---

## Additional complications discovered from corpus analysis

### `complete="partial"`

The `complete` attribute on `<key-ref>` can take three values:
- `"true"` — this dataset owns the key (authoritative)
- `"false"` — this dataset contributes foreign key columns for a join
- `"partial"` — this dataset holds a subset of key columns; the key is spread
  across multiple datasets (rare bridge-table pattern)

For the converter: treat `partial` similarly to `false` for join inference
purposes — the authoritative key is elsewhere.

### Column-level SQL expressions

Some datasets define computed columns inline rather than relying on SQL in the
physical query:

```xml
<attribute-ref id="UUID" complete="true">
  <column>
    <name>COMPUTED_COL</name>
    <sql>CONCAT(FIRST_NAME, ' ', LAST_NAME)</sql>
    <type>String</type>
  </column>
</attribute-ref>
```

When a `<column>` element contains `<name>`, `<sql>`, and `<type>` children
instead of a plain text column name, extract the `<name>` as the column
identifier for SML purposes. The `<sql>` expression is a design-time hint
and does not need to be emitted in SML output (the column name is sufficient).

### Dynamic default members

Hierarchies may carry a default member expression:

```xml
<default-member>
  <literal-member>[Date].[Date Hierarchy].[Year].&amp;[2024]</literal-member>
</default-member>
```

Unescape HTML entities, then emit as:

```yaml
default_member: "[Date].[Date Hierarchy].[Year].&[2024]"
```

If the target SML version does not support `default_member`, include it as a
comment.

### Multiple cubes per schema file

A single XML file may contain multiple `<cube>` elements under `<cubes>`:

```xml
<schema name="ProjectName" version="2">
  <cubes>
    <cube name="Cube A">...</cube>
    <cube name="Cube B">...</cube>
  </cubes>
</schema>
```

Each cube becomes a separate SML model file. Schema-level datasets, dimensions,
and calculated members are shared by all cubes. Process schema-level constructs
once, then iterate over each `<cube>` to emit its model file.

### Cube visibility

```xml
<cube>
  <properties>
    <visible>false</visible>
  </properties>
</cube>
```

Map to `is_hidden_from_ui: true` on the SML model, following the same
convention as invisible attributes.

### Level properties

#### `unique-in-parent`

```xml
<level unique-in-parent="true" primary-attribute="UUID">
```

Indicates members are unique within their parent. Map to:

```yaml
unique_members: true
```

#### `allowed-calculation-types`

```xml
<keyed-attribute allowed-calculation-types="...">
```

This controls which MDX calculations are permitted for the attribute. It is a
design-time constraint not represented in SML; skip during conversion.

#### `dimension-ref` in cube dimensions

```xml
<cube>
  <dimensions>
    <dimension-ref id="SHARED_DIM_UUID"/>
  </dimensions>
</cube>
```

This references a schema-level shared dimension. Resolve the UUID to the shared
dimension name and add it to the model's `dimensions` list as normal.

### Aggregates and preferred-aggregate-stores

```xml
<aggregates/>
<preferred-aggregate-stores/>
```

These are empty placeholder elements. Skip during conversion; they carry no
data needed for SML output.

### Design-time metadata (skip)

The following elements appear in XML files but contain only design-time
information that does not map to any SML field. Skip them entirely:

- `<modeler-metadata>` — canvas layout, node positions
- `<annotations>` — arbitrary key-value metadata added by the Design Center UI
- `<description>` on dimensions/hierarchies — no SML equivalent (preserve as
  a YAML comment if desired)
- `<allowed-calculation-types>` on keyed-attributes
- `<preferred-aggregate-stores>` — storage hints, not schema
