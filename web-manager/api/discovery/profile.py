"""Build > Discovery: look at a warehouse table before modeling it.

Three sources, all through the host's AtScale (never a direct warehouse
connection - CLAUDE.md):

  sample      engine GET /v1/datasources/{id}/sample-data/{schema}/{table}
              (AtScaleClient.get_table_sample)
  statistics  engine GET /v1/datasources/{id}/statistics - AtScale's own cached
              RowCount / Cardinality (AtScaleClient.list_datasource_statistics)
  profile     SQL run via POST /wapi/p/data-sources/conn/{id}/query/sample
              (AtScaleClient.query_sample)

The profile SQL is new logic, not a port (like smlgen/): nothing in ps-utils or
PythonAtscaleUtility profiles a table. It is shaped around query/sample's
contract: the engine wraps every query as
`SELECT * FROM (<query>) as_subselect_tmp LIMIT 10` and returns values as
strings, so each query here returns <= 10 rows (one aggregate row, or a
ROW_NUMBER()-ranked top 10 - an ORDER BY inside the subselect isn't honoured by
every dialect) and results are read by position, never by alias (Snowflake
upper-cases unquoted aliases). The engine also caches results by query text for
its lifetime, so each recompute tags the SQL with a comment nonce.
"""

from __future__ import annotations

import re
import time
from concurrent.futures import ThreadPoolExecutor
from typing import Any

#: Columns aggregated per profile query; chunks run in parallel.
CHUNK = 20
TOP_N = 10
SAMPLE_LIMIT = 100

_BACKTICK_DIALECTS = ("databricks", "bigquery", "hive", "spark", "mysql", "mariadb", "impala")
#: Dialects whose SQL can't reference another database: schema.table only.
_TWO_PART_DIALECTS = ("postgres", "redshift", "greenplum", "sqlite")

_NUMERIC = re.compile(r"int|long|short|byte|decimal|numeric|number|double|float|real|money", re.I)
_TEMPORAL = re.compile(r"date|time", re.I)
_BOOLEAN = re.compile(r"bool|bit\b", re.I)
_STRING = re.compile(r"string|char|text|varchar|clob|uuid", re.I)
_KEY_NAME = re.compile(r"(^id$|_id$|key$|_sk$|_fk$|_pk$|code$)", re.I)


def kind_of(data_type: str | None) -> str:
    t = data_type or ""
    if _BOOLEAN.search(t):
        return "boolean"
    if _TEMPORAL.search(t):
        return "temporal"
    if _NUMERIC.search(t):
        return "numeric"
    if _STRING.search(t):
        return "string"
    return "other"


def quote_ident(name: str, dialect: str | None) -> str:
    d = (dialect or "").lower()
    if any(d.startswith(b) for b in _BACKTICK_DIALECTS):
        return "`" + name.replace("`", "``") + "`"
    return '"' + name.replace('"', '""') + '"'


def table_ref(database: str, schema: str, table: str, dialect: str | None) -> str:
    d = (dialect or "").lower()
    parts = [schema, table] if any(d.startswith(p) for p in _TWO_PART_DIALECTS) else [database, schema, table]
    return ".".join(quote_ident(p, dialect) for p in parts if p)


def _nonce() -> str:
    return f" /* env-manager discovery {time.time_ns()} */"


def _rows(result: dict[str, Any]) -> list[list[Any]]:
    """query/sample rows are [{values: [...]}]; tolerate plain lists too."""
    out = []
    for r in result.get("rows") or []:
        out.append(list(r.get("values") or []) if isinstance(r, dict) else list(r))
    return out


def _int(v: Any) -> int | None:
    try:
        return int(float(v))
    except (TypeError, ValueError):
        return None


def _num(v: Any) -> float | None:
    try:
        return float(v)
    except (TypeError, ValueError):
        return None


