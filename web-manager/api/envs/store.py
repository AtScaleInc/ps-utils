"""Host + Git profile store backed by connections.yaml (gitignored).

Same file shape sml-wizard's config.py reads (reference/ps-utils connection
entries: `connections.<name>.atscale: {url, username, password, apiToken,
insecure}`), extended per host with `env`, `label`, `status`, `lastChecked`
and `links` (repo/branch/model the user linked through this app). The shared
Git profile lives at `connections.git.git`, exactly like sml-wizard's.
"""

from __future__ import annotations

import os
import re
import threading
import uuid
from pathlib import Path
from typing import Any

import yaml

ENVS = ("dev", "qa", "prod")
GIT_KEY = "git"
_API_DIR = Path(__file__).resolve().parent.parent
DEFAULT_PATH = Path(os.environ.get("ENV_MANAGER_CONNECTIONS_FILE", _API_DIR / "connections.yaml"))

_lock = threading.RLock()


def normalize_hostname(raw: str) -> str:
    """Every host is a container reached at https://{hostname} - drop any
    scheme, port, path or trailing slash the user pasted in."""
    h = (raw or "").strip()
    h = re.sub(r"^[a-zA-Z][a-zA-Z0-9+.-]*://", "", h)
    h = h.split("/", 1)[0]
    h = h.split("@")[-1]
    h = re.sub(r":\d+$", "", h)
    return h.lower()


def hostname_from_url(url: str) -> str:
    return normalize_hostname(url or "")


class Store:
    def __init__(self, path: Path | str = DEFAULT_PATH):
        self.path = Path(path)

    # -- raw file io ---------------------------------------------------------------
    def _read(self) -> dict[str, Any]:
        if not self.path.exists():
            return {"connections": {}}
        with self.path.open("r", encoding="utf-8") as f:
            data = yaml.safe_load(f) or {}
        data.setdefault("connections", {})
        return data

    def _write(self, data: dict[str, Any]) -> None:
        self.path.parent.mkdir(parents=True, exist_ok=True)
        tmp = self.path.with_suffix(".yaml.tmp")
        with tmp.open("w", encoding="utf-8") as f:
            yaml.safe_dump(data, f, sort_keys=False, allow_unicode=True)
        os.chmod(tmp, 0o600)
        tmp.replace(self.path)

    # -- hosts ----------------------------------------------------------------------
    def _host_entries(self, data: dict[str, Any]) -> dict[str, dict[str, Any]]:
        return {k: v for k, v in data["connections"].items() if isinstance(v, dict) and "atscale" in v}

    def list_hosts_raw(self) -> list[dict[str, Any]]:
        with _lock:
            data = self._read()
            return [{"id": k, **v} for k, v in self._host_entries(data).items()]

    def get_host_raw(self, host_id: str) -> dict[str, Any] | None:
        with _lock:
            entry = self._host_entries(self._read()).get(host_id)
            return {"id": host_id, **entry} if entry else None

    def add_host(self, body: dict[str, Any]) -> dict[str, Any]:
        env = body.get("env")
        if env not in ENVS:
            raise ValueError(f"env must be one of {ENVS}")
        with _lock:
            data = self._read()
            label = (body.get("label") or "").strip() or f"{env}-host-{len(self._host_entries(data)) + 1}"
            host_id = _unique_id(label, data["connections"])
            hostname = normalize_hostname(body.get("hostname", ""))
            data["connections"][host_id] = {
                "env": env,
                "label": label,
                "status": "untested",
                "lastChecked": None,
                "atscale": {
                    "url": f"https://{hostname}" if hostname else "",
                    "username": body.get("username") or "",
                    "password": body.get("password") or "",
                    "apiToken": body.get("apiToken") or "",
                    "insecure": bool(body.get("insecure", True)),
                },
                "links": [],
            }
            self._write(data)
            return {"id": host_id, **data["connections"][host_id]}

    def update_host(self, host_id: str, patch: dict[str, Any]) -> dict[str, Any]:
        with _lock:
            data = self._read()
            entry = self._host_entries(data).get(host_id)
            if entry is None:
                raise KeyError(host_id)
            at = entry["atscale"]
            reset = False
            if "hostname" in patch:
                hostname = normalize_hostname(patch["hostname"])
                new_url = f"https://{hostname}" if hostname else ""
                reset |= new_url != at.get("url")
                at["url"] = new_url
            for field in ("username", "password", "apiToken"):
                # Secrets are never echoed to the UI, so an absent/None value
                # means "leave as is"; an explicit "" clears it.
                if field in patch and patch[field] is not None:
                    reset |= patch[field] != at.get(field)
                    at[field] = patch[field]
            if "insecure" in patch:
                at["insecure"] = bool(patch["insecure"])
            if "label" in patch:
                entry["label"] = (patch["label"] or "").strip() or entry["label"]
            if "env" in patch:
                if patch["env"] not in ENVS:
                    raise ValueError(f"env must be one of {ENVS}")
                entry["env"] = patch["env"]
            for field in ("status", "lastChecked"):
                if field in patch:
                    entry[field] = patch[field]
            if reset:
                entry["status"] = "untested"
                entry["lastChecked"] = None
            self._write(data)
            return {"id": host_id, **entry}

    def delete_host(self, host_id: str) -> None:
        with _lock:
            data = self._read()
            if host_id not in self._host_entries(data):
                raise KeyError(host_id)
            del data["connections"][host_id]
            self._write(data)

    def set_links(self, host_id: str, links: list[dict[str, Any]]) -> None:
        with _lock:
            data = self._read()
            entry = self._host_entries(data).get(host_id)
            if entry is None:
                raise KeyError(host_id)
            entry["links"] = links
            self._write(data)

    def record_deployment(self, host_id: str, catalog_id: str, record: dict[str, Any] | None) -> None:
        """What this app deployed per catalog (repoUrl, branch, commit, deployedAt) -
        AtScale itself keeps no commit for a deployment. None forgets it."""
        with _lock:
            data = self._read()
            entry = self._host_entries(data).get(host_id)
            if entry is None:
                raise KeyError(host_id)
            deps = entry.setdefault("deployments", {})
            if record is None:
                deps.pop(catalog_id, None)
            else:
                deps[catalog_id] = record
            self._write(data)

    # -- git ------------------------------------------------------------------------
    def get_git_raw(self) -> dict[str, Any]:
        with _lock:
            conn = self._read()["connections"].get(GIT_KEY) or {}
            return dict(conn.get("git") or {})

    def update_git(self, patch: dict[str, Any]) -> dict[str, Any]:
        with _lock:
            data = self._read()
            conn = data["connections"].setdefault(GIT_KEY, {})
            git = conn.setdefault("git", {})
            changed = False
            for field in ("username", "email"):
                if field in patch and patch[field] is not None:
                    changed |= patch[field] != git.get(field)
                    git[field] = patch[field]
            if patch.get("token") is not None:
                changed |= patch["token"] != git.get("token")
                git["token"] = patch["token"]
            for field in ("status", "lastChecked"):
                if field in patch:
                    git[field] = patch[field]
            if changed:
                git["status"] = "untested"
                git["lastChecked"] = None
            self._write(data)
            return dict(git)


