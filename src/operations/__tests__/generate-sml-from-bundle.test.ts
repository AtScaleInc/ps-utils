import fs from "fs";
import os from "os";
import path from "path";
import { fileURLToPath } from "url";
import JSZip from "jszip";
import { afterEach, describe, expect, it, vi } from "vitest";
import { runCli } from "../../cli-runner.js";
import {
  discoverBundleProjects,
  findMetadataDir,
  readProjectName,
  slug,
} from "../generate-sml-from-bundle/bundle-walker.js";

const fixtureXml = fileURLToPath(
  new URL("./fixtures/duplicate-measure-column-resolution.xml", import.meta.url),
);

const temporaryDirectories: string[] = [];

function tempDir(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  temporaryDirectories.push(dir);
  return dir;
}

/** Build an installer-layout bundle: metadata/<org>/<id>/project.xml. */
function installerBundle(root: string, projects: Array<{ org: string; id: string; xml?: string }>): string {
  for (const p of projects) {
    const dir = path.join(root, "metadata", p.org, p.id);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, "project.xml"), p.xml ?? fs.readFileSync(fixtureXml, "utf8"));
  }
  return root;
}

/** Build a container-layout bundle: metadata/<id>/project.xml. */
function containerBundle(root: string, ids: string[]): string {
  for (const id of ids) {
    const dir = path.join(root, "metadata", id);
    fs.mkdirSync(dir, { recursive: true });
    fs.copyFileSync(fixtureXml, path.join(dir, "project.xml"));
  }
  return root;
}

async function zipWithWrapperFolder(sourceRoot: string, zipPath: string, wrapper: string): Promise<void> {
  const zip = new JSZip();
  const walk = (dir: string) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else zip.file(path.posix.join(wrapper, path.relative(sourceRoot, full).split(path.sep).join("/")), fs.readFileSync(full));
    }
  };
  walk(sourceRoot);
  fs.writeFileSync(zipPath, await zip.generateAsync({ type: "nodebuffer" }));
}

function readSummaryRows(outputDir: string): string[][] {
  const [, ...rows] = fs.readFileSync(path.join(outputDir, "summary.csv"), "utf8").trim().split("\n");
  return rows.map((r) => r.split(","));
}

