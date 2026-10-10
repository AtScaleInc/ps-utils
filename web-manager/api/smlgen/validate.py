"""SML validation - shells out to the `sml-cli` npm package (the authoritative
external validator per the build plan), writing the generated files to a temp
directory in the on-disk repo layout it expects. Copied from sml-wizard
api/smlgen/validate.py; `sml-cli` is now a pinned devDependency in
web/package.json (web/node_modules/.bin/sml-cli), with `npx --yes` kept only
as a fallback when node_modules hasn't been installed.

`npx sml-cli validate <dir>` exits 1 on failure, 0 on success, and prints
`[ERROR]`/`[WARNING]`-prefixed lines per file plus a final "Validation
FAILED/PASSED" line - confirmed by running it against a real hand-built SML
repo (sample-dev) during development.
"""

from __future__ import annotations

import os
import shutil
import subprocess
import tempfile
from pathlib import Path

from cache import work_tmp

from .packages import flatten_packages


class SmlCliNotFound(RuntimeError):
    pass


_LOCAL_CLI = Path(__file__).resolve().parent.parent.parent / "web" / "node_modules" / ".bin" / "sml-cli"


def _sml_cli() -> list[str]:
    if _LOCAL_CLI.exists():
        return [str(_LOCAL_CLI)]
    npx = shutil.which("npx")
    if not npx:
        raise SmlCliNotFound("sml-cli not installed (cd web && npm install) and npx not found on PATH.")
    return [npx, "--yes", "sml-cli"]


#: sml-cli's global error for a repo without a model - expected for a shared
#: dimensions package (smlgen/packages.py), which is attached, never deployed.
_NO_MODEL = "Missing Model files in folder structure"


def validate_sml(files: dict[str, str], packages: list[dict] | None = None, shared: bool = False) -> dict:
    """`packages`: [{ref, files}] resolved from package.yml; `shared`: a shared
    dimensions package, where sml-cli's no-model error is expected."""
    cli = _sml_cli()
    if packages:
        files = flatten_packages(files, packages)

    with tempfile.TemporaryDirectory(prefix="validate-", dir=work_tmp()) as tmp:
        root = Path(tmp)
        for rel_path, content in files.items():
            p = root / rel_path
            p.parent.mkdir(parents=True, exist_ok=True)
            p.write_text(content, encoding="utf-8")

        proc = subprocess.run(
            [*cli, "validate", str(root)],
            capture_output=True,
            text=True,
            timeout=120,
            env={**os.environ, "NO_COLOR": "1", "FORCE_COLOR": "0"},  # plain text for the UI
        )
        output = (proc.stdout or "") + (proc.stderr or "")
        passed = proc.returncode == 0
        if shared and not passed:
            errors = [ln for ln in output.splitlines() if ln.strip().startswith("[ERROR]")]
            if errors and all(_NO_MODEL in ln for ln in errors):
                passed = True
                output += "\n(No model is expected: this is a shared dimensions package - it is attached, not deployed.)"
        return {"passed": passed, "returncode": proc.returncode, "output": output}
