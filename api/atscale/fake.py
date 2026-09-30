"""In-memory stand-in for an AtScale host, enabled with ENV_MANAGER_FAKE=1.

Seeded with the prototype's data (handoff `Environment Manager.dc.html` ::
seed()), so every screen and every §5 business rule can be exercised - and
tested - without a live container.
"""

from __future__ import annotations

import random
import sqlite3
import threading
import time
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

    def _connection(self) -> str:
        """Each demo environment names its warehouse connection differently
        (PG_DEV / PG_QA / PG_PROD), like real ones do."""
        return f"PG_{str(self.host.get('env') or 'dev').upper()}"

    def export_aggregates(self, catalog_id: str, model_id: str, agg_ids: list[str]) -> Any:
        values = [{**a, "connectionId": a.get("connectionId") or self._connection()}
                  for a in _inv(self.id)["aggs"] if a["model"] == model_id and a["id"] in agg_ids]
        return {"exportModelId": model_id, "aggregates": {"count": len(values), "values": values},
                "exportSummary": {"connectionIds": {"count": 1, "values": [self._connection()]}}}

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
        return [self._connection()]

    def dataset_connections(self, catalog_id: str) -> dict[str, str]:
        return {"factinternetsales": self._connection(), "dimcustomer": self._connection()}

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

# Demo warehouse rows for Build > Discovery: deterministic per table, loaded into
# an in-memory SQLite whose attached `public` schema lets the real profile SQL
# ("public"."dimcustomer", COUNT DISTINCT, ROW_NUMBER() OVER ...) run unchanged.
_ROW_COUNTS = {"factinternetsales": 600, "dimcustomer": 180, "dimgeography": 40, "dimproduct": 60, "dimdate": 120}
_WORDS = {
    "firstname": ["Ana", "Ben", "Chen", "Dara", "Eli", "Fatima", "Gus", "Hana"],
    "lastname": ["Lee", "Garcia", "Kim", "Nguyen", "Patel", "Smith"],
    "gender": ["F", "M"],
    "city": ["Austin", "Boston", "Denver", "Paris", "Seattle", "Sydney", "Toronto"],
    "stateprovincename": ["Texas", "Massachusetts", "Colorado", "Ile-de-France", "Washington", "NSW", "Ontario"],
    "countryregioncode": ["US", "FR", "AU", "CA"],
    "color": ["Black", "Red", "Silver", "Blue", None],
    "englishmonthname": ["January", "February", "March", "April", "May", "June", "July", "August",
                         "September", "October", "November", "December"],
}


def _fake_value(rnd: random.Random, table: str, col: str, typ: str, i: int) -> Any:
    if col == f"{table.removeprefix('dim')}key" or (table == "dimdate" and col == "datekey"):
        return i + 1
    if col.endswith("key"):
        fk = col.removesuffix("key")
        return 20240101 + rnd.randrange(_ROW_COUNTS.get("dimdate", 1)) if col == "orderdatekey" \
            else rnd.randrange(1, _ROW_COUNTS.get(f"dim{fk}", 50) + 1)
    if col in _WORDS:
        return rnd.choice(_WORDS[col])
    if col == "englishproductname":
        return f"Product {i + 1:03d}"
    if col == "salesordernumber":
        return f"SO{43000 + i // 3}"
    if col == "salesamount":
        return round(rnd.uniform(2, 3500), 2)
    if col == "orderquantity":
        return rnd.choice([1, 1, 1, 2, 3])
    if col == "fulldatealternatekey":
        return f"2024-{1 + i % 12:02d}-{1 + i % 28:02d}"
    if col == "calendaryear":
        return 2022 + i % 3
    if col == "monthnumberofyear":
        return 1 + i % 12
    return rnd.randrange(1000) if typ in ("Int", "Decimal") else f"{col}_{i}"


def fake_rows(table: str) -> list[tuple]:
    rnd = random.Random(table)
    cols = _COLS.get(table, [])
    return [tuple(_fake_value(rnd, table, c, t, i) for c, t in cols) for i in range(_ROW_COUNTS.get(table, 0))]


_warehouse: sqlite3.Connection | None = None
_warehouse_lock = threading.Lock()


