"""Build > Discovery: look at one warehouse table before modeling it.

  table        GET  /hosts/<id>/discovery/table        columns, sample rows, AtScale's statistics
  profile      GET  /hosts/<id>/discovery/profile      SQL profile + drift vs the previous run
  top values   GET  /hosts/<id>/discovery/top-values   a column's most frequent values
  join check   POST /hosts/<id>/discovery/join-check   orphans + target uniqueness for a join
  store        GET  /discovery/store, POST /discovery/cleanup|compact   Settings > Cache & Database

Table args are ?source=<connectionId::database>&schema=&table= (the Source
panel's source id). Everything read from the warehouse is kept in SQLite
(discovery/store.py) and served from there until ?refresh=1 - a profile scans
the whole table, so it runs only for a table never profiled or on Re-profile.
"""

from __future__ import annotations

import os
import threading
from pathlib import Path
from typing import Any, Callable

from flask import Blueprint, jsonify, request

import cache
from atscale.backend import now_iso
from atscale.client import AtScaleAuthError
from discovery import profile as prof
from discovery import store
from envs import registry
from routes.build import _list_sources, _sources_ttl
from routes.objects import host_errors

discovery_bp = Blueprint("discovery", __name__)

store.set_path(Path(os.environ["ENV_MANAGER_DISCOVERY_DB"]) if os.environ.get("ENV_MANAGER_DISCOVERY_DB")
               else cache.WORKSPACE / ("discovery-demo.db" if registry.FAKE else "discovery.db"))

# One warehouse read per (table, kind) at a time: a second tab or a double click
# waits for the first and gets its stored result instead of scanning again.
_locks: dict[tuple, threading.Lock] = {}
_locks_guard = threading.Lock()


def _lock_for(key: tuple) -> threading.Lock:
    with _locks_guard:
        return _locks.setdefault(key, threading.Lock())


class _BadRequest(Exception):
    pass


def _refresh(b: dict | None = None) -> bool:
    return request.args.get("refresh") in ("1", "true") or bool((b or {}).get("refresh"))


def _table_key(host_id: str, src: dict) -> store.TableKey:
    connection_id, _, database = (src.get("source") or "").partition("::")
    schema, table = src.get("schema") or "", src.get("table") or ""
    if not connection_id or not database or not schema or not table:
        raise _BadRequest("Missing 'source', 'schema' or 'table'")
    return host_id, connection_id, database, schema, table


def _dialect(host_id: str, connection_id: str, src: dict) -> str | None:
    """The warehouse's platformType, from the host's cached sources list."""
    if src.get("dialect"):
        return src["dialect"]
    sources, _ = cache.get(("host", host_id, "sources"), lambda: _list_sources(registry.source_api(host_id)),
                           ttl=_sources_ttl)
    return next((s["dialect"] for s in sources if s["connectionId"] == connection_id), None)


def _columns(api, key: store.TableKey) -> list[dict[str, Any]]:
    _, connection_id, database, schema, table = key
    info = api.get_table_info(connection_id, database, schema, table) or {}
    return [{"name": c.get("name"), "type": c.get("dataType")} for c in info.get("columns", [])]


def _stored(key: store.TableKey, kind: str, item_key: str, loader: Callable[[], Any], refresh: bool) -> tuple[Any, str]:
    """(data, fetched_at) from the store, else load, store and return it."""
    if not refresh and (hit := store.get_item(key, kind, item_key)):
        return hit
    with _lock_for((*key, kind, item_key)):
        if not refresh and (hit := store.get_item(key, kind, item_key)):
            return hit
        data, at = loader(), now_iso()
        store.put_item(key, kind, item_key, data, at)
        return data, at


def _guard(fn):
    """400 for bad args; the warehouse / engine message as a 502."""
    def wrapper(*a, **kw):
        try:
            return fn(*a, **kw)
        except _BadRequest as e:
            return jsonify({"error": str(e)}), 400
        except (ValueError, registry.HostNotFound, AtScaleAuthError):
            raise  # host_errors: 400 / 404 / 401
        except Exception as e:  # noqa: BLE001
            return jsonify({"error": str(e)}), 502
    wrapper.__name__ = fn.__name__
    return wrapper


@discovery_bp.get("/hosts/<host_id>/discovery/table")
@host_errors
@_guard
def table_info(host_id: str):
    """Columns (live metadata), sample rows and AtScale's cached statistics. The
    sample and statistics fail independently - each reports its own error."""
    key = _table_key(host_id, request.args)
    api = registry.source_api(host_id)
    dialect = _dialect(host_id, key[1], request.args)
    out: dict[str, Any] = {"dialect": dialect, "columns": _columns(api, key)}
    loaders = {
        "sample": lambda: prof.sample_rows(api, *key[1:], dialect),
        "statistics": lambda: prof.table_statistics(api, *key[1:]),
    }
    for name, loader in loaders.items():
        try:
            out[name], out[f"{name}At"] = _stored(key, name, "", loader, _refresh())
        except Exception as e:  # noqa: BLE001
            out[name], out[f"{name}Error"] = None, str(e)
    return jsonify(out)


