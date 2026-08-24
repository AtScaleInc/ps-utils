import { describe, expect, it } from "vitest";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import yaml from "js-yaml";
import {
  crossCheckMermaid,
  isEnumerable,
  normaliseType,
  parseBody,
  parseDoc,
  parseMermaid,
  toBlocks,
} from "../sml-reference-parser.js";

/**
 * Coverage for the SML schema pipeline.
 *
 * The parser tests use inline fixtures reproducing the *exact* shapes found in
 * `resources/sml-reference/` — including its inconsistencies, since those are the
 * cases a naive parser silently mishandles. See the header comment in
 * `sml-reference-parser.ts` for why each shape exists.
 *
 * The artifact tests read the committed output of `npm run generate:sml-schema`,
 * so they fail if the generated files are stale relative to the vendored docs.
 */

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "../../..");
const SCHEMA_DIR = path.join(ROOT, "vscode-extension/media/sml-schema");
const REFERENCE_DIR = path.join(ROOT, "resources/sml-reference");

const lines = (text: string): string[] => text.split("\n");

// ──────────────────────────────────────────────────────────────────────────────

describe("normaliseType", () => {
  it("folds the corpus's eleven spellings onto seven types", () => {
    expect(normaliseType("string")).toEqual({ type: "string" });
    expect(normaliseType("String")).toEqual({ type: "string" });
    expect(normaliseType("Boolean")).toEqual({ type: "boolean" });
    expect(normaliseType("number")).toEqual({ type: "number" });
    expect(normaliseType("Int")).toEqual({ type: "integer" });
    expect(normaliseType("object")).toEqual({ type: "object" });
    expect(normaliseType("const")).toEqual({ type: "const" });
  });

  it("treats an enum as a string, since its values constrain it separately", () => {
    expect(normaliseType("enum")).toEqual({ type: "string" });
  });

  it("reads the element type out of catalog.md's `array<string>`", () => {
    expect(normaliseType("array<string>")).toEqual({ type: "array", itemType: "string" });
  });

  it("returns undefined for an unknown type rather than guessing", () => {
    expect(normaliseType("Widget")).toBeUndefined();
  });
});

describe("isEnumerable", () => {
  it("accepts a list of literals", () => {
    expect(isEnumerable([{ value: "sum" }, { value: "average" }])).toBe(true);
  });

  it("rejects dataset.md's data_type list, which mixes in `decimal(x,y)` placeholders", () => {
    // A strict enum here would reject `decimal(16,8)` — a value that appears in
    // the reference doc's own example.
    expect(isEnumerable([{ value: "string" }, { value: "decimal(x,y)" }])).toBe(false);
  });
});

// ──────────────────────────────────────────────────────────────────────────────

describe("parseBody metadata", () => {
  it("reads a Type/Required pair whose colon sits inside the bold markers", () => {
    const parsed = parseBody(lines("\n- **Type:** string\n- **Required:** Y\n\nThe unique name.\n"), "t");
    expect(parsed.type).toBe("string");
    expect(parsed.required).toBe(true);
    expect(parsed.description).toBe("The unique name.");
  });

  it("accepts the colonless `**Required**` and `**Default**` variants", () => {
    const parsed = parseBody(
      lines("\n- **Type:** boolean\n- **Required** N\n- **Added in** v1.2\n- **Default** false\n"),
      "t",
    );
    expect(parsed.required).toBe(false);
    expect(parsed.addedIn).toBe("v1.2");
    expect(parsed.defaultValue).toBe("false");
  });

  it("records conditional requiredness as prose instead of asserting it", () => {
    const parsed = parseBody(
      lines("\n- **Type:** string\n- **Required:** Required if `table` is not defined\n"),
      "t",
    );
    // Encoding these as oneOf produces unreadable diagnostics in vscode-yaml, so
    // the condition becomes documentation.
    expect(parsed.required).toBe(false);
    expect(parsed.requiredNote).toBe("Required if `table` is not defined");
  });

  it("throws on an unrecognised type rather than defaulting", () => {
    expect(() => parseBody(lines("\n- **Type:** Widget\n- **Required:** Y\n"), "t")).toThrow(
      /unrecognised Type "Widget"/,
    );
  });
});