def _fake_warehouse() -> sqlite3.Connection:
    global _warehouse
    if _warehouse is None:
        conn = sqlite3.connect(":memory:", check_same_thread=False)
        conn.execute("ATTACH DATABASE ':memory:' AS public")
        for table, cols in _COLS.items():
            conn.execute(f'CREATE TABLE public."{table}" ({", ".join(f"{c!r}" for c, _ in cols)})')
            conn.executemany(f'INSERT INTO public."{table}" VALUES ({", ".join("?" * len(cols))})', fake_rows(table))
        _warehouse = conn
    return _warehouse


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

    def query_sample(self, connection_id: str, query: str, timeout: float | None = 600) -> dict[str, Any]:
        """Same wrapper the engine applies (DB.scala :: getQuerySampleData)."""
        with _warehouse_lock:
            try:
                cur = _fake_warehouse().execute(f"SELECT * FROM ({query}) as_subselect_tmp LIMIT 10")
            except sqlite3.Error as e:
                raise ValueError(f"Problem getting query sample data: {e}") from None
            rows = cur.fetchall()
        return {"columns": [{"name": d[0], "column-type": {"data-type": "String"}} for d in cur.description],
                "rows": [{"values": [None if v is None else str(v) for v in r]} for r in rows]}

    def get_table_sample(self, connection_id: str, database: str, schema: str, table: str,
                         limit: int = 100) -> dict[str, Any]:
        if table not in _COLS:
            raise ValueError(f"Table {schema}.{table} not found")
        return {"columns": [{"name": c} for c, _ in _COLS[table]],
                "rows": [list(r) for r in fake_rows(table)[:limit]], "rowCount": min(limit, _ROW_COUNTS[table])}

    def list_datasource_statistics(self, connection_id: str) -> list[dict[str, Any]]:
        # The engine only has row counts for tables its workers have visited.
        return [{"connectionId": connection_id, "statisticType": "RowCount", "value": _ROW_COUNTS[t],
                 "lastUpdated": "2026-09-01T00:00:00Z",
                 "descriptor": {"dataSet": {"database": "tutorial", "schema": "public", "tableName": t}, "columns": []}}
                for t in ("factinternetsales", "dimcustomer")]

    def run_xmla(self, xml_body: str, timeout: float | None = None) -> str:
        raise ValueError("Preview queries need a live AtScale host - not available in demo mode")

    submit_query = run_xmla

    # -- query history (Monitor): same shapes as AtScaleClient.list_queries & co --
    def list_queries(self, page: int = 1, size: int = 100, start_date: str | None = None,
                     end_date: str | None = None, query_types: list[str] | None = None,
                     statuses: list[str] | None = None) -> dict[str, Any]:
        now = int(time.time() * 1000)
        start = _parse_ms(start_date) if start_date else now - 86400 * 1000
        end = _parse_ms(end_date) if end_date else now
        rows = []
        slot = now // _Q_SLOT_MS
        while slot * _Q_SLOT_MS >= start:
            q = _fake_query(self.host_id, slot, now)
            if (q and q["startTime"] >= start and q["startTime"] <= end
                    and (not query_types or q["queryType"] in query_types)):
                rows.append(q)
            slot -= 1
        lo = (page - 1) * size
        return {"results": rows[lo:lo + size], "totalResults": str(len(rows)), "hasNextPage": len(rows) > lo + size,
                "currentPage": page, "pageSize": size}

    def get_query_text(self, query_id: str, subquery: bool = False) -> str:
        q = _fake_query(self.host_id, _slot_of(query_id), int(time.time() * 1000))
        if not q:
            raise ValueError(f"Query {query_id} not found")
        return q["_text"]

    def get_query_aggregates(self, query_id: str) -> list[dict[str, Any]]:
        q = _fake_query(self.host_id, _slot_of(query_id), int(time.time() * 1000))
        by_id = {f"def-{name}": (name, kind) for name, _, kind, _ in AGGS}
        return [{"id": a, "name": by_id[a][0], "type": "system_defined" if by_id[a][1] == "SYSTEM" else "user_defined",
                 "subType": "demand_defined" if by_id[a][1] == "SYSTEM" else "manual",
                 "active_instance": {"table_name": f"as_agg_{by_id[a][0]}"}}
                for a in (q or {}).get("aggregates", []) if a in by_id]


# -- fake query history: one possible query per host per 3-minute slot, derived from
# (host, slot) so every poll and every detail call sees the same history, and new
# queries keep arriving as time passes (auto-poll has something to show).
_Q_SLOT_MS = 3 * 60 * 1000
_Q_USERS = ["ana.lee", "raj.patel", "m.chen", "sofia.garcia", "bi_service"]
_Q_ATTRS = ["Order Date Year", "Order Date Month", "Product Category", "Product Line", "Customer Country",
            "Sales Territory", "Customer Segment"]
_Q_MEASURES = ["Sales Amount", "Order Quantity", "Tax Amount", "Freight", "Distinct Customers"]


def _parse_ms(iso: str) -> int:
    import datetime as dt

    return int(dt.datetime.fromisoformat(iso.replace("Z", "+00:00")).timestamp() * 1000)


