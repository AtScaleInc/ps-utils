/**
 * "Monitor SML Directory" — re-runs `atscale-list-model-errors` whenever a file
 * in a watched SML directory changes, and puts the problems it reports in the
 * Problems panel.
 *
 * ## Why this runs the CLI rather than validating in-process
 *
 * The checks worth watching for are the ones only the operation can do: phase 1
 * resolves cross-file references (a `join_column` that no longer exists in the
 * dataset it names), and phase 2 POSTs joinability and uniqueness checks to the
 * AtScale engine. Neither is expressible in the JSON Schemas that back the
 * editor's per-file validation, which is why this is a separate channel from
 * `sml-unknown-keys.ts` and has its own DiagnosticCollection.
 *
 * The CLI is spawned rather than sent to the integrated terminal — the terminal
 * is for operations the user reads the output of, and its text cannot be parsed
 * back. `bundledCliPath` plus `ELECTRON_RUN_AS_NODE` on `process.execPath` is the
 * same invocation `runner.ts` builds, minus the shell quoting, since `spawn`
 * passes an argv array with no shell in between.
 *
 * ## Cost discipline
 *
 * A run reaches a live AtScale instance and issues SQL, so it must not fire per
 * keystroke. Saves are debounced, runs never overlap, and a change arriving
 * mid-run sets a dirty flag for exactly one re-run afterwards rather than
 * queueing one per event.
 */
import * as vscode from "vscode";
import * as fs from "fs";
import * as path from "path";
import { spawn } from "child_process";
import type { ChildProcess } from "child_process";
import { bundledCliPath } from "./runner";
import { readConnectionNames } from "./connections";
import { getRemembered, updateRemembered } from "./remembered";
import {
  buildNameIndex,
  describeFailure,
  formatProblem,
  locateProblem,
  parseReport,
  refineWithinFile,
} from "./sml-monitor-core";
import type { Declaration, ModelProblem } from "./sml-monitor-core";

const OPERATION = "atscale-list-model-errors";
const STATE_KEY = "psUtils.smlMonitors";
const CTX_ACTIVE = "psUtils.smlMonitorActive";
/**
 * Directories currently monitored, published for the menu's `when` clauses.
 *
 * A menu item cannot ask "is the folder being right-clicked monitored?" with a
 * plain boolean context key, so the checkbox would have to reflect *any* monitor
 * being active — wrong the moment there are two directories. VS Code's `in`
 * operator tests membership of a context key's value, so publishing the set of
 * paths lets `resourcePath in psUtils.smlMonitoredDirs` be exact.
 */
const CTX_DIRS = "psUtils.smlMonitoredDirs";

/**
 * Directories the operation reads, relative to `--sml-dir`. Indexed for position
 * mapping; kept identical to `readYamlDir` call sites in the operation so the
 * editor never claims to know about a file the validator never looked at.
 */
const SML_SUBDIRS = ["models", "dimensions", "datasets", "connections"];

/** Settle time after the last change before a run starts. */
const DEBOUNCE_MS = 1_200;

/**
 * How long a run may take before it is killed, in seconds.
 *
 * Phase 2 POSTs joinability and uniqueness checks to the AtScale engine, which
 * issues SQL against the warehouse — legitimately slow on a large model, and
 * unbounded when the instance is unreachable, since the operation sets no timeout
 * of its own. Without a limit here a single stalled run wedges the monitor
 * permanently: `running` stays true, every later change only sets `dirty`, and the
 * log goes silent after "validating" with no indication anything is wrong.
 */
const DEFAULT_TIMEOUT_SECONDS = 120;

const timeoutMs = (): number =>
  Math.max(5, vscode.workspace.getConfiguration("psUtils").get<number>("smlMonitorTimeout", DEFAULT_TIMEOUT_SECONDS)) * 1_000;

/**
 * Whether to run the operation's phase 2 engine checks on every save.
 *
 * Off by default. Phase 1 resolves cross-file references locally in about a
 * second; phase 2 issues SQL against the warehouse through a live AtScale
 * instance, which is far too slow and too expensive to repeat on each keystroke's
 * worth of editing — and blocks entirely when the instance is down. Deliberate
 * runs (**Validate now**, or the operation from the context menu) are the right
 * place for it.
 */
const engineChecksEnabled = (): boolean =>
  vscode.workspace.getConfiguration("psUtils").get<boolean>("smlMonitorEngineChecks", false);

