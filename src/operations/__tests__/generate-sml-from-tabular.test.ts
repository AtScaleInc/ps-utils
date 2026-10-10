import { load } from "js-yaml";
import { describe, expect, it } from "vitest";
import { convertTabularToSml, type TmslDocument } from "../generate-sml-from-tabular/tabular-converter.js";

/**
 * Synthetic TMSL fixture exercising the highest-risk logic ported from
 * tabular_to_sml.py:
 *   - a role-play family: "Order Date" and "Ship Date" both read from the
 *     same physical source (EDW.dbo.vd_date) and must collapse into one
 *     consolidated "Date Dimension", wired to the fact via two role_play
 *     relationships ("Order {0}" / "Ship {0}") recovered from each table's
 *     own column-alias prefix.
 *   - a simple measure (SalesAmount = SUM([Amount])) that converts to a metric.
 *   - a whitelisted DAX measure (GrowthPct = DIVIDE(...)) that now converts
 *     verbatim as an AtScale server-side DAX calculation.
 *   - a measure with no cube-side equivalent (LastServiceDate = FIRSTDATE(...))
 *     that must still be deferred, and a calculation over it (ServiceRatio) that
 *     is deferred with it - SML rejects a calculation naming a missing metric.
 *   - a table with a measure but no outgoing relationship ("Lookup") --
 *     modeled as a dimension only, its measure excluded/deferred.
 *   - an orphan table ("Staging") with no relationships at all -- excluded.
 */
const fixture: TmslDocument = {
  createOrReplace: {
    database: {
      model: {
        tables: [
          {
            name: "Order Date",
            columns: [
              { name: "Order Dte", dataType: "dateTime" },
              { name: "Order Yr", dataType: "int64" },
              { name: "Order Yr Qtr", dataType: "string" },
              { name: "Order Yr Mnth", dataType: "string" },
            ],
            partitions: [{
              source: {
                type: "query",
                query: 'SELECT date_key "Order Dte", cal_year "Order Yr", cal_year_qtr "Order Yr Qtr", ' +
                  'cal_year_month "Order Yr Mnth"\nFROM EDW.dbo.vd_date',
              },
            }],
          },
          {
            name: "Ship Date",
            columns: [
              { name: "Ship Dte", dataType: "dateTime" },
              { name: "Ship Yr", dataType: "int64" },
              { name: "Ship Yr Qtr", dataType: "string" },
              { name: "Ship Yr Mnth", dataType: "string" },
            ],
            partitions: [{
              source: {
                type: "query",
                query: 'SELECT date_key "Ship Dte", cal_year "Ship Yr", cal_year_qtr "Ship Yr Qtr", ' +
                  'cal_year_month "Ship Yr Mnth"\nFROM EDW.dbo.vd_date',
              },
            }],
          },
          {
            name: "Lookup",
            columns: [
              { name: "Key", dataType: "int64" },
              { name: "Val", dataType: "string" },
            ],
            measures: [{ name: "LookupCount", expression: "COUNTROWS('Lookup')" }],
            partitions: [{
              source: { type: "query", query: 'SELECT key, val\nFROM EDW.dbo.d_lookup' },
            }],
          },
          {
            name: "Staging",
            columns: [{ name: "Id", dataType: "int64" }],
          },
          {
            name: "Sales",
            columns: [
              { name: "OrderDateKey", dataType: "int64" },
              { name: "ShipDateKey", dataType: "int64" },
              { name: "LookupKey", dataType: "int64" },
              { name: "Amount", dataType: "decimal" },
            ],
            measures: [
              { name: "SalesAmount", expression: "SUM([Amount])" },
              { name: "PriorSalesAmount", expression: "SUM([Amount])" },
              { name: "Units", expression: "SUM([Amount])" },
              { name: "GrowthPct", expression: "DIVIDE([SalesAmount],[PriorSalesAmount])" },
              { name: "LastServiceDate", expression: "FIRSTDATE('Order Date'[Order Dte])" },
              { name: "Sales/Unit", expression: "DIVIDE([SalesAmount],[Units])" },
              // Converts on its own, but its measure doesn't - so it is deferred with it.
              { name: "ServiceRatio", expression: "DIVIDE([SalesAmount],[LastServiceDate])" },
            ],
            partitions: [{
              source: {
                type: "query",
                query: 'SELECT order_date_key "OrderDateKey", ship_date_key "ShipDateKey", ' +
                  'lookup_key "LookupKey", amount "Amount"\nFROM EDW.dbo.f_sales',
              },
            }],
          },
        ],
        relationships: [
          { fromTable: "Sales", fromColumn: "OrderDateKey", toTable: "Order Date", toColumn: "DateKey" },
          { fromTable: "Sales", fromColumn: "ShipDateKey", toTable: "Ship Date", toColumn: "DateKey" },
          { fromTable: "Sales", fromColumn: "LookupKey", toTable: "Lookup", toColumn: "Key" },
        ],
      },
    },
  },
};