def _slot_of(query_id: str) -> int:
    try:
        return int(query_id.rsplit("-", 1)[1])
    except (IndexError, ValueError):
        raise ValueError(f"Query {query_id} not found") from None


def _fake_query(host_id: str, slot: int, now_ms: int) -> dict[str, Any] | None:
    rnd = random.Random(f"{host_id}:{slot}")
    busy = 0.85 if host_id.startswith("prod") else 0.55
    if rnd.random() > busy:
        return None
    models = [m[0] for m in _SEED_MODELS.get(host_id, ([], []))[0] if (m[3] if len(m) > 3 else "Deployed") != "Linked"]
    if not models:
        return None
    model = rnd.choice(models)
    start = slot * _Q_SLOT_MS + rnd.randrange(_Q_SLOT_MS)
    system = rnd.random() < 0.18
    roll = rnd.random()
    aggs = [f"def-{a[0]}" for a in AGGS if a[1] == model]
    if system:
        cls = "raw" if rnd.random() < 0.7 else "agg"
        attrs, measures = [], []
    else:
        cls = "cache" if roll < 0.2 else "agg" if roll < 0.72 and aggs else "raw"
        attrs = rnd.sample(_Q_ATTRS, rnd.randint(0, 3))
        measures = rnd.sample(_Q_MEASURES, rnd.randint(1, 2))
    used = [rnd.choice(aggs)] if cls == "agg" and aggs else []
    base = {"cache": (15, 180), "agg": (120, 1800), "raw": (1500, 28000)}[cls if used or cls != "agg" else "raw"]
    duration = rnd.uniform(*base) * (2.5 if host_id.startswith("dev") and cls == "raw" else 1)
    failed = rnd.random() < 0.035
    status = "failed" if failed else "running" if start + duration > now_ms else "successful"
    planning = min(duration * rnd.uniform(0.05, 0.2), duration)
    subq = [] if cls == "cache" and rnd.random() < 0.5 else [
        {"name": f"Query {i + 1}", "subqueryId": f"sq-{slot}-{i}", "startTime": start + planning,
         "duration": (duration - planning) * rnd.uniform(0.6, 0.95)} for i in range(rnd.randint(1, 3))]
    outbound = max((s["duration"] for s in subq), default=0)
    mdx = rnd.random() < 0.6
    cols = ", ".join(f'"{a}"' for a in attrs + measures) or '"Sales Amount"'
    text = (f"SELECT {{{', '.join(f'[Measures].[{m}]' for m in measures) or '[Measures].[Sales Amount]'}}} ON COLUMNS"
            + (f",\n  NON EMPTY [{attrs[0]}].[{attrs[0]}].MEMBERS ON ROWS" if attrs else "") + f"\nFROM [{model}]"
            if mdx else f'SELECT {cols}\nFROM "{model}"' + (f'\nGROUP BY {", ".join(f"{chr(34)}{a}{chr(34)}" for a in attrs)}' if attrs else ""))
    if system:
        text = f"/* aggregate build */ INSERT INTO as_agg_{model.lower().replace(' ', '_')} SELECT ..."
    return {
        "queryId": f"fq-{slot}", "startTime": start, "duration": None if status == "running" else round(duration, 1),
        "status": status, "queryType": "System" if system else "User",
        "userId": "system" if system else rnd.choice(_Q_USERS), "user": "System" if system else None,
        "catalogId": CATALOG.get(model, "catalog"), "catalogName": CATALOG.get(model, "catalog"),
        "modelId": model.lower().replace(" ", "_"), "modelName": model,
        "dialect": "postgresql", "optimization": (["CACHE"] if cls == "cache" else []) + (["AGGS"] if used else []),
        "aggregates": used, "aggregatesTables": [f"as_agg_{u[4:]}" for u in used],
        "attributes": attrs, "measures": measures,
        "events": [{"name": "Inbound Query", "startTime": start, "duration": round(duration, 1)},
                   {"name": "Planning", "startTime": start, "duration": round(planning, 1)},
                   {"name": "Outbound", "startTime": start + planning, "duration": round(outbound, 1), "subqueries": subq},
                   {"name": "Result Processing", "startTime": start + planning + outbound,
                    "duration": round(max(duration - planning - outbound, 0), 1)}],
        "failedMessage": "Query timed out waiting for the warehouse" if failed and cls == "raw"
        else "Level [Customer Segment] not found in cube" if failed else None,
        "_text": text,
    }


def register_built_model(repo_url: str, model: str, catalog: str) -> None:
    """A model pushed by Build becomes a repo the fake hosts can deploy."""
    with _lock:
        FAKE_REPOS[repo_url] = [model]
        CATALOG[model] = catalog