/** What is persisted per workspace so monitors survive a window reload. */
interface MonitorConfig {
  dir: string;
  connectionFile: string;
  connectionName: string;
  modelName?: string;
}

interface Monitor extends MonitorConfig {
  watcher: vscode.FileSystemWatcher;
  timer?: ReturnType<typeof setTimeout>;
  child?: ChildProcess;
  running: boolean;
  dirty: boolean;
  /** URIs this monitor last published problem diagnostics for, so it clears only its own. */
  published: vscode.Uri[];
  /**
   * Where the "could not run" diagnostic was put, tracked apart from `published`
   * because the two have opposite lifetimes: a failed run keeps the previous
   * problems (it proved nothing about the files) while adding this, and the next
   * successful run clears this while replacing those.
   */
  failureUri?: vscode.Uri;
  problems: number;
  failed: boolean;
  /**
   * Set by `stop`. Killing the child fires `close`, which would otherwise publish
   * results for a monitor that no longer exists and — seeing `dirty` — start a
   * fresh run of it, resurrecting the monitor the user just switched off.
   */
  disposed: boolean;
  /** Set when the run was killed for exceeding the timeout, so it is reported as such. */
  timedOut: boolean;
}

const monitors = new Map<string, Monitor>();
let diagnostics: vscode.DiagnosticCollection;
let output: vscode.OutputChannel;
let status: vscode.StatusBarItem;
let extensionContext: vscode.ExtensionContext;

// ── directory resolution ──────────────────────────────────────────────────────

const hasModels = (dir: string): boolean => {
  try {
    return fs.statSync(path.join(dir, "models")).isDirectory();
  } catch {
    return false;
  }
};

/**
 * The directory to pass as `--sml-dir`, given whatever the user right-clicked.
 *
 * Right-clicking `datasets/` is at least as natural as right-clicking the
 * repository root, so the clicked folder and then its ancestors are searched for
 * the one holding `models/` — which is what the operation requires and what it
 * resolves every other path against. The walk stops at the workspace root rather
 * than escaping to the filesystem root.
 */
function resolveSmlDir(start: string): string | undefined {
  const roots = (vscode.workspace.workspaceFolders ?? []).map((f) => f.uri.fsPath);
  let current = start;

  for (;;) {
    if (hasModels(current)) return current;
    const parent = path.dirname(current);
    if (parent === current) return undefined;
    if (roots.some((root) => path.relative(root, current) === "")) return undefined;
    current = parent;
  }
}

// ── parameter collection ──────────────────────────────────────────────────────

/**
 * Gather the connection arguments, reusing what the rest of the extension already
 * knows: the `psUtils.connectionFile` setting, then the cross-operation memory
 * that `panel.ts` writes. Only genuinely unknown values are asked for, so
 * starting a second monitor in a configured project is a single click.
 */
async function collectConfig(dir: string): Promise<MonitorConfig | undefined> {
  const settings = vscode.workspace.getConfiguration("psUtils");
  const remembered = getRemembered(extensionContext);

  let connectionFile = (settings.get<string>("connectionFile") ?? "").trim();
  if (!connectionFile || !fs.existsSync(connectionFile)) {
    const picked = await vscode.window.showOpenDialog({
      title: "Select the connections file for SML validation",
      canSelectMany: false,
      openLabel: "Use this connections file",
      filters: { YAML: ["yaml", "yml"] },
      defaultUri: vscode.workspace.workspaceFolders?.[0]?.uri,
    });
    if (!picked?.length) return undefined;
    connectionFile = picked[0].fsPath;
  }

  const names = readConnectionNames(connectionFile);
  const previous = String(remembered["atscale-connection-name"] ?? "");
  let connectionName: string | undefined;

  if (names.length > 0) {
    connectionName = await vscode.window.showQuickPick(names, {
      title: "AtScale connection to validate against",
      placeHolder: previous && names.includes(previous) ? `Previously: ${previous}` : undefined,
    });
  } else {
    // Unreadable or connection-less file — fall back to free text rather than
    // blocking on a dropdown that can never be populated.
    connectionName = await vscode.window.showInputBox({
      title: "AtScale connection name",
      prompt: `No connections found in ${path.basename(connectionFile)}. Enter the name manually.`,
      value: previous,
    });
  }
  if (!connectionName) return undefined;

  const modelName = (settings.get<string>("modelName") ?? "").trim() ||
    String(remembered["model-name"] ?? "").trim() ||
    undefined;

  await updateRemembered(extensionContext, { "atscale-connection-name": connectionName });
  return { dir, connectionFile, connectionName, modelName };
}

