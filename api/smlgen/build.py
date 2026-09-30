"""SML generation engine - new code, driven entirely by the wizard's explicit
model state (see docs/BUILD_PLAN.md). Not a port of ps-utils' inference
algorithms.

Shape decisions below were corrected against `sample-dev/`, a real, working,
hand-built SML repo pulled from the user's own AtScale instance (not just the
atscale-sml-model-generator skill's docs, which turned out to disagree on one
important point):

  - **Dim-to-dim (snowflake) relationships use `type: embedded`, not
    `type: snowflake`.** They live as a `relationships:` block *inside the
    child dimension's own file* (the FK side), pointing at the parent
    dimension by name - e.g. `dimensions/Product.yml` has a relationship to
    "Product Sub Category", which itself has one to "Product Category". Each
    joined table is its own separate `object_type: dimension` file - they are
    NOT merged into one dimension with multiple `level_attributes` datasets
    (that's a valid SML pattern per the skill's Rule 5, but it's not what
    this AtScale instance's own UI produces, and it maps far more naturally
    onto this wizard's one-node-per-table model anyway).
  - **Metrics reference their fact by bare dataset `unique_name`**
    (`dataset: factinternetsalesorig`), not a `.dataset`-suffixed name.
  - **`role_play` lives on the model relationship**, e.g.
    `role_play: Order {0}` / `role_play: Ship {0}` for two FKs on one fact
    joined to the same conformed Date dimension - confirmed exactly matching
    the skill's Rule 2/21 and ps-utils' sml-serializer.ts approach.
  - Catalog `version:` is still `1.7` (skill Rule 6) even though the sample
    repo itself was `version: 1` - `sml-cli validate` flags that as a WARNING
    ("different from the latest supported version"), so 1.7 is the correct
    default to emit, not what that one sample happened to have.
"""

from __future__ import annotations

from typing import Any

import yaml

from .rules import AGG_TO_CALC_METHOD, cased, join_type_family, kebab, sml_data_type, title_case


def _column_key(node_id: str, column: str) -> str:
    return f"{node_id}::{column}"


def _levels_of(cfg: dict[str, dict], node_id: str) -> list[dict]:
    out = []
    prefix = f"{node_id}::"
    for key, c in cfg.items():
        if key.startswith(prefix) and c.get("dimRole") == "level":
            out.append({"key": key, "column": key[len(prefix):], "levelOrder": c.get("levelOrder", 0), "config": c})
    out.sort(key=lambda x: x["levelOrder"])
    return out


def _attached_to(cfg: dict[str, dict], level_key: str, dim_role: str) -> list[dict]:
    out = []
    for key, c in cfg.items():
        if c.get("dimRole") == dim_role and c.get("attachToKey") == level_key:
            out.append({"key": key, "config": c})
    return out


def _level_for_column(cfg: dict[str, dict], node_id: str, column: str) -> dict | None:
    """The hierarchy level whose *effective* key column (the Key Column
    override if set, else the level's own column) is `column` - i.e. the
    level that actually backs a join drawn to this physical column.

    A join edge can land on any column, not just the one the user happened to
    mark as a level (e.g. joining a fact's FK to a dimension's surrogate key
    while a *different* column on that table is marked as the display level).
    Relationship generation must key off the joined column, not just always
    the dimension's leaf level - using the wrong one produces a `to.level`
    whose key_columns don't match the join's actual column/type (confirmed:
    joining on an int FK while the leaf level's key is a string display
    column produced `bigint = text` from AtScale's query engine)."""
    for lv in _levels_of(cfg, node_id):
        key_col = lv["config"].get("keyColumn") or lv["column"]
        if key_col == column:
            return lv
    return None


def _resolve_key_display_sort(config: dict, own_col: str, dialect: str | None) -> tuple[str, str, str | None]:
    """SML lets key_columns (join/identity), name_column (display), and
    sort_column all be different physical columns on the same level/attribute
    (e.g. key on `datekey`, display `date_name`) - `own_col` is the column
    the user actually clicked to mark as a level/secondary/alias, and
    key/display/sort each default to it unless overridden in the Inspector."""
    key_col = cased(config.get("keyColumn") or own_col, dialect)
    name_col = cased(config.get("displayColumn") or own_col, dialect)
    sort_col = cased(config["sortColumn"], dialect) if config.get("sortColumn") else None
    return key_col, name_col, sort_col


def _yaml_dump(obj: Any) -> str:
    return yaml.safe_dump(obj, sort_keys=False, default_flow_style=False, allow_unicode=True)


