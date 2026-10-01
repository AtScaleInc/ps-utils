"""Build's read-only guard: SML Build can't write back (smlgen/support.py)."""

import copy

import yaml

from routes import build
from smlgen.build import build_sml
from smlgen.parse import parse_sml
from smlgen.support import BUILT_BY_MARKER, built_here, unsupported_features
from tests.test_api_fake import client as _client_fixture  # noqa: F401 - pytest fixture reuse
from tests.test_build_api import client, payload  # noqa: F401
from tests.test_smlgen import PAYLOAD


def _edit(files, path, fn):
    doc = yaml.safe_load(files[path])
    fn(doc)
    return {**files, path: yaml.safe_dump(doc, sort_keys=False)}


def _features(files):
    return {f["feature"] for f in unsupported_features(files, "postgresql")}


def test_generated_sml_round_trips_and_is_tagged():
    files = build_sml(PAYLOAD)
    assert all(body.startswith(BUILT_BY_MARKER) for body in files.values())
    result = parse_sml(files)
    assert result["builtHere"] is True
    assert result["unsupported"] == []
    # A repo rewritten elsewhere (Design Center drops comments) reads as foreign.
    assert not built_here({p: b.replace(BUILT_BY_MARKER, "") for p, b in files.items()})


def test_complex_features_are_flagged():
    files = build_sml(PAYLOAD)
    metric = next(p for p in files if p.startswith("metrics/"))
    dim = "dimensions/Product.yml"
    model = next(p for p in files if p.startswith("models/"))
    files = _edit(files, metric, lambda d: d.update(semi_additive={"position": "last", "relationships": []}))
    files = _edit(files, dim, lambda d: d["level_attributes"][0].update(key_columns=["a", "b"]))
    files = _edit(files, model, lambda d: d.update(perspectives=[{"unique_name": "p"}]))
    files["security/rls.yml"] = yaml.safe_dump({"unique_name": "rls", "object_type": "row_security"})
    files["composite.yml"] = yaml.safe_dump({"unique_name": "c", "object_type": "composite_model", "models": []})
    files["models/second.yml"] = yaml.safe_dump({"unique_name": "second", "object_type": "model"})
    assert {"Semi-additive metric", "Composite key", "Perspectives", "Row security", "Composite model",
            "More than one model"} <= _features(files)
    assert parse_sml(files)["unsupported"]


def test_save_and_deploy_refuse_a_read_only_working_copy(client, tmp_path):  # noqa: F811
    root = tmp_path / "models" / build.slugify_model_name(PAYLOAD["modelName"])
    root.mkdir(parents=True)
    for path, body in build_sml(PAYLOAD).items():
        (root / path).parent.mkdir(parents=True, exist_ok=True)
        (root / path).write_text(body)
    (root / "security.yml").write_text(yaml.safe_dump({"unique_name": "rls", "object_type": "row_security"}))
    files = [{"name": "catalog.yml", "body": "x"}]

    r = client.post("/api/sml/save", json={"modelName": PAYLOAD["modelName"], "files": files})
    assert r.status_code == 409 and r.get_json()["readOnly"] is True
    r = client.post("/api/build/deploy", json={**payload(), "hostIds": ["dev-east"]})
    assert r.status_code == 409
    assert (root / "catalog.yml").read_text().startswith(BUILT_BY_MARKER)  # untouched

    # A working copy Build wrote itself saves as before.
    (root / "security.yml").unlink()
    r = client.post("/api/sml/save", json={"modelName": PAYLOAD["modelName"], "files": files})
    assert r.status_code == 200
