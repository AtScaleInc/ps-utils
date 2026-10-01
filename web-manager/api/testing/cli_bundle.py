"""A validation run as a zip the user runs by hand with the ps-utils CLI.

Validate › Run (and Catalog › Validate) can run the picked queries here, or
hand them over as a repeatable CLI job: the same queries, on the same hosts,
through ps-utils `execute-atscale-query-harness` (task-file mode), then a
pass / fail comparison of every host against the first one.

Shapes follow ps-utils, read from source:
  - queries/<cube>_<xmla|sql>_queries.json - QueryRecord arrays as
    src/operations/generate-queries-shared.ts :: makeQueryRecord writes them
    (queryLanguage "analysis" for MDX, "sql" for SQL)
  - tasks/<host>.yaml - TaskDefinition (ExecuteAtScaleQueryHarnessOperation.ts):
    task-file mode reads queries/<model>_<protocol>_queries.json relative to
    the working directory, takes the cube from `model` (direct mode would use
    the connection name as the cube) and the CSV name from `runLogFileName`;
    workers come from an AtOnceUsersOpenInjectionStep (deriveLoadPattern)
  - the connections file - xmlaConfigFromYaml / sqlConfigFromYaml: container
    host (`installer: false`), Keycloak password grant through `mdx.user`,
    `mdx.catalog_name`; SQL on :15432 with `ssl: true`, database = catalog;
    top-level `cert.rejectUnauthorized: false` for self-signed hosts

No secret is ever written into the zip: connections.yaml carries every host,
catalog and user, with each password left as PLACEHOLDER for the user to fill
in; run.sh / run.ps1 refuse to start while one is left. The harness's CLI has no switches for UseAggregates /
GenerateAggregates / UseQueryCache / UseAggregateCache in connections.yaml
mode - it always sends true / false / false / true - so other picks are
reported in the README instead of silently dropped.
"""

from __future__ import annotations

import io
import json
import re
import zipfile
from datetime import datetime, timezone
from typing import Any

from .generate import sha256hex
from .harness import DEFAULT_OPTS

#: What execute-atscale-query-harness sends in connections.yaml mode (xmlaConfigFromYaml).
CLI_OPTS = {"useAggregates": True, "generateAggregates": False, "useQueryCache": False, "useAggregateCache": True}
OPT_LABEL = {"useAggregates": "Use aggregates", "generateAggregates": "Generate aggregates",
             "useQueryCache": "Query cache", "useAggregateCache": "Aggregate cache"}
PACKAGE = "@atscale-ps/ps-utils"
SQL_PORT = 15432


def slug(text: str) -> str:
    """The harness's own file-name rule: model.replace(/[^a-zA-Z0-9_-]/g, "_")."""
    return re.sub(r"[^A-Za-z0-9_-]", "_", text or "") or "x"


def _hostname(raw: dict[str, Any]) -> str:
    url = (raw.get("atscale") or {}).get("url") or ""
    return re.sub(r"^https?://", "", url).split("/")[0]


def _record(name: str, language: str, text: str, cube: str) -> dict[str, Any]:
    # ps-utils generate-queries-shared.ts :: makeQueryRecord
    return {"queryName": name, "queryLanguage": language, "originalText": text, "originalTextHash": sha256hex(text),
            "outboundText": None, "cubeName": cube, "projectId": "", "aggregateUsed": False, "numTimes": 1,
            "elapsedTimeInSeconds": None, "avgResultSetSize": 0, "atscaleQueryId": ""}


def _yaml_str(s: str) -> str:
    return json.dumps(s)  # a JSON string is a valid YAML double-quoted scalar


