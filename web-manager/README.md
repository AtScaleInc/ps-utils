# AtScale Environment Manager

One console for many AtScale **container** hosts, organised by **business
unit**. Each business unit (BU) is an isolated realm, like a Keycloak realm:
its own Git profile and its own hosts in four environments, **Dev**,
**Test**, **QA** and **Prod**. Pick the BU under the product name; everything
below works inside it. From one screen you can:

- **build** a semantic model visually, after profiling the warehouse tables it
  uses, and deploy it to one or many hosts,
- **test** that an environment answers the same queries as another, with the
  same model and the same values,
- **promote** models and system aggregates from one environment to the next,
  such as Dev → Test → QA → Prod, moving only what's new,
- **manage** each host's models and aggregates, and **analyze** a deployed
  model: every object and SML property it uses, with descriptions, YAML
  comments and audit findings,
- **monitor** a host's query history: how much is served from cache,
  aggregates or the warehouse, volume, latency and hotspots.

```
┌───── Build ──────┐   ┌────── Test ──────┐   ┌──── Promote ─────┐   ┌───── Manage ─────┐   ┌──── Monitor ─────┐
│ discover →       │   │ generate queries │   │ source host      │   │ group → host     │   │ poll a host's    │
│ canvas → SML     │ → │ from a model,    │ → │  diff → stage    │ → │ Models: link,    │ → │ query history:   │
│ push to Git      │   │ run on hosts,    │   │ target host      │   │  deploy, unlink  │   │ cache / agg /    │
│ deploy to any    │   │ compare model +  │   │  promote (Prod   │   │ Aggregates:      │   │  warehouse mix,  │
│ hosts            │   │ results          │   │  asks first)     │   │  build, (de)act  │   │ latency, hotspots│
│                  │   │                  │   │                  │   │ Analyze: audit   │   │                  │
└──────────────────┘   └──────────────────┘   └──────────────────┘   └──────────────────┘   └──────────────────┘
  Settings: Hosts & Git (credentials, the BU's Git profile) · Business units · Cache & Database
```

The top tabs are **Build · Test · Promote · Manage · Monitor**, with **⚙ Settings** on the
right. The app opens on Build. The left rail lists the current tab's sections:

| Tab | Rail sections |
|---|---|
| Build | Discovery · Develop · Preview |
| Test | Run · Results · Compare results · Compare model |
| Promote | Models · Aggregates |
| Manage | Models · Aggregates · Analyze |
| Monitor | Overview · History · Hotspots |
| Settings | Hosts & Git · Cache & Database |

Every tab picks its group and host the same way: the env picker and host
dropdown sit at the left of the bar.

---

## What it does

### Build: model SML and deploy it to one or many hosts

Build is the SML wizard that used to be the separate `sml-wizard` repo. It
works on the host picked in the Build bar, using that host's credentials from
Settings. There's no separate login.

