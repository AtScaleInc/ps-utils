#!/usr/bin/env python3
"""envmgr - run AtScale Env Manager pipeline steps from CI.

    envmgr validate --path .
    envmgr deploy --env qa --branch main --commit <sha> [--repo owner/name | --model "Internet Sales"] [--host qa-1 ...]
    envmgr test --env qa [--baseline prod|previous] [--model ...] [--junit results.xml]
    envmgr promote-aggs --from qa --to prod [--system-only] [--model ...]
    envmgr rollback --model "Internet Sales" --env prod
    envmgr promote --model "Internet Sales" --env prod      (built-in gate)
    envmgr report --stage "Lint" --verdict pass
    envmgr status

Reads ENVMGR_URL and ENVMGR_TOKEN (an API token from Env Manager › Pipeline ›
CI setup). Each step starts a job on the server, polls it every 10 s
(ENVMGR_POLL_S), prints its summary and exits 0 = pass, 1 = fail, 2 = error.
Under GitHub Actions or Jenkins the run (number, URL, commit, PR) is detected
and sent along, so Env Manager's Runs list links back to it and a test on a PR
posts a commit status and a comment. ENVMGR_INSECURE=1 skips TLS verification.

Standard library only: CI fetches this file from the Env Manager it calls
(GET /api/pipeline/cli), so the CLI always matches the server.
"""

from __future__ import annotations

import argparse
import json
import os
import ssl
import subprocess
import sys
import time
import urllib.error
import urllib.request
from pathlib import Path
from typing import Any

PASS, FAIL, ERROR = 0, 1, 2
SKIP_DIRS = {".git", ".github", "node_modules", ".venv", "__pycache__"}


class Fail(Exception):
    def __init__(self, msg: str, code: int = ERROR):
        super().__init__(msg)
        self.code = code


def _ctx() -> ssl.SSLContext | None:
    if os.environ.get("ENVMGR_INSECURE") == "1":
        c = ssl.create_default_context()
        c.check_hostname = False
        c.verify_mode = ssl.CERT_NONE
        return c
    return None


def call(method: str, path: str, body: Any = None, raw: bool = False) -> Any:
    url = os.environ.get("ENVMGR_URL", "").rstrip("/")
    token = os.environ.get("ENVMGR_TOKEN", "")
    if not url:
        raise Fail("Set ENVMGR_URL to the Env Manager's address (e.g. https://envmgr.corp.local)")
    if not token:
        raise Fail("Set ENVMGR_TOKEN to an API token (Env Manager › Pipeline › CI setup › API tokens)")
    data = json.dumps(body).encode() if body is not None else None
    req = urllib.request.Request(f"{url}/api{path}", data=data, method=method, headers={
        "Authorization": f"Bearer {token}", "Content-Type": "application/json", "Accept": "application/json"})
    try:
        with urllib.request.urlopen(req, timeout=120, context=_ctx()) as resp:
            text = resp.read().decode()
            return text if raw else (json.loads(text) if text else {})
    except urllib.error.HTTPError as e:
        try:
            msg = json.loads(e.read().decode()).get("error") or e.reason
        except Exception:  # noqa: BLE001
            msg = e.reason
        # A closed gate is a pipeline verdict (fail), not an error.
        raise Fail(f"{e.code}: {msg}", FAIL if e.code == 409 else ERROR) from None
    except urllib.error.URLError as e:
        raise Fail(f"Can't reach {url}: {e.reason}") from None


# -- CI detection ----------------------------------------------------------------------------

def _git(*args: str) -> str | None:
    try:
        return subprocess.run(["git", *args], capture_output=True, text=True, check=True).stdout.strip() or None
    except Exception:  # noqa: BLE001
        return None


def _https(url: str | None) -> str | None:
    if not url:
        return None
    if url.startswith("git@"):
        host, path = url[4:].split(":", 1)
        url = f"https://{host}/{path}"
    return url.removesuffix(".git")


