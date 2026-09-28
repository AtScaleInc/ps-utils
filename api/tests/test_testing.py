"""Test tab: ps-utils query generation + harness, against a stub host."""

import time

import pytest

from testing import harness
from testing.generate import build_queries, model_entries

META = {
    "_measures": [{"MEASURE_NAME": "salesamount", "MEASURE_CAPTION": "Sales"},
                  {"MEASURE_NAME": "orderquantity", "MEASURE_CAPTION": "Qty"}],
    "_levels": [
        {"DIMENSION_UNIQUE_NAME": "[Product]", "HIERARCHY_UNIQUE_NAME": "[Product].[Product Hierarchy]",
         "LEVEL_NAME": "(All)", "LEVEL_CAPTION": "(All)", "LEVEL_NUMBER": "0"},
        {"DIMENSION_UNIQUE_NAME": "[Product]", "HIERARCHY_UNIQUE_NAME": "[Product].[Product Hierarchy]",
         "LEVEL_NAME": "productkey", "LEVEL_CAPTION": "Product", "LEVEL_NUMBER": "1"},
        {"DIMENSION_UNIQUE_NAME": "[Measures]", "HIERARCHY_UNIQUE_NAME": "[Measures]",
         "LEVEL_NAME": "MeasuresLevel", "LEVEL_NUMBER": "0"},
    ],
}


def test_generates_totals_and_level_breakdowns():
    metrics, levels = model_entries(META)
    qs = build_queries(metrics, levels, "cube1")
    assert [q["name"] for q in qs] == ["Sales | Total", "Qty | Total", "Product | Product Hierarchy | Product"]
    assert qs[0]["mdx"] == "SELECT {[Measures].[salesamount]} ON COLUMNS\nFROM [cube1]"
    assert qs[0]["sql"] == 'SELECT "salesamount"\nFROM "cube1"'
    # Level NAME in the MDX brackets, not the caption (ps-utils uses the caption,
    # which AtScale rejects when the two differ).
    assert "[Product].[Product Hierarchy].[productkey].MEMBERS" in qs[2]["mdx"]
    assert 'GROUP BY "productkey"' in qs[2]["sql"]
    assert len({q["id"] for q in qs}) == 3


def test_no_metrics_is_an_error():
    with pytest.raises(ValueError):
        build_queries([], [], "c")


XMLA_OK = ("<soap:Envelope><soap:Header><Session id='1'/></soap:Header><soap:Body><root><CellData>"
           "<Cell><Value>1</Value></Cell><Cell><Value>2</Value></Cell></CellData></root></soap:Body></soap:Envelope>")
XMLA_FAULT = "<soap:Envelope><soap:Body><soap:Fault><faultstring>Level not found</faultstring></soap:Fault></soap:Body></soap:Envelope>"
SQL_OK = ("<query-results><metadata><succeeded>true</succeeded></metadata><columns><column><name>a</name></column></columns>"
          "<data><row><column>x</column></row><row><column>y</column></row></data></query-results>")


class StubApi:
    def __init__(self, mdx_body=XMLA_OK):
        self.mdx_body, self.sent = mdx_body, []

    def run_xmla(self, envelope, timeout=None):
        self.sent.append(envelope)
        return self.mdx_body

    def submit_query(self, payload, timeout=None):
        self.sent.append(payload)
        return SQL_OK


def test_xmla_rows_checksum_ignores_header_and_timestamps():
    def body(session, ts):
        return XMLA_OK.replace("id='1'", f"id='{session}'").replace(
            "<root>", f"<root><OlapInfo><LastDataUpdate xmlns='x'>{ts}</LastDataUpdate></OlapInfo>")

    a = harness.execute_xmla(StubApi(body(1, "2026-01-01T00:00:00Z")), "SELECT 1", "cat", "cube", harness.DEFAULT_OPTS)
    b = harness.execute_xmla(StubApi(body(2, "2026-09-28T20:32:14Z")), "SELECT 1", "cat", "cube", harness.DEFAULT_OPTS)
    c = harness.execute_xmla(StubApi(body(1, "x").replace("<Value>2</Value>", "<Value>3</Value>")), "SELECT 1", "cat", "cube", harness.DEFAULT_OPTS)
    assert a["status"] == "SUCCEEDED" and a["rowCount"] == 2
    assert a["checksum"] == b["checksum"] != c["checksum"]


