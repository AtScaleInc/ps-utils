/**
 * The parameter dialog — a Webview panel that collects an operation's parameters,
 * prefilled from the right-clicked path and project settings, then runs the CLI.
 */
import * as vscode from "vscode";
import * as fs from "fs";
import * as path from "path";
import type { Manifest, ManifestOperation, ManifestParam } from "./manifest";
import { isDirRole, isFileRole } from "./manifest";
import { buildCommand, detectShell, resolveCli, runInTerminal } from "./runner";
import { readConnectionNames } from "./connections";

/**
 * True when `param` is the `--connection-name` for an op that also takes a
 * `--connection-file`: it should render as a dropdown populated from that file.
 */
function isConnectionNameDropdown(op: ManifestOperation, param: ManifestParam): boolean {
  return (
    param.name === "connection-name" &&
    op.params.some((p) => p.name === "connection-file")
  );
}

/** Pick a filename to place inside a right-clicked folder for an output-file param. */
function folderOutputFilename(param: ManifestParam): string {
  const d = param.default;
  if (typeof d === "string" && d.trim()) return path.basename(d.replace(/[\\/]+$/, "")) || "output";
  // Fall back to a name derived from the parameter (e.g. "output-model-file" → "model").
  return param.name.replace(/^output-/, "").replace(/-file$/, "") || "output";
}

/** Compute the initial value for a parameter from target path, settings, and defaults. */
function initialValue(
  param: ManifestParam,
  manifest: Manifest,
  op: ManifestOperation,
  targetPath: string | undefined,
  isFolder: boolean,
): string | boolean {
  const cfg = vscode.workspace.getConfiguration("psUtils");
  const target = isFolder ? op.targetParam.folder : op.targetParam.file;

  if (targetPath && param.name === target) {
    // For a net-new generator, the folder is the destination directory — prefill the
    // output file as <folder>/<filename> rather than the bare folder path.
    if (isFolder && param.role === "output-file") {
      return path.join(targetPath, folderOutputFilename(param));
    }
    return targetPath;
  }

  const settingKey = manifest.settingsParams[param.name];
  if (settingKey) {
    const v = cfg.get<string>(settingKey)?.trim();
    if (v) return v;
  }
  const common = cfg.get<Record<string, string>>("commonParams") ?? {};
  if (common[param.name]) return common[param.name];

  if (param.type === "boolean") return param.default === true;
  return param.default === null || param.default === undefined ? "" : String(param.default);
}

export function openParamDialog(
  context: vscode.ExtensionContext,
  manifest: Manifest,
  opName: string,
  uri?: vscode.Uri,
): void {
  const op = manifest.operations[opName];
  if (!op) {
    vscode.window.showErrorMessage(`PS-Utils: unknown operation "${opName}".`);
    return;
  }

  const targetPath = uri?.fsPath;
  let isFolder = false;
  try {
    if (targetPath) isFolder = fs.statSync(targetPath).isDirectory();
  } catch {
    /* path may not exist; treat as file */
  }

  const panel = vscode.window.createWebviewPanel(
    "psUtilsParams",
    `PS-Utils: ${opName}`,
    vscode.ViewColumn.Active,
    { enableScripts: true, retainContextWhenHidden: true },
  );

  const initial: Record<string, string | boolean> = {};
  for (const p of op.params) initial[p.name] = initialValue(p, manifest, op, targetPath, isFolder);

  // Initial connection-name options, parsed from the (prefilled) connection-file.
  const hasConnFile = op.params.some((p) => p.name === "connection-file");
  const initialConnNames = hasConnFile ? readConnectionNames(String(initial["connection-file"] ?? "")) : [];

  panel.webview.html = renderHtml(panel.webview, opName, op, initial, initialConnNames);

  panel.webview.onDidReceiveMessage(async (msg) => {
    if (msg.type === "connectionsChanged") {
      // The connection-file field changed — reparse and refresh the name dropdown.
      panel.webview.postMessage({ type: "connectionNames", names: readConnectionNames(msg.path) });
    } else if (msg.type === "browse") {
      const param: ManifestParam | undefined = op.params.find((p) => p.name === msg.param);
      const canFolders = param ? isDirRole(param.role) : false;
      const picked = await vscode.window.showOpenDialog({
        canSelectFiles: !canFolders,
        canSelectFolders: canFolders,
        canSelectMany: false,
        openLabel: "Select",
      });
      if (picked && picked[0]) {
        panel.webview.postMessage({ type: "browsed", param: msg.param, path: picked[0].fsPath });
      }
    } else if (msg.type === "execute") {
      const shell = detectShell();
      const cli = resolveCli(manifest, shell);
      const command = buildCommand(cli, opName, op, msg.values ?? {}, shell);
      runInTerminal(command);
      panel.dispose();
    } else if (msg.type === "cancel") {
      panel.dispose();
    }
  }, undefined, context.subscriptions);
}

