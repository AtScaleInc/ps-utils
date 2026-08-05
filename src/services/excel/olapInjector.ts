/**
 * Post-processes an xlsx buffer (zip) to inject:
 *   - xl/connections.xml           OLEDB / XMLA connection
 *   - xl/pivotCache/pivotCacheDefinitionN.xml
 *   - xl/pivotTables/pivotTableN.xml
 *   - xl/charts/chartN.xml         (for non-text tiles)
 *   - xl/drawings/drawingN.xml     (one per dashboard sheet with charts)
 *
 * Uses JSZip for zip manipulation; no Python subprocess required.
 */
import JSZip from "jszip";
import type { PivotMeta, ChartMeta } from "./types.js";
import { extractModelHierarchies, resolveXaxisUnique, getModelObj } from "./modelHierarchies.js";
import { buildConnectionsXml, buildCacheDefXml, buildPivotTableXml } from "./olapXml.js";
import { buildChartXml, buildDrawingXml, buildDrawingRelsXml } from "./chartXml.js";
import type { DrawingAnchor } from "./chartXml.js";
import { nextRid, colLetter } from "./xmlHelpers.js";

const PKG_NS   = "http://schemas.openxmlformats.org/package/2006/relationships";
const PT_REL   = "http://schemas.openxmlformats.org/officeDocument/2006/relationships/pivotTable";
const CACHE_REL = "http://schemas.openxmlformats.org/officeDocument/2006/relationships/pivotCacheDefinition";
const CONN_REL = "http://schemas.openxmlformats.org/officeDocument/2006/relationships/connections";
const DRW_REL  = "http://schemas.openxmlformats.org/officeDocument/2006/relationships/drawing";

// ---------------------------------------------------------------------------
// Public entry point
// ---------------------------------------------------------------------------

export async function injectOlap(
  buffer: Buffer,
  pivotMeta: PivotMeta[],
  chartMeta: ChartMeta[],
  connString: string,
  cubeName: string,
  connectionName: string,
  models: Record<string, unknown>,
): Promise<Buffer> {
  if (pivotMeta.length === 0) return buffer;

  const zip = await JSZip.loadAsync(buffer);

  await stripPreviousOlap(zip);

  const newParts: string[] = [];

  // connections.xml
  zip.file("xl/connections.xml", buildConnectionsXml(connString, connectionName, cubeName));
  newParts.push("xl/connections.xml");

  // Pivot cache + table per tile
  for (let i = 0; i < pivotMeta.length; i++) {
    const idx        = i + 1;
    const pt         = pivotMeta[i];
    const hierarchies = extractModelHierarchies(models, pt.model);
    const modelObj   = getModelObj(models, pt.model);
    const xaxisUnique = resolveXaxisUnique(pt.xAxis, modelObj, hierarchies);

    const cacheXml = buildCacheDefXml(hierarchies, pt.model, pt.measures);
    const pivotXml = buildPivotTableXml(
      pt.tileTitle, i, pt.anchorCol, pt.hdrRow,
      pt.measures, hierarchies, xaxisUnique,
    );

    // OLAP pivot caches with saveData="0" have no pivotCacheRecords file.
    // The pivotCacheDefinition has no r:id and no _rels file.
    zip.file(`xl/pivotCache/pivotCacheDefinition${idx}.xml`, cacheXml);
    zip.file(`xl/pivotTables/pivotTable${idx}.xml`, pivotXml);
    newParts.push(`xl/pivotCache/pivotCacheDefinition${idx}.xml`);
    newParts.push(`xl/pivotTables/pivotTable${idx}.xml`);
  }

  // Charts (group by dashboard sheet so each dash sheet gets one drawing file)
  // injectCharts mutates newParts directly; no need to push the return value again
  await injectCharts(zip, chartMeta, newParts);

  // workbook.xml.rels
  const wbRelsSrc = await readStr(zip, "xl/_rels/workbook.xml.rels") ?? "";
  const { src: newWbRels, cacheRids } = updateWorkbookRels(wbRelsSrc, pivotMeta.length);
  zip.file("xl/_rels/workbook.xml.rels", newWbRels);

  // workbook.xml
  const wbSrc = await readStr(zip, "xl/workbook.xml") ?? "";
  zip.file("xl/workbook.xml", updateWorkbookXml(wbSrc, cacheRids));

  // [Content_Types].xml
  const ctSrc = await readStr(zip, "[Content_Types].xml") ?? "";
  zip.file("[Content_Types].xml", updateContentTypes(ctSrc, newParts));

  // Sheet _rels → pivot tables
  await attachPivotTables(zip, pivotMeta);

  return zip.generateAsync({ type: "nodebuffer", compression: "DEFLATE" }) as Promise<Buffer>;
}