def test_xmla_fault_fails():
    r = harness.execute_xmla(StubApi(XMLA_FAULT), "SELECT 1", "cat", "cube", harness.DEFAULT_OPTS)
    assert r["status"] == "FAILED" and r["error"] == "Level not found"


def test_run_all_targets_and_protocols_annotated():
    qs = build_queries(*model_entries(META), "cube1")
    apis = {"h1": StubApi(), "h2": StubApi(XMLA_FAULT)}
    targets = [{"hostId": h, "catalog": "cat", "cube": "cube1"} for h in apis]
    res = harness.run("RUN1", targets, qs, ["mdx", "sql"], apis.__getitem__, harness.DEFAULT_OPTS, concurrency=2, throttle_ms=0)
    assert len(res) == 2 * 2 * len(qs)
    assert {r["status"] for r in res if r["hostId"] == "h2" and r["protocol"] == "mdx"} == {"FAILED"}
    assert all(r["status"] == "SUCCEEDED" for r in res if r["protocol"] == "sql")
    assert '/* {"run_id":"RUN1"' in apis["h1"].sent[0] or '"run_id":"RUN1"' in str(apis["h1"].sent[0])
    assert harness.to_csv(res).splitlines()[0].startswith("run_id,task_name,model,query_name")


@pytest.fixture
def client(tmp_path, monkeypatch):
    from app import create_app
    from envs import registry
    from envs.store import Store
    from routes import testing as testing_routes
    import cache

    monkeypatch.setattr(registry, "FAKE", True)
    cache.set_dir(tmp_path / "cache")
    s = Store(tmp_path / "connections.yaml")
    registry.set_store(s)
    registry.seed_fake(s)
    from testing import store

    store.set_path(tmp_path / "tests.db")
    monkeypatch.setattr(testing_routes, "_LEGACY_DIR", tmp_path / "tests")
    monkeypatch.setattr(testing_routes, "_imported", False)
    monkeypatch.setattr(registry, "source_api", lambda host_id: StubApi())
    yield create_app().test_client()
    registry.set_store(None)


def test_run_endpoint_live_then_persisted(client, tmp_path):
    qs = build_queries(*model_entries(META), "cube1")
    r = client.post("/api/test/runs", json={"targets": [{"hostId": "dev-east", "catalog": "cat", "cube": "cube1"},
                                                          {"hostId": "qa-main", "catalog": "cat", "cube": "cube1"}],
                                             "queries": qs, "protocols": ["mdx", "sql"]})
    assert r.status_code == 202
    run_id = r.get_json()["runId"]
    for _ in range(100):
        run = client.get(f"/api/test/runs/{run_id}").get_json()
        if run["status"] != "running":
            break
        time.sleep(0.05)
    assert run["status"] == "done" and run["done"] == run["total"] == 12 and run["failed"] == 0
    from testing import store

    assert store.get_run(run_id)["done"] == 12 and store.read_data(run_id, "dev-east", "sql", qs[0]["id"]) is not None
    assert [x["runId"] for x in client.get("/api/test/runs").get_json()["runs"]] == [run_id]
    csv = client.get(f"/api/test/runs/{run_id}.csv")
    import csv as csvmod
    import io

    assert csv.status_code == 200 and len(list(csvmod.reader(io.StringIO(csv.data.decode())))) == 13


def test_run_validation(client):
    assert client.post("/api/test/runs", json={"targets": [], "queries": []}).status_code == 400
    q = build_queries(*model_entries(META), "c")[:1]
    assert client.post("/api/test/runs", json={"targets": [{"hostId": "nope", "catalog": "c", "cube": "c"}], "queries": q}).status_code == 404


# -- compare -----------------------------------------------------------------------------------

from testing.model import compare_models  # noqa: E402
from testing.results import compare, mdx_rows, sql_rows  # noqa: E402

CELLSET = """<soap:Envelope xmlns:soap="http://schemas.xmlsoap.org/soap/envelope/"><soap:Body><ExecuteResponse><return>
<root xmlns="urn:schemas-microsoft-com:xml-analysis:mddataset"><Axes>
<Axis name="Axis0"><Tuples><Tuple><Member><UName>[Measures].[s]</UName><Caption>Sales</Caption></Member></Tuple></Tuples></Axis>
{axis1}</Axes><CellData>{cells}</CellData></root></return></ExecuteResponse></soap:Body></soap:Envelope>"""
AXIS1 = ('<Axis name="Axis1"><Tuples>'
         '<Tuple><Member><UName>[P].[P].[k].&amp;[1]</UName><Caption>Bikes</Caption></Member></Tuple>'
         '<Tuple><Member><UName>[P].[P].[k].&amp;[2]</UName><Caption>Helmets</Caption></Member></Tuple></Tuples></Axis>')


