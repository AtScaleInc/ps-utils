import JSZip from "jszip";
import { describe, expect, it } from "vitest";
import { readPbixBuffer } from "../analyze-powerbi-dax-gaps/pbix-reader.js";
import { analyzeMeasure, analyzeReport } from "../analyze-powerbi-dax-gaps/gap-analyzer.js";
import {
  renderGapCsv, renderGapJson, renderGapMarkdown,
} from "../analyze-powerbi-dax-gaps/gap-report.js";
import {
  SUPPORTED_CLIENT_DAX, supportsClientDax,
} from "../analyze-powerbi-dax-gaps/client-dax-capabilities.js";
import type { PbixMeasure } from "../analyze-powerbi-dax-gaps/pbix-reader.js";

/** Build a .pbix in memory: UTF-16LE Report/Layout with nested JSON config. */
async function buildPbix(opts: {
  measures?: Array<{ entity: string; name: string; expression: string; refs?: string[] }>;
  withDataModel?: boolean;
  connectionType?: string;
  connectionString?: string;
}): Promise<Buffer> {
  const entities = new Map<string, Array<Record<string, unknown>>>();
  for (const m of opts.measures ?? []) {
    if (!entities.has(m.entity)) entities.set(m.entity, []);
    entities.get(m.entity)!.push({
      name: m.name,
      expression: m.expression,
      hidden: false,
      formatInformation: { formatString: "0.00" },
      references: { measures: (m.refs ?? []).map((r) => ({ name: r })) },
    });
  }
  const config = JSON.stringify({
    modelExtensions: [{
      name: "extension",
      entities: [...entities].map(([name, measures]) => ({ name, extends: name, measures })),
    }],
  });
  const layout = JSON.stringify({
    id: 1,
    config,
    sections: [{ name: "s1", displayName: "Overview" }],
  });

  const zip = new JSZip();
  zip.file("Version", "1.17");
  zip.file("Report/Layout", Buffer.from(layout, "utf16le"));
  zip.file("Connections", JSON.stringify({
    Version: 1,
    Connections: [{
      Name: "EntityDataSource",
      ConnectionString: opts.connectionString
        ?? "Data Source=server;Initial Catalog=Billing;Cube=Billing",
      ConnectionType: opts.connectionType ?? "analysisServicesDatabaseLive",
    }],
  }));
  if (opts.withDataModel) zip.file("DataModel", Buffer.from([0x00, 0x01, 0x02]));
  return zip.generateAsync({ type: "nodebuffer" });
}

const measure = (over: Partial<PbixMeasure> = {}): PbixMeasure => ({
  entity: "Fact", name: "m", expression: "SUM('Fact'[amt])",
  referencedModelMeasures: [], hidden: false, ...over,
});

describe("pbix reader", () => {
  it("reads report-scoped measures from UTF-16 Report/Layout", async () => {
    const buf = await buildPbix({
      measures: [{ entity: "_ADAL", name: "Ratio", expression: "DIVIDE([a],[b])", refs: ["a"] }],
    });
    const report = await readPbixBuffer(buf, "test.pbix");
    expect(report.measures).toHaveLength(1);
    expect(report.measures[0]).toMatchObject({
      entity: "_ADAL", name: "Ratio", expression: "DIVIDE([a],[b])",
      referencedModelMeasures: ["a"],
    });
    expect(report.pages).toEqual(["Overview"]);
  });

  it("parses the connection string into its parts", async () => {
    const report = await readPbixBuffer(await buildPbix({}), "test.pbix");
    expect(report.connections[0]).toMatchObject({
      catalog: "Billing", cube: "Billing", dataSource: "server",
    });
    expect(report.isLiveConnection).toBe(true);
  });

  it("picks up an explicit daxdialect parameter", async () => {
    const report = await readPbixBuffer(
      await buildPbix({ connectionString: "Data Source=http://a/xmla/default?daxdialect=tabular" }),
      "test.pbix",
    );
    expect(report.connections[0].daxDialect).toBe("tabular");
  });

  it("flags an embedded DataModel rather than pretending to read it", async () => {
    const report = await readPbixBuffer(await buildPbix({ withDataModel: true }), "t.pbix");
    expect(report.hasEmbeddedDataModel).toBe(true);
  });

  it("returns no measures for a report with none", async () => {
    const report = await readPbixBuffer(await buildPbix({}), "t.pbix");
    expect(report.measures).toEqual([]);
    expect(report.hasEmbeddedDataModel).toBe(false);
  });
});

describe("client-side DAX capability registry", () => {
  it("has exactly the documented number of functions", () => {
    // If this fails, refresh SUPPORTED_CLIENT_DAX in
    // client-dax-capabilities.ts from the CONTAINER docs, bump `captured`,
    // and update this count. Do not just change the number.
    expect(
      SUPPORTED_CLIENT_DAX.size,
      "client-side DAX function count changed -- refresh " +
        "client-dax-capabilities.ts from the container docs, do not just " +
        "update this number",
    ).toBe(109);
  });

  it("matches the container docs, not the narrower installer page", () => {
    // These four are absent from the installer version of the page; using it
    // overstates the gap badly.
    expect(supportsClientDax("SELECTEDVALUE")).toBe(true);
    expect(supportsClientDax("ALLSELECTED")).toBe(true);
    expect(supportsClientDax("AVERAGEX")).toBe(true);
    expect(supportsClientDax("HASONEVALUE")).toBe(true);
  });

  it("excludes the functions the docs do not list", () => {
    expect(supportsClientDax("VALUES")).toBe(false);
    expect(supportsClientDax("CONCATENATEX")).toBe(false);
    expect(supportsClientDax("COUNTROWS")).toBe(false);
    expect(supportsClientDax("EARLIER")).toBe(false);
  });

  it("differs from the server-side surface on purpose", () => {
    // SUM is fine client-side but is a base metric server-side.
    expect(supportsClientDax("SUM")).toBe(true);
  });
});