def _with_history(key: store.TableKey, found: tuple[dict, str, int]) -> dict[str, Any]:
    profile, at, pid = found
    prev = store.get_profile(key, before_id=pid)
    previous = {**prev[0], "profiledAt": prev[1]} if prev else None
    return {**profile, "id": pid, "profiledAt": at, "drift": store.drift(profile, previous),
            "history": store.history(key)}


@discovery_bp.get("/hosts/<host_id>/discovery/profile")
@host_errors
@_guard
def profile(host_id: str):
    """The newest stored profile (or ?id=<run>); runs one when the table has
    none yet or on ?refresh=1. ?cached=1 never runs one: 404 with
    notProfiled when the table has none (the Build wizard checks first)."""
    key = _table_key(host_id, request.args)
    if request.args.get("id"):
        found = store.get_profile(key, profile_id=int(request.args["id"]))
        if not found:
            return jsonify({"error": "No such profile run"}), 404
        return jsonify(_with_history(key, found))
    refresh = _refresh()
    if not refresh and (found := store.get_profile(key)):
        return jsonify(_with_history(key, found))
    if request.args.get("cached") in ("1", "true"):
        return jsonify({"error": "Not profiled yet", "notProfiled": True}), 404
    with _lock_for((*key, "profile")):
        if not refresh and (found := store.get_profile(key)):
            return jsonify(_with_history(key, found))
        api = registry.source_api(host_id)
        dialect = _dialect(host_id, key[1], request.args)
        try:
            sample, _ = _stored(key, "sample", "", lambda: prof.sample_rows(api, *key[1:], dialect), False)
        except Exception:  # noqa: BLE001 - format checks just go without
            sample = None
        result = prof.profile_table(api, *key[1:], _columns(api, key), dialect, sample)
        at = now_iso()
        pid = store.add_profile(key, result, at)
        return jsonify(_with_history(key, (result, at, pid)))


@discovery_bp.get("/hosts/<host_id>/discovery/top-values")
@host_errors
@_guard
def top_values(host_id: str):
    key = _table_key(host_id, request.args)
    column = request.args.get("column", "")
    if not column:
        raise _BadRequest("Missing 'column'")
    api = registry.source_api(host_id)
    dialect = _dialect(host_id, key[1], request.args)
    values, at = _stored(key, "top", column, lambda: prof.top_values(api, *key[1:], column, dialect), _refresh())
    return jsonify({"column": column, "values": values, "fetchedAt": at})


@discovery_bp.post("/hosts/<host_id>/discovery/join-check")
@host_errors
@_guard
def join_check(host_id: str):
    """Body: table args + {column, toSchema, toTable, toColumn, refresh?}."""
    b = request.get_json(force=True, silent=True) or {}
    key = _table_key(host_id, b)
    column, to_schema, to_table, to_column = (b.get(k) or "" for k in ("column", "toSchema", "toTable", "toColumn"))
    if not column or not to_table or not to_column:
        raise _BadRequest("Missing 'column', 'toTable' or 'toColumn'")
    to_schema = to_schema or key[3]
    api = registry.source_api(host_id)
    dialect = _dialect(host_id, key[1], b)
    result, at = _stored(key, "join", f"{column}->{to_schema}.{to_table}.{to_column}",
                         lambda: prof.join_check(api, *key[1:], column, to_schema, to_table, to_column, dialect),
                         _refresh(b))
    return jsonify({**result, "fetchedAt": at})


@discovery_bp.get("/discovery/store")
def store_info():
    return jsonify({**store.stats(), "tables": store.tables()})


@discovery_bp.post("/discovery/cleanup")
def cleanup():
    """Body: {olderThanDays?, keepPerTable?, hostId?, dryRun?} - delete profile
    runs older than N days and/or beyond the newest N per table (Settings >
    Cache & Database). dryRun lists them; a real cleanup compacts afterwards."""
    b = request.get_json(force=True, silent=True) or {}

    def num(k: str) -> int | None:
        v = b.get(k)
        return None if v in (None, "") else max(0, int(v))

    older, keep = num("olderThanDays"), num("keepPerTable")
    if older is None and keep is None:
        return jsonify({"error": "Give olderThanDays and/or keepPerTable"}), 400
    runs = store.select_old(keep_per_table=keep, older_than_days=older, host_id=b.get("hostId") or None)
    if b.get("dryRun"):
        return jsonify({"runs": runs, "count": len(runs), "dryRun": True})
    n = store.delete_profiles([r["id"] for r in runs], vacuum=True)
    return jsonify({"count": n, "store": store.stats()})


@discovery_bp.post("/discovery/compact")
def compact():
    before = store.stats()["bytes"]
    store.compact()
    after = store.stats()
    return jsonify({"freedBytes": max(0, before - after["bytes"]), "store": after})
