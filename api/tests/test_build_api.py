"""Build (merged sml-wizard) endpoints against the fake backend: host-scoped
sources, generate, and deploy to several hosts at once."""

import copy

import pytest

from routes import build
from tests.test_api_fake import client as _client_fixture, wait  # noqa: F401 - pytest fixture reuse
from tests.test_smlgen import PAYLOAD


@pytest.fixture
def client(_client_fixture, tmp_path, monkeypatch):  # noqa: F811
    monkeypatch.setattr(build, "MODELS_ROOT", tmp_path / "models")
    return _client_fixture


def payload(**extra):
    p = copy.deepcopy(PAYLOAD)
    p.update(asConnection="PostgresDB", **extra)
    return p


def test_sources_are_per_host(client):
    dev = client.get("/api/hosts/dev-east/sources").get_json()["sources"]
    assert [s["id"] for s in dev] == ["PostgresDB::tutorial"]
    assert client.get("/api/hosts/prod-west/sources").get_json()["sources"] == []
    assert client.get("/api/hosts/nope/sources").status_code == 404


def poll_schemas(client, qs=""):
    """/schemas returns schema names at once and lists tables in the background;
    poll like the Source panel until no schema is `loading`."""
    import time

    for _ in range(100):
        body = client.get(f"/api/hosts/dev-east/sources/PostgresDB::tutorial/schemas{qs}").get_json()
        if not any(s.get("loading") for s in body):
            return body
        qs = qs.replace("refresh=1", "refresh=0")
        time.sleep(0.02)
    raise AssertionError("schemas still loading")


def test_schemas_hide_system_and_filter(client):
    first = client.get("/api/hosts/dev-east/sources/PostgresDB::tutorial/schemas").get_json()
    assert [s["name"] for s in first] == ["public"]                  # names come back at once
    schemas = poll_schemas(client)
    assert len(schemas[0]["tables"]) == 5 and not schemas[0].get("loading")
    hit = poll_schemas(client, "?search=dimc")
    assert [t["name"] for t in hit[0]["tables"]] == ["dimcustomer"]
    assert "columns" not in hit[0]["tables"][0]                       # names only; columns load per table
    cols = client.get("/api/hosts/dev-east/sources/PostgresDB::tutorial/columns?schema=public&table=dimcustomer").get_json()
    assert {"name": "customerkey", "type": "Int"} in cols
    batch = client.post("/api/hosts/dev-east/sources/PostgresDB::tutorial/columns",
                        json={"tables": [{"schema": "public", "table": "dimcustomer"},
                                         {"schema": "public", "table": "dimdate"}]}).get_json()
    assert set(batch) == {"public.dimcustomer", "public.dimdate"} and batch["public.dimcustomer"] == cols


def test_a_failing_schema_keeps_its_place_with_the_error(client, monkeypatch):
    from atscale.fake import FakeSourceApi
    from envs import registry

    class Api(FakeSourceApi):
        def list_schemas(self, connection_id, database):
            return ["public", "post"]

        def list_tables(self, connection_id, database, schema):
            if schema == "post":
                raise RuntimeError("Ask timed out")
            return super().list_tables(connection_id, database, schema)

    monkeypatch.setattr(registry, "source_api", lambda h: Api(h))
    schemas = poll_schemas(client, "?refresh=1")
    by = {s["name"]: s for s in schemas}
    assert len(by["public"]["tables"]) == 5 and by["post"] == {"name": "post", "tables": [], "error": "Ask timed out"}
    assert build._tables_ttl(by["post"]) == build._SOURCES_RETRY_TTL


def test_generate(client):
    r = client.post("/api/sml/generate", json=payload())
    assert r.status_code == 200
    assert any(f["name"] == "catalog.yml" for f in r.get_json()["files"])


def test_deploy_to_several_hosts(client, tmp_path):
    r = client.post("/api/build/deploy", json=payload(hostIds=["dev-east", "qa-main", "prod-west"]))
    assert r.status_code == 202
    job = wait(client, r.get_json())
    assert job["status"] == "done", job
    res = {x["hostId"]: x for x in job["result"]["results"]}
    assert res["dev-east"]["ok"] and res["qa-main"]["ok"]
    assert not res["prod-west"]["ok"] and "PostgresDB" in res["prod-west"]["error"]
    assert (tmp_path / "models" / build.slugify_model_name(PAYLOAD["modelName"]) / "catalog.yml").exists()
    names = {m["name"] for m in client.get("/api/hosts/qa-main/models").get_json()["models"]}
    assert PAYLOAD["modelName"] in names


