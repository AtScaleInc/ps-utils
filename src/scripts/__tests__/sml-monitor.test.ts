/**
 * Tests for the SML monitor's report parsing and position mapping.
 *
 * The mapping is the part with real risk: `atscale-list-model-errors` reports
 * problems against SML object names, and turning those into file positions is
 * guesswork that has to be right often enough to be worth a squiggle. The
 * fixtures below use the shapes the operation actually emits — every `location`
 * string here is copied from a literal in `AtScaleListModelErrorsOperation.ts`.
 */
import * as fs from "fs";
import * as path from "path";
import { describe, expect, it } from "vitest";
import {
  buildNameIndex,
  describeFailure,
  formatProblem,
  locateProblem,
  parseLocation,
  parseReport,
  quotedNames,
  refineWithinFile,
  stripNodeWarnings,
} from "../../../vscode-extension/src/sml-monitor-core";
import type { ModelProblem } from "../../../vscode-extension/src/sml-monitor-core";

const CORPUS_DIR = path.join(__dirname, "fixtures/sml-corpus");

/** The corpus, read the way the monitor reads a watched directory. */
function corpus(): { file: string; text: string }[] {
  const files: { file: string; text: string }[] = [];
  for (const sub of ["models", "dimensions", "datasets", "connections"]) {
    const full = path.join(CORPUS_DIR, sub);
    if (!fs.existsSync(full)) continue;
    for (const entry of fs.readdirSync(full).sort()) {
      if (!/\.ya?ml$/i.test(entry)) continue;
      const file = path.join(full, entry);
      files.push({ file, text: fs.readFileSync(file, "utf8") });
    }
  }
  return files;
}

const index = buildNameIndex(corpus());

const problem = (over: Partial<ModelProblem>): ModelProblem => ({
  phase: "structural",
  severity: "error",
  message: "",
  ...over,
});

// ──────────────────────────────────────────────────────────────────────────────

describe("parseReport", () => {
  const report = { model: "Sales", problems: [], summary: { errors: 0, warnings: 0 } };

  it("finds the report even though log lines share stdout", () => {
    // buildLogger sends log/info to stdout too, so the JSON is never alone there.
    const stdout = [
      "Validating model: Sales",
      "Phase 1 found 0 structural problem(s).",
      JSON.stringify(report, null, 2),
      "",
    ].join("\n");
    expect(parseReport(stdout)).toEqual(report);
  });

  it("takes the last report when a run somehow emits two", () => {
    const first = { model: "Old", problems: [] };
    const stdout = [JSON.stringify(first, null, 2), JSON.stringify(report, null, 2), ""].join("\n");
    expect(parseReport(stdout)?.model).toBe("Sales");
  });

  it("is not fooled by a brace in a log line", () => {
    const stdout = ["{ this is not json", JSON.stringify(report, null, 2), ""].join("\n");
    expect(parseReport(stdout)).toEqual(report);
  });

  it("returns undefined when the operation threw before reporting", () => {
    expect(parseReport("Error: Connection 'prod' not found in connections file\n")).toBeUndefined();
    expect(parseReport("")).toBeUndefined();
  });
});

describe("parseLocation", () => {
  it("reads the four shapes the operation emits", () => {
    expect(parseLocation("datasets/queries")).toEqual({ directory: "datasets", name: "queries" });
    expect(parseLocation("dimensions/query_details")).toEqual({
      directory: "dimensions",
      name: "query_details",
    });
    expect(parseLocation("models/ → rel_query")).toEqual({ directory: "models", name: "rel_query" });
    // `connectionId: …` names an AtScale connection group, not an SML object.
    expect(parseLocation("connectionId: default")).toBeUndefined();
    expect(parseLocation(undefined)).toBeUndefined();
  });

  it("accepts an ascii arrow, in case the operation stops using →", () => {
    expect(parseLocation("models/ -> rel_query")).toEqual({
      directory: "models",
      name: "rel_query",
    });
  });
});

