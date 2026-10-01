"""Test runs in one SQLite file (workspace/tests.db, demo: tests-demo.db).

  runs        one row per run: status, targets, options, counters, model check
  queries     the generated queries a run executed
  models      each host's DMV model snapshot at run time (testing/model.py)
  executions  one row per (run, host, protocol, query): status, time, row
              count, checksum, and the result rows as zlib-compressed JSON
              (testing/results.py shape) for compare

Executions are written as they finish, so an API restart mid-run keeps what's
done (the run is then marked failed on start-up). After every run, runs are
pruned: at most ENV_MANAGER_TEST_KEEP per model (default 100) and none older
than ENV_MANAGER_TEST_MAX_AGE_DAYS (default 90); cleanup() does the same on
demand and compacts the file. Runs saved by the earlier JSON
layout (workspace/tests/*.json) are imported once and the folder renamed.
"""

from __future__ import annotations

import json
import os
import shutil
import sqlite3
import threading
import zlib
from contextlib import contextmanager
from pathlib import Path
from typing import Any, Iterator

KEEP_PER_MODEL = int(os.environ.get("ENV_MANAGER_TEST_KEEP", "100"))
MAX_AGE_DAYS = int(os.environ.get("ENV_MANAGER_TEST_MAX_AGE_DAYS", "90"))

_SCHEMA = """
CREATE TABLE IF NOT EXISTS runs (
  run_id TEXT PRIMARY KEY, status TEXT NOT NULL, started_at TEXT NOT NULL, finished_at TEXT,
  model TEXT, catalog TEXT, targets TEXT NOT NULL, protocols TEXT NOT NULL, options TEXT NOT NULL,
  concurrency INTEGER NOT NULL, total INTEGER NOT NULL, done INTEGER NOT NULL DEFAULT 0,
  failed INTEGER NOT NULL DEFAULT 0, error TEXT, model_check TEXT NOT NULL DEFAULT '{}'
);
CREATE INDEX IF NOT EXISTS runs_model ON runs (model, started_at);
CREATE TABLE IF NOT EXISTS queries (
  run_id TEXT NOT NULL REFERENCES runs(run_id) ON DELETE CASCADE, query_id TEXT NOT NULL,
  position INTEGER NOT NULL, body TEXT NOT NULL, PRIMARY KEY (run_id, query_id)
);
CREATE TABLE IF NOT EXISTS models (
  run_id TEXT NOT NULL REFERENCES runs(run_id) ON DELETE CASCADE, host_id TEXT NOT NULL,
  snapshot TEXT NOT NULL, PRIMARY KEY (run_id, host_id)
);
CREATE TABLE IF NOT EXISTS executions (
  run_id TEXT NOT NULL REFERENCES runs(run_id) ON DELETE CASCADE, host_id TEXT NOT NULL,
  protocol TEXT NOT NULL, query_id TEXT NOT NULL, query_name TEXT NOT NULL, host TEXT, env TEXT,
  catalog TEXT, model TEXT, run_query_id TEXT, status TEXT NOT NULL, duration_ms INTEGER NOT NULL,
  row_count INTEGER NOT NULL, checksum TEXT, error TEXT, ts INTEGER, text_hash TEXT, text TEXT,
  data BLOB, PRIMARY KEY (run_id, host_id, protocol, query_id)
);
CREATE INDEX IF NOT EXISTS executions_history ON executions (model, query_name, protocol, host_id);
"""

_path: Path | None = None
_lock = threading.RLock()  # writes hold it while _db() may take it for first-time schema setup
_ready: set[Path] = set()


def set_path(path: Path | str) -> None:
    """Point the store somewhere else (tests use a temp file)."""
    global _path
    _path = Path(path)


def path() -> Path:
    if _path is None:
        raise RuntimeError("testing.store path not set")
    return _path


@contextmanager
def _db() -> Iterator[sqlite3.Connection]:
    p = path()
    p.parent.mkdir(parents=True, exist_ok=True)
    con = sqlite3.connect(p, timeout=30, check_same_thread=False)
    con.row_factory = sqlite3.Row
    con.execute("PRAGMA foreign_keys = ON")
    try:
        if p not in _ready:
            with _lock:
                if p not in _ready:
                    con.execute("PRAGMA journal_mode = WAL")
                    con.executescript(_SCHEMA)
                    # Anything still "running" was cut off by a restart.
                    con.execute("UPDATE runs SET status = 'failed', error = COALESCE(error, 'API restarted during the run') "
                                "WHERE status = 'running'")
                    con.commit()
                    _ready.add(p)
        yield con
        con.commit()
    finally:
        con.close()


