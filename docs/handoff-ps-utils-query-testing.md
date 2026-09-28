# Handoff: fix query generation + the query harness in ps-utils

For a Claude Code session working in the **ps-utils** repo
(`AtScaleInc/ps-utils`, branch `develop`, checked against `987672b`, 2026-09-28).
Follow that repo's `CLAUDE.md`, add Vitest cases under
`src/operations/__tests__/`, and keep README / docs/NODE.md / docs/ACTIONS.md /
action.yml in sync with any parameter change (`npm run build` regenerates the
REST and GraphQL docs). One PR, one commit per fix, is easiest to review.

Found while porting the "Testing / Query Processing" group
(`generate-queries-from-model`, `generate-queries-shared.ts`,
`execute-atscale-query-harness`) into AtScale Env Manager, which now runs those
queries on several container hosts (Dev / QA / Prod) and compares their results.
Everything below was reproduced on real container hosts; the Env Manager port
(`api/testing/generate.py`, `api/testing/harness.py`) carries the fixes and can
be used as a reference.

| # | Where | Severity | Symptom |
|---|---|---|---|
| 1 | `generate-queries-from-model` | **High** | Level MDX fails with *Level not found* whenever a level's caption ≠ its name |
| 2 | `generate-queries-from-sml` | High (suspected, verify) | Same caption-vs-name issue, plus SQL uses the physical column |
| 3 | harness `executeXmlaQuery` | **High** | MDX checksum never matches between two runs, even on the same host |
| 4 | harness `executeXmlaQuery` | Medium | MDX row count counts every formatted cell twice |
| 5 | `generate-queries-shared.ts` `buildQueryPairs` | Medium | One non-conformed metric fails every level breakdown |
| 6 | harness `executeXmlaQuery` | Low | A SOAP fault returned with HTTP 200 is reported as SUCCEEDED |

---

## 1. Level MDX uses the caption instead of the level name

`src/operations/generate-queries-from-model/GenerateQueriesFromModelOperation.ts:158`

```ts
levels.push({
  dimLabel,
  hierLabel,
  levelLabel:      lvl.caption ?? lvl.query_name,   // ← caption
  levelNameColumn: lvl.query_name,
});
```

`mdxLevelQuery` (`generate-queries-shared.ts`) puts `levelLabel` in the MDX
brackets: `[dim].[hier].[levelLabel].MEMBERS`. MDX resolves levels by **name**
(`MDSCHEMA_LEVELS.LEVEL_NAME`, which is `query_name` in model.yaml), not by
caption.

Reproduced on a container host, model with level `LEVEL_NAME = productkey`,
`LEVEL_CAPTION = Product`:

```
SELECT {[Measures].[salesamount]} ON COLUMNS,
  NON EMPTY [Product].[Product Hierarchy].[Product].MEMBERS ON ROWS FROM [envmgr_build_test]
→ Level `[Product].[Product Hierarchy].[Product]` not found in envmgr_build_test

  … [Product].[Product Hierarchy].[productkey].MEMBERS …
→ 158 rows
```

It only works today on models where every caption equals its name.

**Fix:** keep the caption for the query's display name, use the name in the
MDX. For example, add a field to `LevelEntry`:

```ts
export interface LevelEntry {
  dimLabel: string;
  hierLabel: string;
  levelLabel: string;       // caption - display only (query name "Dim | Hier | Level")
  levelName: string;        // LEVEL_NAME - goes in the MDX brackets
  levelNameColumn: string;  // SQL column
}
```

and in `mdxLevelQuery` use `levelName`. `dimLabel` / `hierLabel` in this
operation are already parsed from `HIERARCHY_UNIQUE_NAME`, so they're names and
are fine.

**Test:** a model.yaml fixture whose level has `caption: Product`,
`query_name: productkey` must produce `[...].[productkey].MEMBERS`, while the
query name stays `... | Product`.

## 2. `generate-queries-from-sml`: same issue, and SQL uses `name_column` (verify)

`src/operations/generate-queries-from-sml/GenerateQueriesFromSMLOperation.ts:178-192`

```ts
const dimLabel: string = dim.label ?? dimUniqueName;
const hierLabel: string = hier.label ?? hier.unique_name;
...
levelLabel:      la.label ?? la.name_column,
levelNameColumn: la.name_column,
```

