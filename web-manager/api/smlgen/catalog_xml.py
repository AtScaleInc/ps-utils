"""Python port of ps-utils src/algorithm/catalog-xml-builder.ts.

Restored from sml-wizard api/smlgen/catalog_xml.py (unchanged) for the legacy
deploy path: AtScale builds without POST /v1/catalogs/deploy (404 - e.g.
34.x containers) deploy via /wapi/git/deploy/catalog, which needs this XML
compiled locally (atscale/legacy_deploy.py). Newer builds compile the SML
themselves and never reach this module.

Builds the legacy AtScale catalog XML (project_2_0 schema) that
`/wapi/git/deploy/catalog` requires alongside the raw SML files, as its
`projectXml` field. Object UUIDs are derived deterministically (UUID v5) from
the object's unique name and the project name, so repeated calls with
identical SML produce identical XML - ported line-for-line from the TS
original, including its "assume single join key" simplification (see
`joinKa = keyedAttrs[0]` below), which is fine for this wizard's one join per
fact-dimension pair.
"""

from __future__ import annotations

import uuid
from typing import Any
from xml.sax.saxutils import escape as _esc

# The TS original's ROOT_NS ("6ba7b810-9dad-11d1-80b4-00c04fd430c8") is
# Python's uuid.NAMESPACE_URL - same constant.
ROOT_NS = uuid.NAMESPACE_URL

_SML_TO_XML_TYPE = {
    "string": "String",
    "int": "Int",
    "long": "Long",
    "double": "Double",
    "float": "Float",
    "decimal": "Decimal",
    "boolean": "Boolean",
    "date": "Date",
    "datetime": "DateTime",
}

_AGG_MAP = {
    "SUM": "SUM",
    "AVERAGE": "AVG",
    "MINIMUM": "MIN",
    "MAXIMUM": "MAX",
    "COUNT NON-NULL": "COUNT",
    "COUNT": "COUNT",
}


def _sml_type_to_xml(sml_type: str | None) -> str:
    return _SML_TO_XML_TYPE.get((sml_type or "string").lower(), "String")


def _project_namespace(project_name: str) -> uuid.UUID:
    return uuid.uuid5(ROOT_NS, f"atscale-project:{project_name}")


def _gen_id(ns: uuid.UUID, path: str) -> str:
    return str(uuid.uuid5(ns, path))


