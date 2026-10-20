import { describe, it, expect } from "vitest";
import { infoSchemaView } from "../ExtractDDLFromConnectionOperation.js";
import type { SqlConnection } from "../../../services/SqlService.js";

const conn = (dialect: string, extra: object = {}) => ({ dialect, ...extra }) as unknown as SqlConnection;

describe("infoSchemaView", () => {
  it("qualifies INFORMATION_SCHEMA with project and dataset on BigQuery, which has no unqualified form", () => {
    const bq = conn("bigquery", { client: { projectId: "my-proj" } });
    expect(infoSchemaView(bq, "tpcds", "TABLES")).toBe("`my-proj.tpcds`.INFORMATION_SCHEMA.TABLES");
  });

  it("leaves every other dialect's SQL text exactly as it was", () => {
    for (const d of ["snowflake", "postgres", "databricks", "redshift"]) {
      expect(infoSchemaView(conn(d), "PUBLIC", "COLUMNS")).toBe("INFORMATION_SCHEMA.COLUMNS");
    }
  });
});
