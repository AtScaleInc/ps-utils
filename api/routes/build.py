"""Build: the SML wizard (merged from sml-wizard), made host-aware.

sml-wizard held one logged-in AtScale session per browser; here every
host-bound call names a registered host instead (`/hosts/<id>/...`), and Git
credentials come from the shared Git profile in Settings.

  sources  GET  /hosts/<id>/sources, /hosts/<id>/sources/<sid>/schemas (table
           names), GET|POST /hosts/<id>/sources/<sid>/columns (per table, lazily)
           (sml-wizard routes/sources.py)
  sml      POST /sml/generate|validate|save|save-path|import|import-path|import-git,
           GET /sml/models (sml-wizard routes/sml.py)
  repos    GET/DELETE /hosts/<id>/build/repos (sml-wizard routes/sml.py
           list_attached_repos / unlink_attached_repo)
  discover /hosts/<id>/discovery/... - routes/discovery.py
  preview  /hosts/<id>/preview/catalogs|metadata|query (sml-wizard routes/preview.py)
  deploy   POST /build/deploy - generate -> save -> push to Git once -> deploy
           on every selected host via the same Container API deploy Promote
           uses (RealBackend.deploy_branch: POST /v1/catalogs/deploy, AtScale
           compiles the SML). Replaces sml-wizard routes/publish.py, whose local
           catalog-XML compile + /wapi/git/deploy/catalog path is dropped.
"""

from __future__ import annotations

import os
import re
import shutil
import threading
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
from typing import Any

from flask import Blueprint, jsonify, request

import cache
import jobs
from atscale.git_ops import ensure_github_repo, push_sml_to_repo, slugify_repo_name
from atscale.preview import MAX_ROWS, list_catalogs_and_cubes, load_cube_metadata, run_freehand_query, run_preview_query
from envs import registry
from routes.objects import host_errors
from smlgen.build import ValidationError, build_sml
from smlgen.naming import is_valid_model_name, slugify_model_name
from smlgen.parse import parse_sml
from smlgen.validate import SmlCliNotFound, validate_sml

build_bp = Blueprint("build", __name__)

_YAML_SUFFIXES = {".yml", ".yaml"}
_REQUIRED = {"modelName", "connectionName", "asConnection", "database", "schema", "nodes", "joins"}

# One working copy per model (sml-wizard config.model_workspace_dir), next to
# the list cache in the working folder. Demo mode keeps its own folder.
MODELS_ROOT = Path(os.environ.get("ENV_MANAGER_MODELS_DIR", "")) if os.environ.get("ENV_MANAGER_MODELS_DIR") \
    else cache.WORKSPACE / ("models-demo" if registry.FAKE else "models")


def _body() -> dict:
    return request.get_json(force=True, silent=True) or {}


def model_workspace_dir(model_name: str) -> Path:
    root = MODELS_ROOT / slugify_model_name(model_name)
    root.mkdir(parents=True, exist_ok=True)
    return root


def _read_sml_directory(root: Path) -> dict[str, str]:
    files: dict[str, str] = {}
    for path in root.rglob("*"):
        if ".git" in path.parts:
            continue
        if path.is_file() and path.suffix.lower() in _YAML_SUFFIXES:
            files[str(path.relative_to(root))] = path.read_text(encoding="utf-8")
    return files


def write_files(root: Path, files: list[dict[str, str]]) -> int:
    # sml-wizard routes/sml.py :: write_files
    root.mkdir(parents=True, exist_ok=True)
    for f in files:
        p = root / f["name"]
        p.parent.mkdir(parents=True, exist_ok=True)
        p.write_text(f["body"], encoding="utf-8")
    return len(files)


def _missing(payload: dict) -> Any:
    missing = _REQUIRED - payload.keys()
    if missing:
        return jsonify({"error": f"Missing fields: {sorted(missing)}"}), 400
    return None


# -- sources (sml-wizard routes/sources.py) --------------------------------------------------

# Schemas AtScale/Postgres/Databricks create for their own bookkeeping.
_SYSTEM_SCHEMA_PATTERNS = ("information_schema", "pg_catalog", "pg_toast", "pg_temp", "atscale_aggr")


def _is_system_schema(name: str, database: str) -> bool:
    lname = name.lower()
    return lname == database.lower() or any(lname.startswith(p) for p in _SYSTEM_SCHEMA_PATTERNS)


#: A sources list with an unreachable warehouse is re-read after a minute, not
#: cached for the full TTL - a suspended warehouse still resuming, or a blip,
#: would otherwise hide it for hours.
_SOURCES_RETRY_TTL = 60


