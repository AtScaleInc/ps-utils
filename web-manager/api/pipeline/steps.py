"""The headless pipeline steps - what POST /api/pipeline/<step> runs as a job
and the envmgr CLI waits on. Each returns {verdict: pass | fail, summary, ...}
and records a pipeline run (pipeline/store.py).

  validate      sml-cli over the files the CLI sends (smlgen/validate.py)
  deploy        a branch to every host of a stage. Given a commit, the branch
                head must still be that commit (AtScale deploys a branch head,
                never a commit), and a stage behind a promotion gate takes only
                a commit that passed its test on the stage before (§5).
  test          generate queries on the stage's primary host (Validate's
                generator), run them there and on a baseline (another stage's
                primary host, or this stage's previous test), compare model and
                results (Validate's compare). Scored by stages.summarize.
  promote-aggs  system aggregates from one stage's primary host to every host
                of another (Promote's export -> remap -> import)
  rollback      redeploy the commit a stage ran before (backend.deploy_commit)
  promote       the built-in gate: re-check the gate, then deploy
"""

from __future__ import annotations

import contextvars
import time
from concurrent.futures import ThreadPoolExecutor
from typing import Any, Callable

from atscale import github
from atscale.backend import now_iso
from envs import registry

from . import config, stages
from . import store as pstore

ORCH_LABEL = {"gha": "GitHub Actions", "jenkins": "Jenkins", "builtin": "Built-in gate", "cli": "envmgr CLI"}
ORCH_SHORT = {"gha": "GHA", "jenkins": "JNK", "builtin": "ENV", "cli": "CLI"}


class GateClosed(RuntimeError):
    """The built-in promote found the gate not open (-> 409)."""


class StepError(ValueError):
    """A bad request for a step (unknown stage, model not deployed, ...) -> 400."""


# -- reading the business unit's hosts ------------------------------------------------------

def _parallel(fn: Callable[[Any], Any], items: list) -> list:
    """`fn` over `items` on a pool, each in a copy of the caller's context
    (the business unit is a contextvar: worker threads don't inherit it)."""
    if not items:
        return []
    with ThreadPoolExecutor(max_workers=8) as ex:
        return list(ex.map(lambda x: contextvars.copy_context().run(fn, x), items))


def load(refresh: bool = False) -> tuple[list[dict[str, Any]], dict[str, list[dict[str, Any]]], dict[str, str]]:
    """(hosts, model rows per host id, error per host id) for the BU."""
    hosts = registry.bu_hosts()

    def rows(h: dict[str, Any]) -> tuple[str, list[dict[str, Any]], str | None]:
        try:
            return h["id"], registry.backend(h["id"], refresh).list_models(), None
        except Exception as e:  # noqa: BLE001 - one unreachable host doesn't hide the rest
            return h["id"], [], str(e)

    out = _parallel(rows, hosts)
    return hosts, {i: r for i, r, _ in out}, {i: e for i, _, e in out if e}


def compare_fn(hosts: list[dict[str, Any]]) -> stages.Compare:
    """Commit order through any host's backend: compare() is a GitHub compare,
    the same whichever host asks (and cached per BU)."""
    if not hosts:
        return lambda a, b: None
    b = registry.backend(hosts[0]["id"])
    return lambda src, tgt: b.compare(src, tgt)


def test_lookup() -> Callable[[str, str | None, str], dict[str, Any] | None]:
    latest = pstore.tests(registry.bu())

    def of(model: str, commit: str | None, env: str) -> dict[str, Any] | None:
        run = latest.get((model, commit or "", env))
        if not run:
            return None
        return {**(run.get("result") or {}), "status": "running" if run["status"] == "running" else
                ("failed" if run["status"] == "failed" else "done"), "error": run.get("error"), "runId": run["id"],
                "runRef": run.get("runRef"), "at": run.get("finishedAt") or run.get("startedAt")}
    return of


def board(refresh: bool = False) -> dict[str, Any]:
    seed_demo()
    hosts, rows, errors = load(refresh)
    cfg = config.settings()
    out = stages.board(hosts, rows, compare_fn(hosts), test_lookup(), cfg["policy"])
    out["hostErrors"] = errors
    return out


def _stage(st: list[dict[str, Any]], env: str) -> tuple[int, dict[str, Any]]:
    for i, s in enumerate(st):
        if s["env"] == env:
            return i, s
    have = " · ".join(s["env"] for s in st) or "none"
    raise StepError(f"No stage '{env}' in this business unit's pipeline (stages: {have})")


