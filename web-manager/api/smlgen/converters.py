"""Build › Import & convert: an existing model's export -> SML, by ps-utils.

Every conversion is a ps-utils operation run as a CLI. None is ported:
thousands of lines of conversion rules would drift from the CLI the field uses.
Which CLI (`cli_info`):
  1. this branch's own build - `vscode-extension/cli/cli.cjs` at the ps-utils
     repo root, the single-file bundle `npm run build` (bundle:cli) writes. It
     carries converter fixes made here before they are published, so Import
     and the CLI agree on this branch. An exception to "never execute ps-utils'
     src/": it runs the built bundle, as an external process.
  2. the pinned npm package - `@atscale-ps/ps-utils` in web/package.json
     (`web/node_modules/.bin/atscale-utils`), when there is no build, or with
     ENV_MANAGER_PS_UTILS=npm.
Rebuild after changing a converter (`npm run build` at the repo root); the
converter's version and build time are reported with every conversion.

  xml      AtScale project_2_0 XML      ps-utils src/operations/generate-sml-from-xml
  ssas     SSAS Multidimensional XMLA   ps-utils src/operations/generate-sml-from-ssas-multidimensional
  tabular  SSAS Tabular TMSL JSON       ps-utils src/operations/generate-sml-from-tabular

What lives here is only what the wizard adds around them:
  - `inspect`: the project / cube names in the export, plus the connections
    and models a trial conversion emits, so the user maps them before
    converting for real (the CLI's connection naming isn't re-derived here).
  - `rename_models` at conversion, then - on the converted files, so the user
    maps exactly what the CLI emitted - `remap_connections`: every connection
    pointed at a data source picked on the host (`as_connection` = its
    connectionId, `database` / `schema` per connection).
"""

from __future__ import annotations

import json
import os
import re
import shutil
import subprocess
import tempfile
import xml.etree.ElementTree as ET
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

import yaml

from cache import work_tmp

from .naming import slugify_model_name


class ConverterNotFound(RuntimeError):
    pass


class ConversionFailed(RuntimeError):
    def __init__(self, message: str, log: str):
        super().__init__(message)
        self.log = log


_WEB_MANAGER = Path(__file__).resolve().parent.parent.parent
_LOCAL_CLI = _WEB_MANAGER / "web" / "node_modules" / ".bin" / "atscale-utils"
_REPO_BUNDLE = _WEB_MANAGER.parent / "vscode-extension" / "cli" / "cli.cjs"
#: --model-mode values (ps-utils src/operations/model-query-name-compatibility.ts :: parseModelMode).
MODEL_MODES = ("new", "existing")
_TIMEOUT = 300

#: kind -> the ps-utils operation and its input-file flag.
KINDS: dict[str, dict[str, str]] = {
    "xml": {"operation": "generate-sml-from-xml", "fileFlag": "--xml-file", "ext": ".xml"},
    "ssas": {"operation": "generate-sml-from-ssas-multidimensional", "fileFlag": "--xmla-file", "ext": ".xml"},
    "tabular": {"operation": "generate-sml-from-tabular", "fileFlag": "--xmla-file", "ext": ".json"},
}

#: generate-sml-from-tabular's --warehouse values (GenerateSMLFromTabularOperation.ts :: WAREHOUSES),
#: matched from an AtScale data source's dialect. It decides how DAX is translated to SQL.
_TABULAR_WAREHOUSES = (("snowflake", "Snowflake"), ("databricks", "Databricks"), ("bigquery", "BigQuery"),
                       ("postgres", "Postgres"))
TABULAR_WAREHOUSES = [w for _, w in _TABULAR_WAREHOUSES]
#: Required by generate-sml-from-tabular; a trial conversion uses these, the remap replaces them.
_TABULAR_PLACEHOLDER = {"warehouse": "Postgres", "database": "DATABASE", "schema": "SCHEMA"}


def _use_repo_build() -> bool:
    return os.environ.get("ENV_MANAGER_PS_UTILS", "").lower() != "npm" and _REPO_BUNDLE.exists() \
        and shutil.which("node") is not None


def _cli() -> list[str]:
    if _use_repo_build():
        return [shutil.which("node") or "node", str(_REPO_BUNDLE)]
    if _LOCAL_CLI.exists():
        return [str(_LOCAL_CLI)]
    npx = shutil.which("npx")
    if not npx:
        raise ConverterNotFound("ps-utils CLI not installed (cd web && npm install) and npx not found on PATH.")
    return [npx, "--yes", "--package", "@atscale-ps/ps-utils", "atscale-utils"]


