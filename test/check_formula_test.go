package exceltest

import (
    "fmt"
    "testing"
    excelize "github.com/xuri/excelize/v2"
)

func TestCheckGranularityFormulas(t *testing.T) {
    f, err := excelize.OpenFile("/tmp/workbook_test.xlsx")
    if err != nil { t.Fatal(err) }
    for col := 36; col <= 60; col++ {
        colName, _ := excelize.ColumnNumberToName(col)
        val1, _ := f.GetCellValue("Telemetry_comprehensive", colName+"1")
        form2, _ := f.GetCellFormula("Telemetry_comprehensive", colName+"2")
        if val1 != "" || form2 != "" {
            fmt.Printf("%s1=%q  %s2=%s\n", colName, val1, colName, form2)
        }
    }
}
