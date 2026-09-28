"""In-memory stand-in for an AtScale host, enabled with ENV_MANAGER_FAKE=1.

Seeded with the prototype's data (handoff `Environment Manager.dc.html` ::
seed()), so every screen and every §5 business rule can be exercised - and
tested - without a live container.
"""

from __future__ import annotations

import threading
import uuid
from typing import Any

from .backend import now_iso

BRANCHES = ["main", "develop", "release"]

FAKE_REPOS: dict[str, list[str]] = {
    "https://github.com/corp/atscale-sml-sales": ["Internet Sales", "Reseller Sales", "Customer 360"],
    "https://github.com/corp/atscale-sml-finance": ["Finance Ledger", "Marketing Attribution"],
    "https://github.com/corp/atscale-sml-ops": ["Supply Chain", "Inventory Snapshot"],
}
CATALOG = {
    "Internet Sales": "sales_catalog", "Reseller Sales": "sales_catalog", "Finance Ledger": "finance_catalog",
    "Supply Chain": "ops_catalog", "Customer 360": "crm_catalog", "Marketing Attribution": "mktg_catalog",
    "Inventory Snapshot": "ops_catalog",
}
AGGS = [
    ("agg_sales_by_month", "Internet Sales", "USER", "1.2 GB"),
    ("agg_sales_by_product_cat", "Internet Sales", "SYSTEM", "640 MB"),
    ("agg_sales_by_customer_geo", "Internet Sales", "SYSTEM", "880 MB"),
    ("agg_sales_daily", "Internet Sales", "USER", "2.1 GB"),
    ("agg_reseller_by_employee", "Reseller Sales", "SYSTEM", "190 MB"),
    ("agg_gl_by_account", "Finance Ledger", "SYSTEM", "1.4 GB"),
    ("agg_reseller_by_region", "Reseller Sales", "SYSTEM", "410 MB"),
    ("agg_gl_by_period", "Finance Ledger", "USER", "2.8 GB"),
    ("agg_shipments_by_week", "Supply Chain", "USER", "760 MB"),
    ("agg_customer_segments", "Customer 360", "USER", "220 MB"),
    ("agg_campaign_touch", "Marketing Attribution", "SYSTEM", "95 MB"),
    ("agg_inventory_daily", "Inventory Snapshot", "SYSTEM", "3.1 GB"),
]

SEED_HOSTS = [
    {"id": "dev-east", "env": "dev", "label": "dev-east", "hostname": "dev-atscale-01.corp.local",
     "username": "svc_atscale_dev", "password": "dev-secret", "apiToken": "demo-token"},
    {"id": "dev-sandbox", "env": "dev", "label": "dev-sandbox", "hostname": "dev-atscale-02.corp.local",
     "username": "svc_atscale_dev", "password": "dev-secret", "apiToken": ""},
    {"id": "qa-main", "env": "qa", "label": "qa-main", "hostname": "qa-atscale.corp.local",
     "username": "svc_atscale_qa", "password": "qa-secret", "apiToken": "demo-token"},
    {"id": "prod-east", "env": "prod", "label": "prod-east", "hostname": "atscale-east.corp.com",
     "username": "svc_atscale_prod", "password": "prod-secret", "apiToken": "demo-token"},
    {"id": "prod-west", "env": "prod", "label": "prod-west", "hostname": "atscale-west.corp.com",
     "username": "svc_atscale_prod", "password": "prod-secret", "apiToken": "demo-token"},
]

_SEED_MODELS: dict[str, tuple[list[tuple], list[str]]] = {
    "dev-east": ([("Internet Sales", 14, "2026-09-24"), ("Reseller Sales", 9, "2026-09-22"),
                  ("Finance Ledger", 6, "2026-09-23", "Linked"), ("Supply Chain", 4, "2026-09-19"),
                  ("Customer 360", 11, "2026-09-24"), ("Marketing Attribution", 3, "2026-09-25", "Linked"),
                  ("Inventory Snapshot", 5, "2026-09-18")], []),
    "dev-sandbox": ([("Internet Sales", 15, "2026-09-25", "Linked"), ("Customer 360", 12, "2026-09-25", "Linked")], []),
    "qa-main": ([("Internet Sales", 13, "2026-09-20"), ("Reseller Sales", 9, "2026-09-22"),
                 ("Finance Ledger", 5, "2026-09-12"), ("Supply Chain", 4, "2026-09-19"),
                 ("Customer 360", 10, "2026-09-16")], ["agg_customer_segments"]),
    "prod-east": ([("Internet Sales", 12, "2026-09-09"), ("Reseller Sales", 8, "2026-09-09"),
                   ("Finance Ledger", 5, "2026-09-15"), ("Supply Chain", 3, "2026-08-28")], []),
    "prod-west": ([("Internet Sales", 12, "2026-09-09"), ("Reseller Sales", 8, "2026-09-09"),
                   ("Supply Chain", 3, "2026-08-28", "Error")], ["agg_shipments_by_week"]),
}

