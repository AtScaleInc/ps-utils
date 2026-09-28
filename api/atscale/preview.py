"""Cube data preview: catalog/cube listing, metadata (dimensions/hierarchies/
levels/measures), and MDX/SQL query execution against a deployed AtScale cube.

Query shape (XML templates, MDX building, SQL building, result parsing) is
ported from the user's own PythonAtscaleUtility reference tool
(cubes/cube_data_queries.py, cube_data_parsers.py, cube_data_sql.py,
cubes_core_functions.py, cube_data_drilldown.py) - that tool's own connection/
auth handling is NOT used here; every request goes through the same
AtScaleClient/session-scoped bearer auth as the rest of this app (see
AtScaleClient.run_xmla/submit_query in client.py), not a separate config.json
or Basic-auth XMLA login.
"""

from __future__ import annotations

import re
import xml.etree.ElementTree as ET
from typing import Any

from .client import AtScaleClient

_SOAP_NS = {
    "soap": "http://schemas.xmlsoap.org/soap/envelope/",
    "rowset": "urn:schemas-microsoft-com:xml-analysis:rowset",
}
_MDDATASET_NS = "urn:schemas-microsoft-com:xml-analysis:mddataset"

# -- XMLA query templates (ported verbatim from cube_data_queries.py) -------------

CATALOG_QUERY = """<?xml version="1.0" encoding="utf-8"?>
<soap:Envelope xmlns:soap="http://schemas.xmlsoap.org/soap/envelope/"
               xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"
               xmlns:xsd="http://www.w3.org/2001/XMLSchema">
  <soap:Body>
    <Execute xmlns="urn:schemas-microsoft-com:xml-analysis">
      <Command>
        <Statement>
              SELECT [CATALOG_NAME], [CATALOG_GUID] from $system.DBSCHEMA_CATALOGS
        </Statement>
      </Command>
      <Properties>
        <PropertyList>
          <Catalog>Default</Catalog>
          <Cube>Default</Cube>
        </PropertyList>
      </Properties>
    </Execute>
  </soap:Body>
</soap:Envelope>"""

CUBE_QUERY_TEMPLATE = """<?xml version="1.0" encoding="utf-8"?>
<soap:Envelope xmlns:soap="http://schemas.xmlsoap.org/soap/envelope/"
               xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"
               xmlns:xsd="http://www.w3.org/2001/XMLSchema">
  <soap:Body>
    <Execute xmlns="urn:schemas-microsoft-com:xml-analysis">
      <Command>
        <Statement>
              SELECT [CUBE_NAME], [CUBE_GUID] from $system.MDSCHEMA_CUBES
        </Statement>
      </Command>
      <Properties>
        <PropertyList>
          <Catalog>{catalog}</Catalog>
          <Cube>Default</Cube>
        </PropertyList>
      </Properties>
    </Execute>
  </soap:Body>
</soap:Envelope>"""

DIMENSIONS_QUERY = """<?xml version="1.0" encoding="utf-8"?>
<soap:Envelope xmlns:soap="http://schemas.xmlsoap.org/soap/envelope/">
  <soap:Body>
    <Execute xmlns="urn:schemas-microsoft-com:xml-analysis">
      <Command>
        <Statement>
          SELECT [CATALOG_NAME], [CUBE_NAME], [DIMENSION_UNIQUE_NAME], [DIMENSION_CAPTION], [DEFAULT_HIERARCHY]
          FROM $system.MDSCHEMA_DIMENSIONS
          WHERE [CUBE_NAME] = '{cube_name}' AND [DIMENSION_UNIQUE_NAME] &lt;&gt; '[Measures]'
        </Statement>
      </Command>
      <Properties>
        <PropertyList>
          <Catalog>{catalog}</Catalog>
          <Cube>{cube_name}</Cube>
        </PropertyList>
      </Properties>
    </Execute>
  </soap:Body>
</soap:Envelope>"""

HIERARCHIES_QUERY = """<?xml version="1.0" encoding="utf-8"?>
<soap:Envelope xmlns:soap="http://schemas.xmlsoap.org/soap/envelope/">
  <soap:Body>
    <Execute xmlns="urn:schemas-microsoft-com:xml-analysis">
      <Command>
        <Statement>
          SELECT [DIMENSION_UNIQUE_NAME], [HIERARCHY_NAME], [HIERARCHY_UNIQUE_NAME], [HIERARCHY_CAPTION], [HIERARCHY_DISPLAY_FOLDER]
          FROM $system.MDSCHEMA_HIERARCHIES
          WHERE [CUBE_NAME] = '{cube_name}' AND [DIMENSION_UNIQUE_NAME] &lt;&gt; '[Measures]'
        </Statement>
      </Command>
      <Properties>
        <PropertyList>
          <Catalog>{catalog}</Catalog>
          <Cube>{cube_name}</Cube>
        </PropertyList>
      </Properties>
    </Execute>
  </soap:Body>
</soap:Envelope>"""