# -- profile ------------------------------------------------------------------------------
# Scope: the checks from the usual profiling checklist that help someone about
# to model a table and that fit query/sample (one aggregate row or <= 10 rows):
# completeness (NULL / blank / placeholder), uniqueness (distinct, key
# candidates, near-keys, duplicate rows), ranges (min/max/avg, negatives, future
# or pre-1900 dates), formats + types-stored-as-text (from the sample rows, no
# extra scan) and join integrity (join_check). Median/skew, time-series stability
# and functional dependencies don't fit a 10-row, dialect-portable query.

_STRING_SENTINELS = ("N/A", "NA", "#N/A", "NULL", "NONE", "NIL", "-", "--", "?", "UNKNOWN", "MISSING",
                     "UNDEFINED", "TBD", "NAN")
_NUMBER_SENTINELS = (-1, -99, -999, -9999, -99999, 9999999, 99999999)
_MEASURE_NAME = re.compile(r"amount|amt|price|cost|qty|quantity|count|total|revenue|sales|age|units", re.I)
_NUMBER_TEXT = re.compile(r"^[+-]?(\d+([.,]\d+)?|\d{1,3}(,\d{3})+(\.\d+)?)$")
_DATE_TEXT = re.compile(r"^(\d{4}[-/]\d{1,2}[-/]\d{1,2}|\d{1,2}[-/]\d{1,2}[-/]\d{2,4})([ T]\d{1,2}:\d{2}(:\d{2})?.*)?$")


def _stat_exprs(col: dict[str, Any], dialect: str | None) -> list[tuple[str, str]]:
    """(stat, SQL) per column: COUNT / COUNT DISTINCT always; MIN/MAX for
    orderable types; AVG for numbers. Booleans and complex types (arrays,
    structs, variants) skip MIN/MAX - several warehouses reject them."""
    q = quote_ident(col["name"], dialect)
    out = [("nonNull", f"COUNT({q})"), ("distinct", f"COUNT(DISTINCT {q})")]
    if col["kind"] in ("numeric", "temporal", "string"):
        out += [("min", f"MIN({q})"), ("max", f"MAX({q})")]
    if col["kind"] == "numeric":
        out.append(("avg", f"AVG({q})"))
    return out


def _count_if(cond: str) -> str:
    return f"SUM(CASE WHEN {cond} THEN 1 ELSE 0 END)"


def _check_exprs(col: dict[str, Any], dialect: str | None) -> list[tuple[str, str]]:
    """Disguised-missing and plausibility counts. A separate query from the
    stats, so a dialect that rejects one (TRIM, CURRENT_DATE) only loses these."""
    q = quote_ident(col["name"], dialect)
    if col["kind"] == "string":
        sentinels = ", ".join("'" + v.replace("'", "''") + "'" for v in _STRING_SENTINELS)
        return [("blanks", _count_if(f"TRIM({q}) = ''")), ("sentinels", _count_if(f"UPPER(TRIM({q})) IN ({sentinels})"))]
    if col["kind"] == "numeric":
        return [("negatives", _count_if(f"{q} < 0")),
                ("sentinels", _count_if(f"{q} IN ({', '.join(map(str, _NUMBER_SENTINELS))})"))]
    if col["kind"] == "temporal":
        return [("future", _count_if(f"{q} > CURRENT_DATE"))]
    return []


def _aggregate(api, connection_id: str, ref: str, cols: list[dict[str, Any]], dialect: str | None,
               exprs) -> dict[str, dict[str, Any]]:
    plan = [(c["name"], stat, sql) for c in cols for stat, sql in exprs(c, dialect)]
    if not plan:
        return {}
    sql = f"SELECT COUNT(*), {', '.join(s for _, _, s in plan)} FROM {ref}{_nonce()}"
    rows = _rows(api.query_sample(connection_id, sql))
    if not rows:
        raise ValueError("Profile query returned no rows")
    values = rows[0]
    out: dict[str, dict[str, Any]] = {c["name"]: {"_rows": _int(values[0])} for c in cols}
    for (name, stat, _), v in zip(plan, values[1:]):
        out[name][stat] = v
    return out


