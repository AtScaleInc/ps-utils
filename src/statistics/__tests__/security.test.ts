import { describe, expect, it } from "vitest";
import {
  bucketCold,
  bucketOverlap,
  roundPearsonR,
  isNearFunctional,
  sensitivityFor,
  containsAbsoluteDate,
  assertGeneratedKeyShape,
  assertFkClosure,
  hardenFingerprint,
  validateFingerprint,
  MIN_ROWS_FOR_UNMASKED_FINGERPRINT,
  SECURITY_PROFILE_VERSION,
} from "../security.js";
import type { SchemaFingerprint } from "../types.js";

/**
 * Regression coverage for the review-derived security controls.
 * Each block maps to a specific finding in review/01_risk_register.md
 * or control in review/03_obfuscation_tactics.md so that future edits
 * have a clear anchor back to the source requirement.
 */

function sampleFingerprint(): SchemaFingerprint {
  return {
    version:    "2.0",
    capturedAt: new Date().toISOString(),
    sampling:   { targetFactRows: 100_000, targetColumnRows: 10_000, confidenceLevel: 0.95, marginOfError: 0.05 },
    dimensions: [
      {
        id: "D1",
        rowCount: 10_000,
        hierarchies: [{
          id: "H1",
          levels: [
            { id: "L1", role: "root", memberCount: 10,  nullKeyFraction: 0 },
            { id: "L2", role: "leaf", memberCount: 100, nullKeyFraction: 0, coldMemberFraction: 0.42 },
          ],
        }],
      },
    ],
    facts: [{
      id: "F1",
      rowCount: 50_000,
      joins: [{
        toDimensionId: "D1", toLeafLevelId: "L2",
        nullFkFraction: 0, coverageFraction: 0.58,
        density: { avg: 500, stddev: 100, shape: "normal", p50: 500, p90: 650, p99: 800, max: 1000, sampled: false },
      }],
      measures: [{
        id: "F1.amount",
        aggregation: "sum", dataType: "decimal", additivity: "additive", nullFraction: 0,
        distribution: { shape: "normal", min: 0, max: 1_000, mean: 500, stddev: 50,
          percentiles: { p5: 420, p25: 470, p50: 500, p75: 530, p95: 580, p99: 650 } },
      }, {
        id: "F1.qty",
        aggregation: "sum", dataType: "integer", additivity: "additive", nullFraction: 0,
        distribution: { shape: "normal", min: 0, max: 100, mean: 50, stddev: 10,
          percentiles: { p5: 35, p25: 42, p50: 50, p75: 58, p95: 65, p99: 70 } },
      }],
      measureCorrelations: [
        { measureId1: "F1.amount", measureId2: "F1.qty", pearsonR: 0.8347291 },
      ],
      fkAssociations: [],
    }],
    conformedDimensions: [],
  };
}

describe("security / binning (review/01 R-4, R-10)", () => {
  it("buckets cold-member fractions into quartiles", () => {
    expect(bucketCold(0.00)).toBe("0-10%");
    expect(bucketCold(0.09)).toBe("0-10%");
    expect(bucketCold(0.15)).toBe("10-30%");
    expect(bucketCold(0.45)).toBe("30-60%");
    expect(bucketCold(0.95)).toBe("60-100%");
  });
  it("buckets overlap fractions into quartiles", () => {
    expect(bucketOverlap(0.00)).toBe("0-20%");
    expect(bucketOverlap(0.35)).toBe("20-50%");
    expect(bucketOverlap(0.70)).toBe("50-80%");
    expect(bucketOverlap(0.99)).toBe("80-100%");
  });
});

describe("security / Pearson r rounding (review/01 R-7)", () => {
  it("rounds to two decimal places", () => {
    expect(roundPearsonR(0.83472)).toBe(0.83);
    expect(roundPearsonR(-0.9876)).toBe(-0.99);
    expect(roundPearsonR(0)).toBe(0);
  });
});

describe("security / near-functional threshold (review/01 R-11)", () => {
  it("flags scores ≥ 0.90 as near-functional", () => {
    expect(isNearFunctional(0.89)).toBe(false);
    expect(isNearFunctional(0.90)).toBe(true);
    expect(isNearFunctional(0.95)).toBe(true);
  });
});

