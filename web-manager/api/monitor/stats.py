"""Report maths over stored query records (pure - unit-tested).

Latency figures use finished queries only (running ones have no final duration).

Aggregate hit rate - AtScale's measure of how well its aggregates cover the
workload - is agg / (agg + raw) over successful queries of the scope: user
queries unless the report is filtered to System (system queries are mostly
aggregate builds, which always read the warehouse). `hits` carries the three
counts so the UI can also count cache hits as hits: (agg + cache) / all three.
"""

from __future__ import annotations

import math
from collections import Counter, defaultdict
from typing import Any

from monitor.queries import CLASSES, pair_counts
from monitor.store import NONE

_MIN = 60 * 1000
# (max window span, bucket size): about 24-100 buckets whatever the window.
_BUCKETS = [(2 * 60 * _MIN, 5 * _MIN), (12 * 60 * _MIN, 15 * _MIN), (2 * 1440 * _MIN, 60 * _MIN),
            (14 * 1440 * _MIN, 360 * _MIN)]


def bucket_ms(span_ms: int) -> int:
    for limit, size in _BUCKETS:
        if span_ms <= limit:
            return size
    return 1440 * _MIN


def percentile(values: list[float], p: float) -> float | None:
    """Nearest-rank percentile."""
    if not values:
        return None
    s = sorted(values)
    return s[max(0, math.ceil(p / 100 * len(s)) - 1)]


def _lat(values: list[float]) -> dict[str, float | None]:
    return {"avg": sum(values) / len(values) if values else None, "p50": percentile(values, 50),
            "p95": percentile(values, 95), "max": max(values) if values else None}


def _done(r: dict[str, Any]) -> bool:
    return r["status"] != "running"


def hits(rows: list[dict[str, Any]], user_only: bool = True) -> dict[str, Any]:
    """{agg, cache, raw} over the successful queries hit rate is measured on,
    plus rate = agg / (agg + raw) (None when nothing is eligible)."""
    c = Counter(r["cls"] for r in rows
                if r["status"] == "successful" and (not user_only or r["queryType"] == "User"))
    out = {k: c.get(k, 0) for k in CLASSES}
    return {**out, "rate": out["agg"] / (out["agg"] + out["raw"]) if out["agg"] + out["raw"] else None}


def _mix(rows: list[dict[str, Any]], user_only: bool = True) -> dict[str, Any]:
    c = Counter(r["cls"] for r in rows)
    done = [r["durationMs"] for r in rows if _done(r)]
    return {"count": len(rows), **{k: c.get(k, 0) for k in CLASSES},
            "failed": sum(r["status"] == "failed" for r in rows), "p50": percentile(done, 50),
            "p95": percentile(done, 95), "avg": sum(done) / len(done) if done else None,
            "hits": hits(rows, user_only)}


def overview(records: list[dict[str, Any]], from_ms: int, to_ms: int, tz_offset_min: int = 0,
             user_only: bool = True) -> dict[str, Any]:
    """KPIs, the cache / aggregate / raw mix, hit rate, volume + p95 latency
    over time, latency per class, top models and users. tz_offset_min: minutes
    east of UTC, so day buckets start at local midnight. user_only: hit rate
    over user queries only (False when the report is filtered to System)."""
    size = bucket_ms(max(to_ms - from_ms, 1))
    off = tz_offset_min * _MIN

    def floor(t: int) -> int:
        return (t + off) // size * size - off

    buckets: dict[int, list[dict[str, Any]]] = defaultdict(list)
    for r in records:
        buckets[floor(r["startMs"])].append(r)
    series = []
    t = floor(from_ms)
    while t <= to_ms:
        rows = buckets.get(t, [])
        done = [r["durationMs"] for r in rows if _done(r)]
        series.append({"t": t, **{k: sum(r["cls"] == k for r in rows) for k in CLASSES},
                       "failed": sum(r["status"] == "failed" for r in rows), "p95": percentile(done, 95),
                       "hits": hits(rows, user_only)})
        t += size

    by_cls = {k: _lat([r["durationMs"] for r in records if r["cls"] == k and _done(r)]) for k in CLASSES}

    def top(key: str) -> list[dict[str, Any]]:
        groups: dict[str, list[dict[str, Any]]] = defaultdict(list)
        for r in records:
            groups[r[key] or NONE].append(r)
        rows = [{"name": name, **_mix(rs, user_only)} for name, rs in groups.items()]
        return sorted(rows, key=lambda x: -x["count"])[:10]

    done = [r["durationMs"] for r in records if _done(r)]
    mix = _mix(records, user_only)
    served = mix["cache"] + mix["agg"]
    return {
        "fromMs": from_ms, "toMs": to_ms, "bucketMs": size,
        "totals": {**mix, "running": sum(r["status"] == "running" for r in records),
                   "servedPct": served / mix["count"] * 100 if mix["count"] else None,
                   "users": len({r["user"] for r in records if r["user"]}),
                   "models": len({r["modelName"] for r in records if r["modelName"]}), **_lat(done)},
        "byClass": by_cls,
        "byType": {t: _mix([r for r in records if r["queryType"] == t], t == "User") for t in ("User", "System")},
        "hitScope": "User" if user_only else "System",
        "series": series,
        "byModel": top("modelName"),
        "byUser": top("user"),
    }


def hotspots(records: list[dict[str, Any]], limit: int = 20, user_only: bool = True) -> dict[str, Any]:
    """Where to act: slowest queries, models leaning on the warehouse, the
    attribute x measure pairs that most often miss an aggregate, repeated failures."""
    done = [r for r in records if _done(r)]
    slowest = sorted(done, key=lambda r: -r["durationMs"])[:limit]
    models: dict[str, list[dict[str, Any]]] = defaultdict(list)
    for r in records:
        models[r["modelName"] or NONE].append(r)
    model_rows = []
    for name, rs in models.items():
        raw = [r for r in rs if r["cls"] == "raw"]
        model_rows.append({"name": name, "count": len(rs), "raw": len(raw), "rawPct": len(raw) / len(rs) * 100,
                           "rawP95": percentile([r["durationMs"] for r in raw if _done(r)], 95),
                           "p95": percentile([r["durationMs"] for r in rs if _done(r)], 95),
                           "hits": hits(rs, user_only)})
    model_rows.sort(key=lambda m: (-m["raw"], -m["count"]))
    failures: dict[str, list[dict[str, Any]]] = defaultdict(list)
    for r in records:
        if r["status"] == "failed":
            failures[(r["failedMessage"] or "(no message)").strip().splitlines()[0][:300]].append(r)
    fail_rows = sorted(({"message": m, "count": len(rs), "lastMs": max(r["startMs"] for r in rs),
                         "models": sorted({r["modelName"] for r in rs if r["modelName"]})}
                        for m, rs in failures.items()), key=lambda f: -f["count"])[:10]
    return {"slowest": slowest, "warehouseModels": model_rows[:limit], "pairs": pair_counts(records, limit),
            "failures": fail_rows}
