"""A staged promotion as a zip the user runs by hand with the ps-utils CLI.

Promote can run the staged models / aggregates here, or hand them over as a
repeatable CLI job (Validate's "Download CLI script", testing/cli_bundle.py, is
the same idea for query runs). Nothing runs in the app.

Models - per staged (repo, branch), like routes/promote.py :: promote_models:
  - the target's repo id from `atscale-list-repos`, attaching the repo first
    with `atscale-create-repo` when the target doesn't have it (_ensure_repo)
  - `git clone --branch <branch>` with the user's own Git access, then
    `atscale-deploy-catalog --repo-id --project-name <catalog unique_name>_<branch>`:
    the same Design Center deploy (/wapi/git/deploy/catalog) and project name
    as atscale/legacy_deploy.py :: deploy
  - "Link only" stops after the repo step
  - "Undeploy <old branch> afterwards" has no CLI operation: listed in the README

Aggregates - per source model, like promote_aggregates:
  - `atscale-export-aggregates` from the source catalog / model
  - helpers.mjs keeps only the staged definitions (promotion.json picks them,
    ALL_AGGREGATES=1 keeps the whole export)
  - `atscale-import-aggregates` into the target catalog / model, which remaps
    ids by name and applies the same duplicate / reactivate rules

Catalog, model and repo ids are the hosts' current ones (promotion.json), so a
redeploy under a new catalog id means generating the zip again. No secret goes
into the zip: connections.yaml has every host and user, with each password left
as PLACEHOLDER, and run.sh / run.ps1 refuse to start while one is left.
"""

from __future__ import annotations

import io
import json
import zipfile
from datetime import datetime, timezone
from typing import Any

from testing.cli_bundle import PACKAGE, PLACEHOLDER, _hostname, _ps_quote, _sh_quote, _yaml_str, slug


def _conn_rows(hosts: list[tuple[str, dict[str, Any]]]) -> dict[str, dict[str, Any]]:
    """host id -> {name, label, env, url, username, insecure}; names unique and file-safe."""
    out: dict[str, dict[str, Any]] = {}
    for host_id, raw in hosts:
        if host_id in out:
            continue  # a model override can promote within one host
        base = slug(raw.get("label") or host_id)
        name, n = base, 2
        while name in {r["name"] for r in out.values()}:
            name, n = f"{base}_{n}", n + 1
        a = raw.get("atscale") or {}
        out[host_id] = {"name": name, "label": raw.get("label") or host_id, "env": raw.get("env"),
                        "url": f"https://{_hostname(raw)}", "username": a.get("username") or "",
                        "insecure": bool(a.get("insecure", True))}
    return out


def _connections_yaml(rows: list[dict[str, Any]], why: str) -> str:
    out = [
        f"# ps-utils connections for this {why}.",
        # The placeholder itself must not appear in a comment: run.sh greps for it.
        "# Fill in each user's password below - run.sh won't start while one is left blank.",
        "# This file then holds secrets: keep it out of Git and share the zip, not this file.",
        "",
        "users:",
    ]
    for r in rows:
        out += [f"  u_{r['name']}:", f"    username: {_yaml_str(r['username'] or PLACEHOLDER)}",
                f"    password: {_yaml_str(PLACEHOLDER)}"]
    out += ["", "connections:"]
    for r in rows:
        out += [
            f"  # {r['label']} ({(r['env'] or '').upper()})",
            f"  {r['name']}:",
            "    atscale:",
            f"      url: {r['url']}",
            f"      user: u_{r['name']}",
            f"      insecure: {'true' if r['insecure'] else 'false'}",
        ]
    return "\n".join(out) + "\n"


def _zip(root: str, files: dict[str, str]) -> bytes:
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w", zipfile.ZIP_DEFLATED) as z:
        for path, body in files.items():
            info = zipfile.ZipInfo(f"{root}/{path}", date_time=datetime.now().timetuple()[:6])
            info.compress_type = zipfile.ZIP_DEFLATED
            info.external_attr = (0o755 if path == "run.sh" else 0o644) << 16
            z.writestr(info, body)
    return buf.getvalue()


def _fill(template: str, subs: dict[str, str]) -> str:
    for k, v in {"@@PACKAGE@@": PACKAGE, "@@PLACEHOLDER@@": PLACEHOLDER, **subs}.items():
        template = template.replace(k, v)
    return template


def _now() -> datetime:
    return datetime.now(timezone.utc)


# -- models -----------------------------------------------------------------------------

