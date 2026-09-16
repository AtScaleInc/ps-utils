/**
 * Rewrite the PS-Utils VS Code extension's package.json menu contributions from
 * operations.manifest.json.
 *
 * Run after generate:extension-manifest:
 *   npm run generate:extension-contributes
 *
 * This is called automatically by `npm run build`. It owns three keys of the
 * extension's `contributes` object — `commands`, `submenus`, and `menus` — and
 * rewrites them in place, preserving `configuration` and every other field. The
 * command ids it emits (`psUtils.op.<name>`) are the same ones the extension
 * registers at runtime, keeping the two in lock-step.
 *
 * Menu structure:
 *   explorer/context ──▶ submenu "PS-Utils"
 *                          ├─ submenu per group   (visible per group's file/folder mix)
 *                          │    └─ op command      (visible per op's file/folder context)
 *                          ├─ "Settings…" command  (always visible)
 *                          └─ one SML support command (exactly one of three, see below)
 */
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const EXT_DIR = path.resolve(__dirname, "../../vscode-extension");
const MANIFEST = path.join(EXT_DIR, "media/operations.manifest.json");
const PKG = path.join(EXT_DIR, "package.json");

interface ManifestOperation {
  description: string;
  group: string;
  contexts: ("file" | "folder")[];
  targetParam: { file?: string; folder?: string };
  params: unknown[];
}
interface Manifest {
  generalGroupName: string;
  groups: { name: string; operations: string[] }[];
  operations: Record<string, ManifestOperation>;
}

const manifest: Manifest = JSON.parse(fs.readFileSync(MANIFEST, "utf8"));

/**
 * The SML support entry, sitting beside "Settings…" in the PS-Utils submenu.
 *
 * It reads as a **checkbox** that toggles the workspace-scoped
 * `psUtils.sml.enabled` setting:
 *
 *   installed, on here       ──▶ "☑ SML Support"          (click turns it off)
 *   installed, off here      ──▶ "☐ SML Support"          (click turns it on)
 *   YAML extension missing   ──▶ "☐ SML Support (install YAML extension)"
 *
 * Three commands share the one slot because neither half of that is directly
 * expressible: `contributes.menus` items support only `command`/`alt`/`when`/
 * `group` — there is no `toggled` property, so an extension cannot get a native
 * checkmark in a context menu — and a command's `title` is static, so the label
 * can only change by swapping which command occupies the slot. The check is
 * therefore drawn in the title, and `when` clauses over context keys the extension
 * publishes at runtime (see setSmlContextKeys in
 * vscode-extension/src/sml-schema.ts) keep exactly one visible.
 *
 * `paletteHidden` keeps these three out of the Command Palette, where `when`
 * clauses on the *menu* entry do not apply: without an explicit `commandPalette`
 * entry every contributed command is listed there, so all three states — including
 * "install the YAML extension" when it is already installed — would be offered at
 * once. The palette instead gets `psUtils.sml.toggle`, a plain verb, since a
 * checkbox glyph reads badly in a search list.
 */
const SML_MENU = [
  {
    command: "psUtils.sml.installYamlExtension",
    title: "☐ SML Support (install YAML extension)",
    when: "!psUtils.yamlExtensionInstalled",
    paletteHidden: true,
  },
  {
    command: "psUtils.sml.enable",
    title: "☐ SML Support",
    when: "psUtils.yamlExtensionInstalled && !psUtils.smlEnabled",
    paletteHidden: true,
  },
  {
    command: "psUtils.sml.disable",
    title: "☑ SML Support",
    when: "psUtils.yamlExtensionInstalled && psUtils.smlEnabled",
    paletteHidden: true,
  },
  {
    command: "psUtils.sml.toggle",
    title: "Toggle SML Support for this Project",
    when: "false", // palette-only; never shown in the context menu
  },
];

/**
 * "Monitor SML Directory", below the SML support checkbox.
 *
 * This is a *watch* wrapper around the `atscale-list-model-errors` operation, not
 * a second copy of it: the operation already appears in the AtScale Config group
 * for a one-shot run in the terminal, while these re-run it on every change and
 * route the problems into the Problems panel. It is therefore a plain command
 * here rather than anything derived from the manifest.
 *
 * Like SML_MENU it reads as a checkbox, drawn in the title for the same reason:
 * `contributes.menus` has no `toggled` property and a command's `title` is static,
 * so two commands share the slot and `when` clauses decide which is visible.
 *
 * The state here is per *directory* rather than global, which a boolean context
 * key cannot express — with two monitored directories it would tick both. VS
 * Code's `in` operator tests membership of a context key's value, so
 * `psUtils.smlMonitoredDirs` is published as an array of paths (see
 * `setContext` in vscode-extension/src/sml-monitor.ts) and the check appears on
 * exactly the folder being watched.
 *
 * `resourcePath` rather than `resource`: the key holds filesystem paths as the
 * monitor stores them, not URI strings.
 */
const MONITORED = "resourcePath in psUtils.smlMonitoredDirs";

