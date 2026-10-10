import fs from "fs";
import { fileURLToPath } from "url";
import { load } from "js-yaml";
import { describe, expect, it } from "vitest";
import { buildLogger } from "../../logging.js";
import { convertXmlToSml } from "../generate-sml-from-xml/xml-converter.js";

/**
 * Output SML's own validator rejects (SML-develop packages/models/src/schemas +
 * packages/validator), seen converting a real AdventureWorks project export:
 *   - `<sql dialect>` variants for engines SML has no dialect value for
 *   - default_member written as {literal_value, apply_in_query}
 *   - a format on an attribute whose name_column is a string column
 *   - catalog version 1.5 ("different from the latest supported version" warning)
 *   - two cubes each declaring the same dimension -> "<name>" and an identical "<name>_2"
 *     ("duplicated dataset and key_columns combination ... Please remove duplicates")
 */
const fixture = fileURLToPath(new URL("./fixtures/sml-conformance.xml", import.meta.url));
const duplicateDimensionFixture = fileURLToPath(new URL("./fixtures/duplicate-cube-dimension.xml", import.meta.url));
const namingFixture = fileURLToPath(new URL("./fixtures/naming-and-relationships.xml", import.meta.url));

async function convertNaming(): Promise<Map<string, string>> {
  return convertXmlToSml(fs.readFileSync(namingFixture, "utf8"), {}, buildLogger({}));
}
const byUniqueName = (sml: Map<string, string>, prefix: string, name: string): any =>
  [...sml].filter(([k]) => k.startsWith(prefix)).map(([, v]) => load(v) as any).find((d) => d.unique_name === name);

async function convert(): Promise<Map<string, string>> {
  return convertXmlToSml(fs.readFileSync(fixture, "utf8"), { xmlFileName: "sml-conformance.xml" }, buildLogger({}));
}

