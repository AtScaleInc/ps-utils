/**
 * PS-Utils VS Code extension entry point.
 *
 * Registers one command per operation (`psUtils.op.<name>`) — matching the
 * command ids generated into package.json's contributes.commands — plus the
 * Settings command. Command handlers open the parameter dialog / settings panel.
 *
 * Also registers SML editing support (see sml-schema.ts): per-document JSON Schema
 * association for SML YAML files, giving completion, hover documentation and
 * validation. The SML-aware syntax highlighting alongside it is contributed
 * declaratively via package.json's `grammars`.
 */
import * as vscode from "vscode";
import { loadManifest } from "./manifest";
import { openParamDialog } from "./panel";
import { openSettingsPanel } from "./settings";
import { registerTerminalCleanup } from "./runner";
import { registerSmlSchemas } from "./sml-schema";

export function activate(context: vscode.ExtensionContext): void {
  const manifest = loadManifest(context.extensionPath);
  registerTerminalCleanup(context);
  registerSmlSchemas(context);

  for (const opName of Object.keys(manifest.operations)) {
    context.subscriptions.push(
      vscode.commands.registerCommand(`psUtils.op.${opName}`, (uri?: vscode.Uri) => {
        openParamDialog(context, manifest, opName, uri);
      }),
    );
  }

  context.subscriptions.push(
    vscode.commands.registerCommand("psUtils.settings", () => openSettingsPanel(context)),
  );
}

export function deactivate(): void {
  /* nothing to clean up beyond context subscriptions */
}
