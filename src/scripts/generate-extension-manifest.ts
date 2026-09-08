/**
 * Generate operations.manifest.json — the machine-readable operation catalogue
 * consumed by the PS-Utils VS Code extension.
 *
 * Run after any operation or parameter change:
 *   npm run generate:extension-manifest
 *
 * This is called automatically by `npm run build`, and is followed by
 * `generate:extension-contributes`, which turns this manifest into the
 * extension's package.json menu contributions.
 *
 * The manifest is derived entirely from the runtime operation registry and the
 * shared OPERATION_GROUPS list, so it never drifts from the CLI. Parameter roles
 * (input file, output file, directory) reuse the same naming conventions the
 * web-services server uses (see graphql-server.ts).
 */
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { buildRegistry } from "../operations/index.js";
import { OPERATION_GROUPS } from "../operations/operation-groups.js";
import {
  isFileParam,
  isDirParam,
  isOutputFileParam,
  isOutputDirParam,
} from "../operations/execute-web-services/graphql-server.js";
import { BooleanParameter, NumberParameter } from "../Parameters.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const OUT = path.resolve(__dirname, "../../vscode-extension/media/operations.manifest.json");

const nullLogger = { log: () => {}, info: () => {}, error: () => {}, verbose: () => {} };

// ──────────────────────────────────────────────────────────────────────────────
// Manifest types (kept in sync with the extension's src/manifest.ts)
// ──────────────────────────────────────────────────────────────────────────────

type ParamRole = "input-file" | "output-file" | "input-dir" | "output-dir" | "scalar";
type ParamType = "string" | "number" | "boolean";

interface ManifestParam {
  name: string;
  description: string;
  type: ParamType;
  role: ParamRole;
  required: boolean;
  default: string | number | boolean | null;
}

interface ManifestOperation {
  description: string;
  group: string;
  /** Which explorer targets this op is offered for. */
  contexts: ("file" | "folder")[];
  /** Param name that receives the right-clicked path, per context. */
  targetParam: { file?: string; folder?: string };
  params: ManifestParam[];
}

interface Manifest {
  cliPackage: string;
  cliBin: string;
  /** Param name → workspace-setting key, prefilled into dialogs from project settings. */
  settingsParams: Record<string, string>;
  generalGroupName: string;
  groups: { name: string; operations: string[] }[];
  operations: Record<string, ManifestOperation>;
}

const GENERAL_GROUP = "General";

// Params consistent across a project that should be prefilled from workspace settings.
const SETTINGS_PARAMS: Record<string, string> = {
  "connection-file": "connectionFile",
  "sml-config-file": "styleFile",
  "model-name": "modelName",
};

// Settings-backed file params are project-wide inputs (a connections file, a style
// config), NOT the operand a user picks in the Explorer. They are prefilled from
// settings and must not, on their own, make an operation "file-context" — otherwise
// net-new generators (e.g. *-from-atscale, whose only file input is connection-file)
// would appear on file right-clicks instead of folder right-clicks.
const SETTINGS_FILE_PARAMS = new Set(["connection-file", "sml-config-file"]);

// ──────────────────────────────────────────────────────────────────────────────
// Classification helpers
// ──────────────────────────────────────────────────────────────────────────────

function classifyRole(name: string): ParamRole {
  if (isDirParam(name)) return isOutputDirParam(name) ? "output-dir" : "input-dir";
  if (isOutputFileParam(name)) return "output-file";
  if (isFileParam(name)) return "input-file";
  return "scalar";
}

function classifyType(param: unknown): ParamType {
  if (param instanceof BooleanParameter) return "boolean";
  if (param instanceof NumberParameter) return "number";
  return "string";
}

// ──────────────────────────────────────────────────────────────────────────────
// Build manifest
// ──────────────────────────────────────────────────────────────────────────────

const registry = await buildRegistry(nullLogger, { includeSql: false });

const opToGroup = new Map<string, string>();
for (const group of OPERATION_GROUPS) {
  for (const opName of group.operations) opToGroup.set(opName, group.name);
}

const operations: Record<string, ManifestOperation> = {};

for (const op of registry.list()) {
  const params: ManifestParam[] = op.parameters.parameters.map((p) => ({
    name: p.name,
    description: p.description,
    type: classifyType(p),
    role: classifyRole(p.name),
    required: p.required && p.defaultValue === undefined,
    default: p.defaultValue ?? null,
  }));

  // A "genuine" input file is one the user operates on — not a settings-backed file.
  const firstGenuineInput = params.find(
    (p) => p.role === "input-file" && !SETTINGS_FILE_PARAMS.has(p.name),
  );
  const firstDir = params.find((p) => p.role === "input-dir") ?? params.find((p) => p.role === "output-dir");
  const firstOutputFile = params.find((p) => p.role === "output-file");

  // Folder context: an op with a directory param, or a net-new generator — one that
  // writes an output file and has no genuine input file (the folder is the destination).
  const folderTarget = firstDir?.name ?? (!firstGenuineInput && firstOutputFile ? firstOutputFile.name : undefined);

  const contexts: ("file" | "folder")[] = [];
  if (firstGenuineInput) contexts.push("file");
  if (folderTarget) contexts.push("folder");

  const group = contexts.length === 0 ? GENERAL_GROUP : (opToGroup.get(op.name) ?? GENERAL_GROUP);

  operations[op.name] = {
    description: op.description,
    group,
    contexts,
    targetParam: { file: firstGenuineInput?.name, folder: folderTarget },
    params,
  };
}

// Groups in display order: OPERATION_GROUPS order, keeping only ops that stayed in
// that group, then a synthetic General group at the end for no-file/no-folder ops.
const groups: { name: string; operations: string[] }[] = [];
for (const group of OPERATION_GROUPS) {
  const members = group.operations.filter((name) => operations[name]?.group === group.name);
  if (members.length > 0) groups.push({ name: group.name, operations: members });
}
const generalMembers = registry
  .list()
  .map((op) => op.name)
  .filter((name) => operations[name]?.group === GENERAL_GROUP);
if (generalMembers.length > 0) groups.push({ name: GENERAL_GROUP, operations: generalMembers });

const manifest: Manifest = {
  cliPackage: "@atscale-ps/ps-utils",
  cliBin: "atscale-utils",
  settingsParams: SETTINGS_PARAMS,
  generalGroupName: GENERAL_GROUP,
  groups,
  operations,
};

fs.mkdirSync(path.dirname(OUT), { recursive: true });
fs.writeFileSync(OUT, JSON.stringify(manifest, null, 2) + "\n");
console.log(`[generate-extension-manifest] Wrote ${OUT} (${Object.keys(operations).length} operations)`);
