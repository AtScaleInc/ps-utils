"""Which parts of a loaded SML repo Build can't write back.

Build regenerates every file from the canvas (build.py), so anything parse.py
doesn't carry onto the canvas is dropped on the next Save or Deploy - a
semi-additive metric turns additive, row security disappears, a second model
is never written. `unsupported_features()` lists those, per the SML reference
(ps-utils resources/sml-reference, a verbatim copy of semanticdatalayer/SML
sml-reference/): the allowed keys below are exactly what build.py emits and
parse.py reads back. A repo with any finding opens read-only (no Save, no
Deploy); the API refuses to overwrite such a working copy.

New Python logic, not a ps-utils port - Build's own SML subset.
"""

from __future__ import annotations

from typing import Any

import yaml

from .rules import AGG_TO_CALC_METHOD, cased

#: First line of every file build.py writes - marks a repo built here.
BUILT_BY_MARKER = "# Built with AtScale Environment Manager (Build)"

_CALC_METHODS = set(AGG_TO_CALC_METHOD.values())

# Keys build.py writes (parse.py reads them all back). Anything else is lost.
_CATALOG = {"unique_name", "object_type", "label", "version", "aggressive_agg_promotion", "build_speculative_aggs"}
_CONNECTION = {"unique_name", "object_type", "label", "as_connection", "database", "schema"}
_DATASET = {"unique_name", "object_type", "label", "columns", "connection_id", "table"}
_DATASET_COLUMN = {"name", "data_type"}
_DIMENSION = {"unique_name", "object_type", "label", "type", "is_degenerate", "hierarchies", "level_attributes", "relationships"}
_HIERARCHY = {"unique_name", "label", "levels"}
_LEVEL = {"unique_name", "secondary_attributes"}
_SECONDARY = {"unique_name", "label", "dataset", "key_columns", "name_column", "sort_column"}
_LEVEL_ATTR = {"unique_name", "label", "contains_unique_names", "dataset", "key_columns", "name_column",
               "sort_column", "time_unit", "is_unique_key"}
_DIM_REL = {"unique_name", "from", "to", "type"}
_METRIC = {"unique_name", "object_type", "label", "calculation_method", "column", "dataset", "unrelated_dimensions_handling"}
_CALC = {"unique_name", "object_type", "label", "expression", "description"}
_MODEL = {"unique_name", "object_type", "label", "relationships", "metrics", "dimensions"}
_MODEL_REL = {"unique_name", "from", "to", "role_play"}

#: Object types Build has no canvas for at all.
_OBJECT_FEATURES = {
    "composite_model": "Composite model",
    "row_security": "Row security",
    "package": "Package (shared objects from another repo)",
}

#: Friendlier names for the keys users most often hit.
_KEY_FEATURES = {
    "semi_additive": "Semi-additive metric",
    "calculation_groups": "Calculation groups",
    "perspectives": "Perspectives",
    "drillthroughs": "Drill-throughs",
    "aggregates": "User-defined aggregates",
    "partitions": "Aggregate partitions",
    "overrides": "Query name overrides",
    "dataset_properties": "Dataset properties",
    "sql": "SQL (query) dataset / calculated column",
    "incremental": "Incremental aggregate builds",
    "parallel_periods": "Parallel periods",
    "aliases": "Level aliases",
    "metrics": "Metrical attributes",
    "m2m": "Many-to-many relationship",
    "role_play": "Role-played dimension-to-dimension relationship",
    "custom_empty_member": "Custom empty member",
    "shared_degenerate_columns": "Shared degenerate columns",
    "named_quantiles": "Quantile metric",
    "custom_quantiles": "Quantile metric",
    "compression": "Percentile compression",
    "format": "Formats",
    "folder": "Folders",
    "is_hidden": "Hidden objects",
    "description": "Descriptions",
    "map": "Map column",
    "parent_column": "Map column",
    "dialects": "Dialect-specific SQL",
    "filter_empty": "Hierarchy empty-member filter",
    "default_member": "Hierarchy default member",
    "associated_hierarchy": "Associated hierarchy",
    "mdx_aggregation_function": "MDX aggregation function",
    "mdx_aggregate_function": "MDX aggregation function",
    "include_default_drillthrough": "Drill-throughs",
    "constraint_translation": "Constraint translation",
    "project_properties": "Project / model properties",
    "model_properties": "Project / model properties",
    "modeler_metadata": "Design Center metadata",
    "override": "Connection overrides",
    "visible": "Visibility",
    "immutable": "Immutable dataset",
    "qds_materialization": "Materialized query dataset",
    "allowed_calcs_for_dma": "Calculations allowed for DMA",
    "exclude_from_dim_agg": "Aggregate exclusions",
    "exclude_from_fact_agg": "Aggregate exclusions",
    "is_aggregatable": "Aggregate exclusions",
    "constraint_translation_rank": "Constraint translation",
    "is_excel_pivot_table_property": "Excel properties",
    "is_user_defined_property": "Excel properties",
    "type": "Metric type",
}

