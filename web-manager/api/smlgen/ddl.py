"""Parse SQL DDL (CREATE TABLE / CREATE VIEW) into the tables + columns the
new-model Wizard plans from - Build › Import & convert › Database DDL.

Port of ps-utils src/algorithm/ddl-reader.ts (the parser behind
generate-sml-from-ddl): the same preprocessing, comment stripping, statement
split and CREATE TABLE / ALTER TABLE ... FOREIGN KEY handling. Two deliberate
differences: the precision / scale of a type is kept (NUMBER(38,0) is an
integer key, NUMBER(18,2) a measure), and each type is also mapped to the
AtScale metadata type a live data source reports (Int, Long, Decimal, String,
...) so the Wizard's join-type guardrail and metric inference treat a DDL
column exactly like a live one. Views keep no columns, as in ps-utils."""

from __future__ import annotations

import re
from typing import Any

_I = re.I | re.M


def _preprocess(ddl: str) -> str:
    for pattern, repl in (
        (r"\s+IDENTITY\s*\(\s*\d+\s*,\s*\d+\s*\)", ""),
        (r"\s+AUTOINCREMENT\b", ""),
        (r"\s+INCLUDE\s*\([^)]*\)", ""),
        (r"^\s*GO\s*$", ";"),
        (r"^\s*USE\s+(?:DATABASE\s+|SCHEMA\s+)?[\w.]+\s*;?", ""),
        (r"^\s*CREATE\s+DATABASE\s+(?:IF\s+NOT\s+EXISTS\s+)?[\w.\"'`]+\s*;?", ""),
        (r"^\s*CREATE\s+SCHEMA\s+(?:IF\s+NOT\s+EXISTS\s+)?[\w.\"'`]+\s*;?", ""),
        (r"^\s*ALTER\s+TABLE\s+[\w.\"'`]+\s+CLUSTER\s+BY\s*\([^)]*\)\s*;?", ""),
        (r"^\s*IF\s+EXISTS[\s\S]*?DROP\s+DATABASE[\s\S]*?;", ""),
        (r"^\s*DROP\s+DATABASE[\s\S]*?;", ""),
    ):
        ddl = re.sub(pattern, repl, ddl, flags=_I)
    return ddl


def _strip_comments(sql: str) -> str:
    out: list[str] = []
    i, n = 0, len(sql)
    while i < n:
        if sql.startswith("/*", i):
            end = sql.find("*/", i + 2)
            i = n if end == -1 else end + 2
            out.append(" ")
        elif sql.startswith("--", i):
            while i < n and sql[i] != "\n":
                i += 1
            out.append(" ")
        elif sql[i] == "'":
            out.append(sql[i])
            i += 1
            while i < n:
                if sql.startswith("''", i):
                    out.append("''")
                    i += 2
                elif sql[i] == "'":
                    out.append("'")
                    i += 1
                    break
                else:
                    out.append(sql[i])
                    i += 1
        else:
            out.append(sql[i])
            i += 1
    return "".join(out)


def _split_statements(ddl: str) -> list[str]:
    stmts: list[str] = []
    cur: list[str] = []
    depth, in_str, i = 0, False, 0
    while i < len(ddl):
        ch = ddl[i]
        if in_str:
            cur.append(ch)
            if ch == "'" and ddl[i + 1:i + 2] == "'":
                cur.append("'")
                i += 1
            elif ch == "'":
                in_str = False
        elif ch == "'":
            in_str = True
            cur.append(ch)
        elif ch == ";" and depth == 0:
            if "".join(cur).strip():
                stmts.append("".join(cur).strip())
            cur = []
        else:
            depth += ch == "("
            depth -= ch == ")"
            cur.append(ch)
        i += 1
    if "".join(cur).strip():
        stmts.append("".join(cur).strip())
    return stmts


def _paren_body(sql: str, start: int) -> str | None:
    open_ = sql.find("(", start)
    if open_ == -1:
        return None
    depth = 0
    for i in range(open_, len(sql)):
        if sql[i] == "(":
            depth += 1
        elif sql[i] == ")":
            depth -= 1
            if depth == 0:
                return sql[open_ + 1:i]
    return None


def _split_commas(s: str) -> list[str]:
    parts, cur, depth = [], [], 0
    for ch in s:
        if ch == "(":
            depth += 1
        elif ch == ")":
            depth -= 1
        elif ch == "," and depth == 0:
            parts.append("".join(cur).strip())
            cur = []
            continue
        cur.append(ch)
    if "".join(cur).strip():
        parts.append("".join(cur).strip())
    return parts


def _norm(s: str) -> str:
    return re.sub(r"\s+", " ", s).strip()


def _unquote(t: str) -> str:
    return re.sub(r"^[\"'`\[]|[\"'`\]]$", "", t.strip()).strip()


