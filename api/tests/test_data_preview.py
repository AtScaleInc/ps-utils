"""Build > Develop Preview data against the fake warehouse (SQLite behind
FakeSourceApi.query_sample, which applies the engine's LIMIT 10)."""

import pytest

from discovery import data_preview
from tests.test_api_fake import client as _client_fixture  # noqa: F401 - pytest fixture reuse
from tests.test_discovery import client  # noqa: F401

URL = "/api/hosts/dev-east/discovery/data-preview"
FACT = {"alias": "t0", "schema": "public", "table": "factinternetsales"}
CUSTOMER = {"alias": "t1", "schema": "public", "table": "dimcustomer", "parent": "t0",
            "on": [["customerkey", "customerkey"]]}
GEO = {"alias": "t2", "schema": "public", "table": "dimgeography", "parent": "t1",
       "on": [["geographykey", "geographykey"]]}


def body(mode, tables, columns):
    return {"source": "PostgresDB::tutorial", "mode": mode, "tables": tables, "columns": columns}


def test_rows_through_a_snowflake_join(client):  # noqa: F811
    cols = [{"alias": "t2", "column": "city"}, {"alias": "t1", "column": "lastname"},
            {"alias": "t0", "column": "salesamount", "agg": "SUM"}]
    r = client.post(URL, json=body("rows", [FACT, CUSTOMER, GEO], cols)).get_json()
    assert len(r["rows"]) == 10 and all(len(row) == 3 for row in r["rows"])
    assert 'LEFT JOIN "public"."dimgeography" t2 ON t1."geographykey" = t2."geographykey"' in r["sql"]
    assert "SUM(" not in r["sql"]  # rows mode ignores agg


def test_aggregate_groups_by_attributes(client):  # noqa: F811
    cols = [{"alias": "t2", "column": "countryregioncode"}, {"alias": "t0", "column": "salesamount", "agg": "SUM"},
            {"alias": "t0", "column": "salesordernumber", "agg": "COUNT DISTINCT"}]
    r = client.post(URL, json=body("aggregate", [FACT, CUSTOMER, GEO], cols)).get_json()
    assert 'GROUP BY t2."countryregioncode"' in r["sql"]
    assert {row[0] for row in r["rows"]} <= {"US", "FR", "AU", "CA", None}


def test_check_finds_fan_out_and_orphans(client):  # noqa: F811
    ok = client.post(URL, json=body("check", [FACT, CUSTOMER], [])).get_json()
    assert ok["rootRows"] == ok["joinedRows"] == 600 and not ok["fanOut"]
    assert ok["joins"][0]["matched"] == 600
    # productkey -> productsubcategorykey is not unique on the dimension side (test_discovery).
    bad = {"alias": "t1", "schema": "public", "table": "dimproduct", "parent": "t0",
           "on": [["productkey", "productsubcategorykey"]]}
    r = client.post(URL, json=body("check", [FACT, bad], [])).get_json()
    assert r["fanOut"] is True or r["joins"][0]["matched"] < r["rootRows"]


@pytest.mark.parametrize("tables,columns,msg", [
    ([], [], "Pick at least one"),
    ([FACT, {**GEO, "parent": "t9"}], [{"alias": "t0", "column": "x"}], "isn't listed before"),
    ([{**FACT, "alias": "x; DROP"}], [{"alias": "t0", "column": "x"}], "Bad table alias"),
    ([FACT], [{"alias": "t0", "column": "salesamount", "agg": "MEDIAN"}], "Unknown aggregation"),
])
def test_bad_requests(client, tables, columns, msg):  # noqa: F811
    r = client.post(URL, json=body("aggregate", tables, columns))
    assert r.status_code == 400 and msg in r.get_json()["error"]


def test_identifiers_are_quoted():
    sql = data_preview.build_sql([{"alias": "t0", "schema": "s", "table": 'we"ird'}],
                                 [{"alias": "t0", "column": 'a"b'}], "rows", "db", "snowflake")
    assert sql == 'SELECT t0."a""b" AS c0 FROM "db"."s"."we""ird" t0'
