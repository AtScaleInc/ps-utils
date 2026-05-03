import { describe, expect, it } from "vitest";
import { buildServiceRegistry } from "../../services/index.js";
import { ExtractAtScaleModelOperation } from "../extract-model-from-atscale/ExtractAtScaleModelOperation.js";
import { buildLogger } from "../../logging.js";

describe("ExtractAtScaleModelOperation", () => {
  it("accepts model and output parameters without parameter errors", async () => {
    const services = await buildServiceRegistry();
    const logger = buildLogger({});
    const operation = new ExtractAtScaleModelOperation(services, logger);

    expect(() =>
      operation.parameters.parse({
        model: "sales-model",
        "connection-file": "./connection.json",
        "connection-name": "prod",
        "output-model-file": "./model.json",
      })
    ).not.toThrow();
  });
});
