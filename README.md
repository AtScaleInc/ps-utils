# AtScale Environment Manager

One console for many AtScale **container** hosts, grouped into three
environments: **Dev**, **Test-QA** and **Prod**. From one screen you can build
a new semantic model and deploy it to several hosts at once, see what each host
runs, manage its semantic models and aggregates, and promote
models and system aggregates from one environment to the next, such as Dev → QA
→ Prod. It checks what already exists on the target and only moves what's new.

```
┌─────────────── Settings ───────────────┐   ┌──────── Manage ────────┐   ┌──────────── Promote ────────────┐
│ Git profile (shared)                   │   │ pick group → host      │   │ source host  ─┐                 │
│ Dev   │ Test-QA │ Prod                 │ → │  Models:  link, deploy │ → │  diff states  ├─ drag to stage  │
│ hosts │ hosts   │ hosts  + credentials │   │   undeploy, unlink     │   │ target host  ─┘  promote        │
│ test connection                        │   │  Aggregates: build,    │   │  (Prod always asks to confirm)  │
└────────────────────────────────────────┘   │   deactivate/reactivate│   └─────────────────────────────────┘
                                             └────────────────────────┘
```

The top tabs are **Build · Manage · Test · Promote**, with **Settings** on the
right. The left rail lists the current tab's sections: Model / Preview for
Build; Models / Aggregates for Manage and Promote; Run / Results / Compare
results / Compare model for Test.

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
- **Deploy.** Generates the SML and shows it for review. **Validate with
  sml-cli** is optional. **Deploy to** lists every host by group; the Build
  host is checked by default. The SML is pushed to Git once: a new model gets
  `github.com/<git user>/<model>`, and a loaded one goes back to its own repo
  and branch. Then each checked host attaches the repo and deploys that branch,
  using the same call Promote uses. A host without the model's data warehouse
  connection is greyed out, and results are reported per host.
- **Preview.** Browse a deployed cube's dimensions and measures and run an MDX
  or SQL query against it on the Build host.

Build is a quick-start modeler, not a replacement for AtScale's own. Multi-table
dimension hierarchies and multi-hierarchy dimensions only partly import.

### Settings: hosts, credentials and Git

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
  deploying and promoting models are disabled until it works.
- **Cache & Database** (its own Settings section) shows the list cache in the
  working folder (see *Caching*) and lets you clear it, next to the Test
  history database and its clean-up.

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

Test is ps-utils' *Testing / Query Processing* group, for several hosts at once.

- **Run.** Pick a host and one of its deployed models. The app generates one
  grand-total query per metric and one breakdown per hierarchy level
  (`generate-queries-from-model`), each in MDX and SQL. Pick the hosts to run
  on (a host counts as having the model when it has a cube with the same
  name), which queries to run, MDX and/or SQL, workers per host, and the
  aggregate and cache flags. The queries run like `execute-atscale-query-harness`:
  status, time, row count and checksum per query, and every query's result
  rows are kept.
- **Results.** Runs are grouped by model, newest first. A run's detail shows a
  **promotion check** for each host against a baseline host: is the model (DMV)
  identical, are all results identical, what failed, how the time compares.
  Opening a query shows its text, any errors, and its **history** across past
  runs.
- **Compare results.** Baseline vs candidate, each picked as model → run →
  host. That can be two hosts in one run (Dev vs QA), or the same host in two
  runs (before and after a redeploy). Queries are matched by name, rows by
  member, and values per measure, within a tolerance you pick. You get a
  verdict, then each problem query with its variance table (member, measure,
  baseline, candidate, Δ, Δ%) and any rows found on only one side. The
  comparison exports as CSV.
- **Compare model.** A live DMV diff of two deployed models. Metrics and levels
  are listed as only in baseline, only in candidate, or changed, with the
  baseline → candidate value.