function convert() {
  return convertTabularToSml(fixture, {
    tmslFileName: "fixture.xmla",
    warehouse: "Snowflake",
    database: "EDW",
    schema: "DBO",
    modelName: "sales_model",
    currency: "USD",
    tmslRawContent: JSON.stringify(fixture),
  });
}

describe("generate-sml-from-tabular converter", () => {
  it("collapses role-play family members into one consolidated time dimension", () => {
    const { sml } = convert();
    const dim = load(sml.get("dimensions/Date Dimension.yml")!) as any;

    expect(dim.type).toBe("time");
    const levelNames = dim.hierarchies[0].levels.map((l: any) => l.unique_name);
    expect(levelNames).toEqual(["Yr", "Yr Qtr", "Yr Mnth", "Dte"]);

    // Individual Tabular tables must NOT get their own dimension file.
    expect(sml.has("dimensions/Order Date.yml")).toBe(false);
    expect(sml.has("dimensions/Ship Date.yml")).toBe(false);
  });

  it("wires the fact to the family via recovered role_play prefixes", () => {
    const { sml } = convert();
    const modelYaml = load(sml.get("models/sales_model.yml")!) as any;
    const rels = modelYaml.relationships as any[];

    const toDate = rels.filter((r) => r.to.dimension === "Date Dimension");
    expect(toDate).toHaveLength(2);
    const rolePlays = toDate.map((r) => r.role_play).sort();
    expect(rolePlays).toEqual(["Order {0}", "Ship {0}"]);

    const toLookup = rels.find((r) => r.to.dimension === "Lookup");
    expect(toLookup).toBeDefined();
    expect(toLookup.role_play).toBeUndefined();
  });

  it("keeps dataset and dimension unique_names distinct and updates every reference", () => {
    const { sml } = convert();
    const datasets = [...sml.entries()]
      .filter(([file]) => file.startsWith("datasets/"))
      .map(([, yaml]) => load(yaml) as any);
    const dimensions = [...sml.entries()]
      .filter(([file]) => file.startsWith("dimensions/"))
      .map(([, yaml]) => load(yaml) as any);

    const datasetNames = new Set(datasets.map((dataset) => dataset.unique_name.toLowerCase()));
    const dimensionNames = new Set(dimensions.map((dimension) => dimension.unique_name.toLowerCase()));
    expect([...datasetNames].filter((name) => dimensionNames.has(name))).toEqual([]);

    expect((load(sml.get("datasets/Date Dimension.yml")!) as any).unique_name)
      .toBe("Date Dimension.dataset");
    expect((load(sml.get("datasets/Lookup.yml")!) as any).unique_name)
      .toBe("Lookup.dataset");

    for (const dimension of dimensions) {
      for (const attribute of dimension.level_attributes ?? []) {
        expect(datasetNames.has(attribute.dataset.toLowerCase())).toBe(true);
      }
    }

    const metric = load(sml.get("metrics/SalesAmount.yml")!) as any;
    expect(metric.dataset).toBe("Sales");

    const model = load(sml.get("models/sales_model.yml")!) as any;
    expect(model.relationships.every((relationship: any) => relationship.from.dataset === "Sales"))
      .toBe(true);
    expect(model.relationships.some((relationship: any) => relationship.to.dimension === "Date Dimension"))
      .toBe(true);
    expect(model.relationships.some((relationship: any) => relationship.to.dimension === "Lookup"))
      .toBe(true);
  });

  it("converts a simple measure to a base metric", () => {
    const { sml } = convert();
    const metric = load(sml.get("metrics/SalesAmount.yml")!) as any;
    expect(metric.calculation_method).toBe("sum");
    expect(metric.column).toBe("AMOUNT");
  });

  it("converts a whitelisted DAX measure to a verbatim calculation", () => {
    const { sml } = convert();
    expect(sml.has("metrics/GrowthPct.yml")).toBe(false);

    const calc = load(sml.get("calculations/GrowthPct.yml")!) as any;
    expect(calc.object_type).toBe("metric_calc");
    expect(calc.expression).toBe("DIVIDE([SalesAmount],[PriorSalesAmount])");
    expect(sml.get("DEFERRED_MEASURES.md")).not.toContain("GrowthPct");
  });

  it("does not let a slash in a measure name create a nested directory", () => {
    const { sml } = convert();
    // "Sales/Unit" must not land at calculations/Sales/Unit.yml.
    expect([...sml.keys()].every((k) => k.split("/").length <= 2)).toBe(true);
    const calc = load(sml.get("calculations/Sales-Unit.yml")!) as any;
    expect(calc.unique_name).toBe("Sales/Unit");
  });

  it("defers a calculation whose referenced measure was deferred", () => {
    const { sml } = convert();
    expect(sml.has("calculations/ServiceRatio.yml")).toBe(false);
    expect(sml.get("DEFERRED_MEASURES.md")).toContain("ServiceRatio");
    const report = JSON.parse(sml.get("CONVERSION_REPORT.json")!);
    expect(report.issues.some((i: any) => i.category === "calculation_references_deferred_measure" && i.object === "ServiceRatio")).toBe(true);
  });

  it("still defers a measure with no cube-side equivalent", () => {
    const { sml } = convert();
    expect(sml.has("calculations/LastServiceDate.yml")).toBe(false);
    expect(sml.get("DEFERRED_MEASURES.md")).toContain("LastServiceDate");
    expect(sml.get("DEFERRED_MEASURES.md")).toContain("LookupCount");
  });

  it("excludes orphan tables and reports the conversion summary", () => {
    const { sml } = convert();
    expect(sml.has("datasets/Staging.yml")).toBe(false);

    const report = JSON.parse(sml.get("CONVERSION_REPORT.json")!);
    expect(report.orphanTables).toEqual(["Staging"]);
    expect(report.excludedMeasureTables).toEqual(["Lookup"]);
    expect(report.summary.rolePlayFamilies).toBe(1);
    expect(report.summary.rolePlaySourceTablesCollapsed).toBe(2);
    expect(report.summary.measuresDeferred).toBe(2); // LastServiceDate, and ServiceRatio over it
    expect(report.summary.metricsConverted).toBe(3);
    expect(report.summary.calculationsConverted).toBe(2);
  });
});