describe("parseBody enums", () => {
  it("collects a Supported values list", () => {
    const parsed = parseBody(
      lines("\n- **Type:** string\n- **Required:** Y\n\nThe method.\n\nSupported values:\n\n- `sum`\n- `average`\n"),
      "t",
    );
    expect(parsed.enumValues.map((v) => v.value)).toEqual(["sum", "average"]);
  });

  it("keeps per-value descriptions", () => {
    const parsed = parseBody(
      lines(
        "\n- **Type:** string\n- **Required:** Y\n\nSupported values:\n\n" +
          "- `embedded`: A secondary relationship.\n- `snowflake`: A physical join.\n",
      ),
      "t",
    );
    expect(parsed.enumValues).toEqual([
      { value: "embedded", description: "A secondary relationship." },
      { value: "snowflake", description: "A physical join." },
    ]);
  });
});

describe("parseBody sub-properties", () => {
  it("reads an inline Supported properties list", () => {
    const parsed = parseBody(
      lines(
        "\n- **Type:** object\n- **Required:** Y\n\nDefines the side of the relationship.\n\n" +
          "Supported properties:\n\n" +
          "- `dataset`: String, required. The physical fact dataset.\n" +
          "- `join_columns`: Array, required. The columns to join on.\n",
      ),
      "t",
    );
    expect([...parsed.subProperties.keys()]).toEqual(["dataset", "join_columns"]);
    expect(parsed.subProperties.get("dataset")!.required).toBe(true);
    expect(parsed.subProperties.get("join_columns")!.type).toBe("array");
  });

  it("does not mark a conditionally-required sub-property as required", () => {
    const parsed = parseBody(
      lines(
        "\n- **Type:** array\n- **Required:** N\n\nSupported properties:\n\n" +
          "- `name`: String, required if `row_security` is undefined. The attribute name.\n",
      ),
      "t",
    );
    const name = parsed.subProperties.get("name")!;
    expect(name.required).toBe(false);
    expect(name.requiredNote).toMatch(/^required if/i);
  });

  it("attaches an indented nested list to its parent bullet, not to the outer object", () => {
    // model.md documents perspective `hierarchies` this way. Flattening the indent
    // would file `level` under the dimension instead of the hierarchy.
    const parsed = parseBody(
      lines(
        "\n- **Type:** array\n- **Required:** N\n\nSupported properties:\n\n" +
          "- `name`: String, required. The dimension name.\n" +
          "- `hierarchies`: Array, optional. The hierarchies to hide. Supported properties:\n\n" +
          "  - `name`: String, required. The name of the hierarchy.\n" +
          "  - `level`: String, optional. A single level to hide.\n\n" +
          "- `secondary_attributes`: Array, optional. Attributes to hide.\n",
      ),
      "t",
    );
    expect([...parsed.subProperties.keys()]).toEqual(["name", "hierarchies", "secondary_attributes"]);
    const hierarchies = parsed.subProperties.get("hierarchies")!;
    expect([...hierarchies.subProperties!.keys()]).toEqual(["name", "level"]);
    // `level` must not have leaked up to the outer scope.
    expect(parsed.subProperties.has("level")).toBe(false);
  });

  it("assigns un-indented enum values to the sub-property that introduced them", () => {
    // dataset.md's `dialects` is malformed: the `dialect` sub-property ends with
    // "Supported values:" and its values then sit at the *same* indent as sibling
    // sub-properties, so indentation alone cannot classify them.
    const parsed = parseBody(
      lines(
        "\n- **Type:** array\n- **Required:** N\n\nSupported properties:\n\n" +
          "- `dialect`: String, required. An alternate SQL dialect. Supported\n  values:\n" +
          "- `Snowflake`\n" +
          "- `BigQuery`\n\n" +
          "- `sql`: String, required. The alternate SQL statement.\n",
      ),
      "t",
    );
    expect([...parsed.subProperties.keys()]).toEqual(["dialect", "sql"]);
    expect(parsed.subProperties.get("dialect")!.enumValues?.map((v) => v.value)).toEqual([
      "Snowflake",
      "BigQuery",
    ]);
  });
});