def _pick_hosts(stage: dict[str, Any], host_ids: list[str] | None) -> dict[str, Any]:
    """The stage narrowed to `host_ids` (in the stage's order); None or empty
    = every host of the stage."""
    if not host_ids:
        return stage
    known = {h["id"] for h in stage["hosts"]}
    unknown = [h for h in host_ids if h not in known]
    if unknown:
        raise StepError(f"Not a {stage['label']} host: {', '.join(unknown)} "
                        f"(its hosts: {', '.join(h['id'] for h in stage['hosts'])})")
    return {**stage, "hosts": [h for h in stage["hosts"] if h["id"] in host_ids]}


def same_commit(a: str | None, b: str | None) -> bool:
    return bool(a and b) and (a.startswith(b) or b.startswith(a))


def resolve_repo(rows: dict[str, list[dict[str, Any]]], repo: str | None, model: str | None) -> str:
    """The repo URL as the hosts know it, from `repo` (a URL or owner/name) or a model name."""
    all_rows = [r for rs in rows.values() for r in rs if r.get("repoUrl")]
    if repo:
        url = repo if "://" in repo else f"https://github.com/{repo.strip('/')}"
        key = github.normalize_repo_url(url)
        return next((r["repoUrl"] for r in all_rows if github.normalize_repo_url(r["repoUrl"]) == key), url)
    if model:
        r = next((r for r in all_rows if r.get("name") == model), None)
        if not r:
            raise StepError(f"No host in this business unit has a model named '{model}'")
        return r["repoUrl"]
    raise StepError("Give the repository (--repo) or a model (--model)")


def _models_of(rows: dict[str, list[dict[str, Any]]], repo_url: str, hosts: list[dict[str, Any]] | None = None) -> list[str]:
    key = github.normalize_repo_url(repo_url)
    ids = {h["id"] for h in hosts} if hosts is not None else set(rows)
    return sorted({r["name"] for i, rs in rows.items() if i in ids for r in rs
                   if r.get("status") != "Linked" and github.normalize_repo_url(r.get("repoUrl") or "") == key})


# -- run records -----------------------------------------------------------------------------

def _orch(ci: dict[str, Any]) -> str:
    o = (ci or {}).get("orchestrator")
    return o if o in ORCH_LABEL else "cli"


def _start(kind: str, ci: dict[str, Any], **fields: Any) -> tuple[str, float]:
    ci = ci or {}
    o = _orch(ci)
    run_id = pstore.create_run(registry.bu(), {
        "kind": kind, "stage": ci.get("stage") or fields.pop("stage", None) or kind, "orchestrator": o,
        "runRef": ci.get("runRef") or f"{ORCH_SHORT[o]} {now_iso()[5:16].replace('T', ' ')}", "url": ci.get("url"),
        "startedAt": now_iso(), "status": "running", **fields,
    })
    return run_id, time.time()


def _finish(run_id: str, t0: float, verdict: str, result: dict[str, Any] | None = None, error: str | None = None) -> None:
    pstore.update_run(run_id, status="failed" if error and verdict == "error" else "done", verdict=verdict,
                      result=result, error=error, finishedAt=now_iso(), durationS=round(time.time() - t0, 1))


# -- steps -----------------------------------------------------------------------------------

def validate(files: dict[str, str], ci: dict[str, Any]) -> dict[str, Any]:
    from routes.build import _resolve_packages
    from smlgen.validate import SmlCliNotFound, validate_sml

    run_id, t0 = _start("validate", ci, stage=ci.get("stage") or "Commit · validate", commit=ci.get("sha"))
    if not files:
        _finish(run_id, t0, "fail", error="No SML files sent")
        return {"verdict": "fail", "summary": "No .yml files found under the path", "runId": run_id}
    try:
        packages, warnings = _resolve_packages(files)
        res = validate_sml(files, packages)
    except SmlCliNotFound as e:
        _finish(run_id, t0, "error", error=str(e))
        raise
    verdict = "pass" if res["passed"] else "fail"
    result = {"files": len(files), "output": res["output"][-20000:], "warnings": warnings}
    _finish(run_id, t0, verdict, result)
    return {"verdict": verdict, "summary": f"sml-cli validate: {'passed' if res['passed'] else 'failed'} ({len(files)} files)",
            "runId": run_id, **result}