_lock = threading.RLock()
_INV: dict[str, dict[str, list[dict[str, Any]]]] = {}


def _repo_for(model: str) -> str:
    return next(url for url, ms in FAKE_REPOS.items() if model in ms)


def _model_row(name: str, version: int | None, updated: str | None, status: str) -> dict[str, Any]:
    repo = _repo_for(name)
    return {
        "key": f"{repo.rsplit('/', 1)[1]}:{name}",
        "name": name,
        "catalog": CATALOG[name],
        "version": f"v{version}" if version is not None else None,
        "commit": f"v{version}" if version is not None else None,
        "commitDate": updated,
        "versionInferred": False,
        "updated": updated,
        "status": status,
        "catalogId": CATALOG[name] if status != "Linked" else None,
        "modelId": name if status != "Linked" else None,
        "repoId": repo.rsplit("/", 1)[1],
        "repoUrl": repo,
        "branch": "main",
    }


def _agg_rows(models: list[dict[str, Any]], stale: list[str]) -> list[dict[str, Any]]:
    deployed = {m["name"]: m for m in models if m["status"] != "Linked"}
    return [
        {"id": name, "instanceId": f"{name}-i1", "name": name, "model": model, "type": typ, "size": size,
         "lastBuild": f"{deployed[model]['updated']}T02:00:00Z",
         "status": "Stale" if name in stale else "Built", "active": True, "signature": name, "modelId": model}
        for name, model, typ, size in AGGS if model in deployed
    ]


def reset() -> None:
    with _lock:
        _INV.clear()
        for host_id, (models, stale) in _SEED_MODELS.items():
            rows = [_model_row(m[0], m[1], m[2], m[3] if len(m) > 3 else "Deployed") for m in models]
            _INV[host_id] = {"models": rows, "aggs": _agg_rows(rows, stale)}


def _inv(host_id: str) -> dict[str, list[dict[str, Any]]]:
    with _lock:
        if not _INV:
            reset()
        return _INV.setdefault(host_id, {"models": [], "aggs": []})


def _num(v: str | None) -> int:
    return int(v[1:]) if v else 0


def _head(model: str, branch: str) -> int:
    """Fake Git: main is the newest version any host has; develop is one ahead."""
    with _lock:
        top = max([1, *(_num(m["commit"]) for i in _INV.values() for m in i["models"] if m["name"] == model)])
    return top + (1 if branch == "develop" else 0)


