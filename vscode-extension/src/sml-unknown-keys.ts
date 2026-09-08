/**
 * Publishes the unknown-key findings from `sml-unknown-keys-core.ts` as editor
 * diagnostics, and offers a quick fix for the ones with a close documented match.
 *
 * ## Why the extension owns this channel
 *
 * The schemas stay `additionalProperties: true` (see the core module), so
 * redhat.vscode-yaml will never report an undocumented key. This is a separate
 * `DiagnosticCollection` at *warning* severity, which is what makes it safe: a
 * spec gap is a squiggle, not a red error, and `psUtils.smlUnknownKeys` turns it
 * down or off without touching the rest of SML validation.
 *
 * It also means typo detection is the one part of SML support that works with no
 * YAML extension installed — nothing here goes through `registerContributor`.
 *
 * ## Ordering rule
 *
 * Like the schema contributor, this must not be what breaks when schema loading
 * fails: the caller passes an already-loaded lookup, and a missing schema simply
 * clears the file's diagnostics.
 */
import * as vscode from "vscode";
import { findUnknownKeys } from "./sml-unknown-keys-core";
import type { Allowlist, JsonSchema, UnknownKey } from "./sml-unknown-keys-core";

const CONFIG_SECTION = "psUtils";
const SEVERITY_SETTING = "smlUnknownKeys";
const FULL_SEVERITY_SETTING = `${CONFIG_SECTION}.${SEVERITY_SETTING}`;
const DIAGNOSTIC_SOURCE = "SML";
const DIAGNOSTIC_CODE = "unknown-key";

/**
 * Revalidation delay while typing. Long enough that a half-written key
 * (`colum`, then `column`, then `columns`) does not flash a warning on the way to
 * being correct; short enough to feel like part of the edit.
 */
const DEBOUNCE_MS = 500;

export interface UnknownKeyLinterOptions {
  /** The schema for an SML object type, already parsed. */
  schemaFor(objectType: string): JsonSchema | undefined;
  /** The object type of a document URI, or undefined if it is not SML. */
  objectTypeFor(resource: string): string | undefined;
  /** The `psUtils.smlEnabled` project switch — this channel obeys it too. */
  isEnabled(): boolean;
  /** Keys the toolchain emits that the spec omits, from `index.json`. */
  allowlist: Allowlist;
  log?: vscode.LogOutputChannel;
}

const severityFromSettings = (): vscode.DiagnosticSeverity | undefined => {
  const value = vscode.workspace
    .getConfiguration(CONFIG_SECTION)
    .get<string>(SEVERITY_SETTING, "warning");
  if (value === "off") return undefined;
  return value === "information"
    ? vscode.DiagnosticSeverity.Information
    : vscode.DiagnosticSeverity.Warning;
};

/** `columns[0]` reads better than the object type when the key is nested. */
const describeLocation = (finding: UnknownKey, objectType: string): string =>
  finding.path.length === 0
    ? `SML \`${objectType}\``
    : `\`${finding.path}\` in SML \`${objectType}\``;

