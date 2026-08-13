/**
 * Generate the SML JSON Schemas and TextMate injection grammar consumed by the
 * PS-Utils VS Code extension.
 *
 * Run after refreshing `resources/sml-reference/`:
 *   npm run generate:sml-schema
 *
 * This is called automatically by `npm run build`. Outputs:
 *   vscode-extension/media/sml-schema/<doc>.schema.json        (one per SML object type)
 *   vscode-extension/media/sml-schema/index.json               (object_type → schema map)
 *   vscode-extension/syntaxes/sml.injection.tmLanguage.json    (YAML injection grammar)
 *
 * Parsing lives in `sml-reference-parser.ts`; this file holds the *policy* — the
 * decisions the prose cannot supply, and the assertions that keep those decisions
 * honest across an upstream refresh.
 *
 * ## Why the tables below exist
 *
 * The upstream reference is hand-written prose and disagrees with itself in a
 * handful of places (its own mermaid diagrams are the cross-check). Rather than
 * paper over that with a permissive schema, every discrepancy is enumerated here
 * with a reason, and the generator fails if the real set stops matching:
 *
 * - `ARRAY_ITEMS`      — arrays whose element type prose never states
 * - `TYPE_OVERRIDES`   — properties whose documented type is demonstrably wrong
 * - `DROP_PROPERTIES`  — stale diagram-only properties that would mislead completion
 * - `EXPECTED_DIVERGENCE` — known prose/diagram mismatches, adopted as a union
 * - `REFERENCES`       — which properties are cross-file references, and to what
 *
 * A refresh that changes any of this fails the build with a diff of what moved,
 * so the schemas can never quietly drift from the specification.
 */
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import {
  crossCheckMermaid,
  isEnumerable,
  parseDoc,
  type Discrepancy,
  type SmlClass,
  type SmlDoc,
  type SmlProperty,
  type SmlType,
} from "./sml-reference-parser.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REFERENCE_DIR = path.resolve(__dirname, "../../resources/sml-reference");
const SCHEMA_OUT = path.resolve(__dirname, "../../vscode-extension/media/sml-schema");
const GRAMMAR_OUT = path.resolve(
  __dirname,
  "../../vscode-extension/syntaxes/sml.injection.tmLanguage.json",
);

const SCHEMA_BASE_URI = "https://atscale.com/schemas/sml";

// ──────────────────────────────────────────────────────────────────────────────
// The ten reference documents
// ──────────────────────────────────────────────────────────────────────────────

interface DocSpec {
  /** Basename in `resources/sml-reference/`, and of the emitted schema. */
  file: string;
  /** Root class name, where it differs from the H1 title. */
  rootClass?: string;
  /**
   * Value of the file's `object_type` discriminator. Undefined for `package`,
   * which has no `object_type` — it is matched by filename alone.
   */
  objectType?: string;
  /** Conventional directory for this object type, used for filename fallback matching. */
  directory?: string;
}

const DOCS: DocSpec[] = [
  { file: "catalog", objectType: "catalog" },
  { file: "connection", objectType: "connection", directory: "connections" },
  { file: "dataset", objectType: "dataset", directory: "datasets" },
  { file: "dimension", objectType: "dimension", directory: "dimensions" },
  { file: "metric", objectType: "metric", directory: "metrics" },
  // calculation.md documents `metric_calc` files; its root class is `MetricCalc`.
  { file: "calculation", rootClass: "MetricCalc", objectType: "metric_calc", directory: "calculations" },
  { file: "model", objectType: "model", directory: "models" },
  { file: "composite-model", rootClass: "CompositeModel", objectType: "composite_model", directory: "models" },
  { file: "row-security", rootClass: "RowSecurity", objectType: "row_security" },
  { file: "package", rootClass: "Packages" },
];

// ──────────────────────────────────────────────────────────────────────────────
// Policy tables
// ──────────────────────────────────────────────────────────────────────────────

/**
 * Element types for arrays that prose declares only as `array`, and whose doc has
 * no mermaid `Array~T~` declaration to fill the gap. Keyed `<doc>:<Class>.<prop>`.
 *
 * The generator asserts this table exactly covers the unbound arrays — a stale
 * entry or a new unbound array both fail the build.
 */
const ARRAY_ITEMS: Record<string, SmlType | { class: string } | { anyOf: SmlType[] }> = {
  // "A list of the metrics to include in the aggregate" — metric unique names.
  "composite-model:Aggregate.metrics": "string",
  // "Array values must be numbers between 0 and 1."
  "metric:Metric.custom_quantiles": "number",
  // Relationship names, but embedded dimensions are expressed as a nested list
  // building a path, so an element is either a name or a path of names.
  "metric:SemiAdditive.relationships": { anyOf: ["string", "array"] },
  // "The columns within the `dataset` that you want to use as join columns."
  "model:From.join_columns": "string",
};

/**
 * Properties whose documented type is wrong, with the evidence. Applied after
 * parsing; the generator asserts each entry actually changes something.
 */