def ci_context(stage: str | None = None) -> dict[str, Any]:
    e = os.environ
    if e.get("GITHUB_ACTIONS") == "true":
        event: dict[str, Any] = {}
        try:
            event = json.loads(Path(e["GITHUB_EVENT_PATH"]).read_text())
        except Exception:  # noqa: BLE001
            pass
        pr = event.get("pull_request") or {}
        server, repo = e.get("GITHUB_SERVER_URL", "https://github.com"), e.get("GITHUB_REPOSITORY")
        return {"orchestrator": "gha", "runRef": f"GHA #{e.get('GITHUB_RUN_NUMBER', '?')}",
                "url": f"{server}/{repo}/actions/runs/{e.get('GITHUB_RUN_ID')}" if repo else None,
                "sha": (pr.get("head") or {}).get("sha") or e.get("GITHUB_SHA"), "pr": pr.get("number"),
                "repo": f"{server}/{repo}" if repo else None, "stage": stage}
    if e.get("JENKINS_URL"):
        return {"orchestrator": "jenkins", "runRef": f"JNK #{e.get('BUILD_NUMBER', '?')}", "url": e.get("BUILD_URL"),
                "sha": e.get("GIT_COMMIT"), "pr": e.get("CHANGE_ID"), "repo": _https(e.get("GIT_URL")),
                "stage": stage}
    return {"orchestrator": "cli", "sha": _git("rev-parse", "HEAD"), "repo": _https(_git("remote", "get-url", "origin")),
            "stage": stage}


# -- jobs -----------------------------------------------------------------------------------

def wait(job_id: str, junit: str | None) -> int:
    poll = float(os.environ.get("ENVMGR_POLL_S", "10"))
    t0 = time.time()
    while True:
        j = call("GET", f"/pipeline/jobs/{job_id}")
        if j.get("status") != "running":
            break
        print(f"  … running ({int(time.time() - t0)} s)", flush=True)
        time.sleep(poll)
    verdict = j.get("verdict")
    print(f"{(verdict or 'error').upper()}: {j.get('summary') or ''}")
    for m in (j.get("result") or {}).get("models") or []:
        if m.get("summary") and len((j.get("result") or {}).get("models")) > 1:
            print(f"  - {m['summary']}")
    if junit:
        Path(junit).write_text(call("GET", f"/pipeline/jobs/{job_id}/junit", raw=True))
        print(f"JUnit: {junit}")
    return PASS if verdict == "pass" else FAIL if verdict == "fail" else ERROR


def start(path: str, body: dict[str, Any], junit: str | None = None) -> int:
    res = call("POST", path, body)
    print(f"Job {res['jobId']} started")
    return wait(res["jobId"], junit)


# -- commands -------------------------------------------------------------------------------

def cmd_validate(a: argparse.Namespace, ci: dict[str, Any]) -> int:
    root = Path(a.path).resolve()
    files = {}
    for p in root.rglob("*"):
        if p.is_file() and p.suffix in (".yml", ".yaml") and not (set(p.relative_to(root).parts) & SKIP_DIRS):
            files[str(p.relative_to(root))] = p.read_text(encoding="utf-8", errors="replace")
    if not files:
        raise Fail(f"No .yml files under {root}", FAIL)
    print(f"Validating {len(files)} files")
    return start("/pipeline/validate", {"files": files, "ci": ci}, a.junit)


def cmd_deploy(a: argparse.Namespace, ci: dict[str, Any]) -> int:
    branch = a.branch or os.environ.get("GITHUB_HEAD_REF") or os.environ.get("CHANGE_BRANCH") \
        or os.environ.get("GITHUB_REF_NAME") or os.environ.get("BRANCH_NAME") or _git("rev-parse", "--abbrev-ref", "HEAD")
    body = {"env": a.env, "branch": branch, "commit": a.commit, "model": a.model,
            "repo": a.repo or (None if a.model else ci.get("repo")), "force": a.force, "hosts": a.host, "ci": ci}
    return start("/pipeline/deploy", body, a.junit)


def cmd_test(a: argparse.Namespace, ci: dict[str, Any]) -> int:
    body = {"env": a.env, "model": a.model, "repo": a.repo or (None if a.model else ci.get("repo")),
            "commit": a.commit, "baseline": a.baseline, "protocols": a.protocols.split(","), "host": a.host, "ci": ci}
    return start("/pipeline/test", body, a.junit)


def cmd_promote_aggs(a: argparse.Namespace, ci: dict[str, Any]) -> int:
    # --system-only is the only mode: user-defined aggregates are never promoted.
    body = {"from": a.src, "to": a.to, "model": a.model, "includeReplacements": a.include_replacements, "ci": ci}
    return start("/pipeline/promote-aggs", body, a.junit)


def cmd_rollback(a: argparse.Namespace, ci: dict[str, Any]) -> int:
    return start("/pipeline/rollback", {"env": a.env, "model": a.model, "hosts": a.host, "ci": ci}, a.junit)


def cmd_promote(a: argparse.Namespace, ci: dict[str, Any]) -> int:
    return start("/pipeline/promote", {"env": a.env, "model": a.model, "hosts": a.host, "branch": a.branch, "ci": ci}, a.junit)


