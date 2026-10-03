"""Pipeline runs in one SQLite file (workspace/pipeline.db, demo: pipeline-demo.db).

  runs   one row per step a CI job (or the UI's built-in gate) ran here, or
         reported: kind (validate | deploy | test | promote-aggs | rollback |
         promote | report), stage label, model, commit, env, who ran it
         (orchestrator, run ref, URL), status and result. A test's result is
         kept raw; its verdict is scored at read time (stages.summarize).
  tests  the latest test run per (bu, model, commit, env) - what the gates read

Every row is keyed by business unit. Runs beyond ENV_MANAGER_PIPELINE_KEEP per
BU (default 1000) are pruned, oldest first; a run a `tests` row points to is kept.
"""

from __future__ import annotations

import json
import os
import sqlite3
import threading
import uuid
from contextlib import contextmanager
from pathlib import Path
from typing import Any, Iterator

KEEP = int(os.environ.get("ENV_MANAGER_PIPELINE_KEEP", "1000"))

_SCHEMA = """
CREATE TABLE IF NOT EXISTS runs (
  id TEXT PRIMARY KEY, bu TEXT NOT NULL, kind TEXT NOT NULL, stage TEXT, model TEXT, commit_sha TEXT,
  version TEXT, env TEXT, orchestrator TEXT, run_ref TEXT, url TEXT, status TEXT NOT NULL,
  verdict TEXT, result TEXT, error TEXT, job_id TEXT, started_at TEXT NOT NULL, finished_at TEXT,
  duration_s REAL
);
CREATE INDEX IF NOT EXISTS runs_bu ON runs (bu, started_at);
CREATE TABLE IF NOT EXISTS tests (
  bu TEXT NOT NULL, model TEXT NOT NULL, commit_sha TEXT NOT NULL, env TEXT NOT NULL, run_id TEXT NOT NULL,
  PRIMARY KEY (bu, model, commit_sha, env)
);
"""

_path: Path | None = None
_lock = threading.RLock()
_ready: set[Path] = set()


def set_path(path: Path | str) -> None:
    global _path
    _path = Path(path)


def path() -> Path:
    if _path is None:
        raise RuntimeError("pipeline.store path not set")
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
                    # Anything still "running" was cut off by a restart.
                    con.execute("UPDATE runs SET status = 'failed', error = COALESCE(error, 'API restarted during the run') "
                                "WHERE status = 'running'")
                    con.commit()
                    _ready.add(p)
        yield con
        con.commit()
    finally:
        con.close()


_COLS = {"kind": "kind", "stage": "stage", "model": "model", "commit": "commit_sha", "version": "version",
         "env": "env", "orchestrator": "orchestrator", "runRef": "run_ref", "url": "url", "status": "status",
         "verdict": "verdict", "error": "error", "jobId": "job_id", "startedAt": "started_at",
         "finishedAt": "finished_at", "durationS": "duration_s"}


def _row(r: sqlite3.Row) -> dict[str, Any]:
    out = {k: r[c] for k, c in _COLS.items()}
    out["id"] = r["id"]
    out["result"] = json.loads(r["result"]) if r["result"] else None
    return out


def create_run(bu: str, run: dict[str, Any]) -> str:
    run_id = run.get("id") or uuid.uuid4().hex[:12]
    fields = {c: run.get(k) for k, c in _COLS.items()}
    fields["status"] = fields["status"] or "running"
    with _lock, _db() as con:
        con.execute(f"INSERT INTO runs (id, bu, result, {', '.join(fields)}) VALUES (?, ?, ?, {', '.join('?' * len(fields))})",
                    (run_id, bu, json.dumps(run["result"]) if run.get("result") is not None else None, *fields.values()))
        _prune(con, bu)
    return run_id


def update_run(run_id: str, **patch: Any) -> None:
    sets, vals = [], []
    for k, v in patch.items():
        if k == "result":
            sets.append("result = ?")
            vals.append(json.dumps(v) if v is not None else None)
        else:
            sets.append(f"{_COLS[k]} = ?")
            vals.append(v)
    if not sets:
        return
    with _lock, _db() as con:
        con.execute(f"UPDATE runs SET {', '.join(sets)} WHERE id = ?", (*vals, run_id))


def get_run(bu: str, run_id: str) -> dict[str, Any] | None:
    with _db() as con:
        r = con.execute("SELECT * FROM runs WHERE id = ? AND bu = ?", (run_id, bu)).fetchone()
        return _row(r) if r else None


def list_runs(bu: str, limit: int = 200, model: str | None = None) -> list[dict[str, Any]]:
    q, args = "SELECT * FROM runs WHERE bu = ?", [bu]
    if model:
        q += " AND model = ?"
        args.append(model)
    with _db() as con:
        return [_row(r) for r in con.execute(q + " ORDER BY started_at DESC, rowid DESC LIMIT ?", (*args, limit))]


def set_test(bu: str, model: str, commit: str, env: str, run_id: str) -> None:
    with _lock, _db() as con:
        con.execute("INSERT OR REPLACE INTO tests (bu, model, commit_sha, env, run_id) VALUES (?, ?, ?, ?, ?)",
                    (bu, model, commit, env, run_id))


def tests(bu: str) -> dict[tuple[str, str, str], dict[str, Any]]:
    """(model, commit, env) -> the latest test run (with its raw result)."""
    with _db() as con:
        rows = con.execute("SELECT t.model, t.commit_sha AS c, t.env AS e, r.* FROM tests t JOIN runs r ON r.id = t.run_id "
                           "WHERE t.bu = ?", (bu,)).fetchall()
        return {(r["model"], r["c"], r["e"]): _row(r) for r in rows}


def previous_test(bu: str, model: str, env: str, not_commit: str) -> dict[str, Any] | None:
    """The newest finished test of `model` on `env` for another commit - the
    "previous" baseline."""
    with _db() as con:
        r = con.execute("SELECT * FROM runs WHERE bu = ? AND kind = 'test' AND model = ? AND env = ? AND status = 'done' "
                        "AND commit_sha IS NOT ? ORDER BY started_at DESC LIMIT 1", (bu, model, env, not_commit)).fetchone()
        return _row(r) if r else None


def _prune(con: sqlite3.Connection, bu: str) -> None:
    con.execute("DELETE FROM runs WHERE bu = ? AND id NOT IN (SELECT run_id FROM tests WHERE bu = ?) AND id NOT IN "
                "(SELECT id FROM runs WHERE bu = ? ORDER BY started_at DESC LIMIT ?)", (bu, bu, bu, KEEP))
