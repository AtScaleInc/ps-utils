/**
 * Generate REST.md — REST API reference documentation.
 *
 * Run after any operation or parameter change:
 *   npm run generate:rest-docs
 *
 * This is called automatically by `npm run build`.
 */
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { buildRegistry } from "../operations/index.js";
import { buildOpMetas } from "../operations/execute-web-services/graphql-server.js";
import type { OpMeta, ParamMeta } from "../operations/execute-web-services/graphql-server.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const OUT = path.resolve(__dirname, "../../docs/REST.md");

const nullLogger = { log: () => { }, info: () => { }, error: () => { }, verbose: () => { } };

const registry = await buildRegistry(nullLogger, { includeSql: false });
const metas = buildOpMetas(registry);

// ──────────────────────────────────────────────────────────────────────────────
// curl example builders
// ──────────────────────────────────────────────────────────────────────────────

/** Build a JSON body curl example showing required params. */
function curlJsonExample(meta: OpMeta): string[] {
  const inputParams = meta.params.filter((p) => !p.isOutputDir && !p.isOutputFile);
  const exampleFields: string[] = [];

  for (const p of inputParams.filter((p) => p.required || p.isFile).slice(0, 4)) {
    if (p.isFile) {
      exampleFields.push(`  "${p.fieldName}Content": "--- # inline YAML/file content"`);
    } else if (p.gqlType === "Boolean") {
      exampleFields.push(`  "${p.fieldName}": false`);
    } else if (p.gqlType === "Int") {
      exampleFields.push(`  "${p.fieldName}": 0`);
    } else {
      exampleFields.push(`  "${p.fieldName}": "value"`);
    }
  }

  const bodyLines =
    exampleFields.length > 0
      ? [`  -d '{`, ...exampleFields.map((l, i) => `    ${l}${i < exampleFields.length - 1 ? "," : ""}`), `  }'`]
      : [`  -d '{}'`];

  return [
    "```bash",
    `curl -X POST http://localhost:4000/rest/${meta.opName} \\`,
    `  -H "Content-Type: application/json" \\`,
    ...bodyLines,
    "```",
  ];
}

/** Build a multipart curl example for operations with file params. */
function curlMultipartExample(meta: OpMeta): string[] | null {
  const fileParams = meta.params.filter((p) => p.isFile);
  if (fileParams.length === 0) return null;

  const formFields: string[] = [];
  for (const p of fileParams.slice(0, 2)) {
    formFields.push(`  -F "${p.fieldName}Upload=@/path/to/file" \\`);
  }
  const requiredNonFile = meta.params
    .filter((p) => p.required && !p.isFile && !p.isOutputDir && !p.isOutputFile)
    .slice(0, 3);
  for (const p of requiredNonFile) {
    if (p.gqlType === "Boolean") {
      formFields.push(`  -F "${p.fieldName}=false" \\`);
    } else if (p.gqlType === "Int") {
      formFields.push(`  -F "${p.fieldName}=0" \\`);
    } else {
      formFields.push(`  -F "${p.fieldName}=value" \\`);
    }
  }

  // Remove trailing backslash from last line
  if (formFields.length > 0) {
    formFields[formFields.length - 1] = formFields[formFields.length - 1].replace(/ \\$/, "");
  }

  return [
    "```bash",
    "# With file upload (multipart/form-data):",
    `curl -X POST http://localhost:4000/rest/${meta.opName} \\`,
    ...formFields,
    "```",
  ];
}

// ──────────────────────────────────────────────────────────────────────────────
// Operation groupings (mirrors README.md TOC order)
// ──────────────────────────────────────────────────────────────────────────────