def build_models(source: tuple[str, dict[str, Any]], target: tuple[str, dict[str, Any]],
                 steps: list[dict[str, Any]], replace: list[dict[str, Any]]) -> tuple[str, bytes]:
    """(file name, zip bytes). `steps`: [{mode: deploy|link, repoUrl, branch, models: [names]}]
    in run order; `replace`: [{model, branch, catalogs: [names]}] the app would undeploy."""
    conns = _conn_rows([target])
    tgt = conns[target[0]]
    stamp = _now().strftime("%Y%m%d-%H%M")
    root = f"promote-models-{slug(tgt['label'])}-{stamp}"

    def label(s: dict[str, Any]) -> str:
        return ", ".join(s["models"])

    sh_steps = "\n".join(
        f"step {s['mode']} {i} {_sh_quote(s['repoUrl'])} {_sh_quote(s['branch'])} {_sh_quote(label(s))}"
        for i, s in enumerate(steps, 1))
    ps_steps = ",\n".join(
        f"  @{{ Mode = \"{s['mode']}\"; Url = {_ps_quote(s['repoUrl'])}; Branch = {_ps_quote(s['branch'])}; "
        f"Label = {_ps_quote(label(s))} }}" for s in steps)
    subs = {"@@TARGET@@": tgt["name"], "@@TARGETLABEL@@": tgt["label"], "@@STEPS@@": sh_steps, "@@PSSTEPS@@": ps_steps}
    manifest = {
        "generatedAt": _now().replace(microsecond=0).isoformat(),
        "kind": "models",
        "source": {"label": source[1].get("label") or source[0], "env": source[1].get("env")},
        "target": {k: tgt[k] for k in ("name", "label", "env", "url", "username")},
        "steps": steps,
        "notApplied": {"undeployOldBranch": replace},
    }
    files = {
        "connections.yaml": _connections_yaml([tgt], "model promotion"),
        "run.sh": _fill(MODELS_SH, subs),
        "run.ps1": _fill(MODELS_PS1, subs),
        "helpers.mjs": HELPERS_MJS,
        "promotion.json": json.dumps(manifest, indent=2) + "\n",
        "README.md": _models_readme(source[1].get("label") or source[0], tgt, steps, replace),
    }
    return f"{root}.zip", _zip(root, files)


def _models_readme(src_label: str, tgt: dict[str, Any], steps: list[dict[str, Any]], replace: list[dict[str, Any]]) -> str:
    rows = "\n".join(f"| {', '.join(s['models'])} | `{s['repoUrl']}` | `{s['branch']}` | "
                     f"{'Link & deploy' if s['mode'] == 'deploy' else 'Link only'} |" for s in steps)
    note = ""
    if replace:
        items = "\n".join(f"- {r['model']}: {', '.join(f'`{c}`' for c in r['catalogs'])} (now on `{r['branch']}`)"
                          for r in replace)
        note = ("\n## Not done by the script: undeploy the old branch\n\n"
                "You picked **Undeploy `<old branch>` afterwards**. ps-utils has no undeploy operation, so the script "
                "deploys the new branch alongside the old one. Once the new deploy works, undeploy these catalogs on "
                f"{tgt['label']} (Env Manager › Manage › Models, or Design Center):\n\n{items}\n")
    return _fill(MODELS_README, {"@@SRC@@": src_label, "@@TGT@@": tgt["label"], "@@TARGET@@": tgt["name"],
                                 "@@ROWS@@": rows, "@@NOTE@@": note, "@@N@@": str(sum(len(s["models"]) for s in steps))})


