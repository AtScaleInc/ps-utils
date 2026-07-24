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
import type { Manifest, ManifestOperation } from "./manifest";

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
 * Resolve the base CLI invocation for the given shell.
 * Order: explicit `psUtils.cliCommand` setting (used verbatim) → local
 * `node_modules/.bin` executable → `npx --yes <package>`.
 *
 * On Windows the local bin is a `.cmd`/`.exe` shim; when its path needs quoting,
 * PowerShell requires the call operator (`& '<path>'`) to execute it.
 */
export function resolveCli(manifest: Manifest, shell: ShellFamily): string {
  const configured = vscode.workspace.getConfiguration("psUtils").get<string>("cliCommand")?.trim();
  if (configured) return configured;

  const root = workspaceRoot();
  if (root) {
    const candidates =
      process.platform === "win32"
        ? [`${manifest.cliBin}.cmd`, `${manifest.cliBin}.exe`, manifest.cliBin]
        : [manifest.cliBin];
    for (const name of candidates) {
      const localBin = path.join(root, "node_modules", ".bin", name);
      if (fs.existsSync(localBin)) {
        const quoted = quoteArg(localBin, shell);
        // PowerShell only runs a quoted path when invoked with the call operator.
        if (shell === "powershell" && quoted.startsWith("'")) return `& ${quoted}`;
        return quoted;
      }
    }
  }
  // npx is the most reliable fallback when the package is a project dependency.
  return `npx --yes ${manifest.cliPackage}`;
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
