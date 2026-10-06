import fs from "fs";
import os from "os";
import path from "path";
import { fileURLToPath } from "url";
import JSZip from "jszip";
import { afterEach, describe, expect, it, vi } from "vitest";
import { runCli } from "../../cli-runner.js";
import { unzipTo } from "../../lib/streams.js";
import {
  discoverBundleProjects,
  findMetadataSource,
  isMetadataEntry,
  readProjectName,
  slug,
} from "../generate-sml-from-bundle/bundle-walker.js";

const fixtureXml = fileURLToPath(
  new URL("./fixtures/duplicate-measure-column-resolution.xml", import.meta.url),
);
const fixtureText = () => fs.readFileSync(fixtureXml, "utf8");

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
    fs.writeFileSync(path.join(dir, "project.xml"), p.xml ?? fixtureText());
  }
  return root;
}

/** Zip a directory tree, optionally under a wrapper folder, with extra raw entries. */
async function zipDir(sourceRoot: string, zipPath: string, wrapper = "", extra: Record<string, Buffer | string> = {}): Promise<void> {
  const zip = new JSZip();
  const walk = (dir: string) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else {
        const rel = path.relative(sourceRoot, full).split(path.sep).join("/");
        zip.file(wrapper ? `${wrapper}/${rel}` : rel, fs.readFileSync(full));
      }
    }
  };
  walk(sourceRoot);
  for (const [name, content] of Object.entries(extra)) zip.file(name, content);
  fs.writeFileSync(zipPath, await zip.generateAsync({ type: "nodebuffer" }));
}

/**
 * Build the engine's native support-bundle archive: MANIFEST.txt plus one zip
 * per area, with projects inside metadata.zip at metadata/<id>/project.xml.
 */
async function nativeBundleZip(zipPath: string, ids: string[]): Promise<void> {
  const inner = new JSZip();
  for (const id of ids) {
    inner.file(`metadata/${id}/project.xml`, fixtureText());
    inner.file(`metadata/${id}/yaml_files.zip`, Buffer.from("not a real zip"));
  }
  const metadataZip = await inner.generateAsync({ type: "nodebuffer" });
  const outer = new JSZip();
  outer.file("MANIFEST.txt", "engine support bundle");
  outer.file("logs.zip", Buffer.alloc(256 * 1024, 1));      // filler that must never be extracted
  outer.file("aggregates.zip", Buffer.alloc(1024, 2));
  outer.file("metadata.zip", metadataZip);
  fs.writeFileSync(zipPath, await outer.generateAsync({ type: "nodebuffer" }));
}

function readSummaryRows(outputDir: string): string[][] {
  const [, ...rows] = fs.readFileSync(path.join(outputDir, "summary.csv"), "utf8").trim().split("\n");
  return rows.map((r) => r.split(","));
}

