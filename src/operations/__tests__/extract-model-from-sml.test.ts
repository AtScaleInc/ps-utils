import fs from "fs";
import os from "os";
import path from "path";
import { afterEach, describe, expect, it } from "vitest";
import { parse } from "yaml";
import { buildServiceRegistry } from "../../services/index.js";
import { buildLogger } from "../../logging.js";
import { ExtractModelFromSMLOperation } from "../extract-model-from-sml/ExtractModelFromSMLOperation.js";

const tempDirs: string[] = [];

/** The model label used by every fixture below, and therefore the output key. */
const MODEL_LABEL = "Sales Model";

/**
 * The single model entry in the output.
 *
 * model.yaml is keyed by the model's **label**, not its `unique_name` — matching
 * `extract-model-from-atscale`, which keys by the AtScale model name (see
 * `example/model.yaml`, keyed `Telemetry`). Asserting the key here rather than
 * indexing optionally means a change to that contract fails with the key it
 * actually produced, instead of an `undefined` several assertions later.
 */
function modelEntry(parsed: Record<string, any>): Record<string, any> {
  expect(Object.keys(parsed)).toEqual([MODEL_LABEL]);
  return parsed[MODEL_LABEL];
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe("ExtractModelFromSMLOperation", () => {
  it("includes metrics defined in calculations/ when resolving model metric refs", async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "extract-model-from-sml-"));
    tempDirs.push(tempDir);

    fs.mkdirSync(path.join(tempDir, "models"), { recursive: true });
    fs.mkdirSync(path.join(tempDir, "calculations"), { recursive: true });

    fs.writeFileSync(
      path.join(tempDir, "models", "sales.yml"),
      [
        "unique_name: sales_model",
        "label: Sales Model",
        "metrics:",
        "  - unique_name: sales_calc",
        "",
      ].join("\n"),
    );

    fs.writeFileSync(
      path.join(tempDir, "calculations", "sales-calc.yml"),
      [
        "unique_name: sales_calc",
        "label: Sales Calc",
        "object_type: metric_calc",
        "expression: sum([measure])",
        "",
      ].join("\n"),
    );

    const outputFile = path.join(tempDir, "model.yaml");
    const services = await buildServiceRegistry();
    const logger = buildLogger({});
    const operation = new ExtractModelFromSMLOperation(services, logger);

    await operation.run({
      "sml-dir": tempDir,
      "output-model-file": outputFile,
    });

    const parsed = parse(fs.readFileSync(outputFile, "utf8"));
    const model = modelEntry(parsed);

    expect(model.mdx.metrics).toHaveLength(1);
    expect(model.mdx.metrics[0].query_name).toBe("sales_calc");
  });

  it("resolves dimension refs when the model uses object entries for dimensions", async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "extract-model-from-sml-dim-"));
    tempDirs.push(tempDir);

    fs.mkdirSync(path.join(tempDir, "models"), { recursive: true });
    fs.mkdirSync(path.join(tempDir, "datasets"), { recursive: true });
    fs.mkdirSync(path.join(tempDir, "dimensions"), { recursive: true });

    fs.writeFileSync(
      path.join(tempDir, "models", "sales.yml"),
      [
        "unique_name: sales_model",
        "label: Sales Model",
        "dimensions:",
        "  - unique_name: region_dim",
        "",
      ].join("\n"),
    );

    fs.writeFileSync(
      path.join(tempDir, "datasets", "sales.yml"),
      [
        "unique_name: sales",
        "table: sales",
        "columns:",
        "  - name: region_id",
        "    data_type: string",
        "",
      ].join("\n"),
    );

    fs.writeFileSync(
      path.join(tempDir, "dimensions", "region.yml"),
      [
        "unique_name: region_dim",
        "label: Region",
        "level_attributes:",
        "  - unique_name: region_level_attr",
        "    dataset: sales",
        "    name_column: region_id",
        "hierarchies:",
        "  - unique_name: region_hierarchy",
        "    label: Region",
        "    levels:",
        "      - unique_name: region_level_attr",
        "",
      ].join("\n"),
    );

    const outputFile = path.join(tempDir, "model.yaml");
    const services = await buildServiceRegistry();
    const logger = buildLogger({});
    const operation = new ExtractModelFromSMLOperation(services, logger);

    await operation.run({
      "sml-dir": tempDir,
      "output-model-file": outputFile,
    });

    const parsed = parse(fs.readFileSync(outputFile, "utf8"));
    const attributes = modelEntry(parsed).mdx.attributes;

    expect(attributes.Region).toBeDefined();
    expect(attributes.Region["Region Hierarchy"]).toBeDefined();
  });
});
