"""Manage › Analyze: an audit of one model, read from its SML repo.

Everything the model reaches is resolved from the repo's YAML - the model's
relationships (fact dataset → dimension, role-plays), the dimensions they land
on and the ones those embed (snowflake / embedded / m2m relationships), the
metrics and calculations it lists, the datasets, connections and row security
behind all of it, the catalog and package settings - and every object carries
every property the SML reference documents (analyze/spec.py), its file, its
description and the `#` comments written next to it. `propertyUsage` counts
each documented property across the model (zeros included), `timeIntelligence`
gathers time dimensions, parallel periods, calculation groups and the
calculations built on MDX time functions, and findings flag broken references
(columns, levels, relationships, overrides, ...) and the spec's rules.

Object shapes follow the SML reference (semanticdatalayer/SML sml-reference/,
vendored in ps-utils resources/sml-reference). New Python logic, not a port.
"""

from __future__ import annotations

import re
from collections import Counter
from typing import Any

import yaml

from .spec import KNOWN_UNDOCUMENTED, SPEC, keys

_KEY_LINE = re.compile(r"^\s*(?:-\s+)?(?:unique_name|name):\s*(.+?)\s*(?:#\s*(.*))?$")
_COMMENT = re.compile(r"^\s*#\s?(.*)$")
#: MDX functions that make a calculation time-relative.
_TIME_FUNCS = re.compile(r"\b(ParallelPeriod|PeriodsToDate|Ytd|Qtd|Mtd|Wtd|Lag|Lead|PrevMember|NextMember|OpeningPeriod|"
                         r"ClosingPeriod|LastPeriods|Cousin)\s*\(?", re.I)
#: metric.md calculation_method: semi-additive allowed / non-additive.
_NON_ADDITIVE = {"count distinct", "sum distinct", "percentile"}
_SEMI_OK = {"average", "sum", "minimum", "maximum"}


def _unquote(v: str) -> str:
    v = v.strip()
    return v[1:-1] if len(v) >= 2 and v[0] == v[-1] and v[0] in "'\"" else v


def extract_comments(body: str) -> tuple[list[str], dict[str, list[str]]]:
    """(file header comments, {name: comments}). A comment block belongs to the
    next `unique_name:` / `name:` line; an inline comment on any line belongs
    to the last name seen above it. yaml.safe_load drops comments, so they are
    read from the text."""
    header: list[str] = []
    by_name: dict[str, list[str]] = {}
    pending: list[str] = []
    current: str | None = None
    seen_key = False
    for line in body.splitlines():
        if not line.strip():
            if not seen_key and pending:
                header.extend(pending)
                pending = []
            continue
        c = _COMMENT.match(line)
        if c:
            text = c.group(1).strip()
            if text:
                pending.append(text)
            continue
        k = _KEY_LINE.match(line)
        if k:
            name = _unquote(k.group(1))
            if pending:
                by_name.setdefault(name, []).extend(pending)
                pending = []
            if k.group(2):
                by_name.setdefault(name, []).append(k.group(2).strip())
            current = name
            seen_key = True
            continue
        if pending and not seen_key:
            header.extend(pending)
            pending = []
        elif pending and current:
            by_name.setdefault(current, []).extend(pending)
            pending = []
        seen_key = True
        if "#" in line and current:
            # inline comment after a value (ignore '#' inside quotes)
            m = re.search(r"\s#\s?(.*)$", re.sub(r"(['\"]).*?\1", "", line))
            if m and m.group(1).strip():
                by_name.setdefault(current, []).append(m.group(1).strip())
    if pending:
        (by_name.setdefault(current, []) if current else header).extend(pending)
    return header, by_name


class _Repo:
    """Every SML object in the repo, by type and unique_name, with its file and comments."""

    def __init__(self, files: dict[str, str]):
        self.by_type: dict[str, dict[str, dict]] = {}
        self.path: dict[tuple[str, str], str] = {}
        self.comments: dict[str, dict[str, list[str]]] = {}
        self.header: dict[str, list[str]] = {}
        self.errors: list[dict[str, str]] = []
        self.package: tuple[str, dict] | None = None
        for path, body in sorted(files.items()):
            try:
                doc = yaml.safe_load(body)
            except yaml.YAMLError as e:
                self.errors.append({"file": path, "error": str(e).splitlines()[0]})
                continue
            if not isinstance(doc, dict):
                continue
            if not doc.get("object_type"):
                # package.md: package.yml has no object_type, just version + packages
                if "packages" in doc:
                    self.package = (path, doc)
                    self.header[path], self.comments[path] = extract_comments(body)
                continue
            t, name = doc["object_type"], str(doc.get("unique_name") or path)
            self.by_type.setdefault(t, {})[name] = doc
            self.path[(t, name)] = path
            self.header[path], self.comments[path] = extract_comments(body)

    def get(self, t: str, name: str | None) -> dict | None:
        return self.by_type.get(t, {}).get(name) if name else None

    def file(self, t: str, name: str) -> str | None:
        return self.path.get((t, name))

    def notes(self, t: str, name: str, *inner: str) -> list[str]:
        """Comments for a top-level object (file header + its own) or, with
        `inner`, for a named item inside its file."""
        path = self.path.get((t, name))
        if not path:
            return []
        c = self.comments.get(path, {})
        if inner:
            out: list[str] = []
            for n in inner:
                out += [x for x in c.get(n, []) if x not in out]
            return out
        return [x for x in self.header.get(path, []) + c.get(name, []) if not x.startswith("Built with AtScale")]


def _cols(v: Any) -> list[str]:
    if v is None:
        return []
    return [str(x) for x in v] if isinstance(v, list) else [str(v)]


def _path(v: Any) -> str:
    """A relationships_path / semi-additive entry: a name or a nested list (embedded path)."""
    return " → ".join(_cols(v)) if isinstance(v, list) else str(v)


class _Audit:
    """Shared state while walking one model: property usage and findings."""

    def __init__(self, repo: _Repo):
        self.repo = repo
        self.usage: Counter[str] = Counter()
        self.seen: Counter[str] = Counter()
        self.undocumented: list[str] = []
        self.findings: list[dict[str, Any]] = []
        self.missing: list[dict[str, str]] = []

    def props(self, kind: str, obj: dict, where: str, skip: tuple[str, ...] = ()) -> dict[str, Any]:
        """{props, extra}: every documented property set on `obj` (minus the
        children rendered on their own) and any undocumented key. Counts usage."""
        if not isinstance(obj, dict):
            return {"props": {}, "extra": {}}
        spec = keys(kind)
        self.seen[kind] += 1
        for k in obj:
            if k in spec:
                self.usage[f"{kind}.{k}"] += 1
        extra = {k: v for k, v in obj.items() if k not in spec}
        for k in extra:
            self.undocumented.append(f"{where}: {k}{' (known, undocumented)' if k in KNOWN_UNDOCUMENTED else ''}")
        return {"props": {k: obj[k] for k in spec if k in obj and k not in skip}, "extra": extra}

    def add(self, level: str, text: str, items: list[str] | None = None, group: str = "") -> None:
        self.findings.append({"level": level, "text": text, "items": items or [], "group": group})


def _custom_empty(a: _Audit, v: Any, where: str) -> Any:
    if isinstance(v, dict):
        a.props("custom_empty_member", v, where)
    return v