def _gate_problems(st, idx: int, rows, models: list[str], commit: str | None, policy: dict[str, Any],
                   test_of) -> list[str]:
    """Why a stage behind a promotion gate can't take `commit` (empty: it can)."""
    kinds = stages.gate_kinds(st)
    if idx == 0 or kinds[idx - 1]["kind"] != "promote" or not policy.get("requireTest"):
        return []
    prev = st[idx - 1]
    out = []
    for m in models:
        c = stages.cell(prev, rows, m)
        if not c:
            # The deploy takes the repo's whole catalog: this model would arrive untested.
            out.append(f"{m}: not on {prev['label']} - the deploy would bring it to {st[idx]['label']} untested")
            continue
        if commit and not same_commit(c["commit"], commit):
            out.append(f"{m}: {prev['label']} runs {stages.short(c['row'])}, not {commit[:7]} - deploy and test it there first")
            continue
        v = stages.summarize(test_of(m, c["commit"], prev["env"]), policy)["verdict"]
        if v != "pass":
            why = {"none": "no test", "fail": "test failed", "running": "test still running"}.get(v, v)
            out.append(f"{m}: {why} for {stages.short(c['row'])} on {prev['label']}")
    return out


def deploy(env: str, branch: str | None, ci: dict[str, Any], commit: str | None = None, repo: str | None = None,
           model: str | None = None, force: bool = False, host_ids: list[str] | None = None) -> dict[str, Any]:
    """`host_ids`: deploy to these hosts of the stage only (default: all). The
    others keep what they run - the Board shows them as drift."""
    hosts, rows, _ = load(refresh=True)
    st = stages.stages(hosts)
    idx, stage = _stage(st, env)
    stage = _pick_hosts(stage, host_ids)
    repo_url = resolve_repo(rows, repo, model)
    branch = branch or "main"
    first = registry.backend(stage["hosts"][0]["id"])
    head = first.head_commit(repo_url, branch, model)
    run_id, t0 = _start("deploy", ci, stage=f"Deploy · {stage['label']}", model=model or repo_url.rsplit("/", 1)[-1],
                        commit=commit or head, version=(commit or head or "")[:7], env=env)
    if commit and head and not same_commit(head, commit):
        msg = (f"{branch} has moved: its head is {head[:7]}, not {commit[:7]}. AtScale deploys a branch head, "
               "so this commit can't be deployed - run the pipeline for the new head.")
        _finish(run_id, t0, "fail", error=msg)
        return {"verdict": "fail", "summary": msg, "runId": run_id}
    # The whole catalog deploys, so every model of the repo has to pass the gate.
    models = _models_of(rows, repo_url) or ([model] if model else [])
    if not force:
        problems = _gate_problems(st, idx, rows, models, commit or head, config.settings()["policy"], test_lookup())
        if problems:
            msg = f"Blocked at the gate into {stage['label']}: " + "; ".join(problems)
            _finish(run_id, t0, "fail", error=msg)
            return {"verdict": "fail", "summary": msg, "runId": run_id, "blocked": problems}
    results = _parallel(lambda h: {**registry.backend(h["id"]).deploy_branch(repo_url, branch), "hostId": h["id"],
                                   "host": h["label"]}, stage["hosts"])
    bad = [r for r in results if not r.get("ok")]
    verdict = "fail" if bad else "pass"
    summary = (f"{repo_url.rsplit('/', 1)[-1]}@{branch} ({(commit or head or '?')[:7]}) deployed to "
               f"{', '.join(r['host'] for r in results if r.get('ok')) or 'no host'}")
    if bad:
        summary += " · failed on " + "; ".join(f"{r['host']}: {r.get('error')}" for r in bad)
    result = {"repoUrl": repo_url, "branch": branch, "commit": commit or head, "hosts": results}
    _finish(run_id, t0, verdict, result, error=None if not bad else summary)
    return {"verdict": verdict, "summary": summary, "runId": run_id, **result}


def _queries(host_id: str, row: dict[str, Any]) -> tuple[dict[str, Any], list[dict[str, Any]]]:
    """(harness target, generated queries) for a model on a host."""
    from atscale.preview import load_cube_metadata
    from routes.analyze import _xmla_target
    from testing.generate import build_queries, model_entries

    api = registry.source_api(host_id)
    catalog, cube = _xmla_target(api, row)
    metrics, levels = model_entries(load_cube_metadata(api, catalog, cube))
    raw = registry.host(host_id)
    return ({"hostId": host_id, "label": raw.get("label") or host_id, "env": raw.get("env"),
             "catalog": catalog, "cube": cube}, build_queries(metrics, levels, cube))


