"""Build › Import & convert: walk an existing model's export into an SML repo.

`kind` is xml (AtScale project_2_0 XML), ssas (SSAS Multidimensional XMLA) or
tabular (SSAS Tabular TMSL JSON) - each converted by its ps-utils operation
(smlgen/converters.py).

  POST /build/import/inspect  {kind, text, fileName} -> project + cube names, and
                              the connections / models a conversion emits
  POST /build/import/convert  {kind, text, fileName, repoName, catalogName?,
                              modelMode?, warehouse? (tabular), models: {emitted
                              name: new name}} -> files + report (a failed
                              conversion is a 422 with the CLI's log)
  POST /build/import/connect  {repoName, files, asConnection, connections: {name:
                              {database, schema}}} -> the converted files remapped
                              onto the picked data source + sml-cli validation
  POST /build/import/save     {repoName, files, replace?} -> the repo's working copy
  POST /build/import/publish  {repoName, files, models, asConnection, hostIds,
                              action: link|deploy, private?} -> job: push to Git
                              once, then link each model (Manage's Link) or deploy
                              the branch on every host
  POST /build/import/ddl      {text, fileName} -> the DDL's tables, columns and
                              foreign keys (smlgen/ddl.py), which the new-model
                              Wizard plans from instead of a live table listing

Save / push reuse Build's working copy + Git path (routes/build.py); an
imported working copy is read-only for Build's own Save / Deploy."""

from __future__ import annotations

import shutil
from pathlib import Path
from typing import Any

from flask import Blueprint, jsonify, request

import jobs
from envs import registry
from routes.build import (_has_connection, _push, _read_sml_directory, model_workspace_dir, models_root, write_files,
                          import_marker)
from routes.objects import host_errors
from smlgen import converters
from smlgen.ddl import parse_ddl
from smlgen.naming import is_valid_model_name, slugify_model_name
from smlgen.validate import SmlCliNotFound, validate_sml

importer_bp = Blueprint("importer", __name__)

_MAX_TEXT = 50 * 1024 * 1024


def _body() -> dict:
    return request.get_json(force=True, silent=True) or {}


def _text(b: dict) -> str | None:
    text = b.get("text")
    return text if isinstance(text, str) and text.strip() else None


def _input_error(b: dict) -> Any:
    if b.get("kind") not in converters.KINDS:
        return jsonify({"error": f"kind must be one of {', '.join(converters.KINDS)}"}), 400
    text = _text(b)
    if not text:
        return jsonify({"error": "Missing 'text' - the export file's contents"}), 400
    if len(text) > _MAX_TEXT:
        return jsonify({"error": "The file is larger than 50 MB"}), 413
    return None


def _repo_error(repo_name: str | None) -> Any:
    if not repo_name:
        return jsonify({"error": "Enter a repository name"}), 400
    if not is_valid_model_name(repo_name):
        return jsonify({"error": f"'{repo_name}' is not a valid repository name - use letters, numbers, '-' or '_' only"}), 400
    return None


def _workspace_has_sml(repo_name: str) -> bool:
    root = models_root() / slugify_model_name(repo_name)
    return root.is_dir() and bool(_read_sml_directory(root))


def _replace_working_copy(repo_name: str) -> Path:
    """An import is a whole repo: files a previous working copy had and the
    conversion doesn't must not survive. Keeps .git so a push stays on top of
    that history. Marks the copy read-only for Build's own Save / Deploy."""
    root = model_workspace_dir(repo_name)
    for child in root.iterdir():
        if child.name == ".git":
            continue
        shutil.rmtree(child) if child.is_dir() else child.unlink()
    import_marker(root).write_text("Converted by Build › Import & convert - read-only in Build\n")
    return root


@importer_bp.post("/build/import/inspect")
def inspect():
    b = _body()
    if (err := _input_error(b)):
        return err
    try:
        return jsonify({**converters.inspect(b["kind"], b["text"], b.get("fileName")), "converter": converters.cli_info()})
    except ValueError as e:
        return jsonify({"error": str(e)}), 400
    except converters.ConversionFailed as e:
        return jsonify({"error": str(e), "log": e.log, "converter": converters.cli_info()}), 422
    except converters.ConverterNotFound as e:
        return jsonify({"error": str(e)}), 500


@importer_bp.post("/build/import/ddl")
def ddl():
    b = _body()
    text = _text(b)
    if not text:
        return jsonify({"error": "Missing 'text' - the DDL file's contents"}), 400
    if len(text) > _MAX_TEXT:
        return jsonify({"error": "The file is larger than 50 MB"}), 413
    parsed = parse_ddl(text)
    if not any(t["columns"] for t in parsed["tables"]):
        return jsonify({"error": "No CREATE TABLE statements with columns found in this file", **parsed}), 422
    return jsonify({**parsed, "fileName": b.get("fileName")})


