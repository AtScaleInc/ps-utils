"""Promote: diff source vs target, then promote models or system aggregates."""

from __future__ import annotations

from flask import Blueprint, jsonify, request

import jobs
from envs import registry
from atscale import github
from promote import diff as D
from promote.remap import connection_map, remap_export, target_connection
from routes.objects import host_errors

promote_bp = Blueprint("promote", __name__)


def _body() -> dict:
    return request.get_json(force=True, silent=True) or {}


def _hosts(b: dict) -> tuple[str, str]:
    src, tgt = b.get("sourceHostId"), b.get("targetHostId")
    if not src or not tgt:
        raise ValueError("sourceHostId and targetHostId are required")
    if src == tgt:
        raise ValueError("Pick a target different from the source")
    return src, tgt


def _oldest(*backends) -> float | None:
    times = [b.loaded_at for b in backends if b.loaded_at is not None]
    return min(times) if times else None


def _all_aggs(backend, model_name: str | None = None) -> tuple[list[dict], list[dict]]:
    models = [m for m in backend.agg_models() if not model_name or m["name"] == model_name]
    aggs: list[dict] = []
    for m in models:
        aggs.extend(backend.list_aggregates(m["catalogId"], m["modelId"]))
    return models, aggs


@promote_bp.post("/promote/diff")
@host_errors
def promote_diff():
    b = _body()
    section = b.get("section", "models")
    src_id, tgt_id = b.get("sourceHostId"), b.get("targetHostId")
    if not src_id or not tgt_id:
        return jsonify({"error": "sourceHostId and targetHostId are required"}), 400
    if src_id == tgt_id:
        return jsonify({"rows": [], "target": [], "sameHost": True, "message": "Pick a target different from the source"})
    refresh = bool(b.get("refresh"))
    src, tgt = registry.backend(src_id, refresh), registry.backend(tgt_id, refresh)

    if section == "models":
        tgt_rows = tgt.list_models()
        rows = D.diff_models(src.list_models(), tgt_rows, src.compare)
        return jsonify({"rows": rows, "target": tgt_rows, "cachedAt": _oldest(src, tgt)})

    model = b.get("model") or None
    src_models, src_aggs = _all_aggs(src, model)
    tgt_models = tgt.agg_models()
    tgt_model_names = {m["name"] for m in tgt_models}
    tgt_aggs: list[dict] = []
    for m in tgt_models:
        if m["name"] in {sm["name"] for sm in src_models}:
            tgt_aggs.extend(tgt.list_aggregates(m["catalogId"], m["modelId"]))
    dup_ids = D.duplicates_on_target(src_aggs, tgt_aggs)
    return jsonify({
        "rows": D.diff_aggs(src_aggs, tgt_aggs, tgt_model_names),
        "target": [{**t, "duplicate": t["id"] in dup_ids} for t in tgt_aggs],
        "sourceModels": [m["name"] for m in src.agg_models()],
        "targetModels": sorted(tgt_model_names),
        "cachedAt": _oldest(src, tgt),
    })


@promote_bp.post("/promote/models")
@host_errors
def promote_models():
    """Body: {sourceHostId, targetHostId, models: [{name, branch, mode, replaceOld}]}.

    - mode "deploy" (default): attach the repo on the target if missing, then
      deploy `branch` there - so Dev can run `develop` while Prod gets `main`.
      Deploy is per catalog, so models sharing a repo + branch deploy once.
      replaceOld: undeploy the target's catalog(s) of this repo on other branches
      after the new deploy succeeds.
    - mode "link": attach the repo + branch on the target only."""
    if not registry.git_ready():
        return jsonify({"error": "Git profile is missing or failed its test - fix it in Settings", "needsGit": True}), 409
    b = _body()
    src_id, tgt_id = _hosts(b)
    staged = [m if isinstance(m, dict) else {"name": m} for m in (b.get("models") or [])]
    if not staged:
        return jsonify({"error": "Nothing staged"}), 400
    src, tgt = registry.backend(src_id), registry.backend(tgt_id)

    def run() -> dict:
        rows = {r["name"]: r for r in src.list_models()}
        tgt_rows = tgt.list_models()
        results: list[dict] = []
        plan: dict[tuple[str, str], dict] = {}
        for item in staged:
            row = rows.get(item["name"])
            if not row or not row.get("repoUrl"):
                results.append({"name": item["name"], "ok": False, "error": "Not on source (or no repo URL)"})
                continue
            branch = item.get("branch") or row["branch"]
            if item.get("mode") == "link":
                try:
                    tgt.link(row["repoUrl"], branch, item["name"])
                    results.append({"name": item["name"], "ok": True, "mode": "link", "branch": branch})
                except Exception as e:  # noqa: BLE001 - reported per model
                    results.append({"name": item["name"], "ok": False, "mode": "link", "error": str(e)})
                continue
            step = plan.setdefault((row["repoUrl"], branch), {"names": [], "replace": set()})
            step["names"].append(item["name"])
            if item.get("replaceOld"):
                same_repo = github.normalize_repo_url(row["repoUrl"])
                step["replace"] |= {t["catalogId"] for t in tgt_rows if t.get("catalogId") and t.get("branch") != branch
                                    and github.normalize_repo_url(t.get("repoUrl") or "") == same_repo}
        for (repo_url, branch), step in plan.items():
            r = tgt.deploy_branch(repo_url, branch, sorted(step["replace"]))
            results.extend({**r, "name": n, "mode": "deploy"} for n in step["names"])
        return {"results": results}

    return jsonify(jobs.submit("promote-models", run)), 202


