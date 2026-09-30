"""Monitor's query history in one SQLite file (workspace/monitor.db, demo: monitor-demo.db).

  queries  one row per (host, AtScale query id) - the normalised /wapi/p/queries row
           (monitor/queries.py), upserted so a query seen running is updated once it
           finishes; `text` / `agg_defs` are filled the first time its detail is opened
  polls    one row per pull from a host: the window asked for, rows fetched / new,
           whether the page cap cut it short, and any error

Reports read only from here, so they cover every poll, not just the latest.
Queries older than ENV_MANAGER_MONITOR_MAX_AGE_DAYS (default 90) are pruned after
every poll; cleanup() does the same on demand.
"""

from __future__ import annotations

import json
import os
import sqlite3
import threading
import time
from contextlib import contextmanager
from pathlib import Path
from typing import Any, Iterator

from monitor.queries import dumps

MAX_AGE_DAYS = int(os.environ.get("ENV_MANAGER_MONITOR_MAX_AGE_DAYS", "90"))

_SCHEMA = """
CREATE TABLE IF NOT EXISTS queries (
  host_id TEXT NOT NULL, query_id TEXT NOT NULL, start_ms INTEGER NOT NULL, duration_ms REAL NOT NULL,
  status TEXT NOT NULL, query_type TEXT NOT NULL, user_id TEXT, user_name TEXT, catalog_id TEXT, catalog_name TEXT,
  model_id TEXT, model_name TEXT, dialect TEXT, cls TEXT NOT NULL, optimization TEXT NOT NULL,
  aggregates TEXT NOT NULL, agg_tables TEXT NOT NULL, attributes TEXT NOT NULL, measures TEXT NOT NULL,
  planning_ms REAL, outbound_ms REAL, processing_ms REAL, subqueries INTEGER NOT NULL, failed_message TEXT,
  events TEXT NOT NULL, text TEXT, agg_defs TEXT, fetched_at INTEGER NOT NULL,
  PRIMARY KEY (host_id, query_id)
);
CREATE INDEX IF NOT EXISTS queries_time ON queries (host_id, start_ms);
CREATE TABLE IF NOT EXISTS polls (
  id INTEGER PRIMARY KEY AUTOINCREMENT, host_id TEXT NOT NULL, polled_at INTEGER NOT NULL,
  from_ms INTEGER NOT NULL, to_ms INTEGER, fetched INTEGER NOT NULL, added INTEGER NOT NULL,
  pages INTEGER NOT NULL, truncated INTEGER NOT NULL DEFAULT 0, error TEXT
);
CREATE INDEX IF NOT EXISTS polls_host ON polls (host_id, polled_at);
"""

_path: Path | None = None
_lock = threading.RLock()
_ready: set[Path] = set()


def set_path(path: Path | str) -> None:
    """Point the store somewhere else (tests use a temp file)."""
    global _path
    _path = Path(path)


def path() -> Path:
    if _path is None:
        raise RuntimeError("monitor.store path not set")
    return _path


@contextmanager
def _db() -> Iterator[sqlite3.Connection]:
    p = path()
    p.parent.mkdir(parents=True, exist_ok=True)
    con = sqlite3.connect(p, timeout=30, check_same_thread=False)
    con.row_factory = sqlite3.Row
    try:
        if p not in _ready:
            with _lock:
                if p not in _ready:
                    con.execute("PRAGMA journal_mode = WAL")
                    con.executescript(_SCHEMA)
                    con.commit()
                    _ready.add(p)
        yield con
        con.commit()
    finally:
        con.close()


# -- writes ---------------------------------------------------------------------------------

_COLS = ("host_id, query_id, start_ms, duration_ms, status, query_type, user_id, user_name, catalog_id, catalog_name, "
         "model_id, model_name, dialect, cls, optimization, aggregates, agg_tables, attributes, measures, planning_ms, "
         "outbound_ms, processing_ms, subqueries, failed_message, events, fetched_at")


def upsert(host_id: str, records: list[dict[str, Any]]) -> int:
    """Insert or refresh rows; returns how many query ids were new. Opened
    detail (text, aggregate definitions) is kept."""
    if not records:
        return 0
    now = int(time.time() * 1000)
    rows = [(host_id, r["queryId"], r["startMs"], r["durationMs"], r["status"], r["queryType"], r["userId"], r["user"],
             r["catalogId"], r["catalogName"], r["modelId"], r["modelName"], r["dialect"], r["cls"],
             dumps(r["optimization"]), dumps(r["aggregates"]), dumps(r["aggTables"]), dumps(r["attributes"]),
             dumps(r["measures"]), r["planningMs"], r["outboundMs"], r["processingMs"], r["subqueries"],
             r["failedMessage"], dumps(r["events"]), now) for r in records if r["queryId"]]
    updates = ", ".join(f"{c.strip()} = excluded.{c.strip()}" for c in _COLS.split(",")[2:])
    with _lock, _db() as con:
        before = con.execute("SELECT COUNT(*) FROM queries WHERE host_id = ?", (host_id,)).fetchone()[0]
        con.executemany(f"INSERT INTO queries ({_COLS}) VALUES ({', '.join('?' * len(rows[0]))}) "
                        f"ON CONFLICT (host_id, query_id) DO UPDATE SET {updates}", rows)
        after = con.execute("SELECT COUNT(*) FROM queries WHERE host_id = ?", (host_id,)).fetchone()[0]
    return after - before


