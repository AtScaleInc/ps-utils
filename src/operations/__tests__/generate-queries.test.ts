import fs from "fs";
import os from "os";
import path from "path";
import { afterEach, describe, expect, it } from "vitest";
import { buildServiceRegistry } from "../../services/index.js";
import type { Logger } from "../../logging.js";
import { GenerateQueriesFromSMLOperation } from "../generate-queries-from-sml/GenerateQueriesFromSMLOperation.js";
import { GenerateQueriesFromModelOperation } from "../generate-queries-from-model/GenerateQueriesFromModelOperation.js";

const logger: Logger = { log() {}, info() {}, error() {}, verbose() {} };
const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

function tempDir(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

function readJson(file: string): any[] {
  return JSON.parse(fs.readFileSync(file, "utf8"));
}

async function runModelOp(dir: string, params: Record<string, string> = {}) {
  const op = new GenerateQueriesFromModelOperation(await buildServiceRegistry(), logger);
  const xmla = path.join(dir, "out", "xmla.json");
  const sql = path.join(dir, "out", "sql.json");
  await op.run({
    "model-file": path.join(dir, "model.yaml"),
    "xmla-output-file": xmla,
    "sql-output-file": sql,
    ...params,
  } as any);
  return { xmla: readJson(xmla), sql: readJson(sql) };
}

describe("GenerateQueriesFromModelOperation", () => {
  it("puts the level name, not its caption, in the MDX brackets", async () => {
    const dir = tempDir("generate-queries-from-model-");
    fs.writeFileSync(
      path.join(dir, "model.yaml"),
      [
        "envmgr_build_test:",
        "  mdx:",
        "    metrics:",
        "      - query_name: salesamount",
        "        caption: Sales Amount",
        "    attributes:",
        "      Product:",
        "        Product Hierarchy:",
        "          - query_name: productkey",
        "            caption: Product",
        "            level_number: 1",
        "",
      ].join("\n"),
    );

    const { xmla, sql } = await runModelOp(dir);
    const level = xmla.find((q) => q.queryName.startsWith("Product |"));
    expect(level.queryName).toBe("Product | Product Hierarchy | Product");
    expect(level.originalText).toContain("[Product].[Product Hierarchy].[productkey].MEMBERS");
    expect(level.originalText).not.toContain("[Product].MEMBERS");

    const sqlLevel = sql.find((q) => q.queryName === level.queryName);
    expect(sqlLevel.originalText).toContain('GROUP BY "productkey"');
  });
});

describe("GenerateQueriesFromSMLOperation", () => {
  it("uses unique_names in MDX and SQL, labels only in the query name", async () => {
    const dir = tempDir("generate-queries-from-sml-");
    for (const sub of ["models", "metrics", "dimensions"]) {
      fs.mkdirSync(path.join(dir, sub), { recursive: true });
    }
    fs.writeFileSync(path.join(dir, "models", "sales.yml"), [
      "unique_name: sales_model",
      "object_type: model",
      "label: Sales",
      "metrics:",
      "  - unique_name: salesamount",
      "relationships:",
      "  - unique_name: fact_to_product",
      "    from: { dataset: fact, join_columns: [productkey] }",
      "    to: { dimension: product_dim, level: product_level }",
      "",
    ].join("\n"));
    fs.writeFileSync(path.join(dir, "metrics", "salesamount.yml"), [
      "unique_name: salesamount",
      "object_type: metric",
      "label: Sales Amount",
      "",
    ].join("\n"));
    fs.writeFileSync(path.join(dir, "dimensions", "product.yml"), [
      "unique_name: product_dim",
      "object_type: dimension",
      "label: Product",
      "hierarchies:",
      "  - unique_name: product_hier",
      "    label: Product Hierarchy",
      "    levels:",
      "      - unique_name: product_level",
      "level_attributes:",
      "  - unique_name: product_level",
      "    label: Product Name",
      "    dataset: dim_product",
      "    name_column: english_product_name",
      "    key_columns: [productkey]",
      "",
    ].join("\n"));

    const op = new GenerateQueriesFromSMLOperation(await buildServiceRegistry(), logger);
    const xmlaPath = path.join(dir, "out", "xmla.json");
    const sqlPath = path.join(dir, "out", "sql.json");
    await op.run({ "sml-dir": dir, "xmla-output-file": xmlaPath, "sql-output-file": sqlPath });

    const name = "Product | Product Hierarchy | Product Name";
    const mdx = readJson(xmlaPath).find((q) => q.queryName === name);
    expect(mdx.originalText).toContain("[product_dim].[product_hier].[product_level].MEMBERS");

    const sql = readJson(sqlPath).find((q) => q.queryName === name);
    expect(sql.originalText).toContain('GROUP BY "product_level"');
    expect(sql.originalText).not.toContain("english_product_name");
  });
});
