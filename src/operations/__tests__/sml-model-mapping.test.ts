import { describe, expect, it } from "vitest";
import { buildModelMapping, CATALOG_SCOPE, mappingTables, type MappingInput } from "../sml-model-mapping.js";
import { generateReportFromSml, type SmlCollection } from "../generate-report-from-sml/sml-report-generator.js";

// A snowflake Product dimension (product → subcategory) and a Date dimension with one duplicate secondary.
function input(): MappingInput {
  return {
    datasets: [
      { unique_name: "sales", table: "fact_sales", connection_id: "c" },
      { unique_name: "product", connection_id: "c" },
      { unique_name: "subcategory", connection_id: "c" },
      { unique_name: "dates", connection_id: "c" },
    ],
    metrics: [
      { unique_name: "m_amount", label: "Amount", calculation_method: "sum", dataset: "sales", column: "amount", format: "$#,##0" },
      { unique_name: "m_price", label: "Unit Price", calculation_method: "sum", dataset: "sales", column: "unit_price" },
    ],
    dimensions: [
      {
        unique_name: "Product",
        label: "Product",
        hierarchies: [{ unique_name: "ph", levels: [{ unique_name: "Subcategory" }, { unique_name: "Product" }] }],
        level_attributes: [
          { unique_name: "Subcategory", dataset: "subcategory", key_columns: ["subcat_key"], name_column: "subcat_name" },
          { unique_name: "Product", dataset: "product", key_columns: ["product_key"], name_column: "product_name" },
        ],
        relationships: [{ type: "snowflake", from: { dataset: "product", join_columns: ["subcat_key"] }, to: { level: "Subcategory" } }],
      },
      {
        unique_name: "Date",
        label: "Date",
        hierarchies: [{ unique_name: "dh", levels: [{ unique_name: "Day", secondary_attributes: [{ unique_name: "day_copy", label: "Day", dataset: "dates", key_columns: ["day_id"] }] }] }],
        level_attributes: [{ unique_name: "Day", label: "Day", dataset: "dates", key_columns: ["day_id"], name_column: "day_id" }],
      },
      { unique_name: "Orphan", hierarchies: [], level_attributes: [] },
    ],
    models: [
      {
        unique_name: "Sales",
        object_type: "model",
        metrics: [{ unique_name: "m_amount", folder: "Sales" }, { unique_name: "m_price" }, { unique_name: "calc_margin" }],
        relationships: [
          { unique_name: "to_product", from: { dataset: "sales", join_columns: ["product_key"] }, to: { dimension: "Product", level: "Product" } },
          { unique_name: "to_date", from: { dataset: "sales.dataset", join_columns: ["date_key"] }, to: { dimension: "Date", level: "Day" } },
        ],
      },
    ],
    calculations: [{ unique_name: "calc_margin" }],
  };
}

