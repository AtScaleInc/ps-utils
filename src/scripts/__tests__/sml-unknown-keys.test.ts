/**
 * Tests for the extension's unknown-key linter.
 *
 * The linter exists because the generated schemas are `additionalProperties: true`
 * and so can never report a typo. Its whole value depends on staying quiet on
 * valid SML — a channel that cries wolf gets switched off — so the load-bearing
 * test here is the corpus sweep, which asserts zero findings across every file
 * ps-utils itself generates.
 *
 * `sml-unknown-keys-core.ts` lives under `vscode-extension/src/` but imports no
 * `vscode`, precisely so it can be exercised from here.
 */
import * as fs from "fs";
import * as path from "path";
import { describe, expect, it } from "vitest";
import {
  Allowlist,
  editDistance,
  findUnknownKeys,
  suggestFor,
} from "../../../vscode-extension/src/sml-unknown-keys-core";
import type {
  JsonSchema,
  KnownUndocumented,
} from "../../../vscode-extension/src/sml-unknown-keys-core";

const SCHEMA_DIR = path.join(__dirname, "../../../vscode-extension/media/sml-schema");
const CORPUS_DIR = path.join(__dirname, "fixtures/sml-corpus");

interface Index {
  knownUndocumented: KnownUndocumented[];
  objectTypes: Record<string, { schema: string; directory?: string }>;
}

const index = JSON.parse(fs.readFileSync(path.join(SCHEMA_DIR, "index.json"), "utf8")) as Index;

const schemaFor = (objectType: string): JsonSchema =>
  JSON.parse(
    fs.readFileSync(path.join(SCHEMA_DIR, index.objectTypes[objectType].schema), "utf8"),
  ) as JsonSchema;

const allowlist = Allowlist.from(index.knownUndocumented);

const dataset = schemaFor("dataset");

/** Every `.yml` under the corpus, paired with the object type it declares. */
function corpusFiles(): { file: string; objectType: string; text: string }[] {
  const out: { file: string; objectType: string; text: string }[] = [];
  const walk = (dir: string): void => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(full);
      } else if (/\.ya?ml$/.test(entry.name)) {
        const text = fs.readFileSync(full, "utf8");
        const objectType = /^object_type\s*:\s*["']?([A-Za-z_][A-Za-z0-9_]*)["']?/m.exec(text)?.[1];
        // catalog.yml carries no object_type; it is dispatched by filename.
        const resolved = objectType ?? (entry.name.startsWith("catalog.") ? "catalog" : undefined);
        if (resolved) out.push({ file: path.relative(CORPUS_DIR, full), objectType: resolved, text });
      }
    }
  };
  walk(CORPUS_DIR);
  return out;
}

// ──────────────────────────────────────────────────────────────────────────────

describe("editDistance", () => {
  it("scores a transposition as one edit, which plain Levenshtein does not", () => {
    // `tabel`/`table` and `lable`/`label` are the commonest SML typos; at a cost
    // of 2 they would be indistinguishable from an unrelated word.
    expect(editDistance("tabel", "table")).toBe(1);
    expect(editDistance("lable", "label")).toBe(1);
  });

  it("handles insertions, deletions and substitutions", () => {
    expect(editDistance("colums", "columns")).toBe(1);
    expect(editDistance("columnss", "columns")).toBe(1);
    expect(editDistance("columnt", "columns")).toBe(1);
    expect(editDistance("", "columns")).toBe(7);
    expect(editDistance("columns", "columns")).toBe(0);
  });
});

describe("suggestFor", () => {
  const documented = Object.keys(dataset.properties!);

  it("names the intended property for a one-character slip", () => {
    expect(suggestFor("colums", documented)).toBe("columns");
    expect(suggestFor("conection_id", documented)).toBe("connection_id");
    expect(suggestFor("uniqe_name", documented)).toBe("unique_name");
  });

  it("is case-insensitive, since YAML keys often arrive capitalised", () => {
    expect(suggestFor("Label", documented)).toBe("label");
  });

  it("says nothing when the key resembles nothing documented", () => {
    // The reported case: a word that is simply not an SML property. Offering the
    // nearest string here would be noise dressed up as help.
    expect(suggestFor("patreick", documented)).toBeUndefined();
    expect(suggestFor("owner_team", documented)).toBeUndefined();
  });

  it("scales the threshold with length, so short keys are not over-matched", () => {
    // `sql` is 3 characters: two edits away is a different word, not a typo.
    expect(suggestFor("xyz", documented)).toBeUndefined();
  });

  it("declines to guess between two equally close candidates", () => {
    expect(suggestFor("bar", ["far", "car"])).toBeUndefined();
    expect(suggestFor("far", ["far", "car"])).toBe("far");
  });
});

