import json

import pytest

import cache


@pytest.fixture(autouse=True)
def tmp_cache(tmp_path):
    cache.set_dir(tmp_path / "cache")
    yield tmp_path / "cache"


def test_writes_readable_json_to_working_folder(tmp_cache):
    cache.get(("host", "dev-docker", "models"), lambda: [{"name": "Sales"}])
    doc = json.loads((tmp_cache / "host" / "dev-docker" / "models.json").read_text())
    assert doc["value"] == [{"name": "Sales"}] and doc["loadedAt"] and doc["expiresAt"]


def test_restart_serves_from_disk_until_expiry(tmp_cache):
    cache.get(("host", "h", "models"), lambda: [1])
    cache._entries.clear()  # new process
    assert cache.get(("host", "h", "models"), lambda: pytest.fail("should not reload"))[0] == [1]
    assert cache.get(("host", "h", "models"), lambda: [2], refresh=True)[0] == [2]


def test_expired_entries_reload(tmp_cache):
    cache.get(("host", "h", "models"), lambda: [1], ttl=lambda _: -1)
    assert cache.get(("host", "h", "models"), lambda: [2])[0] == [2]


def test_invalidate_prefix_removes_files(tmp_cache):
    cache.get(("host", "a", "models"), lambda: [1])
    cache.get(("host", "a", "aggs", "c", "m"), lambda: [1])
    cache.get(("host", "b", "models"), lambda: [1])
    cache.invalidate("host", "a")
    assert not (tmp_cache / "host" / "a").exists()
    assert (tmp_cache / "host" / "b" / "models.json").exists()
    assert [e["key"] for e in cache.summary()] == [["host", "b", "models"]]
