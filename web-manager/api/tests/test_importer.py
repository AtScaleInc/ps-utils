"""Build › Import & convert: AtScale XML, SSAS Multidimensional and SSAS
Tabular exports through their ps-utils operations (the npm CLI), remapped onto
a host's data source, then saved / linked / deployed."""

from pathlib import Path

import pytest
import yaml

from routes import build
from smlgen import converters
from tests.test_api_fake import client as _client_fixture, wait  # noqa: F401 - pytest fixture reuse

pytestmark = pytest.mark.skipif(not converters._LOCAL_CLI.exists(), reason="ps-utils CLI not installed (cd web && npm install)")

FIXTURES = Path(__file__).parent / "fixtures" / "imports"
XML = (FIXTURES / "retail.xml").read_text()          # 2 cubes, tables in PROD.SALES and PROD.RETURNS
SSAS = (FIXTURES / "shop.ssas.xml").read_text()      # 1 cube over dbo.SALES
TABULAR = (FIXTURES / "shop.tmsl.json").read_text()  # Sales -> Product


@pytest.fixture
def client(_client_fixture, tmp_path, monkeypatch):  # noqa: F811
    monkeypatch.setattr(build, "MODELS_ROOT", tmp_path / "models")
    monkeypatch.setattr("routes.importer.validate_sml", lambda files: {"passed": True, "returncode": 0, "output": "ok"})
    return _client_fixture


def test_read_project_per_kind_and_rejects_the_wrong_file():
    p = converters.read_project("xml", XML)
    assert p["project"] == "Retail Project" and p["datasets"] == 2
    assert [c["name"] for c in p["cubes"]] == ["Sales Cube", "Returns Cube"]
    assert converters.read_project("ssas", SSAS)["cubes"] == [{"name": "Sales", "caption": None, "visible": True}]
    assert converters.read_project("tabular", TABULAR)["project"] == "Shop"
    with pytest.raises(ValueError, match="well-formed"):
        converters.read_project("xml", "<schema")
    with pytest.raises(ValueError, match="expected <schema>"):
        converters.read_project("xml", SSAS)
    with pytest.raises(ValueError, match="no <Database>"):
        converters.read_project("ssas", XML)
    with pytest.raises(ValueError, match="TMSL"):
        converters.read_project("tabular", XML)
    with pytest.raises(ValueError, match="kind"):
        converters.read_project("ddl", XML)


def test_tabular_warehouse_from_dialect():
    assert converters.tabular_warehouse("postgresql") == "Postgres"
    assert converters.tabular_warehouse("DatabricksSQL") == "Databricks"
    assert converters.tabular_warehouse("oracle") is None


def test_inspect_lists_what_the_cli_emits(client):
    body = client.post("/api/build/import/inspect", json={"kind": "xml", "text": XML, "fileName": "retail.xml"}).get_json()
    assert body["project"] == "Retail Project" and body["kind"] == "xml"
    # One connection per database/schema pair (xml-converter.ts Phase 6).
    conns = {c["name"]: c for c in body["connections"]}
    assert set(conns) == {"SNOW", "SNOW_RETURNS"}
    assert (conns["SNOW"]["database"], conns["SNOW"]["schema"], conns["SNOW"]["datasets"]) == ("PROD", "SALES", 1)
    assert sorted(m["name"] for m in body["models"]) == ["Returns Cube", "Sales Cube"]


def test_inspect_errors(client):
    assert client.post("/api/build/import/inspect", json={"kind": "xml"}).status_code == 400
    assert client.post("/api/build/import/inspect", json={"kind": "ddl", "text": XML}).status_code == 400
    bad = client.post("/api/build/import/inspect", json={"kind": "xml", "text": "<nope/>"})
    assert bad.status_code == 400 and "<schema>" in bad.get_json()["error"]


def convert_body(**extra):
    body = {"kind": "xml", "text": XML, "fileName": "retail.xml", "repoName": "retail-sml", "catalogName": "Retail",
            "models": {"Sales Cube": "sales", "Returns Cube": "Returns Cube"}}
    body.update(extra)
    return body


def convert_then_connect(client, connections, **extra):
    """Convert, then point the converted connections at the demo host's PostgresDB."""
    r = client.post("/api/build/import/convert", json=convert_body(**extra))
    assert r.status_code == 200, r.get_json()
    converted = r.get_json()
    c = client.post("/api/build/import/connect", json={
        "repoName": "retail-sml", "files": converted["files"], "asConnection": "PostgresDB", "connections": connections})
    assert c.status_code == 200, c.get_json()
    return converted, c.get_json()


def files_of(body):
    return {f["name"]: f["body"] for f in body["files"]}