const TYPE_OVERRIDES: Record<string, { type: SmlType; reason: string }> = {
  "dimension:SecondaryAttribute.sort_column": {
    type: "string",
    reason:
      "dimension.md types this as `array`, but the doc's own mermaid says `String`, " +
      "both sibling definitions (Alias.sort_column, LevelAttribute.sort_column) say " +
      "string, and src/algorithm/sml-serializer.ts declares `sort_column?: string`.",
  },
};

/**
 * Properties the reference marks `Required: Y` that demonstrably are not.
 *
 * A wrong `required` is the most damaging kind of error a schema of this sort can
 * carry: it puts an error squiggle on a correct file, with no way for the author
 * to satisfy it except by writing something untrue. Each entry needs evidence
 * that real, valid SML omits the property.
 */
const REQUIRED_OVERRIDES: Record<string, { required: false; reason: string }> = {
  "catalog:Catalog.hidden_models": {
    required: false,
    reason:
      "catalog.md marks this `Required: Y`, but it was `Added in v1.2`, so every catalog " +
      "predating it is valid without it, its own Use case bullet describes an opt-in deploy " +
      "optimisation, and src/algorithm/sml-serializer.ts does not emit it.",
  },
};

/**
 * Diagram-only properties that are stale rather than merely undocumented, and
 * would produce actively misleading completions if adopted.
 */
const DROP_PROPERTIES: Record<string, string> = {
  "model:From.columns":
    "Stale alias for `join_columns`. model.md's mermaid declares `Array~Column~ columns` " +
    "on `From`, but the prose, dimension.md's identical `From` class and " +
    "sml-serializer.ts all use `join_columns`.",
};

/**
 * Every known prose/diagram divergence, as `<doc>:<Class>.<prop> <kind>`.
 *
 * `missing-in-prose` properties are adopted from the diagram (the diagram is
 * evidence the engine supports them); `missing-in-mermaid` properties are kept
 * from prose. Both directions are recorded so that an upstream refresh which
 * fixes — or introduces — a divergence fails the build and gets a fresh decision.
 */
const EXPECTED_DIVERGENCE: Record<string, string> = {
  // calculation.md disagrees with itself: the prose section is
  // `mdx_aggregation_function`, the diagram says `mdx_aggregate_function`, and
  // src/operations/generate-sml-docs/sml-docs-generator.ts reads the latter.
  // Both are emitted so neither spelling is flagged.
  "calculation:MetricCalc.mdx_aggregation_function missing-in-mermaid": "naming disagreement, both kept",
  "calculation:MetricCalc.mdx_aggregate_function missing-in-prose": "naming disagreement, both kept",

  "composite-model:CompositeModel.description missing-in-mermaid": "diagram omits a documented property",
  "composite-model:ModelReference.unique_name missing-in-prose": "class exists only in the diagram",

  "dataset:Dataset.alternate missing-in-prose": "undocumented property, adopted from the diagram",

  "dimension:MetricalAttribute.allowed_calcs_for_dma missing-in-prose":
    "documented for SecondaryAttribute and LevelAttribute but not MetricalAttribute",
  "dimension:LevelAttribute.custom_empty_member missing-in-prose":
    "documented for the three sibling attribute types but not LevelAttribute",

  "metric:Metric.custom_quantiles missing-in-mermaid": "diagram omits a documented property",
  "metric:SemiAdditive.relationships missing-in-mermaid": "diagram omits a documented property",
  "metric:SemiAdditive.degenerate_dimensions missing-in-mermaid": "diagram omits a documented property",

  "model:Model.dataset_properties missing-in-mermaid": "diagram omits a documented property",
  "model:Model.include_default_drillthrough missing-in-prose": "undocumented property, adopted from the diagram",
  "model:Relationship.type missing-in-prose":
    "documented only for dimension relationships; adopted from the diagram",
  "model:From.join_columns missing-in-mermaid": "see DROP_PROPERTIES['model:From.columns']",
  "model:AttributeReference.partition_rank missing-in-mermaid": "diagram spells these `partition`/`distribution`",
  "model:AttributeReference.distribution_rank missing-in-mermaid": "diagram spells these `partition`/`distribution`",
  "model:AttributeReference.relationships_path missing-in-prose": "undocumented property, adopted from the diagram",
};

/**
 * Keys the ps-utils toolchain emits that the specification does not document.
 * Recorded so a permissive schema does not silently absorb them.
 *
 * Emitted into `index.json` as the allowlist for the extension's unknown-key
 * linter (`vscode-extension/src/sml-unknown-keys-core.ts`), which reports keys the
 * schema cannot — since it is `additionalProperties: true` by design. Anything
 * added here stops warning; anything removed starts warning again.
 */
const KNOWN_UNDOCUMENTED: {
  key: string;
  /** Reference document the class belongs to, matching `DOCS[].file`. */
  doc: string;
  /** Class the key appears on. Scoping matters — see `is_unique_key` below. */
  class: string;
  where: string;
}[] = [
  {
    key: "visualize_in_bi_tool",
    doc: "dimension",
    class: "Level",
    where: "hierarchy level references, emitted by src/algorithm/sml-serializer.ts",
  },
  {
    key: "is_unique_key",
    doc: "dimension",
    class: "SecondaryAttribute",
    where:
      "secondary attributes, emitted by src/algorithm/sml-serializer.ts. " +
      "The reference documents this key on LevelAttribute and SharedDegenerateColumns " +
      "but not here, which is why the allowlist is scoped by class rather than by key",
  },
];