def build_catalog_xml(
    catalog: dict[str, Any],
    model: dict[str, Any],
    dimensions_map: dict[str, dict[str, Any]],
    datasets_map: dict[str, dict[str, Any]],
    metrics_map: dict[str, dict[str, Any]],
    connections_map: dict[str, dict[str, Any]],
    project_name: str,
    project_id: str | None = None,
) -> str:
    engine_id = project_id or str(uuid.uuid4())
    ns = _project_namespace(project_name)
    caption = catalog.get("label") or catalog.get("unique_name") or "catalog"

    default_database = "default"
    default_schema = "default"
    for conn in connections_map.values():
        if conn.get("database"):
            default_database = conn["database"]
        if conn.get("schema"):
            default_schema = conn["schema"]
        break

    def as_connection_id(conn_id: str | None) -> str:
        if not conn_id:
            return "default"
        conn = connections_map.get(conn_id)
        return (conn.get("as_connection") if conn else None) or conn_id

    # -- model relationships --
    relationships = [
        {
            "fromDataset": (r.get("from") or {}).get("dataset", ""),
            "joinColumns": (r.get("from") or {}).get("join_columns", []),
            "toDimension": (r.get("to") or {}).get("dimension", ""),
            "toLevel": (r.get("to") or {}).get("level", ""),
        }
        for r in model.get("relationships") or []
    ]

    # A model's `dimensions` list names dimensions with no fact join at all -
    # degenerate dimensions living directly on a fact table (e.g. "Sales
    # Reasons" on factinternetsales) - so they never appear as a `to.dimension`
    # in any relationship. Confirmed against a real deploy: omitting this list
    # here (relationships-only) silently dropped every such dimension from the
    # compiled cube XML, even though its own dimension YAML was correct.
    ref_dim_names = {r["toDimension"] for r in relationships if r["toDimension"]}
    ref_dim_names |= {
        (d if isinstance(d, str) else d.get("unique_name"))
        for d in (model.get("dimensions") or [])
    }
    ref_dim_names.discard(None)
    fact_dataset_names = {r["fromDataset"] for r in relationships if r["fromDataset"]}

    # NOTE on dim<->dim "embedded" relationships (e.g. Customer Dimension ->
    # Geography Dimension via geographykey, declared on the dimension's own
    # file): confirmed via a live deploy AND AtScale's own UI (a real
    # "Geography City" hierarchy screenshot: one dimension, one hierarchy,
    # 4 levels, each level backed by a *different* dataset, chained via
    # `type: snowflake` relationships with a visible link icon between
    # adjacent levels) that AtScale has no concept of two independent
    # top-level dimensions cross-linked to each other at all. A snowflaked
    # table's levels belong *inside* the referencing dimension's own
    # hierarchy, spanning multiple datasets - not a second, separate
    # `object_type: dimension`. This wizard's canvas is one-physical-table-
    # per-node, so it can't author that shape (see README's "Known
    # limitations" - already documented, not new). An attempt to compile the
    # "embedded" relationship type this wizard's own generator invents (not
    # a real AtScale/ps-utils concept - confirmed absent from both) into a
    # second, cross-linked <dimension> was tried here and reverted: AtScale
    # reported the snowflaked dimension "not found" in the cube regardless
    # of how the key-ref chain was wired, because it was never going to be
    # attached as its own dimension in the first place. Fixing this for real
    # needs build.py to merge a dim<->dim join's target into the *same*
    # dimension's hierarchy (multiple levels, multiple datasets, `type:
    # snowflake`) instead of generating a separate dimension object - a
    # bigger change to the node/hierarchy model itself, not this compiler.

    # -- keyed attributes: one per level_attribute *and* per secondary
    # attribute, across every referenced dimension - not just the one level
    # each fact relationship directly joins to. Confirmed against a real
    # legacy project XML (atscale-xml-sml/enterprise_sales.xml) that every
    # level in a multi-level hierarchy needs its own <level> element (only
    # the join-target level was ever emitted here before, silently dropping
    # every other level of the same hierarchy from the compiled cube), and a
    # secondary attribute needs its own attribute-key/keyed-attribute pair
    # referenced from its parent level via <keyed-attribute-ref> - a plain
    # SML `secondary_attributes` entry alone never reached the compiled XML
    # AtScale's deploy endpoint actually builds the cube from, so it was
    # silently dropped for any model this wizard generated (confirmed: a
    # hand-authored repo not deployed through this pipeline shows secondary
    # attributes fine; one generated and deployed by this wizard didn't).
    def _make_ka(dim_name: str, level_name: str, attr_name: str, la: dict[str, Any]) -> dict[str, Any]:
        key_id = _gen_id(ns, f"{dim_name}.{level_name}.{attr_name}.key")
        attr_id = _gen_id(ns, f"{dim_name}.{level_name}.{attr_name}.attr")
        ds_id = _gen_id(ns, la.get("dataset") or "")
        # SML lets an attribute's join/identity column (key_columns) differ
        # from its display column (name_column) - e.g. join on the surrogate
        # key `productkey` but show `englishproductname` (confirmed correct
        # and required: sales-insights-postgres' hand-authored "Product
        # Name" level does exactly this and queries fine). The legacy
        # catalog XML has two separate elements for this - <key-ref> (what
        # actually gets joined against) and <attribute-ref> (what's
        # displayed) - so they need their own column, not one shared column
        # defaulting to name_column: that previously made the compiled XML
        # join the fact's int/bigint FK against a text display column
        # whenever the two differed, producing a runtime "operator does not
        # exist: bigint = text" from the SQL engine.
        key_col = (la.get("key_columns") or [la["unique_name"]])[0]
        attr_col = la.get("name_column") or key_col
        return {
            "laUniqueName": la["unique_name"],
            "datasetName": la.get("dataset") or "",
            "keyColumnName": key_col,
            "attrColumnName": attr_col,
            "label": la.get("label") or la["unique_name"],
            "keyId": key_id,
            "attrId": attr_id,
            "datasetId": ds_id,
        }

    keyed_attrs: list[dict[str, Any]] = []
    # level unique_name -> its own ka (not a secondary's) - for the <level
    # primary-attribute="..."> reference below, and for resolving each fact
    # relationship's join target in the cube's data-set-ref further down.
    own_ka_by_level: dict[str, dict[str, Any]] = {}
    # level unique_name -> [ka, ...] for its secondary_attributes, so the
    # hierarchy XML can emit <keyed-attribute-ref> under the right <level>.
    secondary_kas_by_level: dict[str, list[dict[str, Any]]] = {}
    # dataset name -> every ka backed by it, so a dataset that backs several
    # levels/secondaries (the common case - one table, several attributes)
    # gets a <key-ref>/<attribute-ref> for each instead of only the first.
    kas_by_dataset: dict[str, list[dict[str, Any]]] = {}

    for dim_name in ref_dim_names:
        dim = dimensions_map.get(dim_name)
        if not dim:
            continue
        la_map = {la["unique_name"]: la for la in dim.get("level_attributes") or []}
        for h in dim.get("hierarchies") or []:
            for level in h.get("levels") or []:
                level_name = level["unique_name"]
                la = la_map.get(level_name)
                if not la:
                    continue
                ka = _make_ka(dim_name, level_name, level_name, la)
                keyed_attrs.append(ka)
                own_ka_by_level[level_name] = ka
                kas_by_dataset.setdefault(ka["datasetName"], []).append(ka)

                for sec in level.get("secondary_attributes") or []:
                    sec_la = la_map.get(sec["unique_name"]) or sec
                    sec_ka = _make_ka(dim_name, level_name, sec["unique_name"], sec_la)
                    keyed_attrs.append(sec_ka)
                    kas_by_dataset.setdefault(sec_ka["datasetName"], []).append(sec_ka)
                    secondary_kas_by_level.setdefault(level_name, []).append(sec_ka)

    # -- fact datasets with metric columns --
    fact_datasets: dict[str, dict[str, Any]] = {}
    for ds_name in fact_dataset_names:
        ds = datasets_map.get(ds_name)
        if not ds:
            continue
        # Every relationship from this fact dataset needs its own <key-ref>
        # in the cube's data-set-ref (confirmed against a real legacy
        # project XML, atscale-xml-sml/enterprise_sales.xml: a fact dataset
        # joined to two dimensions has two <key-ref> elements, each with the
        # id of the *target level's own* attribute-key and the fact's own
        # join column) - picking only the first relationship's join column
        # (this dict's old single `joinColName` field) silently left every
        # dimension after the first one unwired from the cube, even though
        # its own dimension/level/dataset XML was otherwise correct.
        # De-duplicated by target level: a role-played relationship (the
        # same level joined via more than one FK, e.g. Order/Ship dates)
        # needs the `<ref-path>` mechanism this compiler doesn't implement
        # yet to represent more than one such join without id collisions -
        # so only the first join to a given level is wired here for now,
        # same limitation as before, just no longer affecting every *other*
        # dimension too.
        seen_levels: set[tuple[str, str]] = set()
        joins: list[dict[str, str]] = []
        for r in relationships:
            if r["fromDataset"] != ds_name or not r["joinColumns"]:
                continue
            level_key = (r["toDimension"], r["toLevel"])
            if level_key in seen_levels:
                continue
            seen_levels.add(level_key)
            joins.append({"toDimension": r["toDimension"], "toLevel": r["toLevel"], "joinColumn": r["joinColumns"][0]})
        fact_datasets[ds_name] = {
            "datasetName": ds_name,
            "ds": ds,
            "dsId": _gen_id(ns, ds_name),
            "metrics": [],
            "joins": joins,
        }

    model_cube_name = model.get("unique_name") or model.get("label") or "model"
    for metric_ref in model.get("metrics") or []:
        mn = metric_ref if isinstance(metric_ref, str) else metric_ref.get("unique_name")
        m = metrics_map.get(mn)
        if not m:
            continue
        fde = fact_datasets.get(m.get("dataset"))
        if not fde:
            continue
        fde["metrics"].append(
            {"unique_name": m["unique_name"], "column": m.get("column"), "attrId": _gen_id(ns, f"{model_cube_name}.{m['unique_name']}")}
        )

    # -- dimension datasets: one <data-set> per physical dataset, but a
    # <key-ref>/<attribute-ref> pair for *every* ka backed by it (a dataset
    # commonly backs several levels/secondaries at once - grouping by only
    # the first ka silently dropped every other attribute on that table).
    # A degenerate dimension's ka can be backed by the fact table itself
    # (same dataset name/id as a fact_datasets entry) - that dataset's
    # physical <data-set> is emitted once, below, under fact_datasets_xml
    # with these same kas folded into its <logical> block; emitting a
    # second <data-set> here for it would duplicate its id.
    dim_datasets: list[dict[str, Any]] = []
    seen_dim_ds: set[str] = set()
    for ka in keyed_attrs:
        if ka["datasetName"] in seen_dim_ds or ka["datasetName"] in fact_datasets:
            continue
        seen_dim_ds.add(ka["datasetName"])
        ds = datasets_map.get(ka["datasetName"])
        if not ds:
            continue
        dim_datasets.append({"datasetName": ka["datasetName"], "ds": ds, "dsId": ka["datasetId"]})

    # -- dimensions XML: every level of every referenced hierarchy (not just
    # the one a fact relationship directly joins to), each with its own
    # <keyed-attribute-ref> for any secondary attributes attached to it. --
    dimensions_xml_parts = []
    for dim_name in ref_dim_names:
        dim = dimensions_map.get(dim_name)
        if not dim:
            continue
        dim_id = _gen_id(ns, dim_name)
        hier_parts = []
        for h in dim.get("hierarchies") or []:
            level_parts = []
            for level in h.get("levels") or []:
                level_name = level["unique_name"]
                ka = own_ka_by_level.get(level_name)
                if not ka:
                    continue
                sec_refs = "".join(
                    f"""
          <keyed-attribute-ref attribute-id="{sec_ka['attrId']}">
            <properties>
              <multiplicity></multiplicity>
            </properties>
          </keyed-attribute-ref>"""
                    for sec_ka in secondary_kas_by_level.get(level_name, [])
                )
                level_parts.append(
                    f"""
        <level primary-attribute="{ka['attrId']}">
          <properties>
            <unique-in-parent>false</unique-in-parent>
            <visible>true</visible>
          </properties>{sec_refs}
        </level>"""
                )
            if not level_parts:
                continue
            hier_id = _gen_id(ns, f"{dim_name}.{h['unique_name']}")
            hier_parts.append(
                f"""
      <hierarchy id="{hier_id}" name="{_esc(h['unique_name'])}">
        <properties>
          <caption>{_esc(h.get('label') or h['unique_name'])}</caption>
          <visible>true</visible>
          <filter-empty>Always</filter-empty>
          <default-member><all-member></all-member></default-member>
        </properties>{"".join(level_parts)}
      </hierarchy>"""
            )
        hierarchies_xml = "".join(hier_parts)
        if not hierarchies_xml:
            continue
        dimensions_xml_parts.append(
            f"""
  <dimension id="{dim_id}" name="{_esc(dim_name)}">
    <properties>
      <visible>true</visible>
      <caption>{_esc(dim.get('label') or dim_name)}</caption>
      <dimension-type>Other</dimension-type>
    </properties>{hierarchies_xml}
  </dimension>"""
        )
    dimensions_xml = "".join(dimensions_xml_parts)

    def columns_xml(ds: dict[str, Any]) -> str:
        return "".join(
            f"\n        <column><name>{_esc(c['name'])}</name><type>{_sml_type_to_xml(c.get('data_type'))}</type></column>"
            for c in ds.get("columns") or []
        )

    dim_datasets_xml_parts = []
    for entry in dim_datasets:
        ds_name, ds, ds_id = entry["datasetName"], entry["ds"], entry["dsId"]
        table_name = ds.get("table") or ds_name.replace(".dataset", "")
        conn_id = as_connection_id(ds.get("connection_id"))
        refs = "".join(
            f"""
      <key-ref id="{ka['keyId']}" unique="false" complete="true">
        <column>{_esc(ka['keyColumnName'])}</column>
      </key-ref>
      <attribute-ref id="{ka['attrId']}" complete="true">
        <column>{_esc(ka['attrColumnName'])}</column>
      </attribute-ref>"""
            for ka in kas_by_dataset.get(ds_name, [])
        )
        dim_datasets_xml_parts.append(
            f"""
  <data-set id="{ds_id}" name="{_esc(ds_name)}">
    <properties><allow-aggregates>true</allow-aggregates></properties>
    <physical>
      <connection id="{_esc(conn_id)}"></connection>
      <table>
        <database>{_esc(default_database)}</database>
        <schema>{_esc(default_schema)}</schema>
        <name>{_esc(table_name)}</name>
      </table>
      <immutable>false</immutable>{columns_xml(ds)}
    </physical>
    <logical>{refs}
    </logical>
  </data-set>"""
        )
    dim_datasets_xml = "".join(dim_datasets_xml_parts)

    fact_datasets_xml_parts = []
    for fde in fact_datasets.values():
        ds_name, ds, ds_id = fde["datasetName"], fde["ds"], fde["dsId"]
        table_name = ds.get("table") or ds_name.replace(".dataset", "")
        conn_id = as_connection_id(ds.get("connection_id"))
        # A degenerate dimension attribute living on this same fact table
        # (no join, so it never shows up in `joins`/`metrics` above) gets its
        # key-ref/attribute-ref folded in here rather than a separate
        # <data-set> - see the dim_datasets skip above.
        degenerate_refs = "".join(
            f"""
      <key-ref id="{ka['keyId']}" unique="false" complete="true">
        <column>{_esc(ka['keyColumnName'])}</column>
      </key-ref>
      <attribute-ref id="{ka['attrId']}" complete="true">
        <column>{_esc(ka['attrColumnName'])}</column>
      </attribute-ref>"""
            for ka in kas_by_dataset.get(ds_name, [])
        )
        fact_datasets_xml_parts.append(
            f"""
  <data-set id="{ds_id}" name="{_esc(ds_name)}">
    <properties><allow-aggregates>true</allow-aggregates></properties>
    <physical>
      <connection id="{_esc(conn_id)}"></connection>
      <table>
        <database>{_esc(default_database)}</database>
        <schema>{_esc(default_schema)}</schema>
        <name>{_esc(table_name)}</name>
      </table>
      <immutable>false</immutable>{columns_xml(ds)}
    </physical>
    <logical>{degenerate_refs}
    </logical>
  </data-set>"""
        )
    fact_datasets_xml = "".join(fact_datasets_xml_parts)

    # -- cube XML --
    cube_id = _gen_id(ns, model_cube_name)

    measure_attrs_parts = []
    for fde in fact_datasets.values():
        for m in fde["metrics"]:
            mn = metrics_map.get(m["unique_name"])
            agg = (mn.get("calculation_method") if mn else "sum").upper()
            def_agg = _AGG_MAP.get(agg, "SUM")
            measure_attrs_parts.append(
                f"""
      <attribute id="{m['attrId']}" name="{_esc(m['unique_name'])}">
        <properties>
          <visible>true</visible>
          <caption>{_esc((mn or {}).get('label') or m['unique_name'])}</caption>
          <type><measure><default-aggregation>{def_agg}</default-aggregation></measure></type>
        </properties>
      </attribute>"""
            )
    measure_attrs_xml = "".join(measure_attrs_parts)

    cube_ds_refs_parts = []
    for fde in fact_datasets.values():
        # One <key-ref> per dimension this fact dataset actually joins to -
        # each keyed by that *target level's own* attribute-key id (matching
        # a real legacy project XML's pattern for a fact joined to more than
        # one dimension: multiple <key-ref> elements, one per dimension,
        # each carrying the target's key id and this fact's own join
        # column). Using a single id for every join here before this fix
        # left every dimension but one unwired from the cube.
        key_refs = "".join(
            f"\n          <key-ref id=\"{ka['keyId']}\" unique=\"false\" complete=\"false\"><column>{_esc(j['joinColumn'])}</column></key-ref>"
            for j in fde["joins"]
            for ka in [own_ka_by_level.get(j["toLevel"])]
            if ka
        )
        attr_refs = "".join(
            f"\n          <attribute-ref id=\"{m['attrId']}\" complete=\"true\"><column>{_esc(m['column'])}</column></attribute-ref>"
            for m in fde["metrics"]
        )
        cube_ds_refs_parts.append(
            f"""
    <data-set-ref id="{fde['dsId']}">
      <logical>{key_refs}{attr_refs}
      </logical>
    </data-set-ref>"""
        )
    cube_ds_refs_xml = "".join(cube_ds_refs_parts)

    cubes_xml = f"""
  <cube id="{cube_id}" name="{_esc(model_cube_name)}">
    <properties>
      <caption>{_esc(model.get('label') or model_cube_name)}</caption>
      <visible>true</visible>
    </properties>
    <attributes>{measure_attrs_xml}
    </attributes>
    <data-sets>{cube_ds_refs_xml}
    </data-sets>
    <calculated-members></calculated-members>
  </cube>"""

    attrs_xml = "".join(
        f"""
  <attribute-key id="{ka['keyId']}"><properties><visible>true</visible><columns>1</columns></properties></attribute-key>
  <keyed-attribute id="{ka['attrId']}" key-ref="{ka['keyId']}" name="{_esc(ka['laUniqueName'])}"><properties><visible>true</visible><caption>{_esc(ka['label'])}</caption><type><enum></enum></type><ordering><sort-key><order>ascending</order><value></value></sort-key></ordering></properties></keyed-attribute>"""
        for ka in keyed_attrs
    )

    return (
        '<schema xmlns="http://www.atscale.com/xsd/project_2_0"'
        f' name="{_esc(project_name)}" version="2.0"'
        ' xsi:schemaLocation="http://www.atscale.com/xsd/project_2_0 ../../../../../core/src/main/resources/com/atscale/engine/schema/project_2_0.xsd"'
        ' xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"'
        ' xmlns:xsd="http://www.w3.org/2001/XMLSchema">'
        "<annotations>"
        '<annotation name="migrationVersion">2020.3.0.1</annotation>'
        f'<annotation name="engineId">{engine_id}</annotation>'
        '<annotation name="version">version-to-be-generated-on-deploy</annotation>'
        "</annotations>"
        "<properties>"
        "<visible>true</visible>"
        f"<caption>{_esc(caption)}</caption>"
        "<aggregate-prediction><speculative-aggregates>false</speculative-aggregates></aggregate-prediction>"
        "</properties>"
        f"<attributes>{attrs_xml}\n</attributes>"
        f"<dimensions>{dimensions_xml}\n</dimensions>"
        f"<data-sets>{dim_datasets_xml}{fact_datasets_xml}\n</data-sets>"
        "<calculated-members></calculated-members>"
        f"<cubes>{cubes_xml}\n</cubes>"
        "</schema>"
    )