class FakeBackend:
    def __init__(self, host: dict[str, Any], store: Any = None):
        self.host = host
        self.id = host["id"]

    def test(self) -> None:
        at = self.host.get("atscale", {})
        if not (at.get("url") and at.get("username") and (at.get("password") or at.get("apiToken"))):
            raise RuntimeError("Missing hostname, ID or password/token")
        inv = _inv(self.id)
        if not inv["models"]:
            inv["models"] = [_model_row("Internet Sales", None, None, "Linked"),
                             _model_row("Customer 360", None, None, "Linked")]

    def list_repos(self) -> list[dict[str, Any]]:
        return [{"id": u.rsplit("/", 1)[1], "name": u.rsplit("/", 1)[1], "url": u, "defaultBranch": "main"}
                for u in FAKE_REPOS]

    def branches(self, repo_url: str) -> list[dict[str, Any]]:
        return [{"name": b, "sha": None} for b in BRANCHES]

    def list_models(self) -> list[dict[str, Any]]:
        return [dict(m) for m in _inv(self.id)["models"]]

    def compare(self, src: dict[str, Any], tgt: dict[str, Any]) -> str | None:
        if not (src.get("commit") and tgt.get("commit")):
            return None
        a, b = _num(src["commit"]), _num(tgt["commit"])
        return "identical" if a == b else "ahead" if a > b else "behind"

    def link(self, repo_url: str, branch: str, model: str) -> dict[str, Any]:
        if model not in FAKE_REPOS.get(repo_url, []):
            raise ValueError(f"{model} is not in {repo_url}")
        with _lock:
            inv = _inv(self.id)
            if any(m["name"] == model for m in inv["models"]):
                raise ValueError(f"{model} is already linked on this host")
            row = _model_row(model, None, None, "Linked")
            row["branch"] = branch
            inv["models"].append(row)
        return {"repoId": row["repoId"]}

    def deploy_branch(self, repo_url: str, branch: str, replace_catalogs: list[str] | None = None,
                      only: str | None = None) -> dict[str, Any]:
        models = [m for m in FAKE_REPOS.get(repo_url, []) if not only or m == only]
        heads = {m: _head(m, branch) for m in models}
        with _lock:
            inv = _inv(self.id)
            for model in models:
                row = _model_row(model, heads[model], now_iso()[:10], "Deployed")
                row["branch"] = branch
                inv["models"] = [m for m in inv["models"] if m["name"] != model] + [row]
        # One catalog per repo here, so a redeploy on another branch replaces in place.
        return {"ok": True, "repoUrl": repo_url, "branch": branch, "catalogId": CATALOG[models[0]] if models else None,
                "commit": f"v{heads[models[0]]}" if models else None, "replaced": [], "warnings": []}

    def deploy(self, keys: list[str], branches: dict[str, str] | None = None) -> list[dict[str, Any]]:
        results = []
        for m in self.list_models():
            if m["key"] in keys:
                r = self.deploy_branch(m["repoUrl"], (branches or {}).get(m["key"]) or m["branch"], only=m["name"])
                results.append({**r, "key": m["key"]})
        return results

    def undeploy(self, keys: list[str]) -> dict[str, Any]:
        with _lock:
            inv = _inv(self.id)
            names = {m["name"] for m in inv["models"] if m["key"] in keys}
            for m in inv["models"]:
                if m["name"] in names:
                    m.update(status="Linked", version=None, commit=None, catalogId=None, modelId=None)
            inv["aggs"] = [a for a in inv["aggs"] if a["model"] not in names]
        return {"removed": keys, "catalogs": sorted(CATALOG[n] for n in names), "warnings": []}

    def unlink(self, keys: list[str]) -> dict[str, Any]:
        self.undeploy(keys)
        with _lock:
            inv = _inv(self.id)
            inv["models"] = [m for m in inv["models"] if m["key"] not in keys]
        return {"removed": keys, "catalogs": [], "warnings": []}

    def agg_models(self) -> list[dict[str, Any]]:
        return [{"catalogId": m["catalogId"], "modelId": m["modelId"], "name": m["name"], "catalog": m["catalog"]}
                for m in _inv(self.id)["models"] if m["status"] != "Linked"]

    def list_aggregates(self, catalog_id: str, model_id: str) -> list[dict[str, Any]]:
        return [dict(a) for a in _inv(self.id)["aggs"] if a["model"] == model_id]

    def set_active(self, catalog_id: str, model_id: str, agg_ids: list[str], active: bool) -> list[dict[str, Any]]:
        out = []
        with _lock:
            for a in _inv(self.id)["aggs"]:
                if a["model"] == model_id and a["id"] in agg_ids:
                    a.update(active=active, status="Built" if active else "Inactive")
                    out.append({"id": a["id"], "ok": True})
        return out

    def build(self, catalog_id: str, model_id: str, full: bool) -> dict[str, Any]:
        with _lock:
            targets = [a for a in _inv(self.id)["aggs"] if a["model"] == model_id and a["active"]]
            for a in targets:
                a["status"] = "Building"
        ids = [a["id"] for a in targets]

        def done() -> None:
            with _lock:
                for a in _inv(self.id)["aggs"]:
                    if a["id"] in ids and a["status"] == "Building":
                        a.update(status="Built", lastBuild=now_iso())

        threading.Timer(2.4 if full else 1.2, done).start()
        return {"batch": {"id": uuid.uuid4().hex, "status": "new"}, "aggregates": len(ids)}

    def build_history(self, catalog_id: str, model_id: str) -> list[dict[str, Any]]:
        return []

    def export_aggregates(self, catalog_id: str, model_id: str, agg_ids: list[str]) -> Any:
        values = [dict(a) for a in _inv(self.id)["aggs"] if a["model"] == model_id and a["id"] in agg_ids]
        return {"exportModelId": model_id, "aggregates": {"count": len(values), "values": values}}

    def import_aggregates(self, catalog_id: str, model_id: str, payload: Any) -> dict[str, Any]:
        """Like AtScale: a definition that already exists on the target is ignored."""
        values = payload["aggregates"]["values"]
        out = []
        with _lock:
            inv = _inv(self.id)
            for a in values:
                if any(x["id"] == a["id"] and x["model"] == model_id for x in inv["aggs"]):
                    out.append({"id": a["id"], "imported": False, "reason": "Definition already exists"})
                    continue
                inv["aggs"].append({**a, "model": model_id, "status": "Built", "active": True, "lastBuild": now_iso()})
                out.append({"id": a["id"], "newId": a["id"], "imported": True})
        return {"numberOfDefinitionsImported": sum(o["imported"] for o in out),
                "numberOfDefinitionsIgnored": sum(not o["imported"] for o in out), "aggregates": {"values": out}}

    def model_connections(self, catalog_id: str, model_id: str) -> list[str]:
        return []

    def catalog_ids(self, catalog_id: str) -> dict[str, str]:
        return {}