/**
 * Hold the allowlist to what it claims: each entry must name a class that exists
 * and must *not* already be documented on it.
 *
 * Without this the list only grows. When upstream finally documents one of these,
 * the schema starts carrying the property, the linter stops warning on it anyway,
 * and a stale entry silently suppresses real typos of that key from then on.
 */
function checkKnownUndocumented(parsed: Parsed[]): void {
  for (const gap of KNOWN_UNDOCUMENTED) {
    const doc = parsed.find((entry) => entry.spec.file === gap.doc)?.doc;
    if (!doc) {
      fail(`KNOWN_UNDOCUMENTED: no reference document named ${gap.doc}.md (key ${gap.key})`);
      continue;
    }
    const cls = doc.classes.get(gap.class);
    if (!cls) {
      fail(
        `KNOWN_UNDOCUMENTED: ${gap.doc}.md has no class ${gap.class} — ` +
          `the allowlist entry for \`${gap.key}\` can no longer match anything`,
      );
      continue;
    }
    if (cls.properties.has(gap.key)) {
      fail(
        `KNOWN_UNDOCUMENTED: ${gap.doc}.md now documents \`${gap.key}\` on ${gap.class}. ` +
          "Remove the entry — the schema covers it, and leaving it in would suppress " +
          "genuine typos of that key",
      );
    }
  }
}

/**
 * Cross-file reference annotations, keyed `<doc>:<Class>.<property>`.
 *
 * Emitted as a non-standard `x-sml-ref` keyword. Every JSON Schema validator
 * ignores unknown keywords, so these are inert for validation today and exist to
 * drive the reference resolver (workspace-wide `unique_name` checking, go-to
 * definition) without a second hand-maintained list of which keys are references.
 *
 * Shape:
 *   kind    what the value names (`dataset`, `dimension`, `column`, …)
 *   in      context needed to resolve it, as name → relative JSON pointer where a
 *           leading integer is levels up: `0/dataset` is a sibling key, `1/dataset`
 *           the parent object's key. `self` means the enclosing file's own object.
 *   on      `keys` when it is the object's *keys* that are references
 *   lenient `unique_name` or `label` may match
 */
interface RefSpec {
  kind: string;
  in?: Record<string, string>;
  on?: "keys";
  lenient?: boolean;
}

const COLUMN_IN_SIBLING_DATASET: RefSpec = { kind: "column", in: { dataset: "0/dataset" } };
const LEVEL_IN_SIBLING_DIMENSION: RefSpec = { kind: "level", in: { dimension: "0/dimension" } };

