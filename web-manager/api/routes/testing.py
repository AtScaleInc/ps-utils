"""Test: generate queries from a deployed model and run them on chosen hosts.

  GET  /hosts/<id>/test/cubes     catalogs + cubes deployed on the host
  POST /test/generate             {hostId, catalog, cube} -> metrics, levels, queries
                                  (ps-utils generate-queries-from-model, testing/generate.py)
  POST /test/runs                 {targets: [{hostId, catalog, cube}], queries, protocols,
                                   concurrency, options} -> {runId}  (execute-atscale-query-harness,
                                  testing/harness.py)
  POST /test/script               same body as /test/runs -> a zip to run it by hand with the ps-utils
                                  CLI (execute-atscale-query-harness + a baseline compare, testing/cli_bundle.py)
  GET  /test/runs                 run history (newest first, no per-query rows)
  GET  /test/runs/<id>            one run, live while it's running
  GET  /test/runs/<id>.csv        results in the harness's CSV layout
  POST /test/compare              {baseline: {runId, hostId}, candidate: {runId, hostId}, tolerance}
                                  -> model diff (DMV snapshots) + per-query result variance
  POST /test/model-compare        {baseline: {hostId, catalog, cube}, candidate: {...}} - live DMV diff

  GET  /test/history              ?model=&query=&protocol= - one query across runs
  GET  /test/store                where runs are kept, how many, how big, retention
  POST /test/cleanup              {olderThanDays?, keepPerModel?, model?, dryRun?} -> runs deleted (or that would be)
  POST /test/compact              give freed space back to the filesystem (VACUUM)

Runs, their queries, each host's model snapshot and every execution (with its
result rows) live in one SQLite file, workspace/tests.db (demo: tests-demo.db) -
see testing/store.py.
"""

from __future__ import annotations

import os
import threading
from pathlib import Path
from typing import Any

from flask import Blueprint, Response, jsonify, request

import cache
from atscale.backend import now_iso
from atscale.preview import list_catalogs_and_cubes, load_cube_metadata
from envs import registry
from routes.objects import host_errors
from testing import cli_bundle, harness, store
from testing.model import compare_models, snapshot
from testing.results import compare as compare_rows
from testing.generate import build_queries, model_entries

testing_bp = Blueprint("testing", __name__)

store.set_path(Path(os.environ["ENV_MANAGER_TESTS_DB"]) if os.environ.get("ENV_MANAGER_TESTS_DB")
               else cache.WORKSPACE / ("tests-demo.db" if registry.FAKE else "tests.db"))
# Runs saved by the earlier JSON layout move into the database once.
_LEGACY_DIR = cache.WORKSPACE / ("tests-demo" if registry.FAKE else "tests")
_imported = False
_import_lock = threading.Lock()
# Test runs hit the hosts hard (every query x host x protocol): cap how many
# execute at once so many users starting runs can't swamp the hosts or the API.
MAX_ACTIVE = int(os.environ.get("ENV_MANAGER_TEST_MAX_ACTIVE", "3"))
_active = threading.BoundedSemaphore(MAX_ACTIVE)


def _ensure_imported() -> None:
    global _imported
    if _imported:
        return
    with _import_lock:
        if not _imported:
            try:
                store.import_json_dir(_LEGACY_DIR)
            finally:
                _imported = True


def _body() -> dict:
    return request.get_json(force=True, silent=True) or {}


@testing_bp.get("/hosts/<host_id>/test/cubes")
@host_errors
def cubes(host_id: str):
    return jsonify({"cubes": list_catalogs_and_cubes(registry.source_api(host_id))})


@testing_bp.post("/test/generate")
@host_errors
def generate():
    b = _body()
    host_id, catalog, cube = b.get("hostId"), b.get("catalog"), b.get("cube")
    if not (host_id and catalog and cube):
        return jsonify({"error": "Missing hostId, catalog or cube"}), 400
    meta = load_cube_metadata(registry.source_api(host_id), catalog, cube)
    metrics, levels = model_entries(meta)
    return jsonify({"metrics": metrics, "levels": levels, "queries": build_queries(metrics, levels, cube)})


def _summary(run: dict[str, Any]) -> dict[str, Any]:
    return {k: v for k, v in run.items() if k not in ("results", "queries", "models")}


