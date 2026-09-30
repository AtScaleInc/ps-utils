"""Monitor: /wapi/p/queries rows -> stored history -> reports, against the fake host."""

import time

import pytest

from app import create_app
from envs import registry
from envs.store import Store
from monitor import poll as poller
from monitor import stats, store
from monitor.queries import classify, normalize, pair_counts

ROW = {
    "queryId": "q1", "startTime": 1_700_000_000_000, "duration": 812.0, "status": "successful", "queryType": "User",
    "userId": "u1", "user": "Ana Lee", "catalogId": "c1", "catalogName": "sales", "modelId": "m1",
    "modelName": "Internet Sales", "dialect": "postgresql", "optimization": ["AGGS"], "aggregates": ["d1"],
    "aggregatesTables": ["as_agg_1"], "attributes": ["Year"], "measures": ["Sales", "Qty"],
    "events": [{"name": "Inbound Query", "duration": 812}, {"name": "Planning", "duration": 40.5},
               {"name": "Outbound", "duration": 700, "subqueries": [{"name": "Query 1", "duration": 690}]},
               {"name": "Result Processing", "duration": 20}],
}


def test_normalize_reads_events_and_flags():
    r = normalize(ROW)
    assert (r["cls"], r["planningMs"], r["outboundMs"], r["processingMs"], r["subqueries"]) == ("agg", 40.5, 700, 20, 1)
    assert r["durationMs"] == 812.0 and r["user"] == "Ana Lee"


def test_classify_order():
    assert classify(["CACHE", "AGGS"], ["d"], 1, "successful") == "cache"
    assert classify([], ["d"], 1, "successful") == "agg"
    assert classify([], [], 1, "successful") == "raw"
    # no subquery sent at all: answered by the engine without the warehouse
    assert classify([], [], 0, "successful") == "cache"
    assert classify([], [], 0, "failed") == "raw"


def test_pair_counts_ports_ps_utils_null_pairs():
    a = normalize({**ROW, "optimization": [], "aggregates": []})
    b = normalize({**ROW, "queryId": "q2", "attributes": [], "measures": ["Sales"]})
    pairs = {(p["attribute"], p["measure"]): p for p in pair_counts([a, b])}
    assert pairs[("Year", "Sales")]["count"] == 1 and pairs[("Year", "Sales")]["raw"] == 1
    assert pairs[(None, "Sales")]["count"] == 1
    system = normalize({**ROW, "queryId": "q3", "queryType": "System", "attributes": [], "measures": []})
    assert (None, None) not in {(p["attribute"], p["measure"]) for p in pair_counts([a, system])}


def test_overview_buckets_and_percentiles():
    base = 1_700_000_000_000
    recs = [normalize({**ROW, "queryId": f"q{i}", "startTime": base + i * 60_000, "duration": float(i + 1) * 100,
                       "optimization": ["CACHE"] if i % 2 else []}) for i in range(10)]
    o = stats.overview(recs, base, base + 3600_000)
    assert o["bucketMs"] == 5 * 60_000
    assert o["totals"]["count"] == 10 and o["totals"]["cache"] == 5 and o["totals"]["agg"] == 5
    assert o["totals"]["p95"] == 1000 and o["totals"]["p50"] == 500
    assert sum(s["cache"] + s["agg"] + s["raw"] for s in o["series"]) == 10
    assert o["byType"]["User"]["count"] == 10 and o["byType"]["System"]["count"] == 0


@pytest.fixture
def client(tmp_path, monkeypatch):
    monkeypatch.setattr(registry, "FAKE", True)
    import cache

    cache.set_dir(tmp_path / "cache")
    store.set_path(tmp_path / "monitor.db")
    s = Store(tmp_path / "connections.yaml")
    registry.set_store(s)
    registry.seed_fake(s)
    yield create_app().test_client()
    registry.set_store(None)


def _poll(client, host, body=None):
    job = client.post(f"/api/hosts/{host}/monitor/poll", json=body or {}).get_json()
    for _ in range(200):
        j = client.get(f"/api/jobs/{job['id']}").get_json()
        if j["status"] != "running":
            assert j["status"] == "done", j
            return j["result"]
        time.sleep(0.05)
    raise AssertionError("poll timed out")


def test_poll_is_incremental_and_reports_read_the_store(client):
    first = _poll(client, "prod-east")
    assert first["added"] > 0 and not first["truncated"]
    span = time.time() * 1000 - first["fromMs"]
    assert abs(span - poller.DEFAULT_DAYS * 86400_000) < 60_000
    again = _poll(client, "prod-east")
    assert again["fromMs"] > first["fromMs"]  # since the newest stored query, not the whole window
    assert again["fetched"] < first["fetched"]

    now = int(time.time() * 1000)
    o = client.get(f"/api/hosts/prod-east/monitor/overview?fromMs={now - 2 * 86400_000}&toMs={now}").get_json()
    t = o["totals"]
    assert t["count"] == t["cache"] + t["agg"] + t["raw"] == client.get(
        "/api/hosts/prod-east/monitor/status").get_json()["stored"]
    assert o["byType"]["System"]["count"] > 0 and o["models"]

    page = client.get(f"/api/hosts/prod-east/monitor/queries?fromMs={now - 2 * 86400_000}&cls=agg&limit=5").get_json()
    assert len(page["queries"]) == 5 and {q["cls"] for q in page["queries"]} == {"agg"}
    qid = page["queries"][0]["queryId"]
    d = client.get(f"/api/hosts/prod-east/monitor/queries/{qid}").get_json()
    assert d["query"]["text"] and d["query"]["aggDefs"][0]["type"] in ("system_defined", "user_defined")
    assert d["query"]["events"]

    h = client.get(f"/api/hosts/prod-east/monitor/hotspots?fromMs={now - 2 * 86400_000}").get_json()
    assert h["slowest"][0]["durationMs"] >= h["slowest"][-1]["durationMs"] and h["pairs"]


