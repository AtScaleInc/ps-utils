"""GitHub side of link / deploy / promote.

Repo discovery is ported from
web-manager/reference/PythonAtscaleUtility/api/git_operations.py :: get_personal_repositories()
+ _repo_has_catalog() + get_repos_with_catalog(). Fetching a branch's SML is the
same job as migration/migration_fromGit.py (walk the contents API), done as a
single tarball download instead of one request per file.
"""

from __future__ import annotations

import io
import re
import tarfile
from concurrent.futures import ThreadPoolExecutor
from typing import Any

import requests
import yaml

API = "https://api.github.com"


class GitError(RuntimeError):
    pass


def _headers(token: str) -> dict[str, str]:
    return {
        "Accept": "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
        "Authorization": f"Bearer {token}",
    }


def normalize_repo_url(url: str) -> str:
    """Same normalisation sml-wizard's publish.py uses to match AtScale's
    /wapi/p/repo records (trailing `.git`, slash and case differ between
    repos attached by hand and by tools)."""
    return (url or "").strip().rstrip("/").removesuffix(".git").lower()


def repo_full_name(url: str) -> str:
    m = re.search(r"github\.com[/:]([^/]+)/([^/]+?)(?:\.git)?/?$", (url or "").strip())
    if not m:
        raise GitError(f"Not a GitHub repository URL: {url}")
    return f"{m.group(1)}/{m.group(2)}"


def test_token(token: str) -> dict[str, Any]:
    resp = requests.get(f"{API}/user", headers=_headers(token), timeout=15)
    if resp.status_code != 200:
        raise GitError(f"GitHub rejected the token ({resp.status_code})")
    return {"login": resp.json().get("login")}


def list_catalog_repos(token: str) -> list[dict[str, Any]]:
    resp = requests.get(
        f"{API}/user/repos",
        headers=_headers(token),
        params={"visibility": "all", "affiliation": "owner,collaborator,organization_member",
                "sort": "full_name", "per_page": 100},
        timeout=30,
    )
    if resp.status_code != 200:
        raise GitError(f"GitHub API returned {resp.status_code}: {resp.text[:200]}")
    repos = resp.json()

    def has_catalog(repo: dict[str, Any]) -> bool:
        r = requests.get(f"{API}/repos/{repo['full_name']}/contents/catalog.yml",
                         headers=_headers(token), timeout=12)
        return r.status_code == 200

    with ThreadPoolExecutor(max_workers=8) as ex:
        flags = list(ex.map(has_catalog, repos))
    return [
        {"fullName": r["full_name"], "url": r["html_url"], "defaultBranch": r.get("default_branch") or "main",
         "private": r.get("private", False)}
        for r, ok in zip(repos, flags) if ok
    ]


def _user_repos(token: str) -> list[dict[str, Any]]:
    resp = requests.get(
        f"{API}/user/repos",
        headers=_headers(token),
        params={"visibility": "all", "affiliation": "owner,collaborator,organization_member",
                "sort": "full_name", "per_page": 100},
        timeout=30,
    )
    if resp.status_code != 200:
        raise GitError(f"GitHub API returned {resp.status_code}: {resp.text[:200]}")
    return resp.json()


def shared_repo_check(token: str, full: str, marker: str, ref: str | None = None) -> bool | None:
    """Whether `full` (owner/name) is a shared-dimensions package at `ref`
    (default branch when None): None when it has no root catalog.yml or has a
    models/ folder without carrying `marker`, else whether it carries it."""
    raw = {**_headers(token), "Accept": "application/vnd.github.raw+json"}
    params = {"ref": ref} if ref else None
    r = requests.get(f"{API}/repos/{full}/contents/catalog.yml", headers=raw, params=params, timeout=12)
    if r.status_code != 200:
        return None
    if marker in r.text:
        return True
    m = requests.get(f"{API}/repos/{full}/contents/models", headers=_headers(token), params=params, timeout=12)
    if m.status_code == 200 and m.json():
        return None
    return False


def list_shared_repos(token: str, marker: str) -> list[dict[str, Any]]:
    """Repos usable as a shared-dimensions package (smlgen/packages.py): a root
    catalog.yml carrying `marker` (tagged), or a catalog with no models/
    folder. Same discovery as list_catalog_repos, reading catalog.yml's text."""
    repos = _user_repos(token)

    def check(repo: dict[str, Any]) -> dict[str, Any] | None:
        tagged = shared_repo_check(token, repo["full_name"], marker)
        if tagged is None:
            return None
        return {"fullName": repo["full_name"], "url": repo["html_url"],
                "defaultBranch": repo.get("default_branch") or "main",
                "private": repo.get("private", False), "tagged": tagged}

    with ThreadPoolExecutor(max_workers=8) as ex:
        return [r for r in ex.map(check, repos) if r]