MODELS_SH = r"""#!/usr/bin/env bash
# Model promotion to @@TARGETLABEL@@, generated by the AtScale Env Manager.
# Clones each staged repo at its branch and deploys it to the target host with
# ps-utils atscale-deploy-catalog ("link" only attaches the repo).
#
#   ./run.sh                                  # uses ./connections.yaml
#   CONNECTIONS=~/secure/conn.yaml ./run.sh   # a filled-in copy kept elsewhere
#   PS_UTILS="/path/to/atscale-utils" ./run.sh
set -uo pipefail
cd "$(dirname "$0")"

CONN="${CONNECTIONS:-connections.yaml}"
TARGET="@@TARGET@@"
if [ -n "${PS_UTILS:-}" ]; then read -r -a PSU <<< "$PS_UTILS"
elif command -v atscale-utils >/dev/null 2>&1; then PSU=(atscale-utils)
else PSU=(npx --yes --package @@PACKAGE@@ atscale-utils); fi

if [ ! -f "$CONN" ]; then echo "No connections file at $CONN" >&2; exit 2; fi
if grep -qF '@@PLACEHOLDER@@' "$CONN"; then
  echo "Fill in $CONN first - these lines still say @@PLACEHOLDER@@:" >&2
  grep -nF '@@PLACEHOLDER@@' "$CONN" >&2
  exit 2
fi

WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT
psu() { "${PSU[@]}" "$@" --connection-file "$CONN" --atscale-connection-name "$TARGET"; }

# The target's id for repo $1, attaching it (default branch $2) when it's missing.
repo_id() {
  local id
  if id=$(psu atscale-list-repos | node helpers.mjs repo-id "$1"); then echo "$id"; return 0; fi
  echo "   attaching $1" >&2
  psu atscale-create-repo --name "$(node helpers.mjs repo-name "$1")" --url "$1" --type catalog \
    --default-branch "$2" >/dev/null || return 1
  psu atscale-list-repos | node helpers.mjs repo-id "$1"
}

link() {  # <n> <repo url> <branch> <models>
  echo "== $4: link $2 ($3)"
  repo_id "$2" "$3" >/dev/null
}

deploy() {  # <n> <repo url> <branch> <models>
  echo "== $4: deploy $2 ($3)"
  local id dir name
  id=$(repo_id "$2" "$3") || return 1
  dir="$WORK/$1"
  git clone --quiet --depth 1 --branch "$3" "$2" "$dir" || return 1
  rm -rf "$dir/.git" "$dir/.github"  # the deploy reads every .yml under the folder
  name=$(node helpers.mjs project-name "$dir" "$3") || return 1
  psu atscale-deploy-catalog --sml-dir "$dir" --repo-id "$id" --project-name "$name"
}

failed=0
step() { "$@" || { echo "!! $5: failed" >&2; failed=1; }; }
@@STEPS@@

echo
if [ $failed -eq 0 ]; then echo "PASS"; else echo "FAIL"; fi
exit $failed
"""

MODELS_PS1 = r"""# Model promotion to @@TARGETLABEL@@, generated by the AtScale Env Manager (PowerShell).
# Same as run.sh: clones each staged repo at its branch and deploys it to the
# target host with ps-utils atscale-deploy-catalog ("link" only attaches the repo).
#
#   ./run.ps1
#   $env:CONNECTIONS = "C:\secure\conn.yaml"; ./run.ps1
#   $env:PS_UTILS = "C:\path\to\atscale-utils"; ./run.ps1
$ErrorActionPreference = "Continue"
Set-Location $PSScriptRoot

$Conn = if ($env:CONNECTIONS) { $env:CONNECTIONS } else { "connections.yaml" }
$Target = "@@TARGET@@"
$Psu = if ($env:PS_UTILS) { $env:PS_UTILS -split " " }
  elseif (Get-Command atscale-utils -ErrorAction SilentlyContinue) { @("atscale-utils") }
  else { @("npx", "--yes", "--package", "@@PACKAGE@@", "atscale-utils") }

if (-not (Test-Path $Conn)) { Write-Error "No connections file at $Conn"; exit 2 }
$left = Select-String -Path $Conn -SimpleMatch "@@PLACEHOLDER@@"
if ($left) {
  Write-Host "Fill in $Conn first - these lines still say @@PLACEHOLDER@@:"
  $left | ForEach-Object { Write-Host "  line $($_.LineNumber): $($_.Line.Trim())" }
  exit 2
}

$Steps = @(
@@PSSTEPS@@
)

$Work = Join-Path ([System.IO.Path]::GetTempPath()) ("promote-" + [guid]::NewGuid())
New-Item -ItemType Directory -Force -Path $Work | Out-Null
$cmd = $Psu[0]; $pre = @($Psu | Select-Object -Skip 1)
function Psu { & $cmd @pre @args --connection-file $Conn --atscale-connection-name $Target }

function Get-RepoId($Url, $Branch) {
  $id = Psu atscale-list-repos | node helpers.mjs repo-id $Url
  if ($LASTEXITCODE -eq 0) { return $id }
  Write-Host "   attaching $Url"
  Psu atscale-create-repo --name (node helpers.mjs repo-name $Url) --url $Url --type catalog --default-branch $Branch | Out-Null
  if ($LASTEXITCODE -ne 0) { return $null }
  $id = Psu atscale-list-repos | node helpers.mjs repo-id $Url
  if ($LASTEXITCODE -eq 0) { return $id } else { return $null }
}

$failed = 0
$n = 0
try {
  foreach ($s in $Steps) {
    $n++
    Write-Host "== $($s.Label): $($s.Mode) $($s.Url) ($($s.Branch))"
    $id = Get-RepoId $s.Url $s.Branch
    if (-not $id) { Write-Warning "$($s.Label): failed"; $failed = 1; continue }
    if ($s.Mode -eq "link") { continue }
    $dir = Join-Path $Work $n
    git clone --quiet --depth 1 --branch $s.Branch $s.Url $dir
    if ($LASTEXITCODE -ne 0) { Write-Warning "$($s.Label): failed"; $failed = 1; continue }
    # The deploy reads every .yml under the folder.
    Remove-Item -Recurse -Force -ErrorAction SilentlyContinue (Join-Path $dir ".git"), (Join-Path $dir ".github")
    $name = node helpers.mjs project-name $dir $s.Branch
    if ($LASTEXITCODE -ne 0) { Write-Warning "$($s.Label): failed"; $failed = 1; continue }
    Psu atscale-deploy-catalog --sml-dir $dir --repo-id $id --project-name $name
    if ($LASTEXITCODE -ne 0) { Write-Warning "$($s.Label): failed"; $failed = 1 }
  }
} finally {
  Remove-Item -Recurse -Force -ErrorAction SilentlyContinue $Work
}

Write-Host ""
if ($failed -eq 0) { Write-Host "PASS" } else { Write-Host "FAIL" }
exit $failed
"""