#: Lost on save but not modelling logic - listed after the complex features.
_COSMETIC = {
    "Folders", "Formats", "Descriptions", "Labels", "Hidden objects", "Visibility", "Identifier casing",
    "Design Center metadata", "Project / model properties", "Excel properties",
}


def _recased(identifier: str, dialect: str | None) -> str | None:
    """What build.py would write instead, or None when it keeps the name.
    Dialect unknown: only a mixed-case name is sure to change."""
    if dialect:
        out = cased(identifier, dialect)
        return out if out != identifier else None
    return identifier.lower() if identifier not in (identifier.lower(), identifier.upper()) else None


def _load(files: dict[str, str]) -> list[tuple[str, dict]]:
    out = []
    for path, body in sorted(files.items()):
        try:
            doc = yaml.safe_load(body)
        except yaml.YAMLError:
            continue
        if isinstance(doc, dict) and doc.get("object_type"):
            out.append((path, doc))
    return out


def built_here(files: dict[str, str]) -> bool:
    """True when the catalog file still carries build.py's marker - Design
    Center rewrites the file without it, so a model edited there reads as foreign."""
    for path, body in files.items():
        if body.lstrip().startswith(BUILT_BY_MARKER):
            try:
                if (yaml.safe_load(body) or {}).get("object_type") == "catalog":
                    return True
            except yaml.YAMLError:
                continue
    return False


