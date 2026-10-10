"""Pipeline: stages per business unit, the §5 gate table, verdicts scored at
read time, API tokens + scopes, and the steps end to end on the demo backend
(PIPELINE_BUILD.md §9)."""

import threading
import time

import pytest

from envs import registry
from pipeline import stages

POLICY = {"requireTest": True, "approval": True, "intendedOnly": True, "variance": 2.0}


@pytest.fixture
def client(tmp_path, monkeypatch):
    from app import create_app
    from envs.store import Store
    from pipeline import store as pstore
    from testing import store as tstore
    import cache

    monkeypatch.setattr(registry, "FAKE", True)
    cache.set_dir(tmp_path / "cache")
    s = Store(tmp_path / "connections.yaml")
    registry.set_store(s)
    registry.seed_fake(s)
    tstore.set_path(tmp_path / "tests.db")
    pstore.set_path(tmp_path / "pipeline.db")
    yield create_app().test_client()
    registry.set_store(None)


H = {"X-BU": "sales-analytics"}


def wait(client, job_id, headers=H):
    for _ in range(200):
        j = client.get(f"/api/pipeline/jobs/{job_id}", headers=headers).get_json()
        if j["status"] != "running":
            return j
        time.sleep(0.05)
    raise AssertionError("job timed out")


def model(board, name):
    return next(m for m in board["models"] if m["name"] == name)


# -- stages + gates (pure) ----------------------------------------------------------------------

def test_stages_follow_the_groups_with_hosts():
    full = stages.stages([{"id": e, "env": e} for e in ("prod", "dev", "qa", "test")])
    assert [(s["env"], s["role"]) for s in full] == [("dev", "pr"), ("test", "main"), ("qa", "promote"), ("prod", "release")]
    assert [g["kind"] for g in stages.gate_kinds(full)] == ["merge", "promote", "promote"]
    assert [g["final"] for g in stages.gate_kinds(full)] == [False, False, True]
    two = stages.stages([{"id": "a", "env": "dev"}, {"id": "b", "env": "prod"}])
    assert [s["trigger"] for s in two] == ["PR · main", "approved"]
    assert [g["kind"] for g in stages.gate_kinds(two)] == ["promote"]


def _c(env, n):
    row = {"commit": f"v{n}", "version": f"v{n}"}
    return {"env": env, "row": row, "commit": row["commit"]}


def _cmp(a, b):
    x, y = int(a["commit"][1:]), int(b["commit"][1:])
    return "identical" if x == y else "ahead" if x > y else "behind"


def test_merge_gate_table():
    assert stages.merge_gate(None, _c("qa", 3), _cmp)["k"] == "blank"
    g = stages.merge_gate(_c("dev", 4), None, _cmp)
    assert g["label"] == "Merge to main" and g["sub"] == "— → v4"
    g = stages.merge_gate(_c("dev", 4), _c("qa", 3), _cmp)
    assert g["label"] == "Merge to main" and g["sub"] == "v3 → v4"
    assert stages.merge_gate(_c("dev", 4), _c("qa", 4), _cmp)["label"] == "In sync"


@pytest.mark.parametrize("src,tgt,verdict,policy,final,k,label", [
    (None, 3, "pass", POLICY, True, "na", ""),
    (4, 4, "none", POLICY, True, "sync", "In sync"),
    (4, 5, "none", POLICY, True, "sync", "Prod ahead"),
    (4, 3, "running", POLICY, True, "wait", "Testing…"),
    (4, 3, "none", POLICY, True, "block", "Blocked · no test"),
    (4, 3, "fail", POLICY, True, "block", "Blocked · test failed"),
    (4, 3, "pass", POLICY, True, "open", "Awaiting approval"),
    (4, 3, "pass", {**POLICY, "approval": False}, True, "open", "Gate open"),
    (4, 3, "pass", POLICY, False, "open", "Gate open"),            # approval is the final gate's only
    (4, 3, "none", {**POLICY, "requireTest": False}, True, "open", "Awaiting approval"),
    (4, None, "pass", POLICY, True, "open", "Awaiting approval"),  # target missing
])
def test_promote_gate_table(src, tgt, verdict, policy, final, k, label):
    g = stages.promote_gate(_c("qa", src) if src else None, _c("prod", tgt) if tgt else None, _cmp, verdict, policy, final)
    assert (g["k"], g["label"]) == (k, label)


