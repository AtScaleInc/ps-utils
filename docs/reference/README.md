# API Reference

Per-operation reference for every way ps-utils can be invoked. Each document covers the same operation set, grouped the same way as the main [README](../../README.md). For background on the platform, conventions, and algorithms, see [`../system/`](../system/).

| Document | Description |
|----------|-------------|
| [ACTIONS.md](ACTIONS.md) | GitHub Actions guide — run any operation as a composite workflow step, with inputs, secrets, and examples |
| [NODE.md](NODE.md) | Node.js library API — the typed `async` function exported for every operation, with parameter tables |
| [GRAPHQL.md](GRAPHQL.md) | GraphQL API for the web services server — schema and per-operation mutations (auto-generated) |
| [REST.md](REST.md) | REST API for the web services server — endpoints and request bodies for every operation (auto-generated) |
| [DEVELOPER.md](DEVELOPER.md) | Developer guide — CLI framework architecture and how to add a new operation |

`GRAPHQL.md` and `REST.md` are generated from the operation registry during `npm run build`; do not edit them by hand.
