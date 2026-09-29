# CLAUDE.md — AtScale Env Manager conventions

See [docs/BUILD_PLAN.md](docs/BUILD_PLAN.md) for the build plan, the source of
every ported call, and the open gaps. UI spec: the handoff mockup
`Environment Manager.dc.html` (BUILD_INSTRUCTIONS.md §5 business rules are
authoritative).

## Project in one paragraph

One console for many AtScale **container** hosts, grouped into Dev / Test-QA /
Prod. Top tabs: **Build · Manage · Test · Promote** (+ Settings); the left rail
shows the current tab's sections (Build: Discovery · Develop · Preview). Build is the SML wizard (merged from the now-deprecated
sml-wizard repo): browse a host's warehouse, model on a canvas, generate SML, push
it to Git once and deploy it to one or many hosts. Test generates queries from a
deployed model (ps-utils generate-queries-from-model), runs them on several hosts
(execute-atscale-query-harness) and compares baseline vs candidate - model (DMV)
and result values - before promoting. Settings registers hosts + a
shared Git profile; Manage works on one host's
models (link / deploy / unlink) and aggregates (deactivate / reactivate, full /
incremental build); Promote diffs a source host against a target and moves models
(repo attach + deploy) or system aggregates (export → filter → import).

## Repo layout

- `/api` — Flask (Python) REST backend. Venv lives outside the repo at
  `~/Development/venv/atscale-env-manager` (`.venv` marker file at repo root holds
  the name — don't create `.venv/` inside the repo).
  - `envs/store.py` — hosts + Git profile in `api/connections.yaml` (gitignored),
    ps-utils connection shape (`connections.<id>.atscale: {url, username, password,
    apiToken, insecure}`) + `env/label/status/lastChecked/links`. API responses
    never echo secrets (`hasPassword` / `hasToken`). `profile_to_connection()` is
    the single adapter to the ps-utils entry shape.
  - `atscale/client.py` — auth copied from sml-wizard; catalog + aggregate calls
    are container-only (see BUILD_PLAN.md call map). Deploy uses
    `POST /v1/catalogs/deploy` (AtScale compiles SML); builds without it (404,
    e.g. 34.x) fall back to `atscale/legacy_deploy.py`: clone repo@branch,
    compile the catalog XML locally (`smlgen/catalog_xml.py`, restored from
    sml-wizard) and POST `/wapi/git/deploy/catalog` with a cookie session.
  - `atscale/github.py` — repo discovery, branches, commits; a model's version is
    the Git commit it was built from.
  - `atscale/backend.py` — `RealBackend` normalises AtScale responses into UI rows.
    `atscale/fake.py` — in-memory demo backend (`ENV_MANAGER_FAKE=1`), seeded with
    the mockup's data; the API tests run against it.
  - `promote/diff.py` — §5 diff states and promotion filters (pure, unit-tested).
  - `smlgen/` — SML generation / parse / validate, copied from sml-wizard. New
    Python logic, not a ps-utils port: the user declares structure on the canvas.
    The `atscale-sml-model-generator` skill's rules are authoritative for SML
    shape — cite the rule number when implementing one. Hierarchies are dynamic
    (`dimRole: 'level' | 'secondary' | 'alias'`, ordered by `levelOrder`), never
    fixed L1/L2/L3. sml-wizard's catalog-XML compiler is kept only for the
    legacy deploy fallback.
  - `routes/build.py` — Build endpoints. Host-bound calls are
    `/hosts/<id>/sources|preview|build/repos`; `/schemas` returns schema names
    at once and lists tables per schema in the background (the UI polls while
    `loading`); columns come per table from `/columns`, never the whole tree; `POST /build/deploy` pushes to Git
    once, then `deploy_branch` per host (skips hosts without the model's
    `asConnection`). `registry.source_api(id)` gives the host's `AtScaleClient`,
    or `fake.FakeSourceApi` in demo mode — keep the two in sync (a test checks).
  - `testing/` + `routes/testing.py` — the Test tab. `generate.py` (ps-utils
    query generation, but level NAME in MDX brackets), `harness.py` (query
    harness: XMLA via /engine/xmla, SQL via /engine/query/submit, 180 s timeout),
    `model.py` (DMV snapshot + model diff), `results.py` (result rows + variance;
    duplicate keys compared as multisets), `store.py` (SQLite `workspace/tests.db`:
    runs, queries, model snapshots, executions with zlib result rows). Retention:
    `ENV_MANAGER_TEST_KEEP` per model (100), `ENV_MANAGER_TEST_MAX_AGE_DAYS` (90);
    `ENV_MANAGER_TEST_MAX_ACTIVE` concurrent runs (3, else 429). ps-utils bugs
    found here: `docs/handoff-ps-utils-query-testing.md`.
  - `discovery/` + `routes/discovery.py` — Build › Discovery: profile one
    warehouse table before modeling. `profile.py` runs its SQL through
    `POST /wapi/p/data-sources/conn/{id}/query/sample` (engine wraps it in
    `LIMIT 10` and caches by query text - so one aggregate row or a
    ROW_NUMBER-ranked top 10 per query, values read by position, a comment
    nonce per recompute); sample rows + AtScale statistics come from engine
    `/engine/v1/datasources/{id}/sample-data|statistics` (ported from
    mcp-develop). `store.py` keeps results in SQLite `workspace/discovery.db`
    (demo: `discovery-demo.db`): a profile runs once per table and again only on
    Re-profile; `ENV_MANAGER_DISCOVERY_KEEP` runs per table (20) feed drift.
    Demo mode runs the same SQL on an in-memory SQLite (`fake.FakeSourceApi`).
  - `jobs.py` keeps finished jobs 1 h, at most 500.
  - `atscale/preview.py` — cube preview (MDX/SQL), ported from PythonAtscaleUtility.
    Levels of one hierarchy are Hierarchize'd, never CrossJoined with themselves.
    `atscale/git_ops.py` — create the model's GitHub repo + push (GitPython).
- `/web` — React 19 + TypeScript + Vite, TanStack Query for server state, zustand
  for UI state. Theme tokens in `web/src/theme.css` (sml-wizard's dark theme).
  - `web/src/build/` — the wizard (panels, `modelStore`, `client.ts`). Its CSS is
    scoped under `.wiz` (`build.css`) so its `.btn` / `.eyebrow` / `.field` don't
    leak into theme.css. `client.ts` resolves the Build host via `setBuildHost`.
  - `sml-cli` is a pinned devDependency; `smlgen/validate.py` runs
    `web/node_modules/.bin/sml-cli` (falls back to `npx --yes`).
- `/reference/ps-utils` — git submodule (`develop`), AtScaleInc/ps-utils.
- `/reference/PythonAtscaleUtility` — git submodule, rwidjaja/PythonAtscaleUtility:
  GitHub repo discovery (its aggregate calls are installer-mode, not used).
- Also consulted (outside the repo): `~/Development/Atscale/SML-develop` (api-sdk,
  public-api-sdk, postman) and `~/Development/Atscale/engine-develop` (routes).

## Caching

- **Working folder:** every cached list is mirrored as JSON under
  `workspace/cache/` (demo mode: `workspace/cache-demo/`), gitignored; Settings →
  Cache lists and clears it. A restarted API serves unexpired files from disk.
- **API:** `api/cache.py` holds every host's lists (models, aggregate models,
  aggregates, repos, branches, commit compares) for `ENV_MANAGER_CACHE_TTL`
  (default 2 h). `?refresh=1` (or `refresh: true` on /promote/diff) reloads.
  `atscale/cached.py` wraps each backend: writes invalidate the host's entries.
  Editing, re-testing or removing a host drops its cache and AtScale session
  (`registry.forget_host`); saving the Git profile drops all host caches.
  Aggregate lists containing Building rows are cached for 5 s only.
- **Session:** one `AtScaleClient` per host is reused (JWT kept) until its
  connection settings change.
- **Start-up:** `registry.warm_cache()` preloads every non-failed host.
- **Web:** TanStack Query staleTime/gcTime 2 h; the ↻ Refresh button calls the
  refresh endpoints for the current host(s).

## Rules

- **Submodules are read-only porting references.** Never executed at runtime, never
  edited. Update only with `git submodule update --remote reference/<name>`.
- **Port, don't reimplement from memory.** Every ported function carries a comment
  naming its source file + function. Grep the submodules for exact paths; if a call
  has no source, raise `NotPorted` (→ HTTP 501 with `gap: true`) and flag it to the
  user instead of guessing an endpoint.
- **Container hosts only.** No installer `:10500/:10502` / orgId paths.
- **`insecure` TLS flag** per host (default true, self-signed container certs) —
  same as sml-wizard; it maps to `verify=not insecure` on every request.
- **Hostname only.** Hosts are containers: URL is always `https://{hostname}`;
  `normalize_hostname()` strips any scheme / port / path the user pastes.
- **Deploy needs real Keycloak username + password** (Design Center session cookie
  via `AtScaleEnvironment._acquire_session_cookie`); SSO-only accounts can't deploy.
- Only **system** aggregates are promotable; user-defined ones are blocked in UI and API.
- **Build is a quick-start modeler**, not a replacement for AtScale's own. Weigh
  requests that only serve patterns Design Center covers (multi-table dimension
  hierarchies, multi-hierarchy dimensions, MDX calculated metrics) against that
  scope and flag the tradeoff before building them.
- Warehouse browsing goes through AtScale's metadata API
  (`/wapi/p/data-sources/conn/{connectionId}/...`), never a direct warehouse connection.
- `calculation_method` is an exact enum string (`sum`, `average`, `minimum`,
  `maximum`, `count distinct`, `count non-null`, `sum distinct`, ...).
- Runtime tools are dependencies (package.json / requirements.txt); porting
  references stay submodules (the npm ps-utils ships only dist/, not the src/*.ts
  the porting comments cite).

## Running

- `./start.sh` — API :5050 + Vite :5174 (not sml-wizard's ports), logs in `.logs/`.
- `ENV_MANAGER_FAKE=1 ./start.sh` — same, against the demo backend
  (`api/connections.fake.yaml`).
- `cd api && ~/Development/venv/atscale-env-manager/bin/python -m pytest tests -q`
- `cd web && npm run build`
- Build's working copies: `workspace/models/<model>` (demo: `workspace/models-demo/`).
- Test history: `workspace/tests.db` (demo: `tests-demo.db`); Settings → Cache & Database cleans it up.
- Discovery profiles: `workspace/discovery.db` (demo: `discovery-demo.db`); the same Settings page cleans it up (older than N days / beyond newest N per table).