def _sources_ttl(value: list[dict[str, Any]]) -> float:
    return _SOURCES_RETRY_TTL if any(s.get("error") for s in value) else cache.TTL


def _list_sources(api) -> list[dict[str, Any]]:
    """One entry per warehouse database. A warehouse whose databases can't be
    listed stays in as {error, ...} with no database, so the UI can say why."""
    out = []
    for w in api.list_data_sources():
        connection_id = w.get("connectionId")
        if not connection_id:
            continue
        try:
            databases = api.list_databases(connection_id)
        except Exception as e:  # noqa: BLE001 - reported on the warehouse's entry
            out.append({
                "id": f"{connection_id}::",
                "label": f"{w.get('name')} — unavailable",
                "dialect": w.get("platformType"),
                "connectionId": connection_id,
                "database": None,
                "error": str(e)[:500],
            })
            continue
        for database in databases:
            out.append({
                "id": f"{connection_id}::{database}",
                "label": f"{w.get('name')} — {database}",
                "dialect": w.get("platformType"),
                "connectionId": connection_id,
                "database": database,
            })
    return out


# Tables are listed per schema in the background: a Snowflake schema can take
# AtScale minutes to list, and the tree mustn't wait on the slowest one. The
# Source panel polls /schemas while any schema is still `loading`.
_tables_pool = ThreadPoolExecutor(max_workers=8, thread_name_prefix="list-tables")
_tables_inflight: set[tuple] = set()
_tables_guard = threading.Lock()


def _tables_ttl(value: dict) -> float:
    return _SOURCES_RETRY_TTL if value.get("error") else cache.TTL


def _schema_tables(api, key: tuple, connection_id: str, database: str, schema: str) -> dict:
    """{tables: [{name}]} or {tables: [], error} - never raises."""
    try:
        return {"tables": [{"name": t} for t in api.list_tables(connection_id, database, schema)]}
    except Exception as e:  # noqa: BLE001 - reported on the schema
        return {"tables": [], "error": str(e)[:500]}


def _start_tables(api, key: tuple, connection_id: str, database: str, schema: str, refresh: bool) -> None:
    with _tables_guard:
        if key in _tables_inflight:
            return
        _tables_inflight.add(key)

    def run() -> None:
        try:
            cache.get(key, lambda: _schema_tables(api, key, connection_id, database, schema),
                      refresh=refresh, ttl=_tables_ttl)
        finally:
            with _tables_guard:
                _tables_inflight.discard(key)

    _tables_pool.submit(run)


def _schema_tree(api, host_id: str, source_id: str, connection_id: str, database: str,
                 refresh: bool) -> list[dict]:
    """[{name, tables: [{name}], error?, loading?}]: schema names at once (one
    call), each schema's tables from the cache or, when not there yet, started
    in the background and returned as `loading`.
    (sml-wizard routes/sources.py :: _load_all_schemas also fetched every
    table's columns up front - one call per table; columns now come per table
    from /columns.)"""
    names, _ = cache.get(("host", host_id, "schema-names", source_id),
                         lambda: [s for s in api.list_schemas(connection_id, database)
                                  if not _is_system_schema(s, database)], refresh=refresh)
    if refresh:  # polls after a refresh must wait for the new lists, not see the old ones
        cache.invalidate("host", host_id, "tables", source_id)
    out = []
    for schema in names:
        key = ("host", host_id, "tables", source_id, schema)
        hit = None if refresh else cache.peek(key)
        if hit:
            out.append({"name": schema, **hit[0]})
        else:
            _start_tables(api, key, connection_id, database, schema, refresh)
            out.append({"name": schema, "tables": [], "loading": True})
    return out


def _table_columns(api, host_id: str, connection_id: str, database: str, schema: str, table: str,
                   refresh: bool = False) -> list[dict]:
    def load() -> list[dict]:
        info = api.get_table_info(connection_id, database, schema, table) or {}
        return [{"name": c.get("name"), "type": c.get("dataType")} for c in info.get("columns", [])]

    value, _ = cache.get(("host", host_id, "columns", f"{connection_id}::{database}", schema, table), load,
                         refresh=refresh)
    return value


def _refresh() -> bool:
    return request.args.get("refresh") in ("1", "true")