export function registerUnknownKeyDiagnostics(
  context: vscode.ExtensionContext,
  options: UnknownKeyLinterOptions,
): void {
  const diagnostics = vscode.languages.createDiagnosticCollection("sml-unknown-keys");
  context.subscriptions.push(diagnostics);

  // Kept alongside the diagnostics so the quick fix can recover the suggestion,
  // which does not survive a round trip through `vscode.Diagnostic`.
  const findingsByDocument = new Map<string, UnknownKey[]>();
  const pending = new Map<string, ReturnType<typeof setTimeout>>();

  const clear = (document: vscode.TextDocument): void => {
    diagnostics.delete(document.uri);
    findingsByDocument.delete(document.uri.toString());
  };

  const validate = (document: vscode.TextDocument): void => {
    if (document.languageId !== "yaml") return;

    const severity = severityFromSettings();
    if (severity === undefined || !options.isEnabled()) return clear(document);

    const objectType = options.objectTypeFor(document.uri.toString());
    if (!objectType) return clear(document);

    const schema = options.schemaFor(objectType);
    if (!schema) return clear(document);

    const findings = findUnknownKeys(
      document.getText(),
      schema,
      objectType,
      options.allowlist,
    );
    if (findings.length === 0) return clear(document);

    findingsByDocument.set(document.uri.toString(), findings);
    diagnostics.set(
      document.uri,
      findings.map((finding) => {
        const range = new vscode.Range(
          document.positionAt(finding.start),
          document.positionAt(finding.end),
        );
        const where = describeLocation(finding, objectType);
        const suffix = finding.suggestion ? ` Did you mean \`${finding.suggestion}\`?` : "";
        const diagnostic = new vscode.Diagnostic(
          range,
          `\`${finding.key}\` is not a documented property of ${where}.${suffix}`,
          severity,
        );
        diagnostic.source = DIAGNOSTIC_SOURCE;
        diagnostic.code = DIAGNOSTIC_CODE;
        return diagnostic;
      }),
    );
  };

  const validateSoon = (document: vscode.TextDocument): void => {
    const key = document.uri.toString();
    const existing = pending.get(key);
    if (existing) clearTimeout(existing);
    pending.set(
      key,
      setTimeout(() => {
        pending.delete(key);
        validate(document);
      }, DEBOUNCE_MS),
    );
  };

  const validateAll = (): void => {
    for (const document of vscode.workspace.textDocuments) validate(document);
  };

  context.subscriptions.push(
    vscode.workspace.onDidOpenTextDocument(validate),
    vscode.workspace.onDidChangeTextDocument((event) => validateSoon(event.document)),
    vscode.workspace.onDidCloseTextDocument((document) => {
      const timer = pending.get(document.uri.toString());
      if (timer) {
        clearTimeout(timer);
        pending.delete(document.uri.toString());
      }
      clear(document);
    }),
    vscode.workspace.onDidChangeConfiguration((event) => {
      // `smlEnabled` gates this channel as well, so both settings re-run everything.
      if (
        event.affectsConfiguration(FULL_SEVERITY_SETTING) ||
        event.affectsConfiguration(`${CONFIG_SECTION}.smlEnabled`)
      ) {
        validateAll();
      }
    }),
    // Renaming a file can change its object type, since the directory is the
    // fallback discriminator for files with no `object_type` yet.
    vscode.workspace.onDidRenameFiles(validateAll),
    { dispose: () => pending.forEach(clearTimeout) },
  );

  context.subscriptions.push(
    vscode.languages.registerCodeActionsProvider(
      { language: "yaml" },
      new UnknownKeyFixes(findingsByDocument),
      { providedCodeActionKinds: [vscode.CodeActionKind.QuickFix] },
    ),
  );

  validateAll();
  options.log?.debug(`unknown-key diagnostics active (${FULL_SEVERITY_SETTING})`);
}

/** Turns a "did you mean" into a one-click rename of the key. */
class UnknownKeyFixes implements vscode.CodeActionProvider {
  constructor(private readonly findingsByDocument: Map<string, UnknownKey[]>) {}

  provideCodeActions(
    document: vscode.TextDocument,
    range: vscode.Range | vscode.Selection,
    context: vscode.CodeActionContext,
  ): vscode.CodeAction[] {
    const findings = this.findingsByDocument.get(document.uri.toString());
    if (!findings) return [];

    const actions: vscode.CodeAction[] = [];
    for (const diagnostic of context.diagnostics) {
      if (diagnostic.code !== DIAGNOSTIC_CODE || diagnostic.source !== DIAGNOSTIC_SOURCE) continue;
      if (!diagnostic.range.intersection(range)) continue;

      // Match on position rather than identity: `context.diagnostics` are
      // deserialised copies, not the objects `validate` created.
      const finding = findings.find(
        (candidate) =>
          candidate.suggestion !== undefined &&
          document.positionAt(candidate.start).isEqual(diagnostic.range.start),
      );
      if (!finding?.suggestion) continue;

      const action = new vscode.CodeAction(
        `Change to \`${finding.suggestion}\``,
        vscode.CodeActionKind.QuickFix,
      );
      action.diagnostics = [diagnostic];
      action.isPreferred = true;
      action.edit = new vscode.WorkspaceEdit();
      action.edit.replace(document.uri, diagnostic.range, finding.suggestion);
      actions.push(action);
    }
    return actions;
  }
}
