import { describe, expect, it } from "vitest";
import { idNames, nameIds, planIds, translatePlan } from "../atscale-aggregate-idmap.js";

/**
 * Two synthetic catalogs representing "the same SML", deployed on two
 * different hosts: the logical names (dataset, keyed-attribute, role-play
 * naming) match, but every id differs — exactly the situation aggregate
 * promotion has to bridge.
 */
function makeCatalog(opts: { dataSetId: string; keyId: string; attrId: string; refId: string }) {
  return {
    attributes: {
      "keyed-attribute": [
        { id: opts.attrId, name: "Order Date Key", "key-ref": opts.keyId },
      ],
    },
    "data-sets": {
      "data-set": [
        {
          id: opts.dataSetId,
          name: "fact_orders",
          logical: {
            "key-ref": [{ id: opts.keyId, column: "order_date_id", complete: true }],
          },
        },
      ],
    },
    cubes: {
      cube: [
        {
          id: "cube-" + opts.dataSetId,
          name: "Sales",
          "data-sets": {
            "data-set-ref": [
              {
                id: opts.dataSetId,
                logical: {
                  "key-ref": [
                    {
                      id: opts.keyId,
                      column: "order_date_fk",
                      "ref-path": {
                        "new-ref": [{ "ref-id": opts.refId, "attribute-id": opts.attrId, "ref-naming": "Order {0}" }],
                      },
                    },
                  ],
                },
              },
            ],
          },
        },
      ],
    },
  };
}

const HOST_A = makeCatalog({ dataSetId: "ds-a", keyId: "key-a", attrId: "attr-a", refId: "ref-a" });
const HOST_B = makeCatalog({ dataSetId: "ds-b", keyId: "key-b", attrId: "attr-b", refId: "ref-b" });

describe("idNames / nameIds", () => {
  it("names a keyed-attribute's key-ref id by the attribute (highest precedence over column bindings)", () => {
    expect(idNames(HOST_A)["key-a"]).toBe("attr:Order Date Key");
    expect(idNames(HOST_B)["key-b"]).toBe("attr:Order Date Key");
  });

  it("names a role-play reference id by its naming pattern + target attribute", () => {
    expect(idNames(HOST_A)["ref-a"]).toBe("ref:Order {0}:Order Date Key");
    expect(idNames(HOST_B)["ref-b"]).toBe("ref:Order {0}:Order Date Key");
  });

  it("inverts to a unique name -> id map per host", () => {
    expect(nameIds(HOST_A)["attr:Order Date Key"]).toBe("key-a");
    expect(nameIds(HOST_B)["attr:Order Date Key"]).toBe("key-b");
    expect(nameIds(HOST_A)["ref:Order {0}:Order Date Key"]).toBe("ref-a");
    expect(nameIds(HOST_B)["ref:Order {0}:Order Date Key"]).toBe("ref-b");
  });

  it("drops ambiguous names (more than one id shares a name) from the inverse map", () => {
    const ambiguous = {
      attributes: {
        "keyed-attribute": [
          { id: "attrX", name: "Dup", "key-ref": "keyX" },
          { id: "attrY", name: "Dup", "key-ref": "keyY" },
        ],
      },
    };
    expect(nameIds(ambiguous)["attr:Dup"]).toBeUndefined();
  });
});

describe("planIds / translatePlan", () => {
  const planA = {
    type: "cube",
    model: { id: "model-a" },
    selection: {
      type: "logical",
      columns: [{ value: { type: "key", id: "key-a" }, "aggregation-type": "SUM", alias: "c0" }],
      from: { model: { id: "model-a" }, type: "cube" },
      limit: null,
      order: [],
      filters: [{ type: "reuse-ref", "ref-id": "ref-a" }],
    },
    hints: [],
  };

  it("finds every key id and role-play ref id a plan references", () => {
    expect(planIds(planA)).toEqual(new Set(["key-a", "ref-a"]));
  });

  it("translates key and role-play ref ids per a mapping, leaving everything else untouched", () => {
    const translated = translatePlan(planA, { "key-a": "key-b", "ref-a": "ref-b" }) as typeof planA;
    expect(planIds(translated)).toEqual(new Set(["key-b", "ref-b"]));
    expect(translated.model.id).toBe("model-a"); // untouched: not a key/ref-id occurrence
    expect((translated.selection.columns[0] as any).alias).toBe("c0");
  });

  it("translates a JSON-string-encoded plan and returns a JSON string", () => {
    const translated = translatePlan(JSON.stringify(planA), { "key-a": "key-b", "ref-a": "ref-b" });
    expect(typeof translated).toBe("string");
    expect(planIds(translated)).toEqual(new Set(["key-b", "ref-b"]));
  });

  it("translates by name across two hosts: source ids -> source names -> target ids", () => {
    const sourceNames = idNames(HOST_A);
    const targetIdsByName = nameIds(HOST_B);
    const mapping: Record<string, string> = {};
    for (const oid of planIds(planA)) {
      const name = sourceNames[oid];
      if (name && targetIdsByName[name]) mapping[oid] = targetIdsByName[name];
    }
    const translated = translatePlan(planA, mapping);
    expect(planIds(translated)).toEqual(new Set(["key-b", "ref-b"]));
  });
});
