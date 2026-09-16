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
 *   - a complex DAX measure (GrowthPct = DIVIDE(...)) that must be deferred.
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
              { name: "GrowthPct", expression: "DIVIDE([SalesAmount],[PriorSalesAmount])" },
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

  it("converts a simple measure and defers a complex DAX measure", () => {
    const { sml } = convert();
    const metric = load(sml.get("metrics/SalesAmount.yml")!) as any;
    expect(metric.calculation_method).toBe("sum");
    expect(metric.column).toBe("AMOUNT");

    expect(sml.has("metrics/GrowthPct.yml")).toBe(false);
    expect(sml.get("DEFERRED_MEASURES.md")).toContain("GrowthPct");
    expect(sml.get("DEFERRED_MEASURES.md")).toContain("DIVIDE");
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
    expect(report.summary.measuresDeferred).toBe(1);
    expect(report.summary.metricsConverted).toBe(1);
  });
});