LEVELS_QUERY = """<?xml version="1.0" encoding="utf-8"?>
<soap:Envelope xmlns:soap="http://schemas.xmlsoap.org/soap/envelope/">
  <soap:Body>
    <Execute xmlns="urn:schemas-microsoft-com:xml-analysis">
      <Command>
        <Statement>
          SELECT [DIMENSION_UNIQUE_NAME], [HIERARCHY_UNIQUE_NAME], [LEVEL_NAME], [LEVEL_UNIQUE_NAME], [LEVEL_CAPTION], [LEVEL_NUMBER]
          FROM $system.MDSCHEMA_LEVELS
          WHERE [CUBE_NAME] = '{cube_name}' AND [DIMENSION_UNIQUE_NAME] &lt;&gt; '[Measures]' AND [LEVEL_NAME] &lt;&gt; '(All)'
        </Statement>
      </Command>
      <Properties>
        <PropertyList>
          <Catalog>{catalog}</Catalog>
          <Cube>{cube_name}</Cube>
        </PropertyList>
      </Properties>
    </Execute>
  </soap:Body>
</soap:Envelope>"""

MEASURES_QUERY = """<?xml version="1.0" encoding="utf-8"?>
<soap:Envelope xmlns:soap="http://schemas.xmlsoap.org/soap/envelope/">
  <soap:Body>
    <Execute xmlns="urn:schemas-microsoft-com:xml-analysis">
      <Command>
        <Statement>
          SELECT [MEASURE_NAME], [MEASURE_UNIQUE_NAME], [MEASURE_CAPTION], [MEASURE_DISPLAY_FOLDER]
          FROM $system.MDSCHEMA_MEASURES
          WHERE [CUBE_NAME] = '{cube_name}'
        </Statement>
      </Command>
      <Properties>
        <PropertyList>
          <Catalog>{catalog}</Catalog>
          <Cube>{cube_name}</Cube>
        </PropertyList>
      </Properties>
    </Execute>
  </soap:Body>
</soap:Envelope>"""


#: Not in the reference tool - added because level-only metadata was hiding
#: every secondary attribute the model actually has (e.g. a "Product Line"
#: alias on the Product Level, or "Year Name" on a Date level). AtScale
#: exposes these as MDSCHEMA_PROPERTIES rows scoped to the level they attach
#: to, alongside three system properties every level always has (NAME,
#: MEMBER_VALUE, KEY0/KEY1/...) - _SYSTEM_PROPERTY_NAMES below filters those
#: out, confirmed against a real deployed cube (sample-dev-model: 35 levels x
#: 3 system properties = 105 rows, plus 9 real secondary attributes = 114).
PROPERTIES_QUERY = """<?xml version="1.0" encoding="utf-8"?>
<soap:Envelope xmlns:soap="http://schemas.xmlsoap.org/soap/envelope/">
  <soap:Body>
    <Execute xmlns="urn:schemas-microsoft-com:xml-analysis">
      <Command>
        <Statement>
          SELECT [LEVEL_UNIQUE_NAME], [PROPERTY_NAME], [PROPERTY_CAPTION]
          FROM $system.MDSCHEMA_PROPERTIES
          WHERE [CUBE_NAME] = '{cube_name}'
        </Statement>
      </Command>
      <Properties>
        <PropertyList>
          <Catalog>{catalog}</Catalog>
          <Cube>{cube_name}</Cube>
        </PropertyList>
      </Properties>
    </Execute>
  </soap:Body>
</soap:Envelope>"""

_SYSTEM_PROPERTY_NAMES = {"NAME", "MEMBER_VALUE"}


def _is_system_property(name: str) -> bool:
    return name in _SYSTEM_PROPERTY_NAMES or bool(re.fullmatch(r"KEY\d+", name))