const GROUPS: [string, string[]][] = [
  ["Model Extraction", [
    "extract-model-from-atscale", "extract-model-from-sml",
  ]],
  ["SML Creation and Manipulation", [
    "execute-sql-on-connection", "extract-ddl-from-connection",
    "generate-sml-from-connection", "generate-sml-from-ddl",
    "generate-sml-from-xml", "generate-shared-model-plan",
    "apply-shared-model-plan-option", "generate-ddl-from-atscale",
    "generate-metrics-from-model",
  ]],
  ["Synthetic Data Generation", [
    "extract-data-shape-from-connection", "generate-ddl-from-data-shape",
    "generate-data-from-data-shape", "generate-data-from-data-shape-to-connection",
  ]],
  ["Visualization and Namespace Processing", [
    "generate-namespace-from-model", "generate-tableau-from-namespace",
    "generate-excel-from-namespace", "generate-powerbi-from-namespace",
    "generate-notebook-from-connection",
  ]],
  ["Testing / Query Processing", [
    "generate-queries-from-sml", "generate-queries-from-model",
    "extract-query-stats-from-atscale", "extract-queries-from-atscale",
    "execute-atscale-query-harness", "execute-query-on-connection",
    "generate-enhanced-query-results", "execute-run-analysis",
  ]],
  ["AtScale Config", [
    "generate-atscale-install-yaml", "atscale-list-data-sources",
    "atscale-create-data-source", "atscale-list-repos",
    "atscale-create-repo", "atscale-list-deployments",
    "atscale-deploy-catalog", "atscale-list-model-errors",
    "get-dso-count"
  ]],
  ["Web Services", ["execute-web-services"]],
];

// Build lookup maps and sort metas to match group order
const opToGroup = new Map<string, string>();
const opToGroupIndex = new Map<string, number>();
const opToIndexInGroup = new Map<string, number>();
GROUPS.forEach(([groupName, opNames], gi) => {
  opNames.forEach((opName, oi) => {
    opToGroup.set(opName, groupName);
    opToGroupIndex.set(opName, gi);
    opToIndexInGroup.set(opName, oi);
  });
});

const sortedMetas = [...metas].sort((a, b) => {
  const ga = opToGroupIndex.get(a.opName) ?? GROUPS.length;
  const gb = opToGroupIndex.get(b.opName) ?? GROUPS.length;
  if (ga !== gb) return ga - gb;
  return (opToIndexInGroup.get(a.opName) ?? 999) - (opToIndexInGroup.get(b.opName) ?? 999);
});

// ──────────────────────────────────────────────────────────────────────────────
// Markdown generation
// ──────────────────────────────────────────────────────────────────────────────

const lines: string[] = [];

lines.push(
  "# REST API Reference",
  "",
  "> Auto-generated by `npm run generate:rest-docs`. Do not edit by hand.",
  "",
  "## Table of Contents",
  "",
  "- [Overview](#overview)",
  "- [Starting the Server](#starting-the-server)",
  "- [Parameters](#parameters)",
  "- [Endpoints](#endpoints)",
  "- [File Parameters](#file-parameters)",
  "- [Operations](#operations)",
);

for (const [groupName, opNames] of GROUPS) {
  lines.push(`  - ${groupName}`);
  for (const opName of opNames) {
    const meta = sortedMetas.find((m) => m.opName === opName);
    if (meta) {
      lines.push(`    - [\`${meta.opName}\`](#${meta.opName.toLowerCase()})`);
    }
  }
}