def cli_info() -> dict[str, Any]:
    """Which ps-utils ran a conversion - shown with its result, so a stale build
    or an unpublished fix is visible rather than a silent difference."""
    if _use_repo_build():
        meta: dict[str, Any] = {}
        try:
            meta = json.loads((_REPO_BUNDLE.parent / "BUNDLE.json").read_text())
        except (OSError, ValueError):
            pass
        built = datetime.fromtimestamp(_REPO_BUNDLE.stat().st_mtime, timezone.utc).isoformat(timespec="seconds")
        return {"source": "repo", "label": "this branch's ps-utils build", "version": meta.get("version"),
                "path": str(_REPO_BUNDLE), "builtAt": built}
    version = None
    try:
        pkg = _WEB_MANAGER / "web" / "node_modules" / "@atscale-ps" / "ps-utils" / "package.json"
        version = json.loads(pkg.read_text()).get("version")
    except (OSError, ValueError):
        pass
    return {"source": "npm", "label": "@atscale-ps/ps-utils (npm)", "version": version, "path": str(_LOCAL_CLI)}


def _kind(kind: str) -> dict[str, str]:
    if kind not in KINDS:
        raise ValueError(f"kind must be one of {', '.join(KINDS)}")
    return KINDS[kind]


def tabular_warehouse(dialect: str | None) -> str | None:
    d = (dialect or "").lower()
    return next((w for key, w in _TABULAR_WAREHOUSES if key in d), None)


# -- what the export says about itself ------------------------------------------------------

def _local(tag: str) -> str:
    return tag.rsplit("}", 1)[-1]


def _children(el: ET.Element, name: str) -> list[ET.Element]:
    return [c for c in el if _local(c.tag) == name]


def _text(el: ET.Element | None, name: str) -> str | None:
    if el is None:
        return None
    for c in _children(el, name):
        return (c.text or "").strip() or None
    return None


def _parse_xml(text: str) -> ET.Element:
    try:
        return ET.fromstring(text)
    except ET.ParseError as e:
        raise ValueError(f"Not a well-formed XML file: {e}") from e


def _read_atscale_xml(text: str) -> dict[str, Any]:
    root = _parse_xml(text)
    if _local(root.tag) != "schema":
        raise ValueError(f"Not an AtScale project file: the root element is <{_local(root.tag)}>, expected <schema>")
    props = next(iter(_children(root, "properties")), None)
    cubes = []
    for sec in _children(root, "cubes"):
        for cube in _children(sec, "cube"):
            cprops = next(iter(_children(cube, "properties")), None)
            cubes.append({"name": cube.get("name") or cube.get("id") or "Model", "caption": _text(cprops, "caption"),
                          "visible": _text(cprops, "visible") != "false"})
    datasets = sum(len(_children(sec, "data-set")) for sec in _children(root, "data-sets"))
    return {"project": root.get("name") or "Model", "caption": _text(props, "caption"), "cubes": cubes,
            "datasets": datasets}


def _read_ssas(text: str) -> dict[str, Any]:
    root = _parse_xml(text)
    db = root if _local(root.tag) == "Database" else next((e for e in root.iter() if _local(e.tag) == "Database"), None)
    if db is None:
        raise ValueError("Not an SSAS Multidimensional export: no <Database> element (expected a Create / ObjectDefinition script)")
    cubes = [{"name": _text(c, "Name") or _text(c, "ID") or "Cube", "caption": None, "visible": _text(c, "Visible") != "false"}
             for sec in _children(db, "Cubes") for c in _children(sec, "Cube")]
    views = [v for sec in _children(db, "DataSourceViews") for v in _children(sec, "DataSourceView")]
    return {"project": _text(db, "Name") or _text(db, "ID") or "ssas_model", "caption": None, "cubes": cubes,
            # The view's tables are schema elements tagged msprop:DbTableName.
            "datasets": sum(1 for v in views for e in v.iter() if any(k.endswith("DbTableName") for k in e.attrib))}


