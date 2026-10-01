from promote import diff as D


def m(name, version):
    return {"name": name, "version": version and f"v{version}", "n": version, "status": "Deployed"}


def cmp(src, tgt):
    if src["n"] is None or tgt["n"] is None:
        return None
    return "identical" if src["n"] == tgt["n"] else "ahead" if src["n"] > tgt["n"] else "behind"


def a(name, model="Sales", type="SYSTEM", active=True, id=None, sig=None):
    return {"id": id or name, "name": name, "model": model, "type": type, "active": active, "signature": sig or name}


class TestModelStates:
    def test_new(self):
        d = D.model_state(m("X", 3), [], cmp)
        assert d["state"] == "new" and D.with_stageable(d)["stageable"]

    def test_linked_on_target_counts_as_new(self):
        assert D.model_state(m("X", 3), [{**m("X", 1), "status": "Linked"}], cmp)["state"] == "new"

    def test_update(self):
        d = D.with_stageable(D.model_state(m("X", 5), [m("X", 3)], cmp))
        assert d["state"] == "upd" and d["label"] == "Update v3 → v5" and d["stageable"]

    def test_in_sync_not_stageable(self):
        d = D.with_stageable(D.model_state(m("X", 3), [m("X", 3)], cmp))
        assert d["state"] == "same" and not d["stageable"] and d["reason"] == "Nothing to move"

    def test_target_newer_stageable(self):
        d = D.with_stageable(D.model_state(m("X", 2), [m("X", 4)], cmp))
        assert d["state"] == "older" and d["label"] == "Target newer · v4" and d["stageable"]

    def test_diverged_stageable(self):
        d = D.with_stageable(D.model_state(m("X", 2), [m("X", 4)], lambda s, t: "diverged"))
        assert d["state"] == "diverged" and d["stageable"]

    def test_unknown_version_stageable(self):
        d = D.with_stageable(D.model_state(m("X", None), [m("X", 4)], cmp))
        assert d["state"] == "unknown" and d["stageable"]


class TestAggStates:
    def test_not_exportable_is_blocked(self):
        d = D.with_stageable(D.agg_state({**a("s"), "exportable": False}, [], {"Sales"}))
        assert d["state"] == "noexp" and not d["stageable"]

    def test_plan_fingerprint_wins_over_attributes(self):
        src = {**a("x", sig="same"), "planKey": "p1"}
        assert D.agg_state(src, [{**a("y", sig="same", id="t"), "planKey": "p2"}], {"Sales"})["state"] == "new"
        assert D.agg_state(src, [{**a("y", sig="other", id="t"), "planKey": "p1"}], {"Sales"})["state"] == "dup"

    def test_user_defined_blocked_even_if_new(self):
        d = D.with_stageable(D.agg_state(a("u", type="USER"), [], {"Sales"}))
        assert d["state"] == "uda" and not d["stageable"]

    def test_model_not_on_target(self):
        d = D.with_stageable(D.agg_state(a("s"), [], {"Other"}))
        assert d["state"] == "miss" and d["reason"] == "Promote model first"

    def test_duplicate_active(self):
        d = D.with_stageable(D.agg_state(a("s"), [a("s", id="t1")], {"Sales"}))
        assert d["state"] == "dup" and not d["stageable"] and d["targetId"] == "t1"

    def test_replaces_inactive(self):
        d = D.with_stageable(D.agg_state(a("s"), [a("s", active=False, id="t1")], {"Sales"}))
        assert d["state"] == "repl" and d["stageable"] and d["targetIds"] == ["t1"]

    def test_new(self):
        assert D.agg_state(a("s"), [a("other")], {"Sales"})["state"] == "new"

    def test_same_name_other_model_is_new(self):
        assert D.agg_state(a("s"), [a("s", model="Finance")], {"Sales"})["state"] == "new"

    def test_matches_by_signature_not_name(self):
        # System aggregate names are per-host UUIDs; the attribute signature matches.
        d = D.agg_state(a("uuid-src", sig="dim:Color"), [a("uuid-tgt", sig="dim:Color", id="t1")], {"Sales"})
        assert d["state"] == "dup" and d["targetId"] == "t1"
        assert D.agg_state(a("same-uuid", sig="dim:Color"), [a("same-uuid", sig="dim:Size")], {"Sales"})["state"] == "new"


def test_duplicates_ignore_user_and_inactive():
    src = [a("s1"), a("u1", type="USER")]
    tgt = [a("s1", id="t-s1"), a("u1", id="t-u1"), a("s2", id="t-s2")]
    assert D.duplicates_on_target(src, tgt) == {"t-s1"}
    tgt[0]["active"] = False
    assert D.duplicates_on_target(src, tgt) == set()


def test_partition_rechecks_everything():
    src = [a("new"), a("dup"), a("repl"), a("uda", type="USER"), a("miss", model="Finance")]
    tgt = [a("dup"), a("repl", active=False)]
    promote, skipped = D.partition_for_promote(
        ["new", "dup", "repl", "uda", "miss", "ghost"], src, tgt, {"Sales"},
    )
    assert [p["name"] for p in promote] == ["new", "repl"]
    assert {s["name"]: s["reason"] for s in skipped} == {
        "dup": "Deactivate on target", "uda": "System aggs only",
        "miss": "Promote model first", "ghost": "Not on source",
    }


def test_plan_fingerprint_ignores_alias_and_model_and_order():
    from atscale.backend import plan_fingerprint

    def col(key, alias, model):
        return {"type": "select-column", "alias": alias, "aggregation-type": {"type": "aggregate-grouped"},
                "value": {"type": "key-value", "model": {"id": model},
                          "key": {"type": "flat-key", "key": {"type": "key", "model": None, "id": key}, "ref-path": {"type": "ref-path", "refs": []}}}}

    p1 = {"selection": {"columns": [col("k1", "key_c1", "m1"), col("k2", "key_c2", "m1")]}}
    p2 = {"selection": {"columns": [col("k2", "x", "m2"), col("k1", "y", "m2")]}}
    p3 = {"selection": {"columns": [col("k1", "key_c1", "m1")]}}
    assert plan_fingerprint(p1) == plan_fingerprint(p2) != plan_fingerprint(p3)
    assert plan_fingerprint({"selection": {}}) is None
