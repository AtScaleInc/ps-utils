"""SML generation rules, each citing the atscale-sml-model-generator skill's rule
number where applicable. Confirmed/corrected against a real, working, hand-built
SML repo (sample-dev) pulled from the user's own AtScale instance - see build.py's
module docstring for the specific corrections that sample forced.
"""

from __future__ import annotations

import re

# Rule 1: identifier casing follows the warehouse's storage case.
_UPPERCASE_DIALECTS = {"snowflake"}


def cased(identifier: str, dialect: str | None) -> str:
    if (dialect or "").lower() in _UPPERCASE_DIALECTS:
        return identifier.upper()
    return identifier.lower()


# Rule 7: calculation_method is an exact enumerated string - never the naive
# abbreviation.
AGG_TO_CALC_METHOD = {
    "SUM": "sum",
    "MIN": "minimum",
    "MAX": "maximum",
    "COUNT": "count non-null",
    "COUNT DISTINCT": "count distinct",
    "AVG": "average",
}

# AtScale's metadata API returns JDBC-flavored type names (Int, String, Float,
# DateTime, Long, Boolean, ...) - map to SML's lowercase data_type enum.
# Confirmed against sample-dev/datasets/*.yml (int, string, float, double,
# long, datetime, date, boolean).
_TYPE_MAP = {
    "int": "int",
    "integer": "int",
    "smallint": "int",
    "tinyint": "int",
    "bigint": "long",
    "long": "long",
    "float": "float",
    "double": "double",
    "real": "float",
    "decimal": "decimal",
    "numeric": "decimal",
    "number": "decimal",
    "money": "decimal",
    "string": "string",
    "varchar": "string",
    "char": "string",
    "text": "string",
    "boolean": "boolean",
    "bool": "boolean",
    "bit": "boolean",
    "date": "date",
    "datetime": "datetime",
    "timestamp": "datetime",
}


def sml_data_type(atscale_type: str) -> str:
    return _TYPE_MAP.get((atscale_type or "").lower(), "string")


def title_case(s: str) -> str:
    words = re.sub(r"[_\-]+", " ", s).split()
    return " ".join(w[:1].upper() + w[1:] for w in words if w)


def kebab(s: str) -> str:
    s = re.sub(r"[_\s]+", "-", s.strip())
    s = re.sub(r"[^A-Za-z0-9\-]", "", s)
    return s.lower()


def slug(s: str) -> str:
    s = re.sub(r"[^A-Za-z0-9]+", "_", s.strip())
    return s.strip("_").lower()