MODELS_README = """# Promote @@N@@ model(s) to @@TGT@@

Generated by the AtScale Env Manager from Promote › Models (source: @@SRC@@). Instead of
promoting in the app, this deploys the staged models to **@@TGT@@** with the ps-utils CLI,
so you can run it by hand, on a schedule or in CI.

| Models | Repository | Branch | Action |
|---|---|---|---|
@@ROWS@@

For each row, `run.sh`:

1. Looks up the repository on @@TGT@@ (`atscale-list-repos`) and attaches it if it's
   missing (`atscale-create-repo`). **Link only** stops here.
2. Clones the branch with your own Git access (`git clone --depth 1 --branch <branch>`).
3. Deploys it with `atscale-deploy-catalog`, as the catalog `<catalog unique_name>_<branch>`.
   Deploying the same branch again updates that catalog in place.

Models from the same repository and branch deploy together, since a deploy is per catalog.

## Requirements

- Node.js 20+, and `git` with read access to the repositories above.
- ps-utils (`@@PACKAGE@@`). `run.sh` uses `atscale-utils` if it's on your PATH, otherwise `npx`.
  To use another copy, set `PS_UTILS`, for example `PS_UTILS="/path/to/ps-utils/atscale-utils"`.
- The AtScale password (Keycloak) of the target host's user. The deploy signs in with it, so
  an API token alone isn't enough, and accounts that only sign in through SSO can't be used.

## 1. Fill in connections.yaml

`connections.yaml` already has the target host and its user. Only the password is left:
replace `@@PLACEHOLDER@@` with it. The run scripts won't start while a `@@PLACEHOLDER@@` is left.

Once filled in, the file holds a secret, so keep it out of Git. To keep it somewhere safer,
point the scripts at it with `CONNECTIONS=/path/to/connections.yaml`.

## 2. Run it

```bash
./run.sh
```

On Windows, run `./run.ps1` from PowerShell instead. Both exit with 0 when every row
succeeded and with 1 otherwise, so they can gate a CI job.

## How this differs from Promote in the app

- The app deploys through AtScale's Container API (`POST /v1/catalogs/deploy`) where the host
  has it. `atscale-deploy-catalog` always uses the Design Center deploy
  (`/wapi/git/deploy/catalog`) with SML read from the clone - what the app itself does on
  AtScale builds without the Container API. The catalog name is the same either way.
- Shared-dimension packages (`package.yml`) aren't resolved by `atscale-deploy-catalog`. A
  model that imports one needs the app, or the package's files copied into the clone.
- The app records the deployed commit for its version column. After a CLI deploy, refresh
  the host in the app to see it.

## Files

- `connections.yaml`: the target host. You fill in the password.
- `promotion.json`: what was staged (models, repositories, branches) and when.
- `helpers.mjs`: small lookups the scripts use (repository id, catalog name). Node.js only.

To deploy one model by hand:

```bash
git clone --depth 1 --branch <branch> <repo url> sml
atscale-utils atscale-list-repos --connection-file connections.yaml --atscale-connection-name @@TARGET@@
atscale-utils atscale-deploy-catalog --connection-file connections.yaml --atscale-connection-name @@TARGET@@ \\
  --sml-dir sml --repo-id <id from atscale-list-repos> --project-name <catalog unique_name>_<branch>
```
@@NOTE@@"""


# -- aggregates -------------------------------------------------------------------------

