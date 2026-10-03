"""Caching wrapper around a host backend (real or fake).

Reads go through `cache` keyed by host (and model); writes pass through and
invalidate what they touched, so the next read reloads from AtScale.
"""

from __future__ import annotations

from typing import Any

import cache


def _building_ttl(rows: list[dict[str, Any]]) -> float:
    # A running build flips rows Building -> Built; keep polling live.
    return 5 if any(r.get("status") == "Building" for r in rows) else cache.TTL


class CachedBackend:
    def __init__(self, inner: Any, host_id: str, refresh: bool = False, bu: str | None = None):
        self.inner = inner
        self.host_id = host_id
        self.bu = bu  # the host's business unit: Git-side entries are kept per BU
        self.refresh = refresh
        self.loaded_at: float | None = None

    def _get(self, key: tuple, loader, ttl=None) -> Any:
        value, loaded = cache.get(key, loader, refresh=self.refresh, ttl=ttl)
        self.loaded_at = loaded if self.loaded_at is None else min(self.loaded_at, loaded)
        return value

    def _drop(self, *parts: Any) -> None:
        cache.invalidate("host", self.host_id, *parts)

    # -- reads ------------------------------------------------------------------------------
    def list_models(self) -> list[dict[str, Any]]:
        return self._get(("host", self.host_id, "models"), self.inner.list_models)

    def list_repos(self) -> list[dict[str, Any]]:
        return self._get(("host", self.host_id, "repos"), self.inner.list_repos)

    def branches(self, repo_url: str) -> list[dict[str, Any]]:
        return self._get(("host", self.host_id, "branches", repo_url), lambda: self.inner.branches(repo_url))

    def agg_models(self) -> list[dict[str, Any]]:
        return self._get(("host", self.host_id, "aggModels"), self.inner.agg_models)

    def list_aggregates(self, catalog_id: str, model_id: str) -> list[dict[str, Any]]:
        return self._get(("host", self.host_id, "aggs", catalog_id, model_id),
                         lambda: self.inner.list_aggregates(catalog_id, model_id), ttl=_building_ttl)

    def compare(self, src: dict[str, Any], tgt: dict[str, Any]) -> str | None:
        if not (src.get("commit") and tgt.get("commit")):
            return self.inner.compare(src, tgt)
        # Commit pairs never change their relationship - safe to keep.
        key = ("git", self.bu, "compare", src.get("repoUrl"), tgt.get("repoUrl"), tgt["commit"], src["commit"])
        value, _ = cache.get(key, lambda: self.inner.compare(src, tgt))
        return value

    def head_commit(self, repo_url: str, branch: str, model: str | None = None) -> str | None:
        return self.inner.head_commit(repo_url, branch, model)  # never cached: it moves with every merge

    def previous_commit(self, row: dict[str, Any]) -> dict[str, Any] | None:
        return self.inner.previous_commit(row)

    def build_history(self, catalog_id: str, model_id: str) -> list[dict[str, Any]]:
        return self.inner.build_history(catalog_id, model_id)

    def export_aggregates(self, catalog_id: str, model_id: str, agg_ids: list[str]) -> Any:
        return self.inner.export_aggregates(catalog_id, model_id, agg_ids)

    def catalog_ids(self, catalog_id: str) -> dict[str, str]:
        """Per-host id -> name map (stored in the working folder as
        host/<id>/ids/<catalog>.json); captured on Test connection and at start."""
        return self._get(("host", self.host_id, "ids", catalog_id), lambda: self.inner.catalog_ids(catalog_id))

    def model_connections(self, catalog_id: str, model_id: str) -> list[str]:
        return self.inner.model_connections(catalog_id, model_id)

    def dataset_connections(self, catalog_id: str) -> dict[str, str]:
        # Read fresh at promote time: a redeploy can repoint a dataset.
        return self.inner.dataset_connections(catalog_id)

    def test(self) -> None:
        self.inner.test()
        self._drop()

    # -- writes: pass through, then drop what they changed -------------------------------------
    def link(self, *args: Any, **kwargs: Any) -> Any:
        try:
            return self.inner.link(*args, **kwargs)
        finally:
            self._drop()

    def attach_repo(self, *args: Any, **kwargs: Any) -> Any:
        try:
            return self.inner.attach_repo(*args, **kwargs)
        finally:
            self._drop()

    def deploy(self, *args: Any, **kwargs: Any) -> Any:
        try:
            return self.inner.deploy(*args, **kwargs)
        finally:
            self._drop()

    def deploy_branch(self, *args: Any, **kwargs: Any) -> Any:
        try:
            return self.inner.deploy_branch(*args, **kwargs)
        finally:
            self._drop()

    def deploy_commit(self, *args: Any, **kwargs: Any) -> Any:
        try:
            return self.inner.deploy_commit(*args, **kwargs)
        finally:
            self._drop()

    def undeploy(self, *args: Any, **kwargs: Any) -> Any:
        try:
            return self.inner.undeploy(*args, **kwargs)
        finally:
            self._drop()

    def unlink(self, *args: Any, **kwargs: Any) -> Any:
        try:
            return self.inner.unlink(*args, **kwargs)
        finally:
            self._drop()

    def set_active(self, catalog_id: str, model_id: str, *args: Any, **kwargs: Any) -> Any:
        try:
            return self.inner.set_active(catalog_id, model_id, *args, **kwargs)
        finally:
            self._drop("aggs", catalog_id, model_id)

    def build(self, catalog_id: str, model_id: str, *args: Any, **kwargs: Any) -> Any:
        try:
            return self.inner.build(catalog_id, model_id, *args, **kwargs)
        finally:
            self._drop("aggs", catalog_id, model_id)

    def import_aggregates(self, catalog_id: str, model_id: str, *args: Any, **kwargs: Any) -> Any:
        try:
            return self.inner.import_aggregates(catalog_id, model_id, *args, **kwargs)
        finally:
            self._drop("aggs", catalog_id, model_id)