@promote_bp.post("/promote/aggregates")
@host_errors
def promote_aggregates():
    """Body: {sourceHostId, targetHostId, aggregates: [source definition ids]}.

    Rules: system-defined, active + exportable on the source, same model (by
    name) deployed on the target, no active duplicate there. Export from the
    source -> re-check rules -> remap catalog/model/instance/connection ids to
    the target's -> import. An inactive target copy is reactivated instead."""
    b = _body()
    src_id, tgt_id = _hosts(b)
    ids = b.get("aggregates") or []
    if not ids:
        return jsonify({"error": "Nothing staged"}), 400
    src, tgt = registry.backend(src_id), registry.backend(tgt_id, refresh=True)

    def run() -> dict:
        src_models, src_aggs = _all_aggs(src)
        tgt_models = {m["name"]: m for m in tgt.agg_models()}
        tgt_aggs: list[dict] = []
        for m in tgt_models.values():
            if m["name"] in {sm["name"] for sm in src_models}:
                tgt_aggs.extend(tgt.list_aggregates(m["catalogId"], m["modelId"]))
        # §5 rule 6: re-check now - the target may have changed since the diff.
        promote, skipped = D.partition_for_promote(ids, src_aggs, tgt_aggs, set(tgt_models))
        promoted: list[str] = []
        connections: dict[str, int] = {}  # "source → target" connection -> aggregates remapped
        by_model: dict[str, list[dict]] = {}
        for a in promote:
            by_model.setdefault(a["model"], []).append(a)
        tgt_by_id = {t["id"]: t for t in tgt_aggs}
        for model_name, aggs in by_model.items():
            sm = next(m for m in src_models if m["name"] == model_name)
            tm = tgt_models[model_name]  # the same model, matched by name (§5 rule 1)
            payload = src.export_aggregates(sm["catalogId"], sm["modelId"], [a["id"] for a in aggs])
            exported = {v["id"] for v in payload["aggregates"]["values"]}
            for a in aggs:
                if a["id"] not in exported:
                    skipped.append({"id": a["id"], "name": a["name"], "reason": "Not in export (inactive or not system-defined)"})
            # Target counterpart (inactive copy) -> its instance id; new aggregates get none.
            counterpart = {a["id"]: (a["diff"].get("targetIds") or [None])[0] for a in aggs}
            instances = {sid: (tgt_by_id.get(tid) or {}).get("instanceId") for sid, tid in counterpart.items()}
            # Ids differ per host: translate the plan's key / reference ids by name.
            src_names = src.catalog_ids(sm["catalogId"])
            tgt_names = tgt.catalog_ids(tm["catalogId"])
            tgt_by_name: dict[str, str] = {}
            for tid, n in tgt_names.items():
                tgt_by_name[n] = tid if n not in tgt_by_name else ""  # ambiguous -> unusable
            # Connection ids differ per environment: pair them through the datasets
            # both models read (each dataset names its connection).
            conn_map = connection_map(src.dataset_connections(sm["catalogId"]), tgt.dataset_connections(tm["catalogId"]))
            tgt_conns = tgt.model_connections(tm["catalogId"], tm["modelId"])
            body, problems = remap_export(
                payload, target_catalog_id=tm["catalogId"], target_model_id=tm["modelId"],
                target_instances=instances, target_connections=tgt_conns, connections=conn_map,
                source_names=src_names if src_names else None,
                target_ids_by_name={n: i for n, i in tgt_by_name.items() if i} if src_names else None,
            )
            by_id = {a["id"]: a for a in aggs}
            skipped.extend({"id": p["id"], "name": by_id.get(p["id"], {}).get("name", p["id"]), "reason": p["reason"]} for p in problems)
            for v in payload["aggregates"]["values"]:
                sc = v.get("connectionId")
                tc = target_connection(sc, tgt_conns, conn_map)
                if sc and tc:
                    connections[f"{sc} → {tc}"] = connections.get(f"{sc} → {tc}", 0) + 1
            if not body["aggregates"]["values"]:
                continue
            result = tgt.import_aggregates(tm["catalogId"], tm["modelId"], body)
            for v in (result.get("aggregates") or {}).get("values", []):
                a = by_id.get(v.get("id"))
                if not a:
                    continue
                if v.get("imported"):
                    promoted.append(a["name"])
                elif counterpart.get(a["id"]):
                    # "Replaces inactive": AtScale kept the existing (blocked) copy -
                    # reactivate it so the target ends up active / Built.
                    r = tgt.set_active(tm["catalogId"], tm["modelId"], [counterpart[a["id"]]], True)
                    if r and r[0].get("ok"):
                        promoted.append(f"{a['name']} (reactivated)")
                    else:
                        skipped.append({"id": a["id"], "name": a["name"], "reason": (r[0].get("error") if r else None) or v.get("reason") or "Ignored"})
                else:
                    skipped.append({"id": a["id"], "name": a["name"], "reason": v.get("reason") or "Ignored by AtScale"})
        return {"promoted": promoted, "skipped": skipped, "connections": connections}

    return jsonify(jobs.submit("promote-aggregates", run)), 202