// ---------------------------------------------------------------------------
// Chart injection
// ---------------------------------------------------------------------------

async function injectCharts(
  zip: JSZip,
  chartMeta: ChartMeta[],
  newParts: string[],
): Promise<string[]> {
  const added: string[] = [];

  // Group charts by dashboard sheet; each dashboard sheet gets one drawing file
  const sheetMap = await buildSheetMap(zip);

  // dashSheetTitle → { drawingIdx, anchors, rels }
  type SheetDrawing = {
    drawingIdx: number;
    anchors: DrawingAnchor[];
    rels: Array<{ rId: string; chartFile: string }>;
  };
  const bySheet = new Map<string, SheetDrawing>();
  let drawingCounter = 1;
  let globalChartCounter = 1;

  for (const cm of chartMeta) {
    if (cm.graphType === "text") continue;

    // Skip tiles that would produce 0 series — empty <c:barChart> etc. is invalid OOXML
    const hasCategories = Boolean(cm.xAxis);
    const numMeas = cm.numHeaders - (hasCategories ? 1 : 0);
    if (numMeas <= 0) continue;

    const dashTitle = cm.dashSheetTitle;
    if (!bySheet.has(dashTitle)) {
      bySheet.set(dashTitle, {
        drawingIdx: drawingCounter++,
        anchors: [],
        rels: [],
      });
    }
    const sd = bySheet.get(dashTitle)!;
    const chartIdx = globalChartCounter++;
    const chartFile = `xl/charts/chart${chartIdx}.xml`;

    // Build chart XML — cell refs point at the hidden DATA sheet
    const chartXml = buildChartXml({
      graphType:    cm.graphType,
      title:        cm.tileTitle,
      sheetTitle:   cm.dataSheetTitle,
      hdrRow:       cm.hdrRow,
      anchorCol:    cm.anchorCol,
      numHeaders:   cm.numHeaders,
      dataStart:    cm.dataStart,
      dataEnd:      cm.dataEnd,
      hasCategories,
    });
    zip.file(chartFile, chartXml);
    newParts.push(chartFile);
    added.push(chartFile);

    // Drawing anchor uses pre-computed 0-based coordinates from ExcelService
    const rId = `rId${sd.rels.length + 1}`;
    sd.anchors.push({
      rId,
      name: `Chart ${chartIdx}`,
      cId:  sd.anchors.length + 2,  // id=1 is reserved; charts start at 2
      fromCol: cm.chartFromCol,
      fromRow: cm.chartFromRow,
      toCol:   cm.chartToCol,
      toRow:   cm.chartToRow,
    });
    sd.rels.push({ rId, chartFile: `../charts/chart${chartIdx}.xml` });
  }

  // Write drawing files and link them to dashboard sheets
  for (const [dashTitle, sd] of bySheet) {
    const drawingPath = `xl/drawings/drawing${sd.drawingIdx}.xml`;
    const drawingRels = `xl/drawings/_rels/drawing${sd.drawingIdx}.xml.rels`;
    const drawingXml  = buildDrawingXml(sd.anchors);
    const relsXml     = buildDrawingRelsXml(sd.rels);

    zip.file(drawingPath, drawingXml);
    zip.file(drawingRels, relsXml);
    // drawingRels (_rels file) must NOT enter newParts — _rels have no content type
    added.push(drawingPath);
    newParts.push(drawingPath);

    // Attach drawing to the dashboard sheet
    const sheetKey = sheetMap.get(dashTitle);
    if (!sheetKey) continue;

    const sheetNum = sheetKey.match(/sheet(\d+)\.xml$/)?.[1] ?? "1";
    const sheetRelsKey = `xl/worksheets/_rels/sheet${sheetNum}.xml.rels`;

    let relsSrc = await readStr(zip, sheetRelsKey) ?? "";
    if (!relsSrc.trim()) {
      relsSrc = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="${PKG_NS}"></Relationships>`;
    }
    relsSrc = relsSrc.replace(/(<Relationships\b[^>]*)\/>/g, "$1></Relationships>");

    if (!relsSrc.includes(drawingPath.replace("xl/", "../"))) {
      const rid = `rId${nextRid(relsSrc)}`;
      relsSrc = relsSrc.replace(
        "</Relationships>",
        `<Relationship Id="${rid}" Type="${DRW_REL}" Target="../drawings/drawing${sd.drawingIdx}.xml"/></Relationships>`,
      );

      // Add <drawing r:id="..."/> to the sheet XML itself
      let sheetSrc = await readStr(zip, sheetKey) ?? "";
      if (sheetSrc && !sheetSrc.includes("<drawing")) {
        // Ensure xmlns:r is present
        if (!sheetSrc.includes("xmlns:r=")) {
          sheetSrc = sheetSrc.replace(
            "<worksheet ",
            `<worksheet xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" `,
          );
        }
        sheetSrc = sheetSrc.replace(
          "</worksheet>",
          `<drawing r:id="${rid}"/></worksheet>`,
        );
        zip.file(sheetKey, sheetSrc);
      }
    }

    zip.file(sheetRelsKey, relsSrc);
  }

  return added;
}

