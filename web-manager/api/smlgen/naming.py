"""Git-safe model/repo naming rule, shared by the workspace save path
(config.py's model_workspace_dir) and the per-model GitHub repo created
during deploy (atscale/git_ops.py) - both must agree on the same slug for a
given model name, or save and deploy would silently drift onto different
directories/repos for what the user considers one model.
"""

from __future__ import annotations

import re

_VALID_RE = re.compile(r"^[A-Za-z0-9_-]+$")


def slugify_model_name(name: str) -> str:
    slug = re.sub(r"\s+", "-", name.strip())
    slug = re.sub(r"[^A-Za-z0-9._-]", "", slug)
    return slug or "sml-model"


def is_valid_model_name(name: str) -> bool:
    return bool(name) and bool(_VALID_RE.match(name))
