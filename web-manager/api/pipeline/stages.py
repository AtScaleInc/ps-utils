"""Stages, board cells, gates and verdicts - pure, unit-tested (tests/test_pipeline.py).

Stages are the business unit's groups that have hosts, in group order. Their
roles follow the handoff's Dev · PR -> Test-QA · main -> Prod · approved,
stretched or shrunk to the groups the BU has:

  first stage      PR deploys (feature branches). With only two stages it is
                   also where main lands.
  second stage     main (merge) - when there are three or more stages
  middle stages    promoted to when the previous stage's commit passed its test
  last stage       approved (Prod)

Gates sit between adjacent stages. The first gate of a 3+ stage pipeline is a
*merge* gate (PIPELINE_BUILD.md §5 Dev -> QA); every other gate is a
*promotion* gate (§5 QA -> Prod): it opens when the source stage's commit has a
passing test, and the final gate also asks for approval when the policy says so.
Commits are ordered with the backend's compare() (GitHub compare on real
hosts), since a deployment's version is its Git commit.
"""

from __future__ import annotations

import math
from typing import Any, Callable

ENV_ORDER = ("dev", "test", "qa", "prod")
ENV_LABEL = {"dev": "Dev", "test": "Test", "qa": "QA", "prod": "Prod"}

Compare = Callable[[dict[str, Any], dict[str, Any]], "str | None"]


def stages(hosts: list[dict[str, Any]]) -> list[dict[str, Any]]:
    """[{env, label, trigger, role, hosts: [{id, label}]}] for every group with hosts."""
    used = [e for e in ENV_ORDER if any(h.get("env") == e for h in hosts)]
    n = len(used)
    out = []
    for i, env in enumerate(used):
        if i == n - 1 and n > 1:
            role, trigger = "release", "approved"
        elif i == 0:
            role, trigger = ("pr", "PR · main") if n == 2 else ("pr", "PR")
        elif i == 1:
            role, trigger = "main", "main"
        else:
            role, trigger = "promote", "promoted"
        out.append({"env": env, "label": ENV_LABEL[env], "trigger": trigger, "role": role,
                    "hosts": [{"id": h["id"], "label": h.get("label") or h["id"]} for h in hosts if h.get("env") == env]})
    return out


def gate_kinds(st: list[dict[str, Any]]) -> list[dict[str, Any]]:
    """One gate per adjacent pair: {from, to, kind: merge|promote, final}."""
    out = []
    for i in range(len(st) - 1):
        kind = "merge" if i == 0 and len(st) >= 3 else "promote"
        out.append({"from": st[i]["env"], "to": st[i + 1]["env"], "kind": kind, "final": i == len(st) - 2})
    return out


def cell(stage: dict[str, Any], rows_by_host: dict[str, list[dict[str, Any]]], model: str) -> dict[str, Any] | None:
    """The model in one stage: its primary host (the first host of the group
    that has it deployed), and drift - another host of the group on a
    different commit, or without the model."""
    on = []
    for h in stage["hosts"]:
        # A host can run the model from several branches (a PR catalog next to
        # main's): the most recently deployed one is what the stage runs.
        mine = [r for r in rows_by_host.get(h["id"]) or [] if r.get("name") == model and r.get("status") != "Linked"]
        on.append((h, max(mine, key=lambda r: r.get("updated") or "") if mine else None))
    deployed = [(h, r) for h, r in on if r]
    if not deployed:
        return None
    top_h, top = deployed[0]
    drift = [f"{h['label']} {short(r)}" if r else f"{h['label']} not deployed"
             for h, r in on if h is not top_h and (not r or r.get("commit") != top.get("commit"))]
    err = next((h["label"] for h, r in deployed if r.get("status") == "Error"), None)
    return {
        "env": stage["env"], "hostId": top_h["id"], "hostLabel": top_h["label"],
        "hosts": [h["id"] for h, _ in deployed],
        "commit": top.get("commit"), "version": short(top), "branch": top.get("branch"),
        "repoUrl": top.get("repoUrl"), "catalog": top.get("catalog"), "catalogId": top.get("catalogId"),
        "updated": top.get("updated"), "status": top.get("status"), "error": err, "drift": drift,
        "row": top,
    }