/**
 * Shapes from a real Tabular export that SML's validator rejected:
 *   - a table with a column named like the table ("Code" in table "Code"): the level is
 *     named after the table, so that column must not come back as a same-named
 *     secondary attribute (it reads the level's own key column - a redundant copy)
 *   - a partition query selecting one physical column twice (`code` and
 *     `code "Code"`): one dataset column per name
 *   - a select item that is an expression with an implicit alias
 *     (`CASE ... END code_bucket`): a calculated column named by the alias
 */
const codeFixture: TmslDocument = {
  createOrReplace: {
    database: {
      model: {
        tables: [
          {
            name: "Code",
            columns: [
              { name: "code", dataType: "int64", isHidden: true },
              { name: "Code", dataType: "int64" },
              { name: "Code Descr", dataType: "string" },
              { name: "code_bucket", dataType: "string" },
            ],
            partitions: [{
              source: {
                type: "query",
                query: 'SELECT\n\t code\n\t,code\t\t"Code"\n\t,code_descr\t"Code Descr"\n' +
                  "\t,CASE WHEN code <> -1\n        THEN 'known' END\tcode_bucket\n\nFROM EDW.dbo.d_code ;",
              },
            }],
          },
          {
            name: "Claims",
            columns: [
              { name: "CodeKey", dataType: "int64" },
              { name: "Amount", dataType: "decimal" },
            ],
            measures: [{ name: "Claim Amount", expression: "SUM([Amount])" }],
            partitions: [{
              source: { type: "query", query: 'SELECT code_key "CodeKey", amount "Amount"\nFROM EDW.dbo.f_claims' },
            }],
          },
        ],
        relationships: [{ fromTable: "Claims", fromColumn: "CodeKey", toTable: "Code", toColumn: "code" }],
      },
    },
  },
};

describe("generate-sml-from-tabular SML conformance", () => {
  const { sml } = convertTabularToSml(codeFixture, {
    tmslFileName: "codes.xmla", warehouse: "Postgres", database: "edw", schema: "dbo", modelName: "claims_model",
    tmslRawContent: JSON.stringify(codeFixture),
  });

  it("drops a secondary attribute that repeats its level over the same column", () => {
    const dim = load(sml.get("dimensions/Code.yml")!) as any;
    const level = dim.hierarchies[0].levels[0];
    const names = (level.secondary_attributes ?? []).map((a: any) => a.unique_name);
    expect(level.unique_name).toBe("Code");
    expect(names).not.toContain("Code");
    expect(names).toContain("Code Descr");
    const report = JSON.parse(sml.get("CONVERSION_REPORT.json")!);
    expect(report.issues.some((i: any) => i.category === "attribute_name_clash")).toBe(true);
  });

  it("emits a physical column read twice only once", () => {
    const dataset = load(sml.get("datasets/Code.yml")!) as any;
    const names = dataset.columns.map((c: any) => c.name);
    expect(names.filter((n: string) => n === "code")).toHaveLength(1);
  });

  it("turns an implicitly aliased expression into a calculated column named by its alias", () => {
    const dataset = load(sml.get("datasets/Code.yml")!) as any;
    const bucket = dataset.columns.find((c: any) => c.name === "code_bucket");
    expect(bucket.sql).toMatch(/^CASE WHEN code <> -1\s+THEN 'known' END$/);
    expect(dataset.columns.some((c: any) => /case_when/.test(c.name))).toBe(false);
  });
});
