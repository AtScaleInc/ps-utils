# Build plan — AtScale Env Manager

Source brief: handoff `BUILD_INSTRUCTIONS.md` + `Environment Manager.dc.html`.
This file records what was built, where each AtScale call was ported from, and the
decisions that differ from the brief.

## Decisions taken with the user (2026-09-26)

1. **Aggregates follow ps-utils develop (e60f808+) and the Container API docs.**
   An older ps-utils copy (sml-wizard's, c8058c4) had no aggregate operations;
   PythonAtscaleUtility's aggregate calls are installer-mode and are not used.
2. **Hosts are stored in `api/connections.yaml`** (gitignored, mode 0600), not a new
   JSON store. sml-wizard has no JSON profile store to reuse; it uses
   connections.yaml. The Git profile is sml-wizard's `connections.git.git` block.
3. Link dialog repo discovery follows PythonAtscaleUtility (repos with a root
   `catalog.yml`).

## Call map (container hosts only)

Sources: Container API docs (documentation.atscale.com/container-api), ps-utils
(`reference/ps-utils`, develop), SML-develop api-sdk / public-api-sdk, the
engine repo. Reads verified live on docker-atscale (2026-09-26).

| Feature | Call | Source | Live |
|---|---|---|---|
| Auth | Keycloak / `POST /v1/token` (API token → JWT) | sml-wizard ← ps-utils | ✓ |
| Test connection | `GET /wapi/p/projects/deployed` | ps-utils `ListModelsRequest` | ✓ |
| Deployed models | `GET /wapi/p/projects/deployed` + `GET /v1/catalogs` (publishedAt) | ps-utils, docs | ✓ |
| Repos / attach / detach | `GET/POST /wapi/p/repo`, `DELETE /wapi/p/repo/{id}` | ps-utils, SML api-sdk RepoApi | ✓ list |
| Deploy repo@branch | `POST /v1/catalogs/deploy {repoUrl, gitToken, branch}` (AtScale compiles SML) | docs, SML public-api-sdk | write — not yet run |
| Undeploy catalog | `DELETE /wapi/p/catalog/{catalogId}` (Design Center "Undeploy") | SML api-sdk CatalogApi, postman | write — not yet run |
| List aggregates | `GET /wapi/p/aggregate/definition?catalogId&modelId&page&limit` | SML api-sdk AggregateApi | ✓ matches UI response 20/20 |
| Deactivate / reactivate | `PUT /v1/aggregates/definitions/{id}/block` · `/unblock` | docs, SML public-api-sdk (engine: `DELETE/PUT /aggregates/definitionId/{id}?block|unblock`) | write — not yet run |
| Build full / incremental | `POST /v1/aggregates-batch/catalogs/{c}/models/{m}?isFullBuild=` | ps-utils, docs | write — not yet run |
| Build history | `GET /wapi/p/aggregate/batch-history` | ps-utils | ✓ |
| Export / import | `GET /v1/aggregates/export/…`, `POST /v1/aggregates/import/…` | ps-utils, docs | ✓ export |
| Branches / commits | GitHub `branches`, `commits`, `compare` | new | ✓ |

The public `GET /v1/aggregates` ignores page/size on this build (always 10
rows, no total), hence the internal definition list above.

## Decisions (2026-09-26, second pass)

- **Container only.** Installer (`:10500/:10502`, orgId) paths removed.
- **Version = Git commit.** AtScale stores no commit for a deployment. The app
  records the branch head it deployed (`connections.<host>.deployments`); for
  catalogs deployed elsewhere it infers the last commit on the branch at
  `publishedAt` (marked `~` in the UI). Diffs use GitHub compare:
  identical / ahead (Update) / behind (Target newer) / diverged.
- **Promotion deploys a chosen branch** on the target (default: the source's
  branch). Deploy is branch-based, so the target gets that branch's *head*.
- **Deploy/undeploy are per catalog** (AtScale has no per-model undeploy).
  Unlink = undeploy (drops aggregates) + detach repo; Undeploy keeps the link.
- **Aggregate identity across hosts** = fingerprint of the export `planJson`
  columns (key ids, attribute names, aggregation functions; aliases and model
  ids ignored). Definitions not in the export (no active build) fall back to
  the attribute signature and are not promotable ("Not built · can't export").
  "Replaces inactive" deletes the blocked target copy, then imports.
- Invalid aggregates show AtScale's reason (e.g. connection removed).

## Open items

1. Run the write paths once on a dev host: block/unblock, build, deploy,
   undeploy, import (needs a second host for promotion).
2. Import needs the identical model id on the target; ids are UUIDv5 from SML,
   so the same catalog deployed from Git matches. A differently-named catalog
   is skipped with a reason.
