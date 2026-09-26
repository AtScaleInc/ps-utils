"""Per-host operations the routes call, normalised into the row shapes the UI
renders. `RealBackend` talks to an AtScale **container** host; `atscale/fake.py`
is the in-memory stand-in used when ENV_MANAGER_FAKE=1 (demo + tests).

Units of work, as AtScale defines them:
  - A Git repo holds one SML catalog; deploy and undeploy act on a whole catalog
    (every model in it) - there is no per-model undeploy.
  - A deployed model's *version* is the Git commit it was built from. AtScale
    stores no commit, so it is recorded here on deploy, or inferred from
    `publishedAt` for catalogs deployed outside this app.
"""

from __future__ import annotations

from datetime import datetime, timezone
import hashlib
import json
from typing import Any, Protocol

from envs.store import Store, profile_to_connection

from promote.idmap import id_names, translate_plan

from . import github
from .client import AtScaleApiError, AtScaleClient, AtScaleEnvironment


class NotPorted(RuntimeError):
    """The operation has no source in reference/ to port from."""


class Backend(Protocol):
    def test(self) -> None: ...
    def list_models(self) -> list[dict[str, Any]]: ...
    def list_repos(self) -> list[dict[str, Any]]: ...
    def branches(self, repo_url: str) -> list[dict[str, Any]]: ...
    def link(self, repo_url: str, branch: str, model: str) -> dict[str, Any]: ...
    def deploy(self, keys: list[str], branches: dict[str, str] | None = None) -> list[dict[str, Any]]: ...
    def deploy_branch(self, repo_url: str, branch: str, replace_catalogs: list[str] | None = None) -> dict[str, Any]: ...
    def undeploy(self, keys: list[str]) -> dict[str, Any]: ...
    def unlink(self, keys: list[str]) -> dict[str, Any]: ...
    def compare(self, src: dict[str, Any], tgt: dict[str, Any]) -> str | None: ...
    def agg_models(self) -> list[dict[str, Any]]: ...
    def list_aggregates(self, catalog_id: str, model_id: str) -> list[dict[str, Any]]: ...
    def catalog_ids(self, catalog_id: str) -> dict[str, str]: ...
    def set_active(self, catalog_id: str, model_id: str, agg_ids: list[str], active: bool) -> list[dict[str, Any]]: ...
    def build(self, catalog_id: str, model_id: str, full: bool) -> dict[str, Any]: ...
    def build_history(self, catalog_id: str, model_id: str) -> list[dict[str, Any]]: ...
    def export_aggregates(self, catalog_id: str, model_id: str, agg_ids: list[str]) -> Any: ...
    def import_aggregates(self, catalog_id: str, model_id: str, payload: Any) -> dict[str, Any]: ...
    def model_connections(self, catalog_id: str, model_id: str) -> list[str]: ...


def now_iso() -> str:
    return datetime.now(timezone.utc).replace(microsecond=0).isoformat().replace("+00:00", "Z")


# -- aggregate rows --------------------------------------------------------------------------
# Accepts both the engine's snake_case shape (GET /wapi/p/aggregate/definition,
# what list_aggregates uses) and the public API's camelCase (GET /v1/aggregates).

_BUILDING = {"new", "inprogress", "in_progress", "pending"}
_STATUS = {"active": "Built", "done": "Built", "invalid": "Invalid", "failed": "Error", "unreliable": "Error",
           "cancelled": "Error", "deleted": "Inactive"}


def _g(d: dict[str, Any], camel: str, snake: str) -> Any:
    return d.get(camel) if d.get(camel) is not None else d.get(snake)


def agg_signature(attributes: list[dict[str, Any]]) -> str:
    """System aggregate names are generated UUIDs that differ per host, so an
    aggregate is identified across hosts by the attribute set it materialises."""
    return "|".join(sorted(f"{a.get('type')}:{a.get('name')}" for a in attributes or []))


