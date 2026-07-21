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
  cubeName: string,
): string {
  // commandType="1" ("Cube") — command must be the CUBE name Excel queries,
  // not the catalog/project name. A catalog can expose multiple cubes with
  // different names; reusing the catalog here produced Excel's "cannot find
  // OLAP cube <catalog>" error on refresh.
  return (
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
    `<connections xmlns="${SPREADSHEET_NS}">` +
    `<connection id="1" name="${xmlAttr(connectionName)}" ` +
    `type="5" refreshedVersion="8" background="1">` +
    `<dbPr connection="${xmlAttr(connString)}" ` +
    `command="${xmlAttr(cubeName)}" commandType="1"/>` +
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

  // A single dimension can have multiple hierarchies (e.g. "Date.Calendar" and
  // "Date.Fiscal" both under the "Date" dimension), so cacheHierarchies has one
  // entry per hierarchy while <dimensions> must have exactly one entry per
  // DISTINCT dimension. Building <dimensions> from every hierarchy instead of
  // deduplicating produced repeated uniqueName entries, which Excel silently
  // rejects — surfacing as a "PivotTable view" repair on open.
  const uniqueDimNames = [...new Set(dims.map(h => h.dimensionUniqueName ?? ""))];

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
    ...uniqueDimNames.map(dimUnique => {
      const dimName = dimUnique.replace(/^\[|\]$/g, "");
      return `<dimension name="${xmlAttr(dimName)}" uniqueName="${xmlAttr(dimUnique)}" caption="${xmlAttr(dimName)}"/>`;
    }),
  ];
  const dimsXml = `<dimensions count="${dimParts.length}">${dimParts.join("")}</dimensions>`;
  const mgXml = meas.length > 0
    ? `<measureGroups count="1"><measureGroup name="${xmlAttr(groupName)}" caption="${xmlAttr(groupName)}"/></measureGroups>`
    : "";
  const mapParts = uniqueDimNames.map((_, i) => `<map measureGroup="0" dimension="${i + 1}"/>`);
  const mapsXml = uniqueDimNames.length > 0
    ? `<maps count="${uniqueDimNames.length}">${mapParts.join("")}</maps>`
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
  // `ref` must describe the pivot table's FULL range, not just its top-left cell,
  // and firstHeaderRow/firstDataRow/firstDataCol are offsets that must resolve to
  // cells INSIDE that range. A single-cell ref (e.g. "A15") combined with
  // firstDataRow="1" points the data row at row 16 — outside the range — which
  // Excel rejects with a "PivotTable view" repair (and then drops the orphaned
  // pivotCache as a "Workbook properties" repair). This vestigial OLAP pivot is
  // empty, so emit the minimal self-consistent block covering the offsets. This
  // matches the range pattern used by the legacy generate_excel.py generator.
  const startRef = `${colLetter(anchorCol)}${hdrRow}`;
  const endRef   = `${colLetter(anchorCol)}${hdrRow + 1}`;
  const locXml =
    `<location ref="${startRef}:${endRef}" ` +
    `firstHeaderRow="1" firstDataRow="1" firstDataCol="0"/>`;

  // ---- pivotHierarchies ----
  // This pivot table is intentionally empty — nothing is placed in the row/col/
  // data areas (data is supplied by CUBE function formulas elsewhere). Every
  // hierarchy must therefore be a bare <pivotHierarchy/>. Marking measures with
  // dragToData="1" declares a data-area placement with no backing <dataFields>,
  // which is inconsistent for a saveData="0" OLAP cache and contributes to the
  // "PivotTable view" repair. cacheHierarchies count must still equal this count.
  const phParts = hierarchies.map(() => `<pivotHierarchy/>`);
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