function esc(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

/** Build the `<option>` list for the connection-name dropdown. */
function connectionOptions(names: string[], selected: string): string {
  const opts = ['<option value="">(select a connection)</option>'];
  const known = new Set(names);
  // Preserve a preselected value even if it is not (yet) in the parsed list.
  if (selected && !known.has(selected)) {
    opts.push(`<option value="${esc(selected)}" selected>${esc(selected)}</option>`);
  }
  for (const n of names) {
    opts.push(`<option value="${esc(n)}"${n === selected ? " selected" : ""}>${esc(n)}</option>`);
  }
  return opts.join("");
}

function renderHtml(
  webview: vscode.Webview,
  opName: string,
  op: ManifestOperation,
  initial: Record<string, string | boolean>,
  connectionNames: string[],
): string {
  const nonce = String(Math.random()).slice(2) + String(Date.now());

  const fields = op.params
    .map((p) => {
      const val = initial[p.name];
      const req = p.required ? '<span class="req">*</span>' : "";
      const browsable = isFileRole(p.role) || isDirRole(p.role);
      const label = `<label for="f_${esc(p.name)}">--${esc(p.name)} ${req}</label>`;
      const desc = `<div class="desc">${esc(p.description)}</div>`;
      let control: string;
      if (isConnectionNameDropdown(op, p)) {
        control = `<select id="f_${esc(p.name)}" data-name="${esc(p.name)}" data-type="string">${connectionOptions(
          connectionNames,
          String(val ?? ""),
        )}</select>`;
      } else if (p.type === "boolean") {
        control = `<input type="checkbox" id="f_${esc(p.name)}" data-name="${esc(p.name)}" data-type="boolean" ${
          val === true ? "checked" : ""
        }/>`;
      } else {
        const inputType = p.type === "number" ? "number" : "text";
        const browseBtn = browsable
          ? `<button type="button" class="browse" data-name="${esc(p.name)}">Browse…</button>`
          : "";
        control = `<div class="row"><input type="${inputType}" id="f_${esc(p.name)}" data-name="${esc(
          p.name,
        )}" data-type="${p.type}" value="${esc(String(val ?? ""))}"/>${browseBtn}</div>`;
      }
      return `<div class="field">${label}${control}${desc}</div>`;
    })
    .join("\n");

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8"/>
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'nonce-${nonce}'; script-src 'nonce-${nonce}';"/>
<style nonce="${nonce}">
  body { font-family: var(--vscode-font-family); color: var(--vscode-foreground); padding: 1rem 1.25rem; }
  h1 { font-size: 1.15rem; margin: 0 0 .25rem; }
  .op-desc { color: var(--vscode-descriptionForeground); margin-bottom: 1rem; }
  .field { margin-bottom: 1rem; }
  label { display: block; font-weight: 600; margin-bottom: .25rem; }
  .req { color: var(--vscode-errorForeground); }
  .desc { color: var(--vscode-descriptionForeground); font-size: .85em; margin-top: .2rem; }
  .row { display: flex; gap: .5rem; }
  input[type=text], input[type=number], select {
    flex: 1; padding: .35rem .5rem;
    background: var(--vscode-input-background); color: var(--vscode-input-foreground);
    border: 1px solid var(--vscode-input-border, transparent); border-radius: 2px;
  }
  select { background: var(--vscode-dropdown-background); color: var(--vscode-dropdown-foreground);
    border-color: var(--vscode-dropdown-border, transparent); }
  button {
    padding: .35rem .8rem; cursor: pointer; border: none; border-radius: 2px;
    background: var(--vscode-button-background); color: var(--vscode-button-foreground);
  }
  button:hover { background: var(--vscode-button-hoverBackground); }
  button.secondary { background: var(--vscode-button-secondaryBackground); color: var(--vscode-button-secondaryForeground); }
  .browse { background: var(--vscode-button-secondaryBackground); color: var(--vscode-button-secondaryForeground); }
  .actions { position: sticky; bottom: 0; display: flex; gap: .5rem; justify-content: flex-end;
    padding-top: 1rem; margin-top: 1rem; border-top: 1px solid var(--vscode-panel-border);
    background: var(--vscode-editor-background); }
</style>
</head>
<body>
  <h1>${esc(opName)}</h1>
  <div class="op-desc">${esc(op.description)}</div>
  <form id="form">${fields}</form>
  <div class="actions">
    <button type="button" class="secondary" id="cancel">Cancel</button>
    <button type="button" id="execute">Execute</button>
  </div>
<script nonce="${nonce}">
  const vscode = acquireVsCodeApi();
  function collect() {
    const values = {};
    document.querySelectorAll('input[data-name], select[data-name]').forEach((el) => {
      const name = el.getAttribute('data-name');
      const type = el.getAttribute('data-type');
      values[name] = type === 'boolean' ? el.checked : el.value;
    });
    return values;
  }
  // Rebuild the connection-name dropdown from a fresh list, preserving the selection if still valid.
  function applyConnectionNames(names) {
    const sel = document.querySelector('select[data-name="connection-name"]');
    if (!sel) return;
    const current = sel.value;
    sel.innerHTML = '';
    const ph = document.createElement('option');
    ph.value = ''; ph.textContent = '(select a connection)';
    sel.appendChild(ph);
    names.forEach((n) => {
      const o = document.createElement('option');
      o.value = n; o.textContent = n;
      if (n === current) o.selected = true;
      sel.appendChild(o);
    });
  }
  function notifyConnectionFile() {
    const el = document.querySelector('input[data-name="connection-file"]');
    if (el) vscode.postMessage({ type: 'connectionsChanged', path: el.value });
  }
  document.getElementById('execute').addEventListener('click', () => {
    vscode.postMessage({ type: 'execute', values: collect() });
  });
  document.getElementById('cancel').addEventListener('click', () => {
    vscode.postMessage({ type: 'cancel' });
  });
  document.querySelectorAll('.browse').forEach((btn) => {
    btn.addEventListener('click', () => {
      vscode.postMessage({ type: 'browse', param: btn.getAttribute('data-name') });
    });
  });
  // Refresh the connection dropdown when the connection-file field is edited by hand.
  const connFileEl = document.querySelector('input[data-name="connection-file"]');
  if (connFileEl) connFileEl.addEventListener('change', notifyConnectionFile);
  window.addEventListener('message', (e) => {
    const m = e.data;
    if (m.type === 'browsed') {
      const el = document.querySelector('input[data-name="' + m.param + '"]');
      if (el) el.value = m.path;
      // Browsing to a new connection-file must also refresh the dropdown.
      if (m.param === 'connection-file') notifyConnectionFile();
    } else if (m.type === 'connectionNames') {
      applyConnectionNames(m.names || []);
    }
  });
</script>
</body>
</html>`;
}
