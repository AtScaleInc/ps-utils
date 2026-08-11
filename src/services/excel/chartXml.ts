/**
 * OOXML chart and drawing XML builders.
 *
 * Charts are injected directly as OOXML parts (xl/charts/chartN.xml +
 * xl/drawings/drawingN.xml) because ExcelJS has no native chart API.
 * This gives us precise control over the output and no third-party chart
 * library uncertainty.
 */
import { xmlAttr, sheetCellRange, sheetCell } from "./xmlHelpers.js";

const C_NS  = "http://schemas.openxmlformats.org/drawingml/2006/chart";
const A_NS  = "http://schemas.openxmlformats.org/drawingml/2006/main";
const R_NS  = "http://schemas.openxmlformats.org/officeDocument/2006/relationships";
const XDR_NS = "http://schemas.openxmlformats.org/drawingml/2006/spreadsheetDrawing";

// ---------------------------------------------------------------------------
// Chart XML
// ---------------------------------------------------------------------------

type ChartParams = {
  graphType:    string;        // 'bar' | 'line' | 'pie' | 'donut' | 'area' | 'text'
  title:        string;
  sheetTitle:   string;
  hdrRow:       number;        // 1-based
  anchorCol:    number;        // 1-based; category col (if hasCategories)
  numHeaders:   number;        // total columns (category + measures)
  dataStart:    number;        // 1-based first data row
  dataEnd:      number;        // 1-based last data row
  hasCategories: boolean;
};

export function buildChartXml(p: ChartParams): string {
  const measColStart = p.anchorCol + (p.hasCategories ? 1 : 0);
  const measColEnd   = p.anchorCol + p.numHeaders - 1;
  const numMeas      = measColEnd - measColStart + 1;
  const nPts         = p.dataEnd - p.dataStart + 1;

  // Series XML
  const seriesParts: string[] = [];
  for (let i = 0; i < numMeas; i++) {
    const col = measColStart + i;

    const nameRef  = sheetCell(p.sheetTitle, col, p.hdrRow);
    const catXml   = p.hasCategories
      ? `<c:cat><c:strRef>` +
        `<c:f>${xmlAttr(sheetCellRange(p.sheetTitle, p.anchorCol, p.dataStart, p.dataEnd))}</c:f>` +
        `<c:strCache><c:ptCount val="${nPts}"/></c:strCache>` +
        `</c:strRef></c:cat>`
      : "";
    const valRef   = sheetCellRange(p.sheetTitle, col, p.dataStart, p.dataEnd);

    seriesParts.push(
      `<c:ser>` +
      `<c:idx val="${i}"/><c:order val="${i}"/>` +
      `<c:tx><c:strRef><c:f>${xmlAttr(nameRef)}</c:f>` +
      `<c:strCache><c:ptCount val="1"/></c:strCache></c:strRef></c:tx>` +
      catXml +
      `<c:val><c:numRef><c:f>${xmlAttr(valRef)}</c:f>` +
      `<c:numCache><c:formatCode>General</c:formatCode>` +
      `<c:ptCount val="${nPts}"/></c:numCache></c:numRef></c:val>` +
      `</c:ser>`,
    );
  }

  // Chart element
  // Pie/donut charts don't use axes; all others require axId refs + axis definitions
  const isPie = p.graphType === "pie" || p.graphType === "donut";
  const CAT_AX_ID = 1;
  const VAL_AX_ID = 2;
  const axIdXml = isPie ? "" :
    `<c:axId val="${CAT_AX_ID}"/><c:axId val="${VAL_AX_ID}"/>`;

  let chartTypeXml: string;
  if (p.graphType === "line") {
    chartTypeXml =
      `<c:lineChart><c:grouping val="standard"/><c:varyColors val="0"/>` +
      seriesParts.join("") + axIdXml + `</c:lineChart>`;
  } else if (isPie) {
    chartTypeXml =
      `<c:pieChart><c:varyColors val="1"/>` +
      seriesParts.join("") + `</c:pieChart>`;
  } else if (p.graphType === "area") {
    chartTypeXml =
      `<c:areaChart><c:grouping val="standard"/><c:varyColors val="0"/>` +
      seriesParts.join("") + axIdXml + `</c:areaChart>`;
  } else {
    chartTypeXml =
      `<c:barChart><c:barDir val="col"/><c:grouping val="clustered"/>` +
      `<c:varyColors val="0"/>` + seriesParts.join("") + axIdXml + `</c:barChart>`;
  }

  // Category and value axis definitions (required for non-pie charts)
  const axesXml = isPie ? "" :
    `<c:catAx>` +
    `<c:axId val="${CAT_AX_ID}"/>` +
    `<c:scaling><c:orientation val="minMax"/></c:scaling>` +
    `<c:delete val="0"/>` +
    `<c:axPos val="b"/>` +
    `<c:crossAx val="${VAL_AX_ID}"/>` +
    `</c:catAx>` +
    `<c:valAx>` +
    `<c:axId val="${VAL_AX_ID}"/>` +
    `<c:scaling><c:orientation val="minMax"/></c:scaling>` +
    `<c:delete val="0"/>` +
    `<c:axPos val="l"/>` +
    `<c:crossAx val="${CAT_AX_ID}"/>` +
    `</c:valAx>`;

  const titleXml = p.title
    ? `<c:title>` +
      `<c:tx><c:rich>` +
      `<a:bodyPr/><a:lstStyle/>` +
      `<a:p><a:r><a:rPr lang="en-US" dirty="0"/>` +
      `<a:t>${xmlAttr(p.title)}</a:t></a:r></a:p>` +
      `</c:rich></c:tx><c:overlay val="0"/>` +
      `</c:title>`
    : "";

  return (
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
    `<c:chartSpace xmlns:c="${C_NS}" xmlns:a="${A_NS}" xmlns:r="${R_NS}">` +
    `<c:lang val="en-US"/>` +
    `<c:chart>` +
    titleXml +
    `<c:autoTitleDeleted val="${p.title ? "0" : "1"}"/>` +
    `<c:plotArea>${chartTypeXml}${axesXml}</c:plotArea>` +
    `<c:plotVisOnly val="1"/>` +
    `</c:chart>` +
    `<c:style val="10"/>` +
    `</c:chartSpace>`
  );
}