def _launch(targets, queries, protocols):
    """Validate's run launcher; waits for a free slot instead of failing a CI
    job because other runs are executing."""
    from routes.testing import Busy, launch_run

    deadline = time.time() + 30 * 60
    while True:
        try:
            run, thread = launch_run(targets, queries, protocols, _harness_opts(), concurrency=2)
            thread.join()
            return run["runId"]
        except Busy:
            if time.time() > deadline:
                raise
            time.sleep(10)


def _harness_opts() -> dict[str, bool]:
    from testing.harness import DEFAULT_OPTS

    return dict(DEFAULT_OPTS)


def _rows_for_score(rows: list[dict[str, Any]]) -> list[dict[str, Any]]:
    """Validate's compare rows -> what stages.summarize scores: a query only
    the candidate has is new (not a failure); one only the baseline has is missing."""
    out = []
    for r in rows:
        v = r["verdict"]
        if v == "missing":
            v = "new" if r.get("a") is None else "missing"
        pct = None
        if v == "differs":
            d = r.get("variance") or {}
            if not (d.get("onlyACount") or d.get("onlyBCount") or d.get("schemaDiffers")):
                pct = d.get("maxPct")
        out.append({"name": r["name"], "protocol": r["protocol"], "verdict": v, "pct": pct,
                    "error": ((r.get("b") or {}).get("error") or (r.get("a") or {}).get("error") or None)})
    return out


def _sml_names(files: dict[str, str]) -> set[str]:
    import yaml

    names: set[str] = set()

    def walk(o: Any) -> None:
        if isinstance(o, dict):
            for k in ("unique_name", "label", "name"):
                if isinstance(o.get(k), str):
                    names.add(o[k].strip().lower())
            for v in o.values():
                walk(v)
        elif isinstance(o, list):
            for v in o:
                walk(v)

    for body in files.values():
        try:
            walk(yaml.safe_load(body))
        except yaml.YAMLError:
            continue
    return names


def _changed_names(repo_url: str, a: str, b: str) -> set[str] | None:
    """Every name declared in an SML file that differs between commits a and
    b - the commit's intended edits. None when the commits can't be read."""
    token = registry.git_token()
    if not token or not a or not b or registry.FAKE:
        return None
    try:
        fa, fb = github.fetch_sml_files(token, repo_url, a), github.fetch_sml_files(token, repo_url, b)
    except github.GitError:
        return None
    changed = {p: fa.get(p, "") for p in set(fa) | set(fb) if fa.get(p) != fb.get(p)}
    return _sml_names(changed) | _sml_names({p: fb.get(p, "") for p in changed})


def classify(diff: dict[str, Any] | None, changed: set[str] | None) -> dict[str, Any]:
    """Model diff -> intended (an object declared in a changed SML file) vs
    unintended. Without the Git diff every change is unintended, flagged
    `unclassified`, so intendedOnly stays conservative."""
    if not diff:
        return {"intended": 0, "unintended": 0, "changes": [], "unclassified": False}
    changes = []
    for section in ("metrics", "levels"):
        d = diff.get(section) or {}
        for kind, names in (("removed", d.get("onlyA") or []), ("added", d.get("onlyB") or []),
                            ("changed", [c["name"] for c in d.get("changed") or []])):
            for n in names:
                parts = {p.strip().lower() for p in str(n).split("|")}
                ok = changed is not None and bool(parts & changed)
                changes.append({"section": section, "name": n, "kind": kind, "intended": ok})
    n_int = sum(c["intended"] for c in changes)
    return {"intended": n_int, "unintended": len(changes) - n_int, "changes": changes[:200],
            "unclassified": changed is None and bool(changes)}


def test(env: str, ci: dict[str, Any], model: str | None = None, repo: str | None = None, commit: str | None = None,
         baseline: str | None = None, protocols: list[str] | None = None, host_id: str | None = None) -> dict[str, Any]:
    """`host_id`: test on this host of the stage instead of its primary one."""
    hosts, rows, _ = load(refresh=True)
    st = stages.stages(hosts)
    _, stage = _stage(st, env)
    stage = _pick_hosts(stage, [host_id] if host_id else None)
    if model:
        models = [model]
    else:
        models = _models_of(rows, resolve_repo(rows, repo, None), stage["hosts"])
        if not models:
            raise StepError(f"Nothing from {repo} is deployed on {stage['label']}")
    outs = [_test_one(st, stage, rows, m, ci, commit, baseline, protocols or ["mdx"]) for m in models]
    verdict = "pass" if all(o["verdict"] == "pass" for o in outs) else "fail"
    return {"verdict": verdict, "summary": " · ".join(o["summary"] for o in outs), "models": outs,
            "runId": outs[0]["runId"] if len(outs) == 1 else None}


