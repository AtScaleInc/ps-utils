"""Rewrite a source export payload so it imports into the target model.

Ids differ per host (catalogId / modelId, instance ids), so every source id in
the payload is substituted with the target's before POSTing it to
/v1/aggregates/import/catalogs/{c}/models/{m}:

  - exportCatalogId / exportModelId and each value's catalogId / modelId, plus
    every occurrence inside planJson -> target catalog / model id
  - the source model's name -> the target model's (exact-value matches), for a
    model override: the same SML deployed twice under different model names
  - activeInstanceId / latestInstanceId -> the target counterpart's instance
    (same plan fingerprint); for a new aggregate the source ids are kept. The
    engine's import (AggregateImportHelper) never reads them - it creates new
    definitions - but the SML API's request schema (apps/api/src/public/
    aggregate/models/import-aggregate.dto.ts) requires non-null strings, so
    null is rejected with 400 "Expected string, received null".
  - key / role-play reference ids inside planJson -> the target's ids for the
    same *names* (promote/idmap.py); an object missing on the target skips
    that aggregate
  - connectionId (values, exportSummary, and inside planJson for builds that
    reference it there) -> the target model's connection:
    environments don't share connection ids (Postgres14 on Dev, PG_PROD on
    Prod), so connection_map() pairs them through the datasets both models
    share. With no mapping found, the source id is kept (no swap).
"""

from __future__ import annotations

import copy
import json
from typing import Any

from promote.idmap import plan_ids, translate_plan


# z.string() (non-optional) fields of each value in the import request schema.
REQUIRED_STRINGS = ("activeInstanceId", "latestInstanceId", "baseType", "catalogId", "connectionId",
                    "createdAt", "id", "modelId", "subType", "triggeringQueryId")


def _swap(o: Any, ids: dict[str, str]) -> Any:
    if isinstance(o, str):
        return ids.get(o, o)
    if isinstance(o, dict):
        return {k: _swap(v, ids) for k, v in o.items()}
    if isinstance(o, list):
        return [_swap(v, ids) for v in o]
    return o


def connection_map(source_datasets: dict[str, str], target_datasets: dict[str, str]) -> dict[str, str]:
    """source connection id -> target connection id, from the datasets both
    models have (dataset name -> connection, promote/idmap.py ::
    dataset_connections). A source connection whose datasets point at more
    than one target connection is ambiguous and left out."""
    seen: dict[str, set[str]] = {}
    for name, src in source_datasets.items():
        tgt = target_datasets.get(name)
        if tgt:
            seen.setdefault(src, set()).add(tgt)
    return {src: next(iter(tgts)) for src, tgts in seen.items() if len(tgts) == 1}


def target_connection(source_conn: str | None, target_conns: list[str],
                      mapped: dict[str, str] | None = None) -> str | None:
    """The target connection for a source one: matched through the shared
    datasets first; else the same id if the target model uses it; else the
    target model's only connection; otherwise unresolved (None)."""
    if source_conn and mapped and source_conn in mapped:
        return mapped[source_conn]
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
    connections: dict[str, str] | None = None,
    source_names: dict[str, str] | None = None,
    target_ids_by_name: dict[str, str] | None = None,
    source_model_name: str | None = None,
    target_model_name: str | None = None,
) -> tuple[dict[str, Any], list[dict[str, str]]]:
    """(payload for the target, problems). `target_instances` maps a source
    definition id -> the target counterpart's instance id (or None);
    `connections` is connection_map() for this source / target model pair.
    `source_model_name` / `target_model_name`: set when the aggregates go into
    a differently named model (Promote's target-model override)."""
    out = copy.deepcopy(payload)
    ids = {
        str(payload.get("exportCatalogId")): target_catalog_id,
        str(payload.get("exportModelId")): target_model_id,
    }
    if source_model_name and target_model_name and source_model_name != target_model_name:
        ids[source_model_name] = target_model_name
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
        # No mapping found -> keep the source id (nothing to swap it with).
        tgt_conn = target_connection(src_conn, target_connections, connections) or src_conn
        if src_conn and tgt_conn and src_conn != tgt_conn:
            conns[src_conn] = tgt_conn
        # Connection ids are swapped inside planJson too: current exports only
        # carry them in connectionId / exportSummary, newer AtScale builds may
        # also reference the connection in the plan. Exact-value matches only.
        swaps = {**ids, **({src_conn: tgt_conn} if src_conn and tgt_conn and src_conn != tgt_conn else {})}
        nv = _swap(copy.deepcopy(v), {**swaps, **conns})
        plan = v.get("planJson")
        if isinstance(plan, str):
            try:
                nv["planJson"] = json.dumps(_swap(json.loads(plan), swaps))
            except ValueError:
                nv["planJson"] = plan
        if object_ids:
            nv["planJson"] = translate_plan(nv["planJson"], object_ids)
        counterpart = target_instances.get(v.get("id"))
        nv["activeInstanceId"] = counterpart or v.get("activeInstanceId") or v.get("latestInstanceId") or ""
        nv["latestInstanceId"] = counterpart or v.get("latestInstanceId") or v.get("activeInstanceId") or ""
        for field in REQUIRED_STRINGS:
            if not isinstance(nv.get(field), str):
                nv[field] = ""
        values.append(nv)
    out["exportCatalogId"] = target_catalog_id
    out["exportModelId"] = target_model_id
    out["aggregates"] = {**(payload.get("aggregates") or {}), "count": len(values), "values": values}
    summary = (out.get("exportSummary") or {}).get("connectionIds")
    if isinstance(summary, dict) and conns:
        mapped = sorted({conns.get(c, c) for c in summary.get("values", [])})
        out["exportSummary"]["connectionIds"] = {"count": len(mapped), "values": mapped}
    return out, problems
