/**
 * OOXML builders for OLAP pivot cache definitions, pivot table definitions,
 * and the xl/connections.xml connection descriptor.
 *
 * Matches the structure produced by Excel when connecting to an XMLA/MDX
 * OLAP source (validated against correct.xlsx reference workbook).
 */
import { xmlAttr } from "./xmlHelpers.js";
import type { HierarchyInfo } from "./types.js";

const SPREADSHEET_NS =
  "http://schemas.openxmlformats.org/spreadsheetml/2006/main";

// ---------------------------------------------------------------------------
// connections.xml
// ---------------------------------------------------------------------------

export function buildConnectionsXml(
  connString: string,
  connectionName: string,
  catalog: string,
): string {
  return (
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
    `<connections xmlns="${SPREADSHEET_NS}">` +
    `<connection id="1" name="${xmlAttr(connectionName)}" ` +
    `type="5" refreshedVersion="8" background="1">` +
    `<dbPr connection="${xmlAttr(connString)}" ` +
    `command="${xmlAttr(catalog)}" commandType="1"/>` +
    `<olapPr sendLocale="1" rowDrillCount="1000"/>` +
    `</connection>` +
    `</connections>`
  );
}

// ---------------------------------------------------------------------------
// pivotCacheDefinition
// ---------------------------------------------------------------------------

/**
 * Build a pivotCacheDefinition XML for an OLAP external connection.
 *
 * Key constraints validated against correct.xlsx (real Excel XMLA workbook):
 *   - No r:id attribute — OLAP caches with saveData="0" have no pivotCacheRecords
 *   - createdVersion / refreshedVersion must be "8" (Excel 2016+)
 *   - cacheHierarchies count must equal pivotHierarchies count in the pivot table
 *   - dimensions count must equal (1 + number of non-measure hierarchies)
 */
export function buildCacheDefXml(
  hierarchies: HierarchyInfo[],
  modelName: string,
  _measures: string[],
): string {
  // No r:id: OLAP connections with saveData="0" do not have a pivotCacheRecords file.
  const header =
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
    `<pivotCacheDefinition xmlns="${SPREADSHEET_NS}" ` +
    `xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" ` +
    `saveData="0" backgroundQuery="1" ` +
    `createdVersion="8" refreshedVersion="8" minRefreshableVersion="3" ` +
    `recordCount="0">`;

  // When model metadata is unavailable, emit the minimal valid OLAP cache definition.
  // Extra elements like <dimensions> or <cacheHierarchies> must be consistent with each
  // other; mismatched counts cause the "Data store" repair error in Excel.
  if (hierarchies.length === 0) {
    return (
      header +
      `<cacheSource type="external" connectionId="1"/>` +
      `<cacheFields count="0"/>` +
      `</pivotCacheDefinition>`
    );
  }

  // Full definition when model hierarchies are known
  const dims = hierarchies.filter(h => !h.isMeasure);
  const meas = hierarchies.filter(h => h.isMeasure);
  const groupName = modelName.split(".").pop()!;

  const hierParts = hierarchies.map(h =>
    h.isMeasure
      ? `<cacheHierarchy uniqueName="${xmlAttr(h.uniqueName)}" ` +
        `caption="${xmlAttr(h.caption)}" ` +
        `measure="1" displayFolder="${xmlAttr(h.displayFolder)}" ` +
        `measureGroup="${xmlAttr(h.measureGroup ?? "")}" count="0"/>`
      : `<cacheHierarchy uniqueName="${xmlAttr(h.uniqueName)}" ` +
        `caption="${xmlAttr(h.caption)}" ` +
        `defaultMemberUniqueName="${xmlAttr(h.defaultMemberUniqueName ?? "")}" ` +
        `allUniqueName="${xmlAttr(h.allUniqueName ?? "")}" ` +
        `dimensionUniqueName="${xmlAttr(h.dimensionUniqueName ?? "")}" ` +
        `displayFolder="${xmlAttr(h.displayFolder)}" ` +
        `count="0" unbalanced="0"/>`,
  );
  const cacheHierXml =
    `<cacheHierarchies count="${hierarchies.length}">${hierParts.join("")}</cacheHierarchies>`;

  const dimParts = [
    `<dimension measure="1" name="Measures" uniqueName="[Measures]" caption="Measures"/>`,
    ...dims.map(h => {
      const dimName = (h.dimensionUniqueName ?? "").replace(/^\[|\]$/g, "");
      return `<dimension name="${xmlAttr(dimName)}" uniqueName="${xmlAttr(h.dimensionUniqueName ?? "")}" caption="${xmlAttr(dimName)}"/>`;
    }),
  ];
  const dimsXml = `<dimensions count="${dimParts.length}">${dimParts.join("")}</dimensions>`;
  const mgXml = meas.length > 0
    ? `<measureGroups count="1"><measureGroup name="${xmlAttr(groupName)}" caption="${xmlAttr(groupName)}"/></measureGroups>`
    : "";
  const mapParts = dims.map((_, i) => `<map measureGroup="0" dimension="${i + 1}"/>`);
  const mapsXml = dims.length > 0
    ? `<maps count="${dims.length}">${mapParts.join("")}</maps>`
    : "";

  return (
    header +
    `<cacheSource type="external" connectionId="1"/>` +
    `<cacheFields count="0"/>` +
    cacheHierXml +
    `<kpis count="0"/>` +
    dimsXml +
    mgXml +
    mapsXml +
    `</pivotCacheDefinition>`
  );
}

