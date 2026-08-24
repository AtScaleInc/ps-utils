/**
 * Parser for the vendored SML language reference (`resources/sml-reference/*.md`).
 *
 * The upstream SML project ships no machine-readable schema — the specification
 * is ten hand-written Markdown files. This module turns them into a typed model
 * that `generate-sml-schema.ts` renders as JSON Schema and a TextMate grammar.
 *
 * The docs are regular, but not uniformly so. Three structural facts drive the
 * design here, all verified against the pinned revision in
 * `resources/sml-reference/UPSTREAM.md`:
 *
 * 1. **Nested objects are documented three different ways.** As a separate
 *    top-level `# <Noun> Properties` section (dimension.md has 12); as `###`
 *    subsections beneath a `##` property (model.md `relationships`); and as
 *    inline bullet lists (`` - `dataset`: String, required. … ``) for
 *    `from`/`to`/`default_member`/`shared_degenerate_columns`. A parser that
 *    only reads headings silently drops `join_columns`, `from_columns` and every
 *    `from`/`to` sub-property — that is, most of the reference-bearing fields.
 *
 * 2. **A `###` beneath a `##` is not always a child.** dataset.md documents the
 *    dataset-level `dialects` array as `### dialects` under `## sql`, and `sql`
 *    is a string — it cannot have children. The rule applied below: a `###` is a
 *    child only when its parent's declared type is `array` or `object`, and is
 *    otherwise promoted to a sibling. The mermaid cross-check in
 *    `crossCheckMermaid` is what keeps this rule honest.
 *
 * 3. **The mermaid `classDiagram` in each doc is a complete type graph.** Field
 *    declarations (`Array~Hierarchy~ hierarchies`) and composition edges
 *    (`Relationship *-- From`) give the property→type bindings, so the nesting
 *    structure is derived rather than hand-maintained. Prose remains
 *    authoritative for type, requiredness, description and enums; mermaid is
 *    used only for structural binding and as a cross-check oracle.
 *
 * Everything here is pure — no filesystem, no network — so the whole parse is
 * exercised by `src/scripts/__tests__/generate-sml-schema.test.ts` against
 * inline fixtures.
 */

// ──────────────────────────────────────────────────────────────────────────────
// Model
// ──────────────────────────────────────────────────────────────────────────────

/** Normalised JSON-Schema-ish type name. */
export type SmlType =
  | "string"
  | "number"
  | "integer"
  | "boolean"
  | "object"
  | "array"
  | "const";

export interface SmlEnumValue {
  value: string;
  description?: string;
}

export interface SmlProperty {
  name: string;
  type: SmlType;
  /** True only for a documented `Required: Y`. Conditional prose lands in `requiredNote`. */
  required: boolean;
  /** Verbatim prose from a conditional `Required:` bullet, e.g. "Required if `table` is not defined". */
  requiredNote?: string;
  defaultValue?: string;
  addedIn?: string;
  description: string;
  /** Documented `Supported values:` list, if the values are enumerable (see `isEnumerable`). */
  enumValues?: SmlEnumValue[];
  /** For arrays: the scalar item type, when the items are not a class. */
  itemType?: SmlType;
  /** For arrays/objects: the name of the class the value(s) conform to. */
  itemClass?: string;
  /**
   * Sub-properties parsed from a nested inline bullet list. model.md documents
   * perspective `hierarchies` this way — an indented `Supported properties:` list
   * inside its parent bullet — so bullet depth has to be preserved to know that
   * `level`/`levels` belong to the hierarchy and not to the dimension above it.
   */
  subProperties?: Map<string, SmlProperty>;
  /**
   * True when the property exists only in the doc's mermaid diagram and was
   * never written up in prose. Adopted anyway — the diagram is evidence the
   * engine supports it — but with no description and flagged for the generator's
   * exception table.
   */
  undocumented?: boolean;
  /** Source doc + heading level, retained for error messages. */
  origin: string;
}

export interface SmlClass {
  name: string;
  description?: string;
  properties: Map<string, SmlProperty>;
}