def test_verdict_is_scored_against_the_current_policy():
    result = {"status": "done", "rows": [{"verdict": "identical"}, {"verdict": "differs", "pct": 1.5}],
              "model": {"intended": 1, "unintended": 0}}
    s = stages.summarize(result, POLICY)
    assert s["verdict"] == "pass" and s["matched"] == 2 and s["maxVariance"] == 1.5
    assert stages.summarize(result, {**POLICY, "variance": 1.0})["verdict"] == "fail"
    unintended = {**result, "model": {"unintended": 2}}
    assert stages.summarize(unintended, POLICY)["verdict"] == "fail"
    assert stages.summarize(unintended, {**POLICY, "intendedOnly": False})["verdict"] == "pass"
    # Rows only one side has, or non-numeric diffs, fail at any threshold; a new query doesn't.
    assert stages.summarize({**result, "rows": [{"verdict": "differs", "pct": None}]}, {**POLICY, "variance": 99})["verdict"] == "fail"
    assert stages.summarize({**result, "rows": [{"verdict": "identical"}, {"verdict": "new"}]}, POLICY)["verdict"] == "pass"
    assert stages.summarize({**result, "rows": [{"verdict": "failedCandidate"}]}, POLICY)["verdict"] == "fail"
    assert stages.summarize(None, POLICY)["verdict"] == "none"
    assert stages.summarize({"status": "running"}, POLICY)["verdict"] == "running"


# -- board ----------------------------------------------------------------------------------

def test_board_stages_drift_and_seeded_verdicts(client):
    b = client.get("/api/pipeline/board", headers=H).get_json()
    assert [s["env"] for s in b["stages"]] == ["dev", "test", "qa", "prod"]
    sc = model(b, "Supply Chain")
    # prod-west runs Supply Chain with an error: primary is prod-east, the error is surfaced.
    assert sc["cells"][3]["hostId"] == "prod-east" and sc["cells"][3]["error"] == "prod-west"
    fl = model(b, "Finance Ledger")
    assert fl["cells"][3]["drift"] == ["prod-west not deployed"]
    rs = model(b, "Reseller Sales")
    assert rs["cells"][2]["test"]["verdict"] == "fail" and rs["gates"][2]["label"] == "Blocked · test failed"
    assert model(b, "Internet Sales")["gates"][2]["label"] == "Blocked · same catalog"  # Reseller Sales failed on QA
    # Finance has only Dev and Prod: one gate.
    f = client.get("/api/pipeline/board", headers={"X-BU": "finance"}).get_json()
    assert [s["env"] for s in f["stages"]] == ["dev", "prod"] and len(model(f, "Finance Ledger")["gates"]) == 1


def test_policy_change_rescores_a_test(client):
    rs = model(client.get("/api/pipeline/board", headers=H).get_json(), "Reseller Sales")
    assert rs["cells"][2]["test"]["verdict"] == "fail" and rs["gates"][2]["label"] == "Blocked · test failed"
    r = client.put("/api/pipeline/policy", json={"policy": {"variance": 5}}, headers=H)
    assert r.status_code == 200 and r.get_json()["policy"]["variance"] == 5
    rs = model(client.get("/api/pipeline/board", headers=H).get_json(), "Reseller Sales")
    # Its own test passes now; Customer 360, from the same repo, still has no test on QA.
    assert rs["cells"][2]["test"]["verdict"] == "pass"
    assert rs["gates"][2]["why"] == ["Customer 360: Blocked · no test"]
    assert client.put("/api/pipeline/policy", json={"orchestrator": "teamcity"}, headers=H).status_code == 400


# -- tokens ---------------------------------------------------------------------------------

