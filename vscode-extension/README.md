# AtScale PS-Utils — VS Code Extension

Run [`ps-utils`](../README.md) operations directly from the VS Code Explorer.

## What it does

Right-click any file or folder in the Explorer to get a **PS-Utils** submenu containing the
operations that make sense for that target, grouped exactly as in the main README:

- Right-click a **file** → operations that take an input file (the file is prefilled).
- Right-click a **folder** → operations that take a directory, plus **net-new generators**
  (e.g. `*-from-atscale`) that write an output file into the folder — the folder becomes the
  destination and the output path is prefilled as `<folder>/<name>`.
- A **General** group (operations that need neither, such as the `atscale-list-*` commands) and
  **Settings…** appear on both.

Project-wide files (connection file, style config) are prefilled from your saved settings. For an
operation whose only file parameter is such a settings file (e.g. `atscale-list-repos`, which just
needs a `--connection-file`), right-clicking a **file** fills that parameter with the clicked file,
overriding the setting — so you can point it at a specific connections file directly.

Choosing an operation opens a dialog with every parameter for that operation. The clicked
path and your project settings (connection file, style file, common params) are prefilled.
**Execute** runs the CLI in a reused `PS-Utils` terminal; **Cancel** closes the dialog.

When an operation has a `--connection-file` and a connection-name parameter — `--connection-name`,
`--atscale-connection-name`, or `--target-connection-name` — that parameter is a **dropdown**
populated from the connections file. Change or Browse to a different connection file and the
dropdown(s) refresh to that file's connections. (`--new-connection-name`, which names a connection
being created, stays free-text.)

