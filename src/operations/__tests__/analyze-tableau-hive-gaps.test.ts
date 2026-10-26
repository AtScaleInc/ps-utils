import JSZip from "jszip";
import { describe, expect, it } from "vitest";
import { parseTableauXml, readTableauBuffer } from "../analyze-tableau-hive-gaps/tableau-reader.js";
import { analyzeFiles } from "../analyze-tableau-hive-gaps/gap-analyzer.js";
import { extractRawSql, findHiveConstructs } from "../analyze-tableau-hive-gaps/hive-rules.js";
import {
  renderFilesCsv, renderFindingsCsv, renderGapMarkdown,
} from "../analyze-tableau-hive-gaps/gap-report.js";

const xmlAttr = (s: string): string =>
  s.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

/** Build a minimal .twb in the shape Tableau writes. */
function twb(opts: {
  connectionClass?: string;
  port?: string;
  server?: string;
  initialSql?: string;
  customSql?: string;
  calcs?: Array<{ name: string; caption: string; formula: string }>;
  sheets?: Array<{ name: string; columns: string[] }>;
  dashboard?: { name: string; sheets: string[] };
  extract?: boolean;
  published?: string;
}): string {
  const conn = opts.published
    ? `<connection class="sqlproxy" dbname="${opts.published}" server="tableau.example.com"/>`
    : `<connection class="federated"><named-connections>
         <named-connection name="hive.1" caption="atscale">
           <connection class="${opts.connectionClass ?? "hadoophive"}" server="${opts.server ?? "atscale.example.com"}"
             port="${opts.port ?? "11111"}" dbname="default"
             ${opts.initialSql ? `one-time-sql="${xmlAttr(opts.initialSql)}"` : ""}/>
         </named-connection></named-connections>
         ${opts.customSql
           ? `<relation type="text" name="Custom SQL Query" connection="hive.1">${xmlAttr(opts.customSql)}</relation>`
           : `<relation type="table" name="sales" connection="hive.1" table="[default].[sales]"/>`}
       </connection>`;
  const cols = (opts.calcs ?? []).map((c) =>
    `<column name="${c.name}" caption="${c.caption}" datatype="real" role="measure">
       <calculation class="tableau" formula="${xmlAttr(c.formula)}"/></column>`).join("");
  const sheets = (opts.sheets ?? []).map((s) =>
    `<worksheet name="${s.name}"><table><view>
       <datasources><datasource name="federated.abc"/></datasources>
       <datasource-dependencies datasource="federated.abc">
         ${s.columns.map((c) => `<column name="${c}"/>`).join("")}
       </datasource-dependencies></view></table></worksheet>`).join("");
  const dash = opts.dashboard
    ? `<dashboards><dashboard name="${opts.dashboard.name}"><zones><zone id="1">
         ${opts.dashboard.sheets.map((s) => `<zone name="${s}" id="2"/>`).join("")}
       </zone></zones></dashboard></dashboards>`
    : "";
  return `<?xml version="1.0" encoding="utf-8"?>
<workbook version="18.1">
  <datasources>
    <datasource name="Parameters" hasconnection="false"/>
    <datasource name="federated.abc" caption="Sales">
      ${conn}
      ${cols}
      ${opts.extract ? `<extract enabled="true"><connection class="hyper"/></extract>` : ""}
    </datasource>
  </datasources>
  <worksheets>${sheets}</worksheets>
  ${dash}
</workbook>`;
}

const parse = (xml: string, name = "wb.twb") => parseTableauXml(xml, name);

describe("hive-rules", () => {
  it("extracts only the SQL string arguments of RAWSQL calls", () => {
    const f = `RAWSQL_STR("date_format(%1, 'yyyy')", [Order Date]) + IF YEAR([d]) > 1 THEN "" END` +
      ` + RAWSQLAGG_REAL('nvl(%1, 0) + ''x''', [Sales])`;
    expect(extractRawSql(f)).toEqual(["date_format(%1, 'yyyy')", "nvl(%1, 0) + 'x'"]);
  });

  it("flags Hive-only constructs and leaves portable SQL alone", () => {
    const ids = (sql: string) => findHiveConstructs(sql).map((h) => h.rule.id);
    expect(ids("SELECT nvl(a,0), `b` FROM t WHERE c <=> d")).toEqual(
      expect.arrayContaining(["nvl", "backtick", "null_safe_eq"]));
    expect(ids("SELECT to_date(ts) FROM t")).toContain("to_date_1arg");
    expect(ids("SELECT to_date(ts, 'YYYY-MM-DD'), coalesce(a, 0), substr(s, 1, 2) FROM t")).toEqual([]);
  });

  it("carries the PGWire behaviour verified against AtScale", () => {
    const status = (sql: string) =>
      Object.fromEntries(findHiveConstructs(sql).map((h) => [h.rule.id, h.rule.pgwire]));
    expect(status("SELECT nvl(a, 0), `b`, date_format(d, 'y') FROM t WHERE c <=> d")).toEqual({
      nvl: "rejected", backtick: "rejected", date_format: "passthrough", null_safe_eq: "accepted",
    });
    // TRIM is standard SQL, but PGWire rewrites it to btrim and rejects it.
    expect(status("SELECT 1 FROM t WHERE TRIM(x) = 'R'")).toEqual({ trim: "rejected" });
    expect(status("SELECT ltrim(x) FROM t")).toEqual({});
  });
});