lines.push(
  "",
  "---",
  "",
  "## Overview",
  "",
  "The `execute-web-services` operation starts a server that exposes every registered",
  "CLI operation as both a **REST endpoint** (at `/rest`) and a **GraphQL mutation**",
  "(at `/graphql`). See [GRAPHQL.md](GRAPHQL.md) for the GraphQL API reference.",
  "",
  "## Starting the Server",
  "",
  "```bash",
  "./atscale-utils execute-web-services                        # default: localhost:4000",
  "./atscale-utils execute-web-services --port 4000 --host 0.0.0.0",
  "```",
  "",
  "| Endpoint | URL |",
  "|----------|-----|",
  "| REST     | `http://<host>:<port>/rest` |",
  "| GraphQL  | `http://<host>:<port>/graphql` |",
  "",
  "## Parameters",
  "",
  "| Parameter | Default | Description |",
  "|-----------|---------|-------------|",
  "| `--port` | `4000` | Port to listen on |",
  "| `--host` | `localhost` | Bind address (`0.0.0.0` to accept external connections) |",
  "",
  "---",
  "",
  "## Endpoints",
  "",
  "### List Operations",
  "",
  "`GET /rest`",
  "",
  "Returns all available operations.",
  "",
  "```bash",
  "curl http://localhost:4000/rest",
  "```",
  "",
  "**Response:**",
  "```json",
  `{`,
  `  "operations": [`,
  `    { "name": "generate-sml-from-connection", "endpoint": "/rest/generate-sml-from-connection", "description": "..." }`,
  `  ]`,
  `}`,
  "```",
  "",
  "### Execute an Operation",
  "",
  "`POST /rest/{operation-name}`",
  "",
  "**Supported content types:**",
  "",
  "| Content-Type | Body format |",
  "|--------------|-------------|",
  "| `application/json` | JSON object with camelCase field names |",
  "| `multipart/form-data` | Form fields + file upload fields |",
  "",
  "**Response:**",
  "```json",
  `{`,
  `  "success": true,`,
  `  "output": "captured log output",`,
  `  "error": null,`,
  `  "file": {`,
  `    "filename": "output.zip",`,
  `    "content": "<base64-encoded>",`,
  `    "mimeType": "application/zip"`,
  `  }`,
  `}`,
  "```",
  "",
  "`file` is `null` when the operation does not produce file output. When multiple",
  "output files are produced they are collected into a single `output.zip`.",
  "",
  "---",
  "",
  "## File Parameters",
  "",
  "For any `*-file` input parameter, three variants are accepted:",
  "",
  "| Variant | How to pass |",
  "|---------|------------|",
  "| `connectionFile` | `\"connectionFile\": \"/path/to/file\"` in JSON body — path on server |",
  "| `connectionFileContent` | `\"connectionFileContent\": \"raw content\"` in JSON body |",
  "| `connectionFileUpload` | `-F connectionFileUpload=@file.yaml` in multipart |",
  "",
  "Output parameters (e.g. `outputDir`, `outputFile`) are managed automatically —",
  "do not include them in the request. The server injects temp paths, collects",
  "produced files, and returns them in the `file` response field.",
  "",
  "---",
  "",
  "## Operations",
  "",
);

let currentGroup = "";
for (const meta of sortedMetas) {
  const groupName = opToGroup.get(meta.opName) ?? "Other";
  if (groupName !== currentGroup) {
    currentGroup = groupName;
    lines.push(`#### ${groupName}`, "");
  }
  lines.push(`### \`${meta.opName}\``);
  lines.push("", "[↑ Table of Contents](#table-of-contents)", "");
  lines.push(`> ${meta.description}`, "");
  lines.push(`**Endpoint:** \`POST /rest/${meta.opName}\`  |  **GraphQL:** \`${meta.mutName}\``, "");

  // Parameter table
  const inputParams = meta.params.filter((p) => !p.isOutputDir && !p.isOutputFile);
  if (inputParams.length > 0) {
    lines.push("| Field (JSON key) | Type | Required | Description |");
    lines.push("|-----------------|------|----------|-------------|");
    for (const p of inputParams) {
      const req = p.isFile ? (p.required ? "Yes\\*" : "No") : (p.required ? "Yes" : "No");
      lines.push(`| \`${p.fieldName}\` | \`${p.gqlType}\` | ${req} | ${p.description} |`);
      if (p.isFile) {
        lines.push(`| \`${p.fieldName}Content\` | \`String\` | No | Raw string content — alternative to \`${p.fieldName}\` |`);
        lines.push(`| \`${p.fieldName}Upload\` | file field | No | Multipart upload — alternative to \`${p.fieldName}\` |`);
      }
    }
    if (inputParams.some((p) => p.isFile && p.required)) {
      lines.push("", "\\* Required when neither the `Content` nor `Upload` variant is provided.");
    }
    lines.push("");
  }

  // curl examples
  lines.push("**curl (JSON):**", "");
  lines.push(...curlJsonExample(meta), "");

  const multipart = curlMultipartExample(meta);
  if (multipart) {
    lines.push(...multipart, "");
  }

  lines.push("---", "");
}

fs.writeFileSync(OUT, lines.join("\n"));
console.log(`[generate-rest-docs] Wrote ${OUT}`);