Works on **Windows, macOS, and Linux**. Command arguments are quoted for the terminal's shell —
PowerShell on Windows and POSIX (bash/zsh) elsewhere by default; override with
[`psUtils.shell`](#settings) if your default terminal differs (e.g. Git Bash or WSL on Windows).

## SML editing support

The extension also makes the editor understand [SML](https://github.com/semanticdatalayer/SML)
itself, so hand-editing a model is not a matter of remembering property names.

- **Completion and hover documentation** for every documented property of every SML object type,
  with its type, whether it is required, the version it was added in, and the prose description
  from the specification.
- **Validation** — unknown enum values (a misspelled `calculation_method`), wrong value types, and
  missing required properties are flagged as you type.
- **Typo detection** — a key the specification does not document is warned about, with a quick fix
  when a documented property is close enough to name (`colums` → `columns`). See
  [Undocumented keys](#undocumented-keys) for why this is separate from validation.
- **SML-aware syntax highlighting** — `object_type` and its value, and the keys that point at
  other SML objects (`dataset`, `dimension`, `connection_id`, `key_columns`, …) are coloured
  distinctly from ordinary YAML keys. SQL inside a dataset `sql: |` block is highlighted as SQL.

The right schema is chosen **per file, from its `object_type`** rather than from its filename, so
an unconventionally-named or unconventionally-located file still gets the correct one. Files with
no `object_type` yet — the usual state of a file you are still writing — fall back to the
conventional layout (`catalog.yml`, `dimensions/`, `datasets/`, `metrics/`, `calculations/`,
`models/`, `connections/`).

### Turning it on and off per project

The **PS-Utils** context submenu has one SML entry next to **Settings…**, which behaves as a
checkbox for the current project:

| Menu item | Shown when | Clicking it |
|-----------|-----------|-------------|
| **☑ SML Support** | on for this project | writes `psUtils.smlEnabled: false` to the project's `.vscode/settings.json` |
| **☐ SML Support** | off for this project | writes `psUtils.smlEnabled: true` there |
| **☐ SML Support (install YAML extension)** | the YAML extension is missing | offers to install it, or opens it in the Marketplace |

Because the setting is written at **workspace** scope, it applies to that project only, and takes
effect immediately — no reload. With no folder open there is nowhere project-scoped to write, so
the command offers to change the global setting instead.

From the Command Palette the same toggle is **PS-Utils: Toggle SML Support for this Project** — a
plain verb, since a checkbox glyph reads badly in a search list.

The check is drawn in the label rather than being a real checkmark because `contributes.menus`
supports only `command`, `alt`, `when` and `group`: VS Code has no `toggled` property for
extension-contributed context menu items, and a command's `title` is static. Three commands
therefore share the one slot, gated by `when` clauses, so exactly one is visible at a time.

**Syntax highlighting is not covered by this switch.** It comes from a TextMate grammar
*injection*, which the editor resolves statically from `package.json` at extension load; there is
no API to register or unregister an injection at runtime and no `when` clause on the contribution
point. So highlighting is on wherever the extension itself is enabled. In practice this matters
little — the grammar only claims SML-specific keys, so an unrelated YAML file has almost nothing
for it to match. To switch it off for one project, use **Extensions: Disable (Workspace)** on
PS-Utils.

### Requires the YAML extension

VS Code has no built-in YAML schema validation, so the schema half of this feature needs
[redhat.vscode-yaml](https://marketplace.visualstudio.com/items?itemName=redhat.vscode-yaml).
It is intentionally **not** a hard dependency — most people install PS-Utils for the operations
menu and should not have a second extension forced on them. Two paths lead to it: the menu item
above, and a one-time prompt the first time you open a file that looks like SML without it
installed (**Never** suppresses that prompt permanently).

Syntax highlighting and [undocumented-key warnings](#undocumented-keys) do not depend on the YAML
extension — both are produced by PS-Utils directly.

### Where the schemas come from

Upstream SML ships no machine-readable schema — the specification is ten hand-written Markdown
documents. The schemas here are **generated** from a vendored, commit-pinned copy of those
documents (`resources/sml-reference/` in the repo root) by `npm run generate:sml-schema`. See
[How it stays in sync with the CLI](#how-it-stays-in-sync-with-the-cli).

They are deliberately permissive about unknown properties: the specification prose lags the
implementation in places, so a strict schema would put errors on valid files — including SML that
ps-utils itself generates.

### Undocumented keys

Because the schemas accept any extra property, the YAML extension will never report a typo'd key —
`patreick: string` in a dataset validates cleanly. PS-Utils reports those itself, in its own
diagnostics channel, at **warning** severity:

> `` `colums` `` is not a documented property of SML `dataset`. Did you mean `` `columns` ``?

Where a documented property is close enough, a quick fix (<kbd>Ctrl</kbd>+<kbd>.</kbd>) renames the
key. Closeness is measured with an edit distance that counts a transposition as one edit, so
`tabel` still finds `table`; when nothing is near enough, or two candidates tie, no suggestion is
offered rather than a misleading one.

The severity is the point of the design. Making the schema strict would report the same keys as
*errors*, indistinguishable from a genuinely broken file, and there is no way to say "this rule is
softer than that one" in JSON Schema. A warning says what it means: probably a typo, possibly the
specification lagging the implementation. Keys already known to be the latter — such as
`visualize_in_bi_tool` on a hierarchy level — are allowlisted by the schema generator, scoped to the
object type and the class they occur on, so a key that is documented elsewhere still gets checked
everywhere else.

The walk is conservative by construction: it reports a key only where the schema explicitly
declares the surrounding object's properties, and stops descending at anything it cannot resolve.
It also does not look inside a key it has already reported, so one stray key produces one warning
rather than a cascade.

Set [`psUtils.smlUnknownKeys`](#settings) to `information` to keep the findings in the Problems
panel without an editor squiggle, or `off` to disable them. `psUtils.smlEnabled` gates them too.

## Monitoring a directory for model errors

Everything above validates **one file against the specification**. It cannot see that a
relationship's `join_columns` names a column that was deleted from the dataset last week, or that a
level attribute marked `is_unique_key` is not actually unique in the warehouse. Those are what
[`atscale-list-model-errors`](../README.md) checks — cross-file references in phase 1, then
joinability and uniqueness against the live AtScale engine in phase 2.

Right-click a folder → **PS-Utils → ☐ Monitor SML Directory** to run that operation continuously.
Every change to a `.yml`/`.yaml` file under the directory re-runs it, and the problems it reports
land in the Problems panel on the line that caused them. The menu item shows **☑** on a directory
that is being watched — per directory, not globally, so with two monitors only the watched folders
are ticked.

**Saves run phase 1 only.** Phase 1 resolves cross-file references locally and finishes in about a
second; phase 2 asks the engine to run SQL against the warehouse, which is far too slow to repeat on
every keystroke and blocks entirely when the instance is down. The monitor therefore passes
`--skip-engine-checks` on watch-triggered runs. Click the monitored folder again and choose
**Validate now** for a full check including the engine, or set
[`psUtils.smlMonitorEngineChecks`](#settings) to run it on every change.

You are asked once for the connections file (skipped when [`psUtils.connectionFile`](#settings) is
set) and the AtScale connection to validate against; the connection is remembered like any other
parameter, so a second directory in the same project is a single click. Right-clicking a folder
*inside* the model — `datasets/`, say — walks up to the directory holding `models/`, which is what
the operation actually needs.

Clicking **☑ Monitor SML Directory** on a directory that is already monitored offers **Validate
now**, **Show validation log**, and **Stop monitoring**. Monitors are stored per workspace and
resume when the window reloads. A status-bar item shows the current problem count and opens the log.

From the Command Palette the entries are **PS-Utils: Monitor an SML Directory…** and **PS-Utils:
Stop Monitoring SML Directory** — plain verbs, since the checkbox glyph reads badly in a search
list, exactly as for the SML support toggle.

### Where a problem ends up

**Everything the run reports becomes a Problems-panel entry** — errors as errors, warnings as
warnings, each with `atscale-list-model-errors` as its source and the validation phase
(`structural` / `engine`) as its code. The same problems are also written to the **PS-Utils SML
Validation** output channel in the operation's own format, as a timestamped record of each re-run.

Placing them takes some work, because the operation reports against SML *object names*
(`datasets/sales_fact`, `models/ → rel_date`) and never file positions — it validates a directory of
YAML and does not track where a given `unique_name` was written. The extension maps them back:

| Reported | Squiggle lands on |
|----------|-------------------|
| `Dataset 'sales_fact': connection_id 'ghost' not found` | the `connection_id: ghost` line in `datasets/sales_fact.yml` |
| `Relationship 'rel_date': join_column 'dt' not found` | `rel_date`'s declaration in the model file |
| `Engine validation failed for connectionId='default'` | names no SML object — the model file, prefixed with the reported location |

Where the message quotes a value that appears in the resolved file, the diagnostic moves onto that
line rather than the object's `unique_name` — the first row above is the common case, and the
`connection_id` line is where the edit has to happen. When nothing matches it stays on the
declaration rather than guessing at a line, and a problem that maps to no object at all is prefixed
with the operation's own location string so a diagnostic on line 1 of the model file is not
mistaken for being about that line.

A run that **fails outright** — unreachable instance, unknown connection, no model file — is itself
an error in the Problems panel (`atscale-list-model-errors could not validate <dir>: …`), and the
status bar reads `SML: validation failed`. A monitor that has silently stopped validating would
otherwise be indistinguishable from a model with no problems. The previous problems are kept
alongside it, since a failed run proves nothing about the files; the next successful run clears the
failure and replaces them.

### Cost

A run reaches a live AtScale instance and issues SQL. Changes are therefore debounced (1.2 s after
the last one), runs never overlap, and a change arriving mid-run queues exactly one re-run rather
than one per event.

There are two bounds, because an unreachable instance used to hang the whole thing indefinitely:

- The monitor passes **`--timeout`** to the operation, at half `psUtils.smlMonitorTimeout`. That
  bounds each individual AtScale request *including the token exchange*, which is where an
  unreachable instance actually stalls — long before it reaches the endpoint being called. A run
  that hits it still produces a report, with the unreachable engine as a phase 2 warning.
- **`psUtils.smlMonitorTimeout`** (default 120 s) is the outer backstop: the child is killed if the
  operation somehow fails to return anyway. That is reported as a timeout in the Problems panel and
  the log.

Without them one stalled run wedged the monitor for good — it never reported, and every later change
was coalesced into a re-run that never started, so the log simply went quiet after `validating`.

The exact command is written to the log at the start of every run, and the elapsed time on
completion, so a run that behaves oddly can be reproduced in a terminal without reconstructing it.

## Requirements

- **VS Code** 1.85 or newer.
- **Node.js** — 18.20+ or 20+ recommended. Packaging (`npm run package`) uses `@vscode/vsce`,
  whose `undici` dependency needs the `File` global (added in Node 18.20 / 20). This package pins
  `undici` to v5 via an `overrides` entry so packaging also works on older Node 18.x; without it,
  `vsce` fails with `ReferenceError: File is not defined` on those runtimes.
- **No separate CLI install.** The extension ships its own copy of `ps-utils`, bundled into
  `cli/cli.cjs` at package time, and always runs that copy. There is deliberately no setting to
  point at an external CLI: a separately installed one could be any version, and the extension's
  operation catalogue and parameter dialogs are generated from the version it was packaged with.
  Bundling makes a version mismatch impossible rather than merely detectable.

  You do **not** need Node.js on your `PATH`. The bundle runs on the Node runtime inside VS Code
  itself (`process.execPath` with `ELECTRON_RUN_AS_NODE=1`), which is why the command echoed into
  the terminal names the VS Code binary rather than `node`.

## Installation

### Option A — install a packaged `.vsix` (recommended for users)

1. Build the CLI bundle from the repo root. `npm run build` does this as its last step, or run
   it alone:

   ```bash
   npm run bundle:cli     # writes vscode-extension/cli/ — required before packaging
   ```

   `cli/` is a build artifact and is git-ignored; packaging without it produces an extension that
   cannot run anything.

2. Build the extension package (produces `atscale-ps-utils-<version>.vsix`, ~2 MB):

   ```bash
   cd vscode-extension
   npm install
   npm run compile
   npm run package        # requires @vscode/vsce (installed as a devDependency)
   ```

   A `WARNING  LICENSE ... not found` line is harmless. If packaging fails with
   `ReferenceError: File is not defined`, your Node is older than 18.20 — the pinned `undici`
   override normally prevents this; run `npm install` again to ensure it took effect.

3. Install it into VS Code, either from the UI or the command line:

   - **UI:** Extensions view → `⋯` menu → **Install from VSIX…** → pick the `.vsix`.
   - **CLI (any OS):**

     ```bash
     code --install-extension atscale-ps-utils-0.1.9.vsix
     ```

     On Windows, `code` is the VS Code CLI (available if "Add to PATH" was selected during
     install); otherwise use the full path or run it from a Developer/VS Code terminal.

4. Reload VS Code. Right-click a file or folder in the Explorer to see the **PS-Utils** menu.

To share the extension, distribute that single `.vsix` file — teammates install it the same way.

### Option B — run from source (for development)

See [Develop](#develop) below (press **F5** to launch an Extension Development Host without
packaging).

## How it stays in sync with the CLI

**The extension ships the CLI it was built against.** `npm run bundle:cli` writes
`cli/cli.cjs` — a single-file esbuild bundle of ps-utils, with its `.ejs` templates beside it under
`cli/operations/` — and the extension runs only that copy. The menus, the parameter dialogs and the
executing CLI are therefore generated from one build by construction, and there is no setting that
can point at a different one.

This replaced an earlier arrangement where the extension resolved a CLI at run time (a workspace
`node_modules/.bin` entry, else `npx`) while its operation catalogue stayed frozen at package time.
Those two could disagree on a client machine in ways that were invisible: a parameter added to the
CLI simply never appeared in a dialog, and a behavior change appeared as a wrong answer with nothing
in the output identifying which build produced it.

The menu, operations, and parameters are read from `media/operations.manifest.json`, which is
generated from the same ps-utils operation registry and the shared `OPERATION_GROUPS` list:

```bash
# from the repo root
npm run build            # regenerates the manifest + menu contributions + the CLI bundle
# or individually:
npm run generate:extension-manifest
npm run generate:extension-contributes
npm run bundle:cli
```

`generate-extension-contributes` rewrites this package's `contributes.commands/submenus/menus`
from the manifest, so adding or changing an operation in the CLI automatically updates the menus.
It preserves every other field, so the `configuration`, `yamlValidation` and `grammars`
contributions are hand-maintained and safe to edit.

Commands that are **not** operations — `Settings…`, the SML support checkbox, and the
[monitor](#monitoring-a-directory-for-model-errors) entries — are declared in that script's
`SML_MENU` and `MONITOR_MENU` tables, never in `package.json` directly, since the next build
overwrites `commands`/`submenus`/`menus` wholesale.

The SML schemas and the injection grammar are generated too, from the vendored specification:

```bash
npm run generate:sml-schema     # also part of npm run build
```

That writes `media/sml-schema/*.schema.json` (one per SML object type, plus `index.json`) and
`syntaxes/sml.injection.tmLanguage.json`. **Do not edit those by hand.** To pick up a new SML
release, refresh `resources/sml-reference/` per its `UPSTREAM.md` and regenerate; the generator
fails loudly rather than quietly dropping properties if the documents change shape.

`index.json` also carries `knownUndocumented`, the allowlist behind
[undocumented-key warnings](#undocumented-keys). It comes from the generator's `KNOWN_UNDOCUMENTED`
table, which is checked on every run: naming a class that no longer exists, or one that has since
gained the property, fails the build rather than leaving a stale entry that would suppress real
typos.

## Settings

Set via the **Settings…** menu item (writes workspace `.vscode/settings.json`):

| Setting | Purpose |
|---------|---------|
| `psUtils.connectionFile` | Prefilled into `--connection-file` |
| `psUtils.styleFile` | Prefilled into `--sml-config-file` |
| `psUtils.modelName` | Prefilled into `--model-name` |
| `psUtils.shell` | Terminal shell for argument quoting: `auto` (default), `bash`, `powershell`, or `cmd` |
| `psUtils.commonParams` | Map of `param-name` → value prefilled into any matching dialog (explicit pins) |
| `psUtils.rememberParameters` | Remember the last value entered for each scalar parameter and reuse it across operations (default `true`) |
| `psUtils.smlEnabled` | [SML schema support](#sml-editing-support) — completion, hover docs and validation for SML YAML files (default `true`). Set per project; see [Turning it on and off per project](#turning-it-on-and-off-per-project) |
| `psUtils.smlUnknownKeys` | Severity for [keys the specification does not document](#undocumented-keys): `warning` (default), `information`, or `off` |
| `psUtils.smlMonitorTimeout` | Seconds a [monitored validation run](#cost) may take before it is cancelled (default `120`) |
| `psUtils.smlMonitorEngineChecks` | Run the slow phase 2 engine checks on every change while monitoring, not just structural ones (default `false`) |

### Remembered parameters (cross-operation defaults)

When you execute an operation, the values you entered for its scalar parameters (not files/folders) are
remembered per workspace. The next time you open **any** operation that has a parameter of the same name,
that value is prefilled — so a `--model-name` or `--connection-name` chosen in one operation defaults into
the next. Toggle with `psUtils.rememberParameters`; view and **Clear remembered parameters** from the
**Settings…** panel.

Prefill precedence, highest first: the clicked file/folder → `psUtils.commonParams` (explicit pins) →
remembered last-used value → a dedicated setting (`connectionFile` / `styleFile` / `modelName`) → the
operation's default.

CLI resolution when `cliCommand` is blank: local `node_modules/.bin/atscale-utils` (`atscale-utils.cmd` on Windows) → `npx --yes @atscale-ps/ps-utils`.

`psUtils.shell` defaults to `auto`, which picks **PowerShell on Windows** and **POSIX** elsewhere.
Set it to `bash` when using Git Bash or WSL as your default terminal on Windows, or to `cmd` for
the classic Command Prompt, so paths with spaces are quoted correctly.

## Develop

```bash
cd vscode-extension
npm install
```

Then press **F5**. That launches an **Extension Development Host** — a second VS Code window
running the extension straight from `dist/`, entirely separate from the editor you are working in.
Three launch configurations are provided:

| Configuration | Use |
|---|---|
| **Run PS-Utils Extension (watch)** | everyday loop; rebuilds on save |
| **Run PS-Utils Extension (watch + SML corpus)** | same, and opens the committed SML fixture corpus so there are real SML files to test against |
| **Run PS-Utils Extension** | one-shot build, no watcher |

### The reload rules

What you changed determines what you have to do — and none of it involves restarting your own
editor:

| Changed | To pick it up |
|---|---|
| TypeScript under `src/` | **Ctrl+R** / **Cmd+R** in the dev-host window (the watcher has already rebuilt) |
| `package.json` contributions — `commands`, `menus`, `configuration`, `grammars`, `yamlValidation` | **Shift+F5** then **F5** — restart the debug session |
| SML schemas or the grammar | `npm run generate:sml-schema` from the repo root, then restart the debug session |

The second row is the one that catches people. `contributes.configuration` and the menu
contributions are registered **once per application session**, not per window, so a window reload
will not see them — and neither will a brand-new window, since every window shares the
application's extension scan. Restarting the debug session is enough because each launch is a
*fresh* dev-host application.

### Do not install a `.vsix` to test changes

Installing the packaged extension into your main VS Code is the *distribution* path, not the
development path. Because contributions are registered per application session, replacing an
already-installed extension leaves your running editor with the previous version's contributions —
its code updates on reload while its settings and menus do not, which produces confusing
half-updated behaviour (a menu item that appears but whose setting "is not a registered
configuration"). Fixing that genuinely does require quitting VS Code completely.

Use F5 while developing. Package and install only to verify the final artifact, and expect to
fully restart VS Code when you do.

Package a `.vsix`:

```bash
npm run package
```

Bump `version` in `package.json` first: VS Code **silently skips** installing a `.vsix` whose
version matches what is already installed, so reusing a version number looks exactly like a build
that did not take effect.