def build(targets: list[dict[str, Any]], hosts: dict[str, dict[str, Any]], queries: list[dict[str, Any]],
          protocols: list[str], concurrency: int, options: dict[str, bool], annotate: bool) -> tuple[str, bytes]:
    """(file name, zip bytes). `targets`: [{hostId, catalog, cube}] in run order
    (the first is the baseline); `hosts`: raw host entries by id (registry.host)."""
    cube = targets[0]["cube"]
    stamp = datetime.now(timezone.utc).strftime("%Y%m%d-%H%M")
    root = f"validate-{slug(cube)}-{stamp}"
    proto_cli = [("xmla" if p == "mdx" else "sql") for p in protocols]

    # One connection per host; names must be unique and file-safe.
    names: dict[str, str] = {}
    for t in targets:
        base = slug(hosts[t["hostId"]].get("label") or t["hostId"])
        name, n = base, 2
        while name in names.values():
            name, n = f"{base}_{n}", n + 1
        names[t["hostId"]] = name

    files: dict[str, str] = {}
    for p in proto_cli:
        for c in sorted({t["cube"] for t in targets}):
            recs = [_record(q["name"], "analysis" if p == "xmla" else "sql", q["mdx" if p == "xmla" else "sql"], c)
                    for q in queries]
            files[f"queries/{slug(c)}_{p}_queries.json"] = json.dumps(recs, indent=2) + "\n"

    for t in targets:
        n = names[t["hostId"]]
        label = hosts[t["hostId"]].get("label") or n
        tasks = []
        for p in proto_cli:
            tasks += [
                f"- taskName: {_yaml_str(f'{label} {p.upper()}')}",
                f"  simulationClass: {'AtScaleXmlaSimulation' if p == 'xmla' else 'AtScaleSqlSimulation'}",
                f"  model: {_yaml_str(t['cube'])}",
                f"  runLogFileName: {_yaml_str(f'{n}_{p}.log')}",
                "  injectionSteps:",
                "    - type: AtOnceUsersOpenInjectionStep",
                f"      users: {concurrency}",
            ]
        files[f"tasks/{n}.yaml"] = "\n".join([f"# {label}: {t['catalog']} / {t['cube']}", *tasks, ""])

    rows = [{"name": names[t["hostId"]], "label": hosts[t["hostId"]].get("label") or names[t["hostId"]],
             "env": hosts[t["hostId"]].get("env"), "hostname": _hostname(hosts[t["hostId"]]),
             "username": (hosts[t["hostId"]].get("atscale") or {}).get("username") or "",
             "insecure": bool((hosts[t["hostId"]].get("atscale") or {}).get("insecure", True)),
             "catalog": t["catalog"], "cube": t["cube"]} for t in targets]
    opts = {**DEFAULT_OPTS, **(options or {})}
    unsupported = [OPT_LABEL[k] + (" on" if v else " off") for k, v in opts.items() if CLI_OPTS.get(k) != v]
    manifest = {
        "generatedAt": datetime.now(timezone.utc).replace(microsecond=0).isoformat(),
        "model": cube, "protocols": proto_cli, "workersPerHost": concurrency, "annotateQueries": annotate,
        "baseline": rows[0]["name"],
        "hosts": [{k: r[k] for k in ("name", "label", "env", "hostname", "username", "catalog", "cube")} for r in rows],
        "queries": [{"name": q["name"], "kind": q.get("kind"), "hash": q.get("hash")} for q in queries],
        "options": {"picked": opts, "cliSends": CLI_OPTS, "notApplied": unsupported},
    }
    files["validation.json"] = json.dumps(manifest, indent=2) + "\n"
    files["connections.yaml"] = _connections_yaml(rows)
    files["run.sh"] = _fill(RUN_SH, rows, proto_cli, annotate)
    files["run.ps1"] = _fill(RUN_PS1, rows, proto_cli, annotate)
    files["compare.mjs"] = COMPARE_MJS
    files["README.md"] = _readme(cube, rows, proto_cli, queries, concurrency, unsupported)

    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w", zipfile.ZIP_DEFLATED) as z:
        for path, body in files.items():
            info = zipfile.ZipInfo(f"{root}/{path}", date_time=datetime.now().timetuple()[:6])
            info.compress_type = zipfile.ZIP_DEFLATED
            info.external_attr = (0o755 if path == "run.sh" else 0o644) << 16
            z.writestr(info, body)
    return f"{root}.zip", buf.getvalue()


#: What the user replaces in connections.yaml; run.sh / run.ps1 refuse to start while it's there.
PLACEHOLDER = "<fill in>"


