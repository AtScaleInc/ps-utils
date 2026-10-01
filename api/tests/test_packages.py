"""Shared dimensions: publishing a dimensions-only package repo, and a model
that uses its dimensions through package.yml (smlgen/packages.py)."""

from __future__ import annotations

import copy

import pytest
import yaml

from routes import build
from smlgen.build import ValidationError, build_sml
from smlgen.packages import SHARED_MARKER, is_shared_repo, package_name, read_packages
from smlgen.parse import parse_sml
from smlgen.support import unsupported_features
from tests.test_api_fake import client as _client_fixture, wait  # noqa: F401 - pytest fixture reuse
from tests.test_smlgen import PAYLOAD

SHA = "037fe48ad071c34f455f1be54dbf03ffcf14de1d"
REF = {"name": "shared", "url": "https://github.com/corp/shared-dims", "branch": "main", "version": f"commit:{SHA}"}


def shared_payload():
    """The fixture's Product / Product Category / Date dimensions, no fact."""
    p = copy.deepcopy(PAYLOAD)
    p.update(modelName="shared_dims", shared=True)
    p["nodes"] = [n for n in p["nodes"] if n["role"] == "dimension"]
    p["joins"] = [j for j in p["joins"] if j["id"] == "j0"]
    p["cfg"] = {k: v for k, v in p["cfg"].items() if not k.startswith("n3::")}
    return p


def package_canvas():
    """What the Build picker puts on the canvas: the shared repo parsed as a package."""
    files = build_sml(shared_payload())
    return parse_sml({}, [{"ref": REF, "files": files}], all_package_dims=True)


def model_payload():
    """A fact joined to the shared Product and (role-played) Date dimensions."""
    pkg = package_canvas()
    fact = copy.deepcopy(next(n for n in PAYLOAD["nodes"] if n["role"] == "fact"))
    fact["id"] = "f0"
    ids = {n["dimName"]: n["id"] for n in pkg["nodes"]}
    p = copy.deepcopy(PAYLOAD)
    p["nodes"] = pkg["nodes"] + [fact]
    p["joins"] = pkg["joins"] + [
        {"id": "x1", "a": {"node": "f0", "column": "productkey"}, "b": {"node": ids["Product"], "column": "productkey"}},
        {"id": "x2", "a": {"node": "f0", "column": "orderdatekey"}, "b": {"node": ids["Date"], "column": "datekey"},
         "rolePlay": "Order"},
    ]
    p["cfg"] = {**pkg["cfg"], **{k.replace("n3::", "f0::"): v for k, v in PAYLOAD["cfg"].items() if k.startswith("n3::")}}
    return p


def test_disconnected_dimensions_publish_as_shared():
    p = shared_payload()
    with pytest.raises(ValidationError) as e:
        build_sml({**p, "shared": False})
    assert any("not connected to any fact" in m for m in e.value.errors)
    files = build_sml(p)
    assert not any(n.startswith(("models/", "metrics/")) for n in files)
    assert files["catalog.yml"].splitlines()[1] == SHARED_MARKER
    assert {"dimensions/Product.yml", "dimensions/Date.yml", "datasets/dimproduct.yml"} <= set(files)
    assert is_shared_repo(files) and not unsupported_features(files, "postgresql")
    assert parse_sml(files)["shared"] is True


def test_shared_refuses_facts():
    with pytest.raises(ValidationError) as e:
        build_sml({**copy.deepcopy(PAYLOAD), "shared": True})
    assert any("dimensions only" in m for m in e.value.errors)


def test_model_uses_package_dimensions():
    files = build_sml(model_payload())
    assert yaml.safe_load(files["package.yml"]) == {"version": 1, "packages": [REF]}
    # The shared dimensions' files come from the package, not this repo.
    assert not any(n.startswith("dimensions/") for n in files)
    assert set(n for n in files if n.startswith("datasets/")) == {"datasets/factinternetsales.yml"}
    model = yaml.safe_load(files["models/sample-dev-test.yml"])
    rels = {r["to"]["dimension"]: r for r in model["relationships"]}
    assert rels["Product"]["to"]["level"] == "productkey"
    assert rels["Date"]["to"]["level"] == "month" and rels["Date"]["role_play"] == "Order {0}"
    assert not unsupported_features(files, "postgresql")


def test_package_level_names_are_not_recased():
    p = model_payload()
    date = next(n for n in p["nodes"] if n["dimName"] == "Date")
    p["cfg"][f"{date['id']}::month"]["query"] = "Month Level"
    model = yaml.safe_load(build_sml(p)["models/sample-dev-test.yml"])
    assert {r["to"]["level"] for r in model["relationships"] if r["to"]["dimension"] == "Date"} == {"Month Level"}


def test_join_to_a_package_dimension_must_hit_a_level_key():
    p = model_payload()
    product = next(n for n in p["nodes"] if n["dimName"] == "Product")
    p["joins"][-2]["b"]["column"] = "productsubcategorykey"
    with pytest.raises(ValidationError) as e:
        build_sml(p)
    assert any("isn't a level key" in m and "productkey" in m for m in e.value.errors), product