describe("toBlocks", () => {
  it("joins a bullet's wrapped continuation lines", () => {
    // The "Supported values:" marker is only detectable once the wrap is joined.
    const blocks = toBlocks(lines("- `dialect`: String, required. An alternate dialect. Supported\n  values:"));
    expect(blocks).toHaveLength(1);
    expect(blocks[0].text).toBe("`dialect`: String, required. An alternate dialect. Supported values:");
  });

  it("records bullet indentation so nesting can be recovered", () => {
    const blocks = toBlocks(lines("- `a`: String, required. A.\n  - `b`: String, required. B."));
    expect(blocks.map((b) => b.indent)).toEqual([0, 2]);
  });
});

// ──────────────────────────────────────────────────────────────────────────────

describe("parseMermaid", () => {
  it("reads field declarations, generics and composition edges", () => {
    const graph = parseMermaid(
      [
        "```mermaid",
        "classDiagram",
        "    Dimension *-- Hierarchy",
        "    class Dimension{",
        "      String unique_name",
        "      Array~Hierarchy~ hierarchies",
        "      Object from",
        "    }",
        "```",
      ].join("\n"),
      "t",
    );
    const dimension = graph.classes.get("Dimension")!;
    expect(dimension.get("hierarchies")).toMatchObject({ className: "Hierarchy", container: "array" });
    expect(dimension.get("unique_name")).toMatchObject({ scalarType: "string", container: "scalar" });
    expect(graph.edges).toContainEqual(["Dimension", "Hierarchy"]);
  });

  it("tolerates catalog.md's unclosed `Array~String` generic", () => {
    const graph = parseMermaid(
      ["```mermaid", "classDiagram", "class Catalog{", "  Array~String hidden_models", "}", "```"].join("\n"),
      "t",
    );
    expect(graph.classes.get("Catalog")!.get("hidden_models")).toMatchObject({
      container: "array",
      scalarType: "string",
    });
  });

  it("throws when a doc has no diagram to cross-check against", () => {
    expect(() => parseMermaid("# Title\n\nNo diagram here.\n", "t")).toThrow(/no mermaid classDiagram/);
  });
});

// ──────────────────────────────────────────────────────────────────────────────

describe("parseDoc nesting rules", () => {
  const withDiagram = (classBody: string, propertyBody: string) =>
    [
      "# Widget",
      "",
      "```mermaid",
      "classDiagram",
      classBody,
      "```",
      "",
      "# Widget Properties",
      "",
      propertyBody,
    ].join("\n");

  it("promotes a `###` under a scalar parent to a sibling", () => {
    // dataset.md documents the dataset-level `dialects` array beneath the
    // string-typed `## sql`. Treating it as a child would drop it entirely.
    const doc = parseDoc({
      file: "widget",
      markdown: withDiagram(
        "class Widget{\n  String sql\n  Array~Dialect~ dialects\n}\nclass Dialect{\n  String dialect\n}",
        [
          "## sql",
          "",
          "- **Type:** string",
          "- **Required:** N",
          "",
          "A SQL query.",
          "",
          "### dialects",
          "",
          "- **Type:** array",
          "- **Required:** N",
          "",
          "Alternate dialects.",
        ].join("\n"),
      ),
    });
    const widget = doc.classes.get("Widget")!;
    expect([...widget.properties.keys()]).toEqual(["sql", "dialects"]);
    expect(widget.properties.get("dialects")!.itemClass).toBe("Dialect");
  });

  it("keeps a `###` under an array parent as a child", () => {
    const doc = parseDoc({
      file: "widget",
      markdown: withDiagram(
        "class Widget{\n  Array~Column~ columns\n}\nclass Column{\n  String name\n}",
        [
          "## columns",
          "",
          "- **Type:** array",
          "- **Required:** Y",
          "",
          "The columns.",
          "",
          "### name",
          "",
          "- **Type:** string",
          "- **Required:** Y",
          "",
          "The column name.",
        ].join("\n"),
      ),
    });
    const widget = doc.classes.get("Widget")!;
    expect([...widget.properties.keys()]).toEqual(["columns"]);
    expect(widget.properties.get("columns")!.itemClass).toBe("Column");
    expect([...doc.classes.get("Column")!.properties.keys()]).toEqual(["name"]);
  });

  it("names a nested class after the diagram so its own declarations resolve", () => {
    // Without this the class would be `WidgetFrom`, which matches nothing in the
    // diagram, and `Array~String~ join_columns` would be lost.
    const doc = parseDoc({
      file: "widget",
      markdown: withDiagram(
        "Widget *-- From\nclass Widget{\n  Object from\n}\nclass From{\n  String dataset\n  Array~String~ join_columns\n}",
        [
          "## from",
          "",
          "- **Type:** object",
          "- **Required:** Y",
          "",
          "Supported properties:",
          "",
          "- `dataset`: String, required. The dataset.",
          "- `join_columns`: Array, required. The join columns.",
        ].join("\n"),
      ),
    });
    expect(doc.classes.has("From")).toBe(true);
    expect(doc.classes.get("From")!.properties.get("join_columns")!.itemType).toBe("string");
  });

  it("adopts a diagram-only property and flags it as undocumented", () => {
    const doc = parseDoc({
      file: "widget",
      markdown: withDiagram("class Widget{\n  String sql\n  Boolean immutable\n}", [
        "## sql",
        "",
        "- **Type:** string",
        "- **Required:** N",
        "",
        "A SQL query.",
      ].join("\n")),
    });
    const immutable = doc.classes.get("Widget")!.properties.get("immutable")!;
    expect(immutable.undocumented).toBe(true);
    expect(crossCheckMermaid(doc)).toContainEqual({
      className: "Widget",
      property: "immutable",
      kind: "missing-in-prose",
    });
  });

  it("throws when a property section has no Type bullet", () => {
    expect(() =>
      parseDoc({
        file: "widget",
        markdown: withDiagram("class Widget{\n  String sql\n}", "## sql\n\nA SQL query.\n"),
      }),
    ).toThrow(/no "- \*\*Type:\*\*" bullet/);
  });
});

