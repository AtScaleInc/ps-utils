"""Business units: each is an isolated realm - its own hosts (dev/test/qa/prod)
and Git profile. The UI sends the picked BU as X-BU; no header = the first BU."""

from routes import build
from tests.test_api_fake import client, wait  # noqa: F401 - pytest fixture reuse
from tests.test_build_api import payload

FIN = {"X-BU": "finance"}


def test_bu_list_counts_hosts_per_group(client):  # noqa: F811
    body = client.get("/api/bus").get_json()
    bus = {b["id"]: b for b in body["bus"]}
    assert list(bus) == ["sales-analytics", "finance"] and body["current"] == "sales-analytics"
    assert bus["sales-analytics"]["groups"] == {"dev": 2, "test": 1, "qa": 1, "prod": 2}
    assert bus["finance"]["groups"] == {"dev": 1, "test": 0, "qa": 0, "prod": 1}
    assert "ghp_" not in str(body)


def test_hosts_and_git_are_per_bu(client):  # noqa: F811
    assert [h["id"] for h in client.get("/api/hosts", headers=FIN).get_json()["hosts"]] == ["fin-dev", "fin-prod"]
    assert client.get("/api/git", headers=FIN).get_json()["username"] == "finance-bot"
    assert client.get("/api/git").get_json()["username"] == "demo-user"
    new = client.post("/api/hosts", json={"env": "test"}, headers=FIN).get_json()
    assert new["bu"] == "finance"
    assert new["id"] not in [h["id"] for h in client.get("/api/hosts").get_json()["hosts"]]


def test_another_bus_host_is_not_found(client):  # noqa: F811
    assert client.get("/api/hosts/dev-east/models", headers=FIN).status_code == 404
    assert client.patch("/api/hosts/dev-east", json={"label": "x"}, headers=FIN).status_code == 404
    assert client.delete("/api/hosts/dev-east", headers=FIN).status_code == 404
    r = client.post("/api/promote/diff", json={"section": "models", "sourceHostId": "fin-dev", "targetHostId": "qa-main"},
                    headers=FIN)
    assert r.status_code == 404
    assert client.get("/api/hosts/fin-dev/models", headers=FIN).status_code == 200


def test_unknown_bu_is_rejected(client):  # noqa: F811
    r = client.get("/api/hosts", headers={"X-BU": "nope"})
    assert r.status_code == 400 and r.get_json()["unknownBu"]
    # ...but never the BU list: it's how the UI recovers from a removed BU.
    r = client.get("/api/bus", headers={"X-BU": "nope"})
    assert r.status_code == 200 and r.get_json()["current"] == "sales-analytics"


def test_create_rename_delete_bu(client):  # noqa: F811
    bu = client.post("/api/bus", json={"label": "Marketing"}).get_json()
    assert bu["id"] == "marketing" and bu["hosts"] == 0
    assert client.post("/api/bus", json={"label": "marketing"}).status_code == 400
    assert client.patch("/api/bus/marketing", json={"label": "Marketing EU"}).get_json()["label"] == "Marketing EU"
    assert client.get("/api/hosts", headers={"X-BU": "marketing"}).get_json()["hosts"] == []
    assert client.delete("/api/bus/finance").status_code == 409  # has hosts
    assert client.delete("/api/bus/marketing").status_code == 200


def test_deploy_job_keeps_its_bu(client, tmp_path, monkeypatch):  # noqa: F811
    """The job runs after the request: it still pushes with Finance's Git
    profile and into Finance's working copies."""
    monkeypatch.setattr(build, "MODELS_ROOT", tmp_path / "models")
    p = payload()
    r = client.post("/api/build/deploy", json={**p, "hostIds": ["fin-dev"]}, headers=FIN)
    job = wait(client, r.get_json())
    assert job["status"] == "done", job
    assert job["result"]["git"]["repoUrl"].startswith("https://github.com/finance-bot/")
    assert (tmp_path / "models" / "finance" / build.slugify_model_name(p["modelName"]) / "catalog.yml").exists()
    # Sales Analytics doesn't see Finance's working copy.
    assert client.get("/api/sml/models").get_json() == []
    assert len(client.get("/api/sml/models", headers=FIN).get_json()) == 1
    # Deploying to another BU's host is refused before anything runs.
    assert client.post("/api/build/deploy", json={**p, "hostIds": ["dev-east"]}, headers=FIN).status_code == 404
