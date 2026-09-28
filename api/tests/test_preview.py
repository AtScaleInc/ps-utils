"""Cube data preview parsing/building - hand-built XML fixtures matching the
shapes AtScale's XMLA and SQL-submit endpoints actually return (per the user's
PythonAtscaleUtility reference tool), since there's no live AtScale instance
available in CI.
"""

from __future__ import annotations

from atscale.preview import (
    _attach_role_played_secondary_attributes,
    _is_system_property,
    build_initial_mdx,
    build_sql_query,
    extract_sql_column_name,
    parse_catalogs,
    parse_cubes,
    parse_rows,
    parse_sql_result,
    parse_xmla_result,
)

ROWSET_ENVELOPE = """<?xml version="1.0"?>
<soap:Envelope xmlns:soap="http://schemas.xmlsoap.org/soap/envelope/">
  <soap:Body>
    <ExecuteResponse xmlns="urn:schemas-microsoft-com:xml-analysis">
      <return>
        <root xmlns:rowset="urn:schemas-microsoft-com:xml-analysis:rowset">
          {rows}
        </root>
      </return>
    </ExecuteResponse>
  </soap:Body>
</soap:Envelope>"""


def test_parse_catalogs():
    xml = ROWSET_ENVELOPE.format(
        rows="""
        <rowset:row>
          <rowset:CATALOG_NAME>sample_dev</rowset:CATALOG_NAME>
          <rowset:CATALOG_GUID>guid-1</rowset:CATALOG_GUID>
        </rowset:row>
        """
    )
    catalogs = parse_catalogs(xml)
    assert catalogs == [{"name": "sample_dev", "guid": "guid-1"}]


def test_parse_cubes():
    xml = ROWSET_ENVELOPE.format(
        rows="""
        <rowset:row>
          <rowset:CUBE_NAME>Internet Sales Cube</rowset:CUBE_NAME>
          <rowset:CUBE_GUID>guid-2</rowset:CUBE_GUID>
        </rowset:row>
        """
    )
    cubes = parse_cubes(xml)
    assert cubes == [{"name": "Internet Sales Cube", "guid": "guid-2"}]


def test_parse_rows_dimensions():
    xml = ROWSET_ENVELOPE.format(
        rows="""
        <rowset:row>
          <rowset:DIMENSION_UNIQUE_NAME>[Product Dimension]</rowset:DIMENSION_UNIQUE_NAME>
          <rowset:DIMENSION_CAPTION>Product Dimension</rowset:DIMENSION_CAPTION>
          <rowset:DEFAULT_HIERARCHY>[Product Dimension].[Product Hierarchy]</rowset:DEFAULT_HIERARCHY>
        </rowset:row>
        """
    )
    rows = parse_rows(xml, ["DIMENSION_UNIQUE_NAME", "DIMENSION_CAPTION", "DEFAULT_HIERARCHY"])
    assert rows == [
        {
            "DIMENSION_UNIQUE_NAME": "[Product Dimension]",
            "DIMENSION_CAPTION": "Product Dimension",
            "DEFAULT_HIERARCHY": "[Product Dimension].[Product Hierarchy]",
        }
    ]


def test_extract_sql_column_name():
    assert extract_sql_column_name("[Measures].[salesamount1]") == "salesamount1"
    assert extract_sql_column_name("[Product Dimension].[Product Hierarchy].[Product Name]") == "Product Name"
    assert extract_sql_column_name("plain_column") == "plain_column"


def test_build_sql_query():
    sql = build_sql_query(
        ["[Product Dimension].[Product Hierarchy].[Product Name]"],
        ["[Measures].[salesamount1]"],
        "Internet Sales Cube",
    )
    assert "`Internet Sales Cube`.`Product Name` AS `Product Name`" in sql
    assert "`salesamount1`" in sql
    assert "GROUP BY 1" in sql


def test_build_initial_mdx_single_hierarchy():
    levels = [
        {"HIERARCHY_UNIQUE_NAME": "[Product Dimension].[Product Hierarchy]", "LEVEL_UNIQUE_NAME": "[Product Dimension].[Product Hierarchy].[Product Line]", "LEVEL_NUMBER": "1"},
        {"HIERARCHY_UNIQUE_NAME": "[Product Dimension].[Product Hierarchy]", "LEVEL_UNIQUE_NAME": "[Product Dimension].[Product Hierarchy].[Product Name]", "LEVEL_NUMBER": "2"},
    ]
    mdx = build_initial_mdx(
        ["[Product Dimension].[Product Hierarchy]"], ["[Measures].[salesamount1]"], "Internet Sales Cube", levels
    )
    # Picks the first (lowest LEVEL_NUMBER) level, not just whichever came first in the list.
    assert "[Product Dimension].[Product Hierarchy].[Product Line].Members" in mdx
    assert "[Measures].[salesamount1]" in mdx
    assert "FROM [Internet Sales Cube]" in mdx


def test_build_initial_mdx_multiple_hierarchies_crossjoin():
    levels = [
        {"HIERARCHY_UNIQUE_NAME": "[Date Dimension].[Calendar]", "LEVEL_UNIQUE_NAME": "[Date Dimension].[Calendar].[Year]", "LEVEL_NUMBER": "1"},
        {"HIERARCHY_UNIQUE_NAME": "[Product Dimension].[Product Hierarchy]", "LEVEL_UNIQUE_NAME": "[Product Dimension].[Product Hierarchy].[Product Line]", "LEVEL_NUMBER": "1"},
    ]
    mdx = build_initial_mdx(
        ["[Date Dimension].[Calendar]", "[Product Dimension].[Product Hierarchy]"],
        ["[Measures].[salesamount1]"],
        "Internet Sales Cube",
        levels,
    )
    assert mdx.count("CrossJoin(") == 1
    assert "[Date Dimension].[Calendar].[Year].Members" in mdx
    assert "[Product Dimension].[Product Hierarchy].[Product Line].Members" in mdx


