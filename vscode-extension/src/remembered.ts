/**
 * Cross-operation parameter memory.
 *
 * When an operation is executed, the values entered for its scalar parameters
 * (not files/dirs) are remembered per workspace. The next time any operation
 * with a parameter of the same name is opened, that value is prefilled — so, for
 * example, a `--model-name` chosen in one operation defaults into the next.
 *
 * Stored in workspaceState (a Memento) so it is per-project and invisible until
 * surfaced/cleared via the Settings panel. Explicitly-pinned `psUtils.commonParams`
 * always take precedence over remembered values.
 */
import * as vscode from "vscode";

const KEY = "psUtils.rememberedParams";

export type RememberedValue = string | number | boolean;
export type RememberedMap = Record<string, RememberedValue>;

export function getRemembered(context: vscode.ExtensionContext): RememberedMap {
  return context.workspaceState.get<RememberedMap>(KEY, {});
}

/** Merge entries into the remembered map; an empty-string value clears that key. */
export async function updateRemembered(
  context: vscode.ExtensionContext,
  entries: RememberedMap,
): Promise<void> {
  const next: RememberedMap = { ...getRemembered(context) };
  for (const [k, v] of Object.entries(entries)) {
    if (v === "" || v === undefined || v === null) delete next[k];
    else next[k] = v;
  }
  await context.workspaceState.update(KEY, next);
}

export async function clearRemembered(context: vscode.ExtensionContext): Promise<void> {
  await context.workspaceState.update(KEY, {});
}

/** Whether the auto-remember behavior is enabled (setting, default true). */
export function rememberEnabled(): boolean {
  return vscode.workspace.getConfiguration("psUtils").get<boolean>("rememberParameters", true);
}
