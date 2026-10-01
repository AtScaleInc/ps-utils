"""Result data for the Test tab's compare: a query's rows in one shape for both
protocols, and a variance diff between two of them.

Shape: {"keys": [key column names], "measures": [measure column names],
        "rows": [{"key": [..], "label": [..], "values": [..]}]}
  MDX - rows are the Axis1 tuples (key = member unique names, label =
        captions), measures are the Axis0 tuples, values the CellData
        <Value>s by CellOrdinal. No Axis1 (a metric total) is one row with an
        empty key - atscale/preview.py parse_xmla_result returns nothing then.
  SQL - key = the non-metric columns, measures = the query's metric columns.
"""

from __future__ import annotations

import math
import xml.etree.ElementTree as ET
from typing import Any

_NS = "{urn:schemas-microsoft-com:xml-analysis:mddataset}"
MAX_ROWS = 20000


def _tuples(axis: ET.Element | None) -> list[tuple[list[str], list[str]]]:
    out = []
    if axis is None:
        return out
    for t in axis.iter(f"{_NS}Tuple"):
        unames, captions = [], []
        for m in t.iter(f"{_NS}Member"):
            un, cap = m.find(f"{_NS}UName"), m.find(f"{_NS}Caption")
            unames.append(un.text if un is not None and un.text else "")
            captions.append(cap.text if cap is not None and cap.text is not None else (un.text if un is not None else ""))
        out.append((unames, captions))
    return out


def mdx_rows(xml_text: str) -> dict[str, Any]:
    root = ET.fromstring(xml_text)
    data = root.find(f".//{_NS}root")
    if data is None:
        return {"keys": [], "measures": [], "rows": []}
    axes = {a.get("name"): a for a in data.iter(f"{_NS}Axis")}
    cols = _tuples(axes.get("Axis0"))
    rows = _tuples(axes.get("Axis1")) or [([], [])]
    cells: dict[int, Any] = {}
    for c in data.iter(f"{_NS}Cell"):
        v = c.find(f"{_NS}Value")
        cells[int(c.get("CellOrdinal", "0"))] = v.text if v is not None else None
    ncols = max(1, len(cols))
    out = [{"key": un, "label": cap, "values": [cells.get(r * ncols + i) for i in range(len(cols))]}
           for r, (un, cap) in enumerate(rows[:MAX_ROWS])]
    depth = len(rows[0][0]) if rows else 0
    return {"keys": [f"Axis1[{i}]" for i in range(depth)], "measures": [" - ".join(c[1]) for c in cols], "rows": out,
            "truncated": len(rows) > MAX_ROWS}


def sql_rows(columns: list[str], rows: list[list[Any]], metrics: list[str]) -> dict[str, Any]:
    mset = set(metrics)
    kidx = [i for i, c in enumerate(columns) if c not in mset]
    midx = [i for i, c in enumerate(columns) if c in mset]
    out = [{"key": [str(r[i]) for i in kidx], "label": [str(r[i]) for i in kidx], "values": [r[i] for i in midx]}
           for r in rows[:MAX_ROWS]]
    return {"keys": [columns[i] for i in kidx], "measures": [columns[i] for i in midx], "rows": out,
            "truncated": len(rows) > MAX_ROWS}


def _num(v: Any) -> float | None:
    if v is None or v == "":
        return None
    try:
        f = float(v)
        return None if math.isnan(f) else f
    except (TypeError, ValueError):
        return None


def compare(a: dict[str, Any] | None, b: dict[str, Any] | None, tolerance: float = 1e-9, limit: int = 200) -> dict[str, Any]:
    """Rows matched on key; per measure, a numeric variance (b - a, % of a)
    beyond `tolerance` (relative) or any non-numeric mismatch is a diff."""
    if a is None or b is None:
        return {"status": "missing", "rowsA": len((a or {}).get("rows", [])), "rowsB": len((b or {}).get("rows", []))}
    # Keys aren't always unique (a level whose name repeats, e.g. a month name
    # keyed by day): rows sharing a key are sorted by their values and paired in
    # order, so row order in the response never makes equal results differ.
    def index(side: dict[str, Any]) -> tuple[dict[tuple, dict[str, Any]], int]:
        groups: dict[tuple, list[dict[str, Any]]] = {}
        for r in side["rows"]:
            groups.setdefault(tuple(r["key"]), []).append(r)
        out, dup = {}, 0
        for k, rows in groups.items():
            if len(rows) > 1:
                dup += 1
                rows = sorted(rows, key=lambda r: [str(v) for v in r["values"]])
            for i, r in enumerate(rows):
                out[k + ((i,) if len(rows) > 1 else ())] = r
        return out, dup

    ra, dup_a = index(a)
    rb, dup_b = index(b)
    measures = a["measures"] if a["measures"] == b["measures"] else [m for m in a["measures"] if m in b["measures"]]
    ia = {m: a["measures"].index(m) for m in measures}
    ib = {m: b["measures"].index(m) for m in measures}
    only_a = [ra[k]["label"] for k in ra if k not in rb]
    only_b = [rb[k]["label"] for k in rb if k not in ra]
    diffs, n_diff_rows, max_pct = [], 0, 0.0
    for k in ra.keys() & rb.keys():
        row_diff = False
        for m in measures:
            va, vb = ra[k]["values"][ia[m]], rb[k]["values"][ib[m]]
            na, nb = _num(va), _num(vb)
            if na is not None and nb is not None:
                # INF on both sides (a growth % over a zero period) is equal:
                # inf - inf is NaN, which isn't <= anything - and NaN isn't JSON.
                # INF on one side differs (the relative tolerance would be inf too).
                if na == nb:
                    continue
                if math.isinf(na) or math.isinf(nb):
                    delta, pct = None, None
                    max_pct = math.inf
                elif abs(nb - na) <= tolerance * max(1.0, abs(na), abs(nb)):
                    continue
                else:
                    delta = nb - na
                    pct = (delta / abs(na) * 100) if na else None
                    max_pct = max(max_pct, abs(pct) if pct is not None else math.inf)
            elif (va or "") == (vb or ""):
                continue
            else:
                delta, pct = None, None
                max_pct = math.inf
            row_diff = True
            if len(diffs) < limit:
                diffs.append({"label": ra[k]["label"], "measure": m, "a": va, "b": vb, "delta": delta, "pct": pct})
        n_diff_rows += row_diff
    schema = a["measures"] != b["measures"] or a["keys"] != b["keys"]
    identical = not (only_a or only_b or n_diff_rows or schema)
    return {
        "status": "identical" if identical else "differs",
        "rowsA": len(a["rows"]), "rowsB": len(b["rows"]), "matchedRows": len(ra.keys() & rb.keys()),
        "onlyA": only_a[:limit], "onlyB": only_b[:limit], "onlyACount": len(only_a), "onlyBCount": len(only_b),
        "diffRows": n_diff_rows, "diffs": diffs, "maxPct": None if math.isinf(max_pct) else max_pct,
        "measuresA": a["measures"], "measuresB": b["measures"], "schemaDiffers": schema,
        "duplicateKeysA": dup_a, "duplicateKeysB": dup_b,
    }
