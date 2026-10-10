"""A Board action as a ps-utils package: a folder (zip) whose run.sh does the
step with the ps-utils CLI alone - no call to Env Manager, so it runs by hand,
from cron, or from a pipeline that can't reach Env Manager.

  promote   the SML at the commit (git clone of the picked branch - any branch;
            refused when its head isn't the commit the Board showed, the
            tested commit or the picked branch's head, unless COMMIT says another)
            -> atscale-deploy-catalog on each picked host, as the
            <catalog unique_name>_<branch> catalog (the app's own project name,
            atscale/legacy_deploy.py). Into the last stage, then the system
            aggregates: atscale-export-aggregates from the source stage's host
            -> atscale-import-aggregates into each picked host, its catalog /
            model ids looked up with atscale-list-deployments after the deploy.
  rollback  the same deploy of the exact commit the stage ran before
            (git fetch of that commit) - in place, no undeploy.
  test      Validate's own ps-utils package (testing/cli_bundle.py):
            execute-atscale-query-harness on the baseline + the picked host,
            compared by compare.mjs.

Same rules as the Validate / Promote packages: connections.yaml carries every
host with its password left as PLACEHOLDER, and run.sh refuses to start while
one is left. Shapes follow ../src/operations/atscale-* (deploy-catalog,
list-repos, create-repo, list-deployments, export/import-aggregates).

Reporting back is opt-in: with ENVMGR_URL + ENVMGR_TOKEN set, run.sh posts its
verdict and, on failure, the end of its log to POST /api/pipeline/runs, so the
run - and why it failed - shows in Pipeline > Runs.
"""

from __future__ import annotations

import io
import json
import re
import zipfile
from typing import Any

from envs import registry
from promote.cli_bundle import HELPERS_MJS, _conn_rows, _connections_yaml, _fill, _now, _zip
from testing import cli_bundle as tbundle
from testing.cli_bundle import PACKAGE, PLACEHOLDER, _sh_quote

from . import config, stages, steps

ACTIONS = ("promote", "rollback", "test")


def _helpers() -> str:
    """Promote's helpers.mjs plus what the pipeline package needs: the target's
    catalog / model ids after a deploy, and the optional report back."""
    extra = r'''
commands["model-ids"] = ([project, model]) => {
  // atscale-list-deployments: [{repoId, name, projects: [{id, name, caption, models: [{id, name, caption}]}]}]
  const want = (s) => String(s || "").toLowerCase();
  for (const repo of jsonTail(fs.readFileSync(0, "utf8")) || []) {
    for (const p of repo.projects || []) {
      if (want(p.name) !== want(project) && want(p.caption) !== want(project)) continue;
      const m = (p.models || []).find((x) => want(x.caption) === want(model) || want(x.name) === want(model));
      if (m) { console.log(`${p.id} ${m.id}`); return; }
    }
  }
  process.exit(1);
};

commands.report = async ([verdict, logFile]) => {
  // Opt-in: ENVMGR_URL + ENVMGR_TOKEN (an API token, scope any). Never fails the run.
  const url = (process.env.ENVMGR_URL || "").replace(/\/+$/, "");
  const token = process.env.ENVMGR_TOKEN;
  if (!url || !token) return;
  if (process.env.ENVMGR_INSECURE === "1") process.env.NODE_TLS_REJECT_UNAUTHORIZED = "0";
  const plan = JSON.parse(fs.readFileSync(new URL("./pipeline.json", import.meta.url), "utf8"));
  const log = fs.existsSync(logFile) ? fs.readFileSync(logFile, "utf8").trim().split("\n") : [];
  const e = process.env;
  const ci = e.GITHUB_ACTIONS === "true"
    ? { orchestrator: "gha", runRef: `GHA #${e.GITHUB_RUN_NUMBER}`, url: `${e.GITHUB_SERVER_URL}/${e.GITHUB_REPOSITORY}/actions/runs/${e.GITHUB_RUN_ID}` }
    : e.JENKINS_URL ? { orchestrator: "jenkins", runRef: `JNK #${e.BUILD_NUMBER}`, url: e.BUILD_URL }
    : { orchestrator: "cli", runRef: "ps-utils script" };
  const body = { stage: `${plan.title} (ps-utils)`, verdict, model: plan.model, env: plan.env,
    commit: e.COMMIT || plan.commit || null, summary: log.slice(-1)[0] || null,
    error: verdict === "pass" ? null : log.slice(-60).join("\n"), ci };
  try {
    const res = await fetch(`${url}/api/pipeline/runs`, { method: "POST", body: JSON.stringify(body),
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` } });
    console.log(res.ok ? `Reported to ${url}` : `Report to ${url} failed: ${res.status}`);
  } catch (err) {
    console.log(`Report to ${url} failed: ${err.message}`);
  }
};
'''
    marker = "\nif (!commands[cmd])"
    plan = 'JSON.parse(fs.readFileSync(new URL("./promotion.json", import.meta.url), "utf8"))'
    assert marker in HELPERS_MJS and plan in HELPERS_MJS
    # No promotion.json here: pick runs with "all", summary names nothing.
    safe = f'(fs.existsSync(new URL("./promotion.json", import.meta.url)) ? {plan} : {{ models: [] }})'
    return HELPERS_MJS.replace(plan, safe).replace(marker, extra + marker).replace(
        "commands[cmd](args);", "await commands[cmd](args);")


