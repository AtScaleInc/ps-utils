/** Shared types for the ExcelJS-based workbook generator. */

export type HierarchyInfo = {
  uniqueName: string;
  caption: string;
  isMeasure: boolean;
  displayFolder: string;
  measureGroup: string | null;
  defaultMemberUniqueName: string | null;
  allUniqueName: string | null;
  dimensionUniqueName: string | null;
  /** Leaf-level name for CUBERANKEDMEMBER set expressions, e.g. "Query_Hour" */
  leafLevelName: string | null;
  /**
   * All levels of this hierarchy, sorted broadest → most granular (ascending levelNumber).
   * Used to resolve xAxisGranularity to a specific level caption. queryName is
   * tracked separately from caption because namespace xAxis values sometimes
   * reference a level by its query_name rather than its display caption (the
   * two can differ, e.g. query_name "Order Year Week Hierarchy" vs caption
   * "Order Year").
   */
  levels: Array<{ caption: string; queryName: string; levelNumber: number }>;
};

/**
 * One entry per unique model.
 * The pivot table is placed on the first data sheet created for that model.
 */
export type PivotMeta = {
  dataSheetTitle: string;   // First hidden data sheet for this model (pivot table lives here)
  model: string;
  measures: string[];
  xAxis?: string;
  tileTitle: string;
  graphType: string;
  hdrRow: number;           // Always 1 (header row on data sheet)
  dataStart: number;        // Always 2 (first data row)
  dataEnd: number;          // Always 11 (last data row, 10 rows of data)
  anchorCol: number;        // Always 1 (data starts at column A)
  numHeaders: number;       // Total columns (xAxis? 1 : 0) + measures.length
};

/**
 * One entry per chart tile on a dashboard sheet.
 * Charts are placed on the dashboard sheet but data references point to the data sheet.
 */
export type ChartMeta = {
  dashSheetTitle: string;   // Visible dashboard sheet (drawing goes here)
  dataSheetTitle: string;   // Hidden data sheet (chart cell refs point here)
  tileTitle: string;
  graphType: string;
  xAxis?: string;
  hdrRow: number;
  dataStart: number;
  dataEnd: number;
  anchorCol: number;
  numHeaders: number;
  // Chart drawing anchor on the dashboard sheet (0-based row/col for twoCellAnchor)
  chartFromCol: number;
  chartFromRow: number;
  chartToCol: number;
  chartToRow: number;
};

export type ExcelGenerateParams = {
  namespace:      Record<string, unknown>;
  models:         Record<string, unknown>;
  connections:    Record<string, unknown>;
  connectionName: string;
  targetFile:     string;
};