// ── running the operation ─────────────────────────────────────────────────────

const stamp = (): string => new Date().toLocaleTimeString();

/** Every SML file the operation reads, for mapping problems back to positions. */
function readSmlFiles(dir: string): { file: string; text: string }[] {
  const files: { file: string; text: string }[] = [];
  for (const sub of SML_SUBDIRS) {
    const full = path.join(dir, sub);
    let entries: string[];
    try {
      entries = fs.readdirSync(full);
    } catch {
      continue;
    }
    for (const entry of entries.sort()) {
      if (!/\.ya?ml$/i.test(entry)) continue;
      const file = path.join(full, entry);
      try {
        files.push({ file, text: fs.readFileSync(file, "utf8") });
      } catch {
        // Deleted between the readdir and here; the next run will catch up.
      }
    }
  }
  return files;
}

/**
 * The file to hang a problem on when it names no SML object the index can find.
 *
 * Every problem has to reach the Problems panel — one that exists only in the
 * output channel is one nobody will see — so this never gives up while the
 * directory holds any SML file at all. The model file is the meaningful anchor
 * (the run validated *that model*); any other file is merely somewhere visible.
 */
function anchorFile(dir: string, model: string, files: { file: string }[]): string | undefined {
  return modelFileFor(dir, model) ?? files[0]?.file;
}

/**
 * The model file a problem with no locatable object should be attached to.
 *
 * `model` may be empty when the run failed before naming one, in which case the
 * search by name is skipped — an empty name would otherwise match any file with a
 * valueless `unique_name:` line.
 */
function modelFileFor(dir: string, model: string): string | undefined {
  const modelsDir = path.join(dir, "models");
  let entries: string[];
  try {
    entries = fs.readdirSync(modelsDir).filter((e) => /\.ya?ml$/i.test(e)).sort();
  } catch {
    return undefined;
  }
  const named = model === "" ? undefined : entries.find((entry) => {
    try {
      const text = fs.readFileSync(path.join(modelsDir, entry), "utf8");
      return new RegExp(`^\\s*(unique_name|label)\\s*:\\s*["']?${escapeRegExp(model)}["']?\\s*$`, "m").test(text);
    } catch {
      return false;
    }
  });
  const chosen = named ?? entries[0];
  return chosen ? path.join(modelsDir, chosen) : undefined;
}

const escapeRegExp = (value: string): string => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

const severityOf = (problem: ModelProblem): vscode.DiagnosticSeverity =>
  problem.severity === "error"
    ? vscode.DiagnosticSeverity.Error
    : vscode.DiagnosticSeverity.Warning;

/** Publish one run's problems, replacing only what this monitor published before. */
function publish(monitor: Monitor, model: string, problems: ModelProblem[]): void {
  for (const uri of monitor.published) diagnostics.delete(uri);
  monitor.published = [];

  const files = readSmlFiles(monitor.dir);
  const index = buildNameIndex(files);
  const textOf = new Map(files.map((f) => [f.file, f.text]));
  const fallback = anchorFile(monitor.dir, model, files);
  const byFile = new Map<string, vscode.Diagnostic[]>();

  for (const problem of problems) {
    const located = locateProblem(problem, index);
    // Prefer the line carrying the offending value over the object's declaration.
    const found: Declaration | undefined = located
      ? refineWithinFile(located, problem, textOf.get(located.file) ?? "")
      : undefined;
    const file = found?.file ?? fallback;
    // Only reachable when the watched directory holds no SML file at all, in
    // which case the operation would have thrown rather than reported problems.
    if (!file) continue;

    const range = found
      ? new vscode.Range(found.line, found.column, found.line, found.column + found.length)
      : new vscode.Range(0, 0, 0, 0);

    // Say where an unlocated problem really came from, so a diagnostic sitting on
    // line 1 of a file it has nothing to do with is not read as being about that
    // file. `location` is the operation's own coordinate for it.
    const message = found
      ? problem.message
      : `${problem.location ? `${problem.location}: ` : ""}${problem.message}`;

    const diagnostic = new vscode.Diagnostic(range, message, severityOf(problem));
    diagnostic.source = OPERATION;
    diagnostic.code = problem.phase;
    byFile.set(file, [...(byFile.get(file) ?? []), diagnostic]);
  }

  for (const [file, items] of byFile) {
    const uri = vscode.Uri.file(file);
    diagnostics.set(uri, items);
    monitor.published.push(uri);
  }
}