def _strip(o: Any) -> Any:
    """Drop what legitimately differs between hosts: column aliases and the
    owning model's id (the plan's object ids are UUIDv5s derived from SML, so
    they are the same everywhere the same SML is deployed)."""
    if isinstance(o, dict):
        return {k: _strip(v) for k, v in sorted(o.items()) if k not in ("alias", "model")}
    if isinstance(o, list):
        return [_strip(v) for v in o]
    return o


def plan_fingerprint(plan: Any, names: dict[str, str] | None = None) -> str | None:
    """Identity of an aggregate = the objects its logical plan selects, each with
    its aggregation function, from the export payload's `planJson`. Ids differ
    per host, so key / reference ids are first replaced by their names
    (`names`, from promote/idmap.id_names). Order-insensitive."""
    if isinstance(plan, str):
        try:
            plan = json.loads(plan)
        except ValueError:
            return None
    if names:
        plan = translate_plan(plan, names)
    columns = ((plan or {}).get("selection") or {}).get("columns")
    if not columns:
        return None
    canon = sorted(json.dumps(_strip({"value": c.get("value"), "agg": c.get("aggregation-type")}), sort_keys=True)
                   for c in columns)
    return hashlib.sha1("\n".join(canon).encode()).hexdigest()


def agg_label(agg: dict[str, Any]) -> str:
    """Readable name for a system aggregate (whose `name` is just its UUID):
    grain (dimensions, else keys) + how many measures it carries."""
    name = agg.get("name") or ""
    if name and name != agg.get("id"):
        return name
    attrs = agg.get("attributes") or []
    dims = list(dict.fromkeys(a["name"] for a in attrs if a.get("type") == "dimension"))
    keys = [k for k in dict.fromkeys(a["name"].removesuffix(" Key") for a in attrs if a.get("type") == "key") if k not in dims]
    grain = dims + keys
    n_measures = sum(1 for a in attrs if a.get("type") == "measure")
    head = " · ".join(grain[:3]) + (f" +{len(grain) - 3}" if len(grain) > 3 else "") if grain else "All"
    return f"{head} · {n_measures} measure{'s' if n_measures != 1 else ''}" if n_measures else head


def normalize_aggregate(agg: dict[str, Any], model_name: str) -> dict[str, Any]:
    latest = _g(agg, "latestInstance", "latest_instance") or {}
    active_inst = _g(agg, "activeInstance", "active_instance") or {}
    blocked = bool(agg.get("blocked", False))
    latest_status = str(latest.get("status") or "").lower()
    if blocked:
        status = "Inactive"
    elif latest_status in _BUILDING:
        status = "Building"
    elif str(active_inst.get("status") or "").lower() == "active":
        status = "Built"
    else:
        status = _STATUS.get(latest_status, "Stale")
    reason = _g(latest, "invalidationReason", "invalidation_reason") or agg.get("most_recent_invalidation_reason")
    if status == "Invalid" and reason == "failed_aggregate_removed":
        status = "Error"
    inst = active_inst or latest
    stats = inst.get("stats") or {}
    rows = _g(stats, "numberOfRows", "number_of_rows")
    return {
        "id": agg.get("id"),
        "instanceId": inst.get("id"),
        "name": agg_label(agg),
        "model": model_name,
        "modelId": _g(agg, "modelId", "cube_id"),
        "type": "USER" if str(agg.get("type") or "").lower().startswith("user") else "SYSTEM",
        "subtype": agg.get("subtype"),
        "size": f"{rows:,} rows" if isinstance(rows, int) else "—",
        "lastBuild": _g(stats, "materializationEndTime", "materialization_end_time"),
        "status": status,
        "statusNote": latest.get("message") if status in ("Invalid", "Error", "Stale") else None,
        "active": not blocked,
        "signature": agg_signature(agg.get("attributes") or []),
    }


