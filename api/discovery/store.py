"""Discovery results in one SQLite file (workspace/discovery.db, demo:
discovery-demo.db), so a table is read from the warehouse once, not on every
visit - a profile scans the whole table.

  profiles  one row per profile run of a table (discovery/profile.py ::
            profile_table), result as zlib JSON; the history is what drift
            (row count change, columns added / dropped / retyped) compares.
            At most ENV_MANAGER_DISCOVERY_KEEP runs per table (default 20).
  items     the latest of everything else per table - sample rows, AtScale's
            statistics, a column's top values, a join check - keyed by
            (kind, item_key), replaced on refresh.

Same layout and helpers as testing/store.py.
"""

from __future__ import annotations

import json
import os
import sqlite3
import threading
import zlib
from datetime import datetime, timedelta, timezone
from contextlib import contextmanager
from pathlib import Path
from typing import Any, Iterator

KEEP_PER_TABLE = int(os.environ.get("ENV_MANAGER_DISCOVERY_KEEP", "20"))

_SCHEMA = """
CREATE TABLE IF NOT EXISTS profiles (
  id INTEGER PRIMARY KEY AUTOINCREMENT, host_id TEXT NOT NULL, connection_id TEXT NOT NULL,
  database_name TEXT NOT NULL, schema_name TEXT NOT NULL, table_name TEXT NOT NULL,
  profiled_at TEXT NOT NULL, row_count INTEGER, column_count INTEGER NOT NULL, elapsed_ms INTEGER NOT NULL,
  columns TEXT NOT NULL, data BLOB NOT NULL
);
CREATE INDEX IF NOT EXISTS profiles_table
  ON profiles (host_id, connection_id, database_name, schema_name, table_name, profiled_at);
CREATE TABLE IF NOT EXISTS items (
  host_id TEXT NOT NULL, connection_id TEXT NOT NULL, database_name TEXT NOT NULL, schema_name TEXT NOT NULL,
  table_name TEXT NOT NULL, kind TEXT NOT NULL, item_key TEXT NOT NULL, fetched_at TEXT NOT NULL, data BLOB NOT NULL,
  PRIMARY KEY (host_id, connection_id, database_name, schema_name, table_name, kind, item_key)
);
"""

_TABLE = "host_id = ? AND connection_id = ? AND database_name = ? AND schema_name = ? AND table_name = ?"

_path: Path | None = None
_lock = threading.RLock()
_ready: set[Path] = set()

#: (host_id, connection_id, database, schema, table)
TableKey = tuple[str, str, str, str, str]


def set_path(path: Path | str) -> None:
    global _path
    _path = Path(path)


def path() -> Path:
    if _path is None:
        raise RuntimeError("discovery.store path not set")
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


def _pack(data: Any) -> bytes:
    return zlib.compress(json.dumps(data, separators=(",", ":"), default=str).encode("utf-8"))


def _unpack(blob: bytes | None) -> Any:
    return None if blob is None else json.loads(zlib.decompress(blob).decode("utf-8"))


# -- items -------------------------------------------------------------------------------

def get_item(key: TableKey, kind: str, item_key: str = "") -> tuple[Any, str] | None:
    """(data, fetched_at) or None."""
    with _db() as con:
        r = con.execute(f"SELECT data, fetched_at FROM items WHERE {_TABLE} AND kind = ? AND item_key = ?",
                        (*key, kind, item_key)).fetchone()
    return (_unpack(r["data"]), r["fetched_at"]) if r else None


def put_item(key: TableKey, kind: str, item_key: str, data: Any, fetched_at: str) -> None:
    with _lock, _db() as con:
        con.execute("INSERT OR REPLACE INTO items VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
                    (*key, kind, item_key, fetched_at, _pack(data)))


# -- profiles ----------------------------------------------------------------------------

