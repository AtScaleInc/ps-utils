# Testing / Query Processing — All 8 Commands

Track 4 of the PS Template Workflow Tutorials. All commands are run from the
`ps-utils` repo root (`/Users/javiermorales/Desktop/ps-utils`) against the
local Docker AtScale install, using the `internet_sales` model.

**Inputs needed before running anything:**
- `example/connections.yaml` — has `local_atscale` (pgwire + MDX) and `local_atscale_db` (internal Postgres)
- `example/model.yaml` — internet_sales model extracted from the local instance
- `example/sml/` — internet_sales SML source (cloned from the local gitea repo)

Pipeline order: **1–3 produce query files → 4 replays them (twice) → 5 spot-checks → 6 enriches → 7 mines history → 8 compares runs.**

---

## 1. `generate-queries-from-model`

```bash
./atscale-utils generate-queries-from-model \
  --model-file ./example/model.yaml \
  --xmla-output-file ./example/queries/model_xmla.json \
  --sql-output-file ./example/queries/model_sql.json
```

Reads the model.yaml extracted from AtScale and auto-writes a test query for
every metric and every hierarchy level — one grand total per metric, one
breakdown per level. Full model coverage in both SQL and MDX without writing
a single query by hand. Our run: 34 metrics + 114 levels = 148 queries each.

**Outputs:**
| File | Location |
|---|---|
| `model_xmla.json` (148 MDX queries) | `/Users/javiermorales/Desktop/ps-utils/example/queries/model_xmla.json` |
| `model_sql.json` (148 SQL queries) | `/Users/javiermorales/Desktop/ps-utils/example/queries/model_sql.json` |

---

## 2. `generate-queries-from-sml`

```bash
./atscale-utils generate-queries-from-sml \
  --sml-dir ./example/sml \
  --xmla-output-file ./example/queries/sml_xmla.json \
  --sql-output-file ./example/queries/sml_sql.json
```

Same as command 1, but reads the raw SML source files instead of a live
extraction — so it works offline with no AtScale connection at all. Useful in
CI pipelines where you only have the model's git repo. Our run: 12 metrics +
30 levels = 42 queries each (the SML defines fewer metrics than the live
engine exposes, since the engine adds calculated metrics and role-played
date dimensions at deploy time).

**Outputs:**
| File | Location |
|---|---|
| `sml_xmla.json` (42 MDX queries) | `/Users/javiermorales/Desktop/ps-utils/example/queries/sml_xmla.json` |
| `sml_sql.json` (42 SQL queries) | `/Users/javiermorales/Desktop/ps-utils/example/queries/sml_sql.json` |

---

## 3. `extract-queries-from-atscale`

```bash
./atscale-utils extract-queries-from-atscale \
  --connection-file ./example/connections.yaml \
  --connection-name local_atscale_db \
  --models "internet_sales" \
  --days 90 \
  --db-schema engine \
  --output-dir ./example/queries
```

Connects to AtScale's internal Postgres backend (port 10518, schema `engine`)
and pulls the deduplicated history of queries real users actually ran — with
their original durations and result sizes. This is how you capture a
production workload to replay later. Our run found 10 real queries from the
Tableau testing sessions.

**Output:**
| File | Location |
|---|---|
| `internet_sales_sql_queries.json` (10 real queries) | `/Users/javiermorales/Desktop/ps-utils/example/queries/internet_sales_sql_queries.json` |

---

## 4. `execute-atscale-query-harness` (run twice: baseline + comparison)

```bash
./atscale-utils execute-atscale-query-harness \
  --connection-file ./example/connections.yaml \
  --connection-name local_atscale \
  --query-file ./example/queries/internet_sales_sql_queries.json \
  --protocol sql \
  --concurrent-users 1 \
  --run-id run_a \
  --output-dir ./example/run_results
```

```bash
./atscale-utils execute-atscale-query-harness \
  --connection-file ./example/connections.yaml \
  --connection-name local_atscale \
  --query-file ./example/queries/internet_sales_sql_queries.json \
  --protocol sql \
  --concurrent-users 3 \
  --run-id run_b \
  --output-dir ./example/run_results
```

The load tester: replays every query in the file against the live instance
(through pgwire on port 15432), recording status, duration, row count, and a
checksum of the results per query. Run it once before a change and once after
(or at different concurrency levels like we did), and you have two labeled
CSVs ready to compare. Our runs: 10/10 succeeded both times — avg 418ms at 1
user, 465ms at 3 users.

**Outputs:**
| File | Location |
|---|---|
| `run_a_local_atscale.csv` (baseline, 1 user) | `/Users/javiermorales/Desktop/ps-utils/example/run_results/run_a_local_atscale.csv` |
| `run_b_local_atscale.csv` (3 users) | `/Users/javiermorales/Desktop/ps-utils/example/run_results/run_b_local_atscale.csv` |

---

## 5. `execute-query-on-connection`

