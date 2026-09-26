# CLAUDE.md — AtScale Env Manager conventions

See [docs/BUILD_PLAN.md](docs/BUILD_PLAN.md) for the build plan, the source of
every ported call, and the open gaps. UI spec: the handoff mockup
`Environment Manager.dc.html` (BUILD_INSTRUCTIONS.md §5 business rules are
authoritative).

## Project in one paragraph

One console for many AtScale **container** hosts, grouped into Dev / Test-QA /
Prod. Settings registers hosts + a shared Git profile; Manage works on one host's
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
    `POST /v1/catalogs/deploy` (AtScale compiles SML), so there's no local compiler.
  - `atscale/github.py` — repo discovery, branches, commits; a model's version is
    the Git commit it was built from.
  - `atscale/backend.py` — `RealBackend` normalises AtScale responses into UI rows.
    `atscale/fake.py` — in-memory demo backend (`ENV_MANAGER_FAKE=1`), seeded with
    the mockup's data; the API tests run against it.
  - `promote/diff.py` — §5 diff states and promotion filters (pure, unit-tested).
- `/web` — React 19 + TypeScript + Vite, TanStack Query for server state, zustand
  for UI state. Theme tokens in `web/src/theme.css` (sml-wizard's dark theme).
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

## Running

- `./start.sh` — API :5050 + Vite :5174 (not sml-wizard's ports), logs in `.logs/`.
- `ENV_MANAGER_FAKE=1 ./start.sh` — same, against the demo backend
  (`api/connections.fake.yaml`).
- `cd api && ~/Development/venv/atscale-env-manager/bin/python -m pytest tests -q`
- `cd web && npm run build`
