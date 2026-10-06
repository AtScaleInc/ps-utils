/**
 * bundle-walker
 *
 * Discovers every AtScale project.xml inside one or more support bundles.
 *
 * A support bundle is a directory (or a zip of one) that contains a
 * `metadata/` folder.  Projects live at either:
 *   metadata/<project-id>/project.xml            (container edition)
 *   metadata/<org>/<project-id>/project.xml      (installer edition)
 *
 * Zips are extracted to a temporary directory; call the returned `cleanup`
 * when done.  Many zips wrap the bundle in one top-level folder, so the walker
 * descends a few levels to find `metadata/` rather than requiring it at the root.
 */
import fs from "fs";
import os from "os";
import path from "path";
import JSZip from "jszip";
import { Parser } from "xml2js";

export type BundleProject = {
  /** Path the caller supplied for the bundle (directory or zip). */
  bundlePath:  string;
  /** Filesystem-safe name derived from the bundle's basename. */
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

export type DiscoveryResult = {
  projects: BundleProject[];
  /** Bundles that were given but yielded no metadata folder. */
  emptyBundles: string[];
  /** Removes any temporary extraction directories. Safe to call more than once. */
  cleanup: () => void;
};

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

async function extractZip(zipPath: string, tempRoot: string): Promise<string> {
  const dest = fs.mkdtempSync(path.join(tempRoot, "bundle-"));
  const zip = await JSZip.loadAsync(fs.readFileSync(zipPath));
  const entries = Object.values(zip.files);
  for (const entry of entries) {
    const target = path.join(dest, entry.name);
    // Guard against zip-slip: every entry must stay inside dest.
    if (!path.resolve(target).startsWith(path.resolve(dest) + path.sep)) {
      throw new Error(`Zip entry escapes extraction directory: ${entry.name}`);
    }
    if (entry.dir) {
      fs.mkdirSync(target, { recursive: true });
      continue;
    }
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, await entry.async("nodebuffer"));
  }
  return dest;
}

/** Find the bundle's metadata directory, descending up to `maxDepth` levels. */
export function findMetadataDir(root: string, maxDepth = 3): string | undefined {
  const direct = path.join(root, "metadata");
  if (fs.existsSync(direct) && fs.statSync(direct).isDirectory()) return direct;
  if (maxDepth === 0) return undefined;
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    if (!entry.isDirectory() || entry.name.startsWith(".")) continue;
    const found = findMetadataDir(path.join(root, entry.name), maxDepth - 1);
    if (found) return found;
  }
  return undefined;
}

function findProjectXmls(dir: string, out: string[] = []): string[] {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) findProjectXmls(full, out);
    else if (entry.isFile() && entry.name === "project.xml") out.push(full);
  }
  return out;
}

/** Read the root element's `name` attribute. Tolerates attributes split across lines. */
export async function readProjectName(xmlPath: string): Promise<string> {
  try {
    const parser = new Parser({ explicitArray: false, explicitRoot: false, mergeAttrs: false });
    const parsed = await parser.parseStringPromise(fs.readFileSync(xmlPath, "utf8")) as { $?: { name?: string } };
    const name = parsed?.$?.name;
    return typeof name === "string" && name.trim().length > 0 ? name.trim() : "unnamed";
  } catch {
    return "unnamed";
  }
}

/**
 * Discover projects across all given bundles. Order is deterministic:
 * bundles in the order given, projects sorted by path within each.
 */
export async function discoverBundleProjects(bundlePaths: string[]): Promise<DiscoveryResult> {
  const tempDirs: string[] = [];
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "ps-utils-bundles-"));
  tempDirs.push(tempRoot);
  const cleanup = () => {
    for (const dir of tempDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
  };

  const projects: BundleProject[] = [];
  const emptyBundles: string[] = [];

  try {
    for (const given of bundlePaths) {
      const bundlePath = path.resolve(given);
      if (!fs.existsSync(bundlePath)) {
        throw new Error(`Bundle not found: ${bundlePath}`);
      }
      let root = bundlePath;
      let bundleSlug = slug(path.basename(bundlePath));
      if (fs.statSync(bundlePath).isFile()) {
        if (!bundlePath.toLowerCase().endsWith(".zip")) {
          throw new Error(`Bundle must be a directory or a .zip file: ${bundlePath}`);
        }
        root = await extractZip(bundlePath, tempRoot);
        bundleSlug = slug(path.basename(bundlePath, path.extname(bundlePath)));
      }

      const metadataDir = findMetadataDir(root);
      if (!metadataDir) {
        emptyBundles.push(bundlePath);
        continue;
      }

      const xmls = findProjectXmls(metadataDir).sort();
      for (const xmlPath of xmls) {
        const projectDir = path.dirname(xmlPath);
        const projectId  = path.basename(projectDir);
        const orgDir     = path.dirname(projectDir);
        const org        = path.resolve(orgDir) === path.resolve(metadataDir) ? "default" : path.basename(orgDir);
        projects.push({
          bundlePath,
          bundleSlug,
          org,
          projectId,
          projectName: await readProjectName(xmlPath),
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