def _connections_yaml(rows: list[dict[str, Any]]) -> str:
    """A ps-utils connections file for the run's hosts, every value filled in
    but the passwords."""
    out = [
        "# ps-utils connections for this validation run.",
        # The placeholder itself must not appear in a comment: run.sh greps for it.
        "# Fill in each user's password below - run.sh won't start while one is left blank.",
        "# This file then holds secrets: keep it out of Git and share the zip, not this file.",
        "#",
        "# Instead of a password, an XMLA token can authenticate MDX on its own: set mdx.url",
        "# to https://<host>/engine/xmla/<token> (SQL still needs the password).",
    ]
    if any(r["insecure"] for r in rows):
        out += ["", "# Self-signed certificates on these hosts (the Env Manager's 'insecure' flag).",
                "cert:", "  rejectUnauthorized: false"]
    out += ["", "users:"]
    for r in rows:
        out += [f"  u_{r['name']}:", f"    username: {_yaml_str(r['username'] or PLACEHOLDER)}",
                f"    password: {_yaml_str(PLACEHOLDER)}"]
    out += ["", "connections:"]
    for r in rows:
        out += [
            f"  # {r['label']} ({(r['env'] or '').upper()})",
            f"  {r['name']}:",
            "    installer: false",
            "    atscale:",
            f"      url: https://{r['hostname']}",
            "    mdx:",
            f"      url: https://{r['hostname']}",
            f"      user: u_{r['name']}",
            f"      catalog_name: {_yaml_str(r['catalog'])}",
            "    sql:",
            "      dialect: postgres",
            f"      server: {r['hostname']}",
            f"      port: {SQL_PORT}",
            f"      database: {_yaml_str(r['catalog'])}",
            "      ssl: true",
            f"      user: u_{r['name']}",
        ]
    return "\n".join(out) + "\n"


RUN_SH = r"""#!/usr/bin/env bash
# Repeatable validation run, generated by the AtScale Env Manager.
# Runs the same queries on every host in connections.yaml with ps-utils
# execute-atscale-query-harness, then compares each host with the first one.
#
#   ./run.sh                                  # uses ./connections.yaml
#   CONNECTIONS=~/secure/conn.yaml ./run.sh   # a filled-in copy kept elsewhere
#   RUN_ID=nightly-42 ./run.sh                # label the run (default: a timestamp)
#   PS_UTILS="/path/to/atscale-utils" ./run.sh
set -euo pipefail
cd "$(dirname "$0")"

CONN="${CONNECTIONS:-connections.yaml}"
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
failed=0
run_host() {
  echo "== $2"
  "${PSU[@]}" execute-atscale-query-harness \
    --connection-file "$CONN" --connection-name "$1" \
    --task-file "tasks/$1.yaml" \
    --run-id "$RUN_ID" --output-dir "$OUT" \
    --annotate-queries @@ANNOTATE@@ || { echo "!! $2: the harness failed" >&2; failed=1; }
}
@@RUNS@@

echo
node compare.mjs "$OUT" @@HOSTS@@ -- @@PROTOCOLS@@ || failed=1
echo "Results: $OUT"
exit $failed
"""

RUN_PS1 = r"""# Repeatable validation run, generated by the AtScale Env Manager (PowerShell).
# Same as run.sh: the same queries on every host in connections.yaml with
# ps-utils execute-atscale-query-harness, then each host compared with the first.
#
#   ./run.ps1
#   $env:CONNECTIONS = "C:\secure\conn.yaml"; ./run.ps1
#   $env:RUN_ID = "nightly-42"; ./run.ps1
#   $env:PS_UTILS = "C:\path\to\atscale-utils"; ./run.ps1
$ErrorActionPreference = "Stop"
Set-Location $PSScriptRoot

$Conn = if ($env:CONNECTIONS) { $env:CONNECTIONS } else { "connections.yaml" }
$RunId = if ($env:RUN_ID) { $env:RUN_ID } else { Get-Date -Format "yyyy-MM-dd-HHmmss" }
$Out = "run_results/$RunId"
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

$Hosts = @(
@@PSHOSTS@@
)

New-Item -ItemType Directory -Force -Path $Out | Out-Null
$failed = 0
$cmd = $Psu[0]; $pre = @($Psu | Select-Object -Skip 1)
foreach ($h in $Hosts) {
  Write-Host "== $($h.Label)"
  & $cmd @pre execute-atscale-query-harness --connection-file $Conn --connection-name $h.Name `
    --task-file "tasks/$($h.Name).yaml" --run-id $RunId --output-dir $Out --annotate-queries @@ANNOTATE@@
  if ($LASTEXITCODE -ne 0) { Write-Warning "$($h.Label): the harness failed"; $failed = 1 }
}

Write-Host ""
node compare.mjs $Out @@HOSTS@@ -- @@PROTOCOLS@@
if ($LASTEXITCODE -ne 0) { $failed = 1 }
Write-Host "Results: $Out"
exit $failed
"""