def test_convert_renames_models_then_connect_remaps_connections(client):
    converted, connected = convert_then_connect(client, {"SNOW": {"database": "tutorial", "schema": "public"},
                                                         "SNOW_RETURNS": {"database": "tutorial", "schema": ""}})
    raw = files_of(converted)
    assert yaml.safe_load(raw["connections/snow.yml"])["as_connection"] == "SNOW"  # untouched until connect
    assert yaml.safe_load(raw["models/sales.yml"])["unique_name"] == "sales" and "models/sales-cube.yml" not in raw
    assert yaml.safe_load(raw["catalog.yml"])["label"] == "Retail"
    assert converted["report"].startswith("# ") and converted["counts"]["models"] == 2
    assert {c["name"] for c in converted["connections"]} == {"SNOW", "SNOW_RETURNS"}
    files = files_of(connected)
    snow = yaml.safe_load(files["connections/snow.yml"])
    assert (snow["as_connection"], snow["database"], snow["schema"]) == ("PostgresDB", "tutorial", "public")
    returns = yaml.safe_load(files["connections/snow_returns.yml"])
    assert returns["as_connection"] == "PostgresDB" and "schema" not in returns  # blank drops the key
    assert connected["validation"]["passed"] and connected["workspaceExists"] is False


def test_convert_ssas(client):
    converted, connected = convert_then_connect(client, {"ssas-connection": {"database": "tutorial", "schema": "public"}},
                                                kind="ssas", text=SSAS, fileName="shop.xml", models={"Sales": "shop_sales"})
    assert yaml.safe_load(files_of(converted)["models/shop_sales.yml"])["unique_name"] == "shop_sales"
    c = yaml.safe_load(files_of(connected)["connections/ssas-connection.yml"])
    assert (c["as_connection"], c["database"], c["schema"]) == ("PostgresDB", "tutorial", "public")


def test_convert_tabular_needs_a_warehouse(client):
    info = client.post("/api/build/import/inspect", json={"kind": "tabular", "text": TABULAR}).get_json()
    assert info["warehouses"] == ["Snowflake", "Databricks", "BigQuery", "Postgres"]
    assert info["warehouse"] is None  # a SQL Server (MSOLEDBSQL) source names no supported warehouse
    snow = TABULAR.replace("Provider=MSOLEDBSQL;Initial Catalog=SHOPDB", "Driver=SnowflakeDSIIDriver;Database=SHOPDB")
    assert converters.read_project("tabular", snow)["warehouse"] == "Snowflake"
    (model,) = info["models"]
    assert model["name"] == "shop"  # tabular_model_name("Shop")
    body = dict(kind="tabular", text=TABULAR, fileName="shop.json", models={"shop": "shop_model"})
    assert client.post("/api/build/import/convert", json=convert_body(**body)).status_code == 400  # no warehouse
    converted, connected = convert_then_connect(client, {}, warehouse="Postgres", **body)
    assert yaml.safe_load(files_of(converted)["models/shop_model.yml"])["unique_name"] == "shop_model"
    assert converted["report"]  # CONVERSION_REPORT.md
    conn = converted["connections"][0]["name"]
    _, connected = convert_then_connect(client, {conn: {"database": "tutorial", "schema": "public"}}, warehouse="Postgres", **body)
    remapped = next(yaml.safe_load(b) for n, b in files_of(connected).items() if n.startswith("connections/"))
    assert (remapped["as_connection"], remapped["database"], remapped["schema"]) == ("PostgresDB", "tutorial", "public")


def test_convert_and_connect_failures(client):
    assert client.post("/api/build/import/convert", json=convert_body(repoName="bad name")).status_code == 400
    dup = convert_body(models={"Sales Cube": "x", "Returns Cube": "x"})
    assert client.post("/api/build/import/convert", json=dup).status_code == 400
    assert client.post("/api/build/import/convert", json=convert_body(modelMode="bogus")).status_code == 400
    files = [{"name": "catalog.yml", "body": "unique_name: a\n"}]
    assert client.post("/api/build/import/connect", json={"repoName": "r", "files": files}).status_code == 400  # no source
    assert client.post("/api/build/import/connect", json={"repoName": "r", "asConnection": "X"}).status_code == 400


def test_save_replaces_the_working_copy_and_locks_it(client):
    files = [{"name": "catalog.yml", "body": "unique_name: a\n"}]
    assert client.post("/api/build/import/save", json={"repoName": "retail-sml", "files": files}).status_code == 200
    root = build.models_root() / "retail-sml"
    (root / "stale.yml").write_text("x: 1\n")
    again = client.post("/api/build/import/save", json={"repoName": "retail-sml", "files": files})
    assert again.status_code == 409 and again.get_json()["exists"]
    ok = client.post("/api/build/import/save", json={"repoName": "retail-sml", "files": files, "replace": True})
    assert ok.status_code == 200 and not (root / "stale.yml").exists()
    # Read-only for Build: its canvas Save can't overwrite the converted copy, and Load says so.
    blocked = client.post("/api/sml/save", json={"modelName": "retail-sml", "files": files})
    assert blocked.status_code == 409 and blocked.get_json()["readOnly"]
    assert client.post("/api/sml/import-path", json={"path": str(root)}).get_json()["imported"] is True