def _attr(a: _Audit, x: dict, dim: str, kind: str, spec_kind: str, level: str | None = None) -> dict[str, Any]:
    name = x.get("unique_name") or ""
    p = a.props(spec_kind, x, f"{dim} › {name}", skip=("shared_degenerate_columns",))
    _custom_empty(a, x.get("custom_empty_member"), f"{dim} › {name}")
    shared = []
    for s in x.get("shared_degenerate_columns") or []:
        a.props("shared_degenerate_column", s, f"{dim} › {name}")
        shared.append({"dataset": s.get("dataset"), "keyColumns": _cols(s.get("key_columns")),
                       "nameColumn": s.get("name_column"), "sortColumn": s.get("sort_column"),
                       "uniqueKey": s.get("is_unique_key")})
    return {
        "name": name, "label": x.get("label") or name, "kind": kind, "level": level,
        "dataset": x.get("dataset"), "keyColumns": _cols(x.get("key_columns")), "nameColumn": x.get("name_column"),
        "sortColumn": x.get("sort_column"), "column": x.get("column"), "timeUnit": x.get("time_unit"),
        "calculationMethod": x.get("calculation_method"), "uniqueKey": bool(x.get("is_unique_key")),
        "hidden": bool(x.get("is_hidden")), "folder": x.get("folder"), "format": x.get("format"),
        "constraintTranslationRank": x.get("constraint_translation_rank"), "sharedDegenerateColumns": shared,
        "description": x.get("description"), "comments": a.repo.notes("dimension", dim, name), **p,
    }


def _dimension(a: _Audit, name: str, doc: dict) -> dict[str, Any]:
    repo = a.repo
    top = a.props("dimension", doc, name, skip=("hierarchies", "level_attributes", "relationships", "calculation_groups"))
    level_attrs = [_attr(a, la, name, "level", "level_attribute") for la in doc.get("level_attributes") or []]
    by_level = {x["name"]: x for x in level_attrs}
    hierarchies, secondary, aliases, metrical, parallel = [], [], [], [], []
    for h in doc.get("hierarchies") or []:
        hp = a.props("hierarchy", h, f"{name} › {h.get('unique_name')}", skip=("levels",))
        if isinstance(h.get("default_member"), dict):
            a.props("default_member", h["default_member"], f"{name} › {h.get('unique_name')}")
        levels = []
        for lv in h.get("levels") or []:
            ln = lv.get("unique_name")
            lp = a.props("level", lv, f"{name} › {h.get('unique_name')} › {ln}",
                         skip=("secondary_attributes", "aliases", "metrics", "parallel_periods"))
            la = by_level.get(ln, {})
            levels.append({"name": ln, "label": la.get("label") or ln, "hidden": bool(lv.get("is_hidden")),
                           "timeUnit": la.get("timeUnit"), **lp})
            secondary += [_attr(a, s, name, "secondary", "secondary_attribute", ln) for s in lv.get("secondary_attributes") or []]
            aliases += [_attr(a, s, name, "alias", "alias", ln) for s in lv.get("aliases") or []]
            metrical += [_attr(a, s, name, "metrical", "metrical_attribute", ln) for s in lv.get("metrics") or []]
            for pp in lv.get("parallel_periods") or []:
                a.props("parallel_period", pp, f"{name} › {ln}")
                parallel.append({"hierarchy": h.get("unique_name"), "level": ln, "toLevel": pp.get("level"),
                                 "keyColumns": _cols(pp.get("key_columns"))})
        dm = h.get("default_member") if isinstance(h.get("default_member"), dict) else {}
        hierarchies.append({"name": h.get("unique_name"), "label": h.get("label") or h.get("unique_name"),
                            "folder": h.get("folder"), "description": h.get("description"),
                            "filterEmpty": h.get("filter_empty"), "defaultMember": dm.get("expression"),
                            "defaultMemberOnlyInQuery": dm.get("apply_only_when_in_query"),
                            "levels": levels, "comments": repo.notes("dimension", name, h.get("unique_name") or ""), **hp})
    calc_groups = []
    for g in doc.get("calculation_groups") or []:
        gp = a.props("calculation_group", g, f"{name} › {g.get('unique_name')}", skip=("calculated_members",))
        members = []
        for i, m in enumerate(g.get("calculated_members") or []):
            mp = a.props("calculated_member", m, f"{name} › {g.get('unique_name')} › {m.get('unique_name')}")
            members.append({"name": m.get("unique_name"), "template": m.get("template"), "expression": m.get("expression"),
                            "format": m.get("format"), "useInputMetricFormat": m.get("use_input_metric_format"),
                            "hidden": bool(m.get("is_hidden")), "default": i == 0, "description": m.get("description"),
                            "comments": repo.notes("dimension", name, m.get("unique_name") or ""), **mp})
        calc_groups.append({"name": g.get("unique_name"), "label": g.get("label"), "description": g.get("description"),
                            "folder": g.get("folder"), "precedence": g.get("precedence"), "hidden": bool(g.get("is_hidden")),
                            "members": members, "comments": repo.notes("dimension", name, g.get("unique_name") or ""), **gp})
    rels = []
    for r in doc.get("relationships") or []:
        rp = a.props("dimension_relationship", r, f"{name} › relationship {r.get('unique_name')}")
        a.props("relationship_from", r.get("from") or {}, f"{name} › relationship {r.get('unique_name')} › from")
        a.props("relationship_to", r.get("to") or {}, f"{name} › relationship {r.get('unique_name')} › to")
        rels.append(rp)
    all_attrs = [*level_attrs, *secondary, *aliases, *metrical]
    datasets = sorted({x["dataset"] for x in all_attrs if x.get("dataset")}
                      | {s["dataset"] for x in level_attrs for s in x["sharedDegenerateColumns"] if s.get("dataset")}
                      | {(r.get("from") or {}).get("dataset") for r in doc.get("relationships") or [] if (r.get("from") or {}).get("dataset")})
    return {
        "name": name, "label": doc.get("label") or name, "type": doc.get("type") or "standard",
        "degenerate": bool(doc.get("is_degenerate")), "description": doc.get("description"),
        "file": repo.file("dimension", name), "comments": repo.notes("dimension", name),
        "hierarchies": hierarchies, "levelAttributes": level_attrs, "secondaryAttributes": secondary, "aliases": aliases,
        "metricalAttributes": metrical, "parallelPeriods": parallel, "calculationGroups": calc_groups, "datasets": datasets,
        "sharedDegenerate": any(x["sharedDegenerateColumns"] for x in level_attrs), **top,
    }


