"""Build > Develop: Preview data - run the canvas's joins, metrics and
attributes as plain warehouse SQL before anything is generated or deployed,
so a wrong join or metric shows up as data.

New logic, not a port (like profile.py). Runs through the same query/sample
interface as the profiler (AtScaleClient.query_sample), so the engine's
contract applies: it wraps the SQL as `SELECT * FROM (<sql>) as_subselect_tmp
LIMIT 10` (engine DatasourceRest.scala :: getQuerySampleData hard-codes the 10),
values come back as strings and are read by position (Snowflake upper-cases
unquoted aliases), and each run carries a comment nonce so the engine's
per-text cache never serves a stale result.

The web builds the join tree from the canvas (web/src/build/lib/dataPreview.ts:
fact -> dimensions -> snowflaked dimensions, one alias per role-play); this
module only quotes it into SQL.

  tables   [{alias, schema, table, parent?, on: [[parentColumn, column], ...]}]
           the first entry is the root; every other one joins its parent
  columns  [{alias, column, agg?}]  agg (SUM / MIN / MAX / COUNT /
           COUNT DISTINCT / AVG) only in aggregate mode
"""

from __future__ import annotations

import json
import re
import time
from concurrent.futures import ThreadPoolExecutor
from typing import Any

from .profile import _int, _rows, quote_ident, table_ref

ROW_LIMIT = 10  # the engine's, not ours - see the module docstring
MODES = ("rows", "aggregate", "check")

_AGG_SQL = {"SUM": "SUM({})", "MIN": "MIN({})", "MAX": "MAX({})", "COUNT": "COUNT({})",
            "COUNT DISTINCT": "COUNT(DISTINCT {})", "AVG": "AVG({})"}
_ALIAS = re.compile(r"^t\d{1,3}$")


class PreviewError(ValueError):
    """A request the SQL can't be built from (-> 400)."""


class InvalidSourceError(PreviewError):
    """The picked data source doesn't have the canvas's tables - usually the
    Source panel was switched to another warehouse after the tables were
    added (-> 422, `invalidSource`)."""


# How warehouses word "no such table", as the engine passes it through:
# Postgres / Redshift `relation "s.t" does not exist`, Snowflake `Object 'X'
# does not exist or not authorized`, Databricks / Spark `Table or view not
# found` / TABLE_OR_VIEW_NOT_FOUND, BigQuery `Not found: Table`, SQL Server
# `Invalid object name`, generic `... doesn't exist` / `unknown table`.
_MISSING_TABLE = re.compile(
    r"does not exist|doesn't exist|not found|TABLE_OR_VIEW_NOT_FOUND|Invalid object name|unknown table|no such table",
    re.I)
_ENGINE_MESSAGE = re.compile(r'"message"\s*:\s*"((?:[^"\\]|\\.)*)"')


def _engine_message(e: Exception) -> str:
    """The warehouse's own words from an AtScale error, not the whole JSON
    envelope + Node stack trace (AtScaleApiError.body)."""
    body = getattr(e, "body", None) or str(e)
    m = _ENGINE_MESSAGE.search(body)
    try:
        text = json.loads(f'"{m.group(1)}"') if m else str(e)
    except ValueError:
        text = m.group(1)
    text = text.removeprefix("Problem getting query sample data: ")
    return " ".join(text.split())[:400]


def _query(api, connection_id: str, sql: str, tables: list[dict[str, Any]], database: str) -> dict[str, Any]:
    try:
        return api.query_sample(connection_id, sql)
    except Exception as e:  # noqa: BLE001 - reworded below
        msg = _engine_message(e)
        if _MISSING_TABLE.search(msg):
            names = ", ".join(sorted({f"{t.get('schema')}.{t['table']}" if t.get("schema") else t["table"] for t in tables}))
            raise InvalidSourceError(
                f"Invalid data source: {connection_id} · {database} doesn't have the canvas's tables ({names}). "
                f"Pick the data source these tables were added from. Warehouse said: {msg}") from None
        raise PreviewError(f"The warehouse rejected the preview query: {msg}") from None


def _nonce() -> str:
    return f" /* env-manager data preview {time.time_ns()} */"


def _check_tree(tables: list[dict[str, Any]]) -> dict[str, dict[str, Any]]:
    if not tables:
        raise PreviewError("Pick at least one metric or attribute")
    by_alias: dict[str, dict[str, Any]] = {}
    for i, t in enumerate(tables):
        alias = t.get("alias") or ""
        if not _ALIAS.match(alias) or alias in by_alias:
            raise PreviewError(f"Bad table alias '{alias}'")
        if not t.get("table"):
            raise PreviewError(f"Table missing for {alias}")
        if i == 0:
            if t.get("parent"):
                raise PreviewError("The first table is the root - it has no parent")
        else:
            if t.get("parent") not in by_alias:
                raise PreviewError(f"{t['table']} joins a table that isn't listed before it")
            if not t.get("on"):
                raise PreviewError(f"{t['table']} has no join columns")
        by_alias[alias] = t
    return by_alias