// ──────────────────────────────────────────────────────────────────────────────

describe("generated schemas", () => {
  const index = JSON.parse(fs.readFileSync(path.join(SCHEMA_DIR, "index.json"), "utf8"));

  it("emits one schema per documented object type", () => {
    const docs = fs.readdirSync(REFERENCE_DIR).filter((f) => f.endsWith(".md") && f !== "UPSTREAM.md");
    expect(docs).toHaveLength(10);
    expect(Object.keys(index.objectTypes)).toHaveLength(10);
  });

  it("pins object_type to a literal, which is what makes per-document dispatch work", () => {
    for (const [objectType, entry] of Object.entries<{ schema: string }>(index.objectTypes)) {
      const schema = JSON.parse(fs.readFileSync(path.join(SCHEMA_DIR, entry.schema), "utf8"));
      if (objectType === "package") continue; // packages.yml has no object_type discriminator
      expect(schema.properties.object_type.const).toBe(objectType);
    }
  });

  it("stays permissive, because the reference prose lags the implementation", () => {
    // sml-serializer.ts emits `visualize_in_bi_tool`, which the spec never
    // documents. A closed schema would flag ps-utils' own output.
    const dimension = JSON.parse(fs.readFileSync(path.join(SCHEMA_DIR, "dimension.schema.json"), "utf8"));
    expect(dimension.additionalProperties).toBe(true);
    for (const def of Object.values<{ additionalProperties?: boolean }>(dimension.$defs)) {
      expect(def.additionalProperties).toBe(true);
    }
  });

  it("annotates context-dependent references with a resolvable context", () => {
    const metric = JSON.parse(fs.readFileSync(path.join(SCHEMA_DIR, "metric.schema.json"), "utf8"));
    expect(metric.properties.dataset["x-sml-ref"]).toEqual({ kind: "dataset" });
    // A column is only meaningful relative to the dataset named alongside it —
    // the whole reason a plain schema cannot express these.
    expect(metric.properties.column["x-sml-ref"]).toEqual({
      kind: "column",
      in: { dataset: "0/dataset" },
    });
  });

  it("does not emit an enum it cannot enumerate", () => {
    const dataset = JSON.parse(fs.readFileSync(path.join(SCHEMA_DIR, "dataset.schema.json"), "utf8"));
    const dataType = dataset.$defs.Column.properties.data_type;
    expect(dataType.enum).toBeUndefined();
    expect(dataType.description).toMatch(/decimal\(x,y\)/);
  });
});

