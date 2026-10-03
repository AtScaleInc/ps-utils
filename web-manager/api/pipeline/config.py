"""Per business unit pipeline settings, stored in connections.yaml under
`businessUnits.<bu>.pipeline` (envs/store.py):

  orchestrator           gha | jenkins | builtin
  policy                 {requireTest, approval, intendedOnly, variance}
  serviceAccountPattern  regex a deploy identity should match (CI setup's
                         "Deploy identities": SSO-only accounts can't deploy)
  tokens                 [{id, name, scope[], prefix, hash, created, lastUsed}]

API tokens are bearer tokens for CI runners (`emt_...`). Only their sha256 is
stored; the plaintext is returned once, by create_token. A token belongs to
one business unit: a request that presents it works in that BU.
"""

from __future__ import annotations

import hashlib
import re
import secrets
import time
import uuid
from typing import Any

from atscale.backend import now_iso
from envs import registry

ORCHESTRATORS = ("gha", "jenkins", "builtin")
SCOPES = ("deploy", "test", "promote", "monitor")
DEFAULT_POLICY: dict[str, Any] = {"requireTest": True, "approval": True, "intendedOnly": True, "variance": 2.0}
DEFAULT_SERVICE_ACCOUNT = r"^svc[_-]"
TOKEN_PREFIX = "emt_"
# lastUsed is written back at most this often per token (a CI job polls every 10 s).
_TOUCH_EVERY_S = 60
_touched: dict[str, float] = {}


def _hash(token: str) -> str:
    return hashlib.sha256(token.encode()).hexdigest()


def settings(bu: str | None = None) -> dict[str, Any]:
    raw = registry.store().get_pipeline_raw(bu or registry.bu())
    policy = {**DEFAULT_POLICY, **(raw.get("policy") or {})}
    return {
        "orchestrator": raw.get("orchestrator") if raw.get("orchestrator") in ORCHESTRATORS else "gha",
        "policy": policy,
        "serviceAccountPattern": raw.get("serviceAccountPattern") or DEFAULT_SERVICE_ACCOUNT,
    }


def update(patch: dict[str, Any]) -> dict[str, Any]:
    """Orchestrator, policy fields and the service-account pattern; anything
    else is ignored. Raises ValueError on a bad value."""
    if "orchestrator" in patch and patch["orchestrator"] not in ORCHESTRATORS:
        raise ValueError(f"orchestrator must be one of {', '.join(ORCHESTRATORS)}")
    policy: dict[str, Any] = {}
    for k, v in (patch.get("policy") or {}).items():
        if k in ("requireTest", "approval", "intendedOnly"):
            policy[k] = bool(v)
        elif k == "variance":
            try:
                policy[k] = max(0.0, float(v))
            except (TypeError, ValueError):
                raise ValueError("variance must be a number (percent)") from None
    pattern = patch.get("serviceAccountPattern")
    if pattern is not None:
        try:
            re.compile(pattern)
        except re.error as e:
            raise ValueError(f"serviceAccountPattern isn't a valid regular expression: {e}") from None

    def apply(cur: dict[str, Any]) -> dict[str, Any]:
        if "orchestrator" in patch:
            cur["orchestrator"] = patch["orchestrator"]
        if policy:
            cur["policy"] = {**(cur.get("policy") or {}), **policy}
        if pattern is not None:
            cur["serviceAccountPattern"] = pattern
        return cur

    registry.store().update_pipeline(registry.bu(), apply)
    return settings()


def public_token(t: dict[str, Any]) -> dict[str, Any]:
    return {k: t.get(k) for k in ("id", "name", "scope", "prefix", "created", "lastUsed")}


def tokens() -> list[dict[str, Any]]:
    return [public_token(t) for t in registry.store().get_pipeline_raw(registry.bu()).get("tokens") or []]


def create_token(name: str, scope: list[str]) -> tuple[dict[str, Any], str]:
    """(public token, plaintext). The plaintext is never stored or shown again."""
    name = (name or "").strip()
    if not name:
        raise ValueError("A token needs a name")
    scope = [s for s in SCOPES if s in (scope or [])]
    if not scope:
        raise ValueError(f"Pick at least one scope: {', '.join(SCOPES)}")
    plain = TOKEN_PREFIX + secrets.token_urlsafe(32)
    tok = {"id": uuid.uuid4().hex[:10], "name": name, "scope": scope, "prefix": plain[:8] + "••••••••",
           "hash": _hash(plain), "created": now_iso(), "lastUsed": None}

    def add(cur: dict[str, Any]) -> dict[str, Any]:
        if any(t.get("name") == name for t in cur.get("tokens") or []):
            raise ValueError(f"A token named '{name}' already exists")
        cur["tokens"] = [*(cur.get("tokens") or []), tok]
        return cur

    registry.store().update_pipeline(registry.bu(), add)
    return public_token(tok), plain


def revoke_token(token_id: str) -> bool:
    found = False

    def drop(cur: dict[str, Any]) -> dict[str, Any]:
        nonlocal found
        before = cur.get("tokens") or []
        cur["tokens"] = [t for t in before if t.get("id") != token_id]
        found = len(cur["tokens"]) != len(before)
        return cur

    registry.store().update_pipeline(registry.bu(), drop)
    return found


def authenticate(plain: str) -> tuple[str, dict[str, Any]] | None:
    """(bu, token) for a valid bearer token, else None. Constant-time compare."""
    if not plain or not plain.startswith(TOKEN_PREFIX):
        return None
    digest = _hash(plain)
    for bu, raw in registry.store().all_pipelines():
        for t in raw.get("tokens") or []:
            if secrets.compare_digest(t.get("hash") or "", digest):
                _touch(bu, t["id"])
                return bu, public_token(t)
    return None


def _touch(bu: str, token_id: str) -> None:
    now = time.time()
    if now - _touched.get(token_id, 0) < _TOUCH_EVERY_S:
        return
    _touched[token_id] = now

    def set_used(cur: dict[str, Any]) -> dict[str, Any]:
        for t in cur.get("tokens") or []:
            if t.get("id") == token_id:
                t["lastUsed"] = now_iso()
        return cur

    registry.store().update_pipeline(bu, set_used)
