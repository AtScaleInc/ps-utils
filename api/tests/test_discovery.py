"""Build > Discovery against the fake warehouse (SQLite behind FakeSourceApi.query_sample),
so the real profile SQL runs; results are stored in a temp discovery.db."""

import pytest

from discovery import profile as prof
from discovery import store
from tests.test_api_fake import client as _client_fixture  # noqa: F401 - pytest fixture reuse

Q = "source=PostgresDB::tutorial&schema=public"


@pytest.fixture
def client(_client_fixture, tmp_path):  # noqa: F811
    store.set_path(tmp_path / "discovery.db")
    return _client_fixture


class CountingApi:
    """Wraps FakeSourceApi and counts warehouse queries."""

    def __init__(self):
        from atscale.fake import FakeSourceApi

        self.inner, self.queries = FakeSourceApi("dev-east"), []

    def query_sample(self, connection_id, query, timeout=None):
        self.queries.append(query)
        return self.inner.query_sample(connection_id, query)

    def __getattr__(self, name):
        return getattr(self.inner, name)


def test_table_returns_columns_sample_and_engine_stats(client):
    r = client.get(f"/api/hosts/dev-east/discovery/table?{Q}&table=dimcustomer").get_json()
    assert [c["name"] for c in r["columns"]][:2] == ["customerkey", "firstname"]
    assert r["dialect"] == "postgresql"
    assert len(r["sample"]["rows"]) == 100 and r["sample"]["columns"][0] == "customerkey"
    assert r["statistics"] == [{"type": "RowCount", "columns": [], "value": 180, "lastUpdated": "2026-09-01T00:00:00Z"}]


def test_profile_stats_roles_and_flags(client):
    r = client.get(f"/api/hosts/dev-east/discovery/profile?{Q}&table=dimproduct").get_json()
    assert r["rowCount"] == 60 and r["drift"] is None and len(r["history"]) == 1
    cols = {c["name"]: c for c in r["columns"]}
    assert cols["productkey"]["role"] == "key" and cols["productkey"]["min"] == "1"
    assert cols["color"]["nulls"] == 15 and cols["color"]["nullPct"] == 25.0 and cols["color"]["distinct"] == 4
    assert cols["productsubcategorykey"]["role"] == "join"
    assert r["duplicates"] == {"groups": 0, "extraRows": 0}
    assert cols["englishproductname"]["patterns"][0] == {"pattern": "AAA+ 999", "share": 100.0}


def test_profile_is_stored_not_rerun(client, monkeypatch):
    from envs import registry

    api = CountingApi()
    monkeypatch.setattr(registry, "source_api", lambda h: api)
    url = f"/api/hosts/dev-east/discovery/profile?{Q}&table=dimgeography"
    first = client.get(url).get_json()
    n = len(api.queries)
    assert n > 0
    again = client.get(url).get_json()
    assert len(api.queries) == n and again["id"] == first["id"]       # served from discovery.db
    fresh = client.get(url + "&refresh=1").get_json()
    assert len(api.queries) > n and fresh["id"] != first["id"]
    assert fresh["drift"]["rowDelta"] == 0 and fresh["drift"]["added"] == [] and len(fresh["history"]) == 2
    old = client.get(url + f"&id={first['id']}").get_json()
    assert old["id"] == first["id"] and old["drift"] is None


def test_top_values_and_join_check(client):
    r = client.get(f"/api/hosts/dev-east/discovery/top-values?{Q}&table=dimproduct&column=color").get_json()
    assert r["values"][0]["count"] == 15 and {v["value"] for v in r["values"]} >= {None, "Black"}
    j = client.post("/api/hosts/dev-east/discovery/join-check", json={
        "source": "PostgresDB::tutorial", "schema": "public", "table": "factinternetsales",
        "column": "customerkey", "toTable": "dimcustomer", "toColumn": "customerkey"}).get_json()
    assert j["keys"] == 600 and j["orphanRows"] == 0 and j["targetUnique"] is True
    j = client.post("/api/hosts/dev-east/discovery/join-check", json={
        "source": "PostgresDB::tutorial", "schema": "public", "table": "factinternetsales",
        "column": "productkey", "toTable": "dimproduct", "toColumn": "productsubcategorykey"}).get_json()
    assert j["targetUnique"] is False and j["orphanRows"] > 0 and j["orphanSample"]