describe("generated injection grammar", () => {
  const grammar = JSON.parse(
    fs.readFileSync(path.join(ROOT, "vscode-extension/syntaxes/sml.injection.tmLanguage.json"), "utf8"),
  );

  it("uses a while-continuation for block scalars, never both end and while", () => {
    const sql = grammar.repository["sml-embedded-sql"];
    expect(sql.while).toBeDefined();
    expect(sql.end).toBeUndefined();
  });

  it("leaves ubiquitous keys alone, since the injection applies to all YAML", () => {
    // `injectTo: source.yaml` has no file predicate, so claiming `name:` would
    // recolour it in every unrelated YAML file in the workspace.
    const referenceKeys = grammar.repository["sml-reference-key"].match;
    expect(referenceKeys).not.toMatch(/\(name\||\|name\||\|name\)/);
    expect(referenceKeys).toMatch(/connection_id/);
  });

  it("does not double-match the structural keys", () => {
    const structural = grammar.repository["sml-structural-key"].match;
    const references = grammar.repository["sml-reference-key"].match;
    expect(structural).toMatch(/unique_name/);
    expect(references).not.toMatch(/unique_name/);
  });
});

describe("extension contribution wiring", () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, "vscode-extension/package.json"), "utf8"));

  it("declares every setting as a single-segment key", () => {
    // `psUtils.sml.enabled` looked reasonable and was silently never registered by
    // VS Code, because the three-segment id implies an intermediate `psUtils.sml`
    // object that nothing declares. Reads still returned the *default* — so the UI
    // looked right — while `update()` threw "not a registered configuration". Every
    // key must stay `psUtils.<name>`.
    for (const key of Object.keys(pkg.contributes.configuration.properties)) {
      expect(key.split("."), `${key} must be psUtils.<name>`).toHaveLength(2);
      expect(key.startsWith("psUtils.")).toBe(true);
    }
  });

  it("declares the SML toggle setting the extension reads and writes", () => {
    const source = fs.readFileSync(
      path.join(ROOT, "vscode-extension/src/sml-schema.ts"),
      "utf8",
    );
    const section = /const CONFIG_SECTION = "([^"]+)"/.exec(source)?.[1];
    const setting = /const ENABLED_SETTING = "([^"]+)"/.exec(source)?.[1];
    expect(section).toBeDefined();
    expect(setting).toBeDefined();
    expect(pkg.contributes.configuration.properties).toHaveProperty(`${section}.${setting}`);
  });

  it("declares every command any menu references", () => {
    // A menu entry pointing at an undeclared or unregistered command is invisible as
    // a bug: the item renders and clicking it does nothing.
    const declared = new Set<string>(pkg.contributes.commands.map((c: { command: string }) => c.command));
    for (const [menu, items] of Object.entries<{ command?: string }[]>(pkg.contributes.menus)) {
      for (const item of items) {
        if (!item.command) continue;
        expect(declared, `${menu} references undeclared ${item.command}`).toContain(item.command);
      }
    }
  });

  it("registers every SML command it contributes", () => {
    const source = fs.readFileSync(
      path.join(ROOT, "vscode-extension/src/sml-schema.ts"),
      "utf8",
    );
    const contributed = pkg.contributes.commands
      .map((c: { command: string }) => c.command)
      .filter((id: string) => id.startsWith("psUtils.sml."));
    expect(contributed.length).toBeGreaterThan(0);
    for (const id of contributed) {
      expect(source, `${id} is contributed but never registered`).toContain(`"${id}"`);
    }
  });
});

// ──────────────────────────────────────────────────────────────────────────────
// Corpus validation
// ──────────────────────────────────────────────────────────────────────────────

interface Failure {
  path: string;
  message: string;
}

/**
 * Minimal validator over exactly the JSON Schema keywords the generator emits
 * (`type`, `const`, `enum`, `required`, `properties`, `items`, `$ref`, `anyOf`,
 * `additionalProperties`). Deliberately not a general implementation — the point
 * is to check the generated schemas accept real SML, without adding a dependency.
 */