afterEach(() => {
  vi.restoreAllMocks();
  for (const dir of temporaryDirectories.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe("bundle-walker", () => {
  it("slugs names safely", () => {
    expect(slug("EDW_RETAIL (2)")).toBe("EDW_RETAIL_2");
    expect(slug("Salesforce Leads")).toBe("Salesforce_Leads");
    expect(slug("///")).toBe("unnamed");
  });

  it("reads the root name attribute even when attributes span lines", async () => {
    const dir = tempDir("ps-utils-bundle-name-");
    const xml = path.join(dir, "project.xml");
    fs.writeFileSync(xml, `<?xml version="1.0"?>\n<schema xmlns="http://www.atscale.com/xsd/project_2_0"\n        version="2"\n        name="Multi Line Name">\n</schema>\n`);
    expect(await readProjectName(xml)).toBe("Multi Line Name");
    fs.writeFileSync(xml, "not xml at all");
    expect(await readProjectName(xml)).toBe("unnamed");
  });

  it("finds metadata/ at the root or one wrapper folder down", () => {
    const root = tempDir("ps-utils-bundle-find-");
    expect(findMetadataDir(root)).toBeUndefined();
    const wrapped = path.join(root, "customer-bundle-2026-10-05", "metadata");
    fs.mkdirSync(wrapped, { recursive: true });
    expect(findMetadataDir(root)).toBe(wrapped);
  });

  it("discovers projects in installer and container layouts and in zips", async () => {
    const installer = installerBundle(tempDir("ps-utils-bundle-inst-"), [
      { org: "default", id: "11111111-aaaa" },
      { org: "orgB",    id: "22222222-bbbb" },
    ]);
    const container = containerBundle(tempDir("ps-utils-bundle-cont-"), ["33333333-cccc"]);
    const zipPath   = path.join(tempDir("ps-utils-bundle-zip-"), "wrapped-bundle.zip");
    await zipWithWrapperFolder(container, zipPath, "customer bundle-2026-10-05T1512");

    const result = await discoverBundleProjects([installer, zipPath]);
    try {
      const summary = result.projects.map((p) => `${p.bundleSlug}|${p.org}|${p.projectId}|${p.projectName}`);
      expect(summary).toEqual([
        `${path.basename(installer)}|default|11111111-aaaa|Duplicate Measure Regression`,
        `${path.basename(installer)}|orgB|22222222-bbbb|Duplicate Measure Regression`,
        `wrapped-bundle|default|33333333-cccc|Duplicate Measure Regression`,
      ]);
      expect(result.emptyBundles).toEqual([]);
    } finally {
      result.cleanup();
    }
  });

  it("rejects a zip entry that escapes the extraction directory", async () => {
    const zipPath = path.join(tempDir("ps-utils-bundle-slip-"), "evil.zip");
    const zip = new JSZip();
    zip.file("../escape.txt", "x");
    fs.writeFileSync(zipPath, await zip.generateAsync({ type: "nodebuffer" }));
    await expect(discoverBundleProjects([zipPath])).rejects.toThrow(/escapes extraction directory/);
  });
});

describe("generate-sml-from-bundle", () => {
  it("converts every project, writes a summary, and skips on re-run unless forced", async () => {
    const bundle = installerBundle(tempDir("ps-utils-bundle-run-"), [
      { org: "default", id: "11111111-aaaa-bbbb-cccc-000000000001" },
      { org: "orgB",    id: "22222222-aaaa-bbbb-cccc-000000000002" },
    ]);
    const out = tempDir("ps-utils-bundle-out-");
    vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});

    const first = await runCli(["generate-sml-from-bundle", "--bundles", bundle, "--output-dir", out]);
    expect(first).toBe(0);

    const slugBundle = path.basename(bundle);
    const projDir = path.join(out, slugBundle, "default", "Duplicate_Measure_Regression__11111111");
    expect(fs.existsSync(path.join(projDir, "catalog.yml"))).toBe(true);
    expect(fs.existsSync(path.join(projDir, "models"))).toBe(true);
    expect(fs.existsSync(path.join(out, slugBundle, "orgB", "Duplicate_Measure_Regression__22222222", "catalog.yml"))).toBe(true);
    // Nothing but SML inside a project directory; no logs on success.
    expect(fs.existsSync(path.join(out, ".logs"))).toBe(false);

    let rows = readSummaryRows(out);
    expect(rows.map((r) => r[4])).toEqual(["ok", "ok"]);
    expect(fs.readFileSync(path.join(out, "summary.md"), "utf8")).toContain("2 project(s), 0 failed.");

    const second = await runCli(["generate-sml-from-bundle", "--bundles", bundle, "--output-dir", out]);
    expect(second).toBe(0);
    rows = readSummaryRows(out);
    expect(rows.map((r) => r[4])).toEqual(["skipped", "skipped"]);
    expect(rows[0][5]).toBe("1"); // dataset count recovered from the existing directory

    const third = await runCli(["generate-sml-from-bundle", "--bundles", bundle, "--output-dir", out, "--force"]);
    expect(third).toBe(0);
    expect(readSummaryRows(out).map((r) => r[4])).toEqual(["ok", "ok"]);
  });

  it("filters by org", async () => {
    const bundle = installerBundle(tempDir("ps-utils-bundle-org-"), [
      { org: "default", id: "11111111-0000" },
      { org: "orgB",    id: "22222222-0000" },
    ]);
    const out = tempDir("ps-utils-bundle-out-");
    vi.spyOn(console, "log").mockImplementation(() => {});

    expect(await runCli(["generate-sml-from-bundle", "--bundles", bundle, "--output-dir", out, "--org", "orgB"])).toBe(0);
    const rows = readSummaryRows(out);
    expect(rows).toHaveLength(1);
    expect(rows[0][1]).toBe("orgB");
    expect(fs.existsSync(path.join(out, path.basename(bundle), "default"))).toBe(false);
  });

  it("keeps going after a bad project, keeps its log, writes the summary, and exits non-zero", async () => {
    const bundle = installerBundle(tempDir("ps-utils-bundle-fail-"), [
      { org: "default", id: "11111111-good" },
      { org: "default", id: "22222222-bad", xml: "<schema name=\"Broken\"><cubes><cube" },
    ]);
    const out = tempDir("ps-utils-bundle-out-");
    const errors: string[] = [];
    vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation((m) => errors.push(String(m)));

    const exitCode = await runCli(["generate-sml-from-bundle", "--bundles", bundle, "--output-dir", out]);
    expect(exitCode).toBe(1);

    const rows = readSummaryRows(out);
    expect(rows.map((r) => r[4])).toEqual(["ok", "FAILED"]);
    const logRel = rows[1][11];
    expect(logRel.startsWith(".logs/")).toBe(true);
    expect(fs.readFileSync(path.join(out, logRel), "utf8")).toContain("ERROR:");
    // The failed project leaves no half-written SML directory behind.
    expect(fs.existsSync(path.join(out, path.basename(bundle), "default", "unnamed__22222222"))).toBe(false);
    expect(errors.join("\n")).toMatch(/1 project\(s\) failed to convert: .*unnamed/);
  });

  it("fails clearly when a bundle has no metadata folder", async () => {
    const notABundle = tempDir("ps-utils-bundle-empty-");
    const out = tempDir("ps-utils-bundle-out-");
    const errors: string[] = [];
    vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation((m) => errors.push(String(m)));

    expect(await runCli(["generate-sml-from-bundle", "--bundles", notABundle, "--output-dir", out])).toBe(1);
    expect(errors.join("\n")).toMatch(/No metadata\/ folder found/);
  });
});
