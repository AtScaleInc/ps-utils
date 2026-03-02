/**
 * Tests for ExtractAtScaleModelOperation parameter handling.
 */
import { describe, expect, it, vi } from "vitest";
import { buildServiceRegistry } from "../../services/index.js";
import { ExtractAtScaleModelOperation } from "../extract-atscale-model/ExtractAtScaleModelOperation.js";
import { buildLogger } from "../../logging.js";

function captureConsole(): { stop: () => string[] } {
  const output: string[] = [];
  const spy = vi.spyOn(console, "log").mockImplementation((message?: unknown) => {
    output.push(String(message));
  });
  return {
    stop: () => {
      spy.mockRestore();
      return output;
    },
  };
}

describe("ExtractAtScaleModelOperation", () => {
  it("accepts model and output parameters", async () => {
    const services = await buildServiceRegistry();
    const logger = buildLogger({});
    const operation = new ExtractAtScaleModelOperation(services, logger);

    const logs = captureConsole();
    operation.run({
      model: "sales-model",
      "connection-file": "./connection.json",
      "connection-name": "prod",
      "output-model-file": "./model.json",
    });
    const output = logs.stop();

    expect(output).toEqual([]);
  });
});
