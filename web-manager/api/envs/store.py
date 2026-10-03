"""Business units, hosts and Git profiles, backed by connections.yaml (gitignored).

A business unit (BU) is an isolated realm, like a Keycloak realm: its own Git
profile and its own hosts in the four groups (dev / test / qa / prod). Hosts
keep the ps-utils connection entry shape (`connections.<name>.atscale: {url,
username, password, apiToken, insecure}`), extended with `bu`, `env`,
`label`, `status`, `lastChecked` and `links` (repo/branch/model the user
linked through this app). Host ids are unique across BUs. BUs and their Git
profiles live under `businessUnits.<id>: {label, git}`, and each BU's
pipeline settings (orchestrator, gate policy, hashed API tokens) under
`businessUnits.<id>.pipeline` - see pipeline/config.py.

Files from before BUs (one Git profile at `connections.git.git`, hosts with
no `bu`) are read as a single BU, `default`, and written back in the new shape.
"""

from __future__ import annotations

import os
import re
import threading
import uuid
from pathlib import Path
from typing import Any

import yaml

ENVS = ("dev", "test", "qa", "prod")
GIT_KEY = "git"  # pre-BU files kept the one Git profile at connections.git.git
BU_KEY = "businessUnits"
LEGACY_BU = "default"
_API_DIR = Path(__file__).resolve().parent.parent
DEFAULT_PATH = Path(os.environ.get("ENV_MANAGER_CONNECTIONS_FILE", _API_DIR / "connections.yaml"))