def _folder(action: str, env: str, model: str) -> str:
    return re.sub(r"[^a-z0-9]+", "-", f"{action}-{env}-{model}".lower()).strip("-")


def build(action: str, env: str, model: str, host_ids: list[str] | None, branch: str | None) -> dict[str, Any]:
    """{folder, filename, title, files: {path: text}, sh, gha, jenkins} for one
    Board action. Raises steps.StepError on a bad pick."""
    if action not in ACTIONS:
        raise steps.StepError(f"Unknown action '{action}' - {', '.join(ACTIONS)}")
    hosts, rows, _ = steps.load()
    st = stages.stages(hosts)
    idx, stage = steps._stage(st, env)
    picked = steps._pick_hosts(stage, host_ids)
    policy = config.settings()["policy"]
    final = idx == len(st) - 1
    folder = _folder(action, env, model)
    if action == "test":
        out = _test(st, stage, picked, rows, model, folder)
    else:
        out = _deploy(action, st, idx, picked, rows, model, branch, folder, final)
    approve = final and policy.get("approval") and action == "promote"
    out.update(folder=folder, filename=f"{folder}.zip",
               gha=_gha(out["title"], folder, approve, pinned=bool(out.get("commit")) and action == "promote"),
               jenkins=_jenkins(out["title"], folder, approve, pinned=bool(out.get("commit")) and action == "promote"))
    return out


def zip_bytes(out: dict[str, Any]) -> bytes:
    return _zip(out["folder"], out["files"])


# -- promote / rollback ------------------------------------------------------------------------