def _fill(template: str, rows: list[dict[str, Any]], protocols: list[str], annotate: bool) -> str:
    subs = {
        "@@PACKAGE@@": PACKAGE, "@@PLACEHOLDER@@": PLACEHOLDER, "@@ANNOTATE@@": "true" if annotate else "false",
        "@@RUNS@@": "\n".join(f"run_host {r['name']} {_sh_quote(r['label'])}" for r in rows),
        "@@PSHOSTS@@": ",\n".join(f"  @{{ Name = \"{r['name']}\"; Label = {_ps_quote(r['label'])} }}" for r in rows),
        "@@HOSTS@@": " ".join(r["name"] for r in rows), "@@PROTOCOLS@@": " ".join(protocols),
    }
    for k, v in subs.items():
        template = template.replace(k, v)
    return template


def _sh_quote(s: str) -> str:
    return "'" + s.replace("'", "'\\''") + "'"


def _ps_quote(s: str) -> str:
    return "'" + s.replace("'", "''") + "'"


def _readme(cube: str, rows: list[dict[str, Any]], protocols: list[str], queries: list[dict[str, Any]],
            concurrency: int, unsupported: list[str]) -> str:
    host_rows = "\n".join(f"| {r['label']} | {(r['env'] or '').upper()} | `{r['hostname']}` | `{r['catalog']}` | `{r['username']}` |"
                          for r in rows)
    first = rows[0]["name"]
    base = rows[0]["label"]
    proto = " and ".join(p.upper() for p in protocols)
    note = ("\n## Options the CLI can't apply\n\nYou picked " + ", ".join(unsupported) + ". In connections.yaml mode, "
            "`execute-atscale-query-harness` always sends UseAggregates=true, GenerateAggregates=false, "
            "UseQueryCache=false and UseAggregateCache=true, so this run uses those values.\n") if unsupported else ""
    text = README
    for k, v in {"@@CUBE@@": cube, "@@N@@": str(len(queries)), "@@PROTO@@": proto, "@@HOSTN@@": str(len(rows)),
                 "@@BASE@@": base, "@@HOSTROWS@@": host_rows, "@@PACKAGE@@": PACKAGE, "@@PLACEHOLDER@@": PLACEHOLDER,
                 "@@FIRST@@": first, "@@WORKERS@@": str(concurrency), "@@NOTE@@": note}.items():
        text = text.replace(k, v)
    return text


README = """# Validate @@CUBE@@

Generated by the AtScale Env Manager. This runs @@N@@ queries (@@PROTO@@) against
the `@@CUBE@@` model on @@HOSTN@@ host(s), using the ps-utils CLI, then compares every host
with **@@BASE@@** (the baseline). It's the same set of queries every time you run it,
so you can schedule it or run it in CI.

| Host | Group | Hostname | Catalog | User |
|---|---|---|---|---|
@@HOSTROWS@@

## Requirements

- Node.js 20+.
- ps-utils (`@@PACKAGE@@`). `run.sh` uses `atscale-utils` if it's on your PATH, otherwise `npx`.
  To use another copy, set `PS_UTILS`, for example `PS_UTILS="/path/to/ps-utils/atscale-utils"`.
- Each host's AtScale password (Keycloak). Accounts that only sign in through SSO can't be used.

## 1. Fill in connections.yaml

`connections.yaml` already has every host, catalog and user. Only the passwords are left: replace
each `@@PLACEHOLDER@@` with the password for that host's user. The run scripts won't start while a
`@@PLACEHOLDER@@` is left.

Once filled in, the file holds secrets, so keep it out of Git. To keep it somewhere safer, point
the scripts at it with `CONNECTIONS=/path/to/connections.yaml`.

Instead of a password, MDX can use an XMLA token: set that host's `mdx.url` to
`https://<host>/engine/xmla/<token>`. SQL still needs the password.

## 2. Run it

```bash
./run.sh
```

On Windows, run `./run.ps1` from PowerShell instead.

To give the run a label, for example in cron or CI:

```bash
RUN_ID=nightly-$(date +%F) CONNECTIONS=~/secure/connections.yaml ./run.sh
```

## What you get

`run_results/<run id>/` contains:

- `<host>_xmla.csv`, `<host>_sql.csv`: one row per query, written by the harness
  (`status`, `duration_ms`, `row_count`, `checksum`, `error`, …).
- The comparison printed at the end. For each host, it checks status, row count and result
  checksum against @@BASE@@, matched on the query text hash.

`run.sh` exits with 0 when every host matches the baseline, and with 1 if any query fails or
differs. That's what makes it usable as a CI gate.

To compare timing between two hosts, or between two runs, use ps-utils:

```bash
atscale-utils execute-run-analysis \\
  --file-a run_results/<run id>/@@FIRST@@_xmla.csv --file-b run_results/<run id>/<other>_xmla.csv \\
  --summary-file summary.txt --comparison-file comparison.csv --outliers-file outliers.csv
```

## Files

- `connections.yaml`: the hosts. You fill in the passwords.
- `queries/*_queries.json`: the queries you picked, in the ps-utils query format.
- `tasks/<host>.yaml`: one harness task per protocol for each host
  (@@WORKERS@@ worker(s), and the cube name).
- `validation.json`: what was picked (model, hosts, queries, options) and when.
- `compare.mjs`: the baseline comparison. It only needs Node.js.

To run one host by hand:

```bash
atscale-utils execute-atscale-query-harness --connection-file connections.yaml \\
  --connection-name @@FIRST@@ --task-file tasks/@@FIRST@@.yaml --output-dir run_results/manual
```

Run it from this folder: the task file finds its queries under `queries/`.
@@NOTE@@"""


