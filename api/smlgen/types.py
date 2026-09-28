"""Payload shapes for SML generation - mirrors web/src/store/modelStore.ts.

Kept as plain dicts (not dataclasses) since this is exactly what arrives as
JSON from the frontend; see build.py for the actual field access.
"""

from __future__ import annotations

from typing import Any, TypedDict


class ColumnMeta(TypedDict):
    name: str
    type: str


class NodeDict(TypedDict, total=False):
    id: str
    schema: str
    table: str
    columns: list[ColumnMeta]
    role: str | None  # 'fact' | 'dimension' | None
    dimName: str
    hierName: str
    factName: str


class JoinEndpoint(TypedDict):
    node: str
    column: str


class JoinDict(TypedDict, total=False):
    id: str
    a: JoinEndpoint
    b: JoinEndpoint
    rolePlay: str  # e.g. "Order {0}" - only meaningful on a fact<->dim join


ColumnConfig = dict[str, Any]
