/**
 * bundle-walker
 *
 * Discovers every AtScale project.xml inside one or more support bundles.
 *
 * Two bundle shapes exist in the field:
 *
 *   1. The engine's own "Download support bundle" archive: a zip whose top
 *      level is MANIFEST.txt plus one zip per area (logs.zip, aggregates.zip,
 *      metadata.zip, ...).  Projects live inside `metadata.zip` at
 *      `metadata/<project-id>/project.xml`.
 *   2. An already-unpacked tree with a `metadata/` directory, either
 *      `metadata/<project-id>/project.xml` (container edition) or
 *      `metadata/<org>/<project-id>/project.xml` (installer edition).  This is
 *      also what you get after someone hand-extracts metadata.zip, and zips of
 *      such trees often wrap everything in one top-level folder.
 *
 * Only the entries that can hold a project are extracted (metadata.zip and
 * `metadata/**` paths); the log archives, which dominate a real bundle, are
 * never read.  `__MACOSX` resource-fork trees and dot-directories are skipped.
 * Call the returned `cleanup` to remove temporary extraction directories.
 */
import fs from "fs";
import os from "os";
import path from "path";
import { unzipTo } from "../../lib/streams.js";

export type BundleProject = {
  /** Path the caller supplied for the bundle (directory or zip). */
  bundlePath:  string;
  /** Filesystem-safe name for the bundle, unique within one discovery run. */
  bundleSlug:  string;
  /** Organisation folder name, or "default" when the bundle has no org level. */
  org:         string;
  /** The project directory name (the engine's project id). */
  projectId:   string;
  /** The `name` attribute of the XML root element, or "unnamed". */
  projectName: string;
  /** Absolute path to project.xml. */
  xmlPath:     string;
};

export type EmptyBundle = { bundlePath: string; bundleSlug: string };

export type DiscoveryResult = {
  projects: BundleProject[];
  /** Bundles that were given but held neither a metadata/ directory nor a metadata.zip. */
  emptyBundles: EmptyBundle[];
  /** Removes any temporary extraction directories. Safe to call more than once. */
  cleanup: () => void;
};

const SKIP_DIRS = new Set(["__MACOSX", "node_modules"]);

/** Make a string safe for use as a directory name. */
export function slug(value: string): string {
  return value
    .replace(/[^A-Za-z0-9._-]+/g, "_")
    .replace(/_{2,}/g, "_")
    .replace(/^_+|_+$/g, "") || "unnamed";
}

/** Split a comma-separated CLI value into trimmed, non-empty entries. */
export function splitList(value: string | undefined): string[] {
  return (value ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

function isSkippable(name: string): boolean {
  return SKIP_DIRS.has(name) || name.startsWith(".");
}

/** Zip entries worth extracting: metadata.zip itself, or anything under a metadata/ folder. */
export function isMetadataEntry(entryName: string): boolean {
  const parts = entryName.split("/").filter(Boolean);
  if (parts.some(isSkippable)) return false;
  if (parts[parts.length - 1] === "metadata.zip") return true;
  const idx = parts.indexOf("metadata");
  return idx >= 0 && idx < parts.length - 1;
}

type MetadataSource =
  | { kind: "dir"; path: string }
  | { kind: "zip"; path: string };

/**
 * Find the bundle's metadata: a `metadata/` directory or a `metadata.zip`,
 * at the root or up to `maxDepth` wrapper folders down.  A directory wins
 * over a zip at the same level.
 */
export function findMetadataSource(root: string, maxDepth = 3): MetadataSource | undefined {
  const dir = path.join(root, "metadata");
  if (fs.existsSync(dir) && fs.statSync(dir).isDirectory()) return { kind: "dir", path: dir };
  const zip = path.join(root, "metadata.zip");
  if (fs.existsSync(zip) && fs.statSync(zip).isFile()) return { kind: "zip", path: zip };
  if (maxDepth === 0) return undefined;
  const children = fs.readdirSync(root, { withFileTypes: true })
    .filter((e) => e.isDirectory() && !isSkippable(e.name))
    .map((e) => e.name)
    .sort();
  for (const name of children) {
    const found = findMetadataSource(path.join(root, name), maxDepth - 1);
    if (found) return found;
  }
  return undefined;
}

function findProjectXmls(dir: string, out: string[] = []): string[] {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (isSkippable(entry.name)) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) findProjectXmls(full, out);
    else if (entry.isFile() && entry.name === "project.xml") out.push(full);
  }
  return out;
}

