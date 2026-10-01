"""Resolves host ids to backends, and the shared Git token."""

from __future__ import annotations

import os
from pathlib import Path
from typing import Any

import cache
from atscale.backend import RealBackend
from atscale.cached import CachedBackend
from atscale.client import AtScaleClient, AtScaleEnvironment

from .store import DEFAULT_PATH, Store, profile_to_connection

FAKE = os.environ.get("ENV_MANAGER_FAKE") == "1"


class HostNotFound(KeyError):
    pass


_store: Store | None = None


def store() -> Store:
    global _store
    if _store is None:
        path = Path(os.environ.get("ENV_MANAGER_CONNECTIONS_FILE", DEFAULT_PATH))
        if FAKE and "ENV_MANAGER_CONNECTIONS_FILE" not in os.environ:
            path = path.with_name("connections.fake.yaml")
        _store = Store(path)
        if FAKE and not _store.list_hosts_raw():
            seed_fake(_store)
    return _store


def set_store(s: Store) -> None:
    global _store
    _store = s
    _clients.clear()
    cache.clear()


def seed_fake(s: Store) -> None:
    from atscale import fake

    fake.reset()
    for h in fake.SEED_HOSTS:
        # add_host derives ids from labels, which match the fake inventory keys.
        s.add_host(h)
        if h["id"] != "dev-sandbox":
            s.update_host(h["id"], {"status": "connected", "lastChecked": "2026-09-26T09:12:00Z"})
    s.update_git({"username": "demo-user", "email": "demo@example.com", "token": "ghp_demo"})
    s.update_git({"status": "connected"})


def host(host_id: str) -> dict[str, Any]:
    raw = store().get_host_raw(host_id)
    if raw is None:
        raise HostNotFound(host_id)
    return raw


_clients: dict[str, tuple[tuple, AtScaleClient]] = {}


def _client(raw: dict[str, Any]) -> AtScaleClient:
    """One AtScaleClient per host, reused across requests so its JWT (and the
    token exchange behind it) is kept instead of re-authenticating per call.
    Rebuilt when the host's connection settings change."""
    conn = profile_to_connection(raw)["atscale"]
    fp = tuple(sorted(conn.items()))
    hit = _clients.get(raw["id"])
    if hit and hit[0] == fp:
        return hit[1]
    client = AtScaleClient(AtScaleEnvironment(
        base_url=conn["url"], username=conn["username"], password=conn["password"],
        api_token=conn["apiToken"], insecure=conn["insecure"],
    ))
    _clients[raw["id"]] = (fp, client)
    return client


def backend(host_id: str, refresh: bool = False) -> CachedBackend:
    raw = host(host_id)
    if FAKE:
        from atscale.fake import FakeBackend

        return CachedBackend(FakeBackend(raw, store()), host_id, refresh)
    if not profile_to_connection(raw)["atscale"]["url"]:
        raise ValueError("Host has no hostname set")
    return CachedBackend(RealBackend(raw, store(), store().get_git_raw(), api=_client(raw)), host_id, refresh)


def source_api(host_id: str) -> Any:
    """What Build calls for warehouse metadata and cube preview: the host's
    AtScaleClient (same session as its backend), or the demo stand-in."""
    raw = host(host_id)
    if FAKE:
        from atscale.fake import FakeSourceApi

        return FakeSourceApi(host_id)
    if not profile_to_connection(raw)["atscale"]["url"]:
        raise ValueError("Host has no hostname set")
    return _client(raw)


def git_profile() -> dict[str, Any]:
    return store().get_git_raw()


def forget_host(host_id: str) -> None:
    """Host edited / removed / re-tested: drop its session and cached lists."""
    _clients.pop(host_id, None)
    cache.invalidate("host", host_id)


def git_token() -> str | None:
    return store().get_git_raw().get("token") or None


def git_ready() -> bool:
    g = store().get_git_raw()
    return bool(g.get("token")) and g.get("status") != "failed"


def capture_host(host_id: str) -> None:
    """Load and store (working folder) everything host-specific: deployed
    models with their catalog/model ids, the id <-> name map per catalog, and
    aggregates with their instance ids."""
    b = backend(host_id, refresh=True)
    b.list_models()
    for m in b.agg_models():
        b.catalog_ids(m["catalogId"])
        b.list_aggregates(m["catalogId"], m["modelId"])


def warm_cache(log=print) -> None:
    """Refresh-on-start: load every host's models and aggregates into the cache
    so the first switch in the UI is instant. Hosts whose last test failed are
    skipped - they'd only stall startup."""
    for raw in store().list_hosts_raw():
        if raw.get("status") == "failed" or not raw.get("atscale", {}).get("url"):
            continue
        try:
            capture_host(raw["id"])
            log(f"cache warmed: {raw['id']}", flush=True)
        except Exception as e:  # noqa: BLE001 - a dead host must not block startup
            log(f"cache warm failed for {raw['id']}: {e}", flush=True)