// ---------------------------------------------------------------------------
// Drawing XML  (one file per sheet; all charts on a sheet share one drawing)
// ---------------------------------------------------------------------------

export type DrawingAnchor = {
  /** rId used in the drawing_rels file (e.g. "rId1") */
  rId: string;
  /** Chart name shown in Excel's name box */
  name: string;
  /** Unique id within drawing (≥ 2; 1 is reserved) */
  cId: number;
  /** 0-based column index of top-left corner */
  fromCol: number;
  /** 0-based row index of top-left corner */
  fromRow: number;
  /** 0-based column index of bottom-right corner (exclusive) */
  toCol: number;
  /** 0-based row index of bottom-right corner (exclusive) */
  toRow: number;
};

export function buildDrawingXml(anchors: DrawingAnchor[]): string {
  const anchorXml = anchors.map(a =>
    `<xdr:twoCellAnchor editAs="twoCell">` +
    `<xdr:from>` +
    `<xdr:col>${a.fromCol}</xdr:col><xdr:colOff>0</xdr:colOff>` +
    `<xdr:row>${a.fromRow}</xdr:row><xdr:rowOff>0</xdr:rowOff>` +
    `</xdr:from>` +
    `<xdr:to>` +
    `<xdr:col>${a.toCol}</xdr:col><xdr:colOff>0</xdr:colOff>` +
    `<xdr:row>${a.toRow}</xdr:row><xdr:rowOff>0</xdr:rowOff>` +
    `</xdr:to>` +
    `<xdr:graphicFrame macro="">` +
    `<xdr:nvGraphicFramePr>` +
    `<xdr:cNvPr id="${a.cId}" name="${xmlAttr(a.name)}"/>` +
    `<xdr:cNvGraphicFramePr>` +
    `<a:graphicFrameLocks noGrp="1"/>` +
    `</xdr:cNvGraphicFramePr>` +
    // CT_GraphicalObjectFrameNonVisual permits only cNvPr + cNvGraphicFramePr.
    // An <xdr:nvPr/> here is invalid and triggers Excel's "Drawing shape" repair.
    `</xdr:nvGraphicFramePr>` +
    `<xdr:xfrm><a:off x="0" y="0"/><a:ext cx="0" cy="0"/></xdr:xfrm>` +
    `<a:graphic><a:graphicData uri="${C_NS}">` +
    `<c:chart xmlns:c="${C_NS}" xmlns:r="${R_NS}" r:id="${a.rId}"/>` +
    `</a:graphicData></a:graphic>` +
    `</xdr:graphicFrame>` +
    `<xdr:clientData/>` +
    `</xdr:twoCellAnchor>`,
  ).join("");

  return (
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
    `<xdr:wsDr xmlns:xdr="${XDR_NS}" xmlns:a="${A_NS}" xmlns:r="${R_NS}">` +
    anchorXml +
    `</xdr:wsDr>`
  );
}

/** Build the _rels file for a drawing, linking each rId to a chart file. */
export function buildDrawingRelsXml(
  rels: Array<{ rId: string; chartFile: string }>,
): string {
  const PKG_NS = "http://schemas.openxmlformats.org/package/2006/relationships";
  const CHART_TYPE =
    "http://schemas.openxmlformats.org/officeDocument/2006/relationships/chart";

  const entries = rels
    .map(r => `<Relationship Id="${r.rId}" Type="${CHART_TYPE}" Target="${r.chartFile}"/>`)
    .join("");

  return (
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
    `<Relationships xmlns="${PKG_NS}">` +
    entries +
    `</Relationships>`
  );
}