/**
 * Read the root element's `name` attribute without parsing the whole document.
 * Only the first 64 KiB are scanned; root attributes may span several lines.
 */
export function readProjectName(xmlPath: string): string {
  let fd: number | undefined;
  try {
    fd = fs.openSync(xmlPath, "r");
    const buffer = Buffer.alloc(64 * 1024);
    const bytes = fs.readSync(fd, buffer, 0, buffer.length, 0);
    const head = buffer.subarray(0, bytes).toString("utf8");
    // First element that is not the XML declaration or a comment/processing instruction.
    const root = /<(?!\?|!)([A-Za-z_][\w.-]*:)?[A-Za-z_][\w.-]*\b([^>]*)>/s.exec(head);
    if (!root) return "unnamed";
    const attr = /(?:^|\s)name\s*=\s*"([^"]*)"/s.exec(root[2]);
    const name = attr?.[1]?.trim();
    return name && name.length > 0 ? name : "unnamed";
  } catch {
    return "unnamed";
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
  }
}

/** Assign a slug that no earlier bundle in this run has taken. */
function uniqueSlug(base: string, taken: Set<string>): string {
  let candidate = base;
  for (let n = 2; taken.has(candidate); n++) candidate = `${base}-${n}`;
  taken.add(candidate);
  return candidate;
}

/**
 * Discover projects across all given bundles. Order is deterministic:
 * bundles in the order given, projects sorted by path within each.
 */
export async function discoverBundleProjects(bundlePaths: string[]): Promise<DiscoveryResult> {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "ps-utils-bundles-"));
  let cleaned = false;
  const cleanup = () => {
    if (cleaned) return;
    cleaned = true;
    fs.rmSync(tempRoot, { recursive: true, force: true });
  };

  const projects: BundleProject[] = [];
  const emptyBundles: EmptyBundle[] = [];
  const takenSlugs = new Set<string>();
  let extractCount = 0;
  const nextTemp = () => {
    const dir = path.join(tempRoot, String(++extractCount));
    fs.mkdirSync(dir, { recursive: true });
    return dir;
  };

  try {
    for (const given of bundlePaths) {
      const bundlePath = path.resolve(given);
      if (!fs.existsSync(bundlePath)) {
        throw new Error(`Bundle not found: ${bundlePath}`);
      }

      let root = bundlePath;
      let baseName = path.basename(bundlePath);
      if (fs.statSync(bundlePath).isFile()) {
        if (!bundlePath.toLowerCase().endsWith(".zip")) {
          throw new Error(`Bundle must be a directory or a .zip file: ${bundlePath}`);
        }
        root = nextTemp();
        await unzipTo(fs.readFileSync(bundlePath), root, isMetadataEntry);
        baseName = path.basename(bundlePath, path.extname(bundlePath));
      }
      const bundleSlug = uniqueSlug(slug(baseName), takenSlugs);

      let source = findMetadataSource(root);
      if (source?.kind === "zip") {
        const inner = nextTemp();
        await unzipTo(fs.readFileSync(source.path), inner, isMetadataEntry);
        source = findMetadataSource(inner);
      }
      if (!source || source.kind !== "dir") {
        emptyBundles.push({ bundlePath, bundleSlug });
        continue;
      }
      const metadataDir = source.path;

      for (const xmlPath of findProjectXmls(metadataDir).sort()) {
        const projectDir = path.dirname(xmlPath);
        const projectId  = path.basename(projectDir);
        const orgDir     = path.dirname(projectDir);
        const org        = path.resolve(orgDir) === path.resolve(metadataDir) ? "default" : path.basename(orgDir);
        projects.push({
          bundlePath,
          bundleSlug,
          org,
          projectId,
          projectName: readProjectName(xmlPath),
          xmlPath,
        });
      }
    }
  } catch (error) {
    cleanup();
    throw error;
  }

  return { projects, emptyBundles, cleanup };
}