def build_xmla_request(mdx_query: str, catalog: str, cube: str, use_agg: bool = True, use_cache: bool = True) -> str:
    agg_flag = "true" if use_agg else "false"
    cache_flag = "true" if use_cache else "false"
    return f"""<Envelope xmlns="http://schemas.xmlsoap.org/soap/envelope/">
<Body>
<Execute xmlns="urn:schemas-microsoft-com:xml-analysis">
<Command>
    <Statement><![CDATA[{mdx_query}]]></Statement>
</Command>
<Properties>
    <PropertyList>
    <Catalog>{catalog}</Catalog>
    <Cube>{cube}</Cube>
    <UseAggs>{agg_flag}</UseAggs>
    <UseQueryCache>{cache_flag}</UseQueryCache>
    </PropertyList>
</Properties>
</Execute>
</Body>
</Envelope>"""


# -- XML parsing (ported from cube_data_parsers.py, returning plain dicts/lists
#    instead of pandas DataFrames - this API has no pandas dependency) -----------


def parse_rows(xml_text: str, columns: list[str]) -> list[dict[str, str | None]]:
    root = ET.fromstring(xml_text)
    rows = []
    for row_elem in root.findall(".//rowset:row", _SOAP_NS):
        row = {}
        for col in columns:
            elem = row_elem.find(f"rowset:{col}", _SOAP_NS)
            row[col] = elem.text if elem is not None else None
        rows.append(row)
    return rows


def parse_catalogs(xml_text: str) -> list[dict[str, str | None]]:
    root = ET.fromstring(xml_text)
    out = []
    for row in root.findall(".//rowset:row", _SOAP_NS):
        name_elem = row.find("rowset:CATALOG_NAME", _SOAP_NS)
        guid_elem = row.find("rowset:CATALOG_GUID", _SOAP_NS)
        if name_elem is not None:
            out.append({"name": name_elem.text, "guid": guid_elem.text if guid_elem is not None else None})
    return out


def parse_cubes(xml_text: str) -> list[dict[str, str | None]]:
    root = ET.fromstring(xml_text)
    out = []
    for row in root.findall(".//rowset:row", _SOAP_NS):
        name_elem = row.find("rowset:CUBE_NAME", _SOAP_NS)
        guid_elem = row.find("rowset:CUBE_GUID", _SOAP_NS)
        if name_elem is not None:
            out.append({"name": name_elem.text, "guid": guid_elem.text if guid_elem is not None else None})
    return out


def _mddataset_findall(elem: ET.Element, path: str) -> list[ET.Element]:
    return elem.findall(f".//{{{_MDDATASET_NS}}}{path}")


def _mddataset_find(elem: ET.Element, path: str) -> ET.Element | None:
    return elem.find(f"{{{_MDDATASET_NS}}}{path}")


def parse_xmla_result(xml_text: str) -> dict[str, Any]:
    """Ported from parse_xmla_result_to_dataframe - returns {columns, rows}
    with the row label as the first column instead of a DataFrame index."""
    root = ET.fromstring(xml_text)
    data_root = root.find(f".//{{{_MDDATASET_NS}}}root")
    if data_root is None:
        return {"columns": [], "rows": []}

    column_headers: list[str] = []
    axis0 = None
    for axis in _mddataset_findall(data_root, "Axis"):
        if axis.get("name") == "Axis0":
            axis0 = axis
            break
    if axis0 is not None:
        for tuple_elem in _mddataset_findall(axis0, "Tuple"):
            members = _mddataset_findall(tuple_elem, "Member")
            captions = []
            for member in members:
                caption_elem = _mddataset_find(member, "Caption")
                if caption_elem is not None and caption_elem.text:
                    captions.append(caption_elem.text)
                else:
                    uname_elem = _mddataset_find(member, "UName")
                    if uname_elem is not None and uname_elem.text:
                        parts = uname_elem.text.split(".")
                        captions.append(parts[-1].replace("]", "") if len(parts) >= 2 else uname_elem.text)
            column_headers.append(" - ".join(captions) if captions else "Measure")

    rows_data: list[dict[str, Any]] = []
    axis1 = None
    for axis in _mddataset_findall(data_root, "Axis"):
        if axis.get("name") == "Axis1":
            axis1 = axis
            break
    if axis1 is not None:
        for tuple_elem in _mddataset_findall(axis1, "Tuple"):
            members = _mddataset_findall(tuple_elem, "Member")
            row_labels = []
            for i, member in enumerate(members):
                caption_elem = _mddataset_find(member, "Caption")
                if caption_elem is not None and caption_elem.text:
                    row_labels.append(caption_elem.text)
                else:
                    uname_elem = _mddataset_find(member, "UName")
                    if uname_elem is not None and uname_elem.text:
                        parts = uname_elem.text.split(".")
                        name = parts[-1].replace("]", "").replace("&amp;", "") if len(parts) >= 2 else uname_elem.text
                        row_labels.append(name)
                    else:
                        row_labels.append(f"Dimension_{i}")
            rows_data.append({"Row Labels": " - ".join(row_labels) if row_labels else "All"})

    cell_data_elem = _mddataset_find(data_root, "CellData")
    if cell_data_elem is not None:
        cells = _mddataset_findall(cell_data_elem, "Cell")
        num_cols = len(column_headers) if column_headers else 1
        num_rows = len(rows_data)
        if num_rows > 0:
            for cell_ordinal, cell in enumerate(cells):
                row_idx = cell_ordinal // num_cols
                col_idx = cell_ordinal % num_cols
                if row_idx >= num_rows:
                    continue
                fmt_value_elem = _mddataset_find(cell, "FmtValue")
                value_elem = _mddataset_find(cell, "Value")
                if fmt_value_elem is not None and fmt_value_elem.text:
                    cell_value: Any = fmt_value_elem.text
                elif value_elem is not None and value_elem.text:
                    cell_value = value_elem.text
                else:
                    cell_value = ""
                col_name = column_headers[col_idx] if col_idx < len(column_headers) else f"Column_{col_idx}"
                rows_data[row_idx][col_name] = cell_value

    if not rows_data:
        return {"columns": [], "rows": []}
    columns = ["Row Labels"] + column_headers
    rows = [[r.get(c, "") for c in columns] for r in rows_data]
    return {"columns": columns, "rows": rows}