def build_aggregates(source: tuple[str, dict[str, Any]], target: tuple[str, dict[str, Any]],
                     groups: list[dict[str, Any]], model_map: dict[str, str]) -> tuple[str, bytes]:
    """(file name, zip bytes). `groups`: one per source model, in run order -
    {source: {name, catalogId, modelId}, target: {name, catalogId, modelId},
     aggregates: [{id, name, state}]}."""
    conns = _conn_rows([source, target])
    src, tgt = conns[source[0]], conns[target[0]]
    stamp = _now().strftime("%Y%m%d-%H%M")
    root = f"promote-aggregates-{slug(tgt['label'])}-{stamp}"
    stems: list[str] = []
    for g in groups:
        base = slug(g["source"]["name"])
        stem, n = base, 2
        while stem in stems:
            stem, n = f"{base}_{n}", n + 1
        stems.append(stem)
        g["file"] = stem

    def q(g: dict[str, Any]) -> list[str]:
        return [g["source"]["name"], g["source"]["catalogId"], g["source"]["modelId"],
                g["target"]["catalogId"], g["target"]["modelId"], g["file"]]

    sh_steps = "\n".join("step " + " ".join(_sh_quote(v) for v in q(g)) for g in groups)
    ps_steps = ",\n".join(
        "  @{ " + "; ".join(f"{k} = {_ps_quote(v)}" for k, v in zip(("Model", "SrcCatalog", "SrcModel", "TgtCatalog", "TgtModel", "File"), q(g))) + " }"
        for g in groups)
    subs = {"@@SOURCE@@": src["name"], "@@TARGET@@": tgt["name"], "@@TARGETLABEL@@": tgt["label"],
            "@@STEPS@@": sh_steps, "@@PSSTEPS@@": ps_steps}
    manifest = {
        "generatedAt": _now().replace(microsecond=0).isoformat(),
        "kind": "aggregates",
        "source": {k: src[k] for k in ("name", "label", "env", "url", "username")},
        "target": {k: tgt[k] for k in ("name", "label", "env", "url", "username")},
        "modelMap": model_map,
        "models": [{"file": g["file"], "source": g["source"], "target": g["target"], "aggregates": g["aggregates"]}
                   for g in groups],
    }
    rows = [src] if src is tgt else [src, tgt]
    files = {
        "connections.yaml": _connections_yaml(rows, "aggregate promotion"),
        "run.sh": _fill(AGGS_SH, subs),
        "run.ps1": _fill(AGGS_PS1, subs),
        "helpers.mjs": HELPERS_MJS,
        "promotion.json": json.dumps(manifest, indent=2) + "\n",
        "README.md": _aggs_readme(src, tgt, groups, model_map),
    }
    return f"{root}.zip", _zip(root, files)


def _aggs_readme(src: dict[str, Any], tgt: dict[str, Any], groups: list[dict[str, Any]], model_map: dict[str, str]) -> str:
    rows = "\n".join(f"| {g['source']['name']} | {g['target']['name']} | {len(g['aggregates'])} |" for g in groups)
    note = ""
    if model_map:
        pairs = ", ".join(f"{k} → {v}" for k, v in model_map.items())
        note = ("\n## Target-model override\n\nThese aggregates go into a differently named model (" + pairs + "). "
                "`atscale-import-aggregates` substitutes the catalog, model and object ids, but not the model "
                "*name*: where the export names the source model, the import may be refused. If it is, promote "
                "these from the app, which also substitutes the name.\n")
    hosts = f"**{src['label']}** to **{tgt['label']}**" if src is not tgt else f"between two models on **{src['label']}**"
    return _fill(AGGS_README, {"@@HOSTS@@": hosts, "@@SRC@@": src["label"], "@@TGT@@": tgt["label"],
                               "@@SOURCE@@": src["name"], "@@TARGET@@": tgt["name"], "@@ROWS@@": rows, "@@NOTE@@": note,
                               "@@N@@": str(sum(len(g["aggregates"]) for g in groups))})


