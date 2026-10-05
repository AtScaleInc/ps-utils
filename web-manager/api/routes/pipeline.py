"""Pipeline: the business unit's deployment pipeline (pipeline/__init__.py).

  GET    /pipeline/board               ?refresh=1 - stages, per model a cell per stage + gates
  GET    /pipeline/runs                ?model= - recent pipeline runs, verdicts scored now
  GET    /pipeline/runs/<id>           one run in full (summary, error, per-host / per-query result)
  POST   /pipeline/runs                CI reports a run {stage, model, commit, env, verdict, error?, summary?, ...}
  GET    /pipeline/setup               ?origin= - orchestrator, policy, stages, deploy identities, templates
                                       (CI's URL: ENV_MANAGER_PUBLIC_URL, else origin, else this API's)
  PUT    /pipeline/policy              {orchestrator?, policy?: {...}, serviceAccountPattern?}
  GET    /pipeline/tokens              API tokens (never the secret)
  POST   /pipeline/tokens              {name, scope[]} -> {token}: the plaintext, shown once
  DELETE /pipeline/tokens/<id>         revoke

  POST   /pipeline/validate            {files: {path: content}}                       scope test
  POST   /pipeline/deploy              {env, branch, commit?, repo?, model?, force?, hosts?}  scope deploy
  POST   /pipeline/test                {env, model?, repo?, commit?, baseline?, host?}  scope test
  POST   /pipeline/promote-aggs        {from, to, model?, includeReplacements?}       scope promote
  POST   /pipeline/rollback            {env, model, hosts?}                           scope deploy
  POST   /pipeline/promote             {model, env, hosts?, branch?} - built-in gate; 409 if closed  scope promote
  POST   /pipeline/script              {action: promote|rollback|test, env, model, hosts?, branch?} -> the
                                       action as a ps-utils package: run.sh + a GitHub Actions job / Jenkins
                                       stage that runs it (/pipeline/script/zip: the package)
         each -> 202 {jobId}; every body may carry ci: {orchestrator, runRef, url, stage, sha, pr}
  GET    /pipeline/jobs/<id>           {status: running|done, verdict: pass|fail|error, summary, result}
  GET    /pipeline/jobs/<id>/junit     JUnit XML
  GET    /pipeline/cli                 the envmgr CLI (cli/envmgr.py), no token needed

Auth (app.py :: pipeline_auth): a bearer token (`emt_...`) binds the request to
its business unit and its scopes. Without one, only loopback callers (the
local UI) get through, unless ENV_MANAGER_PIPELINE_OPEN says otherwise.
Tokens and policy can only be changed without a token - a CI token can't mint
another.
"""

from __future__ import annotations

import os
import re
import threading
from functools import wraps
from pathlib import Path
from typing import Any

from flask import Blueprint, Response, g, jsonify, request

import cache
import jobs
from envs import registry
from pipeline import config, junit, script_bundle, stages, steps, templates
from pipeline import store as pstore
from routes.objects import host_errors

pipeline_bp = Blueprint("pipeline", __name__)

pstore.set_path(Path(os.environ["ENV_MANAGER_PIPELINE_DB"]) if os.environ.get("ENV_MANAGER_PIPELINE_DB")
                else cache.WORKSPACE / ("pipeline-demo.db" if registry.FAKE else "pipeline.db"))

CLI_PATH = Path(__file__).resolve().parents[2] / "cli" / "envmgr.py"
_job_bu: dict[str, tuple[str, str]] = {}  # job id -> (bu, step kind)
_job_lock = threading.Lock()


def _body() -> dict[str, Any]:
    return request.get_json(force=True, silent=True) or {}


def needs(scope: str | None):
    """A token must carry `scope`; scope None = UI only (no token at all)."""
    def wrap(fn):
        @wraps(fn)
        def inner(*a, **kw):
            tok = getattr(g, "pipeline_token", None)
            if tok is not None:
                if scope is None:
                    return jsonify({"error": "Not with an API token - change this in Env Manager › Pipeline › CI setup"}), 403
                if scope != "any" and scope not in tok["scope"]:
                    return jsonify({"error": f"This token has no '{scope}' scope"}), 403
            return fn(*a, **kw)
        return inner
    return wrap