def add_poll(host_id: str, from_ms: int, to_ms: int | None, fetched: int, added: int, pages: int,
             truncated: bool, error: str | None) -> None:
    with _lock, _db() as con:
        con.execute("INSERT INTO polls (host_id, polled_at, from_ms, to_ms, fetched, added, pages, truncated, error) "
                    "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
                    (host_id, int(time.time() * 1000), from_ms, to_ms, fetched, added, pages, int(truncated), error))
        # Keep the poll log short: the last 200 per host.
        con.execute("DELETE FROM polls WHERE host_id = ? AND id NOT IN "
                    "(SELECT id FROM polls WHERE host_id = ? ORDER BY id DESC LIMIT 200)", (host_id, host_id))


def set_detail(host_id: str, query_id: str, text: str | None = None, agg_defs: list[dict[str, Any]] | None = None) -> None:
    with _lock, _db() as con:
        if text is not None:
            con.execute("UPDATE queries SET text = ? WHERE host_id = ? AND query_id = ?", (text, host_id, query_id))
        if agg_defs is not None:
            con.execute("UPDATE queries SET agg_defs = ? WHERE host_id = ? AND query_id = ?",
                        (dumps(agg_defs), host_id, query_id))


def _cutoff_ms(days: int) -> int:
    return int((time.time() - days * 86400) * 1000)


def delete_queries(older_than_days: int | None = None, host_id: str | None = None, model: str | None = None,
                   dry_run: bool = False) -> int:
    """Stored queries matching every given rule: started more than N days ago,
    on a host, of a model. No rule = everything. Deleting all of a host's rows
    makes its next poll start over at the default window."""
    clauses, args = [], []
    if older_than_days is not None:
        clauses.append("start_ms < ?")
        args.append(_cutoff_ms(older_than_days))
    if host_id:
        clauses.append("host_id = ?")
        args.append(host_id)
    if model:
        clauses.append("model_name = ?")
        args.append(model)
    where = " AND ".join(clauses) or "1 = 1"
    with _lock, _db() as con:
        if dry_run:
            return con.execute(f"SELECT COUNT(*) FROM queries WHERE {where}", args).fetchone()[0]
        return con.execute(f"DELETE FROM queries WHERE {where}", args).rowcount


def delete_host(host_id: str) -> int:
    if not path().exists():
        return 0
    with _lock, _db() as con:
        con.execute("DELETE FROM polls WHERE host_id = ?", (host_id,))
        return con.execute("DELETE FROM queries WHERE host_id = ?", (host_id,)).rowcount


def prune(max_age_days: int | None = MAX_AGE_DAYS) -> int:
    return delete_queries(max_age_days) if max_age_days else 0


def compact() -> None:
    with _lock, _db() as con:
        con.commit()
        con.execute("PRAGMA wal_checkpoint(TRUNCATE)")
        con.execute("VACUUM")


# -- reads ----------------------------------------------------------------------------------

def _row(r: sqlite3.Row, detail: bool = False) -> dict[str, Any]:
    out = {
        "queryId": r["query_id"], "startMs": r["start_ms"], "durationMs": r["duration_ms"], "status": r["status"],
        "queryType": r["query_type"], "userId": r["user_id"], "user": r["user_name"], "catalogId": r["catalog_id"],
        "catalogName": r["catalog_name"], "modelId": r["model_id"], "modelName": r["model_name"],
        "dialect": r["dialect"], "cls": r["cls"], "optimization": json.loads(r["optimization"]),
        "aggregates": json.loads(r["aggregates"]), "aggTables": json.loads(r["agg_tables"]),
        "attributes": json.loads(r["attributes"]), "measures": json.loads(r["measures"]),
        "planningMs": r["planning_ms"], "outboundMs": r["outbound_ms"], "processingMs": r["processing_ms"],
        "subqueries": r["subqueries"], "failedMessage": r["failed_message"],
    }
    if detail:
        out["events"] = json.loads(r["events"])
        out["text"] = r["text"]
        out["aggDefs"] = json.loads(r["agg_defs"]) if r["agg_defs"] else None
    return out


# What the reports call a query without a model / user (system queries often have none);
# as a model or user filter it matches exactly those.
NONE = "(none)"


