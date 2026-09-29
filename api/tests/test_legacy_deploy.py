"""Deploy on AtScale builds without POST /v1/catalogs/deploy (404): fall back
to compiling the catalog XML locally and POSTing /wapi/git/deploy/catalog."""

import uuid

from atscale import backend as B
from atscale import legacy_deploy
from atscale.client import AtScaleApiError
from smlgen.build import build_sml
from smlgen.catalog_xml import build_catalog_xml
from smlgen.parse import _load_all
from tests.test_smlgen import PAYLOAD


def test_wizard_sml_compiles_to_catalog_xml():
    files = build_sml(PAYLOAD)
    p = _load_all(files)
    xml = build_catalog_xml(catalog=p["catalog"], model=p["model"], dimensions_map=p["dimensions"],
                            datasets_map=p["datasets"], metrics_map=p["metrics"], connections_map=p["connections"],
                            project_name="cat_main", project_id=str(uuid.uuid4()))
    assert xml.startswith("<schema") and 'name="cat_main"' in xml
    assert legacy_deploy.infer_con_ids(files, p["connections"]) == [PAYLOAD["asConnection"]]


class Store:
    def __init__(self):
        self.recorded = {}

    def record_deployment(self, host_id, catalog_id, info):
        self.recorded[catalog_id] = info


class Api:
    def __init__(self):
        self.legacy_body = None

    def list_repos(self):
        return [{"id": "repo-1", "url": "https://github.com/me/demo"}]

    def deploy_catalog_from_git(self, *a, **kw):
        raise AtScaleApiError(404, '{"message":"Cannot POST /v1/public/catalogs/deploy"}', "https://h/v1/catalogs/deploy")

    def list_deployed_projects(self):
        return []

    def cookie_client(self):
        return self

    def deploy_repo(self, **body):
        self.legacy_body = body
        return {}


def test_404_on_new_deploy_falls_back_to_legacy(monkeypatch):
    files = build_sml(PAYLOAD)
    monkeypatch.setattr(B.github, "head_commit", lambda token, url, branch: {"sha": "abc123", "date": "2026-09-29"})
    monkeypatch.setattr(legacy_deploy, "read_repo_sml", lambda url, branch, user, token: files)
    api, store = Api(), Store()
    b = B.RealBackend({"id": "old-host", "links": []}, store, {"username": "me", "token": "t"}, api=api)
    r = b.deploy_branch("https://github.com/me/demo", "main")
    assert r["ok"] and r["method"].startswith("legacy")
    body = api.legacy_body
    assert body["repo_id"] == "repo-1" and body["project_name"].endswith("_main") and body["project_xml"].startswith("<schema")
    assert {f["relativePath"] for f in body["sml_raw_files"]} == set(files)
    assert store.recorded[r["catalogId"]]["commit"] == "abc123"


def test_other_errors_do_not_fall_back(monkeypatch):
    monkeypatch.setattr(B.github, "head_commit", lambda token, url, branch: {"sha": "abc", "date": "d"})

    class Api500(Api):
        def deploy_catalog_from_git(self, *a, **kw):
            raise AtScaleApiError(500, "boom", "u")

    api = Api500()
    r = B.RealBackend({"id": "h", "links": []}, Store(), {"token": "t"}, api=api).deploy_branch("https://github.com/me/demo", "main")
    assert not r["ok"] and r["error"].startswith("500") and api.legacy_body is None
