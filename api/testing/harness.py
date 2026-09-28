"""Runs generated queries against hosts and records a result per query.

Ported from reference/ps-utils
src/operations/execute-atscale-query-harness/ExecuteAtScaleQueryHarnessOperation.ts:
  - buildSoapEnvelope (UseAggregates / GenerateAggregates / UseQueryCache /
    UseAggregateCache, defaults true / false / false / true)
  - executeXmlaQuery: row count = <Value> elements inside <CellData>, checksum =
    SHA1 of the SOAP Body (the Header carries per-request session ids), minus
    the LastDataUpdate / LastSchemaUpdate timestamps (see _VOLATILE)
  - executeSqlQueryOnConn: checksum = SHA1 of rows serialised with columns
    sorted, values tab-joined, rows newline-joined
  - buildQueryAnnotation: /* {run_id, run_query_uuid, original_text_hash} */
  - runQueriesOnce: N workers pulling from one queue, throttle between queries
  - toCsv: same columns as the harness's results CSV

Container hosts only: XMLA goes to /engine/xmla and SQL to /engine/query/submit
on the host's existing AtScaleClient session (the harness's SQL path opens a
native Postgres connection to AtScale's SQL port instead - not configured per
host here).
"""

from __future__ import annotations

import csv
import hashlib
import io
import json
import re
import secrets
import threading
import time
import uuid
from concurrent.futures import ThreadPoolExecutor
from datetime import date
from typing import Any, Callable
from xml.sax.saxutils import escape

from atscale.client import AtScaleApiError

from .generate import sha256hex
from .results import mdx_rows, sql_rows

_BODY = re.compile(r"<[A-Za-z0-9_]*:?Body[^>]*>([\s\S]*)</[A-Za-z0-9_]*:?Body>", re.I)
_CELLDATA = re.compile(r"<[A-Za-z0-9_]*:?CellData[^>]*>([\s\S]*?)</[A-Za-z0-9_]*:?CellData>", re.I)
# ps-utils uses <[A-Za-z0-9_]*:?Value, which also matches <FmtValue> and so
# counts every formatted cell twice; the prefix here must end in ':'.
_VALUE = re.compile(r"<(?:[A-Za-z0-9_]+:)?Value[\s>/]", re.I)
QUERY_TIMEOUT_S = 180
# Per-response timestamps inside the Body (OlapInfo / CubeInfo): they change on
# every call, even on one host, so ps-utils' Body checksum never matches across
# runs. Stripped before hashing so equal results give equal checksums.
_VOLATILE = re.compile(r"<([A-Za-z0-9_]*:?)(LastDataUpdate|LastSchemaUpdate)\b[^>]*>[^<]*</\1\2>", re.I)
_FAULT = re.compile(r"<faultstring>([\s\S]*?)</faultstring>", re.I)
_SQL_ERR = re.compile(r"<error-message>([\s\S]*?)</error-message>", re.I)


def generate_run_id() -> str:
    # generateRunId: YYYY-MM-DD-XXXXXXXXXX
    return f"{date.today().isoformat()}-{secrets.token_hex(5).upper()}"


def annotation(run_id: str, run_query_id: str, text_hash: str) -> str:
    return "/* " + json.dumps({"run_id": run_id, "run_query_uuid": run_query_id,
                               "original_text_hash": text_hash}, separators=(",", ":")) + " */\n"


def soap_envelope(mdx: str, catalog: str, cube: str, opts: dict[str, bool]) -> str:
    b = lambda k: "true" if opts[k] else "false"  # noqa: E731
    return f"""<Envelope xmlns="http://schemas.xmlsoap.org/soap/envelope/">
  <Body>
    <Execute xmlns="urn:schemas-microsoft-com:xml-analysis">
      <Command><Statement>{escape(mdx)}</Statement></Command>
      <Properties>
        <PropertyList>
          <Cube>{escape(cube)}</Cube>
          <Catalog>{escape(catalog)}</Catalog>
          <UseAggregates>{b('useAggregates')}</UseAggregates>
          <GenerateAggregates>{b('generateAggregates')}</GenerateAggregates>
          <UseQueryCache>{b('useQueryCache')}</UseQueryCache>
          <UseAggregateCache>{b('useAggregateCache')}</UseAggregateCache>
        </PropertyList>
      </Properties>
    </Execute>
  </Body>
</Envelope>"""


def _error_text(e: Exception) -> str:
    body = e.body if isinstance(e, AtScaleApiError) else str(e)
    m = _FAULT.search(body) or _SQL_ERR.search(body)
    if m:
        return m.group(1).strip()
    return f"HTTP {e.status}: {body[:200]}" if isinstance(e, AtScaleApiError) else str(e)[:300]


def execute_xmla(api: Any, mdx: str, catalog: str, cube: str, opts: dict[str, bool]) -> dict[str, Any]:
    start = time.monotonic()
    try:
        body = api.run_xmla(soap_envelope(mdx, catalog, cube, opts), timeout=QUERY_TIMEOUT_S)
    except Exception as e:  # noqa: BLE001 - recorded as a FAILED row
        return {"status": "FAILED", "durationMs": int((time.monotonic() - start) * 1000), "rowCount": 0,
                "checksum": "", "error": _error_text(e)}
    ms = int((time.monotonic() - start) * 1000)
    m = _BODY.search(body)
    content = m.group(1) if m else body
    fault = _FAULT.search(content)
    if fault:
        return {"status": "FAILED", "durationMs": ms, "rowCount": 0, "checksum": "", "error": fault.group(1).strip()}
    cells = _CELLDATA.search(content)
    rows = len(_VALUE.findall(cells.group(1))) if cells else 0
    checksum = hashlib.sha1(_VOLATILE.sub("", content).encode("utf-8")).hexdigest() if rows else ""
    try:
        data = mdx_rows(body)
    except Exception:  # noqa: BLE001 - a result we can't parse is still a pass; compare shows it as missing
        data = None
    return {"status": "SUCCEEDED", "durationMs": ms, "rowCount": rows, "checksum": checksum, "error": "", "data": data}