@build_bp.get("/hosts/<host_id>/sources")
@host_errors
def list_sources(host_id: str):
    api = registry.source_api(host_id)
    value, loaded = cache.get(("host", host_id, "sources"), lambda: _list_sources(api), refresh=_refresh(),
                              ttl=_sources_ttl)
    return jsonify({"sources": value, "cachedAt": loaded})


def _split_source(source_id: str) -> tuple[str, str] | None:
    connection_id, _, database = source_id.partition("::")
    return (connection_id, database) if connection_id and database else None


@build_bp.get("/hosts/<host_id>/sources/<path:source_id>/schemas")
@host_errors
def list_schemas(host_id: str, source_id: str):
    """[{name, tables: [{name}], error?, loading?}] - table names only; poll
    while any schema is `loading`. ?search= filters the loaded tables."""
    parts = _split_source(source_id)
    if not parts:
        return jsonify({"error": f"Malformed source id '{source_id}'"}), 400
    api = registry.source_api(host_id)
    schemas = _schema_tree(api, host_id, source_id, *parts, _refresh())
    search = request.args.get("search", "").lower()
    if search:
        schemas = [{**s, "tables": [t for t in s["tables"] if search in t["name"].lower()]} for s in schemas]
        schemas = [s for s in schemas if s["tables"] or s.get("loading")]
    return jsonify(schemas)


@build_bp.get("/hosts/<host_id>/sources/<path:source_id>/columns")
@host_errors
def table_columns(host_id: str, source_id: str):
    """One table's columns: ?schema=&table= -> [{name, type}]."""
    parts = _split_source(source_id)
    schema, table = request.args.get("schema"), request.args.get("table")
    if not parts or not schema or not table:
        return jsonify({"error": "Need a source id, 'schema' and 'table'"}), 400
    api = registry.source_api(host_id)
    return jsonify(_table_columns(api, host_id, *parts, schema, table, _refresh()))


@build_bp.post("/hosts/<host_id>/sources/<path:source_id>/columns")
@host_errors
def tables_columns(host_id: str, source_id: str):
    """Several tables' columns at once (the Wizard's picks):
    {tables: [{schema, table}]} -> {"schema.table": [{name, type}]}."""
    parts = _split_source(source_id)
    wanted = [(t.get("schema"), t.get("table")) for t in (_body().get("tables") or []) if t.get("schema") and t.get("table")]
    if not parts or not wanted:
        return jsonify({"error": "Need a source id and 'tables'"}), 400
    api = registry.source_api(host_id)
    with ThreadPoolExecutor(max_workers=8) as pool:
        cols = list(pool.map(lambda st: _table_columns(api, host_id, *parts, *st), wanted))
    return jsonify({f"{s}.{t}": c for (s, t), c in zip(wanted, cols)})


# -- SML generate / validate / save / import (sml-wizard routes/sml.py) ---------------------

@build_bp.post("/sml/generate")
def generate():
    payload = _body()
    if (err := _missing(payload)):
        return err
    try:
        files = build_sml(payload)
    except ValidationError as e:
        return jsonify({"errors": e.errors}), 422
    return jsonify({"files": [{"name": n, "body": b} for n, b in sorted(files.items())]})


@build_bp.post("/sml/validate")
def validate():
    files = _body().get("files")
    if not files:
        return jsonify({"error": "Missing 'files' - pass the array returned by /api/sml/generate"}), 400
    try:
        return jsonify(validate_sml({f["name"]: f["body"] for f in files}))
    except SmlCliNotFound as e:
        return jsonify({"error": str(e)}), 500


@build_bp.post("/sml/save-path")
def save_path():
    b = _body()
    if not b.get("path") or not b.get("files"):
        return jsonify({"error": "Missing 'path' or 'files'"}), 400
    root = Path(b["path"]).expanduser()
    return jsonify({"ok": True, "path": str(root), "count": write_files(root, b["files"])})


@build_bp.post("/sml/save")
def save():
    b = _body()
    model_name, files = b.get("modelName"), b.get("files")
    if not model_name or not files:
        return jsonify({"error": "Missing 'modelName' or 'files'"}), 400
    if not is_valid_model_name(model_name):
        return jsonify({"error": f"'{model_name}' is not a valid model name - use letters, numbers, '-' or '_' only"}), 400
    root = model_workspace_dir(model_name)
    return jsonify({"ok": True, "path": str(root), "count": write_files(root, files)})


def _strip_credentials(url: str) -> str:
    return re.sub(r"^(https?://)[^/@]+@", r"\1", url)