def _run_request(b: dict[str, Any]) -> tuple[Any, ...]:
    """(queries, protocols, targets, raw hosts by id, options, concurrency) from a
    /test/runs or /test/script body; raises ValueError (-> 400) on a bad pick and
    HostNotFound (-> 404) for a host outside the request's business unit."""
    queries = [q for q in (b.get("queries") or []) if q.get("mdx") and q.get("sql")]
    protocols = [p for p in (b.get("protocols") or ["mdx"]) if p in ("mdx", "sql")]
    if not queries:
        raise ValueError("Pick at least one query")
    if not protocols:
        raise ValueError("Pick MDX, SQL or both")
    targets, raws = [], {}
    for t in b.get("targets") or []:
        raw = registry.host(t["hostId"])  # 404 before anything runs
        if not (t.get("catalog") and t.get("cube")):
            raise ValueError(f"No model picked for {raw.get('label') or t['hostId']}")
        raws[t["hostId"]] = raw
        targets.append({"hostId": t["hostId"], "label": raw.get("label") or t["hostId"], "env": raw.get("env"),
                        "catalog": t["catalog"], "cube": t["cube"]})
    if not targets:
        raise ValueError("Pick at least one host")
    opts = {**harness.DEFAULT_OPTS, **{k: bool(v) for k, v in (b.get("options") or {}).items() if k in harness.DEFAULT_OPTS}}
    concurrency = max(1, min(int(b.get("concurrency") or 1), 16))
    return queries, protocols, targets, raws, opts, concurrency


@testing_bp.post("/test/script")
@host_errors
def run_script():
    """The run as a zip for the ps-utils CLI. Nothing runs here and no
    password goes into the zip (run.sh asks, or reads it from the environment)."""
    b = _body()
    queries, protocols, targets, raws, opts, concurrency = _run_request(b)
    name, data = cli_bundle.build(targets, raws, queries, protocols, concurrency, opts, bool(b.get("annotate", True)))
    return Response(data, mimetype="application/zip", headers={"Content-Disposition": f'attachment; filename="{name}"'})


@testing_bp.post("/test/runs")
@host_errors
def start_run():
    b = _body()
    queries, protocols, targets, _, opts, concurrency = _run_request(b)

    if not _active.acquire(blocking=False):
        return jsonify({"error": f"{MAX_ACTIVE} test runs are already running - wait for one to finish", "busy": True}), 429
    run_id = harness.generate_run_id()
    run = {"runId": run_id, "status": "running", "startedAt": now_iso(), "finishedAt": None,
           "targets": targets, "protocols": protocols, "options": opts, "concurrency": concurrency,
           "total": len(queries) * len(protocols) * len(targets), "done": 0, "failed": 0, "error": None}
    try:
        _ensure_imported()
        store.create_run(run, queries)
    except Exception:
        _active.release()
        raise

    def on_result(rec: dict[str, Any]) -> None:
        store.add_execution(rec, rec.pop("data", None))

    def work() -> None:
        status, error = "done", None
        try:
            # What the model looked like on each host when the queries ran.
            models: dict[str, dict[str, Any]] = {}
            for t in targets:
                try:
                    models[t["hostId"]] = snapshot(registry.source_api(t["hostId"]), t["catalog"], t["cube"])
                except Exception as e:  # noqa: BLE001 - the queries still run
                    models[t["hostId"]] = {"error": str(e)}
                store.set_model(run_id, t["hostId"], models[t["hostId"]])
            base = models.get(targets[0]["hostId"]) or {}
            check = {t["hostId"]: compare_models(base, models[t["hostId"]]) for t in targets[1:]
                     if "error" not in base and "error" not in models[t["hostId"]]}
            store.set_model_check(run_id, check)
            harness.run(run_id, targets, queries, protocols, registry.source_api, opts,
                        concurrency=concurrency, annotate=bool(b.get("annotate", True)), on_result=on_result)
        except Exception as e:  # noqa: BLE001 - surfaced on the run
            status, error = "failed", str(e)
        try:
            store.finish_run(run_id, status, now_iso(), error)
            store.prune(targets[0]["cube"])
        finally:
            _active.release()

    threading.Thread(target=work, daemon=True).start()
    return jsonify({"runId": run_id, **run}), 202


