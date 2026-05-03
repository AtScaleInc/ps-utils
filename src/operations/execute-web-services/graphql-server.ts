/**
 * Dynamic GraphQL + REST server for the execute-web-services operation.
 *
 * GraphQL: every operation is a mutation at `POST /graphql`.
 * REST:    every operation is a POST endpoint at `POST /rest/{operation-name}`.
 *          `GET /rest` lists all operations.
 *
 * Both APIs:
 *   - File parameters (names ending in "-file") accept three variants:
 *       <field>               String  — path to a file on the server
 *       <field>Upload         Upload  — multipart file upload (GraphQL only)
 *       <field>Content        String  — raw file content as a string
 *   - Output parameters are injected with temp paths automatically; the
 *     server collects produced files and returns them as a base64 FileResult
 *     (zip when multiple files, raw otherwise).
 *
 * The server is powered by graphql-yoga; REST routes are handled by a
 * lightweight built-in handler using busboy for multipart parsing.
 */

import { createServer, type IncomingMessage, type ServerResponse } from "http";
import { createWriteStream } from "fs";
import { createYoga, createSchema } from "graphql-yoga";
import { join, relative, extname, basename } from "path";
import { tmpdir } from "os";
import { writeFile, unlink, mkdir, readdir, readFile, rm } from "fs/promises";
import { randomUUID } from "crypto";
import JSZip from "jszip";
import Busboy from "busboy";
import type { OperationRegistry } from "../registry.js";
import { BooleanParameter, NumberParameter } from "../../Parameters.js";
import type { Operation } from "../Operation.js";
import type { Logger } from "../../logging.js";

// ──────────────────────────────────────────────────────────────────────────────
// Naming helpers
// ──────────────────────────────────────────────────────────────────────────────

/** kebab-case → camelCase.  "generate-sml-from-xml" → "generateSmlFromXml" */
export function toCamel(s: string): string {
  return s.replace(/-([a-z0-9])/gi, (_, c: string) => c.toUpperCase());
}

/** camelCase → PascalCase for GraphQL type names. */
function toPascal(s: string): string {
  const c = toCamel(s);
  return c.charAt(0).toUpperCase() + c.slice(1);
}

/**
 * Sanitize a string for use inside a GraphQL block-string (`"""..."""`) description.
 *
 * Two rules apply:
 *  1. The literal `"""` inside the content would prematurely close the block string
 *     — replace it with `'''`.
 *  2. If the content ends with `"` the closing `"""` creates `""""`, which the GraphQL
 *     lexer reads as the terminator at the FIRST `"`, leaving an orphan `"` that opens
 *     an unterminated string.  Append a space to prevent this.
 */
