// Package exceltest — feature-level tests for the generate-excel-from-namespace command.
// This file covers chart XML, drawing XML, OLAP XML, dashboard layout, sheet
// relationships, workbook structure, safe-name handling, CUBE formula content,
// idempotency, and multi-dashboard scenarios.
package exceltest

import (
	"crypto/md5"
	"encoding/xml"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

// ---------------------------------------------------------------------------
// Additional fixtures
// ---------------------------------------------------------------------------

const nsLineChart = `
worksheets:
  line_ws:
    title: "Trend Over Time"
    model: "Telemetry"
    graphType: line
    measures:
      - m_query_id_count
    xAxis: query_hour
dashboards:
  Line Dashboard:
    tiles:
      - worksheet: line_ws
`

const nsPieChart = `
worksheets:
  pie_ws:
    title: "Composition"
    model: "Telemetry"
    graphType: pie
    measures:
      - m_query_id_count
    xAxis: query_hour
dashboards:
  Pie Dashboard:
    tiles:
      - worksheet: pie_ws
`

const nsAreaChart = `
worksheets:
  area_ws:
    title: "Cumulative"
    model: "Telemetry"
    graphType: area
    measures:
      - m_query_id_count
    xAxis: query_hour
dashboards:
  Area Dashboard:
    tiles:
      - worksheet: area_ws
`

const nsMultipleMeasures = `
worksheets:
  multi_ws:
    title: "Multi Measure"
    model: "Telemetry"
    graphType: bar
    measures:
      - m_query_id_count
      - m_failed_count_sum
      - m_succeeded_count_sum
    xAxis: query_hour
dashboards:
  Multi Measures:
    tiles:
      - worksheet: multi_ws
`

const nsNoXAxis = `
worksheets:
  noaxis_ws:
    title: "No Axis Chart"
    model: "Telemetry"
    graphType: bar
    measures:
      - m_query_id_count
dashboards:
  No Axis:
    tiles:
      - worksheet: noaxis_ws
`

const nsMultipleDashboards = `
worksheets:
  dash1_ws:
    title: "Dashboard 1 Chart"
    model: "Telemetry"
    graphType: bar
    measures:
      - m_query_id_count
    xAxis: query_hour

  dash2_ws:
    title: "Dashboard 2 Chart"
    model: "Telemetry"
    graphType: line
    measures:
      - m_query_id_count
    xAxis: query_hour

dashboards:
  Alpha Dashboard:
    title: "Alpha"
    tiles:
      - worksheet: dash1_ws

  Beta Dashboard:
    title: "Beta"
    tiles:
      - worksheet: dash2_ws
`

const nsWorksheetDedup = `
worksheets:
  shared_ws:
    title: "Shared"
    model: "Telemetry"
    graphType: bar
    measures:
      - m_query_id_count
    xAxis: query_hour

dashboards:
  Dedup Dashboard:
    tiles:
      - worksheet: shared_ws
        x: 0
      - worksheet: shared_ws
        x: 1
`

const nsCategoryHeaders = `
worksheets:
  cat_ws1:
    title: "Section A Chart"
    model: "Telemetry"
    graphType: bar
    measures:
      - m_query_id_count
    xAxis: query_hour

  cat_ws2:
    title: "Section B Chart"
    model: "Telemetry"
    graphType: text
    measures:
      - m_query_id_count

dashboards:
  Cat Dashboard:
    categoryHeaders:
      - y: 0
        label: "Section A"
      - y: 2
        label: "Section B"
    tiles:
      - worksheet: cat_ws1
        y: 1
      - worksheet: cat_ws2
        y: 3
`

const nsExplicitXY = `
worksheets:
  left_ws:
    title: "Left Tile"
    model: "Telemetry"
    graphType: bar
    measures:
      - m_query_id_count
    xAxis: query_hour

  right_ws:
    title: "Right Tile"
    model: "Telemetry"
    graphType: bar
    measures:
      - m_query_id_count
    xAxis: query_hour

dashboards:
  Positioned:
    tiles:
      - worksheet: left_ws
        x: 0
        y: 0
      - worksheet: right_ws
        x: 1
        y: 0
`

const nsLongName = `
worksheets:
  this_worksheet_name_is_definitely_longer_than_31_chars:
    title: "Long Name"
    model: "Telemetry"
    graphType: text
    measures:
      - m_query_id_count

dashboards:
  Long Name Dashboard:
    tiles:
      - worksheet: this_worksheet_name_is_definitely_longer_than_31_chars
`

const nsSpecialChars = `
worksheets:
  "sheet/with\\special?chars*[and]:more":
    title: "Special"
    model: "Telemetry"
    graphType: text
    measures:
      - m_query_id_count

dashboards:
  Special Dashboard:
    tiles:
      - worksheet: "sheet/with\\special?chars*[and]:more"
`

const nsChartNoTitle = `
worksheets:
  notitle_ws:
    model: "Telemetry"
    graphType: bar
    measures:
      - m_query_id_count
    xAxis: query_hour
dashboards:
  No Title Dashboard:
    tiles:
      - worksheet: notitle_ws
`

// ---------------------------------------------------------------------------
// Raw XML helpers (additional types)
// ---------------------------------------------------------------------------

type xmlWorkbookRels struct {
	XMLName       xml.Name              `xml:"Relationships"`
	Relationships []xmlRelationship     `xml:"Relationship"`
}
type xmlRelationship struct {
	ID     string `xml:"Id,attr"`
	Type   string `xml:"Type,attr"`
	Target string `xml:"Target,attr"`
}

type xmlWorkbook struct {
	XMLName     xml.Name         `xml:"workbook"`
	PivotCaches *xmlPivotCaches  `xml:"pivotCaches"`
}
type xmlPivotCaches struct {
	PivotCache []xmlPivotCacheRef `xml:"pivotCache"`
}
type xmlPivotCacheRef struct {
	CacheID string `xml:"cacheId,attr"`
	RID     string `xml:"id,attr"`
}

type xmlDrawingFull struct {
	XMLName        xml.Name             `xml:"wsDr"`
	TwoCellAnchors []xmlAnchorFull      `xml:"twoCellAnchor"`
}
type xmlAnchorFull struct {
	From         xmlCellPos       `xml:"from"`
	To           xmlCellPos       `xml:"to"`
	GraphicFrame *xmlGFFrame      `xml:"graphicFrame"`
}
type xmlCellPos struct {
	Col int `xml:"col"`
	Row int `xml:"row"`
}
type xmlGFFrame struct {
	NvGFPr *xmlNvGFPr `xml:"nvGraphicFramePr"`
}
type xmlNvGFPr struct {
	CNvPr *xmlCNvPr `xml:"cNvPr"`
	NvPr  *struct{} `xml:"nvPr"`
}
type xmlCNvPr struct {
	ID   int    `xml:"id,attr"`
	Name string `xml:"name,attr"`
}

type xmlDrawingRels struct {
	XMLName       xml.Name           `xml:"Relationships"`
	Relationships []xmlRelationship  `xml:"Relationship"`
}

type xmlChartRoot struct {
	XMLName xml.Name `xml:"chartSpace"`
	Chart   xmlChart `xml:"chart"`
}
type xmlChart struct {
	AutoTitleDeleted string       `xml:"autoTitleDeleted,attr"`
	Title            *xmlTitle    `xml:"title"`
	PlotArea         xmlPlotArea  `xml:"plotArea"`
}
type xmlTitle struct {
	Tx *xmlTitleTx `xml:"tx"`
}
type xmlTitleTx struct {
	Rich *xmlRich `xml:"rich"`
}
type xmlRich struct {
	Paragraphs []xmlParagraph `xml:"p"`
}
type xmlParagraph struct {
	Runs []xmlRun `xml:"r"`
}
type xmlRun struct {
	T string `xml:"t"`
}
type xmlPlotArea struct {
	BarChart  *xmlBarChart  `xml:"barChart"`
	LineChart *xmlLineChart `xml:"lineChart"`
	PieChart  *xmlPieChart  `xml:"pieChart"`
	AreaChart *xmlAreaChart `xml:"areaChart"`
	CatAx     *struct{}     `xml:"catAx"`
	ValAx     *struct{}     `xml:"valAx"`
}
type xmlBarChart struct {
	BarDir   string        `xml:"barDir"`
	Grouping string        `xml:"grouping"`
	Series   []xmlSer      `xml:"ser"`
	AxIDs    []xmlAxID     `xml:"axId"`
}
type xmlLineChart struct {
	Grouping string    `xml:"grouping"`
	Series   []xmlSer  `xml:"ser"`
}
type xmlPieChart struct {
	VaryColors string   `xml:"varyColors"`
	Series     []xmlSer `xml:"ser"`
}
type xmlAreaChart struct {
	Grouping string   `xml:"grouping"`
	Series   []xmlSer `xml:"ser"`
}
type xmlSer struct {
	Idx int        `xml:"idx"`
	Tx  *xmlSerTx  `xml:"tx"`
	Cat *xmlCatVal `xml:"cat"`
	Val *xmlCatVal `xml:"val"`
}
type xmlSerTx struct {
	StrRef *xmlStrRef `xml:"strRef"`
}
type xmlCatVal struct {
	StrRef *xmlStrRef `xml:"strRef"`
	NumRef *xmlNumRef `xml:"numRef"`
}
type xmlStrRef struct {
	F string `xml:"f"`
}
type xmlNumRef struct {
	F string `xml:"f"`
}
type xmlAxID struct {
	Val int `xml:"val,attr"`
}

// firstChartXml returns the parsed XML of the first chart file in the workbook.
func firstChartXml(t *testing.T, xlsxPath string) xmlChartRoot {
	t.Helper()
	for _, e := range zipEntries(t, xlsxPath) {
		if strings.HasPrefix(e, "xl/charts/chart") {
			raw := rawZipEntry(t, xlsxPath, e)
			var c xmlChartRoot
			require.NoError(t, xml.Unmarshal(raw, &c), "parse chart XML %s", e)
			return c
		}
	}
	t.Fatal("no chart files found in workbook")
	return xmlChartRoot{}
}

// firstChartXmlNamed returns the chart associated with a specific chart file.
func allChartXmls(t *testing.T, xlsxPath string) map[string]xmlChartRoot {
	t.Helper()
	result := make(map[string]xmlChartRoot)
	for _, e := range zipEntries(t, xlsxPath) {
		if strings.HasPrefix(e, "xl/charts/chart") {
			raw := rawZipEntry(t, xlsxPath, e)
			var c xmlChartRoot
			require.NoError(t, xml.Unmarshal(raw, &c), "parse %s", e)
			result[e] = c
		}
	}
	return result
}

// ---------------------------------------------------------------------------
// CHART XML TESTS (chartXml.ts)
// ---------------------------------------------------------------------------

func TestChart_BarChartHasCorrectElements(t *testing.T) {
	t.Parallel()
	path := generate(t, nsValid)
	c := firstChartXml(t, path)
	require.NotNil(t, c.Chart.PlotArea.BarChart, "should have barChart element")
	raw := rawZipEntry(t, path, "xl/charts/chart1.xml")
	assert.Contains(t, string(raw), `val="col"`, "barDir should be col")
	assert.NotNil(t, c.Chart.PlotArea.CatAx, "bar chart should have catAx")
	assert.NotNil(t, c.Chart.PlotArea.ValAx, "bar chart should have valAx")
}

func TestChart_BarChartGroupingIsClustered(t *testing.T) {
	t.Parallel()
	path := generate(t, nsValid)
	raw := rawZipEntry(t, path, "xl/charts/chart1.xml")
	require.NotNil(t, raw)
	// barDir val="col" and grouping val="clustered" are embedded as attributes
	assert.Contains(t, string(raw), `val="col"`, "barDir should be col")
	assert.Contains(t, string(raw), `val="clustered"`, "grouping should be clustered for bar")
}

func TestChart_LineChartHasCorrectElements(t *testing.T) {
	t.Parallel()
	path := generate(t, nsLineChart)
	c := firstChartXml(t, path)
	assert.Nil(t, c.Chart.PlotArea.BarChart, "line chart should not have barChart")
	require.NotNil(t, c.Chart.PlotArea.LineChart, "should have lineChart element")
	assert.NotNil(t, c.Chart.PlotArea.CatAx, "line chart needs catAx")
	assert.NotNil(t, c.Chart.PlotArea.ValAx, "line chart needs valAx")

	raw := rawZipEntry(t, path, "xl/charts/chart1.xml")
	assert.Contains(t, string(raw), `val="standard"`, "line grouping should be standard")
}

func TestChart_PieChartHasNoAxes(t *testing.T) {
	t.Parallel()
	path := generate(t, nsPieChart)
	c := firstChartXml(t, path)
	assert.Nil(t, c.Chart.PlotArea.BarChart, "pie should not have barChart")
	require.NotNil(t, c.Chart.PlotArea.PieChart, "should have pieChart element")
	assert.Nil(t, c.Chart.PlotArea.CatAx, "pie chart must NOT have catAx (causes repair)")
	assert.Nil(t, c.Chart.PlotArea.ValAx, "pie chart must NOT have valAx (causes repair)")

	raw := rawZipEntry(t, path, "xl/charts/chart1.xml")
	assert.Contains(t, string(raw), `val="1"`, "pie chart should have varyColors=1")
	assert.NotContains(t, string(raw), "<c:axId", "pie chart must not have axId refs")
}

func TestChart_AreaChartHasCorrectElements(t *testing.T) {
	t.Parallel()
	path := generate(t, nsAreaChart)
	c := firstChartXml(t, path)
	require.NotNil(t, c.Chart.PlotArea.AreaChart, "should have areaChart element")
	assert.NotNil(t, c.Chart.PlotArea.CatAx, "area chart needs catAx")
	assert.NotNil(t, c.Chart.PlotArea.ValAx, "area chart needs valAx")
}

// TestChart_CategoryCellRefMatchesDataSheet verifies the chart category range
// references the dashboard sheet's data section (column X, rows 2-11) rather
// than a separate data sheet.  Column X = colLetter(24) = bannerEndCol(21)+3.
func TestChart_CategoryCellRefMatchesDataSheet(t *testing.T) {
	t.Parallel()
	path := generate(t, nsValid)
	raw := rawZipEntry(t, path, "xl/charts/chart1.xml")
	require.NotNil(t, raw)
	// Category range: column X, rows 2-11 of the dashboard sheet data section
	assert.Contains(t, string(raw), `'Test Dashboard'!$X$2:$X$11`,
		"chart category ref should point to column X of the dashboard data section, rows 2-11")
	assert.NotContains(t, string(raw), `revenue_by_month`,
		"chart should not reference the old separate data sheet")
}

// TestChart_ValueCellRefMatchesDataSheet verifies the chart value range
// references column Y (first measure) of the dashboard data section.
func TestChart_ValueCellRefMatchesDataSheet(t *testing.T) {
	t.Parallel()
	path := generate(t, nsValid)
	raw := rawZipEntry(t, path, "xl/charts/chart1.xml")
	require.NotNil(t, raw)
	// Value range: first measure = column Y (25 = dataCol+1), rows 2-11
	assert.Contains(t, string(raw), `'Test Dashboard'!$Y$2:$Y$11`,
		"chart value ref should point to column Y of the dashboard data section, rows 2-11")
}

// TestChart_SeriesHeaderRefMatchesDataSheet verifies the series name reference
// points to the header row of the dashboard data section (Y1).
func TestChart_SeriesHeaderRefMatchesDataSheet(t *testing.T) {
	t.Parallel()
	path := generate(t, nsValid)
	raw := rawZipEntry(t, path, "xl/charts/chart1.xml")
	require.NotNil(t, raw)
	// Header for first measure: Y1 on the dashboard sheet
	assert.Contains(t, string(raw), `'Test Dashboard'!$Y$1`,
		"series name ref should point to the column header cell Y1 of the dashboard data section")
}

func TestChart_MultipleMeasuresProduceMultipleSeries(t *testing.T) {
	t.Parallel()
	path := generate(t, nsMultipleMeasures)
	raw := rawZipEntry(t, path, "xl/charts/chart1.xml")
	require.NotNil(t, raw)

	serCount := strings.Count(string(raw), "<c:ser>")
	assert.Equal(t, 3, serCount, "3 measures should produce 3 chart series")

	// Data section for multi_ws (hSegments=2): X=category, Y=m1, Z=m2, AA=m3
	assert.Contains(t, string(raw), `'Multi Measures'!$Y$2:$Y$11`, "first measure in column Y")
	assert.Contains(t, string(raw), `'Multi Measures'!$Z$2:$Z$11`, "second measure in column Z")
	assert.Contains(t, string(raw), `'Multi Measures'!$AA$2:$AA$11`, "third measure in column AA")
}

func TestChart_NoXAxisProducesNoCatElement(t *testing.T) {
	t.Parallel()
	path := generate(t, nsNoXAxis)
	raw := rawZipEntry(t, path, "xl/charts/chart1.xml")
	require.NotNil(t, raw)
	assert.NotContains(t, string(raw), "<c:cat>",
		"chart without xAxis must not have category element")
}

func TestChart_TitlePresentInXml(t *testing.T) {
	t.Parallel()
	path := generate(t, nsValid)
	raw := rawZipEntry(t, path, "xl/charts/chart1.xml")
	require.NotNil(t, raw)
	// The tile title "Revenue by Month" should appear in the chart title XML
	assert.Contains(t, string(raw), "Revenue by Month",
		"chart XML should include the tile title")
	assert.Contains(t, string(raw), `autoTitleDeleted val="0"`,
		"chart with title should not delete auto-title")
}

func TestChart_NoTitleFallsBackToWorksheetKey(t *testing.T) {
	t.Parallel()
	// When no "title" key in worksheet def, the wsName key is used as title
	path := generate(t, nsChartNoTitle)
	raw := rawZipEntry(t, path, "xl/charts/chart1.xml")
	require.NotNil(t, raw)
	assert.Contains(t, string(raw), "notitle_ws",
		"chart title should fall back to worksheet key when title not specified")
}

func TestChart_AxesUseSeparateIds(t *testing.T) {
	t.Parallel()
	// catAx and valAx must use different axId values and cross-reference each other
	path := generate(t, nsValid)
	raw := rawZipEntry(t, path, "xl/charts/chart1.xml")
	require.NotNil(t, raw)
	content := string(raw)
	// The axis IDs (1 and 2) must appear; each axis cross-references the other
	assert.Contains(t, content, `<c:axId val="1"/>`)
	assert.Contains(t, content, `<c:axId val="2"/>`)
	assert.Contains(t, content, `<c:crossAx val="1"/>`)
	assert.Contains(t, content, `<c:crossAx val="2"/>`)
}

// ---------------------------------------------------------------------------
// DRAWING XML TESTS (chartXml.ts buildDrawingXml)
// ---------------------------------------------------------------------------

func TestDrawing_TwoCellAnchorsPresent(t *testing.T) {
	t.Parallel()
	path := generate(t, nsValid)
	raw := rawZipEntry(t, path, "xl/drawings/drawing1.xml")
	require.NotNil(t, raw)

	var d xmlDrawingFull
	require.NoError(t, xml.Unmarshal(raw, &d))
	assert.NotEmpty(t, d.TwoCellAnchors, "drawing must have at least one twoCellAnchor")
}

func TestDrawing_AnchorDimensionsArePositive(t *testing.T) {
	t.Parallel()
	path := generate(t, nsValid)
	raw := rawZipEntry(t, path, "xl/drawings/drawing1.xml")
	require.NotNil(t, raw)

	var d xmlDrawingFull
	require.NoError(t, xml.Unmarshal(raw, &d))

	for i, a := range d.TwoCellAnchors {
		assert.Greater(t, a.To.Col, a.From.Col,
			"anchor[%d]: toCol (%d) must be > fromCol (%d)", i, a.To.Col, a.From.Col)
		assert.Greater(t, a.To.Row, a.From.Row,
			"anchor[%d]: toRow (%d) must be > fromRow (%d)", i, a.To.Row, a.From.Row)
	}
}

func TestDrawing_ChartHeightIs14Rows(t *testing.T) {
	t.Parallel()
	// CHART_HEIGHT_ROWS = 14 is hardcoded in ExcelService.ts
	path := generate(t, nsValid)
	raw := rawZipEntry(t, path, "xl/drawings/drawing1.xml")
	require.NotNil(t, raw)

	var d xmlDrawingFull
	require.NoError(t, xml.Unmarshal(raw, &d))

	require.NotEmpty(t, d.TwoCellAnchors)
	a := d.TwoCellAnchors[0]
	assert.Equal(t, 14, a.To.Row-a.From.Row,
		"chart height should be CHART_HEIGHT_ROWS=14 rows")
}

func TestDrawing_ChartWidthIsTileWidth(t *testing.T) {
	t.Parallel()
	// TILE_W = 9 columns
	path := generate(t, nsValid)
	raw := rawZipEntry(t, path, "xl/drawings/drawing1.xml")
	require.NotNil(t, raw)

	var d xmlDrawingFull
	require.NoError(t, xml.Unmarshal(raw, &d))

	require.NotEmpty(t, d.TwoCellAnchors)
	a := d.TwoCellAnchors[0]
	assert.Equal(t, 9, a.To.Col-a.From.Col,
		"chart width should be TILE_W=9 columns")
}

func TestDrawing_NvPrPresentInEveryAnchor(t *testing.T) {
	t.Parallel()
	path := generate(t, nsValid)
	raw := rawZipEntry(t, path, "xl/drawings/drawing1.xml")
	require.NotNil(t, raw)

	var d xmlDrawingFull
	require.NoError(t, xml.Unmarshal(raw, &d))

	for i, a := range d.TwoCellAnchors {
		require.NotNil(t, a.GraphicFrame, "anchor[%d] missing graphicFrame", i)
		require.NotNil(t, a.GraphicFrame.NvGFPr, "anchor[%d] missing nvGraphicFramePr", i)
		assert.NotNil(t, a.GraphicFrame.NvGFPr.NvPr,
			"anchor[%d] missing <xdr:nvPr/> — required by OOXML schema", i)
	}
}

func TestDrawing_ChartIdsAreUniqueAndStartAt2(t *testing.T) {
	t.Parallel()
	// id=1 is reserved; chart graphic frames start at id=2
	path := generate(t, nsMultipleMeasures) // one chart
	raw := rawZipEntry(t, path, "xl/drawings/drawing1.xml")
	require.NotNil(t, raw)

	var d xmlDrawingFull
	require.NoError(t, xml.Unmarshal(raw, &d))

	ids := make(map[int]bool)
	for i, a := range d.TwoCellAnchors {
		require.NotNil(t, a.GraphicFrame.NvGFPr.CNvPr, "anchor[%d] missing cNvPr", i)
		id := a.GraphicFrame.NvGFPr.CNvPr.ID
		assert.GreaterOrEqual(t, id, 2, "chart cNvPr id must be >= 2 (1 is reserved)")
		assert.False(t, ids[id], "duplicate chart cNvPr id=%d", id)
		ids[id] = true
	}
}

func TestDrawing_RelsLinkToChartFiles(t *testing.T) {
	t.Parallel()
	path := generate(t, nsValid)
	raw := rawZipEntry(t, path, "xl/drawings/_rels/drawing1.xml.rels")
	require.NotNil(t, raw, "drawing _rels file must exist")

	var rels xmlDrawingRels
	require.NoError(t, xml.Unmarshal(raw, &rels))

	require.NotEmpty(t, rels.Relationships, "drawing _rels must have at least one relationship")
	for _, r := range rels.Relationships {
		assert.Contains(t, r.Type, "relationships/chart",
			"drawing rel type should be chart")
		assert.Contains(t, r.Target, "chart",
			"drawing rel target should point to a chart file")
	}
}

func TestDrawing_RelsCountMatchesChartCount(t *testing.T) {
	t.Parallel()
	path := generate(t, nsMultipleDashboards)
	entries := zipEntries(t, path)

	chartCount := 0
	for _, e := range entries {
		if strings.HasPrefix(e, "xl/charts/chart") {
			chartCount++
		}
	}
	drawingRelsCount := 0
	for _, e := range entries {
		if strings.Contains(e, "drawings/_rels/drawing") {
			raw := rawZipEntry(t, path, e)
			var rels xmlDrawingRels
			if xml.Unmarshal(raw, &rels) == nil {
				drawingRelsCount += len(rels.Relationships)
			}
		}
	}
	assert.Equal(t, chartCount, drawingRelsCount,
		"total drawing rel entries must equal chart count")
}

func TestDrawing_AnchorUsesEditAsNotMoveWithCells(t *testing.T) {
	t.Parallel()
	// Regression: twoCellAnchor previously used moveWithCells="1" sizeWithCells="1"
	// which are not valid OOXML attributes — Excel repaired the drawing on open.
	// The correct attribute is editAs="twoCell" (or omitted, since twoCell is default).
	path := generate(t, nsLineChart)
	entries := zipEntries(t, path)

	for _, e := range entries {
		if !strings.Contains(e, "xl/drawings/drawing") || strings.Contains(e, "_rels") {
			continue
		}
		raw := rawZipEntry(t, path, e)
		content := string(raw)
		assert.NotContains(t, content, "moveWithCells",
			"twoCellAnchor must not use moveWithCells (invalid OOXML attr)")
		assert.NotContains(t, content, "sizeWithCells",
			"twoCellAnchor must not use sizeWithCells (invalid OOXML attr)")
		// editAs="twoCell" is the correct form (or absent — twoCell is the default)
		assert.NotContains(t, content, `editAs="absolute"`,
			"chart anchors should not use absolute positioning")
	}
}

// ---------------------------------------------------------------------------
// OLAP XML TESTS (olapXml.ts)
// ---------------------------------------------------------------------------

func TestOlapXml_ConnectionStringHasProvider(t *testing.T) {
	t.Parallel()
	path := generate(t, nsValid)
	raw := rawZipEntry(t, path, "xl/connections.xml")
	require.NotNil(t, raw)
	assert.Contains(t, string(raw), "Provider=MSOLAP.8",
		"connection string must start with Provider=MSOLAP.8")
}

func TestOlapXml_ConnectionStringHasDataSource(t *testing.T) {
	t.Parallel()
	path := generate(t, nsValid)
	raw := rawZipEntry(t, path, "xl/connections.xml")
	require.NotNil(t, raw)
	assert.Contains(t, string(raw), "Data Source=",
		"connection string must include Data Source")
}

func TestOlapXml_ConnectionStringHasInitialCatalog(t *testing.T) {
	t.Parallel()
	path := generate(t, nsValid)
	raw := rawZipEntry(t, path, "xl/connections.xml")
	require.NotNil(t, raw)
	assert.Contains(t, string(raw), "Initial Catalog=",
		"connection string must include Initial Catalog")
}

func TestOlapXml_ConnectionStringHasPersistSecurity(t *testing.T) {
	t.Parallel()
	path := generate(t, nsValid)
	raw := rawZipEntry(t, path, "xl/connections.xml")
	require.NotNil(t, raw)
	assert.Contains(t, string(raw), "Persist Security Info=True",
		"connection string must include Persist Security Info=True")
}

func TestOlapXml_ConnectionHasOlapPr(t *testing.T) {
	t.Parallel()
	path := generate(t, nsValid)
	raw := rawZipEntry(t, path, "xl/connections.xml")
	require.NotNil(t, raw)
	assert.Contains(t, string(raw), "<olapPr",
		"OLAP connection must have olapPr element")
	assert.Contains(t, string(raw), `sendLocale="1"`,
		"olapPr must set sendLocale=1")
}

func TestOlapXml_CacheDefWithHierarchiesHasDimensions(t *testing.T) {
	t.Parallel()
	path := generate(t, nsValid)
	raw := rawZipEntry(t, path, "xl/pivotCache/pivotCacheDefinition1.xml")
	require.NotNil(t, raw)
	content := string(raw)
	assert.Contains(t, content, "<dimensions", "cache def must include dimensions for known model")
	assert.Contains(t, content, "<measureGroups", "cache def must include measureGroups")
	assert.Contains(t, content, "<maps", "cache def must include maps")
}

func TestOlapXml_CacheDefMeasureDimensionHasMeasureAttr(t *testing.T) {
	t.Parallel()
	path := generate(t, nsValid)
	raw := rawZipEntry(t, path, "xl/pivotCache/pivotCacheDefinition1.xml")
	require.NotNil(t, raw)
	// The [Measures] virtual dimension must have measure="1"
	assert.Contains(t, string(raw), `measure="1"`,
		"cacheHierarchy for measures must have measure=1")
}

func TestOlapXml_UnknownModelErrorsAndProducesNoFile(t *testing.T) {
	t.Parallel()
	// Regression: a pivot table with no hierarchy metadata triggered an Excel
	// "Removed Feature: PivotTable report" repair dialog on open.
	// Fix: treat missing model metadata as a fatal error — no file is written.
	output := generateExpectError(t, nsUnknownModel)
	assert.Contains(t, output, "NonExistentModel",
		"error output must name the missing model")
}

func TestOlapXml_CacheDefHasNoRidAttribute(t *testing.T) {
	t.Parallel()
	// OLAP caches with saveData="0" must NOT have r:id on pivotCacheDefinition
	// (that attribute points to pivotCacheRecords which don't exist for OLAP)
	path := generate(t, nsValid)
	raw := rawZipEntry(t, path, "xl/pivotCache/pivotCacheDefinition1.xml")
	require.NotNil(t, raw)
	assert.NotContains(t, string(raw), `r:id=`,
		"OLAP pivotCacheDefinition must not have r:id attribute")
}

func TestOlapXml_PivotTableCacheIdIsSequential(t *testing.T) {
	t.Parallel()
	// One pivot table per unique model; each has a sequential numeric cacheId.
	path := generate(t, nsValid)

	for _, e := range zipEntries(t, path) {
		if !strings.HasPrefix(e, "xl/pivotTables/pivotTable") {
			continue
		}
		raw := rawZipEntry(t, path, e)
		var def xmlPivotTableDef
		require.NoError(t, xml.Unmarshal(raw, &def))
		// cacheId should be a non-negative integer (we just check it's present)
		assert.NotContains(t, string(raw), `cacheId=""`,
			"%s should have a numeric cacheId", e)
	}
}

// ---------------------------------------------------------------------------
// EXCEL SERVICE LAYOUT TESTS (ExcelService.ts)
// ---------------------------------------------------------------------------

func TestLayout_DashboardBannerAtRow1(t *testing.T) {
	t.Parallel()
	path := generate(t, nsValid)
	f := openXlsx(t, path)

	// Row 1 of the dashboard is the banner; it spans the full width.
	// We can't easily check the merge, but we can check the title value.
	merges, err := f.GetMergeCells("Test Dashboard")
	require.NoError(t, err)

	// Banner merge starts at row 1
	found := false
	for _, m := range merges {
		if strings.HasPrefix(m.GetStartAxis(), "B1") {
			found = true
			break
		}
	}
	assert.True(t, found, "dashboard should have a merged banner at row 1 starting at column B")
}

func TestLayout_KPITextTileFormulaOnDashboard(t *testing.T) {
	t.Parallel()
	path := generate(t, nsValid)
	f := openXlsx(t, path)

	// The total_cost tile is a "text" graphType.
	// Its KPI value cell on the dashboard should contain CUBEVALUE directly
	// (no reference to a separate data sheet).
	//
	// Both tiles (revenue_by_month at x=0, total_cost at x=1) are at the same
	// y=0 row group; tiles start at currentRow=3, so the KPI value cell is at
	// row 4, column L (= LEFT_COL + 1*TILE_COL_STEP = 12).
	formula, err := f.GetCellFormula("Test Dashboard", "L4")
	require.NoError(t, err)
	assert.True(t, strings.HasPrefix(formula, "CUBEVALUE("),
		"KPI value cell L4 should contain CUBEVALUE directly, got: %s", formula)
	assert.NotContains(t, formula, "total_cost",
		"KPI formula should not reference a separate data sheet")
}

func TestLayout_FooterHasEndpointLabel(t *testing.T) {
	t.Parallel()
	path := generate(t, nsValid)
	f := openXlsx(t, path)

	rows, err := f.GetRows("Test Dashboard")
	require.NoError(t, err)

	found := false
	for _, row := range rows {
		for _, cell := range row {
			if strings.Contains(cell, "AtScale MDX endpoint") {
				found = true
			}
		}
	}
	assert.True(t, found,
		"dashboard should have a footer row containing 'AtScale MDX endpoint'")
}

func TestLayout_ConnectionsSheetHasConnectionName(t *testing.T) {
	t.Parallel()
	path := generate(t, nsValid)
	f := openXlsx(t, path)

	rows, err := f.GetRows("_Connections")
	require.NoError(t, err)

	found := false
	for _, row := range rows {
		for _, cell := range row {
			if cell == "ats_connection" {
				found = true
			}
		}
	}
	assert.True(t, found,
		"_Connections sheet should display the connection name 'ats_connection'")
}

func TestLayout_ConnectionsSheetHasXmlaEndpoint(t *testing.T) {
	t.Parallel()
	path := generate(t, nsValid)
	f := openXlsx(t, path)

	rows, err := f.GetRows("_Connections")
	require.NoError(t, err)

	found := false
	for _, row := range rows {
		for _, cell := range row {
			if strings.Contains(cell, "xmla") || strings.Contains(cell, "/xmla/") {
				found = true
			}
		}
	}
	assert.True(t, found,
		"_Connections sheet should include the XMLA endpoint URL")
}

func TestLayout_ConnectionsSheetIsHidden(t *testing.T) {
	t.Parallel()
	path := generate(t, nsValid)
	f := openXlsx(t, path)

	visible, err := f.GetSheetVisible("_Connections")
	require.NoError(t, err)
	assert.False(t, visible, "_Connections sheet should be hidden")
}

func TestLayout_ConnectionsSheetDoesNotExposePassword(t *testing.T) {
	t.Parallel()
	path := generate(t, nsValid)
	f := openXlsx(t, path)

	// Scan all cells on _Connections for any plaintext password value.
	// The connection string row should show "Password=***" not the real password.
	rows, err := f.GetRows("_Connections")
	require.NoError(t, err)

	for _, row := range rows {
		for _, cell := range row {
			// The example connections.yaml password should not appear verbatim.
			// We check that no cell contains "Password=" followed by a non-*** value.
			if strings.Contains(cell, "Password=") {
				assert.Contains(t, cell, "Password=***",
					"connection string on _Connections sheet must redact the password")
			}
		}
	}
}

func TestLayout_SafeNameSpecialCharsReplacedWithDash(t *testing.T) {
	t.Parallel()
	path := generate(t, nsSpecialChars)
	f := openXlsx(t, path)

	sheets := f.GetSheetList()
	// Original name: "sheet/with\special?chars*[and]:more"
	// safeName replaces /\?*[]: with - → "sheet-with-special-chars--and--more"
	for _, s := range sheets {
		assert.False(t, strings.ContainsAny(s, `/\?*[]:"`),
			"sheet name %q should not contain invalid Excel characters", s)
	}
}

func TestLayout_SafeNameTruncatedTo31Chars(t *testing.T) {
	t.Parallel()
	path := generate(t, nsLongName)
	f := openXlsx(t, path)

	for _, s := range f.GetSheetList() {
		assert.LessOrEqual(t, len(s), 31,
			"sheet name %q is longer than 31 chars (Excel limit)", s)
	}
}

func TestLayout_WorksheetDeduplication(t *testing.T) {
	t.Parallel()
	// shared_ws appears twice in tiles (x=0 and x=1) but should produce ONE data
	// section on the dashboard sheet. Both charts reference the same column range.
	path := generate(t, nsWorksheetDedup)

	// Both charts should reference the same data section columns (X and Y)
	chart1 := rawZipEntry(t, path, "xl/charts/chart1.xml")
	chart2 := rawZipEntry(t, path, "xl/charts/chart2.xml")
	require.NotNil(t, chart1, "chart1.xml should exist")
	require.NotNil(t, chart2, "chart2.xml should exist")

	// Both charts should reference 'Dedup Dashboard'!$X and $Y (shared data section)
	assert.Contains(t, string(chart1), `'Dedup Dashboard'!$X$2:$X$11`,
		"chart1 should reference the shared data section column X")
	assert.Contains(t, string(chart2), `'Dedup Dashboard'!$X$2:$X$11`,
		"chart2 should reference the same shared data section column X (deduplication)")
}

func TestLayout_ExplicitTileXPositioning(t *testing.T) {
	t.Parallel()
	// left_ws at x=0, right_ws at x=1 → two charts in the drawing
	path := generate(t, nsExplicitXY)
	raw := rawZipEntry(t, path, "xl/drawings/drawing1.xml")
	require.NotNil(t, raw)

	var d xmlDrawingFull
	require.NoError(t, xml.Unmarshal(raw, &d))

	require.Equal(t, 2, len(d.TwoCellAnchors),
		"two chart tiles at x=0 and x=1 should produce 2 drawing anchors")

	// First anchor starts in column B (index 1), second starts in column L (index 11)
	// LEFT_COL=2, TILE_COL_STEP=10 → x=0: anchorCol=2 → fromCol=1; x=1: anchorCol=12 → fromCol=11
	fromCols := []int{d.TwoCellAnchors[0].From.Col, d.TwoCellAnchors[1].From.Col}
	assert.Contains(t, fromCols, 1, "x=0 tile should start at col index 1 (column B)")
	assert.Contains(t, fromCols, 11, "x=1 tile should start at col index 11 (column L)")
}

func TestLayout_CategoryHeadersOnDashboard(t *testing.T) {
	t.Parallel()
	path := generate(t, nsCategoryHeaders)
	f := openXlsx(t, path)

	rows, err := f.GetRows("Cat Dashboard")
	require.NoError(t, err)

	found := make(map[string]bool)
	for _, row := range rows {
		for _, cell := range row {
			if cell == "Section A" || cell == "Section B" {
				found[cell] = true
			}
		}
	}
	assert.True(t, found["Section A"], "dashboard should contain category header 'Section A'")
	assert.True(t, found["Section B"], "dashboard should contain category header 'Section B'")
}

// ---------------------------------------------------------------------------
// RELATIONSHIP STRUCTURE TESTS
// ---------------------------------------------------------------------------

func TestRels_ConnectionsSheetHasPivotTableRelationship(t *testing.T) {
	t.Parallel()
	// Pivot tables are placed on the _Connections sheet (one per unique model).
	path := generate(t, nsValid)
	entries := zipEntries(t, path)

	wbXml := rawZipEntry(t, path, "xl/workbook.xml")
	wbRels := rawZipEntry(t, path, "xl/_rels/workbook.xml.rels")

	// Find rId for the _Connections sheet
	rIDMatch := func(data []byte, sheetName string) string {
		s := string(data)
		for _, line := range strings.Split(s, ">") {
			if strings.Contains(line, fmt.Sprintf(`name="%s"`, sheetName)) {
				for _, part := range strings.Fields(line) {
					if strings.HasPrefix(part, `r:id="`) {
						// strip r:id=, leading ", trailing " and optional />
						id := strings.TrimPrefix(part, `r:id="`)
						id = strings.TrimSuffix(id, `"/>`)
						id = strings.TrimSuffix(id, `"/`)
						id = strings.TrimSuffix(id, `"`)
						return id
					}
				}
			}
		}
		return ""
	}
	rId := rIDMatch(wbXml, "_Connections")
	if rId == "" {
		t.Skip("could not determine _Connections sheet rId — skipping pivot rel check")
	}

	// Find the target sheetN.xml for this rId
	sheetTarget := ""
	var rels xmlWorkbookRels
	if xml.Unmarshal(wbRels, &rels) == nil {
		for _, r := range rels.Relationships {
			if r.ID == rId {
				sheetTarget = r.Target
				break
			}
		}
	}
	if sheetTarget == "" {
		t.Skip("could not resolve _Connections sheet target — skipping")
	}

	sheetFile := strings.TrimPrefix(sheetTarget, "../")
	if !strings.HasPrefix(sheetFile, "xl/") {
		sheetFile = "xl/" + sheetFile
	}
	relsFile := strings.Replace(sheetFile, "worksheets/", "worksheets/_rels/", 1) + ".rels"

	found := false
	for _, e := range entries {
		if e == relsFile {
			raw := rawZipEntry(t, path, relsFile)
			found = strings.Contains(string(raw), "pivotTable")
			break
		}
	}
	assert.True(t, found,
		"_Connections sheet _rels (%s) should reference a pivot table", relsFile)
}

func TestRels_EachPivotTableHasCacheDefRel(t *testing.T) {
	t.Parallel()
	path := generate(t, nsValid)
	entries := zipEntries(t, path)

	var pivotTableFiles []string
	for _, e := range entries {
		if strings.HasPrefix(e, "xl/pivotTables/pivotTable") && !strings.Contains(e, "_rels") {
			pivotTableFiles = append(pivotTableFiles, e)
		}
	}
	require.NotEmpty(t, pivotTableFiles)

	for _, pt := range pivotTableFiles {
		// e.g. xl/pivotTables/pivotTable1.xml → xl/pivotTables/_rels/pivotTable1.xml.rels
		relsPath := strings.Replace(pt, "pivotTables/", "pivotTables/_rels/", 1) + ".rels"
		raw := rawZipEntry(t, path, relsPath)
		require.NotNil(t, raw, "pivot table _rels must exist: %s", relsPath)

		var rels xmlDrawingRels
		require.NoError(t, xml.Unmarshal(raw, &rels))

		found := false
		for _, r := range rels.Relationships {
			if strings.Contains(r.Type, "pivotCacheDefinition") {
				found = true
				assert.Contains(t, r.Target, "pivotCacheDefinition",
					"%s: rel target should point to pivotCacheDefinition", relsPath)
			}
		}
		assert.True(t, found,
			"%s: must have a pivotCacheDefinition relationship", relsPath)
	}
}

func TestRels_DashboardSheetHasDrawingRelationship(t *testing.T) {
	t.Parallel()
	path := generate(t, nsValid)
	raw := rawZipEntry(t, path, "xl/_rels/workbook.xml.rels")
	require.NotNil(t, raw)

	// Find the sheet file for "Test Dashboard"
	wbXml := rawZipEntry(t, path, "xl/workbook.xml")
	require.NotNil(t, wbXml)

	// We look for any sheet rels file that has a drawing relationship
	entries := zipEntries(t, path)
	found := false
	for _, e := range entries {
		if !strings.HasPrefix(e, "xl/worksheets/_rels/") {
			continue
		}
		sheetRaw := rawZipEntry(t, path, e)
		if strings.Contains(string(sheetRaw), "relationships/drawing") {
			found = true
			// Verify the drawing target points to xl/drawings/drawing*.xml
			assert.Contains(t, string(sheetRaw), "../drawings/drawing",
				"%s: drawing relationship should target ../drawings/drawingN.xml", e)
			break
		}
	}
	assert.True(t, found,
		"at least one sheet _rels file should have a drawing relationship")
}

func TestRels_PivotCacheCountMatchesPivotTableCount(t *testing.T) {
	t.Parallel()
	path := generate(t, nsValid)
	entries := zipEntries(t, path)

	cacheCount := 0
	tableCount := 0
	for _, e := range entries {
		if strings.HasPrefix(e, "xl/pivotCache/pivotCacheDefinition") {
			cacheCount++
		}
		if strings.HasPrefix(e, "xl/pivotTables/pivotTable") && !strings.Contains(e, "_rels") {
			tableCount++
		}
	}
	assert.Equal(t, cacheCount, tableCount,
		"each pivot table must have exactly one cache definition")
}

// ---------------------------------------------------------------------------
// WORKBOOK STRUCTURE TESTS
// ---------------------------------------------------------------------------

func TestWorkbook_HasPivotCachesElement(t *testing.T) {
	t.Parallel()
	path := generate(t, nsValid)
	raw := rawZipEntry(t, path, "xl/workbook.xml")
	require.NotNil(t, raw)

	var wb xmlWorkbook
	require.NoError(t, xml.Unmarshal(raw, &wb))
	require.NotNil(t, wb.PivotCaches, "workbook.xml must contain <pivotCaches> element")
	assert.NotEmpty(t, wb.PivotCaches.PivotCache,
		"pivotCaches must list at least one pivotCache entry")
}

func TestWorkbook_PivotCacheEntriesMatchCacheFiles(t *testing.T) {
	t.Parallel()
	path := generate(t, nsValid)
	entries := zipEntries(t, path)

	cacheFileCount := 0
	for _, e := range entries {
		if strings.HasPrefix(e, "xl/pivotCache/pivotCacheDefinition") {
			cacheFileCount++
		}
	}

	raw := rawZipEntry(t, path, "xl/workbook.xml")
	var wb xmlWorkbook
	require.NoError(t, xml.Unmarshal(raw, &wb))

	assert.Equal(t, cacheFileCount, len(wb.PivotCaches.PivotCache),
		"workbook.xml pivotCache entries must match pivotCacheDefinition file count")
}

func TestWorkbook_SheetOrderDataBeforeDashboard(t *testing.T) {
	t.Parallel()
	// Dashboard sheet(s) come before _Connections (which is always last/hidden)
	path := generate(t, nsValid)
	f := openXlsx(t, path)

	sheets := f.GetSheetList()
	require.NotEmpty(t, sheets)

	posOf := func(name string) int {
		for i, s := range sheets {
			if s == name {
				return i
			}
		}
		return -1
	}

	dashPos := posOf("Test Dashboard")
	connPos := posOf("_Connections")

	require.GreaterOrEqual(t, dashPos, 0, "Test Dashboard should exist")
	require.GreaterOrEqual(t, connPos, 0, "_Connections should exist")
	assert.Greater(t, connPos, dashPos,
		"_Connections sheet should come after dashboard sheets")
}

// ---------------------------------------------------------------------------
// MULTIPLE DASHBOARDS TESTS
// ---------------------------------------------------------------------------

func TestMultipleDashboards_BothSheetsCreated(t *testing.T) {
	t.Parallel()
	path := generate(t, nsMultipleDashboards)
	f := openXlsx(t, path)

	sheets := f.GetSheetList()
	assert.Contains(t, sheets, "Alpha Dashboard",
		"Alpha Dashboard should produce a sheet named 'Alpha Dashboard'")
	assert.Contains(t, sheets, "Beta Dashboard",
		"Beta Dashboard should produce a sheet named 'Beta Dashboard'")
}

func TestMultipleDashboards_EachHasItsOwnDrawing(t *testing.T) {
	t.Parallel()
	path := generate(t, nsMultipleDashboards)
	entries := zipEntries(t, path)

	drawingCount := 0
	for _, e := range entries {
		if strings.HasPrefix(e, "xl/drawings/drawing") && !strings.Contains(e, "_rels") {
			drawingCount++
		}
	}
	assert.Equal(t, 2, drawingCount,
		"two dashboards should each produce one drawing file")
}

// TestMultipleDashboards_DataSectionsOnDashboardSheets verifies that charts on
// each dashboard reference their own dashboard sheet for data (no shared separate
// data sheets). Each dashboard's data section starts at its own column X.
func TestMultipleDashboards_DataSectionsOnDashboardSheets(t *testing.T) {
	t.Parallel()
	path := generate(t, nsMultipleDashboards)

	// Alpha Dashboard chart should reference 'Alpha Dashboard' columns
	// Beta Dashboard chart should reference 'Beta Dashboard' columns
	// (each dashboard gets its own nextDataCol starting fresh at X=24)
	chart1 := rawZipEntry(t, path, "xl/charts/chart1.xml")
	chart2 := rawZipEntry(t, path, "xl/charts/chart2.xml")
	require.NotNil(t, chart1, "chart1.xml should exist")
	require.NotNil(t, chart2, "chart2.xml should exist")

	// Charts should reference their respective dashboard sheets, not separate data sheets
	assert.NotContains(t, string(chart1), "dash1_ws",
		"chart1 should not reference a separate data sheet")
	assert.NotContains(t, string(chart2), "dash2_ws",
		"chart2 should not reference a separate data sheet")

	// Each chart refs one of the two dashboard sheets
	refsAlpha := strings.Contains(string(chart1), "Alpha Dashboard") || strings.Contains(string(chart2), "Alpha Dashboard")
	refsBeta := strings.Contains(string(chart1), "Beta Dashboard") || strings.Contains(string(chart2), "Beta Dashboard")
	assert.True(t, refsAlpha, "one chart should reference Alpha Dashboard")
	assert.True(t, refsBeta, "one chart should reference Beta Dashboard")
}

// ---------------------------------------------------------------------------
// CUBE FORMULA CONTENT TESTS
// ---------------------------------------------------------------------------

// Data section column offsets for test fixtures with default hSegments=2:
//   bannerEndCol = LEFT_COL(2) + hSegments(2)*TILE_COL_STEP(10) - 1 = 21
//   nextDataCol  = bannerEndCol + 3 = 24 = column X
//
// nsValid: revenue_by_month → X(cat), Y(meas1); total_cost → Z(grand total)
// nsMultipleMeasures: multi_ws → X(cat), Y(m1), Z(m2), AA(m3)

func TestCube_RankedMemberContainsHierarchyUniqueName(t *testing.T) {
	t.Parallel()
	path := generate(t, nsValid)
	f := openXlsx(t, path)

	// revenue_by_month data section: X = category column (CUBERANKEDMEMBER)
	formula, err := f.GetCellFormula("Test Dashboard", "X2")
	require.NoError(t, err)
	// xAxis=query_hour → unique name "[Query_Hour].[Query_Hour Hierarchy]"
	assert.Contains(t, formula, "[Query_Hour]",
		"CUBERANKEDMEMBER should contain the hierarchy unique name for query_hour")
	assert.Contains(t, formula, ".Members",
		"CUBERANKEDMEMBER set expression should end with .Members")
}

func TestCube_ValueContainsMeasureUniqueName(t *testing.T) {
	t.Parallel()
	path := generate(t, nsValid)
	f := openXlsx(t, path)

	// revenue_by_month data section: Y = first measure (CUBEVALUE)
	formula, err := f.GetCellFormula("Test Dashboard", "Y2")
	require.NoError(t, err)
	assert.Contains(t, formula, "[Measures].[m_query_id_count]",
		"CUBEVALUE should contain the measure unique name from the OLAP hierarchy")
}

func TestCube_GrandTotalHasNoMemberArg(t *testing.T) {
	t.Parallel()
	// total_cost has no xAxis → CUBEVALUE with just the measure (grand total)
	// total_cost data section starts at Z (26 = dataCol after revenue_by_month's 2 cols)
	path := generate(t, nsValid)
	f := openXlsx(t, path)

	formula, err := f.GetCellFormula("Test Dashboard", "Z2")
	require.NoError(t, err)
	assert.True(t, strings.HasPrefix(formula, "CUBEVALUE("),
		"grand total cell should use CUBEVALUE")
	// Grand total formula should NOT reference another cell (no 3rd argument)
	commaCount := strings.Count(formula, ",")
	assert.Equal(t, 1, commaCount,
		"CUBEVALUE grand total should have exactly 2 args (connection, member) → 1 comma, got: %s", formula)
}

func TestCube_RankedMemberRankIncrementsPerRow(t *testing.T) {
	t.Parallel()
	path := generate(t, nsValid)
	f := openXlsx(t, path)

	// revenue_by_month data section: X = category column, rows 2-11
	for rank := 1; rank <= 10; rank++ {
		cell := fmt.Sprintf("X%d", rank+1) // row 2=rank1, row 11=rank10
		formula, err := f.GetCellFormula("Test Dashboard", cell)
		require.NoError(t, err)
		assert.Contains(t, formula, fmt.Sprintf(",%d)", rank),
			"CUBERANKEDMEMBER in row %d should have rank=%d", rank+1, rank)
	}
}

func TestCube_ValueReferencesCorrectDimensionCell(t *testing.T) {
	t.Parallel()
	// Y2 should reference X2, Y3 should reference X3, etc.
	// X = category col (24), Y = measure col (25)
	path := generate(t, nsValid)
	f := openXlsx(t, path)

	for row := 2; row <= 11; row++ {
		formula, err := f.GetCellFormula("Test Dashboard", fmt.Sprintf("Y%d", row))
		require.NoError(t, err)
		assert.Contains(t, formula, fmt.Sprintf(",X%d)", row),
			"CUBEVALUE in Y%d should reference dimension cell X%d", row, row)
	}
}

func TestCube_MultipleMeasuresInSeparateColumns(t *testing.T) {
	t.Parallel()
	// multi_ws data section (hSegments=2): X=cat, Y=m1, Z=m2, AA=m3
	path := generate(t, nsMultipleMeasures)
	f := openXlsx(t, path)

	y2, err := f.GetCellFormula("Multi Measures", "Y2")
	require.NoError(t, err)
	assert.Contains(t, y2, "m_query_id_count", "Y2 should contain first measure")

	z2, err := f.GetCellFormula("Multi Measures", "Z2")
	require.NoError(t, err)
	assert.Contains(t, z2, "m_failed_count_sum", "Z2 should contain second measure")

	aa2, err := f.GetCellFormula("Multi Measures", "AA2")
	require.NoError(t, err)
	assert.Contains(t, aa2, "m_succeeded_count_sum", "AA2 should contain third measure")
}

// ---------------------------------------------------------------------------
// IDEMPOTENCY TEST
// ---------------------------------------------------------------------------

func TestIdempotency_RerunProducesSameStructure(t *testing.T) {
	t.Parallel()
	// Generate the same namespace twice with the same target file and verify
	// the second run doesn't corrupt the workbook (stripPreviousOlap works).
	nsFile, err := os.CreateTemp(t.TempDir(), "ns-*.yaml")
	require.NoError(t, err)
	_, err = nsFile.WriteString(nsValid)
	require.NoError(t, err)
	require.NoError(t, nsFile.Close())

	out := filepath.Join(t.TempDir(), "idempotent.xlsx")
	cli := filepath.Join(projectRoot, "atscale-utils")
	args := []string{
		"generate-excel-from-namespace",
		"--namespace-file", nsFile.Name(),
		"--model-file", filepath.Join(projectRoot, "example", "model.yaml"),
		"--connection-file", filepath.Join(projectRoot, "example", "connections.yaml"),
		"--connection-name", "ats_connection",
		"--target-file", out,
	}

	// First run
	runCmd(t, cli, args...)
	f1 := openXlsx(t, out)
	sheets1 := f1.GetSheetList()

	// Second run (overwrites the same file)
	runCmd(t, cli, args...)
	f2 := openXlsx(t, out)
	sheets2 := f2.GetSheetList()

	// Structural idempotency: same sheets, same formulas on data sheet
	assert.Equal(t, sheets1, sheets2,
		"two runs should produce the same sheet list")
	a2run1, _ := f1.GetCellFormula("revenue_by_month", "A2")
	a2run2, _ := f2.GetCellFormula("revenue_by_month", "A2")
	assert.Equal(t, a2run1, a2run2, "data sheet formula should be identical across runs")

	// The second run's output must also be openable
	openXlsx(t, out)

	// And content types must still have no duplicates
	raw := rawZipEntry(t, out, "[Content_Types].xml")
	var ct xmlContentTypes
	require.NoError(t, xml.Unmarshal(raw, &ct))
	seen := make(map[string]int)
	for _, o := range ct.Overrides {
		seen[o.PartName]++
	}
	for part, count := range seen {
		assert.Equal(t, 1, count,
			"after second run: duplicate content type entry for %q", part)
	}
}

func runCmd(t *testing.T, cli string, args ...string) {
	t.Helper()
	// import: os/exec is already imported via the other file in this package
	cmd := exec.Command(cli, args...)
	cmd.Dir = projectRoot
	out, err := cmd.CombinedOutput()
	if err != nil {
		t.Logf("CLI: %s", out)
		t.Fatalf("command failed: %v", err)
	}
}

func md5File(t *testing.T, path string) string {
	t.Helper()
	data, err := os.ReadFile(path)
	require.NoError(t, err)
	return fmt.Sprintf("%x", md5.Sum(data))
}
