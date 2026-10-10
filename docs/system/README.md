# System Reference

Background material on the AtScale platform and the conventions and algorithms that ps-utils builds on. For per-operation usage, see the API references in [`../reference/`](../reference/).

| Document | Description |
|----------|-------------|
| [ARCHITECTURE.md](ARCHITECTURE.md) | AtScale platform architecture — Kubernetes/Helm components, request routing, storage and warehouse connections, and key deployment decisions |
| [STYLE.md](STYLE.md) | SML naming conventions — label style and casing rules for metrics, dimensions, hierarchies, levels, and secondary attributes, as controlled by `sml.style.yaml` |
| [sml.style.yaml](sml.style.yaml) | Annotated reference style config — every `sml.style.yaml` parameter with its default and an explanation; copy it into a working directory as a starting point |
| [STATISTICS.md](STATISTICS.md) | Statistical fingerprint algorithm — how data shape is profiled, obfuscated, and reconstructed into DDL and synthetic data, plus security and compliance controls |
| [VERTICALS.md](VERTICALS.md) | Industry verticals guide — the pre-built DDL schemas and SML models for 15 verticals and the end-to-end pipeline for using them |
