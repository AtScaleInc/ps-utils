import { describe, expect, it } from "vitest";
import { idNames } from "../atscale-aggregate-idmap.js";
import { planFingerprint } from "../atscale-aggregate-fingerprint.js";

function makeCatalog(opts: { keyId: string; attrId: string }) {
  return {
    attributes: {
      "keyed-attribute": [{ id: opts.attrId, name: "Order Date Key", "key-ref": opts.keyId }],
    },
  };
}

const HOST_A = makeCatalog({ keyId: "key-a", attrId: "attr-a" });
const HOST_B = makeCatalog({ keyId: "key-b", attrId: "attr-b" });

function plan(keyId: string, agg: string, extra: Record<string, unknown> = {}) {
  return {
    type: "cube",
    model: { id: "model-a" },
    selection: {
      columns: [{ value: { type: "key", id: keyId }, "aggregation-type": agg, alias: "c0", model: { id: "model-a" }, ...extra }],
    },
  };
}

describe("planFingerprint", () => {
  it("is order-insensitive over the selected columns", () => {
    const a = plan("key-a", "SUM");
    const twoColumn = {
      ...a,
      selection: {
        columns: [
          { value: { type: "key", id: "key-a" }, "aggregation-type": "SUM" },
          { value: { type: "key", id: "key-a" }, "aggregation-type": "COUNT" },
        ],
      },
    };
    const reordered = { ...twoColumn, selection: { columns: [...twoColumn.selection.columns].reverse() } };
    expect(planFingerprint(twoColumn)).toBe(planFingerprint(reordered));
  });

  it("ignores column alias and the owning model id (legitimately differ per host)", () => {
    const a = plan("key-a", "SUM", { alias: "c0", model: { id: "model-a" } });
    const b = plan("key-a", "SUM", { alias: "different-alias", model: { id: "model-different" } });
    expect(planFingerprint(a)).toBe(planFingerprint(b));
  });

  it("differs when the aggregation function differs", () => {
    expect(planFingerprint(plan("key-a", "SUM"))).not.toBe(planFingerprint(plan("key-a", "COUNT")));
  });

  it("returns undefined when there are no selected columns", () => {
    expect(planFingerprint({ selection: { columns: [] } })).toBeUndefined();
    expect(planFingerprint({})).toBeUndefined();
  });

  it("returns undefined for an unparseable JSON-string plan", () => {
    expect(planFingerprint("{not json")).toBeUndefined();
  });

  it("is equal across two hosts once each side's key ids are translated to their own logical names", () => {
    const planOnA = plan("key-a", "SUM");
    const planOnB = plan("key-b", "SUM");
    const fpA = planFingerprint(planOnA, idNames(HOST_A));
    const fpB = planFingerprint(planOnB, idNames(HOST_B));
    expect(fpA).toBe(fpB);
  });

  it("differs across two hosts when compared by raw id (no name translation)", () => {
    const planOnA = plan("key-a", "SUM");
    const planOnB = plan("key-b", "SUM");
    expect(planFingerprint(planOnA)).not.toBe(planFingerprint(planOnB));
  });
});