def fetch_sml_files(token: str, repo_url: str, branch: str) -> dict[str, str]:
    """{relativePath: content} for every YAML file on `branch`."""
    full = repo_full_name(repo_url)
    resp = requests.get(f"{API}/repos/{full}/tarball/{branch}", headers=_headers(token), timeout=60)
    if resp.status_code != 200:
        raise GitError(f"Could not download {full}@{branch} ({resp.status_code})")
    files: dict[str, str] = {}
    with tarfile.open(fileobj=io.BytesIO(resp.content), mode="r:gz") as tar:
        for member in tar.getmembers():
            if not member.isfile():
                continue
            rel = member.name.split("/", 1)[1] if "/" in member.name else member.name
            if not rel.endswith((".yml", ".yaml")):
                continue
            fh = tar.extractfile(member)
            if fh:
                files[rel] = fh.read().decode("utf-8", errors="replace")
    return files


def models_in_files(files: dict[str, str]) -> list[str]:
    names = []
    for body in files.values():
        try:
            doc = yaml.safe_load(body)
        except yaml.YAMLError:
            continue
        if isinstance(doc, dict) and doc.get("object_type") == "model":
            names.append(doc.get("label") or doc.get("unique_name"))
    return sorted(n for n in names if n)


# -- versions: a deployed model's version is the Git commit it was built from ----------
# AtScale records no commit for a deployment (GET /v1/catalogs, /wapi/p/catalog
# only carry a publish counter + publishedAt), so versions come from GitHub.

def list_branches(token: str, repo_url: str) -> list[dict[str, Any]]:
    """[{name, sha}] - sha is the branch head, i.e. what a deploy would build."""
    full = repo_full_name(repo_url)
    resp = requests.get(f"{API}/repos/{full}/branches", headers=_headers(token), params={"per_page": 100}, timeout=20)
    if resp.status_code != 200:
        raise GitError(f"Could not list branches of {full} ({resp.status_code})")
    return [{"name": b["name"], "sha": (b.get("commit") or {}).get("sha")} for b in resp.json()]


def head_commit(token: str, repo_url: str, branch: str) -> dict[str, Any]:
    full = repo_full_name(repo_url)
    resp = requests.get(f"{API}/repos/{full}/commits/{branch}", headers=_headers(token), timeout=20)
    if resp.status_code != 200:
        raise GitError(f"Could not read {full}@{branch} ({resp.status_code})")
    return _commit(resp.json())


def commit_at(token: str, repo_url: str, branch: str, when_iso: str) -> dict[str, Any] | None:
    """Last commit on `branch` at or before `when_iso` - what a deploy made at
    that moment would have built."""
    full = repo_full_name(repo_url)
    resp = requests.get(f"{API}/repos/{full}/commits", headers=_headers(token),
                        params={"sha": branch, "until": when_iso, "per_page": 1}, timeout=20)
    if resp.status_code != 200 or not resp.json():
        return None
    return _commit(resp.json()[0])


def compare(token: str, repo_url: str, base: str, head: str) -> str | None:
    """'identical' | 'ahead' (head newer) | 'behind' | 'diverged', or None."""
    full = repo_full_name(repo_url)
    resp = requests.get(f"{API}/repos/{full}/compare/{base}...{head}", headers=_headers(token), timeout=20)
    if resp.status_code != 200:
        return None
    return resp.json().get("status")


def _commit(c: dict[str, Any]) -> dict[str, Any]:
    return {"sha": c["sha"], "date": c["commit"]["committer"]["date"], "message": c["commit"]["message"].splitlines()[0]}


def set_commit_status(token: str, repo_url: str, sha: str, state: str, description: str,
                      context: str = "atscale/env-manager", target_url: str | None = None) -> None:
    """POST /repos/{o}/{r}/statuses/{sha} - the pipeline's test verdict on the
    commit (state: pending | success | failure | error)."""
    full = repo_full_name(repo_url)
    body: dict[str, Any] = {"state": state, "description": description[:140], "context": context}
    if target_url:
        body["target_url"] = target_url
    resp = requests.post(f"{API}/repos/{full}/statuses/{sha}", headers=_headers(token), json=body, timeout=20)
    if resp.status_code >= 300:
        raise GitError(f"Could not set the commit status on {full}@{sha[:7]} ({resp.status_code})")


def comment_on_pr(token: str, repo_url: str, number: int, body: str) -> None:
    """POST /repos/{o}/{r}/issues/{n}/comments - the pipeline's test summary on a PR."""
    full = repo_full_name(repo_url)
    resp = requests.post(f"{API}/repos/{full}/issues/{number}/comments", headers=_headers(token),
                         json={"body": body}, timeout=20)
    if resp.status_code >= 300:
        raise GitError(f"Could not comment on {full}#{number} ({resp.status_code})")