function quiet(): string[] {
  const errors: string[] = [];
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation((m) => errors.push(String(m)));
  return errors;
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

  it("reads the root name attribute without a full parse, even when attributes span lines", () => {
    const dir = tempDir("ps-utils-bundle-name-");
    const xml = path.join(dir, "project.xml");
    fs.writeFileSync(xml, `<?xml version="1.0"?>\n<!-- exported -->\n<schema xmlns="http://www.atscale.com/xsd/project_2_0"\n        version="2"\n        name="Multi Line Name">\n</schema>\n`);
    expect(readProjectName(xml)).toBe("Multi Line Name");
    fs.writeFileSync(xml, "not xml at all");
    expect(readProjectName(xml)).toBe("unnamed");
    fs.writeFileSync(xml, `<schema><cube name="Inner"/></schema>`);
    expect(readProjectName(xml)).toBe("unnamed"); // only the root element's own attributes count
  });

  it("selects only metadata entries from a zip", () => {
    expect(isMetadataEntry("metadata.zip")).toBe(true);
    expect(isMetadataEntry("wrapper/metadata.zip")).toBe(true);
    expect(isMetadataEntry("metadata/abc/project.xml")).toBe(true);
    expect(isMetadataEntry("wrapper/metadata/org/abc/project.xml")).toBe(true);
    expect(isMetadataEntry("logs.zip")).toBe(false);
    expect(isMetadataEntry("wrapper/logs/engine.log")).toBe(false);
    expect(isMetadataEntry("__MACOSX/wrapper/metadata/abc/._project.xml")).toBe(false);
    expect(isMetadataEntry("metadata/")).toBe(false);
  });

  it("finds metadata/ or metadata.zip at the root or below, skipping __MACOSX", () => {
    const root = tempDir("ps-utils-bundle-find-");
    expect(findMetadataSource(root)).toBeUndefined();
    fs.mkdirSync(path.join(root, "__MACOSX", "wrapper", "metadata", "x"), { recursive: true });
    expect(findMetadataSource(root)).toBeUndefined();
    const real = path.join(root, "wrapper", "metadata");
    fs.mkdirSync(real, { recursive: true });
    expect(findMetadataSource(root)).toEqual({ kind: "dir", path: real });
    const zipRoot = tempDir("ps-utils-bundle-findzip-");
    fs.writeFileSync(path.join(zipRoot, "metadata.zip"), "x");
    expect(findMetadataSource(zipRoot)).toEqual({ kind: "zip", path: path.join(zipRoot, "metadata.zip") });
  });

  it("discovers projects in installer dirs, wrapped zips, and the engine's native bundle", async () => {
    const installer = installerBundle(tempDir("ps-utils-bundle-inst-"), [
      { org: "default", id: "11111111-aaaa" },
      { org: "orgB",    id: "22222222-bbbb" },
    ]);
    const containerTree = tempDir("ps-utils-bundle-cont-");
    fs.mkdirSync(path.join(containerTree, "metadata", "33333333-cccc"), { recursive: true });
    fs.copyFileSync(fixtureXml, path.join(containerTree, "metadata", "33333333-cccc", "project.xml"));
    const wrappedZip = path.join(tempDir("ps-utils-bundle-zip-"), "wrapped-bundle.zip");
    await zipDir(containerTree, wrappedZip, "customer bundle-2026-10-05T1512", {
      "__MACOSX/customer bundle-2026-10-05T1512/metadata/33333333-cccc/._project.xml": Buffer.from("rf"),
    });
    const nativeZip = path.join(tempDir("ps-utils-bundle-native-"), "support-bundle-2026-06-12.zip");
    await nativeBundleZip(nativeZip, ["44444444-dddd", "55555555-eeee"]);

    const result = await discoverBundleProjects([installer, wrappedZip, nativeZip]);
    try {
      expect(result.projects.map((p) => `${p.bundleSlug}|${p.org}|${p.projectId}|${p.projectName}`)).toEqual([
        `${path.basename(installer)}|default|11111111-aaaa|Duplicate Measure Regression`,
        `${path.basename(installer)}|orgB|22222222-bbbb|Duplicate Measure Regression`,
        `wrapped-bundle|default|33333333-cccc|Duplicate Measure Regression`,
        `support-bundle-2026-06-12|default|44444444-dddd|Duplicate Measure Regression`,
        `support-bundle-2026-06-12|default|55555555-eeee|Duplicate Measure Regression`,
      ]);
      expect(result.emptyBundles).toEqual([]);
      // Nothing but metadata was extracted from the native bundle: the outer
      // extraction dir holds metadata.zip and nothing else.
      const nativeXml = result.projects[3].xmlPath;
      const tempRoot = nativeXml.slice(0, nativeXml.indexOf(`${path.sep}metadata${path.sep}`));
      const outerDir = path.join(path.dirname(tempRoot), String(Number(path.basename(tempRoot)) - 1));
      expect(fs.readdirSync(outerDir)).toEqual(["metadata.zip"]);
    } finally {
      result.cleanup();
    }
  });

  it("accepts an unpacked native bundle directory that still holds metadata.zip", async () => {
    const dir = tempDir("ps-utils-bundle-unpacked-");
    await nativeBundleZip(path.join(dir, "whole.zip"), ["66666666-ffff"]);
    // Simulate `unzip` of the outer archive: metadata.zip sits beside MANIFEST.txt.
    const outer = await JSZip.loadAsync(fs.readFileSync(path.join(dir, "whole.zip")));
    fs.writeFileSync(path.join(dir, "metadata.zip"), await outer.file("metadata.zip")!.async("nodebuffer"));
    fs.writeFileSync(path.join(dir, "MANIFEST.txt"), "x");
    fs.rmSync(path.join(dir, "whole.zip"));

    const result = await discoverBundleProjects([dir]);
    try {
      expect(result.projects.map((p) => p.projectId)).toEqual(["66666666-ffff"]);
    } finally {
      result.cleanup();
    }
  });

  it("keeps bundles with the same basename apart", async () => {
    const a = installerBundle(path.join(tempDir("ps-utils-bundle-a-"), "support-bundle"), [{ org: "default", id: "same-id" }]);
    const b = installerBundle(path.join(tempDir("ps-utils-bundle-b-"), "support-bundle"), [{ org: "default", id: "same-id" }]);
    const result = await discoverBundleProjects([a, b]);
    try {
      expect(result.projects.map((p) => p.bundleSlug)).toEqual(["support-bundle", "support-bundle-2"]);
    } finally {
      result.cleanup();
    }
  });

  it("never extracts a zip entry that escapes the extraction directory", async () => {
    const zip = new JSZip();
    zip.file("../escape.txt", "x");
    const archive = await zip.generateAsync({ type: "nodebuffer" });
    const target = path.join(tempDir("ps-utils-bundle-slip-"), "extract");
    // The shared helper refuses outright ...
    await expect(unzipTo(archive, target)).rejects.toThrow(/escapes extraction directory/);
    expect(fs.existsSync(path.join(path.dirname(target), "escape.txt"))).toBe(false);
    // ... and the bundle filter never selects such an entry in the first place.
    expect(isMetadataEntry("../metadata/x/project.xml")).toBe(false);
    expect(isMetadataEntry("metadata/../../x/project.xml")).toBe(false);
  });
});