```bash
./atscale-utils execute-query-on-connection \
  --connection-file ./example/connections.yaml \
  --connection-name local_atscale \
  --query-file ./example/queries/internet_sales_sql_queries.json \
  --protocol sql \
  --query-name "SQL Query 24 (c27c77a3-d6dc-46ea-9756-246eb4cadeb5)" \
  --output-file ./example/output/query24_result.csv
```

Runs one query from a query file and saves the **actual
result data** to a CSV — not just stats. This is the investigation tool for
when the harness or the run analysis flags a query and you need to see the
real numbers it returns. Our run: Query 24 returned 371 rows of "Calculated
Tax by Order Reporting Day of Year."

**Output:**
| File | Location |
|---|---|
| `query24_result.csv` (371 data rows) | `/Users/javiermorales/Desktop/ps-utils/example/output/query24_result.csv` |

---

## 6. `generate-enhanced-query-results`

```bash
./atscale-utils generate-enhanced-query-results \
  --results-file ./example/run_results/run_a_local_atscale.csv \
  --connection-file ./example/connections.yaml \
  --connection-name local_atscale_db \
  --db-schema engine
```

Takes a harness run CSV and joins it back to AtScale's internal query log
(via the UUID comment the harness stamps on every query), appending the
engine's phase timings — inbound, planning, wait, execute, fetch — plus the
outbound SQL and whether an aggregate was used. Turns "this query is slow"
into "this query spends 90% of its time waiting on the warehouse connection."
Our run matched 10/10 queries and revealed `run_used_agg: true` — AtScale's
aggregates are answering the queries.

**Output:**
| File | Location |
|---|---|
| `run_a_local_atscale_enhanced.csv` (run A + 11 timing columns) | `/Users/javiermorales/Desktop/ps-utils/example/run_results/run_a_local_atscale_enhanced.csv` |

---

## 7. `extract-query-stats-from-atscale`

```bash
./atscale-utils extract-query-stats-from-atscale \
  --connection-file ./example/connections.yaml \
  --connection-name local_atscale \
  --model "internet_sales" \
  --window-days 90 \
  --output-dir ./example/query-stats
```

Mines the query history into a frequency matrix showing how often each
(dimension attribute × measure) pair gets queried — basically "what do my
users actually analyze?" Perfect for deciding which aggregate tables are
worth building. **Note:** works on container-based AtScale thanks to our
local patch — the command falls back to the new `/api/queries` endpoint when
the old installer endpoint 404s. Add `--monthly true` for a fourth
month-by-month CSV.

**Outputs** (the README only documents the first one, but the command always writes all three):
| File | Location |
|---|---|
| `..._occurrences.csv` (flat attribute × measure counts) | `/Users/javiermorales/Desktop/ps-utils/example/query-stats/internet_sales_catalog_main_internet_sales_occurrences.csv` |
| `..._metric_by_hierarchy.csv` (counts with full dimension > hierarchy > level path) | `/Users/javiermorales/Desktop/ps-utils/example/query-stats/internet_sales_catalog_main_internet_sales_metric_by_hierarchy.csv` |
| `..._metric_pivot.csv` (matrix: metrics as rows, hierarchy levels as columns) | `/Users/javiermorales/Desktop/ps-utils/example/query-stats/internet_sales_catalog_main_internet_sales_metric_pivot.csv` |

---

## 8. `execute-run-analysis`

```bash
./atscale-utils execute-run-analysis \
  --file-a ./example/run_results/run_a_local_atscale.csv \
  --file-b ./example/run_results/run_b_local_atscale.csv \
  --summary-file ./example/analysis/summary.txt \
  --comparison-file ./example/analysis/comparison.csv \
  --outliers-file ./example/analysis/outliers.csv
```

Compares two harness runs query-by-query (matched by query-text hash) and
flags anything that changed: row-count mismatches, durations outside a 20%
variance threshold, or new errors. The outliers CSV is the regression report —
if it's empty, the change you made is safe. Our run: 10/10 matched, 0 data
mismatches, 4 duration outliers from the concurrency increase.

**Outputs:**
| File | Location |
|---|---|
| `summary.txt` (human-readable report) | `/Users/javiermorales/Desktop/ps-utils/example/analysis/summary.txt` |
| `comparison.csv` (all 10 pairs side-by-side) | `/Users/javiermorales/Desktop/ps-utils/example/analysis/comparison.csv` |
| `outliers.csv` (the 4 flagged queries) | `/Users/javiermorales/Desktop/ps-utils/example/analysis/outliers.csv` |

---

## Quick reference — where everything lives

```
/Users/javiermorales/Desktop/ps-utils/example/
├── connections.yaml          ← input: all connection definitions
├── model.yaml                ← input: internet_sales model (extracted from local AtScale)
├── sml/                      ← input: internet_sales SML source (from local gitea)
├── queries/                  ← commands 1, 2, 3 outputs (query JSON files)
├── run_results/              ← command 4 outputs + command 6 enhanced CSV
├── output/                   ← command 5 output (actual query results)
├── query-stats/              ← command 7 outputs (frequency matrices)
└── analysis/                 ← command 8 outputs (comparison report)
```
