/**
 * ExcelService
 *
 * Generates an Excel workbook (.xlsx) from namespace / model / connection data.
 *
 * Architecture:
 *   - One visible DASHBOARD SHEET per dashboard
 *   - CUBE formula data sections live in far-right columns of each dashboard sheet
 *     (rows 1-11: header + 10 data rows), invisible during normal scrolling
 *   - Charts and KPI formulas on the dashboard reference those same-sheet data cells
 *
 * Uses ExcelJS for workbook structure and JSZip (via olapInjector) for OOXML
 * pivot-table and chart XML injection. No Python dependency.
 */
import ExcelJS from "exceljs";
import fs from "fs";
import path from "path";
import { ServiceProvider } from "./ServiceProvider.js";
import { injectOlap } from "./excel/olapInjector.js";
import { colLetter } from "./excel/xmlHelpers.js";
import type { PivotMeta, ChartMeta, ExcelGenerateParams } from "./excel/types.js";
import { extractModelHierarchies, resolveXaxisUnique, getModelObj, levelForGranularity } from "./excel/modelHierarchies.js";

export type { ExcelGenerateParams };

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const HEADER_COLOR = "FF1F3864";
const TITLE_COLOR = "FF2E74B5";
const TITLE_BG = "FFD6E4F0";
const KPI_VALUE_BG = "FFEEF4FB";

const LEFT_COL = 2;    // first tile column (1-based, column B)
const TILE_W = 9;    // columns wide per tile
const TILE_GAP = 1;    // gap columns between tiles
const TILE_COL_STEP = TILE_W + TILE_GAP;   // 10 columns per tile slot

const CHART_HEIGHT_ROWS = 14;  // rows tall for a chart drawing
const CHART_TILE_H = 1 + CHART_HEIGHT_ROWS + 1;  // title + chart + gap = 16
const TEXT_TILE_H = 5;   // rows for a KPI text tile
const CAT_HEADER_H = 2;   // rows for a category section header

// ---------------------------------------------------------------------------
// Service
// ---------------------------------------------------------------------------

export class ExcelService extends ServiceProvider {
  name = "excel";

