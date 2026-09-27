import json

from promote import diff as D
from promote.remap import remap_export, target_connection

SRC_CAT, SRC_MODEL = "src-cat", "src-model"
TGT_CAT, TGT_MODEL = "tgt-cat", "tgt-model"


def payload(conn="PG_DEV", plan_as_str=False):
    plan = {"type": "logical-plan", "model": {"id": SRC_MODEL},
            "selection": {"columns": [{"value": {"type": "key-value", "model": {"id": SRC_MODEL}, "key": {"id": "k1"}}}],
                          "from": {"type": "cube-data-selection", "model": {"id": SRC_MODEL}}}}
    return {
        "atScaleExportVersion": "36.0.0", "exportCatalogId": SRC_CAT, "exportModelId": SRC_MODEL,
        "exportSummary": {"connectionIds": {"count": 1, "values": [conn]}},
        "aggregates": {"count": 2, "values": [
            {"id": "a1", "catalogId": SRC_CAT, "modelId": SRC_MODEL, "connectionId": conn,
             "activeInstanceId": "src-i1", "latestInstanceId": "src-i1",
             "planJson": json.dumps(plan) if plan_as_str else plan},
            {"id": "a2", "catalogId": SRC_CAT, "modelId": SRC_MODEL, "connectionId": conn,
             "activeInstanceId": "src-i2", "latestInstanceId": "src-i2", "planJson": plan},
        ]},
    }


def test_substitutes_catalog_model_and_instance_ids():
    body, problems = remap_export(payload(), target_catalog_id=TGT_CAT, target_model_id=TGT_MODEL,
                                  target_instances={"a1": "tgt-i1", "a2": None}, target_connections=["PG_DEV"])
    assert not problems
    assert body["exportCatalogId"] == TGT_CAT and body["exportModelId"] == TGT_MODEL
    a1, a2 = body["aggregates"]["values"]
    assert (a1["catalogId"], a1["modelId"], a1["activeInstanceId"], a1["latestInstanceId"]) == (TGT_CAT, TGT_MODEL, "tgt-i1", "tgt-i1")
    text = json.dumps(body)
    assert SRC_MODEL not in text and SRC_CAT not in text
    assert a1["planJson"]["selection"]["columns"][0]["value"]["key"]["id"] == "k1"  # object ids untouched


def test_instance_ids_are_never_null():
    # The import schema requires strings (400 "Expected string, received null");
    # a new aggregate keeps the source ids, which the engine ignores on import.
    body, _ = remap_export(payload(), target_catalog_id=TGT_CAT, target_model_id=TGT_MODEL,
                           target_instances={"a1": None}, target_connections=[])
    for v in body["aggregates"]["values"]:
        assert isinstance(v["activeInstanceId"], str) and isinstance(v["latestInstanceId"], str)
    a1, a2 = body["aggregates"]["values"]
    assert a1["activeInstanceId"] == "src-i1" and a2["latestInstanceId"] == "src-i2"


def test_missing_required_strings_are_filled():
    p = payload()
    for v in p["aggregates"]["values"]:
        v.pop("activeInstanceId"); v.pop("latestInstanceId"); v["triggeringQueryId"] = None
    body, _ = remap_export(p, target_catalog_id=TGT_CAT, target_model_id=TGT_MODEL, target_instances={}, target_connections=[])
    for v in body["aggregates"]["values"]:
        assert v["activeInstanceId"] == "" and v["latestInstanceId"] == "" and v["triggeringQueryId"] == ""


def test_plan_json_string_is_remapped_too():
    body, _ = remap_export(payload(plan_as_str=True), target_catalog_id=TGT_CAT, target_model_id=TGT_MODEL,
                           target_instances={}, target_connections=[])
    assert SRC_MODEL not in body["aggregates"]["values"][0]["planJson"]


def test_connection_remapped_to_single_target_connection():
    body, problems = remap_export(payload("PG_DEV"), target_catalog_id=TGT_CAT, target_model_id=TGT_MODEL,
                                  target_instances={}, target_connections=["PG_PROD"])
    assert not problems
    assert {v["connectionId"] for v in body["aggregates"]["values"]} == {"PG_PROD"}
    assert body["exportSummary"]["connectionIds"]["values"] == ["PG_PROD"]


def test_ambiguous_connection_is_skipped():
    body, problems = remap_export(payload("PG_DEV"), target_catalog_id=TGT_CAT, target_model_id=TGT_MODEL,
                                  target_instances={}, target_connections=["A", "B"])
    assert body["aggregates"]["values"] == [] and len(problems) == 2


def test_target_connection_rules():
    assert target_connection("X", ["X", "Y"]) == "X"
    assert target_connection("X", ["Y"]) == "Y"
    assert target_connection("X", ["Y", "Z"]) is None


def test_only_active_exportable_system_aggs_promotable():
    base = {"id": "a", "name": "a", "model": "M", "type": "SYSTEM", "signature": "s"}
    assert D.agg_state({**base, "active": False}, [], {"M"})["state"] == "srcoff"
    assert D.agg_state({**base, "active": True, "exportable": False}, [], {"M"})["state"] == "noexp"
    assert D.agg_state({**base, "type": "USER", "active": True}, [], {"M"})["state"] == "uda"
    assert D.with_stageable(D.agg_state({**base, "active": True, "exportable": True}, [], {"M"}))["stageable"]