const REFERENCES: Record<string, RefSpec> = {
  // ── catalog ────────────────────────────────────────────────────────────────
  "catalog:Catalog.dataset_properties": { kind: "dataset", on: "keys" },
  // Prose says "models"; catalog.yml's own sample lists what look like labels
  // ("Supply Model"), so either identifier is accepted until upstream clarifies.
  "catalog:Catalog.hidden_models": { kind: "model", lenient: true },

  // ── dataset ────────────────────────────────────────────────────────────────
  "dataset:Dataset.connection_id": { kind: "connection" },
  // The incremental column lives in the dataset this file defines.
  "dataset:Incremental.column": { kind: "column", in: { dataset: "self" } },
  "dataset:Column.parent_column": { kind: "column", in: { dataset: "self" } },

  // ── metric ─────────────────────────────────────────────────────────────────
  "metric:Metric.dataset": { kind: "dataset" },
  "metric:Metric.column": COLUMN_IN_SIBLING_DATASET,
  "metric:SemiAdditive.relationships": { kind: "relationship" },
  "metric:SemiAdditiveDegenerateDimensions.name": { kind: "dimension" },
  "metric:SemiAdditiveDegenerateDimensions.level": { kind: "level", in: { dimension: "0/name" } },

  // ── dimension ──────────────────────────────────────────────────────────────
  "dimension:LevelAttribute.dataset": { kind: "dataset" },
  "dimension:LevelAttribute.name_column": COLUMN_IN_SIBLING_DATASET,
  "dimension:LevelAttribute.sort_column": COLUMN_IN_SIBLING_DATASET,
  "dimension:LevelAttribute.key_columns": COLUMN_IN_SIBLING_DATASET,
  "dimension:SecondaryAttribute.dataset": { kind: "dataset" },
  "dimension:SecondaryAttribute.name_column": COLUMN_IN_SIBLING_DATASET,
  "dimension:SecondaryAttribute.sort_column": COLUMN_IN_SIBLING_DATASET,
  "dimension:SecondaryAttribute.key_columns": COLUMN_IN_SIBLING_DATASET,
  "dimension:Alias.dataset": { kind: "dataset" },
  "dimension:Alias.name_column": COLUMN_IN_SIBLING_DATASET,
  "dimension:Alias.sort_column": COLUMN_IN_SIBLING_DATASET,
  "dimension:MetricalAttribute.dataset": { kind: "dataset" },
  "dimension:MetricalAttribute.column": COLUMN_IN_SIBLING_DATASET,
  "dimension:SharedDegenerateColumns.dataset": { kind: "dataset" },
  "dimension:SharedDegenerateColumns.name_column": COLUMN_IN_SIBLING_DATASET,
  "dimension:SharedDegenerateColumns.sort_column": COLUMN_IN_SIBLING_DATASET,
  "dimension:SharedDegenerateColumns.key_columns": COLUMN_IN_SIBLING_DATASET,
  "dimension:From.dataset": { kind: "dataset" },
  "dimension:From.join_columns": COLUMN_IN_SIBLING_DATASET,
  "dimension:From.hierarchy": { kind: "hierarchy", in: { dimension: "self" } },
  "dimension:From.level": { kind: "level", in: { hierarchy: "0/hierarchy" } },
  "dimension:To.dimension": { kind: "dimension" },
  "dimension:To.level": LEVEL_IN_SIBLING_DIMENSION,
  "dimension:To.row_security": { kind: "row_security" },
  "dimension:ParallelPeriods.level": { kind: "level", in: { dimension: "self" } },
  // A hierarchy level names a level attribute defined in the same dimension.
  "dimension:Level.unique_name": { kind: "level_attribute", in: { dimension: "self" } },
  "dimension:Level.secondary_attributes": { kind: "secondary_attribute", in: { dimension: "self" } },

  // ── model ──────────────────────────────────────────────────────────────────
  "model:Model.dimensions": { kind: "dimension" },
  "model:Model.dataset_properties": { kind: "dataset", on: "keys" },
  "model:ModelOverrides.query_name": { kind: "metric_or_dimension" },
  "model:From.dataset": { kind: "dataset" },
  "model:From.join_columns": COLUMN_IN_SIBLING_DATASET,
  "model:To.dimension": { kind: "dimension" },
  "model:To.level": LEVEL_IN_SIBLING_DIMENSION,
  "model:To.row_security": { kind: "row_security" },
  "model:ConstraintTranslation.level": { kind: "level" },
  "model:ConstraintTranslation.from_columns": { kind: "column", in: { dataset: "2/from/dataset" } },
  "model:MetricReference.unique_name": { kind: "metric_or_calculation" },
  "model:Perspective.metrics": { kind: "metric_or_calculation" },
  "model:PerspectiveDimension.name": { kind: "dimension" },
  "model:PerspectiveDimension.secondary_attributes": { kind: "secondary_attribute", in: { dimension: "0/name" } },
  "model:PerspectiveDimension.relationships_path": { kind: "relationship" },
  "model:PerspectiveHierarchy.name": { kind: "hierarchy", in: { dimension: "1/name" } },
  "model:PerspectiveHierarchy.level": { kind: "level", in: { hierarchy: "0/name" } },
  "model:PerspectiveHierarchy.levels": { kind: "level", in: { hierarchy: "0/name" } },
  "model:Drillthrough.metrics": { kind: "metric_or_calculation" },
  "model:AttributeReferenceDrillthrough.name": { kind: "attribute", in: { dimension: "0/dimension" } },
  "model:AttributeReferenceDrillthrough.dimension": { kind: "dimension" },
  "model:AttributeReferenceDrillthrough.relationships_path": { kind: "relationship" },
  "model:Aggregate.metrics": { kind: "metric_or_calculation" },
  "model:AttributeReference.name": { kind: "attribute", in: { dimension: "0/dimension" } },
  "model:AttributeReference.dimension": { kind: "dimension" },
  "model:AttributeReference.row_security": { kind: "row_security" },
  "model:AttributeReference.relationships_path": { kind: "relationship" },
  "model:Partition.dimension": { kind: "dimension" },
  "model:Partition.attribute": { kind: "attribute", in: { dimension: "0/dimension" } },

  // ── composite model ────────────────────────────────────────────────────────
  "composite-model:ModelReference.unique_name": { kind: "model" },
  "composite-model:MetricReference.unique_name": { kind: "metric_calc" },
  "composite-model:Aggregate.metrics": { kind: "metric_or_calculation" },
  "composite-model:AggregateAttributes.name": { kind: "attribute", in: { dimension: "0/dimension" } },
  "composite-model:AggregateAttributes.dimension": { kind: "dimension" },

  // ── row security ───────────────────────────────────────────────────────────
  "row-security:RowSecurity.dataset": { kind: "dataset" },
  "row-security:RowSecurity.filter_key_column": COLUMN_IN_SIBLING_DATASET,
  "row-security:RowSecurity.ids_column": COLUMN_IN_SIBLING_DATASET,
};

// ──────────────────────────────────────────────────────────────────────────────
// Failure collection
//
// Assertions accumulate so one run reports every drift at once, rather than
// making a refresh a game of fix-one-rerun.
// ──────────────────────────────────────────────────────────────────────────────

const failures: string[] = [];
const fail = (message: string) => failures.push(message);

// ──────────────────────────────────────────────────────────────────────────────
// Parse
// ──────────────────────────────────────────────────────────────────────────────

interface Parsed {
  spec: DocSpec;
  doc: SmlDoc;
}

const parsed: Parsed[] = [];