def parse_sql_result(xml_text: str) -> dict[str, Any]:
    """Ported from parse_sql_results - no pandas, so no numeric coercion; the
    frontend renders whatever string/None the engine returned."""
    root = ET.fromstring(xml_text)
    columns = [col.find("name").text for col in root.findall(".//columns/column")]
    rows = []
    for row in root.findall(".//data/row"):
        values: list[str | None] = []
        for col in row.findall("column"):
            values.append(None if "null" in col.attrib else col.text)
        rows.append(values)
    return {"columns": columns, "rows": rows}


# -- MDX/SQL builders (ported from cubes_core_functions.py / cube_data_sql.py) ---


def get_hierarchy_levels(hierarchy_unique_name: str, levels: list[dict[str, Any]]) -> list[dict[str, Any]]:
    matches = [lv for lv in levels if lv.get("HIERARCHY_UNIQUE_NAME") == hierarchy_unique_name]
    matches.sort(key=lambda lv: int(lv.get("LEVEL_NUMBER") or 0))
    return matches


def build_initial_mdx(hierarchy_unique_names: list[str], measure_unique_names: list[str], cube: str, levels: list[dict[str, Any]]) -> str:
    """Shows the first non-(All) level's members for each selected hierarchy -
    a starting-point query the user refines by picking different levels, same
    as the reference tool's build_initial_mdx()."""
    measures_set = ", ".join(measure_unique_names)

    def first_level_set(hierarchy_name: str) -> str:
        hlevels = get_hierarchy_levels(hierarchy_name, levels)
        target = hlevels[0]["LEVEL_UNIQUE_NAME"] if hlevels else hierarchy_name
        return f"{{ {target}.Members }}"

    if len(hierarchy_unique_names) == 1:
        rows_set = first_level_set(hierarchy_unique_names[0])
    else:
        crossjoin_items = [first_level_set(h) for h in hierarchy_unique_names]
        rows_set = crossjoin_items[0]
        for item in crossjoin_items[1:]:
            rows_set = f"CrossJoin({rows_set}, {item})"

    return f"""SELECT
    {{ {measures_set} }} ON COLUMNS,
    NON EMPTY {rows_set} ON ROWS
    FROM [{cube}]"""


def extract_sql_column_name(unique_name: str) -> str:
    """MDX unique name ([Dim].[Hier].[Level] or [Measures].[Name]) -> SQL column name."""
    if unique_name.startswith("[") and unique_name.endswith("]"):
        name = unique_name[1:-1]
        parts = name.replace("].[", ".").split(".")
        if parts:
            return parts[-1].replace("[", "").replace("]", "")
    return unique_name