def add_profile(key: TableKey, profile: dict[str, Any], profiled_at: str, keep: int = KEEP_PER_TABLE) -> int:
    cols = [{"name": c["name"], "type": c.get("type")} for c in profile.get("columns", [])]
    with _lock, _db() as con:
        cur = con.execute(
            "INSERT INTO profiles (host_id, connection_id, database_name, schema_name, table_name, profiled_at, "
            "row_count, column_count, elapsed_ms, columns, data) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
            (*key, profiled_at, profile.get("rowCount"), len(cols), profile.get("elapsedMs") or 0,
             json.dumps(cols), _pack(profile)))
        con.execute(f"DELETE FROM profiles WHERE {_TABLE} AND id NOT IN "
                    f"(SELECT id FROM profiles WHERE {_TABLE} ORDER BY id DESC LIMIT ?)", (*key, *key, max(1, keep)))
        return int(cur.lastrowid)


def get_profile(key: TableKey, profile_id: int | None = None, before_id: int | None = None
                ) -> tuple[dict[str, Any], str, int] | None:
    """(profile, profiled_at, id): the newest run, run `profile_id`, or the
    newest run older than `before_id` (the one drift compares against)."""
    sql, args = f"SELECT id, profiled_at, data FROM profiles WHERE {_TABLE}", list(key)
    if profile_id is not None:
        sql, args = sql + " AND id = ?", [*args, profile_id]
    if before_id is not None:
        sql, args = sql + " AND id < ?", [*args, before_id]
    with _db() as con:
        r = con.execute(sql + " ORDER BY id DESC LIMIT 1", args).fetchone()
    return (_unpack(r["data"]), r["profiled_at"], r["id"]) if r else None


def history(key: TableKey, limit: int = KEEP_PER_TABLE) -> list[dict[str, Any]]:
    """Newest first: {id, profiledAt, rowCount, columnCount, elapsedMs, columns[{name, type}]}."""
    with _db() as con:
        rows = con.execute(f"SELECT id, profiled_at, row_count, column_count, elapsed_ms, columns FROM profiles "
                           f"WHERE {_TABLE} ORDER BY id DESC LIMIT ?", (*key, limit)).fetchall()
    return [{"id": r["id"], "profiledAt": r["profiled_at"], "rowCount": r["row_count"],
             "columnCount": r["column_count"], "elapsedMs": r["elapsed_ms"], "columns": json.loads(r["columns"])}
            for r in rows]


def drift(current: dict[str, Any], previous: dict[str, Any] | None) -> dict[str, Any] | None:
    """What changed since the previous profile run of the same table."""
    if not previous:
        return None
    now = {c["name"].lower(): c for c in current["columns"]}
    before = {c["name"].lower(): c for c in previous["columns"]}
    rc, prc = current.get("rowCount"), previous.get("rowCount")
    shifts = []
    for k, c in now.items():
        p = before.get(k)
        if not p:
            continue
        if c.get("nullPct") is not None and p.get("nullPct") is not None and abs(c["nullPct"] - p["nullPct"]) >= 5:
            shifts.append({"name": c["name"], "what": "nullPct", "from": p["nullPct"], "to": c["nullPct"]})
        cd, pd = c.get("distinct"), p.get("distinct")
        if cd is not None and pd and pd >= 10 and abs(cd - pd) / pd >= 0.2:
            shifts.append({"name": c["name"], "what": "distinct", "from": pd, "to": cd})
    return {
        "since": previous["profiledAt"],
        "rowCount": prc,
        "rowDelta": rc - prc if rc is not None and prc is not None else None,
        "rowDeltaPct": round(100 * (rc - prc) / prc, 2) if rc is not None and prc else None,
        "added": [now[k]["name"] for k in now if k not in before],
        "removed": [before[k]["name"] for k in before if k not in now],
        "retyped": [{"name": now[k]["name"], "from": before[k].get("type"), "to": now[k].get("type")}
                    for k in now if k in before and (now[k].get("type") or "") != (before[k].get("type") or "")],
        # NULL % moved >= 5 points, or distinct count moved >= 20%
        "shifts": shifts,
    }


# -- housekeeping ------------------------------------------------------------------------