@pytest.mark.parametrize("action", ["deploy", "link"])
def test_publish_pushes_once_then_links_or_deploys(client, action):
    files = [{"name": "catalog.yml", "body": "unique_name: a\n"}]
    r = client.post("/api/build/import/publish", json={
        "repoName": f"retail-{action}", "files": files, "models": ["sales", "Returns Cube"], "catalogName": "Retail",
        "asConnection": "PostgresDB", "hostIds": ["dev-east", "prod-west"], "action": action,
    })
    assert r.status_code == 202, r.get_json()
    result = wait(client, r.get_json())["result"]
    by_host = {row["hostId"]: row for row in result["results"]}
    assert by_host["dev-east"]["ok"], by_host["dev-east"]
    assert not by_host["prod-west"]["ok"] and "PostgresDB" in by_host["prod-west"]["error"]
    models = {m["name"]: m for m in client.get("/api/hosts/dev-east/models?refresh=1").get_json()["models"]}
    assert {"sales", "Returns Cube"} <= set(models)
    assert models["sales"]["status"] == ("Deployed" if action == "deploy" else "Linked")


def test_converter_prefers_this_branchs_build(monkeypatch, tmp_path):
    bundle = tmp_path / "cli" / "cli.cjs"
    bundle.parent.mkdir()
    bundle.write_text("// bundle")
    (bundle.parent / "BUNDLE.json").write_text('{"version": "9.9.9"}')
    monkeypatch.setattr(converters, "_REPO_BUNDLE", bundle)
    info = converters.cli_info()
    assert (info["source"], info["version"], info["path"]) == ("repo", "9.9.9", str(bundle)) and info["builtAt"]
    assert converters._cli()[-1] == str(bundle)
    monkeypatch.setenv("ENV_MANAGER_PS_UTILS", "npm")  # forced back to the published package
    assert converters.cli_info()["source"] == "npm" and converters._cli() == [str(converters._LOCAL_CLI)]
    monkeypatch.delenv("ENV_MANAGER_PS_UTILS")
    monkeypatch.setattr(converters, "_REPO_BUNDLE", tmp_path / "missing.cjs")  # no build -> npm
    assert converters.cli_info()["source"] == "npm"


def test_convert_reports_the_converter(client):
    r = client.post("/api/build/import/convert", json=convert_body())
    assert r.get_json()["converter"]["source"] in ("repo", "npm")


# -- Database DDL --------------------------------------------------------------

from smlgen.ddl import atscale_type, parse_ddl  # noqa: E402


def _ddl() -> str:
    return (FIXTURES / "shop.ddl.sql").read_text()


def test_parse_ddl_tables_columns_and_keys():
    parsed = parse_ddl(_ddl())
    by = {t["name"]: t for t in parsed["tables"]}
    assert set(by) == {"dim_date", "dim_product", "dim_customer", "fact_sales", "v_sales"}
    assert parsed["schemas"] == ["sales"]
    assert by["v_sales"]["kind"] == "view" and by["v_sales"]["columns"] == []
    cols = {c["name"]: c for c in by["fact_sales"]["columns"]}
    assert list(cols) == ["sale_id", "date_key", "product_key", "cust_key", "quantity", "sales_amount", "discount", "updated_at"]
    assert cols["date_key"]["type"] == "Long" and cols["date_key"]["ddlType"] == "NUMBER(38,0)"
    assert cols["sales_amount"]["type"] == "Decimal"
    assert cols["discount"]["type"] == "Double"
    assert cols["updated_at"]["type"] == "DateTime"
    assert {(f["column"], f["toTable"], f["toColumn"]) for f in by["fact_sales"]["foreignKeys"]} == {
        ("date_key", "dim_date", "date_key"),
        ("product_key", "dim_product", "product_key"),
        ("cust_key", "dim_customer", "customer_key"),
    }
    assert {c["name"] for c in by["dim_product"]["columns"] if c["primaryKey"]} == {"product_key"}
    assert {c["name"] for c in by["dim_customer"]["columns"] if c["primaryKey"]} == {"customer_key"}
    assert "customer name" in {c["name"] for c in by["dim_customer"]["columns"]}
    assert by["dim_date"]["columns"][0]["primaryKey"] is True


def test_atscale_type_mapping():
    assert atscale_type("NUMBER(9,0)") == "Int"
    assert atscale_type("NUMBER(10)") == "Long"
    assert atscale_type("NUMBER") == "Decimal"
    assert atscale_type("VARCHAR(10)") == "String"
    assert atscale_type("TIMESTAMP WITH TIME ZONE") == "DateTime"
    assert atscale_type("BOOLEAN") == "Boolean"


def test_ddl_endpoint(client):
    r = client.post("/api/build/import/ddl", json={"text": _ddl(), "fileName": "shop.ddl.sql"})
    assert r.status_code == 200, r.get_json()
    body = r.get_json()
    assert body["fileName"] == "shop.ddl.sql" and len(body["tables"]) == 5
    r = client.post("/api/build/import/ddl", json={"text": "SELECT 1;"})
    assert r.status_code == 422
    assert client.post("/api/build/import/ddl", json={}).status_code == 400