def _ci(b: dict[str, Any]) -> dict[str, Any]:
    ci = b.get("ci") if isinstance(b.get("ci"), dict) else {}
    if getattr(g, "pipeline_token", None) is None and not ci.get("orchestrator"):
        ci = {**ci, "orchestrator": "builtin"}  # started from the UI
    return ci


def _submit(kind: str, fn, ci: dict[str, Any] | None = None, **fields: Any) -> Any:
    """Run a step as a job. Whatever happens, the Runs list says it: each run
    the step recorded gets its summary, and a crash fails the step's running
    runs with the error - or records one failed run when it crashed before
    recording any (e.g. a host unreachable while loading)."""
    def run() -> Any:
        started: list[str] = []
        token = steps.JOB_RUNS.set(started)
        try:
            res = fn()
        except Exception as e:
            msg = str(e) if isinstance(e, (steps.StepError, steps.GateClosed)) else f"{type(e).__name__}: {e}"
            if started:
                for rid in started:
                    pstore.fail_running(rid, msg, steps.now_iso())
            else:
                c = ci or {}
                pstore.create_run(registry.bu(), {
                    "kind": kind, "stage": c.get("stage") or kind, "orchestrator": steps._orch(c), "runRef": c.get("runRef"),
                    "url": c.get("url"), "status": "failed", "verdict": "error", "error": msg, "summary": msg,
                    "startedAt": steps.now_iso(), "finishedAt": steps.now_iso(), **fields})
            raise
        finally:
            steps.JOB_RUNS.reset(token)
        for r in [res, *((res or {}).get("models") or [])]:
            if isinstance(r, dict) and r.get("runId") and r.get("summary"):
                pstore.update_run(r["runId"], summary=r["summary"])
        return res

    job = jobs.submit(f"pipeline-{kind}", run)
    with _job_lock:
        _job_bu[job["id"]] = (registry.bu(), kind)
    return jsonify({"jobId": job["id"], "status": "running"}), 202


# -- board, runs, setup ---------------------------------------------------------------------

@pipeline_bp.get("/pipeline/board")
@needs("any")
def board():
    out = steps.board(request.args.get("refresh") in ("1", "true"))
    cfg = config.settings()
    return jsonify({**out, "policy": cfg["policy"], "orchestrator": cfg["orchestrator"]})


def _public_run(r: dict[str, Any], policy: dict[str, Any]) -> dict[str, Any]:
    out = {k: v for k, v in r.items() if k != "result"}
    if r["kind"] == "test":
        res = r.get("result") or {}
        out["score"] = stages.summarize({**res, "status": "running" if r["status"] == "running" else
                                         "failed" if r["status"] == "failed" or (res.get("error") and not res.get("rows")) else "done",
                                         "error": r.get("error")}, policy)
        out["verdict"] = out["score"]["verdict"]
        out["baseline"] = res.get("baseline")
        out["validateRunId"] = res.get("validateRunId")
    elif r["status"] == "running":
        out["verdict"] = "running"
    return out


@pipeline_bp.get("/pipeline/runs")
@needs("any")
def runs():
    steps.seed_demo()
    policy = config.settings()["policy"]
    return jsonify({"runs": [_public_run(r, policy) for r in pstore.list_runs(registry.bu(), model=request.args.get("model") or None)]})


@pipeline_bp.get("/pipeline/runs/<run_id>")
@needs("any")
def run_detail(run_id: str):
    """One run in full: summary, error, and the step's result (per host for a
    deploy / rollback / aggregates, per query for a test)."""
    r = pstore.get_run(registry.bu(), run_id)
    if not r:
        return jsonify({"error": "Unknown run"}), 404
    return jsonify({**_public_run(r, config.settings()["policy"]), "result": r.get("result")})


