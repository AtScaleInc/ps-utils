"""Query generation for the Test tab.

Ported from ps-utils:
  - src/operations/generate-queries-shared.ts (mdxMetricTotal, mdxLevelQuery,
    sqlMetricTotal, sqlLevelQuery, buildQueryPairs, sha256hex)
  - src/operations/generate-queries-from-model/GenerateQueriesFromModelOperation.ts
    (metrics from mdx.metrics, levels from mdx.attributes sorted by level_number)
  - src/operations/extract-model-from-atscale/ExtractAtScaleModelOperation.ts
    (getMetrics / getAttributes: MDSCHEMA_MEASURES and MDSCHEMA_LEVELS without
    the (All) level or the [Measures] dimension)

Instead of reading a model.yaml, the metadata comes straight from the host
(atscale/preview.py load_cube_metadata runs the same DMV rowsets).

One deliberate deviation: ps-utils puts the level *caption* in the MDX level
brackets (`levelLabel: lvl.caption ?? lvl.query_name`). MDX resolves levels by
name, so that fails whenever caption != name - confirmed on a container host:
`[Product].[Product Hierarchy].[Product]` -> "Level not found", while
`[...].[productkey]` (LEVEL_NAME) returns rows. The MDX here uses LEVEL_NAME;
the caption is still used for the query's display name.
"""

from __future__ import annotations

import hashlib
import re
from typing import Any

_HIER_PARTS = re.compile(r"\[(.*?)\]\.\[(.*?)\]")


def sha256hex(text: str) -> str:
    return hashlib.sha256(text.encode("utf-8")).hexdigest()


# -- MDX / SQL builders (generate-queries-shared.ts) ----------------------------------------

def mdx_metric_total(metric: str, cube: str) -> str:
    return f"SELECT {{[Measures].[{metric}]}} ON COLUMNS\nFROM [{cube}]"


def mdx_level_query(metrics: list[str], dim: str, hier: str, level_name: str, cube: str) -> str:
    measures = ", ".join(f"[Measures].[{m}]" for m in metrics)
    return (f"SELECT {{{measures}}} ON COLUMNS,\n"
            f"  NON EMPTY [{dim}].[{hier}].[{level_name}].MEMBERS ON ROWS\n"
            f"FROM [{cube}]")


def sql_metric_total(metric: str, cube: str) -> str:
    return f'SELECT "{metric}"\nFROM "{cube}"'


def sql_level_query(metrics: list[str], level_column: str, cube: str) -> str:
    cols = ",\n".join(f'  "{m}"' for m in metrics)
    return (f'SELECT\n  "{level_column}",\n{cols}\n'
            f'FROM "{cube}"\n'
            f'GROUP BY "{level_column}"\n'
            f'ORDER BY "{level_column}"')


# -- model reduction (extract-model-from-atscale getMetrics / getAttributes) -----------------

def model_entries(meta: dict[str, Any]) -> tuple[list[dict[str, str]], list[dict[str, Any]]]:
    """(metrics, levels) from load_cube_metadata's raw rowsets."""
    metrics = [
        {"uniqueName": m["MEASURE_NAME"], "label": m.get("MEASURE_CAPTION") or m["MEASURE_NAME"]}
        for m in meta.get("_measures", []) if m.get("MEASURE_NAME")
    ]
    levels = []
    for lv in meta.get("_levels", []):
        name = lv.get("LEVEL_NAME")
        if not name or name == "(All)" or lv.get("DIMENSION_UNIQUE_NAME") == "[Measures]":
            continue
        parts = _HIER_PARTS.match(lv.get("HIERARCHY_UNIQUE_NAME") or "")
        dim, hier = (parts.group(1), parts.group(2)) if parts else (lv["HIERARCHY_UNIQUE_NAME"], lv["HIERARCHY_UNIQUE_NAME"])
        levels.append({
            "dimLabel": dim, "hierLabel": hier, "levelName": name,
            "levelLabel": lv.get("LEVEL_CAPTION") or name,
            "levelNumber": int(lv.get("LEVEL_NUMBER") or 0),
        })
    # Broadest -> most granular within each hierarchy, hierarchies in rowset order.
    order = {}
    for lv in levels:
        order.setdefault((lv["dimLabel"], lv["hierLabel"]), len(order))
    levels.sort(key=lambda lv: (order[(lv["dimLabel"], lv["hierLabel"])], lv["levelNumber"]))
    return metrics, levels


def build_queries(metrics: list[dict[str, str]], levels: list[dict[str, Any]], cube: str) -> list[dict[str, Any]]:
    """buildQueryPairs: one grand total per metric, then one breakdown per level
    with every metric. Each entry carries both its MDX and SQL text."""
    if not metrics:
        raise ValueError(f"Cube '{cube}' has no metrics")
    names = [m["uniqueName"] for m in metrics]
    out: list[dict[str, Any]] = []
    for m in metrics:
        mdx, sql = mdx_metric_total(m["uniqueName"], cube), sql_metric_total(m["uniqueName"], cube)
        out.append({"name": f"{m['label']} | Total", "kind": "total", "mdx": mdx, "sql": sql, "metrics": [m["uniqueName"]]})
    for lv in levels:
        mdx = mdx_level_query(names, lv["dimLabel"], lv["hierLabel"], lv["levelName"], cube)
        sql = sql_level_query(names, lv["levelName"], cube)
        out.append({"name": f"{lv['dimLabel']} | {lv['hierLabel']} | {lv['levelLabel']}", "kind": "level",
                    "dimension": lv["dimLabel"], "mdx": mdx, "sql": sql, "metrics": names})
    for i, q in enumerate(out):
        q["id"] = f"q{i + 1}"
        q["hash"] = sha256hex(q["mdx"] + "\n" + q["sql"])
    return out