/**
 * Report a run that never produced a report — a wrong connection name, an
 * unreachable instance, no model file.
 *
 * This belongs in the Problems panel rather than only in the output channel: a
 * monitor that has silently stopped validating looks exactly like a model with no
 * problems, and the status bar would say so. The file it hangs on is not at fault,
 * so the message names the operation and the directory rather than pretending to
 * be about that file's contents.
 */
function publishFailure(monitor: Monitor, reason: string): void {
  clearFailure(monitor);

  const file = anchorFile(monitor.dir, "", readSmlFiles(monitor.dir));
  if (!file) return;

  const diagnostic = new vscode.Diagnostic(
    new vscode.Range(0, 0, 0, 0),
    `${OPERATION} could not validate ${monitor.dir}: ${reason}`,
    vscode.DiagnosticSeverity.Error,
  );
  diagnostic.source = OPERATION;
  diagnostic.code = "run-failed";

  const uri = vscode.Uri.file(file);
  // Merge rather than overwrite: this file may already carry real problems from
  // the last successful run, which a failure does not invalidate.
  diagnostics.set(uri, [...(diagnostics.get(uri) ?? []), diagnostic]);
  monitor.failureUri = uri;
}

function clearFailure(monitor: Monitor): void {
  const uri = monitor.failureUri;
  if (!uri) return;
  const remaining = (diagnostics.get(uri) ?? []).filter((d) => d.code !== "run-failed");
  if (remaining.length > 0) diagnostics.set(uri, remaining);
  else diagnostics.delete(uri);
  monitor.failureUri = undefined;
}

function refreshStatus(): void {
  if (monitors.size === 0) {
    status.hide();
    return;
  }
  const running = [...monitors.values()].some((m) => m.running);
  const failed = [...monitors.values()].some((m) => m.failed);
  const problems = [...monitors.values()].reduce((total, m) => total + m.problems, 0);

  status.text = running
    ? "$(sync~spin) SML: validating…"
    : // Never claim a clean model off the back of a run that did not happen.
      failed
      ? "$(error) SML: validation failed"
      : problems === 0
        ? "$(check) SML: no problems"
        : `$(warning) SML: ${problems} problem${problems === 1 ? "" : "s"}`;
  status.tooltip = `Monitoring ${monitors.size} SML director${monitors.size === 1 ? "y" : "ies"} with ${OPERATION}`;
  status.show();
}

/**
 * @param fullCheck run phase 2 regardless of `psUtils.smlMonitorEngineChecks` —
 *   what **Validate now** means, as opposed to the save-triggered runs that skip
 *   the engine by default.
 */