@pipeline_bp.post("/pipeline/runs")
@needs("any")
def report_run():
    """A CI job reports a step Env Manager didn't run itself (e.g. a lint or a
    custom check), so the Runs list shows the whole pipeline."""
    b = _body()
    verdict = b.get("verdict") if b.get("verdict") in ("pass", "fail") else None
    if not b.get("stage"):
        return jsonify({"error": "Missing 'stage'"}), 400
    ci = _ci(b)
    run_id = pstore.create_run(registry.bu(), {
        "kind": "report", "stage": b["stage"], "model": b.get("model"), "commit": b.get("commit"),
        "version": (b.get("commit") or "")[:7] or None, "env": b.get("env"), "orchestrator": ci.get("orchestrator") or "cli",
        "runRef": ci.get("runRef"), "url": ci.get("url"), "status": "done", "verdict": verdict,
        "error": (str(b["error"])[-4000:] if b.get("error") else None), "summary": b.get("summary"),
        "startedAt": b.get("startedAt") or steps.now_iso(), "finishedAt": steps.now_iso(), "durationS": b.get("durationS"),
    })
    return jsonify({"id": run_id}), 201


@pipeline_bp.get("/pipeline/setup")
@needs("any")
def setup():
    cfg = config.settings()
    hosts = registry.bu_hosts()
    st = stages.stages(hosts)
    try:
        pat = re.compile(cfg["serviceAccountPattern"])
    except re.error:
        pat = re.compile(config.DEFAULT_SERVICE_ACCOUNT)
    order = {e: i for i, e in enumerate(stages.ENV_ORDER)}
    idents = [{"hostId": h["id"], "label": h.get("label") or h["id"], "env": h.get("env"),
               "username": (h.get("atscale") or {}).get("username") or "",
               "hasPassword": bool((h.get("atscale") or {}).get("password")),
               "serviceAccount": bool(pat.search((h.get("atscale") or {}).get("username") or ""))}
              for h in sorted(hosts, key=lambda h: (order.get(h.get("env"), 9), h.get("label") or ""))]
    url = _ci_url(request.args.get("origin"))
    return jsonify({
        **cfg, "stages": st, "identities": idents,
        "templates": {"gha": templates.gha(st, cfg["policy"], url), "jenkins": templates.jenkins(st, cfg["policy"], url)},
        "cli": templates.cli_examples(st), "url": url,
    })


@pipeline_bp.put("/pipeline/policy")
@needs(None)
def put_policy():
    try:
        return jsonify(config.update(_body()))
    except ValueError as e:
        return jsonify({"error": str(e)}), 400


@pipeline_bp.get("/pipeline/tokens")
@needs(None)
def list_tokens():
    return jsonify({"tokens": config.tokens(), "scopes": list(config.SCOPES)})


@pipeline_bp.post("/pipeline/tokens")
@needs(None)
def create_token():
    b = _body()
    try:
        tok, plain = config.create_token(b.get("name"), b.get("scope") or [])
    except ValueError as e:
        return jsonify({"error": str(e)}), 400
    return jsonify({**tok, "token": plain}), 201


@pipeline_bp.delete("/pipeline/tokens/<token_id>")
@needs(None)
def revoke_token(token_id: str):
    if not config.revoke_token(token_id):
        return jsonify({"error": "Unknown token"}), 404
    return jsonify({"ok": True})


# -- steps ----------------------------------------------------------------------------------

def _hosts(b: dict[str, Any]) -> list[str] | None:
    hs = b.get("hosts")
    if hs is None:
        return None
    if not isinstance(hs, list) or not all(isinstance(h, str) for h in hs):
        raise steps.StepError("hosts must be a list of host ids")
    if not hs:
        raise steps.StepError("Pick at least one host")
    return hs


def _ci_url(origin: str | None) -> str:
    """The address CI should call: ENV_MANAGER_PUBLIC_URL, else the browser's
    origin (its /api proxies here), else this API's own - behind Vite's
    proxy that's 127.0.0.1, which no runner can reach."""
    origin = origin or ""
    return (os.environ.get("ENV_MANAGER_PUBLIC_URL") or (origin if re.match(r"^https?://[^/]+$", origin) else "")
            or request.host_url).rstrip("/")


