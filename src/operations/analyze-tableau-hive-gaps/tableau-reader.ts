/**
 * Reads the parts of Tableau workbooks and data sources that matter for the
 * Hive thrift → PGWire migration.
 *
 *   - `.twb` / `.tds` are plain XML.
 *   - `.twbx` / `.tdsx` are zips holding one `.twb` / `.tds` at the root, plus
 *     extracts and images we do not need.
 *
 * Inside the XML, every data source wraps its real connections in a
 * `federated` connection:
 *
 *   <datasource name='federated.abc' caption='Sales'>
 *     <connection class='federated'>
 *       <named-connections>
 *         <named-connection name='hive.xyz'>
 *           <connection class='hadoophive' server='atscale' port='11111' one-time-sql='...'/>
 *         </named-connection>
 *       </named-connections>
 *       <relation type='text' name='Custom SQL Query' connection='hive.xyz'>SELECT ...</relation>
 *     </connection>
 *     <column name='[Calculation_1]' caption='Margin'>
 *       <calculation class='tableau' formula='RAWSQL_REAL("...", [Sales])'/>
 *     </column>
 *   </datasource>
 *
 * A workbook that uses a *published* data source instead has a `sqlproxy`
 * connection whose `dbname` is the published source's name.
 *
 * Worksheets list the columns they use under
 * `table/view/datasource-dependencies`, which is how findings are mapped back
 * to the sheets a tester has to open.
 */

import { readFile } from "node:fs/promises";
import path from "node:path";
import JSZip from "jszip";
import { Parser } from "xml2js";

export type TableauConnection = {
  /** named-connection name, or "" for an old-style direct connection. */
  name: string;
  caption: string;
  connectionClass: string;
  server: string;
  port: string;
  dbname: string;
  schema: string;
  /** Initial SQL (`one-time-sql`), sent verbatim on connect. */
  initialSql: string;
};

export type TableauCustomSql = {
  name: string;
  connectionName: string;
  sql: string;
};

export type TableauCalculation = {
  /** Internal name including brackets, e.g. `[Calculation_123]`. */
  name: string;
  caption: string;
  formula: string;
};

export type TableauDatasource = {
  /** Internal name, e.g. `federated.0abc...`. */
  name: string;
  caption: string;
  connections: TableauConnection[];
  customSql: TableauCustomSql[];
  calculations: TableauCalculation[];
  /** Name of the published data source this one proxies, when it is a `sqlproxy`. */
  publishedSource?: string;
  hasExtract: boolean;
};

export type TableauWorksheet = {
  name: string;
  /** Data source internal name → column names used from it. */
  dependencies: Record<string, string[]>;
};

export type TableauFile = {
  fileName: string;
  /** Path relative to the scanned root, for reports. */
  relPath: string;
  kind: "workbook" | "datasource";
  datasources: TableauDatasource[];
  worksheets: TableauWorksheet[];
  /** Worksheet name → dashboards that show it. */
  dashboardsBySheet: Record<string, string[]>;
  parseError?: string;
};

export const TABLEAU_EXTENSIONS = [".twb", ".twbx", ".tds", ".tdsx"];

// xml2js nodes: attributes under `$`, text under `_`, children always arrays.
type XNode = { $?: Record<string, string>; _?: string; [child: string]: unknown };

const kids = (n: XNode | undefined, tag: string): XNode[] =>
  (n?.[tag] as XNode[] | undefined) ?? [];
const attr = (n: XNode | undefined, key: string): string => n?.$?.[key] ?? "";
const text = (n: XNode | string | undefined): string =>
  typeof n === "string" ? n : (n?._ ?? "");

function readConnection(c: XNode, name: string, caption: string): TableauConnection {
  return {
    name,
    caption,
    connectionClass: attr(c, "class").toLowerCase(),
    server: attr(c, "server"),
    port: attr(c, "port"),
    dbname: attr(c, "dbname"),
    schema: attr(c, "schema"),
    initialSql: attr(c, "one-time-sql"),
  };
}