AGGS_SH = r"""#!/usr/bin/env bash
# Aggregate promotion to @@TARGETLABEL@@, generated by the AtScale Env Manager.
# For each model: export its system aggregates from the source, keep the staged
# ones (promotion.json), import them into the target - ps-utils
# atscale-export-aggregates / atscale-import-aggregates.
#
#   ./run.sh                                  # uses ./connections.yaml
#   CONNECTIONS=~/secure/conn.yaml ./run.sh   # a filled-in copy kept elsewhere
#   ALL_AGGREGATES=1 ./run.sh                 # every exportable aggregate, not only the staged ones
#   RUN_ID=nightly-42 ./run.sh                # label the run (default: a timestamp)
#   PS_UTILS="/path/to/atscale-utils" ./run.sh
set -uo pipefail
cd "$(dirname "$0")"

CONN="${CONNECTIONS:-connections.yaml}"
SOURCE="@@SOURCE@@"
TARGET="@@TARGET@@"
RUN_ID="${RUN_ID:-$(date +%Y-%m-%d-%H%M%S)}"
OUT="run_results/$RUN_ID"
if [ -n "${PS_UTILS:-}" ]; then read -r -a PSU <<< "$PS_UTILS"
elif command -v atscale-utils >/dev/null 2>&1; then PSU=(atscale-utils)
else PSU=(npx --yes --package @@PACKAGE@@ atscale-utils); fi

if [ ! -f "$CONN" ]; then echo "No connections file at $CONN" >&2; exit 2; fi
if grep -qF '@@PLACEHOLDER@@' "$CONN"; then
  echo "Fill in $CONN first - these lines still say @@PLACEHOLDER@@:" >&2
  grep -nF '@@PLACEHOLDER@@' "$CONN" >&2
  exit 2
fi
mkdir -p "$OUT"

promote() {  # <source model> <src catalog> <src model> <tgt catalog> <tgt model> <file>
  echo "== $1"
  local f="$OUT/$6" rc=0
  "${PSU[@]}" atscale-export-aggregates --connection-file "$CONN" --atscale-connection-name "$SOURCE" \
    --catalog-id "$2" --model-id "$3" --output-file "$f.export.json" >/dev/null || return 1
  node helpers.mjs pick "$f.export.json" "$f.import.json" "$6" "${ALL_AGGREGATES:-}" || rc=$?
  [ $rc -eq 4 ] && return 1  # none of the staged ones were exported
  "${PSU[@]}" atscale-import-aggregates --connection-file "$CONN" --atscale-connection-name "$TARGET" \
    --input-file "$f.import.json" --catalog-id "$4" --model-id "$5" \
    --source-atscale-connection-name "$SOURCE" > "$f.result.json" || return 1
  node helpers.mjs summary "$f.result.json" "$6" || return 1
  return $rc
}

failed=0
step() { promote "$@" || { echo "!! $1: failed or incomplete" >&2; failed=1; }; }
@@STEPS@@

echo
echo "Results: $OUT"
if [ $failed -eq 0 ]; then echo "PASS"; else echo "FAIL"; fi
exit $failed
"""

AGGS_PS1 = r"""# Aggregate promotion to @@TARGETLABEL@@, generated by the AtScale Env Manager (PowerShell).
# Same as run.sh: for each model, export from the source, keep the staged
# aggregates (promotion.json), import them into the target.
#
#   ./run.ps1
#   $env:CONNECTIONS = "C:\secure\conn.yaml"; ./run.ps1
#   $env:ALL_AGGREGATES = "1"; ./run.ps1     # every exportable aggregate
#   $env:RUN_ID = "nightly-42"; ./run.ps1
#   $env:PS_UTILS = "C:\path\to\atscale-utils"; ./run.ps1
$ErrorActionPreference = "Continue"
Set-Location $PSScriptRoot

$Conn = if ($env:CONNECTIONS) { $env:CONNECTIONS } else { "connections.yaml" }
$Source = "@@SOURCE@@"
$Target = "@@TARGET@@"
$RunId = if ($env:RUN_ID) { $env:RUN_ID } else { Get-Date -Format "yyyy-MM-dd-HHmmss" }
$Out = "run_results/$RunId"
$All = if ($env:ALL_AGGREGATES) { $env:ALL_AGGREGATES } else { "" }
$Psu = if ($env:PS_UTILS) { $env:PS_UTILS -split " " }
  elseif (Get-Command atscale-utils -ErrorAction SilentlyContinue) { @("atscale-utils") }
  else { @("npx", "--yes", "--package", "@@PACKAGE@@", "atscale-utils") }

if (-not (Test-Path $Conn)) { Write-Error "No connections file at $Conn"; exit 2 }
$left = Select-String -Path $Conn -SimpleMatch "@@PLACEHOLDER@@"
if ($left) {
  Write-Host "Fill in $Conn first - these lines still say @@PLACEHOLDER@@:"
  $left | ForEach-Object { Write-Host "  line $($_.LineNumber): $($_.Line.Trim())" }
  exit 2
}

$Steps = @(
@@PSSTEPS@@
)

New-Item -ItemType Directory -Force -Path $Out | Out-Null
$cmd = $Psu[0]; $pre = @($Psu | Select-Object -Skip 1)
$failed = 0
foreach ($s in $Steps) {
  Write-Host "== $($s.Model)"
  $f = "$Out/$($s.File)"
  & $cmd @pre atscale-export-aggregates --connection-file $Conn --atscale-connection-name $Source `
    --catalog-id $s.SrcCatalog --model-id $s.SrcModel --output-file "$f.export.json" | Out-Null
  if ($LASTEXITCODE -ne 0) { Write-Warning "$($s.Model): export failed"; $failed = 1; continue }
  node helpers.mjs pick "$f.export.json" "$f.import.json" $s.File $All
  $rc = $LASTEXITCODE
  if ($rc -eq 4) { $failed = 1; continue }
  if ($rc -ne 0) { $failed = 1 }
  & $cmd @pre atscale-import-aggregates --connection-file $Conn --atscale-connection-name $Target `
    --input-file "$f.import.json" --catalog-id $s.TgtCatalog --model-id $s.TgtModel `
    --source-atscale-connection-name $Source | Set-Content -Encoding utf8 "$f.result.json"
  if ($LASTEXITCODE -ne 0) { Write-Warning "$($s.Model): import failed"; $failed = 1; continue }
  node helpers.mjs summary "$f.result.json" $s.File
  if ($LASTEXITCODE -ne 0) { $failed = 1 }
}

Write-Host ""
Write-Host "Results: $Out"
if ($failed -eq 0) { Write-Host "PASS" } else { Write-Host "FAIL" }
exit $failed
"""

