"""Monitor: a host's AtScale query history - stored, polled on demand, reported on.

  GET  /hosts/<id>/monitor/status              stored rows, last poll, whether a poll is running
  POST /hosts/<id>/monitor/poll                {fromMs?, toMs?, includeSystem?} -> job (202);
                                               no range = since the last poll (monitor/poll.py)
  GET  /hosts/<id>/monitor/overview            ?fromMs&toMs&model&user&queryType&tz -> KPIs, mix, series
  GET  /hosts/<id>/monitor/queries             ?...&cls&status&q&sort&limit&offset -> one page
  GET  /hosts/<id>/monitor/queries/<qid>       one query + its text and aggregates (fetched once from
                                               AtScale, then kept)
  GET  /hosts/<id>/monitor/hotspots            ?fromMs&toMs&model&user&queryType -> slowest, models,
                                               aggregate candidates, failures
  GET  /monitor/store                          where it's kept, rows per host, retention
  POST /monitor/cleanup                        {olderThanDays?, hostId?, model?, dryRun?} -> rows deleted
                                               (every given rule must match; none = everything)
  POST /monitor/compact                        VACUUM

Source: GET /wapi/p/queries (PythonAtscaleUtility queries/query_history_container.py),
stored in workspace/monitor.db (demo: monitor-demo.db) - see monitor/store.py.
"""

from __future__ import annotations

import os
import threading
import time
from pathlib import Path
from typing import Any

from flask import Blueprint, jsonify, request

import cache
import jobs
from envs import registry
from monitor import poll as poller
from monitor import stats, store
from routes.objects import host_errors

monitor_bp = Blueprint("monitor", __name__)

store.set_path(Path(os.environ["ENV_MANAGER_MONITOR_DB"]) if os.environ.get("ENV_MANAGER_MONITOR_DB")
               else cache.WORKSPACE / ("monitor-demo.db" if registry.FAKE else "monitor.db"))

# One poll per host at a time: auto-poll and "Poll now" share the running job.
_polls: dict[str, str] = {}
_polls_lock = threading.Lock()


def _running_poll(host_id: str) -> str | None:
    job_id = _polls.get(host_id)
    job = jobs.get(job_id) if job_id else None
    return job_id if job and job["status"] == "running" else None


def _num(key: str) -> int | None:
    v = request.args.get(key)
    try:
        return int(float(v)) if v not in (None, "") else None
    except ValueError:
        raise ValueError(f"{key} must be a number") from None


def _filters() -> dict[str, Any]:
    now = int(time.time() * 1000)
    to_ms = _num("toMs") or now
    from_ms = _num("fromMs")
    return {"fromMs": from_ms if from_ms is not None else to_ms - 86400 * 1000, "toMs": to_ms,
            **{k: request.args.get(k) or None for k in ("model", "user", "queryType", "cls", "status", "q")}}


def _lists(host_id: str, f: dict[str, Any]) -> dict[str, list[str]]:
    """Models and users seen in the window - the filter dropdowns."""
    rows = store.select(host_id, {"fromMs": f["fromMs"], "toMs": f["toMs"]})

    def names(key: str) -> list[str]:
        # "(none)" last, and only when some query really has no model / user
        return sorted({r[key] for r in rows if r[key]}) + ([store.NONE] if any(not r[key] for r in rows) else [])

    return {"models": names("modelName"), "users": names("user")}


@monitor_bp.get("/hosts/<host_id>/monitor/status")
@host_errors
def status(host_id: str):
    registry.host(host_id)
    return jsonify({**store.host_status(host_id), "pollJob": _running_poll(host_id),
                    "defaultDays": poller.DEFAULT_DAYS, "maxPages": poller.MAX_PAGES, "pageSize": poller.PAGE_SIZE})