def unsupported_features(files: dict[str, str], dialect: str | None = None) -> list[dict[str, str]]:
    """[{feature, detail, file, kind}] - one row per thing a regenerate would lose;
    kind "complex" (modelling logic) or "detail" (folders, formats, labels ...).
    Empty means Build round-trips the repo. `dialect` decides identifier casing
    (build.py cases table / column names); None lowercases, as build.py does."""
    found: list[dict[str, str]] = []
    seen: set[tuple[str, str, str]] = set()

    def add(feature: str, detail: str, path: str) -> None:
        if (feature, detail, path) not in seen:
            seen.add((feature, detail, path))
            kind = "detail" if feature in _COSMETIC else "complex"
            found.append({"feature": feature, "detail": detail, "file": path, "kind": kind})

    def extra_keys(obj: dict, allowed: set[str], where: str, path: str) -> None:
        for key in obj:
            if key not in allowed:
                add(_KEY_FEATURES.get(key, f"'{key}'"), f"{where}: {key}", path)

    docs = _load(files)
    by_type: dict[str, list[tuple[str, dict]]] = {}
    for path, doc in docs:
        by_type.setdefault(doc["object_type"], []).append((path, doc))

    for obj_type, feature in _OBJECT_FEATURES.items():
        for path, doc in by_type.get(obj_type, []):
            add(feature, doc.get("unique_name") or obj_type, path)
    known = {"catalog", "connection", "dataset", "dimension", "metric", "metric_calc", "model", *_OBJECT_FEATURES}
    for obj_type, items in by_type.items():
        if obj_type not in known:
            for path, doc in items:
                add(f"'{obj_type}' object", doc.get("unique_name") or obj_type, path)

    models = by_type.get("model", [])
    if len(models) > 1:
        names = ", ".join(d.get("unique_name", "?") for _, d in models)
        add("More than one model", names, models[1][0])
    model_name = models[0][1].get("unique_name") if models else None

    for path, doc in by_type.get("catalog", []):
        extra_keys(doc, _CATALOG, "catalog", path)
        for flag in ("aggressive_agg_promotion", "build_speculative_aggs"):
            if doc.get(flag):
                add("Catalog settings", f"{flag}: true (Build writes false)", path)
        # build.py names the catalog <model>_catalog - another name is a new catalog on deploy.
        if model_name and doc.get("unique_name") != f"{model_name}_catalog":
            add("Catalog name", f"'{doc.get('unique_name')}' (Build writes '{model_name}_catalog')", path)

    connections = by_type.get("connection", [])
    for path, doc in connections:
        extra_keys(doc, _CONNECTION, f"connection {doc.get('unique_name')}", path)
    if len(connections) > 1:
        add("More than one connection", ", ".join(d.get("unique_name", "?") for _, d in connections), connections[1][0])

    for path, ds in by_type.get("dataset", []):
        name = ds.get("unique_name", "?")
        extra_keys(ds, _DATASET, f"dataset {name}", path)
        for col in ds.get("columns") or []:
            extra_keys(col, _DATASET_COLUMN, f"dataset {name}, column {col.get('name')}", path)
            if col.get("name") and (new := _recased(col["name"], dialect)):
                add("Identifier casing", f"dataset {name}, column {col['name']} (Build writes {new})", path)
        table = ds.get("table")
        if table and table.lower() != str(name).lower():
            add("Dataset name differs from its table", f"{name} -> {table}", path)
        elif table and (new := _recased(table, dialect)):
            add("Identifier casing", f"dataset {name}, table {table} (Build writes {new})", path)
        if ds.get("label") not in (None, name):
            add("Labels", f"dataset {name}: '{ds['label']}'", path)

    metrics_on_column: dict[tuple[str, str], list[str]] = {}
    for path, m in by_type.get("metric", []):
        name = m.get("unique_name", "?")
        extra_keys(m, _METRIC, f"metric {name}", path)
        method = m.get("calculation_method")
        if method not in _CALC_METHODS:
            add("Calculation method", f"metric {name}: {method}", path)
        udh = m.get("unrelated_dimensions_handling")
        if udh != "repeat":
            add("Unrelated dimensions handling", f"metric {name}: {udh or 'default'} (Build writes repeat)", path)
        metrics_on_column.setdefault((m.get("dataset"), m.get("column")), []).append(name)
    for (ds, col), names in metrics_on_column.items():
        if len(names) > 1:
            add("Several metrics on one column", f"{ds}.{col}: {', '.join(names)}", "metrics/")

    for path, c in by_type.get("metric_calc", []):
        extra_keys(c, _CALC, f"calculation {c.get('unique_name')}", path)

    for path, dim in by_type.get("dimension", []):
        _check_dimension(path, dim, dialect, add, extra_keys)

    for path, model in models[:1]:
        _check_model(path, model, by_type, add, extra_keys)

    return found