def branch_from_project_name(project_name: str, branches: list[str]) -> str | None:
    """Design Center names a deployed project `<catalog>_<branch>` (see
    sml-wizard deploy.py / ps-utils AtScaleDeployCatalogOperation)."""
    matches = [b for b in branches if project_name.endswith(f"_{b}")]
    if matches:
        return max(matches, key=len)
    return project_name.rsplit("_", 1)[1] if "_" in project_name else None


class RealBackend:
    def __init__(self, host: dict[str, Any], store: Store, git: dict[str, Any] | None = None,
                 api: AtScaleClient | None = None):
        self.host = host
        self.store = store
        self.git = git or {}
        if api is None:
            conn = profile_to_connection(host)["atscale"]
            if not conn["url"]:
                raise ValueError("Host has no hostname set")
            api = AtScaleClient(AtScaleEnvironment(
                base_url=conn["url"], username=conn["username"], password=conn["password"],
                api_token=conn["apiToken"], insecure=conn["insecure"],
            ))
        self.api = api
        self._branch_cache: dict[str, list[str]] = {}

    @property
    def _token(self) -> str | None:
        return self.git.get("token") or None

    def _need_token(self) -> str:
        if not self._token:
            raise ValueError("Git profile is missing - set it in Settings")
        return self._token

    # -- settings -----------------------------------------------------------------------
    def test(self) -> None:
        # Auth + one cheap call (BUILD_INSTRUCTIONS §4: atScaleListDeployments as probe).
        self.api.env.authenticate(force=True)
        self.api.list_deployed_projects()

    # -- models ---------------------------------------------------------------------------
    def list_repos(self) -> list[dict[str, Any]]:
        return self.api.list_repos()

    def branches(self, repo_url: str) -> list[dict[str, Any]]:
        if repo_url not in self._branch_cache:
            self._branch_cache[repo_url] = github.list_branches(self._need_token(), repo_url)
        return self._branch_cache[repo_url]

    def _version(self, catalog_id: str, repo_url: str | None, branch: str | None, published_at: str | None) -> dict[str, Any]:
        rec = (self.host.get("deployments") or {}).get(catalog_id)
        if rec and rec.get("commit"):
            return {"commit": rec["commit"], "commitDate": rec.get("commitDate"), "versionInferred": False}
        if not (self._token and repo_url and branch and published_at):
            return {"commit": None, "commitDate": None, "versionInferred": False}
        try:
            c = github.commit_at(self._token, repo_url, branch, published_at)
        except github.GitError:
            c = None
        return {"commit": c["sha"] if c else None, "commitDate": c["date"] if c else None, "versionInferred": bool(c)}

    def list_models(self) -> list[dict[str, Any]]:
        repos = {r["id"]: r for r in self.api.list_repos()}
        published = {c["id"]: c for c in self.api.list_published_catalogs()}
        links = self.host.get("links") or []
        deployments = self.host.get("deployments") or {}
        rows: list[dict[str, Any]] = []
        for entry in self.api.list_deployed_projects():
            repo_id = entry.get("repoId")
            repo = repos.get(repo_id, {})
            repo_url = repo.get("url")
            for project in entry.get("projects") or []:
                cat_id = project.get("id")
                rec = deployments.get(cat_id) or {}
                branch = rec.get("branch")
                if not branch and repo_url:
                    try:
                        branch = branch_from_project_name(project.get("name") or "", [b["name"] for b in self.branches(repo_url)] if self._token else [])
                    except github.GitError:
                        branch = branch_from_project_name(project.get("name") or "", [])
                pub = published.get(cat_id) or {}
                version = self._version(cat_id, repo_url, branch, pub.get("publishedAt"))
                for model in project.get("models") or []:
                    if model.get("type") not in (None, "model"):
                        continue  # perspectives are views of a model, not deployable units
                    rows.append({
                        "key": f"{cat_id}:{model.get('id')}",
                        "name": model.get("caption") or model.get("name"),
                        "catalog": project.get("caption") or project.get("name"),
                        **version,
                        "version": (version["commit"] or "")[:7] or None,
                        "updated": pub.get("publishedAt"),
                        "status": "Deployed",
                        "catalogId": cat_id,
                        "modelId": model.get("id"),
                        "repoId": repo_id,
                        "repoUrl": repo_url,
                        "branch": branch or repo.get("defaultBranch") or "main",
                    })
        deployed = {(r["repoId"], r["name"]) for r in rows}
        deployed_repos = {r["repoId"] for r in rows}
        for link in links:
            repo = repos.get(link.get("repoId"))
            if repo and (repo["id"], link["model"]) not in deployed and repo["id"] not in deployed_repos:
                rows.append(_linked_row(repo, link["model"], link.get("branch")))
        linked = {l.get("repoId") for l in links}
        for repo_id, repo in repos.items():
            if repo_id not in deployed_repos and repo_id not in linked:
                rows.append(_linked_row(repo, None, None))
        return rows

    def compare(self, src: dict[str, Any], tgt: dict[str, Any]) -> str | None:
        if not (src.get("commit") and tgt.get("commit")):
            return None
        if src["commit"] == tgt["commit"]:
            return "identical"
        if github.normalize_repo_url(src.get("repoUrl") or "") != github.normalize_repo_url(tgt.get("repoUrl") or ""):
            return None
        return github.compare(self._need_token(), src["repoUrl"], tgt["commit"], src["commit"])

    def _ensure_repo(self, repo_url: str, branch: str) -> str:
        target = github.normalize_repo_url(repo_url)
        match = next((r for r in self.api.list_repos() if github.normalize_repo_url(r.get("url", "")) == target), None)
        if match:
            return match["id"]
        name = github.repo_full_name(repo_url).split("/")[1]
        try:
            return self.api.create_repo(name=name, url=repo_url, repo_type="catalog", default_branch=branch)["id"]
        except AtScaleApiError as e:
            # Same recovery as sml-wizard publish.py: AtScale's own URL dedup matched.
            if "already exists" not in e.body.lower():
                raise
            match = next((r for r in self.api.list_repos() if github.normalize_repo_url(r.get("url", "")) == target), None)
            if not match:
                raise
            return match["id"]

    def link(self, repo_url: str, branch: str, model: str) -> dict[str, Any]:
        repo_id = self._ensure_repo(repo_url, branch)
        links = [l for l in (self.host.get("links") or []) if l.get("repoId") != repo_id]
        links.append({"repoId": repo_id, "repoUrl": repo_url, "branch": branch, "model": model})
        self.store.set_links(self.host["id"], links)
        self.host["links"] = links
        return {"repoId": repo_id}

    def deploy_branch(self, repo_url: str, branch: str, replace_catalogs: list[str] | None = None) -> dict[str, Any]:
        """Deploy repo@branch (Container API POST /v1/catalogs/deploy - AtScale
        clones and compiles the SML) and record the commit it built.

        A different branch of the same repo deploys as its own catalog, so the
        old branch's catalog keeps running; `replace_catalogs` are undeployed
        once the new deploy succeeds."""
        token = self._need_token()
        commit = github.head_commit(token, repo_url, branch)
        try:
            self._ensure_repo(repo_url, branch)
            result = self.api.deploy_catalog_from_git(repo_url, branch, token, self.git.get("username"))
        except AtScaleApiError as e:
            return {"ok": False, "repoUrl": repo_url, "branch": branch, "error": f"{e.status}: {e.body[:300]}"}
        cat_id = result.get("catalogId")
        if cat_id:
            self.store.record_deployment(self.host["id"], cat_id, {
                "repoUrl": repo_url, "branch": branch, "commit": commit["sha"],
                "commitDate": commit["date"], "deployedAt": now_iso(),
            })
        warnings = [o.get("message") for o in ((result.get("compilationWarnings") or {}).get("globalOutput") or [])]
        replaced = []
        for old in replace_catalogs or []:
            if old and old != cat_id:
                errs = self.api.undeploy_catalog(old)
                warnings.extend(e for e in (errs if isinstance(errs, list) else []) if e)
                self.store.record_deployment(self.host["id"], old, None)
                replaced.append(old)
        return {"ok": True, "repoUrl": repo_url, "branch": branch, "catalogId": cat_id,
                "commit": commit["sha"], "replaced": replaced, "warnings": [w for w in warnings if w]}

    def deploy(self, keys: list[str], branches: dict[str, str] | None = None) -> list[dict[str, Any]]:
        """Deploy the catalogs behind `keys`; `branches` overrides the branch per key."""
        rows = {r["key"]: r for r in self.list_models()}
        targets: dict[tuple[str, str], list[str]] = {}
        results = []
        for key in keys:
            row = rows.get(key)
            if not row or not row.get("repoUrl"):
                results.append({"key": key, "ok": False, "error": "Model not found on host (or no repo URL)"})
                continue
            targets.setdefault((row["repoUrl"], (branches or {}).get(key) or row["branch"]), []).append(key)
        for (repo_url, branch), ks in targets.items():
            r = self.deploy_branch(repo_url, branch)
            results.extend({**r, "key": k} for k in ks)
        return results

    def undeploy(self, keys: list[str]) -> dict[str, Any]:
        rows = self.list_models()
        catalogs = {r["catalogId"] for r in rows if r["key"] in keys and r["catalogId"]}
        errors = []
        for cat_id in catalogs:
            result = self.api.undeploy_catalog(cat_id)
            errors.extend(e for e in (result if isinstance(result, list) else []) if e)
            self.store.record_deployment(self.host["id"], cat_id, None)
        removed = [r["key"] for r in rows if r["catalogId"] in catalogs]
        return {"removed": removed, "catalogs": sorted(catalogs), "warnings": errors}

    def unlink(self, keys: list[str]) -> dict[str, Any]:
        """Undeploy the catalog (which drops its aggregates), then detach the
        repo from AtScale. Git itself is untouched."""
        rows = self.list_models()
        selected = [r for r in rows if r["key"] in keys]
        repo_ids = {r["repoId"] for r in selected if r["repoId"]}
        undeployed = self.undeploy([r["key"] for r in rows if r["repoId"] in repo_ids and r["catalogId"]])
        for repo_id in repo_ids:
            # sml-wizard client.delete_repo = SML-develop api-sdk RepoApi DELETE /repo/{id}
            self.api.delete_repo(repo_id)
        links = [l for l in (self.host.get("links") or []) if l.get("repoId") not in repo_ids]
        self.store.set_links(self.host["id"], links)
        removed = sorted({*undeployed["removed"], *(r["key"] for r in selected)})
        return {"removed": removed, "catalogs": undeployed["catalogs"], "warnings": undeployed["warnings"]}

    # -- aggregates -----------------------------------------------------------------------
    def agg_models(self) -> list[dict[str, Any]]:
        return [
            {"catalogId": r["catalogId"], "modelId": r["modelId"], "name": r["name"], "catalog": r["catalog"]}
            for r in self._deployed_models()
        ]

    def _deployed_models(self) -> list[dict[str, Any]]:
        out = []
        for entry in self.api.list_deployed_projects():
            for project in entry.get("projects") or []:
                for model in project.get("models") or []:
                    if model.get("type") in (None, "model"):
                        out.append({"catalogId": project.get("id"), "modelId": model.get("id"),
                                    "name": model.get("caption") or model.get("name"),
                                    "catalog": project.get("caption") or project.get("name")})
        return out

    def _model_name(self, catalog_id: str, model_id: str) -> str:
        m = next((m for m in self._deployed_models() if m["catalogId"] == catalog_id and m["modelId"] == model_id), None)
        return m["name"] if m else model_id

    def list_aggregates(self, catalog_id: str, model_id: str) -> list[dict[str, Any]]:
        name = self._model_name(catalog_id, model_id)
        rows = [normalize_aggregate(a, name) for a in self.api.list_aggregates(catalog_id, model_id)]
        # Plan fingerprints come from the export payload (system-defined, built
        # definitions only); the rest match on their attribute signature.
        try:
            exported = self.api.export_aggregates(catalog_id, model_id)
        except AtScaleApiError:
            exported = {}
        names = self.catalog_ids(catalog_id)
        keys = {v.get("id"): plan_fingerprint(v.get("planJson"), names) for v in (exported.get("aggregates") or {}).get("values", [])}
        for r in rows:
            r["planKey"] = keys.get(r["id"])
            r["exportable"] = r["planKey"] is not None
        return rows

    def catalog_ids(self, catalog_id: str) -> dict[str, str]:
        """This host's id -> name map for the catalog's keys and references
        (GET /v1/catalogs/{id}/export, Container API "export-catalog-representation")."""
        rep = self.api._dispatch("GET", f"/v1/catalogs/{catalog_id}/export", headers={"Accept": "application/json"}, timeout=60).json()
        return id_names(rep)

    def set_active(self, catalog_id: str, model_id: str, agg_ids: list[str], active: bool) -> list[dict[str, Any]]:
        results = []
        for agg_id in agg_ids:
            try:
                body = self.api.unblock_aggregate(agg_id) if active else self.api.block_aggregate(agg_id)
                ok = body.get("unblocked" if active else "blocked", True)
                results.append({"id": agg_id, "ok": bool(ok), **({} if ok else {"error": "AtScale did not change it"})})
            except AtScaleApiError as e:
                results.append({"id": agg_id, "ok": False, "error": f"{e.status}: {e.body[:200]}"})
        return results

    def build(self, catalog_id: str, model_id: str, full: bool) -> dict[str, Any]:
        return self.api.rebuild_aggregates(catalog_id, model_id, full_build=full)

    def build_history(self, catalog_id: str, model_id: str) -> list[dict[str, Any]]:
        return self.api.list_aggregate_build_history(catalog_id, model_id)

    def export_aggregates(self, catalog_id: str, model_id: str, agg_ids: list[str]) -> Any:
        """Export (system-defined only), trimmed to the staged definitions."""
        payload = self.api.export_aggregates(catalog_id, model_id)
        values = [v for v in (payload.get("aggregates") or {}).get("values", []) if v.get("id") in set(agg_ids)]
        return {**payload, "aggregates": {"count": len(values), "values": values}}

    def import_aggregates(self, catalog_id: str, model_id: str, payload: Any) -> dict[str, Any]:
        """`payload` must already be remapped to this host's ids (promote/remap.py)."""
        return self.api.import_aggregates(catalog_id, model_id, payload)

    def model_connections(self, catalog_id: str, model_id: str) -> list[str]:
        cat = self.api.get_catalog(catalog_id)
        m = next((m for m in cat.get("models") or [] if m.get("id") == model_id), {})
        return list(m.get("connection_ids") or m.get("connectionIds") or [])


def _linked_row(repo: dict[str, Any], model: str | None, branch: str | None) -> dict[str, Any]:
    name = model or repo.get("name") or github.repo_full_name(repo.get("url", "")).split("/")[1]
    return {
        "key": f"repo:{repo.get('id')}",
        "name": name,
        "catalog": "—",
        "version": None,
        "commit": None,
        "commitDate": None,
        "versionInferred": False,
        "updated": None,
        "status": "Linked",
        "catalogId": None,
        "modelId": None,
        "repoId": repo.get("id"),
        "repoUrl": repo.get("url"),
        "branch": branch or repo.get("defaultBranch") or "main",
    }