def test_tokens_hashed_shown_once_and_scoped(client):
    r = client.post("/api/pipeline/tokens", json={"name": "gha", "scope": ["test"]}, headers=H)
    assert r.status_code == 201
    plain = r.get_json()["token"]
    assert plain.startswith("emt_")
    listed = client.get("/api/pipeline/tokens", headers=H).get_json()["tokens"]
    assert listed[0]["name"] == "gha" and "token" not in listed[0] and "hash" not in listed[0]
    raw = registry.store().get_pipeline_raw("sales-analytics")["tokens"][0]
    assert plain not in str(raw) and len(raw["hash"]) == 64

    auth = {"Authorization": f"Bearer {plain}"}
    # The token picks its BU, whatever X-BU says; scope 'test' can't deploy or mint tokens.
    assert client.get("/api/pipeline/board", headers={**auth, "X-BU": "finance"}).get_json()["stages"][0]["hosts"][0]["id"] == "dev-east"
    assert client.post("/api/pipeline/deploy", json={"env": "qa"}, headers=auth).status_code == 403
    assert client.post("/api/pipeline/tokens", json={"name": "x", "scope": ["deploy"]}, headers=auth).status_code == 403
    assert client.get("/api/pipeline/board", headers={"Authorization": "Bearer emt_nope"}).status_code == 401
    # Not loopback and no token -> 401; the CLI file stays public.
    remote = {"REMOTE_ADDR": "10.1.2.3"}
    assert client.get("/api/pipeline/board", environ_base=remote).status_code == 401
    assert client.get("/api/pipeline/board", headers=auth, environ_base=remote).status_code == 200
    assert client.get("/api/pipeline/cli", environ_base=remote).status_code == 200
    # Through a local proxy the forwarded address decides, and only a proxy's header is believed.
    assert client.get("/api/pipeline/board", headers={"X-Forwarded-For": "10.1.2.3"}).status_code == 401
    assert client.get("/api/pipeline/board", headers={"X-Forwarded-For": "127.0.0.1"}).status_code == 200
    assert client.get("/api/pipeline/board", headers={"X-Forwarded-For": "127.0.0.1"}, environ_base=remote).status_code == 401

    tid = listed[0]["id"]
    assert client.delete(f"/api/pipeline/tokens/{tid}", headers=H).status_code == 200
    assert client.get("/api/pipeline/board", headers=auth).status_code == 401


# -- steps ----------------------------------------------------------------------------------

def test_test_step_opens_the_gate_then_promote_deploys(client):
    b = client.get("/api/pipeline/board", headers=H).get_json()
    assert model(b, "Customer 360")["gates"][2]["label"] == "Blocked · no test"
    # 409 while closed - checked server-side.
    r = client.post("/api/pipeline/promote", json={"model": "Customer 360", "env": "prod"}, headers=H)
    assert r.status_code == 409
    r = client.post("/api/pipeline/test", json={"env": "qa", "model": "Customer 360"}, headers=H)
    assert r.status_code == 202
    # The job records the test as running as soon as it starts: the gate shows "Testing…".
    for _ in range(40):
        gate = model(client.get("/api/pipeline/board", headers=H).get_json(), "Customer 360")["gates"][2]
        if gate["k"] == "wait":
            break
        time.sleep(0.025)
    assert gate["label"] == "Testing…"
    j = wait(client, r.get_json()["jobId"])
    assert j["verdict"] == "pass", j
    xml = client.get(f"/api/pipeline/jobs/{r.get_json()['jobId']}/junit", headers=H).data.decode()
    import xml.etree.ElementTree as ET

    suite = ET.fromstring(xml).find("testsuite")
    assert suite.get("failures") == "0" and int(suite.get("tests")) == 25
    # Its own test passed; Reseller Sales (same repo) failed on QA, so the catalog stays put.
    gate = model(client.get("/api/pipeline/board", headers=H).get_json(), "Customer 360")["gates"][2]
    assert gate["label"] == "Blocked · same catalog" and gate["why"] == ["Reseller Sales: Blocked · test failed"]
    assert client.post("/api/pipeline/promote", json={"model": "Customer 360", "env": "prod"}, headers=H).status_code == 409
    client.put("/api/pipeline/policy", json={"policy": {"variance": 5}}, headers=H)
    assert model(client.get("/api/pipeline/board", headers=H).get_json(), "Customer 360")["gates"][2]["k"] == "open"
    # Open, but QA's v10 isn't main's head (v12) any more: refused before anything deploys.
    r = client.post("/api/pipeline/promote", json={"model": "Customer 360", "env": "prod"}, headers=H)
    assert r.status_code == 409 and "Customer 360: QA runs v10, not v12" in r.get_json()["error"]
    assert client.get("/api/pipeline/runs", headers=H).get_json()["runs"][0]["kind"] == "test"


