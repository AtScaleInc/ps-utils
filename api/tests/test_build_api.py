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


def test_schemas_hide_system_and_filter(client):
    schemas = client.get("/api/hosts/dev-east/sources/PostgresDB::tutorial/schemas").get_json()
    assert [s["name"] for s in schemas] == ["public"]
    hit = client.get("/api/hosts/dev-east/sources/PostgresDB::tutorial/schemas?search=dimc").get_json()
    assert [t["name"] for t in hit[0]["tables"]] == ["dimcustomer"]
    assert {"name": "customerkey", "type": "Int"} in hit[0]["tables"][0]["columns"]


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