def _unique_id(label: str, existing: dict[str, Any]) -> str:
    base = re.sub(r"[^a-z0-9]+", "-", label.lower()).strip("-") or "host"
    if base == GIT_KEY:
        base = "host-git"
    candidate = base
    while candidate in existing:
        candidate = f"{base}-{uuid.uuid4().hex[:4]}"
    return candidate


def public_host(raw: dict[str, Any]) -> dict[str, Any]:
    """API view of a host - never includes password or token."""
    at = raw.get("atscale", {})
    return {
        "id": raw["id"],
        "env": raw.get("env"),
        "label": raw.get("label") or raw["id"],
        "hostname": hostname_from_url(at.get("url", "")),
        "username": at.get("username") or "",
        "hasPassword": bool(at.get("password")),
        "hasToken": bool(at.get("apiToken")),
        "insecure": bool(at.get("insecure", True)),
        "status": raw.get("status") or "untested",
        "lastChecked": raw.get("lastChecked"),
    }


def public_git(raw: dict[str, Any]) -> dict[str, Any]:
    return {
        "username": raw.get("username") or "",
        "email": raw.get("email") or "",
        "hasToken": bool(raw.get("token")),
        "status": raw.get("status") or ("untested" if raw.get("token") else "missing"),
        "lastChecked": raw.get("lastChecked"),
    }


def profile_to_connection(raw: dict[str, Any]) -> dict[str, Any]:
    """The single adapter from a stored host to the ps-utils connection entry
    shape (`atscale: {url, username, password, apiToken, insecure}`)."""
    at = raw.get("atscale", {})
    hostname = hostname_from_url(at.get("url", ""))
    return {
        "atscale": {
            "url": f"https://{hostname}" if hostname else "",
            "username": at.get("username") or None,
            "password": at.get("password") or None,
            "apiToken": at.get("apiToken") or None,
            "insecure": bool(at.get("insecure", True)),
        }
    }
