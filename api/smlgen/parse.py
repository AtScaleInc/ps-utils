"""Reverse of build.py: reconstructs the wizard's {nodes, joins, cfg} model
state from an existing SML repo, so the wizard can load a model someone else
already built (locally, or pulled from the Git repo AtScale is linked to)
instead of only ever starting from a blank canvas.

Known simplifications (this wizard's one-node-per-table, one-hierarchy-per-
dimension model is a deliberate subset of what SML can express - confirmed
against two real repos, sample-dev and sales-insights-postgres):

- SML's "level alias" (Rule 8 - a secondary attribute that shares its level's
  own key_columns, used as an alternate display name) and an ordinary
  secondary attribute are structurally identical once emitted (both are
  `secondary_attributes` entries) unless the alias's key_columns are checked
  against its parent level's key_columns. This parser treats every
  secondary_attributes entry as `dimRole: 'secondary'`; distinguishing a true
  alias by comparing key_columns is a follow-up, not implemented here.
- A dimension spanning *multiple physical datasets joined into one hierarchy*
  (`type: snowflake` relationships with no `to.dimension` - confirmed in
  sales-insights-postgres/dimensions/Geography Dimension.yml, e.g. Country /
  State / City / Zip each backed by a different table but forming ONE
  Geography dimension) is a different, still-valid SML pattern this wizard
  doesn't yet support authoring. Such relationships are skipped rather than
  crashing; the dimension imports using only its first dataset's columns.
- A dimension with more than one hierarchy (e.g. a Date dimension with a
  separate 445-retail-calendar hierarchy alongside the plain calendar one)
  collapses onto this wizard's single hierarchy per node - relationships
  from multiple fact FKs to different hierarchies of the same dimension can
  end up as duplicate-looking joins once resolved to a single {node, column}
  pair, since both hierarchies key off the same underlying column. Exact
  duplicates are deduped below; the extra hierarchy itself is not imported.
- SML legitimately lets a level's `key_columns` (join/identity - can be
  composite), `name_column` (display), and `sort_column` differ - this
  wizard's canvas only tracks one column per level, so a level is resolved
  by `name_column` (what a user would actually drag onto the canvas and mark
  as a level), never `key_columns[0]`. Picking `key_columns[0]` used to
  silently collide two unrelated levels onto the same cfg entry whenever a
  composite key shared its leading column with a sibling level's single-
  column key (confirmed in sales-insights-postgres' Product Dimension:
  "Product Category" is keyed by `[productline, productsubcategorykey]`,
  "Product Line" by `[productline]` alone) - the loser vanished and the
  survivor kept its original, now non-contiguous hierarchy position as its
  levelOrder. `sort_column` isn't tracked at all yet if it differs from
  `name_column` - a follow-up, not implemented here.
"""

from __future__ import annotations

from typing import Any

import yaml

from .packages import is_shared_repo
from .rules import AGG_TO_CALC_METHOD
from .support import built_here, unsupported_features

CALC_METHOD_TO_AGG = {v: k for k, v in AGG_TO_CALC_METHOD.items()}

#: A connection's `as_connection` names AtScale's own connection object, not a
#: dialect string (build.py's identifier-casing rules need "postgresql" /
#: "snowflake" / etc.) - this is a best-effort guess from that name for a
#: freshly-imported model; the field can always be re-picked via the Data
#: Source panel, which gets the dialect straight from AtScale instead.
_DIALECT_HINTS = {
    "snowflake": "snowflake",
    "postgres": "postgresql",
    "databricks": "databricks",
    "bigquery": "bigquery",
    "redshift": "redshift",
}


def _guess_dialect(as_connection: str | None) -> str | None:
    if not as_connection:
        return None
    lowered = as_connection.lower()
    for hint, dialect in _DIALECT_HINTS.items():
        if hint in lowered:
            return dialect
    return None