@monitor_bp.post("/hosts/<host_id>/monitor/poll")
@host_errors
def poll(host_id: str):
    registry.host(host_id)
    body = request.get_json(force=True, silent=True) or {}
    from_ms, to_ms = body.get("fromMs"), body.get("toMs")
    if from_ms is not None and to_ms is not None and int(to_ms) <= int(from_ms):
        raise ValueError("The range's end must be after its start")
    api = registry.source_api(host_id)
    include_system = body.get("includeSystem", True) is not False
    with _polls_lock:
        running = _running_poll(host_id)
        if running:
            return jsonify(jobs.get(running)), 202
        job = jobs.submit("monitor-poll", lambda: poller.poll(api, host_id, from_ms, to_ms, include_system))
        _polls[host_id] = job["id"]
    return jsonify(job), 202


@monitor_bp.get("/hosts/<host_id>/monitor/overview")
@host_errors
def overview(host_id: str):
    registry.host(host_id)
    f = _filters()
    rows = store.select(host_id, f)
    return jsonify({**stats.overview(rows, f["fromMs"], f["toMs"], _num("tz") or 0), **_lists(host_id, f)})


@monitor_bp.get("/hosts/<host_id>/monitor/queries")
@host_errors
def queries(host_id: str):
    registry.host(host_id)
    f = _filters()
    limit = min(max(_num("limit") or 100, 1), 500)
    rows, total = store.page(host_id, f, request.args.get("sort") or "-startMs", limit, _num("offset") or 0)
    return jsonify({"queries": rows, "total": total, **_lists(host_id, f)})


@monitor_bp.get("/hosts/<host_id>/monitor/queries/<query_id>")
@host_errors
def query_detail(host_id: str, query_id: str):
    registry.host(host_id)
    q = store.get(host_id, query_id)
    if q is None:
        return jsonify({"error": "Query not in the stored history - poll the host first"}), 404
    errors: dict[str, str] = {}
    if q["text"] is None or q["aggDefs"] is None:
        api = registry.source_api(host_id)
        if q["text"] is None:
            try:
                q["text"] = api.get_query_text(query_id)
                store.set_detail(host_id, query_id, text=q["text"])
            except Exception as e:  # noqa: BLE001 - shown next to the query, the rest still renders
                errors["text"] = str(e)
        if q["aggDefs"] is None:
            if q["aggregates"]:
                try:
                    defs = api.get_query_aggregates(query_id)
                    q["aggDefs"] = [{"id": d.get("id"), "name": d.get("name"), "type": d.get("type"),
                                     "subType": d.get("subType"),
                                     "table": (d.get("active_instance") or d.get("latest_instance") or {}).get("table_name")}
                                    for d in defs]
                    store.set_detail(host_id, query_id, agg_defs=q["aggDefs"])
                except Exception as e:  # noqa: BLE001
                    errors["aggregates"] = str(e)
            else:
                q["aggDefs"] = []
    return jsonify({"query": q, "errors": errors})


@monitor_bp.get("/hosts/<host_id>/monitor/hotspots")
@host_errors
def hotspots(host_id: str):
    registry.host(host_id)
    f = _filters()
    return jsonify({**stats.hotspots(store.select(host_id, f)), **_lists(host_id, f)})


@monitor_bp.get("/monitor/store")
def store_info():
    return jsonify(store.stats())


@monitor_bp.post("/monitor/cleanup")
def cleanup():
    body = request.get_json(force=True, silent=True) or {}
    days = body.get("olderThanDays")
    if days is not None:
        try:
            days = int(days)
        except (TypeError, ValueError):
            return jsonify({"error": "olderThanDays must be a number"}), 400
        if days < 0:
            return jsonify({"error": "olderThanDays must be 0 or more"}), 400
    n = store.delete_queries(days, body.get("hostId") or None, body.get("model") or None, dry_run=bool(body.get("dryRun")))
    return jsonify({"count": n})


@monitor_bp.post("/monitor/compact")
def compact():
    before = store.stats()["bytes"]
    store.compact()
    return jsonify({"freedBytes": max(0, before - store.stats()["bytes"])})