describe("quotedNames", () => {
  it("pulls the object names out of a message in order", () => {
    expect(
      quotedNames("Relationship 'rel_a': join_column 'user_id' not found in dataset 'queries'"),
    ).toEqual(["rel_a", "user_id", "queries"]);
  });
});

describe("buildNameIndex", () => {
  it("indexes the corpus and points at the value, not the key", () => {
    const declarations = index.get("query_details.dataset");
    expect(declarations).toBeDefined();
    const [declaration] = declarations!;
    const line = fs.readFileSync(declaration.file, "utf8").split(/\r?\n/)[declaration.line];
    expect(line.slice(declaration.column, declaration.column + declaration.length)).toBe(
      "query_details.dataset",
    );
    expect(declaration.directory).toBe("datasets");
  });

  it("finds no duplicate name in the corpus, as SML uniqueness requires", () => {
    // Not a formality: it is why picking declarations[0] is almost always right,
    // and why a duplicate is worth handling but not worth optimising for.
    expect([...index.entries()].filter(([, d]) => d.length > 1)).toEqual([]);
  });

  it("keeps every declaration when a name is duplicated anyway", () => {
    // Which is exactly the state a validation run exists to catch, so the index
    // must not collapse them and lose one of the two places to point at.
    const built = buildNameIndex([
      { file: "/x/datasets/a.yml", text: "unique_name: dup" },
      { file: "/x/dimensions/b.yml", text: "unique_name: dup" },
    ]);
    expect(built.get("dup")).toHaveLength(2);
  });

  it("strips quotes and trailing comments from the value", () => {
    const built = buildNameIndex([
      { file: "/x/datasets/a.yml", text: 'unique_name: "quoted_name"  # trailing' },
    ]);
    const [declaration] = built.get("quoted_name")!;
    expect(declaration.column).toBe(14); // inside the opening quote
    expect(declaration.length).toBe("quoted_name".length);
  });
});

describe("locateProblem", () => {
  it("resolves a dataset problem to its declaration", () => {
    const found = locateProblem(
      problem({
        message: "Dataset 'query_details.dataset': missing 'connection_id'",
        location: "datasets/query_details.dataset",
      }),
      index,
    );
    expect(found?.directory).toBe("datasets");
    expect(found?.file.endsWith("query_details.yml")).toBe(true);
  });

  it("prefers the declaration in the directory the location named", () => {
    // Valid SML has no duplicate names (see the corpus test above), so this only
    // bites on a file that is itself broken — which is when the monitor runs.
    const collided = buildNameIndex([
      { file: "/x/datasets/a.yml", text: "unique_name: dup" },
      { file: "/x/dimensions/b.yml", text: "unique_name: dup" },
    ]);

    expect(locateProblem(problem({ location: "datasets/dup" }), collided)?.directory).toBe(
      "datasets",
    );
    expect(locateProblem(problem({ location: "dimensions/dup" }), collided)?.directory).toBe(
      "dimensions",
    );
    // No directory hint at all: first declaration wins rather than nothing.
    expect(locateProblem(problem({ message: "Dataset 'dup': broken" }), collided)).toBeDefined();
  });

  it("falls back to a name quoted in the message when there is no location", () => {
    const found = locateProblem(
      problem({ message: "Relationship 'r': from.dataset 'query_details.dataset' not found" }),
      index,
    );
    expect(found?.file.endsWith("query_details.yml")).toBe(true);
  });

  it("returns undefined for a problem that names no SML object", () => {
    // Attaching this to an arbitrary file would be a squiggle on innocent code.
    expect(
      locateProblem(
        problem({
          phase: "engine",
          severity: "warning",
          message: "Engine validation failed for connectionId='default': timeout",
          location: "connectionId: default",
        }),
        index,
      ),
    ).toBeUndefined();
  });

  it("returns undefined when the named object is not in the directory at all", () => {
    expect(
      locateProblem(problem({ message: "Dataset 'ghost': missing", location: "datasets/ghost" }), index),
    ).toBeUndefined();
  });
});

