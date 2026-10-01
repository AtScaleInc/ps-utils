"""Catalog: repo -> model -> every host of the BU it's on."""

from tests.test_api_fake import client  # noqa: F401 - pytest fixture reuse

FIN = {"X-BU": "finance"}


def _model(body, name):
    return next(m for r in body["repos"] for m in r["models"] if m["name"] == name)


def test_catalog_lists_git_models_and_where_they_are(client):  # noqa: F811
    body = client.get("/api/catalog").get_json()
    assert body["gitError"] is None
    assert {r["fullName"] for r in body["repos"]} >= {"corp/atscale-sml-sales", "corp/atscale-sml-ops"}
    sales = _model(body, "Internet Sales")
    assert sales["inGit"]
    # Dev -> Prod order, and only this BU's hosts.
    assert [d["env"] for d in sales["deployments"]] == sorted(
        [d["env"] for d in sales["deployments"]], key=["dev", "test", "qa", "prod"].index)
    by_host = {d["hostId"]: d for d in sales["deployments"]}
    assert "fin-dev" not in by_host
    assert by_host["dev-sandbox"]["status"] == "Linked" and by_host["dev-sandbox"]["atHead"] is None
    # main's head is the newest version any host runs (v15 on the sandbox link);
    # every deployed copy is older.
    assert by_host["prod-east"]["commit"] == "v12" and by_host["prod-east"]["atHead"] is False


def test_catalog_is_per_bu(client):  # noqa: F811
    body = client.get("/api/catalog", headers=FIN).get_json()
    ledger = _model(body, "Finance Ledger")
    assert {d["hostId"] for d in ledger["deployments"]} == {"fin-dev", "fin-prod"}
    assert {h["id"] for h in body["hosts"]} == {"fin-dev", "fin-prod"}


def test_model_in_git_but_nowhere_is_listed(client):  # noqa: F811
    body = client.get("/api/catalog", headers=FIN).get_json()
    m = _model(body, "Inventory Snapshot")
    assert m["inGit"] and m["deployments"] == []