#: Baseline comparison over the harness CSVs (no dependency beyond Node).
COMPARE_MJS = r"""// Compare each host's harness CSV with the first host's (the baseline).
// Usage: node compare.mjs <results dir> <baseline> <host>... -- <xmla|sql>...
// Exit code 1 when a query failed anywhere or differs from the baseline.
import fs from "node:fs";
import path from "node:path";

const args = process.argv.slice(2);
const dir = args[0];
const cut = args.indexOf("--");
const hosts = args.slice(1, cut);
const protocols = args.slice(cut + 1);

function parseCsv(text) {
  const rows = []; let row = [], cell = "", q = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (q) {
      if (c === '"' && text[i + 1] === '"') { cell += '"'; i++; }
      else if (c === '"') q = false;
      else cell += c;
    } else if (c === '"') q = true;
    else if (c === ",") { row.push(cell); cell = ""; }
    else if (c === "\n" || c === "\r") {
      if (c === "\r" && text[i + 1] === "\n") i++;
      row.push(cell); rows.push(row); row = []; cell = "";
    } else cell += c;
  }
  if (cell || row.length) { row.push(cell); rows.push(row); }
  const [head, ...body] = rows.filter((r) => r.length > 1);
  return (body || []).map((r) => Object.fromEntries(head.map((h, i) => [h, r[i] ?? ""])));
}

function load(host, p) {
  const file = path.join(dir, `${host}_${p}.csv`);
  if (!fs.existsSync(file)) return null;
  const byHash = new Map();
  for (const r of parseCsv(fs.readFileSync(file, "utf8"))) byHash.set(r.original_text_hash || r.query_name, r);
  return byHash;
}

let bad = false;
for (const p of protocols) {
  const base = load(hosts[0], p);
  console.log(`${p.toUpperCase()}  baseline ${hosts[0]}`);
  if (!base) { console.log(`  no results for ${hosts[0]}`); bad = true; continue; }
  const baseFailed = [...base.values()].filter((r) => r.status !== "SUCCEEDED");
  if (baseFailed.length) { bad = true; console.log(`  ${hosts[0]}: ${baseFailed.length} failed on the baseline`); }
  for (const h of hosts.slice(1)) {
    const cur = load(h, p);
    if (!cur) { console.log(`  ${h}: no results`); bad = true; continue; }
    const diff = [];
    for (const [k, a] of base) {
      const b = cur.get(k);
      if (!b) diff.push([a.query_name, "missing"]);
      else if (b.status !== "SUCCEEDED") diff.push([a.query_name, `failed: ${b.error.slice(0, 120)}`]);
      else if (a.status === "SUCCEEDED" && a.row_count !== b.row_count) diff.push([a.query_name, `rows ${a.row_count} vs ${b.row_count}`]);
      else if (a.status === "SUCCEEDED" && a.checksum !== b.checksum) diff.push([a.query_name, "values differ (checksum)"]);
    }
    if (diff.length) bad = true;
    console.log(`  ${h}: ${diff.length ? `${diff.length} of ${base.size} differ` : `all ${base.size} match`}`);
    for (const [n, why] of diff.slice(0, 20)) console.log(`    - ${n}: ${why}`);
    if (diff.length > 20) console.log(`    … ${diff.length - 20} more`);
  }
}
console.log(bad ? "\nFAIL" : "\nPASS");
process.exit(bad ? 1 : 0);
"""