def _metric(a: _Audit, name: str, folder: str | None, overrides: dict) -> dict[str, Any] | None:
    repo = a.repo
    ov = (overrides.get(name) or {}).get("query_name") if isinstance(overrides.get(name), dict) else None
    doc = repo.get("metric", name)
    if doc is not None:
        p = a.props("metric", doc, name)
        sa = doc.get("semi_additive")
        if isinstance(sa, dict):
            a.props("semi_additive", sa, f"{name} › semi_additive")
            for d in sa.get("degenerate_dimensions") or []:
                a.props("degenerate_dimension_ref", d, f"{name} › semi_additive")
        method = doc.get("calculation_method")
        return {
            "name": name, "label": doc.get("label") or name, "kind": "metric", "calculationMethod": method,
            "additivity": "semi-additive" if isinstance(sa, dict) else "non-additive" if method in _NON_ADDITIVE else "additive",
            "dataset": doc.get("dataset"), "column": doc.get("column"),
            "semiAdditive": {"position": sa.get("position"), "relationships": [_path(r) for r in sa.get("relationships") or []],
                             "degenerate": [f"{d.get('name')}.{d.get('level')}" for d in sa.get("degenerate_dimensions") or []]}
            if isinstance(sa, dict) else None,
            "unrelatedDimensions": doc.get("unrelated_dimensions_handling"), "compression": doc.get("compression"),
            "namedQuantiles": doc.get("named_quantiles"), "customQuantiles": doc.get("custom_quantiles"),
            "quantiles": bool(doc.get("named_quantiles") or doc.get("custom_quantiles")),
            "format": doc.get("format"), "folder": folder, "hidden": bool(doc.get("is_hidden")), "queryName": ov,
            "description": doc.get("description"), "file": repo.file("metric", name), "comments": repo.notes("metric", name), **p,
        }
    doc = repo.get("metric_calc", name)
    if doc is not None:
        p = a.props("calculation", doc, name)
        expr = str(doc.get("expression") or "")
        return {
            "name": name, "label": doc.get("label") or name, "kind": "calculation", "expression": doc.get("expression"),
            "mdxAggregation": doc.get("mdx_aggregation_function") or doc.get("mdx_aggregate_function"),
            "timeFunctions": sorted({m.group(1).upper() for m in _TIME_FUNCS.finditer(expr)}),
            "format": doc.get("format"), "folder": folder, "hidden": bool(doc.get("is_hidden")), "queryName": ov,
            "description": doc.get("description"), "file": repo.file("metric_calc", name),
            "comments": repo.notes("metric_calc", name), **p,
        }
    return None


def find_model(files: dict[str, str], name: str) -> str | None:
    """unique_name of the (composite) model whose label or unique_name is `name`
    (case-insensitive); the repo's only model when nothing matches."""
    repo = _Repo(files)
    models = {**repo.by_type.get("model", {}), **repo.by_type.get("composite_model", {})}
    want = (name or "").strip().lower()
    for un, doc in models.items():
        if want in (un.lower(), str(doc.get("label") or "").lower()):
            return un
    return next(iter(models)) if len(models) == 1 else None


def models_in(files: dict[str, str]) -> list[str]:
    repo = _Repo(files)
    return sorted({*repo.by_type.get("model", {}), *repo.by_type.get("composite_model", {})})