def _test_one(st, stage, rows, model: str, ci: dict[str, Any], commit: str | None, baseline: str | None,
              protocols: list[str]) -> dict[str, Any]:
    from routes.testing import compare_sides
    from testing import store as tstore

    bu = registry.bu()
    c = stages.cell(stage, rows, model)
    if not c:
        raise StepError(f"{model} isn't deployed on {stage['label']}")
    run_id, t0 = _start("test", ci, stage=ci.get("stage") or f"Test · {stage['label']}", model=model,
                        commit=c["commit"], version=stages.short(c["row"]), env=stage["env"])
    if c["commit"]:
        pstore.set_test(bu, model, c["commit"], stage["env"], run_id)
    git_sha, repo_url = ci.get("sha"), c.get("repoUrl")
    _post_status(repo_url, git_sha, "pending", f"Testing {model} on {stage['label']}", ci)

    def fail(msg: str) -> dict[str, Any]:
        _finish(run_id, t0, "fail", {"rows": [], "error": msg}, error=msg)
        _post_status(repo_url, git_sha, "failure", f"{model}: {msg}"[:140], ci)
        return {"verdict": "fail", "summary": f"{model}: {msg}", "runId": run_id, "model": model}

    if commit and not same_commit(c["commit"], commit):
        return fail(f"{stage['label']} runs {stages.short(c['row'])}, not {commit[:7]}")
    # Baseline: another stage's primary host (default: the last stage), or this stage's previous test.
    want = baseline or (st[-1]["env"] if st[-1]["env"] != stage["env"] else "previous")
    base_cell = None
    if want != "previous":
        _, bstage = _stage(st, want)
        base_cell = stages.cell(bstage, rows, model)
        if not base_cell:
            want = "previous"
    if registry.FAKE:
        return _demo_test(run_id, t0, c, stage, base_cell, model, protocols, ci)
    try:
        cand_t, queries = _queries(c["hostId"], c["row"])
        if not queries:
            return fail("no queries could be generated from the model")
        if base_cell:
            base_t, _ = _queries(base_cell["hostId"], base_cell["row"])
            vid = _launch([base_t, cand_t], queries, protocols)
            vrun = tstore.get_run(vid)
            diff, cmp_rows = compare_sides(vrun, base_t, vrun, cand_t)
            base_info = {"kind": "stage", "env": base_cell["env"], "hostId": base_cell["hostId"],
                         "label": base_cell["hostLabel"], "commit": base_cell["commit"], "version": base_cell["version"]}
        else:
            prev = pstore.previous_test(bu, model, stage["env"], c["commit"] or "")
            vid = _launch([cand_t], queries, protocols)
            vrun = tstore.get_run(vid)
            pr = (prev or {}).get("result") or {}
            prun = tstore.get_run(pr.get("validateRunId") or "") if pr.get("validateRunId") else None
            if prun:
                ptarget = next(t for t in prun["targets"] if t["hostId"] == pr["candidate"]["hostId"])
                diff, cmp_rows = compare_sides(prun, ptarget, vrun, cand_t)
                base_info = {"kind": "previous", "env": stage["env"], "hostId": ptarget["hostId"], "label": ptarget.get("label"),
                             "commit": prev.get("commit"), "version": prev.get("version")}
            else:
                # Nothing to compare with yet: the queries only have to run.
                diff = None
                cmp_rows = [{"name": r["queryName"], "protocol": r["protocol"], "a": {}, "b": r,
                             "verdict": "failedCandidate" if r["status"] == "FAILED" else "identical"}
                            for r in vrun["results"]]
                base_info = {"kind": "none"}
    except Exception as e:  # noqa: BLE001 - reported as the test's failure
        return fail(str(e))
    changed = _changed_names(repo_url or "", (base_info.get("commit") or ""), c["commit"] or "") if base_info.get("commit") else None
    result = {
        "validateRunId": vid, "protocols": protocols, "queries": len(queries),
        "candidate": {"hostId": c["hostId"], "label": c["hostLabel"], "commit": c["commit"], "version": c["version"],
                      "env": stage["env"]},
        "baseline": base_info, "rows": _rows_for_score(cmp_rows), "model": classify(diff, changed),
    }
    score = stages.summarize({**result, "status": "done"}, config.settings()["policy"])
    _finish(run_id, t0, score["verdict"], result)
    summary = _test_summary(model, stage, base_info, score)
    _post_status(repo_url, git_sha, "success" if score["verdict"] == "pass" else "failure", summary, ci)
    _comment(repo_url, ci, model, stage, base_info, score, result)
    return {"verdict": score["verdict"], "summary": summary, "runId": run_id, "model": model, "score": score,
            "result": result}