describe("gap analysis", () => {
  it("keeps a fully supported measure in the report", () => {
    const gap = analyzeMeasure(measure({ expression: "DIVIDE([a],[b],0)" }));
    expect(gap.clientVerdict).toBe("supported");
    expect(gap.recommendation).toBe("keep-in-report");
  });

  it("recommends redesign when neither surface supports it", () => {
    const gap = analyzeMeasure(measure({ expression: "CONCATENATEX(VALUES('T'[c]), [a], \",\")" }));
    expect(gap.clientVerdict).toBe("unsupported");
    expect(gap.clientBlockers).toEqual(["CONCATENATEX", "VALUES"]);
    expect(gap.recommendation).toBe("redesign");
  });

  it("recommends pushing to the model when server-side accepts it", () => {
    // COUNTROWS is off the client-side list but on the server-side one.
    const gap = analyzeMeasure(measure({ expression: "COUNTROWS('Fact')" }));
    expect(gap.clientVerdict).toBe("unsupported");
    expect(gap.recommendation).toBe("push-to-model");
  });

  it("attaches remediation to unsupported functions", () => {
    const gap = analyzeMeasure(measure({ expression: "VALUES('T'[c])" }));
    expect(gap.clientNotes.join(" ")).toMatch(/VALUES:/);
  });

  it("records caveats for supported functions with documented limits", () => {
    const gap = analyzeMeasure(measure({
      expression: "CALCULATE([a], DATEADD('D'[d], -1, YEAR))",
    }));
    expect(gap.clientVerdict).toBe("supported");
    expect(gap.caveats.join(" ")).toMatch(/DAY interval/);
  });

  it("parses IN with a table constructor", () => {
    const gap = analyzeMeasure(measure({
      expression: "CALCULATE([a], FILTER('T', NOT 'T'[c] IN {\"x\",\"y\"}))",
    }));
    expect(gap.clientVerdict).not.toBe("parseError");
    expect(gap.functionsUsed).toContain("FILTER");
  });

  it("reports malformed DAX as a parse error rather than throwing", () => {
    const gap = analyzeMeasure(measure({ expression: "DIVIDE('T'[a],'unterminated" }));
    expect(gap.clientVerdict).toBe("parseError");
    expect(gap.recommendation).toBe("unparseable");
    expect(gap.parseError).toBeTruthy();
  });

  it("ranks blockers by measures affected", async () => {
    const report = await readPbixBuffer(await buildPbix({
      measures: [
        { entity: "F", name: "a", expression: "VALUES('T'[c])" },
        { entity: "F", name: "b", expression: "VALUES('T'[d])" },
        { entity: "F", name: "c", expression: "EARLIER('T'[e])" },
        { entity: "F", name: "d", expression: "DIVIDE([x],[y])" },
      ],
    }), "t.pbix");
    const analysis = analyzeReport(report);
    expect(analysis.summary).toMatchObject({ total: 4, clientSupported: 1, clientUnsupported: 3 });
    expect(analysis.clientBlockerRanking[0]).toMatchObject({ fn: "VALUES", measures: 2 });
  });
});

describe("gap report rendering", () => {
  const build = async () => analyzeReport(await readPbixBuffer(await buildPbix({
    measures: [
      { entity: "F", name: "Good", expression: "DIVIDE([a],[b],0)" },
      { entity: "F", name: "Bad|Name", expression: "CONCATENATEX(VALUES('T'[c]), [a], \",\")" },
      { entity: "F", name: "Rowcount", expression: "COUNTROWS('Fact')" },
    ],
  }), "test.pbix"));

  it("includes the key sections", async () => {
    const md = renderGapMarkdown(await build());
    expect(md).toContain("# Power BI DAX gap analysis");
    expect(md).toContain("## Summary");
    expect(md).toContain("Functions outside client-side DAX support");
    expect(md).toContain("Move into the AtScale model");
    expect(md).toContain("Needs redesign");
  });

  it("escapes pipes so a measure name cannot break the tables", async () => {
    expect(renderGapMarkdown(await build())).toContain("Bad\\|Name");
  });

  it("explains a live connection", async () => {
    expect(renderGapMarkdown(await build())).toContain("Live connection");
  });

  it("says an embedded DataModel could not be read", async () => {
    const analysis = analyzeReport(
      await readPbixBuffer(await buildPbix({ withDataModel: true }), "t.pbix"),
    );
    expect(renderGapMarkdown(analysis)).toContain("XPress9");
  });

  it("handles a report with no measures without claiming success", async () => {
    const analysis = analyzeReport(await readPbixBuffer(await buildPbix({}), "t.pbix"));
    expect(renderGapMarkdown(analysis)).toContain("No report-scoped DAX measures");
  });

  it("emits machine-readable json and csv", async () => {
    const analysis = await build();
    const json = JSON.parse(renderGapJson(analysis));
    expect(json.summary.total).toBe(3);
    expect(json.measures).toHaveLength(3);

    const csv = renderGapCsv(analysis);
    expect(csv.split("\n")[0]).toContain("recommendation");
    // A comma inside an expression must not break the row count.
    expect(csv.trim().split("\n")).toHaveLength(4);
  });
});