def test_a_catalog_crosses_a_gate_together(client):
    """Supply Chain v4 passed on QA, but its repo also holds Inventory Snapshot,
    which never reached QA: deploying the catalog would take it to Prod untested."""
    sc = model(client.get("/api/pipeline/board", headers=H).get_json(), "Supply Chain")
    assert sc["gates"][2]["label"] == "Blocked · same catalog" and sc["gates"][2]["why"] == ["Inventory Snapshot isn't on QA"]
    assert client.post("/api/pipeline/promote", json={"model": "Supply Chain", "env": "prod"}, headers=H).status_code == 409
    r = client.post("/api/pipeline/deploy", json={"env": "prod", "branch": "main", "commit": "v4", "model": "Supply Chain"}, headers=H)
    j = wait(client, r.get_json()["jobId"])
    assert j["verdict"] == "fail" and "Inventory Snapshot: not on QA" in j["summary"]


def test_two_stage_pipeline_promotes_to_prod(client):
    """Finance has only Dev and Prod: Finance Ledger v6 passed on Dev (seeded) and is main's head."""
    fh = {"X-BU": "finance"}
    fl = model(client.get("/api/pipeline/board", headers=fh).get_json(), "Finance Ledger")
    assert fl["gates"][0]["label"] == "Awaiting approval"
    r = client.post("/api/pipeline/promote", json={"model": "Finance Ledger", "env": "prod"}, headers=fh)
    j = wait(client, r.get_json()["jobId"], fh)
    assert j["verdict"] == "pass", j
    fl = model(client.get("/api/pipeline/board", headers=fh).get_json(), "Finance Ledger")
    assert fl["cells"][1]["version"] == "v6" and fl["gates"][0]["label"] == "In sync"


def test_deploy_refuses_a_moved_branch_and_a_closed_gate(client):
    # main's head is v15 in the demo: v13 can't be deployed (AtScale deploys a branch head).
    r = client.post("/api/pipeline/deploy", json={"env": "test", "branch": "main", "commit": "v13", "model": "Internet Sales"}, headers=H)
    j = wait(client, r.get_json()["jobId"])
    assert j["verdict"] == "fail" and "has moved" in j["summary"]
    # QA sits behind a promotion gate: Test runs v14, so v15 was never tested there.
    r = client.post("/api/pipeline/deploy", json={"env": "qa", "branch": "main", "commit": "v15", "model": "Internet Sales"}, headers=H)
    j = wait(client, r.get_json()["jobId"])
    assert j["verdict"] == "fail" and "Blocked at the gate into QA" in j["summary"] and "deploy and test it there first" in j["summary"]
    r = client.post("/api/pipeline/deploy", json={"env": "qa", "branch": "main", "commit": "v15", "model": "Internet Sales",
                                                   "force": True}, headers=H)
    assert wait(client, r.get_json()["jobId"])["verdict"] == "pass"
    assert client.post("/api/pipeline/deploy", json={"env": "staging"}, headers=H).status_code == 400


