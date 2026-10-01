"""Manage: models (list/link/deploy/unlink) and aggregates (list/active/build)."""

from __future__ import annotations

from functools import wraps

from flask import Blueprint, jsonify, request

import jobs
from atscale.backend import NotPorted
from atscale.client import AtScaleApiError, AtScaleAuthError
from envs import registry

objects_bp = Blueprint("objects", __name__)


def _body() -> dict:
    return request.get_json(force=True, silent=True) or {}


def host_errors(fn):
    @wraps(fn)
    def wrapper(*args, **kwargs):
        try:
            return fn(*args, **kwargs)
        except registry.HostNotFound:
            return jsonify({"error": "Unknown host"}), 404
        except NotPorted as e:
            return jsonify({"error": str(e), "gap": True}), 501
        except AtScaleAuthError as e:
            return jsonify({"error": str(e)}), 401
        except AtScaleApiError as e:
            return jsonify({"error": f"AtScale returned {e.status}: {e.body[:300]}"}), 502
        except ValueError as e:
            return jsonify({"error": str(e)}), 400
    return wrapper


def _refresh() -> bool:
    return request.args.get("refresh") in ("1", "true")


def _cached(key: str, b, value):
    """List payload + when it was loaded from AtScale (epoch seconds)."""
    return jsonify({key: value, "cachedAt": b.loaded_at})


def _require_git():
    if not registry.git_ready():
        return jsonify({"error": "Git profile is missing or failed its test - fix it in Settings", "needsGit": True}), 409
    return None


# -- models --------------------------------------------------------------------------------

@objects_bp.get("/hosts/<host_id>/models")
@host_errors
def list_models(host_id: str):
    b = registry.backend(host_id, _refresh())
    return _cached("models", b, b.list_models())


@objects_bp.get("/hosts/<host_id>/repos")
@host_errors
def list_repos(host_id: str):
    b = registry.backend(host_id, _refresh())
    return _cached("repos", b, b.list_repos())


@objects_bp.post("/hosts/<host_id>/models/link")
@host_errors
def link_model(host_id: str):
    if (resp := _require_git()):
        return resp
    b = _body()
    if not b.get("repoUrl") or not b.get("model"):
        return jsonify({"error": "repoUrl and model are required"}), 400
    result = registry.backend(host_id).link(b["repoUrl"], b.get("branch") or "main", b["model"])
    return jsonify({"ok": True, **result})


@objects_bp.post("/hosts/<host_id>/models/deploy")
@host_errors
def deploy_models(host_id: str):
    if (resp := _require_git()):
        return resp
    # models: ["key", ...] or [{"key", "branch"}, ...] - branch overrides the linked one.
    items = [m if isinstance(m, dict) else {"key": m} for m in (_body().get("models") or [])]
    if not items:
        return jsonify({"error": "No models selected"}), 400
    keys = [m["key"] for m in items]
    branches = {m["key"]: m["branch"] for m in items if m.get("branch")}
    backend = registry.backend(host_id)
    return jsonify(jobs.submit("deploy", lambda: {"results": backend.deploy(keys, branches)})), 202


@objects_bp.post("/hosts/<host_id>/models/undeploy")
@host_errors
def undeploy_models(host_id: str):
    """Undeploy the catalogs holding these models (whole catalog - AtScale has no
    per-model undeploy). The repo link stays."""
    keys = _body().get("models") or []
    if not keys:
        return jsonify({"error": "No models selected"}), 400
    return jsonify(registry.backend(host_id).undeploy(keys))


@objects_bp.post("/hosts/<host_id>/models/unlink")
@host_errors
def unlink_models(host_id: str):
    """Undeploy (drops aggregates) + detach the repo. Git is untouched."""
    keys = _body().get("models") or []
    if not keys:
        return jsonify({"error": "No models selected"}), 400
    return jsonify(registry.backend(host_id).unlink(keys))


@objects_bp.get("/hosts/<host_id>/branches")
@host_errors
def branches(host_id: str):
    url = request.args.get("url", "")
    if not url:
        return jsonify({"error": "url is required"}), 400
    b = registry.backend(host_id, _refresh())
    return _cached("branches", b, b.branches(url))


# -- aggregates ----------------------------------------------------------------------------

def _model_args() -> tuple[str, str]:
    src = request.args if request.method == "GET" else _body()
    catalog_id, model_id = src.get("catalogId"), src.get("modelId")
    if not catalog_id or not model_id:
        raise ValueError("catalogId and modelId are required")
    return catalog_id, model_id


@objects_bp.get("/hosts/<host_id>/aggregate-models")
@host_errors
def agg_models(host_id: str):
    b = registry.backend(host_id, _refresh())
    return _cached("models", b, b.agg_models())


@objects_bp.get("/hosts/<host_id>/aggregates")
@host_errors
def list_aggregates(host_id: str):
    catalog_id, model_id = _model_args()
    b = registry.backend(host_id, _refresh())
    return _cached("aggregates", b, b.list_aggregates(catalog_id, model_id))


def _set_active(host_id: str, active: bool):
    catalog_id, model_id = _model_args()
    ids = _body().get("aggregates") or []
    if not ids:
        return jsonify({"error": "No aggregates selected"}), 400
    results = registry.backend(host_id).set_active(catalog_id, model_id, ids, active)
    return jsonify({"results": results})


@objects_bp.post("/hosts/<host_id>/aggregates/deactivate")
@host_errors
def deactivate(host_id: str):
    return _set_active(host_id, False)


@objects_bp.post("/hosts/<host_id>/aggregates/reactivate")
@host_errors
def reactivate(host_id: str):
    return _set_active(host_id, True)


@objects_bp.post("/hosts/<host_id>/aggregates/build")
@host_errors
def build(host_id: str):
    catalog_id, model_id = _model_args()
    mode = _body().get("mode", "full")
    if mode not in ("full", "incremental"):
        return jsonify({"error": "mode must be full or incremental"}), 400
    backend = registry.backend(host_id)
    return jsonify(jobs.submit("build", lambda: backend.build(catalog_id, model_id, mode == "full"))), 202


@objects_bp.get("/hosts/<host_id>/aggregates/builds")
@host_errors
def builds(host_id: str):
    catalog_id, model_id = _model_args()
    return jsonify({"builds": registry.backend(host_id).build_history(catalog_id, model_id)})


@objects_bp.get("/jobs/<job_id>")
def get_job(job_id: str):
    job = jobs.get(job_id)
    if not job:
        return jsonify({"error": "Unknown job"}), 404
    return jsonify(job)
