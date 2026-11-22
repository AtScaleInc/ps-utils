import { describe, expect, it } from "vitest";
import {
  CATALOG_COLUMNS,
  buildCatalogRows,
  buildCsv,
  buildDCCubeObjects,
  buildValuesSql,
  inferConnectionId,
  type DCCubeInput,
} from "../generate-dc-cube-from-sml/dc-cube-builder.js";

function input(): DCCubeInput {
  return {
    metrics: [
      { unique_name: "m_sales", object_type: "metric", label: "Sales", calculation_method: "sum", dataset: "fact", column: "sales" },
      { unique_name: "m_cust", object_type: "metric", label: "Customers", calculation_method: "count distinct", dataset: "fact", column: "cust" },
      { unique_name: "m_other", object_type: "metric", label: "Other", calculation_method: "sum", dataset: "other_fact", column: "x" },
    ],
    dimensions: [
      {
        unique_name: "Date",
        object_type: "dimension",
        label: "Date Dimension",
        hierarchies: [{ unique_name: "h", levels: [{ unique_name: "Year" }, { unique_name: "Day", secondary_attributes: [{ unique_name: "day_name", label: "Day Name", dataset: "dates", key_columns: ["day_name"] }] }] }],
        level_attributes: [
          { unique_name: "Year", label: "Year", dataset: "dates", key_columns: ["year"] },
          { unique_name: "Day", label: "Day", dataset: "dates", key_columns: ["day_id"] },
        ],
      },
    ],
    models: [
      {
        unique_name: "Sales",
        object_type: "model",
        label: "Sales Model",
        metrics: [{ unique_name: "m_sales" }, { unique_name: "m_cust" }, { unique_name: "m_missing" }, { unique_name: "m_other" }],
        relationships: [{ unique_name: "fact_to_date ", from: { dataset: "fact", join_columns: ["date_key"] }, to: { dimension: "Date", level: "Day" } }],
      },
      // The cube's own model is never catalogued, so re-running is idempotent.
      { unique_name: "data_catalog_cube", object_type: "model", metrics: [{ unique_name: "m_sales" }], relationships: [{ from: { dataset: "fact" }, to: { dimension: "Date", level: "Day" } }] },
    ],
  };
}

describe("buildCatalogRows", () => {
  it("emits one row per model / metric / attribute path, marking the join level", () => {
    const { rows } = buildCatalogRows(input());
    // 2 metrics on `fact` × 3 attributes (Year, Day, day_name); m_other has no relationship from its dataset.
    expect(rows).toHaveLength(6);
    expect(rows.map((r) => r.catalog_row_id)).toEqual(["1", "2", "3", "4", "5", "6"]);
    expect(rows.filter((r) => r.measure_name === "m_sales").map((r) => [r.attribute_name, r.attribute_type])).toEqual([
      ["Year", "Level"],
      ["Day", "Join Level"],
      ["day_name", "Secondary Attribute"],
    ]);
    expect(rows[0]).toMatchObject({
      model_label: "Sales Model",
      measure_label: "Sales (Sum)",
      fact_join_key: "date_key",
      relationship_name: "fact_to_date",
      dimension_label: "Date Dimension",
      dimension_dataset: "dates",
      attribute_key_column: "year",
    });
    expect(rows.find((r) => r.measure_name === "m_cust")?.measure_label).toBe("Customers (Count Distinct)");
    expect(rows.some((r) => r.model_name === "data_catalog_cube")).toBe(false);
  });

  it("warns and skips missing references instead of throwing", () => {
    const i = input();
    i.models[0].relationships = [
      ...(i.models[0].relationships as unknown[]),
      { unique_name: "r2", from: { dataset: "fact", join_columns: ["k"] }, to: { dimension: "Ghost", level: "x" } },
    ];
    const { rows, warnings } = buildCatalogRows(i);
    expect(rows).toHaveLength(6);
    expect(warnings).toEqual(["Sales: dimension Ghost not found; skipped", "Sales: metric m_missing not found in metrics/; skipped"]);
  });
});

describe("cube outputs", () => {
  const { rows } = buildCatalogRows(input());

  it("escapes quotes in the VALUES query and CSV", () => {
    const quoted = rows.map((r) => ({ ...r, model_label: `O'Brien, "Sales"` }));
    expect(buildValuesSql(quoted)).toContain(`'O''Brien, "Sales"'`);
    expect(buildValuesSql(quoted)).toContain(`) AS t (${CATALOG_COLUMNS.join(", ")})`);
    expect(buildCsv(quoted).split("\r\n")[1]).toContain(`"O'Brien, ""Sales"""`);
  });

  it("builds a model whose dimensions are plain names and whose dataset is inline SQL by default", () => {
    const files = buildDCCubeObjects(rows, { modelName: "data_catalog_cube", datasetName: "data_catalog_relationships", connectionId: "conn" });
    expect(Object.keys(files)).toHaveLength(11);
    expect(files["models/data_catalog_cube.yml"].dimensions).toEqual(["dc_model", "dc_measure", "dc_fact", "dc_dimension"]);
    expect(files["datasets/data_catalog_relationships.yml"]).toMatchObject({ connection_id: "conn" });
    expect(files["datasets/data_catalog_relationships.yml"].sql).toMatch(/^SELECT \* FROM \(VALUES/);
    expect(files["datasets/data_catalog_relationships.yml"].table).toBeUndefined();
  });

  it("reads a physical table instead when one is given", () => {
    const files = buildDCCubeObjects(rows, { modelName: "m", datasetName: "d", connectionId: "conn", table: "data_catalog" });
    expect(files["datasets/d.yml"]).toMatchObject({ table: "data_catalog" });
    expect(files["datasets/d.yml"].sql).toBeUndefined();
  });

  it("infers the connection from the first catalogued fact dataset", () => {
    expect(inferConnectionId(rows, [{ unique_name: "fact", connection_id: "warehouse" }])).toBe("warehouse");
    expect(inferConnectionId(rows, [])).toBeUndefined();
  });
});