def _pack(data: Any) -> bytes | None:
    return None if data is None else zlib.compress(json.dumps(data, separators=(",", ":")).encode("utf-8"))


def _unpack(blob: bytes | None) -> Any:
    return None if blob is None else json.loads(zlib.decompress(blob).decode("utf-8"))


# -- writes ---------------------------------------------------------------------------------

def create_run(run: dict[str, Any], queries: list[dict[str, Any]]) -> None:
    first = (run.get("targets") or [{}])[0]
    with _lock, _db() as con:
        con.execute(
            "INSERT INTO runs (run_id, status, started_at, finished_at, model, catalog, targets, protocols, options, "
            "concurrency, total, done, failed, error, model_check) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
            (run["runId"], run["status"], run["startedAt"], run.get("finishedAt"), first.get("cube"), first.get("catalog"),
             json.dumps(run["targets"]), json.dumps(run["protocols"]), json.dumps(run["options"]), run["concurrency"],
             run["total"], run.get("done", 0), run.get("failed", 0), run.get("error"), json.dumps(run.get("modelCheck") or {})))
        con.executemany("INSERT INTO queries (run_id, query_id, position, body) VALUES (?,?,?,?)",
                        [(run["runId"], q["id"], i, json.dumps(q)) for i, q in enumerate(queries)])


def finish_run(run_id: str, status: str, finished_at: str, error: str | None = None) -> None:
    with _lock, _db() as con:
        con.execute("UPDATE runs SET status = ?, finished_at = ?, error = ? WHERE run_id = ?", (status, finished_at, error, run_id))


def set_model(run_id: str, host_id: str, snapshot: dict[str, Any]) -> None:
    with _lock, _db() as con:
        con.execute("INSERT OR REPLACE INTO models (run_id, host_id, snapshot) VALUES (?,?,?)", (run_id, host_id, json.dumps(snapshot)))


def set_model_check(run_id: str, check: dict[str, Any]) -> None:
    with _lock, _db() as con:
        con.execute("UPDATE runs SET model_check = ? WHERE run_id = ?", (json.dumps(check), run_id))


def add_execution(rec: dict[str, Any], data: Any) -> None:
    with _lock, _db() as con:
        con.execute(
            "INSERT OR REPLACE INTO executions (run_id, host_id, protocol, query_id, query_name, host, env, catalog, model, "
            "run_query_id, status, duration_ms, row_count, checksum, error, ts, text_hash, text, data) "
            "VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
            (rec["runId"], rec["hostId"], rec["protocol"], rec["queryId"], rec["queryName"], rec.get("host"), rec.get("env"),
             rec.get("catalog"), rec.get("model"), rec.get("runQueryId"), rec["status"], rec["durationMs"], rec["rowCount"],
             rec.get("checksum"), rec.get("error"), rec.get("timestamp"), rec.get("originalTextHash"), rec.get("originalText"),
             _pack(data)))
        con.execute("UPDATE runs SET done = done + 1, failed = failed + ? WHERE run_id = ?",
                    (1 if rec["status"] == "FAILED" else 0, rec["runId"]))


def delete_run(run_id: str) -> bool:
    with _lock, _db() as con:
        return con.execute("DELETE FROM runs WHERE run_id = ?", (run_id,)).rowcount > 0


def _cutoff(days: int | None) -> str | None:
    if days is None:
        return None
    from datetime import datetime, timedelta, timezone

    return (datetime.now(timezone.utc) - timedelta(days=days)).strftime("%Y-%m-%dT%H:%M:%SZ")