def test_store_info_and_cleanup(client):
    url = f"/api/hosts/dev-east/discovery/profile?{Q}&table=dimdate"
    for _ in range(3):
        client.get(url + "&refresh=1")
    client.get(f"/api/hosts/dev-east/discovery/profile?{Q}&table=dimgeography")
    client.get(f"/api/hosts/dev-east/discovery/top-values?{Q}&table=dimgeography&column=city")
    info = client.get("/api/discovery/store").get_json()
    assert info["profiles"] == 4 and {t["table"]: t["runs"] for t in info["tables"]} == {"dimdate": 3, "dimgeography": 1}
    assert client.post("/api/discovery/cleanup", json={}).status_code == 400
    dry = client.post("/api/discovery/cleanup", json={"keepPerTable": 1, "dryRun": True}).get_json()
    assert dry["count"] == 2 and {r["table"] for r in dry["runs"]} == {"public.dimdate"}
    assert client.get("/api/discovery/store").get_json()["profiles"] == 4       # dry run deleted nothing
    assert client.post("/api/discovery/cleanup", json={"keepPerTable": 1}).get_json()["count"] == 2
    assert client.post("/api/discovery/cleanup", json={"keepPerTable": 1, "hostId": "dev-sandbox",
                                                        "dryRun": True}).get_json()["count"] == 0
    import sqlite3

    with sqlite3.connect(store.path()) as con:  # backdate the remaining runs
        con.execute("UPDATE profiles SET profiled_at = '2026-01-01T00:00:00Z'")
    assert client.post("/api/discovery/cleanup", json={"olderThanDays": 30}).get_json()["count"] == 2
    info = client.get("/api/discovery/store").get_json()
    assert info["profiles"] == 0 and info["items"] == 0                           # items go with their table
    assert client.post("/api/discovery/compact").status_code == 200


def test_bad_args_and_unknown_host(client):
    assert client.get("/api/hosts/dev-east/discovery/profile?table=x").status_code == 400
    assert client.get(f"/api/hosts/nope/discovery/profile?{Q}&table=x").status_code == 404
    r = client.get(f"/api/hosts/dev-east/discovery/profile?{Q}&table=missing")
    assert r.status_code in (400, 502)


def test_flags_and_drift_units():
    col = {"name": "status", "kind": "string", "role": "attribute", "nullPct": 0, "blanks": 3, "sentinels": 2,
           "nonNull": 10, "distinct": 3}
    texts = [f["text"] for f in prof.column_flags(col, 10)]
    assert any("blank" in t for t in texts) and any("placeholder" in t for t in texts)
    date = {"name": "d", "kind": "temporal", "role": "time", "min": "1899-12-31", "max": "9999-12-31", "future": 4}
    assert len(prof.column_flags(date, 10)) == 3
    text_nums = prof.sample_checks({"columns": ["n"], "rows": [["1"], ["2.5"], ["1,000"]]},
                                   [{"name": "n", "kind": "string"}])
    assert text_nums["n"]["storedAs"] == "number"
    d = store.drift({"rowCount": 120, "columns": [{"name": "a", "type": "Int", "nullPct": 30.0},
                                                  {"name": "c", "type": "String"}]},
                    {"rowCount": 100, "profiledAt": "t0", "columns": [{"name": "a", "type": "String", "nullPct": 1.0},
                                                                      {"name": "b", "type": "Int"}]})
    assert d["rowDelta"] == 20 and d["rowDeltaPct"] == 20.0 and d["added"] == ["c"] and d["removed"] == ["b"]
    assert d["retyped"] == [{"name": "a", "from": "String", "to": "Int"}]
    assert d["shifts"] == [{"name": "a", "what": "nullPct", "from": 1.0, "to": 30.0}]
    assert prof.quote_ident("a`b", "databricks") == "`a``b`" and prof.table_ref("db", "s", "t", "snowflake") == '"db"."s"."t"'
    assert prof.table_ref("db", "s", "t", "postgresql") == '"s"."t"'


def test_statistics_404_means_none():
    from atscale.client import AtScaleApiError

    class Old:
        def list_datasource_statistics(self, connection_id):
            raise AtScaleApiError(404, "The requested resource could not be found.", "https://h/engine/v1/datasources/c/statistics")

    assert prof.table_statistics(Old(), "c", "db", "s", "t") == []