def _git_remote_of(path: Path) -> tuple[str, str] | None:
    # sml-wizard routes/sml.py :: _git_remote_of
    if not (path / ".git").exists():
        return None
    from git import InvalidGitRepositoryError, Repo

    try:
        repo = Repo(str(path))
        if "origin" not in [r.name for r in repo.remotes]:
            return None
        url = _strip_credentials(next(repo.remotes.origin.urls))
        branch = repo.active_branch.name if not repo.head.is_detached else "main"
        return url, branch
    except (InvalidGitRepositoryError, TypeError, ValueError):
        return None


@build_bp.get("/sml/models")
def list_workspace_models():
    if not MODELS_ROOT.is_dir():
        return jsonify([])
    out = []
    for child in sorted(MODELS_ROOT.iterdir()):
        if child.is_dir() and _read_sml_directory(child):
            entry: dict[str, Any] = {"name": child.name, "path": str(child)}
            remote = _git_remote_of(child)
            if remote:
                entry["gitRepoUrl"], entry["gitBranch"] = remote
            out.append(entry)
    return jsonify(out)


@build_bp.post("/sml/import")
def import_files():
    files = _body().get("files")
    if not files:
        return jsonify({"error": "Missing 'files'"}), 400
    return jsonify(parse_sml({f["name"]: f["body"] for f in files}))


@build_bp.post("/sml/import-path")
def import_path():
    raw_path = _body().get("path")
    if not raw_path:
        return jsonify({"error": "Missing 'path'"}), 400
    root = Path(raw_path).expanduser()
    if not root.is_dir():
        return jsonify({"error": f"'{raw_path}' is not a directory on the API server"}), 400
    files = _read_sml_directory(root)
    if not files:
        return jsonify({"error": f"No .yml/.yaml files found under '{raw_path}'"}), 400
    return jsonify(parse_sml(files))


@build_bp.post("/sml/import-git")
def import_git():
    """sml-wizard routes/sml.py :: import_git - clone (or pull) a repo and parse
    its SML. With `modelName`, clones into that model's working copy so a later
    Deploy commits on top of the real history. Credentials: the Git profile."""
    from git import GitCommandError, Repo

    b = _body()
    repo_url, branch, model_name = b.get("repoUrl"), b.get("branch") or "main", b.get("modelName")
    if not repo_url:
        return jsonify({"error": "Missing 'repoUrl'"}), 400
    if registry.FAKE:
        return jsonify({"error": "Loading from Git needs a real Git profile - not available in demo mode"}), 400
    git = registry.git_profile()
    username, token = git.get("username"), git.get("token")
    auth_url = repo_url
    if token and repo_url.startswith("https://"):
        auth = f"{username}:{token}" if username else token
        auth_url = repo_url.replace("https://", f"https://{auth}@", 1)

    if model_name:
        repo_dir = model_workspace_dir(model_name)
    else:
        repo_dir = MODELS_ROOT / ".git-cache" / "".join(c if c.isalnum() else "_" for c in repo_url)
        repo_dir.parent.mkdir(parents=True, exist_ok=True)
    try:
        if (repo_dir / ".git").exists():
            repo = Repo(str(repo_dir))
            repo.remotes.origin.set_url(auth_url)
            repo.remotes.origin.fetch()
            repo.git.checkout(branch)
            repo.remotes.origin.pull()
        else:
            repo = Repo.clone_from(auth_url, str(repo_dir), branch=branch)
        repo.remotes.origin.set_url(repo_url)  # never leave the token in .git/config
    except GitCommandError as e:
        if not model_name:
            shutil.rmtree(repo_dir, ignore_errors=True)
        return jsonify({"error": f"Git operation failed: {_strip_credentials(str(e))}"}), 502
    files = _read_sml_directory(repo_dir)
    if not files:
        return jsonify({"error": f"No .yml/.yaml files found in {repo_url}@{branch}"}), 400
    return jsonify(parse_sml(files))


# -- repos attached on a host (sml-wizard routes/sml.py list_attached_repos) -----------------

@build_bp.get("/hosts/<host_id>/build/repos")
@host_errors
def attached_repos(host_id: str):
    """Repos attached on the host with the catalogs/models deployed from each,
    for the Load tab. Built from the host's cached models list."""
    b = registry.backend(host_id, _refresh())
    repos: dict[str, dict[str, Any]] = {}
    for r in b.list_repos():
        repos[r["id"]] = {"repoId": r["id"], "name": r.get("name"), "url": r.get("url"),
                          "branch": r.get("defaultBranch") or "main", "projects": []}
    for row in b.list_models():
        entry = repos.get(row.get("repoId"))
        if not entry or not row.get("catalogId"):
            continue
        proj = next((p for p in entry["projects"] if p["id"] == row["catalogId"]), None)
        if not proj:
            proj = {"id": row["catalogId"], "name": row.get("catalog"), "models": []}
            entry["projects"].append(proj)
        proj["models"].append({"id": row.get("modelId"), "name": row["name"]})
    return jsonify(list(repos.values()))


