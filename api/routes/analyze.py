"""Manage › Analyze: audit one model on a host.

  GET /hosts/<id>/analyze?key=<model key>[&refresh=1]
      The model's SML, read from its repo at the deployed commit (branch head
      when no commit is known), analysed by analyze/model.py; plus what the
      host actually serves - a DMV snapshot (testing/model.py) compared with
      the SML, and the model's aggregates.
  GET /hosts/<id>/analyze/file?key=<model key>&path=<repo path>
      One YAML file from the same repo read, for the audit's "view source".
"""

from __future__ import annotations

from collections import Counter
from typing import Any

from flask import Blueprint, jsonify, request

import cache
from analyze.model import analyze
from atscale import github
from atscale.client import AtScaleApiError
from envs import registry
from routes.objects import host_errors
from atscale.preview import list_catalogs_and_cubes
from testing.model import snapshot

analyze_bp = Blueprint("analyze", __name__)


def _refresh() -> bool:
    return request.args.get("refresh") in ("1", "true")


def _row(host_id: str, key: str) -> dict[str, Any] | None:
    return next((m for m in registry.backend(host_id).list_models() if m["key"] == key), None)


def _ref(row: dict[str, Any]) -> str:
    return row.get("commit") or row.get("branch") or "main"


def _files(row: dict[str, Any], refresh: bool) -> tuple[dict[str, str], str]:
    """{path: yaml} at the model's commit (immutable, so cached for the TTL) or branch."""
    ref = _ref(row)
    if registry.FAKE:
        from atscale.fake import fake_sml

        return fake_sml(row["name"]), ref
    token = registry.git_token()
    if not token:
        raise PermissionError("Git profile is missing - set it in Settings")
    files, _ = cache.get(("git", "sml", github.normalize_repo_url(row["repoUrl"]), ref),
                         lambda: github.fetch_sml_files(token, row["repoUrl"], ref), refresh)
    return files, ref


def _norm(s: str | None) -> str:
    return (s or "").strip().lower()


def _xmla_target(api: Any, row: dict[str, Any]) -> tuple[str, str]:
    """(XMLA catalog, cube) of a model row. The row's `catalog` is the display
    caption, not the XMLA catalog name (that gives "Schema not found"), so the
    host's own DBSCHEMA_CATALOGS / MDSCHEMA_CUBES list (what Test picks from)
    is matched: catalog GUID = the row's catalogId first, then the names."""
    cubes = [c for c in list_catalogs_and_cubes(api) if _norm(c["cube"]) == _norm(row["name"])]
    pick = next((c for c in cubes if row.get("catalogId") and c.get("catalogGuid") == row["catalogId"]), None) \
        or next((c for c in cubes if _norm(c["catalog"]) == _norm(row["catalog"])), None) \
        or (cubes[0] if len(cubes) == 1 else None)
    if not pick:
        where = ", ".join(str(c["catalog"]) for c in cubes)
        raise ValueError(f"No XMLA cube {row['name']!r} found for catalog {row['catalog']!r}"
                         + (f" (it is in: {where})" if where else ""))
    return str(pick["catalog"]), str(pick["cube"])


def _deployed(host_id: str, row: dict[str, Any], sml: dict[str, Any]) -> dict[str, Any]:
    """What the host serves for this model: DMV objects (vs the SML) and aggregates."""
    out: dict[str, Any] = {}
    try:
        api = registry.source_api(host_id)
        catalog, cube = _xmla_target(api, row)
        try:
            snap = snapshot(api, catalog, cube)
        except AtScaleApiError:  # the engine sometimes 500s one DMV call; one retry before reporting it
            snap = snapshot(api, catalog, cube)
        levels = snap["levels"]
        dims = {k.split(" | ")[0] for k in levels}
        hiers = {" | ".join(k.split(" | ")[:2]) for k in levels}
        deployed_m = {_norm(n): n for n in snap["metrics"]} | {_norm(v["caption"]): n for n, v in snap["metrics"].items()}
        sml_m = [m for m in sml["metrics"] if not m["hidden"]]
        missing = [m["label"] for m in sml_m if _norm(m["name"]) not in deployed_m and _norm(m["label"]) not in deployed_m]
        # Metrical attributes (metrics on a dimension level) are measures in the DMV too.
        dim_metrics = [x for d in sml["dimensions"] for x in d["metricalAttributes"]]
        known = {_norm(m[k]) for m in [*sml["metrics"], *dim_metrics] for k in ("name", "label")}
        extra = [n for n, v in snap["metrics"].items() if _norm(n) not in known and _norm(v["caption"]) not in known]
        out["dmv"] = {
            "measures": len(snap["metrics"]), "levels": len(levels), "hierarchies": len(hiers), "dimensions": len(dims),
            "aggregation": dict(Counter(v["aggregation"] for v in snap["metrics"].values()).most_common()),
            "missingFromHost": missing, "notInSml": extra, "catalog": catalog, "cube": cube,
        }
    except Exception as e:  # noqa: BLE001 - reported next to the SML analysis, never fatal
        out["dmvError"] = str(e)
    try:
        aggs = registry.backend(host_id).list_aggregates(row["catalogId"], row["modelId"])
        out["aggregates"] = {
            "total": len(aggs), "system": sum(1 for a in aggs if a["type"] == "SYSTEM"),
            "user": sum(1 for a in aggs if a["type"] == "USER"), "active": sum(1 for a in aggs if a["active"]),
            "byStatus": dict(Counter(a["status"] for a in aggs).most_common()),
        }
    except Exception as e:  # noqa: BLE001
        out["aggregatesError"] = str(e)
    return out


@analyze_bp.get("/hosts/<host_id>/analyze")
@host_errors
def analyze_model(host_id: str):
    key = request.args.get("key") or ""
    row = _row(host_id, key)
    if not row:
        return jsonify({"error": "Model not found on this host"}), 404
    if not row.get("repoUrl"):
        return jsonify({"error": "This model has no Git repo attached - nothing to read its SML from"}), 409
    try:
        files, ref = _files(row, _refresh())
    except PermissionError as e:
        return jsonify({"error": str(e), "needsGit": True}), 409
    except github.GitError as e:
        return jsonify({"error": str(e)}), 502
    try:
        result = analyze(files, row["name"])
    except ValueError as e:
        return jsonify({"error": str(e)}), 422
    source = {"repoUrl": row["repoUrl"], "ref": ref, "branch": row.get("branch"), "commit": row.get("commit"),
              "commitDate": row.get("commitDate"), "versionInferred": row.get("versionInferred"),
              "status": row["status"], "catalog": row["catalog"], "updated": row.get("updated"),
              "atCommit": ref == row.get("commit")}
    deployed = _deployed(host_id, row, result) if row["status"] != "Linked" and row.get("catalogId") else None
    return jsonify({**result, "source": source, "deployed": deployed})


@analyze_bp.get("/hosts/<host_id>/analyze/file")
@host_errors
def analyze_file(host_id: str):
    row = _row(host_id, request.args.get("key") or "")
    if not row or not row.get("repoUrl"):
        return jsonify({"error": "Model not found on this host"}), 404
    try:
        files, ref = _files(row, False)
    except PermissionError as e:
        return jsonify({"error": str(e), "needsGit": True}), 409
    except github.GitError as e:
        return jsonify({"error": str(e)}), 502
    path = request.args.get("path") or ""
    if path not in files:
        return jsonify({"error": f"{path} is not in the repo at {ref}"}), 404
    return jsonify({"path": path, "ref": ref, "content": files[path]})
