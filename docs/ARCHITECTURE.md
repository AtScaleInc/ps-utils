# AtScale Architecture

## Overview

AtScale runs as a Kubernetes deployment (installed via Helm) that sits between BI tools and data sources, providing a universal semantic layer. BI tools connect via XMLA/MDX or SQL; AtScale translates queries to native SQL and pushes them down to the underlying data warehouse.

## Architecture Diagrams

### Request Routing

How external clients reach AtScale services through the Nginx ingress.

```mermaid
flowchart LR
    subgraph CLIENTS["Clients and BI Tools"]
        USR["Admins (Browser)"]
        TAB["Tableau"]
        PBI["Power BI"]
        XL["Excel / Office"]
        MISC["Looker / MicroStrategy"]
    end

    NG["Nginx Ingress :443 / :15432"]

    subgraph CORE["AtScale Core Services"]
        DC["Design Center (Web UI)"]
        ENG["Query Engine (XMLA / MDX / SQL)"]
        API["REST API (/wapi/p/)"]
        AUTH["Auth Service (Keycloak)"]
    end

    USR -->|"HTTPS"| NG
    TAB & PBI & XL -->|"XMLA / MDX"| NG
    MISC -->|"SQL :15432"| NG

    NG -->|":443 /ui"| DC
    NG -->|":443 + :15432"| ENG
    NG -->|":443 /wapi/p/"| API
    NG -->|":443 /auth"| AUTH
```

### Internal Storage Connections

How core services read and write to internal storage.

```mermaid
flowchart LR
    subgraph CORE["Core Services"]
        DC["Design Center"]
        ENG["Query Engine"]
        AGG["Aggregation Manager"]
        API["REST API"]
        AUTH["Keycloak"]
    end

    subgraph STORE["Internal Services"]
        META[("PostgreSQL (Metadata)")]
        CACHE[("Redis (Query Cache)")]
        ZK["Zookeeper (Coordination)"]
    end

    DC & ENG & API & AUTH --> META
    ENG --> CACHE
    ENG --> AGG
    ENG & AGG -.- ZK
```

### Data Warehouse Connections

How the Query Engine and Aggregation Manager interact with external data sources.

```mermaid
flowchart LR
    ENG["Query Engine"]
    AGG["Aggregation Manager"]
    S3["Object Storage (S3 / Azure Blob)"]

    subgraph DW["Data Sources"]
        SF["Snowflake"]
        RS["Redshift"]
        BQ["BigQuery"]
        DBRK["Databricks / Delta Lake"]
        AZ["Azure Synapse"]
        OTHER["IRIS / PostgreSQL"]
    end

    ENG -->|"push-down SQL"| SF & RS & BQ & DBRK & AZ & OTHER
    AGG -->|"write aggregates"| SF & RS & BQ & DBRK
    AGG -->|"spill"| S3
```

### External Service Connections

How AtScale integrates with Git, identity providers, and observability.

```mermaid
flowchart LR
    DC["Design Center"]
    API["REST API"]
    AUTH["Keycloak"]
    ENG["Query Engine"]

    subgraph EXT["External Services"]
        GIT["Git (SML Repos)"]
        IDP["Identity Provider (LDAP / SAML / SSO)"]
        MON["Prometheus / Grafana"]
    end

    DC & API -->|"clone / commit SML"| GIT
    AUTH -->|"federate"| IDP
    ENG -.->|"metrics / traces"| MON
```

## Component Reference

### Ingress

| Component | Detail |
|---|---|
| **Nginx Ingress** | Entry point for all external traffic. Routes `:443` to Design Center, XMLA/MDX engine, REST API, and Auth. Routes `:15432` (Postgres-compatible) to the SQL Analytics interface of the Query Engine. |

### Core Pods

| Component | Detail |
|---|---|
| **Design Center** | Browser-based semantic layer designer. Used to build and manage SML models, connections, and deployments. Reads/writes model files to Git and model metadata to PostgreSQL. |
| **Query Engine** | Receives MDX/XMLA queries from BI tools and SQL queries from direct clients. Translates semantic queries to native SQL dialects and executes them against the connected data source via push-down. Returns results through the originating protocol. |
| **Aggregation Manager** | Monitors query patterns and cost estimates. Plans, creates, and refreshes pre-computed aggregate tables in the data warehouse to accelerate repeated queries. Coordinates with the Query Engine via Zookeeper. |
| **REST API (wapi)** | Management API served at `/wapi/p/`. Used to programmatically create connections, deploy models, list catalogs, and trigger operations. All `ps-utils` AtScale config operations call this API. |
| **Auth Service (Keycloak)** | Handles all authentication and session management. Delegates to external identity providers via LDAP or SAML/SSO. Issues short-lived JWTs consumed by the REST API and Design Center. |

### Internal Services

| Component | Detail |
|---|---|
| **PostgreSQL (Metadata)** | Stores model definitions, connection configurations, deployment state, query statistics, and user/role assignments. Central store for all AtScale state. |
| **Zookeeper** | Provides distributed coordination between Query Engine replicas and the Aggregation Manager. Manages leader election and shared configuration. |
| **Redis (Query Cache)** | Caches query results to avoid redundant push-down executions against the data warehouse. TTL-based invalidation. |

## Helm Chart Component Diagram

The diagram below reflects the actual subcharts and inter-service wiring in the `atscale` Helm chart (v2026.4.0).