def _demo_test(run_id: str, t0: float, c: dict[str, Any], stage: dict[str, Any], base_cell: dict[str, Any] | None,
               model: str, protocols: list[str], ci: dict[str, Any]) -> dict[str, Any]:
    """Demo mode: the fake hosts serve no cube, so the result is synthesised
    (atscale/fake.py :: pipeline_test_rows) - same shape, same scoring."""
    from atscale import fake

    time.sleep(1.5)  # long enough for the board to show "Testing…"
    base = ({"kind": "stage", "env": base_cell["env"], "hostId": base_cell["hostId"], "label": base_cell["hostLabel"],
             "commit": base_cell["commit"], "version": base_cell["version"]} if base_cell else {"kind": "none"})
    result = {"validateRunId": None, "protocols": protocols, "queries": 24, "demo": True,
              "candidate": {"hostId": c["hostId"], "label": c["hostLabel"], "commit": c["commit"], "version": c["version"],
                            "env": stage["env"]},
              "baseline": base, "rows": fake.pipeline_test_rows(model, c["commit"], stage["env"]),
              "model": {"intended": 1 if base_cell and base_cell["commit"] != c["commit"] else 0, "unintended": 0,
                        "changes": [], "unclassified": False}}
    score = stages.summarize({**result, "status": "done"}, config.settings()["policy"])
    _finish(run_id, t0, score["verdict"], result)
    return {"verdict": score["verdict"], "summary": _test_summary(model, stage, base, score), "runId": run_id,
            "model": model, "score": score, "result": result}


def seed_demo() -> None:
    """Demo mode: the BU's pipeline starts with the mockup's test history."""
    from atscale import fake

    bu = registry.bu()
    if not registry.FAKE or pstore.list_runs(bu, limit=1):
        return
    hosts = registry.bu_hosts()
    envs = {h.get("env") for h in hosts}
    for model, commit, env, ref, at in fake.PIPELINE_SEED:
        if env not in envs:
            continue
        rows = fake.pipeline_test_rows(model, commit, env)
        result = {"validateRunId": None, "protocols": ["mdx"], "queries": len(rows), "demo": True,
                  "candidate": {"env": env, "commit": commit, "version": commit}, "baseline": {"kind": "stage", "env": "prod",
                  "label": "prod-east"}, "rows": rows,
                  "model": {"intended": 1, "unintended": 0, "changes": [], "unclassified": False}}
        orch = "jenkins" if ref.startswith("JNK") else "gha"
        run_id = pstore.create_run(bu, {"kind": "test", "stage": f"Test · {stages.ENV_LABEL[env]}", "model": model,
                                        "commit": commit, "version": commit, "env": env, "orchestrator": orch,
                                        "runRef": ref, "status": "done", "startedAt": at, "finishedAt": at,
                                        "durationS": 290.0, "result": result})
        pstore.set_test(bu, model, commit, env, run_id)


def _test_summary(model: str, stage: dict[str, Any], base: dict[str, Any], s: dict[str, Any]) -> str:
    vs = {"stage": f"vs {base.get('label')} ({base.get('version')})", "previous": f"vs previous {base.get('version')}",
          "none": "no baseline yet"}.get(base.get("kind"), "")
    mv = "∞" if s.get("unbounded") else f"{s.get('maxVariance') or 0}%"
    return (f"{model} on {stage['label']} {vs}: {s['verdict'].upper()} · {s.get('matched', 0)}/{s.get('queries', 0)} matched · "
            f"max variance {mv} (limit {s.get('limit')}%) · model diff {s.get('intended', 0)} intended, "
            f"{s.get('unintended', 0)} unintended")


def _post_status(repo_url: str | None, sha: str | None, state: str, description: str, ci: dict[str, Any]) -> None:
    """Commit status `atscale/env-manager` on the commit CI ran for, through
    the BU's Git token. Best effort: a missing permission never fails a test."""
    token = registry.git_token()
    if registry.FAKE or not (token and repo_url and sha):
        return
    try:
        github.set_commit_status(token, repo_url, sha, state, description, target_url=ci.get("url"))
    except github.GitError:
        pass