- **Discovery.** See what a table holds before modeling it. Pick a warehouse,
  database and schema, then click a table (the same Source panel as Develop,
  which keeps the choice). The profile runs on the first visit:
  - **tiles**: rows, columns, key candidates, duplicate rows, and how many
    columns have findings
  - **per column**: NULL %, blank strings and placeholder values (`N/A`,
    `UNKNOWN`, `-999`…), distinct count, min / max / avg, negative amounts,
    future dates and dates before 1900 or in the 9000s. From the sample rows:
    numbers or dates stored as text, and the string formats (`AA-999`).
  - a **suggested role** per column (key, join key, measure, attribute, time,
    constant, empty) with the reason, and **findings** worth a look before
    modeling. Click a column for its top 10 values.
  - **Sample rows**, 100 from the table (10 on AtScale builds without the
    engine's sample-data endpoint).
  - **Joins**: suggests tables with a column of the same name, then counts
    this table's keys missing from the other one (orphans) and checks the other
    side is unique. If it isn't, the join fans out and double counts metrics.
  - **AtScale statistics**: the row counts and cardinality AtScale's engine
    has collected. The tab only shows when the host has some.
  - **Add to canvas** puts the table on the Develop canvas.

  Results are kept in `workspace/discovery.db`: a table is profiled once and
  read from there on every later visit, even after a restart. **Re-profile**
  reads the warehouse again and keeps the run as history: the newest 20 per
  table, shown as a strip you can open, with what changed since the previous
  run (row count, columns added / dropped / retyped, NULL % jumps, distinct
  count swings). A profile scans the whole table, so the first one on a very
  large table takes a while. Old runs are cleaned up in Settings.
- **Large warehouses.** The Source panel (shared by Discovery and Develop) gets
  schema names at once and lists each schema's tables in the background,
  polling until all are in. A Snowflake schema can take AtScale minutes, and
  the rest don't wait for it. Each schema shows 100 tables with **show more**;
  search covers every table. Columns load per table when you add it to the
  canvas or pick it. A warehouse or schema AtScale can't list shows its error
  and is retried after a minute; **↻ refresh** reloads now.
- **Develop.** Pick one of the host's data warehouses, drag tables onto the
  canvas, mark each as a fact or a dimension, join them (snowflake joins work
  too), and configure metrics, hierarchies, aliases, secondary attributes and
  calculations. **Wizard** does the first pass for you from column names. The
  data source list is per host: switching to a host that doesn't have the
  picked warehouse connection clears the pick instead of querying a connection
  that isn't there.
- **Preview data** (canvas toolbar, after Auto-arrange). Checks joins and
  metrics against real data before anything is generated or deployed. In a
  pop-up like the Wizard's, pick the table to start from (facts first), then
  the metrics and each dimension's levels and attributes. Nothing is ticked
  when it opens: every ticked column can add a join, so pick only what you
  want to look at (a group's checkbox ticks the whole group). Tables join the way the canvas says: fact → dimensions →
  snowflaked dimensions, one join per role-play (Order Date / Ship Date), as
  LEFT JOINs so a key with no match shows as NULL instead of vanishing.
  - **Rows**: the joined rows as they are, metrics unaggregated. A dimension
    column that is NULL on every row is flagged (its join likely matches
    nothing).
  - **Aggregated**: each metric with its own aggregation (SUM, COUNT
    DISTINCT, …), grouped by the ticked attributes.
  - **Check joins**: rows before vs after the joins (more after = fan-out,
    which inflates every metric) and, per join, how many rows find no
    dimension row. This one counts every row, so it's a full scan on large
    tables.

  Nothing runs until you click **Run** (it stays off until something is
  ticked, except for Check joins); the SQL sent is shown under the result.
  Changing the table to start from clears the picks. Rows and Aggregated return the first **10 rows**: the SQL goes
  through the same AtScale interface as Discovery's profile, whose limit is
  fixed by the engine. Calculations are MDX and aren't previewed; they run in
  AtScale after deploy. Nothing is stored.
- **Shared dimensions (SML packages).** Build common dimensions once and reuse
  them in many models through the model's `package.yml`
  ([SML package reference](https://github.com/semanticdatalayer/SML/blob/main/sml-reference/package.md)).
  - **Publish a shared dimensions repo.** Put only dimensions on the canvas (no
    fact) and click **Deploy**. Instead of the "not connected to any fact
    table" errors, Build asks whether to publish the repo as shared
    dimensions. Say yes and the bar shows a **Shared dimensions** chip (✕
    turns it back into a model) and the button reads **Publish**. The repo
    holds the catalog, connection, datasets and dimensions, with no model and
    no metrics. Its `catalog.yml` carries the tag
    `# Shared dimensions package (AtScale Environment Manager) - attach, don't deploy`,
    and its connection is named `<connection>_shared_dim`. A model using the
    package would otherwise have a connection with the same
    `con_<database>_<schema>` name, and AtScale requires every name to be
    unique once the package is merged in. Publishing pushes to Git once, then
    only **attaches** the repo on each checked host. Nothing is deployed.
  - **Use shared dimensions in a model.** **Shared dims** in the Build bar
    lists repos you can pick from: ones carrying the tag, Git profile repos
    with a catalog but no `models/` folder, and repos attached on the Build
    host with nothing deployed from them. Every listed repo must have a root
    `catalog.yml` on GitHub, so only valid AtScale packages appear; a host
    repo that lacks one, or that the Git profile can't read, is left out.
    Picking one reads the head commit
    of its branch. Choose the dimensions to add. They land on the canvas
    read-only, with a dashed border and a `SHARED · <package> @ <commit>`
    badge. The Inspector shows their hierarchy and the level keys a join can
    land on. Join your fact to them as usual. The generated model writes no
    files for them. Instead it lists the repo in `package.yml`, pinned to that
    commit:

    ```yaml
    version: 1
    packages:
      - name: shared
        url: https://github.com/<owner>/<shared-repo>
        branch: main
        version: commit:037fe48ad071c34f455f1be54dbf03ffcf14de1d
    ```

    The model refers to the shared dimensions and levels by their names in
    the package, unchanged. Picking the same repo again moves its nodes to the
    branch's new head commit. Loading a model with a `package.yml` fetches each
    package at its pinned commit, so the shared dimensions show up again (a
    package that can't be fetched is reported, and the rest still loads).
  - **Validate with sml-cli** puts the package's files next to the model, as
    AtScale does, so the shared dimensions resolve. For a shared repo, the
    "Missing Model files" error is expected and isn't counted as a failure.
    A name used both by the model and by a package fails here (and on a
    legacy deploy) with the same "is not unique" message AtScale gives.
- **Save / Load.** Saving writes plain SML to `workspace/models/<model>/`.
  Loading reads from there, from a repo already attached on the host, or from
  any path or Git URL.
- **Built here / Built elsewhere.** Every file Build generates starts with the
  comment `# Built with AtScale Environment Manager (Build)`. AtScale ignores
  it; Design Center drops it when it rewrites a file. A loaded model shows
  **Built here** when its `catalog.yml` still carries it, else **Built
  elsewhere** (models built before the tag existed show as elsewhere, but stay
  editable if nothing below applies).
- **Read-only models.** Save and Deploy regenerate every file from the canvas,
  so anything the canvas can't hold would be deleted from the model. When a
  loaded repo uses any of it, the model opens **read-only**: Deploy and Save
  are disabled, and a banner under the Build bar lists what it found, grouped,
  with the file and object for each (**show details**). The API also refuses
  (409) to save or deploy over a working copy that holds such SML. Checked
  against the [SML reference](https://github.com/semanticdatalayer/SML/tree/main/sml-reference):
  - **Complex features** (listed first): row security, composite models,
    more than one model, semi-additive metrics, calculation groups,
    perspectives, user-defined aggregates, partitions, drill-throughs,
    dimensions over several tables (snowflake hierarchies), more than one
    hierarchy per dimension, composite keys and joins, SQL datasets and
    calculated columns, many-to-many and dimension-level role-play
    relationships, parallel periods, metrical attributes, quantiles, level
    aliases, custom empty members, dataset / model properties, connection
    overrides, calculation methods or unrelated-dimension handling Build
    doesn't write, a catalog name other than `<model>_catalog`, several
    metrics on one column.
  - **Cosmetic** (also blocks, since a save would lose it): folders, formats,
    descriptions, labels that differ from the name, hidden objects, Design
    Center metadata, and identifier casing Build would change.

  Edit such a model in Design Center. **Reset** (or the Wizard with a cleared
  canvas) starts a new, editable model.
- **Deploy.** Generates the SML and shows it for review; **Validate with
  sml-cli** is optional. **Deploy to** lists every host by group, with the
  Build host checked by default. The SML is pushed to Git once: a new model
  gets `github.com/<git user>/<model>`, and a loaded one goes back to its own
  repo and branch. Then each checked host attaches the repo and deploys that
  branch, using the same call Promote uses. A host without the model's data
  warehouse connection is greyed out, and results are reported per host. A
  shared dimensions repo (above) is pushed the same way but only attached on
  each host, not deployed.
- **Preview.** Pick a deployed catalog/cube on the Build host, then a mode:
  - **DMV**: drag hierarchies, levels and measures (read from the cube's DMV)
    onto Rows / Measures, and run the query the app builds. Levels of the same
    hierarchy are combined with `Hierarchize`. You can expand the generated
    query under the grid.
  - **Freehand**: type your own MDX, or SQL when **SQL Dialect** is ticked.
    Dragging an item into the editor inserts its MDX unique name or its quoted
    SQL column name. **Use last query** copies the last built query,
    **Template** starts an empty one, and Cmd/Ctrl+Enter runs it. MDX and SQL
    keep separate drafts.
  - Either mode returns at most 1,000 rows (`ENV_MANAGER_PREVIEW_MAX_ROWS`),
    with a notice when more exist. Built queries and typed SQL carry the limit
    themselves (`HEAD` / `LIMIT`), so a preview never pulls a whole dataset;
    typed MDX runs as written and is trimmed afterwards.

Build is a quick-start modeler, not a replacement for AtScale's own. A model
using anything beyond Build's subset opens read-only (see above) rather than
being partly imported and overwritten.

### Test: prove an environment matches before promoting

Test is ps-utils' *Testing / Query Processing* group, run on several hosts at
once. A candidate environment is ready to promote to when its **model** and its
**query results** match the baseline.

- **Run.** Pick a host and one of its deployed models. The app generates one
  grand-total query per metric and one breakdown per hierarchy level
  (ps-utils `generate-queries-from-model`), each in MDX and SQL. Then pick:
  - the hosts to run on. A host counts as having the model when it has a cube
    with the same name, even if its catalog name carries a branch suffix.
  - which queries to run (filter by totals / level breakdowns, or search)
  - MDX and/or SQL, workers per host, and the aggregate / cache flags
  - whether to annotate each query with a `/* {run_id, …} */` comment, so
    AtScale's query log can be matched to the run

  The queries run like ps-utils `execute-atscale-query-harness`. Each one
  records its status, time, size and checksum, and the result rows are stored
  too. Each host's model (DMV) is snapshotted at the start of the run.
- **Results.** Runs are grouped by model, newest first. A run's detail shows:
  - a **promotion check** for each host against a baseline host you pick:
    whether the model is identical and all results are identical, what failed,
    and how the time compares. A banner says whether it's safe to promote.
  - per-host totals (ok / failed, average and max time)
  - every execution per host. Opening one shows its text, any errors, and its
    **history** across past runs: time, size, and whether the result changed.
- **Compare results.** Baseline vs candidate, each picked as model → run →
  host. That can be two hosts in one run (Dev vs QA), or the same host in two
  runs (before and after a redeploy). Queries are matched by name, rows by
  member, and values per measure, within a tolerance you pick (exact to 1%).
  You get:
  - a verdict, plus model / results / response-time checks
  - problem queries first: Differs, Failed on baseline / candidate, Missing
  - for each differing query, a variance table (member, measure, baseline,
    candidate, Δ, Δ%) and any rows found on only one side
  - a CSV export of the comparison
- **Compare model.** A live DMV diff of two deployed models. Metrics and levels
  are listed as *Only in baseline*, *Only in candidate* or *Changed*, with the
  baseline → candidate value. **Show matching objects** lists the rest.

**Keeping the lists current.** The model pickers (Run, Compare model) and the
run pickers (Compare results) reload their list when you open them if it's
more than 30 seconds old, so a model deployed or a run finished a minute ago
shows up. **↻ Refresh** (Run, Compare results, Compare model) reloads
everything Test holds: every host's models, the generated queries, runs and
comparisons. Use it after redeploying a model under the same name, since the
generated queries for a model already picked are kept until then.

MDX sizes are **cell** counts (rows × measures) and SQL sizes are row counts. A
level whose key repeats (for example a month name keyed by day) is compared as
a multiset, so row order never makes equal results differ.

### Promote

The source (group and host) is on top and the target is below. Choose
**Models** or **Aggregates** in the rail.

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

#### How aggregate promotion works across hosts

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
   - connection id → the target model's connection. Environments don't share
     connection ids (for example `Postgres14` on Dev, `PG_PROD` on Prod), so
     each source connection is paired with a target one through the datasets
     both models read: every dataset in the catalog names its connection. If
     that doesn't settle it, the same id is used when the target model has it,
     then the target model's only connection. With no mapping found, the
     source id is kept. The swap also applies inside the aggregate plan, for
     AtScale builds that reference the connection there. The result lists any swap, e.g. `Postgres14 → PG_PROD`.

   If an aggregate references something the target model doesn't have, it's
   skipped and the missing names are listed.
5. **Re-check at promote time.** The target's current state is re-read before
   importing, in case it changed since the diff was shown.

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

### Manage → Analyze

An audit of one model. Pick a group, a host, then a model. Everything the model
uses is listed with its file, its `description`, and the `#` comments written
next to it in the YAML.

**Where it reads from.** The model's SML comes from its Git repo at the commit
that is deployed. If that commit isn't known, it uses the head of the branch,
and the toolbar says so. When the model is deployed, the host is also asked
what it actually serves:

- its measures, dimensions, hierarchies and levels, compared with the SML
- its aggregates, counted by type and status

**What it covers.** Every property the
[SML reference](https://github.com/semanticdatalayer/SML/tree/main/sml-reference)
documents (v1.8, 296 properties across 47 object kinds). Keys that the
reference doesn't document are listed too, marked *undoc*. A test parses the
reference docs and fails if a documented property isn't covered, so a spec
update can't go unnoticed.

Each tab opens with a switch that shows one view at a time:

| Tab | Views |
|---|---|
| Overview | **Summary** (model, commit, catalog settings, counts) · **Deployed on host** · **Shape** (calculation methods, formats, folders, role plays) · **Findings** |
| Relationships | **Matrix**: dimensions × fact datasets, laid out like Design Center. Each cell lists the role-played `[Hierarchy].[Level]` the fact joins to, with the key (`orderdatekey → datekey`). Dimensions reached through another one sit under it. · **Diagram** · **Metric reach**: which dimensions each metric can be sliced by |
| Time & calcs | **Time dimensions** (time unit per level, parallel periods) · **Calculation groups** (every member: template or expression, format, precedence, default) · **Time calculations** (MDX time functions such as ParallelPeriod or PeriodsToDate) · **Semi-additive** |
| Metrics | All · Metrics · Calculations. Click a row for every property. |
| Dimensions | All · Standard · Time · Degenerate · With calc groups. Hierarchies, every attribute (level, secondary, alias, metrical) and calculation groups. |
| Datasets | All · Fact · Dimension · SQL query. Columns (calculated, map, dialects), incremental, alternate, dataset properties. |
| Joins | Fact → dimension · Snowflake · Embedded · Row security. Keys, levels, role play, many-to-many, constraint translation. |
| Other | Catalog · Connections · Row security · Perspectives · Drill-throughs · User aggs · Partitions · Overrides · Dataset props · Packages · Unused objects in the repo · Undocumented keys |
| SML Properties | Every property in the reference, grouped by SML file, with how many objects set it |

**Findings** come in four groups:

- **References.** Things that don't resolve, such as:
  - a column that isn't in its dataset
  - a level, relationship, metric or attribute that doesn't exist
  - an override or `hidden_models` entry with no match
- **SML reference rules.** Where the model breaks a rule the reference states, such as:
  - a constraint translation without its rank
  - partition or distribution ranks that don't run 1, 2, 3…
  - a percentile metric without quantiles
  - `m2m` on a relationship that isn't embedded
  - member-model UDAs in a composite, which are ignored
- **Design.** Patterns worth a second look, such as many-to-many joins,
  composite keys, SQL datasets, hidden objects, or levels with no sort column.
- **Documentation.** Objects with no description.

**Export JSON** downloads the whole audit.

### Settings

**Hosts & Git** (of the business unit picked in the header)

- **Hosts.** Register any number of AtScale container hosts. Each one has a
  label, a hostname (no scheme or port), a Keycloak ID and password, an
  optional API token, and a group (Dev, Test, QA or Prod). A host belongs to
  the business unit it was added in.
  - **Test connection** logs in and makes one cheap call. On success it records
    the host's ids (models, catalog objects, aggregate instances) in the
    working folder.
  - Secrets are never sent back to the browser. The UI only knows whether a
    password or token has been saved.
- **Git profile.** One GitHub username, email and personal access token
  (`repo` scope) per business unit, shared by its hosts. **Test Git** checks
  the token. Linking, deploying and promoting models, and Build's deploy, are
  disabled until it works.

**Business units**

- Add, rename and remove business units, or switch to one. A BU can only be
  removed once it has no hosts, and the last one always stays.
- Nothing crosses a BU boundary: another BU's hosts are "not found" to the
  API, so you can't promote, test or deploy across BUs. Build keeps its
  working copies per BU (`workspace/models/<bu>/<model>`), Test lists only the
  runs on the BU's hosts, and Monitor / Discovery clean-ups without a host
  touch only the BU's hosts.
- Switching BU clears the Build canvas (it asks first when tables are on it),
  since its model belongs to the BU it was loaded in.

**Cache & Database**

- **Cache.** The list cache in the working folder (see *Caching and storage*):
  how many lists, how many are fresh, their size. You can show the contents
  and clear it.
- **Database.** The Test history in `workspace/tests.db`:
  - stored runs, executions and result data per model, with the oldest and
    newest run
  - **Delete runs** older than N days and/or beyond the newest N per model, for
    all models or one, with a count shown before anything is deleted
  - **Compact** gives space freed by deleted runs back to the disk
- **Discovery.** Build › Discovery's stored profiles in `workspace/discovery.db`:
  - each profiled table with its host, runs, size and last profile
  - **Delete profile runs** older than N days and/or beyond the newest N per
    table, for all hosts or one, with a count shown before anything is
    deleted. A table left with no runs is profiled again on its next visit,
    and its stored samples, top values and join checks go with it.
  - **Compact** gives the freed space back to the disk

---

## Running it

### Requirements

- Python 3.11+ and Node 20+ (developed on Python 3.14 and Node 26)
- network access to your AtScale hosts and to `api.github.com`
- a GitHub personal access token with `repo` scope

### First-time setup

```bash
git clone --recurse-submodules https://github.com/AtScaleInc/ps-utils.git
cd ps-utils/web-manager
```

The Environment Manager lives in `web-manager/` of the ps-utils repo: it is the
web UI, ps-utils (the repo root) is the CLI it ports from.

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
your PATH.

The first run installs the frontend packages (`npm install` in `web/`)
automatically, including the pinned `sml-cli` that Build's **Validate** uses.
After pulling changes that touch dependencies, run `npm install` in `web/` and
`pip install -r api/requirements.txt` again.

### Start

```bash
./start.sh
```

- API: http://127.0.0.1:5050, log in `.logs/api.log`
- Web: http://127.0.0.1:5174, log in `.logs/web.log`

Open the web URL and go to **Settings → Hosts & Git**. Save and test the **Git**
profile, then add hosts to each group and **Test connection**.

`start.sh` first stops anything already bound to its two ports. To use other
ports:

```bash
API_PORT=5060 WEB_PORT=5184 ./start.sh
```

### Demo mode (no AtScale host needed)

```bash
ENV_MANAGER_FAKE=1 ./start.sh
```

This runs against an in-memory backend seeded with sample data: two business
units (Sales Analytics with six hosts across the four groups, Finance with
two), seven models, and aggregates with duplicates, stale
rows and user-defined rows. Manage and Promote can be tried in full here.
Each demo environment names its warehouse connection differently (`PG_DEV`,
`PG_QA`, `PG_PROD`), so promoted aggregates show the connection swap.

- Demo hosts are stored in `api/connections.fake.yaml`.
- Demo data goes to its own files: `workspace/cache-demo/`,
  `workspace/models-demo/`, `workspace/tests-demo.db` and
  `workspace/discovery-demo.db`.
- In Build, every demo host has a `PostgresDB` warehouse except prod-west, so
  you can see a deploy skip a host. Deploy doesn't really push to Git.
- Build's Discovery works in full: the demo warehouse is an in-memory SQLite
  with generated rows, and the real profile SQL runs against it.
- Build's Preview, Load from Git, and the Test tab run real queries, so they
  need a real host.
- Manage → Analyze reads AtScale's `sml-demo-sales-insights` repo for every
  demo model, copied into `api/atscale/demo_sml/`. The **Deployed on host**
  view needs a real host.
- **Settings → Hosts & Git → Reset demo data** restores the seed.

### Tests and build

```bash
cd api && ~/Development/venv/atscale-env-manager/bin/python -m pytest tests -q
```

```bash
cd web && npm run build
```

The API tests cover:

- Promote: the diff states, duplicate and system-only filtering, model matching
  by name, name-based aggregate fingerprints across hosts with different ids,
  and payload remapping (including the import schema's required fields)
- the credential store round-trip (secrets masked) and hostname normalisation
- caching and its disk mirror
- full promote flows against the demo backend
- Build: SML generation and parsing, sml-cli validation, per-host sources and
  schemas, multi-host deploy with its preflight, the preview MDX builder
  (including levels of one hierarchy), and freehand MDX/SQL
- Discovery: the profile, top values and join check running on the demo
  warehouse, roles and findings, results served from the store instead of
  re-read, drift between runs, cleanup, and a statistics 404 on older AtScale
  builds
- Test: query generation (level names, not captions), the harness (checksums
  ignore per-response timestamps; `<FmtValue>` isn't counted), result variance
  and model diffs, the compare endpoint, the SQLite store (history, retention,
  restart recovery, JSON import), cleanup, the concurrent-run cap and job pruning

---

## Configuration and data

| Path | What | In Git? |
|---|---|---|
| `api/connections.yaml` | Hosts, credentials, Git token. Written by Settings, file mode 0600. See `api/connections.yaml.sample`. | **no** (gitignored) |
| `api/connections.fake.yaml` | Demo-mode hosts | no |
| `workspace/cache/` | Every cached list as readable JSON (demo: `cache-demo/`) | no |
| `workspace/models/<model>/` | Build's working copy of each model's SML, also the Git checkout it pushes from (demo: `models-demo/`) | no |
| `workspace/tests.db` | Test runs, model snapshots and result rows, in SQLite (demo: `tests-demo.db`) | no |
| `workspace/discovery.db` | Build › Discovery profiles (with history), sample rows, top values and join checks, in SQLite (demo: `discovery-demo.db`) | no |
| `workspace/monitor.db` | Monitor query history, in SQLite (demo: `monitor-demo.db`) | no |
| `workspace/tests-imported/` | Test runs from the earlier JSON layout, left after their one-time import into `tests.db`. Safe to delete. | no |
| `.logs/` | API and web logs from `start.sh` | no |

`connections.yaml` keeps business units under `businessUnits.<id>: {label,
git}`, each with its own Git profile. Hosts use the ps-utils connection
layout: each is an entry under `connections:` with an `atscale:` block, plus
`bu`, `env` (`dev` / `test` / `qa` / `prod`), `label`, `status`, `links`
(repos linked through the app) and `deployments` (the commit this app
deployed per catalog). A file from before business units (one Git profile at
`connections.git.git`) is read as one BU, `default`, and saved in the new
shape; Build's existing working copies move into `workspace/models/default/`.

Environment variables:

| Variable | Default | Purpose |
|---|---|---|
| `API_PORT` / `WEB_PORT` | `5050` / `5174` | Ports used by `start.sh` |
| `ENV_MANAGER_FAKE` | unset | `1` runs the demo backend |
| `ENV_MANAGER_CONNECTIONS_FILE` | `api/connections.yaml` | Location of the credential store |
| `ENV_MANAGER_WORKSPACE` | `./workspace` | Location of the working folder |
| `ENV_MANAGER_CACHE_TTL` | `7200` | How long cached lists stay valid, in seconds |
| `ENV_MANAGER_MODELS_DIR` | `workspace/models` | Where Build keeps each model's working copy |
| `ENV_MANAGER_TESTS_DB` | `workspace/tests.db` | Location of the Test database |
| `ENV_MANAGER_TEST_KEEP` | `100` | Runs kept per model; older ones are pruned after each run |
| `ENV_MANAGER_TEST_MAX_AGE_DAYS` | `90` | Runs older than this are pruned after each run |
| `ENV_MANAGER_TEST_MAX_ACTIVE` | `3` | Test runs that can execute at once; more are refused until one finishes |
| `ENV_MANAGER_DISCOVERY_DB` | `workspace/discovery.db` | Location of the Discovery database |
| `ENV_MANAGER_DISCOVERY_KEEP` | `20` | Profile runs kept per table; older ones are pruned after each profile |
| `ENV_MANAGER_MONITOR_DB` | `workspace/monitor.db` | Location of the Monitor query-history database |
| `ENV_MANAGER_MONITOR_DEFAULT_DAYS` | `2` | How many days back the first poll of a new host reaches |
| `ENV_MANAGER_MONITOR_MAX_PAGES` | `200` | Pages (100 queries each) one poll reads before stopping; the poll is then marked truncated |
| `ENV_MANAGER_MONITOR_MAX_AGE_DAYS` | `90` | Stored queries older than this are pruned |
| `ENV_MANAGER_PREVIEW_MAX_ROWS` | `1000` | Most rows a Build › Preview query returns. The limit is part of the query (MDX `HEAD`, SQL `LIMIT`); typed MDX is only trimmed after it runs |

### Caching and storage

Container calls are slow: each list needs authentication and several REST
calls. To keep switching between hosts, models and views instant:

- **Session reuse.** Each host keeps its AtScale login token between requests.
- **Server cache.** Every list (models, aggregate models, aggregates, repos,
  branches, id maps, commit comparisons, Build's data sources and schema trees)
  is cached per host and per model for **2 hours**. Each one is also written to
  `workspace/cache/…json` with its load and expiry times, so you can see exactly
  what's being served, and a restarted API picks it up.
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
  - Saving a business unit's Git profile clears its hosts' cache and its Git lists.
- **Builds.** Aggregate lists that contain Building rows are cached for only
  5 seconds, so builds show progress.
- **Not cached:** preview and Test queries, which always go to the host. Model
  metadata can change between one deploy and the next.

Discovery results aren't in the list cache either. They're kept in
`workspace/discovery.db` with no expiry, because a profile scans a whole table;
**Re-profile** and each panel's refresh are what read the warehouse again.

Test history lives in `workspace/tests.db`, not the cache. Each execution is
written as soon as it finishes, so a restart mid-run keeps what's done (that
run is then marked failed). Background jobs (deploy, build, promote) are kept in
memory: finished jobs for an hour, at most 500.

---

## Architecture

```
web/  React 19 + TypeScript + Vite · TanStack Query (server state) · zustand (UI state)
  src/build/        Build: discovery, wizard panels, SML model store, preview (DMV / Freehand)
  src/components/   Manage (incl. ManageAnalyze), Promote, Settings
  src/test/         Test: run setup, results, compare results, compare model, database card
  └─ /api/* ──► api/  Flask
                 routes/      settings (hosts, git, cache) · objects (models, aggregates, jobs) · promote
                              build (sources, SML, preview, multi-host deploy) · discovery · testing (Test)
                              analyze (Manage → Analyze)
                 envs/        store.py (connections.yaml) · registry.py (host → backend, sessions, warm-up)
                 atscale/     client.py (AtScale REST) · github.py · git_ops.py (repo create + push)
                              backend.py (real host) · fake.py (demo host) · cached.py (cache wrapper)
                              preview.py (DMV metadata, MDX/SQL preview)
                 smlgen/      SML build / parse / validate (sml-cli)
                 discovery/   profile.py (profile SQL, top values, join check, roles + findings) · store.py (SQLite)
                 promote/     diff.py (states + rules) · idmap.py (id ↔ name) · remap.py (payload rewrite)
                 analyze/     model.py (SML audit, fact × dimension reach, time intelligence, findings)
                              spec.py (every property in the SML reference)
                 testing/     generate.py (queries) · harness.py (execution) · model.py (DMV snapshot + diff)
                              results.py (result rows + variance) · store.py (SQLite)
                 cache.py     2 h cache + working-folder mirror
                 jobs.py      background jobs for deploy / build / promote (UI polls /api/jobs/:id)
reference/PythonAtscaleUtility  git submodule, read-only reference for porting
../  (ps-utils root)            the CLI: src/ is the porting source cited in comments
```

### AtScale calls used (container hosts only)

| Purpose | Call |
|---|---|
| Authentication | Keycloak password grant, or `POST /v1/token` to exchange an API token for a JWT |
| Deployed models | `GET /wapi/p/projects/deployed`, `GET /v1/catalogs` (for `publishedAt`), `GET /wapi/p/catalog/{id}` |
| Repos | `GET/POST /wapi/p/repo`, `DELETE /wapi/p/repo/{id}` (publishing shared dimensions only attaches: `POST /wapi/p/repo`) |
| Deploy repo@branch | `POST /v1/catalogs/deploy` `{repoUrl, gitToken, branch}`; on a 404 (older builds), local catalog-XML compile + `POST /wapi/git/deploy/catalog`, with `package.yml`'s packages fetched at their pinned commit and compiled in |
| Undeploy catalog | `DELETE /wapi/p/catalog/{catalogId}` |
| Catalog representation (id ↔ name) | `GET /v1/catalogs/{id}/export` |
| List aggregates | `GET /wapi/p/aggregate/definition?catalogId&modelId&page&limit` |
| Deactivate / reactivate | `PUT /v1/aggregates/definitions/{id}/block` · `/unblock` |
| Build | `POST /v1/aggregates-batch/catalogs/{c}/models/{m}?isFullBuild=` |
| Build history | `GET /wapi/p/aggregate/batch-history` |
| Export / import | `GET /v1/aggregates/export/…` · `POST /v1/aggregates/import/…` |
| Data warehouses, schema tree (Build) | `GET /wapi/p/data-warehouses`, `/wapi/p/data-sources/conn/{connectionId}/databases/…/tables/{t}/info` |
| Profile SQL (Discovery), Preview data (Develop) | `POST /wapi/p/data-sources/conn/{connectionId}/query/sample` `{query, udf}`: AtScale runs it on the warehouse, wrapped in `LIMIT 10` |
| Sample rows, statistics (Discovery) | `GET /engine/v1/datasources/{connectionId}/sample-data/{schema}/{table}`, `/engine/v1/datasources/{connectionId}/statistics` (newer engines only) |
| DMV metadata, MDX queries (Preview, Test, Analyze) | `POST /engine/xmla` (`MDSCHEMA_CUBES / DIMENSIONS / HIERARCHIES / LEVELS / MEASURES / PROPERTIES`, and MDX) |
| SQL queries (Preview, Test) | `POST /engine/query/submit` |

Analyze also reads the model's SML from GitHub
(`GET /repos/{owner}/{repo}/tarball/{commit}`), and so does Build for shared
dimension packages (at the commit pinned in `package.yml`). The Shared dims list
reads `catalog.yml` and `models/` of the Git profile's repos
(`GET /repos/{owner}/{repo}/contents/…`) and resolves a branch head with
`GET /repos/{owner}/{repo}/commits/{branch}`.

Sources: the AtScale Container API docs, ps-utils, and SML's API SDKs. See
`docs/BUILD_PLAN.md` for which source each call comes from, what has been
verified on a live host, and the design decisions.

### App API (for scripting)

All routes are under `/api`. List endpoints accept `?refresh=1` and return
`cachedAt`. Long-running calls return a job, and you poll `GET /api/jobs/:id`.

```
Settings        GET/POST /hosts · PATCH/DELETE /hosts/:id · POST /hosts/:id/test
                GET/PUT /git · POST /git/test · GET /git/repos · /git/repos/models · GET/DELETE /cache
Manage          GET /hosts/:id/models · /repos · /branches?url= · /aggregate-models · /aggregates?catalogId&modelId
                POST /hosts/:id/models/link · deploy · undeploy · unlink
                POST /hosts/:id/aggregates/build · deactivate · reactivate · GET /hosts/:id/aggregates/builds
                GET /hosts/:id/analyze?key=<model key> · /hosts/:id/analyze/file?key=&path=
Promote         POST /promote/diff · /promote/models · /promote/aggregates
Build           GET /hosts/:id/sources · /sources/:sourceId/schemas?search= (poll while a schema is `loading`)
                GET /hosts/:id/sources/:sourceId/columns?schema=&table= · POST …/columns {tables} · GET /build/repos
                GET /hosts/:id/preview/catalogs · /preview/metadata · POST /preview/query · /preview/freehand
                POST /sml/generate · validate · save · save-path · import · import-path · import-git · GET /sml/models
                  (import returns builtHere + unsupported[]; save / save-path / build/deploy answer 409
                   {readOnly, unsupported} over a working copy Build can't write back)
                POST /build/deploy {…model, hostIds, shared?} (shared: push, then attach only) · GET /build/preflight?connection=&hostIds=
                GET /build/shared-repos?hostId= · POST /build/shared/load {repoUrl, branch, taken: [package names]}
Discovery       GET /hosts/:id/discovery/table · /discovery/profile[?id=] · /discovery/top-values?column=
                  (table args: ?source=<connectionId::database>&schema=&table=)
                POST /hosts/:id/discovery/join-check {…table, column, toSchema, toTable, toColumn}
                POST /hosts/:id/discovery/data-preview {source, mode: rows|aggregate|check, tables, columns}
                GET /discovery/store · POST /discovery/cleanup {olderThanDays, keepPerTable, hostId, dryRun}
                POST /discovery/compact
Test            GET /hosts/:id/test/cubes · POST /test/generate · /test/runs · /test/compare · /test/model-compare
                GET /test/runs · /test/runs/:id · /test/runs/:id.csv · /test/history?model=&query=&protocol=
                GET /test/store · POST /test/cleanup {olderThanDays, keepPerModel, model, dryRun} · /test/compact
Jobs            GET /jobs/:id
```

---

## Known limits

- **Container hosts only.** Installer-style hosts (`:10500`/`:10502` URLs with
  `orgId`) aren't supported.
- **Older AtScale builds deploy the Design Center way.** Builds without
  `POST /v1/catalogs/deploy` (it answers 404, e.g. 34.x containers) fall back
  to compiling the catalog XML locally from the repo's SML and posting it to
  `/wapi/git/deploy/catalog`, as sml-wizard did. The catalog is then named
  `<catalog>_<branch>` (e.g. `sales_catalog_main`); models and cubes keep their
  names, so Promote and Test still match them.
- **Deploy needs a real Keycloak username and password**, not just an API
  token. Accounts that only sign in through SSO can't deploy.
- **Deploy is by branch, not commit.** A deploy always gets the branch's head
  commit.
- **Versions of catalogs deployed outside this app are inferred** from the
  publish time (shown with `~`).
- **Build models one physical table per dimension, with one hierarchy each,**
  and only the SML it can write back. A loaded model using anything else
  (semi-additive metrics, row security, several models, composite keys,
  folders, formats, …) is read-only in Build: no Save, no Deploy. Most models
  made in Design Center fall in this group; edit them there.
- **Shared dimensions are read-only in the model that uses them.** Change them
  in their own repo (load it in Build, edit, **Publish**), then pick it again
  in Shared dims to move the model to the new commit. A join to a shared
  dimension must land on one of its level key columns, since Build can't
  change its keys. A dimension-to-dimension join can only start from one of
  your own dimensions. The package's warehouse connection must exist on every
  host the model deploys to. A model only deploys the commit pinned in
  `package.yml`, never "latest", which SML's validator rejects. Shared repos
  published before the `_shared_dim` connection name was added clash with
  the model's own connection: republish them.
- **Preview data returns 10 rows,** the engine's fixed limit on `query/sample`.
  **Check joins** scans every row of the joined tables. Calculations (MDX)
  aren't previewed.
- **A Build deploy needs the same warehouse connection id on every target host**
  (for example `Postgres14`). Hosts without it are skipped.
- **The DMV doesn't say which dimensions a measure relates to**, and AtScale
  rejects `MDSCHEMA_MEASUREGROUP_DIMENSIONS`. So Compare model can call two
  models identical when one of them can't answer some queries. The result
  compare still catches it, as failed queries.
- **Generated level breakdowns select every metric** (as ps-utils does), so one
  metric that isn't related to a dimension fails every breakdown on it.
- **Discovery reads the warehouse through AtScale's `query/sample`,** which
  returns at most 10 rows. So the profile sticks to checks that fit one
  aggregate row or a top 10: no median, skew or trend over time. A check a
  warehouse rejects (for example `TRIM` or `CURRENT_DATE`) is left empty rather
  than failing the column.
- **Analyze reads the SML from Git.** A model with no repo attached can't be
  analyzed. The live host check matches the model's catalog and cube by
  name, because the XMLA catalog name is `<catalog>_<branch>`.
- **Metric reach covers metrics, not calculations.** What a calculation can be
  sliced by depends on its MDX.
- **Single process.** Sessions and background jobs live in memory. Test history,
  Discovery results and the list cache are on disk.

## Related

- `CLAUDE.md`: conventions for working on this repo with Claude Code
- `docs/BUILD_PLAN.md`: the call map, decisions and open items
- `docs/handoff-ps-utils-aggregate-import.md`: the aggregate import fix
  requested upstream in ps-utils
- `docs/handoff-ps-utils-query-testing.md`: query generation and harness fixes
  for ps-utils, found while building Test
- Build replaces the standalone `sml-wizard` repo, which is being deprecated
