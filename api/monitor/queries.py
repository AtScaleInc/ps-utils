"""One AtScale query-history row -> the record Monitor stores and reports on.

Rows come from GET /wapi/p/queries (SML-develop apps/api/src/queries/model/query.dto.ts
:: QueryDTO, filled by query.mapper.ts): durations are already milliseconds,
startTime is epoch ms, `optimization` holds "AGGS" and/or "CACHE".

How a query is classified (`cls`), first match wins:
  cache  optimization has CACHE - a subquery was answered from the engine's local
         result cache (engine QueryExecutor.scala, used_local_cache) - or the query
         succeeded without sending any subquery ("fully cache-served",
         engine QueryInfoPostgresDao.scala)
  agg    optimization has AGGS, or the row lists aggregate definitions
  raw    everything else: the warehouse answered it without an aggregate
"""

from __future__ import annotations

import json
from typing import Any

CLASSES = ("cache", "agg", "raw")


def _ms(event: dict[str, Any] | None) -> float:
    # PythonAtscaleUtility queries/query_history_base.py :: QueryHistoryBase._safe_get_duration
    try:
        v = (event or {}).get("duration")
        return float(v) if v is not None else 0.0
    except (TypeError, ValueError):
        return 0.0


def classify(optimization: list[str], aggregates: list[str], subqueries: int, status: str) -> str:
    opt = {str(o).upper() for o in optimization or []}
    if "CACHE" in opt:
        return "cache"
    if "AGGS" in opt or aggregates:
        return "agg"
    if status == "successful" and subqueries == 0:
        return "cache"
    return "raw"


def normalize(row: dict[str, Any]) -> dict[str, Any]:
    """Ported from PythonAtscaleUtility queries/query_history_container.py ::
    QueryHistoryContainer._parse_query (events -> planning / wall / outbound ms,
    subquery count, aggregatesTables -> used aggregate), extended with the other
    QueryDTO fields the dashboard reports on."""
    events = [e for e in row.get("events") or [] if isinstance(e, dict)]
    by_name = {e.get("name"): e for e in events}
    outbound = by_name.get("Outbound") or {}
    subqueries = [s for s in outbound.get("subqueries") or [] if isinstance(s, dict)]
    optimization = [str(o) for o in row.get("optimization") or []]
    aggregates = [str(a) for a in row.get("aggregates") or []]
    status = str(row.get("status") or "successful").lower()
    duration = row.get("duration")
    return {
        "queryId": str(row.get("queryId") or ""),
        "startMs": int(row.get("startTime") or 0),
        "durationMs": float(duration) if duration is not None else _ms(by_name.get("Inbound Query")),
        "status": status,
        "queryType": row.get("queryType") or "User",
        "userId": row.get("userId") or "",
        "user": row.get("user") or row.get("userId") or "",
        "catalogId": row.get("catalogId") or "",
        "catalogName": row.get("catalogName") or "",
        "modelId": row.get("modelId") or "",
        "modelName": row.get("modelName") or "",
        "dialect": row.get("dialect") or "",
        "optimization": optimization,
        "cls": classify(optimization, aggregates, len(subqueries), status),
        "aggregates": aggregates,
        "aggTables": [str(t) for t in row.get("aggregatesTables") or []],
        "attributes": [str(a) for a in row.get("attributes") or []],
        "measures": [str(m) for m in row.get("measures") or []],
        "planningMs": _ms(by_name.get("Planning")),
        "outboundMs": _ms(outbound),
        "processingMs": _ms(by_name.get("Result Processing")),
        "subqueries": len(subqueries),
        "failedMessage": row.get("failedMessage") or "",
        "events": [{"name": e.get("name"), "startTime": e.get("startTime"), "duration": _ms(e),
                    "subqueries": [{"name": s.get("name"), "subqueryId": s.get("subqueryId"),
                                    "startTime": s.get("startTime"), "duration": _ms(s)} for s in e.get("subqueries") or []
                                   if isinstance(s, dict)]}
                   for e in events],
    }


def pair_counts(records: list[dict[str, Any]], limit: int = 25) -> list[dict[str, Any]]:
    """(dimension attribute x measure) occurrences, ported from ps-utils
    src/operations/extract-query-stats-from-atscale/ExtractQueryStatsFromAtScaleOperation.ts
    :: processQueries (an attribute- or measure-only query counts against null).
    Adds the pair's average duration and how many of its queries missed an
    aggregate, so warehouse-heavy pairs surface as aggregate candidates. Only
    user queries that name a field count (ps-utils asks for querySource=user;
    system queries - aggregate builds, canaries - have none)."""
    counts: dict[tuple[str | None, str | None], dict[str, Any]] = {}
    for r in records:
        if r["queryType"] == "System" or not (r["attributes"] or r["measures"]):
            continue
        attrs: list[str | None] = list(r["attributes"]) or [None]
        measures: list[str | None] = list(r["measures"]) or [None]
        for a in attrs:
            for m in measures:
                c = counts.setdefault((a, m), {"attribute": a, "measure": m, "count": 0, "raw": 0, "totalMs": 0.0})
                c["count"] += 1
                c["totalMs"] += r["durationMs"]
                if r["cls"] == "raw":
                    c["raw"] += 1
    rows = [{**c, "avgMs": c.pop("totalMs") / c["count"]} for c in counts.values()]
    rows.sort(key=lambda c: (-c["raw"], -c["count"]))
    return rows[:limit]


def dumps(v: Any) -> str:
    return json.dumps(v, separators=(",", ":"))