def _comment(repo_url: str | None, ci: dict[str, Any], model: str, stage: dict[str, Any], base: dict[str, Any],
             s: dict[str, Any], result: dict[str, Any]) -> None:
    token = registry.git_token()
    pr = ci.get("pr")
    if registry.FAKE or not (token and repo_url and pr):
        return
    icon = "✅" if s["verdict"] == "pass" else "❌"
    lines = [f"### {icon} AtScale Env Manager · {model} on {stage['label']}", "",
             f"| | |", "|---|---|",
             f"| Verdict | **{s['verdict'].upper()}** |",
             f"| Baseline | {base.get('label') or '—'} {base.get('version') or ''} |",
             f"| Matched | {s.get('matched', 0)}/{s.get('queries', 0)} |",
             f"| Max variance | {'∞' if s.get('unbounded') else str(s.get('maxVariance') or 0) + '%'} (limit {s.get('limit')}%) |",
             f"| Model diff | {s.get('intended', 0)} intended · {s.get('unintended', 0)} unintended |"]
    bad = [r for r in result["rows"] if r["verdict"] in stages.FAIL_ROWS or
           (r["verdict"] == "differs" and (r["pct"] is None or abs(r["pct"]) > s.get("limit", 0)))]
    if bad:
        lines += ["", "<details><summary>Queries over the limit or failing</summary>", ""]
        lines += [f"- {r['name']} ({r['protocol']}): {r['verdict']}" + (f" {r['pct']}%" if r.get("pct") is not None else "")
                  for r in bad[:30]]
        lines += ["", "</details>"]
    try:
        github.comment_on_pr(token, repo_url, int(pr), "\n".join(lines))
    except (github.GitError, ValueError):
        pass


def promote_aggs(src_env: str, tgt_env: str, ci: dict[str, Any], model: str | None = None,
                 include_replacements: bool = False) -> dict[str, Any]:
    """Every stageable system aggregate (§5 rules; "replaces inactive" only
    with include_replacements) from the source stage's primary host to each
    host of the target stage."""
    from promote import diff as D
    from routes.promote import _all_aggs, _target_aggs, promote_aggregate_ids

    hosts, rows, _ = load(refresh=True)
    st = stages.stages(hosts)
    _, s_stage = _stage(st, src_env)
    _, t_stage = _stage(st, tgt_env)
    if model:
        sc = stages.cell(s_stage, rows, model)
        if not sc:
            raise StepError(f"{model} isn't deployed on {s_stage['label']}")
        src_id = sc["hostId"]
        tgt_ids = [h["id"] for h in t_stage["hosts"]
                   if any(r.get("name") == model and r.get("status") != "Linked" for r in rows.get(h["id"]) or [])]
    else:
        src_id, tgt_ids = s_stage["hosts"][0]["id"], [h["id"] for h in t_stage["hosts"]]
    run_id, t0 = _start("promote-aggs", ci, stage=f"Promote · aggregates {s_stage['label']} → {t_stage['label']}",
                        model=model or "all models", env=tgt_env)
    src = registry.backend(src_id)
    per_host = []
    for tid in tgt_ids:
        tgt = registry.backend(tid, refresh=True)
        src_models, src_aggs = _all_aggs(src, model)
        tgt_models = tgt.agg_models()
        tgt_aggs = _target_aggs(tgt, tgt_models, src_models, {})
        diffs = D.diff_aggs(src_aggs, tgt_aggs, {m["name"] for m in tgt_models})
        ids = [a["id"] for a in diffs if a["diff"]["stageable"] and (include_replacements or a["diff"]["state"] != "repl")]
        held = [{"name": a["name"], "reason": a["diff"].get("reason") or a["diff"]["label"]}
                for a in diffs if a["id"] not in ids and a["diff"]["state"] not in ("same", "uda")]
        res = promote_aggregate_ids(src, tgt, ids, {}) if ids else {"promoted": [], "skipped": [], "connections": {}}
        per_host.append({"hostId": tid, "host": registry.host(tid).get("label") or tid, **res,
                         "skipped": res["skipped"] + held})
    n = sum(len(h["promoted"]) for h in per_host)
    summary = (f"{n} system aggregate(s) promoted {s_stage['label']} → {t_stage['label']}"
               + "".join(f" · {h['host']}: {len(h['promoted'])} promoted, {len(h['skipped'])} skipped" for h in per_host))
    result = {"source": src_id, "hosts": per_host}
    _finish(run_id, t0, "pass", result)
    return {"verdict": "pass", "summary": summary, "runId": run_id, **result}


