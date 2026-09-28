# AtScale Environment Manager

One console for many AtScale **container** hosts, grouped into three
environments: **Dev**, **Test-QA** and **Prod**. From one screen you can:

- **build** a semantic model visually and deploy it to one or many hosts,
- **manage** each host's models and aggregates,
- **test** that an environment answers the same queries as another, with the
  same model and the same values,
- **promote** models and system aggregates from one environment to the next,
  such as Dev → QA → Prod, moving only what's new.

```
┌──── Build ─────┐   ┌──── Manage ─────┐   ┌───── Test ──────┐   ┌──── Promote ────┐
│ warehouse →    │   │ group → host    │   │ generate queries│   │ source host     │
│ canvas → SML   │ → │ Models: link,   │ → │ from a model,   │ → │  diff → stage   │
│ push to Git    │   │  deploy, unlink │   │ run on hosts,   │   │ target host     │
│ deploy to any  │   │ Aggregates:     │   │ compare model + │   │  promote (Prod  │
│ hosts          │   │  build, (de)act │   │ results         │   │  asks first)    │
└────────────────┘   └─────────────────┘   └─────────────────┘   └─────────────────┘
        Settings: Hosts & Git (credentials, shared Git profile) · Cache & Database
```

The top tabs are **Build · Manage · Test · Promote**, with **⚙ Settings** on the
right. The left rail lists the current tab's sections:

| Tab | Rail sections |
|---|---|
| Build | Model · Preview |
| Manage | Models · Aggregates |
| Test | Run · Results · Compare results · Compare model |
| Promote | Models · Aggregates |
| Settings | Hosts & Git · Cache & Database |

Every tab picks its group and host the same way: the env picker and host
dropdown sit at the left of the bar.

---

## What it does

### Build: model SML and deploy it to one or many hosts

Build is the SML wizard that used to be the separate `sml-wizard` repo. It
works on the host picked in the Build bar, using that host's credentials from
Settings. There's no separate login.

- **Model.** Pick one of the host's data warehouses, drag tables onto the
  canvas, mark each as a fact or a dimension, join them (snowflake joins work
  too), and configure metrics, hierarchies, aliases, secondary attributes and
  calculations. **Wizard** does the first pass for you from column names.
- **Save / Load.** Saving writes plain SML to `workspace/models/<model>/`.
  Loading reads from there, from a repo already attached on the host, or from
  any path or Git URL.
- **Deploy.** Generates the SML and shows it for review; **Validate with
  sml-cli** is optional. **Deploy to** lists every host by group, with the
  Build host checked by default. The SML is pushed to Git once: a new model
  gets `github.com/<git user>/<model>`, and a loaded one goes back to its own
  repo and branch. Then each checked host attaches the repo and deploys that
  branch, using the same call Promote uses. A host without the model's data
  warehouse connection is greyed out, and results are reported per host.