// ---------------------------------------------------------------------------
// Strip previous OLAP / chart parts (idempotent re-run support)
// ---------------------------------------------------------------------------

async function stripPreviousOlap(zip: JSZip): Promise<void> {
  const prefixes = ["xl/pivotTables/", "xl/pivotCache/", "xl/connections.xml",
                    "xl/charts/", "xl/drawings/", "xl/pivotCache/_rels/"];

  for (const name of Object.keys(zip.files)) {
    if (prefixes.some(p => name.startsWith(p) || name === p)) {
      zip.remove(name);
    }
  }

  // workbook.xml.rels
  const wbRels = await readStr(zip, "xl/_rels/workbook.xml.rels");
  if (wbRels) {
    zip.file(
      "xl/_rels/workbook.xml.rels",
      wbRels.replace(/<Relationship\b[^>]*\b(?:pivotCacheDefinition|connections)[^>]*\/>/g, ""),
    );
  }

  // workbook.xml
  const wb = await readStr(zip, "xl/workbook.xml");
  if (wb) {
    zip.file("xl/workbook.xml", wb.replace(/<pivotCaches>[\s\S]*?<\/pivotCaches>/g, ""));
  }

  // [Content_Types].xml
  const ct = await readStr(zip, "[Content_Types].xml");
  if (ct) {
    zip.file(
      "[Content_Types].xml",
      ct.replace(/<Override\b[^>]*\b(?:pivotTable|pivotCache|connections|chart|drawing)[^>]*\/>/g, ""),
    );
  }

  // Sheet _rels: remove pivotTable + drawing references
  for (const name of Object.keys(zip.files)) {
    if (/xl\/worksheets\/_rels\/sheet\d+\.xml\.rels$/.test(name)) {
      const src = await readStr(zip, name);
      if (src) {
        const cleaned = src
          .replace(/<Relationship\b[^>]*\/relationships\/pivotTable[^>]*\/>/g, "")
          .replace(/<Relationship\b[^>]*\/relationships\/drawing[^>]*\/>/g, "");
        zip.file(name, cleaned);
      }
    }
    // Remove <drawing> element from sheet XML
    if (/xl\/worksheets\/sheet\d+\.xml$/.test(name)) {
      const src = await readStr(zip, name);
      if (src) {
        zip.file(name, src.replace(/<drawing\b[^/]*\/>/g, ""));
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Attach pivot tables to sheet _rels
// ---------------------------------------------------------------------------

async function attachPivotTables(zip: JSZip, pivotMeta: PivotMeta[]): Promise<void> {
  const sheetMap = await buildSheetMap(zip);

  for (let i = 0; i < pivotMeta.length; i++) {
    const idx   = i + 1;
    const pt    = pivotMeta[i];
    const sheetKey = sheetMap.get(pt.dataSheetTitle);
    if (!sheetKey) continue;

    const sheetNum = sheetKey.match(/sheet(\d+)\.xml$/)?.[1] ?? "1";
    const relsKey  = `xl/worksheets/_rels/sheet${sheetNum}.xml.rels`;

    let relsSrc = await readStr(zip, relsKey) ?? "";
    if (!relsSrc.trim()) {
      relsSrc = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="${PKG_NS}"></Relationships>`;
    }
    relsSrc = relsSrc.replace(/(<Relationships\b[^>]*)\/>/g, "$1></Relationships>");

    if (!relsSrc.includes(`pivotTable${idx}.xml`)) {
      const rid = `rId${nextRid(relsSrc)}`;
      relsSrc = relsSrc.replace(
        "</Relationships>",
        `<Relationship Id="${rid}" Type="${PT_REL}" Target="../pivotTables/pivotTable${idx}.xml"/></Relationships>`,
      );
    }
    zip.file(relsKey, relsSrc);

    // pivotTable _rels → cacheDefinition
    zip.file(
      `xl/pivotTables/_rels/pivotTable${idx}.xml.rels`,
      `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
      `<Relationships xmlns="${PKG_NS}">` +
      `<Relationship Id="rId1" Type="${CACHE_REL}" Target="../pivotCache/pivotCacheDefinition${idx}.xml"/>` +
      `</Relationships>`,
    );
  }
}

// ---------------------------------------------------------------------------
// workbook.xml.rels
// ---------------------------------------------------------------------------

function updateWorkbookRels(
  src: string,
  numPivots: number,
): { src: string; cacheRids: Map<number, string> } {
  const cacheRids = new Map<number, string>();
  let nextId = nextRid(src);
  const inserts: string[] = [];

  for (let idx = 1; idx <= numPivots; idx++) {
    const target = `pivotCache/pivotCacheDefinition${idx}.xml`;
    if (!src.includes(target)) {
      const rid = `rId${nextId++}`;
      cacheRids.set(idx, rid);
      inserts.push(
        `<Relationship Id="${rid}" Type="${CACHE_REL}" Target="${target}"/>`,
      );
    }
  }

  if (!src.includes("connections.xml")) {
    inserts.push(
      `<Relationship Id="rId${nextId++}" Type="${CONN_REL}" Target="connections.xml"/>`,
    );
  }

  if (inserts.length) {
    src = src.replace("</Relationships>", inserts.join("") + "</Relationships>");
  }
  return { src, cacheRids };
}

// ---------------------------------------------------------------------------
// workbook.xml
// ---------------------------------------------------------------------------

function updateWorkbookXml(src: string, cacheRids: Map<number, string>): string {
  if (!src || cacheRids.size === 0) return src;
  if (src.includes("<pivotCaches")) return src;

  const rNs = "http://schemas.openxmlformats.org/officeDocument/2006/relationships";
  const entries = [...cacheRids.entries()]
    .sort(([a], [b]) => a - b)
    .map(([idx, rid]) => `<pivotCache cacheId="${idx - 1}" r:id="${rid}"/>`)
    .join("");

  if (!src.includes("xmlns:r=")) {
    src = src.replace("<workbook ", `<workbook xmlns:r="${rNs}" `);
  }
  return src.replace("</workbook>", `<pivotCaches>${entries}</pivotCaches></workbook>`);
}

// ---------------------------------------------------------------------------
// [Content_Types].xml
// ---------------------------------------------------------------------------

const CONTENT_TYPES: Record<string, string> = {
  pivotCacheDefinition: "application/vnd.openxmlformats-officedocument.spreadsheetml.pivotCacheDefinition+xml",
  pivotTable:           "application/vnd.openxmlformats-officedocument.spreadsheetml.pivotTable+xml",
  connections:          "application/vnd.openxmlformats-officedocument.spreadsheetml.connections+xml",
  chart:                "application/vnd.openxmlformats-officedocument.drawingml.chart+xml",
  drawing:              "application/vnd.openxmlformats-officedocument.drawing+xml",
};

function updateContentTypes(src: string, newParts: string[]): string {
  const inserts: string[] = [];
  for (const part of newParts) {
    const partName = "/" + part;
    if (src.includes(partName)) continue;
    for (const [key, mime] of Object.entries(CONTENT_TYPES)) {
      if (part.includes(key)) {
        inserts.push(`<Override PartName="${partName}" ContentType="${mime}"/>`);
        break;
      }
    }
  }
  if (inserts.length) {
    src = src.replace("</Types>", inserts.join("") + "</Types>");
  }
  return src;
}

// ---------------------------------------------------------------------------
// Sheet map  (sheetTitle → "xl/worksheets/sheetN.xml")
// ---------------------------------------------------------------------------

async function buildSheetMap(zip: JSZip): Promise<Map<string, string>> {
  const wbXml   = await readStr(zip, "xl/workbook.xml") ?? "";
  const relsXml = await readStr(zip, "xl/_rels/workbook.xml.rels") ?? "";
  const map = new Map<string, string>();

  for (const m of wbXml.matchAll(/<sheet\b([^>]+)>/g)) {
    const attrs   = m[1];
    const nameM   = attrs.match(/\bname="([^"]+)"/);
    const ridM    = attrs.match(/\br:id="([^"]+)"/);
    if (!nameM || !ridM) continue;

    const rid     = ridM[1];
    const targetM =
      relsXml.match(new RegExp(`<Relationship\\b[^>]*\\bId="${rid}"[^>]*\\bTarget="([^"]+)"`)) ??
      relsXml.match(new RegExp(`<Relationship\\b[^>]*\\bTarget="([^"]+)"[^>]*\\bId="${rid}"`));

    if (targetM) {
      const target = targetM[1].replace(/^\//, "");
      map.set(nameM[1], target.startsWith("xl/") ? target : `xl/${target}`);
    }
  }
  return map;
}

// ---------------------------------------------------------------------------
// Utility
// ---------------------------------------------------------------------------

async function readStr(zip: JSZip, name: string): Promise<string | undefined> {
  return zip.file(name)?.async("string");
}

// Re-export colLetter for use in ExcelService
export { colLetter };