class ValidationError(Exception):
    def __init__(self, errors: list[str]):
        super().__init__("; ".join(errors))
        self.errors = errors


def validate_model(nodes: list[dict], joins: list[dict], cfg: dict[str, dict]) -> list[str]:
    """Validate-before-generate checks from the design README / build plan.
    Returns a list of human-readable error strings (empty = OK)."""
    errors: list[str] = []
    nodes_by_id = {n["id"]: n for n in nodes}

    for n in nodes:
        if n.get("role") not in ("fact", "dimension"):
            errors.append(f"Table '{n['table']}' has no role set (fact or dimension) - unset roles cannot be exported.")

    for n in nodes:
        if n.get("role") != "dimension":
            continue
        levels = _levels_of(cfg, n["id"])
        if not levels:
            errors.append(f"Dimension '{n.get('dimName') or n['table']}' has no hierarchy levels defined.")
        elif n.get("isTime"):
            for lv in levels:
                if not lv["config"].get("timeUnit"):
                    errors.append(
                        f"Level '{lv['config'].get('display') or lv['column']}' on time dimension "
                        f"'{n.get('dimName') or n['table']}' has no time unit set - pick one in the "
                        "Column Inspector so SML defines this level's time_unit correctly."
                    )

    # Every secondary/alias must point at a level that actually exists on its own node.
    for key, c in cfg.items():
        if c.get("dimRole") in ("secondary", "alias"):
            node_id = key.split("::", 1)[0]
            attach = c.get("attachToKey")
            level_keys = {lv["key"] for lv in _levels_of(cfg, node_id)}
            if not attach or attach not in level_keys:
                errors.append(f"Column '{key.split('::', 1)[1]}' is a {c['dimRole']} attribute with no valid level attached.")

    # Join keys must be the same type family - no string-to-int joins.
    def _col_type(node_id: str, column: str) -> str | None:
        n = nodes_by_id.get(node_id) or {}
        return next((c.get("type") for c in n.get("columns") or [] if c.get("name") == column), None)

    for j in joins:
        ta, tb = _col_type(j["a"]["node"], j["a"]["column"]), _col_type(j["b"]["node"], j["b"]["column"])
        fa, fb = join_type_family(ta), join_type_family(tb)
        if fa and fb and fa != fb:
            na, nb = nodes_by_id.get(j["a"]["node"], {}), nodes_by_id.get(j["b"]["node"], {})
            errors.append(
                f"Join {na.get('table', j['a']['node'])}.{j['a']['column']} ({ta}) to "
                f"{nb.get('table', j['b']['node'])}.{j['b']['column']} ({tb}) joins different types "
                f"({fa} vs {fb}) - join keys must be the same type."
            )

    # Every dimension must reach a fact, directly or through a chain of dim<->dim joins.
    fact_ids = {n["id"] for n in nodes if n.get("role") == "fact"}
    dim_ids = {n["id"] for n in nodes if n.get("role") == "dimension"}
    adjacency: dict[str, set[str]] = {nid: set() for nid in dim_ids}
    reaches_fact: set[str] = set()
    for j in joins:
        a, b = j["a"]["node"], j["b"]["node"]
        if a in fact_ids and b in dim_ids:
            reaches_fact.add(b)
        elif b in fact_ids and a in dim_ids:
            reaches_fact.add(a)
        elif a in dim_ids and b in dim_ids:
            adjacency[a].add(b)
            adjacency[b].add(a)
    changed = True
    while changed:
        changed = False
        for nid in dim_ids:
            if nid in reaches_fact:
                continue
            if adjacency[nid] & reaches_fact:
                reaches_fact.add(nid)
                changed = True
    for nid in dim_ids - reaches_fact:
        n = nodes_by_id[nid]
        errors.append(f"Dimension '{n.get('dimName') or n['table']}' is not connected to any fact table.")

    return errors


def _join_dimension_side(nodes_by_id: dict[str, dict], j: dict) -> tuple[str, str] | None:
    """(node_id, column) of whichever side of `j` needs to resolve to a real
    hierarchy level - for a fact<->dim join, whichever side has role
    'dimension'; for a dim<->dim embedded join, join.b (the drop-target side,
    by this wizard's drag-origin/drop-target convention) - the "from" side's
    join_columns is always explicit in the generated SML, so it never needs
    to itself be a level. None if neither side is a dimension."""
    a_node, b_node = nodes_by_id[j["a"]["node"]], nodes_by_id[j["b"]["node"]]
    if a_node.get("role") == "dimension" and b_node.get("role") == "dimension":
        return j["b"]["node"], j["b"]["column"]
    if a_node.get("role") == "dimension":
        return j["a"]["node"], j["a"]["column"]
    if b_node.get("role") == "dimension":
        return j["b"]["node"], j["b"]["column"]
    return None