def _read_tabular(text: str) -> dict[str, Any]:
    try:
        doc = json.loads(text)
    except json.JSONDecodeError as e:
        raise ValueError(f"Not a TMSL JSON file: {e}") from e
    db = (doc.get("createOrReplace") or doc.get("create") or {}).get("database") if isinstance(doc, dict) else None
    if not isinstance(db, dict):
        db = doc if isinstance(doc, dict) and "model" in doc else None  # a bare .bim database
    if not isinstance(db, dict) or not isinstance(db.get("model"), dict):
        raise ValueError("Not an SSAS Tabular export: expected a TMSL createOrReplace.database.model")
    model = db["model"]
    name = db.get("name") or model.get("name") or "tabular_model"
    return {"project": name, "caption": None, "cubes": [{"name": model.get("name") or name, "caption": None, "visible": True}],
            "datasets": len(model.get("tables") or []), "warehouse": _tabular_source_warehouse(model)}


#: How a Tabular model names its warehouse: a provider / connection string /
#: protocol on its data sources, or a Power Query source function in an M expression.
_WAREHOUSE_HINTS = (
    ("Snowflake", re.compile(r"snowflake", re.I)),
    ("Databricks", re.compile(r"databricks|spark", re.I)),
    ("BigQuery", re.compile(r"bigquery", re.I)),
    ("Postgres", re.compile(r"postgres|npgsql", re.I)),
)


def _tabular_source_warehouse(model: dict[str, Any]) -> str | None:
    """The warehouse the export's own data sources point at, when it says -
    the wizard then only asks when it doesn't (e.g. a SQL Server source)."""
    hay = [json.dumps(model.get("dataSources") or []), json.dumps(model.get("expressions") or [])]
    for t in model.get("tables") or []:
        for part in t.get("partitions") or []:
            hay.append(json.dumps(part.get("source") or {}))
    text = "\n".join(hay)
    found = {w for w, rx in _WAREHOUSE_HINTS if rx.search(text)}
    return found.pop() if len(found) == 1 else None


def read_project(kind: str, text: str) -> dict[str, Any]:
    """Project and cube names, for the wizard to show next to the fields it pre-fills."""
    _kind(kind)
    return {"xml": _read_atscale_xml, "ssas": _read_ssas, "tabular": _read_tabular}[kind](text)


def tabular_model_name(project: str) -> str:
    """generate-sml-from-tabular's --model-name: it recommends snake_case."""
    return re.sub(r"[^a-z0-9_]", "", slugify_model_name(project).lower().replace("-", "_")) or "tabular_model"


# -- conversion -----------------------------------------------------------------------------

def _safe_file_name(name: str | None, ext: str) -> str:
    base = re.sub(r"[^A-Za-z0-9._-]", "_", Path(name or f"model{ext}").name) or f"model{ext}"
    return base if "." in base else f"{base}{ext}"


def convert(kind: str, text: str, file_name: str | None = None, *, catalog_name: str | None = None,
            model_mode: str = "new", warehouse: str | None = None, model_name: str | None = None) -> tuple[dict[str, str], str]:
    """Runs the kind's ps-utils operation on the export. Returns ({relative
    path: body}, the CLI's log). Every file it writes is kept - README.md /
    CONVERSION_REPORT.md is its conversion report (omissions, renames)."""
    spec = _kind(kind)
    if model_mode not in MODEL_MODES:
        raise ValueError(f"modelMode must be one of {', '.join(MODEL_MODES)}")
    cli = _cli()
    with tempfile.TemporaryDirectory(prefix="import-", dir=work_tmp()) as tmp:
        root = Path(tmp)
        src = root / _safe_file_name(file_name, spec["ext"])
        src.write_text(text, encoding="utf-8")
        out = root / "sml"
        cmd = [*cli, spec["operation"], spec["fileFlag"], str(src), "--output-dir", str(out), "--model-mode", model_mode]
        if catalog_name:
            cmd += ["--catalog-name", catalog_name]
        if kind == "tabular":
            cmd += ["--warehouse", warehouse or _TABULAR_PLACEHOLDER["warehouse"],
                    "--database", _TABULAR_PLACEHOLDER["database"], "--schema", _TABULAR_PLACEHOLDER["schema"],
                    "--model-name", model_name or tabular_model_name(read_project(kind, text)["project"])]
        try:
            # stdin closed: the ps-utils CLI reads an open stdin as input and would wait on it.
            proc = subprocess.run(cmd, capture_output=True, text=True, timeout=_TIMEOUT, stdin=subprocess.DEVNULL,
                                  env={**os.environ, "NO_COLOR": "1", "FORCE_COLOR": "0"})
        except subprocess.TimeoutExpired as e:
            raise ConversionFailed(f"The conversion did not finish in {_TIMEOUT} s", str(e.stdout or "")) from e
        log = ((proc.stdout or "") + (proc.stderr or "")).replace(str(root) + os.sep, "")
        if proc.returncode != 0:
            raise ConversionFailed(f"{spec['operation']} exited with {proc.returncode}", log)
        files = {str(p.relative_to(out)): p.read_text(encoding="utf-8")
                 for p in sorted(out.rglob("*")) if p.is_file()} if out.is_dir() else {}
        if not files:
            raise ConversionFailed(f"{spec['operation']} wrote no files", log)
        return files, log


