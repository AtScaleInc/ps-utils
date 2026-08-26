/**
 * Generate GRAPHQL.md — GraphQL API reference documentation.
 *
 * Run after any operation or parameter change:
 *   npm run generate:graphql-docs
 *
 * This is called automatically by `npm run build`.
 */
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { buildRegistry } from "../operations/index.js";
import { buildOpMetas, buildSdl } from "../operations/execute-web-services/graphql-server.js";
import type { OpMeta, ParamMeta } from "../operations/execute-web-services/graphql-server.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const OUT = path.resolve(__dirname, "../../docs/GRAPHQL.md");

const nullLogger = { log: () => { }, info: () => { }, error: () => { }, verbose: () => { } };

const registry = await buildRegistry(nullLogger, { includeSql: false });
const metas = buildOpMetas(registry);
const sdl = buildSdl(metas);

// ──────────────────────────────────────────────────────────────────────────────
// Helpers
// ──────────────────────────────────────────────────────────────────────────────

/** Build a compact JSON-inline mutation query for a curl example. */
function curlMutationBody(meta: OpMeta): string {
  const inputParams = meta.params.filter((p) => !p.isOutputDir && !p.isOutputFile);
  const exampleFields: string[] = [];
  for (const p of inputParams.filter((p) => p.required || p.isFile).slice(0, 3)) {
    if (p.isFile) {
      exampleFields.push(`${p.fieldName}Content: \\"--- # file content\\"`);
    } else if (p.gqlType === "Boolean") {
      exampleFields.push(`${p.fieldName}: false`);
    } else if (p.gqlType === "Int") {
      exampleFields.push(`${p.fieldName}: 0`);
    } else {
      exampleFields.push(`${p.fieldName}: \\"value\\"`);
    }
  }
  const inputStr = exampleFields.length > 0 ? `{${exampleFields.join(", ")}}` : "{}";
  return `{"query":"mutation{${meta.mutName}(input:${inputStr}){success output error file{filename content mimeType}}}"}`;
}

/** Build a multipart curl example for operations with file upload parameters. */
function curlMultipartBody(meta: OpMeta): string[] | null {
  const fileParams = meta.params.filter((p) => p.isFile);
  if (fileParams.length === 0) return null;

  const lines: string[] = [
    "# With file upload (GraphQL multipart request spec):",
    `curl -X POST http://localhost:4000/graphql \\`,
  ];
  const fileParam = fileParams[0];
  const otherRequired = meta.params
    .filter((p) => p.required && !p.isFile && !p.isOutputDir && !p.isOutputFile)
    .slice(0, 2);

  const queryFields: string[] = [
    `${fileParam.fieldName}Upload:$f`,
    ...otherRequired.map((p) => `${p.fieldName}:\\"value\\"`),
  ];
  lines.push(
    `  -F 'operations={"query":"mutation($f:Upload!){${meta.mutName}(input:{${queryFields.join(",")}}){success output error}}","variables":{"f":null}}' \\`,
    `  -F 'map={"f":["variables.f"]}' \\`,
    `  -F 'f=@/path/to/file'`,
  );
  return lines;
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
  "# GraphQL API Reference",
  "",
  "> Auto-generated by `npm run generate:graphql-docs`. Do not edit by hand.",
  "",
  "## Table of Contents",
  "",
  "- [Overview](#overview)",
  "- [Starting the Server](#starting-the-server)",
  "- [Parameters](#parameters)",
  "- [File Parameters](#file-parameters)",
  "- [Response](#response)",
  "- [Introspection Query](#introspection-query)",
  "- [Operations](#operations)",
);

for (const [groupName, opNames] of GROUPS) {
  lines.push(`  - ${groupName}`);
  for (const opName of opNames) {
    const meta = sortedMetas.find((m) => m.opName === opName);
    if (meta) {
      lines.push(`    - [\`${meta.mutName}\`](#${meta.mutName.toLowerCase()})`);
    }
  }
}