def _filters(host_id: str, f: dict[str, Any]) -> tuple[str, list[Any]]:
    """f: fromMs, toMs, model, user, queryType, cls, status, q (query id / user / model contains)."""
    where, args = ["host_id = ?"], [host_id]
    if f.get("fromMs") is not None:
        where.append("start_ms >= ?")
        args.append(int(f["fromMs"]))
    if f.get("toMs") is not None:
        where.append("start_ms <= ?")
        args.append(int(f["toMs"]))
    for key, col in (("model", "model_name"), ("user", "user_name"), ("queryType", "query_type"),
                     ("cls", "cls"), ("status", "status")):
        if f.get(key) == NONE and key in ("model", "user"):
            where.append(f"({col} IS NULL OR {col} = '')")
        elif f.get(key):
            where.append(f"{col} = ?")
            args.append(f[key])
    if f.get("q"):
        where.append("(query_id LIKE ? OR user_name LIKE ? OR model_name LIKE ? OR text LIKE ?)")
        args.extend([f"%{f['q']}%"] * 4)
    return " AND ".join(where), args


def select(host_id: str, f: dict[str, Any]) -> list[dict[str, Any]]:
    """Every matching row (no events/text) - what the reports aggregate over."""
    where, args = _filters(host_id, f)
    with _db() as con:
        return [_row(r) for r in con.execute(f"SELECT * FROM queries WHERE {where} ORDER BY start_ms DESC", args)]


_SORTS = {"startMs": "start_ms", "durationMs": "duration_ms", "subqueries": "subqueries"}


def page(host_id: str, f: dict[str, Any], sort: str = "-startMs", limit: int = 100, offset: int = 0
         ) -> tuple[list[dict[str, Any]], int]:
    where, args = _filters(host_id, f)
    col = _SORTS.get(sort.lstrip("-"), "start_ms")
    order = "DESC" if sort.startswith("-") else "ASC"
    with _db() as con:
        total = con.execute(f"SELECT COUNT(*) FROM queries WHERE {where}", args).fetchone()[0]
        rows = con.execute(f"SELECT * FROM queries WHERE {where} ORDER BY {col} {order}, query_id LIMIT ? OFFSET ?",
                           [*args, limit, offset])
        return [_row(r) for r in rows], total


def get(host_id: str, query_id: str) -> dict[str, Any] | None:
    with _db() as con:
        r = con.execute("SELECT * FROM queries WHERE host_id = ? AND query_id = ?", (host_id, query_id)).fetchone()
        return _row(r, detail=True) if r else None


def newest_start(host_id: str) -> int | None:
    with _db() as con:
        return con.execute("SELECT MAX(start_ms) FROM queries WHERE host_id = ?", (host_id,)).fetchone()[0]


def oldest_running(host_id: str) -> int | None:
    with _db() as con:
        return con.execute("SELECT MIN(start_ms) FROM queries WHERE host_id = ? AND status = 'running'",
                           (host_id,)).fetchone()[0]


def host_status(host_id: str) -> dict[str, Any]:
    with _db() as con:
        c = con.execute("SELECT COUNT(*), MIN(start_ms), MAX(start_ms) FROM queries WHERE host_id = ?",
                        (host_id,)).fetchone()
        p = con.execute("SELECT * FROM polls WHERE host_id = ? ORDER BY id DESC LIMIT 1", (host_id,)).fetchone()
    last = None if p is None else {
        "polledAt": p["polled_at"], "fromMs": p["from_ms"], "toMs": p["to_ms"], "fetched": p["fetched"],
        "added": p["added"], "pages": p["pages"], "truncated": bool(p["truncated"]), "error": p["error"]}
    return {"stored": c[0], "oldestMs": c[1], "newestMs": c[2], "lastPoll": last}


def stats() -> dict[str, Any]:
    p = path()
    size = sum(f.stat().st_size for f in (p, p.with_name(p.name + "-wal")) if f.exists())
    with _db() as con:
        hosts = [{"hostId": r[0], "queries": r[1], "oldestMs": r[2], "newestMs": r[3], "models": []} for r in con.execute(
            "SELECT host_id, COUNT(*), MIN(start_ms), MAX(start_ms) FROM queries GROUP BY host_id ORDER BY host_id")]
        by_host = {h["hostId"]: h for h in hosts}
        for r in con.execute("SELECT host_id, model_name, COUNT(*), MIN(start_ms), MAX(start_ms) FROM queries "
                             "GROUP BY host_id, model_name ORDER BY host_id, COUNT(*) DESC"):
            by_host[r[0]]["models"].append({"model": r[1] or "", "queries": r[2], "oldestMs": r[3], "newestMs": r[4]})
    return {"path": str(p), "bytes": size, "queries": sum(h["queries"] for h in hosts), "hosts": hosts,
            "maxAgeDays": MAX_AGE_DAYS}
