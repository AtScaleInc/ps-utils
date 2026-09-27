# Handoff: fix `atscale-import-aggregates` in ps-utils for cross-host promotion

For a Claude Code session working in the **ps-utils** repo
(`AtScaleInc/ps-utils`, branch `develop`). Follow that repo's `CLAUDE.md`, and
keep README / docs/NODE.md / docs/ACTIONS.md / action.yml in sync with any
parameter change. Regenerate the REST and GraphQL docs via `npm run build`.

## Problem

`atscale-import-aggregates` (`src/operations/atscale-import-aggregates/AtScaleImportAggregatesOperation.ts`)
reads an export file and posts it unchanged to
`POST /v1/aggregates/import/catalogs/{catalogId}/models/{modelId}` through
`ImportAggregatesRequest` in `src/services/AtScaleRestClientService.ts`. That
works when a payload is re-imported into the **same** host. It fails, or would
import broken definitions, when promoting an export from host A (e.g. Dev)
into host B (e.g. Prod).

### 1. Import rejects null or missing instance ids (confirmed on a real host)

```
AtScale API error 400 for https://<host>/v1/aggregates/import/catalogs/<c>/models/<m>:
{"statusCode":400,"message":"Validation failed. aggregates,values,0,activeInstanceId:
Expected string, received null. aggregates,values,0,latestInstanceId: Expected string,
received null. ...","error":{"cause":"BadRequestException", ... "ZodParamValidationPipe" ...}}
```

The two SML API schemas disagree:

- **Export** (`SML/apps/api/src/public/aggregate/models/export-aggregate.dto.ts`)
  marks `activeInstanceId` / `latestInstanceId` as `z.string().optional()`.
- **Import** (`SML/apps/api/src/public/aggregate/models/import-aggregate.dto.ts`)
  requires `z.string()` for each value's `activeInstanceId`, `baseType`,
  `catalogId`, `connectionId`, `createdAt`, `id`, `latestInstanceId`, `modelId`,
  `subType` and `triggeringQueryId`, plus `blocked`/`promoted` as booleans,
  `notes.dimensional` as a boolean, and `planJson`. At the top level it
  requires `atScaleExportVersion`, `exportModelId`, `exportCatalogId`,
  `exportTimestamp`, and `exportSummary.connectionIds {count, values}`.

So a valid export can fail import validation as-is.

The engine side (`engine/modules/server/aggregates/.../AggregateImportHelper.scala`)
never reads the instance ids. It creates new definitions. That means any
string satisfies the check: keep the source's instance ids, fall back to `""`,
and never send `null`.

### 2. Ids differ per host, so a straight re-post can't target another host

Each host that deploys the same SML generates its **own** catalog id, model id,
key ids and reference ids. An export from host A carries A's ids in:

- `exportCatalogId`, `exportModelId`
- each value's `catalogId`, `modelId`
- each value's `planJson`:
  - the model id, in every `{"model": {"id": ...}}`
  - key ids, in `{"type": "key", "id": ...}`
  - role-play and join reference ids, in `{"type": "reuse-ref", "ref-id": ...}`
- `activeInstanceId` / `latestInstanceId`
- `connectionId` and `exportSummary.connectionIds`, when B's warehouse
  connection id differs

Matching by id **never works across hosts**. Everything has to be matched by
name, and then the target's id is looked up.

## Required changes

### A. Normalise the payload before posting (always, including same-host)

In `ImportAggregatesRequest.body()`, or in a helper the operation calls before
`importAggregates`, go through every `aggregates.values[i]`:

- `activeInstanceId` = existing, else `latestInstanceId`, else `""`
- `latestInstanceId` = existing, else `activeInstanceId`, else `""`
- Any of the required string fields listed above that is missing or null
  becomes `""`.
- Keep `aggregates.count` equal to `values.length`.

This alone fixes the 400 when importing an export back into the same host.

### B. Remap to the target model when it isn't the export's model

When the target `catalogId`/`modelId` (resolved by
`resolveCatalogAndModel`) differ from the payload's
`exportCatalogId`/`exportModelId`:

1. **Model must be the same model.** Find the target model by its deployed
   name (`GET /wapi/p/projects/deployed` →
   `projects[].models[].caption|name`). If there's no model with that name on
   the target, fail with a clear error; don't import.
2. **Catalog and model ids.** Set `exportCatalogId`/`exportModelId` and each
   value's `catalogId`/`modelId` to the target's. Replace every exact-string
   occurrence of the source catalog and model id inside `planJson`. It can be
   an object or a JSON string, so handle both.
