"""Resolves host ids to backends, and the business unit's Git token.

The business unit a request works in is a context variable (`current_bu`),
set per request from the `X-BU` header (or `?bu=`) by `app.py`, and carried
into job threads by `jobs.submit`. Inside one, `host()` only resolves that
BU's hosts - another BU's host is "not found", so BUs stay isolated like
Keycloak realms. Outside a request (start-up cache warm, background capture)
there is no BU and every host resolves.
"""

from __future__ import annotations

import contextvars
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


class UnknownBu(KeyError):
    pass


_bu: contextvars.ContextVar[str | None] = contextvars.ContextVar("bu", default=None)


def set_bu(bu: str | None) -> str:
    """Bind the request to business unit `bu` (none or empty: the first BU)."""
    bu = bu or store().default_bu()
    if store().get_bu(bu) is None:
        raise UnknownBu(bu)
    _bu.set(bu)
    return bu


def current_bu() -> str | None:
    """The request's business unit, or None outside a request."""
    return _bu.get()


def bu() -> str:
    """The business unit to work in: the request's, else the first one."""
    return _bu.get() or store().default_bu()


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
    seeded = {b["id"] for b in s.list_bus()}
    for unit in fake.SEED_BUS:
        if unit["id"] not in seeded:
            # add_bu derives ids from labels, which match SEED_BUS ids.
            s.add_bu(unit["label"])
        s.update_git(unit["id"], unit["git"])
        s.update_git(unit["id"], {"status": "connected"})
    if fake.SEED_BUS[0]["id"] not in seeded:
        # A fresh demo file starts with BU "default" (store migration); drop it.
        for b in seeded - {u["id"] for u in fake.SEED_BUS}:
            if not s.list_hosts_raw(b):
                s.delete_bu(b)
    for h in fake.SEED_HOSTS:
        # add_host derives ids from labels, which match the fake inventory keys.
        s.add_host(h, h["bu"])
        if h["id"] != "dev-sandbox":
            s.update_host(h["id"], {"status": "connected", "lastChecked": "2026-09-26T09:12:00Z"})


def host(host_id: str) -> dict[str, Any]:
    raw = store().get_host_raw(host_id)
    cur = current_bu()
    if raw is None or (cur is not None and raw.get("bu") != cur):
        raise HostNotFound(host_id)
    return raw


def bu_hosts() -> list[dict[str, Any]]:
    """The current business unit's hosts."""
    return store().list_hosts_raw(bu())


def bu_host_ids() -> set[str]:
    return {h["id"] for h in bu_hosts()}


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

        return CachedBackend(FakeBackend(raw, store()), host_id, refresh, bu=raw["bu"])
    if not profile_to_connection(raw)["atscale"]["url"]:
        raise ValueError("Host has no hostname set")
    # The host's own BU's Git profile - the same as the request's, as host() enforces.
    git = store().get_git_raw(raw["bu"])
    return CachedBackend(RealBackend(raw, store(), git, api=_client(raw)), host_id, refresh, bu=raw["bu"])


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
    """The current business unit's Git profile."""
    return store().get_git_raw(bu())


def forget_host(host_id: str) -> None:
    """Host edited / removed / re-tested: drop its session and cached lists."""
    _clients.pop(host_id, None)
    cache.invalidate("host", host_id)


def forget_bu(unit: str) -> None:
    """A BU's Git profile changed: its hosts' versions + branches and its Git
    lists depend on the token."""
    for raw in store().list_hosts_raw(unit):
        cache.invalidate("host", raw["id"])
    cache.invalidate("git", unit)


def git_token() -> str | None:
    return git_profile().get("token") or None


def git_ready() -> bool:
    g = git_profile()
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
