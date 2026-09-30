import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";
import { DdlDatabaseMetaData } from "../ddl-reader.js";
import { proposeSemanticModel, parseRelationshipSpec } from "../semantic-model-builder.js";
import { toTitleCase } from "../types.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE = fs.readFileSync(path.join(here, "fixtures", "multi-schema-views.ddl.sql"), "utf8");

const LEDGER_TYPES = { "VW_LEDGER.Amount": "NUMBER(38,6)", "VW_LEDGER.Date": "DATE", "VW_CALENDAR.Date": "DATE" };

async function buildFixtureModel(extra: Parameters<typeof proposeSemanticModel>[2] = {}) {
  const db = DdlDatabaseMetaData.fromDdl(FIXTURE, { columnTypes: LEDGER_TYPES });
  return proposeSemanticModel(db, "Ledger", {
    sampleSize: 0,
    factTables: ["VW_LEDGER"],
    sml: { connectionName: "wh", dialect: "snowflake" },
    ...(typeof extra === "object" ? extra : {}),
  });
}

describe("views-only, multi-schema DDL → semantic model", () => {
  it("classifies views, infers key-name joins and measures", async () => {
    const model = await buildFixtureModel();
    expect(model.facts.map((f) => f.sourceTable)).toEqual(["VW_LEDGER"]);
    expect(model.facts[0].measures.map((m) => m.sourceColumn)).toEqual(expect.arrayContaining(["Amount"]));
    const joins = model.relationships.map((r) => `${r.fromColumn}->${r.toColumn}`).sort();
    expect(joins).toEqual(["Account->Account", "Cost_Center->Cost_Center", "Date->Date"]);
    // Unreferenced snapshot view gets no join.
    expect(model.warnings.join("\n")).not.toContain('"VW_REGION_SNAP"."Region"');
  });

  it("emits one connection per schema and points each dataset at its schema's connection", async () => {
    const model = await buildFixtureModel();
    const sml = model.sml!;
    const connectionFiles = Array.from(sml.keys()).filter((k) => k.startsWith("connections/")).sort();
    expect(connectionFiles).toEqual([
      "connections/wh-dims.yml",
      "connections/wh-facts.yml",
      "connections/wh-hier.yml",
    ]);
    const hier = parse(sml.get("connections/wh-hier.yml")!);
    expect(hier).toMatchObject({
      unique_name: "wh_HIER", object_type: "connection", as_connection: "wh",
      database: "ANALYTICS_DB", schema: "HIER",
    });
    expect(parse(sml.get("datasets/VW_LEDGER.yml")!).connection_id).toBe("wh_FACTS");
    expect(parse(sml.get("datasets/VW_CALENDAR.yml")!).connection_id).toBe("wh_DIMS");
    expect(parse(sml.get("datasets/VW_ACCOUNT_SNAP.yml")!).connection_id).toBe("wh_HIER");
  });

  it("an explicit database option overrides the DDL database", async () => {
    const model = await buildFixtureModel({
      sampleSize: 0, factTables: ["VW_LEDGER"],
      sml: { connectionName: "wh", database: "PROD_DB" },
    });
    expect(parse(model.sml!.get("connections/wh-hier.yml")!).database).toBe("PROD_DB");
  });

  it("uses declared relationships when key-name inference is disabled", async () => {
    const model = await buildFixtureModel({
      sampleSize: 0, factTables: ["VW_LEDGER"],
      inferKeyNameJoins: false,
      relationships: ["FACTS.VW_LEDGER.Account -> VW_ACCOUNT_SNAP.Account", "VW_LEDGER.Nope -> VW_X.Y", "garbage"],
      sml: { connectionName: "wh" },
    });
    expect(model.relationships.map((r) => `${r.fromColumn}->${r.toColumn}`)).toEqual(["Account->Account"]);
    const warnings = model.warnings.join("\n");
    expect(warnings).toContain('"VW_LEDGER.Nope -> VW_X.Y" does not match');
    expect(warnings).toContain('Could not parse "garbage"');
  });
});

describe("key-name join inference guards", () => {
  it("skips ambiguous targets and leaves tables with declared FKs alone", async () => {
    const db = DdlDatabaseMetaData.fromDdl(`
      CREATE TABLE a_dim (code VARCHAR(10) PRIMARY KEY, label VARCHAR(50));
      CREATE TABLE b_dim (code VARCHAR(10) PRIMARY KEY, label VARCHAR(50));
      CREATE TABLE c_dim (region VARCHAR(10) PRIMARY KEY, label VARCHAR(50));
      CREATE TABLE f1 (code VARCHAR(10), amount DECIMAL(10,2));
      CREATE TABLE f2 (id INT, region VARCHAR(10), amount DECIMAL(10,2),
        FOREIGN KEY (id) REFERENCES a_dim (code));
    `);
    const model = await proposeSemanticModel(db, "M", { sampleSize: 0 });
    expect(model.warnings.join("\n")).toContain('[AMBIGUOUS JOIN] "f1"."code"');
    // f2 declares an FK, so its "region" column is not inferred as a join to c_dim.
    expect(model.warnings.join("\n")).not.toContain('"f2"."region"');
  });
});

describe("single-schema output is unchanged in shape", () => {
  it("emits a single connection named after connectionName, using the table schema", async () => {
    const db = DdlDatabaseMetaData.fromDdl(`
      CREATE TABLE sales.dim_product (product_id INT PRIMARY KEY, product_name VARCHAR(50), category VARCHAR(50));
      CREATE TABLE sales.fact_sales (sale_id INT PRIMARY KEY, product_id INT, amount DECIMAL(10,2),
        FOREIGN KEY (product_id) REFERENCES sales.dim_product (product_id));
    `);
    const model = await proposeSemanticModel(db, "Sales", { sampleSize: 0, sml: { connectionName: "wh" } });
    const connectionFiles = Array.from(model.sml!.keys()).filter((k) => k.startsWith("connections/"));
    expect(connectionFiles).toEqual(["connections/wh.yml"]);
    expect(parse(model.sml!.get("connections/wh.yml")!)).toMatchObject({ unique_name: "wh", schema: "sales" });
    expect(parse(model.sml!.get("datasets/fact_sales.yml")!).connection_id).toBe("wh");
  });
});

describe("helpers", () => {
  it("parseRelationshipSpec accepts schema-qualified and quoted names", () => {
    expect(parseRelationshipSpec(`S.T."Col A" -> U.V`)).toEqual({ fromTable: "T", fromColumn: "Col A", toTable: "U", toColumn: "V" });
    expect(parseRelationshipSpec("T.C")).toBeNull();
  });

  it("toTitleCase keeps runs of capitals together", () => {
    expect(toTitleCase("VW_FLOW_SNAP")).toBe("VW FLOW SNAP");
    expect(toTitleCase("FactInternetSales")).toBe("Fact Internet Sales");
    expect(toTitleCase("HTTPServerLog")).toBe("HTTP Server Log");
    expect(toTitleCase("day_in_week")).toBe("Day In Week");
    expect(toTitleCase("OrderID")).toBe("Order ID");
  });
});
