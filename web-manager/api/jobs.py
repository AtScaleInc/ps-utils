"""In-process job registry for long-running calls (deploy, build, promote).
Single-user, same as sml-wizard's session store."""

from __future__ import annotations

import contextvars
import threading
import time
import traceback
import uuid
from concurrent.futures import ThreadPoolExecutor
from typing import Any, Callable

from atscale.backend import now_iso

_pool = ThreadPoolExecutor(max_workers=4)
_jobs: dict[str, dict[str, Any]] = {}
_lock = threading.Lock()
# Finished jobs are only polled for a few seconds by the UI; keep them an hour,
# and never more than MAX_JOBS in total, so the registry can't grow forever.
KEEP_FINISHED_S = 60 * 60
MAX_JOBS = 500


def _prune() -> None:
    """Caller holds _lock. Drops finished jobs past KEEP_FINISHED_S, then the
    oldest finished ones while over MAX_JOBS. Running jobs are kept."""
    now = time.time()
    for jid in [j for j, job in _jobs.items() if job["status"] != "running" and now - job["_t"] > KEEP_FINISHED_S]:
        del _jobs[jid]
    finished = sorted((job["_t"], jid) for jid, job in _jobs.items() if job["status"] != "running")
    while len(_jobs) > MAX_JOBS and finished:
        del _jobs[finished.pop(0)[1]]


def submit(kind: str, fn: Callable[[], Any]) -> dict[str, Any]:
    job_id = uuid.uuid4().hex[:12]
    job = {"id": job_id, "kind": kind, "status": "running", "startedAt": now_iso(), "result": None, "error": None,
           "_t": time.time()}
    with _lock:
        _prune()
        _jobs[job_id] = job

    def run() -> None:
        try:
            result = fn()
            with _lock:
                job.update(status="done", result=result, finishedAt=now_iso(), _t=time.time())
        except Exception as e:  # noqa: BLE001 - surfaced through GET /api/jobs/:id
            traceback.print_exc()
            with _lock:
                job.update(status="failed", error=str(e), finishedAt=now_iso(), _t=time.time())

    # Run in a copy of the caller's context: the job keeps the request's
    # business unit (envs.registry.current_bu) after the request has ended.
    _pool.submit(contextvars.copy_context().run, run)
    return _public(job)


def _public(job: dict[str, Any]) -> dict[str, Any]:
    return {k: v for k, v in job.items() if not k.startswith("_")}


def get(job_id: str) -> dict[str, Any] | None:
    with _lock:
        job = _jobs.get(job_id)
        return _public(job) if job else None
