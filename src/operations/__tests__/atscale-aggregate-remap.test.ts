import { describe, expect, it } from "vitest";
import { remapExport, targetConnection, REQUIRED_STRINGS } from "../atscale-aggregate-remap.js";

function baseValue(overrides: Record<string, unknown> = {}) {
  return {
    id: "agg-1",
    baseType: "system_defined",
    blocked: false,
    catalogId: "cat-a",
    connectionId: "conn-a",
    createdAt: "2024-01-01T00:00:00Z",
    modelId: "model-a",
    subType: "grouping-sets",
    promoted: false,
    notes: { dimensional: false },
    planJson: {
      type: "cube",
      model: { id: "model-a" },
      selection: { columns: [{ value: { type: "key", id: "key-a" }, "aggregation-type": "SUM" }] },
    },
    ...overrides,
  };
}

function basePayload(values: Record<string, unknown>[]) {
  return {
    atScaleExportVersion: "2024.1",
    exportTimestamp: "2024-01-01T00:00:00Z",
    exportCatalogId: "cat-a",
    exportModelId: "model-a",
    exportSummary: { connectionIds: { count: 1, values: ["conn-a"] } },
    aggregates: { count: values.length, values },
  };
}

describe("targetConnection", () => {
  it("keeps the source connection when it exists on the target", () => {
    expect(targetConnection("conn-a", ["conn-a", "conn-b"])).toBe("conn-a");
  });
  it("uses the sole target connection when the source one isn't present", () => {
    expect(targetConnection("conn-a", ["conn-only"])).toBe("conn-only");
  });
  it("is ambiguous (undefined) with more than one target connection and no match", () => {
    expect(targetConnection("conn-a", ["conn-x", "conn-y"])).toBeUndefined();
  });
});

describe("remapExport", () => {
  it("defaults required string fields to '' instead of leaving them null/missing", () => {
    const value = baseValue({ activeInstanceId: null, latestInstanceId: undefined, triggeringQueryId: null });
    const { payload } = remapExport(basePayload([value]), {
      targetCatalogId: "cat-a",
      targetModelId: "model-a",
    });
    const out = (payload.aggregates as any).values[0];
    for (const field of REQUIRED_STRINGS) {
      expect(typeof out[field]).toBe("string");
    }
    expect(out.triggeringQueryId).toBe("");
  });

  it("falls back activeInstanceId/latestInstanceId to whichever of the two is present", () => {
    const value = baseValue({ activeInstanceId: undefined, latestInstanceId: "inst-1" });
    const { payload } = remapExport(basePayload([value]), { targetCatalogId: "cat-a", targetModelId: "model-a" });
    const out = (payload.aggregates as any).values[0];
    expect(out.activeInstanceId).toBe("inst-1");
    expect(out.latestInstanceId).toBe("inst-1");
  });

  it("prefers the matched target counterpart's instance id over the source's own", () => {
    const value = baseValue({ id: "agg-1", activeInstanceId: "source-inst" });
    const { payload } = remapExport(basePayload([value]), {
      targetCatalogId: "cat-a",
      targetModelId: "model-a",
      targetInstances: { "agg-1": "target-inst" },
    });
    const out = (payload.aggregates as any).values[0];
    expect(out.activeInstanceId).toBe("target-inst");
    expect(out.latestInstanceId).toBe("target-inst");
  });

  it("remaps catalog/model ids everywhere, including inside planJson (string or object)", () => {
    const value = baseValue();
    const { payload } = remapExport(basePayload([value]), {
      targetCatalogId: "cat-TARGET",
      targetModelId: "model-TARGET",
    });
    expect(payload.exportCatalogId).toBe("cat-TARGET");
    expect(payload.exportModelId).toBe("model-TARGET");
    const out = (payload.aggregates as any).values[0];
    expect(out.catalogId).toBe("cat-TARGET");
    expect(out.modelId).toBe("model-TARGET");
    expect(out.planJson.model.id).toBe("model-TARGET");

    const stringPlanValue = baseValue({ planJson: JSON.stringify(value.planJson) });
    const { payload: payload2 } = remapExport(basePayload([stringPlanValue]), {
      targetCatalogId: "cat-TARGET",
      targetModelId: "model-TARGET",
    });
    const out2 = (payload2.aggregates as any).values[0];
    expect(JSON.parse(out2.planJson).model.id).toBe("model-TARGET");
  });

  it("remaps a value's connectionId to the target's, and mirrors it into exportSummary.connectionIds", () => {
    const value = baseValue({ connectionId: "conn-a" });
    const { payload } = remapExport(basePayload([value]), {
      targetCatalogId: "cat-a",
      targetModelId: "model-a",
      targetConnections: ["conn-b"],
    });
    const out = (payload.aggregates as any).values[0];
    expect(out.connectionId).toBe("conn-b");
    expect((payload.exportSummary as any).connectionIds.values).toEqual(["conn-b"]);
  });

  it("skips a value whose connection has no unambiguous match on the target", () => {
    const value = baseValue({ connectionId: "conn-a" });
    const { payload, problems } = remapExport(basePayload([value]), {
      targetCatalogId: "cat-a",
      targetModelId: "model-a",
      targetConnections: ["conn-x", "conn-y"],
    });
    expect((payload.aggregates as any).values).toHaveLength(0);
    expect(problems).toEqual([{ id: "agg-1", reason: expect.stringContaining("no unambiguous match") }]);
  });

  it("translates key/reference ids by name and drops an aggregate whose plan references an object missing on the target", () => {
    const resolvable = baseValue({
      id: "agg-resolvable",
      planJson: { model: { id: "model-a" }, selection: { columns: [{ value: { type: "key", id: "key-a" } }] } },
    });
    const unresolvable = baseValue({
      id: "agg-unresolvable",
      planJson: { model: { id: "model-a" }, selection: { columns: [{ value: { type: "key", id: "key-unknown" } }] } },
    });
    const { payload, problems } = remapExport(basePayload([resolvable, unresolvable]), {
      targetCatalogId: "cat-a",
      targetModelId: "model-a",
      sourceNames: { "key-a": "attr:Order Date Key" },
      targetIdsByName: { "attr:Order Date Key": "key-a-on-target" },
    });
    const values = (payload.aggregates as any).values;
    expect(values).toHaveLength(1);
    expect(values[0].id).toBe("agg-resolvable");
    expect(values[0].planJson.selection.columns[0].value.id).toBe("key-a-on-target");
    expect(problems).toEqual([{ id: "agg-unresolvable", reason: expect.stringContaining("Not on target model") }]);
  });

  it("defaults notes.dimensional to false when missing", () => {
    const value = baseValue({ notes: undefined });
    const { payload } = remapExport(basePayload([value]), { targetCatalogId: "cat-a", targetModelId: "model-a" });
    expect((payload.aggregates as any).values[0].notes).toEqual({ dimensional: false });
  });
});