def _aggregate_cols(api, connection_id: str, ref: str, cols: list[dict[str, Any]], dialect: str | None,
                    exprs) -> dict[str, dict[str, Any]]:
    """One query per chunk; a failing chunk is retried column by column so one
    unsupported type doesn't blank the whole table."""
    try:
        return _aggregate(api, connection_id, ref, cols, dialect, exprs)
    except Exception as e:  # noqa: BLE001 - narrowed below
        if len(cols) == 1:
            return {cols[0]["name"]: {"error": str(e)}}
    out: dict[str, dict[str, Any]] = {}
    for c in cols:
        try:
            out.update(_aggregate(api, connection_id, ref, [c], dialect, exprs))
        except Exception as e:  # noqa: BLE001 - reported on the column
            out[c["name"]] = {"error": str(e)}
    return out


def duplicate_rows(api, connection_id: str, ref: str, cols: list[dict[str, Any]],
                   dialect: str | None) -> dict[str, Any] | None:
    """Fully duplicated rows: groups of identical rows and the surplus rows in
    them. None when a column type can't be grouped on."""
    if not cols or any(c["kind"] == "other" for c in cols):
        return None
    group = ", ".join(quote_ident(c["name"], dialect) for c in cols)
    sql = (f"SELECT COUNT(*), SUM(n) FROM (SELECT COUNT(*) AS n FROM {ref} GROUP BY {group} "
           f"HAVING COUNT(*) > 1) dup{_nonce()}")
    row = _rows(api.query_sample(connection_id, sql))[0]
    groups, rows = _int(row[0]) or 0, _int(row[1]) or 0
    return {"groups": groups, "extraRows": rows - groups}


def _shape(v: str) -> str:
    """Format pattern: letters -> A, digits -> 9, runs collapsed past 3 (A9-999...)."""
    p = re.sub(r"[A-Za-z]", "A", re.sub(r"\d", "9", v))
    return re.sub(r"(A{4,}|9{4,})", lambda m: m.group(0)[:3] + "+", p)


def sample_checks(sample: dict[str, Any] | None, cols: list[dict[str, Any]]) -> dict[str, dict[str, Any]]:
    """Per string column, from the sample rows: format patterns and whether the
    values are numbers or dates stored as text."""
    if not sample or not sample.get("columns"):
        return {}
    index = {n.lower(): i for i, n in enumerate(sample["columns"])}
    out: dict[str, dict[str, Any]] = {}
    for c in cols:
        i = index.get(c["name"].lower())
        if i is None or c["kind"] != "string":
            continue
        values = [str(r[i]).strip() for r in sample["rows"] if i < len(r) and r[i] is not None and str(r[i]).strip()]
        if not values:
            continue
        counts: dict[str, int] = {}
        for v in values:
            counts[_shape(v)] = counts.get(_shape(v), 0) + 1
        patterns = sorted(counts.items(), key=lambda kv: -kv[1])[:3]
        stored = "number" if all(_NUMBER_TEXT.match(v) for v in values) else \
            "date" if all(_DATE_TEXT.match(v) for v in values) else None
        out[c["name"]] = {"patterns": [{"pattern": p, "share": round(100 * n / len(values), 1)} for p, n in patterns],
                          "sampled": len(values), "storedAs": stored}
    return out


def suggest_role(col: dict[str, Any], row_count: int | None) -> tuple[str, str]:
    """(role, why) - a modeling hint for the canvas, not a rule."""
    non_null, distinct = col.get("nonNull"), col.get("distinct")
    if non_null is None or distinct is None:
        return "unknown", "Not profiled"
    if non_null == 0:
        return "empty", "Every value is NULL"
    if distinct == 1:
        return "constant", "A single value"
    if row_count and distinct == row_count and non_null == row_count:
        return "key", "Unique and never NULL - primary key candidate"
    if col["kind"] == "temporal" or col.get("storedAs") == "date":
        return "time", "Date/time - a time dimension level or role-played date"
    if col["kind"] == "numeric" and _KEY_NAME.search(col["name"]):
        return "join", "Looks like a foreign key - join to a dimension"
    if col["kind"] == "numeric" and (distinct > 50 or (row_count and distinct / row_count > 0.05)):
        return "measure", "Numeric with high cardinality - metric candidate"
    return "attribute", "Low cardinality - dimension attribute / level"