```mermaid
flowchart TD
    EXT["External Clients (BI Tools / ML Pipelines / Browsers)"]

    subgraph ingress["Ingress Layer"]
        PROXY["atscale-proxy (NGINX :80/:443)"]
    end

    subgraph app["Application Services"]
        API["atscale-api (Design Center API :3001)"]
        ENGINE["atscale-engine (Query Engine) HTTP :10502 metrics :9095 pgwire :15432 thrift :11111"]
        SML["atscale-sml (SML Service :3000)"]
        ENT["atscale-entitlement (Entitlement :3002)"]
        MCP["atscale-mcp (MCP Server :3003)"]
        MON["atscale-monitor (Monitor :3004)"]
    end

    subgraph auth["Identity and Access"]
        KC["atscale-keycloak (Keycloak IdP :80/:443)"]
        KCDB[("keycloak-postgresql :5432")]
    end

    subgraph data["Data Stores"]
        DB[("atscale-db (PostgreSQL :5432)")]
        IMAGG[("in-mem-aggs (PostgreSQL :5432)")]
        REDIS[("atscale-redis (Redis 7.4 :6379)")]
    end

    subgraph obs["Observability"]
        OTEL["atscale-opentelemetry-collector (OTLP gRPC :4317 HTTP :4318)"]
    end

    EXT -->|HTTPS| PROXY
    PROXY -->|/api| API
    PROXY -->|/engine| ENGINE
    PROXY -->|/modeler| SML
    PROXY -->|/auth| KC
    PROXY -->|/mcp| MCP

    API -->|internalUrl| ENGINE
    API -->|internalUrl| ENT
    API -->|OIDC| KC
    SML -->|internalUrl| API
    SML -->|OIDC callback| KC
    ENGINE -->|queries| DB
    ENGINE -->|in-memory aggs| IMAGG
    ENGINE -->|cache / sessions| REDIS
    ENGINE -->|entitlement check| ENT
    ENGINE -->|OTLP traces and metrics| OTEL
    ENT -->|persistence| DB
    ENT -->|cache| REDIS
    ENT -->|token validation| KC
    MCP -->|OIDC| KC
    MON -->|OIDC| KC
    KC --- KCDB
```

### Helm Subchart Reference

| Subchart | Alias | Role | Default Port(s) | Conditional |
|---|---|---|---|---|
| `atscale-proxy` | `atscale-proxy` | NGINX reverse proxy, TLS termination | 80 / 443 | `atscale-proxy.enabled` |
| `atscale-api` | `atscale-api` | Design Center REST API | 3001 | Always |
| `atscale-engine` | `atscale-engine` | XMLA / MDX / SQL query engine | 10502 (HTTP), 15432 (pgwire), 11111 (thrift), 9095 (metrics) | Always |
| `atscale-sml` | `atscale-sml` | Semantic Model Layer service | 3000 | Always |
| `atscale-entitlement` | `atscale-entitlement` | License and entitlement enforcement | 3002 | Always |
| `atscale-mcp` | `atscale-mcp` | MCP (AI tool) server | 3003 | `atscale-mcp.enabled` |
| `atscale-monitor` | `atscale-monitor` | Ops monitoring service | 3004 | `atscale-monitor.enabled` |
| `atscale-keycloak` | `keycloak` | Identity provider (OIDC / OAuth2) | 80 / 443 | `keycloak.enabled` |
| `atscale-db` | `db` | Main PostgreSQL database | 5432 | `db.enabled` |
| `atscale-db` | `in-mem-aggs` | PostgreSQL for in-memory aggregations | 5432 | `in-mem-aggs.enabled` |
| `atscale-redis` | `redis` | Redis cache and session store | 6379 | `redis.enabled` |
| `atscale-opentelemetry-collector` | `telemetry` | Telemetry aggregator (OTLP) | 4317 (gRPC), 4318 (HTTP) | `global.atscale.telemetry.enabled` |

### External Connections

| Entity | Protocol / Interface | Direction |
|---|---|---|
| **Tableau Server** | XMLA / MDX over HTTPS | Inbound to Nginx |
| **Power BI** | XMLA / MDX over HTTPS | Inbound to Nginx |
| **Excel / Office** | MDX over OLE DB for OLAP | Inbound to Nginx |
| **Looker / MicroStrategy / Custom** | XMLA or SQL (`:15432`) | Inbound to Nginx |
| **Users / Admins** | Browser (HTTPS) or REST API | Inbound to Nginx |
| **Snowflake** | Push-down SQL (JDBC/ODBC) | Outbound from Query Engine |
| **Redshift** | Push-down SQL (JDBC) | Outbound from Query Engine |
| **BigQuery** | Push-down SQL (REST/JDBC) | Outbound from Query Engine |
| **Databricks / Delta Lake** | Push-down SQL (JDBC) | Outbound from Query Engine |
| **Azure Synapse** | Push-down SQL (JDBC) | Outbound from Query Engine |
| **IRIS** | Push-down SQL | Outbound from Query Engine |
| **PostgreSQL** | Push-down SQL | Outbound from Query Engine |
| **Git** | HTTPS (clone / push SML files) | Outbound from Design Center and REST API |
| **Identity Provider** | LDAP or SAML 2.0 / OIDC | Outbound from Auth Service |
| **Object Storage (S3 / Blob)** | Cloud SDK | Outbound from Aggregation Manager (aggregate spill) |
| **Prometheus / Grafana** | Prometheus scrape endpoint | Outbound from Query Engine (optional) |
