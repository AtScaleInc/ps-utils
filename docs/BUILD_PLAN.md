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
- **Ids never match across hosts** (agreed 2026-09-26). Each host that deploys
  the same SML generates its own catalog / model / key / reference ids, so
  everything is matched by *name*: models by deployed name (then the target's
  ids are looked up), aggregates by a plan fingerprint whose key and reference
  ids are first translated to names. The per-host id <-> name map comes from
  `GET /v1/catalogs/{id}/export` (`promote/idmap.py`: keyed-attribute name,
  sort-key attribute, dataset column, or `ref:<naming>:<attribute>` for
  role-play/join refs) and is captured on Test connection and at start-up into
  the working folder (`workspace/cache/host/<id>/ids/<catalog>.json`).
- **Aggregate promotion rules (agreed 2026-09-26):** system-defined, `active`
  and exportable on the source; the same model (by name) deployed on the
  target; no active duplicate there. Before import the export is remapped
  (`promote/remap.py`): catalog/model ids (incl. inside planJson) -> target's,
  plan key/reference ids -> target ids with the same names (aggregate skipped,
  names listed, if the target model lacks one), instance ids -> the target
  counterpart's instance (new ones keep the source's: the import schema
  requires non-null strings, the engine ignores them),
  connectionId -> the target model's connection (`/wapi/p/catalog/{id}`
  connection_ids; skipped if ambiguous). An inactive target copy that AtScale
  keeps on import is reactivated (unblock) - nothing is deleted.
- **Promoting to Prod is always confirmed** (no setting to turn it off).
- Invalid aggregates show AtScale's reason (e.g. connection removed).

## Open items

1. Run the write paths once on a dev host: block/unblock, build, deploy,
   undeploy, import (needs a second host for promotion).
2. Only one real host exists so far (dev-docker and qa-host-2 are the same
   server); verify remap + import across two real hosts once available.