def _deploy(action, st, idx, picked, rows, model, branch, folder, final) -> dict[str, Any]:
    stage = st[idx]
    target_cell = stages.cell(stage, rows, model)
    src_cell = stages.cell(st[idx - 1], rows, model) if idx > 0 else None
    exact = 0
    if action == "rollback":
        if not target_cell:
            raise steps.StepError(f"{model} isn't deployed on {stage['label']}")
        prev = registry.backend(target_cell["hostId"]).previous_commit(target_cell["row"])
        if not prev:
            raise steps.StepError(f"No earlier commit is recorded for {model} on {target_cell['hostLabel']} - this app "
                                  "keeps the commits it deployed")
        repo, branch, commit, exact = target_cell["repoUrl"], prev.get("branch") or target_cell["branch"] or "main", prev["commit"], 1
        title = f"Roll back {stage['label']} · {model}"
    else:
        if idx == 0:
            raise steps.StepError(f"{stage['label']} is the first stage - deploy to it from Build or CI")
        kind = stages.gate_kinds(st)[idx - 1]["kind"]
        if not src_cell:
            raise steps.StepError(f"{model} isn't on {st[idx - 1]['label']}")
        repo = src_cell["repoUrl"]
        if kind == "merge":
            branch, commit = branch or (target_cell or {}).get("branch") or "main", ""
        else:
            if branch and branch != src_cell["branch"]:
                # Another branch: pinned to its head now - what the Board's check looked at.
                head = registry.backend(stage["hosts"][0]["id"]).head_commit(repo, branch, model)
                commit = head or ""
            else:
                branch, commit = src_cell["branch"] or "main", src_cell["commit"] or ""
        title = f"Deploy to {stage['label']} · {model}"
    # Commits in the demo are "v14", not SHAs: a script can't pin those.
    if commit and not re.fullmatch(r"[0-9a-fA-F]{7,40}", commit):
        commit = ""
    if action == "rollback" and not commit:
        raise steps.StepError(f"The previous commit of {model} isn't a Git SHA - a script can't fetch it")

    targets = [(h["id"], registry.host(h["id"])) for h in picked["hosts"]]
    source = None
    src_ids = {}
    if action == "promote" and final and src_cell:
        source = (src_cell["hostId"], registry.host(src_cell["hostId"]))
        src_ids = {"catalogId": src_cell["row"].get("catalogId"), "modelId": src_cell["row"].get("modelId")}
    conn = _conn_rows(targets + ([source] if source else []))
    names = [conn[h]["name"] for h, _ in targets]
    plan = {
        "generatedAt": _now().replace(microsecond=0).isoformat(), "action": action, "title": title, "model": model,
        "env": stage["env"], "repoUrl": repo, "branch": branch, "commit": commit or None, "exactCommit": bool(exact),
        "targets": [{k: conn[h][k] for k in ("name", "label", "url", "username")} for h, _ in targets],
        "aggregates": ({"source": conn[source[0]]["name"], **src_ids} if source else None), "models": [],
    }
    subs = {
        "@@TITLE@@": title, "@@REPO@@": repo, "@@BRANCH@@": branch, "@@COMMIT@@": commit, "@@EXACT@@": str(exact),
        "@@TARGETS@@": " ".join(_sh_quote(n) for n in names), "@@SOURCE@@": conn[source[0]]["name"] if source else "",
        "@@SRC_CATALOG@@": src_ids.get("catalogId") or "", "@@SRC_MODEL@@": src_ids.get("modelId") or "",
        "@@MODEL@@": _sh_quote(model),
    }
    files = {
        "run.sh": _fill(DEPLOY_SH, subs),
        "connections.yaml": _connections_yaml(list(conn.values()), f"pipeline step ({title})"),
        "helpers.mjs": _helpers(),
        "pipeline.json": json.dumps(plan, indent=2) + "\n",
        "README.md": _readme(title, stage, plan, folder, bool(source)),
    }
    return {"title": title, "files": files, "sh": files["run.sh"], "commit": commit}