def test_round_trip_resolves_package_dimensions():
    pkg_files = build_sml(shared_payload())
    files = build_sml(model_payload())
    assert read_packages(files) == [REF]
    without = parse_sml(files)
    assert not any(n["role"] == "dimension" for n in without["nodes"])
    loaded = parse_sml(files, [{"ref": REF, "files": pkg_files}])
    dims = {n["dimName"]: n for n in loaded["nodes"] if n["role"] == "dimension"}
    assert set(dims) == {"Product", "Date"}                      # only what the model references
    assert all(n["package"] == REF for n in dims.values())
    again = build_sml({**model_payload(), "nodes": loaded["nodes"], "joins": loaded["joins"], "cfg": loaded["cfg"]})
    assert yaml.safe_load(again["models/sample-dev-test.yml"]) == yaml.safe_load(files["models/sample-dev-test.yml"])


def test_package_names():
    assert package_name("https://github.com/a/x") == "shared"
    assert package_name("https://github.com/a/dims-2024.git", {"shared"}) == "dims"
    assert package_name("https://github.com/a/dims", {"shared", "dims"}) == "dims_a"


@pytest.fixture
def client(_client_fixture, tmp_path, monkeypatch):  # noqa: F811
    monkeypatch.setattr(build, "MODELS_ROOT", tmp_path / "models")
    return _client_fixture


def test_publish_shared_attaches_without_deploying(client):
    p = {**shared_payload(), "asConnection": "PostgresDB", "hostIds": ["dev-east", "prod-west"]}
    job = wait(client, client.post("/api/build/deploy", json=p).get_json())
    assert job["status"] == "done", job
    res = job["result"]
    assert res["shared"] and all(r["ok"] and r["attached"] for r in res["results"])
    assert "shared_dims" not in {m["name"] for m in client.get("/api/hosts/dev-east/models").get_json()["models"]}
    repos = client.get("/api/build/shared-repos").get_json()["repos"]
    assert res["git"]["repoUrl"] in {r["url"] for r in repos}

    loaded = client.post("/api/build/shared/load", json={"repoUrl": res["git"]["repoUrl"], "taken": ["shared"]}).get_json()
    assert loaded["package"]["version"] == f"commit:{res['git']['commit']}" and loaded["package"]["name"] == "shared_dims"
    assert {n["dimName"] for n in loaded["nodes"]} == {"Product", "Product Category", "Date"}
    assert all(n["package"] == loaded["package"] for n in loaded["nodes"])


def test_demo_shared_repo_loads(client):
    repos = client.get("/api/build/shared-repos").get_json()["repos"]
    url = next(r["url"] for r in repos if r["name"] == "atscale-shared-dimensions")
    loaded = client.post("/api/build/shared/load", json={"repoUrl": url}).get_json()
    assert loaded["package"]["name"] == "shared"
    assert {"Date Dimension", "Customer Dimension", "Product Dimension"} <= {n["dimName"] for n in loaded["nodes"]}


def _has_cli() -> bool:
    from smlgen.validate import SmlCliNotFound, _sml_cli

    try:
        _sml_cli()
        return True
    except SmlCliNotFound:
        return False


@pytest.mark.skipif(not _has_cli(), reason="sml-cli not available")
def test_sml_cli_accepts_shared_repo_and_package_model():
    from smlgen.validate import validate_sml

    pkg = build_sml(shared_payload())
    assert validate_sml(pkg, shared=True)["passed"]
    result = validate_sml(build_sml(model_payload()), [{"ref": REF, "files": pkg}])
    assert result["passed"], result["output"]


def test_shared_connection_name_never_clashes_with_the_model():
    """AtScale merges package objects into the model's namespace; both name
    their connection con_<database>_<schema> from the same warehouse schema."""
    from smlgen.packages import SHARED_CONNECTION_SUFFIX, flatten_packages, package_conflicts

    pkg = build_sml(shared_payload())
    con = yaml.safe_load(next(b for n, b in pkg.items() if n.startswith("connections/")))
    assert con["unique_name"] == PAYLOAD["connectionName"] + SHARED_CONNECTION_SUFFIX
    assert {yaml.safe_load(b)["connection_id"] for n, b in pkg.items() if n.startswith("datasets/")} == {con["unique_name"]}
    assert build_sml({**shared_payload(), "connectionName": con["unique_name"]}) == pkg     # republish is stable
    assert not package_conflicts(flatten_packages(build_sml(model_payload()), [{"ref": REF, "files": pkg}]))

    # A shared repo published before the suffix: the clash AtScale reports.
    old = {n.replace(SHARED_CONNECTION_SUFFIX.replace("_", "-"), ""): b.replace(SHARED_CONNECTION_SUFFIX, "")
           for n, b in pkg.items()}
    clashes = package_conflicts(flatten_packages(build_sml(model_payload()), [{"ref": REF, "files": old}]))
    assert clashes and 'The "connection" name "con_atscale_data_SalesInsights" is not unique' in clashes[0]
