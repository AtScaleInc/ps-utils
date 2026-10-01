"""Catalog: the business unit's AtScale models seen from the repo side.

  GET /catalog        ?refresh=1 - every Git repo holding models, each model,
                      and where it sits on each of the BU's hosts

Manage, Promote and Test start from a host and list what is on it; this is the
reverse - start from a repo / model and see every host (Dev, Test, QA, Prod)
it is linked or deployed on, at which branch and commit, and whether that
commit is the branch head. Repos come from the BU's Git profile (repos with a
root catalog.yml - github.list_catalog_repos) plus any repo a host has
attached that the profile doesn't list, so a deployment is never hidden.
"""

from __future__ import annotations

import contextvars
from concurrent.futures import ThreadPoolExecutor
from typing import Any

from flask import Blueprint, jsonify, request

import cache
from envs import registry

catalog_bp = Blueprint("catalog", __name__)


def _refresh() -> bool:
    return request.args.get("refresh") in ("1", "true")


def _parallel(fn, items: list) -> list:
    """`fn` over `items` on a pool, each in a copy of the request's context
    (registry.current_bu is a contextvar: worker threads don't inherit it)."""
    if not items:
        return []
    with ThreadPoolExecutor(max_workers=8) as ex:
        return list(ex.map(lambda x: contextvars.copy_context().run(fn, x), items))


def _git_repos(refresh: bool) -> tuple[list[dict[str, Any]], str | None]:
    """([{url, fullName, defaultBranch, models}], error) from the Git profile."""
    if registry.FAKE:
        from atscale.fake import FAKE_REPOS

        return [{"url": u, "fullName": u.split("github.com/")[1], "defaultBranch": "main", "models": list(ms)}
                for u, ms in FAKE_REPOS.items() if ms], None
    token = registry.git_token()
    if not token:
        return [], "Git profile is missing - set it in Settings"
    from atscale import github

    def load() -> list[dict[str, Any]]:
        repos = github.list_catalog_repos(token)

        def with_models(r: dict[str, Any]) -> dict[str, Any]:
            try:
                return {**r, "models": github.models_in_files(github.fetch_sml_files(token, r["url"], r["defaultBranch"]))}
            except github.GitError:
                return {**r, "models": []}

        with ThreadPoolExecutor(max_workers=8) as ex:
            return list(ex.map(with_models, repos))

    try:
        repos, _ = cache.get(("git", registry.bu(), "catalog-repos"), load, refresh=refresh)
        return repos, None
    except Exception as e:  # noqa: BLE001 - the hosts' side still shows
        return [], str(e)


def _host_rows(h: dict[str, Any], refresh: bool) -> dict[str, Any]:
    try:
        b = registry.backend(h["id"], refresh)
        return {"host": h, "backend": b, "models": b.list_models(), "error": None}
    except Exception as e:  # noqa: BLE001 - one unreachable host doesn't hide the rest
        return {"host": h, "backend": None, "models": [], "error": str(e)}


def _head(b: Any, repo_url: str, branch: str, model: str) -> str | None:
    """The branch's head commit as the host sees it (its cached branch list)."""
    if registry.FAKE:
        from atscale import fake

        return f"v{fake._head(model, branch)}"
    try:
        return next((x.get("sha") for x in b.branches(repo_url) if x.get("name") == branch), None)
    except Exception:  # noqa: BLE001 - unknown head = no "behind" flag
        return None


def _same_commit(a: str | None, b: str | None) -> bool:
    return bool(a and b) and (a.startswith(b) or b.startswith(a))


@catalog_bp.get("/catalog")
def catalog():
    from atscale.github import normalize_repo_url

    refresh = _refresh()
    hosts = registry.bu_hosts()
    git, git_error = _git_repos(refresh)
    per_host = _parallel(lambda h: _host_rows(h, refresh), hosts)

    repos: dict[str, dict[str, Any]] = {}

    def repo(url: str, full: str | None = None, branch: str | None = None, source: str = "git") -> dict[str, Any]:
        key = normalize_repo_url(url)
        if key not in repos:
            repos[key] = {"url": url, "fullName": full or "/".join(url.rstrip("/").split("/")[-2:]),
                          "defaultBranch": branch or "main", "source": source, "models": {}}
        return repos[key]

    def model(r: dict[str, Any], name: str) -> dict[str, Any]:
        return r["models"].setdefault(name, {"name": name, "inGit": False, "deployments": []})

    for g in git:
        r = repo(g["url"], g.get("fullName"), g.get("defaultBranch"))
        for name in g.get("models") or []:
            model(r, name)["inGit"] = True

    head_jobs: list[tuple[dict[str, Any], Any, str, str, str]] = []
    for hr in per_host:
        h = hr["host"]
        for row in hr["models"]:
            if not row.get("name") or not row.get("repoUrl"):
                continue  # a repo attached with no model linked from it
            r = repo(row["repoUrl"], branch=row.get("branch"), source="host")
            d = {
                "hostId": h["id"], "env": h["env"], "label": h["label"],
                "key": row["key"], "status": row["status"], "catalog": row.get("catalog"),
                "branch": row.get("branch"), "commit": row.get("commit"), "version": row.get("version"),
                "commitDate": row.get("commitDate"), "versionInferred": row.get("versionInferred", False),
                "updated": row.get("updated"), "head": None, "atHead": None,
            }
            model(r, row["name"])["deployments"].append(d)
            if row["status"] != "Linked" and row.get("branch"):
                head_jobs.append((d, hr["backend"], row["repoUrl"], row["branch"], row["name"]))

    heads = _parallel(lambda j: _head(j[1], j[2], j[3], j[4]), head_jobs)
    for (d, *_), head in zip(head_jobs, heads):
        d["head"] = head
        d["atHead"] = _same_commit(d["commit"], head) if head and d["commit"] else None

    order = {e: i for i, e in enumerate(("dev", "test", "qa", "prod"))}
    out = []
    for r in repos.values():
        models = sorted(r.pop("models").values(), key=lambda m: m["name"].lower())
        if not models:
            continue
        for m in models:
            m["deployments"].sort(key=lambda d: (order.get(d["env"], 9), d["label"].lower()))
        out.append({**r, "models": models})
    out.sort(key=lambda r: r["fullName"].lower())
    return jsonify({
        "repos": out,
        "hosts": [{"id": hr["host"]["id"], "env": hr["host"]["env"], "label": hr["host"]["label"], "error": hr["error"]}
                  for hr in per_host],
        "gitError": git_error,
    })