def test_deploy_needs_hosts_and_git(client):
    assert client.post("/api/build/deploy", json=payload(hostIds=[])).status_code == 400
    client.put("/api/git", json={"token": ""})
    assert client.post("/api/build/deploy", json=payload(hostIds=["dev-east"])).status_code == 409


def test_preflight(client):
    body = client.get("/api/build/preflight?connection=PostgresDB&hostIds=dev-east,prod-west").get_json()
    assert {h["hostId"]: h["ok"] for h in body["hosts"]} == {"dev-east": True, "prod-west": False}


def test_preview_is_unavailable_in_demo(client):
    r = client.get("/api/hosts/dev-east/preview/catalogs")
    assert r.status_code == 400 and "demo" in r.get_json()["error"]


def test_real_client_has_every_source_api_call():
    """FakeSourceApi stands in for AtScaleClient in demo mode; the real client
    must expose the same calls or Build 500s on a live host."""
    from atscale.client import AtScaleClient
    from atscale.fake import FakeSourceApi

    calls = [n for n in vars(FakeSourceApi) if not n.startswith("_")]
    assert calls and all(callable(getattr(AtScaleClient, n, None)) for n in calls), calls


def test_preview_freehand_mdx_sql_and_fault(client, monkeypatch):
    from envs import registry
    from tests.test_testing import SQL_OK, XMLA_FAULT, cellset

    class Api:
        def __init__(self, body):
            self.body = body

        def run_xmla(self, xml, timeout=None):
            return self.body

        def submit_query(self, payload, timeout=None):
            assert payload["query"] == 'SELECT "a" FROM "c"\nLIMIT 1001' and payload["context"]["project"]["name"] == "cat"
            return SQL_OK

    url = "/api/hosts/dev-east/preview/freehand"
    body = {"catalog": "cat", "cube": "c", "dialect": "mdx", "query": "SELECT {[Measures].[s]} ON COLUMNS FROM [c]"}
    monkeypatch.setattr(registry, "source_api", lambda h: Api(cellset([42], rows=False)))
    r = client.post(url, json=body).get_json()
    assert r["columns"] == ["Sales"] and r["rows"] == [["42"]]          # grand total: no row axis
    monkeypatch.setattr(registry, "source_api", lambda h: Api(cellset([10, 20])))
    r = client.post(url, json=body).get_json()
    assert r["columns"] == ["Row Labels", "Sales"] and r["rows"] == [["Bikes", "10"], ["Helmets", "20"]]
    monkeypatch.setattr(registry, "source_api", lambda h: Api(XMLA_FAULT))
    r = client.post(url, json=body)
    assert r.status_code == 502 and r.get_json()["error"] == "Level not found"
    r = client.post(url, json={**body, "dialect": "sql", "query": 'SELECT "a" FROM "c"'}).get_json()
    assert r["columns"] == ["a"] and r["rows"] == [["x"], ["y"]] and not r.get("truncated") and r["maxRows"] == 1000
    assert client.post(url, json={**body, "query": "  "}).status_code == 400


def test_unreachable_warehouse_is_listed_with_its_error_and_retried_soon(client, monkeypatch):
    """A warehouse whose databases can't be listed (e.g. a suspended Snowflake
    still resuming) stays in the list with AtScale's error instead of vanishing,
    and that list is cached for a minute, not the full TTL."""
    import cache
    from atscale.fake import FakeSourceApi
    from envs import registry

    class Api(FakeSourceApi):
        def list_data_sources(self):
            return super().list_data_sources() + [{"name": "Snow", "connectionId": "Snow", "platformType": "snowflake"}]

        def list_databases(self, connection_id):
            if connection_id == "Snow":
                raise RuntimeError("warehouse is resuming")
            return super().list_databases(connection_id)

    monkeypatch.setattr(registry, "source_api", lambda h: Api(h))
    sources = client.get("/api/hosts/dev-east/sources?refresh=1").get_json()["sources"]
    snow = next(s for s in sources if s["connectionId"] == "Snow")
    assert snow["error"] == "warehouse is resuming" and snow["database"] is None
    assert build._sources_ttl(sources) == build._SOURCES_RETRY_TTL
    assert build._sources_ttl([s for s in sources if not s.get("error")]) == cache.TTL
