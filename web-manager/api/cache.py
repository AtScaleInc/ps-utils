"""TTL cache for AtScale / GitHub reads, mirrored to disk.

Container calls are slow (auth + several REST round-trips per list), so each
host's lists are kept for ENV_MANAGER_CACHE_TTL seconds (default 2 h). Writes
invalidate the host's entries; `refresh=True` forces a reload.

Every entry is also written as readable JSON under the working folder
(`workspace/cache/` at the repo root, override with ENV_MANAGER_WORKSPACE), e.g.
    workspace/cache/host/dev-docker/models.json
    workspace/cache/host/dev-docker/aggs/<catalogId>/<modelId>.json
so you can see exactly what the app is serving, and a restarted API picks the
data back up instead of starting cold.
"""

from __future__ import annotations

import json
import os
import re
import shutil
import threading
import time
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Callable

TTL = int(os.environ.get("ENV_MANAGER_CACHE_TTL", str(2 * 60 * 60)))

_REPO_ROOT = Path(__file__).resolve().parent.parent
WORKSPACE = Path(os.environ.get("ENV_MANAGER_WORKSPACE", _REPO_ROOT / "workspace"))
# The demo backend (ENV_MANAGER_FAKE=1) gets its own folder so demo data never
# mixes with real hosts' cached lists.
DIR = WORKSPACE / ("cache-demo" if os.environ.get("ENV_MANAGER_FAKE") == "1" else "cache")


def work_tmp() -> Path:
    """Scratch space for short-lived files (conversions, sml-cli validation) inside
    the working folder instead of the OS temp dir, so they sit with everything else."""
    path = WORKSPACE / "tmp"
    path.mkdir(parents=True, exist_ok=True)
    return path

_entries: dict[tuple, tuple[float, float, Any]] = {}  # key -> (loaded_at, expires_at, value)
_lock = threading.Lock()
_key_locks: dict[tuple, threading.Lock] = {}


def set_dir(path: Path | str) -> None:
    """Point the disk mirror somewhere else (tests use a temp dir)."""
    global DIR
    DIR = Path(path)
    with _lock:
        _entries.clear()


def _slug(part: Any) -> str:
    s = str(part)
    s = re.sub(r"^https?://", "", s)
    return re.sub(r"[^A-Za-z0-9._-]+", "_", s).strip("_") or "_"


def path_for(key: tuple) -> Path:
    parts = [_slug(p) for p in key]
    return DIR.joinpath(*parts[:-1], f"{parts[-1]}.json")


def _iso(ts: float) -> str:
    return datetime.fromtimestamp(ts, timezone.utc).replace(microsecond=0).isoformat().replace("+00:00", "Z")


def _write(key: tuple, loaded: float, expires: float, value: Any) -> None:
    path = path_for(key)
    try:
        path.parent.mkdir(parents=True, exist_ok=True)
        tmp = path.with_suffix(".json.tmp")
        tmp.write_text(json.dumps({
            "key": list(key), "loadedAt": _iso(loaded), "expiresAt": _iso(expires),
            "loadedAtEpoch": loaded, "expiresAtEpoch": expires, "value": value,
        }, indent=1, default=str))
        tmp.replace(path)
    except OSError:
        pass  # the disk mirror is a convenience; memory stays authoritative


def _read(key: tuple) -> tuple[float, float, Any] | None:
    path = path_for(key)
    try:
        doc = json.loads(path.read_text())
        return doc["loadedAtEpoch"], doc["expiresAtEpoch"], doc["value"]
    except (OSError, ValueError, KeyError):
        return None


def get(key: tuple, loader: Callable[[], Any], refresh: bool = False,
        ttl: Callable[[Any], float] | None = None) -> tuple[Any, float]:
    """(value, loaded_at). One loader runs per key at a time, so concurrent
    requests for the same list share a single AtScale call."""
    if not refresh:
        hit = _entries.get(key)
        if hit and hit[1] > time.time():
            return hit[2], hit[0]
    with _lock:
        key_lock = _key_locks.setdefault(key, threading.Lock())
    with key_lock:
        if not refresh:
            hit = _entries.get(key) or _read(key)
            if hit and hit[1] > time.time():
                _entries[key] = hit
                return hit[2], hit[0]
        value = loader()
        loaded = time.time()
        expires = loaded + (ttl(value) if ttl else TTL)
        _entries[key] = (loaded, expires, value)
        _write(key, loaded, expires, value)
        return value, loaded


def peek(key: tuple) -> tuple[Any, float] | None:
    """(value, loaded_at) if the key holds an unexpired value, else None -
    never runs a loader (memory, then the disk mirror)."""
    hit = _entries.get(key)
    if not (hit and hit[1] > time.time()):
        hit = _read(key)
        if not (hit and hit[1] > time.time()):
            return None
        _entries[key] = hit
    return hit[2], hit[0]


def invalidate(*prefix: Any) -> None:
    """Drop every entry whose key starts with `prefix` (memory and disk)."""
    n = len(prefix)
    with _lock:
        for k in [k for k in _entries if k[:n] == prefix]:
            _entries.pop(k, None)
    if not prefix:
        target = DIR
    else:
        target = DIR.joinpath(*(_slug(p) for p in prefix))
        single = target.with_suffix(".json")
        if single.is_file():
            single.unlink(missing_ok=True)
    if target.is_dir():
        shutil.rmtree(target, ignore_errors=True)


def clear() -> None:
    invalidate()


def summary() -> list[dict[str, Any]]:
    """What's on disk: one row per cached list, for GET /api/cache."""
    out = []
    if not DIR.is_dir():
        return out
    now = time.time()
    for path in sorted(DIR.rglob("*.json")):
        try:
            doc = json.loads(path.read_text())
        except (OSError, ValueError):
            continue
        value = doc.get("value")
        out.append({
            "path": str(path.relative_to(DIR.parent)),
            "key": doc.get("key"),
            "loadedAt": doc.get("loadedAt"),
            "expiresAt": doc.get("expiresAt"),
            "fresh": doc.get("expiresAtEpoch", 0) > now,
            "items": len(value) if isinstance(value, (list, dict)) else None,
            "bytes": path.stat().st_size,
        })
    return out
