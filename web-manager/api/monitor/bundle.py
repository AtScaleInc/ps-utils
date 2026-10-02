"""PS bundle: the engine support zip (GET /engine/support) plus each deployed catalog's
SML, unpacked, and each deployed model's aggregates.

The engine's EngineMetadata provider writes metadata/<catalog-id>/project.xml and, next
to it, yaml_files.zip - the SML the engine was deployed from (engine-develop
support/providers/EngineMetadataProvider.scala). The Design Center bundle has only the
project.xml. Here every yaml_files.zip is also unpacked into sml/<catalog name>/, named
by project.xml's root `name`, so the deployed SML reads without a nested zip keyed by UUID.

Aggregates come from the host's backend per deployed model (the Manage tab's list and
the Promote export) instead of the engine's AggregateData provider, whose raw table
dumps aren't keyed by model: aggregates/<catalog>/<model>/ holds aggregates.csv (one
readable row each), aggregates.json (the same rows) and export.json (the system-defined
ones, in the import payload shape Promote uses).
"""

from __future__ import annotations

import copy
import csv
import io
import json
import re
import shutil
import zipfile
from typing import IO, Any

_NAME = re.compile(rb"<[A-Za-z][\w:.-]*\b[^>]*?\sname=\"([^\"]+)\"")


def _safe(name: str, fallback: str) -> str:
    return re.sub(r"[^\w .-]+", "_", name).strip(" .") or fallback


def _catalog_name(project_xml: bytes, fallback: str) -> str:
    """The root element's name attribute (the XML prolog and comments are skipped)."""
    m = _NAME.search(re.sub(rb"<\?.*?\?>|<!--.*?-->", b"", project_xml, flags=re.S))
    name = m.group(1).decode("utf-8", "replace") if m else fallback
    return _safe(name, fallback)


_CSV_COLS = ["name", "type", "status", "active", "size", "lastBuild", "dimensions", "keys", "measures",
             "statusNote", "id"]


def _csv_row(agg: dict[str, Any]) -> dict[str, Any]:
    """The signature ("type:name|...", backend.agg_signature) split back into columns.
    A measure appears once per aggregation function it carries; each name is listed once."""
    by: dict[str, list[str]] = {}
    for part in filter(None, (agg.get("signature") or "").split("|")):
        kind, _, name = part.partition(":")
        if name not in by.setdefault(kind, []):
            by[kind].append(name)
    return {**{k: agg.get(k) for k in _CSV_COLS}, **{k: "; ".join(by.get(k[:-1], [])) for k in ("dimensions", "keys", "measures")}}


def aggregate_files(backend: Any) -> dict[str, bytes]:
    """aggregates/<catalog>/<model>/... for every deployed model; a model that fails
    gets an error.txt rather than failing the bundle."""
    files: dict[str, bytes] = {}
    used: set[str] = set()
    for m in backend.agg_models():
        d = f"aggregates/{_safe(m.get('catalog') or '', m['catalogId'])}/{_safe(m.get('name') or '', m['modelId'])}"
        if d in used:
            d = f"{d} ({m['modelId'][:8]})"
        used.add(d)
        try:
            rows = backend.list_aggregates(m["catalogId"], m["modelId"])
            system = [r["id"] for r in rows if r.get("type") == "SYSTEM"]
            export = backend.export_aggregates(m["catalogId"], m["modelId"], system) if system else None
        except Exception as e:  # noqa: BLE001 - one model's failure is reported in its folder
            files[f"{d}/error.txt"] = f"{type(e).__name__}: {e}\n".encode()
            continue
        buf = io.StringIO()
        w = csv.DictWriter(buf, _CSV_COLS)
        w.writeheader()
        w.writerows(_csv_row(r) for r in rows)
        files[f"{d}/aggregates.csv"] = buf.getvalue().encode()
        files[f"{d}/aggregates.json"] = json.dumps({**m, "aggregates": rows}, indent=2).encode()
        if export is not None:
            files[f"{d}/export.json"] = json.dumps(export, indent=2).encode()
    return files


def add_sml(src: IO[bytes], out: IO[bytes], extra: dict[str, bytes] | None = None) -> int:
    """Copy the zip `src` to `out`, adding <root>/sml/<catalog>/... for every
    metadata/<id>/yaml_files.zip, and `extra` (paths relative to the bundle's root
    folder). Returns the number of catalogs unpacked."""
    with zipfile.ZipFile(src) as zin, zipfile.ZipFile(out, "w", zipfile.ZIP_DEFLATED) as zout:
        for info in zin.infolist():
            # A copy: writing sets header_offset on the ZipInfo, which zin still reads by.
            with zin.open(info) as r, zout.open(copy.copy(info), "w") as w:
                shutil.copyfileobj(r, w)

        used: set[str] = set()
        n = 0
        for info in zin.infolist():
            parts = info.filename.split("/")
            if len(parts) < 3 or parts[-1] != "yaml_files.zip" or parts[-3] != "metadata":
                continue
            root, cat_id = "/".join(parts[:-3]), parts[-2]
            xml_path = "/".join([*parts[:-1], "project.xml"])
            xml = zin.read(xml_path) if xml_path in zin.namelist() else b""
            name = _catalog_name(xml, cat_id)
            if name in used:
                name = f"{name} ({cat_id[:8]})"
            used.add(name)
            prefix = "/".join(p for p in (root, "sml", name) if p)
            with zipfile.ZipFile(io.BytesIO(zin.read(info))) as sml:
                for f in sml.infolist():
                    if f.is_dir() or f.filename.startswith("/") or ".." in f.filename.split("/"):
                        continue
                    zout.writestr(f"{prefix}/{f.filename}", sml.read(f))
            n += 1

        root = zin.namelist()[0].split("/")[0] if zin.namelist() and "/" in zin.namelist()[0] else ""
        for path, data in (extra or {}).items():
            zout.writestr(f"{root}/{path}" if root else path, data)
        return n