def cellset(values, rows=True):
    cells = "".join(f'<Cell CellOrdinal="{i}"><Value>{v}</Value><FmtValue>{v}</FmtValue></Cell>' for i, v in enumerate(values))
    return CELLSET.format(axis1=AXIS1 if rows else "", cells=cells)


def test_mdx_rows_total_and_breakdown():
    total = mdx_rows(cellset([42], rows=False))
    assert total["measures"] == ["Sales"] and total["rows"] == [{"key": [], "label": [], "values": ["42"]}]
    rows = mdx_rows(cellset([10, 20]))
    assert [r["label"] for r in rows["rows"]] == [["Bikes"], ["Helmets"]] and rows["rows"][1]["values"] == ["20"]


def test_fmtvalue_not_double_counted():
    r = harness.execute_xmla(StubApi(cellset([10, 20])), "SELECT 1", "c", "c", harness.DEFAULT_OPTS)
    assert r["rowCount"] == 2


def test_variance_identical_differs_and_only_one_side():
    a, b = mdx_rows(cellset([10, 20])), mdx_rows(cellset([10, 20]))
    assert compare(a, b)["status"] == "identical"
    d = compare(a, mdx_rows(cellset([10, 25])))
    assert d["status"] == "differs" and d["diffRows"] == 1
    assert d["diffs"][0] == {"label": ["Helmets"], "measure": "Sales", "a": "20", "b": "25", "delta": 5.0, "pct": 25.0}
    assert compare(a, mdx_rows(cellset([10, 20.0000000001])))["status"] == "identical"  # within tolerance
    s1 = sql_rows(["k", "m"], [["a", "1"], ["b", "2"]], ["m"])
    s2 = sql_rows(["k", "m"], [["a", "1"], ["c", "2"]], ["m"])
    d = compare(s1, s2)
    assert d["onlyA"] == [["b"]] and d["onlyB"] == [["c"]] and d["status"] == "differs"
    assert compare(s1, None)["status"] == "missing"


def test_compare_models():
    a = {"metrics": {"s": {"caption": "Sales", "aggregation": "sum"}, "q": {"caption": "Qty"}}, "levels": {"P | P | k": {"levelNumber": 1}}}
    b = {"metrics": {"s": {"caption": "Sales", "aggregation": "avg"}}, "levels": {"P | P | k": {"levelNumber": 1}, "D | D | y": {}}}
    d = compare_models(a, b)
    assert not d["identical"]
    assert d["metrics"]["onlyA"] == ["q"] and d["metrics"]["changed"] == [{"name": "s", "fields": [{"field": "aggregation", "a": "sum", "b": "avg"}]}]
    assert d["levels"]["onlyB"] == ["D | D | y"] and d["levels"]["same"] == 1
    assert compare_models(a, a)["identical"]


def test_compare_endpoint_across_hosts(client, monkeypatch):
    from envs import registry

    apis = {"dev-east": StubApi(cellset([10, 20])), "qa-main": StubApi(cellset([10, 25]))}
    monkeypatch.setattr(registry, "source_api", lambda h: apis[h])
    qs = [{"id": "q1", "name": "P | P | k", "kind": "level", "mdx": "SELECT", "sql": "SELECT", "metrics": ["s"]}]
    run_id = client.post("/api/test/runs", json={"targets": [{"hostId": h, "catalog": "c", "cube": "c"} for h in apis],
                                                 "queries": qs, "protocols": ["mdx"]}).get_json()["runId"]
    for _ in range(100):
        if client.get(f"/api/test/runs/{run_id}").get_json()["status"] != "running":
            break
        time.sleep(0.05)
    r = client.post("/api/test/compare", json={"baseline": {"runId": run_id, "hostId": "dev-east"},
                                               "candidate": {"runId": run_id, "hostId": "qa-main"}}).get_json()
    assert r["verdict"] == "fail" and r["counts"] == {"differs": 1}
    assert r["queries"][0]["variance"]["diffs"][0]["pct"] == 25.0
    same = client.post("/api/test/compare", json={"baseline": {"runId": run_id, "hostId": "dev-east"},
                                                  "candidate": {"runId": run_id, "hostId": "dev-east"}}).get_json()
    assert same["counts"] == {"identical": 1}