function run(monitor: Monitor, fullCheck = false): void {
  if (monitor.running) {
    monitor.dirty = true;
    return;
  }
  monitor.running = true;
  monitor.dirty = false;
  monitor.timedOut = false;
  refreshStatus();

  const started = Date.now();
  const args = [
    bundledCliPath(extensionContext),
    OPERATION,
    "--connection-file",
    monitor.connectionFile,
    "--atscale-connection-name",
    monitor.connectionName,
    "--sml-dir",
    monitor.dir,
    ...(monitor.modelName ? ["--model-name", monitor.modelName] : []),
    // Bound every AtScale request, authentication included. Without it an
    // unreachable instance stalls the run until the kill timer fires, and the
    // report is lost; with it the operation still produces a report, and the
    // unreachable engine shows up as a warning in the Problems panel.
    "--timeout",
    String(Math.max(5, Math.floor(timeoutMs() / 1_000 / 2))),
    ...(fullCheck || engineChecksEnabled() ? [] : ["--skip-engine-checks"]),
  ];

  // The exact command, so a run that behaves oddly can be reproduced in a
  // terminal without reconstructing it by hand. This is also the only evidence
  // the operation was invoked at all while it is still running.
  output.appendLine(`[${stamp()}] validating ${monitor.dir}`);
  output.appendLine(`           ${OPERATION} ${args.slice(2).join(" ")}`);

  const child = spawn(process.execPath, args, {
    cwd: vscode.workspace.workspaceFolders?.[0]?.uri.fsPath,
    // The bundle is plain JS; VS Code's own binary runs it as Node with this set.
    env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" },
  });
  monitor.child = child;

  const limit = timeoutMs();
  const killer = setTimeout(() => {
    monitor.timedOut = true;
    child.kill();
    // SIGTERM is enough for a Node process blocked on a socket, but not for one
    // ignoring it; escalate rather than leave the monitor wedged.
    setTimeout(() => child.kill("SIGKILL"), 2_000);
  }, limit);

  let stdout = "";
  let stderr = "";
  child.stdout?.on("data", (chunk: Buffer) => (stdout += chunk.toString()));
  child.stderr?.on("data", (chunk: Buffer) => (stderr += chunk.toString()));

  child.on("error", (error) => {
    output.appendLine(`[${stamp()}] could not start the CLI: ${error.message}`);
  });

  child.on("close", (code) => {
    clearTimeout(killer);
    monitor.child = undefined;
    monitor.running = false;

    // `stop` kills the child to shut the monitor down; the close that follows is
    // that shutdown, not a result. Publishing here would put diagnostics back for
    // a monitor the user switched off, and the `dirty` re-run below would start it
    // up again.
    if (monitor.disposed) return;

    const elapsed = `${((Date.now() - started) / 1_000).toFixed(1)}s`;
    const report = parseReport(stdout);
    if (!report) {
      // A thrown operation (missing model, unknown connection, unreachable
      // instance) produces no report. The previous problems are kept — nothing
      // was proven about the files — and the failure itself becomes a problem, so
      // a monitor that has stopped validating cannot pass for a clean model.
      const reason = monitor.timedOut
        ? `timed out after ${elapsed} (psUtils.smlMonitorTimeout). The engine checks in phase 2 ` +
          "run SQL against the warehouse and are unbounded when the instance is unreachable."
        : describeFailure(stdout, stderr, code);
      monitor.failed = true;
      publishFailure(monitor, reason);
      output.appendLine(`[${stamp()}] failed after ${elapsed}: ${reason}`);
    } else {
      monitor.failed = false;
      clearFailure(monitor);
      publish(monitor, report.model, report.problems);
      monitor.problems = report.problems.length;

      const errors = report.summary?.errors ?? report.problems.filter((p) => p.severity === "error").length;
      const warnings = report.summary?.warnings ?? report.problems.filter((p) => p.severity === "warning").length;
      output.appendLine(
        report.problems.length === 0
          ? `[${stamp()}] ✓ ${report.model}: no problems (${elapsed})`
          : `[${stamp()}] ${report.model}: ${errors} error(s), ${warnings} warning(s) (${elapsed})`,
      );
      for (const problem of report.problems) output.appendLine(formatProblem(problem));
    }

    refreshStatus();
    if (monitor.dirty) run(monitor);
  });
}

function schedule(monitor: Monitor): void {
  if (monitor.timer) clearTimeout(monitor.timer);
  monitor.timer = setTimeout(() => {
    monitor.timer = undefined;
    run(monitor);
  }, DEBOUNCE_MS);
}

// ── lifecycle ─────────────────────────────────────────────────────────────────

async function persist(): Promise<void> {
  const configs: MonitorConfig[] = [...monitors.values()].map((m) => ({
    dir: m.dir,
    connectionFile: m.connectionFile,
    connectionName: m.connectionName,
    modelName: m.modelName,
  }));
  await extensionContext.workspaceState.update(STATE_KEY, configs);
  await vscode.commands.executeCommand("setContext", CTX_ACTIVE, configs.length > 0);
  await vscode.commands.executeCommand("setContext", CTX_DIRS, configs.map((c) => c.dir));
}

function start(config: MonitorConfig, runNow: boolean): Monitor {
  const watcher = vscode.workspace.createFileSystemWatcher(
    new vscode.RelativePattern(config.dir, "**/*.{yml,yaml}"),
  );
  const monitor: Monitor = {
    ...config,
    watcher,
    running: false,
    dirty: false,
    published: [],
    problems: 0,
    failed: false,
    disposed: false,
    timedOut: false,
  };

  const changed = (uri: vscode.Uri): void => {
    output.appendLine(`[${stamp()}] changed: ${path.relative(config.dir, uri.fsPath)}`);
    schedule(monitor);
  };
  watcher.onDidCreate(changed);
  watcher.onDidChange(changed);
  watcher.onDidDelete(changed);

  monitors.set(config.dir, monitor);
  if (runNow) run(monitor);
  return monitor;
}

