"""Two hosts deploy the same SML but generate different ids: matching and
promotion must go through names."""

from atscale.backend import plan_fingerprint
from promote.idmap import id_names, name_ids, plan_ids, translate_plan
from promote.remap import remap_export


def catalog(key_id, ref_id, attr_id):
    return {
        "attributes": {
            "keyed-attribute": [
                {"id": attr_id, "name": "Customer Name", "key-ref": key_id},
                {"id": "x-" + attr_id, "name": "Custom Year", "key-ref": "k2-" + key_id,
                 "properties": {"ordering": {"sort-key": {"key-ref": {"id": "sk-" + key_id}}}}},
            ],
        },
        "cubes": {"cube": {"data-sets": {"name": "Internet Sales Cube", "id": "ds", "logical": {"key-ref": [
            {"ref-path": {"new-ref": {"ref-naming": "Order {0}", "attribute-id": attr_id, "ref-id": ref_id}}},
        ]}}}},
        "data-sets": {"data-set": [{"name": "dimcustomer", "id": "d1", "physical": {"columns": [
            {"column": "rpt_year", "id": "col-" + key_id},
        ]}}]},
    }


def plan(key_id, ref_id, model):
    return {"type": "logical-plan", "model": {"id": model}, "selection": {"columns": [
        {"alias": "key_c1", "aggregation-type": {"type": "aggregate-grouped"},
         "value": {"type": "key-value", "model": {"id": model},
                   "key": {"type": "flat-key", "key": {"type": "key", "model": None, "id": key_id},
                           "ref-path": {"type": "ref-path", "refs": [{"type": "reuse-ref", "ref-id": ref_id}]}}}},
        {"alias": "m", "aggregation-type": {"type": "aggregate-simple-function", "function": "sum"},
         "value": {"type": "attribute-value", "attribute": {"type": "attribute", "model": {"id": model}, "name": "Sales"}}},
    ]}}


SRC = catalog("src-key", "src-ref", "src-attr")
TGT = catalog("tgt-key", "tgt-ref", "tgt-attr")


def test_names_are_host_independent():
    s, t = id_names(SRC), id_names(TGT)
    assert s["src-key"] == t["tgt-key"] == "attr:Customer Name"
    assert s["src-ref"] == t["tgt-ref"] == "ref:Order {0}:Customer Name"
    assert s["sk-src-key"] == "sort:Custom Year" and s["col-src-key"] == "col:dimcustomer:rpt_year"
    assert name_ids(TGT)["attr:Customer Name"] == "tgt-key"


def test_same_aggregate_fingerprints_equal_across_hosts():
    a = plan_fingerprint(plan("src-key", "src-ref", "src-model"), id_names(SRC))
    b = plan_fingerprint(plan("tgt-key", "tgt-ref", "tgt-model"), id_names(TGT))
    assert a == b
    # by raw id they would never match (the reason names are used)
    assert plan_fingerprint(plan("src-key", "src-ref", "m")) != plan_fingerprint(plan("tgt-key", "tgt-ref", "m"))


def test_promotion_translates_plan_ids_to_target():
    payload = {"exportCatalogId": "src-cat", "exportModelId": "src-model", "exportSummary": {},
               "aggregates": {"count": 1, "values": [{"id": "a1", "catalogId": "src-cat", "modelId": "src-model",
                                                      "planJson": plan("src-key", "src-ref", "src-model")}]}}
    body, problems = remap_export(payload, target_catalog_id="tgt-cat", target_model_id="tgt-model",
                                  target_instances={}, target_connections=[],
                                  source_names=id_names(SRC), target_ids_by_name=name_ids(TGT))
    assert not problems
    p = body["aggregates"]["values"][0]["planJson"]
    assert plan_ids(p) == {"tgt-key", "tgt-ref"}
    assert p["model"]["id"] == "tgt-model"


def test_object_missing_on_target_skips_aggregate():
    tgt = catalog("tgt-key", "tgt-ref", "tgt-attr")
    tgt["attributes"]["keyed-attribute"][0]["name"] = "Client Name"  # renamed in target SML
    payload = {"exportCatalogId": "c", "exportModelId": "m", "aggregates": {"values": [
        {"id": "a1", "planJson": plan("src-key", "src-ref", "m")}]}}
    body, problems = remap_export(payload, target_catalog_id="t", target_model_id="tm", target_instances={},
                                  target_connections=[], source_names=id_names(SRC), target_ids_by_name=name_ids(tgt))
    assert body["aggregates"]["values"] == []
    assert "attr:Customer Name" in problems[0]["reason"]


def test_translate_plan_keeps_string_form():
    import json
    s = translate_plan(json.dumps(plan("a", "b", "m")), {"a": "A", "b": "B"})
    assert isinstance(s, str) and plan_ids(s) == {"A", "B"}
