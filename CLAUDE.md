# CLAUDE.md — Project conventions for Claude Code

## Documentation — always keep in sync with code

When making any code change, update the following files as part of the same change (not as a separate follow-up):

- **README.md** — update if the change adds/modifies operations, parameters, or behavior
- **docs/ACTIONS.md** — update if the change affects GitHub Actions usage
- **action.yml** — update if the change adds/modifies operations or parameters exposed to the composite action
- **docs/NODE.md** — update if the change adds/modifies operations, parameters, or their descriptions (the Node.js library API reference). Also update `src/index.ts` to export any new operation function with appropriate defaults from `Object.assign`.
- **docs/GRAPHQL.md** — auto-generated; regenerate via `npm run generate:graphql-docs` (runs automatically during `npm run build`)
- **docs/REST.md** — auto-generated; regenerate via `npm run generate:rest-docs` (runs automatically during `npm run build`)

All six files must reflect every operation change before the change is considered complete.

The VS Code extension's operation catalogue is also auto-generated and needs no manual edits:

- **vscode-extension/media/operations.manifest.json** — auto-generated; regenerate via `npm run generate:extension-manifest`
- **vscode-extension/package.json** `contributes.commands/submenus/menus` — auto-generated from the manifest via `npm run generate:extension-contributes`

Both run automatically during `npm run build` (after the REST/GraphQL docs). They derive everything from the operation registry and `OPERATION_GROUPS`, so any operation/parameter change flows into the extension menus with no hand-editing. Never edit these two generated regions by hand.

## docs/NODE.md — Node.js library API reference

`docs/NODE.md` documents the typed `async` function exported from `src/index.ts` for every operation. It is written by hand and must be kept in sync with the code. When adding or modifying an operation:

1. Add the export type alias at the bottom of the operation's `Params` type block (e.g. `export type GenerateFooParams = Params;`).
2. Import the type in `src/index.ts` (both the `export type` block and the `import type` block).
3. Add an exported function in `src/index.ts` that calls `run("operation-name", Object.assign({...defaults}, p), o)`.
4. Add the operation to the correct `#### <Group Name>` section in `docs/NODE.md` with:
   - A TypeScript code example showing a minimal call
   - A `function` signature block
   - A parameter table with columns: Key, Type, Required, Default, Description
   - `[↑ Table of Contents](#table-of-contents)` immediately after the `###` heading
5. Add the operation to the TOC in `docs/NODE.md`.

Use the same group names and ordering as README.md.

## docs/GRAPHQL.md and docs/REST.md — regenerate when operations change

`docs/GRAPHQL.md` and `docs/REST.md` are auto-generated and **must never be edited by hand**. After any change to an operation definition, its parameters, or its description, regenerate both:

```bash
npm run generate:graphql-docs
npm run generate:rest-docs
```

Both run automatically as part of `npm run build`. The scripts live at:
- `src/scripts/generate-graphql-docs.ts` — builds GraphQL API docs via `buildOpMetas()` / `buildSdl()` in `graphql-server.ts`
- `src/scripts/generate-rest-docs.ts` — builds REST API docs via `buildOpMetas()` in `graphql-server.ts`

The generated output must follow the same documentation structure as README.md and docs/ACTIONS.md: operations grouped under `#### <Group Name>` section headers matching the TOC, with a `[↑ Table of Contents](#table-of-contents)` link after each operation heading. If the generator scripts do not produce this structure, update them.

## Adding a new SML style parameter

Three files must always be updated together:

1. `src/operations/sml-style-config.ts` — add the field to `SmlStyleConfig`, `MergedSmlStyle`, `SML_STYLE_DEFAULTS`, and `mergeSmlStyle()`
2. `docs/sml.style.yaml` — add the parameter with its default value and an explanatory comment
3. `src/algorithm/report-generator.ts` → `buildStyleGuide()` — extend the generated STYLE.md to reflect the new parameter

`docs/sml.style.yaml` is the canonical reference that users copy as a starting point; the generated STYLE.md must stay consistent with it.

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

## Mermaid diagrams — always use real newlines

When generating Mermaid diagram strings anywhere in the codebase (README output, report generators, plan-generator.ts, xml-converter.ts, etc.), always build the diagram by joining an array of lines with `"\n"` or a template literal — never by embedding the `\n` escape sequence as a literal two-character string inside a single-line string concatenation.

**Wrong** — produces a broken diagram with visible `\n` characters:
```typescript
const diagram = "```mermaid\ngraph LR\n  A --> B\n```";
```

**Correct** — real line feeds that Mermaid can parse:
```typescript
const lines = ["```mermaid", "graph LR", "  A --> B", "```"];
const diagram = lines.join("\n");
```

This applies to every place a Mermaid code block is assembled: `buildDimLibraryDiagram`, `buildDatasetConsolidationDiagram`, `buildBaseModelDiagram`, `buildMermaidDiagram` in the XML converter, inline diagrams in README sections, and any future diagram builders.

**Never use `\n` inside Mermaid node labels.** `htmlLabels` is disabled in this project, so `\n` inside a quoted label string is not interpreted as a line break — it renders as the literal two characters `\n`. Use a space or another inline separator instead:

**Wrong:**
```typescript
lines.push(`  ${id}["${name}\\n(${project})"]`);
```

**Correct:**
```typescript
lines.push(`  ${id}["${name} (${project})"]`);
```

## Operation body structure — group headers and back-to-TOC links

Inside the `## Operations` section of every documentation file (README.md, docs/ACTIONS.md, and generated docs/GRAPHQL.md / docs/REST.md), operations must be organized under group section headers that exactly match the TOC groupings. Add a `#### <Group Name>` heading before the first operation in each group. The group name must be identical to how it appears in the TOC.