@build_bp.delete("/hosts/<host_id>/build/repos/<repo_id>")
@host_errors
def detach_repo(host_id: str, repo_id: str):
    """Unregister an attached repo whose Git side is gone (sml-wizard
    unlink_attached_repo -> client.delete_repo). Deployed catalogs stay."""
    if registry.FAKE:
        return jsonify({"error": "Not available in demo mode"}), 400
    registry.source_api(host_id).delete_repo(repo_id)
    cache.invalidate("host", host_id)
    return jsonify({"ok": True})


# -- preview (sml-wizard routes/preview.py) --------------------------------------------------
# No metadata cache: AtScale can rename measure/level unique_names across a
# redeploy, and this workflow is edit -> deploy -> preview -> redeploy.

@build_bp.get("/hosts/<host_id>/preview/catalogs")
@host_errors
def preview_catalogs(host_id: str):
    try:
        return jsonify(list_catalogs_and_cubes(registry.source_api(host_id)))
    except ValueError:
        raise
    except Exception as e:  # noqa: BLE001
        return jsonify({"error": str(e)}), 502


@build_bp.get("/hosts/<host_id>/preview/metadata")
@host_errors
def preview_metadata(host_id: str):
    catalog, cube = request.args.get("catalog"), request.args.get("cube")
    if not catalog or not cube:
        return jsonify({"error": "Missing 'catalog' or 'cube' query param"}), 400
    try:
        result = load_cube_metadata(registry.source_api(host_id), catalog, cube)
    except ValueError:
        raise
    except Exception as e:  # noqa: BLE001
        return jsonify({"error": str(e)}), 502
    return jsonify({"dimensions": result["dimensions"], "measures": result["measures"]})


def _capped(result: dict) -> dict:
    """At most preview.MAX_ROWS rows (the query asked for one more to tell if
    there were more); freehand MDX can't be rewritten safely, so it is only trimmed here."""
    if len(result["rows"]) > MAX_ROWS:
        result["rows"], result["truncated"] = result["rows"][:MAX_ROWS], True
    result["maxRows"] = MAX_ROWS
    return result


@build_bp.post("/hosts/<host_id>/preview/query")
@host_errors
def preview_query(host_id: str):
    b = _body()
    catalog, cube, dialect = b.get("catalog"), b.get("cube"), b.get("dialect", "mdx")
    hierarchies, measures = b.get("hierarchies") or [], b.get("measures") or []
    if not catalog or not cube:
        return jsonify({"error": "Missing 'catalog' or 'cube'"}), 400
    if not measures:
        return jsonify({"error": "Select at least one measure"}), 400
    if dialect == "mdx" and not hierarchies:
        return jsonify({"error": "Select at least one dimension/hierarchy for an MDX query"}), 400
    api = registry.source_api(host_id)
    try:
        meta = load_cube_metadata(api, catalog, cube)
        result = run_preview_query(api, catalog, cube, dialect, hierarchies, measures, meta["_levels"],
                                   use_agg=b.get("useAgg", True), use_cache=b.get("useCache", True))
    except ValueError:
        raise
    except Exception as e:  # noqa: BLE001
        return jsonify({"error": str(e)}), 502
    return jsonify(_capped(result))


@build_bp.post("/hosts/<host_id>/preview/freehand")
@host_errors
def preview_freehand(host_id: str):
    """Build > Preview > Freehand: run the MDX or SQL the user typed."""
    b = _body()
    catalog, cube, dialect, query = b.get("catalog"), b.get("cube"), b.get("dialect", "mdx"), (b.get("query") or "").strip()
    if not catalog or not cube:
        return jsonify({"error": "Missing 'catalog' or 'cube'"}), 400
    if not query:
        return jsonify({"error": "Type a query first"}), 400
    api = registry.source_api(host_id)
    try:
        result = run_freehand_query(api, catalog, cube, dialect, query,
                                    use_agg=b.get("useAgg", True), use_cache=b.get("useCache", True))
    except ValueError:
        raise
    except Exception as e:  # noqa: BLE001 - the engine's message is what the user needs
        return jsonify({"error": str(e)}), 502
    return jsonify(_capped(result))


