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
    assert body["groups"] == {"dev": ["dev-east", "dev-sandbox"], "test": ["test-main"], "qa": ["qa-main"],
                              "prod": ["prod-east", "prod-west"]}
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
    registry.store().update_git(registry.bu(), {"status": "failed"})
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


def _deploy_copy(host, name, copy_of="Internet Sales"):
    """The same SML deployed a second time under another model name."""
    from atscale import fake

    inv = fake._inv(host)
    row = next(m for m in inv["models"] if m["name"] == copy_of)
    inv["models"].append({**row, "key": f"{row['key']}-copy", "name": name, "modelId": name})


def test_aggregates_promoted_into_an_override_model(client):
    from atscale import fake

    src, tgt, name = "qa-main", "prod-east", "agg_sales_by_product_cat"
    _deploy_copy(tgt, "Internet Sales EU")
    # Default: matched by name - the copy is not considered.
    d = diff(client, "aggs", src, tgt, "Internet Sales")
    assert {r["name"]: r["diff"]["state"] for r in d["rows"]}[name] == "dup"

    body = {"section": "aggs", "sourceHostId": src, "targetHostId": tgt, "model": "Internet Sales",
            "modelMap": {"Internet Sales": "Internet Sales EU"}}
    d = client.post("/api/promote/diff", json=body).get_json()
    rows = {r["name"]: r for r in d["rows"]}
    assert rows[name]["diff"]["state"] == "new" and rows[name]["model"] == "Internet Sales"
    assert d["target"] == []

    job = client.post("/api/promote/aggregates", json={
        "sourceHostId": src, "targetHostId": tgt, "aggregates": [name],
        "modelMap": {"Internet Sales": "Internet Sales EU"}}).get_json()
    result = wait(client, job)["result"]
    assert result["promoted"] == [name], result
    stored = [a for a in fake._inv(tgt)["aggs"] if a["id"] == name and a["model"] == "Internet Sales EU"]
    assert stored and stored[0]["modelId"] == "Internet Sales EU"
    d = client.post("/api/promote/diff", json=body).get_json()
    assert {r["name"]: r["diff"]["state"] for r in d["rows"]}[name] == "dup"


def test_override_allows_the_same_host(client):
    _deploy_copy("qa-main", "Internet Sales EU")
    body = {"section": "aggs", "sourceHostId": "qa-main", "targetHostId": "qa-main", "model": "Internet Sales",
            "modelMap": {"Internet Sales": "Internet Sales EU"}}
    d = client.post("/api/promote/diff", json=body).get_json()
    assert not d.get("sameHost") and any(r["diff"]["state"] == "new" for r in d["rows"])
    r = client.post("/api/promote/aggregates", json={
        "sourceHostId": "qa-main", "targetHostId": "qa-main", "aggregates": ["x"]})
    assert r.status_code == 400  # no override -> still refused


def _unzip(resp):
    import io
    import zipfile

    assert resp.status_code == 200 and resp.mimetype == "application/zip", resp.get_data(as_text=True)
    z = zipfile.ZipFile(io.BytesIO(resp.data))
    root = z.namelist()[0].split("/")[0]
    return z, root, (lambda p: z.read(f"{root}/{p}").decode())


def _no_secrets(z, *hosts):
    for h in hosts:
        pw = (registry.store().get_host_raw(h).get("atscale") or {}).get("password")
        assert not pw or all(pw not in z.read(n).decode() for n in z.namelist())


def test_models_cli_script(client):
    import json

    import yaml

    r = client.post("/api/promote/models/script", json={
        "sourceHostId": "qa-main", "targetHostId": "prod-east",
        "models": [{"name": "Internet Sales", "branch": "develop", "replaceOld": True},
                   {"name": "Supply Chain", "mode": "link"}]})
    z, root, read = _unzip(r)
    assert root.startswith("promote-models-")
    assert {n.split("/", 1)[1] for n in z.namelist()} == {
        "connections.yaml", "run.sh", "run.ps1", "helpers.mjs", "promotion.json", "README.md"}
    assert z.getinfo(f"{root}/run.sh").external_attr >> 16 == 0o755
    conn = yaml.safe_load(read("connections.yaml"))
    assert len(conn["connections"]) == 1  # the target only
    (name, entry), = conn["connections"].items()
    assert entry["atscale"]["url"].startswith("https://") and entry["atscale"]["user"] == f"u_{name}"
    assert all(u["password"] == "<fill in>" for u in conn["users"].values())
    _no_secrets(z, "qa-main", "prod-east")

    plan = json.loads(read("promotion.json"))
    steps = {s["models"][0]: s for s in plan["steps"]}
    assert steps["Internet Sales"]["mode"] == "deploy" and steps["Internet Sales"]["branch"] == "develop"
    assert steps["Supply Chain"]["mode"] == "link"
    run = read("run.sh")
    assert "step deploy 1 'https://" in run and "'develop' 'Internet Sales'" in run
    assert "atscale-deploy-catalog" in run and "step link 2" in run
    # prod-east runs Internet Sales on main: undeploying it has no CLI operation -> README
    assert plan["notApplied"]["undeployOldBranch"] and "Undeploy" in read("README.md")


def test_aggregates_cli_script(client):
    import json

    src, tgt, name = "qa-main", "prod-east", "agg_sales_by_product_cat"
    rows = {r["name"]: r for r in diff(client, "aggs", src, tgt, "Internet Sales")["rows"]}
    r = client.post("/api/promote/aggregates/script", json={
        "sourceHostId": src, "targetHostId": tgt, "aggregates": [rows[name]["id"]]})
    z, root, read = _unzip(r)
    assert root.startswith("promote-aggregates-")
    import yaml

    assert len(yaml.safe_load(read("connections.yaml"))["connections"]) == 2
    _no_secrets(z, src, tgt)
    plan = json.loads(read("promotion.json"))
    (m,) = plan["models"]
    assert m["source"]["name"] == m["target"]["name"] == "Internet Sales"
    assert m["source"]["catalogId"] and m["target"]["modelId"]
    assert [a["id"] for a in m["aggregates"]] == [rows[name]["id"]]
    run = read("run.sh")
    assert "atscale-export-aggregates" in run and "atscale-import-aggregates" in run
    assert f"step 'Internet Sales' '{m['source']['catalogId']}'" in run


def test_aggregates_cli_script_override_and_errors(client):
    import json

    _deploy_copy("qa-main", "Internet Sales EU")
    body = {"sourceHostId": "qa-main", "targetHostId": "qa-main", "aggregates": ["agg_sales_by_product_cat"],
            "modelMap": {"Internet Sales": "Internet Sales EU"}}
    z, _, read = _unzip(client.post("/api/promote/aggregates/script", json=body))
    import yaml

    assert len(yaml.safe_load(read("connections.yaml"))["connections"]) == 1  # one host, both sides
    assert json.loads(read("promotion.json"))["models"][0]["target"]["name"] == "Internet Sales EU"
    assert "Target-model override" in read("README.md")

    assert client.post("/api/promote/aggregates/script", json={**body, "aggregates": []}).status_code == 400
    assert client.post("/api/promote/aggregates/script", json={**body, "aggregates": ["nope"]}).status_code == 400
    assert client.post("/api/promote/models/script", json={
        "sourceHostId": "qa-main", "targetHostId": "fin-dev", "models": ["Internet Sales"]}).status_code == 404