def _check_dimension(path: str, dim: dict, dialect: str | None, add, extra_keys) -> None:
    name = dim.get("unique_name", "?")
    where = f"dimension {name}"
    extra_keys(dim, _DIMENSION, where, path)
    level_attrs = dim.get("level_attributes") or []
    hierarchies = dim.get("hierarchies") or []
    datasets = {la.get("dataset") for la in level_attrs}
    if len(hierarchies) > 1:
        add("More than one hierarchy", f"{where}: {', '.join(h.get('unique_name', '?') for h in hierarchies)}", path)
    if len(datasets) > 1:
        add("Dimension over several datasets (snowflake)", f"{where}: {', '.join(sorted(map(str, datasets)))}", path)

    if dim.get("is_degenerate"):
        # build.py: one level, unique_name = the level's label, name = key column.
        if len(level_attrs) > 1:
            add("Degenerate dimension with several levels", where, path)
        for la in level_attrs[:1]:
            if la.get("label") != name:
                add("Labels", f"{where}: level label '{la.get('label')}' (Build names the dimension after it)", path)
            if la.get("name_column") != (la.get("key_columns") or [None])[0]:
                add("Degenerate dimension name column", f"{where}: {la.get('name_column')}", path)
    elif dim.get("label") not in (None, name):
        add("Labels", f"{where}: '{dim['label']}'", path)

    in_hierarchy: set[str] = set()
    for h in hierarchies:
        extra_keys(h, _HIERARCHY, f"{where}, hierarchy {h.get('unique_name')}", path)
        if h.get("label") not in (None, h.get("unique_name")):
            add("Labels", f"{where}, hierarchy {h.get('unique_name')}: '{h['label']}'", path)
        for lv in h.get("levels") or []:
            lname = lv.get("unique_name", "?")
            in_hierarchy.add(lname)
            extra_keys(lv, _LEVEL, f"{where}, level {lname}", path)
            if new := _recased(lname, dialect):
                add("Identifier casing", f"{where}, level {lname} (Build writes {new})", path)
            for sec in lv.get("secondary_attributes") or []:
                sname = sec.get("unique_name", "?")
                extra_keys(sec, _SECONDARY, f"{where}, attribute {sname}", path)
                if len(sec.get("key_columns") or []) > 1:
                    add("Composite key", f"{where}, attribute {sname}: {sec['key_columns']}", path)
                if new := _recased(sname, dialect):
                    add("Identifier casing", f"{where}, attribute {sname} (Build writes {new})", path)

    for la in level_attrs:
        lname = la.get("unique_name", "?")
        extra_keys(la, _LEVEL_ATTR, f"{where}, level attribute {lname}", path)
        if len(la.get("key_columns") or []) > 1:
            add("Composite key", f"{where}, level {lname}: {la['key_columns']}", path)
        if hierarchies and lname not in in_hierarchy:
            add("Level attribute outside the hierarchy", f"{where}: {lname}", path)

    for rel in dim.get("relationships") or []:
        rname = rel.get("unique_name", "?")
        extra_keys(rel, _DIM_REL, f"{where}, relationship {rname}", path)
        to = rel.get("to") or {}
        if not to.get("dimension") or rel.get("type") == "snowflake":
            add("Dimension over several datasets (snowflake)", f"{where}, relationship {rname}", path)
        if len((rel.get("from") or {}).get("join_columns") or []) > 1:
            add("Composite join", f"{where}, relationship {rname}", path)


def _check_model(path: str, model: dict, by_type: dict, add, extra_keys) -> None:
    name = model.get("unique_name", "?")
    extra_keys(model, _MODEL, f"model {name}", path)
    if model.get("label") not in (None, name):
        add("Labels", f"model {name}: '{model['label']}'", path)
    for rel in model.get("relationships") or []:
        rname = rel.get("unique_name", "?")
        extra_keys(rel, _MODEL_REL, f"model relationship {rname}", path)
        for side in ("from", "to"):
            allowed = {"dataset", "join_columns"} if side == "from" else {"dimension", "level"}
            extra_keys(rel.get(side) or {}, allowed, f"model relationship {rname}.{side}", path)
        if len((rel.get("from") or {}).get("join_columns") or []) > 1:
            add("Composite join", f"model relationship {rname}", path)
    for m in model.get("metrics") or []:
        if isinstance(m, dict):
            extra_keys(m, {"unique_name"}, f"model metric {m.get('unique_name')}", path)
    degenerate = {d.get("unique_name") for _, d in by_type.get("dimension", []) if d.get("is_degenerate")}
    for d in model.get("dimensions") or []:
        dname = d.get("unique_name") if isinstance(d, dict) else d
        if dname not in degenerate:
            add("Dimension listed on the model without a relationship", f"model {name}: {dname}", path)