def build_sql_query(hierarchy_unique_names: list[str], measure_unique_names: list[str], cube: str) -> str:
    dim_clauses = [f"`{cube}`.`{extract_sql_column_name(h)}` AS `{extract_sql_column_name(h)}`" for h in hierarchy_unique_names]
    measure_clauses = [f"`{extract_sql_column_name(m)}`" for m in measure_unique_names]
    select_clause = ", ".join(dim_clauses + measure_clauses)
    group_by_clause = ", ".join(str(i + 1) for i in range(len(dim_clauses)))
    return f"""SELECT {select_clause}
FROM `{cube}` `{cube}`
GROUP BY {group_by_clause}"""


# -- Orchestration used by routes/preview.py --------------------------------------


def list_catalogs_and_cubes(client: AtScaleClient) -> list[dict[str, str | None]]:
    catalogs = parse_catalogs(client.run_xmla(CATALOG_QUERY))
    out: list[dict[str, str | None]] = []
    for cat in catalogs:
        cat_name = cat["name"]
        if not cat_name:
            continue
        cubes = parse_cubes(client.run_xmla(CUBE_QUERY_TEMPLATE.format(catalog=cat_name)))
        for cube in cubes:
            out.append(
                {
                    "catalog": cat_name,
                    "catalogGuid": cat.get("guid"),
                    "cube": cube["name"],
                    "cubeGuid": cube.get("guid"),
                }
            )
    return out


def _attach_role_played_secondary_attributes(
    dims_out: list[dict[str, Any]], properties: list[dict[str, Any]], levels: list[dict[str, Any]]
) -> None:
    """A role-played dimension (e.g. "Due Date"/"Order Date", both aliases of
    one hidden base "Date" dimension) has its secondary attributes registered
    by MDSCHEMA_PROPERTIES under the BASE dimension's hierarchy/level names,
    never the role-played alias - so the exact LEVEL_UNIQUE_NAME match in
    load_cube_metadata finds nothing for these. Confirmed against a real
    deployed cube: MDSCHEMA_LEVELS has no rows for "[Date]" at all, only for
    "[Due Date]"/"[Order Date]", yet MDSCHEMA_PROPERTIES returns "Due
    year_name"/"Order year_name" both scoped to the same base level
    "[Date].[...].[year]" - the role-play prefix survives only in the
    property's own name. Reconciles by that prefix: if a property's name
    starts with "<word> " where "<word>" is also a role-played dimension's
    first caption word, and stripping that same prefix from one of that
    dimension's own level captions matches the property's own level's
    trailing bracket segment, attach it there.
    """
    known_level_names = {lv["LEVEL_UNIQUE_NAME"] for lv in levels}
    orphans = [p for p in properties if p.get("LEVEL_UNIQUE_NAME") not in known_level_names]
    if not orphans:
        return

    for p in orphans:
        name = p.get("PROPERTY_NAME")
        base_level_unique_name = p.get("LEVEL_UNIQUE_NAME")
        if not name or _is_system_property(name) or not base_level_unique_name:
            continue
        base_level_name = base_level_unique_name.rsplit(".", 1)[-1].strip("[]")

        for dim in dims_out:
            prefix = dim["caption"].split(" ", 1)[0] + " "
            if not name.startswith(prefix):
                continue
            for hier in dim["hierarchies"]:
                for lvl in hier["levels"]:
                    if lvl["caption"].startswith(prefix) and lvl["caption"][len(prefix):] == base_level_name:
                        lvl["secondaryAttributes"].append(
                            {"name": name, "caption": p.get("PROPERTY_CAPTION") or name}
                        )
                        break