def _qualified(s: str) -> tuple[str | None, str]:
    """`db.schema.table`, `schema.table` or `table` -> (schema, table)."""
    parts = [_unquote(p) for p in re.split(r"[\"'`\]]?\.[\"'`\[]?", s)]
    if len(parts) == 1:
        return None, parts[0]
    return parts[-2], parts[-1]


_MULTI_WORD = (
    "TIMESTAMP WITH LOCAL TIME ZONE", "TIMESTAMP WITH TIME ZONE", "TIMESTAMP WITHOUT TIME ZONE",
    "NATIONAL CHARACTER VARYING", "CHARACTER VARYING", "DOUBLE PRECISION", "NATIONAL CHARACTER",
    "BINARY VARYING", "BINARY LARGE OBJECT", "CHARACTER LARGE OBJECT",
)


def _data_type(rest: str) -> str:
    """The column's type as written, with its (precision, scale)."""
    upper = rest.upper().strip()
    for mw in _MULTI_WORD:
        if upper.startswith(mw):
            return mw
    m = re.match(r"^([A-Z_][A-Z0-9_]*)\s*(\(\s*\d+(?:\s*,\s*\d+)?\s*\))?", upper)
    if not m:
        return "VARCHAR"
    return m.group(1) + (re.sub(r"\s+", "", m.group(2)) if m.group(2) else "")


def atscale_type(ddl_type: str) -> str:
    """Map a DDL type onto the metadata type AtScale reports for a live column,
    which is what the Wizard and smlgen.rules expect."""
    t = ddl_type.upper()
    base = re.sub(r"\(.*$", "", t).strip()
    if base in ("TINYINT", "SMALLINT", "INT", "INTEGER", "INT2", "INT4", "BYTEINT", "SERIAL"):
        return "Int"
    if base in ("BIGINT", "INT8", "BIGSERIAL", "LONG"):
        return "Long"
    if base in ("NUMBER", "NUMERIC", "DECIMAL", "DEC", "MONEY", "SMALLMONEY", "BIGNUMERIC"):
        m = re.search(r"\(\s*(\d+)\s*(?:,\s*(\d+))?\s*\)", t)
        if base in ("NUMBER", "NUMERIC", "DECIMAL", "DEC") and m and int(m.group(2) or 0) == 0:
            # NUMBER(38,0) / NUMBER(10): an integer, the usual surrogate key type.
            return "Int" if int(m.group(1)) <= 9 else "Long"
        return "Decimal"
    if base in ("FLOAT", "FLOAT4", "FLOAT8", "FLOAT64", "DOUBLE", "DOUBLE PRECISION", "REAL"):
        return "Double"
    if base in ("BOOLEAN", "BOOL", "BIT"):
        return "Boolean"
    if base == "DATE":
        return "Date"
    if base.startswith(("TIMESTAMP", "DATETIME", "SMALLDATETIME")):
        return "DateTime"
    return "String"


_CONSTRAINT_START = ("PRIMARY KEY", "FOREIGN KEY", "UNIQUE", "CHECK", "INDEX", "CONSTRAINT", "KEY ")


def _column(defn: str, pk: set[str]) -> dict[str, Any] | None:
    norm = _norm(defn)
    if norm.upper().startswith(_CONSTRAINT_START):
        return None
    m = re.match(r"^[\"'`\[]([^\]\"'`]+)[\"'`\]]\s+(.+)$", norm) or re.match(r"^(\w+)\s+(.+)$", norm)
    if not m:
        return None
    name, rest = m.group(1), m.group(2)
    ddl_type = _data_type(rest)
    return {
        "name": name,
        "type": atscale_type(ddl_type),
        "ddlType": ddl_type,
        "nullable": not re.search(r"\bNOT\s+NULL\b", rest, re.I),
        "primaryKey": bool(re.search(r"\bPRIMARY\s+KEY\b", rest, re.I)) or name.upper() in pk,
    }


def _col_list(s: str) -> list[str]:
    return [_unquote(c) for c in s.split(",")]


def _foreign_key(defn: str) -> list[dict[str, str]]:
    m = re.search(r"FOREIGN\s+KEY\s*\(([^)]+)\)\s+REFERENCES\s+([\w.\"'`\[\]]+)\s*(?:\(([^)]+)\))?", defn, re.I)
    if not m:
        return []
    cols = _col_list(m.group(1))
    to_schema, to_table = _qualified(m.group(2))
    to_cols = _col_list(m.group(3)) if m.group(3) else cols
    return [{"column": c, "toSchema": to_schema, "toTable": to_table, "toColumn": to_cols[i] if i < len(to_cols) else to_cols[0]}
            for i, c in enumerate(cols)]