DEPLOY_SH = r"""#!/usr/bin/env bash
# @@TITLE@@ - generated by the AtScale Env Manager Pipeline.
# Runs with the ps-utils CLI only (atscale-deploy-catalog; atscale-export /
# import-aggregates into the last stage). It never calls Env Manager, unless
# ENVMGR_URL + ENVMGR_TOKEN are set: then it reports its verdict to Pipeline > Runs.
#
#   ./run.sh                                  # uses ./connections.yaml
#   CONNECTIONS=~/secure/conn.yaml ./run.sh   # a filled-in copy kept elsewhere
#   COMMIT=<sha> ./run.sh                     # in CI: the run's own commit
#   GIT_TOKEN=<token> ./run.sh                # clone a private repo over HTTPS
#   PS_UTILS="/path/to/atscale-utils" ./run.sh
set -uo pipefail
cd "$(dirname "$0")"

CONN="${CONNECTIONS:-connections.yaml}"
REPO="@@REPO@@"
BRANCH="@@BRANCH@@"
COMMIT="${COMMIT:-@@COMMIT@@}"
EXACT=@@EXACT@@           # 1: deploy exactly COMMIT (a rollback), not the branch head
TARGETS=(@@TARGETS@@)
SOURCE="@@SOURCE@@"       # where system aggregates come from ('' = no aggregates step)
MODEL=@@MODEL@@
if [ -n "${PS_UTILS:-}" ]; then read -r -a PSU <<< "$PS_UTILS"
elif command -v atscale-utils >/dev/null 2>&1; then PSU=(atscale-utils)
else PSU=(npx --yes --package @@PACKAGE@@ atscale-utils); fi
export COMMIT

if [ ! -f "$CONN" ]; then echo "No connections file at $CONN" >&2; exit 2; fi
if grep -qF '@@PLACEHOLDER@@' "$CONN"; then
  echo "Fill in $CONN first - these lines still say @@PLACEHOLDER@@:" >&2
  grep -nF '@@PLACEHOLDER@@' "$CONN" >&2
  exit 2
fi

WORK="$(mktemp -d)"
LOG="$WORK/run.log"
trap 'rm -rf "$WORK"' EXIT
psu() { local c="$1"; shift; "${PSU[@]}" "$@" --connection-file "$CONN" --atscale-connection-name "$c"; }
die() { echo "!! $*"; exit 1; }

# The target's id for the repo, attaching the repo when the host doesn't have it.
repo_id() {
  local id
  if id=$(psu "$1" atscale-list-repos | node helpers.mjs repo-id "$REPO"); then echo "$id"; return 0; fi
  echo "   attaching $REPO on $1" >&2
  psu "$1" atscale-create-repo --name "$(node helpers.mjs repo-name "$REPO")" --url "$REPO" --type catalog \
    --default-branch "$BRANCH" >/dev/null || return 1
  psu "$1" atscale-list-repos | node helpers.mjs repo-id "$REPO"
}

# System aggregates (runtime state, not Git) from SOURCE into one target.
aggs() {
  local f="$WORK/aggs-$1" ids rc=0
  psu "$SOURCE" atscale-export-aggregates --catalog-id "@@SRC_CATALOG@@" --model-id "@@SRC_MODEL@@" \
    --output-file "$f.export.json" >/dev/null || return 1
  node helpers.mjs pick "$f.export.json" "$f.import.json" - 1 || rc=$?
  [ $rc -eq 4 ] && { echo "   no system aggregates to move"; return 0; }
  ids=$(psu "$1" atscale-list-deployments | node helpers.mjs model-ids "$PROJECT" "$MODEL") \
    || { echo "!! $MODEL isn't deployed as $PROJECT on $1"; return 1; }
  read -r cat_id model_id <<< "$ids"
  psu "$1" atscale-import-aggregates --input-file "$f.import.json" --catalog-id "$cat_id" --model-id "$model_id" \
    --source-atscale-connection-name "$SOURCE" > "$f.result.json" || return 1
  node helpers.mjs summary "$f.result.json" -
}

main() {
  local url="$REPO" sml="$WORK/sml" head failed=0 id
  if [ -n "${GIT_TOKEN:-}" ] && [[ "$url" == https://* ]]; then url="https://x-access-token:${GIT_TOKEN}@${url#https://}"; fi
  if [ "$EXACT" = 1 ]; then
    echo "== SML at $COMMIT"
    { git init -q "$sml" && git -C "$sml" fetch -q --depth 1 "$url" "$COMMIT" && git -C "$sml" checkout -q FETCH_HEAD; } \
      || die "couldn't fetch commit $COMMIT of $REPO"
  else
    echo "== SML at $BRANCH${COMMIT:+ ($COMMIT)}"
    git clone -q --depth 1 --branch "$BRANCH" "$url" "$sml" || die "couldn't clone $REPO ($BRANCH)"
    head=$(git -C "$sml" rev-parse HEAD)
    if [ -n "$COMMIT" ]; then
      case "$head" in "$COMMIT"*) ;; *) die "$BRANCH has moved: its head is ${head:0:7}, not ${COMMIT:0:7}. AtScale deploys a branch head - rerun the pipeline for the new head, or COMMIT=${head:0:7} to deploy it.";; esac
    fi
  fi
  rm -rf "$sml/.git" "$sml/.github"   # the deploy reads every .yml under the folder
  PROJECT=$(node helpers.mjs project-name "$sml" "$BRANCH") || die "no catalog.yml in $REPO"

  for T in "${TARGETS[@]}"; do
    echo "== deploy $PROJECT → $T"
    id=$(repo_id "$T") || { echo "!! $T: couldn't attach $REPO"; failed=1; continue; }
    psu "$T" atscale-deploy-catalog --sml-dir "$sml" --repo-id "$id" --project-name "$PROJECT" \
      || { echo "!! $T: atscale-deploy-catalog failed"; failed=1; continue; }
    if [ -n "$SOURCE" ]; then
      echo "== system aggregates $SOURCE → $T"
      aggs "$T" || { echo "!! $T: aggregates failed"; failed=1; }
    fi
  done
  echo
  if [ $failed -eq 0 ]; then echo "PASS"; else echo "FAIL"; fi
  return $failed
}

main 2>&1 | tee "$LOG"
rc=${PIPESTATUS[0]}
node helpers.mjs report "$([ "$rc" -eq 0 ] && echo pass || echo fail)" "$LOG" || true
exit "$rc"
""".replace("@@PACKAGE@@", PACKAGE).replace("@@PLACEHOLDER@@", PLACEHOLDER)