def test_rollback_and_promote_aggs(client):
    r = client.post("/api/pipeline/rollback", json={"env": "prod", "model": "Internet Sales"}, headers=H)
    j = wait(client, r.get_json()["jobId"])
    assert j["verdict"] == "pass" and "v12 → v11" in j["summary"]
    cell = model(client.get("/api/pipeline/board", headers=H).get_json(), "Internet Sales")["cells"][3]
    assert cell["version"] == "v11" and cell["drift"] == []

    from atscale import fake

    fake._inv("prod-east")["aggs"] = [a for a in fake._inv("prod-east")["aggs"] if a["id"] != "agg_sales_by_product_cat"]
    r = client.post("/api/pipeline/promote-aggs", json={"from": "qa", "to": "prod", "model": "Internet Sales"}, headers=H)
    j = wait(client, r.get_json()["jobId"])
    assert j["verdict"] == "pass"
    east = next(h for h in j["result"]["hosts"] if h["hostId"] == "prod-east")
    assert east["promoted"] == ["agg_sales_by_product_cat"]


def test_setup_templates_follow_the_stages(client):
    s = client.get("/api/pipeline/setup", headers=H).get_json()
    gha = s["templates"]["gha"]
    assert "deploy-test:" in gha and "promote-qa:" in gha and "promote-prod:" in gha and "environment: production" in gha
    assert "envmgr promote-aggs --from qa --to prod" in gha
    assert "stage('Promote to Prod')" in s["templates"]["jenkins"] and "input {" in s["templates"]["jenkins"]
    ids = {i["hostId"]: i["serviceAccount"] for i in s["identities"]}
    assert ids["dev-east"] is True
    f = client.get("/api/pipeline/setup", headers={"X-BU": "finance"}).get_json()
    assert "deploy-dev:" in f["templates"]["gha"] and "promote-prod:" in f["templates"]["gha"] and "promote-qa" not in f["templates"]["gha"]
    import yaml

    assert set(yaml.safe_load(gha)["jobs"]) == {"validate", "test-dev", "deploy-test", "promote-qa", "promote-prod"}


# -- the envmgr CLI against a live server ------------------------------------------------------

@pytest.fixture
def live(client, tmp_path):
    from werkzeug.serving import make_server

    from app import create_app

    srv = make_server("127.0.0.1", 0, create_app(), threaded=True)
    t = threading.Thread(target=srv.serve_forever, daemon=True)
    t.start()
    yield f"http://127.0.0.1:{srv.server_port}"
    srv.shutdown()


def _cli(monkeypatch, url, token, *argv):
    import importlib.util
    from pathlib import Path

    spec = importlib.util.spec_from_file_location("envmgr", Path(__file__).resolve().parents[2] / "cli" / "envmgr.py")
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    monkeypatch.setenv("ENVMGR_URL", url)
    monkeypatch.setenv("ENVMGR_TOKEN", token)
    monkeypatch.setenv("ENVMGR_POLL_S", "0.05")
    for k in ("GITHUB_ACTIONS", "JENKINS_URL"):
        monkeypatch.delenv(k, raising=False)
    return mod.main(list(argv))


def test_cli_exit_codes(client, live, monkeypatch, tmp_path):
    tok = client.post("/api/pipeline/tokens", json={"name": "ci", "scope": ["deploy", "test", "promote"]},
                      headers=H).get_json()["token"]
    junit = tmp_path / "results.xml"
    assert _cli(monkeypatch, live, tok, "test", "--env", "test", "--model", "Customer 360", "--junit", str(junit)) == 0
    assert junit.read_text().startswith("<?xml")
    # A variance breach fails (seeded Reseller Sales v9 on QA: 4.2% > 2%).
    assert _cli(monkeypatch, live, tok, "test", "--env", "qa", "--model", "Reseller Sales") == 1
    # A closed gate is a fail; a bad token is an error.
    assert _cli(monkeypatch, live, tok, "promote", "--env", "prod", "--model", "Reseller Sales") == 1
    assert _cli(monkeypatch, live, "emt_wrong", "status") == 2
    assert _cli(monkeypatch, live, tok, "status") == 0


# -- picking hosts + branch, and the per-action script ------------------------------------------

