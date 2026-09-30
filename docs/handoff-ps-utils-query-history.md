# Handoff: fix query-history extraction in ps-utils

For a Claude Code session working in the **ps-utils** repo
(`AtScaleInc/ps-utils`, branch `develop`, checked against `08008fa`, 2026-09-29).
Follow that repo's `CLAUDE.md`. Add Vitest cases under `src/operations/__tests__/`.
Keep README / docs/NODE.md / docs/ACTIONS.md / action.yml in sync with any
parameter change; `npm run build` regenerates the REST and GraphQL docs.
One PR with one commit per fix is easiest to review.

These bugs turned up while building the Monitor tab in AtScale Env Manager.
Monitor pulls a container host's query history and splits it into three groups:
served from cache, used an aggregate, or hit the warehouse with no aggregate.
It needed the two ps-utils operations that read query history:

- `extract-query-stats-from-atscale` - REST
- `extract-queries-from-atscale` - SQL against AtScale's internal Postgres

Neither could be used as-is on a container host. Engine references are to
`engine-develop` and SML references to `SML-develop` (`apps/api`), as of
2026-09-30. Env Manager's port (`api/monitor/`) can serve as a reference:
`queries.py` has the classification, and `poll.py` pages to the end.

| # | Where | Severity | Symptom |
|---|---|---|---|
| 1 | `extract-query-stats-from-atscale` | **High** | Container URL `/engine/queries/orgId/{org}` is not routed by the engine - 404 |
| 2 | `extract-query-stats-from-atscale` | **High** | `--limit` above 101 silently stops after the first page |
| 3 | `extract-queries-from-atscale` | **High** | `num_times` / `avg_result_size` counted once per subquery, not per execution |
| 4 | `extract-queries-from-atscale` | **High** | Queries answered without a subquery (cache-served) are dropped |
| 5 | `extract-queries-from-atscale` | Medium | `aggregateUsed` checks one subquery's text for `as_agg_` |
| 6 | `extract-query-stats-from-atscale` | Medium | `--monthly` month windows are in local time, shifted by the UTC offset |
| 7 | `extract-query-stats-from-atscale` | Low | Container still requires an `mdx.organization_id` it never needs |
| 8 | `extract-query-stats-from-atscale` | Low | "Processed N query records" log is wrong; sampling comment overstates |
| 9 | both | Gap | No cache / aggregate / warehouse breakdown, and no user-vs-system split |

---

## 1. Container URL has an `orgId` segment the engine doesn't route

`src/operations/extract-query-stats-from-atscale/ExtractQueryStatsFromAtScaleOperation.ts:378-380`

```ts
const baseUrl = installer
  ? `${atscaleUrl}:10502/queries/orgId/${organizationId}`
  : `${atscaleUrl}/engine/queries/orgId/${organizationId}`;
```

The engine mounts query history as `"queries" -> ActivityMonitorRest()`
(`modules/server/http/.../rest/RestServer.scala:157`), and the list route is
`(get & pathEnd)` (`rest/activitymonitor/ActivityMonitorRest.scala:76`). It has
no `orgId/{org}` segment. The other routes under `/queries` are `queryId/…` and
`subqueryId/…`, so `/queries/orgId/default` matches nothing. Container nginx
strips `/engine` before forwarding, so the working container URL is
`https://{host}/engine/queries?...`.

**Fix:** for container, use `${atscaleUrl}/engine/queries` and keep the query
string. The filter names already match what the engine accepts
(`QueryInfoPostgresDao.scala:196-247`): `querySource=user|system`,
`status=success|error|running|completed`, `projectId`, `cubeId`, `userId`,
`queryId`, `queryDateTimeStart`, `queryDateTimeEnd`. The installer branch stays
as it is.

**Alternative:** the SML API wrapper `GET /wapi/p/queries`
(`apps/api/src/queries/queries.controller.ts:50-148`) is what the AtScale UI
uses. It returns camelCase rows with `optimization: ["AGGS" | "CACHE"]`.
Its parameters are `catalogId`, `modelId`, `queryType=User|System`,
`status=successful|failed|running`, `startDate`, `endDate`, `page`, `size` and
`sort`. Its response envelope differs: `{results, hasNextPage}` instead of
`{response: {data}}`.