for (const spec of DOCS) {
  const file = path.join(REFERENCE_DIR, `${spec.file}.md`);
  if (!fs.existsSync(file)) {
    fail(`${spec.file}.md is missing from ${REFERENCE_DIR}`);
    continue;
  }
  try {
    const doc = parseDoc({
      file: spec.file,
      markdown: fs.readFileSync(file, "utf8"),
      rootClass: spec.rootClass,
    });
    parsed.push({ spec, doc });
  } catch (error) {
    fail(`${spec.file}.md: ${(error as Error).message}`);
  }
}

if (parsed.length !== DOCS.length) {
  reportAndExit();
}

// ── Apply overrides and drops, asserting each entry still bites ───────────────

const usedOverrides = new Set<string>();
const usedDrops = new Set<string>();
const usedRequired = new Set<string>();

for (const { spec, doc } of parsed) {
  for (const cls of doc.classes.values()) {
    for (const property of [...cls.properties.values()]) {
      const key = `${spec.file}:${cls.name}.${property.name}`;

      const drop = DROP_PROPERTIES[key];
      if (drop) {
        cls.properties.delete(property.name);
        usedDrops.add(key);
        continue;
      }

      const requiredOverride = REQUIRED_OVERRIDES[key];
      if (requiredOverride) {
        if (!property.required) {
          fail(`REQUIRED_OVERRIDES["${key}"] is stale — the docs no longer mark it required`);
        }
        property.required = requiredOverride.required;
        property.description = [property.description, `**Note:** ${requiredOverride.reason}`]
          .filter(Boolean)
          .join("\n\n");
        usedRequired.add(key);
      }

      const override = TYPE_OVERRIDES[key];
      if (override) {
        if (property.type === override.type) {
          fail(`TYPE_OVERRIDES["${key}"] is stale — the docs now already say ${override.type}`);
        }
        property.type = override.type;
        property.itemType = undefined;
        property.itemClass = undefined;
        property.description = [property.description, `**Note:** ${override.reason}`]
          .filter(Boolean)
          .join("\n\n");
        usedOverrides.add(key);
      }
    }
  }
}

for (const key of Object.keys(TYPE_OVERRIDES)) {
  if (!usedOverrides.has(key)) fail(`TYPE_OVERRIDES["${key}"] matched no property — stale entry`);
}
for (const key of Object.keys(DROP_PROPERTIES)) {
  if (!usedDrops.has(key)) fail(`DROP_PROPERTIES["${key}"] matched no property — stale entry`);
}
for (const key of Object.keys(REQUIRED_OVERRIDES)) {
  if (!usedRequired.has(key)) fail(`REQUIRED_OVERRIDES["${key}"] matched no property — stale entry`);
}

// ── Assert ARRAY_ITEMS exactly covers the unresolved arrays ───────────────────

const unboundArrays: string[] = [];
for (const { spec, doc } of parsed) {
  for (const cls of doc.classes.values()) {
    for (const property of cls.properties.values()) {
      if (property.type !== "array") continue;
      if (property.itemClass || property.itemType) continue;
      unboundArrays.push(`${spec.file}:${cls.name}.${property.name}`);
    }
  }
}

for (const key of unboundArrays) {
  if (!(key in ARRAY_ITEMS)) {
    fail(
      `array with no documented element type: ${key}\n` +
        `      Add an ARRAY_ITEMS entry naming the element type, with the prose that justifies it.`,
    );
  }
}
for (const key of Object.keys(ARRAY_ITEMS)) {
  if (!unboundArrays.includes(key)) {
    fail(`ARRAY_ITEMS["${key}"] is stale — that array now resolves on its own`);
  }
}

// ── Assert the prose/diagram divergence set is unchanged ──────────────────────

const divergences: { key: string; discrepancy: Discrepancy }[] = [];
for (const { spec, doc } of parsed) {
  for (const discrepancy of crossCheckMermaid(doc)) {
    divergences.push({
      key: `${spec.file}:${discrepancy.className}.${discrepancy.property} ${discrepancy.kind}`,
      discrepancy,
    });
  }
}

for (const { key } of divergences) {
  if (!(key in EXPECTED_DIVERGENCE)) {
    fail(
      `new prose/diagram divergence: ${key}\n` +
        `      The reference doc and its own mermaid diagram disagree. Decide which is right,\n` +
        `      then record it in EXPECTED_DIVERGENCE (or DROP_PROPERTIES / TYPE_OVERRIDES).`,
    );
  }
}
const seenDivergence = new Set(divergences.map((d) => d.key));
for (const key of Object.keys(EXPECTED_DIVERGENCE)) {
  if (!seenDivergence.has(key)) {
    fail(`EXPECTED_DIVERGENCE["${key}"] no longer occurs — upstream fixed it; drop the entry`);
  }
}

// ── Assert every REFERENCES entry points at a real property ───────────────────

for (const key of Object.keys(REFERENCES)) {
  const [file, rest] = key.split(":");
  const [className, propertyName] = rest.split(".");
  const doc = parsed.find((p) => p.spec.file === file)?.doc;
  if (!doc) {
    fail(`REFERENCES["${key}"] names unknown doc "${file}"`);
    continue;
  }
  const cls = doc.classes.get(className);
  if (!cls) {
    fail(`REFERENCES["${key}"] names unknown class "${className}" in ${file}.md`);
    continue;
  }
  if (!cls.properties.has(propertyName)) {
    fail(`REFERENCES["${key}"] names unknown property "${propertyName}" on ${className}`);
  }
}

