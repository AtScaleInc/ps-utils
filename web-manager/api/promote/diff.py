"""Diff states + promotion filters - BUILD_INSTRUCTIONS.md §5, ported from the
prototype's diff() / srcRows logic.

Models are matched by name; their version is the Git commit they were built
from, ordered with `compare(src, tgt)` -> 'identical' | 'ahead' | 'behind' |
'diverged' | None (GitHub compare on real hosts). Aggregates are matched by
model + the objects they materialise (plan fingerprint, else attribute
signature), since system aggregate names are per-host UUIDs.
"""

from __future__ import annotations

from typing import Any, Callable

Compare = Callable[[dict[str, Any], dict[str, Any]], str | None]

STAGEABLE = {"new", "upd", "older", "diverged", "unknown", "repl"}

REASON = {
    "same": "Nothing to move",
    "miss": "Promote model first",
    "dup": "Deactivate on target",
    "uda": "System aggs only",
    "noexp": "Build it first",
    "srcoff": "Reactivate on source",
}


def model_state(src: dict[str, Any], targets: list[dict[str, Any]], compare: Compare) -> dict[str, Any]:
    t = next((x for x in targets if x["name"] == src["name"] and x.get("status") != "Linked"), None)
    if t is None:
        return {"state": "new", "label": "New"}
    sv, tv = src.get("version") or "?", t.get("version") or "?"
    rel = compare(src, t)
    if rel == "identical":
        return {"state": "same", "label": f"In sync · {tv}", "targetVersion": tv}
    if rel == "ahead":
        return {"state": "upd", "label": f"Update {tv} → {sv}", "targetVersion": tv}
    if rel == "behind":
        return {"state": "older", "label": f"Target newer · {tv}", "targetVersion": tv}
    if rel == "diverged":
        return {"state": "diverged", "label": f"Diverged · target {tv}", "targetVersion": tv}
    return {"state": "unknown", "label": "On target · version n/a", "targetVersion": t.get("version")}


def _same_agg(a: dict[str, Any], b: dict[str, Any]) -> bool:
    """Same model and same objects: compare plan fingerprints when both sides
    have one, else the attribute signature (blocked definitions aren't exported,
    so they have no plan fingerprint)."""
    if a["model"] != b["model"]:
        return False
    if a.get("planKey") and b.get("planKey"):
        return a["planKey"] == b["planKey"]
    return a.get("signature", a["name"]) == b.get("signature", b["name"])


def agg_state(src: dict[str, Any], targets: list[dict[str, Any]], target_models: set[str]) -> dict[str, Any]:
    if src.get("type") == "USER":
        return {"state": "uda", "label": "User-defined · not promotable"}
    # Promotion rules: system-defined, active on the source, and exportable.
    if src.get("active") is False:
        return {"state": "srcoff", "label": "Inactive on source"}
    if src.get("exportable") is False:
        # Export carries only definitions with a built instance.
        return {"state": "noexp", "label": "Not built · can't export"}
    if src["model"] not in target_models:
        return {"state": "miss", "label": "Model not on target"}
    matches = [t for t in targets if _same_agg(src, t)]
    if not matches:
        return {"state": "new", "label": "New"}
    active = [t for t in matches if t.get("active") is not False]
    if active:
        return {"state": "dup", "label": "Duplicate on target", "targetId": active[0].get("id")}
    return {"state": "repl", "label": "Replaces inactive · not advised", "targetIds": [t.get("id") for t in matches]}


def with_stageable(d: dict[str, Any]) -> dict[str, Any]:
    d["stageable"] = d["state"] in STAGEABLE
    d["reason"] = REASON.get(d["state"])
    return d


def diff_models(src_rows: list[dict[str, Any]], tgt_rows: list[dict[str, Any]], compare: Compare) -> list[dict[str, Any]]:
    return [{**r, "diff": with_stageable(model_state(r, tgt_rows, compare))} for r in src_rows]


def diff_aggs(src_aggs: list[dict[str, Any]], tgt_aggs: list[dict[str, Any]], target_models: set[str]) -> list[dict[str, Any]]:
    return [{**a, "diff": with_stageable(agg_state(a, tgt_aggs, target_models))} for a in src_aggs]


def duplicates_on_target(src_aggs: list[dict[str, Any]], tgt_aggs: list[dict[str, Any]]) -> set[str]:
    """Target aggregate ids that block promotion: active, same model + signature
    as a system aggregate on the source."""
    system = [a for a in src_aggs if a.get("type") != "USER"]
    return {t["id"] for t in tgt_aggs if t.get("active") is not False and any(_same_agg(s, t) for s in system)}


def partition_for_promote(
    staged_ids: list[str],
    src_aggs: list[dict[str, Any]],
    tgt_aggs: list[dict[str, Any]],
    target_models: set[str],
) -> tuple[list[dict[str, Any]], list[dict[str, Any]]]:
    """Server-side re-check at promote time (§5 rule 6): returns (promote, skipped)."""
    promote, skipped = [], []
    for agg_id in staged_ids:
        src = next((a for a in src_aggs if a["id"] == agg_id), None)
        if src is None:
            skipped.append({"id": agg_id, "name": agg_id, "reason": "Not on source"})
            continue
        d = with_stageable(agg_state(src, tgt_aggs, target_models))
        if d["stageable"]:
            promote.append({**src, "diff": d})
        else:
            skipped.append({"id": agg_id, "name": src["name"], "reason": d["reason"] or d["label"]})
    return promote, skipped
