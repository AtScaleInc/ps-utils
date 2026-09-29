"""AtScale REST client.

Auth + repo calls copied from sml-wizard api/atscale/client.py. Catalog and
aggregate calls follow the Container API docs (documentation.atscale.com/
container-api), cross-checked against reference/ps-utils and SML-develop's
api-sdk / public-api-sdk. Container hosts only - no installer :10500/:10502.

Ported from reference/ps-utils/src/services/AtScaleRestClientService.ts and
RestClientService.ts, including the cookie-auth flow required specifically by
`/wapi/git/deploy/catalog` (see AtScaleEnvironment._acquire_session_cookie -
faithfully ported from acquireSessionCookie() in the TS source, a headless
Keycloak authorization-code flow: GET /signin, scrape the login form action,
POST credentials, follow the redirect, capture the session cookie).
"""

from __future__ import annotations

import re
import time
from dataclasses import dataclass, field
from typing import Any
from urllib.parse import quote

import requests


class AtScaleAuthError(RuntimeError):
    pass


class AtScaleApiError(RuntimeError):
    def __init__(self, status: int, body: str, url: str):
        super().__init__(f"AtScale API error {status} for {url}: {body}")
        self.status = status
        self.body = body
        self.url = url


@dataclass
class AtScaleEnvironment:
    """Mirrors AtScaleEnvironment / KeycloakEnvironment config in AtScaleRestClientService.ts."""

    base_url: str
    username: str | None = None
    password: str | None = None
    realm: str = "atscale"
    client_id: str = "atscale-ai-link"
    client_secret: str | None = None
    api_token: str | None = None
    auth_type: str = "keycloak"  # "keycloak" | "basic"
    insecure: bool = True
    use_raw_api_token: bool = False
    session_cookie: str | None = None
    #: When True, authenticate() acquires a Design Center session cookie
    #: instead of a Bearer JWT - required by /wapi/git/deploy/catalog.
    cookie_auth: bool = False

    _token: str | None = field(default=None, init=False, repr=False)
    _token_expires_at: float = field(default=0.0, init=False, repr=False)
    _cookie_header: str | None = field(default=None, init=False, repr=False)

    def invalidate(self) -> None:
        self._token = None
        self._token_expires_at = 0.0
        self._cookie_header = None

    def _keycloak_token_url(self) -> str:
        return f"{self.base_url}/auth/realms/{self.realm}/protocol/openid-connect/token"

    def authenticate(self, force: bool = False) -> tuple[str, dict[str, str]]:
        """Returns (scheme, headers) - bearer, basic, or cookie auth headers."""
        if self.cookie_auth:
            return self._authenticate_cookie(force)

        if not force and self._token and time.time() < self._token_expires_at:
            return "bearer", {"Authorization": f"Bearer {self._token}"}

        if self.api_token and self.use_raw_api_token:
            self._token = self.api_token
            self._token_expires_at = time.time() + 3600
            return "bearer", {"Authorization": f"Bearer {self._token}"}

        if self.api_token:
            token = self._exchange_api_token()
            self._token = token
            self._token_expires_at = time.time() + 3600
            return "bearer", {"Authorization": f"Bearer {self._token}"}

        if self.auth_type == "basic":
            return "basic", {}

        token = self._keycloak_password_grant()
        self._token = token
        self._token_expires_at = time.time() + 3600
        return "bearer", {"Authorization": f"Bearer {self._token}"}

    def _authenticate_cookie(self, force: bool) -> tuple[str, dict[str, str]]:
        if not force and self._cookie_header:
            return "cookie", {"Cookie": self._cookie_header}

        if self.session_cookie:
            self._cookie_header = f"auth_session={self.session_cookie}"
            return "cookie", {"Cookie": self._cookie_header}

        # SSO environments (no username) fall back to an exchanged JWT - the
        # Design Center metadata endpoints accept that in addition to a cookie.
        if self.api_token and not self.username:
            token = self._exchange_api_token()
            self._token = token
            self._token_expires_at = time.time() + 3600
            return "bearer", {"Authorization": f"Bearer {self._token}"}

        self._cookie_header = self._acquire_session_cookie()
        return "cookie", {"Cookie": self._cookie_header}

    def _acquire_session_cookie(self) -> str:
        """Headless Keycloak authorization-code flow (ported verbatim from
        acquireSessionCookie() in AtScaleRestClientService.ts):
          1. GET /signin -> state cookie + Keycloak redirect URL
          2. GET <Keycloak login page> -> scrape the login form's action URL
          3. POST username/password to that URL -> 302 to /signin/callback?code=...
          4. GET the callback URL -> Set-Cookie: auth_session=... (or better-auth's
             __Secure-better-auth.session_token on newer AtScale builds)
        """
        if not self.username or not self.password:
            raise AtScaleAuthError(
                "Deploying requires Keycloak credentials to acquire the Design Center "
                "session cookie automatically. Add 'username' and 'password' to the "
                "atscale: block in connections.yaml."
            )

        session = requests.Session()
        session.verify = not self.insecure

        r1 = session.get(f"{self.base_url}/signin", allow_redirects=False)
        kc_url = r1.headers.get("Location", "")
        if not kc_url:
            raise AtScaleAuthError(
                f"{self.base_url}/signin did not redirect to Keycloak (status {r1.status_code}). "
                "Verify the AtScale URL is correct."
            )

        r2 = session.get(kc_url, allow_redirects=False)
        match = re.search(r'["\'`](https?:[^"\'`]+login-actions/authenticate[^"\'`]+)[`"\']', r2.text)
        if not match:
            raise AtScaleAuthError(
                "Could not extract the Keycloak login form action URL from the login page "
                "- the Keycloak theme may have changed."
            )
        form_action_url = match.group(1)

        r3 = session.post(
            form_action_url,
            data={"username": self.username, "password": self.password},
            allow_redirects=False,
        )
        if not (300 <= r3.status_code < 400):
            raise AtScaleAuthError(
                f"Keycloak login failed (status {r3.status_code}). "
                "Check username/password in connections.yaml's atscale: block."
            )
        raw_location = r3.headers.get("Location", "")
        callback_url = raw_location if raw_location.startswith("http") else f"{self.base_url}{raw_location}"

        session.get(callback_url, allow_redirects=False)

        cookie_names = ("auth_session", "__Secure-better-auth.session_token")
        if not any(c in session.cookies for c in cookie_names):
            raise AtScaleAuthError(
                "/signin/callback did not set a session cookie (expected auth_session or "
                "__Secure-better-auth.session_token). The Keycloak code exchange may have failed."
            )
        return "; ".join(f"{c.name}={c.value}" for c in session.cookies)

    def _exchange_api_token(self) -> str:
        resp = requests.post(
            f"{self.base_url}/v1/token",
            headers={"Authorization": f"Bearer {self.api_token}"},
            json={},
            verify=not self.insecure,
        )
        if resp.status_code >= 300:
            raise AtScaleAuthError(f"API token exchange failed: {resp.status_code} {resp.text}")
        return resp.json()["accessToken"]

    def _keycloak_password_grant(self) -> str:
        form = {
            "client_id": self.client_id,
            "grant_type": "password",
            "username": self.username,
            "password": self.password,
            "scope": "openid",
        }
        if self.client_secret:
            form["client_secret"] = self.client_secret
        resp = requests.post(self._keycloak_token_url(), data=form, verify=not self.insecure)
        if resp.status_code >= 300:
            raise AtScaleAuthError(f"Keycloak auth failed: {resp.status_code} {resp.text}")
        return resp.json()["access_token"]


