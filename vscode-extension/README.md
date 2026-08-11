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

## Requirements

- **VS Code** 1.85 or newer.
- **Node.js** — 18.20+ or 20+ recommended. Packaging (`npm run package`) uses `@vscode/vsce`,
  whose `undici` dependency needs the `File` global (added in Node 18.20 / 20). This package pins
  `undici` to v5 via an `overrides` entry so packaging also works on older Node 18.x; without it,
  `vsce` fails with `ReferenceError: File is not defined` on those runtimes.
- **The `ps-utils` CLI must be reachable.** By default the extension runs it via:
  1. a local `node_modules/.bin/atscale-utils` (`atscale-utils.cmd` on Windows) if the workspace
     has `@atscale-ps/ps-utils` installed, otherwise
  2. `npx --yes @atscale-ps/ps-utils` (downloads on first use).

  If you install the CLI globally or want a custom invocation, set `psUtils.cliCommand`
  (see [Settings](#settings)). **Node.js** is required for either path.

## Installation

### Option A — install a packaged `.vsix` (recommended for users)

1. Build the extension package (produces `atscale-ps-utils-<version>.vsix`):

   ```bash
   cd vscode-extension
   npm install
   npm run compile
   npm run package        # requires @vscode/vsce (installed as a devDependency)
   ```

   A `WARNING  LICENSE ... not found` line is harmless. If packaging fails with
   `ReferenceError: File is not defined`, your Node is older than 18.20 — the pinned `undici`
   override normally prevents this; run `npm install` again to ensure it took effect.

2. Install it into VS Code, either from the UI or the command line:

   - **UI:** Extensions view → `⋯` menu → **Install from VSIX…** → pick the `.vsix`.
   - **CLI (any OS):**

     ```bash
     code --install-extension atscale-ps-utils-0.1.9.vsix
     ```

     On Windows, `code` is the VS Code CLI (available if "Add to PATH" was selected during
     install); otherwise use the full path or run it from a Developer/VS Code terminal.

3. Reload VS Code. Right-click a file or folder in the Explorer to see the **PS-Utils** menu.

To share the extension, distribute that single `.vsix` file — teammates install it the same way.

### Option B — run from source (for development)

See [Develop](#develop) below (press **F5** to launch an Extension Development Host without
packaging).

## How it stays in sync with the CLI

The menu, operations, and parameters are read from `media/operations.manifest.json`, which is
generated from the ps-utils operation registry and the shared `OPERATION_GROUPS` list:

```bash
# from the repo root
npm run build            # regenerates the manifest + this extension's menu contributions
# or individually:
npm run generate:extension-manifest
npm run generate:extension-contributes
```

`generate-extension-contributes` rewrites this package's `contributes.commands/submenus/menus`
from the manifest, so adding or changing an operation in the CLI automatically updates the menus.

## Settings

Set via the **Settings…** menu item (writes workspace `.vscode/settings.json`):

| Setting | Purpose |
|---------|---------|
| `psUtils.connectionFile` | Prefilled into `--connection-file` |
| `psUtils.styleFile` | Prefilled into `--sml-config-file` |
| `psUtils.modelName` | Prefilled into `--model-name` |
| `psUtils.cliCommand` | Override the CLI invocation (blank = auto-detect) |
| `psUtils.shell` | Terminal shell for argument quoting: `auto` (default), `bash`, `powershell`, or `cmd` |
| `psUtils.commonParams` | Map of `param-name` → value prefilled into any matching dialog (explicit pins) |
| `psUtils.rememberParameters` | Remember the last value entered for each scalar parameter and reuse it across operations (default `true`) |

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
npm run compile        # bundle to dist/extension.js
```

Then press **F5** (or run the "Run PS-Utils Extension" launch config) to open an Extension
Development Host. Open a workspace, right-click a file/folder, and try an operation.

Package a `.vsix`:

```bash
npm run package
```
