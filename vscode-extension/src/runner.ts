/**
 * CLI resolution, command construction, and the shared PS-Utils terminal.
 *
 * Commands are sent to the integrated terminal via `sendText`, so they must be
 * quoted for whatever shell the terminal is running. We support the three common
 * families — POSIX (bash/zsh), PowerShell, and cmd.exe — auto-detected from the
 * platform and overridable via the `psUtils.shell` setting.
 */
import * as vscode from "vscode";
import * as fs from "fs";
import * as path from "path";
import type { ManifestOperation } from "./manifest";

const TERMINAL_NAME = "PS-Utils";
let terminal: vscode.Terminal | undefined;

export type ShellFamily = "posix" | "powershell" | "cmd";

/** Register the terminal-disposal listener once at activation. */
export function registerTerminalCleanup(context: vscode.ExtensionContext): void {
  context.subscriptions.push(
    vscode.window.onDidCloseTerminal((t) => {
      if (t === terminal) terminal = undefined;
    }),
  );
}

function getTerminal(cwd?: string): vscode.Terminal {
  if (!terminal) {
    terminal = vscode.window.createTerminal({ name: TERMINAL_NAME, cwd });
  }
  return terminal;
}

/** First workspace folder path, if any. */
function workspaceRoot(): string | undefined {
  return vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
}

/**
 * Detect the terminal shell family. The `psUtils.shell` setting (auto | bash |
 * powershell | cmd) overrides; `auto` maps Windows → PowerShell (the VS Code
 * default terminal on Windows) and everything else → POSIX.
 */
export function detectShell(): ShellFamily {
  const override = vscode.workspace.getConfiguration("psUtils").get<string>("shell")?.trim();
  if (override === "bash") return "posix";
  if (override === "powershell") return "powershell";
  if (override === "cmd") return "cmd";
  return process.platform === "win32" ? "powershell" : "posix";
}

/** Characters that never need quoting in any of the supported shells. */
const SAFE = /^[A-Za-z0-9_./:@=+-]+$/;

/** Quote a single argument for the given shell family. */
export function quoteArg(value: string, shell: ShellFamily): string {
  if (value === "") return shell === "cmd" ? '""' : "''";
  if (SAFE.test(value)) return value;
  switch (shell) {
    case "posix":
      // Wrap in single quotes; embedded single quotes become '\''.
      return `'${value.replace(/'/g, `'\\''`)}'`;
    case "powershell":
      // Single-quoted strings are literal in PowerShell; embedded ' is doubled.
      return `'${value.replace(/'/g, "''")}'`;
    case "cmd":
      // Double-quote; embedded " is doubled.
      return `"${value.replace(/"/g, '""')}"`;
  }
}

/**
 * Absolute path to the CLI bundle shipped inside this extension.
 *
 * The extension carries its own copy of ps-utils (built by `npm run bundle:cli`
 * in the ps-utils repo) and there is deliberately no setting to point at an
 * external one: a separately installed CLI is what allowed the extension's
 * frozen operation catalogue to drift from the CLI actually executing.
 */
export function bundledCliPath(context: vscode.ExtensionContext): string {
  return path.join(context.extensionPath, "cli", "cli.cjs");
}

/** Version of the bundled CLI, read from the manifest written at bundle time. */
export function bundledCliVersion(context: vscode.ExtensionContext): string | undefined {
  try {
    const meta = JSON.parse(
      fs.readFileSync(path.join(context.extensionPath, "cli", "BUNDLE.json"), "utf8"),
    ) as { name?: string; version?: string };
    return meta.version;
  } catch {
    return undefined;
  }
}

/**
 * Resolve the base CLI invocation for the given shell.
 *
 * The bundle is plain JavaScript and needs a Node runtime. Rather than depend
 * on the user having `node` on PATH — an environment problem they could no
 * longer work around, now that the override setting is gone — it runs on the
 * Node that ships inside VS Code itself. `process.execPath` is the VS Code
 * binary; `ELECTRON_RUN_AS_NODE=1` makes it behave as a plain Node interpreter.
 *
 * The env var has to be set per shell family because the command is sent to the
 * integrated terminal as text rather than spawned with an env block.
 */
export function resolveCli(context: vscode.ExtensionContext, shell: ShellFamily): string {
  const node = quoteArg(process.execPath, shell);
  const script = quoteArg(bundledCliPath(context), shell);
  switch (shell) {
    case "posix":
      return `ELECTRON_RUN_AS_NODE=1 ${node} ${script}`;
    case "powershell":
      // & is required to execute a quoted path; $env: scopes to this invocation.
      return `$env:ELECTRON_RUN_AS_NODE=1; & ${node} ${script}`;
    case "cmd":
      return `set ELECTRON_RUN_AS_NODE=1 && ${node} ${script}`;
  }
}

/**
 * Build the full CLI command line for an operation from user-entered values.
 * - boolean `true` → bare `--flag`; boolean `false`/empty → omitted
 * - empty optional values are omitted
 */
export function buildCommand(
  cli: string,
  opName: string,
  op: ManifestOperation,
  values: Record<string, string | boolean>,
  shell: ShellFamily,
): string {
  const parts = [cli, opName];
  for (const param of op.params) {
    const raw = values[param.name];
    if (param.type === "boolean") {
      if (raw === true || raw === "true") parts.push(`--${param.name}`);
      continue;
    }
    const str = raw === undefined || raw === null ? "" : String(raw).trim();
    if (str === "") continue;
    parts.push(`--${param.name}`, quoteArg(str, shell));
  }
  return parts.join(" ");
}

/** Show the shared terminal and run the command in it. */
export function runInTerminal(command: string): void {
  const term = getTerminal(workspaceRoot());
  term.show(true);
  term.sendText(command);
}
