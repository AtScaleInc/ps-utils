"""Pull a host's query history into the store.

An on-demand poll without a range picks up where the last one stopped: from
the newest stored query minus OVERLAP (so queries that were still running
are refreshed), or DEFAULT_DAYS back on a host never polled. A range poll
(fromMs..toMs) backfills any window. Pages come newest first, PAGE_SIZE rows
each (the engine's cap), until the API reports no next page or MAX_PAGES is
reached - then the poll is marked truncated (the oldest part of the window is
missing) instead of silently stopping. User and System queries are both pulled
(Overview splits them); include_system=False keeps to User queries.
"""

from __future__ import annotations

import datetime as dt
import os
import time
from typing import Any

from monitor import store
from monitor.queries import normalize

DEFAULT_DAYS = int(os.environ.get("ENV_MANAGER_MONITOR_DEFAULT_DAYS", "2"))
MAX_PAGES = int(os.environ.get("ENV_MANAGER_MONITOR_MAX_PAGES", "200"))
PAGE_SIZE = 100
OVERLAP_MS = 60 * 60 * 1000


def _iso(ms: int) -> str:
    return dt.datetime.fromtimestamp(ms / 1000, dt.timezone.utc).strftime("%Y-%m-%dT%H:%M:%S.") + f"{ms % 1000:03d}Z"


def window(host_id: str, from_ms: int | None, to_ms: int | None, now_ms: int) -> tuple[int, int | None]:
    if from_ms is not None:
        return int(from_ms), (int(to_ms) if to_ms is not None else None)
    default_from = now_ms - DEFAULT_DAYS * 86400 * 1000
    newest = store.newest_start(host_id)
    if newest is None:
        return default_from, None
    start = newest - OVERLAP_MS
    running = store.oldest_running(host_id)
    if running is not None and running >= default_from:
        start = min(start, running)
    return start, None


def poll(api: Any, host_id: str, from_ms: int | None = None, to_ms: int | None = None,
         include_system: bool = True) -> dict[str, Any]:
    now = int(time.time() * 1000)
    start, end = window(host_id, from_ms, to_ms, now)
    fetched = added = pages = 0
    truncated = False
    error = None
    try:
        page = 1
        while True:
            body = api.list_queries(page=page, size=PAGE_SIZE, start_date=_iso(start),
                                    end_date=_iso(end) if end is not None else None,
                                    query_types=["User", "System"] if include_system else ["User"])
            rows = [normalize(r) for r in body.get("results") or [] if isinstance(r, dict)]
            pages += 1
            fetched += len(rows)
            added += store.upsert(host_id, rows)
            if not body.get("hasNextPage") or not rows:
                break
            if pages >= MAX_PAGES:
                truncated = True
                break
            page += 1
    except Exception as e:  # noqa: BLE001 - recorded on the poll, then re-raised for the job
        error = str(e)
        raise
    finally:
        store.add_poll(host_id, start, end, fetched, added, pages, truncated, error)
        store.prune()
    return {"fromMs": start, "toMs": end, "fetched": fetched, "added": added, "pages": pages, "truncated": truncated}