def _need(b: dict[str, Any], *keys: str) -> None:
    missing = [k for k in keys if not b.get(k)]
    if missing:
        raise steps.StepError(f"Missing {', '.join(missing)}")


def _step_errors(fn):
    @wraps(fn)
    def inner(*a, **kw):
        try:
            return fn(*a, **kw)
        except steps.StepError as e:
            return jsonify({"error": str(e)}), 400
        except steps.GateClosed as e:
            return jsonify({"error": f"The gate isn't open: {e}", "gate": str(e)}), 409
    return inner


@pipeline_bp.post("/pipeline/validate")
@needs("test")
def validate():
    b = _body()
    files = {str(k): str(v) for k, v in (b.get("files") or {}).items() if str(k).endswith((".yml", ".yaml"))}
    ci = _ci(b)
    return _submit("validate", lambda: steps.validate(files, ci), ci)


@pipeline_bp.post("/pipeline/deploy")
@needs("deploy")
@host_errors
@_step_errors
def deploy():
    b = _body()
    _need(b, "env")
    ci = _ci(b)
    st = stages.stages(registry.bu_hosts())
    _, stage = steps._stage(st, b["env"])  # 400 before a job starts
    host_ids = _hosts(b)
    steps._pick_hosts(stage, host_ids)
    return _submit("deploy", lambda: steps.deploy(b["env"], b.get("branch"), ci, commit=b.get("commit"),
                                                  repo=b.get("repo"), model=b.get("model"), force=bool(b.get("force")),
                                                  host_ids=host_ids), ci, env=b["env"], model=b.get("model"),
                   commit=b.get("commit"))


@pipeline_bp.post("/pipeline/test")
@needs("test")
@host_errors
@_step_errors
def test():
    b = _body()
    _need(b, "env")
    ci = _ci(b)
    _, stage = steps._stage(stages.stages(registry.bu_hosts()), b["env"])
    host_id = b.get("host") or None
    steps._pick_hosts(stage, [host_id] if host_id else None)
    protocols = [p for p in (b.get("protocols") or ["mdx"]) if p in ("mdx", "sql")] or ["mdx"]
    return _submit("test", lambda: steps.test(b["env"], ci, model=b.get("model"), repo=b.get("repo"),
                                              commit=b.get("commit"), baseline=b.get("baseline"), protocols=protocols,
                                              host_id=host_id), ci, env=b["env"], model=b.get("model"))


@pipeline_bp.post("/pipeline/promote-aggs")
@needs("promote")
@host_errors
@_step_errors
def promote_aggs():
    b = _body()
    _need(b, "from", "to")
    ci = _ci(b)
    st = stages.stages(registry.bu_hosts())
    steps._stage(st, b["from"])
    steps._stage(st, b["to"])
    return _submit("promote-aggs", lambda: steps.promote_aggs(b["from"], b["to"], ci, model=b.get("model"),
                                                              include_replacements=bool(b.get("includeReplacements"))),
                   ci, env=b["to"], model=b.get("model"))


@pipeline_bp.post("/pipeline/rollback")
@needs("deploy")
@host_errors
@_step_errors
def rollback():
    b = _body()
    _need(b, "env", "model")
    ci = _ci(b)
    _, stage = steps._stage(stages.stages(registry.bu_hosts()), b["env"])
    host_ids = _hosts(b)
    steps._pick_hosts(stage, host_ids)
    return _submit("rollback", lambda: steps.rollback(b["env"], b["model"], ci, host_ids=host_ids), ci,
                   env=b["env"], model=b["model"])