def select_old(keep_per_model: int | None = None, older_than_days: int | None = None, model: str | None = None,
               before: str | None = None) -> list[dict[str, Any]]:
    """Finished runs matching any of: beyond the newest `keep_per_model` of
    their model, started more than `older_than_days` ago / before `before`.
    `model` limits it to one model. Running runs are never selected."""
    cutoff = before or _cutoff(older_than_days)
    with _db() as con:
        rows = con.execute("SELECT run_id, model, started_at FROM runs WHERE status != 'running'"
                           + (" AND model = ?" if model else "") + " ORDER BY model, started_at DESC",
                           (model,) if model else ()).fetchall()
    out, seen = [], {}
    for r in rows:
        seen[r["model"]] = seen.get(r["model"], 0) + 1
        beyond = keep_per_model is not None and seen[r["model"]] > keep_per_model
        old = cutoff is not None and r["started_at"] < cutoff
        if beyond or old:
            out.append({"runId": r["run_id"], "model": r["model"], "startedAt": r["started_at"]})
    return out


def delete_runs(run_ids: list[str], vacuum: bool = False) -> int:
    with _lock, _db() as con:
        n = sum(con.execute("DELETE FROM runs WHERE run_id = ?", (i,)).rowcount for i in run_ids)
    if vacuum:
        compact()
    return n


def compact() -> None:
    """Give deleted pages back to the filesystem."""
    with _lock, _db() as con:
        con.commit()
        con.execute("PRAGMA wal_checkpoint(TRUNCATE)")
        con.execute("VACUUM")


def prune(model: str | None, keep: int = KEEP_PER_MODEL, max_age_days: int | None = MAX_AGE_DAYS) -> int:
    """Automatic retention after a run: the model's runs beyond `keep`, and
    any run older than `max_age_days`."""
    ids = {r["runId"] for r in select_old(keep_per_model=keep, model=model)}
    ids |= {r["runId"] for r in select_old(older_than_days=max_age_days)} if max_age_days else set()
    return delete_runs(sorted(ids)) if ids else 0


# -- reads ----------------------------------------------------------------------------------

def _run_row(r: sqlite3.Row) -> dict[str, Any]:
    return {"runId": r["run_id"], "status": r["status"], "startedAt": r["started_at"], "finishedAt": r["finished_at"],
            "model": r["model"], "catalog": r["catalog"], "targets": json.loads(r["targets"]),
            "protocols": json.loads(r["protocols"]), "options": json.loads(r["options"]), "concurrency": r["concurrency"],
            "total": r["total"], "done": r["done"], "failed": r["failed"], "error": r["error"],
            "modelCheck": json.loads(r["model_check"] or "{}")}


def _exec_row(r: sqlite3.Row) -> dict[str, Any]:
    return {"runId": r["run_id"], "hostId": r["host_id"], "host": r["host"], "env": r["env"], "catalog": r["catalog"],
            "model": r["model"], "queryId": r["query_id"], "queryName": r["query_name"], "runQueryId": r["run_query_id"],
            "protocol": r["protocol"], "status": r["status"], "durationMs": r["duration_ms"], "rowCount": r["row_count"],
            "checksum": r["checksum"] or "", "error": r["error"] or "", "timestamp": r["ts"],
            "originalTextHash": r["text_hash"], "originalText": r["text"], "hasData": r["has_data"]}


_EXEC_COLS = ("run_id, host_id, host, env, catalog, model, query_id, query_name, run_query_id, protocol, status, "
              "duration_ms, row_count, checksum, error, ts, text_hash, text, data IS NOT NULL AS has_data")


def list_runs(model: str | None = None) -> list[dict[str, Any]]:
    with _db() as con:
        sql, args = "SELECT * FROM runs", ()
        if model:
            sql, args = sql + " WHERE model = ?", (model,)
        return [_run_row(r) for r in con.execute(sql + " ORDER BY started_at DESC", args)]


def get_run(run_id: str) -> dict[str, Any] | None:
    with _db() as con:
        r = con.execute("SELECT * FROM runs WHERE run_id = ?", (run_id,)).fetchone()
        if not r:
            return None
        run = _run_row(r)
        run["queries"] = [json.loads(q["body"]) for q in
                          con.execute("SELECT body FROM queries WHERE run_id = ? ORDER BY position", (run_id,))]
        run["models"] = {m["host_id"]: json.loads(m["snapshot"]) for m in
                         con.execute("SELECT host_id, snapshot FROM models WHERE run_id = ?", (run_id,))}
        run["results"] = [_exec_row(e) for e in con.execute(
            f"SELECT {_EXEC_COLS} FROM executions WHERE run_id = ? ORDER BY ts", (run_id,))]
        return run