def _in_bu(run: dict[str, Any], ids: set[str] | None = None) -> bool:
    """A run belongs to the business unit of its hosts (a run never spans two:
    its hosts all resolve through registry.host)."""
    ids = registry.bu_host_ids() if ids is None else ids
    return any(t.get("hostId") in ids for t in run.get("targets") or [])


def _bu_run(run_id: str) -> dict[str, Any] | None:
    run = store.get_run(run_id)
    return run if run and _in_bu(run) else None


@testing_bp.get("/test/runs")
def list_runs():
    _ensure_imported()
    ids = registry.bu_host_ids()
    return jsonify({"runs": [r for r in store.list_runs(request.args.get("model") or None) if _in_bu(r, ids)]})


@testing_bp.get("/test/history")
def query_history():
    """One query's executions across runs (newest first) - trend of time,
    row count and checksum per host."""
    model, name = request.args.get("model"), request.args.get("query")
    if not model or not name:
        return jsonify({"error": "Missing model or query"}), 400
    ids = registry.bu_host_ids()
    return jsonify({"history": [e for e in store.history(model, name, request.args.get("protocol") or None)
                                if e["hostId"] in ids]})


@testing_bp.get("/test/store")
def store_info():
    _ensure_imported()
    return jsonify({**store.stats(), "maxActive": MAX_ACTIVE})


@testing_bp.post("/test/compact")
def compact():
    before = store.stats()["bytes"]
    store.compact()
    after = store.stats()
    return jsonify({"freedBytes": max(0, before - after["bytes"]), "store": after})


@testing_bp.post("/test/cleanup")
def cleanup():
    """Delete finished runs: older than N days and/or beyond the newest N per
    model, optionally for one model only. dryRun lists them without deleting;
    a real cleanup compacts the database afterwards."""
    b = _body()

    def num(k: str) -> int | None:
        v = b.get(k)
        return None if v in (None, "") else max(0, int(v))

    older, keep = num("olderThanDays"), num("keepPerModel")
    if older is None and keep is None:
        return jsonify({"error": "Give olderThanDays and/or keepPerModel"}), 400
    ids = registry.bu_host_ids()
    mine = {r["runId"] for r in store.list_runs(b.get("model") or None) if _in_bu(r, ids)}
    runs = [r for r in store.select_old(keep_per_model=keep, older_than_days=older, model=b.get("model") or None)
            if r["runId"] in mine]
    if b.get("dryRun"):
        return jsonify({"runs": runs, "count": len(runs), "dryRun": True})
    n = store.delete_runs([r["runId"] for r in runs], vacuum=True)
    return jsonify({"count": n, "store": store.stats()})


@testing_bp.get("/test/runs/<run_id>.csv")
def run_csv(run_id: str):
    run = _bu_run(run_id)
    if not run:
        return jsonify({"error": "Unknown run"}), 404
    return Response(harness.to_csv(run["results"]), mimetype="text/csv",
                    headers={"Content-Disposition": f"attachment; filename=results_{run_id}.csv"})


@testing_bp.get("/test/runs/<run_id>")
def get_run(run_id: str):
    run = _bu_run(run_id)
    if not run:
        return jsonify({"error": "Unknown run"}), 404
    return jsonify(run)


@testing_bp.delete("/test/runs/<run_id>")
def delete_run(run_id: str):
    if not _bu_run(run_id) or not store.delete_run(run_id):
        return jsonify({"error": "Unknown run"}), 404
    return jsonify({"ok": True})


def _run_side(ref: dict[str, Any], label: str) -> tuple[dict[str, Any], dict[str, Any]]:
    run = _bu_run(ref.get("runId") or "")
    if not run:
        raise ValueError(f"{label}: unknown run")
    target = next((t for t in run["targets"] if t["hostId"] == ref.get("hostId")), None)
    if not target:
        raise ValueError(f"{label}: host isn't in run {run['runId']}")
    return run, target


def _pct(a: float, b: float) -> float | None:
    return round((b - a) / a * 100, 1) if a else None


