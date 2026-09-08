# Vendored SML language reference

The `*.md` files in this directory are **verbatim copies** of the SML language
specification. They are the input to `src/scripts/generate-sml-schema.ts`, which
derives the JSON Schemas and TextMate grammar shipped by the VS Code extension.

Do not hand-edit them. Edits here are silently lost on the next refresh, and any
correction belongs upstream.

## Source

| | |
|---|---|
| Repository | <https://github.com/semanticdatalayer/SML> |
| Path | `sml-reference/` |
| Pinned commit | `63e1dcb0eb4f3f284e439268cd3267077116dadb` |
| Commit date | 2026-08-12 |
| Commit subject | Merge pull request #54 from semanticdatalayer/draft/v1.8 |
| License | Apache 2.0 |

Vendoring at a pinned commit keeps `npm run build` deterministic and offline, and
turns an upstream specification change into a reviewable diff rather than a
silent shift in what the editor accepts.

## Refreshing

```bash
SHA=<new-commit-sha>
for f in calculation catalog composite-model connection dataset dimension \
         metric model package row-security; do
  curl -sSfL "https://raw.githubusercontent.com/semanticdatalayer/SML/$SHA/sml-reference/$f.md" \
    -o "resources/sml-reference/$f.md"
done
npm run generate:sml-schema      # will fail loudly if the docs grew a new shape
```

Then update the pinned commit in the table above and review the resulting diff in
`vscode-extension/media/sml-schema/`.

The generator asserts its own assumptions, so a refresh that introduces an
unrecognised structure (a new `# <Noun> Properties` section, a property with no
`Type`/`Required` bullet) fails the build instead of quietly dropping properties.
See the header comment in `src/scripts/generate-sml-schema.ts` for the parsing
strategies and the two hand-maintained tables.

## Spec version coverage

These docs carry `Added in` markers for v1.2 through **v1.8**, so the generated
schemas describe the union of everything up to v1.8.

`src/algorithm/sml-serializer.ts` targets **v1.5**. That skew is safe in this
direction: a later spec is a superset, so v1.5 output still validates. It does
mean the editor will offer completions for properties the serializer does not yet
emit.

## Known documentation gaps

The upstream docs lag the implementation in at least one place, which is why the
generated schemas set `additionalProperties: true`:

- `visualize_in_bi_tool` — emitted by `src/algorithm/sml-serializer.ts` on level
  attribute references, documented in none of the 10 files.

Known-undocumented keys are listed in `KNOWN_UNDOCUMENTED` in the generator so
they are tracked deliberately rather than absorbed by a permissive schema.
