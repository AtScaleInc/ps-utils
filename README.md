# AtScale Environment Manager

One console for many AtScale **container** hosts, grouped into three
environments: **Dev**, **Test-QA** and **Prod**. From one screen you can see
what each host runs, manage its semantic models and aggregates, and promote
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

---

## What it does

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
- **Cache.** Shows what's in the working folder (see *Caching*) and lets you
  clear it.

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
`web/`) automatically.

### Start

```bash
./start.sh
```

- API: http://127.0.0.1:5050, log in `.logs/api.log`
- Web: http://127.0.0.1:5174, log in `.logs/web.log`

Open the web URL, go to **Settings**, save and test the **Git** profile, then
add hosts to each group and **Test connection**.

`start.sh` first stops anything already bound to its two ports. The defaults
are deliberately **not** sml-wizard's 5000/5173, so both apps can run at the
same time. To use other ports:

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
- Demo cache goes to `workspace/cache-demo/`.
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
- **Single user, single process.** Jobs and sessions live in memory; the cache
  also has a copy on disk.

## Related

- `CLAUDE.md`: conventions for working on this repo with Claude Code
- `docs/BUILD_PLAN.md`: the call map, decisions and open items
- `docs/handoff-ps-utils-aggregate-import.md`: the matching fix requested
  upstream in ps-utils