def _load_all(files: dict[str, str]) -> dict[str, Any]:
    parsed: dict[str, Any] = {
        "catalog": None,
        "connections": {},
        "datasets": {},
        "dimensions": {},
        "metrics": {},
        "calculations": {},
        "model": None,
    }
    for path, body in files.items():
        doc = yaml.safe_load(body)
        if not isinstance(doc, dict):
            continue
        object_type = doc.get("object_type")
        if object_type == "catalog":
            parsed["catalog"] = doc
        elif object_type == "connection":
            parsed["connections"][doc["unique_name"]] = doc
        elif object_type == "dataset":
            parsed["datasets"][doc["unique_name"]] = doc
        elif object_type == "dimension":
            parsed["dimensions"][doc["unique_name"]] = doc
        elif object_type == "metric":
            parsed["metrics"][doc["unique_name"]] = doc
        elif object_type == "metric_calc":
            parsed["calculations"][doc["unique_name"]] = doc
        elif object_type == "model":
            parsed["model"] = doc
    return parsed


#: Exposed for the deploy pipeline (api/atscale/deploy.py), which needs the
#: same catalog/model/dimensions/datasets/metrics/connections maps this
#: function builds internally, to compile the legacy catalog XML.
load_sml_objects = _load_all


def parse_sml(files: dict[str, str], packages: list[dict[str, Any]] | None = None,
              all_package_dims: bool = False) -> dict[str, Any]:
    """`packages`: [{ref: {name, url, branch, version}, files}] - the repos the
    root package.yml lists, fetched at their pinned commit. Their dimensions
    become read-only nodes carrying `package: ref` (smlgen/packages.py): the
    ones this repo's model / dimensions reference, or every one with
    `all_package_dims` (the shared-dimension picker)."""
    parsed = _load_all(files)
    datasets = parsed["datasets"]
    dimensions = parsed["dimensions"]
    metrics = parsed["metrics"]
    calculations_by_name = parsed["calculations"]
    connections = parsed["connections"]
    model = parsed["model"] or {}

    # Root objects win a name clash, as they do once AtScale merges packages.
    package_of_dataset: dict[str, dict] = {}
    package_schema: dict[str, str] = {}
    package_dims: set[str] = set()
    for pkg in packages or []:
        pp = _load_all(pkg.get("files") or {})
        for name, dim in pp["dimensions"].items():
            if name not in dimensions and not dim.get("is_degenerate"):
                dimensions[name] = dim
                package_dims.add(name)
        for name, ds in pp["datasets"].items():
            if name not in datasets:
                datasets[name] = ds
                package_of_dataset[name] = pkg["ref"]
                con = pp["connections"].get(ds.get("connection_id")) or {}
                package_schema[name] = con.get("schema", "")
    if package_dims and not all_package_dims:
        wanted = {r["to"].get("dimension") for r in model.get("relationships") or [] if r.get("to")}
        for name, dim in list(dimensions.items()):
            if name not in package_dims:
                wanted |= {r["to"].get("dimension") for r in dim.get("relationships") or [] if r.get("to")}
        for name in package_dims - wanted:
            dimensions.pop(name)

    # This wizard only ever authors a model against a single connection (one
    # data source picked in the Data Source panel), so on import just take
    # whichever connection the first dataset points at - not a per-dataset lookup.
    first_dataset = next((d for n, d in datasets.items() if n not in package_of_dataset), None)
    connection = connections.get(first_dataset.get("connection_id")) if first_dataset else None
    source_schema = connection.get("schema", "") if connection else ""
    source = (
        {
            "connectionId": connection.get("as_connection"),
            "database": connection.get("database"),
            "dialect": _guess_dialect(connection.get("as_connection")),
        }
        if connection
        else None
    )

    # -- classify each dataset: fact (backs a metric), dimension (backs a
    # non-degenerate dimension's level_attributes), or unused --
    fact_dataset_names: set[str] = {m["dataset"] for m in metrics.values() if "dataset" in m}
    dim_by_dataset: dict[str, dict] = {}
    degenerate_dims: list[dict] = []
    for dim in dimensions.values():
        if dim.get("is_degenerate"):
            degenerate_dims.append(dim)
            continue
        level_attrs = dim.get("level_attributes") or []
        if level_attrs:
            dim_by_dataset[level_attrs[0]["dataset"]] = dim

    node_ids: dict[str, str] = {}  # dataset unique_name -> node id
    nodes: list[dict] = []
    seq = 0

    def node_for_dataset(dataset_name: str, role: str) -> str:
        nonlocal seq
        if dataset_name in node_ids:
            return node_ids[dataset_name]
        ds = datasets.get(dataset_name, {})
        node_id = f"n{seq}"
        seq += 1
        node_ids[dataset_name] = node_id
        col = seq % 3
        row = seq // 3
        node: dict[str, Any] = {
            "id": node_id,
            "schema": package_schema.get(dataset_name, source_schema),
            "table": dataset_name,
            "columns": [{"name": c["name"], "type": c.get("data_type", "string")} for c in ds.get("columns", [])],
            "x": 40 + col * 320,
            "y": 40 + row * 300,
            "role": role,
        }
        if dataset_name in package_of_dataset:
            node["package"] = package_of_dataset[dataset_name]
        nodes.append(node)
        return node_id

    cfg: dict[str, dict] = {}
    joins: list[dict] = []
    join_seq = 0

    # -- dimension nodes: levels, secondary attributes, embedded (snowflake) relationships --
    for dataset_name, dim in dim_by_dataset.items():
        node_id = node_for_dataset(dataset_name, "dimension")
        nodes[[n["id"] for n in nodes].index(node_id)]["dimName"] = dim["unique_name"]
        nodes[[n["id"] for n in nodes].index(node_id)]["isTime"] = dim.get("type") == "time"

        level_attrs_by_name = {la["unique_name"]: la for la in dim.get("level_attributes", [])}
        hierarchies = dim.get("hierarchies") or []
        if hierarchies:
            nodes[[n["id"] for n in nodes].index(node_id)]["hierName"] = hierarchies[0].get("unique_name")
            all_levels = hierarchies[0].get("levels") or []

            # Two things must be true for a level to import onto this node:
            #  1. its level_attribute must actually live on this node's own
            #     dataset - a level backed by a *different* dataset (the
            #     multi-dataset-snowflake pattern, e.g. Geography Dimension's
            #     Country/State levels living on separate tables from the City
            #     level) can't be represented by this wizard's one-node-per-
            #     table model, so it's excluded rather than mis-numbered in.
            #  2. its resolved column must be `name_column`, not
            #     `key_columns[0]` - a level with a *composite* key
            #     (key_columns: [productline, productsubcategorykey]) shares
            #     its first key column with a sibling single-column level
            #     (key_columns: [productline]), and picking key_columns[0]
            #     made two unrelated levels collide onto the same cfg key,
            #     silently dropping one and leaving the surviving level's
            #     original (non-contiguous) hierarchy position as its
            #     levelOrder - confirmed against sales-insights-postgres'
            #     Product Dimension (Product Line vs Product Category both
            #     keyed by `productline`) and Geography Dimension (levels on
            #     other datasets consuming index slots before being excluded).
            # Filtering first and enumerating the *filtered* list is what
            # keeps the imported levels' L1, L2, ... numbering contiguous.
            own_columns = {c["name"] for c in (datasets.get(dataset_name) or {}).get("columns") or []}

            def _extra_key_display_sort(attr: dict, anchor_col: str) -> dict:
                """SML lets key_columns/name_column/sort_column differ (e.g. key
                `datekey`, display `date_name`) - round-trip an override into
                keyColumn/displayColumn/sortColumn only when it's a real column
                on this node and actually differs from the anchor, so re-editing
                an imported model shows the same override the source SML had
                (see api/routes: the Inspector's Key/Value column fields)."""
                extra: dict[str, Any] = {}
                key_col = (attr.get("key_columns") or [None])[0]
                if key_col and key_col != anchor_col and key_col in own_columns:
                    extra["keyColumn"] = key_col
                name_col = attr.get("name_column")
                if name_col and name_col != anchor_col and name_col in own_columns:
                    extra["displayColumn"] = name_col
                sort_col = attr.get("sort_column")
                if sort_col and sort_col != anchor_col and sort_col in own_columns:
                    extra["sortColumn"] = sort_col
                return extra

            resolved_levels = []
            for level_entry in all_levels:
                attr = level_attrs_by_name.get(level_entry["unique_name"])
                if not attr or attr.get("dataset") != dataset_name:
                    continue
                col = attr.get("name_column") or attr["key_columns"][0]
                resolved_levels.append((level_entry, attr, col))

            # SML's `levels:` list reads coarsest-first/leaf-last (see
            # build.py), but this wizard's own `levelOrder` convention is the
            # opposite - ascending from the level nearest the join (see
            # modelStore.ts's setColumnDimRole, which always appends a new
            # level with a *higher* levelOrder than whatever exists) - so
            # importing must enumerate leaf-first (reversed) to land back on
            # the same levelOrder values the wizard itself would have
            # produced, keeping edit-then-regenerate round-trips stable.
            for idx, (level_entry, attr, col) in enumerate(reversed(resolved_levels)):
                key = f"{node_id}::{col}"
                cfg[key] = {
                    "dimRole": "level",
                    "levelOrder": idx,
                    "display": attr.get("label"),
                    # "Query name" in the Inspector is this level's SML
                    # unique_name - level_entry["unique_name"] (not
                    # attr["unique_name"], which is identical for a real SML
                    # file since both come from the same object, but the
                    # hierarchy's own entry is the one build.py treats as
                    # authoritative) so re-editing an imported model shows
                    # it instead of a blank field.
                    "query": level_entry.get("unique_name"),
                    **_extra_key_display_sort(attr, col),
                    **({"timeUnit": attr["time_unit"]} if attr.get("time_unit") else {}),
                }

                for sec in level_entry.get("secondary_attributes") or []:
                    sec_col = sec.get("name_column") or sec["key_columns"][0]
                    sec_key = f"{node_id}::{sec_col}"
                    cfg[sec_key] = {
                        "dimRole": "secondary",
                        "attachToKey": key,
                        "display": sec.get("label"),
                        "query": sec.get("unique_name"),
                        **_extra_key_display_sort(sec, sec_col),
                    }

        for rel in dim.get("relationships") or []:
            # `type: embedded` (cross-dimension link, `to.dimension` set) is what
            # this wizard's one-node-per-table model can represent. `type:
            # snowflake` (intra-dimension: several physical datasets merged into
            # ONE dimension's own hierarchy, `to.dimension` absent - confirmed in
            # a real repo, sales-insights-postgres/dimensions/Geography
            # Dimension.yml) is a different, still-valid modeling pattern this
            # wizard doesn't yet support authoring - skip rather than crash, so
            # an import of a repo using it still succeeds for everything else.
            to_dim_name = rel["to"].get("dimension")
            if not to_dim_name:
                continue
            to_dim = dimensions.get(to_dim_name)
            if not to_dim:
                continue
            to_dataset = (to_dim.get("level_attributes") or [{}])[0].get("dataset")
            to_node_id = node_for_dataset(to_dataset, "dimension") if to_dataset else None
            if not to_node_id:
                continue
            from_col = rel["from"]["join_columns"][0]
            to_level_name = rel["to"]["level"]
            to_attr = {la["unique_name"]: la for la in (to_dim.get("level_attributes") or [])}.get(to_level_name)
            to_col = to_attr["key_columns"][0] if to_attr else to_level_name
            joins.append(
                {
                    "id": f"j{join_seq}",
                    "a": {"node": node_id, "column": from_col},
                    "b": {"node": to_node_id, "column": to_col},
                }
            )
            join_seq += 1

    # -- fact nodes: metrics, degenerate dimensions --
    for metric in metrics.values():
        dataset_name = metric.get("dataset")
        if not dataset_name:
            continue
        node_id = node_for_dataset(dataset_name, "fact")
        nodes[[n["id"] for n in nodes].index(node_id)].setdefault(
            "factName", f"{dataset_name} Facts"
        )
        col = metric.get("column")
        key = f"{node_id}::{col}"
        agg = CALC_METHOD_TO_AGG.get(metric.get("calculation_method"), "SUM")
        # "query" is the metric's own unique_name (build.py's Query name
        # override to the metric's own identifier, not its source column -
        # matching level_unique_name's same convention for a level) so
        # re-editing an imported model and regenerating keeps the same
        # unique_name a deployed catalog/MDX query already references,
        # instead of silently renaming it to the auto m_<table>_<col>_<agg>
        # pattern on the next generate.
        cfg[key] = {"measure": True, "agg": agg, "display": metric.get("label"), "query": metric.get("unique_name")}

    for degen in degenerate_dims:
        level_attrs = degen.get("level_attributes") or []
        if not level_attrs:
            continue
        dataset_name = level_attrs[0]["dataset"]
        node_id = node_ids.get(dataset_name)
        if not node_id:
            node_id = node_for_dataset(dataset_name, "fact")
        col = level_attrs[0]["key_columns"][0]
        key = f"{node_id}::{col}"
        existing = cfg.get(key, {})
        existing.update({"degen": True, "degenDisplay": level_attrs[0].get("label"), "degenQuery": col})
        cfg[key] = existing

    # -- model relationships: fact<->dim joins, with role_play --
    for rel in model.get("relationships") or []:
        from_dataset = rel["from"]["dataset"]
        from_node = node_ids.get(from_dataset) or node_for_dataset(from_dataset, "fact")
        from_col = rel["from"]["join_columns"][0]

        to_dim_name = rel["to"]["dimension"]
        to_dim = dimensions.get(to_dim_name)
        if not to_dim:
            continue
        to_dataset = (to_dim.get("level_attributes") or [{}])[0].get("dataset")
        to_node = node_ids.get(to_dataset)
        if not to_node:
            continue
        to_level_name = rel["to"]["level"]
        to_attr = {la["unique_name"]: la for la in (to_dim.get("level_attributes") or [])}.get(to_level_name)
        to_col = to_attr["key_columns"][0] if to_attr else to_level_name

        join: dict[str, Any] = {
            "id": f"j{join_seq}",
            "a": {"node": from_node, "column": from_col},
            "b": {"node": to_node, "column": to_col},
        }
        join_seq += 1
        role_play = rel.get("role_play")
        if role_play:
            join["rolePlay"] = role_play.rsplit(" {0}", 1)[0]
        joins.append(join)

    joins = _dedupe_joins(joins)
    calculations = [
        {
            "id": f"calc{i}",
            "uniqueName": calc["unique_name"],
            "label": calc.get("label") or calc["unique_name"],
            "expression": calc.get("expression", ""),
            "description": calc.get("description"),
        }
        for i, calc in enumerate(calculations_by_name.values())
    ]

    # Anything the canvas can't hold would be dropped by the next Save / Deploy,
    # so the UI opens such a repo read-only (support.py).
    return {"nodes": nodes, "joins": joins, "cfg": cfg, "calculations": calculations, "source": source,
            "builtHere": built_here(files), "shared": is_shared_repo(files),
            "unsupported": unsupported_features(files, source.get("dialect") if source else None)}


def _dedupe_joins(joins: list[dict]) -> list[dict]:
    """Collapses joins that resolve to the identical {node, column} pair on
    both sides (direction-insensitive) - see the multi-hierarchy note above."""
    seen: set[tuple] = set()
    out = []
    for j in joins:
        a = (j["a"]["node"], j["a"]["column"])
        b = (j["b"]["node"], j["b"]["column"])
        sig = (a, b, j.get("rolePlay")) if a <= b else (b, a, j.get("rolePlay"))
        if sig in seen:
            continue
        seen.add(sig)
        out.append(j)
    return out