def analyze(files: dict[str, str], model_name: str) -> dict[str, Any]:
    repo = _Repo(files)
    un = find_model(files, model_name)
    if not un:
        raise ValueError(f"No model named {model_name!r} in the repo (it has: {', '.join(models_in(files)) or 'none'})")
    a = _Audit(repo)

    def broken(kind: str, name: str, where: str) -> None:
        a.missing.append({"kind": kind, "name": name, "where": where})

    composite = repo.get("composite_model", un)
    members = [un] if composite is None else [str(m) for m in composite.get("models") or []]
    root = composite or repo.get("model", un) or {}
    root_props = a.props("composite_model" if composite is not None else "model", root, un,
                         skip=("relationships", "metrics", "perspectives", "drillthroughs", "aggregates", "partitions",
                               "dimensions", "overrides", "dataset_properties", "models"))

    # -- model-level objects ------------------------------------------------------------
    relationships: list[dict] = []
    metric_refs: dict[str, str | None] = {}
    dim_refs: set[str] = set()
    degenerate_refs: set[str] = set()
    perspectives, drillthroughs, aggregates, partitions = [], [], [], []
    overrides: dict[str, Any] = {}
    model_ds_props: dict[str, dict] = {}
    member_udas: list[str] = []

    def agg_rows(doc: dict, owner: str) -> list[dict]:
        out = []
        for g in doc.get("aggregates") or []:
            a.props("aggregate", g, f"{owner} › aggregate {g.get('unique_name')}", skip=("attributes",))
            attrs = []
            for x in g.get("attributes") or []:
                a.props("aggregate_attribute", x, f"{owner} › aggregate {g.get('unique_name')}")
                attrs.append({"name": x.get("name"), "dimension": x.get("dimension"), "rowSecurity": x.get("row_security"),
                              "partition": x.get("partition"), "partitionRank": x.get("partition_rank"),
                              "distribution": x.get("distribution"), "distributionRank": x.get("distribution_rank"),
                              "relationshipsPath": [_path(p) for p in x.get("relationships_path") or []]})
            out.append({"name": g.get("unique_name"), "label": g.get("label"), "caching": g.get("caching"),
                        "metrics": _cols(g.get("metrics")), "attributes": attrs, "model": owner,
                        "comments": repo.notes("composite_model" if owner == un and composite is not None else "model",
                                               owner, g.get("unique_name") or "")})
        return out

    for m in members:
        doc = repo.get("model", m)
        if doc is None:
            broken("model", m, f"composite model {un}")
            continue
        if composite is not None:
            a.props("model", doc, m, skip=("relationships", "metrics", "perspectives", "drillthroughs", "aggregates",
                                           "partitions", "dimensions", "overrides", "dataset_properties"))
            if doc.get("aggregates"):
                member_udas.append(f"{m}: {len(doc['aggregates'])}")
        for r in doc.get("relationships") or []:
            a.props("model_relationship", r, f"{m} › relationship {r.get('unique_name')}")
            a.props("model_relationship_from", r.get("from") or {}, f"{m} › relationship {r.get('unique_name')} › from")
            a.props("relationship_to", r.get("to") or {}, f"{m} › relationship {r.get('unique_name')} › to")
            if isinstance(r.get("constraint_translation"), dict):
                a.props("constraint_translation", r["constraint_translation"], f"{m} › relationship {r.get('unique_name')}")
            relationships.append({**r, "_model": m})
        for ref in doc.get("metrics") or []:
            ref = ref if isinstance(ref, dict) else {"unique_name": ref}
            a.props("metric_reference", ref, f"{m} › metrics")
            metric_refs.setdefault(ref.get("unique_name"), ref.get("folder"))
        for d in doc.get("dimensions") or []:
            degenerate_refs.add(d if isinstance(d, str) else d.get("unique_name"))
        for p in doc.get("perspectives") or []:
            a.props("perspective", p, f"{m} › perspective {p.get('unique_name')}", skip=("dimensions",))
            dims = []
            for pd in p.get("dimensions") or []:
                a.props("perspective_dimension", pd, f"{m} › perspective {p.get('unique_name')}")
                hs = []
                for ph in pd.get("hierarchies") or []:
                    a.props("perspective_hierarchy", ph, f"{m} › perspective {p.get('unique_name')} › {pd.get('name')}")
                    hs.append({"name": ph.get("name"), "level": ph.get("level"), "levels": _cols(ph.get("levels"))})
                dims.append({"name": pd.get("name"), "hierarchies": hs, "secondaryAttributes": _cols(pd.get("secondary_attributes")),
                             "relationshipsPath": [_path(x) for x in pd.get("relationships_path") or []]})
            perspectives.append({"name": p.get("unique_name"), "hiddenMetrics": _cols(p.get("metrics")), "hiddenDimensions": dims,
                                 "model": m, "comments": repo.notes("model", m, p.get("unique_name") or "")})
        for d in doc.get("drillthroughs") or []:
            a.props("drillthrough", d, f"{m} › drillthrough {d.get('unique_name')}", skip=("attributes",))
            attrs = []
            for x in d.get("attributes") or []:
                a.props("drillthrough_attribute", x, f"{m} › drillthrough {d.get('unique_name')}")
                attrs.append({"name": x.get("name"), "dimension": x.get("dimension"),
                              "relationshipsPath": [_path(p) for p in x.get("relationships_path") or []]})
            drillthroughs.append({"name": d.get("unique_name"), "metrics": _cols(d.get("metrics")), "attributes": attrs,
                                  "notes": d.get("notes"), "model": m, "comments": repo.notes("model", m, d.get("unique_name") or "")})
        if composite is None:
            aggregates += agg_rows(doc, m)
        for p in doc.get("partitions") or []:
            a.props("partition", p, f"{m} › partition {p.get('unique_name')}")
            partitions.append({"name": p.get("unique_name"), "dimension": p.get("dimension"), "attribute": p.get("attribute"),
                               "type": p.get("type"), "model": m})
        for k, v in (doc.get("overrides") or {}).items():
            if isinstance(v, dict):
                a.props("override", v, f"{m} › overrides › {k}")
            overrides[k] = v
        for ds, v in (doc.get("dataset_properties") or {}).items():
            if isinstance(v, dict):
                a.props("dataset_properties", v, f"{m} › dataset_properties › {ds}")
                model_ds_props.setdefault(ds, {}).update(v)
    if composite is not None:
        for ref in composite.get("metrics") or []:
            ref = ref if isinstance(ref, dict) else {"unique_name": ref}
            a.props("metric_reference", ref, f"{un} › metrics")
            metric_refs.setdefault(ref.get("unique_name"), ref.get("folder"))
        aggregates += agg_rows(composite, un)
    dim_refs |= degenerate_refs

    joins: list[dict[str, Any]] = []
    row_security: set[str] = set()
    for r in relationships:
        frm, to = r.get("from") or {}, r.get("to") or {}
        if to.get("row_security"):
            row_security.add(to["row_security"])
        elif to.get("dimension"):
            dim_refs.add(to["dimension"])
        ct = r.get("constraint_translation") if isinstance(r.get("constraint_translation"), dict) else None
        joins.append({"kind": "security" if to.get("row_security") else "fact", "name": r.get("unique_name"),
                      "fromDataset": frm.get("dataset"), "columns": _cols(frm.get("join_columns") or frm.get("columns")),
                      "toDimension": to.get("dimension") or to.get("row_security"), "toLevel": to.get("level"),
                      "fromHierarchy": None, "fromLevel": None, "rolePlay": r.get("role_play"), "m2m": False,
                      "constraintTranslation": {"level": ct.get("level"), "fromColumns": _cols(ct.get("from_columns"))} if ct else None,
                      "owner": r["_model"], "ownerKind": "model"})

    # -- dimensions, following embedded / snowflake relationships ----------------------
    dims: dict[str, dict | None] = {}
    queue = sorted(d for d in dim_refs if d)
    while queue:
        name = queue.pop(0)
        if name in dims:
            continue
        doc = repo.get("dimension", name)
        if doc is None:
            broken("dimension", name, f"model {un}")
            dims[name] = None
            continue
        dims[name] = _dimension(a, name, doc)
        for r in doc.get("relationships") or []:
            frm, to = r.get("from") or {}, r.get("to") or {}
            kind = r.get("type") or ("snowflake" if not to.get("dimension") else "embedded")
            if to.get("row_security"):
                row_security.add(to["row_security"])
                kind = "security"
            target = to.get("dimension") or (name if kind == "snowflake" else None)
            joins.append({"kind": kind, "name": r.get("unique_name"), "fromDataset": frm.get("dataset"),
                          "columns": _cols(frm.get("join_columns")), "toDimension": target or to.get("row_security"),
                          "toLevel": to.get("level"), "fromHierarchy": frm.get("hierarchy"), "fromLevel": frm.get("level"),
                          "rolePlay": r.get("role_play"), "m2m": bool(r.get("m2m")), "constraintTranslation": None,
                          "owner": name, "ownerKind": "dimension"})
            if kind == "embedded" and to.get("dimension") and to["dimension"] not in dims:
                queue.append(to["dimension"])
    dimensions = [d for d in dims.values() if d]
    by_dim = {d["name"]: d for d in dimensions}

    # -- metrics -------------------------------------------------------------------------
    metrics = []
    for name, folder in metric_refs.items():
        m = _metric(a, name, folder, overrides)
        if m is None:
            broken("metric", name, f"model {un}")
        else:
            metrics.append(m)

    # -- datasets, connections, row security, catalog, package ------------------------------
    rls_docs = {n: repo.get("row_security", n) for n in row_security}
    fact_ds = {j["fromDataset"] for j in joins if j["kind"] == "fact"} | {m["dataset"] for m in metrics if m.get("dataset")}
    dim_ds = {ds for d in dimensions for ds in d["datasets"]}
    sec_ds = {d.get("dataset") for d in rls_docs.values() if d and d.get("dataset")}
    catalog = next(iter(repo.by_type.get("catalog", {}).values()), None)
    cat_ds_props = {k: v for k, v in ((catalog or {}).get("dataset_properties") or {}).items() if isinstance(v, dict)}
    for ds, v in cat_ds_props.items():
        a.props("dataset_properties", v, f"catalog › dataset_properties › {ds}")
    datasets, conns = [], {}
    for name in sorted((fact_ds | dim_ds | sec_ds) - {None}):
        doc = repo.get("dataset", name)
        if doc is None:
            broken("dataset", name, "a relationship, metric, attribute or row security")
            continue
        p = a.props("dataset", doc, name, skip=("columns",))
        for d in doc.get("dialects") or []:
            a.props("dialect", d, f"{name} › dialects")
        if isinstance(doc.get("incremental"), dict):
            a.props("incremental", doc["incremental"], f"{name} › incremental")
        alt = doc.get("alternate") if isinstance(doc.get("alternate"), dict) else None
        if alt:
            a.props("alternate", alt, f"{name} › alternate")
        cols = []
        for c in doc.get("columns") or []:
            cp = a.props("column", c, f"{name} › {c.get('name')}")
            if isinstance(c.get("map"), dict):
                a.props("map", c["map"], f"{name} › {c.get('name')} › map")
            for d in c.get("dialects") or []:
                a.props("dialect", d, f"{name} › {c.get('name')} › dialects")
            cols.append({"name": c.get("name"), "dataType": c.get("data_type"), "sql": c.get("sql"),
                         "dialects": [d.get("dialect") for d in c.get("dialects") or []],
                         "map": c.get("map") if isinstance(c.get("map"), dict) else None, "parentColumn": c.get("parent_column"),
                         "comments": repo.notes("dataset", name, c.get("name") or ""), "description": c.get("description"), **cp})
        conn = doc.get("connection_id")
        conns.setdefault(conn, []).append(name)
        roles = [r for r, s in (("fact", fact_ds), ("dimension", dim_ds), ("security", sec_ds)) if name in s]
        inc = doc.get("incremental") if isinstance(doc.get("incremental"), dict) else None
        datasets.append({
            "name": name, "label": doc.get("label") or name, "role": " + ".join(roles),
            "connection": conn, "table": doc.get("table"), "sql": doc.get("sql"),
            "dialects": [{"dialect": d.get("dialect"), "sql": d.get("sql")} for d in doc.get("dialects") or []],
            "columns": cols, "calculatedColumns": sum(1 for c in cols if c["sql"]), "mapColumns": sum(1 for c in cols if c["map"]),
            "incremental": {"column": inc.get("column"), "gracePeriod": inc.get("grace_period")} if inc else None,
            "immutable": doc.get("immutable"), "qdsMaterialization": doc.get("qds_materialization"),
            "alternate": {"type": alt.get("type"), "connection": alt.get("connection_id"), "table": alt.get("table"),
                          "sql": alt.get("sql")} if alt else None,
            "datasetProperties": {"catalog": cat_ds_props.get(name), "model": model_ds_props.get(name),
                                  "effective": {**(cat_ds_props.get(name) or {}), **(model_ds_props.get(name) or {})}},
            "description": doc.get("description"), "file": repo.file("dataset", name), "comments": repo.notes("dataset", name), **p,
        })
    by_ds = {d["name"]: d for d in datasets}
    connections = []
    for name, used_by in sorted(conns.items(), key=lambda kv: str(kv[0])):
        doc = repo.get("connection", name)
        if doc is None:
            broken("connection", str(name), f"dataset {used_by[0]}")
            continue
        p = a.props("connection", doc, str(name))
        connections.append({"name": name, "label": doc.get("label") or name, "asConnection": doc.get("as_connection"),
                            "database": doc.get("database"), "schema": doc.get("schema"), "datasets": used_by,
                            "file": repo.file("connection", name), "comments": repo.notes("connection", name), **p})
    rls = []
    for name in sorted(row_security):
        doc = rls_docs[name]
        if doc is None:
            broken("row_security", name, "a relationship")
            continue
        p = a.props("row_security", doc, name)
        rls.append({"name": name, "label": doc.get("label") or name, "dataset": doc.get("dataset"),
                    "filterKey": doc.get("filter_key_column"), "idsColumn": doc.get("ids_column"),
                    "idType": doc.get("id_type"), "scope": doc.get("scope"), "useFilterKey": doc.get("use_filter_key"),
                    "secureTotals": doc.get("secure_totals"), "description": doc.get("description"),
                    "file": repo.file("row_security", name), "comments": repo.notes("row_security", name), **p})
    catalog_out = None
    if catalog:
        cp = a.props("catalog", catalog, "catalog", skip=("dataset_properties",))
        catalog_out = {"name": catalog.get("unique_name"), "label": catalog.get("label"), "version": catalog.get("version"),
                       "hiddenModels": _cols(catalog.get("hidden_models")),
                       "aggressiveAggPromotion": catalog.get("aggressive_agg_promotion"),
                       "buildSpeculativeAggs": catalog.get("build_speculative_aggs"), "datasetProperties": cat_ds_props,
                       "description": catalog.get("description"), "file": repo.file("catalog", catalog.get("unique_name") or ""),
                       "comments": repo.notes("catalog", catalog.get("unique_name") or ""), **cp}
    package_out = None
    if repo.package:
        ppath, pdoc = repo.package
        a.props("package", pdoc, "package", skip=("packages",))
        for e in pdoc.get("packages") or []:
            a.props("package_entry", e, "package")
        package_out = {"file": ppath, "version": pdoc.get("version"),
                       "packages": [{"name": e.get("name"), "url": e.get("url"), "branch": e.get("branch"),
                                     "version": e.get("version")} for e in pdoc.get("packages") or []]}

    # -- role plays + time intelligence ----------------------------------------------------
    role_plays: dict[str, dict[str, int]] = {}
    for j in joins:
        if j["rolePlay"] and j["toDimension"]:
            roles = role_plays.setdefault(j["toDimension"], {})
            roles[j["rolePlay"]] = roles.get(j["rolePlay"], 0) + 1
    time_dims = [d for d in dimensions if d["type"] == "time" or any(x["timeUnit"] for x in d["levelAttributes"])]
    time_intel = {
        "dimensions": [{"name": d["name"], "label": d["label"], "type": d["type"],
                        "roles": [r for r in role_plays.get(d["name"], {})],
                        "hierarchies": [{"name": h["name"], "label": h["label"],
                                         "levels": [{"name": l["name"], "label": l["label"], "timeUnit": l["timeUnit"]} for l in h["levels"]]}
                                        for h in d["hierarchies"]],
                        "parallelPeriods": d["parallelPeriods"]} for d in time_dims],
        "calculationGroups": [{"dimension": d["label"], **g} for d in dimensions for g in d["calculationGroups"]],
        "calculations": [{"name": m["name"], "label": m["label"], "functions": m["timeFunctions"], "expression": m["expression"]}
                         for m in metrics if m["kind"] == "calculation" and m["timeFunctions"]],
        "semiAdditive": [{"name": m["name"], "label": m["label"], **m["semiAdditive"]} for m in metrics if m.get("semiAdditive")],
    }

    # -- unused + counts -------------------------------------------------------------------
    used = {("model", m) for m in members} | {("composite_model", un)} \
        | {("dimension", d) for d in dims} | {("dataset", d["name"]) for d in datasets} \
        | {("connection", c["name"]) for c in connections} | {("row_security", r) for r in row_security} \
        | {("metric", m["name"]) for m in metrics if m["kind"] == "metric"} \
        | {("metric_calc", m["name"]) for m in metrics if m["kind"] == "calculation"} \
        | {("catalog", n) for n in repo.by_type.get("catalog", {})}
    unused = sorted(({"type": t, "name": n, "file": repo.file(t, n)} for t, objs in repo.by_type.items()
                     for n in objs if (t, n) not in used), key=lambda o: (o["type"], o["name"]))
    other_models = [m for m in models_in(files) if m not in members and m != un]

    plain = [m for m in metrics if m["kind"] == "metric"]
    calcs = [m for m in metrics if m["kind"] == "calculation"]
    attrs = [x for d in dimensions for x in d["levelAttributes"] + d["secondaryAttributes"] + d["aliases"] + d["metricalAttributes"]]
    counts = {
        "metrics": len(plain), "calculations": len(calcs),
        "semiAdditive": sum(1 for m in plain if m["semiAdditive"]),
        "nonAdditive": sum(1 for m in plain if m["additivity"] == "non-additive"),
        "dimensions": len(dimensions), "degenerateDimensions": sum(1 for d in dimensions if d["degenerate"]),
        "sharedDegenerateDimensions": sum(1 for d in dimensions if d["sharedDegenerate"]),
        "timeDimensions": len(time_dims),
        "hierarchies": sum(len(d["hierarchies"]) for d in dimensions),
        "levels": sum(len(h["levels"]) for d in dimensions for h in d["hierarchies"]),
        "levelAttributes": sum(len(d["levelAttributes"]) for d in dimensions),
        "secondaryAttributes": sum(len(d["secondaryAttributes"]) for d in dimensions),
        "aliases": sum(len(d["aliases"]) for d in dimensions),
        "metricalAttributes": sum(len(d["metricalAttributes"]) for d in dimensions),
        "parallelPeriods": sum(len(d["parallelPeriods"]) for d in dimensions),
        "calculationGroups": sum(len(d["calculationGroups"]) for d in dimensions),
        "calculatedMembers": sum(len(g["members"]) for d in dimensions for g in d["calculationGroups"]),
        "timeCalculations": len(time_intel["calculations"]),
        "defaultMembers": sum(1 for d in dimensions for h in d["hierarchies"] if h["defaultMember"]),
        "customEmptyMembers": a.seen["custom_empty_member"],
        "datasets": len(datasets), "factDatasets": sum(1 for d in datasets if "fact" in d["role"]),
        "queryDatasets": sum(1 for d in datasets if d["sql"]),
        "calculatedColumns": sum(d["calculatedColumns"] for d in datasets),
        "mapColumns": sum(d["mapColumns"] for d in datasets),
        "incrementalDatasets": sum(1 for d in datasets if d["incremental"]),
        "connections": len(connections), "joins": len(joins),
        "factJoins": sum(1 for j in joins if j["kind"] == "fact"),
        "snowflakeJoins": sum(1 for j in joins if j["kind"] == "snowflake"),
        "embeddedJoins": sum(1 for j in joins if j["kind"] == "embedded"),
        "securityJoins": sum(1 for j in joins if j["kind"] == "security"),
        "m2m": sum(1 for j in joins if j["m2m"]),
        "constraintTranslations": sum(1 for j in joins if j["constraintTranslation"]),
        "rolePlays": sum(len(v) for v in role_plays.values()), "rolePlayedDimensions": len(role_plays),
        "rolePlayRelationships": sum(n for v in role_plays.values() for n in v.values()),
        "rowSecurity": len(rls), "perspectives": len(perspectives), "drillthroughs": len(drillthroughs),
        "userAggregates": len(aggregates), "partitions": len(partitions), "overrides": len(overrides),
        "hiddenObjects": sum(1 for m in metrics if m["hidden"]) + sum(1 for x in attrs if x["hidden"]),
        "undocumentedKeys": len(a.undocumented), "files": len(files),
    }

    _check(a, un, members, composite is not None, catalog_out, metrics, dimensions, by_dim, datasets, by_ds, joins,
           rls, aggregates, partitions, perspectives, drillthroughs, overrides, model_ds_props, cat_ds_props,
           member_udas, unused, package_out)

    bus = _bus_matrix(metrics, dimensions, joins)

    usage = [{"kind": kind, "file": f.replace("|", ", "), "property": p, "count": a.usage.get(f"{kind}.{p}", 0), "objects": a.seen.get(kind, 0)}
             for kind, (f, props) in SPEC.items() for p in props]
    order = {"error": 0, "warn": 1, "info": 2}
    a.findings.sort(key=lambda f: order[f["level"]])
    return {
        "model": {"name": un, "label": root.get("label") or un, "composite": composite is not None, "members": members,
                  "description": root.get("description"),
                  "file": repo.file("composite_model" if composite is not None else "model", un),
                  "comments": repo.notes("composite_model" if composite is not None else "model", un),
                  "includeDefaultDrillthrough": root.get("include_default_drillthrough"),
                  "degenerateDimensions": sorted(d for d in degenerate_refs if d), **root_props},
        "catalog": catalog_out, "package": package_out, "otherModels": other_models,
        "counts": counts,
        "calculationMethods": dict(Counter(m.get("calculationMethod") or "?" for m in plain).most_common()),
        "formats": dict(Counter(m.get("format") or "(none)" for m in metrics).most_common()),
        "folders": dict(Counter(m.get("folder") or "(no folder)" for m in metrics).most_common()),
        "metrics": metrics, "dimensions": dimensions, "datasets": datasets, "connections": connections, "joins": joins,
        "rolePlays": [{"dimension": d, "roles": [{"template": t, "relationships": n} for t, n in r.items()]}
                      for d, r in sorted(role_plays.items())],
        "timeIntelligence": time_intel, "busMatrix": bus,
        "rowSecurity": rls, "perspectives": perspectives, "drillthroughs": drillthroughs, "aggregates": aggregates,
        "partitions": partitions,
        "overrides": [{"name": k, "queryName": (v or {}).get("query_name") if isinstance(v, dict) else v} for k, v in overrides.items()],
        "datasetProperties": {"catalog": cat_ds_props, "model": model_ds_props},
        "unused": unused, "undocumented": a.undocumented, "propertyUsage": usage, "findings": a.findings,
    }


