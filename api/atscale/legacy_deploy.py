"""Deploy for AtScale builds that predate POST /v1/catalogs/deploy.

Ported from sml-wizard api/atscale/deploy.py (itself ported from
reference/ps-utils/src/operations/atscale-deploy-catalog/
AtScaleDeployCatalogOperation.ts): read the repo's SML at the branch, compile
the legacy catalog XML locally (smlgen/catalog_xml.py) and POST both to
/wapi/git/deploy/catalog with a Design Center session cookie. RealBackend.
deploy_branch falls back to this when /v1/catalogs/deploy answers 404.
"""

from __future__ import annotations

import re
import tempfile
import uuid
from pathlib import Path
from typing import Any

from smlgen.catalog_xml import build_catalog_xml
from smlgen.parse import _load_all as load_sml_objects

from .client import AtScaleClient

_YAML = {".yml", ".yaml"}


def infer_con_ids(files: dict[str, str], connections_map: dict[str, dict[str, Any]]) -> list[str]:
    """sml-wizard atscale/deploy.py :: infer_con_ids - every `connection_id:`
    translated from the SML connection's unique_name to its AtScale data
    warehouse id (`as_connection`); the endpoint validates conIds against those."""
    ids: set[str] = set()
    for body in files.values():
        for match in re.finditer(r"^connection_id:\s*(.+)$", body, re.MULTILINE):
            ids.add(match.group(1).strip())
    return sorted({connections_map.get(i, {}).get("as_connection", i) for i in ids})


def read_repo_sml(repo_url: str, branch: str, username: str | None, token: str) -> dict[str, str]:
    """Shallow-clone repo@branch into a temp dir and return its YAML files."""
    from git import Repo

    auth = f"{username}:{token}" if username else token
    url = repo_url.replace("https://", f"https://{auth}@", 1) if repo_url.startswith("https://") else repo_url
    with tempfile.TemporaryDirectory(prefix="envmgr-deploy-") as tmp:
        try:
            Repo.clone_from(url, tmp, branch=branch, depth=1)
        except Exception as e:  # noqa: BLE001 - never echo the token in the message
            raise ValueError(f"Couldn't clone {repo_url}@{branch}: {str(e).replace(token, '***')}") from None
        root = Path(tmp)
        return {str(p.relative_to(root)): p.read_text(encoding="utf-8")
                for p in root.rglob("*") if ".git" not in p.parts and p.is_file() and p.suffix.lower() in _YAML}


def deploy(api_client: AtScaleClient, cookie_client: AtScaleClient, files: dict[str, str], repo_id: str,
           branch: str) -> dict[str, Any]:
    """sml-wizard atscale/deploy.py :: deploy. `api_client` is the host's Bearer
    client (/wapi/p/projects/deployed); `cookie_client` has cookie_auth=True
    (/wapi/git/deploy/catalog) - ps-utils' dual-environment design."""
    parsed = load_sml_objects(files)
    catalog, model = parsed["catalog"], parsed["model"]
    if not catalog:
        raise ValueError("No catalog.yml (object_type: catalog) in the repo")
    if not model:
        raise ValueError("No model file (object_type: model) in the repo")
    con_ids = infer_con_ids(files, parsed["connections"])
    project_name = f"{catalog['unique_name']}_{branch}"
    deployed = api_client.list_deployed_projects()
    repo_entry = next((e for e in deployed if e.get("repoId") == repo_id), None)
    existing = next((p for p in (repo_entry or {}).get("projects", []) if p.get("name") == project_name), None)
    project_id = existing["id"] if existing else str(uuid.uuid4())
    project_xml = build_catalog_xml(
        catalog=catalog, model=model, dimensions_map=parsed["dimensions"], datasets_map=parsed["datasets"],
        metrics_map=parsed["metrics"], connections_map=parsed["connections"],
        project_name=project_name, project_id=project_id,
    )
    result = cookie_client.deploy_repo(
        repo_id=repo_id, sml_raw_files=[{"relativePath": n, "rawContent": b} for n, b in files.items()],
        project_xml=project_xml, project_name=project_name, con_ids=con_ids, project_id=project_id,
    )
    return {"catalogId": project_id, "projectName": project_name, "conIds": con_ids,
            "reusedExistingProject": existing is not None, "result": result}