@testing_bp.post("/test/compare")
def compare():
    """Baseline vs candidate: two (run, host) pairs - the same run's two hosts
    (Dev vs QA), or one host across two runs (before vs after a redeploy).
    Queries are matched by name + protocol."""
    b = _body()
    try:
        run_a, ta = _run_side(b.get("baseline") or {}, "Baseline")
        run_b, tb = _run_side(b.get("candidate") or {}, "Candidate")
    except ValueError as e:
        return jsonify({"error": str(e)}), 400
    tolerance = float(b.get("tolerance") or 1e-9)
    ma, mb = (run_a.get("models") or {}).get(ta["hostId"]), (run_b.get("models") or {}).get(tb["hostId"])
    model = compare_models(ma, mb) if ma and mb and "error" not in ma and "error" not in mb else None

    def index(run, host_id):
        return {(r["queryName"], r["protocol"]): r for r in run["results"] if r["hostId"] == host_id}

    ia, ib = index(run_a, ta["hostId"]), index(run_b, tb["hostId"])
    rows = []
    for key in sorted(set(ia) | set(ib), key=lambda k: (k[0], k[1])):
        ra, rb = ia.get(key), ib.get(key)
        row: dict[str, Any] = {"name": key[0], "protocol": key[1],
                               "a": {k: ra[k] for k in ("status", "durationMs", "rowCount", "error")} if ra else None,
                               "b": {k: rb[k] for k in ("status", "durationMs", "rowCount", "error")} if rb else None}
        if not ra or not rb:
            row["verdict"] = "missing"
        elif ra["status"] == "FAILED" or rb["status"] == "FAILED":
            row["verdict"] = ("failedBoth" if ra["status"] == rb["status"] else
                              "failedBaseline" if ra["status"] == "FAILED" else "failedCandidate")
        else:
            diff = compare_rows(store.read_data(run_a["runId"], ta["hostId"], key[1], ra["queryId"]),
                                store.read_data(run_b["runId"], tb["hostId"], key[1], rb["queryId"]), tolerance)
            row["verdict"] = diff["status"]
            row["variance"] = diff
            row["timePct"] = _pct(ra["durationMs"], rb["durationMs"])
        rows.append(row)
    order = {"failedCandidate": 0, "differs": 1, "missing": 2, "failedBaseline": 3, "failedBoth": 4, "identical": 5}
    rows.sort(key=lambda r: (order.get(r["verdict"], 9), r["name"], r["protocol"]))
    counts: dict[str, int] = {}
    for r in rows:
        counts[r["verdict"]] = counts.get(r["verdict"], 0) + 1
    ok_a = [r["a"]["durationMs"] for r in rows if r.get("timePct") is not None]
    ok_b = [r["b"]["durationMs"] for r in rows if r.get("timePct") is not None]
    side = lambda run, t: {"runId": run["runId"], "startedAt": run["startedAt"], "hostId": t["hostId"],  # noqa: E731
                           "label": t.get("label"), "env": t.get("env"), "catalog": t["catalog"], "cube": t["cube"]}
    passed = model is not None and model["identical"] and counts.get("identical", 0) == len(rows) and rows
    return jsonify({
        "baseline": side(run_a, ta), "candidate": side(run_b, tb), "tolerance": tolerance,
        "verdict": "pass" if passed else "fail", "model": model, "counts": counts, "total": len(rows),
        "time": {"baselineMs": sum(ok_a), "candidateMs": sum(ok_b), "pct": _pct(sum(ok_a), sum(ok_b))},
        "queries": rows,
    })


@testing_bp.post("/test/model-compare")
@host_errors
def model_compare():
    """Live DMV snapshot of two deployed models, diffed."""
    b = _body()
    a, c = b.get("baseline") or {}, b.get("candidate") or {}
    for side, label in ((a, "Baseline"), (c, "Candidate")):
        if not (side.get("hostId") and side.get("catalog") and side.get("cube")):
            return jsonify({"error": f"{label}: pick a host and a model"}), 400
    sa = snapshot(registry.source_api(a["hostId"]), a["catalog"], a["cube"])
    sc = snapshot(registry.source_api(c["hostId"]), c["catalog"], c["cube"])
    return jsonify({"baseline": {**a, "snapshot": sa}, "candidate": {**c, "snapshot": sc}, "diff": compare_models(sa, sc)})
