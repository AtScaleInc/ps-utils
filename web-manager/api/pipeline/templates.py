"""CI templates for the business unit's own stages (CI setup › Pipeline template).

The handoff's templates are Dev -> QA -> Prod; here they follow the BU's
groups. With two stages (Dev -> Prod): PRs and main both land on Dev, Prod is
the approved deploy. With three or four: PRs on the first stage, main on the
second, each later stage promoted once the stage before passed its test, and
the last one approved. System aggregates move into the last stage only - they
are runtime state per host, not Git.

Every job fetches the envmgr CLI from this Env Manager (GET /api/pipeline/cli,
one stdlib-only Python file), so the CLI always matches the server it calls.
The CLI turns the verdict into its exit code: 0 pass, 1 fail, 2 error.
"""

from __future__ import annotations

from typing import Any

from .stages import ENV_LABEL


def _gha_job(name: str, steps: list[str], cond: str | None = None, needs: str | None = None,
             environment: str | None = None) -> list[str]:
    out = [f"  {name}:"]
    if cond:
        out.append(f"    if: {cond}")
    if needs:
        out.append(f"    needs: {needs}")
    if environment:
        out.append(f"    environment: {environment}    # approval gate: required reviewers")
    out += ["    runs-on: ubuntu-latest", "    steps:", "      - uses: actions/checkout@v4",
            '      - run: curl -fsSL "$ENVMGR_URL/api/pipeline/cli" -o envmgr && chmod +x envmgr']
    out += [f"      - run: {s}" for s in steps]
    return out


def gha(st: list[dict[str, Any]], policy: dict[str, Any], url: str) -> str:
    envs = [s["env"] for s in st]
    if len(envs) < 2:
        return "# The pipeline needs hosts in at least two groups (for example Dev and Prod)."
    first, last = envs[0], envs[-1]
    lines = [
        "name: atscale-pipeline",
        "on:",
        "  pull_request:",
        "  push:",
        "    branches: [main]",
        "env:",
        f"  ENVMGR_URL: ${{{{ vars.ENVMGR_URL }}}}      # {url}",
        "  ENVMGR_TOKEN: ${{ secrets.ENVMGR_TOKEN }}",
        "concurrency: atscale-${{ github.ref }}",
        "jobs:",
    ]
    lines += _gha_job("validate", ["./envmgr validate --path ."])
    pr = 'github.event_name == \'pull_request\''
    main = "github.ref == 'refs/heads/main'"
    lines += _gha_job(f"test-{first}", [
        f"./envmgr deploy --env {first} --branch ${{{{ github.head_ref }}}} --commit ${{{{ github.event.pull_request.head.sha }}}}",
        f"./envmgr test --env {first} --junit results.xml",
    ], cond=pr, needs="validate")
    main_env = envs[0] if len(envs) == 2 else envs[1]
    prev_job = f"deploy-{main_env}"
    lines += _gha_job(prev_job, [
        f"./envmgr deploy --env {main_env} --branch main --commit ${{{{ github.sha }}}}",
        f"./envmgr test --env {main_env} --junit results.xml",
    ], cond=main, needs="validate")
    for i, env in enumerate(envs):
        if i <= envs.index(main_env):
            continue
        final = env == last
        steps = [f"./envmgr deploy --env {env} --branch main --commit ${{{{ github.sha }}}}"]
        if final:
            steps.append(f"./envmgr promote-aggs --from {envs[i - 1]} --to {env} --system-only")
        else:
            steps.append(f"./envmgr test --env {env} --junit results.xml")
        job = f"promote-{env}"
        lines += _gha_job(job, steps, cond=main, needs=prev_job,
                          environment="production" if final and policy.get("approval") else None)
        prev_job = job
    return "\n".join(lines) + "\n"