describe("findUnknownKeys", () => {
  const valid = [
    "unique_name: dim_currency.dataset",
    "object_type: dataset",
    "label: Dim Currency",
    "connection_id: my_connection",
    "table: dim_currency",
    "columns:",
    "  - name: currency_key",
    "    data_type: int",
  ].join("\n");

  it("finds a stray top-level key and points at it", () => {
    const text = `${valid}\n\npatreick: string\n`;
    const findings = findUnknownKeys(text, dataset, "dataset", allowlist);

    expect(findings).toHaveLength(1);
    expect(findings[0].key).toBe("patreick");
    expect(findings[0].path).toBe("");
    expect(findings[0].suggestion).toBeUndefined();
    expect(text.slice(findings[0].start, findings[0].end)).toBe("patreick");
  });

  it("reports nothing for the same file without the stray key", () => {
    expect(findUnknownKeys(valid, dataset, "dataset", allowlist)).toEqual([]);
  });

  it("descends into arrays and names the containing element", () => {
    const text = `${valid}\n    dtaa_type: int\n`;
    const findings = findUnknownKeys(text, dataset, "dataset", allowlist);

    expect(findings).toHaveLength(1);
    expect(findings[0].key).toBe("dtaa_type");
    expect(findings[0].path).toBe("columns[0]");
    expect(findings[0].suggestion).toBe("data_type");
  });

  it("follows $ref into $defs", () => {
    const dimension = schemaFor("dimension");
    const text = [
      "unique_name: currency",
      "object_type: dimension",
      "label: Currency",
      "type: standard",
      "hierarchies:",
      "  - unique_name: currency_h",
      "    label: Currency",
      "    lvels:",
      "      - unique_name: currency",
    ].join("\n");

    const findings = findUnknownKeys(text, dimension, "dimension", allowlist);
    expect(findings.map((f) => f.key)).toEqual(["lvels"]);
    expect(findings[0].suggestion).toBe("levels");
    expect(findings[0].path).toBe("hierarchies[0]");
  });

  it("does not report the contents of a key it has already reported", () => {
    // The sub-tree of an unknown key has no applicable schema, so walking into it
    // would turn one honest finding into a cascade of invented ones.
    const text = `${valid}\nextras:\n  anything: 1\n  nested:\n    deeper: 2\n`;
    expect(findUnknownKeys(text, dataset, "dataset", allowlist).map((f) => f.key)).toEqual(["extras"]);
  });

  describe("the known-spec-gap allowlist", () => {
    const dimension = schemaFor("dimension");
    const withGaps = [
      "unique_name: currency",
      "object_type: dimension",
      "label: Currency",
      "type: standard",
      "hierarchies:",
      "  - unique_name: currency_h",
      "    label: Currency",
      "    levels:",
      "      - unique_name: currency",
      "        visualize_in_bi_tool: false",
      "        secondary_attributes:",
      "          - unique_name: currency_code",
      "            label: Code",
      "            is_unique_key: false",
    ].join("\n");

    it("stays quiet on the gaps ps-utils' own serializer emits", () => {
      expect(index.knownUndocumented.length).toBeGreaterThan(0);
      expect(findUnknownKeys(withGaps, dimension, "dimension", allowlist)).toEqual([]);
    });

    it("would report them without it, which is what makes it load-bearing", () => {
      expect(
        findUnknownKeys(withGaps, dimension, "dimension", Allowlist.empty()).map((f) => f.key),
      ).toEqual(["visualize_in_bi_tool", "is_unique_key"]);
    });

    it("is scoped to the class the gap exists on, not the bare key name", () => {
      // `visualize_in_bi_tool` is allowlisted on a hierarchy level. At the root of
      // a dimension it is just as wrong as any other stray key, and a flat
      // key-name allowlist would have let it through.
      const misplaced = `${withGaps}\nvisualize_in_bi_tool: false\n`;
      const findings = findUnknownKeys(misplaced, dimension, "dimension", allowlist);
      expect(findings.map((f) => f.key)).toEqual(["visualize_in_bi_tool"]);
      expect(findings[0].path).toBe("");
    });

    it("is scoped to the object type too", () => {
      // Nothing allowlists `is_unique_key` on a dataset column.
      const text = `${valid}\n    is_unique_key: true\n`;
      expect(findUnknownKeys(text, dataset, "dataset", allowlist).map((f) => f.key)).toEqual([
        "is_unique_key",
      ]);
    });
  });

  it("ignores the YAML merge key, whose contents belong to the anchor", () => {
    const text = [
      "base: &base",
      "  label: Shared",
      "unique_name: d.dataset",
      "object_type: dataset",
      "connection_id: c",
      "columns: []",
      "<<: *base",
    ].join("\n");
    expect(findUnknownKeys(text, dataset, "dataset", allowlist).map((f) => f.key)).toEqual(["base"]);
  });

  it("returns nothing rather than throwing on unparseable YAML", () => {
    expect(findUnknownKeys("columns:\n  - [unclosed\n", dataset, "dataset", allowlist)).toEqual([]);
  });

  it("stays silent where the schema stops describing the shape", () => {
    // `label` is a string. A mapping there is a type error for the YAML extension
    // to report; this linter has no properties to judge the keys against.
    const text = "object_type: dataset\nlabel:\n  whatever: 1\n";
    expect(findUnknownKeys(text, dataset, "dataset", allowlist)).toEqual([]);
  });
});

describe("the committed SML corpus", () => {
  const files = corpusFiles();

  it("covers every object type the corpus contains", () => {
    expect(files.length).toBeGreaterThan(20);
  });

  // The regression test that keeps the channel trustworthy: ps-utils' own output
  // must never warn. A failure here means either a real spec gap that belongs in
  // KNOWN_UNDOCUMENTED, or a bug in the walk.
  it.each(files)("reports nothing for $file", ({ objectType, text }) => {
    expect(findUnknownKeys(text, schemaFor(objectType), objectType, allowlist)).toEqual([]);
  });
});