def load_cube_metadata(client: AtScaleClient, catalog: str, cube: str) -> dict[str, Any]:
    dimensions = parse_rows(
        client.run_xmla(DIMENSIONS_QUERY.format(catalog=catalog, cube_name=cube)),
        ["DIMENSION_UNIQUE_NAME", "DIMENSION_CAPTION", "DEFAULT_HIERARCHY"],
    )
    hierarchies = parse_rows(
        client.run_xmla(HIERARCHIES_QUERY.format(catalog=catalog, cube_name=cube)),
        ["DIMENSION_UNIQUE_NAME", "HIERARCHY_NAME", "HIERARCHY_UNIQUE_NAME", "HIERARCHY_CAPTION", "HIERARCHY_DISPLAY_FOLDER"],
    )
    levels = parse_rows(
        client.run_xmla(LEVELS_QUERY.format(catalog=catalog, cube_name=cube)),
        ["DIMENSION_UNIQUE_NAME", "HIERARCHY_UNIQUE_NAME", "LEVEL_NAME", "LEVEL_UNIQUE_NAME", "LEVEL_CAPTION", "LEVEL_NUMBER"],
    )
    measures = parse_rows(
        client.run_xmla(MEASURES_QUERY.format(catalog=catalog, cube_name=cube)),
        ["MEASURE_NAME", "MEASURE_UNIQUE_NAME", "MEASURE_CAPTION", "MEASURE_DISPLAY_FOLDER"],
    )
    properties = parse_rows(
        client.run_xmla(PROPERTIES_QUERY.format(catalog=catalog, cube_name=cube)),
        ["LEVEL_UNIQUE_NAME", "PROPERTY_NAME", "PROPERTY_CAPTION"],
    )

    secondary_by_level: dict[str, list[dict]] = {}
    for p in properties:
        name = p.get("PROPERTY_NAME")
        if not name or _is_system_property(name):
            continue
        secondary_by_level.setdefault(p["LEVEL_UNIQUE_NAME"], []).append(
            {"name": name, "caption": p.get("PROPERTY_CAPTION") or name}
        )

    hierarchies_by_dim: dict[str, list[dict]] = {}
    for h in hierarchies:
        hierarchies_by_dim.setdefault(h["DIMENSION_UNIQUE_NAME"], []).append(h)

    levels_by_hier: dict[str, list[dict]] = {}
    for lv in levels:
        levels_by_hier.setdefault(lv["HIERARCHY_UNIQUE_NAME"], []).append(lv)
    for hier_levels in levels_by_hier.values():
        hier_levels.sort(key=lambda lv: int(lv.get("LEVEL_NUMBER") or 0))

    dims_out = []
    for dim in dimensions:
        dim_name = dim["DIMENSION_UNIQUE_NAME"]
        hiers_out = []
        for h in hierarchies_by_dim.get(dim_name, []):
            hier_name = h["HIERARCHY_UNIQUE_NAME"]
            hiers_out.append(
                {
                    "uniqueName": hier_name,
                    "caption": h.get("HIERARCHY_CAPTION") or h.get("HIERARCHY_NAME"),
                    "levels": [
                        {
                            "uniqueName": lv["LEVEL_UNIQUE_NAME"],
                            "caption": lv.get("LEVEL_CAPTION") or lv.get("LEVEL_NAME"),
                            "secondaryAttributes": secondary_by_level.get(lv["LEVEL_UNIQUE_NAME"], []),
                        }
                        for lv in levels_by_hier.get(hier_name, [])
                    ],
                }
            )
        dims_out.append({"uniqueName": dim_name, "caption": dim.get("DIMENSION_CAPTION") or dim_name, "hierarchies": hiers_out})

    _attach_role_played_secondary_attributes(dims_out, properties, levels)

    measures_by_folder: dict[str, list[dict]] = {}
    for m in measures:
        folder = m.get("MEASURE_DISPLAY_FOLDER") or ""
        measures_by_folder.setdefault(folder, []).append(
            {"uniqueName": m["MEASURE_UNIQUE_NAME"], "caption": m.get("MEASURE_CAPTION") or m.get("MEASURE_NAME")}
        )
    measures_out = [{"folder": folder, "items": items} for folder, items in measures_by_folder.items()]

    return {"dimensions": dims_out, "measures": measures_out, "_levels": levels}


def run_preview_query(
    client: AtScaleClient,
    catalog: str,
    cube: str,
    dialect: str,
    hierarchies: list[str],
    measures: list[str],
    levels: list[dict[str, Any]],
    use_agg: bool = True,
    use_cache: bool = True,
) -> dict[str, Any]:
    if dialect == "sql":
        sql = build_sql_query(hierarchies, measures, cube)
        payload = {
            "language": "SQL",
            "query": sql,
            "context": {
                "organization": {"id": "default"},
                "environment": {"id": "default"},
                "project": {"name": catalog},
            },
            "useAggs": use_agg,
            "genAggs": use_agg,
            "fakeResults": False,
            "dryRun": False,
            "useLocalCache": use_cache,
            "useAggregateCache": use_cache,
            "timeout": "2.minutes",
        }
        response_xml = client.submit_query(payload)
        result = parse_sql_result(response_xml)
        result["query"] = sql
        return result

    mdx = build_initial_mdx(hierarchies, measures, cube, levels)
    xmla_request = build_xmla_request(mdx, catalog, cube, use_agg, use_cache)
    response_xml = client.run_xmla(xmla_request)
    result = parse_xmla_result(response_xml)
    result["query"] = mdx
    return result