- **Clean up** is in **Settings → Cache & Database**. You can see stored runs
  per model, delete runs older than N days and/or beyond the newest N per model
  (with a preview count first), and compact the file. Runs are also pruned
  automatically after every run (100 per model, 90 days by default), and at
  most 3 runs execute at once.

Runs are stored in one SQLite file, `workspace/tests.db`.

### Promote

The source (group and host) is on top and the target is below. Choose
**Models** or **Aggregates** in the sidebar.

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

### How aggregate promotion works across hosts

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
your PATH. The first run installs the frontend packages (`npm install` in
`web/`) automatically. That also installs the pinned `sml-cli` that Build's
**Validate** uses. If you pulled the merge into an existing checkout, run
`npm install` in `web/` once, and install `api/requirements.txt` again to get
GitPython.

### Start

```bash
./start.sh
```

- API: http://127.0.0.1:5050, log in `.logs/api.log`
- Web: http://127.0.0.1:5174, log in `.logs/web.log`

Open the web URL, go to **Settings**, save and test the **Git** profile, then
add hosts to each group and **Test connection**.

`start.sh` first stops anything already bound to its two ports. To use other ports:

```bash
API_PORT=5060 WEB_PORT=5184 ./start.sh
```

### Demo mode (no AtScale host needed)

```bash
ENV_MANAGER_FAKE=1 ./start.sh
```

This runs against an in-memory backend seeded with sample data: five hosts
across the three groups, seven models, and aggregates with duplicates, stale
rows and user-defined rows. Every screen and rule can be tried here.

- Demo hosts are stored in `api/connections.fake.yaml`.
- Demo cache goes to `workspace/cache-demo/`, and Build's saved models go to `workspace/models-demo/`.
- In Build, every demo host has a `PostgresDB` warehouse except prod-west, so
  you can see a deploy skip a host. Deploy doesn't really push to Git, and
  Preview and Load from Git need a real host.
- **Settings → Reset demo data** restores the seed.

### Tests and build

```bash
cd api && ~/Development/venv/atscale-env-manager/bin/python -m pytest tests -q
```

```bash
cd web && npm run build
```

The API tests cover:

- the diff states
- duplicate filtering and system-only filtering
- model matching by name, and name-based aggregate fingerprints across hosts
  with different ids
- payload remapping, including the import schema's required fields
- hostname normalisation
- the credential store round-trip (secrets masked)
- caching and its disk mirror
- full promote flows against the demo backend

---

## Configuration and data

| Path | What | In Git? |
|---|---|---|
| `api/connections.yaml` | Hosts, credentials, Git token. Written by Settings, file mode 0600. See `api/connections.yaml.sample`. | **no** (gitignored) |
| `api/connections.fake.yaml` | Demo-mode hosts | no |
| `workspace/cache/` | Working folder: every cached list as readable JSON | no |
| `workspace/cache-demo/` | The same, in demo mode | no |
| `.logs/` | API and web logs from `start.sh` | no |

`connections.yaml` uses the ps-utils connection layout. Each host is an entry
with an `atscale:` block, plus `env`, `label`, `status`, `links` (repos linked
through the app) and `deployments` (the commit this app deployed per catalog).
The shared Git profile is `connections.git.git`, the same as in sml-wizard.

Environment variables:

| Variable | Default | Purpose |
|---|---|---|
| `API_PORT` / `WEB_PORT` | `5050` / `5174` | Ports used by `start.sh` |
| `ENV_MANAGER_FAKE` | unset | `1` runs the demo backend |
| `ENV_MANAGER_CACHE_TTL` | `7200` | How long cached lists stay valid, in seconds |
| `ENV_MANAGER_WORKSPACE` | `./workspace` | Location of the working folder |
| `ENV_MANAGER_CONNECTIONS_FILE` | `api/connections.yaml` | Location of the credential store |

### Caching

Container calls are slow: each list needs authentication and several REST
calls. To keep switching between hosts, models and views instant:

- **Session reuse.** Each host keeps its AtScale login token between requests.
- **Server cache.** Every list (models, aggregate models, aggregates, repos,
  branches, id maps, commit comparisons) is cached per host and per model for
  **2 hours**. Each one is also written to `workspace/cache/…json` with its
  load and expiry times, so you can see exactly what's being served, and a
  restarted API picks it up.
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

---

## Architecture

```
web/  React 19 + TypeScript + Vite · TanStack Query (server state) · zustand (UI state)
  └─ /api/* ──► api/  Flask
                 routes/      settings (hosts, git, cache) · objects (models, aggregates, jobs) · promote
                 envs/        store.py (connections.yaml) · registry.py (host → backend, sessions, warm-up)
                 atscale/     client.py (AtScale REST) · github.py · backend.py (real host)
                              fake.py (demo host) · cached.py (cache wrapper)
                 promote/     diff.py (states + rules) · idmap.py (id ↔ name) · remap.py (payload rewrite)
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

Sources: the AtScale Container API docs, ps-utils, and SML's API SDKs. See
`docs/BUILD_PLAN.md` for which source each call comes from, what has been
verified on a live host, and the design decisions.

### App API (for scripting)

All routes are under `/api`. List endpoints accept `?refresh=1` and return
`cachedAt`. Long-running calls return a job, and you poll `GET /api/jobs/:id`.

```
GET/POST        /hosts                    PATCH/DELETE /hosts/:id    POST /hosts/:id/test
GET/PUT         /git                      POST /git/test             GET /git/repos · /git/repos/models
GET/DELETE      /cache
GET             /hosts/:id/models · /repos · /branches?url= · /aggregate-models · /aggregates?catalogId&modelId
POST            /hosts/:id/models/link · deploy · undeploy · unlink
POST            /hosts/:id/aggregates/build · deactivate · reactivate     GET /hosts/:id/aggregates/builds
POST            /promote/diff · /promote/models · /promote/aggregates
GET             /hosts/:id/sources · /sources/:sourceId/schemas?search= · /build/repos
GET/POST        /hosts/:id/preview/catalogs · /preview/metadata · /preview/query
POST            /sml/generate · validate · save · save-path · import · import-path · import-git   GET /sml/models
POST            /build/deploy {…model, hostIds}     GET /build/preflight?connection=&hostIds=
GET             /hosts/:id/test/cubes            POST /test/generate · /test/runs · /test/compare · /test/model-compare · /test/cleanup
GET             /test/runs · /test/runs/:id · /test/runs/:id.csv · /test/history?model=&query=&protocol= · /test/store
GET             /jobs/:id
```

---

## Known limits

- **Container hosts only.** Installer-style hosts (`:10500`/`:10502` URLs with
  `orgId`) aren't supported.
- **Deploy needs a real Keycloak username and password**, not just an API
  token. Accounts that only sign in through SSO can't deploy.
- **Deploy is by branch, not commit.** A deploy always gets the branch's head
  commit.
- **Versions of catalogs deployed outside this app are inferred** from the
  publish time (shown with `~`).
- **Build models one physical table per dimension, with one hierarchy each.**
  Richer patterns only partly import; use AtScale's own modeler for those.
- **A Build deploy needs the same warehouse connection id on every target host**
  (for example `PostgresDB`). Hosts without it are skipped.
- **The DMV doesn't say which dimensions a measure relates to**, so Compare
  model can call two models identical when one of them can't answer some
  queries. The result compare still catches it as failed queries.
- **Single user, single process.** Jobs and sessions live in memory; the cache
  also has a copy on disk.

## Related

- `CLAUDE.md`: conventions for working on this repo with Claude Code
- Build replaces the standalone `sml-wizard` repo, which is being deprecated
- `docs/BUILD_PLAN.md`: the call map, decisions and open items
- `docs/handoff-ps-utils-aggregate-import.md`: the matching fix requested
  upstream in ps-utils
- `docs/handoff-ps-utils-query-testing.md`: ps-utils query generation / harness
  fixes found while building Test