def test_rollback_one_host_leaves_drift(client):
    r = client.post("/api/pipeline/rollback", json={"env": "prod", "model": "Internet Sales", "hosts": ["prod-east"]}, headers=H)
    j = wait(client, r.get_json()["jobId"])
    assert j["verdict"] == "pass" and [h["hostId"] for h in j["result"]["hosts"]] == ["prod-east"]
    cell = model(client.get("/api/pipeline/board", headers=H).get_json(), "Internet Sales")["cells"][3]
    assert cell["version"] == "v11" and cell["drift"] == ["prod-west v12"]
    bad = client.post("/api/pipeline/rollback", json={"env": "prod", "model": "Internet Sales", "hosts": ["qa-main"]}, headers=H)
    assert bad.status_code == 400 and "Not a Prod host" in bad.get_json()["error"]
    assert client.post("/api/pipeline/deploy", json={"env": "prod", "hosts": []}, headers=H).status_code == 400


def test_promote_to_picked_hosts_and_branch_rule(client):
    fh = {"X-BU": "finance"}
    client.get("/api/pipeline/board", headers=fh)  # the demo's test history is seeded on first view
    # Any branch can be promoted - but develop's head (v7) never ran on Dev, so the gate holds it.
    r = client.post("/api/pipeline/promote", json={"model": "Finance Ledger", "env": "prod", "branch": "develop"}, headers=fh)
    assert r.status_code == 409 and "Dev runs v6, not v7" in r.get_json()["error"]
    r = client.post("/api/pipeline/promote", json={"model": "Finance Ledger", "env": "prod", "hosts": ["fin-prod"]}, headers=fh)
    j = wait(client, r.get_json()["jobId"], fh)
    assert j["verdict"] == "pass" and [h["hostId"] for h in j["result"]["hosts"]] == ["fin-prod"]


def test_test_on_a_picked_host(client):
    r = client.post("/api/pipeline/test", json={"env": "prod", "model": "Internet Sales", "host": "prod-west"}, headers=H)
    j = wait(client, r.get_json()["jobId"])
    assert j["result"]["models"][0]["result"]["candidate"]["hostId"] == "prod-west"


def _unzip(resp):
    import io
    import zipfile

    assert resp.status_code == 200 and resp.mimetype == "application/zip", resp.get_data(as_text=True)
    z = zipfile.ZipFile(io.BytesIO(resp.data))
    root = z.namelist()[0].split("/")[0]
    return root, {n.split("/", 1)[1]: z.read(n).decode() for n in z.namelist()}, z


def test_action_script_is_a_ps_utils_package(client):
    """No Env Manager URL in it: run.sh deploys with the ps-utils CLI."""
    body = {"action": "promote", "env": "qa", "model": "Customer 360", "hosts": ["qa-main"]}
    s = client.post("/api/pipeline/script", json=body, headers=H).get_json()
    assert s["folder"] == "promote-qa-customer-360" and s["filename"] == "promote-qa-customer-360.zip"
    root, files, z = _unzip(client.post("/api/pipeline/script/zip", json=body, headers=H))
    assert root == "promote-qa-customer-360" and z.getinfo(f"{root}/run.sh").external_attr >> 16 == 0o755
    sh = files["run.sh"]
    assert "atscale-deploy-catalog" in sh and "TARGETS=('qa-main')" in sh and 'BRANCH="main"' in sh
    assert "localhost" not in sh and "ENVMGR_URL" in sh  # only the opt-in report back
    assert 'SOURCE=""' in sh  # QA isn't the last stage: no aggregates step
    assert all(u["password"] == "<fill in>" for u in __import__("yaml").safe_load(files["connections.yaml"])["users"].values())
    _no_pw = [h for h in ("qa-main",) if (registry.store().get_host_raw(h)["atscale"].get("password") or "x") in "".join(files.values())]
    assert not _no_pw
    jobs = __import__("yaml").safe_load("jobs:\n" + s["gha"].split("\n", 2)[2])["jobs"]
    run = jobs["promote-qa-customer-360"]["steps"][2]["run"]
    assert "./atscale/promote-qa-customer-360/run.sh" in run and "environment" not in jobs["promote-qa-customer-360"]
    assert "withCredentials" in s["jenkins"] and "./atscale/promote-qa-customer-360/run.sh" in s["jenkins"]