@pipeline_bp.post("/pipeline/promote")
@needs("promote")
@host_errors
@_step_errors
def promote():
    """Built-in gate: the gate is re-checked here (409 when closed) and again
    inside the job, against the hosts' state at that moment."""
    b = _body()
    _need(b, "model", "env")
    ci = _ci(b)
    hosts, rows, _ = steps.load(refresh=True)
    st = stages.stages(hosts)
    idx, stage = steps._stage(st, b["env"])
    host_ids = _hosts(b)
    steps._pick_hosts(stage, host_ids)
    if idx == 0:
        raise steps.StepError("The first stage has no gate in front of it")
    bd = stages.board(hosts, rows, steps.compare_fn(hosts), steps.test_lookup(), config.settings()["policy"])
    m = next((x for x in bd["models"] if x["name"] == b["model"]), None)
    if not m:
        raise steps.StepError(f"{b['model']} isn't in the pipeline")
    gate, kind = m["gates"][idx - 1], bd["gates"][idx - 1]["kind"]
    if gate["k"] != ("merge" if kind == "merge" else "open"):
        raise steps.GateClosed(gate["label"] or "Nothing to promote")
    src = m["cells"][idx - 1]
    if kind == "promote" and b.get("branch") and src and b["branch"] != src["branch"]:
        raise steps.StepError(f"A promotion deploys the commit {st[idx - 1]['label']} tested, on {src['branch']} - "
                              f"not {b['branch']}. Deploy {b['branch']} to {st[idx - 1]['label']} and test it there first.")
    return _submit("promote", lambda: steps.promote(b["model"], b["env"], ci, host_ids=host_ids, branch=b.get("branch")),
                   ci, env=b["env"], model=b["model"])


def _bundle(b: dict[str, Any]) -> dict[str, Any]:
    _need(b, "action", "env", "model")
    return script_bundle.build(b["action"], b["env"], b["model"], _hosts(b), b.get("branch"))


@pipeline_bp.post("/pipeline/script")
@needs("any")
@host_errors
@_step_errors
def action_script():
    """A Board action as a ps-utils package (pipeline/script_bundle.py): its
    run.sh, plus the GitHub Actions job / Jenkins stage that runs it from the
    repo. Body: {action: promote | rollback | test, env, model, hosts?, branch?}.
    POST /pipeline/script/zip -> the package itself."""
    out = _bundle(_body())
    return jsonify({k: out[k] for k in ("folder", "filename", "title", "sh", "gha", "jenkins")})


@pipeline_bp.post("/pipeline/script/zip")
@needs("any")
@host_errors
@_step_errors
def action_script_zip():
    out = _bundle(_body())
    return Response(script_bundle.zip_bytes(out), mimetype="application/zip",
                    headers={"Content-Disposition": f'attachment; filename="{out["filename"]}"'})


# -- jobs -----------------------------------------------------------------------------------

def _job(job_id: str) -> tuple[dict[str, Any] | None, str]:
    with _job_lock:
        owner = _job_bu.get(job_id)
    job = jobs.get(job_id)
    if not job or not owner or owner[0] != registry.bu():
        return None, ""
    return job, owner[1]


@pipeline_bp.get("/pipeline/jobs/<job_id>")
@needs("any")
def job(job_id: str):
    j, kind = _job(job_id)
    if not j:
        return jsonify({"error": "Unknown job"}), 404
    if j["status"] == "running":
        return jsonify({"id": job_id, "kind": kind, "status": "running"})
    if j["status"] == "failed":
        return jsonify({"id": job_id, "kind": kind, "status": "done", "verdict": "error", "summary": j["error"]})
    res = j["result"] or {}
    return jsonify({"id": job_id, "kind": kind, "status": "done", "verdict": res.get("verdict"),
                    "summary": res.get("summary"), "result": res})


@pipeline_bp.get("/pipeline/jobs/<job_id>/junit")
@needs("any")
def job_junit(job_id: str):
    j, kind = _job(job_id)
    if not j:
        return jsonify({"error": "Unknown job"}), 404
    if j["status"] == "running":
        return jsonify({"error": "Still running"}), 409
    xml = junit.render(kind, j.get("result"), j.get("error"), config.settings()["policy"])
    return Response(xml, mimetype="application/xml")


@pipeline_bp.get("/pipeline/cli")
def cli():
    """The envmgr CLI, one stdlib-only file - CI fetches it from the server it
    calls, so the two always match. Code, not a secret: no token needed."""
    return Response(CLI_PATH.read_text(encoding="utf-8"), mimetype="text/x-python",
                    headers={"Content-Disposition": 'attachment; filename="envmgr"'})