def _year(v: Any) -> int | None:
    m = re.match(r"^\s*(\d{4})", str(v or ""))
    return int(m.group(1)) if m else None


def column_flags(col: dict[str, Any], row_count: int | None) -> list[dict[str, str]]:
    """Findings worth a look before modeling: {level: warn|info, text}."""
    flags: list[dict[str, str]] = []

    def add(level: str, text: str) -> None:
        flags.append({"level": level, "text": text})

    n = lambda k: _int(col.get(k)) or 0  # noqa: E731
    if col.get("error"):
        add("warn", f"Not profiled: {col['error']}")
        return flags
    if col.get("nullPct") is not None and 0 < col["nullPct"] < 100 and col["nullPct"] >= 50:
        add("warn", f"{col['nullPct']:g}% NULL")
    if n("blanks"):
        add("warn", f"{n('blanks'):,} blank strings - disguised missing values")
    if n("sentinels"):
        add("warn", f"{n('sentinels'):,} placeholder values ("
            + ("N/A, UNKNOWN, -…" if col["kind"] == "string" else "-1, -999, 9999999…") + ")")
    if n("negatives") and (col["role"] == "measure" or _MEASURE_NAME.search(col["name"])):
        add("info", f"{n('negatives'):,} negative values - returns/adjustments, or bad data?")
    if n("future"):
        add("warn", f"{n('future'):,} dates in the future")
    if col["kind"] == "temporal" and (_year(col.get("min")) or 9999) < 1900:
        add("warn", f"Earliest date {col['min']} - placeholder date?")
    if col["kind"] == "temporal" and (_year(col.get("max")) or 0) >= 9000:
        add("warn", f"Latest date {col['max']} - 'open-ended' placeholder?")
    if col.get("storedAs"):
        add("warn", f"String column holding {col['storedAs']}s - cast it in the dataset")
    pats = col.get("patterns") or []
    if pats and len(pats) > 1 and pats[0]["share"] < 80 and (_KEY_NAME.search(col["name"]) or col["role"] == "key"):
        add("info", f"Mixed formats in sample: {', '.join(p['pattern'] for p in pats)}")
    non_null, distinct = col.get("nonNull"), col.get("distinct")
    if (row_count and non_null and distinct and col["role"] != "key" and _KEY_NAME.search(col["name"])
            and non_null == row_count and 0.98 <= distinct / non_null < 1):
        add("warn", f"{non_null - distinct:,} duplicate values in a key-like column")
    if col["role"] == "attribute" and col["kind"] == "string" and (distinct or 0) > 100_000:
        add("info", f"{distinct:,} distinct values - a very large level")
    return flags