def _check(a: _Audit, un: str, members: list[str], composite: bool, catalog: dict | None, metrics: list[dict],
           dimensions: list[dict], by_dim: dict[str, dict], datasets: list[dict], by_ds: dict[str, dict], joins: list[dict],
           rls: list[dict], aggregates: list[dict], partitions: list[dict], perspectives: list[dict], drillthroughs: list[dict],
           overrides: dict, model_ds_props: dict, cat_ds_props: dict, member_udas: list[str], unused: list[dict],
           package: dict | None) -> None:
    """Reference checks and the reference docs' rules, as findings."""
    add = a.add
    pkg = " (it may come from a package)" if package else ""
    for b in a.missing:
        add("warn" if package else "error",
            f"{b['kind'].replace('_', ' ').capitalize()} {b['name']!r} is referenced by {b['where']} but not in the repo{pkg}",
            group="references")
    for e in a.repo.errors:
        add("error", f"{e['file']} is not valid YAML: {e['error']}", group="references")

    # columns exist in their dataset
    bad_cols: list[str] = []

    def col(ds: str | None, c: str | None, where: str) -> None:
        if ds and c and ds in by_ds and c not in {x["name"] for x in by_ds[ds]["columns"]}:
            bad_cols.append(f"{where}: {ds}.{c}")

    for d in dimensions:
        for x in d["levelAttributes"] + d["secondaryAttributes"] + d["aliases"] + d["metricalAttributes"]:
            for c in [*x["keyColumns"], x["nameColumn"], x["sortColumn"], x["column"]]:
                col(x["dataset"], c, f"{d['label']} › {x['label']}")
            for s in x["sharedDegenerateColumns"]:
                for c in [*s["keyColumns"], s["nameColumn"], s["sortColumn"]]:
                    col(s["dataset"], c, f"{d['label']} › {x['label']}")
    for m in metrics:
        if m["kind"] == "metric":
            col(m.get("dataset"), m.get("column"), m["label"])
    for j in joins:
        for c in j["columns"]:
            col(j["fromDataset"], c, f"join {j['name'] or ''} ({j['owner']})")
        if j["constraintTranslation"]:
            for c in j["constraintTranslation"]["fromColumns"]:
                col(j["fromDataset"], c, f"constraint translation {j['name']}")
    for d in datasets:
        if d["incremental"]:
            col(d["name"], d["incremental"]["column"], "incremental")
        names = {c["name"] for c in d["columns"]}
        for c in d["columns"]:
            if c["parentColumn"] and c["parentColumn"] not in names:
                bad_cols.append(f"{d['label']}.{c['name']}: parent_column {c['parentColumn']} not in the dataset")
    for r in rls:
        col(r["dataset"], r["filterKey"], f"row security {r['label']}")
        col(r["dataset"], r["idsColumn"], f"row security {r['label']}")
    if bad_cols:
        add("error", f"{len(bad_cols)} column reference(s) not found in their dataset's columns", bad_cols, "references")

    # levels / hierarchies / relationships exist
    def levels_of(dim: str) -> set[str]:
        return {x["name"] for x in by_dim[dim]["levelAttributes"]} if dim in by_dim else set()

    def attrs_of(dim: str) -> set[str]:
        d = by_dim.get(dim)
        return {x["name"] for x in d["levelAttributes"] + d["secondaryAttributes"] + d["aliases"] + d["metricalAttributes"]} \
            | {h["name"] for h in d["hierarchies"]} if d else set()

    bad_lv: list[str] = []
    for j in joins:
        if j["kind"] in ("fact", "embedded", "snowflake") and j["toLevel"] and j["toDimension"] in by_dim \
                and j["toLevel"] not in levels_of(j["toDimension"]):
            bad_lv.append(f"{j['owner']} → {j['toDimension']}.{j['toLevel']}")
        if j["fromLevel"] and j["owner"] in by_dim and j["fromLevel"] not in levels_of(j["owner"]):
            bad_lv.append(f"{j['owner']} from level {j['fromLevel']}")
    for d in dimensions:
        for h in d["hierarchies"]:
            for lv in h["levels"]:
                if lv["name"] not in levels_of(d["name"]):
                    bad_lv.append(f"{d['label']} › {h['label']} › {lv['name']} (no level attribute)")
        for p in d["parallelPeriods"]:
            if p["toLevel"] and p["toLevel"] not in levels_of(d["name"]):
                bad_lv.append(f"{d['label']} parallel period → {p['toLevel']}")
    if bad_lv:
        add("error", f"{len(bad_lv)} level reference(s) that don't resolve", bad_lv, "references")

    rel_names = {j["name"] for j in joins if j["name"]}
    bad_ref: list[str] = []
    for m in metrics:
        sa = m.get("semiAdditive")
        if sa:
            for r in sa["relationships"]:
                for part in r.split(" → "):
                    if part not in rel_names:
                        bad_ref.append(f"{m['label']} semi-additive relationship {part}")
            for dg in sa["degenerate"]:
                dn, _, lv = dg.partition(".")
                if dn not in by_dim or lv not in levels_of(dn):
                    bad_ref.append(f"{m['label']} semi-additive degenerate {dg}")
    metric_names = {m["name"] for m in metrics}
    for g in aggregates:
        for mn in g["metrics"]:
            if mn not in metric_names:
                bad_ref.append(f"aggregate {g['name']} metric {mn}")
        for x in g["attributes"]:
            if x["dimension"] and x["name"] and x["name"] not in attrs_of(x["dimension"]):
                bad_ref.append(f"aggregate {g['name']} attribute {x['dimension']}.{x['name']}")
    for d in drillthroughs:
        for mn in d["metrics"]:
            if mn not in metric_names:
                bad_ref.append(f"drill-through {d['name']} metric {mn}")
        for x in d["attributes"]:
            if x["dimension"] and x["name"] not in attrs_of(x["dimension"]):
                bad_ref.append(f"drill-through {d['name']} attribute {x['dimension']}.{x['name']}")
    for p in partitions:
        if p["attribute"] not in attrs_of(p["dimension"]):
            bad_ref.append(f"partition {p['name']} → {p['dimension']}.{p['attribute']}")
    for p in perspectives:
        for mn in p["hiddenMetrics"]:
            if mn not in metric_names:
                bad_ref.append(f"perspective {p['name']} metric {mn}")
        for pd in p["hiddenDimensions"]:
            if pd["name"] not in by_dim:
                bad_ref.append(f"perspective {p['name']} dimension {pd['name']}")
                continue
            hs = {h["name"]: h for h in by_dim[pd["name"]]["hierarchies"]}
            for ph in pd["hierarchies"]:
                if ph["name"] not in hs:
                    bad_ref.append(f"perspective {p['name']} hierarchy {pd['name']}.{ph['name']}")
    dim_names = {d["name"] for d in dimensions}
    for k in overrides:
        if k not in metric_names and k not in dim_names:
            bad_ref.append(f"override {k} (not a metric or dimension of the model)")
    for ds in model_ds_props:
        if ds not in by_ds:
            bad_ref.append(f"model dataset_properties {ds} (dataset not used by the model)")
    if catalog:
        for hm in catalog["hiddenModels"]:
            if hm not in members and a.repo.get("model", hm) is None:
                bad_ref.append(f"catalog hidden_models {hm}")
    if bad_ref:
        add("error", f"{len(bad_ref)} reference(s) to relationships, metrics or attributes that don't resolve", bad_ref, "references")

    # spec rules
    ct_rank = [f"{j['name']} → {j['constraintTranslation']['level']}" for j in joins if j["constraintTranslation"]
               and j["toDimension"] in by_dim and not any(x["name"] == j["constraintTranslation"]["level"]
                                                          and x["constraintTranslationRank"] is not None
                                                          for x in by_dim[j["toDimension"]]["levelAttributes"])]
    if ct_rank:
        add("error", "constraint_translation without a constraint_translation_rank on its level (model.md)", ct_rank, "rules")
    for g in aggregates:
        for rank in ("partitionRank", "distributionRank"):
            vals = sorted(x[rank] for x in g["attributes"] if x[rank] is not None)
            if vals and vals != list(range(1, len(vals) + 1)):
                add("error", f"Aggregate {g['name']}: {rank.replace('Rank', '_rank')} values must run 1, 2, 3... (model.md)",
                    [str(v) for v in vals], "rules")
    pct = [m["label"] for m in metrics if m.get("calculationMethod") == "percentile"
           and not (m.get("compression") and (m.get("namedQuantiles") or m.get("customQuantiles")))]
    if pct:
        add("error", "percentile metric(s) without compression + named/custom quantiles (metric.md)", pct, "rules")
    semi_bad = [f"{m['label']} ({m['calculationMethod']})" for m in metrics if m.get("semiAdditive")
                and m.get("calculationMethod") not in _SEMI_OK]
    if semi_bad:
        add("warn", "semi-additive metric(s) with a method other than average / sum / minimum / maximum (metric.md)", semi_bad, "rules")
    qds = [d["label"] for d in datasets if d["qdsMaterialization"] and not d["sql"]]
    if qds:
        add("warn", "qds_materialization on a table dataset - only applies to query (SQL) datasets (dataset.md)", qds, "rules")
    deprecated = [f"{p['name']} › {pd['name']}.{ph['name']}" for p in perspectives for pd in p["hiddenDimensions"]
                  for ph in pd["hierarchies"] if ph["levels"]]
    if deprecated:
        add("warn", "perspective hierarchies use the deprecated `levels` (use `level`) (model.md)", deprecated, "rules")
    pp_nontime = [d["label"] for d in dimensions if d["parallelPeriods"] and d["type"] != "time"]
    if pp_nontime:
        add("warn", "parallel periods on a non-time dimension (dimension.md: time dimensions only)", pp_nontime, "rules")
    tu_nontime = [d["label"] for d in dimensions if d["type"] != "time" and any(x["timeUnit"] for x in d["levelAttributes"])]
    if tu_nontime:
        add("warn", "time_unit set on a non-time dimension (dimension.md: time dimensions only)", tu_nontime, "rules")
    shared_sec = [d["label"] for d in dimensions if d["sharedDegenerate"] and d["secondaryAttributes"]]
    if shared_sec:
        add("error", "shared degenerate dimension(s) with secondary attributes (dimension.md)", shared_sec, "rules")
    m2m_bad = [f"{j['owner']} → {j['toDimension']}" for j in joins if j["m2m"] and j["kind"] != "embedded"]
    if m2m_bad:
        add("error", "m2m set on a non-embedded relationship (dimension.md: embedded only)", m2m_bad, "rules")
    if composite and member_udas:
        add("warn", "UDAs on the composite's member models are not used (composite-model.md)", member_udas, "rules")
    if catalog and un in catalog["hiddenModels"]:
        add("warn", f"{un} is in the catalog's hidden_models - it is not deployed as a model of its own", group="rules")
    no_dialect = [d["label"] for d in datasets if d["sql"] and not d["dialects"]]
    if no_dialect:
        add("info", "query dataset(s) with no alternate dialects - their SQL runs only on one warehouse type", no_dialect, "rules")

    # review points
    undescribed = [m["label"] for m in metrics if not m.get("description")]
    if undescribed:
        add("warn", f"{len(undescribed)} of {len(metrics)} metrics / calculations have no description", undescribed, "documentation")
    undescribed = [d["label"] for d in dimensions if not d.get("description")]
    if undescribed:
        add("info", f"{len(undescribed)} of {len(dimensions)} dimensions have no description", undescribed, "documentation")
    attrs = [x for d in dimensions for x in d["levelAttributes"] + d["secondaryAttributes"] + d["aliases"] + d["metricalAttributes"]]
    undescribed = [x["label"] for x in attrs if not x.get("description") and not x["hidden"]]
    if undescribed:
        add("info", f"{len(undescribed)} of {len(attrs)} attributes have no description", undescribed, "documentation")
    undescribed = [d["label"] for d in datasets if not d.get("description")]
    if undescribed:
        add("info", f"{len(undescribed)} of {len(datasets)} datasets have no description", undescribed, "documentation")
    if any(j["m2m"] for j in joins):
        add("warn", "many-to-many relationship(s) - results can double count; check the bridge tables",
            [f"{j['owner']}: {j['fromDataset']} → {j['toDimension']}" for j in joins if j["m2m"]], "design")
    semi = [f"{m['label']} ({m['semiAdditive']['position']})" for m in metrics if m.get("semiAdditive")]
    if semi:
        add("info", f"{len(semi)} semi-additive metric(s) - not summed across the listed relationships", semi, "design")
    nonadd = [m["label"] for m in metrics if m.get("additivity") == "non-additive"]
    if nonadd:
        add("info", f"{len(nonadd)} non-additive metric(s) - system aggregates are not built for them (model.md UDAs)", nonadd, "design")
    composite_keys = [f"{j['fromDataset']} → {j['toDimension']} ({', '.join(j['columns'])})" for j in joins if len(j["columns"]) > 1]
    if composite_keys:
        add("info", f"{len(composite_keys)} join(s) on a composite key", composite_keys, "design")
    qd = [d["label"] for d in datasets if d["sql"]]
    if qd:
        add("info", f"{len(qd)} query (SQL) dataset(s) - their SQL runs on every warehouse query", qd, "design")
    cc = [f"{d['label']}.{c['name']}" for d in datasets for c in d["columns"] if c["sql"]]
    if cc:
        add("info", f"{len(cc)} calculated column(s)", cc, "design")
    if len({d["connection"] for d in datasets}) > 1:
        add("warn", "Datasets span several connections - every host needs all of them",
            sorted({str(d["connection"]) for d in datasets}), "design")
    hidden = [m["label"] for m in metrics if m["hidden"]] + [x["label"] for x in attrs if x["hidden"]]
    if hidden:
        add("info", f"{len(hidden)} hidden object(s)", hidden, "design")
    no_folder = [m["label"] for m in metrics if not m.get("folder") and not m["hidden"]]
    if no_folder and len(no_folder) < len(metrics):
        add("info", f"{len(no_folder)} metric(s) outside any folder", no_folder, "design")
    no_sort = [x["label"] for d in dimensions for x in d["levelAttributes"] if not x.get("sortColumn") and not x.get("timeUnit")]
    if no_sort:
        add("info", f"{len(no_sort)} level(s) without a sort column - they sort by name", no_sort, "design")
    if a.undocumented:
        add("info", f"{len(a.undocumented)} key(s) the SML reference doesn't document", a.undocumented, "design")
    if unused:
        add("info", f"{len(unused)} object(s) in the repo are not used by this model",
            [f"{u['type']}: {u['name']}" for u in unused], "design")