Every operation heading must be immediately followed by a back-to-TOC link on the next line:

```markdown
### `operation-name`

[↑ Table of Contents](#table-of-contents)
```

When adding a new operation:
1. Find the correct `#### <Group Name>` section in `## Operations` (or add one if the group is new).
2. Insert the operation's `### \`name\`` block within that group, in the same order it appears in the TOC.
3. Include `[↑ Table of Contents](#table-of-contents)` immediately after the heading.

The group order in the body must match the group order in the TOC — do not reorder groups.

## Operation groupings — keep all three in sync

The CLI, README, and action.yml all define operation groups. Whenever you add, move, or rename an operation, update **all three** in the same change:

1. **`src/operations/operation-groups.ts` → `OPERATION_GROUPS`** — the authoritative list. `printUsage()` in `src/cli-runner.ts` imports it for CLI help, and `generate-extension-manifest.ts` consumes it for the VS Code extension menus. Groups and their membership must exactly match the README. Editing this array is what updates the CLI help and the extension menus.
2. **`README.md` — `### <Group Name>` sections** — each section has a Mermaid `flowchart` diagram showing the operations and their data flow. Add the new operation to the correct section diagram and the operation's own reference anchor (`click X href "#..."`). Group names and membership must match `OPERATION_GROUPS`.
3. **`action.yml` — composite action steps** — each operation has a corresponding `if: inputs.operation == '<name>'` step. Add a step for any new operation in the appropriate logical position.

Also update the TOC and body in **`docs/ACTIONS.md`** to add the operation in the correct group.

**Diagrams at the top of README.md** are one per group. Each diagram must include every operation in that group — no operation may be present in `OPERATION_GROUPS` but absent from the corresponding README diagram, and vice versa.

When in doubt about which group an operation belongs to, match what is already in `src/operations/operation-groups.ts`. Do not invent new groups without updating all three files.

## Connections file

Use `example/connections.yaml` in the project root when a connections file is needed for testing or development. Do not use paths outside the project directory.

## Branded document styling — standalone Markdown deliverables

When generating a **standalone Markdown document** meant to be read or converted to PDF (onboarding guides, engagement deliverables, runbooks, design docs — i.e. not the repo's auto-generated `docs/*.md` reference files), apply the AtScale brand style below instead of plain default Markdown. These rules match the house PDF template.

### Rules

1. **Embed a stylesheet.** Put an inline `<style>` block at the very top of the `.md` file (before the H1). Do not rely on external CSS files. Use the block in *Embedded stylesheet* below verbatim, adjusting only content-specific values if the user asks.
2. **Brand colors only** — never introduce other accent colors:
   | Token | Hex | Use |
   |-------|-----|-----|
   | Brand teal | `#00AB9F` | H2 section headings only |
   | Charcoal | `#434343` | H1 title and body text |
   | Black | `#000000` | H3 subheadings and table-header text |
   | Rule gray | `#CCCCCC` | table row rules and bullets |
3. **Font is Signika** (the AtScale brand typeface) for all headings and body, with a sans-serif fallback stack. Code/monospace spans use a monospace stack.
4. **No horizontal rules.** Never emit `---`/`***` thematic breaks or `<hr>`. Separate sections with headings and whitespace only.
5. **Emoji only when functional.** Remove decorative/topical emoji (☸️ ☁️ ❄️ and section-topic icons). Keep an emoji **only** when it is a defined legend/key marker used consistently — e.g. 🔒 = "access/permission required", 🛠️ = "hands-on practice". Define such markers once near the top of the document.
6. **Tables use horizontal rules only** — no vertical borders and no outer box. Bold header row with a heavier bottom rule; thin `#CCCCCC` rules between rows. (The embedded stylesheet already enforces this.)
7. **Heading hierarchy maps to the brand roles above:** `#` (H1) = charcoal document title; `##` (H2) = teal section headings; `###` (H3) = black subheadings. Do not skip levels to get a color.

### Embedded stylesheet

Place this at the top of the generated `.md`:

```html
<style>
@import url('https://fonts.googleapis.com/css2?family=Signika:wght@300;400;600;700&display=swap');

body, .markdown-body {
  font-family: "Signika", "Segoe UI", Helvetica, Arial, sans-serif;
  font-weight: 300;
  color: #434343;
  background-color: #FFFFFF;
  line-height: 1.5;
  max-width: 800px;
  margin: 0 auto;
}
h1 { font-family: "Signika", sans-serif; font-weight: 700; color: #434343; font-size: 2em; }
h2 { font-family: "Signika", sans-serif; font-weight: 600; color: #00AB9F; margin-top: 1.6em; }
h3 { font-family: "Signika", sans-serif; font-weight: 700; color: #000000; }
h4, h5, h6 { font-family: "Signika", sans-serif; color: #434343; }
strong, b { color: #000000; }
a { color: #00AB9F; }
code, pre { font-family: "SFMono-Regular", Consolas, "Liberation Mono", monospace; background-color: #FFFFFF; color: #000000; }
ul { list-style-type: disc; }
ul ul { list-style-type: circle; }
li { margin: 0.25em 0; }
hr { display: none; }
blockquote { background-color: #FFFFFF; color: #434343; border-left: 3px solid #00AB9F; margin: 1em 0; padding: 0.25em 1em; }

table { border-collapse: collapse; width: 100%; margin: 1em 0; }
th, td { text-align: left; padding: 0.5em 0.75em; border: none; }
thead th { color: #000000; font-weight: 700; border-bottom: 2px solid #434343; }
tbody tr { border-bottom: 1px solid #CCCCCC; }
tbody tr:last-child { border-bottom: 1px solid #434343; }
</style>
```

When converting these documents to PDF, keep the same fonts and colors so the Markdown and PDF stay visually identical.