class AtScaleClient:
    """Dispatches requests against AtScale's /wapi/p/ REST API with retry-on-401,
    mirroring RestClientService.dispatch()."""

    def __init__(self, env: AtScaleEnvironment):
        self.env = env

    def _dispatch(self, method: str, path: str, is_retry: bool = False, **kwargs: Any) -> requests.Response:
        scheme, headers = self.env.authenticate(force=is_retry)
        auth = None
        if scheme == "basic":
            auth = (self.env.username or "", self.env.password or "")
        req_headers = {**kwargs.pop("headers", {}), **headers}
        url = f"{self.env.base_url}{path}"
        resp = requests.request(
            method,
            url,
            headers=req_headers,
            auth=auth,
            verify=not self.env.insecure,
            **kwargs,
        )
        if resp.status_code == 401 and not is_retry:
            self.env.invalidate()
            return self._dispatch(method, path, is_retry=True, **kwargs)
        if resp.status_code >= 300:
            raise AtScaleApiError(resp.status_code, resp.text, url)
        return resp

    # -- data sources / schema tree (Build) - copied from sml-wizard api/atscale/client.py --
    def list_data_sources(self) -> list[dict[str, Any]]:
        return self._dispatch("GET", "/wapi/p/data-warehouses").json()

    # -- schema tree (warehouse-agnostic through AtScale's own metadata API) --------
    # NOTE: `connection_id` here is the data-warehouse's `connectionId` field (a
    # name-based string, e.g. "PostgresDB") - confirmed against a real instance.
    # The warehouse's own `id` (a UUID) and the inner `connections[].id` both 404 /
    # 500 ("ConnectionGroup ... not found") on this path family.
    def list_databases(self, connection_id: str) -> list[str]:
        path = f"/wapi/p/data-sources/conn/{connection_id}/databases"
        return self._dispatch("GET", path).json()

    def list_schemas(self, connection_id: str, database: str) -> list[str]:
        path = f"/wapi/p/data-sources/conn/{connection_id}/databases/{database}/schemas"
        return self._dispatch("GET", path).json()

    def list_tables(self, connection_id: str, database: str, schema: str) -> list[str]:
        # Confirmed shape: a plain list of table-name strings, not objects.
        path = f"/wapi/p/data-sources/conn/{connection_id}/databases/{database}/schemas/{schema}/tables"
        return self._dispatch("GET", path).json()

    def get_table_info(self, connection_id: str, database: str, schema: str, table: str) -> dict[str, Any]:
        path = (
            f"/wapi/p/data-sources/conn/{connection_id}/databases/{database}"
            f"/schemas/{schema}/tables/{table}/info"
        )
        return self._dispatch("GET", path).json()

    # -- data discovery (Build > Discovery) -------------------------------------------
    def query_sample(self, connection_id: str, query: str, timeout: float | None = 600) -> dict[str, Any]:
        """POST /wapi/p/data-sources/conn/{id}/query/sample {query, udf} - runs SQL on
        the warehouse through AtScale's own connection (SML-develop apps/api
        data-sources.controller.ts :: getRawData -> engine DatasourceRest.scala ::
        getQuerySampleData). The engine wraps the query as
        `SELECT * FROM (<query>) as_subselect_tmp LIMIT 10` (DB.scala ::
        getQuerySampleData) and caches the result by query text for its lifetime.
        -> {columns: [{name, column-type}], rows: [{values: [str|None]}]}"""
        body = self._dispatch("POST", f"/wapi/p/data-sources/conn/{connection_id}/query/sample",
                              json={"query": query, "udf": None}, timeout=timeout).json()
        # The SML API passes the engine envelope through (unlike /databases etc.).
        return body.get("response", body) if isinstance(body, dict) else {}

    def get_table_sample(self, connection_id: str, database: str, schema: str, table: str,
                         limit: int = 100) -> dict[str, Any]:
        """GET /engine/v1/datasources/{id}/sample-data/{schema}/{table}?database&limit
        (mcp-develop engine/client.py :: get_sample_data; engine
        DataSourceSampleDataController, limit clamped to 1..10000).
        -> {columns: [{name, ...}], rows: [[...]], rowCount}"""
        path = f"/engine/v1/datasources/{quote(connection_id, safe='')}/sample-data/" \
               f"{quote(schema, safe='')}/{quote(table, safe='')}"
        body = self._dispatch("GET", path, params={"database": database, "limit": limit}, timeout=120).json()
        return body.get("response", {}) if isinstance(body, dict) else {}

    def list_datasource_statistics(self, connection_id: str) -> list[dict[str, Any]]:
        """GET /engine/v1/datasources/{id}/statistics - the engine's cached RowCount /
        Cardinality statistics (mcp-develop engine/client.py :: get_statistics,
        engine/datasources.py :: parse_statistics). Empty until the engine's
        background statistics workers have run."""
        path = f"/engine/v1/datasources/{quote(connection_id, safe='')}/statistics"
        body = self._dispatch("GET", path, timeout=60).json()
        response = body.get("response", {}) if isinstance(body, dict) else {}
        values = response.get("values", []) if isinstance(response, dict) else []
        return values if isinstance(values, list) else []

    # -- repos (git attach)----------------------------------------------------------
    def list_repos(self) -> list[dict[str, Any]]:
        return self._dispatch("GET", "/wapi/p/repo").json()

    def create_repo(
        self, name: str, url: str, repo_type: str = "catalog",
        visible_branches_pattern: str | None = None, default_branch: str | None = None,
    ) -> dict[str, Any]:
        body: dict[str, Any] = {"name": name, "url": url, "type": repo_type}
        if visible_branches_pattern:
            body["visibleBranchesPattern"] = visible_branches_pattern
        if default_branch:
            body["defaultBranch"] = default_branch
        return self._dispatch("POST", "/wapi/p/repo", json=body).json()

    def delete_repo(self, repo_id: str) -> dict[str, Any]:
        """Unregisters a repo attachment (/wapi/p/repo/{id}) - not documented
        in ps-utils (which only ever connects/lists), but confirmed to exist
        and work against a real instance. Doesn't touch the actual Git repo
        or anything already deployed from it - just AtScale's own record
        that it's attached, e.g. for cleaning up a repo whose Git side has
        since been deleted."""
        resp = self._dispatch("DELETE", f"/wapi/p/repo/{repo_id}")
        return resp.json() if resp.text else {}

    # -- deployments / catalogs -----------------------------------------------------------
    def list_deployed_projects(self) -> list[dict[str, Any]]:
        # ps-utils AtScaleRestClientService.ts :: ListModelsRequest (atScaleListDeployments)
        return self._dispatch("GET", "/wapi/p/projects/deployed").json()

    def list_published_catalogs(self) -> list[dict[str, Any]]:
        """[{id, name, caption, publishedAt, publishedBy, models[...]}] - Container
        API "Get catalogs" (GET /v1/catalogs); SML public-api-sdk CatalogsApi."""
        return self._dispatch("GET", "/v1/catalogs", timeout=30).json()

    def deploy_catalog_from_git(
        self, repo_url: str, branch: str, git_token: str, git_username: str | None = None,
    ) -> dict[str, Any]:
        """Container API "Deploy from Git" (POST /v1/catalogs/deploy): AtScale
        clones `repo_url@branch` and compiles the SML itself. Returns
        {catalogId, tableau, compilationWarnings}."""
        body: dict[str, Any] = {"repoUrl": repo_url, "gitToken": git_token, "branch": branch}
        if git_username:
            body["gitUsername"] = git_username
        return self._dispatch("POST", "/v1/catalogs/deploy", json=body, timeout=300).json()

    def get_catalog(self, catalog_id: str) -> dict[str, Any]:
        """GET /wapi/p/catalog/{id} -> {id, name, version, models[{id, connection_ids}], publishedAt}
        (SML-develop api-sdk CatalogApi.ts :: catalogControllerGetOne)."""
        return self._dispatch("GET", f"/wapi/p/catalog/{catalog_id}", timeout=30).json()

    def undeploy_catalog(self, catalog_id: str) -> Any:
        """DELETE /wapi/p/catalog/{catalogId} - what Design Center's "Undeploy"
        calls (SML-develop api-sdk CatalogApi.ts :: catalogControllerUndeploy,
        apps/web/services/proxies/project-api-proxy.ts). Whole catalog only; the
        engine drops its aggregates with it. Returns [engineError, tableauError]."""
        resp = self._dispatch("DELETE", f"/wapi/p/catalog/{catalog_id}", timeout=120)
        return resp.json() if resp.text else []

    # -- aggregates (Container API /v1, cross-checked with ps-utils + SML public-api-sdk) --
    def list_aggregates(self, catalog_id: str, model_id: str, page_size: int = 100) -> list[dict[str, Any]]:
        """Aggregate definitions incl. `blocked`, `type`, `attributes`, latest/active
        instance - GET /wapi/p/aggregate/definition (SML-develop api-sdk
        AggregateApi.ts :: aggregateControllerGetDefinitions, Design Center's own
        list). Engine snake_case fields. Used instead of the public GET
        /v1/aggregates, which on current container builds ignores page/size and
        returns only the first 10."""
        out: list[dict[str, Any]] = []
        page = 1
        while True:
            body = self._dispatch(
                "GET", "/wapi/p/aggregate/definition",
                params={"catalogId": catalog_id, "modelId": model_id, "page": page, "limit": page_size},
                timeout=90,
            ).json()
            data = body.get("data") or []
            out.extend(data)
            if not data or len(out) >= int(body.get("total") or 0):
                return out
            page += 1

    def list_aggregate_build_history(self, catalog_id: str, model_id: str, limit: int = 20) -> list[dict[str, Any]]:
        # ps-utils AtScaleRestClientService.ts :: GetAggregateBuildHistoryRequest
        params = {"page": 1, "limit": limit, "catalogId": catalog_id, "modelId": model_id}
        return self._dispatch("GET", "/wapi/p/aggregate/batch-history", params=params, timeout=30).json().get("data", [])

    def rebuild_aggregates(self, catalog_id: str, model_id: str, full_build: bool) -> dict[str, Any]:
        # ps-utils AtScaleRestClientService.ts :: RebuildAggregatesRequest
        path = f"/v1/aggregates-batch/catalogs/{catalog_id}/models/{model_id}"
        return self._dispatch(
            "POST", path, params={"isFullBuild": "true" if full_build else "false"},
            json={"gracePeriodOverrides": {}}, timeout=60,
        ).json()

    def block_aggregate(self, definition_id: str) -> dict[str, Any]:
        """PUT /v1/aggregates/definitions/{id}/block -> {blocked} (Container API
        "aggregate-block"; SML public-api-sdk AggregateDetailsApi.ts). Engine side
        is DELETE /aggregates/definitionId/{id}?block=true, the installer call
        PythonAtscaleUtility uses."""
        return self._dispatch("PUT", f"/v1/aggregates/definitions/{definition_id}/block", timeout=30).json()

    def unblock_aggregate(self, definition_id: str) -> dict[str, Any]:
        """PUT /v1/aggregates/definitions/{id}/unblock -> {unblocked}."""
        return self._dispatch("PUT", f"/v1/aggregates/definitions/{definition_id}/unblock", timeout=30).json()

    def delete_aggregate(self, definition_id: str) -> dict[str, Any]:
        """DELETE /v1/aggregates/definitions/{id} -> {deleted} (Container API "aggregate-delete")."""
        return self._dispatch("DELETE", f"/v1/aggregates/definitions/{definition_id}", timeout=30).json()

    def export_aggregates(self, catalog_id: str, model_id: str) -> dict[str, Any]:
        # ps-utils AtScaleRestClientService.ts :: ExportAggregatesRequest (system-defined only)
        path = f"/v1/aggregates/export/catalogs/{catalog_id}/models/{model_id}"
        return self._dispatch("GET", path, timeout=60).json()

    def import_aggregates(
        self, catalog_id: str, model_id: str, payload: dict[str, Any], connection_remap: list[str] | None = None,
    ) -> dict[str, Any]:
        # ps-utils AtScaleRestClientService.ts :: ImportAggregatesRequest
        params: dict[str, Any] = {"importDistributionKey": "true", "importPartitionKeys": "true", "importReplication": "true"}
        if connection_remap:
            params["connectionRemap"] = connection_remap
        path = f"/v1/aggregates/import/catalogs/{catalog_id}/models/{model_id}"
        return self._dispatch("POST", path, params=params, json=payload, timeout=120).json()

    # -- cube data preview (Build > Preview) - copied from sml-wizard api/atscale/client.py --
    # Same bearer-JWT session as every /wapi/p/* call above - the container-mode
    # AtScale deployment this wizard targets proxies both the XMLA and query/submit
    # engines through the main host (no separate :10502 port or Basic-auth XMLA
    # login, unlike the installer-mode pattern some standalone AtScale tools use).
    def run_xmla(self, xml_body: str, timeout: float | None = None) -> str:
        # timeout: the Test harness bounds every query (None = wait, as before)
        return self._dispatch(
            "POST", "/engine/xmla", data=xml_body.encode("utf-8"), headers={"Content-Type": "text/xml"}, timeout=timeout
        ).text

    def submit_query(self, payload: dict[str, Any], timeout: float | None = None) -> str:
        return self._dispatch("POST", "/engine/query/submit", json=payload, timeout=timeout).text