if (failures.length > 0) reportAndExit();

// ──────────────────────────────────────────────────────────────────────────────
// JSON Schema emission
// ──────────────────────────────────────────────────────────────────────────────

type JsonSchema = Record<string, unknown>;

/** Compose a property's hover text from every documented fact about it. */
function describe(property: SmlProperty): string {
  const parts: string[] = [];
  if (property.description) parts.push(property.description);
  if (property.undocumented) {
    parts.push(
      "_Not described in the SML reference prose; adopted from the specification's own entity-relationship diagram._",
    );
  }
  if (property.requiredNote) parts.push(`**Required:** ${property.requiredNote}`);
  if (property.defaultValue) parts.push(`**Default:** \`${property.defaultValue}\``);
  if (property.addedIn) parts.push(`**Added in:** ${property.addedIn}`);

  // A non-enumerable value list still belongs in the hover, even though it cannot
  // constrain the schema — dataset.md's `data_type` is the motivating case, where
  // `decimal(x,y)` placeholders sit alongside literals.
  if (property.enumValues && !isEnumerable(property.enumValues)) {
    const values = property.enumValues.map((v) => `\`${v.value}\``).join(", ");
    parts.push(`**Supported values:** ${values}`);
  }
  return parts.join("\n\n");
}

function scalarSchema(type: SmlType): JsonSchema {
  if (type === "const") return { type: "string" };
  return { type };
}

function propertySchema(
  property: SmlProperty,
  refKey: string,
  objectType: string | undefined,
): JsonSchema {
  const schema: JsonSchema = {};
  const description = describe(property);
  if (description) schema.description = description;

  // `object_type` is what makes per-document schema dispatch possible, so it is
  // pinned to a literal rather than left an open string.
  if (property.name === "object_type" && objectType) {
    schema.const = objectType;
  } else if (property.type === "array") {
    const override = ARRAY_ITEMS[refKey];
    if (property.itemClass) {
      schema.items = { $ref: `#/$defs/${property.itemClass}` };
    } else if (property.itemType) {
      schema.items = scalarSchema(property.itemType);
    } else if (override && typeof override === "object" && "class" in override) {
      schema.items = { $ref: `#/$defs/${override.class}` };
    } else if (override && typeof override === "object" && "anyOf" in override) {
      schema.items = { anyOf: override.anyOf.map(scalarSchema) };
    } else if (override) {
      schema.items = scalarSchema(override as SmlType);
    }
    schema.type = "array";
  } else if (property.type === "object") {
    if (property.itemClass) {
      schema.$ref = `#/$defs/${property.itemClass}`;
      // A `$ref` alongside a description is legal in 2020-12 and keeps the hover.
      return schema;
    }
    schema.type = "object";
  } else {
    Object.assign(schema, scalarSchema(property.type));
  }

  // An enum's values are documented as prose tokens, so they must be coerced to
  // the property's declared type. dimension.md lists `true` / `false` under
  // several boolean properties; emitting those verbatim produced a string enum
  // that rejected every real file, since YAML parses them as booleans. For a
  // boolean the `type` already constrains the value completely, so the enum is
  // dropped rather than translated.
  if (property.enumValues && isEnumerable(property.enumValues) && property.type !== "boolean") {
    schema.enum = property.enumValues.map((v) =>
      property.type === "number" || property.type === "integer" ? Number(v.value) : v.value,
    );
    if ((schema.enum as unknown[]).some((v) => typeof v === "number" && Number.isNaN(v))) {
      fail(
        `${refKey}: documented as ${property.type}, but its Supported values list is not numeric ` +
          `(${property.enumValues.map((v) => v.value).join(", ")})`,
      );
    }
    const documented = property.enumValues.filter((v) => v.description);
    if (documented.length > 0) {
      schema.description = [
        schema.description,
        documented.map((v) => `- \`${v.value}\` — ${v.description}`).join("\n"),
      ]
        .filter(Boolean)
        .join("\n\n");
    }
  }

  const ref = REFERENCES[refKey];
  if (ref) schema["x-sml-ref"] = ref;

  return schema;
}

function classSchema(cls: SmlClass, docFile: string, objectType?: string): JsonSchema {
  const properties: JsonSchema = {};
  const required: string[] = [];

  for (const property of cls.properties.values()) {
    const refKey = `${docFile}:${cls.name}.${property.name}`;
    properties[property.name] = propertySchema(property, refKey, objectType);
    if (property.required) required.push(property.name);
  }

  const schema: JsonSchema = { type: "object", properties };
  if (required.length > 0) schema.required = required;

  // Deliberately permissive: the reference prose lags the implementation (see
  // KNOWN_UNDOCUMENTED), so a closed schema would flag valid files — including
  // ps-utils' own generated output.
  schema.additionalProperties = true;
  return schema;
}