def profile_table(api, connection_id: str, database: str, schema: str, table: str,
                  columns: list[dict[str, Any]], dialect: str | None,
                  sample: dict[str, Any] | None = None) -> dict[str, Any]:
    """Row count, duplicate rows, and per column: nulls / blanks / placeholders,
    distinct, min / max / avg, range checks, formats, a suggested role and flags.
    `columns`: [{name, type}] from the table's metadata; `sample`: sample_rows()."""
    started = time.time()
    ref = table_ref(database, schema, table, dialect)
    cols = [{"name": c["name"], "type": c.get("type"), "kind": kind_of(c.get("type"))} for c in columns]
    chunks = [cols[i:i + CHUNK] for i in range(0, len(cols), CHUNK)]
    stats: dict[str, dict[str, Any]] = {c["name"]: {} for c in cols}
    row_count: int | None = None
    dup: dict[str, Any] | None = None
    dup_error: str | None = None
    if cols:
        with ThreadPoolExecutor(max_workers=4) as pool:
            core = [pool.submit(_aggregate_cols, api, connection_id, ref, ch, dialect, _stat_exprs) for ch in chunks]
            checks = [pool.submit(_aggregate_cols, api, connection_id, ref, ch, dialect, _check_exprs) for ch in chunks]
            dup_f = pool.submit(duplicate_rows, api, connection_id, ref, cols, dialect)
            for f in core:
                for name, s in f.result().items():
                    stats[name].update(s)
            for f in checks:  # a failed check query leaves only the checks empty
                for name, s in f.result().items():
                    stats[name].update({k: v for k, v in s.items() if k not in ("error", "_rows")})
            try:
                dup = dup_f.result()
            except Exception as e:  # noqa: BLE001
                dup_error = str(e)
        row_count = next((s["_rows"] for s in stats.values() if s.get("_rows") is not None), None)
        if row_count is None:  # every column failed: the table itself is unreadable
            raise ValueError(next((s["error"] for s in stats.values() if s.get("error")), "Profile failed"))
    else:
        row_count = _int(_rows(api.query_sample(connection_id, f"SELECT COUNT(*) FROM {ref}{_nonce()}"))[0][0])

    from_sample = sample_checks(sample, cols)
    out_cols = []
    for c in cols:
        s = stats.get(c["name"], {})
        non_null, distinct = _int(s.get("nonNull")), _int(s.get("distinct"))
        row = {**c, "nonNull": non_null, "distinct": distinct, "min": s.get("min"), "max": s.get("max"),
               "avg": _num(s.get("avg")), "error": s.get("error"),
               **{k: _int(s.get(k)) for k in ("blanks", "sentinels", "negatives", "future") if k in s},
               **from_sample.get(c["name"], {})}
        row["nulls"] = row_count - non_null if row_count is not None and non_null is not None else None
        row["nullPct"] = round(100 * row["nulls"] / row_count, 2) if row_count and row["nulls"] is not None else None
        row["distinctPct"] = round(100 * distinct / row_count, 2) if row_count and distinct is not None else None
        row["role"], row["roleWhy"] = suggest_role(row, row_count)
        row["flags"] = column_flags(row, row_count)
        out_cols.append(row)
    return {"table": f"{schema}.{table}", "rowCount": row_count, "columns": out_cols,
            "duplicates": dup, "duplicatesError": dup_error,
            "elapsedMs": int((time.time() - started) * 1000)}


def join_check(api, connection_id: str, database: str, schema: str, table: str, column: str,
               to_schema: str, to_table: str, to_column: str, dialect: str | None) -> dict[str, Any]:
    """Before drawing a join on the canvas: how many of this table's non-NULL
    keys have no match in the target (orphans), and whether the target column is
    unique (if not, the join fans out and inflates every metric)."""
    fq, tq = quote_ident(column, dialect), quote_ident(to_column, dialect)
    src, tgt = table_ref(database, schema, table, dialect), table_ref(database, to_schema, to_table, dialect)
    orphans = _rows(api.query_sample(connection_id, (
        f"SELECT COUNT(f.{fq}), COUNT(DISTINCT f.{fq}), "
        f"{_count_if(f't.{tq} IS NULL AND f.{fq} IS NOT NULL')}, "
        f"COUNT(DISTINCT CASE WHEN t.{tq} IS NULL THEN f.{fq} END) "
        f"FROM {src} f LEFT JOIN (SELECT DISTINCT {tq} FROM {tgt}) t ON f.{fq} = t.{tq}{_nonce()}")))[0]
    target = _rows(api.query_sample(connection_id,
                                    f"SELECT COUNT({tq}), COUNT(DISTINCT {tq}) FROM {tgt}{_nonce()}"))[0]
    sample = _rows(api.query_sample(connection_id, (
        f"SELECT DISTINCT f.{fq} FROM {src} f LEFT JOIN (SELECT DISTINCT {tq} FROM {tgt}) t "
        f"ON f.{fq} = t.{tq} WHERE t.{tq} IS NULL AND f.{fq} IS NOT NULL{_nonce()}")))
    keys, distinct_keys, orphan_rows, orphan_keys = (_int(v) or 0 for v in orphans)
    t_rows, t_distinct = (_int(v) or 0 for v in target)
    return {
        "from": f"{schema}.{table}.{column}", "to": f"{to_schema}.{to_table}.{to_column}",
        "keys": keys, "distinctKeys": distinct_keys, "orphanRows": orphan_rows, "orphanKeys": orphan_keys,
        "orphanPct": round(100 * orphan_rows / keys, 2) if keys else 0.0,
        "orphanSample": [r[0] for r in sample],
        "targetRows": t_rows, "targetDistinct": t_distinct, "targetUnique": t_rows == t_distinct,
    }


