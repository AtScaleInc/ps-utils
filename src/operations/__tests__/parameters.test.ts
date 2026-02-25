import { describe, expect, it } from "vitest";
import { BooleanParameter, NumberParameter, ParameterSet, StringParameter } from "../Parameters.js";

/**
 * Tests for parameter parsing, defaults, and validation.
 */
class DemoParameterSet extends ParameterSet {
  parameters = [
    new (class extends StringParameter {
      name = "name";
      description = "Name";
      required = true;
    })(),
    new (class extends NumberParameter {
      name = "count";
      description = "Count";
      required = false;
      defaultValue = 2;
    })(),
    new (class extends BooleanParameter {
      name = "enabled";
      description = "Enabled";
      required = false;
      defaultValue = false;
    })(),
  ];
}

describe("ParameterSet", () => {
  it("parses values and applies defaults", () => {
    const set = new DemoParameterSet();
    const parsed = set.parse({ name: "example" });

    expect(parsed).toEqual({
      name: "example",
      count: 2,
      enabled: false,
    });
  });

  it("rejects unknown parameters", () => {
    const set = new DemoParameterSet();
    expect(() => set.parse({ name: "example", unknown: "x" })).toThrow(
      "Unknown parameter"
    );
  });

  it("validates boolean and number values", () => {
    const set = new DemoParameterSet();

    expect(() => set.parse({ name: "example", count: "nope" })).toThrow(
      "must be a number"
    );
    expect(() => set.parse({ name: "example", enabled: "maybe" })).toThrow(
      "must be true or false"
    );
  });
});