def test_parse_xmla_result():
    xml = """<?xml version="1.0"?>
<soap:Envelope xmlns:soap="http://schemas.xmlsoap.org/soap/envelope/">
  <soap:Body>
    <ExecuteResponse xmlns="urn:schemas-microsoft-com:xml-analysis">
      <return>
        <root xmlns="urn:schemas-microsoft-com:xml-analysis:mddataset">
          <Axis name="Axis0">
            <Tuple>
              <Member><Caption>Sales Amount</Caption></Member>
            </Tuple>
          </Axis>
          <Axis name="Axis1">
            <Tuple>
              <Member><Caption>Bikes</Caption></Member>
            </Tuple>
            <Tuple>
              <Member><Caption>Accessories</Caption></Member>
            </Tuple>
          </Axis>
          <CellData>
            <Cell><Value>100</Value></Cell>
            <Cell><Value>200</Value></Cell>
          </CellData>
        </root>
      </return>
    </ExecuteResponse>
  </soap:Body>
</soap:Envelope>"""
    result = parse_xmla_result(xml)
    assert result["columns"] == ["Row Labels", "Sales Amount"]
    assert result["rows"] == [["Bikes", "100"], ["Accessories", "200"]]


def test_is_system_property():
    # Confirmed against a real deployed cube (sample-dev-model): every level
    # always carries NAME/MEMBER_VALUE/KEY0 as MDSCHEMA_PROPERTIES rows - only
    # a real secondary attribute (e.g. "Product Line", "Year Name") should
    # survive the filter used to build each level's secondaryAttributes list.
    assert _is_system_property("NAME")
    assert _is_system_property("MEMBER_VALUE")
    assert _is_system_property("KEY0")
    assert _is_system_property("KEY12")
    assert not _is_system_property("Product Line")
    assert not _is_system_property("Due year_name")


def test_attach_role_played_secondary_attributes():
    """Confirmed against a real deployed cube (sample-dev-model): a role-played
    dimension's own MDSCHEMA_LEVELS rows never match its MDSCHEMA_PROPERTIES
    rows, which are scoped to the hidden base dimension's level names - only
    the role-play prefix in the property's own name ("Due year_name") ties it
    back to the "Due Date" dimension's "Due year" level."""
    dims_out = [
        {
            "uniqueName": "[Due Date]",
            "caption": "Due Date",
            "hierarchies": [
                {
                    "uniqueName": "[Due Date].[Due datecustom_dimension Hierarchy]",
                    "caption": "Due datecustom_dimension Hierarchy",
                    "levels": [{"uniqueName": "[Due Date].[...].[Due year]", "caption": "Due year", "secondaryAttributes": []}],
                }
            ],
        },
        {
            "uniqueName": "[Order Date]",
            "caption": "Order Date",
            "hierarchies": [
                {
                    "uniqueName": "[Order Date].[Order datecustom_dimension Hierarchy]",
                    "caption": "Order datecustom_dimension Hierarchy",
                    "levels": [{"uniqueName": "[Order Date].[...].[Order year]", "caption": "Order year", "secondaryAttributes": []}],
                }
            ],
        },
    ]
    properties = [
        {"LEVEL_UNIQUE_NAME": "[Date].[datecustom_dimension Hierarchy].[year]", "PROPERTY_NAME": "Due year_name", "PROPERTY_CAPTION": "Due year_name"},
        {"LEVEL_UNIQUE_NAME": "[Date].[datecustom_dimension Hierarchy].[year]", "PROPERTY_NAME": "Order year_name", "PROPERTY_CAPTION": "Order year_name"},
        {"LEVEL_UNIQUE_NAME": "[Date].[datecustom_dimension Hierarchy].[year]", "PROPERTY_NAME": "NAME", "PROPERTY_CAPTION": "NAME"},
    ]
    # No MDSCHEMA_LEVELS rows for the base "[Date]" dimension, matching the real cube.
    levels = [{"LEVEL_UNIQUE_NAME": "[Due Date].[...].[Due year]"}, {"LEVEL_UNIQUE_NAME": "[Order Date].[...].[Order year]"}]

    _attach_role_played_secondary_attributes(dims_out, properties, levels)

    assert dims_out[0]["hierarchies"][0]["levels"][0]["secondaryAttributes"] == [{"name": "Due year_name", "caption": "Due year_name"}]
    assert dims_out[1]["hierarchies"][0]["levels"][0]["secondaryAttributes"] == [{"name": "Order year_name", "caption": "Order year_name"}]


def test_parse_sql_result():
    xml = """<result>
  <columns>
    <column><name>Product Name</name></column>
    <column><name>salesamount1</name></column>
  </columns>
  <data>
    <row>
      <column>Bikes</column>
      <column>1234.5</column>
    </row>
    <row>
      <column>Accessories</column>
      <column null="true"></column>
    </row>
  </data>
</result>"""
    result = parse_sql_result(xml)
    assert result["columns"] == ["Product Name", "salesamount1"]
    assert result["rows"] == [["Bikes", "1234.5"], ["Accessories", None]]
