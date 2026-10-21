import { describe, it, expect } from "vitest";
import { percentileAgg, quoter } from "../sql-helpers.js";

describe("percentileAgg", () => {
  it("emits exactly the original SQL text for every non-BigQuery dialect", () => {
    for (const dialect of [undefined, "snowflake", "postgres", "databricks"]) {
      expect(percentileAgg(dialect, 0.5, "x")).toBe("PERCENTILE_CONT(0.50) WITHIN GROUP (ORDER BY x)");
      expect(percentileAgg(dialect, 0.9, "x")).toBe("PERCENTILE_CONT(0.90) WITHIN GROUP (ORDER BY x)");
      expect(percentileAgg(dialect, 0.95, "x")).toBe("PERCENTILE_CONT(0.95) WITHIN GROUP (ORDER BY x)");
      expect(percentileAgg(dialect, 0.99, "x")).toBe("PERCENTILE_CONT(0.99) WITHIN GROUP (ORDER BY x)");
    }
  });

  it("uses APPROX_QUANTILES on BigQuery, which has no WITHIN GROUP", () => {
    expect(percentileAgg("bigquery", 0.5, "n")).toBe("APPROX_QUANTILES(n, 100)[OFFSET(50)]");
    expect(percentileAgg("BigQuery", 0.99, "n")).toBe("APPROX_QUANTILES(n, 100)[OFFSET(99)]");
  });
});

describe("quoter", () => {
  it("quotes BigQuery identifiers with backticks and keeps the dataset qualifier", () => {
    expect(quoter("bigquery").qualifyTable("sap_demo", "d_plant")).toBe("`sap_demo`.`d_plant`");
  });

  it("keeps ANSI double-quotes for Snowflake", () => {
    expect(quoter("snowflake").qualifyTable("PUBLIC", "T")).toBe('"PUBLIC"."T"');
  });
});