lines.push(
  "- [Full SDL](#full-sdl)",
  "",
  "---",
  "",
  "## Overview",
  "",
  "The `execute-web-services` operation starts a server that exposes every registered",
  "CLI operation as both a **GraphQL mutation** (at `/graphql`) and a **REST endpoint**",
  "(at `/rest`). See [REST.md](REST.md) for the REST API reference.",
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
  "| GraphQL  | `http://<host>:<port>/graphql` |",
  "| REST     | `http://<host>:<port>/rest` |",
  "",
  "## Parameters",
  "",
  "| Parameter | Default | Description |",
  "|-----------|---------|-------------|",
  "| `--port` | `4000` | Port to listen on |",
  "| `--host` | `localhost` | Bind address (`0.0.0.0` to accept external connections) |",
  "",
  "## File Parameters",
  "",
  "Parameters whose names end in `-file` expose **three** ways to supply the file:",
  "",
  "| Variant | GraphQL type | Description |",
  "|---------|-------------|-------------|",
  "| `<field>` | `String` | Path to a file on the server's filesystem |",
  "| `<field>Upload` | `Upload` | Multipart file upload (GraphQL multipart request spec) |",
  "| `<field>Content` | `String` | Raw file content as a string — server writes it to a temp file |",
  "",
  "Output parameters (e.g. `outputDir`) are managed automatically — do not pass them.",
  "The server injects temp paths and returns produced files in the `file` field.",
  "",
  "## Response",
  "",
  "Every mutation returns `OperationResult`:",
  "",
  "```graphql",
  "type OperationResult {",
  "  success: Boolean!   # true when the operation completed without error",
  "  output:  String!    # captured log output from the operation",
  "  error:   String     # error message when success is false",
  "  file:    FileResult # present when the operation produced output files",
  "}",
  "",
  "type FileResult {",
  "  filename: String!   # e.g. output.zip or model.yaml",
  "  content:  String!   # base64-encoded file content",
  "  mimeType: String!   # e.g. application/zip or application/x-yaml",
  "}",
  "```",
  "",
  "When an operation produces multiple output files they are zipped into a single",
  "`output.zip`; a single file is returned as-is with its native MIME type.",
  "",
  "## Introspection Query",
  "",
  "To list all available operations at runtime:",
  "",
  "```graphql",
  "query {",
  "  _operations {",
  "    name",
  "    description",
  "    mutationName",
  "  }",
  "}",
  "```",
  "",
  "```bash",
  `curl http://localhost:4000/graphql \\`,
  `  -H "Content-Type: application/json" \\`,
  `  -d '{"query":"{_operations{name description mutationName}}"}'`,
  "```",
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
  lines.push(`### \`${meta.mutName}\``);
  lines.push("", "[↑ Table of Contents](#table-of-contents)", "");
  lines.push(`> ${meta.description}`, "");
  lines.push(`**CLI name:** \`${meta.opName}\`  |  **REST:** \`POST /rest/${meta.opName}\``, "");

  // Parameter table
  lines.push("| Input field | GraphQL type | Required | Description |");
  lines.push("|-------------|-------------|----------|-------------|");
  for (const p of meta.params) {
    const isOutput = p.isOutputDir || p.isOutputFile;
    if (isOutput) {
      lines.push(`| \`${p.fieldName}\` | \`${p.gqlType}\` | — | *Server-managed output path — do not pass* |`);
      continue;
    }
    const type = p.gqlType;
    const req = p.isFile ? (p.required ? "Yes\\*" : "No") : (p.required ? "Yes" : "No");
    lines.push(`| \`${p.fieldName}\` | \`${type}\` | ${req} | ${p.description} |`);
    if (p.isFile) {
      lines.push(`| \`${p.fieldName}Upload\` | \`Upload\` | No | Multipart upload — alternative to \`${p.fieldName}\` |`);
      lines.push(`| \`${p.fieldName}Content\` | \`String\` | No | Raw string content — alternative to \`${p.fieldName}\` |`);
    }
  }
  if (meta.params.some((p) => p.isFile && p.required)) {
    lines.push("", "\\* Required when neither the `Upload` nor `Content` variant is provided.");
  }
  lines.push("");

  // GraphQL example
  const inputParams = meta.params.filter((p) => !p.isOutputDir && !p.isOutputFile);
  const exampleFields = inputParams
    .filter((p) => p.required || p.isFile)
    .slice(0, 3)
    .map((p) => {
      if (p.isFile) return `    ${p.fieldName}Content: "--- # file content"`;
      if (p.gqlType === "Boolean") return `    ${p.fieldName}: false`;
      if (p.gqlType === "Int") return `    ${p.fieldName}: 0`;
      return `    ${p.fieldName}: "value"`;
    });

  if (exampleFields.length > 0) {
    lines.push(
      "**GraphQL:**",
      "",
      "```graphql",
      "mutation {",
      `  ${meta.mutName}(input: {`,
      ...exampleFields,
      "  }) {",
      "    success output error",
      "    file { filename content mimeType }",
      "  }",
      "}",
      "```",
      "",
    );
  }

  // curl examples
  lines.push(
    "**curl:**",
    "",
    "```bash",
    `curl -X POST http://localhost:4000/graphql \\`,
    `  -H "Content-Type: application/json" \\`,
    `  -d '${curlMutationBody(meta)}'`,
    "```",
    "",
  );

  const multipart = curlMultipartBody(meta);
  if (multipart) {
    lines.push("```bash", ...multipart, "```", "");
  }

  lines.push("---", "");
}

lines.push(
  "## Full SDL",
  "",
  "```graphql",
  sdl,
  "```",
);

fs.writeFileSync(OUT, lines.join("\n"));
console.log(`[generate-graphql-docs] Wrote ${OUT}`);