def rollback(env: str, model: str, ci: dict[str, Any], host_ids: list[str] | None = None) -> dict[str, Any]:
    """Redeploy the commit the stage's primary host ran before, on every host
    of the stage that runs the model (or the `host_ids` of them). A model
    version is its Git commit - nothing is rebuilt; aggregates are left as they are."""
    hosts, rows, _ = load(refresh=True)
    st = stages.stages(hosts)
    _, stage = _stage(st, env)
    stage = _pick_hosts(stage, host_ids)
    c = stages.cell(stage, rows, model)
    if not c:
        raise StepError(f"{model} isn't deployed on {stage['label']}")
    prev = registry.backend(c["hostId"]).previous_commit(c["row"])
    run_id, t0 = _start("rollback", ci, stage=f"Rollback · {stage['label']}", model=model,
                        commit=(prev or {}).get("commit"), version=((prev or {}).get("commit") or "")[:7], env=env)
    if not prev:
        msg = (f"No earlier commit is recorded for {model} on {c['hostLabel']} - this app keeps the commits it "
               "deployed, so redeploy the one you want from Manage or Promote")
        _finish(run_id, t0, "fail", error=msg)
        return {"verdict": "fail", "summary": msg, "runId": run_id}
    branch = prev.get("branch") or c["branch"] or "main"
    results = _parallel(lambda hid: {**registry.backend(hid).deploy_commit(c["repoUrl"], branch, prev["commit"],
                                                                           _catalog_id(rows, hid, model)),
                                     "hostId": hid, "host": registry.host(hid).get("label") or hid}, c["hosts"])
    bad = [r for r in results if not r.get("ok")]
    verdict = "fail" if bad else "pass"
    summary = f"{model} on {stage['label']} rolled back {c['version']} → {prev['commit'][:7]}"
    if bad:
        summary += " · failed on " + "; ".join(f"{r['host']}: {r.get('error')}" for r in bad)
    _finish(run_id, t0, verdict, {"hosts": results, "from": c["commit"], "to": prev["commit"]}, error=summary if bad else None)
    return {"verdict": verdict, "summary": summary, "runId": run_id, "hosts": results}


def _catalog_id(rows, host_id: str, model: str) -> str | None:
    return next((r.get("catalogId") for r in rows.get(host_id) or [] if r.get("name") == model and r.get("status") != "Linked"), None)


def promote(model: str, env: str, ci: dict[str, Any], host_ids: list[str] | None = None,
            branch: str | None = None) -> dict[str, Any]:
    """The built-in gate's Promote: re-check the gate into `env` server-side
    (raises GateClosed), then deploy to `host_ids` of the stage (default: all).
    Over a promotion gate it deploys the previous stage's commit - its branch,
    whose head must still be that commit, so another branch is refused. Over a
    merge gate, `branch`'s head (default: the branch the target stage runs)."""
    hosts, rows, _ = load(refresh=True)
    st = stages.stages(hosts)
    idx, stage = _stage(st, env)
    if idx == 0:
        raise StepError(f"{stage['label']} is the first stage - deploy to it from Build or CI")
    b = stages.board(hosts, rows, compare_fn(hosts), test_lookup(), config.settings()["policy"])
    m = next((x for x in b["models"] if x["name"] == model), None)
    if not m:
        raise StepError(f"{model} isn't in the pipeline")
    gate, kind = m["gates"][idx - 1], b["gates"][idx - 1]["kind"]
    src = m["cells"][idx - 1]
    if kind == "promote" and gate["k"] != "open":
        raise GateClosed(gate["label"] or "Nothing to promote")
    if kind == "merge" and gate["k"] != "merge":
        raise GateClosed(gate["label"] or "Nothing to promote")
    ci = {**ci, "orchestrator": ci.get("orchestrator") or "builtin", "stage": f"Promote · {st[idx - 1]['label']} → {stage['label']}"}
    if kind == "merge":
        tgt = m["cells"][idx]
        return deploy(env, branch or (tgt or {}).get("branch") or "main", ci, repo=src["repoUrl"], model=model,
                      force=True, host_ids=host_ids)
    if branch and branch != src["branch"]:
        raise StepError(f"{st[idx - 1]['label']} tested {stages.short(src)} on {src['branch']}: a promotion deploys that "
                        f"commit, not {branch}'s head. Deploy {branch} to {st[idx - 1]['label']} and test it there first.")
    return deploy(env, src["branch"], ci, commit=src["commit"], repo=src["repoUrl"], model=model, host_ids=host_ids)