def execute_sql(api: Any, sql: str, catalog: str, opts: dict[str, bool], metrics: list[str] | None = None) -> dict[str, Any]:
    # Same response shape atscale/preview.py parse_sql_result reads.
    from atscale.preview import parse_sql_result

    payload = {
        "language": "SQL", "query": sql,
        "context": {"organization": {"id": "default"}, "environment": {"id": "default"}, "project": {"name": catalog}},
        "useAggs": opts["useAggregates"], "genAggs": opts["generateAggregates"], "fakeResults": False,
        "dryRun": False, "useLocalCache": opts["useQueryCache"], "useAggregateCache": opts["useAggregateCache"],
        "timeout": "2.minutes",
    }
    start = time.monotonic()
    try:
        parsed = parse_sql_result(api.submit_query(payload, timeout=QUERY_TIMEOUT_S))
        rows = [dict(zip(parsed["columns"], (v if v is not None else "" for v in row))) for row in parsed["rows"]]
    except Exception as e:  # noqa: BLE001
        return {"status": "FAILED", "durationMs": int((time.monotonic() - start) * 1000), "rowCount": 0,
                "checksum": "", "error": _error_text(e)}
    ms = int((time.monotonic() - start) * 1000)
    checksum = ""
    if rows:
        cols = sorted(rows[0])
        checksum = hashlib.sha1("\n".join("\t".join(str(r.get(c, "")) for c in cols) for r in rows)
                                .encode("utf-8")).hexdigest()
    data = sql_rows(parsed["columns"], parsed["rows"], metrics or [])
    return {"status": "SUCCEEDED", "durationMs": ms, "rowCount": len(rows), "checksum": checksum, "error": "", "data": data}


DEFAULT_OPTS = {"useAggregates": True, "generateAggregates": False, "useQueryCache": False, "useAggregateCache": True}


def run(
    run_id: str,
    targets: list[dict[str, Any]],
    queries: list[dict[str, Any]],
    protocols: list[str],
    api_for: Callable[[str], Any],
    opts: dict[str, bool],
    concurrency: int = 1,
    throttle_ms: int = 5,
    annotate: bool = True,
    on_result: Callable[[dict[str, Any]], None] = lambda r: None,
) -> list[dict[str, Any]]:
    """Every (target, protocol, query) once. `concurrency` workers per target;
    targets run side by side (each host has its own session)."""
    lock = threading.Lock()
    results: list[dict[str, Any]] = []

    def run_target(t: dict[str, Any]) -> None:
        api = api_for(t["hostId"])
        queue = [(p, q) for p in protocols for q in queries]
        qlock = threading.Lock()

        def worker() -> None:
            while True:
                with qlock:
                    if not queue:
                        return
                    protocol, q = queue.pop(0)
                text = q[protocol]
                text_hash = sha256hex(text)
                run_query_id = str(uuid.uuid4())
                sent = (annotation(run_id, run_query_id, text_hash) + text) if annotate else text
                r = (execute_xmla(api, sent, t["catalog"], t["cube"], opts) if protocol == "mdx"
                     else execute_sql(api, sent, t["catalog"], opts, q.get("metrics")))
                rec = {
                    "runId": run_id, "hostId": t["hostId"], "host": t.get("label") or t["hostId"],
                    "env": t.get("env"), "catalog": t["catalog"], "model": t["cube"], "queryId": q["id"],
                    "queryName": q["name"], "runQueryId": run_query_id, "protocol": protocol,
                    **r, "timestamp": int(time.time() * 1000), "originalTextHash": text_hash, "originalText": text,
                }
                with lock:
                    results.append(rec)
                on_result(rec)
                if throttle_ms:
                    time.sleep(throttle_ms / 1000)

        with ThreadPoolExecutor(max_workers=max(1, concurrency)) as pool:
            for f in [pool.submit(worker) for _ in range(max(1, concurrency))]:
                f.result()

    with ThreadPoolExecutor(max_workers=max(1, len(targets))) as pool:
        for f in [pool.submit(run_target, t) for t in targets]:
            f.result()
    return results


_CSV_COLUMNS = ["run_id", "task_name", "model", "query_name", "run_query_uuid", "original_atscale_query_id",
                "protocol", "status", "duration_ms", "row_count", "checksum", "error", "timestamp",
                "original_text_hash", "original_text"]


def to_csv(records: list[dict[str, Any]]) -> str:
    """The harness's results CSV; task_name carries the host, and protocol
    uses its names (xmla / sql)."""
    buf = io.StringIO()
    w = csv.writer(buf, lineterminator="\n")
    w.writerow(_CSV_COLUMNS)
    for r in records:
        w.writerow([r["runId"], r["host"], r["model"], r["queryName"], r["runQueryId"], "",
                    "xmla" if r["protocol"] == "mdx" else "sql", r["status"], r["durationMs"], r["rowCount"],
                    r["checksum"], r["error"], r["timestamp"], r["originalTextHash"], r["originalText"]])
    return buf.getvalue()