- **Preview.** Pick a deployed catalog/cube on the Build host, then a mode:
  - **DMV**: drag hierarchies, levels and measures (read from the cube's DMV)
    onto Rows / Measures, and run the query the app builds. Levels of the same
    hierarchy are combined with `Hierarchize`. You can expand the generated
    query under the grid.
  - **Freehand**: type your own MDX, or SQL when **SQL Dialect** is ticked.
    Dragging an item into the editor inserts its MDX unique name or its quoted
    SQL column name. **Use last query** copies the last built query,
    **Template** starts an empty one, and Cmd/Ctrl+Enter runs it. MDX and SQL
    keep separate drafts.

Build is a quick-start modeler, not a replacement for AtScale's own. Multi-table
dimension hierarchies and multi-hierarchy dimensions only partly import.

### Manage → Models

Pick a group, then a host.

| Action | What happens |
|---|---|
| **+ Link model** | Registers a GitHub repo on the host, at a branch you pick. The repo list shows only your repos that have a `catalog.yml`. Each branch shows its head commit. |
| **Deploy…** | For each selected repo, deploys the **branch you pick**. AtScale clones that branch head and compiles the SML itself. A branch other than the current one deploys as its own catalog, tagged with the branch name. |
| **Undeploy** | Undeploys the whole catalog the selected models belong to, along with its aggregates. The repo stays linked. |
| **Unlink** | Undeploys the catalog, then detaches the repo from the host. Git isn't touched. |

AtScale deploys and undeploys **whole catalogs** (a repo is one catalog), so the
confirmation dialogs list every model affected.

**Version = the Git commit** the deployment was built from (for example
`ef4d8e3 main`). AtScale doesn't record the commit, so:

- if the app deployed it, the app recorded the commit
- otherwise it's inferred as the last commit on the branch before AtScale's
  publish time, and shown with a `~`

### Manage → Aggregates

- Pick a deployed model to see its aggregates:
  - type: `SYSTEM` or `USER`
  - row count
  - last build time
  - status: Built, Building, Stale, Invalid, Error or Inactive. Invalid and
    Error show AtScale's reason when you hover.
- **Full build** or **Incremental build** covers every active aggregate of the
  model. Building rows update to Built on their own.
- **Deactivate** or **Reactivate** works on one row or on a multi-selection.
- System aggregates have UUIDs for names, so the app shows a readable label
  built from their grain, such as `Product Category · Product Line · 24 measures`.

### Test: prove an environment matches before promoting

Test is ps-utils' *Testing / Query Processing* group, run on several hosts at
once. A candidate environment is ready to promote to when its **model** and its
**query results** match the baseline.

- **Run.** Pick a host and one of its deployed models. The app generates one
  grand-total query per metric and one breakdown per hierarchy level
  (ps-utils `generate-queries-from-model`), each in MDX and SQL. Then pick:
  - the hosts to run on. A host counts as having the model when it has a cube
    with the same name, even if its catalog name carries a branch suffix.
  - which queries to run (filter by totals / level breakdowns, or search)
  - MDX and/or SQL, workers per host, and the aggregate / cache flags
  - whether to annotate each query with a `/* {run_id, …} */` comment, so
    AtScale's query log can be matched to the run

  The queries run like ps-utils `execute-atscale-query-harness`. Each one
  records its status, time, size and checksum, and the result rows are stored
  too. Each host's model (DMV) is snapshotted at the start of the run.
- **Results.** Runs are grouped by model, newest first. A run's detail shows:
  - a **promotion check** for each host against a baseline host you pick:
    whether the model is identical and all results are identical, what failed,
    and how the time compares. A banner says whether it's safe to promote.
  - per-host totals (ok / failed, average and max time)
  - every execution per host. Opening one shows its text, any errors, and its
    **history** across past runs: time, size, and whether the result changed.
- **Compare results.** Baseline vs candidate, each picked as model → run →
  host. That can be two hosts in one run (Dev vs QA), or the same host in two
  runs (before and after a redeploy). Queries are matched by name, rows by
  member, and values per measure, within a tolerance you pick (exact to 1%).
  You get:
  - a verdict, plus model / results / response-time checks
  - problem queries first: Differs, Failed on baseline / candidate, Missing
  - for each differing query, a variance table (member, measure, baseline,
    candidate, Δ, Δ%) and any rows found on only one side
  - a CSV export of the comparison
- **Compare model.** A live DMV diff of two deployed models. Metrics and levels
  are listed as *Only in baseline*, *Only in candidate* or *Changed*, with the
  baseline → candidate value. **Show matching objects** lists the rest.

MDX sizes are **cell** counts (rows × measures) and SQL sizes are row counts. A
level whose key repeats (for example a month name keyed by day) is compared as
a multiset, so row order never makes equal results differ.

### Promote

The source (group and host) is on top and the target is below. Choose
**Models** or **Aggregates** in the rail.

**Models.** Each row shows how the source compares with the target, using a
GitHub compare of the two commits:

| State | Meaning | Can stage |
|---|---|---|
| New | not on the target | yes |
| Update `abc → def` | source commit is newer | yes |
| In sync | same commit | yes, via **Branch ↓**, to push a different branch |
| Target newer | target commit is ahead | yes (shown amber) |
| Diverged | the branches split | yes |

Each staged model has:

- **From branch**: any branch of the repo, with its head commit. Dev can run
  `develop` while Prod gets `main`.
- **Link & deploy** or **Link only**.
- **Undeploy `<old branch>` afterwards**: offered when the target already runs
  the repo on a different branch. Without it, the new branch deploys
  alongside the old one.

**Aggregates.** Only these can be promoted:

- **system-defined**. User-defined ones are shown dimmed as
  "User-defined · not promotable".
- **active** on the source, not deactivated
- **exportable**, meaning it has a built instance
- on a model **deployed on the target under the same name**. Otherwise it
  shows "Promote model first".
- **not already active on the target**. Otherwise it shows "Duplicate on
  target", with a **Deactivate** button on the target row. If the target copy
  is inactive, the row shows "Replaces inactive · not advised"; promoting
  reactivates that copy.

Other rules:

- **Stage all** stages every aggregate that can be staged in the current model
  filter.
- The source and target must be different hosts.
- Changing the source clears what's staged.
- **Promoting to Prod always asks for confirmation.**

#### How aggregate promotion works across hosts

Every host that deploys the same SML generates **its own ids**: catalog, model,
keys, role-play references and instances. Matching by id would never work, so
everything is matched by **name**, and then the target's id is looked up.

1. **Model.** Found on the target by deployed name.
2. **Id ↔ name map per host.** Built from the catalog's JSON
   (`GET /v1/catalogs/{id}/export`):
   - a key is named after the attribute that uses it, e.g.
     `attr:Customer Name`, `sort:customyear`, or `col:<dataset>:<column>`
   - a reference is named after its naming pattern and attribute, e.g.
     `ref:Order {0}:DayMonth`
3. **Matching.** Two aggregates are the same when their plans select the same
   named objects with the same aggregation functions.
4. **Remap.** The source export is rewritten before import:
   - catalog and model ids → the target's
   - plan key and reference ids → the target's ids for the same names
   - instance ids → the target counterpart's
   - connection id → the target model's connection

   If an aggregate references something the target model doesn't have, it's
   skipped and the missing names are listed.
5. **Re-check at promote time.** The target's current state is re-read before
   importing, in case it changed since the diff was shown.

### Settings

**Hosts & Git**

- **Hosts.** Register any number of AtScale container hosts. Each one has a
  label, a hostname (no scheme or port), a Keycloak ID and password, an
  optional API token, and a group (Dev, Test-QA or Prod).
  - **Test connection** logs in and makes one cheap call. On success it records
    the host's ids (models, catalog objects, aggregate instances) in the
    working folder.
  - Secrets are never sent back to the browser. The UI only knows whether a
    password or token has been saved.
- **Git profile.** One GitHub username, email and personal access token
  (`repo` scope), shared by all hosts. **Test Git** checks the token. Linking,
  deploying and promoting models, and Build's deploy, are disabled until it
  works.

**Cache & Database**

- **Cache.** The list cache in the working folder (see *Caching and storage*):
  how many lists, how many are fresh, their size. You can show the contents
  and clear it.
- **Database.** The Test history in `workspace/tests.db`:
  - stored runs, executions and result data per model, with the oldest and
    newest run
  - **Delete runs** older than N days and/or beyond the newest N per model, for
    all models or one, with a count shown before anything is deleted
  - **Compact** gives space freed by deleted runs back to the disk

---

## Running it

### Requirements

- Python 3.11+ and Node 20+ (developed on Python 3.14 and Node 26)
- network access to your AtScale hosts and to `api.github.com`
- a GitHub personal access token with `repo` scope

### First-time setup

```bash
git clone --recurse-submodules <this repo>
cd Atscale-Environment-Manager
```

If you cloned without submodules:

```bash
git submodule update --init
```

Create the Python virtualenv outside the repo, as the project convention
expects, and point `start.sh` at it:

```bash
python3 -m venv ~/Development/venv/atscale-env-manager
```

```bash
~/Development/venv/atscale-env-manager/bin/pip install -r api/requirements.txt
```

```bash
echo atscale-env-manager > .venv
```

`start.sh` looks for `.venv/bin/activate` inside the repo first. If it doesn't
find one, it reads the name in the `.venv` file and uses
`~/Development/venv/<name>`. If neither exists, it falls back to `python3` on
your PATH.

The first run installs the frontend packages (`npm install` in `web/`)
automatically, including the pinned `sml-cli` that Build's **Validate** uses.
After pulling changes that touch dependencies, run `npm install` in `web/` and
`pip install -r api/requirements.txt` again.

### Start

```bash
./start.sh
```

- API: http://127.0.0.1:5050, log in `.logs/api.log`
- Web: http://127.0.0.1:5174, log in `.logs/web.log`

Open the web URL and go to **Settings → Hosts & Git**. Save and test the **Git**
profile, then add hosts to each group and **Test connection**.

`start.sh` first stops anything already bound to its two ports. To use other
ports:

```bash
API_PORT=5060 WEB_PORT=5184 ./start.sh
```

### Demo mode (no AtScale host needed)

```bash
ENV_MANAGER_FAKE=1 ./start.sh
```

This runs against an in-memory backend seeded with sample data: five hosts
across the three groups, seven models, and aggregates with duplicates, stale
rows and user-defined rows. Manage and Promote can be tried in full here.

- Demo hosts are stored in `api/connections.fake.yaml`.
- Demo data goes to its own files: `workspace/cache-demo/`,
  `workspace/models-demo/` and `workspace/tests-demo.db`.
- In Build, every demo host has a `PostgresDB` warehouse except prod-west, so
  you can see a deploy skip a host. Deploy doesn't really push to Git.
- Build's Preview, Load from Git, and the Test tab run real queries, so they
  need a real host.
- **Settings → Hosts & Git → Reset demo data** restores the seed.

### Tests and build

```bash
cd api && ~/Development/venv/atscale-env-manager/bin/python -m pytest tests -q
```

```bash
cd web && npm run build
```

The API tests cover:

- Promote: the diff states, duplicate and system-only filtering, model matching
  by name, name-based aggregate fingerprints across hosts with different ids,
  and payload remapping (including the import schema's required fields)
- the credential store round-trip (secrets masked) and hostname normalisation
- caching and its disk mirror
- full promote flows against the demo backend
- Build: SML generation and parsing, sml-cli validation, per-host sources and
  schemas, multi-host deploy with its preflight, the preview MDX builder
  (including levels of one hierarchy), and freehand MDX/SQL
- Test: query generation (level names, not captions), the harness (checksums
  ignore per-response timestamps; `<FmtValue>` isn't counted), result variance
  and model diffs, the compare endpoint, the SQLite store (history, retention,
  restart recovery, JSON import), cleanup, the concurrent-run cap and job pruning

---

## Configuration and data

| Path | What | In Git? |
|---|---|---|
| `api/connections.yaml` | Hosts, credentials, Git token. Written by Settings, file mode 0600. See `api/connections.yaml.sample`. | **no** (gitignored) |
| `api/connections.fake.yaml` | Demo-mode hosts | no |
| `workspace/cache/` | Every cached list as readable JSON (demo: `cache-demo/`) | no |
| `workspace/models/<model>/` | Build's working copy of each model's SML, also the Git checkout it pushes from (demo: `models-demo/`) | no |
| `workspace/tests.db` | Test runs, model snapshots and result rows, in SQLite (demo: `tests-demo.db`) | no |
| `workspace/tests-imported/` | Test runs from the earlier JSON layout, left after their one-time import into `tests.db`. Safe to delete. | no |
| `.logs/` | API and web logs from `start.sh` | no |

`connections.yaml` uses the ps-utils connection layout. Each host is an entry
with an `atscale:` block, plus `env`, `label`, `status`, `links` (repos linked
through the app) and `deployments` (the commit this app deployed per catalog).
The shared Git profile is `connections.git.git`.

Environment variables:

| Variable | Default | Purpose |
|---|---|---|
| `API_PORT` / `WEB_PORT` | `5050` / `5174` | Ports used by `start.sh` |
| `ENV_MANAGER_FAKE` | unset | `1` runs the demo backend |
| `ENV_MANAGER_CONNECTIONS_FILE` | `api/connections.yaml` | Location of the credential store |
| `ENV_MANAGER_WORKSPACE` | `./workspace` | Location of the working folder |
| `ENV_MANAGER_CACHE_TTL` | `7200` | How long cached lists stay valid, in seconds |
| `ENV_MANAGER_MODELS_DIR` | `workspace/models` | Where Build keeps each model's working copy |
| `ENV_MANAGER_TESTS_DB` | `workspace/tests.db` | Location of the Test database |
| `ENV_MANAGER_TEST_KEEP` | `100` | Runs kept per model; older ones are pruned after each run |
| `ENV_MANAGER_TEST_MAX_AGE_DAYS` | `90` | Runs older than this are pruned after each run |
| `ENV_MANAGER_TEST_MAX_ACTIVE` | `3` | Test runs that can execute at once; more are refused until one finishes |

### Caching and storage

Container calls are slow: each list needs authentication and several REST
calls. To keep switching between hosts, models and views instant:

- **Session reuse.** Each host keeps its AtScale login token between requests.
- **Server cache.** Every list (models, aggregate models, aggregates, repos,
  branches, id maps, commit comparisons, Build's data sources and schema trees)
  is cached per host and per model for **2 hours**. Each one is also written to
  `workspace/cache/…json` with its load and expiry times, so you can see exactly
  what's being served, and a restarted API picks it up.
- **Start-up.** When the API starts it pre-loads every host whose last test
  didn't fail. **Test connection** re-captures that host.
- **Browser cache.** The browser keeps whatever you've already viewed for
  2 hours.
- **↻ Refresh.** In Manage and Promote, reloads the current host(s) from
  AtScale and shows how old the data is.
- **Invalidation.**
  - Deploy, undeploy, unlink, link, deactivate/reactivate, build and import
    clear the cache for the host they touched.
  - Editing, re-testing or removing a host clears that host's cache.
  - Saving the Git profile clears every host's cache.
- **Builds.** Aggregate lists that contain Building rows are cached for only
  5 seconds, so builds show progress.
- **Not cached:** preview and Test queries, which always go to the host. Model
  metadata can change between one deploy and the next.

Test history lives in `workspace/tests.db`, not the cache. Each execution is
written as soon as it finishes, so a restart mid-run keeps what's done (that
run is then marked failed). Background jobs (deploy, build, promote) are kept in
memory: finished jobs for an hour, at most 500.

---

## Architecture

```
web/  React 19 + TypeScript + Vite · TanStack Query (server state) · zustand (UI state)
  src/build/        Build: wizard panels, SML model store, preview (DMV / Freehand)
  src/components/   Manage, Promote, Settings
  src/test/         Test: run setup, results, compare results, compare model, database card
  └─ /api/* ──► api/  Flask
                 routes/      settings (hosts, git, cache) · objects (models, aggregates, jobs) · promote
                              build (sources, SML, preview, multi-host deploy) · testing (Test)
                 envs/        store.py (connections.yaml) · registry.py (host → backend, sessions, warm-up)
                 atscale/     client.py (AtScale REST) · github.py · git_ops.py (repo create + push)
                              backend.py (real host) · fake.py (demo host) · cached.py (cache wrapper)
                              preview.py (DMV metadata, MDX/SQL preview)
                 smlgen/      SML build / parse / validate (sml-cli)
                 promote/     diff.py (states + rules) · idmap.py (id ↔ name) · remap.py (payload rewrite)
                 testing/     generate.py (queries) · harness.py (execution) · model.py (DMV snapshot + diff)
                              results.py (result rows + variance) · store.py (SQLite)
                 cache.py     2 h cache + working-folder mirror
                 jobs.py      background jobs for deploy / build / promote (UI polls /api/jobs/:id)
reference/ps-utils              git submodule, read-only reference for porting
reference/PythonAtscaleUtility  git submodule, read-only reference for porting
```

### AtScale calls used (container hosts only)

| Purpose | Call |
|---|---|
| Authentication | Keycloak password grant, or `POST /v1/token` to exchange an API token for a JWT |
| Deployed models | `GET /wapi/p/projects/deployed`, `GET /v1/catalogs` (for `publishedAt`), `GET /wapi/p/catalog/{id}` |
| Repos | `GET/POST /wapi/p/repo`, `DELETE /wapi/p/repo/{id}` |
| Deploy repo@branch | `POST /v1/catalogs/deploy` `{repoUrl, gitToken, branch}` |
| Undeploy catalog | `DELETE /wapi/p/catalog/{catalogId}` |
| Catalog representation (id ↔ name) | `GET /v1/catalogs/{id}/export` |
| List aggregates | `GET /wapi/p/aggregate/definition?catalogId&modelId&page&limit` |
| Deactivate / reactivate | `PUT /v1/aggregates/definitions/{id}/block` · `/unblock` |
| Build | `POST /v1/aggregates-batch/catalogs/{c}/models/{m}?isFullBuild=` |
| Build history | `GET /wapi/p/aggregate/batch-history` |
| Export / import | `GET /v1/aggregates/export/…` · `POST /v1/aggregates/import/…` |
| Data warehouses, schema tree (Build) | `GET /wapi/p/data-warehouses`, `/wapi/p/data-sources/conn/{connectionId}/databases/…/tables/{t}/info` |
| DMV metadata, MDX queries (Preview, Test) | `POST /engine/xmla` (`MDSCHEMA_CUBES / DIMENSIONS / HIERARCHIES / LEVELS / MEASURES / PROPERTIES`, and MDX) |
| SQL queries (Preview, Test) | `POST /engine/query/submit` |

Sources: the AtScale Container API docs, ps-utils, and SML's API SDKs. See
`docs/BUILD_PLAN.md` for which source each call comes from, what has been
verified on a live host, and the design decisions.

### App API (for scripting)

All routes are under `/api`. List endpoints accept `?refresh=1` and return
`cachedAt`. Long-running calls return a job, and you poll `GET /api/jobs/:id`.

```
Settings        GET/POST /hosts · PATCH/DELETE /hosts/:id · POST /hosts/:id/test
                GET/PUT /git · POST /git/test · GET /git/repos · /git/repos/models · GET/DELETE /cache
Manage          GET /hosts/:id/models · /repos · /branches?url= · /aggregate-models · /aggregates?catalogId&modelId
                POST /hosts/:id/models/link · deploy · undeploy · unlink
                POST /hosts/:id/aggregates/build · deactivate · reactivate · GET /hosts/:id/aggregates/builds
Promote         POST /promote/diff · /promote/models · /promote/aggregates
Build           GET /hosts/:id/sources · /sources/:sourceId/schemas?search= · /build/repos
                GET /hosts/:id/preview/catalogs · /preview/metadata · POST /preview/query · /preview/freehand
                POST /sml/generate · validate · save · save-path · import · import-path · import-git · GET /sml/models
                POST /build/deploy {…model, hostIds} · GET /build/preflight?connection=&hostIds=
Test            GET /hosts/:id/test/cubes · POST /test/generate · /test/runs · /test/compare · /test/model-compare
                GET /test/runs · /test/runs/:id · /test/runs/:id.csv · /test/history?model=&query=&protocol=
                GET /test/store · POST /test/cleanup {olderThanDays, keepPerModel, model, dryRun} · /test/compact
Jobs            GET /jobs/:id
```

---

## Known limits

- **Container hosts only.** Installer-style hosts (`:10500`/`:10502` URLs with
  `orgId`) aren't supported.
- **Deploy needs `POST /v1/catalogs/deploy`.** Older container builds don't
  have it and answer 404 ("Cannot POST /v1/public/catalogs/deploy"), so
  Manage, Promote and Build can't deploy to them. The repo still gets attached.
- **Deploy needs a real Keycloak username and password**, not just an API
  token. Accounts that only sign in through SSO can't deploy.
- **Deploy is by branch, not commit.** A deploy always gets the branch's head
  commit.
- **Versions of catalogs deployed outside this app are inferred** from the
  publish time (shown with `~`).
- **Build models one physical table per dimension, with one hierarchy each.**
  Richer patterns only partly import; use AtScale's own modeler for those.
- **A Build deploy needs the same warehouse connection id on every target host**
  (for example `Postgres14`). Hosts without it are skipped.
- **The DMV doesn't say which dimensions a measure relates to**, and AtScale
  rejects `MDSCHEMA_MEASUREGROUP_DIMENSIONS`. So Compare model can call two
  models identical when one of them can't answer some queries. The result
  compare still catches it, as failed queries.
- **Generated level breakdowns select every metric** (as ps-utils does), so one
  metric that isn't related to a dimension fails every breakdown on it.
- **Single process.** Sessions and background jobs live in memory. Test history
  and the list cache are on disk.

## Related

- `CLAUDE.md`: conventions for working on this repo with Claude Code
- `docs/BUILD_PLAN.md`: the call map, decisions and open items
- `docs/handoff-ps-utils-aggregate-import.md`: the aggregate import fix
  requested upstream in ps-utils
- `docs/handoff-ps-utils-query-testing.md`: query generation and harness fixes
  for ps-utils, found while building Test
- Build replaces the standalone `sml-wizard` repo, which is being deprecated