- MDX brackets get the dimension / hierarchy / level **labels**. On the
  container hosts tested, the MDX names are the SML `unique_name`s (the level's
  `LEVEL_NAME` equals the level attribute's `unique_name`), so this fails the
  same way as #1 whenever a label differs from its unique_name.
- SQL groups by `la.name_column`, the **dataset's physical column**. AtScale's
  SQL interface exposes the level under its query name (the level attribute's
  `unique_name`), so this fails whenever the column name differs.

In the models tested, the names happened to match, so please confirm against a
model where `label` ≠ `unique_name` ≠ `name_column` before changing it. If it's
confirmed, use `dim.unique_name`, `hier.unique_name` and `la.unique_name` for
the MDX, and `la.unique_name` for the SQL column. Keep the labels for the query
display name.

## 3. MDX checksum includes per-response timestamps, so it never matches

`src/operations/execute-atscale-query-harness/ExecuteAtScaleQueryHarnessOperation.ts:664-667`

```ts
const checksum = rowCount > 0
  ? createHash("sha1").update(bodyContent, "utf8").digest("hex")
  : "";
```

The comment says the Header is excluded because it holds per-request values.
But the SOAP **Body** also carries two per-response timestamps, inside
`OlapInfo` / `CubeInfo`:

```
<LastDataUpdate xmlns="http://schemas.microsoft.com/analysisservices/2003/engine">2026-09-28T20:32:12.962674780Z</LastDataUpdate>
<LastSchemaUpdate xmlns="http://schemas.microsoft.com/analysisservices/2003/engine">2026-09-28T20:11:46.763286098Z</LastSchemaUpdate>
```

Diffing the Body of the same query run twice on the **same host** shows only
`LastDataUpdate` changing. Across two hosts, both change. So the MDX checksum
differs on every run, and it can't be used to compare runs or hosts. The SQL
checksum, which is computed over the row data, is fine.

**Fix:** strip them before hashing:

```ts
const VOLATILE = /<([A-Za-z0-9_]*:?)(LastDataUpdate|LastSchemaUpdate)\b[^>]*>[^<]*<\/\1\2>/gi;
createHash("sha1").update(bodyContent.replace(VOLATILE, ""), "utf8")
```

A more robust option is to hash only the axes (tuples) and CellData, which is
what the result actually is. That ignores any other metadata AtScale may add
later.

**Test:** two response bodies with identical cells and different
`LastDataUpdate` / `LastSchemaUpdate` / Header `SessionId` must give the same
checksum. A changed `<Value>` must give a different one.

## 4. MDX row count also counts `<FmtValue>`

`ExecuteAtScaleQueryHarnessOperation.ts:662`

```ts
rowCount = (cellDataMatch[1].match(/<[A-Za-z0-9_]*:?Value[\s>\/]/gi) ?? []).length;
```

`[A-Za-z0-9_]*` is meant to match a namespace prefix, but it also matches the
`Fmt` in `<FmtValue>`. Every formatted cell is counted twice: a one-metric
grand total reports `rowCount = 2`. Seen on container hosts, where cells carry
both `<Value>` and `<FmtValue>`.

**Fix:** require the colon when there's a prefix:

```ts
/<(?:[A-Za-z0-9_]+:)?Value[\s>\/]/gi
```

Also worth documenting: for XMLA this is a **cell** count
(rows × measures), not a row count. The output CSV column is `row_count` for
both protocols, so a 1124-row breakdown with 3 metrics reads 3372 for XMLA and
1124 for SQL.

**Test:** CellData with 2 cells, each having `<Value>` and `<FmtValue>` → 2.

## 5. Every level breakdown selects every metric

`generate-queries-shared.ts` `buildQueryPairs` → `mdxLevelQuery(allMetricNames, …)` / `sqlLevelQuery(allMetricNames, …)`

Each level query selects **all** model metrics. If a single metric isn't related
to that dimension (another fact or measure group), AtScale rejects the whole
query. Seen on a real host:

```
Query is not possible: measures (Sum([List Price])) are not defined over the product
of these dimensions: ([Color], FlatKey(...))
```

Every breakdown on that model then fails, so the other metrics on those
dimensions are never tested either.

**Suggestion** (pick one, behind a parameter so the current output stays the default):
- `--metrics-per-level-query all|each`: with `each`, emit one level query per
  (level, metric), or
- group metrics by measure group (`MDSCHEMA_MEASURES.MEASUREGROUP_NAME` in
  `extract-model-from-atscale`) and emit one level query per group.
  Note that AtScale rejects `MDSCHEMA_MEASUREGROUP_DIMENSIONS` ("DMV query
  against MDSCHEMA_MEASUR… "), so the metric-to-dimension mapping can't come
  from the DMV. With per-metric queries, a failure pins down exactly which
  metric isn't conformed.

## 6. A SOAP fault with HTTP 200 counts as success

`executeXmlaQuery` treats any HTTP 200 as SUCCEEDED and then counts cells. If
the engine returns a `<soap:Fault>` / `<Exception>` inside a 200 response,
the query is reported as SUCCEEDED with `rowCount = 0`. The hosts tested return
faults as HTTP 500, so this is defensive, but it's cheap to add:

```ts
const fault = bodyContent.match(/<faultstring>([\s\S]*?)<\/faultstring>/i);
if (fault) return { status: "FAILED", durationMs, rowCount: 0, checksum: "", error: fault[1].trim() };
```

---

## Out of scope, for context

- Env Manager runs SQL through `/engine/query/submit` on the host session,
  rather than the harness's native Postgres connection. That's a choice on
  the Env Manager side, not a ps-utils issue.
- Env Manager's own Build preview had a *"CrossJoin may not cross the same
  hierarchy with itself"* bug when two levels of one hierarchy were picked.
  It's fixed there with `Hierarchize({L1.Members, L2.Members})`. ps-utils'
  generators never combine levels, so they aren't affected.
