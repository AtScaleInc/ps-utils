"""End-to-end API flows against the in-memory fake backend (§9 scenarios)."""

import time

import pytest

from app import create_app
from envs import registry
from envs.store import Store


@pytest.fixture
def client(tmp_path, monkeypatch):
    monkeypatch.setattr(registry, "FAKE", True)
    import cache

    cache.set_dir(tmp_path / "cache")  # never touch the real workspace/cache
    s = Store(tmp_path / "connections.yaml")
    registry.set_store(s)
    registry.seed_fake(s)
    yield create_app().test_client()
    registry.set_store(None)


def wait(client, job):
    for _ in range(50):
        j = client.get(f"/api/jobs/{job['id']}").get_json()
        if j["status"] != "running":
            return j
        time.sleep(0.05)
    raise AssertionError("job timed out")


def diff(client, section, src, tgt, model=None):
    return client.post("/api/promote/diff", json={
        "section": section, "sourceHostId": src, "targetHostId": tgt, "model": model}).get_json()


def test_hosts_grouped_without_secrets(client):
    body = client.get("/api/hosts").get_json()
    assert body["groups"] == {"dev": ["dev-east", "dev-sandbox"], "qa": ["qa-main"], "prod": ["prod-east", "prod-west"]}
    assert "secret" not in str(body)


def test_model_diff_states(client):
    rows = {r["name"]: r["diff"] for r in diff(client, "models", "dev-east", "qa-main")["rows"]}
    assert rows["Internet Sales"]["label"] == "Update v13 → v14"
    assert rows["Supply Chain"]["label"] == "In sync · v4"
    assert rows["Reseller Sales"]["state"] == "same"
    assert rows["Inventory Snapshot"]["state"] == "new"


def test_same_host_is_empty(client):
    d = diff(client, "models", "qa-main", "qa-main")
    assert d["rows"] == [] and d["sameHost"]


def test_promote_new_and_updated_model(client):
    job = client.post("/api/promote/models", json={
        "sourceHostId": "dev-east", "targetHostId": "qa-main", "models": ["Internet Sales", "Inventory Snapshot"]}).get_json()
    assert wait(client, job)["status"] == "done"
    # AtScale deploys a branch, not a commit: the target gets the branch head
    # (v15, already on dev-sandbox), newer than dev-east's deployed v14.
    rows = {r["name"]: r["diff"] for r in diff(client, "models", "dev-east", "qa-main")["rows"]}
    assert rows["Inventory Snapshot"]["state"] == "same"
    assert rows["Internet Sales"]["state"] == "older" and rows["Internet Sales"]["targetVersion"] == "v15"


def test_aggregate_duplicate_skipped_then_replaced(client):
    d = diff(client, "aggs", "qa-main", "prod-east", "Internet Sales")
    states = {r["name"]: r["diff"]["state"] for r in d["rows"]}
    assert states["agg_sales_by_product_cat"] == "dup"
    assert states["agg_sales_by_month"] == "uda"
    assert any(t["duplicate"] for t in d["target"])

    job = client.post("/api/promote/aggregates", json={
        "sourceHostId": "qa-main", "targetHostId": "prod-east", "aggregates": ["agg_sales_by_product_cat"]}).get_json()
    result = wait(client, job)["result"]
    assert result["promoted"] == [] and result["skipped"][0]["reason"] == "Deactivate on target"

    r = client.post("/api/hosts/prod-east/aggregates/deactivate", json={
        "catalogId": "sales_catalog", "modelId": "Internet Sales", "aggregates": ["agg_sales_by_product_cat"]})
    assert r.status_code == 200
    states = {r["name"]: r["diff"]["state"] for r in diff(client, "aggs", "qa-main", "prod-east")["rows"]}
    assert states["agg_sales_by_product_cat"] == "repl"

    job = client.post("/api/promote/aggregates", json={
        "sourceHostId": "qa-main", "targetHostId": "prod-east", "aggregates": ["agg_sales_by_product_cat"]}).get_json()
    # AtScale keeps the existing (blocked) definition, so the target copy is reactivated.
    assert wait(client, job)["result"]["promoted"] == ["agg_sales_by_product_cat (reactivated)"]
    aggs = client.get("/api/hosts/prod-east/aggregates?catalogId=sales_catalog&modelId=Internet%20Sales").get_json()["aggregates"]
    replaced = [a for a in aggs if a["name"] == "agg_sales_by_product_cat"]
    assert len(replaced) == 1 and replaced[0]["status"] == "Built" and replaced[0]["active"]


def test_model_missing_on_target_blocks_aggs(client):
    states = {r["name"]: r["diff"]["state"] for r in diff(client, "aggs", "qa-main", "prod-west")["rows"]}
    assert states["agg_gl_by_account"] == "miss"


def test_unlink_removes_aggregates(client):
    models = client.get("/api/hosts/qa-main/models").get_json()["models"]
    key = next(m["key"] for m in models if m["name"] == "Customer 360")
    assert client.post("/api/hosts/qa-main/models/unlink", json={"models": [key]}).status_code == 200
    names = [m["name"] for m in client.get("/api/hosts/qa-main/aggregate-models").get_json()["models"]]
    assert "Customer 360" not in names


