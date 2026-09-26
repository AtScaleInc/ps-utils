"""In-process job registry for long-running calls (deploy, build, promote).
Single-user, same as sml-wizard's session store."""

from __future__ import annotations

import threading
import traceback
import uuid
from concurrent.futures import ThreadPoolExecutor
from typing import Any, Callable

from atscale.backend import now_iso

_pool = ThreadPoolExecutor(max_workers=4)
_jobs: dict[str, dict[str, Any]] = {}
_lock = threading.Lock()


def submit(kind: str, fn: Callable[[], Any]) -> dict[str, Any]:
    job_id = uuid.uuid4().hex[:12]
    job = {"id": job_id, "kind": kind, "status": "running", "startedAt": now_iso(), "result": None, "error": None}
    with _lock:
        _jobs[job_id] = job

    def run() -> None:
        try:
            result = fn()
            with _lock:
                job.update(status="done", result=result, finishedAt=now_iso())
        except Exception as e:  # noqa: BLE001 - surfaced through GET /api/jobs/:id
            traceback.print_exc()
            with _lock:
                job.update(status="failed", error=str(e), finishedAt=now_iso())

    _pool.submit(run)
    return dict(job)


def get(job_id: str) -> dict[str, Any] | None:
    with _lock:
        job = _jobs.get(job_id)
        return dict(job) if job else None