def jenkins(st: list[dict[str, Any]], policy: dict[str, Any], url: str) -> str:
    envs = [s["env"] for s in st]
    if len(envs) < 2:
        return "// The pipeline needs hosts in at least two groups (for example Dev and Prod)."
    first, last = envs[0], envs[-1]
    main_env = envs[0] if len(envs) == 2 else envs[1]
    out = [
        "pipeline {",
        "  agent any",
        "  environment {",
        f"    ENVMGR_URL   = '{url}'",
        "    ENVMGR_TOKEN = credentials('envmgr-token')",
        "  }",
        "  stages {",
        "    stage('Validate') {",
        "      steps {",
        "        sh 'curl -fsSL \"$ENVMGR_URL/api/pipeline/cli\" -o envmgr && chmod +x envmgr'",
        "        sh './envmgr validate --path .'",
        "      }",
        "    }",
        f"    stage('Test on {ENV_LABEL[first]}') {{",
        "      when { changeRequest() }",
        "      steps {",
        f"        sh \"./envmgr deploy --env {first} --branch ${{CHANGE_BRANCH}} --commit ${{GIT_COMMIT}}\"",
        f"        sh './envmgr test --env {first} --junit results.xml'",
        "      }",
        "    }",
        f"    stage('Deploy {ENV_LABEL[main_env]}') {{",
        "      when { branch 'main' }",
        "      steps {",
        f"        sh \"./envmgr deploy --env {main_env} --branch main --commit ${{GIT_COMMIT}}\"",
        f"        sh './envmgr test --env {main_env} --junit results.xml'",
        "      }",
        "    }",
    ]
    for i, env in enumerate(envs):
        if i <= envs.index(main_env):
            continue
        final = env == last
        out += [f"    stage('Promote to {ENV_LABEL[env]}') {{", "      when { branch 'main' }"]
        if final and policy.get("approval"):
            out.append(f"      input {{ message 'Deploy to {ENV_LABEL[env]}?' }}")
        out += ["      steps {", f"        sh \"./envmgr deploy --env {env} --branch main --commit ${{GIT_COMMIT}}\""]
        out.append(f"        sh './envmgr promote-aggs --from {envs[i - 1]} --to {env} --system-only'" if final
                   else f"        sh './envmgr test --env {env} --junit results.xml'")
        out += ["      }", "    }"]
    out += ["  }", "  post { always { junit allowEmptyResults: true, testResults: 'results.xml' } }", "}"]
    return "\n".join(out) + "\n"


def cli_examples(st: list[dict[str, Any]]) -> list[str]:
    envs = [s["env"] for s in st]
    if len(envs) < 2:
        return ["envmgr validate --path ."]
    main_env = envs[0] if len(envs) == 2 else envs[1]
    return [
        "envmgr validate --path .",
        f"envmgr deploy --env {main_env} --branch main --commit <sha>",
        f"envmgr test --env {main_env} --baseline {envs[-1]} --junit results.xml",
        f"envmgr promote-aggs --from {envs[-2]} --to {envs[-1]} --system-only",
        f'envmgr rollback --model "<model>" --env {envs[-1]}',
    ]


# -- one Board action as a script (Board › Deploy / Test / Rollback › Copy or Download) -----

def _slug(s: str) -> str:
    import re

    return re.sub(r"[^a-z0-9]+", "-", (s or "").lower()).strip("-") or "model"


def action_commands(action: str, p: dict[str, Any], st: list[dict[str, Any]], commit_var: str | None) -> list[list[str]]:
    """The envmgr argv lists for one action. `commit_var` replaces a pinned
    commit with the CI run's own (e.g. ${{ github.sha }}); None keeps it pinned."""
    env, model = p["env"], p.get("model")
    hosts = [a for h in p.get("hosts") or [] for a in ("--host", h)]
    m = ["--model", model] if model else []
    if action in ("deploy", "promote"):
        cmd = ["deploy", "--env", env, "--branch", p.get("branch") or "main"]
        if p.get("commit"):
            cmd += ["--commit", commit_var or p["commit"]]
        out = [cmd + m + hosts]
        envs = [s["env"] for s in st]
        if env == envs[-1] and len(envs) > 1:
            # System aggregates aren't in Git: they follow the deploy into the last stage.
            out.append(["promote-aggs", "--from", envs[-2], "--to", env, "--system-only"] + m)
        return out
    if action == "test":
        return [["test", "--env", env] + m + (["--host", p["hosts"][0]] if p.get("hosts") else []) + ["--junit", "results.xml"]]
    if action == "rollback":
        return [["rollback", "--env", env] + m + hosts]
    raise ValueError(f"Unknown action '{action}'")


