/**
 * Stream/path resolution utilities for the public library API.
 *
 * Each exported function in src/index.ts accepts either a file-system path or a
 * Node.js stream for every I/O parameter.  resolveIO() normalises stream values
 * into temporary file/directory paths before the underlying CLI operation runs,
 * then flush() ships the results back to any caller-supplied output streams.
 */

import { Readable, Writable } from "node:stream";
import { pipeline }           from "node:stream/promises";
import {
  createWriteStream,
  createReadStream,
  mkdirSync,
  writeFileSync,
  readdirSync,
  statSync,
  rmSync,
} from "node:fs";
import { mkdtemp }     from "node:fs/promises";
import { tmpdir }      from "node:os";
import { join, dirname, relative } from "node:path";
import JSZip           from "jszip";

// ── Public type aliases ───────────────────────────────────────────────────────

/** An input file: either a file-system path or a Readable stream of the file's contents. */
export type FileInput = string | Readable;

/** An input directory: either a file-system path or a Readable stream of a ZIP archive. */
export type DirInput  = string | Readable;

/** An output file: either a file-system path or a Writable that receives the file's contents. */
export type FileOutput = string | Writable;

/**
 * An output directory: either a file-system path or a Writable that receives
 * a ZIP archive of the directory's contents.
 */
export type DirOutput = string | Writable;

// ── IOSpec ────────────────────────────────────────────────────────────────────

export type IOSpec = {
  /** Parameter keys whose values are input file paths / Readables. */
  inputFiles?:    string[];
  /** Parameter keys whose values are input directory paths / zip Readables. */
  inputDirs?:     string[];
  /**
   * Parameter keys that hold a comma-separated list of directory paths.
   * When a Readable (zip) is supplied, top-level zip folders become the list.
   */
  inputDirLists?: string[];
  /** Parameter keys whose values are output file paths / Writables. */
  outputFiles?:   string[];
  /** Parameter keys whose values are output directory paths / zip Writables. */
  outputDirs?:    string[];
};

// ── Helpers ───────────────────────────────────────────────────────────────────

async function toBuffer(stream: Readable): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of stream) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return Buffer.concat(chunks);
}

async function unzipTo(stream: Readable, dir: string): Promise<void> {
  const zip = await JSZip.loadAsync(await toBuffer(stream));
  for (const [filename, file] of Object.entries(zip.files)) {
    const dest = join(dir, filename);
    if (file.dir) {
      mkdirSync(dest, { recursive: true });
    } else {
      mkdirSync(dirname(dest), { recursive: true });
      writeFileSync(dest, await file.async("nodebuffer"));
    }
  }
}

async function zipTo(dir: string, stream: Writable): Promise<void> {
  const zip = new JSZip();
  const addDir = (absDir: string) => {
    for (const entry of readdirSync(absDir)) {
      const absPath = join(absDir, entry);
      if (statSync(absPath).isDirectory()) {
        addDir(absPath);
      } else {
        zip.file(relative(dir, absPath), createReadStream(absPath));
      }
    }
  };
  addDir(dir);
  const buf = await zip.generateAsync({ type: "nodebuffer" });
  await pipeline(Readable.from(buf), stream);
}

// ── resolveIO ─────────────────────────────────────────────────────────────────

export type IOResolution = {
  params:  Record<string, unknown>;
  /** Pipe operation outputs to any caller-supplied Writables. Call after run(). */
  flush:   () => Promise<void>;
  /** Delete all temporary files and directories. Call in a finally block. */
  cleanup: () => void;
};

/**
 * Normalise stream values in `params` to temporary file-system paths.
 *
 * - `Readable` input fields  → temp file or extracted zip dir
 * - `Writable` output fields → temp file or dir; flush() ships results back
 *
 * Always call cleanup() in a finally block regardless of success or failure.
 */
export async function resolveIO(
  params:  Record<string, unknown>,
  spec:    IOSpec,
): Promise<IOResolution> {
  const tmpPaths: string[] = [];
  const flushers: Array<() => Promise<void>> = [];
  const out = { ...params };

  // ── Input files ─────────────────────────────────────────────────────────────
  for (const key of spec.inputFiles ?? []) {
    const v = out[key];
    if (v instanceof Readable) {
      const tmp = join(tmpdir(), `atscale-in-${key}-${Date.now()}`);
      await pipeline(v, createWriteStream(tmp));
      tmpPaths.push(tmp);
      out[key] = tmp;
    }
  }

  // ── Input directories (zip → extracted dir) ──────────────────────────────
  for (const key of spec.inputDirs ?? []) {
    const v = out[key];
    if (v instanceof Readable) {
      const tmp = await mkdtemp(join(tmpdir(), "atscale-in-"));
      tmpPaths.push(tmp);
      await unzipTo(v, tmp);
      out[key] = tmp;
    }
  }

  // ── Input directory lists (zip → comma-separated top-level dirs) ─────────
  for (const key of spec.inputDirLists ?? []) {
    const v = out[key];
    if (v instanceof Readable) {
      const tmp = await mkdtemp(join(tmpdir(), "atscale-in-"));
      tmpPaths.push(tmp);
      await unzipTo(v, tmp);
      const subdirs = readdirSync(tmp)
        .map(e => join(tmp, e))
        .filter(p => statSync(p).isDirectory());
      out[key] = subdirs.join(",");
    }
  }

  // ── Output files ─────────────────────────────────────────────────────────
  for (const key of spec.outputFiles ?? []) {
    const v = out[key];
    if (v instanceof Writable) {
      const tmp = join(tmpdir(), `atscale-out-${key}-${Date.now()}`);
      tmpPaths.push(tmp);
      out[key] = tmp;
      const w = v;
      flushers.push(() => pipeline(createReadStream(tmp), w));
    }
  }

  // ── Output directories (dir → zip → Writable) ────────────────────────────
  for (const key of spec.outputDirs ?? []) {
    const v = out[key];
    if (v instanceof Writable) {
      const tmp = await mkdtemp(join(tmpdir(), "atscale-out-"));
      tmpPaths.push(tmp);
      out[key] = tmp;
      const w = v;
      flushers.push(() => zipTo(tmp, w));
    }
  }

  return {
    params:  out,
    flush:   async () => { for (const fn of flushers) await fn(); },
    cleanup: () => {
      for (const p of tmpPaths) {
        try { rmSync(p, { recursive: true, force: true }); } catch { /* best effort */ }
      }
    },
  };
}