def _create_table(stmt: str) -> dict[str, Any] | None:
    norm = _norm(stmt)
    head = re.search(
        r"CREATE\s+(?:OR\s+REPLACE\s+)?(?:(?:GLOBAL\s+|LOCAL\s+)?(?:TEMPORARY|TEMP|TRANSIENT|EXTERNAL)\s+)?TABLE\s+"
        r"(?:IF\s+NOT\s+EXISTS\s+)?([\w.\"'`\[\]]+)\s*\(", norm, re.I)
    if not head:
        return None
    schema, name = _qualified(head.group(1))
    body = _paren_body(norm, head.end() - 1)
    if body is None:
        return None
    items = _split_commas(body)
    pk: set[str] = set()
    for item in items:
        if re.match(r"^(?:CONSTRAINT\s+\S+\s+)?PRIMARY\s+KEY", item, re.I):
            m = re.search(r"PRIMARY\s+KEY\s*\(([^)]+)\)", item, re.I)
            if m:
                pk.update(c.upper() for c in _col_list(m.group(1)))
    columns: list[dict[str, Any]] = []
    fks: list[dict[str, str]] = []
    for item in items:
        upper = item.upper().strip()
        if re.match(r"^(?:CONSTRAINT\s+\S+\s+)?FOREIGN\s+KEY", upper):
            fks.extend(_foreign_key(item))
            continue
        if re.match(r"^(?:CONSTRAINT\s+\S+\s+)?(?:PRIMARY\s+KEY|UNIQUE|CHECK)\b", upper) or re.match(r"^(?:UNIQUE\s+)?(?:KEY|INDEX)\s+", upper):
            continue
        col = _column(item, pk)
        if col:
            # Inline `col INT REFERENCES dim(id)`.
            ref = re.search(r"\bREFERENCES\s+([\w.\"'`\[\]]+)\s*(?:\(([^)]+)\))?", item, re.I)
            if ref:
                to_schema, to_table = _qualified(ref.group(1))
                fks.append({"column": col["name"], "toSchema": to_schema, "toTable": to_table,
                            "toColumn": _unquote(ref.group(2)) if ref.group(2) else col["name"]})
            columns.append(col)
    return {"schema": schema, "name": name, "kind": "table", "columns": columns, "foreignKeys": fks}


def _create_view(stmt: str) -> dict[str, Any] | None:
    m = re.search(r"CREATE\s+(?:OR\s+REPLACE\s+)?(?:SECURE\s+)?(?:FORCE\s+)?(?:MATERIALIZED\s+)?VIEW\s+"
                  r"(?:IF\s+NOT\s+EXISTS\s+)?([\w.\"'`\[\]]+)", _norm(stmt), re.I)
    if not m:
        return None
    schema, name = _qualified(m.group(1))
    return {"schema": schema, "name": name, "kind": "view", "columns": [], "foreignKeys": []}


def parse_ddl(text: str) -> dict[str, Any]:
    """{tables: [{schema, name, kind, columns: [{name, type, ddlType, nullable,
    primaryKey}], foreignKeys: [{column, toSchema, toTable, toColumn}]}],
    schemas, statements, skipped}. A later CREATE of the same table wins, as
    in ps-utils."""
    tables: dict[str, dict[str, Any]] = {}
    stmts = _split_statements(_strip_comments(_preprocess(text)))
    skipped = 0
    for stmt in stmts:
        head = stmt.lstrip()
        if re.match(r"CREATE\s+(?:OR\s+REPLACE\s+)?(?:(?:GLOBAL\s+|LOCAL\s+)?(?:TEMPORARY|TEMP|TRANSIENT|EXTERNAL)\s+)?TABLE\b", head, re.I):
            t = _create_table(stmt)
        elif re.match(r"CREATE\s+(?:OR\s+REPLACE\s+)?(?:SECURE\s+)?(?:FORCE\s+)?(?:MATERIALIZED\s+)?VIEW\b", head, re.I):
            t = _create_view(stmt)
        elif re.match(r"ALTER\s+TABLE\s+", head, re.I) and re.search(r"\bFOREIGN\s+KEY\b", head, re.I):
            m = re.match(r"ALTER\s+TABLE\s+([\w.\"'`\[\]]+)\s+ADD\s+", head, re.I)
            owner = tables.get(_qualified(m.group(1))[1].upper()) if m else None
            if owner:
                owner["foreignKeys"].extend(_foreign_key(stmt))
            continue
        else:
            skipped += 1 if re.match(r"CREATE\b", head, re.I) else 0
            continue
        if t:
            tables[t["name"].upper()] = t
    out = sorted(tables.values(), key=lambda t: t["name"].lower())
    schemas = sorted({t["schema"] for t in out if t["schema"]}, key=str.lower)
    return {"tables": out, "schemas": schemas, "statements": len(stmts), "skipped": skipped}