# -- Build (SML wizard) --------------------------------------------------------------------
# Warehouse metadata per host, in the shape AtScale's /wapi/p/data-sources API
# returns (sml-wizard routes/sources.py docstring). prod-west has no PostgresDB
# connection, so deploying a Build model there fails its preflight check.
_COLS = {
    "factinternetsales": [("salesordernumber", "String"), ("orderdatekey", "Int"), ("customerkey", "Int"),
                          ("productkey", "Int"), ("salesamount", "Decimal"), ("orderquantity", "Int")],
    "dimcustomer": [("customerkey", "Int"), ("firstname", "String"), ("lastname", "String"),
                    ("gender", "String"), ("geographykey", "Int")],
    "dimgeography": [("geographykey", "Int"), ("city", "String"), ("stateprovincename", "String"),
                     ("countryregioncode", "String")],
    "dimproduct": [("productkey", "Int"), ("englishproductname", "String"), ("color", "String"),
                   ("productsubcategorykey", "Int")],
    "dimdate": [("datekey", "Int"), ("fulldatealternatekey", "Date"), ("calendaryear", "Int"),
                ("monthnumberofyear", "Int"), ("englishmonthname", "String")],
}
_WAREHOUSES = [{"id": "wh-pg", "name": "Postgres", "connectionId": "PostgresDB", "platformType": "postgresql"}]
FAKE_SOURCES: dict[str, list[dict[str, Any]]] = {
    h["id"]: ([] if h["id"] == "prod-west" else _WAREHOUSES) for h in SEED_HOSTS
}


class FakeSourceApi:
    """Stands in for the AtScaleClient data-source calls Build uses."""

    def __init__(self, host_id: str):
        self.host_id = host_id

    def list_data_sources(self) -> list[dict[str, Any]]:
        return [dict(w) for w in FAKE_SOURCES.get(self.host_id, _WAREHOUSES)]

    def list_databases(self, connection_id: str) -> list[str]:
        return ["tutorial"]

    def list_schemas(self, connection_id: str, database: str) -> list[str]:
        return ["public", "information_schema"]

    def list_tables(self, connection_id: str, database: str, schema: str) -> list[str]:
        return list(_COLS) if schema == "public" else []

    def get_table_info(self, connection_id: str, database: str, schema: str, table: str) -> dict[str, Any]:
        return {"columns": [{"name": n, "dataType": t} for n, t in _COLS.get(table, [])]}

    def run_xmla(self, xml_body: str, timeout: float | None = None) -> str:
        raise ValueError("Preview queries need a live AtScale host - not available in demo mode")

    submit_query = run_xmla


def register_built_model(repo_url: str, model: str, catalog: str) -> None:
    """A model pushed by Build becomes a repo the fake hosts can deploy."""
    with _lock:
        FAKE_REPOS[repo_url] = [model]
        CATALOG[model] = catalog