def _readme(title: str, stage: dict[str, Any], plan: dict[str, Any], folder: str, aggs: bool) -> str:
    hosts = "\n".join(f"| {t['label']} | `{t['url']}` | `{t['username'] or '-'}` |" for t in plan["targets"])
    what = (f"Redeploys commit `{plan['commit']}` of `{plan['repoUrl']}` - the one {stage['label']} ran before - as the "
            f"`<catalog>_{plan['branch']}` catalog, in place. It does **not** undeploy anything."
            if plan["exactCommit"] else
            f"Clones `{plan['repoUrl']}` at `{plan['branch']}`"
            + (f", checks its head is still `{plan['commit']}` (the commit the Board showed - set `COMMIT` to deploy another)"
               if plan["commit"] else "")
            + f", and deploys it as the `<catalog>_{plan['branch']}` catalog with `atscale-deploy-catalog`.")
    return f"""# {title}

Generated by the AtScale Env Manager Pipeline. Runs with the **ps-utils CLI only** - no call
to Env Manager - so you can run it by hand, from cron, or from a CI job.

{what} A deploy takes the repo's whole catalog: every model in it moves to the same commit.
{"After each deploy it moves the system aggregates from the stage before (`atscale-export-aggregates` → `atscale-import-aggregates`, ids looked up with `atscale-list-deployments`); duplicates are skipped by the import." if aggs else ""}

| {stage['label']} host | URL | User |
|---|---|---|
{hosts}

## Run it

1. Fill in each `{PLACEHOLDER}` in `connections.yaml` (the deploy signs in with a Keycloak
   password; an SSO-only account can't deploy). Keep the filled-in file out of Git.
2. `./run.sh` - exits 0 when every host succeeded, 1 otherwise.

Needs Node.js 20+, git, and ps-utils (`atscale-utils` on the PATH, else `npx {PACKAGE}`).

| Variable | |
|---|---|
| `CONNECTIONS` | a filled-in connections file kept elsewhere |
| `COMMIT` | deploy this commit (in CI: the run's own); default `{plan['commit'] or 'the branch head'}` |
| `GIT_TOKEN` | clone a private repository over HTTPS |
| `ENVMGR_URL` + `ENVMGR_TOKEN` | optional: report the verdict - and the end of the log on failure - to Pipeline › Runs |

## In a pipeline

Commit this folder to the repository as `atscale/{folder}/`, store the filled-in
`connections.yaml` as a secret, and paste the job from the Board's GitHub Actions / Jenkins tab.
"""


