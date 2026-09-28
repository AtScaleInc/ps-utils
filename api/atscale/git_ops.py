"""Git operations for the Deploy pipeline: create the model's GitHub repo (if
it doesn't exist yet) and push the generated SML to it. Copied from
sml-wizard api/atscale/git_ops.py; `author` added so commits carry the Git
profile's name/email instead of depending on the machine's git config.

New code, not a ps-utils port - ps-utils always deploys to a repo AtScale is
already attached to; this wizard also creates that repo per-model, named
after the model (per your steer: `github.com/<username>/<model-name>`,
spaces replaced with dashes).
"""

from __future__ import annotations

from pathlib import Path
from typing import Any

import requests
from git import Actor, GitCommandError, Repo

from smlgen.naming import slugify_model_name

# Kept as an alias - this is the same slug rule the workspace save path uses
# (smlgen/naming.py), just under the name existing callers (publish.py) import.
slugify_repo_name = slugify_model_name


def ensure_github_repo(username: str, token: str, repo_name: str, private: bool = True) -> dict[str, Any]:
    """Returns the repo's {html_url, clone_url, default_branch}, creating it
    under the token's account if it doesn't already exist."""
    headers = {"Authorization": f"token {token}", "Accept": "application/vnd.github+json"}

    resp = requests.get(f"https://api.github.com/repos/{username}/{repo_name}", headers=headers)
    if resp.status_code == 200:
        data = resp.json()
        return {
            "html_url": data["html_url"],
            "clone_url": data["clone_url"],
            "default_branch": data.get("default_branch", "main"),
            "created": False,
        }
    if resp.status_code != 404:
        raise RuntimeError(f"GitHub API error checking repo '{repo_name}': {resp.status_code} {resp.text}")

    # auto_init=False: an auto-created README commit would give the remote a
    # history unrelated to our freshly-committed local repo, making the first
    # push get rejected as a non-fast-forward / unrelated-histories conflict.
    # An empty repo has nothing to conflict with.
    create_resp = requests.post(
        "https://api.github.com/user/repos",
        headers=headers,
        json={"name": repo_name, "private": private, "auto_init": False},
    )
    if create_resp.status_code >= 300:
        raise RuntimeError(f"GitHub API error creating repo '{repo_name}': {create_resp.status_code} {create_resp.text}")
    data = create_resp.json()
    return {
        "html_url": data["html_url"],
        "clone_url": data["clone_url"],
        "default_branch": data.get("default_branch", "main"),
        "created": True,
    }


def push_sml_to_repo(
    local_dir: Path,
    clone_url: str,
    username: str,
    token: str,
    branch: str = "main",
    commit_message: str = "Update SML",
    author: tuple[str | None, str | None] | None = None,
) -> str:
    """Commits everything under local_dir and pushes to `branch`. Returns the
    commit SHA. `local_dir` is git-init'd in place if not already a repo."""
    auth_url = clone_url.replace("https://", f"https://{username}:{token}@", 1)

    if (local_dir / ".git").exists():
        repo = Repo(str(local_dir))
    else:
        repo = Repo.init(str(local_dir), initial_branch=branch)

    if "origin" in [r.name for r in repo.remotes]:
        repo.remotes.origin.set_url(auth_url)
    else:
        repo.create_remote("origin", auth_url)

    repo.git.add(A=True)
    if repo.is_dirty(untracked_files=True) or not repo.head.is_valid():
        actor = Actor(author[0], author[1]) if author and author[0] and author[1] else None
        repo.index.commit(commit_message, author=actor, committer=actor)

    try:
        repo.git.checkout("-B", branch)
        repo.remotes.origin.fetch()
    except GitCommandError:
        pass  # empty remote - nothing to fetch yet

    try:
        push_infos = repo.remotes.origin.push(refspec=f"{branch}:{branch}", set_upstream=True)
    except GitCommandError as e:
        raise RuntimeError(f"git push failed: {e}") from e
    finally:
        # local_dir is workspace/<model> - a visible, user-browsable directory,
        # not a hidden cache dir - don't leave the token embedded in its
        # .git/config once the push attempt is done (success or failure).
        repo.remotes.origin.set_url(clone_url)

    # GitPython's push() does not raise on a rejected/errored push - it only
    # returns a PushInfoList with per-ref flags that must be checked.
    error_flags = push_infos[0].ERROR | push_infos[0].REJECTED if push_infos else 0
    failed = [info for info in push_infos if info.flags & error_flags]
    if failed:
        summaries = "; ".join(info.summary.strip() for info in failed)
        raise RuntimeError(f"git push rejected: {summaries}")

    return repo.head.commit.hexsha