describe("buildModelMapping", () => {
  it("builds the metric, relationship, attribute and coverage tables", () => {
    const m = buildModelMapping(input());
    expect(m.metrics.map((r) => [r.metric_name, r.fact_table, r.folder])).toEqual([
      ["m_amount", "fact_sales", "Sales"],
      ["m_price", "fact_sales", ""],
    ]);
    expect(m.relationships.map((r) => [r.dimension_name, r.join_level, r.dimension_dataset, r.dimension_key_column])).toEqual([
      ["Product", "Product", "product", "product_key"],
      ["Date", "Day", "dates", "day_id"],
    ]);
    // `.dataset` suffixes are normalized, so the Date relationship still reaches both metrics.
    expect(m.coverage.map((r) => `${r.metric_name}/${r.dimension_name}=${r.attribute_count}`)).toEqual([
      "m_amount/Product=2",
      "m_amount/Date=2",
      "m_price/Product=2",
      "m_price/Date=2",
    ]);
    expect(m.attributes.find((r) => r.attribute_name === "Product")?.attribute_type).toBe("Join Level");
    expect(m.attributes.find((r) => r.attribute_name === "day_copy")).toMatchObject({ attribute_type: "Secondary", level_number: 1, level_name: "Day" });
  });

  it("does not flag a snowflake level its relationships reach, or a referenced calculation", () => {
    const issues = buildModelMapping(input()).issues.map((i) => i.issue);
    expect(issues.some((i) => i.includes("Subcategory"))).toBe(false);
    expect(issues.some((i) => i.includes("calc_margin"))).toBe(false);
  });

  it("detects each kind of issue, errors first", () => {
    const i = input();
    (i.dimensions[0].relationships as unknown[]).length = 0; // break the snowflake join
    i.models[0].metrics.push({ unique_name: "m_gone" });
    i.metrics.push({ unique_name: "m_orphan_ds", calculation_method: "sum", dataset: "deleted_ds", column: "x" });
    i.models[0].metrics.push({ unique_name: "m_orphan_ds" });

    const issues = buildModelMapping(i).issues;
    const summary = issues.map((x) => `${x.severity}:${x.object_name}`);
    expect(summary).toEqual([
      "error:m_gone",
      "error:m_orphan_ds",
      "warning:m_price",
      "warning:Date",
      "warning:Date",
      "warning:Product",
      "info:Orphan",
    ]);
    expect(issues.map((x) => x.issue_number)).toEqual([1, 2, 3, 4, 5, 6, 7]);
    expect(issues[3].issue).toBe("Secondary attribute day_copy repeats level Day's key column day_id");
    expect(issues[4].issue).toBe('Label "day" is used by Day, day_copy');
    expect(issues[5].issue).toBe("Levels Subcategory come from subcategory, which no relationship joins to product");
    expect(issues[6].model_name).toBe(CATALOG_SCOPE);
  });

  it("excludes requested models but still counts their dimensions as used", () => {
    const i = input();
    i.models.push({ unique_name: "catalog_cube", object_type: "model", dimensions: ["Orphan"], metrics: [{ unique_name: "m_amount" }], relationships: [] });
    const m = buildModelMapping(i, { excludeModels: ["catalog_cube"] });
    expect(m.metrics.every((r) => r.model_name === "Sales")).toBe(true);
    expect(m.issues.some((x) => x.object_name === "Orphan")).toBe(false);
  });

  it("lists the five mapping tables in a fixed order", () => {
    expect(mappingTables(buildModelMapping(input())).map((t) => t.name)).toEqual([
      "model_metrics",
      "model_relationships",
      "model_dimension_attributes",
      "model_metric_coverage",
      "model_issues",
    ]);
  });
});

describe("generate-report-from-sml model mapping sections", () => {
  it("renders the mapping per model and a catalog-wide issues table", () => {
    const i = input();
    const wrap = (raw: Record<string, unknown>, dir: string) => ({ file: `${dir}/${String(raw.unique_name)}.yml`, raw });
    const c: SmlCollection = {
      connections: [],
      datasets: i.datasets.map((d) => wrap(d, "datasets")),
      dimensions: i.dimensions.map((d) => wrap(d, "dimensions")),
      metrics: i.metrics.map((d) => wrap(d, "metrics")),
      calculations: (i.calculations ?? []).map((d) => wrap(d, "calculations")),
      models: i.models.map((d) => wrap(d, "models")),
      other: [],
    };
    const md = generateReportFromSml(c, { title: "T" });
    expect(md).toContain("- [Model Mapping](#model-mapping)");
    expect(md).toContain("- [Issues and Recommendations](#issues-and-recommendations)");
    expect(md).toContain("2 metric(s) from 1 fact dataset(s) (`sales`), joined to 2 dimension(s) through 2 relationship(s): 4 attribute(s) and 8 metric-to-attribute path(s).");
    expect(md).toContain("| Amount | 2 | 2 | 4 |");
    expect(md).toContain("| 1 | warning | Sales | `m_price` | Unit Price sums unit_price |");
    expect(md.indexOf("## Model Mapping")).toBeLessThan(md.indexOf("## Issues and Recommendations"));
  });
});