_lock = threading.RLock()
#: Earlier commits kept per deployed catalog (record_deployment).
DEPLOY_HISTORY = 10


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
        data: dict[str, Any] = {}
        if self.path.exists():
            with self.path.open("r", encoding="utf-8") as f:
                data = yaml.safe_load(f) or {}
        data.setdefault("connections", {})
        _migrate(data)
        return data

    def _write(self, data: dict[str, Any]) -> None:
        self.path.parent.mkdir(parents=True, exist_ok=True)
        tmp = self.path.with_suffix(".yaml.tmp")
        ordered = {BU_KEY: data[BU_KEY], **{k: v for k, v in data.items() if k != BU_KEY}}
        with tmp.open("w", encoding="utf-8") as f:
            yaml.safe_dump(ordered, f, sort_keys=False, allow_unicode=True)
        os.chmod(tmp, 0o600)
        tmp.replace(self.path)

    # -- hosts ----------------------------------------------------------------------
    def _host_entries(self, data: dict[str, Any]) -> dict[str, dict[str, Any]]:
        return {k: v for k, v in data["connections"].items() if isinstance(v, dict) and "atscale" in v}

    def list_hosts_raw(self, bu: str | None = None) -> list[dict[str, Any]]:
        """Every host, or only those of business unit `bu`."""
        with _lock:
            data = self._read()
            return [{"id": k, **v} for k, v in self._host_entries(data).items() if bu is None or v["bu"] == bu]

    def get_host_raw(self, host_id: str) -> dict[str, Any] | None:
        with _lock:
            entry = self._host_entries(self._read()).get(host_id)
            return {"id": host_id, **entry} if entry else None

    def add_host(self, body: dict[str, Any], bu: str) -> dict[str, Any]:
        env = body.get("env")
        if env not in ENVS:
            raise ValueError(f"env must be one of {ENVS}")
        with _lock:
            data = self._read()
            if bu not in data[BU_KEY]:
                raise KeyError(bu)
            label = (body.get("label") or "").strip() or f"{env}-host-{len(self._host_entries(data)) + 1}"
            host_id = _unique_id(label, data["connections"])
            hostname = normalize_hostname(body.get("hostname", ""))
            data["connections"][host_id] = {
                "bu": bu,
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
                # The commits this catalog ran before, newest first - what the
                # pipeline's rollback redeploys (pipeline/steps.py).
                # A rollback passes its own history (the commit it left is dropped, not kept).
                old = deps.get(catalog_id) or {}
                history = list(record["history"] if "history" in record else old.get("history") or [])
                if "history" not in record and old.get("commit") and old["commit"] != record.get("commit"):
                    history.insert(0, {k: old.get(k) for k in ("commit", "commitDate", "branch", "deployedAt")})
                deps[catalog_id] = {**record, "history": history[:DEPLOY_HISTORY]}
            self._write(data)

    # -- business units ---------------------------------------------------------------
    def list_bus(self) -> list[dict[str, Any]]:
        with _lock:
            return [{"id": k, **v} for k, v in self._read()[BU_KEY].items()]

    def get_bu(self, bu: str) -> dict[str, Any] | None:
        with _lock:
            entry = self._read()[BU_KEY].get(bu)
            return {"id": bu, **entry} if entry else None

    def default_bu(self) -> str:
        """The first business unit - the one a request without a BU works in."""
        with _lock:
            return next(iter(self._read()[BU_KEY]))

    def add_bu(self, label: str) -> dict[str, Any]:
        label = (label or "").strip()
        if not label:
            raise ValueError("A business unit needs a name")
        with _lock:
            data = self._read()
            if any(v.get("label", "").lower() == label.lower() for v in data[BU_KEY].values()):
                raise ValueError(f"A business unit named '{label}' already exists")
            bu = _unique_id(label, data[BU_KEY], fallback="bu")
            data[BU_KEY][bu] = {"label": label, "git": {}}
            self._write(data)
            return {"id": bu, **data[BU_KEY][bu]}

    def update_bu(self, bu: str, patch: dict[str, Any]) -> dict[str, Any]:
        with _lock:
            data = self._read()
            entry = data[BU_KEY].get(bu)
            if entry is None:
                raise KeyError(bu)
            if "label" in patch:
                label = (patch["label"] or "").strip()
                if not label:
                    raise ValueError("A business unit needs a name")
                if any(k != bu and v.get("label", "").lower() == label.lower() for k, v in data[BU_KEY].items()):
                    raise ValueError(f"A business unit named '{label}' already exists")
                entry["label"] = label
            self._write(data)
            return {"id": bu, **entry}

    def delete_bu(self, bu: str) -> None:
        """Only an empty BU goes, and never the last one: its hosts would be
        orphaned, and every request needs a BU to work in."""
        with _lock:
            data = self._read()
            if bu not in data[BU_KEY]:
                raise KeyError(bu)
            if any(v["bu"] == bu for v in self._host_entries(data).values()):
                raise ValueError("Remove this business unit's hosts first")
            if len(data[BU_KEY]) == 1:
                raise ValueError("The last business unit can't be removed")
            del data[BU_KEY][bu]
            self._write(data)

    # -- git (one profile per business unit) ------------------------------------------
    def get_git_raw(self, bu: str) -> dict[str, Any]:
        with _lock:
            entry = self._read()[BU_KEY].get(bu) or {}
            return dict(entry.get("git") or {})

    def update_git(self, bu: str, patch: dict[str, Any]) -> dict[str, Any]:
        with _lock:
            data = self._read()
            entry = data[BU_KEY].get(bu)
            if entry is None:
                raise KeyError(bu)
            git = entry.setdefault("git", {})
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


    # -- pipeline (one per business unit; shape and defaults in pipeline/config.py) ----
    def get_pipeline_raw(self, bu: str) -> dict[str, Any]:
        with _lock:
            entry = self._read()[BU_KEY].get(bu) or {}
            return dict(entry.get("pipeline") or {})

    def update_pipeline(self, bu: str, fn) -> dict[str, Any]:
        """Read-modify-write the BU's pipeline settings under the store lock:
        `fn(settings) -> settings`."""
        with _lock:
            data = self._read()
            entry = data[BU_KEY].get(bu)
            if entry is None:
                raise KeyError(bu)
            entry["pipeline"] = fn(dict(entry.get("pipeline") or {}))
            self._write(data)
            return dict(entry["pipeline"])

    def all_pipelines(self) -> list[tuple[str, dict[str, Any]]]:
        """(bu, settings) for every BU - an API token is looked up across them."""
        with _lock:
            return [(k, dict(v.get("pipeline") or {})) for k, v in self._read()[BU_KEY].items()]


def _migrate(data: dict[str, Any]) -> None:
    """In place: a pre-BU file becomes BU `default` holding its Git profile;
    a host whose BU is missing or unknown joins the first BU."""
    legacy = data["connections"].pop(GIT_KEY, None)
    bus = data.get(BU_KEY)
    if not isinstance(bus, dict) or not bus:
        git = dict((legacy or {}).get("git") or {}) if isinstance(legacy, dict) else {}
        bus = data[BU_KEY] = {LEGACY_BU: {"label": "Default", "git": git}}
    first = next(iter(bus))
    for v in data["connections"].values():
        if isinstance(v, dict) and "atscale" in v and v.get("bu") not in bus:
            v["bu"] = first


def _unique_id(label: str, existing: dict[str, Any], fallback: str = "host") -> str:
    base = re.sub(r"[^a-z0-9]+", "-", label.lower()).strip("-") or fallback
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
        "bu": raw.get("bu"),
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


def public_bu(raw: dict[str, Any], hosts: list[dict[str, Any]]) -> dict[str, Any]:
    """API view of a business unit: name, host count per group, Git status (no token)."""
    mine = [h for h in hosts if h.get("bu") == raw["id"]]
    return {
        "id": raw["id"],
        "label": raw.get("label") or raw["id"],
        "hosts": len(mine),
        "groups": {e: sum(1 for h in mine if h.get("env") == e) for e in ENVS},
        "git": public_git(raw.get("git") or {}),
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
