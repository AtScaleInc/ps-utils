/**
 * The project settings panel — a Webview that edits the workspace-level PS-Utils
 * settings that stay consistent across a project (connection file, style file,
 * CLI command). Values are written to workspace configuration so they persist in
 * `.vscode/settings.json` and prefill operation dialogs.
 */
import * as vscode from "vscode";
import { clearRemembered, getRemembered, type RememberedMap } from "./remembered";

interface SettingField {
  key: string;
  label: string;
  description: string;
  kind: "file" | "text";
}

const FIELDS: SettingField[] = [
  {
    key: "connectionFile",
    label: "Connection file",
    description: "Prefilled into --connection-file.",
    kind: "file",
  },
  {
    key: "styleFile",
    label: "SML style config file",
    description: "Prefilled into --sml-config-file.",
    kind: "file",
  },
  {
    key: "modelName",
    label: "Default model name",
    description: "Prefilled into --model-name when a model.yaml contains multiple models.",
    kind: "text",
  },
  {
    key: "cliCommand",
    label: "CLI command override",
    description: "Leave blank to auto-detect (local bin → npx → global atscale-utils).",
    kind: "text",
  },
];

export function openSettingsPanel(context: vscode.ExtensionContext): void {
  const panel = vscode.window.createWebviewPanel(
    "psUtilsSettings",
    "PS-Utils: Settings",
    vscode.ViewColumn.Active,
    { enableScripts: true, retainContextWhenHidden: true },
  );

  const cfg = vscode.workspace.getConfiguration("psUtils");
  const current: Record<string, string> = {};
  for (const f of FIELDS) current[f.key] = cfg.get<string>(f.key) ?? "";

  panel.webview.html = renderHtml(current, getRemembered(context));

  panel.webview.onDidReceiveMessage(async (msg) => {
    if (msg.type === "clearRemembered") {
      await clearRemembered(context);
      vscode.window.showInformationMessage("PS-Utils: cleared remembered parameters.");
      panel.webview.html = renderHtml(current, {});
    } else if (msg.type === "browse") {
      const picked = await vscode.window.showOpenDialog({
        canSelectFiles: true,
        canSelectFolders: false,
        canSelectMany: false,
        openLabel: "Select",
      });
      if (picked && picked[0]) {
        panel.webview.postMessage({ type: "browsed", key: msg.key, path: picked[0].fsPath });
      }
    } else if (msg.type === "save") {
      const target = vscode.workspace.workspaceFolders?.length
        ? vscode.ConfigurationTarget.Workspace
        : vscode.ConfigurationTarget.Global;
      const conf = vscode.workspace.getConfiguration("psUtils");
      for (const f of FIELDS) {
        await conf.update(f.key, (msg.values?.[f.key] ?? "").trim(), target);
      }
      vscode.window.showInformationMessage("PS-Utils settings saved.");
      panel.dispose();
    } else if (msg.type === "cancel") {
      panel.dispose();
    }
  }, undefined, context.subscriptions);
}

function esc(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

function renderHtml(current: Record<string, string>, remembered: RememberedMap): string {
  const nonce = String(Math.random()).slice(2) + String(Date.now());

  const fields = FIELDS.map((f) => {
    const val = esc(current[f.key] ?? "");
    const browse =
      f.kind === "file"
        ? `<button type="button" class="browse" data-key="${f.key}">Browse…</button>`
        : "";
    return `<div class="field">
      <label for="s_${f.key}">${esc(f.label)}</label>
      <div class="row"><input type="text" id="s_${f.key}" data-key="${f.key}" value="${val}"/>${browse}</div>
      <div class="desc">${esc(f.description)}</div>
    </div>`;
  }).join("\n");

  const rememberedKeys = Object.keys(remembered).sort();
  const rememberedRows = rememberedKeys
    .map((k) => `<tr><td><code>${esc(k)}</code></td><td>${esc(String(remembered[k]))}</td></tr>`)
    .join("");
  const rememberedSection = `<div class="field">
      <label>Remembered parameters</label>
      <div class="desc">Last values entered per parameter, reused across operations. Explicit pins in <code>psUtils.commonParams</code> take precedence.</div>
      ${
        rememberedKeys.length
          ? `<table class="remembered"><thead><tr><th>Parameter</th><th>Value</th></tr></thead><tbody>${rememberedRows}</tbody></table>
             <div class="row" style="justify-content:flex-start"><button type="button" class="secondary" id="clearRemembered">Clear remembered parameters</button></div>`
          : `<div class="desc"><em>Nothing remembered yet.</em></div>`
      }
    </div>`;

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8"/>
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'nonce-${nonce}'; script-src 'nonce-${nonce}';"/>
<style nonce="${nonce}">
  body { font-family: var(--vscode-font-family); color: var(--vscode-foreground); padding: 1rem 1.25rem; }
  h1 { font-size: 1.15rem; }
  .field { margin-bottom: 1rem; }
  label { display: block; font-weight: 600; margin-bottom: .25rem; }
  .desc { color: var(--vscode-descriptionForeground); font-size: .85em; margin-top: .2rem; }
  .row { display: flex; gap: .5rem; }
  input[type=text] { flex: 1; padding: .35rem .5rem;
    background: var(--vscode-input-background); color: var(--vscode-input-foreground);
    border: 1px solid var(--vscode-input-border, transparent); border-radius: 2px; }
  button { padding: .35rem .8rem; cursor: pointer; border: none; border-radius: 2px;
    background: var(--vscode-button-background); color: var(--vscode-button-foreground); }
  button.secondary, button.browse { background: var(--vscode-button-secondaryBackground); color: var(--vscode-button-secondaryForeground); }
  .actions { display: flex; gap: .5rem; justify-content: flex-end; margin-top: 1rem;
    padding-top: 1rem; border-top: 1px solid var(--vscode-panel-border); }
  table.remembered { width: 100%; border-collapse: collapse; margin: .35rem 0 .5rem; }
  table.remembered th, table.remembered td { text-align: left; padding: .25rem .5rem;
    border-bottom: 1px solid var(--vscode-panel-border); font-size: .9em; }
  code { background: var(--vscode-textCodeBlock-background); padding: 0 .25rem; border-radius: 2px; }
</style>
</head>
<body>
  <h1>PS-Utils Project Settings</h1>
  <form id="form">${fields}</form>
  ${rememberedSection}
  <div class="actions">
    <button type="button" class="secondary" id="cancel">Cancel</button>
    <button type="button" id="save">Save</button>
  </div>
<script nonce="${nonce}">
  const vscode = acquireVsCodeApi();
  function collect() {
    const values = {};
    document.querySelectorAll('input[data-key]').forEach((el) => { values[el.getAttribute('data-key')] = el.value; });
    return values;
  }
  document.getElementById('save').addEventListener('click', () => vscode.postMessage({ type: 'save', values: collect() }));
  document.getElementById('cancel').addEventListener('click', () => vscode.postMessage({ type: 'cancel' }));
  document.querySelectorAll('.browse').forEach((btn) => {
    btn.addEventListener('click', () => vscode.postMessage({ type: 'browse', key: btn.getAttribute('data-key') }));
  });
  const clearBtn = document.getElementById('clearRemembered');
  if (clearBtn) clearBtn.addEventListener('click', () => vscode.postMessage({ type: 'clearRemembered' }));
  window.addEventListener('message', (e) => {
    const m = e.data;
    if (m.type === 'browsed') {
      const el = document.querySelector('[data-key="' + m.key + '"]');
      if (el) el.value = m.path;
    }
  });
</script>
</body>
</html>`;
}
