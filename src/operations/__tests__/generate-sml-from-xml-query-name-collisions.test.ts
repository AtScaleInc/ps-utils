import fs from "fs";
import os from "os";
import path from "path";
import { fileURLToPath } from "url";
import { load } from "js-yaml";
import { afterEach, describe, expect, it, vi } from "vitest";
import { runCli } from "../../cli-runner.js";
import { buildLogger } from "../../logging.js";
import { convertXmlToSml } from "../generate-sml-from-xml/xml-converter.js";
import { writeSmlFiles } from "../generate-sml-shared.js";

const fixture = fileURLToPath(
  new URL("./fixtures/duplicate-level-query-name.xml", import.meta.url),
);
const ddlFixture = fileURLToPath(new URL("./fixtures/query-name-collision.sql", import.meta.url));
const duplicateMeasureFixture = fileURLToPath(new URL("./fixtures/duplicate-measure-column-resolution.xml", import.meta.url));

const temporaryDirectories: string[] = [];

function temporaryOutputDirectory(): string {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "ps-utils-query-name-collision-"));
  temporaryDirectories.push(directory);
  return directory;
}

function readYaml(relativePath: string, outputDirectory: string): any {
  return load(fs.readFileSync(path.join(outputDirectory, relativePath), "utf8"));
}

afterEach(() => {
  vi.restoreAllMocks();
  for (const directory of temporaryDirectories.splice(0)) {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

describe("generate-sml-from-xml query-name compatibility", () => {
  it("renames every member of a cross-dimension collision in new-model mode", async () => {
    const outputDirectory = temporaryOutputDirectory();
    vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});

    const exitCode = await runCli([
      "generate-sml-from-xml",
      "--xml-file", fixture,
      "--output-dir", outputDirectory,
      "--model-mode", "new",
    ]);

    expect(exitCode).toBe(0);
    expect(readYaml("dimensions/geography.yml", outputDirectory).level_attributes[0].unique_name)
      .toBe("geography_division");
    expect(readYaml("dimensions/organization.yml", outputDirectory).level_attributes[0].unique_name)
      .toBe("organization_division");
  });

  it("requires an actionable compatibility policy in non-interactive runs", async () => {
    const outputDirectory = temporaryOutputDirectory();
    const errors: string[] = [];
    vi.spyOn(console, "error").mockImplementation((message) => errors.push(String(message)));

    const exitCode = await runCli([
      "generate-sml-from-xml",
      "--xml-file", fixture,
      "--output-dir", outputDirectory,
    ]);

    expect(exitCode).toBe(1);
    expect(errors.join("\n")).toContain("ambiguous query-name collision requires a model compatibility policy");
    expect(errors.join("\n")).toContain("--model-mode new");
    expect(errors.join("\n")).toContain("--model-mode existing");
    expect(fs.readdirSync(outputDirectory)).toEqual([]);
  });

  it("preserves established names and blocks promotion in existing-model mode", async () => {
    const outputDirectory = temporaryOutputDirectory();
    vi.spyOn(console, "error").mockImplementation(() => {});

    const exitCode = await runCli([
      "generate-sml-from-xml",
      "--xml-file", fixture,
      "--output-dir", outputDirectory,
      "--model-mode", "existing",
    ]);

    expect(exitCode).toBe(1);
    expect(readYaml("dimensions/geography.yml", outputDirectory).level_attributes[0].unique_name)
      .toBe("division");
    expect(readYaml("dimensions/organization.yml", outputDirectory).level_attributes[0].unique_name)
      .toBe("division");
  });

  it("makes the structural validator reject manually authored ambiguity", async () => {
    const outputDirectory = temporaryOutputDirectory();
    const xml = fs.readFileSync(fixture, "utf8");
    const ambiguousSml = await convertXmlToSml(xml, { xmlFileName: path.basename(fixture) }, buildLogger({}));
    writeSmlFiles(ambiguousSml, outputDirectory, buildLogger({}));
    const connectionFile = path.join(outputDirectory, "validator-connections.yml");
    fs.writeFileSync(connectionFile, [
      "connections:",
      "  fixture:",
      "    atscale:",
      "      url: http://127.0.0.1:1",
      "      apiToken: fixture-token",
      "",
    ].join("\n"));
    vi.spyOn(console, "error").mockImplementation(() => {});

    const exitCode = await runCli([
      "atscale-list-model-errors",
      "--connection-file", connectionFile,
      "--atscale-connection-name", "fixture",
      "--sml-dir", outputDirectory,
      "--model-name", "Division Model",
    ]);

    expect(exitCode).toBe(1);
  });

  it("applies the same new-model policy to DDL generation", async () => {
    const outputDirectory = temporaryOutputDirectory();
    const exitCode = await runCli([
      "generate-sml-from-ddl",
      "--ddl-file", ddlFixture,
      "--output-dir", outputDirectory,
      "--fact-tables", "fact_assignments",
      "--model-mode", "new",
    ]);

    expect(exitCode).toBe(0);
    expect(readYaml("dimensions/geography.yml", outputDirectory).level_attributes[0].unique_name)
      .toBe("geography_division");
    expect(readYaml("dimensions/organization.yml", outputDirectory).level_attributes[0].unique_name)
      .toBe("organization_division");
  });

  it("preserves PR #57 duplicate-measure column selection behavior", async () => {
    const xml = fs.readFileSync(duplicateMeasureFixture, "utf8");
    const sml = await convertXmlToSml(xml, { xmlFileName: path.basename(duplicateMeasureFixture) }, buildLogger({}));
    const metric = load(sml.get("metrics/salesamount.yml")!) as any;
    expect(metric.column).toBe("valid_amount");
    expect(metric.dataset).toBe("fact_sales.dataset");
  });
});