def short(row: dict[str, Any] | None) -> str:
    if not row:
        return "—"
    return row.get("version") or (row.get("commit") or "")[:7] or "?"


def merge_gate(src: dict[str, Any] | None, tgt: dict[str, Any] | None, compare: Compare) -> dict[str, Any]:
    """§5 Dev -> QA: nothing on the source -> blank; target missing or the
    source newer -> 'Merge to main'; same commit -> 'In sync'."""
    if not src:
        return {"k": "blank", "label": "", "sub": ""}
    sub = f"{short(tgt['row']) if tgt else '—'} → {short(src['row'])}"
    if not tgt:
        return {"k": "merge", "label": "Merge to main", "sub": sub}
    rel = compare(src["row"], tgt["row"])
    if rel == "identical":
        return {"k": "sync", "label": "In sync", "sub": ""}
    if rel == "behind":
        return {"k": "sync", "label": f"{ENV_LABEL.get(tgt['env'], tgt['env'])} ahead", "sub": ""}
    if rel == "diverged":
        return {"k": "merge", "label": "Diverged", "sub": sub}
    return {"k": "merge", "label": "Merge to main", "sub": sub}


def promote_gate(src: dict[str, Any] | None, tgt: dict[str, Any] | None, compare: Compare,
                 verdict: str, policy: dict[str, Any], final: bool) -> dict[str, Any]:
    """§5 QA -> Prod, for any promotion gate. `verdict` is the test verdict of
    the source stage's commit on the source stage (pass | fail | running | none)."""
    if not src:
        return {"k": "na", "label": "", "sub": ""}
    if tgt:
        rel = compare(src["row"], tgt["row"])
        if rel == "identical":
            return {"k": "sync", "label": "In sync", "sub": ""}
        if rel == "behind":
            return {"k": "sync", "label": f"{ENV_LABEL.get(tgt['env'], tgt['env'])} ahead", "sub": ""}
    sub = f"{short(tgt['row']) if tgt else '—'} → {short(src['row'])}"
    if verdict == "running":
        return {"k": "wait", "label": "Testing…", "sub": sub}
    if policy.get("requireTest") and verdict == "none":
        return {"k": "block", "label": "Blocked · no test", "sub": sub}
    if policy.get("requireTest") and verdict == "fail":
        return {"k": "block", "label": "Blocked · test failed", "sub": sub}
    approval = final and policy.get("approval")
    return {"k": "open", "label": "Awaiting approval" if approval else "Gate open", "sub": sub, "approval": bool(approval)}


# -- verdicts ---------------------------------------------------------------------------

FAIL_ROWS = ("failedCandidate", "missing")


def summarize(result: dict[str, Any] | None, policy: dict[str, Any]) -> dict[str, Any]:
    """A stored test result scored against the *current* policy, so changing
    the threshold re-evaluates every gate (§4.2: computed at read time).

    `result`: {status: running|done|failed, error?, rows: [{name, protocol,
    verdict, pct}], model: {intended, unintended, ...}} - pipeline/steps.py.
    A row's pct is its largest relative measure difference (%), None when
    the results differ in a way no threshold covers (rows only on one side,
    non-numeric values, other columns)."""
    if not result:
        return {"verdict": "none"}
    if result.get("status") == "running":
        return {"verdict": "running"}
    if result.get("status") == "failed":
        return {"verdict": "fail", "error": result.get("error") or "The test didn't finish"}
    limit = float(policy.get("variance") or 0)
    rows = result.get("rows") or []
    failed = [r for r in rows if r.get("verdict") in FAIL_ROWS]
    over, worst, matched = [], 0.0, 0
    for r in rows:
        if r.get("verdict") == "identical":
            matched += 1
        elif r.get("verdict") == "differs":
            pct = r.get("pct")
            p = math.inf if pct is None else abs(float(pct))
            worst = max(worst, p)
            if p <= limit:
                matched += 1
            else:
                over.append(r)
    model = result.get("model") or {}
    unintended = int(model.get("unintended") or 0)
    ok = bool(rows) and not failed and not over and not (policy.get("intendedOnly") and unintended)
    return {
        "verdict": "pass" if ok else "fail",
        "queries": len(rows), "matched": matched, "failed": len(failed), "overLimit": len(over),
        "maxVariance": None if math.isinf(worst) else round(worst, 3), "unbounded": math.isinf(worst),
        "limit": limit, "intended": int(model.get("intended") or 0), "unintended": unintended,
        "unclassified": bool(model.get("unclassified")),
    }