def build_sml(payload: dict[str, Any]) -> dict[str, str]:
    """payload keys: modelName, catalogName?, connectionName, asConnection,
    database, schema, dialect, nodes, joins, cfg, calculations?. Returns
    {path: yaml_text}. Raises ValidationError if the model fails
    validate_model()."""
    nodes: list[dict] = payload["nodes"]
    joins: list[dict] = payload["joins"]
    cfg: dict[str, dict] = payload.get("cfg", {})
    calculations: list[dict] = payload.get("calculations", [])
    dialect = payload.get("dialect")
    model_name = payload["modelName"]
    catalog_name = payload.get("catalogName") or f"{model_name}_catalog"
    connection_name = payload["connectionName"]

    errors = validate_model(nodes, joins, cfg)
    if errors:
        raise ValidationError(errors)

    nodes_by_id = {n["id"]: n for n in nodes}
    files: dict[str, str] = {}

    # -- catalog.yml (Rule 6: version 1.7, catalog unique_name != model unique_name, Rule 8c) --
    files["catalog.yml"] = _yaml_dump(
        {
            "unique_name": catalog_name,
            "object_type": "catalog",
            "label": catalog_name,
            "version": 1.7,
            "aggressive_agg_promotion": False,
            "build_speculative_aggs": False,
        }
    )

    # -- connections/<name>.yml --
    files[f"connections/{kebab(connection_name)}.yml"] = _yaml_dump(
        {
            "unique_name": connection_name,
            "object_type": "connection",
            "label": connection_name,
            "as_connection": payload["asConnection"],
            "database": payload["database"],
            "schema": payload["schema"],
        }
    )

    # -- datasets/<table>.yml, one per node --
    for n in nodes:
        table = cased(n["table"], dialect)
        files[f"datasets/{n['table']}.yml"] = _yaml_dump(
            {
                "unique_name": n["table"],
                "object_type": "dataset",
                "label": n["table"],
                "columns": [
                    {"name": cased(c["name"], dialect), "data_type": sml_data_type(c["type"])} for c in n["columns"]
                ],
                "connection_id": connection_name,
                "table": table,
            }
        )

    # -- dimension <-> dimension embedded relationships, grouped by the "from" node --
    # Convention: join.a is the drag origin (the FK / child side, by how the UI's
    # join-creation gesture works), join.b is the drop target (the parent/PK side).
    embedded_by_node: dict[str, list[dict]] = {n["id"]: [] for n in nodes}
    fact_dim_joins: list[dict] = []
    # Columns joined to a dimension that don't back any hierarchy level the
    # user actually defined (e.g. a fact joins the dimension's raw surrogate
    # key while the user only marked a *display* column, like a name, as the
    # level) - a real, common pattern (confirmed in sales-insights-postgres'
    # Geography Dimension, which has exactly this: a `GeoKeyCity`/`GeoKeyZip`
    # level with `is_hidden: true` beneath the visible City/Zip levels, keyed
    # by the raw join column). Each such column gets its own synthetic hidden
    # leaf level below, so every join resolves to *some* real level - SML's
    # `to.level` has no separate join_columns of its own, so the referenced
    # level's key_columns must match the actual join column or the generated
    # relationship silently joins on the wrong (and often type-mismatched)
    # column instead - this is what makes that always possible without
    # requiring the user to hand-configure a Key Column override.
    hidden_levels_needed: dict[str, set[str]] = {n["id"]: set() for n in nodes}
    for j in joins:
        a_node, b_node = nodes_by_id[j["a"]["node"]], nodes_by_id[j["b"]["node"]]
        if a_node["role"] == "dimension" and b_node["role"] == "dimension":
            embedded_by_node[a_node["id"]].append(j)
        else:
            fact_dim_joins.append(j)
        dim_side = _join_dimension_side(nodes_by_id, j)
        if dim_side and _level_for_column(cfg, dim_side[0], dim_side[1]) is None:
            hidden_levels_needed[dim_side[0]].add(dim_side[1])

    def level_unique_name(config: dict, column: str) -> str:
        """`unique_name` for a level/secondary/alias - the "Query name" field
        overrides it when set, matching how it already overrides a metric's
        source column; otherwise it's just the clicked column, cased."""
        query = config.get("query")
        return cased(query, dialect) if query else cased(column, dialect)

    def leaf_level(node_id: str) -> str | None:
        levels = _levels_of(cfg, node_id)
        return level_unique_name(levels[-1]["config"], levels[-1]["column"]) if levels else None

    def target_level(node_id: str, column: str, dialect: str | None) -> str:
        """The unique_name a relationship joining `node_id` on `column`
        should reference - the real level backing it if one exists, else the
        dimension's leaf level, whose key_columns the dimension-emission loop
        above repoints at this same `column` as a secondary attribute (see
        hidden_levels_needed and the anchor_col logic) - never the bare
        column name itself, which is a secondary attribute's unique_name
        here, not a level's, and SML's `to.level` must name an actual level."""
        matched = _level_for_column(cfg, node_id, column)
        if matched:
            return level_unique_name(matched["config"], matched["column"])
        return leaf_level(node_id) or cased(column, dialect)

    # -- dimensions/<dimName>.yml, one per dimension-role node --
    for n in nodes:
        if n.get("role") != "dimension":
            continue
        levels = _levels_of(cfg, n["id"])
        hier_name = n.get("hierName") or f"{n['table']} Hierarchy"
        dim_name = n.get("dimName") or n["table"]
        table = n["table"]

        # A join landing on a column no visible level's own key covers (e.g. a
        # fact FK joined to a dimension's surrogate key while the user only
        # marked a *display* column, like a name, as the level) repoints the
        # LEAF level's key_columns at that join column directly - the level
        # the user clicked (englishproductname) stays the display/name_column,
        # the real join grain (productkey) becomes key_columns, no separate
        # level or secondary attribute needed - matching the real repo's own
        # pattern exactly (sales-insights-postgres' "Product Name" level:
        # key_columns=[productkey], name_column=englishproductname, nothing
        # else). Confirmed against a real deploy that adding productkey as
        # *either* a second level or a secondary attribute of this level made
        # AtScale drop the display level from XMLA discovery entirely - it
        # must be only the key_columns override, nothing more.
        anchor_col = next(iter(sorted(hidden_levels_needed.get(n["id"], ()))), None)

        level_entries = []
        level_attributes = []
        for lv in levels:
            is_leaf = lv is levels[-1]
            col = level_unique_name(lv["config"], lv["column"])
            display = lv["config"].get("display") or title_case(lv["column"])
            secondaries = _attached_to(cfg, lv["key"], "secondary")
            aliases = _attached_to(cfg, lv["key"], "alias")

            secondary_attrs = []
            for s in secondaries + aliases:
                s_col_full = s["key"].split("::", 1)[1]
                s_display = s["config"].get("display") or title_case(s_col_full)
                s_key_col, s_name_col, s_sort_col = _resolve_key_display_sort(s["config"], s_col_full, dialect)
                # No is_unique_key or contains_unique_names here at all - not
                # even `false`. Confirmed against a real hand-authored repo
                # (sales-insights-postgres' Product Dimension:
                # d_productsubcategoryId) that a secondary attribute carries
                # neither field; setting either explicitly to False (this
                # code's behavior before this fix) made AtScale silently drop
                # the property from MDSCHEMA_PROPERTIES discovery entirely
                # instead of just leaving it non-unique.
                s_attr = {
                    "unique_name": level_unique_name(s["config"], s_col_full),
                    "label": s_display,
                    "dataset": table,
                    "key_columns": [s_key_col],
                    "name_column": s_name_col,
                }
                if s_sort_col:
                    s_attr["sort_column"] = s_sort_col
                secondary_attrs.append(s_attr)

            level_entry: dict[str, Any] = {"unique_name": col}
            if secondary_attrs:
                level_entry["secondary_attributes"] = secondary_attrs
            level_entries.append(level_entry)

            # The join's actual column becomes this level's key when it's the
            # leaf and no configured level already covers it - the level the
            # user clicked (englishproductname) stays the display/name_column,
            # but the real join grain (productkey) is what AtScale resolves
            # `to.level` into for the SQL join, same as any other Key Column
            # override, just inferred instead of requiring one.
            if is_leaf and anchor_col and anchor_col != lv["column"]:
                key_col = cased(anchor_col, dialect)
                _, name_col, sort_col = _resolve_key_display_sort(lv["config"], lv["column"], dialect)
            else:
                key_col, name_col, sort_col = _resolve_key_display_sort(lv["config"], lv["column"], dialect)
            attr: dict[str, Any] = {
                "unique_name": col,
                "label": display,
                "contains_unique_names": False,
                "dataset": table,
                "key_columns": [key_col],
                "name_column": name_col,
            }
            if sort_col:
                attr["sort_column"] = sort_col
            if n.get("isTime"):
                # validate_model() already rejected a time dimension with any
                # level missing this, so it's always set by the time we get here.
                attr["time_unit"] = lv["config"]["timeUnit"]
            level_attributes.append(attr)

        # Rule: is_unique_key only when derivable - here, only for a
        # single-level dimension (matches sample-dev's Product Level, the one
        # case that has it) whose key wasn't just repointed at a separate
        # anchor column above (in that case the level's own display column is
        # no longer what actually identifies a row, so it isn't the unique key).
        if len(level_attributes) == 1 and not (anchor_col and anchor_col != levels[0]["column"]):
            level_attributes[0]["is_unique_key"] = True

        # `hierarchies[].levels[]` reads coarsest-first/leaf-last - the
        # opposite of `levels`/`level_attributes` above, which stay in plain
        # ascending `levelOrder` order (matches a real hand-authored repo's
        # own attribute ordering, and each newly-added level always gets a
        # *higher* levelOrder than whatever already exists - see
        # modelStore.ts's setColumnDimRole). This mirrors what the wizard's
        # own Inspector panel already does when *displaying* a hierarchy's
        # levels (HierarchyReadout reverses the same ascending list purely
        # for rendering, coarsest on top) - confirmed against a real deployed
        # cube's own hierarchy browser showing the identical top-down order.
        # The generator just never applied that same reversal when writing
        # the SML itself, silently emitting every hierarchy leaf-first.
        level_entries = list(reversed(level_entries))

        dim_doc: dict[str, Any] = {
            "unique_name": dim_name,
            "object_type": "dimension",
            "label": dim_name,
            "hierarchies": [{"unique_name": hier_name, "label": hier_name, "levels": level_entries}],
            "level_attributes": level_attributes,
        }

        embedded_joins = embedded_by_node.get(n["id"], [])
        if embedded_joins:
            rels = []
            for j in embedded_joins:
                to_node = nodes_by_id[j["b"]["node"]]
                to_dim_name = to_node.get("dimName") or to_node["table"]
                # The "to" (drop-target) side has no join_columns field of its
                # own in SML - only `to.level`, whose key_columns AtScale
                # resolves the actual SQL join from - so it must be the level
                # this join's column actually backs (its real level, or its
                # synthetic hidden anchor level - see target_level), not just
                # always the dimension's leaf level. The "from" side's
                # join_columns is explicit, so from.level stays purely
                # descriptive hierarchy-attachment metadata - the dimension's
                # own leaf level, same as before.
                to_leaf = target_level(to_node["id"], j["b"]["column"], dialect)
                from_col = cased(j["a"]["column"], dialect)
                rels.append(
                    {
                        "unique_name": f"{table}_{from_col}_to_{to_dim_name}",
                        "from": {
                            "dataset": table,
                            "hierarchy": hier_name,
                            "join_columns": [from_col],
                            "level": leaf_level(n["id"]),
                        },
                        "to": {"dimension": to_dim_name, "level": to_leaf, "type": "embedded"},
                        "type": "embedded",
                    }
                )
            dim_doc["relationships"] = rels

        dim_doc["type"] = "time" if n.get("isTime") else "standard"
        files[f"dimensions/{dim_name}.yml"] = _yaml_dump(dim_doc)

    # -- metrics/<name>.yml + degenerate dimensions/<name>.yml, from fact columns --
    metric_names: list[str] = []
    degenerate_names: list[str] = []
    for n in nodes:
        if n.get("role") != "fact":
            continue
        table = n["table"]
        prefix = f"{n['id']}::"
        for key, c in cfg.items():
            if not key.startswith(prefix):
                continue
            col_name = key[len(prefix):]
            col = cased(col_name, dialect)

            if c.get("measure"):
                agg = c.get("agg", "SUM")
                calc = AGG_TO_CALC_METHOD.get(agg, "sum")
                display = c.get("display") or title_case(col_name)
                # "Query name" (c.get("query")) overrides the metric's own
                # unique_name here, exactly like level_unique_name already
                # does for a hierarchy level's unique_name - previously this
                # field only overrode the metric's source `column:`, so the
                # Inspector showed a name the generated SML silently ignored
                # for the identifier a hand-written MDX/query would reference
                # (confirmed: user expected "salesamount", generated SML had
                # "m_factinternetsales_salesamount_sum").
                metric_unique = c.get("query") or f"m_{table}_{col_name}_{agg.lower().replace(' ', '_')}"
                files[f"metrics/{kebab(metric_unique)}.yml"] = _yaml_dump(
                    {
                        "unique_name": metric_unique,
                        "object_type": "metric",
                        "label": display,
                        "calculation_method": calc,
                        "column": col,
                        "dataset": table,
                        "unrelated_dimensions_handling": "repeat",
                    }
                )
                metric_names.append(metric_unique)

            if c.get("degen"):
                degen_display = c.get("degenDisplay") or title_case(col_name)
                degen_col = c.get("degenQuery") and cased(c["degenQuery"], dialect) or col
                degen_name = degen_display
                files[f"dimensions/{kebab(degen_name)}.yml"] = _yaml_dump(
                    {
                        "unique_name": degen_name,
                        "object_type": "dimension",
                        "label": degen_name,
                        "is_degenerate": True,
                        "hierarchies": [
                            {
                                "unique_name": f"{degen_name} Hierarchy",
                                "label": f"{degen_name} Hierarchy",
                                "levels": [{"unique_name": degen_col}],
                            }
                        ],
                        "level_attributes": [
                            {
                                "unique_name": degen_col,
                                "label": degen_display,
                                "contains_unique_names": False,
                                "dataset": table,
                                "key_columns": [degen_col],
                                "name_column": degen_col,
                            }
                        ],
                    }
                )
                degenerate_names.append(degen_name)

    # -- calculations/<name>.yml - calculated metrics (SML `metric_calc`), a
    # raw MDX expression passed through as-is (see module docstring: this
    # wizard doesn't validate MDX or build expressions for you). Confirmed
    # shape against sales-insights-postgres/calculations/*.yml, including
    # that calc unique_names go in the model's `metrics:` list alongside
    # base metrics, same as ps-utils' sml-serializer.ts convention.
    calc_names: list[str] = []
    for calc in calculations:
        unique_name = calc.get("uniqueName") or calc.get("label")
        if not unique_name:
            continue
        calc_doc: dict[str, Any] = {
            "unique_name": unique_name,
            "object_type": "metric_calc",
            "label": calc.get("label") or unique_name,
            "expression": calc.get("expression", ""),
        }
        if calc.get("description"):
            calc_doc["description"] = calc["description"]
        files[f"calculations/{kebab(unique_name)}.yml"] = _yaml_dump(calc_doc)
        calc_names.append(unique_name)

    # -- models/<modelName>.yml --
    relationships = []
    for j in fact_dim_joins:
        a_node, b_node = nodes_by_id[j["a"]["node"]], nodes_by_id[j["b"]["node"]]
        if a_node["role"] == "fact":
            fact_node, fact_col, dim_node, dim_col = a_node, j["a"]["column"], b_node, j["b"]["column"]
        else:
            fact_node, fact_col, dim_node, dim_col = b_node, j["b"]["column"], a_node, j["a"]["column"]

        dim_name = dim_node.get("dimName") or dim_node["table"]
        # The level whose *effective key column* is the one this join
        # actually lands on - its real level, or its synthetic hidden anchor
        # level if no visible level backs this column (see target_level) -
        # not always the dimension's leaf level, which would join on the
        # wrong column whenever the join target isn't the deepest level (e.g.
        # an FK joined to a surrogate key while the leaf level is a separate
        # display column).
        target = target_level(dim_node["id"], dim_col, dialect)
        fact_col_cased = cased(fact_col, dialect)
        rel: dict[str, Any] = {
            "unique_name": f"{fact_node['table']}_{fact_col_cased}_to_{dim_name}",
            "from": {"dataset": fact_node["table"], "join_columns": [fact_col_cased]},
            "to": {"dimension": dim_name, "level": target},
        }
        role_play = j.get("rolePlay")
        if role_play:
            rel["role_play"] = f"{role_play} {{0}}"
        relationships.append(rel)

    model_doc: dict[str, Any] = {
        "unique_name": model_name,
        "object_type": "model",
        "label": model_name,
        "relationships": relationships,
        "metrics": [{"unique_name": m} for m in metric_names + calc_names],
    }
    if degenerate_names:
        model_doc["dimensions"] = degenerate_names
    files[f"models/{kebab(model_name)}.yml"] = _yaml_dump(model_doc)

    return files