# -- deploy to one or more hosts --------------------------------------------------------------

def _has_connection(host_id: str, connection_id: str) -> bool:
    return any(w.get("connectionId") == connection_id for w in registry.source_api(host_id).list_data_sources())


def _push(payload: dict, files: dict[str, str], private: bool) -> dict[str, Any]:
    """Save to the model's working copy and push it to Git (sml-wizard
    routes/publish.py steps 2-3). A model loaded from a repo pushes back to
    that repo/branch; a new one gets github.com/<user>/<model-slug>."""
    model_name = payload["modelName"]
    staging = model_workspace_dir(model_name)
    write_files(staging, [{"name": n, "body": b} for n, b in files.items()])
    git = registry.git_profile()
    username, token = git.get("username"), git.get("token")
    repo_name = slugify_repo_name(model_name)
    if registry.FAKE:
        from atscale import fake

        url = payload.get("gitRepoUrl") or f"https://github.com/{username or 'demo-user'}/{repo_name}"
        fake.register_built_model(url, model_name, payload.get("catalogName") or model_name)
        return {"repoUrl": url, "branch": payload.get("gitBranch") or "main", "commit": "demo", "created": False,
                "path": str(staging)}
    if not username or not token:
        raise ValueError("Git profile is missing a username or token - set it in Settings")
    author = (git.get("username"), git.get("email"))
    if payload.get("gitRepoUrl"):
        url, branch, created = payload["gitRepoUrl"], payload.get("gitBranch") or "main", False
        clone_url = url
        message = f"Update SML for {model_name}"
    else:
        info = ensure_github_repo(username, token, repo_name, private=private)
        url, branch, created, clone_url = info["html_url"], info["default_branch"], info["created"], info["clone_url"]
        message = f"Generate SML for {model_name}"
    commit = push_sml_to_repo(staging, clone_url, username, token, branch=branch, commit_message=message, author=author)
    return {"repoUrl": url, "branch": branch, "commit": commit, "created": created, "path": str(staging)}


@build_bp.post("/build/deploy")
@host_errors
def deploy():
    """Body: the /sml/generate payload + {hostIds: [...], private?}. Pushes the
    SML to Git once, then deploys that branch on each host whose data warehouse
    list has the model's `asConnection`. Returns a job (poll /api/jobs/<id>)."""
    payload = _body()
    if (err := _missing(payload)):
        return err
    host_ids = [h for h in (payload.get("hostIds") or []) if h]
    if not host_ids:
        return jsonify({"error": "Pick at least one host to deploy to"}), 400
    if not registry.git_ready():
        return jsonify({"error": "Git profile is missing or failed its test - fix it in Settings", "needsGit": True}), 409
    hosts = {h: registry.host(h) for h in host_ids}  # 404 on an unknown id before anything runs
    try:
        files = build_sml(payload)
    except ValidationError as e:
        return jsonify({"errors": e.errors}), 422
    private = payload.get("private", True)

    def run() -> dict:
        git = _push(payload, files, private)
        results = []
        for host_id, raw in hosts.items():
            row: dict[str, Any] = {"hostId": host_id, "label": raw.get("label") or host_id, "env": raw.get("env")}
            try:
                if not _has_connection(host_id, payload["asConnection"]):
                    results.append({**row, "ok": False, "error":
                                    f"No data warehouse connection '{payload['asConnection']}' on this host"})
                    continue
                r = registry.backend(host_id).deploy_branch(git["repoUrl"], git["branch"])
                results.append({**row, **r})
            except Exception as e:  # noqa: BLE001 - reported per host
                results.append({**row, "ok": False, "error": str(e)})
        return {"git": git, "fileCount": len(files), "results": results}

    return jsonify(jobs.submit("build-deploy", run)), 202


@build_bp.get("/build/preflight")
@host_errors
def preflight():
    """Which hosts carry a data warehouse connection id - the deploy dialog
    greys out hosts that would fail. ?connection=<connectionId>&hostIds=a,b"""
    connection_id = request.args.get("connection", "")
    out = []
    for host_id in [h for h in request.args.get("hostIds", "").split(",") if h]:
        try:
            out.append({"hostId": host_id, "ok": _has_connection(host_id, connection_id)})
        except Exception as e:  # noqa: BLE001
            out.append({"hostId": host_id, "ok": False, "error": str(e)})
    return jsonify({"hosts": out})