# -- test --------------------------------------------------------------------------------------

def _test(st, stage, picked, rows, model, folder) -> dict[str, Any]:
    """Validate's own package: the baseline (the last stage's primary host, or
    none when testing the last stage) and the picked host."""
    cand = stages.cell(picked, rows, model)
    if not cand:
        raise steps.StepError(f"{model} isn't deployed on {picked['hosts'][0]['label']}")
    base = stages.cell(st[-1], rows, model) if st[-1]["env"] != stage["env"] else None
    cand_t, queries = steps._queries(cand["hostId"], cand["row"])
    targets = [cand_t]
    if base:
        base_t, _ = steps._queries(base["hostId"], base["row"])
        targets = [base_t, cand_t]
    raws = {t["hostId"]: registry.host(t["hostId"]) for t in targets}
    _, data = tbundle.build(targets, raws, queries, ["mdx"], 2, dict(tbundle.DEFAULT_OPTS), True)
    files = {}
    with zipfile.ZipFile(io.BytesIO(data)) as z:
        for n in z.namelist():
            files[n.split("/", 1)[1]] = z.read(n).decode()
    title = f"Test on {stage['label']} · {model}"
    return {"title": title, "files": files, "sh": files["run.sh"], "commit": ""}


# -- CI snippets -------------------------------------------------------------------------------

def _gha(title: str, folder: str, approve: bool, pinned: bool) -> str:
    lines = [
        f"# Commit the package as atscale/{folder}/ and store its filled-in connections.yaml",
        "# as the secret ATSCALE_CONNECTIONS. Paste under `jobs:` (add `needs:` for the job before it).",
        f"  {folder}:",
        f"    name: {title}",
        "    runs-on: ubuntu-latest",
    ]
    if approve:
        lines.append("    environment: production    # approval gate: required reviewers")
    lines += [
        "    steps:",
        "      - uses: actions/checkout@v4",
        "      - uses: actions/setup-node@v4",
        "        with:",
        "          node-version: 20",
        f"      - name: {title} (ps-utils)",
        "        env:",
        "          ATSCALE_CONNECTIONS: ${{ secrets.ATSCALE_CONNECTIONS }}",
        "          GIT_TOKEN: ${{ secrets.GITHUB_TOKEN }}",
    ]
    if pinned:
        lines.append("          COMMIT: ${{ github.sha }}")
    lines += [
        "        run: |",
        '          printf \'%s\\n\' "$ATSCALE_CONNECTIONS" > "$RUNNER_TEMP/connections.yaml"',
        f'          CONNECTIONS="$RUNNER_TEMP/connections.yaml" ./atscale/{folder}/run.sh',
    ]
    return "\n".join(lines) + "\n"


def _jenkins(title: str, folder: str, approve: bool, pinned: bool) -> str:
    lines = [
        f"// Commit the package as atscale/{folder}/. Credentials: the filled-in connections.yaml as the",
        "// secret file 'atscale-connections', a Git token as the secret text 'git-token'. Paste inside `stages { }`.",
        f"    stage('{title}') {{",
    ]
    if approve:
        lines.append(f"      input {{ message '{title}?' }}")
    lines += [
        "      steps {",
        "        withCredentials([file(credentialsId: 'atscale-connections', variable: 'CONNECTIONS'),",
        "                         string(credentialsId: 'git-token', variable: 'GIT_TOKEN')]) {",
        f"          sh '{'COMMIT=$GIT_COMMIT ' if pinned else ''}./atscale/{folder}/run.sh'",
        "        }",
        "      }",
        "    }",
    ]
    return "\n".join(lines) + "\n"