export interface MermaidField {
  name: string;
  /** Raw declared type, e.g. `String`, `Array~Hierarchy~`, `Object`, `const`. */
  rawType: string;
  /** Class name extracted from the declaration, if it names one. */
  className?: string;
  /** Scalar type from the declaration, e.g. `String` or the `String` in `Array~String~`. */
  scalarType?: SmlType;
  container: "scalar" | "array";
}

export interface MermaidGraph {
  classes: Map<string, Map<string, MermaidField>>;
  /** Composition/association edges, `[owner, target]`. */
  edges: [string, string][];
}

export interface SmlDoc {
  /** Doc basename without extension, e.g. `dimension`. */
  file: string;
  /** H1 title, e.g. `Dimension`. */
  title: string;
  /** Name of the class describing the file's root object. */
  rootClass: string;
  classes: Map<string, SmlClass>;
  mermaid: MermaidGraph;
  /** Property sections found, by normalised name — used for coverage reporting. */
  sectionNames: string[];
}

export class SmlParseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SmlParseError";
  }
}

// ──────────────────────────────────────────────────────────────────────────────
// Type normalisation
//
// The docs use 11 spellings for 7 types (`string`×101, `String`×16, `array`×41,
// `Array`×2, `boolean`×37, `object`×15, `const`×9, `number`×4, `enum`×4,
// `integer`×1, `array<string>`×1), and mermaid adds `Int`, `Number` and `Object`.
// ──────────────────────────────────────────────────────────────────────────────

const TYPE_ALIASES: Record<string, SmlType> = {
  string: "string",
  str: "string",
  query: "string",
  enum: "string", // an enum is a string constrained by its Supported values list
  number: "number",
  int: "integer",
  integer: "integer",
  long: "integer",
  boolean: "boolean",
  bool: "boolean",
  object: "object",
  array: "array",
  const: "const",
};

/** Normalise a prose or mermaid type token. Returns undefined if unrecognised. */
export function normaliseType(raw: string): { type: SmlType; itemType?: SmlType } | undefined {
  const cleaned = raw.trim().replace(/[.,]$/, "").toLowerCase();

  // `array<string>` / `array~string~` — an array of scalars.
  const generic = /^array\s*[<~]\s*([a-z]+)\s*[>~]?$/.exec(cleaned);
  if (generic) {
    const item = TYPE_ALIASES[generic[1]];
    return { type: "array", itemType: item };
  }

  const direct = TYPE_ALIASES[cleaned];
  if (direct) return { type: direct };
  return undefined;
}

/**
 * A documented `Supported values:` list is only usable as a JSON Schema `enum`
 * when every value is a literal. dataset.md `data_type` lists `decimal(x,y)`,
 * `number(x,y)` and `numeric(x,y)` placeholders alongside literals, so a strict
 * enum there would reject the perfectly valid `decimal(16,8)` that appears in
 * the doc's own example on line 63.
 */