# -- SQLite store -------------------------------------------------------------------------------

def _rec(run_id, host, qid, status="SUCCEEDED", ms=10):
    return {"runId": run_id, "hostId": host, "host": host, "env": "dev", "catalog": "c", "model": "cube1",
            "queryId": qid, "queryName": f"name {qid}", "runQueryId": "u", "protocol": "mdx", "status": status,
            "durationMs": ms, "rowCount": 1, "checksum": "x", "error": "", "timestamp": ms,
            "originalTextHash": "h", "originalText": "SELECT"}


def _new_run(store, run_id, started, model="cube1"):
    store.create_run({"runId": run_id, "status": "running", "startedAt": started, "targets": [{"hostId": "h1", "catalog": "c", "cube": model}],
                      "protocols": ["mdx"], "options": {}, "concurrency": 1, "total": 1}, [{"id": "q1", "name": "name q1", "mdx": "M", "sql": "S"}])


def test_store_roundtrip_history_prune_and_restart(tmp_path):
    from testing import store

    store.set_path(tmp_path / "t.db")
    for i in range(3):
        _new_run(store, f"r{i}", f"2026-09-28T10:0{i}:00Z")
        store.add_execution(_rec(f"r{i}", "h1", "q1", ms=10 + i), {"keys": [], "measures": ["m"], "rows": [{"key": [], "label": [], "values": [str(i)]}]})
        store.finish_run(f"r{i}", "done", f"2026-09-28T10:0{i}:30Z")
    run = store.get_run("r2")
    assert run["done"] == 1 and run["queries"][0]["id"] == "q1" and run["results"][0]["hasData"]
    assert store.read_data("r1", "h1", "mdx", "q1")["rows"][0]["values"] == ["1"]
    assert [h["runId"] for h in store.history("cube1", "name q1")] == ["r2", "r1", "r0"]
    assert store.prune("cube1", keep=2) == 1 and [r["runId"] for r in store.list_runs()] == ["r2", "r1"]
    assert store.read_data("r0", "h1", "mdx", "q1") is None  # executions cascade
    _new_run(store, "live", "2026-09-28T11:00:00Z")
    store._ready.clear()  # simulate an API restart
    assert store.get_run("live")["status"] == "failed"


def test_store_imports_legacy_json(tmp_path):
    import json

    from testing import store

    store.set_path(tmp_path / "t.db")
    legacy = tmp_path / "tests"
    (legacy / "old" / "h1" / "mdx").mkdir(parents=True)
    rec = _rec("old", "h1", "q1")
    (legacy / "old.json").write_text(json.dumps({
        "runId": "old", "status": "done", "startedAt": "2026-09-01T00:00:00Z", "finishedAt": "2026-09-01T00:01:00Z",
        "targets": [{"hostId": "h1", "catalog": "c", "cube": "cube1"}], "protocols": ["mdx"], "options": {},
        "concurrency": 1, "total": 1, "done": 1, "failed": 0, "error": None,
        "queries": [{"id": "q1", "name": "name q1", "mdx": "M", "sql": "S"}], "results": [rec], "models": {"h1": {"metrics": {}, "levels": {}}}}))
    (legacy / "old" / "h1" / "mdx" / "q1.json").write_text(json.dumps({"keys": [], "measures": [], "rows": []}))
    assert store.import_json_dir(legacy) == 1
    run = store.get_run("old")
    assert run["done"] == 1 and run["models"]["h1"] == {"metrics": {}, "levels": {}}
    assert store.read_data("old", "h1", "mdx", "q1") == {"keys": [], "measures": [], "rows": []}
    assert not legacy.exists() and (tmp_path / "tests-imported").is_dir()


def test_duplicate_keys_compared_as_multiset():
    a = sql_rows(["k", "m"], [["jan", "1"], ["jan", "2"], ["feb", "3"]], ["m"])
    b = sql_rows(["k", "m"], [["feb", "3"], ["jan", "2"], ["jan", "1"]], ["m"])  # same data, other order
    d = compare(a, b)
    assert d["status"] == "identical" and d["duplicateKeysA"] == 1
    c = sql_rows(["k", "m"], [["jan", "1"], ["jan", "5"], ["feb", "3"]], ["m"])
    assert compare(a, c)["status"] == "differs"