async function stop(dir: string): Promise<void> {
  const monitor = monitors.get(dir);
  if (!monitor) return;

  // Before the kill, so the child's `close` handler sees it and does not publish
  // results for — or restart — a monitor that is going away.
  monitor.disposed = true;
  monitor.dirty = false;

  if (monitor.timer) clearTimeout(monitor.timer);
  monitor.child?.kill();
  monitor.watcher.dispose();
  clearFailure(monitor);
  for (const uri of monitor.published) diagnostics.delete(uri);

  monitors.delete(dir);
  output.appendLine(`[${stamp()}] stopped monitoring ${dir}`);
  await persist();
  refreshStatus();
}

/** Clicking the menu item on a directory that is already monitored. */
async function offerRunningActions(dir: string): Promise<void> {
  const choice = await vscode.window.showQuickPick(
    [
      {
        label: "$(sync) Validate now",
        description: "including the phase 2 engine checks",
        action: "run",
      },
      { label: "$(output) Show validation log", action: "log" },
      { label: "$(stop-circle) Stop monitoring", action: "stop" },
    ],
    { title: `Already monitoring ${path.basename(dir)}` },
  );
  if (choice?.action === "run") run(monitors.get(dir)!, true);
  else if (choice?.action === "log") output.show(true);
  else if (choice?.action === "stop") await stop(dir);
}

export function registerSmlMonitor(context: vscode.ExtensionContext): void {
  extensionContext = context;

  diagnostics = vscode.languages.createDiagnosticCollection("sml-model-errors");
  output = vscode.window.createOutputChannel("PS-Utils SML Validation");
  status = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 0);
  status.command = "psUtils.sml.showMonitorLog";
  context.subscriptions.push(diagnostics, output, status);

  /**
   * Backs both halves of the checkbox. `psUtils.sml.monitor` (☐) and
   * `psUtils.sml.monitorActive` (☑) are separate command ids only so the menu can
   * swap the title; the behaviour is the same, and which one is reached is
   * already implied by whether the directory is in `monitors`.
   */
  const monitorCommand = async (uri?: vscode.Uri): Promise<void> => {
    let target = uri?.fsPath;
    if (!target) {
      const picked = await vscode.window.showOpenDialog({
        title: "Select the SML directory to monitor",
        canSelectFolders: true,
        canSelectFiles: false,
        canSelectMany: false,
        openLabel: "Monitor this directory",
        defaultUri: vscode.workspace.workspaceFolders?.[0]?.uri,
      });
      if (!picked?.length) return;
      target = picked[0].fsPath;
    }

    const dir = resolveSmlDir(target);
    if (!dir) {
      void vscode.window.showErrorMessage(
        `No SML directory found at or above ${path.basename(target)}. ` +
          `${OPERATION} needs a directory containing models/ (alongside dimensions/, datasets/ and connections/).`,
      );
      return;
    }

    if (monitors.has(dir)) return offerRunningActions(dir);

    const config = await collectConfig(dir);
    if (!config) return;

    start(config, true);
    await persist();
    refreshStatus();
    output.appendLine(`[${stamp()}] monitoring ${dir} (connection: ${config.connectionName})`);
  };

  context.subscriptions.push(
    vscode.commands.registerCommand("psUtils.sml.monitor", monitorCommand),
    vscode.commands.registerCommand("psUtils.sml.monitorActive", monitorCommand),
    vscode.commands.registerCommand("psUtils.sml.monitorPick", () => monitorCommand()),

    vscode.commands.registerCommand("psUtils.sml.stopMonitor", async () => {
      const dirs = [...monitors.keys()];
      if (dirs.length === 0) {
        void vscode.window.showInformationMessage("No SML directories are being monitored.");
        return;
      }
      if (dirs.length === 1) return stop(dirs[0]);

      const picked = await vscode.window.showQuickPick(
        [...dirs.map((dir) => ({ label: path.basename(dir), description: dir, dir })),
         { label: "$(stop-circle) Stop all", description: "", dir: "" }],
        { title: "Stop monitoring which SML directory?" },
      );
      if (!picked) return;
      if (picked.dir === "") {
        for (const dir of dirs) await stop(dir);
      } else {
        await stop(picked.dir);
      }
    }),

    vscode.commands.registerCommand("psUtils.sml.showMonitorLog", () => output.show(true)),

    { dispose: () => { for (const dir of [...monitors.keys()]) void stop(dir); } },
  );

  // Restore monitors from the previous session. Directories that have since gone
  // away are dropped rather than watched into the void.
  const saved = context.workspaceState.get<MonitorConfig[]>(STATE_KEY, []);
  for (const config of saved) {
    if (!hasModels(config.dir)) continue;
    start(config, true);
  }
  void persist();
  refreshStatus();
}