describe("tableau-reader", () => {
  it("reads federated connections, custom SQL, calcs, sheets and dashboards", async () => {
    const f = await parse(twb({
      initialSql: "SET x = 1",
      customSql: "SELECT * FROM t",
      calcs: [{ name: "[Calculation_1]", caption: "Margin", formula: "SUM([Sales])" }],
      sheets: [{ name: "Overview", columns: ["[Calculation_1]"] }],
      dashboard: { name: "Exec", sheets: ["Overview"] },
    }));
    expect(f.kind).toBe("workbook");
    expect(f.datasources).toHaveLength(1);
    const ds = f.datasources[0];
    expect(ds.connections[0]).toMatchObject({ connectionClass: "hadoophive", port: "11111", initialSql: "SET x = 1" });
    expect(ds.customSql).toEqual([{ name: "Custom SQL Query", connectionName: "hive.1", sql: "SELECT * FROM t" }]);
    expect(ds.calculations[0].caption).toBe("Margin");
    expect(f.worksheets[0].dependencies["federated.abc"]).toEqual(["[Calculation_1]"]);
    expect(f.dashboardsBySheet).toEqual({ Overview: ["Exec"] });
  });

  it("reads custom SQL as Tableau saves it: CDATA with doubled angle brackets", async () => {
    // Tableau writes a literal `<` / `>` in custom SQL as `<<` / `>>`; a single
    // pair is a parameter reference such as <Parameters.Region>.
    const xml = twb({}).replace(
      /<relation type="table"[^>]*\/>/,
      `<relation connection="hive.1" name="Custom SQL Query" type="text">` +
      `<![CDATA[SELECT a FROM t WHERE b <<=>> 'R' AND c >>= 1 AND d = <Parameters.Region>]]></relation>`,
    );
    const ds = (await parse(xml)).datasources[0];
    expect(ds.customSql[0].sql).toBe("SELECT a FROM t WHERE b <=> 'R' AND c >= 1 AND d = <Parameters.Region>");
  });

  it("unpacks .twbx and reports unreadable files instead of throwing", async () => {
    const zip = new JSZip();
    zip.file("Sales.twb", twb({}));
    zip.file("Data/extract.hyper", "x");
    const buf = await zip.generateAsync({ type: "nodebuffer" });
    const f = await readTableauBuffer(buf, "Sales.twbx");
    expect(f.parseError).toBeUndefined();
    expect(f.datasources[0].connections[0].port).toBe("11111");

    const bad = await readTableauBuffer(Buffer.from("not xml <"), "bad.twb");
    expect(bad.parseError).toBeTruthy();
  });
});

describe("gap-analyzer", () => {
  it("puts RAWSQL workbooks at priority 1 and maps findings to sheets", async () => {
    const f = await parse(twb({
      calcs: [
        { name: "[Calculation_1]", caption: "Year Label", formula: `RAWSQL_STR("date_format(%1,'yyyy')", [Order Date])` },
        { name: "[Calculation_2]", caption: "Fixed Year", formula: "{FIXED [Calculation_1] : SUM([Sales])}" },
        { name: "[Calculation_3]", caption: "Age", formula: "DATEDIFF('day', [Order Date], TODAY())" },
      ],
      sheets: [
        { name: "Trend", columns: ["[Calculation_1]"] },
        { name: "Other", columns: ["[Sales]"] },
      ],
      dashboard: { name: "Exec", sheets: ["Trend"] },
    }));
    const a = analyzeFiles([f]);
    const file = a.files[0];
    expect(file).toMatchObject({ status: "affected", priority: 1 });

    const raw = file.findings.find((x) => x.kind === "rawsql")!;
    expect(raw.hiveHits.map((h) => h.id)).toEqual(["date_format"]);
    expect(raw.sheets).toEqual(["Trend"]);
    expect(raw.dashboards).toEqual(["Exec"]);

    expect(file.findings.find((x) => x.kind === "rawsql-dependent")?.object).toBe("Fixed Year");
    // Tableau's own DATEDIFF is a driver-translation check, not a Hive hit.
    const date = file.findings.find((x) => x.kind === "date-function")!;
    expect(date.object).toBe("Age");
    expect(date.hiveHits).toEqual([]);
  });

  it("ranks live, extract and calc-free workbooks", async () => {
    const calc = [{ name: "[Calculation_1]", caption: "M", formula: "SUM([Sales])" }];
    const files = [
      await parse(twb({ calcs: calc }), "live.twb"),
      await parse(twb({ calcs: calc, extract: true }), "extract.twb"),
      await parse(twb({}), "plain.twb"),
      await parse(twb({ connectionClass: "postgres", port: "15432" }), "done.twb"),
      await parse(twb({ connectionClass: "snowflake", port: "443" }), "other.twb"),
    ];
    const byName = Object.fromEntries(analyzeFiles(files).files.map((f) => [f.fileName, f]));
    expect(byName["live.twb"].priority).toBe(2);
    expect(byName["extract.twb"].priority).toBe(3);
    expect(byName["plain.twb"].priority).toBe(4);
    expect(byName["done.twb"].status).toBe("migrated");
    expect(byName["other.twb"].status).toBe("not-affected");
  });

  it("flags custom SQL and Initial SQL as priority 1", async () => {
    const f = await parse(twb({ customSql: "SELECT nvl(a, 0) FROM t", initialSql: "SET hive.x=1" }));
    const file = analyzeFiles([f]).files[0];
    expect(file.priority).toBe(1);
    expect(file.findings.find((x) => x.kind === "custom-sql")?.hiveHits[0].id).toBe("nvl");
    expect(file.findings.some((x) => x.kind === "initial-sql")).toBe(true);
  });

  it("resolves published data sources from the same scan", async () => {
    const wb = await parse(twb({ published: "SalesSource" }), "uses-published.twb");
    const orphan = await parse(twb({ published: "Missing Source" }), "orphan.twb");
    const tds = await parseTableauXml(
      `<datasource formatted-name="Sales Source" caption="Sales Source">
         <connection class="hadoophive" server="atscale.example.com" port="11111" dbname="default"/>
       </datasource>`,
      "Sales Source.tds",
    );
    const a = analyzeFiles([wb, orphan, tds]);
    const byName = Object.fromEntries(a.files.map((f) => [f.fileName, f]));
    expect(byName["uses-published.twb"].status).toBe("affected");
    expect(byName["Sales Source.tds"].status).toBe("affected");
    expect(byName["orphan.twb"].status).toBe("unresolved");
    expect(a.unresolvedPublishedSources).toEqual(["Missing Source"]);
  });

  it("honours --atscale-host so other Hive sources are ignored", async () => {
    const f = await parse(twb({ server: "hadoop.example.com" }));
    expect(analyzeFiles([f], { atscaleHost: "atscale" }).files[0].status).toBe("not-affected");
    expect(analyzeFiles([f]).files[0].status).toBe("affected");
  });
});