// ---------------------------------------------------------------------------
// pivotTableDefinition
// ---------------------------------------------------------------------------

/**
 * Build a pivotTableDefinition XML matching correct.xlsx OLAP structure.
 *
 * For OLAP connections, only location + pivotHierarchies + pivotTableStyleInfo
 * are needed. pivotFields / rowFields / dataFields are NOT used (they reference
 * cacheFields indices which don't exist when cacheFields count="0").
 *
 * Attributes match exactly what Excel 2016+ writes for an OLAP pivot table:
 * createdVersion="8", outline="1", outlineData="1", etc.
 *
 * Element order per OOXML schema:
 *   location → pivotHierarchies → pivotTableStyleInfo
 */
export function buildPivotTableXml(
  tileTitle: string,
  cacheId: number,
  anchorCol: number,
  hdrRow: number,
  measures: string[],
  hierarchies: HierarchyInfo[],
  xaxisUnique: string | undefined,
): string {
  const nHier = hierarchies.length;

  // ---- location ----
  const locXml =
    `<location ref="${colLetter(anchorCol)}${hdrRow}" ` +
    `firstHeaderRow="1" firstDataRow="1" firstDataCol="0"/>`;

  // ---- pivotHierarchies ----
  // Measures get dragToData="1"; dimensions get plain <pivotHierarchy/>.
  // Note: rowFields/colFields/dataFields cannot be pre-populated for OLAP
  // pivot tables with saveData="0" — Excel requires cached item lists
  // (rowItems/colItems/pivotItems) which don't exist without saved data.
  // Data is supplied by CUBE function formulas in rows 2–11 instead.
  const phParts = hierarchies.map(h =>
    h.isMeasure
      ? `<pivotHierarchy dragToRow="0" dragToCol="0" dragToPage="0" dragToData="1"/>`
      : `<pivotHierarchy/>`,
  );
  const pivotHierXml = nHier > 0
    ? `<pivotHierarchies count="${nHier}">${phParts.join("")}</pivotHierarchies>`
    : "";

  // Suppress unused-parameter warnings; parameters kept for API compatibility.
  void measures; void xaxisUnique;

  // When hierarchies are unknown (model not found), use compact="0" outline="0"
  // to avoid the "PivotTable view" repair error Excel raises when outline mode
  // is set on a table that has no field definitions.
  const outlineAttrs = nHier > 0
    ? `indent="0" outline="1" outlineData="1" multipleFieldFilters="0" fieldListSortAscending="1"`
    : `compact="0" outline="0"`;

  return (
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
    `<pivotTableDefinition xmlns="${SPREADSHEET_NS}" ` +
    `name="${xmlAttr(tileTitle)}" cacheId="${cacheId}" ` +
    `applyNumberFormats="0" applyBorderFormats="0" applyFontFormats="0" ` +
    `applyPatternFormats="0" applyAlignmentFormats="0" applyWidthHeightFormats="1" ` +
    `dataCaption="Values" updatedVersion="8" minRefreshableVersion="3" ` +
    `useAutoFormatting="1" itemPrintTitles="1" createdVersion="8" ` +
    outlineAttrs + `>` +
    locXml +
    pivotHierXml +
    `<pivotTableStyleInfo name="PivotStyleMedium9" ` +
    `showRowHeaders="1" showColHeaders="1" showRowStripes="0" ` +
    `showColStripes="0" showLastColumn="1"/>` +
    `</pivotTableDefinition>`
  );
}

// ---------------------------------------------------------------------------
// Local helpers (not exported)
// ---------------------------------------------------------------------------

function colLetter(n: number): string {
  let result = "";
  while (n > 0) {
    const rem = (n - 1) % 26;
    result = String.fromCharCode(65 + rem) + result;
    n = Math.floor((n - 1) / 26);
  }
  return result;
}