def board(hosts: list[dict[str, Any]], rows_by_host: dict[str, list[dict[str, Any]]], compare: Compare,
          test_of: Callable[[str, str | None, str], dict[str, Any] | None], policy: dict[str, Any]) -> dict[str, Any]:
    """The Board: per model, a cell per stage and a gate between each pair.
    `test_of(model, commit, env)` -> the stored result of the latest test of
    that commit on that stage, or None."""
    st = stages(hosts)
    kinds = gate_kinds(st)
    names = sorted({r["name"] for s in st for h in s["hosts"] for r in rows_by_host.get(h["id"]) or []
                    if r.get("name") and r.get("status") != "Linked"}, key=str.lower)
    models = []
    for name in names:
        cells = [cell(s, rows_by_host, name) for s in st]
        if not any(cells):
            continue
        out_cells = []
        for c in cells:
            if not c:
                out_cells.append(None)
                continue
            t = test_of(name, c["commit"], c["env"])
            s = summarize(t, policy)
            if t:
                b = t.get("baseline") or {}
                s |= {"runRef": t.get("runRef"), "at": t.get("at"), "runId": t.get("runId"),
                      "validateRunId": t.get("validateRunId"),
                      "baseline": {"kind": b.get("kind"), "label": b.get("label"), "version": b.get("version"),
                                   "env": b.get("env")}}
            out_cells.append({k: v for k, v in c.items() if k != "row"} | {"test": s})
        gates = []
        for i, g in enumerate(kinds):
            src, tgt = cells[i], cells[i + 1]
            if g["kind"] == "merge":
                gates.append(merge_gate(src, tgt, compare))
            else:
                v = out_cells[i]["test"]["verdict"] if out_cells[i] else "none"
                gates.append(promote_gate(src, tgt, compare, v, policy, g["final"]))
        first = next(c for c in cells if c)
        models.append({"name": name, "catalog": first.get("catalog"), "repoUrl": first.get("repoUrl"),
                       "cells": out_cells, "gates": gates})
    if policy.get("requireTest"):
        _same_catalog(models, st, kinds)
    return {"stages": st, "gates": kinds, "models": models}


def repo_key(url: str | None) -> str:
    return (url or "").strip().rstrip("/").removesuffix(".git").lower()


def _same_catalog(models: list[dict[str, Any]], st: list[dict[str, Any]], kinds: list[dict[str, Any]]) -> None:
    """A deploy takes a repo's whole catalog, so every model from that repo
    crosses a promotion gate together: an open gate stays closed while a
    sibling isn't ready - not on the source stage (it would arrive untested),
    or blocked / still testing there."""
    by_repo: dict[str, list[dict[str, Any]]] = {}
    for m in models:
        by_repo.setdefault(repo_key(m["repoUrl"]), []).append(m)
    own = {id(m): list(m["gates"]) for m in models}  # each model's own gates, before this rule
    for i, g in enumerate(kinds):
        if g["kind"] != "promote":
            continue
        for m in models:
            gate = m["gates"][i]
            if gate["k"] != "open":
                continue
            why = []
            for sib in by_repo[repo_key(m["repoUrl"])]:
                if sib is m:
                    continue
                if not sib["cells"][i]:
                    why.append(f"{sib['name']} isn't on {st[i]['label']}")
                elif own[id(sib)][i]["k"] in ("block", "wait"):
                    why.append(f"{sib['name']}: {own[id(sib)][i]['label']}")
            if why:
                m["gates"][i] = {"k": "block", "label": "Blocked · same catalog", "sub": gate["sub"], "why": why}