def test_deploy_into_the_last_stage_moves_aggregates(client):
    fh = {"X-BU": "finance"}
    s = client.post("/api/pipeline/script", json={"action": "promote", "env": "prod", "model": "Finance Ledger"}, headers=fh).get_json()
    assert 'SOURCE="fin-dev"' in s["sh"] and "atscale-import-aggregates" in s["sh"]
    assert '--catalog-id "finance_catalog" --model-id "Finance Ledger"' in s["sh"]
    assert "environment: production" in s["gha"] and "input {" in s["jenkins"]


def test_rollback_script_deploys_the_previous_commit(client, monkeypatch):
    from atscale.fake import FakeBackend

    monkeypatch.setattr(FakeBackend, "previous_commit", lambda self, row: {"commit": "a1b2c3d4e5f6a7b8", "branch": "main"})
    s = client.post("/api/pipeline/script", json={"action": "rollback", "env": "prod", "model": "Internet Sales",
                                                  "hosts": ["prod-east"]}, headers=H).get_json()
    assert 'COMMIT="${COMMIT:-a1b2c3d4e5f6a7b8}"' in s["sh"] and "EXACT=1" in s["sh"] and "TARGETS=('prod-east')" in s["sh"]
    # Demo commits aren't SHAs: a script can't fetch them - said, not guessed.
    monkeypatch.setattr(FakeBackend, "previous_commit", lambda self, row: {"commit": "v11", "branch": "main"})
    r = client.post("/api/pipeline/script", json={"action": "rollback", "env": "prod", "model": "Internet Sales"}, headers=H)
    assert r.status_code == 400 and "isn't a Git SHA" in r.get_json()["error"]


def test_test_script_is_validates_package(client, monkeypatch):
    from pipeline import steps
    from testing.generate import build_queries, model_entries
    from tests.test_testing import META

    monkeypatch.setattr(steps, "_queries", lambda host_id, row: (
        {"hostId": host_id, "label": host_id, "env": None, "catalog": "cat", "cube": "cube1"},
        build_queries(*model_entries(META), "cube1")))
    root, files, _ = _unzip(client.post("/api/pipeline/script/zip", json={"action": "test", "env": "qa", "model": "Supply Chain"}, headers=H))
    assert root == "test-qa-supply-chain" and "execute-atscale-query-harness" in files["run.sh"]
    assert {"compare.mjs", "tasks/prod-east.yaml", "tasks/qa-main.yaml"} <= set(files)


def test_action_script_errors(client):
    assert client.post("/api/pipeline/script", json={"action": "nuke", "env": "qa", "model": "x"}, headers=H).status_code == 400
    assert client.post("/api/pipeline/script", json={"action": "promote", "env": "qa", "model": "Customer 360",
                                                     "hosts": ["prod-east"]}, headers=H).status_code == 400
    assert client.post("/api/pipeline/script", json={"action": "promote", "env": "dev", "model": "Customer 360"},
                       headers=H).status_code == 400


# -- errors are kept ------------------------------------------------------------------------

def test_a_crashing_step_keeps_its_error(client, monkeypatch):
    from atscale.fake import FakeBackend

    def boom(self, *a, **kw):
        raise RuntimeError("401: Keycloak said the password is wrong")
    monkeypatch.setattr(FakeBackend, "deploy_branch", boom)
    r = client.post("/api/pipeline/deploy", json={"env": "test", "branch": "main", "model": "Internet Sales"}, headers=H)
    j = wait(client, r.get_json()["jobId"])
    assert j["verdict"] == "error" and "password is wrong" in j["summary"]
    run = client.get("/api/pipeline/runs", headers=H).get_json()["runs"][0]
    assert run["kind"] == "deploy" and run["status"] == "failed" and run["verdict"] == "error"
    assert "RuntimeError: 401: Keycloak said the password is wrong" in run["error"]
    detail = client.get(f"/api/pipeline/runs/{run['id']}", headers=H).get_json()
    assert detail["error"] == run["error"]