  async generate(params: ExcelGenerateParams): Promise<void> {
    const { namespace, models, connections, connectionName, targetFile } = params;

    // ------------------------------------------------------------------
    // Resolve connection details
    // ------------------------------------------------------------------
    const connMap = (connections as Record<string, unknown>)["connections"] as
      | Record<string, unknown>
      | undefined;
    const connection = connMap?.[connectionName] as Record<string, unknown> | undefined;
    if (!connection) {
      throw new Error(`Connection '${connectionName}' not found in connection file`);
    }

    const mdxConn = (connection["mdx"] ?? {}) as Record<string, unknown>;
    let mdxUrl = ((mdxConn["url"] as string | undefined) ?? "").replace(/\/$/, "");
    const orgId = (mdxConn["organization_id"] as string | undefined) ?? "default";
    const catalog = (mdxConn["catalog_name"] as string | undefined) ?? "";
    const users = ((connections as Record<string, unknown>)["users"] ?? {}) as
      Record<string, unknown>;
    const userKey = (mdxConn["user"] as string | undefined) ?? "admin";
    const userObj = (users[userKey] ?? {}) as Record<string, unknown>;
    const username = (userObj["username"] as string | undefined) ?? userKey;
    const password = (userObj["password"] as string | undefined) ?? "";

    let xmlaUrl: string;
    let connString: string;
    if (connection["installer"]) {
      if (!/:\d+/.test(mdxUrl.split("//")[1] ?? "")) {
        mdxUrl = `${mdxUrl}:10502`;
      }
      xmlaUrl = `${mdxUrl}/xmla/${orgId}`;
      connString =
        `Provider=MSOLAP.8;` +
        `Data Source=${xmlaUrl};` +
        `Initial Catalog=${catalog};` +
        `User ID=${username};` +
        `Password=${password};` +
        `Persist Security Info=True;`;
    } else {
      // Non-installer (cloud/container) connections: mdx.url may be either the
      // bare host or may already carry the /engine/xmla suffix (connections.yaml
      // entries are inconsistent on this) — add it only if missing. The
      // org-specific path segment beyond that is the connecting user's own
      // token, not something derivable from the URL or org id.
      const base = /\/engine\/xmla(\/|$)/i.test(mdxUrl) ? mdxUrl : `${mdxUrl}/engine/xmla`;
      const userToken = (userObj["token"] as string | undefined) ?? "";
      xmlaUrl = userToken ? `${base}/${userToken}` : base;
      // Explicit User ID/Password authenticates as the configured connections.yaml
      // service account (e.g. demo2_admin), not the interactive Windows/SSO user.
      // Integrated Security=SSPI authenticates as whichever account is currently
      // logged into Windows/Excel instead — which matters because AtScale's
      // row-level security is keyed by user identity, and the interactive user
      // may be subject to RLS restrictions the service account is not.
      connString =
        `Provider=MSOLAP.8;` +
        `Persist Security Info=True;` +
        `Initial Catalog=${catalog};` +
        `Data Source=${xmlaUrl};` +
        `User ID=${username};` +
        `Password=${password};` +
        `MDX Compatibility=1;` +
        `Safety Options=2;` +
        `MDX Missing Member Mode=Error;` +
        `Update Isolation Level=2;`;
    }

    // ------------------------------------------------------------------
    // Collect data
    // ------------------------------------------------------------------
    const wb = new ExcelJS.Workbook();
    const worksheets = (namespace["worksheets"] ?? {}) as Record<string, unknown>;
    const dashboards = (namespace["dashboards"] ?? {}) as Record<string, unknown>;

    const pivotMeta: PivotMeta[] = [];
    const chartMeta: ChartMeta[] = [];

    // ------------------------------------------------------------------
    // Pass 1: collect unique worksheet definitions across all dashboards
    // ------------------------------------------------------------------
    const wsDefsUsed = new Map<string, Record<string, unknown>>();

    for (const dashboard of Object.values(dashboards)) {
      const tiles = ((dashboard as Record<string, unknown>)["tiles"] ?? []) as unknown[];
      for (const tile of tiles) {
        const wsName = (tile as Record<string, unknown>)["worksheet"] as string | undefined;
        if (!wsName || !worksheets[wsName]) continue;
        if (!wsDefsUsed.has(wsName)) {
          wsDefsUsed.set(wsName, worksheets[wsName] as Record<string, unknown>);
        }
      }
    }

    // ------------------------------------------------------------------
    // Pass 2: create visible dashboard sheets.
    //
    // Each dashboard sheet contains:
    //   - visible tile grid (banner, category headers, tile title + chart/KPI)
    //   - data sections in far-right columns (rows 1–11: headers + CUBE formulas)
    //
    // Charts and KPI cells on the dashboard reference those same-sheet data cells
    // directly — no hidden per-worksheet data sheets are needed.
    // ------------------------------------------------------------------
    const modelsPivotAdded = new Set<string>();
    const modelsWarnedMissing = new Set<string>();

    for (const [dashName, dashboard] of Object.entries(dashboards)) {
      const dash = dashboard as Record<string, unknown>;
      const tiles = (dash["tiles"] ?? []) as unknown[];
      if (!tiles.length) continue;

      const hSegments = ((dash["size"] as Record<string, unknown> | undefined)?.["hSegments"] as number | undefined) ?? 2;
      const catHeaders = (dash["categoryHeaders"] ?? []) as Array<Record<string, unknown>>;

      const dashSheetTitle = safeName(dashName);
      const dashWs = wb.addWorksheet(dashSheetTitle, {
        views: [{ showGridLines: false }],
      });

      // Banner row
      const bannerEndCol = LEFT_COL + hSegments * TILE_COL_STEP - 1;
      dashWs.getRow(1).height = 28;
      for (let col = LEFT_COL; col <= bannerEndCol; col++) {
        dashWs.getCell(1, col).fill = solidFill(HEADER_COLOR);
      }
      const bannerCell = dashWs.getCell(1, LEFT_COL);
      bannerCell.value = (dash["title"] as string | undefined) ?? dashName;
      bannerCell.font = { bold: true, size: 15, color: { argb: "FFFFFFFF" } };
      bannerCell.alignment = { vertical: "middle" };
      dashWs.mergeCells(1, LEFT_COL, 1, bannerEndCol);

      // Build sorted event list: category headers + tiles, ordered by y
      type LayoutEvent =
        | { kind: "header"; y: number; label: string }
        | { kind: "tile"; y: number; x: number; wsName: string };

      const events: LayoutEvent[] = [
        ...catHeaders.map(ch => ({
          kind: "header" as const,
          y: (ch["y"] as number) ?? 0,
          label: (ch["label"] as string) ?? "",
        })),
        ...tiles.flatMap(tile => {
          const t = tile as Record<string, unknown>;
          const wsName = t["worksheet"] as string | undefined;
          if (!wsName || !wsDefsUsed.has(wsName)) return [];
          return [{
            kind: "tile" as const,
            y: (t["y"] as number) ?? 0,
            x: (t["x"] as number) ?? 0,
            wsName,
          }];
        }),
      ].sort((a, b) => a.y !== b.y ? a.y - b.y : (
        a.kind === "header" ? -1 : b.kind === "header" ? 1 :
          (a as { x: number }).x - (b as { x: number }).x
      ));

      // Group by y, keeping order
      const groups: Map<number, LayoutEvent[]> = new Map();
      for (const e of events) {
        if (!groups.has(e.y)) groups.set(e.y, []);
        groups.get(e.y)!.push(e);
      }

      // Data sections: one column block per unique worksheet on this dashboard.
      // Placed at far-right columns (starting 3 past the tile grid), rows 1-11.
      // Row 1 = column headers; rows 2-11 = CUBE formula data.
      type DataSection = { dataCol: number; measureUniques: string[]; numFmt: string | null };
      const wsDataSections = new Map<string, DataSection>();
      let nextDataCol = bannerEndCol + 3;

      let currentRow = 3;

      for (const [, group] of Array.from(groups.entries())) {
        const headerEvents = group.filter(e => e.kind === "header");
        const tileEvents = group.filter(e => e.kind === "tile") as
          Array<{ kind: "tile"; y: number; x: number; wsName: string }>;

        // Category section headers
        for (const h of headerEvents) {
          dashWs.getRow(currentRow).height = 20;
          const hCell = dashWs.getCell(currentRow, LEFT_COL);
          hCell.value = h.label;
          hCell.font = { bold: true, size: 11, color: { argb: "FFFFFFFF" } };
          hCell.fill = solidFill(HEADER_COLOR);
          hCell.alignment = { horizontal: "left", vertical: "middle" };
          dashWs.mergeCells(currentRow, LEFT_COL, currentRow, bannerEndCol);
          currentRow += CAT_HEADER_H;
        }

        if (tileEvents.length === 0) continue;

        // Determine row height for this tile row
        const hasChart = tileEvents.some(te => {
          const wsDef = wsDefsUsed.get(te.wsName);
          return wsDef && (wsDef["graphType"] as string) !== "text";
        });
        const tileRowH = hasChart ? CHART_TILE_H : TEXT_TILE_H;

        // Resolve x positions: deduplicate so no two tiles in a row share a column.
        // Tiles are already sorted by x; any collision (including default x=0) gets
        // bumped to the next available slot.
        const usedX = new Set<number>();
        const resolvedX = tileEvents.map(te => {
          let x = te.x;
          while (usedX.has(x)) x++;
          usedX.add(x);
          return x;
        });

        for (let tileIdx = 0; tileIdx < tileEvents.length; tileIdx++) {
          const te = tileEvents[tileIdx];
          const resolvedXVal = resolvedX[tileIdx];
          const wsDef = wsDefsUsed.get(te.wsName)!;
          const graphType = (wsDef["graphType"] as string | undefined) ?? "bar";
          const tileTitle = (wsDef["title"] as string | undefined) ?? te.wsName;
          const xAxis = wsDef["xAxis"] as string | undefined;
          const measRaw = (wsDef["measures"] as string[] | undefined) ?? [];
          const yAxis = wsDef["yAxis"] as string | undefined;
          const modelName = (wsDef["model"] as string | undefined) ?? "";
          const measures = measRaw.length > 0 ? measRaw : (yAxis ? [yAxis] : []);
          const headers = [...(xAxis ? [xAxis] : []), ...measures];
          const numFmt = toExcelNumFmt((wsDef["format"] as string | undefined) ?? "");

          const anchorCol = LEFT_COL + resolvedXVal * TILE_COL_STEP;

          // Ensure data section exists for this worksheet on the dashboard sheet
          if (!wsDataSections.has(te.wsName)) {
            const hierarchies = extractModelHierarchies(models, modelName);
            if (hierarchies.length === 0) modelsWarnedMissing.add(modelName);
            const modelObj = getModelObj(models, modelName);
            const xaxisUnique = resolveXaxisUnique(xAxis, modelObj, hierarchies);
            const measureUniques = measures.map(m =>
              hierarchies.find(h => h.isMeasure && (
                h.uniqueName === `[Measures].[${m}]` ||
                h.caption === m ||
                h.uniqueName.endsWith(`].[${m}]`)
              ))?.uniqueName,
            ).filter((u): u is string => Boolean(u));

            const dataCol = nextDataCol;
            nextDataCol += headers.length;

            // Row 1: column headers
            for (let i = 0; i < headers.length; i++) {
              dashWs.getCell(1, dataCol + i).value = headers[i];
            }

            // Rows 2-11: CUBE formulas
            if (xaxisUnique && measureUniques.length > 0) {
              // Chart tile: dimension members in first column, measure values in subsequent columns.
              // Use xAxisGranularity to select the appropriate hierarchy level (e.g. "week" → Week level).
              // Falls back to the leaf level, then bare Members if neither is available.
              const xaxisHier = hierarchies.find(h => h.uniqueName === xaxisUnique);
              const xAxisGranularity = wsDef["xAxisGranularity"] as string | undefined;
              const leafLevel = xaxisHier?.leafLevelName ?? null;
              // xAxis itself may name one specific level within a shared,
              // multi-level hierarchy (e.g. "Order Custom Year" inside the
              // "Order Custom PP445" hierarchy). When it does, that's the
              // authoritative level — it takes priority over granularity
              // matching or the leaf-level fallback, both of which would
              // otherwise pick the wrong (usually finer-grained) level.
              const xAxisLower = (xAxis ?? "").toLowerCase();
              const exactXAxisLevel = xaxisHier?.levels.find(
                l => l.caption.toLowerCase() === xAxisLower || l.queryName.toLowerCase() === xAxisLower,
              )?.queryName ?? null;
              // Find the hierarchy level that matches the granularity (case-insensitive substring).
              // Only uses levels that actually exist in the model; falls back to leaf level.
              const granLevel = xAxisGranularity && xaxisHier
                ? levelForGranularity(xaxisHier, xAxisGranularity)
                : null;
              const levelToUse = exactXAxisLevel ?? granLevel ?? leafLevel;
              const setExpr = levelToUse
                ? `${xaxisUnique}.[${levelToUse}].Members`
                : `${xaxisUnique}.Members`;

              // Define the set once via CUBESET and have every CUBERANKEDMEMBER
              // call reference that cell, rather than re-passing the raw set
              // expression string on each of the 10 rank calls. This is
              // Microsoft's documented pattern for CUBE-function dashboards and
              // is more reliable against third-party MDX providers than
              // repeated inline set expressions. Row 12 (just below the 10 data
              // rows) is otherwise unused within this data section's columns.
              const setCellRow = 12;
              const setCellRef = colLetter(dataCol) + setCellRow;
              dashWs.getCell(setCellRow, dataCol).value = {
                formula: `CUBESET("${connectionName}","${setExpr}","${xAxis ?? ""}")`,
              };

              // Rank from the END of the set (negative rank = count back from
              // the last member, per CUBERANKEDMEMBER's documented behavior)
              // so trend charts show the most recent 10 periods rather than
              // the first 10. Wide date dimensions (e.g. TPC-DS benchmark
              // models) often pad back a century or more before real fact
              // data begins, so "first 10" silently lands on empty history.
              // Row 2 → rank -10 (oldest of the last 10), row 11 → rank -1
              // (most recent), keeping the displayed order chronological.
              for (let r = 2; r <= 11; r++) {
                dashWs.getCell(r, dataCol).value = {
                  formula: `CUBERANKEDMEMBER("${connectionName}",${setCellRef},${r - 12})`,
                };
                for (let mi = 0; mi < measureUniques.length; mi++) {
                  const rankCellRef = colLetter(dataCol) + r;
                  const mc = dashWs.getCell(r, dataCol + 1 + mi);
                  mc.value = {
                    formula: `CUBEVALUE("${connectionName}","${measureUniques[mi]}",${rankCellRef})`,
                  };
                  if (numFmt) mc.numFmt = numFmt;
                }
              }
            } else if (measureUniques.length > 0) {
              // Text / KPI tile: grand total in first data cell
              const gc = dashWs.getCell(2, dataCol);
              gc.value = {
                formula: `CUBEVALUE("${connectionName}","${measureUniques[0]}")`,
              };
              if (numFmt) gc.numFmt = numFmt;
            }

            wsDataSections.set(te.wsName, { dataCol, measureUniques, numFmt });

            // One pivot table per unique model — placed on the _Connections sheet.
            // Skip when hierarchies are empty (model not found): an empty pivot table
            // triggers an Excel "Removed Feature" repair dialog on open.
            if (!modelsPivotAdded.has(modelName) && hierarchies.length > 0) {
              modelsPivotAdded.add(modelName);
              pivotMeta.push({
                dataSheetTitle: "_Connections",
                model: modelName,
                measures,
                xAxis,
                tileTitle,
                graphType,
                hdrRow: 15,
                dataStart: 16,
                dataEnd: 25,
                anchorCol: 1,
                numHeaders: headers.length,
              });
            }
          }

          const section = wsDataSections.get(te.wsName)!;

          // Tile title on dashboard
          dashWs.getRow(currentRow).height = 18;
          const titleCell = dashWs.getCell(currentRow, anchorCol);
          titleCell.value = tileTitle;
          titleCell.font = { bold: true, size: 11, color: { argb: TITLE_COLOR } };
          titleCell.fill = solidFill(TITLE_BG);
          titleCell.alignment = { horizontal: "left", vertical: "middle" };
          dashWs.mergeCells(currentRow, anchorCol, currentRow, anchorCol + TILE_W - 1);

          if (graphType === "text") {
            // KPI card: write the CUBEVALUE formula directly in the value cell
            const valueCell = dashWs.getCell(currentRow + 1, anchorCol);
            if (section.measureUniques.length > 0) {
              valueCell.value = {
                formula: `CUBEVALUE("${connectionName}","${section.measureUniques[0]}")`,
              };
            }
            if (section.numFmt) valueCell.numFmt = section.numFmt;
            valueCell.font = { bold: true, size: 20, color: { argb: TITLE_COLOR } };
            valueCell.fill = solidFill(KPI_VALUE_BG);
            valueCell.alignment = { horizontal: "center", vertical: "middle" };
            dashWs.getRow(currentRow + 1).height = 30;
            dashWs.mergeCells(currentRow + 1, anchorCol, currentRow + 1, anchorCol + TILE_W - 1);
          } else {
            // Chart tile: record anchor positions for olapInjector.
            // Title is at currentRow (1-based); chart drawing starts at row below it.
            // In 0-based (twoCellAnchor): fromRow = currentRow (= 1-based title row,
            // since chart begins at 1-based row currentRow+1 = 0-based row currentRow).
            const chartFromCol = anchorCol - 1;
            const chartFromRow = currentRow;       // 0-based
            const chartToCol = chartFromCol + TILE_W;
            const chartToRow = chartFromRow + CHART_HEIGHT_ROWS;

            chartMeta.push({
              dashSheetTitle,
              dataSheetTitle: dashSheetTitle,  // data section is on the dashboard sheet
              tileTitle,
              graphType,
              xAxis,
              hdrRow: 1,
              dataStart: 2,
              dataEnd: 11,
              anchorCol: section.dataCol,     // data section starting column
              numHeaders: headers.length,
              chartFromCol,
              chartFromRow,
              chartToCol,
              chartToRow,
            });
          }
        }

        currentRow += tileRowH;
      }

      // Footer
      const footerRow = currentRow + 1;
      const footerCell = dashWs.getCell(footerRow, 2);
      footerCell.value = "AtScale MDX endpoint";
      footerCell.font = { bold: true, size: 8, color: { argb: "FF808080" } };
      const endpointCell = dashWs.getCell(footerRow + 1, 2);
      endpointCell.value = xmlaUrl;
      endpointCell.font = { size: 8, color: { argb: "FFA0A0A0" } };
    }

    // Hidden connection reference sheet
    writeConnectionsSheet(wb, connectionName, connString, xmlaUrl, catalog, username);

    if (Object.keys(dashboards).length === 0) {
      console.warn("Warning: no dashboards found in namespace — workbook will be empty.");
    }

    if (pivotMeta.length === 0) {
      const missing = [...modelsWarnedMissing];
      throw new Error(
        `No OLAP pivot table could be generated. ` +
        (missing.length > 0
          ? `Model(s) not found in model file: ${missing.map(m => `"${m}"`).join(", ")}. ` +
          `Ensure the model file contains the model referenced in the namespace.`
          : `No worksheets with resolvable model metadata were found in the namespace.`),
      );
    }

    // ------------------------------------------------------------------
    // Save base workbook, then inject OLAP + charts via JSZip
    // ------------------------------------------------------------------
    const dir = path.dirname(targetFile);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

    // The connection's dbPr command/commandType="1" ("Cube") names the cube
    // Excel queries — this is the AtScale MODEL name, not the catalog
    // (a catalog/project can expose multiple cubes with different names).
    // Reusing catalog here caused "Excel cannot find OLAP cube <catalog>".
    const cubeName = pivotMeta[0].model;
    const rawBuffer = Buffer.from(await wb.xlsx.writeBuffer() as unknown as ArrayBuffer);
    const finalBuffer = await injectOlap(
      rawBuffer, pivotMeta, chartMeta, connString, cubeName, connectionName, models,
    );
    fs.writeFileSync(targetFile, finalBuffer);

    console.log(
      `Generating Excel workbook: ${pivotMeta.length} pivot table(s), ` +
      `${chartMeta.length} chart(s) → ${targetFile}`,
    );
  }
}