describe("generate-sml-from-xml SML conformance", () => {
  it("keeps only dialects SML accepts and reports the rest", async () => {
    const sml = await convert();
    const dataset = load(sml.get("datasets/region.yml")!) as any;
    const label = dataset.columns.find((c: any) => c.name === "opened_label");
    expect(label.sql).toContain("to_char");
    expect(label.dialects.map((d: any) => d.dialect)).toEqual(["Snowflake"]);
    const readme = sml.get("README.md")!;
    expect(readme).toContain("region → opened_label (Redshift)");
    expect(readme).toContain("region → opened_label (Oracle)");
  });

  it("writes default_member as expression / apply_only_when_in_query", async () => {
    const sml = await convert();
    const dim = load(sml.get("dimensions/region.yml")!) as any;
    expect(dim.hierarchies[0].default_member).toEqual({ expression: "[Region].[Region Hierarchy].[Region].&[1]" });
  });

  it("leaves a format off an attribute whose name column is a string, and reports it", async () => {
    const sml = await convert();
    const dim = load(sml.get("dimensions/region.yml")!) as any;
    const opened = dim.hierarchies[0].levels[0].secondary_attributes.find((a: any) => a.unique_name === "Opened");
    expect(opened.name_column).toBe("opened_label");
    expect(opened.format).toBeUndefined();
    expect(sml.get("README.md")!).toContain('Its name_column "opened_label" is a string column');
  });

  it("declares the latest SML version sml-cli supports", async () => {
    const sml = await convert();
    expect((load(sml.get("catalog.yml")!) as any).version).toBe(1.7);
  });

  it("merges a dimension two cubes declared identically, and points both models at it", async () => {
    const sml = await convertXmlToSml(fs.readFileSync(duplicateDimensionFixture, "utf8"), {}, buildLogger({}));
    expect([...sml.keys()].filter((k) => k.startsWith("dimensions/"))).toEqual(["dimensions/order-details.yml"]);
    const models = [...sml].filter(([k]) => k.startsWith("models/")).map(([, v]) => load(v) as any);
    expect(models).toHaveLength(2);
    for (const m of models) expect(m.dimensions).toEqual(["Order Details"]);
    expect([...sml.values()].some((v) => v.includes("Order Details_2") && !v.startsWith("# "))).toBe(false);
    expect(sml.get("README.md")!).toContain("Order Details_2 → Order Details");
  });

  it("keeps XML names verbatim - they are the MDX query names reports use", async () => {
    const sml = await convert();
    const metric = [...sml].find(([k]) => k.startsWith("metrics/"))!;
    expect((load(metric[1]) as any).unique_name).toBe("Sales Amount");
    const model = load([...sml].find(([k]) => k.startsWith("models/"))![1]) as any;
    expect(model.metrics.map((m: any) => m.unique_name)).toContain("Sales Amount");
  });

  it("writes a link to another dimension as embedded, to that dimension's key level", async () => {
    const sml = await convertNaming();
    const customer = byUniqueName(sml, "dimensions/", "Customer Dimension");
    expect(customer.relationships).toEqual([{
      unique_name: "CustomerDimension_GenderDimension",
      from: { dataset: "customer.dataset", join_columns: ["gender"], hierarchy: "Customer Hierarchy", level: "Customer Name" },
      to: { dimension: "Gender Dimension", level: "Gender Name" },
      type: "embedded",
    }]);
  });

  it("gives two names that slug alike their own files, and copies MDX verbatim", async () => {
    const sml = await convertNaming();
    expect(byUniqueName(sml, "calculations/", "Answers").expression).toBe("[Measures].[Sales Amount] * 2");
    expect(byUniqueName(sml, "calculations/", "Answers %").expression).toBe("[Measures].[Answers] / [Measures].[Sales Amount]");
    expect(sml.has("calculations/answers.yml") && sml.has("calculations/answers-2.yml")).toBe(true);
  });

  it("skips an empty cube and gives a measure-less one a hidden Number of Rows metric", async () => {
    const sml = await convertNaming();
    const models = [...sml].filter(([k]) => k.startsWith("models/")).map(([, v]) => load(v) as any);
    expect(models.map((m) => m.unique_name).sort()).toEqual(["Dims Only Cube", "Sales Cube"]);
    expect(models.find((m) => m.unique_name === "Dims Only Cube").metrics).toEqual([{ unique_name: "rows" }]);
    const rows = byUniqueName(sml, "metrics/", "rows");
    expect(rows).toMatchObject({ label: "Number of Rows", calculation_method: "sum", column: "rows", dataset: "fact_sales.dataset", is_hidden: true });
    const fact = byUniqueName(sml, "datasets/", "fact_sales.dataset");
    expect(fact.columns).toContainEqual({ name: "rows", data_type: "int", sql: "1" });
  });

  it("separates a level that repeats another's dataset + key by extending its key", async () => {
    const sml = await convertNaming();
    const gender = byUniqueName(sml, "dimensions/", "Gender Dimension");
    const levels = Object.fromEntries(gender.level_attributes.map((l: any) => [l.unique_name, l.key_columns]));
    expect(levels).toEqual({ "Gender Name": ["gender"], "Gender Code": ["gender", "gender_label"] });
  });

  it("keeps a shortened metric's full name as its query name", async () => {
    const long = "m_QA_WEEK_ON_TIME_DELIVERED_PALLET_ALLOC_TO_STORE_DEL_12DAYS_sum_extra";
    const xml = fs.readFileSync(namingFixture, "utf8").replace('name="Sales Amount"', `name="${long}"`);
    const sml = await convertXmlToSml(xml, {}, buildLogger({}));
    const model = byUniqueName(sml, "models/", "Sales Cube");
    const [short, override] = Object.entries(model.overrides as Record<string, { query_name: string }>)[0];
    expect(short.length).toBeLessThanOrEqual(63);
    expect(override.query_name).toBe(long);
  });

  it("refuses a project whose every cube is empty", async () => {
    const xml = `<schema name="Empty"><cubes><cube id="c" name="Nothing" /></cubes></schema>`;
    await expect(convertXmlToSml(xml, {}, buildLogger({}))).rejects.toThrow("No populated cubes");
  });

  it("folds a quantile group's instances into one percentile metric SML names them from", async () => {
    // SML names each quantile "<metric>_instance_<value>" itself - the names the XML's
    // instances (and any MDX using them) already carry.
    const xml = fs.readFileSync(namingFixture, "utf8")
      .replace('<data-set-ref id="ds-fact">\n          <logical>', '<data-set-ref id="ds-fact">\n          <logical><attribute-ref id="m-p" complete="true"><column>sales_amount</column></attribute-ref>')
      .replace("</attributes>\n      <data-sets>", `
        <attribute id="m-p" name="m_p"><properties><type><measure><key-ref id="kr-amount" /></measure></type></properties></attribute>
        <attribute id="g-p" name="m_p_group"><properties><visible>false</visible><type><quantile-group><attribute-ref id="m-p" /><compression>200</compression></quantile-group></type></properties></attribute>
        <attribute id="i-50" name="m_p_instance_0.5"><properties><caption>P PCTL-50</caption><type><quantile-instance><quantile-group-ref id="g-p" /><quantile-val>0.5</quantile-val></quantile-instance></type></properties></attribute>
        <attribute id="i-90" name="m_p_instance_0.9"><properties><caption>P PCTL-90</caption><type><quantile-instance><quantile-group-ref id="g-p" /><quantile-val>0.9</quantile-val></quantile-instance></type></properties></attribute>
      </attributes>\n      <data-sets>`);
    const sml = await convertXmlToSml(xml, {}, buildLogger({}));
    const metric = byUniqueName(sml, "metrics/", "m_p");
    expect(metric).toMatchObject({ calculation_method: "percentile", compression: 200, custom_quantiles: [0.5, 0.9], label: "P" });
    expect([...sml.keys()].some((k) => k.includes("instance"))).toBe(false);
  });
});
