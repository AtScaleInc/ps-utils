"""Settings: business units, host registry CRUD + test, each BU's Git profile."""

from __future__ import annotations

from flask import Blueprint, jsonify, request

import threading

import cache
from atscale import github
from atscale.backend import now_iso
from envs import registry
from envs.store import ENVS, public_bu, public_git, public_host

settings_bp = Blueprint("settings", __name__)


def _body() -> dict:
    return request.get_json(force=True, silent=True) or {}


# -- business units ---------------------------------------------------------------------

@settings_bp.get("/bus")
def list_bus():
    """Every business unit - the header's picker. Not scoped to the request's BU."""
    s = registry.store()
    hosts = s.list_hosts_raw()
    return jsonify({"bus": [public_bu(b, hosts) for b in s.list_bus()], "current": registry.bu(),
                    "fake": registry.FAKE})


@settings_bp.post("/bus")
def add_bu():
    try:
        raw = registry.store().add_bu(_body().get("label", ""))
    except ValueError as e:
        return jsonify({"error": str(e)}), 400
    return jsonify(public_bu(raw, [])), 201


@settings_bp.patch("/bus/<bu_id>")
def patch_bu(bu_id: str):
    s = registry.store()
    try:
        raw = s.update_bu(bu_id, {k: v for k, v in _body().items() if k == "label"})
    except KeyError:
        return jsonify({"error": "Unknown business unit"}), 404
    except ValueError as e:
        return jsonify({"error": str(e)}), 400
    return jsonify(public_bu(raw, s.list_hosts_raw(bu_id)))


@settings_bp.delete("/bus/<bu_id>")
def delete_bu(bu_id: str):
    try:
        registry.store().delete_bu(bu_id)
    except KeyError:
        return jsonify({"error": "Unknown business unit"}), 404
    except ValueError as e:
        return jsonify({"error": str(e)}), 409
    registry.forget_bu(bu_id)
    return jsonify({"ok": True})


# -- hosts (the request's business unit only) ------------------------------------------------

@settings_bp.get("/hosts")
def list_hosts():
    hosts = [public_host(h) for h in registry.bu_hosts()]
    return jsonify({"hosts": hosts, "groups": {e: [h["id"] for h in hosts if h["env"] == e] for e in ENVS},
                    "bu": registry.bu(), "fake": registry.FAKE})


@settings_bp.post("/hosts")
def add_host():
    try:
        raw = registry.store().add_host(_body(), registry.bu())
    except ValueError as e:
        return jsonify({"error": str(e)}), 400
    return jsonify(public_host(raw)), 201


@settings_bp.patch("/hosts/<host_id>")
def patch_host(host_id: str):
    body = {k: v for k, v in _body().items() if k in {"label", "hostname", "username", "password", "apiToken", "insecure", "env"}}
    try:
        registry.host(host_id)  # another BU's host is not found
        raw = registry.store().update_host(host_id, body)
        registry.forget_host(host_id)
    except KeyError:
        return jsonify({"error": "Unknown host"}), 404
    except ValueError as e:
        return jsonify({"error": str(e)}), 400
    return jsonify(public_host(raw))


@settings_bp.delete("/hosts/<host_id>")
def delete_host(host_id: str):
    try:
        registry.host(host_id)
        registry.store().delete_host(host_id)
        registry.forget_host(host_id)
        from monitor import store as monitor_store

        monitor_store.delete_host(host_id)  # its query history goes with it
    except KeyError:
        return jsonify({"error": "Unknown host"}), 404
    return jsonify({"ok": True})


@settings_bp.post("/hosts/<host_id>/test")
def test_host(host_id: str):
    registry.forget_host(host_id)
    try:
        registry.backend(host_id).test()
        status, error = "connected", None
    except registry.HostNotFound:
        return jsonify({"error": "Unknown host"}), 404
    except Exception as e:  # noqa: BLE001 - any failure means "failed"
        status, error = "failed", str(e)
    raw = registry.store().update_host(host_id, {"status": status, "lastChecked": now_iso()})
    if status == "connected":
        # Capture this host's ids (catalog/model, key names, aggregate instances) in the background.
        threading.Thread(target=registry.capture_host, args=(host_id,), daemon=True).start()
    return jsonify({**public_host(raw), "error": error})


# -- Git profile (the request's business unit) -------------------------------------------------

@settings_bp.get("/git")
def get_git():
    return jsonify(public_git(registry.git_profile()))


@settings_bp.put("/git")
def put_git():
    body = {k: v for k, v in _body().items() if k in {"username", "email", "token"}}
    raw = registry.store().update_git(registry.bu(), body)
    registry.forget_bu(registry.bu())  # versions, branches + Git lists depend on the token
    return jsonify(public_git(raw))


@settings_bp.post("/git/test")
def test_git():
    token = registry.git_token()
    error = None
    if not token:
        status, error = "failed", "No token saved"
    elif registry.FAKE:
        status = "connected"
    else:
        try:
            github.test_token(token)
            status = "connected"
        except Exception as e:  # noqa: BLE001
            status, error = "failed", str(e)
    raw = registry.store().update_git(registry.bu(), {"status": status, "lastChecked": now_iso()})
    return jsonify({**public_git(raw), "error": error})


@settings_bp.get("/git/repos")
def git_repos():
    """Repos offered in "Link model": the Git profile's repos that carry a
    root catalog.yml (PythonAtscaleUtility git_operations.get_repos_with_catalog)."""
    if registry.FAKE:
        from atscale.fake import FAKE_REPOS

        return jsonify({"repos": [{"url": u, "fullName": u.split("github.com/")[1], "defaultBranch": "main",
                                   "models": ms} for u, ms in FAKE_REPOS.items()]})
    token = registry.git_token()
    if not token:
        return jsonify({"error": "Git profile is missing - set it in Settings"}), 400
    try:
        return jsonify({"repos": github.list_catalog_repos(token)})
    except github.GitError as e:
        return jsonify({"error": str(e)}), 502


@settings_bp.get("/git/repos/models")
def git_repo_models():
    url, branch = request.args.get("url", ""), request.args.get("branch", "main")
    if registry.FAKE:
        from atscale.fake import FAKE_REPOS

        return jsonify({"models": FAKE_REPOS.get(url, [])})
    token = registry.git_token()
    if not token:
        return jsonify({"error": "Git profile is missing - set it in Settings"}), 400
    try:
        return jsonify({"models": github.models_in_files(github.fetch_sml_files(token, url, branch))})
    except github.GitError as e:
        return jsonify({"error": str(e)}), 502


@settings_bp.get("/cache")
def cache_listing():
    """What's in the working folder's cache (workspace/cache/)."""
    return jsonify({"dir": str(cache.DIR), "ttlSeconds": cache.TTL, "entries": cache.summary()})


@settings_bp.delete("/cache")
def cache_clear():
    cache.clear()
    return jsonify({"ok": True})


@settings_bp.post("/demo/reset")
def demo_reset():
    if not registry.FAKE:
        return jsonify({"error": "Only available with ENV_MANAGER_FAKE=1"}), 400
    s = registry.store()
    for h in s.list_hosts_raw():
        s.delete_host(h["id"])
    registry.seed_fake(s)
    return jsonify({"ok": True})
