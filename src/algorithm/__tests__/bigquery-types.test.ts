import { describe, it, expect } from "vitest";
import { isIntegerType, isNumericType, toSemanticType } from "../types.js";

// BigQuery's INFORMATION_SCHEMA.COLUMNS reports INT64/FLOAT64, not INTEGER/FLOAT.
describe("BigQuery column types", () => {
  it("treats INT64 as an integer measure candidate", () => {
    expect(isNumericType("INT64")).toBe(true);
    expect(isIntegerType("INT64")).toBe(true);
    expect(toSemanticType("INT64")).toBe("integer");
  });

  it("treats FLOAT64, NUMERIC and BIGNUMERIC as decimals", () => {
    for (const t of ["FLOAT64", "NUMERIC", "BIGNUMERIC", "BIGDECIMAL"]) {
      expect(isNumericType(t)).toBe(true);
      expect(toSemanticType(t)).toBe("decimal");
    }
  });

  it("keeps STRING, BOOL and TIMESTAMP classified as before", () => {
    expect(toSemanticType("STRING")).toBe("string");
    expect(toSemanticType("BOOL")).toBe("boolean");
    expect(toSemanticType("TIMESTAMP")).toBe("timestamp");
  });
});