function esc(s: string): string {
  let r = s.replace(/"""/g, "'''");
  if (r.endsWith('"')) r += " ";
  return r;
}

// ──────────────────────────────────────────────────────────────────────────────
// Output-parameter detection
// ──────────────────────────────────────────────────────────────────────────────

/**
 * Returns true when the parameter is an output directory.
 * Convention: name ends with "-dir" AND contains "output" (e.g. "output-dir").
 */
function isOutputDirParam(paramName: string): boolean {
  return paramName.endsWith("-dir") && paramName.includes("output");
}

/**
 * Returns true when the parameter is an output file path.
 * Convention: equals "output-file" or starts with "output-" and ends with "-file".
 */
function isOutputFileParam(paramName: string): boolean {
  return paramName === "output-file" || (paramName.startsWith("output-") && paramName.endsWith("-file"));
}

// ──────────────────────────────────────────────────────────────────────────────
// MIME helpers
// ──────────────────────────────────────────────────────────────────────────────

function getMimeType(filename: string): string {
  const ext = extname(filename).toLowerCase();
  const map: Record<string, string> = {
    ".yaml": "application/x-yaml",
    ".yml":  "application/x-yaml",
    ".json": "application/json",
    ".csv":  "text/csv",
    ".txt":  "text/plain",
    ".html": "text/html",
    ".xml":  "application/xml",
    ".sql":  "application/sql",
    ".md":   "text/markdown",
    ".zip":  "application/zip",
  };
  return map[ext] ?? "application/octet-stream";
}

// ──────────────────────────────────────────────────────────────────────────────
// File collection helpers
// ──────────────────────────────────────────────────────────────────────────────

export interface CollectedFile {
  absolutePath: string;
  relativePath: string;  // relative to the temp root
}

/** Recursively list all files under a directory. */
export async function collectFilesRecursive(dir: string, root: string): Promise<CollectedFile[]> {
  const entries = await readdir(dir, { withFileTypes: true });
  const results: CollectedFile[] = [];
  for (const entry of entries) {
    const abs = join(dir, entry.name);
    if (entry.isDirectory()) {
      results.push(...await collectFilesRecursive(abs, root));
    } else {
      results.push({ absolutePath: abs, relativePath: relative(root, abs) });
    }
  }
  return results;
}

// ──────────────────────────────────────────────────────────────────────────────
// FileResult type (returned in OperationResult.file)
// ──────────────────────────────────────────────────────────────────────────────

export interface FileResult {
  filename: string;
  content: string;   // base64-encoded
  mimeType: string;
}

/**
 * Given a list of collected files, build a FileResult.
 * - 0 files  → undefined
 * - 1 file   → return it as-is (base64-encoded)
 * - 2+ files → zip them all and return the zip
 */
export async function buildFileResult(files: CollectedFile[]): Promise<FileResult | undefined> {
  if (files.length === 0) return undefined;

  if (files.length === 1) {
    const data = await readFile(files[0].absolutePath);
    return {
      filename: basename(files[0].absolutePath),
      content: data.toString("base64"),
      mimeType: getMimeType(files[0].absolutePath),
    };
  }

  const zip = new JSZip();
  for (const f of files) {
    const data = await readFile(f.absolutePath);
    zip.file(f.relativePath, data);
  }
  const buffer = await zip.generateAsync({ type: "nodebuffer", compression: "DEFLATE" });
  return {
    filename: "output.zip",
    content: buffer.toString("base64"),
    mimeType: "application/zip",
  };
}

// ──────────────────────────────────────────────────────────────────────────────
// Metadata extraction
// ──────────────────────────────────────────────────────────────────────────────

export interface ParamMeta {
  paramName: string;     // original kebab-case name
  fieldName: string;     // camelCase GraphQL / JSON field name
  description: string;
  gqlType: string;       // "String" | "Boolean" | "Int"
  required: boolean;     // true when required AND no default
  isFile: boolean;       // true → also emit Upload + Content variants
  isOutputDir: boolean;  // true → inject temp dir at runtime
  isOutputFile: boolean; // true → inject temp file path at runtime
}

export interface OpMeta {
  opName: string;        // original kebab-case
  mutName: string;       // camelCase mutation / JS identifier
  inputTypeName: string; // PascalCase + Input (GraphQL only)
  description: string;
  params: ParamMeta[];
}

function isFileParam(paramName: string): boolean {
  return paramName.endsWith("-file");
}

function gqlParamType(param: { isFlag: boolean; parse: (s: string) => unknown }): string {
  if (param.isFlag || param instanceof BooleanParameter) return "Boolean";
  if (param instanceof NumberParameter) return "Int";
  return "String";
}

/** Build structured metadata for every operation in the registry (excluding self). */
export function buildOpMetas(registry: OperationRegistry): OpMeta[] {
  return registry
    .list()
    .filter((op) => op.name !== "execute-web-services")
    .map((op) => {
      const mutName = toCamel(op.name);
      const inputTypeName = toPascal(op.name) + "Input";
      const params: ParamMeta[] = op.parameters.parameters.map((p) => ({
        paramName: p.name,
        fieldName: toCamel(p.name),
        description: p.description,
        gqlType: gqlParamType(p as Parameters<typeof gqlParamType>[0]),
        required: p.required && p.defaultValue === undefined,
        isFile: isFileParam(p.name),
        isOutputDir: isOutputDirParam(p.name),
        isOutputFile: isOutputFileParam(p.name),
      }));
      return { opName: op.name, mutName, inputTypeName, description: op.description, params };
    });
}

// ──────────────────────────────────────────────────────────────────────────────
// SDL builder
// ──────────────────────────────────────────────────────────────────────────────

/** Build the full GraphQL SDL from the operation metadata list. */
export function buildSdl(metas: OpMeta[]): string {
  const inputTypes = metas.map(({ inputTypeName, description, params }) => {
    const fields = params.flatMap((p) => {
      // Output dir/file params are always optional — the server injects temp paths.
      const isOutput = p.isOutputDir || p.isOutputFile;
      const lines: string[] = [
        `  """${esc(p.description)}"""`,
        `  ${p.fieldName}: ${p.gqlType}${!p.isFile && !isOutput && p.required ? "!" : ""}`,
      ];
      if (p.isFile) {
        lines.push(`  """Uploaded file — alternative to ${p.fieldName}"""`);
        lines.push(`  ${p.fieldName}Upload: Upload`);
        lines.push(`  """Raw file content as a string — alternative to ${p.fieldName}"""`);
        lines.push(`  ${p.fieldName}Content: String`);
      }
      return lines;
    });
    // GraphQL forbids empty input types; add a dummy field for parameter-less operations.
    const body = fields.length > 0 ? fields.join("\n") : "  _placeholder: Boolean";
    return `"""${esc(description)}"""\ninput ${inputTypeName} {\n${body}\n}`;
  });

  const mutations = metas.map(
    ({ mutName, inputTypeName, description }) =>
      `  """${esc(description)}"""\n  ${mutName}(input: ${inputTypeName}): OperationResult!`,
  );

  return [
    "scalar Upload",
    "",
    "type FileResult {",
    '  """File name (e.g. output.zip or model.yaml)"""',
    "  filename: String!",
    '  """Base64-encoded file content"""',
    "  content: String!",
    '  """MIME type (e.g. application/zip or application/x-yaml)"""',
    "  mimeType: String!",
    "}",
    "",
    "type OperationResult {",
    "  success: Boolean!",
    "  output: String!",
    "  error: String",
    '  """File output — present when the operation produces one or more output files"""',
    "  file: FileResult",
    "}",
    "",
    "type OperationInfo {",
    "  name: String!",
    "  description: String!",
    "  mutationName: String!",
    "}",
    "",
    "type Query {",
    "  _operations: [OperationInfo!]!",
    "}",
    "",
    inputTypes.join("\n\n"),
    "",
    "type Mutation {",
    mutations.join("\n"),
    "}",
  ].join("\n");
}

// ──────────────────────────────────────────────────────────────────────────────
// Shared execution helpers
// ──────────────────────────────────────────────────────────────────────────────

/** Save a Web API File upload to a temp path and return the path. */
async function saveUpload(file: File): Promise<string> {
  const safeName = file.name.replace(/[^a-zA-Z0-9._-]/g, "_");
  const tmpPath = join(tmpdir(), `gql-upload-${randomUUID()}-${safeName}`);
  const buffer = Buffer.from(await file.arrayBuffer());
  await writeFile(tmpPath, buffer);
  return tmpPath;
}

/**
 * Run an operation with captured log output.
 * Node.js is single-threaded: logger swap is safe for this workload.
 */
export async function runOp(
  op: Operation<Record<string, unknown>>,
  rawParams: Record<string, string>,
): Promise<{ success: boolean; output: string; error?: string }> {
  const lines: string[] = [];
  const capture: Logger = {
    log: (m) => lines.push(m),
    info: (m) => lines.push(m),
    error: (m) => lines.push(m),
    verbose: (m) => lines.push(m),
  };
  const opAny = op as unknown as Record<string, unknown>;
  const original = opAny.logger as Logger;
  opAny.logger = capture;
  try {
    const params = op.parseParams(rawParams);
    await op.run(params);
    return { success: true, output: lines.join("\n") };
  } catch (err) {
    return {
      success: false,
      output: lines.join("\n"),
      error: err instanceof Error ? err.message : String(err),
    };
  } finally {
    opAny.logger = original;
  }
}

/**
 * Inject temp output directories/files, run the operation, collect output files,
 * and return the combined OperationResult with a FileResult when files were produced.
 */
async function runOpWithOutputCollection(
  op: Operation<Record<string, unknown>>,
  rawParams: Record<string, string>,
  meta: OpMeta,
  tempFiles: string[],
  tempDirs: string[],
): Promise<{ success: boolean; output: string; error?: string; file?: FileResult }> {
  // Inject temp paths for output params
  for (const p of meta.params.filter((q) => q.isOutputDir)) {
    const tmpDir = join(tmpdir(), `out-${randomUUID()}`);
    await mkdir(tmpDir, { recursive: true });
    tempDirs.push(tmpDir);
    rawParams[p.paramName] = tmpDir;
  }
  for (const p of meta.params.filter((q) => q.isOutputFile)) {
    const tmpDir = join(tmpdir(), `out-${randomUUID()}`);
    await mkdir(tmpDir, { recursive: true });
    tempDirs.push(tmpDir);
    rawParams[p.paramName] = join(tmpDir, "output");
  }

  const result = await runOp(op, rawParams);

  const collected: CollectedFile[] = [];
  for (const d of tempDirs) {
    collected.push(...await collectFilesRecursive(d, d));
  }
  const fileResult = await buildFileResult(collected);
  return { ...result, file: fileResult };
}

// ──────────────────────────────────────────────────────────────────────────────
// GraphQL resolver builder
// ──────────────────────────────────────────────────────────────────────────────

function buildResolvers(registry: OperationRegistry, metas: OpMeta[]) {
  const Mutation: Record<string, (_: unknown, args: { input: Record<string, unknown> }) => Promise<unknown>> = {};

  for (const meta of metas) {
    const op = registry.get(meta.opName)!;
    Mutation[meta.mutName] = async (_: unknown, { input = {} }: { input?: Record<string, unknown> }) => {
      const tempFiles: string[] = [];
      const tempDirs: string[] = [];
      const rawParams: Record<string, string> = {};

      try {
        for (const p of meta.params) {
          if (p.isOutputDir || p.isOutputFile) continue;

          if (p.isFile) {
            const uploadKey = p.fieldName + "Upload";
            const contentKey = p.fieldName + "Content";
            if (input[uploadKey] instanceof File) {
              const tmpPath = await saveUpload(input[uploadKey] as File);
              tempFiles.push(tmpPath);
              rawParams[p.paramName] = tmpPath;
            } else if (input[contentKey] != null) {
              const tmpPath = join(tmpdir(), `gql-content-${randomUUID()}`);
              await writeFile(tmpPath, String(input[contentKey]), "utf8");
              tempFiles.push(tmpPath);
              rawParams[p.paramName] = tmpPath;
            } else if (input[p.fieldName] != null) {
              rawParams[p.paramName] = String(input[p.fieldName]);
            }
          } else if (input[p.fieldName] != null) {
            rawParams[p.paramName] = String(input[p.fieldName]);
          }
        }

        return await runOpWithOutputCollection(op, rawParams, meta, tempFiles, tempDirs);
      } catch (err) {
        return { success: false, output: "", error: err instanceof Error ? err.message : String(err) };
      } finally {
        for (const f of tempFiles) unlink(f).catch(() => {});
        for (const d of tempDirs) rm(d, { recursive: true, force: true }).catch(() => {});
      }
    };
  }

  const Query = {
    _operations: () =>
      metas.map((m) => ({
        name: m.opName,
        description: m.description,
        mutationName: m.mutName,
      })),
  };

  return { Query, Mutation };
}

// ──────────────────────────────────────────────────────────────────────────────
// REST request handler
// ──────────────────────────────────────────────────────────────────────────────

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const json = JSON.stringify(body, null, 2);
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
  res.end(json);
}

async function readJsonBody(req: IncomingMessage): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    let raw = "";
    req.on("data", (chunk: Buffer) => { raw += chunk.toString(); });
    req.on("end", () => {
      if (!raw.trim()) { resolve({}); return; }
      try { resolve(JSON.parse(raw) as Record<string, unknown>); }
      catch { reject(new Error("Invalid JSON body")); }
    });
    req.on("error", reject);
  });
}

/** Parse multipart/form-data with busboy. Returns field values and temp paths for uploaded files. */
async function readMultipartBody(req: IncomingMessage): Promise<{
  fields: Record<string, string>;
  files: Record<string, string>;
  tempPaths: string[];
}> {
  return new Promise((resolve, reject) => {
    const fields: Record<string, string> = {};
    const files: Record<string, string> = {};
    const tempPaths: string[] = [];
    const pending: Promise<void>[] = [];

    const bb = Busboy({ headers: req.headers as Record<string, string | string[]> });

    bb.on("field", (name, val) => { fields[name] = val; });

    bb.on("file", (name, stream) => {
      const tmpPath = join(tmpdir(), `rest-upload-${randomUUID()}`);
      tempPaths.push(tmpPath);
      files[name] = tmpPath;
      const ws = createWriteStream(tmpPath);
      const p = new Promise<void>((res, rej) => {
        ws.on("finish", res);
        ws.on("error", rej);
      });
      pending.push(p);
      stream.pipe(ws);
    });

    bb.on("close", () => {
      Promise.all(pending).then(() => resolve({ fields, files, tempPaths })).catch(reject);
    });
    bb.on("error", reject);
    req.pipe(bb);
  });
}

async function handleRestRequest(
  req: IncomingMessage,
  res: ServerResponse,
  registry: OperationRegistry,
  metas: OpMeta[],
  logger: Logger,
): Promise<void> {
  const url = req.url ?? "";
  const pathname = url.split("?")[0];

  // GET /rest — list operations
  if (req.method === "GET" && (pathname === "/rest" || pathname === "/rest/")) {
    sendJson(res, 200, {
      operations: metas.map((m) => ({
        name: m.opName,
        endpoint: `/rest/${m.opName}`,
        description: m.description,
      })),
    });
    return;
  }

  // POST /rest/{operation-name}
  if (req.method === "POST" && pathname.startsWith("/rest/")) {
    const opName = pathname.slice("/rest/".length);
    const meta = metas.find((m) => m.opName === opName);
    if (!meta) {
      sendJson(res, 404, { success: false, error: `Unknown operation: ${opName}` });
      return;
    }
    const op = registry.get(opName)!;
    const contentType = req.headers["content-type"] ?? "";
    const tempFiles: string[] = [];
    const tempDirs: string[] = [];

    try {
      let inputFields: Record<string, string> = {};
      let uploadedFiles: Record<string, string> = {};

      if (contentType.includes("multipart/form-data")) {
        const parsed = await readMultipartBody(req);
        inputFields = parsed.fields;
        uploadedFiles = parsed.files;
        tempFiles.push(...parsed.tempPaths);
      } else {
        // application/json or no content-type — attempt JSON parse
        try {
          const body = await readJsonBody(req);
          for (const [k, v] of Object.entries(body)) {
            if (v != null) inputFields[k] = String(v);
          }
        } catch {
          sendJson(res, 400, { success: false, error: "Could not parse request body as JSON." });
          return;
        }
      }

      const rawParams: Record<string, string> = {};
      for (const p of meta.params) {
        if (p.isOutputDir || p.isOutputFile) continue;

        if (p.isFile) {
          const uploadKey = p.fieldName + "Upload";
          const contentKey = p.fieldName + "Content";
          // Priority: multipart upload > inline content > file path
          if (uploadedFiles[uploadKey] ?? uploadedFiles[p.fieldName]) {
            rawParams[p.paramName] = (uploadedFiles[uploadKey] ?? uploadedFiles[p.fieldName])!;
          } else if (inputFields[contentKey]) {
            const tmpPath = join(tmpdir(), `rest-content-${randomUUID()}`);
            await writeFile(tmpPath, inputFields[contentKey], "utf8");
            tempFiles.push(tmpPath);
            rawParams[p.paramName] = tmpPath;
          } else if (inputFields[p.fieldName]) {
            rawParams[p.paramName] = inputFields[p.fieldName];
          }
        } else if (inputFields[p.fieldName]) {
          rawParams[p.paramName] = inputFields[p.fieldName];
        }
      }

      const result = await runOpWithOutputCollection(op, rawParams, meta, tempFiles, tempDirs);
      sendJson(res, result.success ? 200 : 500, { ...result, file: result.file ?? null });
    } catch (err) {
      sendJson(res, 500, {
        success: false,
        output: "",
        error: err instanceof Error ? err.message : String(err),
        file: null,
      });
    } finally {
      for (const f of tempFiles) unlink(f).catch(() => {});
      for (const d of tempDirs) rm(d, { recursive: true, force: true }).catch(() => {});
    }
    return;
  }

  sendJson(res, 404, { success: false, error: "Not found. Try GET /rest for available operations." });
}

// ──────────────────────────────────────────────────────────────────────────────
// Server entry point
// ──────────────────────────────────────────────────────────────────────────────

/**
 * Build and start the combined GraphQL + REST HTTP server.
 * Returns a shutdown function that closes the server and resolves when done.
 *
 * Routes:
 *   /graphql  → GraphQL endpoint (graphql-yoga)
 *   /rest     → REST API (built-in handler)
 */
export async function startServer(
  registry: OperationRegistry,
  port: number,
  host: string,
  logger: Logger,
): Promise<() => Promise<void>> {
  const metas = buildOpMetas(registry);
  const sdl = buildSdl(metas);
  const resolvers = buildResolvers(registry, metas);

  const yoga = createYoga({
    schema: createSchema({ typeDefs: sdl, resolvers }),
    logging: false,
  });

  const server = createServer((req, res) => {
    const url = req.url ?? "";
    if (url === "/rest" || url.startsWith("/rest/")) {
      void handleRestRequest(req, res, registry, metas, logger);
    } else {
      // graphql-yoga's server instance is itself a Node.js request listener
      (yoga as unknown as (req: IncomingMessage, res: ServerResponse) => void)(req, res);
    }
  });

  await new Promise<void>((resolve, reject) => {
    server.listen(port, host, resolve);
    server.once("error", reject);
  });

  logger.log(`[execute-web-services] GraphQL  → http://${host}:${port}/graphql`);
  logger.log(`[execute-web-services] REST     → http://${host}:${port}/rest`);
  logger.log(`[execute-web-services] ${metas.length} operations available`);

  return () =>
    new Promise<void>((resolve, reject) => {
      server.close((err) => (err ? reject(err) : resolve()));
    });
}
