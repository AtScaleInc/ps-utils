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
 *                          └─ "Settings…" command  (always visible)
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