3. **Key and reference ids, by name.** Build an `id → name` map on the source
   and a `name → id` map on the target from each host's catalog
   representation: `GET /v1/catalogs/{catalogId}/export` with
   `Accept: application/json`. Name each id this way:
   - **Key id** (`attributes.attribute-key[].id`), in order of preference:
     1. `attr:<keyed-attribute.name>` where `keyed-attribute.key-ref == id`
     2. `sort:<keyed-attribute.name>` where
        `keyed-attribute.properties.ordering.sort-key.key-ref.id == id`
     3. `col:<owning named object>:<column>` for `{column, id}` bindings
        inside data sets. If one id has several bindings, join them sorted
        with `|`.
   - **Reference id**: any object with `ref-id` and `attribute-id`, i.e.
     `new-ref` in cube data sets and `keyed-attribute-ref` in dimension
     levels, is named `ref:<ref-naming or "">:<name of the keyed-attribute
     whose id == attribute-id>`. If one ref id gets several names, use the
     first in sorted order.
   - If a name maps to more than one id on the target, treat it as unusable.

   Then, in each value's `planJson`, replace every `{"type":"key","id":X}` and
   `{"type":"reuse-ref","ref-id":X}` with the target's id for the same name.
   If any referenced object has no name, or its name is missing on the target,
   **drop that aggregate** and report the missing names. Don't post it.
4. **Instance ids.** If the target already has the same aggregate (see
   *Matching* below), use that target definition's instance id for both
   fields. Otherwise keep the source's, per A.
5. **Connection.** Get the target model's connection ids from
   `GET /wapi/p/catalog/{catalogId}` → `models[].connection_ids`. If the
   source `connectionId` is among them, keep it. If the target has exactly one
   connection, use it. Otherwise drop the aggregate as ambiguous. Apply the
   same mapping to `exportSummary.connectionIds.values`. The existing
   `connectionRemap` query parameter can stay as a manual override.

### C. Promotion rules (from the product owner)

Only promote definitions that are:

- **system-defined:** `baseType == "system_defined"`. The export already
  contains only these, but check anyway.
- **active on the source:** `blocked == false`.
- **exportable:** present in the source export. Definitions without a built
  instance aren't exported.
- **not already active on the target.** If the target has the same aggregate
  active, skip it as a duplicate. If the target copy is blocked, import, and
  if AtScale ignores it because it already exists, unblock the target copy:
  `PUT /v1/aggregates/definitions/{id}/unblock`.

**Matching.** An aggregate on host A is the same as one on host B when their
plans select the same objects. Compute a fingerprint from
`planJson.selection.columns`:

1. Translate key and reference ids to names using the maps above.
2. Drop every `alias` and every `model` sub-object.
3. Canonically JSON-encode each column's `{value, aggregation-type}` with
   sorted keys.
4. Sort the column strings and hash them.

Aggregates that aren't in the export, and so have no `planJson`, fall back to
the sorted `type:name` list of their definition `attributes`, from
`GET /wapi/p/aggregate/definition?catalogId&modelId&page&limit`.

## Reference implementation

The Environment Manager already does all of the above in Python. Port it
rather than re-deriving it:

| Concern | File (Atscale-Environment-Manager repo) |
|---|---|
| Payload remap + required-string defaults | `api/promote/remap.py` (`remap_export`, `REQUIRED_STRINGS`, `target_connection`) |
| id ↔ name maps, plan id walk and translate | `api/promote/idmap.py` (`id_names`, `name_ids`, `plan_ids`, `translate_plan`) |
| Plan fingerprint | `api/atscale/backend.py` (`plan_fingerprint`, `agg_signature`) |
| Promotion rules + re-check | `api/promote/diff.py` (`agg_state`, `partition_for_promote`) |
| Orchestration (export → remap → import → reactivate) | `api/routes/promote.py` (`promote_aggregates`) |
| Tests to mirror | `api/tests/test_remap.py`, `api/tests/test_idmap.py` |

## Verified behaviour (so you don't need to rediscover it)

- `GET /v1/catalogs/{id}/export` resolved all 12 key and reference ids used by
  a real host's aggregate plans to unique names.
- On that host's live export, id-regenerated to simulate a second host,
  remapping gave:
  - 12 of 12 aggregates remapped
  - every plan object id converted to the target's
  - no source id left in the payload
  - identical name-based fingerprints on both sides
- The public `GET /v1/aggregates` ignores `page`/`size` on current builds and
  returns only 10 rows. Use `GET /wapi/p/aggregate/definition` to list all
  definitions. It returns engine snake_case fields: `blocked`,
  `latest_instance`, `active_instance`, `attributes`.

## Acceptance

1. Re-importing an export back into the **same** host no longer returns 400,
   including for a payload whose values lack `activeInstanceId` or
   `latestInstanceId`.
2. Importing host A's export into host B's same-named model succeeds. The
   payload that's posted contains none of A's catalog, model, key or
   reference ids.
3. Aggregates whose plan references an object missing on B are skipped, and
   the report names the missing objects.
4. Unit tests cover:
   - required-string defaults
   - catalog/model/instance/connection remapping
   - key/reference translation across two synthetic catalogs whose ids
     differ but whose names match
   - fingerprint equality across those catalogs
5. Docs (README, docs/NODE.md, docs/ACTIONS.md, action.yml, and the generated
   REST/GraphQL docs) describe the remap behaviour and any new parameter, for
   example `--target-model-name` and a report of skipped aggregates.