// ---------------------------------------------------------------------------
// Connection reference sheet (hidden)
// ---------------------------------------------------------------------------

function writeConnectionsSheet(
  wb: ExcelJS.Workbook,
  connectionName: string,
  connString: string,
  xmlaUrl: string,
  catalog: string,
  username: string,
): void {
  const cs = wb.addWorksheet("_Connections");
  cs.state = "hidden";

  cs.getCell("A1").value = "AtScale MDX Connection";
  cs.getCell("A1").font = { bold: true, size: 13 };

  const safeConnString = connString.replace(/Password=[^;]*/i, "Password=***");

  const rows: [string, string][] = [
    ["Connection Name", connectionName],
    ["XMLA Endpoint", xmlaUrl],
    ["Initial Catalog", catalog],
    ["User", username],
    ["Connection String", safeConnString],
    ["", ""],
    ["How to connect", "Excel ▶ Data ▶ Get Data ▶ From Other Sources ▶ From Analysis Services"],
    ["", `  Server: ${xmlaUrl}`],
    ["", `  Database (Catalog): ${catalog}`],
  ];

  rows.forEach(([k, v], i) => {
    cs.getCell(i + 3, 1).value = k;
    cs.getCell(i + 3, 1).font = { bold: true, size: 9 };
    cs.getCell(i + 3, 2).value = v;
    cs.getCell(i + 3, 2).font = { size: 9 };
  });

  cs.getColumn(1).width = 24;
  cs.getColumn(2).width = 90;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function safeName(name: string): string {
  return name.replace(/[/\\?*[\]:]/g, "-").substring(0, 31);
}

function solidFill(argb: string): ExcelJS.Fill {
  return { type: "pattern", pattern: "solid", fgColor: { argb } };
}

/**
 * Convert a namespace format string to an Excel number format code.
 *   integer      → #,##0
 *   decimal:N    → #,##0.000…  (N decimal places)
 *   percent:N    → 0.000…%
 *   currency:N   → $#,##0.000…
 * Returns null when the format string is empty or unrecognised.
 */
function toExcelNumFmt(format: string): string | null {
  if (!format) return null;
  const [kind, precStr] = format.split(":");
  const prec = precStr !== undefined ? Math.max(0, parseInt(precStr, 10) || 0) : 0;
  const dec = prec > 0 ? "." + "0".repeat(prec) : "";
  switch (kind) {
    case "integer": return "#,##0";
    case "decimal": return `#,##0${dec}`;
    case "percent": return `0${dec}%`;
    case "currency": return `$#,##0${dec}`;
    default: return null;
  }
}
