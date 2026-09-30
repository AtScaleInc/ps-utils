import fs from "fs";
import os from "os";
import path from "path";
import { fileURLToPath } from "url";
import { afterEach, describe, expect, it } from "vitest";
import { parse } from "yaml";
import { buildServiceRegistry } from "../../services/index.js";
import { buildLogger } from "../../logging.js";
import {
  GenerateSMLFromDDLOperation,
  parseColumnTypesParam,
} from "../generate-sml-from-ddl/GenerateSMLFromDDLOperation.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE = path.join(here, "..", "..", "algorithm", "__tests__", "fixtures", "multi-schema-views.ddl.sql");

const tempDirs: string[] = [];
afterEach(() => {
  for (const d of tempDirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});

describe("parseColumnTypesParam", () => {
  it("splits on commas and semicolons outside parentheses", () => {
    expect(parseColumnTypesParam("T.A=NUMBER(38,6), T.B = DATE;S.T.C=VARCHAR")).toEqual({
      "T.A": "NUMBER(38,6)", "T.B": "DATE", "S.T.C": "VARCHAR",
    });
    expect(parseColumnTypesParam(undefined)).toBeUndefined();
    expect(() => parseColumnTypesParam("T.A")).toThrow(/expected TABLE.COLUMN=TYPE/);
  });
});

describe("generate-sml-from-ddl on views-only multi-schema DDL", () => {
  it("writes datasets, per-schema connections and measures", async () => {
    const outputDir = fs.mkdtempSync(path.join(os.tmpdir(), "gen-sml-ddl-"));
    tempDirs.push(outputDir);
    const services = await buildServiceRegistry();
    const operation = new GenerateSMLFromDDLOperation(services, buildLogger({}));

    await operation.run({
      "ddl-file":        FIXTURE,
      "model-name":      "Ledger",
      "output-dir":      outputDir,
      "connection-name": "wh",
      "sml-config-file": path.join(outputDir, "does-not-exist.yaml"),
      dialect:           "snowflake",
      "fact-tables":     "VW_LEDGER",
      "column-types":    "VW_LEDGER.Amount=NUMBER(38,6);VW_LEDGER.Date=DATE;VW_CALENDAR.Date=DATE",
    });

    const files = (dir: string) => fs.readdirSync(path.join(outputDir, dir)).sort();
    expect(files("connections")).toEqual(["wh-dims.yml", "wh-facts.yml", "wh-hier.yml"]);
    expect(files("datasets")).toEqual(expect.arrayContaining(["VW_LEDGER.yml", "VW_CALENDAR.yml", "VW_ACCOUNT_SNAP.yml"]));
    expect(files("metrics").length).toBeGreaterThan(0);

    const model = parse(fs.readFileSync(path.join(outputDir, "models", "ledger.yml"), "utf8"));
    const joinCols = model.relationships.map((r: { from: { join_columns: string[] } }) => r.from.join_columns[0]);
    expect(new Set(joinCols)).toEqual(new Set(["Date", "Account", "Cost_Center"]));

    const style = parse(fs.readFileSync(path.join(outputDir, "sml.style.yaml"), "utf8"));
    expect(style).toMatchObject({
      "views-as-tables": true,
      "infer-key-name-joins": true,
      "column-types": { "VW_LEDGER.Amount": "NUMBER(38,6)" },
      relationships: [],
    });
    expect(fs.readFileSync(path.join(outputDir, "STYLE.md"), "utf8")).toContain("**Column Type Overrides**");
  });

  it("generates nothing from views when views-as-tables is false", async () => {
    const outputDir = fs.mkdtempSync(path.join(os.tmpdir(), "gen-sml-ddl-"));
    tempDirs.push(outputDir);
    const services = await buildServiceRegistry();
    const operation = new GenerateSMLFromDDLOperation(services, buildLogger({}));
    await operation.run({
      "ddl-file":        FIXTURE,
      "output-dir":      outputDir,
      "connection-name": "wh",
      "sml-config-file": path.join(outputDir, "does-not-exist.yaml"),
      "views-as-tables": false,
    });
    expect(fs.existsSync(path.join(outputDir, "datasets"))).toBe(false);
  });
});