AGGS_README = """# Promote @@N@@ aggregate(s) to @@TGT@@

Generated by the AtScale Env Manager from Promote › Aggregates. Instead of promoting in the
app, this moves the staged system aggregates @@HOSTS@@ with the ps-utils CLI, so you can run
it by hand, on a schedule or in CI.

| Source model | Target model | Aggregates |
|---|---|---|
@@ROWS@@

For each model, `run.sh`:

1. Exports the model's system-defined aggregates from @@SRC@@ (`atscale-export-aggregates`).
2. Keeps the ones you staged, listed in `promotion.json`. Set `ALL_AGGREGATES=1` to keep the
   whole export instead.
3. Imports them into @@TGT@@ (`atscale-import-aggregates`). Like Promote in the app, the import
   swaps the catalog, model, key, reference and connection ids for the target's, matched by
   name; skips an aggregate that's already active on the target or that references an object
   the target model doesn't have; and reactivates an inactive target copy instead of adding a
   second one.

## Requirements

- Node.js 20+.
- ps-utils (`@@PACKAGE@@`). `run.sh` uses `atscale-utils` if it's on your PATH, otherwise `npx`.
  To use another copy, set `PS_UTILS`, for example `PS_UTILS="/path/to/ps-utils/atscale-utils"`.
- Each host's AtScale password (Keycloak), or an API token: put `apiToken: <token>` on the
  user in place of `password`.

## 1. Fill in connections.yaml

`connections.yaml` already has every host and user. Only the passwords are left: replace each
`@@PLACEHOLDER@@`. The run scripts won't start while a `@@PLACEHOLDER@@` is left.

Once filled in, the file holds secrets, so keep it out of Git. To keep it somewhere safer, point
the scripts at it with `CONNECTIONS=/path/to/connections.yaml`.

## 2. Run it

```bash
./run.sh
```

On Windows, run `./run.ps1` from PowerShell instead. Both exit with 0 when every staged
aggregate was exported and imported, and with 1 otherwise, so they can gate a CI job.
An aggregate that is a duplicate on the target is reported as skipped, not as a failure.

## What you get

`run_results/<run id>/` contains, per model:

- `<model>.export.json`: the source's export, as AtScale returned it.
- `<model>.import.json`: what was imported (the staged aggregates only).
- `<model>.result.json`: the import's result - imported, ignored, reactivated, skipped and why.

## Catalog and model ids

AtScale's export and import address a model by its catalog and model **ids**, which are
per host. `promotion.json` has the ones the hosts had when this zip was made. Redeploying a
model under the same catalog name keeps them; if a model is undeployed and deployed again
under a new catalog, generate the zip again (or update the ids from `atscale-list-deployments`).

## Files

- `connections.yaml`: the hosts. You fill in the passwords.
- `promotion.json`: what was staged (models, ids, aggregates) and when. Edit a model's
  `aggregates` list to change which aggregates the script promotes.
- `helpers.mjs`: picks the staged aggregates and prints each import's result. Node.js only.

To promote one model by hand:

```bash
atscale-utils atscale-export-aggregates --connection-file connections.yaml \\
  --atscale-connection-name @@SOURCE@@ --catalog-id <id> --model-id <id> --output-file export.json
atscale-utils atscale-import-aggregates --connection-file connections.yaml \\
  --atscale-connection-name @@TARGET@@ --input-file export.json --catalog-id <id> --model-id <id> \\
  --source-atscale-connection-name @@SOURCE@@
```
@@NOTE@@"""