def cmd_report(a: argparse.Namespace, ci: dict[str, Any]) -> int:
    call("POST", "/pipeline/runs", {"stage": a.stage, "verdict": a.verdict, "model": a.model, "env": a.env,
                                    "commit": a.commit or ci.get("sha"), "ci": ci})
    print(f"Reported {a.stage}: {a.verdict}")
    return PASS


def cmd_status(a: argparse.Namespace, ci: dict[str, Any]) -> int:
    b = call("GET", "/pipeline/board")
    st = b["stages"]
    print("Stages: " + " → ".join(s["label"] for s in st))
    for m in b["models"]:
        cells = []
        for c, s in zip(m["cells"], st):
            cells.append(f"{s['label']} {c['version'] if c else '—'}" + (f" ({c['test']['verdict']})" if c else ""))
        gates = [g["label"] for g in m["gates"] if g.get("label")]
        print(f"  {m['name']}: " + " | ".join(cells) + (f"  · {', '.join(gates)}" if gates else ""))
    return PASS


def main(argv: list[str] | None = None) -> int:
    p = argparse.ArgumentParser(prog="envmgr", description="AtScale Env Manager pipeline steps")
    sub = p.add_subparsers(dest="cmd", required=True)

    def add(name: str, fn, help_: str) -> argparse.ArgumentParser:
        sp = sub.add_parser(name, help=help_)
        sp.set_defaults(fn=fn)
        sp.add_argument("--stage", help="label for the Runs list (default: the step, e.g. 'Test · QA')")
        sp.add_argument("--junit", help="write the step's result as JUnit XML to this file")
        return sp

    sp = add("validate", cmd_validate, "validate the SML under a folder (sml-cli)")
    sp.add_argument("--path", default=".")
    sp = add("deploy", cmd_deploy, "deploy a branch to every host of a stage")
    sp.add_argument("--env", required=True)
    sp.add_argument("--branch")
    sp.add_argument("--commit", help="refuse if the branch head isn't this commit")
    sp.add_argument("--repo", help="repository URL or owner/name (default: this checkout's)")
    sp.add_argument("--model", help="pick the repository by one of its models")
    sp.add_argument("--force", action="store_true", help="skip the gate check (needs the 'deploy' scope anyway)")
    sp.add_argument("--host", action="append", help="a host id of the stage (repeat it; default: every host)")
    sp = add("test", cmd_test, "test what a stage runs against a baseline")
    sp.add_argument("--env", required=True)
    sp.add_argument("--model")
    sp.add_argument("--repo")
    sp.add_argument("--commit", help="fail unless the stage runs this commit")
    sp.add_argument("--baseline", help="a stage (default: the last one) or 'previous'")
    sp.add_argument("--protocols", default="mdx", help="mdx, sql or mdx,sql")
    sp.add_argument("--host", help="test on this host of the stage (default: its primary host)")
    sp = add("promote-aggs", cmd_promote_aggs, "move system aggregates between stages")
    sp.add_argument("--from", dest="src", required=True)
    sp.add_argument("--to", required=True)
    sp.add_argument("--model")
    sp.add_argument("--system-only", action="store_true", help="the default and only mode")
    sp.add_argument("--include-replacements", action="store_true", help="also replace inactive copies on the target")
    sp = add("rollback", cmd_rollback, "redeploy the commit a stage ran before")
    sp.add_argument("--env", required=True)
    sp.add_argument("--model", required=True)
    sp.add_argument("--host", action="append", help="a host id of the stage (repeat it; default: every host)")
    sp = add("promote", cmd_promote, "built-in gate: promote a model into a stage when its gate is open")
    sp.add_argument("--env", required=True)
    sp.add_argument("--model", required=True)
    sp.add_argument("--branch", help="over a merge gate: the branch to deploy (a promotion takes the tested commit's)")
    sp.add_argument("--host", action="append", help="a host id of the stage (repeat it; default: every host)")
    sp = add("report", cmd_report, "report a step Env Manager didn't run")
    sp.add_argument("--verdict", choices=["pass", "fail"], required=True)
    sp.add_argument("--model")
    sp.add_argument("--env")
    sp.add_argument("--commit")
    add("status", cmd_status, "print the pipeline board")

    a = p.parse_args(argv)
    try:
        return a.fn(a, ci_context(a.stage))
    except Fail as e:
        print(f"envmgr: {e}", file=sys.stderr)
        return e.code
    except KeyboardInterrupt:
        return ERROR


if __name__ == "__main__":
    sys.exit(main())