function validate(value: unknown, schema: Record<string, any>, root: Record<string, any>, at = "$"): Failure[] {
  const failures: Failure[] = [];

  if (schema.$ref) {
    const name = schema.$ref.replace("#/$defs/", "");
    return validate(value, root.$defs?.[name] ?? {}, root, at);
  }
  if (schema.anyOf) {
    const branches = schema.anyOf.map((branch: Record<string, any>) => validate(value, branch, root, at));
    if (branches.every((b: Failure[]) => b.length > 0)) {
      failures.push({ path: at, message: `matched none of ${schema.anyOf.length} alternatives` });
    }
    return failures;
  }

  const typeOf = (v: unknown) =>
    Array.isArray(v) ? "array" : v === null ? "null" : typeof v === "number" && Number.isInteger(v) ? "integer" : typeof v;

  if (schema.const !== undefined && value !== schema.const) {
    failures.push({ path: at, message: `expected const ${JSON.stringify(schema.const)}, got ${JSON.stringify(value)}` });
  }
  if (schema.enum && !schema.enum.includes(value)) {
    failures.push({ path: at, message: `${JSON.stringify(value)} is not one of ${schema.enum.join(", ")}` });
  }
  if (schema.type) {
    const actual = typeOf(value);
    const ok =
      actual === schema.type ||
      (schema.type === "number" && actual === "integer") ||
      // A YAML scalar may legitimately parse as a Date or number where the schema
      // says string; the schemas are not trying to police scalar spelling.
      (schema.type === "string" && (value instanceof Date || actual === "number" || actual === "boolean"));
    if (!ok && value !== null && value !== undefined) {
      failures.push({ path: at, message: `expected ${schema.type}, got ${actual}` });
    }
  }

  if (schema.type === "object" || schema.properties) {
    if (value && typeof value === "object" && !Array.isArray(value)) {
      const record = value as Record<string, unknown>;
      for (const key of schema.required ?? []) {
        if (!(key in record)) failures.push({ path: at, message: `missing required property "${key}"` });
      }
      for (const [key, child] of Object.entries(record)) {
        const childSchema = schema.properties?.[key];
        if (childSchema) failures.push(...validate(child, childSchema, root, `${at}.${key}`));
      }
    }
  }

  if (schema.type === "array" && Array.isArray(value) && schema.items) {
    value.forEach((item, i) => failures.push(...validate(item, schema.items, root, `${at}[${i}]`)));
  }

  return failures;
}

describe("SML generated by ps-utils validates against the generated schemas", () => {
  const index = JSON.parse(fs.readFileSync(path.join(SCHEMA_DIR, "index.json"), "utf8"));
  // Resolved from the repo root, not __dirname: `tsc` compiles this file to
  // dist/scripts/__tests__/ without copying the .yml fixtures, and vitest's
  // default discovery picks up that compiled copy too.
  const fixtureDir = path.join(ROOT, "src/scripts/__tests__/fixtures/sml-corpus");

  const files = fs.existsSync(fixtureDir)
    ? fs
        .readdirSync(fixtureDir, { recursive: true, encoding: "utf8" })
        .filter((f) => f.endsWith(".yml"))
        .map((f) => path.join(fixtureDir, f))
    : [];

  it("has a corpus to check", () => {
    expect(files.length).toBeGreaterThan(0);
  });

  it.each(files.map((f) => [path.relative(fixtureDir, f), f]))(
    "%s validates with zero diagnostics",
    (_name, file) => {
      const doc = yaml.load(fs.readFileSync(file, "utf8")) as Record<string, unknown>;
      const objectType = String(doc.object_type ?? "");
      const entry = index.objectTypes[objectType];
      expect(entry, `no schema for object_type "${objectType}"`).toBeDefined();

      const schema = JSON.parse(fs.readFileSync(path.join(SCHEMA_DIR, entry.schema), "utf8"));
      const failures = validate(doc, schema, schema);
      expect(
        failures.map((f) => `${f.path}: ${f.message}`),
        "the schemas must not flag valid ps-utils output",
      ).toEqual([]);
    },
  );
});