@importer_bp.post("/build/import/convert")
def convert():
    b = _body()
    if (err := _input_error(b)):
        return err
    kind, text = b["kind"], b["text"]
    repo_name = b.get("repoName")
    if (err := _repo_error(repo_name)):
        return err
    models = {k: v for k, v in (b.get("models") or {}).items() if isinstance(v, str)}
    if any(not v.strip() for v in models.values()):
        return jsonify({"error": "Every model needs a name"}), 400
    if len({v.strip() for v in models.values()}) < len(models):
        return jsonify({"error": "Two models have the same name"}), 400
    extra: dict[str, Any] = {}
    if kind == "tabular":
        # DAX is translated to SQL for the warehouse at conversion, so it is
        # picked up front. The model keeps the name inspect used (its
        # connections are named after it) and is renamed below.
        extra["warehouse"] = b.get("warehouse")
        if extra["warehouse"] not in converters.TABULAR_WAREHOUSES:
            return jsonify({"error": f"warehouse must be one of {', '.join(converters.TABULAR_WAREHOUSES)}"}), 400
    try:
        raw, log = converters.convert(kind, text, b.get("fileName"), catalog_name=(b.get("catalogName") or "").strip() or None,
                                      model_mode=b.get("modelMode") or "new", **extra)
        files = converters.rename_models(raw, models)
    except ValueError as e:
        return jsonify({"error": str(e)}), 400
    except converters.ConversionFailed as e:
        return jsonify({"error": str(e), "log": e.log, "converter": converters.cli_info()}), 422
    except converters.ConverterNotFound as e:
        return jsonify({"error": str(e)}), 500
    return jsonify({
        "files": [{"name": n, "body": body} for n, body in sorted(files.items())],
        "report": converters.report_of(files),
        "log": log,
        "converter": converters.cli_info(),
        **converters.summarize(files),
    })


@importer_bp.post("/build/import/connect")
def connect():
    """The converted files, every connection pointed at the picked data source,
    then validated with sml-cli."""
    b = _body()
    files, repo_name = b.get("files"), b.get("repoName")
    if (err := _repo_error(repo_name)):
        return err
    if not files:
        return jsonify({"error": "Missing 'files' - the converted SML"}), 400
    as_connection = (b.get("asConnection") or "").strip()
    if not as_connection:
        return jsonify({"error": "Pick the data source the model connects to"}), 400
    out = converters.remap_connections({f["name"]: f["body"] for f in files}, as_connection, b.get("connections") or {})
    try:
        validation = validate_sml({n: body for n, body in out.items()
                                   if n.endswith((".yml", ".yaml")) and not n.startswith("context/")})
    except SmlCliNotFound as e:
        validation = {"passed": False, "returncode": None, "output": str(e)}
    return jsonify({
        "files": [{"name": n, "body": body} for n, body in sorted(out.items())],
        "validation": validation,
        "workspaceExists": _workspace_has_sml(repo_name),
        **converters.summarize(out),
    })


@importer_bp.post("/build/import/save")
def save():
    b = _body()
    repo_name, files = b.get("repoName"), b.get("files")
    if (err := _repo_error(repo_name)):
        return err
    if not files:
        return jsonify({"error": "Missing 'files'"}), 400
    if _workspace_has_sml(repo_name) and not b.get("replace"):
        return jsonify({"error": f"workspace/{repo_name} already holds SML - confirm to replace it", "exists": True}), 409
    root = _replace_working_copy(repo_name)
    return jsonify({"ok": True, "path": str(root), "count": write_files(root, files)})


@importer_bp.post("/build/import/publish")
@host_errors
def publish():
    """Push once, then per host: `link` registers the repo and each model on
    the host (backend.link - Manage's Link; deploy it later from Manage), or
    `deploy` deploys the branch (hosts without `asConnection` are skipped,
    same rule as /build/deploy)."""
    b = _body()
    repo_name, files = b.get("repoName"), b.get("files")
    if (err := _repo_error(repo_name)):
        return err
    if not files:
        return jsonify({"error": "Missing 'files'"}), 400
    action = b.get("action")
    if action not in ("link", "deploy"):
        return jsonify({"error": "action must be 'link' or 'deploy'"}), 400
    models = [m for m in (b.get("models") or []) if m]
    as_connection = b.get("asConnection") or ""
    host_ids = [h for h in (b.get("hostIds") or []) if h]
    if not host_ids:
        return jsonify({"error": f"Pick at least one host to {action} to"}), 400
    if not registry.git_ready():
        return jsonify({"error": "Git profile is missing or failed its test - fix it in Settings", "needsGit": True}), 409
    hosts = {h: registry.host(h) for h in host_ids}  # 404 on an unknown id before anything runs
    if _workspace_has_sml(repo_name) and not b.get("replace"):
        return jsonify({"error": f"workspace/{repo_name} already holds SML - confirm to replace it", "exists": True}), 409
    by_name = {f["name"]: f["body"] for f in files}
    payload = {"modelName": repo_name, "models": models, "catalogName": b.get("catalogName")}

    def run() -> dict:
        _replace_working_copy(repo_name)
        git = _push(payload, by_name, b.get("private", True))
        results = []
        for host_id, raw in hosts.items():
            row: dict[str, Any] = {"hostId": host_id, "label": raw.get("label") or host_id, "env": raw.get("env")}
            try:
                if as_connection and not _has_connection(host_id, as_connection):
                    results.append({**row, "ok": False, "error": f"No data warehouse connection '{as_connection}' on this host"})
                    continue
                backend = registry.backend(host_id)
                if action == "deploy":
                    results.append({**row, **backend.deploy_branch(git["repoUrl"], git["branch"])})
                    continue
                errors = []
                for model in models:
                    try:
                        backend.link(git["repoUrl"], git["branch"], model)
                    except Exception as e:  # noqa: BLE001 - reported per model
                        errors.append(f"{model}: {e}")
                results.append({**row, "ok": not errors, "linked": len(models) - len(errors),
                                **({"error": "; ".join(errors)} if errors else {})})
            except Exception as e:  # noqa: BLE001 - reported per host
                results.append({**row, "ok": False, "error": str(e)})
        return {"git": git, "fileCount": len(by_name), "results": results, "action": action}

    return jsonify(jobs.submit(f"import-{action}", run)), 202
