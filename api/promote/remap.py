"""Rewrite a source export payload so it imports into the target model.

Ids differ per host (catalogId / modelId, instance ids), so every source id in
the payload is substituted with the target's before POSTing it to
/v1/aggregates/import/catalogs/{c}/models/{m}:

  - exportCatalogId / exportModelId and each value's catalogId / modelId, plus
    every occurrence inside planJson -> target catalog / model id
  - activeInstanceId / latestInstanceId -> the target counterpart's instance
    (same plan fingerprint), or None when the target has no copy yet
  - key / role-play reference ids inside planJson -> the target's ids for the
    same *names* (promote/idmap.py); an object missing on the target skips
    that aggregate
  - connectionId (values + exportSummary) -> target model's connection
"""

from __future__ import annotations

import copy
import json
from typing import Any

from promote.idmap import plan_ids, translate_plan


def _swap(o: Any, ids: dict[str, str]) -> Any:
    if isinstance(o, str):
        return ids.get(o, o)
    if isinstance(o, dict):
        return {k: _swap(v, ids) for k, v in o.items()}
    if isinstance(o, list):
        return [_swap(v, ids) for v in o]
    return o


def target_connection(source_conn: str | None, target_conns: list[str]) -> str | None:
    """Same id on the target -> keep it; exactly one target connection -> use
    it; otherwise ambiguous (None)."""
    if source_conn and source_conn in target_conns:
        return source_conn
    if len(target_conns) == 1:
        return target_conns[0]
    return None


def remap_export(
    payload: dict[str, Any],
    *,
    target_catalog_id: str,
    target_model_id: str,
    target_instances: dict[str, str | None],
    target_connections: list[str],
    source_names: dict[str, str] | None = None,
    target_ids_by_name: dict[str, str] | None = None,
) -> tuple[dict[str, Any], list[dict[str, str]]]:
    """(payload for the target, problems). `target_instances` maps a source
    definition id -> the target counterpart's instance id (or None)."""
    out = copy.deepcopy(payload)
    ids = {
        str(payload.get("exportCatalogId")): target_catalog_id,
        str(payload.get("exportModelId")): target_model_id,
    }
    conns: dict[str, str] = {}
    problems: list[dict[str, str]] = []
    values = []
    object_ids: dict[str, str] = {}
    for v in (payload.get("aggregates") or {}).get("values", []):
        if source_names is not None and target_ids_by_name is not None:
            missing = []
            for oid in plan_ids(v.get("planJson")):
                name = source_names.get(oid)
                if name and name in target_ids_by_name:
                    object_ids[oid] = target_ids_by_name[name]
                else:
                    missing.append(name or oid)
            if missing:
                problems.append({"id": v.get("id"), "reason": "Not on target model: " + ", ".join(sorted(missing))})
                continue
        src_conn = v.get("connectionId")
        tgt_conn = target_connection(src_conn, target_connections) if target_connections else src_conn
        if src_conn and tgt_conn is None:
            problems.append({"id": v.get("id"), "reason": f"Connection {src_conn} has no unambiguous match on the target"})
            continue
        if src_conn and tgt_conn and src_conn != tgt_conn:
            conns[src_conn] = tgt_conn
        nv = _swap(copy.deepcopy(v), {**ids, **conns})
        plan = v.get("planJson")
        if isinstance(plan, str):
            try:
                nv["planJson"] = json.dumps(_swap(json.loads(plan), ids))
            except ValueError:
                nv["planJson"] = plan
        if object_ids:
            nv["planJson"] = translate_plan(nv["planJson"], object_ids)
        instance = target_instances.get(v.get("id"))
        nv["activeInstanceId"] = instance
        nv["latestInstanceId"] = instance
        values.append(nv)
    out["exportCatalogId"] = target_catalog_id
    out["exportModelId"] = target_model_id
    out["aggregates"] = {**(payload.get("aggregates") or {}), "count": len(values), "values": values}
    summary = (out.get("exportSummary") or {}).get("connectionIds")
    if isinstance(summary, dict) and conns:
        mapped = sorted({conns.get(c, c) for c in summary.get("values", [])})
        out["exportSummary"]["connectionIds"] = {"count": len(mapped), "values": mapped}
    return out, problems