def test_overlapping_pulls_never_duplicate(client):
    now = int(time.time() * 1000)
    _poll(client, "prod-east")
    _poll(client, "prod-east", {"fromMs": now - 3 * 86400_000})       # overlaps the default window
    _poll(client, "prod-east", {"fromMs": now - 86400_000, "toMs": now})  # already stored entirely
    _poll(client, "prod-east")
    with store._db() as con:
        rows, distinct = con.execute(
            "SELECT COUNT(*), COUNT(DISTINCT query_id) FROM queries WHERE host_id = 'prod-east'").fetchone()
    assert rows == distinct == client.get("/api/hosts/prod-east/monitor/status").get_json()["stored"]
    again = _poll(client, "prod-east", {"fromMs": now - 86400_000, "toMs": now})
    assert again["fetched"] > 0 and again["added"] == 0


def test_running_query_is_updated_not_duplicated():
    import tempfile
    from pathlib import Path

    store.set_path(Path(tempfile.mkdtemp()) / "m.db")
    running = normalize({**ROW, "status": "running", "duration": None})
    assert store.upsert("h", [running]) == 1
    assert store.upsert("h", [normalize(ROW)]) == 0
    rows, total = store.page("h", {})
    assert total == 1 and rows[0]["status"] == "successful" and rows[0]["durationMs"] == 812.0


def test_range_backfill_and_page_cap(client, monkeypatch):
    now = int(time.time() * 1000)
    r = _poll(client, "qa-main", {"fromMs": now - 5 * 86400_000, "toMs": now - 4 * 86400_000})
    assert r["toMs"] == now - 4 * 86400_000 and r["added"] > 0
    monkeypatch.setattr(poller, "MAX_PAGES", 1)
    r = _poll(client, "qa-main", {"fromMs": now - 86400_000})
    assert r["truncated"] and r["pages"] == 1
    assert client.get("/api/hosts/qa-main/monitor/status").get_json()["lastPoll"]["truncated"]


def test_cleanup_by_host_and_model(client):
    _poll(client, "prod-east")
    _poll(client, "qa-main")
    info = client.get("/api/monitor/store").get_json()
    east = next(h for h in info["hosts"] if h["hostId"] == "prod-east")
    model = east["models"][0]
    assert sum(m["queries"] for m in east["models"]) == east["queries"]
    body = {"hostId": "prod-east", "model": model["model"]}
    assert client.post("/api/monitor/cleanup", json={**body, "dryRun": True}).get_json()["count"] == model["queries"]
    assert client.post("/api/monitor/cleanup", json=body).get_json()["count"] == model["queries"]
    # everything for one host; the other host is untouched and the next poll starts at the default window
    left = client.post("/api/monitor/cleanup", json={"hostId": "prod-east"}).get_json()["count"]
    assert left == east["queries"] - model["queries"]
    hosts = {h["hostId"] for h in client.get("/api/monitor/store").get_json()["hosts"]}
    assert hosts == {"qa-main"}
    r = _poll(client, "prod-east")
    assert abs(time.time() * 1000 - r["fromMs"] - poller.DEFAULT_DAYS * 86400_000) < 60_000


def test_daily_polls_grow_history_without_duplicates(client, monkeypatch):
    """Day 1 pulls the default window; each later poll only adds what's new."""
    real = time.time()
    for day in range(4):
        monkeypatch.setattr(time, "time", lambda d=day: real + d * 86400)
        _poll(client, "prod-east")
    with store._db() as con:
        rows, distinct, lo, hi = con.execute("SELECT COUNT(*), COUNT(DISTINCT query_id), MIN(start_ms), MAX(start_ms) "
                                             "FROM queries WHERE host_id = 'prod-east'").fetchone()
    assert rows == distinct
    days = (hi - lo) / 86400_000
    assert poller.DEFAULT_DAYS + 3 - 0.2 < days <= poller.DEFAULT_DAYS + 3 + 0.01


def test_cleanup_and_bad_range(client):
    _poll(client, "dev-east")
    assert client.post("/api/hosts/dev-east/monitor/poll", json={"fromMs": 10, "toMs": 5}).status_code == 400
    n = client.post("/api/monitor/cleanup", json={"olderThanDays": 0, "dryRun": True}).get_json()["count"]
    assert n > 0
    assert client.post("/api/monitor/cleanup", json={"olderThanDays": 0}).get_json()["count"] == n
    assert client.get("/api/monitor/store").get_json()["queries"] == 0