describe("security / sensitivity classification (review/04)", () => {
  it("classifies known patterns", () => {
    expect(sensitivityFor("customer_ssn")).toBe("Restricted");
    expect(sensitivityFor("email_address")).toBe("Confidential");
    expect(sensitivityFor("country")).toBe("Public");
  });
  it("defaults to Confidential for unknown patterns", () => {
    expect(sensitivityFor("wacky_field")).toBe("Confidential");
  });
});

describe("security / absolute-date rejector (review/01 R-9)", () => {
  it("detects ISO-8601 dates recursively", () => {
    expect(containsAbsoluteDate("2024-03-27")).toBe(true);
    expect(containsAbsoluteDate({ nested: { when: "2024-03-27T12:00" } })).toBe(true);
    expect(containsAbsoluteDate([1, 2, { when: "2024-03-27" }])).toBe(true);
    expect(containsAbsoluteDate("no dates here")).toBe(false);
    expect(containsAbsoluteDate(42)).toBe(false);
  });
});

describe("security / generated-key shape (review/01 R-15 adapted)", () => {
  it("accepts positive integers in *_key columns", () => {
    expect(() => assertGeneratedKeyShape(
      "dim_1", ["l1_key", "l1_label"], [[1, "lbl"], [2, "lbl"]],
    )).not.toThrow();
  });
  it("rejects string keys", () => {
    expect(() => assertGeneratedKeyShape(
      "dim_1", ["l1_key"], [["syn_abc"]],
    )).toThrow(/generated-key invariant violated/);
  });
  it("rejects zero or negative keys", () => {
    expect(() => assertGeneratedKeyShape("dim_1", ["l1_key"], [[0]])).toThrow();
    expect(() => assertGeneratedKeyShape("dim_1", ["l1_key"], [[-1]])).toThrow();
  });
});

describe("security / FK closure (review/05)", () => {
  const dimLeafKeys = new Map<string, Set<number>>([
    ["dim_1", new Set([1, 2, 3])],
  ]);
  it("passes when every FK resolves", () => {
    const report = assertFkClosure([{
      tableName: "fact_1",
      columns:   ["dim_1_key", "amount"],
      rows:      [[1, 100], [2, 200], [3, 300]],
    }], dimLeafKeys);
    expect(report.failed).toHaveLength(0);
    expect(report.passed).toHaveLength(1);
  });
  it("throws on orphan FK values", () => {
    expect(() => assertFkClosure([{
      tableName: "fact_1",
      columns:   ["dim_1_key"],
      rows:      [[1], [99]],
    }], dimLeafKeys)).toThrow(/FK closure assertion failed/);
  });
});

describe("security / hardenFingerprint (review/04)", () => {
  it("attaches bucket, sensitivity, and security stamp", () => {
    const hardened = hardenFingerprint(sampleFingerprint());
    const leaf     = hardened.dimensions[0]!.hierarchies[0]!.levels[1]! as any;
    expect(leaf.coldMemberBucket).toBe("30-60%");
    expect(leaf.sensitivity).toBeDefined();
    expect((hardened as any).security.profileVersion).toBe(SECURITY_PROFILE_VERSION);
    expect((hardened as any).security.deferredControls).toContain("differential_privacy_noise");
  });
  it("rounds pearsonR to 2 decimal places", () => {
    const hardened = hardenFingerprint(sampleFingerprint());
    expect(hardened.facts[0]!.measureCorrelations![0]!.pearsonR).toBe(0.83);
  });
});

describe("security / validateFingerprint", () => {
  it("passes a hardened fingerprint without errors", () => {
    const hardened = hardenFingerprint(sampleFingerprint());
    const { errors } = validateFingerprint(hardened);
    expect(errors).toHaveLength(0);
  });
  it("rejects absolute dates", () => {
    const fp = hardenFingerprint(sampleFingerprint());
    (fp as any).capturedAt = "2024-03-27T00:00:00Z";
    // capturedAt already ISO; synthesize a definitely-date string in dims instead
    (fp.dimensions[0] as any).dangerField = "2024-03-27";
    const { errors } = validateFingerprint(fp);
    expect(errors.some((e) => /absolute date/.test(e))).toBe(true);
  });
});

describe("security / constants", () => {
  it("exposes small-table threshold from review/01 R-21", () => {
    expect(MIN_ROWS_FOR_UNMASKED_FINGERPRINT).toBe(5000);
  });
});