export function isEnumerable(values: SmlEnumValue[]): boolean {
  return values.length > 0 && values.every((v) => !/[(<]/.test(v.value));
}

// ──────────────────────────────────────────────────────────────────────────────
// Mermaid classDiagram
// ──────────────────────────────────────────────────────────────────────────────

const CLASS_OPEN = /^\s*class\s+([A-Za-z_][A-Za-z0-9_]*)\s*\{\s*$/;
const CLASS_INLINE_CLOSE = /^\s*\}\s*$/;
const EDGE = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*(?:\*--|o--|-->|\.\.>|--\|>|--)\s*([A-Za-z_][A-Za-z0-9_]*)/;
const FIELD = /^\s*([A-Za-z_][A-Za-z0-9_~<>]*)\s+([a-z_][a-z0-9_]*)\s*$/;

/** Extract the first mermaid fence from a doc and parse its classDiagram. */
export function parseMermaid(markdown: string, origin: string): MermaidGraph {
  const fence = /```mermaid\n([\s\S]*?)```/.exec(markdown);
  if (!fence) {
    throw new SmlParseError(`${origin}: no mermaid classDiagram found`);
  }

  const classes = new Map<string, Map<string, MermaidField>>();
  const edges: [string, string][] = [];
  let current: Map<string, MermaidField> | undefined;

  for (const line of fence[1].split("\n")) {
    if (!line.trim() || line.trim().startsWith("classDiagram")) continue;

    const open = CLASS_OPEN.exec(line);
    if (open) {
      current = new Map();
      classes.set(open[1], current);
      continue;
    }

    if (CLASS_INLINE_CLOSE.test(line)) {
      current = undefined;
      continue;
    }

    if (current) {
      const field = FIELD.exec(line);
      if (field) {
        const [, rawType, name] = field;
        // `Array~Hierarchy~ hierarchies`, and the malformed `Array~String hidden_models`
        // in catalog.md which is missing its closing tilde.
        const inner = /^Array~([A-Za-z_][A-Za-z0-9_]*)~?$/.exec(rawType);
        const container = inner ? "array" : "scalar";
        const typeToken = inner ? inner[1] : rawType;
        const scalar = normaliseType(typeToken);
        const isClassName = /^[A-Z]/.test(typeToken) && !scalar;
        current.set(name, {
          name,
          rawType,
          className: isClassName ? typeToken : undefined,
          scalarType: scalar?.type,
          container,
        });
      }
      continue;
    }

    // `namespace Datasets{` and stray lines are ignored; edges are collected.
    const edge = EDGE.exec(line);
    if (edge && !line.includes("namespace")) {
      edges.push([edge[1], edge[2]]);
    }
  }

  if (classes.size === 0) {
    throw new SmlParseError(`${origin}: mermaid block declared no classes`);
  }
  return { classes, edges };
}

// ──────────────────────────────────────────────────────────────────────────────
// Section splitting
// ──────────────────────────────────────────────────────────────────────────────

interface Heading {
  level: number;
  name: string;
  body: string[];
}

interface PropertySection {
  /** Section noun with " Properties" stripped, e.g. `Level Attributes`. */
  name: string;
  headings: Heading[];
}

/**
 * Split a doc into its `# <Noun> Properties` sections, each carrying its `##`
 * and `###` headings with their bodies. Non-`Properties` H1s (the intro, the
 * `# Entity Relationships` / `# Entitity Relationships` mermaid block — the
 * typo appears in four of the ten docs) are skipped.
 */
export function splitPropertySections(markdown: string): PropertySection[] {
  const lines = markdown.split("\n");
  const sections: PropertySection[] = [];
  let section: PropertySection | undefined;
  let heading: Heading | undefined;
  let inFence = false;

  for (const line of lines) {
    if (/^\s*```/.test(line)) inFence = !inFence;

    if (!inFence) {
      const h = /^(#{1,3})\s+(.*?)\s*$/.exec(line);
      if (h) {
        const level = h[1].length;
        const name = h[2];

        if (level === 1) {
          const props = /^(.*?)\s+Properties$/.exec(name);
          section = props ? { name: props[1], headings: [] } : undefined;
          heading = undefined;
          if (section) sections.push(section);
          continue;
        }

        if (section) {
          heading = { level, name, body: [] };
          section.headings.push(heading);
          continue;
        }
      }
    }

    if (heading) heading.body.push(line);
  }

  return sections;
}

// ──────────────────────────────────────────────────────────────────────────────
// Property body
// ──────────────────────────────────────────────────────────────────────────────

/** A bullet with its wrapped continuation lines joined into one string. */
interface Block {
  kind: "bullet" | "paragraph";
  text: string;
  /** Leading-space count for bullets, which encodes nesting depth. */
  indent: number;
}

/**
 * Collapse a body into blocks, joining each bullet's wrapped continuation lines.
 * Continuations matter: dataset.md wraps "…An alternate SQL dialect. Supported"
 * / "values:" across two lines, and the `Supported values:` marker is only
 * detectable once they are joined.
 */
export function toBlocks(body: string[]): Block[] {
  const blocks: Block[] = [];
  let inFence = false;

  for (const raw of body) {
    if (/^\s*```/.test(raw)) {
      inFence = !inFence;
      continue;
    }
    if (inFence) continue;

    const line = raw.replace(/\s+$/, "");
    if (!line.trim()) {
      blocks.push({ kind: "paragraph", text: "", indent: 0 });
      continue;
    }

    const bullet = /^(\s*)[-*]\s+(.*)$/.exec(line);
    if (bullet) {
      blocks.push({ kind: "bullet", text: bullet[2], indent: bullet[1].length });
      continue;
    }

    // Indented non-bullet text continues the preceding bullet. Nested bullets are
    // matched above, so anything reaching here is a wrapped line.
    const last = blocks[blocks.length - 1];
    if (/^\s{2,}\S/.test(line) && last?.kind === "bullet") {
      last.text += " " + line.trim();
      continue;
    }

    if (last?.kind === "paragraph" && last.text) {
      last.text += " " + line.trim();
    } else {
      blocks.push({ kind: "paragraph", text: line.trim(), indent: 0 });
    }
  }

  return blocks.filter((b) => b.text !== "");
}

// `- **Type:** string` puts the colon *inside* the bold markers, while six
// `- **Required**` bullets and one `- **Default**` omit it entirely; both the
// inner and outer colon are therefore optional.
const META = /^\*\*([A-Za-z ]+?):?\*\*:?\s*(.*)$/;
// `- \`name\`: String, required. …` and its conditional form
// `- \`name\`: String, required if \`row_security\` is undefined. …`, which must not
// be recorded as unconditionally required.
const SUB_PROPERTY =
  /^`([A-Za-z_][A-Za-z0-9_]*)`:\s*(String|Boolean|Array|Integer|Number|Object|Query|Int|Long|Str)\b[,.]?\s*(required|optional|options)?(\s+(?:if|unless|when)\b[^.]*)?\.?\s*([\s\S]*)$/i;
const ENUM_WITH_DESC = /^`([^`]+)`:\s*([\s\S]+)$/;
const ENUM_BARE = /^`([^`]+)`\.?$/;
const VALUES_MARKER = /Supported\s+values:\s*$/i;
const PROPERTIES_MARKER = /(Supported\s+properties|supports?\s+the\s+following(\s+properties)?)\s*[.:]?\s*$/i;

export interface ParsedBody {
  type?: SmlType;
  itemType?: SmlType;
  required: boolean;
  requiredNote?: string;
  defaultValue?: string;
  addedIn?: string;
  description: string;
  enumValues: SmlEnumValue[];
  subProperties: Map<string, SmlProperty>;
}

/**
 * Parse one property's body: its `- **Type:**` / `- **Required:**` metadata, its
 * prose description, its `Supported values:` enum and its inline
 * `Supported properties:` sub-properties.
 *
 * The bullet walk is a small state machine because the docs interleave the two
 * bullet kinds. dataset.md `dialects` is the awkward case: the sub-property
 * bullet for `dialect` ends with "Supported values:" and its five enum values
 * then follow *at the same indent level* as sibling sub-properties, so indent
 * alone cannot tell an enum value from a property.
 */
export function parseBody(body: string[], origin: string): ParsedBody {
  const out: ParsedBody = {
    required: false,
    description: "",
    enumValues: [],
    subProperties: new Map(),
  };

  const blocks = toBlocks(body);
  const prose: string[] = [];
  let mode: "none" | "values" | "properties" = "none";
  let valuesOwner: SmlProperty | undefined;

  // Stack of open sub-property scopes, innermost last. A bullet indented deeper
  // than the scope on top opens a new scope beneath the property that created it.
  const scopes: { indent: number; target: Map<string, SmlProperty>; owner?: SmlProperty }[] = [
    { indent: -1, target: out.subProperties },
  ];

  for (const block of blocks) {
    if (block.kind === "paragraph") {
      if (VALUES_MARKER.test(block.text)) {
        mode = "values";
        valuesOwner = undefined;
        continue;
      }
      if (PROPERTIES_MARKER.test(block.text)) {
        mode = "properties";
        valuesOwner = undefined;
        continue;
      }
      if (mode === "none") prose.push(block.text);
      continue;
    }

    // Metadata bullets. Six `Required` and one `Default` bullet in the corpus
    // omit the colon, and `Added in` appears both ways.
    const meta = META.exec(block.text);
    if (meta) {
      const key = meta[1].trim().toLowerCase();
      const value = meta[2].trim();
      if (key === "type") {
        const norm = normaliseType(value);
        if (!norm) throw new SmlParseError(`${origin}: unrecognised Type "${value}"`);
        out.type = norm.type;
        out.itemType = norm.itemType;
        continue;
      }
      if (key === "required") {
        if (/^y$/i.test(value)) out.required = true;
        else if (/^n$/i.test(value)) out.required = false;
        else {
          // Conditional requiredness, e.g. "Required if `table` is not defined".
          out.required = false;
          out.requiredNote = value.replace(/\s+$/, "");
        }
        continue;
      }
      if (key === "default") {
        out.defaultValue = value;
        continue;
      }
      if (key === "added in") {
        out.addedIn = value;
        continue;
      }
      // Any other `**Bold:**` bullet is prose (e.g. "**Prefix:** `\"<prefix> {0}\"`").
      if (mode === "none") prose.push(block.text);
      continue;
    }

    const sub = SUB_PROPERTY.exec(block.text);
    if (sub) {
      const [, name, rawType, requiredWord, conditional, rest] = sub;
      const norm = normaliseType(rawType);
      if (!norm) throw new SmlParseError(`${origin}: sub-property \`${name}\` has unrecognised type "${rawType}"`);
      const property: SmlProperty = {
        name,
        type: norm.type,
        itemType: norm.itemType,
        // "options" is a typo for "optional" in row-security.md; treat it as such.
        required: /^required$/i.test(requiredWord ?? "") && !conditional,
        requiredNote: conditional ? `${requiredWord}${conditional}`.trim() : undefined,
        description: rest.replace(VALUES_MARKER, "").trim(),
        origin: `${origin} > ${name}`,
      };

      // Close any scopes at or deeper than this bullet, then record it.
      while (scopes.length > 1 && scopes[scopes.length - 1].indent >= block.indent) {
        scopes.pop();
      }
      scopes[scopes.length - 1].target.set(name, property);

      // A trailing "Supported properties:" opens a nested scope for the bullets
      // indented beneath this one; a trailing "Supported values:" makes them enum
      // values of this property instead.
      if (PROPERTIES_MARKER.test(block.text)) {
        property.subProperties = new Map();
        scopes.push({ indent: block.indent, target: property.subProperties, owner: property });
      }

      if (VALUES_MARKER.test(block.text)) {
        // The bullets that follow are this sub-property's enum, not siblings —
        // dataset.md's `dialect` case, where they are not even indented.
        mode = "values";
        valuesOwner = property;
      } else {
        mode = "properties";
        valuesOwner = undefined;
      }
      continue;
    }

    if (mode === "values") {
      const withDesc = ENUM_WITH_DESC.exec(block.text);
      const bare = ENUM_BARE.exec(block.text);
      if (bare || withDesc) {
        const entry: SmlEnumValue = bare
          ? { value: bare[1] }
          : { value: withDesc![1], description: withDesc![2].trim() };
        if (valuesOwner) {
          (valuesOwner.enumValues ??= []).push(entry);
        } else {
          out.enumValues.push(entry);
        }
        continue;
      }
    }

    // An unrecognised bullet before any marker is descriptive prose.
    if (mode === "none") prose.push(block.text);
  }

  out.description = prose.join(" ").replace(/\s+/g, " ").trim();
  return out;
}

// ──────────────────────────────────────────────────────────────────────────────
// Document assembly
// ──────────────────────────────────────────────────────────────────────────────

/** `Level Attributes` / `LevelAttribute` / `ParallelPeriods` all normalise alike. */
function classKey(name: string): string {
  return name.replace(/[^A-Za-z0-9]/g, "").toLowerCase().replace(/s$/, "");
}

/** PascalCase a snake_case property name, for matching composition-edge targets. */
function pascal(name: string): string {
  return name
    .split("_")
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join("");
}

export interface ParseDocOptions {
  file: string;
  markdown: string;
  /** Class name for the file's root object, when it differs from the H1 (calculation.md → `MetricCalc`). */
  rootClass?: string;
}

/**
 * Parse one reference doc into its set of classes.
 *
 * Nested-class binding order, most to least authoritative:
 *   1. `# <Noun> Properties` section matching the mermaid field's class name
 *   2. `###` children beneath the property (only when the property is array/object)
 *   3. inline `Supported properties:` bullets in the property body
 */
export function parseDoc({ file, markdown, rootClass }: ParseDocOptions): SmlDoc {
  const titleMatch = /^#\s+(.*?)\s*$/m.exec(markdown);
  if (!titleMatch) throw new SmlParseError(`${file}: no H1 title`);
  const title = titleMatch[1];

  const mermaid = parseMermaid(markdown, file);
  const sections = splitPropertySections(markdown);
  if (sections.length === 0) {
    throw new SmlParseError(`${file}: no "# <Noun> Properties" section found`);
  }

  // Index the `# <Noun> Properties` sections by normalised name so a mermaid
  // class name can find its prose, tolerating the singular/plural drift between
  // `# Secondary Attributes Properties` and mermaid's `SecondaryAttribute`.
  const sectionsByKey = new Map<string, PropertySection>();
  for (const section of sections) {
    sectionsByKey.set(classKey(section.name), section);
  }

  const classes = new Map<string, SmlClass>();
  const resolvedRoot = rootClass ?? title.replace(/\s+/g, "");

  /**
   * Name a nested class after the mermaid class it corresponds to, so that its
   * own field declarations become reachable.
   *
   * Without this, `## relationships` → `### from` would produce
   * `ModelRelationshipsFrom`, which matches nothing in the diagram, and the
   * `Array~String~ join_columns` declaration on mermaid's `From` would be lost —
   * leaving one of the most reference-dense fields in the language untyped.
   * Resolution walks top-down, so each level's mermaid name is known by the time
   * its children are built.
   */
  const childClassName = (ownerClass: string, propName: string, fallback: string): string => {
    const declared = mermaid.classes.get(ownerClass)?.get(propName)?.className;
    if (declared) return declared;
    const edge = mermaid.edges.find(
      ([owner, target]) => owner === ownerClass && classKey(target) === classKey(propName),
    );
    return edge ? edge[1] : fallback;
  };

  /**
   * Turn a property's inline bullet sub-properties into a class, recursing so
   * that arbitrarily nested `Supported properties:` lists (perspective
   * `dimensions` → `hierarchies` → `level`) each become their own class.
   */
  const materialiseInline = (ownerClass: string, property: SmlProperty): void => {
    const subs = property.subProperties;
    if (!subs || subs.size === 0) return;
    if (property.type !== "array" && property.type !== "object") return;

    const name = childClassName(ownerClass, property.name, `${ownerClass}${pascal(property.name)}`);
    classes.set(name, { name, properties: subs });
    property.itemClass = name;
    for (const child of subs.values()) materialiseInline(name, child);
  };

  /** Build a class from a `# <Noun> Properties` section. */
  const buildFromSection = (className: string, section: PropertySection): SmlClass => {
    const existing = classes.get(className);
    if (existing) return existing;

    const cls: SmlClass = { name: className, properties: new Map() };
    classes.set(className, cls);

    let lastTopLevel: SmlProperty | undefined;
    const nestedHeadings = new Map<string, Heading[]>();

    for (const heading of section.headings) {
      const origin = `${file} > ${section.name} Properties > ${heading.name}`;
      const parsed = parseBody(heading.body, origin);
      if (!parsed.type) {
        throw new SmlParseError(`${origin}: no "- **Type:**" bullet`);
      }

      const property: SmlProperty = {
        name: heading.name,
        type: parsed.type,
        itemType: parsed.itemType,
        required: parsed.required,
        requiredNote: parsed.requiredNote,
        defaultValue: parsed.defaultValue,
        addedIn: parsed.addedIn,
        description: parsed.description,
        enumValues: parsed.enumValues.length ? parsed.enumValues : undefined,
        origin,
      };

      // A `###` is a child only when its parent can actually hold children.
      // dataset.md documents the dataset-level `dialects` array beneath the
      // string-typed `## sql`, so a naive nesting would lose it entirely.
      const parentHoldsChildren =
        lastTopLevel && (lastTopLevel.type === "array" || lastTopLevel.type === "object");

      if (heading.level === 3 && parentHoldsChildren) {
        const bucket = nestedHeadings.get(lastTopLevel!.name) ?? [];
        bucket.push(heading);
        nestedHeadings.set(lastTopLevel!.name, bucket);
        continue;
      }

      cls.properties.set(property.name, property);
      if (heading.level === 2) lastTopLevel = property;

      // Inline `Supported properties:` bullets become a nested class.
      if (parsed.subProperties.size > 0) {
        property.subProperties = parsed.subProperties;
        materialiseInline(className, property);
      }
    }

    // Attach `###` children as nested classes.
    for (const [parentName, headings] of nestedHeadings) {
      const parent = cls.properties.get(parentName);
      if (!parent) continue;
      const nestedName = childClassName(className, parentName, `${className}${pascal(parentName)}`);
      const nested: SmlClass = { name: nestedName, properties: new Map() };

      let lastNested: SmlProperty | undefined;
      for (const heading of headings) {
        const origin = `${file} > ${section.name} Properties > ${parentName} > ${heading.name}`;
        const parsed = parseBody(heading.body, origin);
        if (!parsed.type) throw new SmlParseError(`${origin}: no "- **Type:**" bullet`);
        const property: SmlProperty = {
          name: heading.name,
          type: parsed.type,
          itemType: parsed.itemType,
          required: parsed.required,
          requiredNote: parsed.requiredNote,
          defaultValue: parsed.defaultValue,
          addedIn: parsed.addedIn,
          description: parsed.description,
          enumValues: parsed.enumValues.length ? parsed.enumValues : undefined,
          origin,
        };
        nested.properties.set(property.name, property);
        lastNested = property;

        if (parsed.subProperties.size > 0) {
          property.subProperties = parsed.subProperties;
          materialiseInline(nestedName, property);
        }
      }
      void lastNested;

      classes.set(nestedName, nested);
      parent.itemClass = nestedName;
    }

    return cls;
  };

  // Root class first, then every other `# <Noun> Properties` section.
  const rootSection = sectionsByKey.get(classKey(title)) ?? sections[0];
  buildFromSection(resolvedRoot, rootSection);
  for (const section of sections) {
    if (section === rootSection) continue;
    const mermaidName = [...mermaid.classes.keys()].find((c) => classKey(c) === classKey(section.name));
    buildFromSection(mermaidName ?? section.name.replace(/\s+/g, ""), section);
  }

  /**
   * Build a class purely from its mermaid declaration. Used for types the
   * diagram names but prose never writes up — `ModelReference` in
   * composite-model.md, `Alternate` in dataset.md. Losing them would drop real
   * properties from the schema, so they are adopted without descriptions.
   */
  const buildFromMermaid = (className: string): SmlClass | undefined => {
    const existing = classes.get(className);
    if (existing) return existing;
    const fields = mermaid.classes.get(className);
    if (!fields || fields.size === 0) return undefined;

    const cls: SmlClass = { name: className, properties: new Map() };
    classes.set(className, cls);
    for (const field of fields.values()) {
      cls.properties.set(field.name, {
        name: field.name,
        type: field.container === "array" ? "array" : (field.scalarType ?? "string"),
        itemType: field.container === "array" ? field.scalarType : undefined,
        required: false,
        description: "",
        undocumented: true,
        origin: `${file} > mermaid > ${className}.${field.name}`,
      });
    }
    return cls;
  };

  // Adopt properties the diagram declares but prose omits, before binding, so
  // that e.g. the undocumented `Dataset.alternate` still resolves to `Alternate`.
  for (const cls of classes.values()) {
    const fields = mermaid.classes.get(cls.name);
    if (!fields) continue;
    for (const field of fields.values()) {
      if (cls.properties.has(field.name)) continue;
      cls.properties.set(field.name, {
        name: field.name,
        type: field.container === "array" ? "array" : (field.scalarType ?? "string"),
        itemType: field.container === "array" ? field.scalarType : undefined,
        required: false,
        description: "",
        undocumented: true,
        origin: `${file} > mermaid > ${cls.name}.${field.name}`,
      });
    }
  }

  // Bind array/object properties to their classes. Resolution order: the mermaid
  // field declaration, then a composition edge (for `Object`-typed fields such as
  // `Relationship.from`), then a prose section, then the diagram alone.
  for (const cls of classes.values()) {
    const mermaidFields = mermaid.classes.get(cls.name);
    for (const property of cls.properties.values()) {
      if (property.type !== "array" && property.type !== "object") continue;

      const field = mermaidFields?.get(property.name);

      // Arrays of scalars: prose says only "array", the diagram says of what.
      // Requiring `container === "array"` matters — where the diagram declares a
      // bare scalar against a prose `array` the two genuinely disagree
      // (dimension.md types `SecondaryAttribute.sort_column` as an array while
      // mermaid, both sibling definitions and sml-serializer.ts all treat it as a
      // string). Merging them would launder that contradiction into an
      // array-of-string; leaving it unbound surfaces it for an explicit decision.
      if (
        property.type === "array" &&
        !property.itemClass &&
        !property.itemType &&
        field?.container === "array" &&
        field.scalarType
      ) {
        property.itemType = field.scalarType;
        continue;
      }
      if (property.itemClass) continue;

      const candidate =
        field?.className ??
        mermaid.edges.find(
          ([owner, target]) => owner === cls.name && classKey(target) === classKey(property.name),
        )?.[1];
      if (!candidate) continue;

      if (classes.has(candidate)) {
        property.itemClass = candidate;
        continue;
      }
      const section = sectionsByKey.get(classKey(candidate));
      if (section) {
        buildFromSection(candidate, section);
        property.itemClass = candidate;
        continue;
      }
      if (buildFromMermaid(candidate)) {
        property.itemClass = candidate;
      }
    }
  }

  return {
    file,
    title,
    rootClass: resolvedRoot,
    classes,
    mermaid,
    sectionNames: sections.map((s) => s.name),
  };
}

// ──────────────────────────────────────────────────────────────────────────────
// Cross-check oracle
// ──────────────────────────────────────────────────────────────────────────────

export interface Discrepancy {
  className: string;
  property: string;
  kind: "missing-in-prose" | "missing-in-mermaid";
}

/**
 * Compare the parsed prose model against the doc's own mermaid classDiagram.
 *
 * This is what turns a silent misparse into a loud one: if a future refresh
 * moves a property, changes a nesting shape, or adds a class, the two views stop
 * agreeing and the build fails. Genuine upstream gaps — a property drawn in
 * mermaid but never written up in prose — are declared as expected in the
 * generator's exception table rather than silently tolerated here.
 */
export function crossCheckMermaid(doc: SmlDoc): Discrepancy[] {
  const out: Discrepancy[] = [];

  for (const [className, fields] of doc.mermaid.classes) {
    const cls = doc.classes.get(className);
    if (!cls) continue; // Classes sourced from inline bullets carry generated names.

    for (const [name, property] of cls.properties) {
      // Adopted from the diagram because prose never described it.
      if (property.undocumented) {
        out.push({ className, property: name, kind: "missing-in-prose" });
        continue;
      }
      if (!fields.has(name)) {
        out.push({ className, property: name, kind: "missing-in-mermaid" });
      }
    }
  }

  return out;
}