def top_values(api, connection_id: str, database: str, schema: str, table: str, column: str,
               dialect: str | None, n: int = TOP_N) -> list[dict[str, Any]]:
    """Most frequent values of one column (NULL included), ranked in the query so
    query/sample's LIMIT 10 keeps the right rows."""
    q = quote_ident(column, dialect)
    ref = table_ref(database, schema, table, dialect)
    sql = (f"SELECT v, c FROM (SELECT {q} AS v, COUNT(*) AS c, "
           f"ROW_NUMBER() OVER (ORDER BY COUNT(*) DESC) AS rn FROM {ref} GROUP BY {q}) ranked "
           f"WHERE rn <= {int(n)}{_nonce()}")
    values = [{"value": r[0], "count": _int(r[1]) or 0} for r in _rows(api.query_sample(connection_id, sql))]
    return sorted(values, key=lambda v: -v["count"])


# -- sample + engine statistics -----------------------------------------------------------

def sample_rows(api, connection_id: str, database: str, schema: str, table: str,
                dialect: str | None, limit: int = SAMPLE_LIMIT) -> dict[str, Any]:
    """Engine sample-data (mcp-develop engine/datasources.py :: parse_sample_data).
    Older engines without /v1/datasources fall back to query/sample (10 rows)."""
    try:
        body = api.get_table_sample(connection_id, database, schema, table, limit)
        cols = [str(c.get("name", "")) if isinstance(c, dict) else str(c) for c in body.get("columns") or []]
        return {"columns": cols, "rows": [list(r) for r in body.get("rows") or [] if isinstance(r, list)],
                "source": "sample-data"}
    except Exception as first:  # noqa: BLE001 - try the older endpoint before giving up
        try:
            result = api.query_sample(connection_id, f"SELECT * FROM {table_ref(database, schema, table, dialect)}")
        except Exception:  # noqa: BLE001
            raise first from None
        cols = [str(c.get("name", "")) if isinstance(c, dict) else str(c) for c in result.get("columns") or []]
        return {"columns": cols, "rows": _rows(result), "source": "query/sample"}


def table_statistics(api, connection_id: str, database: str, schema: str, table: str) -> list[dict[str, Any]]:
    """The engine's cached statistics for one table (mcp-develop
    engine/datasources.py :: _statistic_row), matched case-insensitively. AtScale
    builds older than the /v1/datasources routes answer 404: no statistics."""
    from atscale.client import AtScaleApiError

    try:
        values = api.list_datasource_statistics(connection_id)
    except AtScaleApiError as e:
        if e.status == 404:
            return []
        raise
    out = []
    for v in values:
        descriptor = v.get("descriptor") if isinstance(v.get("descriptor"), dict) else {}
        ds = descriptor.get("dataSet") if isinstance(descriptor.get("dataSet"), dict) else {}
        if str(ds.get("tableName", "")).lower() != table.lower() or str(ds.get("schema", "")).lower() != schema.lower():
            continue
        if ds.get("database") and str(ds["database"]).lower() != database.lower():
            continue
        out.append({
            "type": str(v.get("statisticType", "")),
            "columns": [str(c.get("name", "")) for c in descriptor.get("columns") or [] if isinstance(c, dict)],
            "value": v.get("value"),
            "lastUpdated": v.get("lastUpdated"),
        })
    return out
