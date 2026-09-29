import json

from promote import diff as D
from promote.idmap import dataset_connections
from promote.remap import connection_map, remap_export, target_connection

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
                           target_instances={"a1": None}, target_connections=["PG_DEV"])
    for v in body["aggregates"]["values"]:
        assert isinstance(v["activeInstanceId"], str) and isinstance(v["latestInstanceId"], str)
    a1, a2 = body["aggregates"]["values"]
    assert a1["activeInstanceId"] == "src-i1" and a2["latestInstanceId"] == "src-i2"


def test_missing_required_strings_are_filled():
    p = payload()
    for v in p["aggregates"]["values"]:
        v.pop("activeInstanceId"); v.pop("latestInstanceId"); v["triggeringQueryId"] = None
    body, _ = remap_export(p, target_catalog_id=TGT_CAT, target_model_id=TGT_MODEL, target_instances={}, target_connections=["PG_DEV"])
    for v in body["aggregates"]["values"]:
        assert v["activeInstanceId"] == "" and v["latestInstanceId"] == "" and v["triggeringQueryId"] == ""


def test_plan_json_string_is_remapped_too():
    body, _ = remap_export(payload(plan_as_str=True), target_catalog_id=TGT_CAT, target_model_id=TGT_MODEL,
                           target_instances={}, target_connections=["PG_DEV"])
    assert SRC_MODEL not in body["aggregates"]["values"][0]["planJson"]


def test_connection_remapped_to_single_target_connection():
    body, problems = remap_export(payload("PG_DEV"), target_catalog_id=TGT_CAT, target_model_id=TGT_MODEL,
                                  target_instances={}, target_connections=["PG_PROD"])
    assert not problems
    assert {v["connectionId"] for v in body["aggregates"]["values"]} == {"PG_PROD"}
    assert body["exportSummary"]["connectionIds"]["values"] == ["PG_PROD"]


def test_ambiguous_connection_is_kept():
    body, problems = remap_export(payload("PG_DEV"), target_catalog_id=TGT_CAT, target_model_id=TGT_MODEL,
                                  target_instances={}, target_connections=["A", "B"])
    assert not problems and {v["connectionId"] for v in body["aggregates"]["values"]} == {"PG_DEV"}


def test_target_connection_rules():
    assert target_connection("X", ["X", "Y"]) == "X"
    assert target_connection("X", ["Y"]) == "Y"
    assert target_connection("X", ["Y", "Z"]) is None
    assert target_connection("X", ["Y", "Z"], {"X": "Z"}) == "Z"      # shared datasets decide first
    assert target_connection("X", ["X", "Z"], {"X": "Z"}) == "Z"
    assert target_connection("X", [], None) is None                     # caller keeps the source id


def test_unknown_target_connection_keeps_the_source_id():
    # No target connection reported and no dataset links them: nothing to swap.
    body, problems = remap_export(payload("Postgres14"), target_catalog_id=TGT_CAT, target_model_id=TGT_MODEL,
                                  target_instances={}, target_connections=[])
    assert not problems and len(body["aggregates"]["values"]) == 2
    assert {v["connectionId"] for v in body["aggregates"]["values"]} == {"Postgres14"}
    assert body["exportSummary"]["connectionIds"]["values"] == ["Postgres14"]


def test_connection_mapped_through_shared_datasets():
    src = {"data-sets": {"data-set": [
        {"name": "factinternetsales", "physical": {"connection": {"id": "Postgres14"}}},
        {"name": "dimcustomer", "physical": {"connection": {"id": "Postgres14"}}},
        {"name": "sf_orders", "physical": {"connection": {"id": "Snow_DEV"}}},
    ]}}
    tgt = {"data-sets": [
        {"name": "factinternetsales", "physical": {"connection": {"id": "PG_PROD"}}},
        {"name": "dimcustomer", "physical": {"connection": {"id": "PG_PROD"}}},
        {"name": "sf_orders", "physical": {"connection": {"id": "Snow_PROD"}}},
    ]}
    conns = connection_map(dataset_connections(src), dataset_connections(tgt))
    assert conns == {"Postgres14": "PG_PROD", "Snow_DEV": "Snow_PROD"}
    # Two target connections: only the dataset pairing can tell which one.
    body, problems = remap_export(payload("Postgres14"), target_catalog_id=TGT_CAT, target_model_id=TGT_MODEL,
                                  target_instances={}, target_connections=["PG_PROD", "Snow_PROD"], connections=conns)
    assert not problems
    assert {v["connectionId"] for v in body["aggregates"]["values"]} == {"PG_PROD"}
    assert body["exportSummary"]["connectionIds"]["values"] == ["PG_PROD"]
    assert "Postgres14" not in json.dumps(body)


def test_connection_map_drops_ambiguous_pairs():
    assert connection_map({"a": "X", "b": "X"}, {"a": "P", "b": "Q"}) == {}
    assert connection_map({"a": "X"}, {"z": "P"}) == {}


def test_only_active_exportable_system_aggs_promotable():
    base = {"id": "a", "name": "a", "model": "M", "type": "SYSTEM", "signature": "s"}
    assert D.agg_state({**base, "active": False}, [], {"M"})["state"] == "srcoff"
    assert D.agg_state({**base, "active": True, "exportable": False}, [], {"M"})["state"] == "noexp"
    assert D.agg_state({**base, "type": "USER", "active": True}, [], {"M"})["state"] == "uda"
    assert D.with_stageable(D.agg_state({**base, "active": True, "exportable": True}, [], {"M"}))["stageable"]


def test_connection_inside_plan_is_swapped_too():
    """Newer AtScale builds may reference the connection inside planJson."""
    p = payload("Postgres14", plan_as_str=True)
    plan = json.loads(p["aggregates"]["values"][0]["planJson"])
    plan["selection"]["from"]["connection"] = {"id": "Postgres14"}
    plan["notes"] = "Postgres14 is not an exact match here"
    p["aggregates"]["values"][0]["planJson"] = json.dumps(plan)
    p["aggregates"]["values"][1]["planJson"] = {**plan}
    body, problems = remap_export(p, target_catalog_id=TGT_CAT, target_model_id=TGT_MODEL, target_instances={},
                                  target_connections=["PG_PROD", "Snow"], connections={"Postgres14": "PG_PROD"})
    assert not problems
    a1, a2 = body["aggregates"]["values"]
    p1 = json.loads(a1["planJson"])
    assert p1["selection"]["from"]["connection"]["id"] == "PG_PROD"             # string plan
    assert a2["planJson"]["selection"]["from"]["connection"]["id"] == "PG_PROD"  # object plan
    assert p1["notes"] == "Postgres14 is not an exact match here"               # only exact values change
