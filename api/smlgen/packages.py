"""Shared dimensions: SML packages (`package.yml`).

A *shared dimensions* repo is a catalog with connections, datasets and
dimensions but no model - Build publishes it to Git and only attaches it on
AtScale (never deploys it). A model repo lists it in its root `package.yml`
and references its dimensions by unique_name; AtScale clones the package at
the pinned commit when the model deploys.

Format per the SML reference (reference/ps-utils/resources/sml-reference/package.md)
and SML-develop's validator (packages/models/src/schemas/package.schema.json):
`version: 1`, each package {name, url, branch, version}; `name` letters, `-`
and `_` only; `version` must be `commit:<8-40 hex>` - "latest" fails the
validator, so the branch head is resolved to its SHA when a package is picked.
Package files sit under `packages/<name>/` once AtScale merges them; a
package's catalog.yml is ignored (SML-develop RepoParser.extractYamlFiles).

New Python logic, not a ps-utils port.
"""

from __future__ import annotations

import re
from typing import Any

import yaml

#: package.yml at the repo root (SML-develop YamlPackageFileUtil.PACKAGE_FILE_NAME).
PACKAGE_FILE = "package.yml"
_PACKAGE_FILES = (PACKAGE_FILE, "package.yaml")

#: Second line of a shared-dimensions repo's catalog.yml - the tag the Build
#: picker looks for (a repo with no model also qualifies).
SHARED_MARKER = "# Shared dimensions package (AtScale Environment Manager) - attach, don't deploy"

#: Appended to a shared repo's connection unique_name: AtScale merges package
#: objects into the model's namespace, and the model's own connection gets the
#: same con_<database>_<schema> name from the same warehouse schema.
SHARED_CONNECTION_SUFFIX = "_shared_dim"

_NAME_OK = re.compile(r"^[A-Za-z_-]+$")
_COMMIT = re.compile(r"^commit:[0-9a-fA-F]{8,40}$")


def package_name(repo_url: str, taken: set[str] | None = None) -> str:
    """A valid package name for `repo_url`: `shared` first, else the repo name
    with anything but letters / `-` / `_` replaced (digits aren't allowed)."""
    taken = taken or set()
    if "shared" not in taken:
        return "shared"
    stem = (repo_url or "").rstrip("/").removesuffix(".git").rsplit("/", 1)[-1]
    base = re.sub(r"[^A-Za-z_-]", "_", stem).strip("_-") or "shared"
    name, i = base, 0
    while name in taken:
        i += 1
        name = f"{base}_{'abcdefghijklmnopqrstuvwxyz'[(i - 1) % 26] * ((i - 1) // 26 + 1)}"
    return name


def package_entry(name: str, url: str, branch: str, sha: str) -> dict[str, str]:
    return {"name": name, "url": url, "branch": branch or "main", "version": f"commit:{sha}"}


def validate_packages(packages: list[dict[str, Any]]) -> list[str]:
    """Same checks as SML-develop's YamlPackageFileValidator."""
    errors: list[str] = []
    seen: dict[str, set[str]] = {"name": set(), "url": set()}
    for p in packages:
        name = p.get("name") or ""
        if not _NAME_OK.match(name):
            errors.append(f"Package name '{name}' may only contain letters, '-' or '_'.")
        if not str(p.get("url") or "").startswith(("http://", "https://")):
            errors.append(f"Package '{name}' needs an http(s) URL.")
        if not _COMMIT.match(str(p.get("version") or "")):
            errors.append(f"Package '{name}' version must be 'commit:<sha>' (got '{p.get('version')}').")
        for key in ("name", "url"):
            value = str(p.get(key) or "").rstrip("/").lower()
            if value in seen[key]:
                errors.append(f"Package {key} '{p.get(key)}' is listed twice.")
            seen[key].add(value)
    return errors


def package_yml(packages: list[dict[str, Any]], marker: str) -> str:
    body = yaml.safe_dump({"version": 1, "packages": [
        {"name": p["name"], "url": p["url"], "branch": p["branch"], "version": p["version"]} for p in packages
    ]}, sort_keys=False, default_flow_style=False)
    return f"{marker}\n{body}"


def read_packages(files: dict[str, str]) -> list[dict[str, Any]]:
    """The root package.yml's entries ([] when there is none or it won't parse)."""
    for name in _PACKAGE_FILES:
        if name in files:
            try:
                doc = yaml.safe_load(files[name]) or {}
            except yaml.YAMLError:
                return []
            return [p for p in (doc.get("packages") or []) if isinstance(p, dict)]
    return []


def commit_of(package: dict[str, Any]) -> str | None:
    version = str(package.get("version") or "")
    return version.removeprefix("commit:").strip() if version.startswith("commit:") else None


def is_package_file(path: str) -> bool:
    return path in _PACKAGE_FILES


def is_shared_repo(files: dict[str, str]) -> bool:
    """A shared-dimensions repo: catalog.yml carries SHARED_MARKER, or the repo
    has dimensions and no model."""
    has_model = has_dimension = False
    for path, body in files.items():
        if path in ("catalog.yml", "catalog.yaml") and SHARED_MARKER in body:
            return True
        try:
            doc = yaml.safe_load(body)
        except yaml.YAMLError:
            continue
        if isinstance(doc, dict):
            has_model = has_model or doc.get("object_type") == "model"
            has_dimension = has_dimension or doc.get("object_type") == "dimension"
    return has_dimension and not has_model


def _name_of(body: str) -> tuple | None:
    try:
        doc = yaml.safe_load(body)
    except yaml.YAMLError:
        return None
    return (doc.get("object_type"), doc.get("unique_name")) if isinstance(doc, dict) else None


def flatten_packages(files: dict[str, str], packages: list[dict[str, Any]]) -> dict[str, str]:
    """The repo with each package's objects merged in under packages/<name>/
    (as AtScale merges them), minus package.yml and the packages' catalog /
    model - for tools that don't resolve packages themselves: sml-cli
    (validate.py) and the legacy deploy, which compiles the catalog XML
    locally (atscale/legacy_deploy.py). Same-name objects are kept, so a clash
    is reported the way AtScale reports it (package_conflicts).
    `packages`: [{ref: {name, ...}, files}]."""
    out = {k: v for k, v in files.items() if not is_package_file(k)}
    for pkg in packages:
        for rel, body in (pkg.get("files") or {}).items():
            key = _name_of(body)
            if not key or key[0] in (None, "catalog", "model"):
                continue
            out[f"packages/{pkg['ref']['name']}/{rel}"] = body
    return out


def package_conflicts(files: dict[str, str]) -> list[str]:
    """Objects of one type sharing a unique_name in a flattened repo - AtScale
    refuses those ('The "connection" name ... is not unique')."""
    seen: dict[tuple, list[str]] = {}
    for path, body in files.items():
        key = _name_of(body)
        if key and key[0] and key[1]:
            seen.setdefault(key, []).append(path)
    return [f'The "{t}" name "{n}" is not unique: {", ".join(sorted(paths))}'
            for (t, n), paths in seen.items() if len(paths) > 1]
