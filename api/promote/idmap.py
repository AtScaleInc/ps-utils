"""Name <-> id maps for a deployed model, so aggregates are matched and
promoted by *name*: every host that deploys the same SML generates its own ids
(catalog, model, keys, role-play refs), so an id never matches across hosts.

Built from the catalog's JSON representation (GET /v1/catalogs/{id}/export,
Container API "export-catalog-representation"). An aggregate's planJson
references two kinds of model objects by id:

  - keys (`{"type": "key", "id": ...}`), named here by, in order of preference:
      the keyed attribute that uses it          -> "attr:Customer Name"
      the attribute it is the sort key of       -> "sort:Custom Year"
      the dataset column(s) it is bound to      -> "col:<dataset>:rpt_year"
  - role-play references (`{"type": "reuse-ref", "ref-id": ...}`), named by
      the dataset + naming pattern that defines them -> "ref:<dataset>:Order {0}"
"""

from __future__ import annotations

import json
from collections import defaultdict
from typing import Any


def _walk(o: Any, fn, ctx: dict[str, Any]) -> None:
    if isinstance(o, dict):
        if o.get("name") and "id" in o:
            ctx = {**ctx, "owner": o["name"]}
        fn(o, ctx)
        for v in o.values():
            _walk(v, fn, ctx)
    elif isinstance(o, list):
        for v in o:
            _walk(v, fn, ctx)


def id_names(catalog_export: dict[str, Any]) -> dict[str, str]:
    """id -> logical name for every key and reference in the catalog."""
    attributes = catalog_export.get("attributes") or {}
    def items(v: Any) -> list[dict[str, Any]]:
        v = [v] if isinstance(v, dict) else v or []
        return [a for a in v if isinstance(a, dict)]

    attr_name = {a["id"]: a["name"] for group in ("keyed-attribute", "attribute")
                 for a in items(attributes.get(group)) if a.get("id") and a.get("name")}
    attr: dict[str, str] = {}
    sort: dict[str, str] = {}
    cols: dict[str, set[str]] = defaultdict(set)
    refs: dict[str, set[str]] = defaultdict(set)

    for ka in items(attributes.get("keyed-attribute")):
        if ka.get("key-ref") and ka.get("name"):
            attr.setdefault(ka["key-ref"], f"attr:{ka['name']}")
        sk = (((ka.get("properties") or {}).get("ordering") or {}).get("sort-key") or {}).get("key-ref")
        if isinstance(sk, dict) and sk.get("id") and ka.get("name"):
            sort.setdefault(sk["id"], f"sort:{ka['name']}")

    def visit(o: dict[str, Any], ctx: dict[str, Any]) -> None:
        owner = ctx.get("owner", "")
        if "column" in o and isinstance(o.get("id"), str) and "name" not in o:
            cols[o["id"]].add(f"{owner}:{o['column']}")
        # References (role-play `new-ref` in cube datasets, joins in dimension
        # levels) carry the attribute they reach: name them by it.
        if isinstance(o.get("ref-id"), str) and o.get("attribute-id"):
            target = attr_name.get(o["attribute-id"], o["attribute-id"])
            refs[o["ref-id"]].add(f"ref:{o.get('ref-naming', '')}:{target}")

    _walk(catalog_export, visit, {})

    out: dict[str, str] = {}
    for kid, cs in cols.items():
        out[kid] = "col:" + "|".join(sorted(cs))
    out.update(sort)
    out.update(attr)
    out.update({rid: sorted(ns)[0] for rid, ns in refs.items()})
    return out


def name_ids(catalog_export: dict[str, Any]) -> dict[str, str]:
    """Inverse: logical name -> id (names that aren't unique are dropped)."""
    seen: dict[str, list[str]] = defaultdict(list)
    for i, n in id_names(catalog_export).items():
        seen[n].append(i)
    return {n: ids[0] for n, ids in seen.items() if len(ids) == 1}


def plan_ids(plan: Any) -> set[str]:
    """Every key id and role-play ref id a plan references."""
    found: set[str] = set()

    def visit(o: Any) -> None:
        if isinstance(o, dict):
            if o.get("type") == "key" and isinstance(o.get("id"), str):
                found.add(o["id"])
            if o.get("type") == "reuse-ref" and isinstance(o.get("ref-id"), str):
                found.add(o["ref-id"])
            for v in o.values():
                visit(v)
        elif isinstance(o, list):
            for v in o:
                visit(v)

    visit(json.loads(plan) if isinstance(plan, str) else plan)
    return found


def translate_plan(plan: Any, mapping: dict[str, str]) -> Any:
    """Replace key / role-play ref ids per `mapping` (other fields untouched)."""
    as_str = isinstance(plan, str)
    obj = json.loads(plan) if as_str else plan

    def visit(o: Any) -> Any:
        if isinstance(o, dict):
            n = {k: visit(v) for k, v in o.items()}
            if n.get("type") == "key" and n.get("id") in mapping:
                n["id"] = mapping[n["id"]]
            if n.get("type") == "reuse-ref" and n.get("ref-id") in mapping:
                n["ref-id"] = mapping[n["ref-id"]]
            return n
        if isinstance(o, list):
            return [visit(v) for v in o]
        return o

    out = visit(obj)
    return json.dumps(out) if as_str else out