#: Lookups the run scripts need, Node only (ps-utils already requires it).
HELPERS_MJS = r"""// Helpers for run.sh / run.ps1, generated by the AtScale Env Manager.
//   node helpers.mjs repo-id <url>          < atscale-list-repos output   -> the repo's id (exit 1: not attached)
//   node helpers.mjs repo-name <url>        -> a name for atscale-create-repo
//   node helpers.mjs project-name <dir> <branch>  -> <catalog unique_name>_<branch>
//   node helpers.mjs pick <export> <out> <file key> [all]  -> the staged aggregates only
//        (exit 3: some staged ones weren't exported, 4: none were)
//   node helpers.mjs summary <import result> <file key>  (exit 1: nothing imported or reactivated)
import fs from "node:fs";
import path from "node:path";

const [cmd, ...args] = process.argv.slice(2);
const norm = (u) => String(u || "").trim().replace(/\/+$/, "").replace(/\.git$/, "").replace(/^git@([^:]+):/, "https://$1/")
  .replace(/^https?:\/\/[^@/]*@/, "https://").toLowerCase();

/** The JSON a ps-utils operation prints last (its log lines come first, on the same stdout). */
function jsonTail(text) {
  const lines = text.split(/\r?\n/);
  for (let i = lines.length - 1; i >= 0; i--) {
    if (!/^[[{]/.test(lines[i])) continue;
    try { return JSON.parse(lines.slice(i).join("\n")); } catch { /* an inner line - keep looking */ }
  }
  return null;
}

function ymlFiles(dir) {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const p = path.join(dir, e.name);
    return e.isDirectory() ? ymlFiles(p) : e.name.endsWith(".yml") ? [p] : [];
  });
}

const commands = {
  "repo-id"([url]) {
    const repo = (jsonTail(fs.readFileSync(0, "utf8")) || []).find((r) => norm(r.url) === norm(url));
    if (!repo) process.exit(1);
    console.log(repo.id);
  },
  "repo-name"([url]) {
    console.log(norm(url).split("/").pop() || "repo");
  },
  "project-name"([dir, branch]) {
    for (const f of ymlFiles(dir)) {
      const text = fs.readFileSync(f, "utf8");
      if (!/^object_type:\s*["']?catalog["']?\s*$/m.test(text)) continue;
      const m = /^unique_name:\s*["']?(.+?)["']?\s*$/m.exec(text);
      if (m) { console.log(`${m[1]}_${branch}`); return; }
    }
    console.error(`No catalog.yml (object_type: catalog) in the ${branch} branch`);
    process.exit(1);
  },
  pick([exportFile, out, key, all]) {
    const payload = JSON.parse(fs.readFileSync(exportFile, "utf8"));
    const values = payload?.aggregates?.values ?? [];
    if (all) {
      fs.writeFileSync(out, JSON.stringify(payload, null, 2));
      console.log(`   ${values.length} exported, all kept (ALL_AGGREGATES)`);
      process.exit(values.length ? 0 : 4);
    }
    const plan = JSON.parse(fs.readFileSync(new URL("./promotion.json", import.meta.url), "utf8"));
    const model = plan.models.find((m) => m.file === key);
    const wanted = new Map((model?.aggregates ?? []).map((a) => [a.id, a.name]));
    const kept = values.filter((v) => wanted.has(v.id));
    const missing = [...wanted].filter(([id]) => !kept.some((v) => v.id === id)).map(([, n]) => n);
    console.log(`   ${kept.length} of ${wanted.size} staged aggregate(s) in the export (${values.length} exported)`);
    for (const n of missing) console.log(`   - ${n}: not exported (inactive, not built, or no longer on the source)`);
    if (!kept.length) process.exit(4);
    payload.aggregates = { ...payload.aggregates, values: kept };
    fs.writeFileSync(out, JSON.stringify(payload, null, 2));
    process.exit(missing.length ? 3 : 0);
  },
  summary([file, key]) {
    const r = jsonTail(fs.readFileSync(file, "utf8")) || {};
    const plan = JSON.parse(fs.readFileSync(new URL("./promotion.json", import.meta.url), "utf8"));
    const names = new Map((plan.models.find((m) => m.file === key)?.aggregates ?? []).map((a) => [a.id, a.name]));
    const imported = r.numberOfDefinitionsImported ?? 0;
    const reactivated = r.reactivated ?? [];
    const skipped = r.skipped ?? [];
    console.log(`   imported ${imported}, reactivated ${reactivated.length}, skipped ${skipped.length}`);
    for (const s of skipped) console.log(`   - ${names.get(s.id) ?? s.id}: ${s.reason ?? "skipped"}`);
    process.exit(imported || reactivated.length || skipped.length ? 0 : 1);
  },
};

if (!commands[cmd]) { console.error(`Unknown command: ${cmd}`); process.exit(2); }
commands[cmd](args);
"""