def report_of(files: dict[str, str]) -> str:
    return files.get("CONVERSION_REPORT.md") or files.get("README.md", "")


def _load(body: str) -> dict[str, Any]:
    try:
        doc = yaml.safe_load(body)
    except yaml.YAMLError:
        return {}
    return doc if isinstance(doc, dict) else {}


def _dump(doc: dict[str, Any]) -> str:
    return yaml.safe_dump(doc, sort_keys=False, default_flow_style=False, allow_unicode=True)


def _is_sml(name: str, prefix: str) -> bool:
    return name.startswith(prefix) and name.endswith((".yml", ".yaml"))


def summarize(files: dict[str, str]) -> dict[str, Any]:
    """Counts per object type, the emitted connections (with how many datasets
    each carries) and the emitted models."""
    counts: dict[str, int] = {}
    for name in files:
        top = name.split("/", 1)[0]
        if "/" in name and top != "context" and name.endswith((".yml", ".yaml")):
            counts[top] = counts.get(top, 0) + 1
    by_conn: dict[str, int] = {}
    for name, body in files.items():
        if _is_sml(name, "datasets/"):
            conn = _load(body).get("connection_id")
            if conn:
                by_conn[conn] = by_conn.get(conn, 0) + 1
    connections, models = [], []
    for name, body in sorted(files.items()):
        if _is_sml(name, "connections/"):
            doc = _load(body)
            connections.append({"name": doc.get("unique_name"), "file": name, "database": doc.get("database"),
                                "schema": doc.get("schema"), "asConnection": doc.get("as_connection"),
                                "datasets": by_conn.get(doc.get("unique_name"), 0)})
        elif _is_sml(name, "models/"):
            doc = _load(body)
            models.append({"name": doc.get("unique_name"), "file": name, "visible": doc.get("visible", True) is not False})
    return {"counts": counts, "connections": connections, "models": models}


def inspect(kind: str, text: str, file_name: str | None = None) -> dict[str, Any]:
    """read_project + a trial conversion, so the models the wizard names are
    exactly what the CLI emits."""
    project = read_project(kind, text)
    files, _ = convert(kind, text, file_name, warehouse=project.get("warehouse"))
    return {"kind": kind, **project, **summarize(files),
            **({"warehouses": TABULAR_WAREHOUSES} if kind == "tabular" else {})}


def rename_models(files: dict[str, str], models: dict[str, str]) -> dict[str, str]:
    """`models`: {emitted model unique_name: new name}; the file is renamed to match."""
    out: dict[str, str] = {}
    taken: set[str] = set()
    for name, body in files.items():
        if _is_sml(name, "models/"):
            doc = _load(body)
            new = (models.get(doc.get("unique_name") or "") or "").strip()
            if new and new != doc.get("unique_name"):
                if doc.get("label") in (None, doc.get("unique_name")):
                    doc["label"] = new
                doc["unique_name"] = new
                name = f"models/{slugify_model_name(new).lower()}.yml"
                body = _dump(doc)
            if name in taken:
                raise ValueError(f"Two models would be written to {name} - give them different names")
            taken.add(name)
        out[name] = body
    return out


def remap_connections(files: dict[str, str], as_connection: str, connections: dict[str, dict[str, Any]]) -> dict[str, str]:
    """Run on the converted files: point every connection at `as_connection`.
    `connections`: {connection unique_name: {database, schema}} - a blank value
    drops the key (the data source's default then applies)."""
    out: dict[str, str] = {}
    for name, body in files.items():
        if _is_sml(name, "connections/"):
            doc = _load(body)
            doc["as_connection"] = as_connection
            mapping = connections.get(doc.get("unique_name") or "", {})
            for key in ("database", "schema"):
                if key in mapping:
                    value = (mapping.get(key) or "").strip()
                    if value:
                        doc[key] = value
                    else:
                        doc.pop(key, None)
            body = _dump(doc)
        out[name] = body
    return out