def _from_clause(tables: list[dict[str, Any]], database: str, dialect: str | None) -> str:
    """Root, then LEFT JOINs: a fact row with no matching dimension row stays
    (NULL attributes) instead of silently vanishing, so orphans show."""
    q = lambda n: quote_ident(n, dialect)  # noqa: E731
    root = tables[0]
    sql = f"{table_ref(database, root.get('schema') or '', root['table'], dialect)} {root['alias']}"
    for t in tables[1:]:
        on = " AND ".join(f"{t['parent']}.{q(pc)} = {t['alias']}.{q(c)}" for pc, c in t["on"])
        sql += f" LEFT JOIN {table_ref(database, t.get('schema') or '', t['table'], dialect)} {t['alias']} ON {on}"
    return sql


def build_sql(tables: list[dict[str, Any]], columns: list[dict[str, Any]], mode: str,
              database: str, dialect: str | None) -> str:
    if mode not in ("rows", "aggregate"):
        raise PreviewError(f"Unknown mode '{mode}'")
    by_alias = _check_tree(tables)
    if not columns:
        raise PreviewError("Pick at least one metric or attribute")
    q = lambda n: quote_ident(n, dialect)  # noqa: E731
    select, group = [], []
    for i, c in enumerate(columns):
        if c.get("alias") not in by_alias or not c.get("column"):
            raise PreviewError(f"Column {c.get('column')} refers to an unknown table")
        ref = f"{c['alias']}.{q(c['column'])}"
        agg = c.get("agg") if mode == "aggregate" else None
        if agg:
            if agg not in _AGG_SQL:
                raise PreviewError(f"Unknown aggregation '{agg}'")
            select.append(f"{_AGG_SQL[agg].format(ref)} AS c{i}")
        else:
            select.append(f"{ref} AS c{i}")
            group.append(ref)
    sql = f"SELECT {', '.join(select)} FROM {_from_clause(tables, database, dialect)}"
    if mode == "aggregate" and group and len(group) < len(columns):
        sql += f" GROUP BY {', '.join(group)}"
    return sql


def check_sql(tables: list[dict[str, Any]], database: str, dialect: str | None) -> tuple[str, str]:
    """(root count, joined counts): rows before the joins, rows after (more =
    a join fans out and inflates every metric), and per joined table how many
    rows found a match (fewer = orphan keys)."""
    _check_tree(tables)
    q = lambda n: quote_ident(n, dialect)  # noqa: E731
    root = tables[0]
    root_sql = f"SELECT COUNT(*) FROM {table_ref(database, root.get('schema') or '', root['table'], dialect)}"
    matched = [f"COUNT({t['alias']}.{q(t['on'][0][1])})" for t in tables[1:]]
    joined_sql = f"SELECT {', '.join(['COUNT(*)', *matched])} FROM {_from_clause(tables, database, dialect)}"
    return root_sql, joined_sql


def run(api, connection_id: str, database: str, dialect: str | None, tables: list[dict[str, Any]],
        columns: list[dict[str, Any]], mode: str) -> dict[str, Any]:
    started = time.time()
    if mode == "check":
        root_sql, joined_sql = check_sql(tables, database, dialect)
        with ThreadPoolExecutor(max_workers=2) as pool:
            root_f = pool.submit(_query, api, connection_id, root_sql + _nonce(), tables[:1], database)
            joined_f = pool.submit(_query, api, connection_id, joined_sql + _nonce(), tables, database)
            root_n = _int((_rows(root_f.result()) or [[None]])[0][0])
            counts = [_int(v) for v in ((_rows(joined_f.result()) or [[]])[0])]
        joined_n = counts[0] if counts else None
        joins = [{"alias": t["alias"], "table": t["table"], "parent": t["parent"],
                  "on": t["on"], "matched": counts[i + 1] if i + 1 < len(counts) else None}
                 for i, t in enumerate(tables[1:])]
        return {"mode": mode, "sql": f"{root_sql};\n{joined_sql}", "rootRows": root_n, "joinedRows": joined_n,
                "fanOut": root_n is not None and joined_n is not None and joined_n > root_n,
                "joins": joins, "elapsedMs": int((time.time() - started) * 1000)}
    sql = build_sql(tables, columns, mode, database, dialect)
    result = _query(api, connection_id, sql + _nonce(), tables, database)
    rows = [r[: len(columns)] for r in _rows(result)]
    return {"mode": mode, "sql": sql, "rows": rows, "limit": ROW_LIMIT,
            "elapsedMs": int((time.time() - started) * 1000)}