describe("refineWithinFile", () => {
  const text = [
    "unique_name: queries.dataset",
    "object_type: dataset",
    "label: Queries",
    "connection_id: ghost_connection",
    "columns:",
    "  - name: user_id",
  ].join("\n");
  const declaration = buildNameIndex([{ file: "/x/datasets/queries.yml", text }]).get(
    "queries.dataset",
  )![0];

  it("moves the squiggle onto the value that caused the problem", () => {
    // Pointing at `unique_name` is technically the right object and the wrong
    // line: the edit the user has to make is four lines down.
    const refined = refineWithinFile(
      declaration,
      problem({
        message:
          "Dataset 'queries.dataset': connection_id 'ghost_connection' not found in connections/. Known: testconn",
        location: "datasets/queries.dataset",
      }),
      text,
    );
    expect(refined.line).toBe(3);
    expect(text.split("\n")[refined.line].slice(refined.column, refined.column + refined.length)).toBe(
      "ghost_connection",
    );
  });

  it("keeps the declaration when the offending value is not in the file", () => {
    // The usual shape of a "not found" error: the thing named is missing, so
    // there is no better line and the object's own is the honest answer.
    const refined = refineWithinFile(
      declaration,
      problem({ message: "Dataset 'queries.dataset': key_column 'absent_col' not found" }),
      text,
    );
    expect(refined).toEqual(declaration);
  });

  it("does not match a value that merely contains the name", () => {
    const refined = refineWithinFile(
      declaration,
      problem({ message: "Dimension 'd' la 'l': name_column 'user' not found" }),
      text,
    );
    expect(refined).toEqual(declaration); // `user_id` must not satisfy `user`
  });

  it("matches a list item, not just a key's value", () => {
    const refined = refineWithinFile(
      declaration,
      problem({ message: "Relationship 'r': join_column 'user_id' is not unique" }),
      text,
    );
    expect(refined.line).toBe(5);
  });
});

describe("formatProblem", () => {
  it("matches the operation's own log format", () => {
    expect(
      formatProblem(problem({ message: "Dataset 'x': missing", location: "datasets/x" })),
    ).toBe("  [ERROR][structural] [datasets/x] Dataset 'x': missing");
    expect(formatProblem(problem({ phase: "engine", severity: "warning", message: "slow" }))).toBe(
      "  [WARN ][engine] slow",
    );
  });
});

describe("describeFailure", () => {
  it("prefers the operation's own error over the exit code", () => {
    expect(describeFailure("", "Error: Model 'Sales' not found in /sml/models/\n", 1)).toBe(
      "Error: Model 'Sales' not found in /sml/models/",
    );
  });

  it("ignores Node's warning block, which the bundled CLI really does emit", () => {
    // Verbatim from a run of the bundled CLI. Reporting the last line of stderr
    // would blame `(Use \`node --trace-warnings …\`)` for a failure caused by the
    // connection — a real error with a nonsense reason attached.
    const stderr = [
      "(node:415399) Warning: NodeVersionSupportWarning: The AWS SDK for JavaScript (v3)",
      "versions published after the first week of January 2027",
      "will require node >=22. You are running node v18.19.1.",
      "",
      "More information can be found at: https://a.co/c895JFp",
      "(Use `node --trace-warnings ...` to show where the warning was created)",
      "Connection 'no_such_connection' not found in connections file",
      "",
    ].join("\n");
    expect(describeFailure("", stderr, 1)).toBe(
      "Connection 'no_such_connection' not found in connections file",
    );
  });

  it("falls back to the exit code when the warning was all there was", () => {
    const stderr = [
      "(node:1) Warning: something",
      "(Use `node --trace-warnings ...` to show where the warning was created)",
      "",
    ].join("\n");
    expect(describeFailure("", stderr, 1)).toBe("atscale-list-model-errors exited with code 1");
  });

  it("strips an unterminated warning block too", () => {
    expect(stripNodeWarnings("(node:1) Warning: no terminator\nmore prose\n").trim()).toBe("");
  });

  it("falls back to stdout, then to the exit code", () => {
    expect(describeFailure("something went wrong\n", "", 1)).toBe("something went wrong");
    expect(describeFailure("", "", 3)).toBe("atscale-list-model-errors exited with code 3");
  });
});
