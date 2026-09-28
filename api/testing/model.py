"""Model snapshot (DMV) and model compare for the Test tab.

The snapshot uses the DMV statements of reference/ps-utils
src/operations/extract-model-from-atscale/ExtractAtScaleModelOperation.ts:
  getMetrics    - MDSCHEMA_MEASURES (name, data type, caption, aggregator,
                  folder, format string, description; aggregator 9 -> 1 and
                  the aggTypeLookup / dataTypeLookup tables)
  getAttributes - MDSCHEMA_LEVELS without (All) / [Measures], plus the
                  hierarchy display folder from MDSCHEMA_HIERARCHIES
so "the model is identical" means the same thing extract-model-from-atscale's
model.yaml would show. Sent through the same XMLA envelope atscale/preview.py
uses for its DMV queries.
"""

from __future__ import annotations

import re
from typing import Any
from xml.sax.saxutils import escape

from atscale.preview import parse_rows

AGG_TYPES = {1: "sum", 5: "avg", 4: "max", 3: "min", 8: "count", 1000: "count", 2: "count", 7: "std",
             333: "std", 0: "var", 6: "var", 9: "calculated"}
DATA_TYPES = {0: "EMPTY", 16: "INT1", 2: "INT2", 3: "INT4", 20: "INT8", 17: "INT_UNSIGNED1", 18: "INT_UNSIGNED2",
              19: "INT_UNSIGNED4", 21: "INT_UNSIGNED8", 4: "FLOAT32", 5: "FLOAT64", 6: "CURRENCY",
              7: "DATE_DOUBLE", 8: "BSTR", 11: "BOOL", 14: "DECIMAL", 72: "GUID", 128: "BYTES", 129: "STRING",
              130: "WSTR", 131: "NUMERIC", 133: "DATE", 134: "TIME", 135: "DATETIME"}

_MEASURES = ("SELECT MEASURE_NAME, DATA_TYPE, MEASURE_CAPTION, MEASURE_AGGREGATOR, MEASURE_DISPLAY_FOLDER, "
             "DEFAULT_FORMAT_STRING, DESCRIPTION FROM $system.MDSCHEMA_MEASURES WHERE [CUBE_NAME] = '{cube}'")
_LEVELS = ("SELECT LEVEL_NAME, HIERARCHY_UNIQUE_NAME, LEVEL_NUMBER, LEVEL_CAPTION, DESCRIPTION, LEVEL_DBTYPE "
           "FROM $system.MDSCHEMA_LEVELS WHERE [CUBE_NAME] = '{cube}' and [LEVEL_NAME] <> '(All)' "
           "and [DIMENSION_UNIQUE_NAME] <> '[Measures]'")
_HIERS = "SELECT HIERARCHY_UNIQUE_NAME, HIERARCHY_DISPLAY_FOLDER FROM $system.MDSCHEMA_HIERARCHIES WHERE [CUBE_NAME] = '{cube}'"
_HIER_PARTS = re.compile(r"\[(.*?)\]\.\[(.*?)\]")


def _dmv(api: Any, statement: str, catalog: str, cube: str) -> str:
    return api.run_xmla(f"""<?xml version="1.0" encoding="utf-8"?>
<soap:Envelope xmlns:soap="http://schemas.xmlsoap.org/soap/envelope/">
  <soap:Body>
    <Execute xmlns="urn:schemas-microsoft-com:xml-analysis">
      <Command><Statement>{escape(statement.format(cube=cube.replace("'", "''")))}</Statement></Command>
      <Properties><PropertyList><Catalog>{escape(catalog)}</Catalog><Cube>{escape(cube)}</Cube></PropertyList></Properties>
    </Execute>
  </soap:Body>
</soap:Envelope>""")


def _int(v: Any, default: int = 0) -> int:
    try:
        return int(v)
    except (TypeError, ValueError):
        return default


def snapshot(api: Any, catalog: str, cube: str) -> dict[str, Any]:
    """{metrics: {name: {...}}, levels: {"Dim | Hier | Level": {...}}}."""
    m_rows = parse_rows(_dmv(api, _MEASURES, catalog, cube), ["MEASURE_NAME", "DATA_TYPE", "MEASURE_CAPTION",
                        "MEASURE_AGGREGATOR", "MEASURE_DISPLAY_FOLDER", "DEFAULT_FORMAT_STRING", "DESCRIPTION"])
    l_rows = parse_rows(_dmv(api, _LEVELS, catalog, cube), ["LEVEL_NAME", "HIERARCHY_UNIQUE_NAME", "LEVEL_NUMBER",
                        "LEVEL_CAPTION", "DESCRIPTION", "LEVEL_DBTYPE"])
    h_rows = parse_rows(_dmv(api, _HIERS, catalog, cube), ["HIERARCHY_UNIQUE_NAME", "HIERARCHY_DISPLAY_FOLDER"])
    folders = {h["HIERARCHY_UNIQUE_NAME"]: h.get("HIERARCHY_DISPLAY_FOLDER") or "" for h in h_rows}

    metrics = {}
    for r in m_rows:
        if not r.get("MEASURE_NAME"):
            continue
        agg = _int(r.get("MEASURE_AGGREGATOR"))
        agg = 1 if agg == 9 else agg  # ps-utils: aggregator 9 is reported as 1
        metrics[r["MEASURE_NAME"]] = {
            "caption": r.get("MEASURE_CAPTION") or "", "aggregation": AGG_TYPES.get(agg, "unknown"),
            "dataType": DATA_TYPES.get(_int(r.get("DATA_TYPE"), -1), "unknown"),
            "folder": r.get("MEASURE_DISPLAY_FOLDER") or "", "format": r.get("DEFAULT_FORMAT_STRING") or "",
            "description": r.get("DESCRIPTION") or "",
        }
    levels = {}
    for r in l_rows:
        if not r.get("LEVEL_NAME"):
            continue
        h = r.get("HIERARCHY_UNIQUE_NAME") or ""
        parts = _HIER_PARTS.match(h)
        dim, hier = (parts.group(1), parts.group(2)) if parts else (h, h)
        levels[f"{dim} | {hier} | {r['LEVEL_NAME']}"] = {
            "caption": r.get("LEVEL_CAPTION") or "", "levelNumber": _int(r.get("LEVEL_NUMBER")),
            "dataType": DATA_TYPES.get(_int(r.get("LEVEL_DBTYPE"), 130), "unknown"),
            "folder": folders.get(h, ""), "description": r.get("DESCRIPTION") or "",
        }
    return {"metrics": metrics, "levels": levels}


def compare_models(a: dict[str, Any], b: dict[str, Any]) -> dict[str, Any]:
    """Per section (metrics / levels): only in A, only in B, and objects on
    both whose attributes differ (field: a -> b)."""
    out: dict[str, Any] = {"identical": True}
    for section in ("metrics", "levels"):
        sa, sb = a.get(section) or {}, b.get(section) or {}
        changed = []
        for name in sorted(set(sa) & set(sb)):
            fields = [{"field": f, "a": sa[name].get(f), "b": sb[name].get(f)}
                      for f in sorted(set(sa[name]) | set(sb[name])) if sa[name].get(f) != sb[name].get(f)]
            if fields:
                changed.append({"name": name, "fields": fields})
        res = {"onlyA": sorted(set(sa) - set(sb)), "onlyB": sorted(set(sb) - set(sa)), "changed": changed,
               "same": len(set(sa) & set(sb)) - len(changed), "countA": len(sa), "countB": len(sb)}
        out[section] = res
        if res["onlyA"] or res["onlyB"] or changed:
            out["identical"] = False
    return out