const MONITOR_MENU = [
  {
    command: "psUtils.sml.monitor",
    title: "☐ Monitor SML Directory",
    when: `explorerResourceIsFolder && !(${MONITORED})`,
    paletteHidden: true,
  },
  {
    command: "psUtils.sml.monitorActive",
    title: "☑ Monitor SML Directory",
    when: `explorerResourceIsFolder && ${MONITORED}`,
    paletteHidden: true,
  },
  // Palette entries. The glyph titles above read badly in a search list, exactly
  // as for the SML support checkbox, so the palette gets plain verbs instead.
  {
    command: "psUtils.sml.monitorPick",
    title: "Monitor an SML Directory…",
    when: "false",
  },
  {
    command: "psUtils.sml.stopMonitor",
    title: "Stop Monitoring SML Directory",
    when: "false",
  },
  {
    command: "psUtils.sml.showMonitorLog",
    title: "Show SML Validation Log",
    when: "false", // status-bar-only; the log is one click from there
    paletteHidden: true,
  },
];

function slug(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
}

/** `when` clause for a member/group given the contexts it should appear in. */
function whenClause(hasFile: boolean, hasFolder: boolean): string | undefined {
  if (hasFile && hasFolder) return undefined; // always (also covers General: both true)
  if (hasFile) return "!explorerResourceIsFolder";
  if (hasFolder) return "explorerResourceIsFolder";
  return undefined;
}

// ── commands ────────────────────────────────────────────────────────────────
const commands: { command: string; title: string; category: string }[] = [];
for (const opName of Object.keys(manifest.operations)) {
  commands.push({ command: `psUtils.op.${opName}`, title: opName, category: "PS-Utils" });
}
commands.push({ command: "psUtils.settings", title: "Settings…", category: "PS-Utils" });
for (const entry of [...SML_MENU, ...MONITOR_MENU]) {
  commands.push({ command: entry.command, title: entry.title, category: "PS-Utils" });
}

// ── submenus ────────────────────────────────────────────────────────────────
const submenus: { id: string; label: string }[] = [{ id: "psUtils.root", label: "PS-Utils" }];
for (const group of manifest.groups) {
  submenus.push({ id: `psUtils.group.${slug(group.name)}`, label: group.name });
}

// ── menus ─────────────────────────────────────────────────────────────────────
type MenuItem = { command?: string; submenu?: string; group?: string; when?: string };
const menus: Record<string, MenuItem[]> = {
  "explorer/context": [{ submenu: "psUtils.root", group: "9_psutils@1", when: "resourceScheme == file" }],
  "psUtils.root": [],
};

manifest.groups.forEach((group, gi) => {
  const isGeneral = group.name === manifest.generalGroupName;
  const ops = group.operations.map((n) => manifest.operations[n]).filter(Boolean);
  const groupHasFile = isGeneral || ops.some((o) => o.contexts.includes("file"));
  const groupHasFolder = isGeneral || ops.some((o) => o.contexts.includes("folder"));

  menus["psUtils.root"].push({
    submenu: `psUtils.group.${slug(group.name)}`,
    group: `1_groups@${gi + 1}`,
    when: whenClause(groupHasFile, groupHasFolder),
  });

  menus[`psUtils.group.${slug(group.name)}`] = group.operations.map((opName, oi) => {
    const op = manifest.operations[opName];
    const hasFile = isGeneral || op.contexts.includes("file");
    const hasFolder = isGeneral || op.contexts.includes("folder");
    return {
      command: `psUtils.op.${opName}`,
      group: `1_ops@${oi + 1}`,
      when: whenClause(hasFile, hasFolder),
    };
  });
});

menus["psUtils.root"].push({ command: "psUtils.settings", group: "9_settings@1" });
for (const entry of SML_MENU) {
  if (entry.when === "false") continue; // palette-only entries take no menu slot
  menus["psUtils.root"].push({ command: entry.command, group: "9_settings@2", when: entry.when });
}
for (const entry of MONITOR_MENU) {
  if (entry.when === "false") continue;
  menus["psUtils.root"].push({ command: entry.command, group: "9_settings@3", when: entry.when });
}

// Command Palette visibility. Only the SML commands are listed: every other
// contributed command is palette-visible by default, which is the existing
// behaviour and should stay that way.
menus["commandPalette"] = [
  ...SML_MENU.map((entry) => ({
    command: entry.command,
    when: entry.paletteHidden ? "false" : undefined,
  })),
  ...MONITOR_MENU.map((entry) => ({
    command: entry.command,
    when: entry.paletteHidden ? "false" : undefined,
  })),
];

// Strip undefined `when` keys so the emitted JSON stays clean.
function clean<T extends Record<string, unknown>>(obj: T): T {
  for (const k of Object.keys(obj)) if (obj[k] === undefined) delete obj[k];
  return obj;
}
for (const list of Object.values(menus)) list.forEach((m) => clean(m));

// ── splice into package.json ────────────────────────────────────────────────
const pkg = JSON.parse(fs.readFileSync(PKG, "utf8"));
pkg.contributes = pkg.contributes ?? {};
pkg.contributes.commands = commands;
pkg.contributes.submenus = submenus;
pkg.contributes.menus = menus;

fs.writeFileSync(PKG, JSON.stringify(pkg, null, 2) + "\n");
console.log(
  `[generate-extension-contributes] Wrote ${PKG} ` +
    `(${commands.length} commands, ${submenus.length} submenus, ${manifest.groups.length} groups)`,
);
