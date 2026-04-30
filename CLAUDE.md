# CLAUDE.md — Project conventions for Claude Code

## Documentation — always keep in sync with code

When making any code change, update the following files as part of the same change (not as a separate follow-up):

- **README.md** — update if the change adds/modifies operations, parameters, or behavior
- **ACTIONS.md** — update if the change affects GitHub Actions usage
- **action.yml** — update if the change adds/modifies operations or parameters exposed to the composite action

## Adding a new SML style parameter

Three files must always be updated together:

1. `src/operations/sml-style-config.ts` — add the field to `SmlStyleConfig`, `MergedSmlStyle`, `SML_STYLE_DEFAULTS`, and `mergeSmlStyle()`
2. `resources/style/sml.style.yaml` — add the parameter with its default value and an explanatory comment
3. `src/algorithm/report-generator.ts` → `buildStyleGuide()` — extend the generated STYLE.md to reflect the new parameter

`resources/style/sml.style.yaml` is the canonical reference that users copy as a starting point; the generated STYLE.md must stay consistent with it.

## Closing a pg Client connected to AtScale's SQL port

`client.end()` hangs indefinitely — AtScale's Postgres-compatible proxy never sends the TCP FIN after receiving a Terminate message. Always use this pattern in `SqlService.close()`:

```typescript
await Promise.race([
  connection.client.end().catch(() => {}),
  new Promise<void>((resolve) => setTimeout(resolve, 1_000)),
]);
const stream = (connection.client as any).connection?.stream;
if (stream && typeof stream.destroy === "function") {
  stream.destroy();
}
```

This applies to any pg Client on AtScale's SQL analytics port (currently 15432), including connections pre-negotiated via `preNegotiateSslPlaintext`.

## AtScale REST API paths

The Design Center REST API is served at `/wapi/p/`:

| Method | Path | Purpose |
|--------|------|---------|
| `POST` | `/wapi/p/data-warehouses/{dialect}` | Create data source |
| `GET`  | `/wapi/p/data-warehouses` | List data sources |
| `GET`  | `/wapi/p/repos` | List git repos |
| `POST` | `/wapi/p/catalogs` | Deploy model |
| `GET`  | `/wapi/p/catalogs` | List models |

**Authentication:** use `apiToken` from the connections file. The code exchanges it for a short-lived JWT via `POST /v1/token` with `Authorization: Bearer <apiToken>`. The JWT is cached and refreshed on 401.

Do not use `/v1/public/<resource>` or `/v1/<resource>` paths — nginx maps `/v1/` differently and returns empty or doubled paths.

**PostgreSQL data source body — required fields:**
- `isImpersonationEnabled`, `isCanaryAlwaysEnabled`, `isPartialAggHitEnabled`
- `extraProperties: { udafMode: "udaf_disabled", udafSchema: "" }` (lowercase `udaf_disabled`)
- `access: { users: [], groups: [{ name: "everyone" }] }` — non-existent users cause a 500
- `isKerberosClientEnabled: false`

## Naming conventions

| Thing | Convention | Example |
|-------|-----------|---------|
| Operation directory | `kebab-case` | `generate-sml-from-connection` |
| Operation class | `PascalCase` + `Operation` | `GenerateSMLFromConnectionOperation` |
| Operation `name` property | `kebab-case`, matches directory | `"generate-sml-from-connection"` |
| Parameter set class | `PascalCase` + `Params` | `GenerateSMLFromConnectionParams` |
| CLI flag names | `kebab-case` | `--connection-file`, `--output-file` |
| Operation file | Named after the class | `GenerateSMLFromConnectionOperation.ts` |
| Service class | `PascalCase` + `Service` | `YamlService`, `AtScaleRestClientService` |
| Service registry key | `kebab-case` | `services.get("yaml")` |

**Acronyms** are preserved as uppercase in class names: `DDL`, `SML`, `MDX`, `XMLA`. `AtScale` is always written as `AtScale` (not `Atscale`).

**Operation file layout:** each operation lives in its own directory under `src/operations/<operation-name>/` containing a single `<OperationClass>.ts` file (plus any `.ejs` templates if needed).

**Adding a new operation:** register it in `src/operations/index.ts` (import + `registry.register(...)`), add it to the grouped list in `printUsage()` in `src/cli-runner.ts`, and update docs (see Documentation section above).

## Connections file

Use `example/connections.yaml` in the project root when a connections file is needed for testing or development. Do not use paths outside the project directory.