def tables(host_id: str | None = None) -> list[dict[str, Any]]:
    """Every table with anything stored: newest profile, run count, bytes."""
    where, args = ("WHERE host_id = ?", (host_id,)) if host_id else ("", ())
    with _db() as con:
        rows = con.execute(
            "SELECT host_id, connection_id, database_name, schema_name, table_name, COUNT(*) AS runs, "
            f"MAX(profiled_at) AS newest, SUM(LENGTH(data)) AS bytes FROM profiles {where} "
            "GROUP BY host_id, connection_id, database_name, schema_name, table_name ORDER BY newest DESC", args).fetchall()
    return [{"hostId": r["host_id"], "connectionId": r["connection_id"], "database": r["database_name"],
             "schema": r["schema_name"], "table": r["table_name"], "runs": r["runs"], "newest": r["newest"],
             "bytes": r["bytes"] or 0} for r in rows]


def select_old(keep_per_table: int | None = None, older_than_days: int | None = None,
               host_id: str | None = None) -> list[dict[str, Any]]:
    """Profile runs a cleanup would delete: older than N days and/or beyond the
    newest N of their table, optionally one host's only. Oldest first."""
    if keep_per_table is None and older_than_days is None:
        return []
    conds, args = [], []
    if older_than_days is not None:
        cutoff = (datetime.now(timezone.utc) - timedelta(days=older_than_days)).strftime("%Y-%m-%dT%H:%M:%SZ")
        conds.append("profiled_at < ?")
        args.append(cutoff)
    if keep_per_table is not None:
        conds.append("rn > ?")
        args.append(keep_per_table)
    where = "WHERE (" + " OR ".join(conds) + ")"
    if host_id:
        where += " AND host_id = ?"
        args.append(host_id)
    with _db() as con:
        rows = con.execute(
            "SELECT * FROM (SELECT id, host_id, schema_name, table_name, profiled_at, ROW_NUMBER() OVER ("
            "PARTITION BY host_id, connection_id, database_name, schema_name, table_name ORDER BY id DESC) AS rn "
            f"FROM profiles) {where} ORDER BY profiled_at", args).fetchall()
    return [{"id": r["id"], "hostId": r["host_id"], "table": f"{r['schema_name']}.{r['table_name']}",
             "profiledAt": r["profiled_at"]} for r in rows]


def delete_profiles(ids: list[int], vacuum: bool = False) -> int:
    """Delete profile runs; a table left with none loses its stored items too,
    so its next visit starts fresh."""
    if not ids:
        return 0
    with _lock, _db() as con:
        n = 0
        for i in range(0, len(ids), 500):
            chunk = ids[i:i + 500]
            n += con.execute(f"DELETE FROM profiles WHERE id IN ({','.join('?' * len(chunk))})", chunk).rowcount
        con.execute("DELETE FROM items WHERE NOT EXISTS (SELECT 1 FROM profiles p WHERE p.host_id = items.host_id "
                    "AND p.connection_id = items.connection_id AND p.database_name = items.database_name "
                    "AND p.schema_name = items.schema_name AND p.table_name = items.table_name)")
    if vacuum:
        compact()
    return n


def compact() -> None:
    with _lock:
        con = sqlite3.connect(path(), timeout=30)
        try:
            con.execute("PRAGMA wal_checkpoint(TRUNCATE)")
            con.execute("VACUUM")
        finally:
            con.close()


def stats() -> dict[str, Any]:
    with _db() as con:
        n_profiles = con.execute("SELECT COUNT(*) FROM profiles").fetchone()[0]
        n_items = con.execute("SELECT COUNT(*) FROM items").fetchone()[0]
        n_tables = con.execute("SELECT COUNT(*) FROM (SELECT DISTINCT host_id, connection_id, database_name, "
                               "schema_name, table_name FROM profiles)").fetchone()[0]
    size = sum(p.stat().st_size for p in (path(), path().with_name(path().name + "-wal")) if p.exists())
    return {"path": str(path()), "profiles": n_profiles, "items": n_items, "tables": n_tables, "bytes": size,
            "keepPerTable": KEEP_PER_TABLE}