def read_data(run_id: str, host_id: str, protocol: str, query_id: str) -> Any:
    with _db() as con:
        r = con.execute("SELECT data FROM executions WHERE run_id = ? AND host_id = ? AND protocol = ? AND query_id = ?",
                        (run_id, host_id, protocol, query_id)).fetchone()
        return _unpack(r["data"]) if r else None


def history(model: str, query_name: str, protocol: str | None = None, limit: int = 50) -> list[dict[str, Any]]:
    """One query's executions across runs, newest first, with the run's start time."""
    with _db() as con:
        sql = (f"SELECT {', '.join('e.' + c.strip() for c in _EXEC_COLS.split(', ')[:-1])}, e.data IS NOT NULL AS has_data, "
               "r.started_at FROM executions e JOIN runs r ON r.run_id = e.run_id WHERE e.model = ? AND e.query_name = ?")
        args: list[Any] = [model, query_name]
        if protocol:
            sql += " AND e.protocol = ?"
            args.append(protocol)
        rows = con.execute(sql + " ORDER BY r.started_at DESC, e.host_id LIMIT ?", (*args, limit)).fetchall()
        return [{**_exec_row(r), "startedAt": r["started_at"]} for r in rows]


def stats() -> dict[str, Any]:
    with _db() as con:
        n_runs = con.execute("SELECT COUNT(*) FROM runs").fetchone()[0]
        n_exec = con.execute("SELECT COUNT(*) FROM executions").fetchone()[0]
        models = [{"model": r["model"], "runs": r["runs"], "oldest": r["oldest"], "newest": r["newest"],
                   "executions": r["executions"], "dataBytes": r["data_bytes"] or 0}
                  for r in con.execute(
                      "SELECT r.model, COUNT(DISTINCT r.run_id) AS runs, MIN(r.started_at) AS oldest, "
                      "MAX(r.started_at) AS newest, COUNT(e.run_id) AS executions, SUM(LENGTH(e.data)) AS data_bytes "
                      "FROM runs r LEFT JOIN executions e ON e.run_id = r.run_id GROUP BY r.model ORDER BY newest DESC")]
    size = sum(p.stat().st_size for p in (path(), path().with_name(path().name + "-wal")) if p.exists())
    return {"path": str(path()), "runs": n_runs, "executions": n_exec, "bytes": size, "models": models,
            "keepPerModel": KEEP_PER_MODEL, "maxAgeDays": MAX_AGE_DAYS}


# -- one-time import of the JSON layout -------------------------------------------------------

def import_json_dir(folder: Path) -> int:
    """Load runs from <folder>/<runId>.json (+ <folder>/<runId>/<host>/<protocol>/<query>.json
    result rows), then rename the folder to <folder>-imported so it's done once."""
    if not folder.is_dir():
        return 0
    n = 0
    for f in sorted(folder.glob("*.json")):
        try:
            run = json.loads(f.read_text(encoding="utf-8"))
        except (OSError, ValueError):
            continue
        if get_run(run.get("runId", "")) is not None:
            continue
        if run.get("status") == "running":
            run["status"], run["error"] = "failed", run.get("error") or "Interrupted (imported)"
        run.setdefault("done", 0)
        run.setdefault("failed", 0)
        results = run.get("results") or []
        run["done"], run["failed"] = 0, 0  # add_execution counts them again
        create_run(run, run.get("queries") or [])
        for host_id, snap in (run.get("models") or {}).items():
            set_model(run["runId"], host_id, snap)
        if run.get("modelCheck"):
            set_model_check(run["runId"], run["modelCheck"])
        for rec in results:
            p = folder / run["runId"] / rec["hostId"] / rec["protocol"] / f"{rec['queryId']}.json"
            data = json.loads(p.read_text(encoding="utf-8")) if p.is_file() else None
            add_execution(rec, data)
        finish_run(run["runId"], run["status"], run.get("finishedAt") or run["startedAt"], run.get("error"))
        n += 1
    target = folder.with_name(folder.name + "-imported")
    if not target.exists():
        shutil.move(str(folder), str(target))
    return n