function buildSchema({ spec, doc }: Parsed): JsonSchema {
  const root = doc.classes.get(doc.rootClass);
  if (!root) throw new Error(`${spec.file}: root class ${doc.rootClass} vanished`);

  const $defs: JsonSchema = {};
  for (const cls of doc.classes.values()) {
    if (cls.name === doc.rootClass) continue;
    $defs[cls.name] = classSchema(cls, spec.file, undefined);
  }

  const undocumented = KNOWN_UNDOCUMENTED.map((u) => `\`${u.key}\` (${u.where})`).join("; ");

  return {
    $schema: "https://json-schema.org/draft/2020-12/schema",
    $id: `${SCHEMA_BASE_URI}/${spec.file}.schema.json`,
    title: `SML ${doc.title}`,
    description: [
      `Generated from resources/sml-reference/${spec.file}.md — do not edit by hand.`,
      "Run `npm run generate:sml-schema` to regenerate; see resources/sml-reference/UPSTREAM.md",
      "for the pinned specification revision.",
      "",
      "`additionalProperties` is true throughout: the specification prose lags the",
      `implementation, so a closed schema would reject valid files. Known gaps: ${undocumented}.`,
    ].join("\n"),
    ...classSchema(root, spec.file, spec.objectType),
    ...(Object.keys($defs).length > 0 ? { $defs } : {}),
  };
}

// ──────────────────────────────────────────────────────────────────────────────
// TextMate injection grammar
//
// Generated from the same model as the schemas so the highlighted key set cannot
// drift from what is actually validated.
// ──────────────────────────────────────────────────────────────────────────────

const STRUCTURAL_KEYS = ["object_type", "unique_name", "label"];

/**
 * Reference keys deliberately left out of the injection grammar.
 *
 * A TextMate injection has no file-level predicate: `injectTo: ["source.yaml"]`
 * applies to *every* YAML file in the workspace, so any key claimed here is
 * recoloured in docker-compose.yml, CI configs and Helm charts too. Keys common
 * enough for that to be a visible regression are dropped; the cost is no
 * highlighting for them inside SML, which is cosmetic, whereas recolouring
 * `name:` everywhere is not.
 *
 * Schema validation is unaffected — it is dispatched per document by
 * `object_type`, so these keys still get completion, hover and diagnostics.
 */
const GRAMMAR_EXCLUDED_KEYS = ["name", "metrics", "dimensions", "levels", "relationships", "attribute"];

function buildGrammar(): JsonSchema {
  const objectTypes = DOCS.map((d) => d.objectType).filter((t): t is string => Boolean(t));

  // Every property carrying an x-sml-ref annotation, minus the structural keys
  // (which have their own rule, and would otherwise be matched twice) and the
  // keys too generic to claim across all YAML.
  const referenceKeys = [
    ...new Set(Object.keys(REFERENCES).map((key) => key.split(".").pop()!)),
  ]
    .filter((key) => !STRUCTURAL_KEYS.includes(key) && !GRAMMAR_EXCLUDED_KEYS.includes(key))
    // Longest first so that `name_column` cannot be partially matched by a
    // shorter alternative sharing its prefix.
    .sort((a, b) => b.length - a.length || a.localeCompare(b));

  for (const key of GRAMMAR_EXCLUDED_KEYS) {
    if (!Object.keys(REFERENCES).some((k) => k.endsWith(`.${key}`))) {
      fail(`GRAMMAR_EXCLUDED_KEYS contains "${key}", which is not a reference key — stale entry`);
    }
  }

  const alternation = (keys: string[]) => keys.join("|");

  return {
    $schema: "https://raw.githubusercontent.com/martinring/tmlanguage/master/tmlanguage.json",
    name: "SML (injected)",
    scopeName: "source.yaml.sml.injection",
    // `L:` gives these patterns precedence over the host YAML grammar's own
    // key rule, which would otherwise claim the whole key first. Comments are
    // excluded; strings are not, because a `sql:` block scalar's content is
    // scoped as a string by the YAML grammar and excluding it would prevent the
    // embedded-SQL rule below from ever applying.
    injectionSelector: "L:source.yaml -comment",
    _generated: "src/scripts/generate-sml-schema.ts — do not edit by hand",
    patterns: [
      { include: "#sml-object-type" },
      { include: "#sml-structural-key" },
      { include: "#sml-reference-key" },
      { include: "#sml-role-play" },
      { include: "#sml-embedded-sql" },
    ],
    repository: {
      "sml-object-type": {
        // `object_type: dimension` — the discriminator and its literal value.
        match: `(?<=^|\\s)(object_type)(\\s*:\\s*)(${alternation(objectTypes)})\\b`,
        captures: {
          "1": { name: "keyword.control.sml" },
          "2": { name: "punctuation.separator.key-value.sml" },
          "3": { name: "entity.name.type.sml" },
        },
      },
      "sml-structural-key": {
        match: `(?<=^|\\s)(${alternation(STRUCTURAL_KEYS)})(?=\\s*:)`,
        name: "keyword.control.sml",
      },
      "sml-reference-key": {
        // Keys whose values name another SML object. Scoped as a type so themes
        // visually separate "this points elsewhere" from ordinary YAML keys.
        match: `(?<=^|\\s)(${alternation(referenceKeys)})(?=\\s*:)`,
        name: "support.type.sml",
      },
      "sml-role-play": {
        // The `{0}` placeholder in a role-playing template, e.g. "Order {0}".
        match: "\\{0\\}",
        name: "constant.character.format.placeholder.sml",
      },
      "sml-embedded-sql": {
        // `sql: |` / `sql: >` block scalars carry SQL; hand the body to the SQL
        // grammar. A `begin` rule takes either `end` or `while`, never both:
        // `while` is the correct one here, since a block scalar continues for as
        // long as following lines stay indented past the key. Capture 1 holds the
        // key's own indent, so the backreference in `while` makes the continuation
        // test relative rather than a fixed two spaces.
        //
        // Only block scalars are handled. Single-line `sql: 'SELECT …'` values are
        // left alone — claiming them would mean injecting into an arbitrary quoted
        // string, which is where false positives would start to hurt.
        begin: "^(\\s*)(sql)(\\s*:\\s*)([|>][-+]?\\d*)\\s*$",
        beginCaptures: {
          "2": { name: "keyword.control.sml" },
          "3": { name: "punctuation.separator.key-value.sml" },
          "4": { name: "keyword.control.flow.block-scalar.yaml" },
        },
        while: "^(?:\\1\\s+\\S|\\s*$)",
        contentName: "meta.embedded.block.sql",
        patterns: [{ include: "source.sql" }],
      },
    },
  };
}

