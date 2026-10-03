"""A pipeline step's result as JUnit XML, so GitHub Actions (dorny/test-reporter)
and Jenkins (`junit`) show it natively.

A test step is one <testsuite> per model: a <testcase> per query and protocol
(failing when it failed on the candidate, is missing there, or differs beyond
the variance limit) plus one for the model diff. Other steps are one
<testsuite> with a <testcase> per host (or the step itself).
"""

from __future__ import annotations

from typing import Any
from xml.sax.saxutils import escape, quoteattr

from . import stages


def _case(classname: str, name: str, failure: str | None = None, seconds: float = 0) -> str:
    head = f"<testcase classname={quoteattr(classname)} name={quoteattr(name)} time=\"{seconds:.3f}\""
    if failure is None:
        return head + "/>"
    return head + f"><failure message={quoteattr(failure[:500])}>{escape(failure)}</failure></testcase>"


def _suite(name: str, cases: list[str], failures: int) -> str:
    return (f"<testsuite name={quoteattr(name)} tests=\"{len(cases)}\" failures=\"{failures}\">"
            + "".join(cases) + "</testsuite>")


def _test_suite(model: dict[str, Any], policy: dict[str, Any]) -> str:
    result = model.get("result") or {}
    limit = float(policy.get("variance") or 0)
    cls = f"atscale.{model.get('model', 'model')}"
    cases, fails = [], 0
    for r in result.get("rows") or []:
        why = None
        if r["verdict"] in stages.FAIL_ROWS:
            why = f"{r['verdict']}: {r.get('error') or ''}".strip()
        elif r["verdict"] == "differs" and (r.get("pct") is None or abs(r["pct"]) > limit):
            why = ("results differ (rows or values beyond any threshold)" if r.get("pct") is None
                   else f"max variance {abs(r['pct']):.3f}% > limit {limit}%")
        fails += why is not None
        cases.append(_case(cls, f"{r['name']} [{r['protocol']}]", why))
    m = result.get("model") or {}
    why = None
    if policy.get("intendedOnly") and m.get("unintended"):
        names = [c["name"] for c in m.get("changes") or [] if not c.get("intended")][:20]
        why = f"{m['unintended']} unintended model change(s): {', '.join(map(str, names))}"
    fails += why is not None
    cases.append(_case(cls, "model diff vs baseline", why))
    if not result.get("rows") and model.get("verdict") == "fail":
        fails += 1
        cases.append(_case(cls, "test", model.get("summary") or "failed"))
    return _suite(f"{model.get('model')} test", cases, fails)


def render(kind: str, job_result: dict[str, Any] | None, error: str | None, policy: dict[str, Any]) -> str:
    suites = []
    if error or not job_result:
        suites.append(_suite(f"envmgr {kind}", [_case(f"envmgr.{kind}", kind, error or "No result")], 1))
    elif kind == "test":
        for m in job_result.get("models") or []:
            suites.append(_test_suite(m, policy))
    else:
        cases, fails = [], 0
        for h in job_result.get("hosts") or []:
            why = None if h.get("ok", True) else str(h.get("error") or "failed")
            fails += why is not None
            cases.append(_case(f"envmgr.{kind}", h.get("host") or h.get("hostId") or kind, why))
        if not cases:
            why = None if job_result.get("verdict") == "pass" else job_result.get("summary") or "failed"
            fails += why is not None
            cases.append(_case(f"envmgr.{kind}", kind, why))
        suites.append(_suite(f"envmgr {kind}", cases, fails))
    return '<?xml version="1.0" encoding="UTF-8"?>\n<testsuites>' + "".join(suites) + "</testsuites>\n"