describe("generate-sml-from-bundle", () => {
  it("converts every project, writes a summary, and skips on re-run unless forced", async () => {
    const bundle = installerBundle(tempDir("ps-utils-bundle-run-"), [
      { org: "default", id: "11111111-aaaa-bbbb-cccc-000000000001" },
      { org: "orgB",    id: "22222222-aaaa-bbbb-cccc-000000000002" },
    ]);
    const out = tempDir("ps-utils-bundle-out-");
    quiet();

    expect(await runCli(["generate-sml-from-bundle", "--bundles", bundle, "--output-dir", out])).toBe(0);

    const slugBundle = path.basename(bundle);
    const projDir = path.join(out, slugBundle, "default", "Duplicate_Measure_Regression__11111111");
    expect(fs.existsSync(path.join(projDir, "catalog.yml"))).toBe(true);
    expect(fs.existsSync(path.join(projDir, "models"))).toBe(true);
    expect(fs.existsSync(path.join(out, slugBundle, "orgB", "Duplicate_Measure_Regression__22222222", "catalog.yml"))).toBe(true);
    expect(fs.existsSync(`${projDir}.converting`)).toBe(false);   // staging dir swapped away
    expect(fs.existsSync(path.join(out, ".logs"))).toBe(false);   // no logs on success

    let rows = readSummaryRows(out);
    expect(rows.map((r) => r[4])).toEqual(["ok", "ok"]);
    expect(fs.readFileSync(path.join(out, "summary.md"), "utf8")).toContain("2 row(s), 0 failed.");

    expect(await runCli(["generate-sml-from-bundle", "--bundles", bundle, "--output-dir", out])).toBe(0);
    rows = readSummaryRows(out);
    expect(rows.map((r) => r[4])).toEqual(["skipped", "skipped"]);
    expect(rows[0][5]).toBe("1"); // dataset count recovered from the existing directory

    expect(await runCli(["generate-sml-from-bundle", "--bundles", bundle, "--output-dir", out, "--force"])).toBe(0);
    expect(readSummaryRows(out).map((r) => r[4])).toEqual(["ok", "ok"]);
  });

  it("converts the engine's native support-bundle zip end to end", async () => {
    const nativeZip = path.join(tempDir("ps-utils-bundle-native-"), "support-bundle-x.zip");
    await nativeBundleZip(nativeZip, ["77777777-0000-0000-0000-000000000000"]);
    const out = tempDir("ps-utils-bundle-out-");
    quiet();
    expect(await runCli(["generate-sml-from-bundle", "--bundles", nativeZip, "--output-dir", out])).toBe(0);
    expect(fs.existsSync(path.join(out, "support-bundle-x", "default", "Duplicate_Measure_Regression__77777777", "catalog.yml"))).toBe(true);
  });

  it("filters by org and merges the summary with rows already on disk", async () => {
    const bundle = installerBundle(tempDir("ps-utils-bundle-org-"), [
      { org: "default", id: "11111111-0000" },
      { org: "orgB",    id: "22222222-0000" },
    ]);
    const out = tempDir("ps-utils-bundle-out-");
    quiet();

    expect(await runCli(["generate-sml-from-bundle", "--bundles", bundle, "--output-dir", out])).toBe(0);
    expect(readSummaryRows(out)).toHaveLength(2);

    expect(await runCli(["generate-sml-from-bundle", "--bundles", bundle, "--output-dir", out, "--org", "orgB", "--force"])).toBe(0);
    const rows = readSummaryRows(out);
    expect(rows).toHaveLength(2);                       // the default-org row survived the filtered run
    expect(rows.map((r) => `${r[1]}:${r[4]}`)).toEqual(["default:ok", "orgB:ok"]);
    expect(fs.existsSync(path.join(out, path.basename(bundle), "default"))).toBe(true);
  });

  it("isolates a bad project, keeps its log, lists it in the summary, and exits non-zero", async () => {
    const bundle = installerBundle(tempDir("ps-utils-bundle-fail-"), [
      { org: "default", id: "11111111-good" },
      { org: "default", id: "22222222-bad", xml: "<schema name=\"Broken\"><cubes><cube" },
    ]);
    const out = tempDir("ps-utils-bundle-out-");
    const errors = quiet();

    expect(await runCli(["generate-sml-from-bundle", "--bundles", bundle, "--output-dir", out])).toBe(1);

    const rows = readSummaryRows(out);
    expect(rows.map((r) => r[4]).sort()).toEqual(["FAILED", "ok"]);
    const failedRow = rows.find((r) => r[4] === "FAILED")!;
    expect(failedRow[2]).toBe("Broken");                // name still read from the broken file's root tag
    const logRel = failedRow[11];
    expect(logRel.startsWith(".logs/")).toBe(true);
    expect(fs.readFileSync(path.join(out, logRel), "utf8")).toContain("ERROR:");
    expect(fs.existsSync(path.join(out, path.basename(bundle), "default", "Broken__22222222"))).toBe(false);
    expect(fs.existsSync(path.join(out, path.basename(bundle), "default", "Broken__22222222.converting"))).toBe(false);
    expect(errors.join("\n")).toMatch(/1 project\(s\) failed to convert: .*Broken/);
  });

  it("a failing forced re-run keeps the previous good output and drops the stale log once it succeeds again", async () => {
    const root = tempDir("ps-utils-bundle-force-");
    const id = "99999999-aaaa";
    installerBundle(root, [{ org: "default", id }]);
    const out = tempDir("ps-utils-bundle-out-");
    quiet();
    const xml = path.join(root, "metadata", "default", id, "project.xml");
    const dest = path.join(out, path.basename(root), "default", `Duplicate_Measure_Regression__${id.slice(0, 8)}`);

    expect(await runCli(["generate-sml-from-bundle", "--bundles", root, "--output-dir", out])).toBe(0);
    const goodCatalog = fs.readFileSync(path.join(dest, "catalog.yml"), "utf8");

    fs.writeFileSync(xml, "<schema name=\"Duplicate Measure Regression\"><cubes><cube");
    expect(await runCli(["generate-sml-from-bundle", "--bundles", root, "--output-dir", out, "--force"])).toBe(1);
    expect(fs.readFileSync(path.join(dest, "catalog.yml"), "utf8")).toBe(goodCatalog);   // untouched
    const logPath = path.join(out, ".logs", path.basename(root), "default", `Duplicate_Measure_Regression__${id.slice(0, 8)}.log`);
    expect(fs.existsSync(logPath)).toBe(true);
    expect(readSummaryRows(out)[0][4]).toBe("FAILED");

    fs.writeFileSync(xml, fixtureText());
    expect(await runCli(["generate-sml-from-bundle", "--bundles", root, "--output-dir", out, "--force"])).toBe(0);
    expect(fs.existsSync(logPath)).toBe(false);
    expect(readSummaryRows(out)[0][4]).toBe("ok");
  });

  it("reports a bundle without metadata in the summary and exits non-zero", async () => {
    const notABundle = tempDir("ps-utils-bundle-empty-");
    fs.writeFileSync(path.join(notABundle, "MANIFEST.txt"), "x");
    const out = tempDir("ps-utils-bundle-out-");
    const errors = quiet();

    expect(await runCli(["generate-sml-from-bundle", "--bundles", notABundle, "--output-dir", out])).toBe(1);
    const rows = readSummaryRows(out);
    expect(rows).toHaveLength(1);
    expect(rows[0][4]).toBe("NO-METADATA");
    expect(errors.join("\n")).toMatch(/No metadata\/ directory or metadata\.zip found/);
  });
});
