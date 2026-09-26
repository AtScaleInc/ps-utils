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
                          "username": "svc", "password": "p@ss", "apiToken": "tok"})
    pub = public_host(store.get_host_raw(raw["id"]))
    assert pub == {
        "id": "dev-east", "env": "dev", "label": "dev-east", "hostname": "h.local", "username": "svc",
        "hasPassword": True, "hasToken": True, "insecure": True, "status": "untested", "lastChecked": None,
    }
    assert "p@ss" not in str(pub) and "tok" not in str(pub)
    on_disk = yaml.safe_load(store.path.read_text())
    assert on_disk["connections"]["dev-east"]["atscale"]["url"] == "https://h.local"


def test_edit_resets_status_but_label_does_not(store):
    store.add_host({"env": "qa", "label": "qa", "hostname": "q.local", "username": "u", "password": "p"})
    store.update_host("qa", {"status": "connected", "lastChecked": "t"})
    assert store.update_host("qa", {"label": "qa-main"})["status"] == "connected"
    assert store.update_host("qa", {"password": None})["status"] == "connected"
    assert store.update_host("qa", {"password": "new"})["status"] == "untested"


def test_env_reassign_and_validation(store):
    store.add_host({"env": "dev", "label": "h"})
    assert store.update_host("h", {"env": "prod"})["env"] == "prod"
    with pytest.raises(ValueError):
        store.update_host("h", {"env": "staging"})


def test_git_profile_masked(store):
    store.update_git({"username": "me", "email": "me@x.com", "token": "ghp_secret"})
    pub = public_git(store.get_git_raw())
    assert pub["hasToken"] and "ghp_secret" not in str(pub)
    store.update_git({"status": "connected"})
    assert store.update_git({"token": "ghp_other"})["status"] == "untested"


def test_git_key_not_listed_as_host(store):
    store.update_git({"token": "t"})
    store.add_host({"env": "dev", "label": "git"})
    ids = [h["id"] for h in store.list_hosts_raw()]
    assert ids == ["host-git"]


def test_profile_to_connection(store):
    raw = store.add_host({"env": "dev", "label": "d", "hostname": "d.local", "username": "u", "password": "p"})
    assert profile_to_connection(raw) == {"atscale": {
        "url": "https://d.local", "username": "u", "password": "p", "apiToken": None, "insecure": True,
    }}