// ──────────────────────────────────────────────────────────────────────────────
// Write
// ──────────────────────────────────────────────────────────────────────────────

function reportAndExit(): never {
  console.error(`\n[generate-sml-schema] ${failures.length} problem(s) — nothing was written:\n`);
  for (const failure of failures) console.error(`  • ${failure}`);
  console.error(
    "\n  The generator refuses to emit a partially-understood schema. Each problem above\n" +
      "  is a place where resources/sml-reference/ no longer matches the generator's\n" +
      "  assumptions — see the header comment in src/scripts/generate-sml-schema.ts.\n",
  );
  process.exit(1);
}

// Build everything before writing anything, so a late assertion (the grammar's
// key-list check) cannot leave a half-updated set of generated files behind.
const schemas = parsed.map((entry) => ({ entry, schema: buildSchema(entry) }));
const grammar = buildGrammar();
checkKnownUndocumented(parsed);
if (failures.length > 0) reportAndExit();

fs.mkdirSync(SCHEMA_OUT, { recursive: true });
fs.mkdirSync(path.dirname(GRAMMAR_OUT), { recursive: true });

let propertyCount = 0;
let classCount = 0;
const index: Record<string, { schema: string; directory?: string }> = {};

for (const { entry, schema } of schemas) {
  const out = path.join(SCHEMA_OUT, `${entry.spec.file}.schema.json`);
  fs.writeFileSync(out, JSON.stringify(schema, null, 2) + "\n");

  classCount += entry.doc.classes.size;
  for (const cls of entry.doc.classes.values()) propertyCount += cls.properties.size;

  const key = entry.spec.objectType ?? entry.spec.file;
  index[key] = {
    schema: `${entry.spec.file}.schema.json`,
    ...(entry.spec.directory ? { directory: entry.spec.directory } : {}),
  };
}

fs.writeFileSync(
  path.join(SCHEMA_OUT, "index.json"),
  JSON.stringify(
    {
      _generated: "src/scripts/generate-sml-schema.ts — do not edit by hand",
      description:
        "Maps an SML object_type (and its conventional directory) to the schema that validates it, " +
        "and lists the keys the extension's unknown-key linter must not warn about.",
      // The schemas are permissive, so these keys validate fine. The extension's
      // unknown-key linter would otherwise warn on every file containing one, which
      // is exactly the false positive that teaches people to ignore the channel.
      // Scoped to the object type and class the gap is known to exist on, so a key
      // that is documented elsewhere still gets checked everywhere else.
      knownUndocumented: KNOWN_UNDOCUMENTED.map((gap) => ({
        key: gap.key,
        objectType: DOCS.find((spec) => spec.file === gap.doc)?.objectType,
        class: gap.class,
        where: gap.where,
      })),
      objectTypes: index,
    },
    null,
    2,
  ) + "\n",
);

fs.writeFileSync(GRAMMAR_OUT, JSON.stringify(grammar, null, 2) + "\n");

const conditional = parsed.reduce(
  (n, { doc }) =>
    n +
    [...doc.classes.values()].reduce(
      (m, cls) => m + [...cls.properties.values()].filter((p) => p.requiredNote).length,
      0,
    ),
  0,
);
const adopted = parsed.reduce(
  (n, { doc }) =>
    n +
    [...doc.classes.values()].reduce(
      (m, cls) => m + [...cls.properties.values()].filter((p) => p.undocumented).length,
      0,
    ),
  0,
);

console.log(
  `[generate-sml-schema] ${parsed.length} object types, ${classCount} classes, ` +
    `${propertyCount} properties, ${Object.keys(REFERENCES).length} reference annotations`,
);
console.log(
  `[generate-sml-schema] ${conditional} conditionally-required properties documented as prose, ` +
    `${adopted} adopted from mermaid, ${Object.keys(EXPECTED_DIVERGENCE).length} known spec divergences`,
);
console.log(`[generate-sml-schema] Wrote ${SCHEMA_OUT} and ${GRAMMAR_OUT}`);