def _bus_matrix(metrics: list[dict], dimensions: list[dict], joins: list[dict]) -> dict[str, Any]:
    """Fact datasets × dimensions: how each fact reaches each dimension.

    Direct: a model relationship (fact columns → dimension level, role-play) or
    a degenerate dimension built on the fact's own columns. Via: a dimension
    reached through an embedded relationship of a dimension the fact reaches
    (the path is listed). Each metric's reach is its dataset's row; metrics
    queried with a dimension outside it fall under unrelated_dimensions_handling.
    Calculations are MDX over other metrics, so their reach isn't derived here."""
    dim_names = [d["name"] for d in dimensions]
    embedded: dict[str, list[dict]] = {}
    for j in joins:
        if j["kind"] == "embedded" and j["toDimension"]:
            embedded.setdefault(j["owner"], []).append(j)
    facts: dict[str, dict[str, list[dict]]] = {}
    for j in joins:
        if j["kind"] == "fact" and j["fromDataset"] and j["toDimension"]:
            facts.setdefault(j["fromDataset"], {}).setdefault(j["toDimension"], []).append(
                {"how": "join", "columns": j["columns"], "level": j["toLevel"], "rolePlay": j["rolePlay"], "relationship": j["name"]})
    for m in metrics:
        if m.get("dataset"):
            facts.setdefault(m["dataset"], {})
    for d in dimensions:
        if d["degenerate"]:
            for ds in d["datasets"]:
                if ds in facts:
                    facts[ds].setdefault(d["name"], []).append({"how": "degenerate", "columns": [], "level": None,
                                                               "rolePlay": None, "relationship": None})
    rows = []
    for ds in sorted(facts):
        cells = {k: list(v) for k, v in facts[ds].items()}
        # walk embedded relationships from every directly reached dimension
        frontier = [(dn, [dn], c[0].get("rolePlay")) for dn, c in facts[ds].items()]
        while frontier:
            dn, path, role = frontier.pop(0)
            for e in embedded.get(dn, []):
                tgt = e["toDimension"]
                if tgt in path:
                    continue
                cells.setdefault(tgt, []).append({"how": "embedded", "columns": e["columns"], "level": e["toLevel"],
                                                  "rolePlay": e["rolePlay"] or role, "relationship": e["name"],
                                                  "path": path + [tgt], "m2m": e["m2m"]})
                frontier.append((tgt, path + [tgt], e["rolePlay"] or role))
        ms = [m for m in metrics if m.get("dataset") == ds]
        rows.append({"dataset": ds, "metrics": [m["label"] for m in ms], "cells": cells,
                     "unreached": [d for d in dim_names if d not in cells]})
    reach = {r["dataset"]: set(r["cells"]) for r in rows}
    metric_reach = [{"metric": m["label"], "dataset": m["dataset"],
                     "dimensions": sorted(reach.get(m["dataset"], set())),
                     "unrelated": [d for d in dim_names if d not in reach.get(m["dataset"], set())],
                     "handling": m.get("unrelatedDimensions")}
                    for m in metrics if m["kind"] == "metric" and m.get("dataset")]
    return {"dimensions": dim_names, "facts": rows, "metricReach": metric_reach,
            "conformed": [d for d in dim_names if sum(1 for r in rows if d in r["cells"]) > 1]}
