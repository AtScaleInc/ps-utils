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
 */
const fixture = fileURLToPath(new URL("./fixtures/sml-conformance.xml", import.meta.url));

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
});