**Test:** stub axios. Assert that the container URL is
`https://h/engine/queries?querySource=user&status=success&projectId=…` with no
`orgId`, and that the installer URL is unchanged.

## 2. `--limit` above 101 stops after one page

Same file, `processQueries` (`:382-445`):

```ts
if (data.length < limit) {
  done = true;
} else {
  offset += limit;
}
```

The engine caps page size at 101:
`rest/internal/PaginationSupport.scala:27-32`,
`limit = math.min(math.max(limit.getOrElse(DefaultLimit), 0), ResultsPerPage)`
with `ResultsPerPage = 101`. With `--limit 500`, the first page comes back with
101 rows. Since 101 < 500 the loop ends and every later page is skipped without
a warning. The CSVs then undercount, and nothing tells the user.

**Fix:** clamp the requested limit to 100 (or 101) before the loop. Advance
`offset` by the number of rows actually returned, not by `limit`. Stop only when
a page comes back empty or with fewer rows than the clamped limit.

**Test:** stub a server that serves at most 101 rows per page from 350 rows.
With `limit: "500"` the pair counts must cover all 350.

## 3. `extract-queries-from-atscale` counts subqueries, not executions

`src/operations/extract-queries-from-atscale/ExtractQueriesFromAtScaleOperation.ts:174-201`

```sql
COUNT(*)                                   AS num_times,
EXTRACT(EPOCH FROM AVG(r.finished - p.planning_started)) AS elapsed_time_in_seconds,
AVG(r.result_size)                         AS avg_result_size
FROM   engine.queries          q
JOIN   engine.query_results    r ON q.query_id = r.query_id
JOIN   engine.queries_planned  p ON q.query_id = p.query_id
JOIN   engine.subqueries       s ON q.query_id = s.query_id   -- one row per subquery
GROUP  BY 1, 2, 3, 6, 7
```

`subqueries` holds one row per outbound subquery
(`modules/server/core/.../core/stats/tables.scala:289-305`). A query that sent 3
subqueries therefore contributes 3 rows to its group. The result:

- `numTimes` is inflated by the subquery count.
- The two `AVG`s are weighted toward queries with many subqueries.
- `--min-executions` filters on the inflated number.

**Fix:** aggregate per query first, then group by text. For example, a CTE that
picks each query's subquery facts with `bool_or` / `MAX` over
`subqueries JOIN subquery_results`, `LEFT JOIN`ed on `query_id`. Then
`COUNT(DISTINCT q.query_id)` and plain `AVG`s over one row per query.

**Test:** unit-test the SQL builder's shape. Better, run one integration query
against a seeded Postgres with a single query that has 3 subqueries: it must
give `num_times = 1`.

## 4. Queries answered without a subquery are dropped

Same SQL: the inner `JOIN subqueries` removes every query that sent no outbound
subquery. The engine records such queries as fully served from cache (`QueryInfoPostgresDao.scala:147`:
"no subqueries (e.g. fully cache-served)"). They are
exactly the cache hits a history or replay should include. The replay file this
operation writes for `execute-atscale-query-harness` therefore leaves out the
cheapest, most-repeated queries.

**Fix:** use `LEFT JOIN` for the subquery side, which the per-query CTE in #3
does anyway. `outbound_text` then becomes nullable; the `QueryRecord` type
already allows that.

## 5. `aggregateUsed` checks the text of a single subquery

```sql
CASE WHEN MAX(s.subquery_text) LIKE '%as_agg_%' THEN true ELSE false END AS used_agg
```

`MAX` picks one subquery text per group, the one that sorts last, and only that
text is tested. If the aggregate was used by any other subquery, the query is
reported as not using one. The check also depends on the aggregate table-name
prefix.

**Fix:** the engine already records which aggregates each query used:

- `query_aggregate_usage (query_id, query_part, aggregate_definition_id,
  aggregate_instance_table_name, …)` (`tables.scala:370-376`). This is what
  `/engine/queries` returns as `aggregate_definition_ids` for rows with
  `query_part IS NULL`.
- The cache flags are on `subquery_results`: `used_local_cache` and
  `used_aggregate_cache` (`tables.scala:319-324`).

Use `EXISTS (SELECT 1 FROM query_aggregate_usage u WHERE u.query_id = q.query_id)`
for `used_agg`. While there, add:

- `used_local_cache`: `bool_or` over the query's `subquery_results`.
- `used_aggregate_cache`: the same.
- `subquery_count`.

Also add the matching fields to `QueryRecord`. That covers most of #9 for this
operation.

## 6. `--monthly` windows are local time, printed as UTC

`ExtractQueryStatsFromAtScaleOperation.ts:743-749`

```ts
const monthStart = new Date(year, month, 1, 0, 0, 0);          // local time
const monthEnd = new Date(year, month + 1, 1, 0, 0, 0);
monthEnd.setSeconds(monthEnd.getSeconds() - 1);
const mStart = monthStart.toISOString()...                     // shifted to UTC
```

On a machine at UTC+8, "January" runs from 31 Dec 16:00Z to 31 Jan 15:59:59Z. On
a CI runner at UTC it's correct. The same run therefore gives different monthly
CSVs depending on where it executes.

Also note that `queryDateTimeEnd` filters on the query's **finish** time
(`QueryInfoPostgresDao.scala:245-246`). A query that starts before midnight and
finishes after the month-end second falls into neither month.

**Fix:** build the windows with `Date.UTC(year, month, 1)`. Either use half-open
windows (end = the next month's start, without the minus-one-second), or say in
the docs that windows are matched on finish time.

**Test:** run with `TZ=Asia/Singapore` and `TZ=UTC`. The generated window
strings must be identical and cover Jan 1 00:00:00Z – Feb 1 00:00:00Z.

## 7. Container mode insists on an `mdx:` block with `organization_id`

`run()` throws when `connection.mdx` is missing (`:488-493`). It then reads
`mdx.organization_id`, and container mode only uses it to build the broken URL
from #1. The XMLA (`/engine/xmla`) and token calls don't need it.

**Fix:** after #1, make `organization_id` optional when `installer` is false.
Better, accept the standard `connections.<name>.atscale: {url, username,
password, apiToken, insecure}` entry that the other container operations use,
so users don't need a second, installer-shaped block for this operation.

## 8. Small correctness nits

- `:447-449` logs ``Processed ${offset + limit} query records``. That is the
  last offset plus one page, not the number of rows seen. Keep a running
  `rows += data.length` and log that.
- `:339-341, :426-433`: the comment says reservoir sampling "matching the
  notebook's approach exactly". Replacing a random slot with probability 0.5 is
  not reservoir sampling; Algorithm R uses probability `numQueries / (count+1)`.
  Either implement Algorithm R or reword the comment. It only affects which
  sample query ids are kept, not the counts.
- `:313, :320`: the catalog and model names are interpolated into DMV `WHERE`
  clauses unescaped. A name containing `'` breaks the statement. Double single
  quotes, the way `sqEscape` does in the other operation.

## 9. Gap: no answered-by breakdown and no user / system split

Neither operation reports how a query was answered, yet that is the first
question when checking a host's health. Both operations already fetch the data
needed for it.

**Suggested classification** (what Env Manager uses; first match wins):

- **cache**: any subquery `used_local_cache`, or the query succeeded with no
  subquery.
- **agg**: the query has an `aggregate_definition_ids` entry (REST), or a
  `query_aggregate_usage` row (SQL).
- **raw**: everything else - the warehouse answered it without an aggregate.

**For `extract-query-stats-from-atscale`:**

- Keep `querySource=user` as the default. Add `--query-source user|system|all`.
- Write a summary CSV with one row per query:
  `query_id, received, duration_ms, user_id, cube_name, class, aggregate_count, subquery_count`.

The engine row already carries `aggregate_definition_ids` and
`timeline_events[type=SubqueriesWall].children[].used_local_cache`
(`rest/activitymonitor/response/QueryExecutionInfo.scala:39-57`,
`SubqueryExecutionInfo.scala:39-55`).

**For `extract-queries-from-atscale`:** covered by the fields added in #5.

Engine caveat: for subquery rows, `QueryInfoPostgresDao.scala:394` fills
`query_text` with the parent's inbound text. To get real outbound SQL, use
`/engine/queries/queryId/{id}/outbound` or `/engine/queries/subqueryId/{id}/text`.

---

### Suggested order

Do #1 and #2 first: without them the REST operation returns nothing, or
silently too little, on current container builds. Then #3–#5 as one SQL
rewrite, then #6–#8. #9 is a feature and can be its own PR.
