# SML corpus fixture

A snapshot of real `generate-sml-from-ddl` output, used by
`src/scripts/__tests__/generate-sml-schema.test.ts` to assert that the generated
JSON Schemas raise **zero** diagnostics against SML this toolchain actually
produces.

That assertion is the regression test for a specific hazard: the upstream SML
reference prose lags the implementation, so a schema that merely looks correct can
still red-squiggle valid files. `src/algorithm/sml-serializer.ts` emits
`visualize_in_bi_tool`, which appears in none of the ten reference documents — if
the schemas ever become strict, these fixtures fail first.

Covers five object types: `catalog`, `connection`, `dataset`, `dimension`, `model`.

## Why this is committed rather than generated

The obvious source DDL is `example/schema.ddl`, but `example/*` is gitignored, so
generating the corpus inside the test would pass locally and fail anywhere else.

## Refreshing

```bash
npm run build
node dist/cli.js generate-sml-from-ddl \
  --ddl-file example/schema.ddl \
  --output-dir /tmp/sml-corpus \
  --connection-name testconn \
  --database atscale \
  --schema atscale \
  --min-hierarchies-per-dim 0
cp -r /tmp/sml-corpus/{catalog.yml,connections,datasets,dimensions,models} \
  src/scripts/__tests__/fixtures/sml-corpus/
```

Only `.yml` files are read by the test; the generated `REPORT.md`, `STYLE.md` and
`sml.style.yaml` are not part of the fixture.