def test_a_step_failing_before_it_starts_is_still_recorded(client, monkeypatch):
    from pipeline import steps

    monkeypatch.setattr(steps, "load", lambda refresh=False: (_ for _ in ()).throw(ConnectionError("qa-main unreachable")))
    r = client.post("/api/pipeline/rollback", json={"env": "prod", "model": "Internet Sales"}, headers=H)
    assert wait(client, r.get_json()["jobId"])["verdict"] == "error"
    run = client.get("/api/pipeline/runs", headers=H).get_json()["runs"][0]
    assert (run["kind"], run["env"], run["model"], run["status"]) == ("rollback", "prod", "Internet Sales", "failed")
    assert run["error"] == "ConnectionError: qa-main unreachable"


def test_summary_and_reported_errors_are_stored(client):
    r = client.post("/api/pipeline/deploy", json={"env": "test", "branch": "main", "commit": "v13", "model": "Internet Sales"}, headers=H)
    wait(client, r.get_json()["jobId"])
    run = client.get("/api/pipeline/runs", headers=H).get_json()["runs"][0]
    assert "has moved" in run["summary"] and "has moved" in run["error"]
    client.post("/api/pipeline/runs", headers=H, json={"stage": "Deploy · QA (ps-utils)", "verdict": "fail",
                                                        "error": "atscale-deploy-catalog: 500 boom", "env": "qa"})
    rep = client.get("/api/pipeline/runs", headers=H).get_json()["runs"][0]
    assert rep["kind"] == "report" and rep["error"] == "atscale-deploy-catalog: 500 boom"


def test_any_branch_promotes_once_it_passed_the_stage_before(client):
    """Pick a branch other than main for a promotion: check -> deploy + test it
    on the stage before -> check passes -> promote deploys that branch's head."""
    fh = {"X-BU": "finance"}
    client.get("/api/pipeline/board", headers=fh)
    c = client.post("/api/pipeline/check", json={"model": "Finance Ledger", "env": "prod", "branch": "develop"}, headers=fh).get_json()
    assert c["kind"] == "promote" and c["head"] == "v7" and c["problems"] == ["Finance Ledger: Dev runs v6, not v7 - deploy and test it there first"]
    assert client.post("/api/pipeline/check", json={"model": "Finance Ledger", "env": "prod", "branch": "main"}, headers=fh).get_json()["problems"] == []

    r = client.post("/api/pipeline/deploy", json={"env": "dev", "branch": "develop", "model": "Finance Ledger"}, headers=fh)
    assert wait(client, r.get_json()["jobId"], fh)["verdict"] == "pass"
    # The whole catalog went to Dev: Marketing Attribution (same repo) needs its test too.
    c = client.post("/api/pipeline/check", json={"model": "Finance Ledger", "env": "prod", "branch": "develop"}, headers=fh).get_json()
    assert c["problems"] == ["Finance Ledger: no test for v7 on Dev", "Marketing Attribution: no test for v4 on Dev"]
    for m in ("Finance Ledger", "Marketing Attribution"):
        r = client.post("/api/pipeline/test", json={"env": "dev", "model": m}, headers=fh)
        assert wait(client, r.get_json()["jobId"], fh)["verdict"] == "pass"
    c = client.post("/api/pipeline/check", json={"model": "Finance Ledger", "env": "prod", "branch": "develop"}, headers=fh).get_json()
    assert c["problems"] == [] and c["tested"]

    r = client.post("/api/pipeline/promote", json={"model": "Finance Ledger", "env": "prod", "branch": "develop"}, headers=fh)
    j = wait(client, r.get_json()["jobId"], fh)
    assert j["verdict"] == "pass" and j["result"]["branch"] == "develop", j
    prod = model(client.get("/api/pipeline/board", headers=fh).get_json(), "Finance Ledger")["cells"][1]
    assert prod["version"] == "v7" and prod["branch"] == "develop"


def test_merge_gate_takes_any_branch(client):
    c = client.post("/api/pipeline/check", json={"model": "Inventory Snapshot", "env": "test", "branch": "release"}, headers=H).get_json()
    assert c["kind"] == "merge" and c["problems"] == []
    s = client.post("/api/pipeline/script", json={"action": "promote", "env": "test", "model": "Inventory Snapshot",
                                                  "branch": "release"}, headers=H).get_json()
    assert 'BRANCH="release"' in s["sh"]