def test_git_gate_blocks_deploy(client):
    registry.store().update_git({"status": "failed"})
    r = client.post("/api/hosts/dev-east/models/deploy", json={"models": ["x"]})
    assert r.status_code == 409 and r.get_json()["needsGit"]


def test_build_goes_building_then_built(client):
    job = client.post("/api/hosts/dev-east/aggregates/build", json={
        "catalogId": "sales_catalog", "modelId": "Reseller Sales", "mode": "incremental"}).get_json()
    wait(client, job)
    url = "/api/hosts/dev-east/aggregates?catalogId=sales_catalog&modelId=Reseller%20Sales"
    assert {a["status"] for a in client.get(url).get_json()["aggregates"]} == {"Building"}
    # Building rows are cached for 5 s only, so polling (as the UI does) sees Built.
    for _ in range(40):
        time.sleep(0.25)
        if {a["status"] for a in client.get(url).get_json()["aggregates"]} == {"Built"}:
            break
    else:
        raise AssertionError("never became Built")


def test_lists_cached_until_refresh(client):
    from atscale import fake

    url = "/api/hosts/qa-main/models"
    first = client.get(url).get_json()
    fake._INV["qa-main"]["models"].pop()  # AtScale changes behind our back
    assert client.get(url).get_json() == first  # served from cache
    fresh = client.get(url + "?refresh=1").get_json()
    assert len(fresh["models"]) == len(first["models"]) - 1 and fresh["cachedAt"] >= first["cachedAt"]


def test_writes_invalidate_host_cache(client):
    models = client.get("/api/hosts/qa-main/models").get_json()["models"]
    key = next(m["key"] for m in models if m["name"] == "Finance Ledger")
    client.post("/api/hosts/qa-main/models/undeploy", json={"models": [key]})
    after = {m["name"]: m["status"] for m in client.get("/api/hosts/qa-main/models").get_json()["models"]}
    assert after["Finance Ledger"] == "Linked"


def test_promote_other_branch_to_target(client):
    # Dev runs develop; promotion deploys the branch picked for the target.
    job = client.post("/api/promote/models", json={
        "sourceHostId": "qa-main", "targetHostId": "prod-east",
        "models": [{"name": "Internet Sales", "branch": "develop"}]}).get_json()
    result = wait(client, job)["result"]["results"][0]
    assert result["ok"] and result["branch"] == "develop"
    prod = {m["name"]: m for m in client.get("/api/hosts/prod-east/models").get_json()["models"]}
    assert prod["Internet Sales"]["branch"] == "develop"
    # develop is one ahead of the newest main (v14), so prod is now newer than qa
    rows = {r["name"]: r["diff"]["state"] for r in diff(client, "models", "qa-main", "prod-east")["rows"]}
    assert rows["Internet Sales"] == "older"


def test_branches_listed(client):
    r = client.get("/api/hosts/dev-east/branches?url=https://github.com/corp/atscale-sml-sales").get_json()
    names = [b["name"] for b in r["branches"]]
    assert "main" in names and "develop" in names


def test_undeploy_keeps_link(client):
    models = client.get("/api/hosts/qa-main/models").get_json()["models"]
    key = next(m["key"] for m in models if m["name"] == "Finance Ledger")
    r = client.post("/api/hosts/qa-main/models/undeploy", json={"models": [key]})
    assert r.status_code == 200
    after = {m["name"]: m for m in client.get("/api/hosts/qa-main/models").get_json()["models"]}
    assert after["Finance Ledger"]["status"] == "Linked"
    names = [m["name"] for m in client.get("/api/hosts/qa-main/aggregate-models").get_json()["models"]]
    assert "Finance Ledger" not in names


def test_promoted_aggregate_gets_the_target_connection(client):
    """Environments name their connections differently (demo: PG_DEV / PG_QA /
    PG_PROD): a promoted aggregate must carry the target's, not the source's."""
    from atscale import fake

    src, tgt, name = "qa-main", "prod-east", "agg_sales_by_product_cat"
    fake._inv(tgt)["aggs"] = [a for a in fake._inv(tgt)["aggs"] if a["id"] != name]  # not on the target yet
    rows = {r["name"]: r for r in diff(client, "aggs", src, tgt, "Internet Sales")["rows"]}
    new = rows[name]
    assert new["diff"]["state"] == "new"
    job = client.post("/api/promote/aggregates", json={
        "sourceHostId": src, "targetHostId": tgt, "aggregates": [new["id"]]}).get_json()
    result = wait(client, job)["result"]
    assert result["promoted"] == [name] and result["connections"] == {"PG_QA → PG_PROD": 1}
    stored = [a for a in fake._inv(tgt)["aggs"] if a["id"] == name]
    assert stored and stored[0]["connectionId"] == "PG_PROD"