/**
 * Tableau stores custom SQL with every literal `<` and `>` doubled, because a
 * single pair delimits a parameter (`<Parameters.Region>`). Undo the doubling
 * so `a <<= b` reads as the `a <= b` the author wrote.
 */
export function unescapeCustomSql(sql: string): string {
  return sql.replace(/<<|>>/g, (m) => m[0]);
}

/** Collect every `relation type='text'` (custom SQL), at any join depth. */
function collectCustomSql(n: XNode, out: TableauCustomSql[]): void {
  for (const r of kids(n, "relation")) {
    if (attr(r, "type") === "text") {
      out.push({
        name: attr(r, "name"),
        connectionName: attr(r, "connection"),
        sql: unescapeCustomSql(text(r).trim()),
      });
    }
    collectCustomSql(r, out);
  }
  // Newer workbooks (2020.2+ relationships) nest relations under _.fcp.ObjectModelEncapsulateLegacy
  // and `object-graph`; walk every child element so none are missed.
  for (const [key, value] of Object.entries(n)) {
    if (key === "$" || key === "_" || key === "relation" || !Array.isArray(value)) continue;
    for (const child of value) if (child && typeof child === "object") collectCustomSql(child as XNode, out);
  }
}

function readDatasource(ds: XNode): TableauDatasource {
  const out: TableauDatasource = {
    name: attr(ds, "name"),
    caption: attr(ds, "caption"),
    connections: [],
    customSql: [],
    calculations: [],
    hasExtract: kids(ds, "extract").some((e) => attr(e, "enabled") !== "false"),
  };

  for (const conn of kids(ds, "connection")) {
    const cls = attr(conn, "class").toLowerCase();
    if (cls === "sqlproxy") {
      out.publishedSource = attr(conn, "dbname") || attr(conn, "server");
      continue;
    }
    if (cls === "federated") {
      for (const nc of kids(kids(conn, "named-connections")[0], "named-connection")) {
        for (const inner of kids(nc, "connection")) {
          out.connections.push(readConnection(inner, attr(nc, "name"), attr(nc, "caption")));
        }
      }
    } else {
      out.connections.push(readConnection(conn, "", ""));
    }
  }
  // Dedupe custom SQL: the same relation is repeated under the legacy and the
  // object-model encodings of one data source.
  const sql: TableauCustomSql[] = [];
  collectCustomSql(ds, sql);
  const seen = new Set<string>();
  out.customSql = sql.filter((s) => {
    const key = `${s.name}\u0000${s.sql}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });

  for (const col of kids(ds, "column")) {
    for (const calc of kids(col, "calculation")) {
      const formula = attr(calc, "formula");
      if (attr(calc, "class") === "tableau" && formula) {
        out.calculations.push({ name: attr(col, "name"), caption: attr(col, "caption"), formula });
      }
    }
  }
  return out;
}

function readWorksheets(root: XNode): TableauWorksheet[] {
  return kids(kids(root, "worksheets")[0], "worksheet").map((ws) => {
    const dependencies: Record<string, string[]> = {};
    for (const table of kids(ws, "table")) {
      for (const view of kids(table, "view")) {
        for (const dep of kids(view, "datasource-dependencies")) {
          const ds = attr(dep, "datasource");
          const cols = kids(dep, "column").map((c) => attr(c, "name"));
          dependencies[ds] = [...(dependencies[ds] ?? []), ...cols];
        }
        // A sheet can use a data source without any dependent columns listed.
        for (const d of kids(kids(view, "datasources")[0], "datasource")) {
          dependencies[attr(d, "name")] ??= [];
        }
      }
    }
    return { name: attr(ws, "name"), dependencies };
  });
}

function collectZoneNames(n: XNode, out: Set<string>): void {
  for (const z of kids(n, "zone")) {
    if (attr(z, "name")) out.add(attr(z, "name"));
    collectZoneNames(z, out);
  }
  for (const zs of kids(n, "zones")) collectZoneNames(zs, out);
}

function readDashboards(root: XNode, sheetNames: Set<string>): Record<string, string[]> {
  const bySheet: Record<string, string[]> = {};
  for (const db of kids(kids(root, "dashboards")[0], "dashboard")) {
    const zones = new Set<string>();
    collectZoneNames(db, zones);
    for (const z of zones) {
      if (sheetNames.has(z)) (bySheet[z] ??= []).push(attr(db, "name"));
    }
  }
  return bySheet;
}

/** Parse Tableau XML (`.twb` or `.tds` content). */
export async function parseTableauXml(
  xml: string,
  fileName: string,
  relPath = fileName,
): Promise<TableauFile> {
  const parsed = (await new Parser().parseStringPromise(xml)) as Record<string, XNode>;
  const isWorkbook = "workbook" in parsed;
  const root = isWorkbook ? parsed.workbook : parsed.datasource;
  if (!root) throw new Error("Not a Tableau workbook or data source (no <workbook> or <datasource> root)");

  const datasources = isWorkbook
    ? kids(kids(root, "datasources")[0], "datasource")
        // The built-in Parameters pseudo-source has no connection.
        .filter((d) => attr(d, "name") !== "Parameters")
        .map(readDatasource)
    : [readDatasource(root)];
  // A standalone .tds root usually has no `name`; give it its caption or file stem.
  if (!isWorkbook && !datasources[0].name) {
    datasources[0].name = datasources[0].caption || path.parse(fileName).name;
  }

  const worksheets = isWorkbook ? readWorksheets(root) : [];
  const dashboardsBySheet = isWorkbook
    ? readDashboards(root, new Set(worksheets.map((w) => w.name)))
    : {};

  return {
    fileName,
    relPath,
    kind: isWorkbook ? "workbook" : "datasource",
    datasources,
    worksheets,
    dashboardsBySheet,
  };
}

/** Decode XML bytes; Tableau writes UTF-8 but older files can carry a BOM. */
function decodeXml(buf: Buffer): string {
  if (buf.length >= 2 && buf[0] === 0xff && buf[1] === 0xfe) return buf.subarray(2).toString("utf16le");
  return buf.toString("utf8").replace(/^﻿/, "");
}

/** Read a .twb/.twbx/.tds/.tdsx buffer. Parse failures are returned, not thrown. */
export async function readTableauBuffer(
  buf: Buffer,
  fileName: string,
  relPath = fileName,
): Promise<TableauFile> {
  const ext = path.extname(fileName).toLowerCase();
  const kind = ext.startsWith(".tw") ? "workbook" : "datasource";
  try {
    let xml: string;
    if (ext === ".twbx" || ext === ".tdsx") {
      const zip = await JSZip.loadAsync(buf);
      const inner = ext === ".twbx" ? ".twb" : ".tds";
      // The document sits at the zip root; ignore copies under Data/ or similar.
      const entry = Object.values(zip.files)
        .filter((f) => !f.dir && f.name.toLowerCase().endsWith(inner))
        .sort((a, b) => a.name.split("/").length - b.name.split("/").length)[0];
      if (!entry) throw new Error(`No ${inner} found inside the packaged file`);
      xml = decodeXml(await entry.async("nodebuffer"));
    } else {
      xml = decodeXml(buf);
    }
    return await parseTableauXml(xml, fileName, relPath);
  } catch (err) {
    return {
      fileName, relPath, kind, datasources: [], worksheets: [], dashboardsBySheet: {},
      parseError: err instanceof Error ? err.message : String(err),
    };
  }
}

export async function readTableauFile(filePath: string, relPath?: string): Promise<TableauFile> {
  return readTableauBuffer(await readFile(filePath), path.basename(filePath), relPath);
}
