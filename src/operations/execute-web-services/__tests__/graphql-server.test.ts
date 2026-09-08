import fs from "fs";
import net from "net";
import os from "os";
import path from "path";
import JSZip from "jszip";
import { afterEach, describe, expect, it } from "vitest";
import { buildServiceRegistry } from "../../../services/index.js";
import { buildLogger } from "../../../logging.js";
import { OperationRegistry } from "../../registry.js";
import { GenerateQueriesFromSMLOperation } from "../../generate-queries-from-sml/GenerateQueriesFromSMLOperation.js";
import { buildOpMetas, buildSdl, isOutputFileParam, startServer } from "../graphql-server.js";

/**
 * Tests for output-parameter handling in the execute-web-services server.
 */

const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

/** Write a minimal SML directory with one model and one metric. */
function writeSmlDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "graphql-server-"));
  tempDirs.push(dir);

  fs.mkdirSync(path.join(dir, "models"), { recursive: true });
  fs.mkdirSync(path.join(dir, "metrics"), { recursive: true });

  fs.writeFileSync(
    path.join(dir, "models", "sales.yml"),
    ["unique_name: sales_model", "label: Sales Model", "metrics:", "  - unique_name: total_sales", ""].join("\n"),
  );
  fs.writeFileSync(
    path.join(dir, "metrics", "total-sales.yml"),
    ["unique_name: total_sales", "label: Total Sales", ""].join("\n"),
  );

  return dir;
}

/** Reserve a free TCP port for the test server. */
async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const probe = net.createServer();
    probe.once("error", reject);
    probe.listen(0, "127.0.0.1", () => {
      const port = (probe.address() as net.AddressInfo).port;
      probe.close(() => resolve(port));
    });
  });
}

async function buildQueriesRegistry(): Promise<OperationRegistry> {
  const services = await buildServiceRegistry();
  const logger = buildLogger({});
  const registry = new OperationRegistry();
  registry.register(new GenerateQueriesFromSMLOperation(services, logger));
  return registry;
}

describe("isOutputFileParam", () => {
  it("recognizes output files wherever 'output' sits in the name", () => {
    expect(isOutputFileParam("output-file")).toBe(true);
    expect(isOutputFileParam("output-model-file")).toBe(true);
    expect(isOutputFileParam("xmla-output-file")).toBe(true);
    expect(isOutputFileParam("sql-output-file")).toBe(true);
  });

  it("leaves input file parameters alone", () => {
    expect(isOutputFileParam("connection-file")).toBe(false);
    expect(isOutputFileParam("model-file")).toBe(false);
    expect(isOutputFileParam("sml-config-file")).toBe(false);
    expect(isOutputFileParam("output-dir")).toBe(false);
  });
});

describe("operation metadata", () => {
  it("marks xmla-output-file and sql-output-file as outputs, not uploads", async () => {
    const registry = await buildQueriesRegistry();
    const meta = buildOpMetas(registry).find((m) => m.opName === "generate-queries-from-sml")!;

    for (const paramName of ["xmla-output-file", "sql-output-file"]) {
      const param = meta.params.find((p) => p.paramName === paramName)!;
      expect(param.isOutputFile).toBe(true);
      expect(param.isFile).toBe(false);
    }
  });

  it("does not offer Upload/Content variants for output files in the SDL", async () => {
    const registry = await buildQueriesRegistry();
    const sdl = buildSdl(buildOpMetas(registry));

    expect(sdl).toContain("xmlaOutputFile: String");
    expect(sdl).not.toContain("xmlaOutputFileUpload");
    expect(sdl).not.toContain("sqlOutputFileContent");
  });
});

describe("REST output collection", () => {
  it("runs generate-queries-from-sml without caller-supplied output paths and returns both files", async () => {
    const registry = await buildQueriesRegistry();
    const port = await freePort();
    const shutdown = await startServer(registry, port, "127.0.0.1", buildLogger({}));

    try {
      const response = await fetch(`http://127.0.0.1:${port}/rest/generate-queries-from-sml`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ smlDir: writeSmlDir() }),
      });
      const result = await response.json();

      expect(result.error ?? null).toBeNull();
      expect(result.success).toBe(true);
      expect(result.file).not.toBeNull();

      const zip = await JSZip.loadAsync(Buffer.from(result.file.content, "base64"));
      const names = Object.keys(zip.files).sort();

      expect(names).toEqual(["sql-output", "xmla-output"]);
      for (const name of names) {
        const parsed = JSON.parse(await zip.files[name].async("string"));
        expect(Array.isArray(parsed) ? parsed.length : Object.keys(parsed).length).toBeGreaterThan(0);
      }
    } finally {
      await shutdown();
    }
  });
});