describe("gap-report", () => {
  it("renders the workbook list and work items", async () => {
    const f = await parse(twb({
      calcs: [{ name: "[Calculation_1]", caption: "Y, label", formula: `RAWSQL_STR("nvl(%1,'')", [x])` }],
      sheets: [{ name: "Trend", columns: ["[Calculation_1]"] }],
    }), "Sales.twb");
    const a = analyzeFiles([f]);
    const md = renderGapMarkdown(a);
    expect(md).toContain("## Workbooks and data sources to migrate");
    expect(md).toContain("`Sales.twb`");
    expect(md).toContain("COALESCE");

    const files = renderFilesCsv(a).trim().split("\n");
    expect(files[0]).toMatch(/^file,type,status,priority/);
    expect(files[1]).toMatch(/^Sales\.twb,workbook,Affected,1,/);

    const findings = renderFindingsCsv(a);
    expect(findings).toContain('"Y, label"');
  });
});

describe("real-format workbook fixture", () => {
  // A Tableau 10.5 AtScale-on-Hive workbook, seeded with RAWSQL, custom SQL and
  // Initial SQL. Server and username are placeholders.
  const fixture = new URL("./fixtures/tableau/SalesHiveRawSql.twb", import.meta.url);

  it("finds every seeded item and maps it to the sheet and dashboard", async () => {
    const { readTableauFile } = await import("../analyze-tableau-hive-gaps/tableau-reader.js");
    const file = (await import("node:url")).fileURLToPath(fixture);
    const a = analyzeFiles([await readTableauFile(file)]);
    const f = a.files[0];
    // 8 constructs; <=> is verified accepted on PGWire, so 7 may break, and
    // nvl (twice) plus the backticks are verified rejected.
    expect(f).toMatchObject({ status: "affected", priority: 1, hiveConstructCount: 7, verifiedBreakingCount: 3 });

    const by = (kind: string) => f.findings.filter((x) => x.kind === kind).map((x) => x.object);
    expect(by("rawsql")).toEqual(["Order Month Label", "Safe Sales", "Product Line Code", "Portable Quantity"]);
    expect(by("rawsql-dependent")).toEqual(["Sales per Line Code (FIXED)"]);
    expect(by("date-function")).toEqual(["Days Since Order Month"]);
    expect(by("custom-sql")).toEqual(["Custom SQL Query"]);
    expect(by("initial-sql")).toHaveLength(1);

    const label = f.findings.find((x) => x.object === "Order Month Label")!;
    expect(label.sheets).toEqual(["Sheet 1"]);
    expect(label.dashboards).toEqual(["Exec Overview"]);
    const portable = f.findings.find((x) => x.object === "Portable Quantity")!;
    expect(portable.hiveHits).toEqual([]);
    expect(portable.note).toMatch(/no breaking construct found/);

    // Backticked HiveQL must not break the Markdown inline code.
    expect(renderGapMarkdown(a)).toContain("`` SELECT `product line`");
  });
});