def test_select_old_keep_and_age(tmp_path):
    from testing import store

    store.set_path(tmp_path / "t.db")
    for i, (model, started) in enumerate([("a", "2020-01-01T00:00:00Z"), ("a", "2026-09-27T00:00:00Z"),
                                          ("a", "2026-09-28T00:00:00Z"), ("b", "2026-09-28T00:00:00Z")]):
        _new_run(store, f"r{i}", started, model=model)
        store.finish_run(f"r{i}", "done", started)
    _new_run(store, "live", "2019-01-01T00:00:00Z", model="a")  # running: never selected
    assert {r["runId"] for r in store.select_old(keep_per_model=1)} == {"r0", "r1"}
    assert {r["runId"] for r in store.select_old(older_than_days=30)} == {"r0"}
    assert {r["runId"] for r in store.select_old(keep_per_model=0, model="b")} == {"r3"}
    assert store.delete_runs(["r0", "r1"], vacuum=True) == 2
    assert {r["runId"] for r in store.list_runs()} == {"r2", "r3", "live"}


def test_cleanup_endpoint_dry_run_then_delete(client):
    qs = build_queries(*model_entries(META), "cube1")[:1]
    ids = []
    for _ in range(3):
        rid = client.post("/api/test/runs", json={"targets": [{"hostId": "dev-east", "catalog": "cat", "cube": "cube1"}],
                                                  "queries": qs, "protocols": ["mdx"]}).get_json()["runId"]
        for _ in range(100):
            if client.get(f"/api/test/runs/{rid}").get_json()["status"] != "running":
                break
            time.sleep(0.05)
        ids.append(rid)
    assert client.post("/api/test/cleanup", json={}).status_code == 400
    dry = client.post("/api/test/cleanup", json={"keepPerModel": 1, "dryRun": True}).get_json()
    assert dry["count"] == 2 and len(client.get("/api/test/runs").get_json()["runs"]) == 3
    done = client.post("/api/test/cleanup", json={"keepPerModel": 1}).get_json()
    assert done["count"] == 2 and done["store"]["runs"] == 1


def test_run_cap_returns_429(client, monkeypatch):
    import threading

    from routes import testing as testing_routes

    monkeypatch.setattr(testing_routes, "_active", threading.BoundedSemaphore(1))
    testing_routes._active.acquire()
    q = build_queries(*model_entries(META), "c")[:1]
    r = client.post("/api/test/runs", json={"targets": [{"hostId": "dev-east", "catalog": "c", "cube": "c"}], "queries": q})
    assert r.status_code == 429 and r.get_json()["busy"]


def test_jobs_are_pruned(monkeypatch):
    import jobs

    monkeypatch.setattr(jobs, "_jobs", {})
    monkeypatch.setattr(jobs, "MAX_JOBS", 3)
    for i in range(3):
        jobs._jobs[f"old{i}"] = {"id": f"old{i}", "status": "done", "_t": time.time() - 2 * jobs.KEEP_FINISHED_S}
    jobs._jobs["busy"] = {"id": "busy", "status": "running", "_t": 0}
    for i in range(5):
        jobs._jobs[f"new{i}"] = {"id": f"new{i}", "status": "done", "_t": time.time() + i}
    with jobs._lock:
        jobs._prune()
    assert "busy" in jobs._jobs and not any(k.startswith("old") for k in jobs._jobs)
    assert len(jobs._jobs) == 3 and "new4" in jobs._jobs


def test_store_stats_per_model_and_compact(client):
    qs = build_queries(*model_entries(META), "cube1")[:1]
    rid = client.post("/api/test/runs", json={"targets": [{"hostId": "dev-east", "catalog": "cat", "cube": "cube1"}],
                                              "queries": qs, "protocols": ["mdx"]}).get_json()["runId"]
    for _ in range(100):
        if client.get(f"/api/test/runs/{rid}").get_json()["status"] != "running":
            break
        time.sleep(0.05)
    info = client.get("/api/test/store").get_json()
    assert info["models"][0]["model"] == "cube1" and info["models"][0]["runs"] == 1 and info["models"][0]["executions"] == 1
    assert client.post("/api/test/compact").status_code == 200