def action_script(action: str, p: dict[str, Any], st: list[dict[str, Any]], policy: dict[str, Any], url: str) -> dict[str, str]:
    """{filename, sh, gha, jenkins} for one Board action. The shell script pins
    the commit the Board showed; the CI snippets use the run's own commit."""
    import shlex

    if action not in ("deploy", "promote", "test", "rollback"):
        raise ValueError(f"Unknown action '{action}' - deploy, promote, test or rollback")
    ci_vars = {"${{ github.sha }}", "${GIT_COMMIT}"}

    def q(a: str) -> str:
        return a if a in ci_vars else shlex.quote(a)

    label = {s["env"]: s["label"] for s in st}.get(p["env"], p["env"])
    final = bool(st) and p["env"] == st[-1]["env"]
    approve = final and policy.get("approval") and action in ("deploy", "promote")
    verb = {"deploy": "Deploy to", "promote": "Deploy to", "test": "Test on", "rollback": "Roll back"}[action]
    title = f"{verb} {label}" + (f" · {p['model']}" if p.get("model") else "")
    where = f" ({', '.join(p['hosts'])})" if p.get("hosts") else f" (every {label} host)"
    pinned = action_commands(action, p, st, None)

    sh = [
        "#!/usr/bin/env bash",
        f"# {title}{where} - generated by the AtScale Env Manager Pipeline.",
        "# Needs ENVMGR_TOKEN: an API token from Pipeline > CI setup > API tokens.",
        "# Exit code: 0 pass, 1 fail (e.g. the gate is closed), 2 error.",
    ]
    if p.get("commit"):
        sh.append(f"# Pinned to commit {p['commit']}: the deploy is refused if {p.get('branch') or 'main'} has moved since.")
    sh += [
        "set -euo pipefail",
        'cd "$(dirname "$0")"',
        f'export ENVMGR_URL="${{ENVMGR_URL:-{url}}}"',
        ': "${ENVMGR_TOKEN:?Set ENVMGR_TOKEN to an Env Manager API token}"',
        'if [ ! -x ./envmgr ]; then curl -fsSL "$ENVMGR_URL/api/pipeline/cli" -o envmgr && chmod +x envmgr; fi',
        "",
        *("./envmgr " + " ".join(shlex.quote(a) for a in c) for c in pinned),
        "",
    ]

    job = _slug(f"{action}-{p['env']}-{p.get('model') or ''}")
    gha = [
        "# Paste under `jobs:` in your workflow (and add `needs:` for the job before it).",
        f"  {job}:",
        f"    name: {title}",
        "    runs-on: ubuntu-latest",
    ]
    if approve:
        gha.append("    environment: production    # approval gate: required reviewers")
    gha += ["    env:", "      ENVMGR_URL: ${{ vars.ENVMGR_URL }}" + f"      # {url}", "      ENVMGR_TOKEN: ${{ secrets.ENVMGR_TOKEN }}",
            "    steps:", '      - run: curl -fsSL "$ENVMGR_URL/api/pipeline/cli" -o envmgr && chmod +x envmgr']
    gha += ["      - run: ./envmgr " + " ".join(q(a) for a in c) for c in action_commands(action, p, st, "${{ github.sha }}")]

    def groovy(c: list[str]) -> str:
        return "./envmgr " + " ".join(f'"{a}"' if (" " in a or not a) else a for a in c)

    jk = [
        "// Paste inside `stages { }` of your Jenkinsfile. ENVMGR_TOKEN: the Jenkins credential 'envmgr-token'.",
        f"    stage('{title}') {{",
        "      when { branch 'main' }" if action in ("deploy", "promote") and p.get("commit") else None,
        f"      input {{ message '{title}?' }}" if approve else None,
        "      environment {",
        f"        ENVMGR_URL   = '{url}'",
        "        ENVMGR_TOKEN = credentials('envmgr-token')",
        "      }",
        "      steps {",
        "        sh 'curl -fsSL \"$ENVMGR_URL/api/pipeline/cli\" -o envmgr && chmod +x envmgr'",
        *(f'        sh """{groovy(c)}"""' for c in action_commands(action, p, st, "${GIT_COMMIT}")),
        "      }",
        "    }",
    ]
    return {"filename": f"envmgr-{job}.sh", "title": title, "sh": "\n".join(sh),
            "gha": "\n".join(gha) + "\n", "jenkins": "\n".join(x for x in jk if x is not None) + "\n"}
