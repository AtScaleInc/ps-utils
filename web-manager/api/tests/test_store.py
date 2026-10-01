import pytest
import yaml

from envs.store import Store, normalize_hostname, profile_to_connection, public_git, public_host


@pytest.mark.parametrize("raw,expected", [
    ("atscale.corp.local", "atscale.corp.local"),
    ("https://atscale.corp.local", "atscale.corp.local"),
    ("https://atscale.corp.local:10500/", "atscale.corp.local"),
    ("http://ATSCALE.corp.local/engine/xmla", "atscale.corp.local"),
    ("  atscale.corp.local:443  ", "atscale.corp.local"),
    ("", ""),
])
def test_normalize_hostname(raw, expected):
    assert normalize_hostname(raw) == expected


@pytest.fixture
def store(tmp_path):
    return Store(tmp_path / "connections.yaml")


def test_round_trip_masks_secrets(store):
    raw = store.add_host({"env": "dev", "label": "dev-east", "hostname": "https://h.local:443",
                          "username": "svc", "password": "p@ss", "apiToken": "tok"}, "default")
    pub = public_host(store.get_host_raw(raw["id"]))
    assert pub == {
        "id": "dev-east", "bu": "default", "env": "dev", "label": "dev-east", "hostname": "h.local", "username": "svc",
        "hasPassword": True, "hasToken": True, "insecure": True, "status": "untested", "lastChecked": None,
    }
    assert "p@ss" not in str(pub) and "tok" not in str(pub)
    on_disk = yaml.safe_load(store.path.read_text())
    assert on_disk["connections"]["dev-east"]["atscale"]["url"] == "https://h.local"


def test_edit_resets_status_but_label_does_not(store):
    store.add_host({"env": "qa", "label": "qa", "hostname": "q.local", "username": "u", "password": "p"}, "default")
    store.update_host("qa", {"status": "connected", "lastChecked": "t"})
    assert store.update_host("qa", {"label": "qa-main"})["status"] == "connected"
    assert store.update_host("qa", {"password": None})["status"] == "connected"
    assert store.update_host("qa", {"password": "new"})["status"] == "untested"


def test_env_reassign_and_validation(store):
    store.add_host({"env": "dev", "label": "h"}, "default")
    assert store.update_host("h", {"env": "prod"})["env"] == "prod"
    with pytest.raises(ValueError):
        store.update_host("h", {"env": "staging"})


def test_git_profile_masked(store):
    store.update_git("default", {"username": "me", "email": "me@x.com", "token": "ghp_secret"})
    pub = public_git(store.get_git_raw("default"))
    assert pub["hasToken"] and "ghp_secret" not in str(pub)
    store.update_git("default", {"status": "connected"})
    assert store.update_git("default", {"token": "ghp_other"})["status"] == "untested"


def test_git_key_not_listed_as_host(store):
    store.update_git("default", {"token": "t"})
    store.add_host({"env": "dev", "label": "git"}, "default")
    ids = [h["id"] for h in store.list_hosts_raw()]
    assert ids == ["host-git"]


def test_profile_to_connection(store):
    raw = store.add_host({"env": "dev", "label": "d", "hostname": "d.local", "username": "u", "password": "p"}, "default")
    assert profile_to_connection(raw) == {"atscale": {
        "url": "https://d.local", "username": "u", "password": "p", "apiToken": None, "insecure": True,
    }}


def test_pre_bu_file_migrates_to_default(tmp_path):
    path = tmp_path / "connections.yaml"
    path.write_text(yaml.safe_dump({"connections": {
        "old-qa": {"env": "qa", "label": "old-qa", "atscale": {"url": "https://q.local"}},
        "git": {"git": {"username": "me", "token": "ghp_old"}},
    }}))
    s = Store(path)
    assert [b["id"] for b in s.list_bus()] == ["default"]
    assert s.get_git_raw("default")["token"] == "ghp_old"
    assert s.get_host_raw("old-qa")["bu"] == "default" and s.get_host_raw("old-qa")["env"] == "qa"
    s.add_bu("Finance")  # any write saves the new shape
    on_disk = yaml.safe_load(path.read_text())
    assert list(on_disk) == ["businessUnits", "connections"]
    assert "git" not in on_disk["connections"] and on_disk["connections"]["old-qa"]["bu"] == "default"


def test_business_units_isolate_hosts_and_git(store):
    fin = store.add_bu("Finance")["id"]
    store.add_host({"env": "test", "label": "a"}, "default")
    store.add_host({"env": "prod", "label": "b"}, fin)
    assert [h["id"] for h in store.list_hosts_raw("default")] == ["a"]
    assert [h["id"] for h in store.list_hosts_raw(fin)] == ["b"]
    store.update_git(fin, {"token": "ghp_fin"})
    assert store.get_git_raw(fin)["token"] == "ghp_fin" and not store.get_git_raw("default").get("token")
    with pytest.raises(KeyError):
        store.add_host({"env": "dev", "label": "c"}, "nope")


def test_business_unit_names_and_delete_rules(store):
    fin = store.add_bu("Finance")["id"]
    with pytest.raises(ValueError):
        store.add_bu("finance")  # names are unique, ignoring case
    store.update_bu(fin, {"label": "Finance & Ops"})
    assert store.get_bu(fin)["label"] == "Finance & Ops"
    store.add_host({"env": "dev", "label": "f"}, fin)
    with pytest.raises(ValueError):
        store.delete_bu(fin)  # still has a host
    store.delete_host("f")
    store.delete_bu(fin)
    with pytest.raises(ValueError):
        store.delete_bu("default")  # the last one stays
