"""Manage › Analyze: SML audit of a model (analyze/model.py) and its API."""

from pathlib import Path

import pytest

from analyze.model import analyze, extract_comments
from tests.test_api_fake import client  # noqa: F401 - fixture

SALES = Path(__file__).resolve().parent.parent / "atscale" / "demo_sml" / "sales-insights"


@pytest.fixture(scope="module")
def sales():
    files = {str(p.relative_to(SALES)): p.read_text() for p in SALES.rglob("*.yml")}
    return files, analyze(files, "Internet Sales")


def test_counts_sales_insights(sales):
    _, r = sales
    c = r["counts"]
    assert (c["metrics"], c["calculations"], c["semiAdditive"]) == (13, 133, 2)
    assert (c["dimensions"], c["degenerateDimensions"], c["timeDimensions"]) == (10, 4, 1)
    assert (c["joins"], c["factJoins"], c["snowflakeJoins"], c["embeddedJoins"]) == (15, 9, 3, 3)
    assert (c["datasets"], c["factDatasets"], c["connections"]) == (10, 1, 1)
    assert (c["perspectives"], c["drillthroughs"], c["userAggregates"]) == (1, 2, 2)


def test_role_plays_counted_once_per_role(sales):
    _, r = sales
    assert r["counts"]["rolePlays"] == 2 and r["counts"]["rolePlayRelationships"] == 6
    (date,) = r["rolePlays"]
    assert date["dimension"] == "Date Dimension"
    assert {x["template"] for x in date["roles"]} == {"Order {0}", "Ship {0}"}


def test_unused_objects_and_comments(sales):
    _, r = sales
    assert {(u["type"], u["name"]) for u in r["unused"]} == {
        ("dataset", "User to Country Map"), ("row_security", "Row Level Security by Region")}
    conn = r["connections"][0]
    assert any("databricks" in c for c in conn["comments"])


def test_missing_reference_is_an_error(sales):
    files, _ = sales
    files = dict(files)
    files["models/Internet Sales.yml"] = files["models/Internet Sales.yml"].replace(
        "  - Color Dimension", "  - Nope Dimension", 1)
    r = analyze(files, "Internet Sales")
    assert any(f["level"] == "error" and "Nope Dimension" in f["text"] for f in r["findings"])


def test_extract_comments():
    header, by = extract_comments(
        "# file header\n\nunique_name: m1  # the model\nobject_type: metric\n"
        "columns:\n  # key column\n  - name: id\n    data_type: int  # surrogate\n")
    assert header == ["file header"]
    assert by["m1"] == ["the model"]
    assert by["id"] == ["key column", "surrogate"]


def test_analyze_api_demo(client):  # noqa: F811
    models = client.get("/api/hosts/dev-east/models").get_json()["models"]
    row = next(m for m in models if m["status"] == "Deployed")
    body = client.get(f"/api/hosts/dev-east/analyze?key={row['key']}").get_json()
    assert body["model"]["label"] == row["name"]
    assert body["counts"]["metrics"] == 13
    assert body["deployed"]["aggregates"]["total"] >= 0 and "dmvError" in body["deployed"]
    f = client.get(f"/api/hosts/dev-east/analyze/file?key={row['key']}&path=catalog.yml").get_json()
    assert "object_type: catalog" in f["content"]
    assert client.get("/api/hosts/dev-east/analyze?key=nope").status_code == 404


# -- every documented SML property is in analyze/spec.py ------------------------------------

REF = Path(__file__).resolve().parents[2] / "reference" / "ps-utils" / "resources" / "sml-reference"
# Enum values the docs list as "- `value`: explanation" - not properties.
_ENUM_VALUES = {"standard", "time", "embedded", "snowflake", "yes", "no", "always", "true", "false", "error", "empty",
                "repeat", "related", "fact", "fact-only", "all", "user", "group", "first", "last", "first_child",
                "last_child", "name", "key", "name+key", "quartiles", "median", "deciles"}


def _documented(md: str) -> set[str]:
    import re

    text = md
    props = set(re.findall(r"^#{2,4} ([a-z_][a-z0-9_]*)\s*$", text, re.M))
    props |= set(re.findall(r"^\s*- `([a-z_][a-z0-9_]*)`: (?:String|Boolean|Array|Integer|Object|Number|string|boolean)", text, re.M))
    # mermaid class fields: "      <Type>[~Inner~] name"
    props |= set(re.findall(r"^\s{4,}[A-Za-z]\w*(?:~\w+~)?\s+([a-z_][a-z0-9_]*)\s*$", text, re.M))
    return props - _ENUM_VALUES


@pytest.mark.skipif(not REF.is_dir(), reason="ps-utils submodule not checked out")
def test_spec_covers_every_documented_property():
    from analyze.spec import SPEC

    by_file: dict[str, set[str]] = {}
    for _kind, (files, props) in SPEC.items():
        for f in files.split("|"):
            by_file.setdefault(f, set()).update(props)
    missing = {}
    for md in REF.glob("*.md"):
        if md.name == "UPSTREAM.md":
            continue
        gap = _documented(md.read_text()) - by_file.get(md.name, set())
        if gap:
            missing[md.name] = sorted(gap)
    assert not missing, f"SML properties not in analyze/spec.py: {missing}"


def test_property_usage_lists_every_spec_property(sales):
    from analyze.spec import SPEC

    _, r = sales
    assert len(r["propertyUsage"]) == sum(len(p) for _, p in SPEC.values())
    used = {(u["kind"], u["property"]): u["count"] for u in r["propertyUsage"]}
    assert used[("level_attribute", "time_unit")] > 0
    assert used[("calculated_member", "template")] > 0
    assert used[("row_security", "secure_totals")] == 0  # documented, unused - still listed


def test_time_intelligence(sales):
    _, r = sales
    ti = r["timeIntelligence"]
    (date,) = ti["dimensions"]
    assert ["year", "quarter", "month", "week", "day"] in [[l["timeUnit"] for l in h["levels"]] for h in date["hierarchies"]]
    assert r["counts"]["calculationGroups"] == 5 and r["counts"]["calculatedMembers"] == 17
    assert r["counts"]["parallelPeriods"] == 4
    assert any("PARALLELPERIOD" in c["functions"] for c in ti["calculations"])


def test_bus_matrix(sales):
    _, r = sales
    (fact,) = r["busMatrix"]["facts"]
    assert fact["dataset"] == "factinternetsales" and len(fact["metrics"]) == 13
    assert {c["rolePlay"] for c in fact["cells"]["Date Dimension"]} == {"Order {0}", "Ship {0}"}
    assert fact["cells"]["Color Dimension"][0]["how"] == "degenerate"
    assert fact["cells"]["Geography Dimension"][0]["path"] == ["Customer Dimension", "Geography Dimension"]


def test_reference_and_rule_checks(sales):
    files, _ = sales
    files = dict(files)
    model = "models/Internet Sales.yml"
    files[model] = files[model].replace("join_columns:\n        - orderdatekey", "join_columns:\n        - no_such_col", 1) \
        + "overrides:\n  not_a_metric:\n    query_name: x\n"
    r = analyze(files, "Internet Sales")
    texts = {f["text"]: f["items"] for f in r["findings"] if f["level"] == "error"}
    cols = next(v for k, v in texts.items() if "column reference" in k)
    assert any("no_such_col" in c for c in cols)
    refs = next(v for k, v in texts.items() if "don't resolve" in k and "relationships" in k)
    assert any("override not_a_metric" in x for x in refs)
