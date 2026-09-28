import fs from "fs";
import os from "os";
import path from "path";
import { afterEach, describe, expect, it } from "vitest";
import { buildServiceRegistry } from "../../services/index.js";
import type { Logger } from "../../logging.js";
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
