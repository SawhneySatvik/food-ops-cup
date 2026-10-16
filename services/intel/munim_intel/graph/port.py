"""The Graph port (03-architecture §ports, ADR-014 'Graph port'): a multi-hop projection of intel.entity / intel.edge.

SQL stays canonical (P14). The graph answers multi-hop questions only, with ids, kinds and names (never a number to
display; `depth` is a hop count). Five templates, no free query: a model-facing `graph_<template>` tool passes only the
template's own arguments. The tenant is never an argument — an adapter gets it from the run token (Postgres: core owns the
SQL and binds `:tenant_id`, services/core-api/src/internal/graph/; any other backend is core's, behind the same route).
"""

from __future__ import annotations

import re
from collections.abc import Mapping, Sequence
from dataclasses import dataclass
from typing import Protocol

from munim_intel.contracts_gen.models import Edge, Entity

Row = dict[str, str | int | None]
MAX_DEPTH = 3
MAX_NODES = 50  # ADR-014 caps: graph <= 50 nodes. Every template ends in LIMIT 50.
_UUID = re.compile(r"^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$")


class GraphError(Exception):
    """Carries a code only — never the offending value (it may be model text)."""

    def __init__(self, code: str) -> None:
        super().__init__(code)
        self.code = code


@dataclass(frozen=True)
class Template:
    name: str
    #: The one uuid argument (an entity id), and whether the template walks (then it also takes `depth`).
    id_arg: str
    walks: bool


TEMPLATES: dict[str, Template] = {
    t.name: t
    for t in (
        Template("price_shock_path", "ingredient_id", True),
        Template("dish_margin_drivers", "item_id", True),
        Template("supplier_dependency", "supplier_id", False),
        Template("claim_support", "finding_id", False),
        Template("neighbourhood", "entity_id", True),
    )
}


def check_args(template: str, args: Mapping[str, object]) -> dict[str, str | int]:
    """The only arguments a template takes: its id (a UUID) and, for walks, `depth` 1..3 (default 3). Anything else —
    a `tenant_id` above all — refuses."""
    t = TEMPLATES.get(template)
    if t is None:
        raise GraphError("unknown_template")
    allowed = {t.id_arg, "depth"} if t.walks else {t.id_arg}
    if set(args) - allowed:
        raise GraphError("bad_args")
    ident = args.get(t.id_arg)
    if not isinstance(ident, str) or not _UUID.match(ident):
        raise GraphError("bad_args")
    out: dict[str, str | int] = {t.id_arg: ident}
    if t.walks:
        depth = args.get("depth", MAX_DEPTH)
        if isinstance(depth, bool) or not isinstance(depth, int) or not 1 <= depth <= MAX_DEPTH:
            raise GraphError("bad_args")
        out["depth"] = depth
    return out


@dataclass(frozen=True)
class UpsertResult:
    entities_inserted: int
    entities_existing: int
    edges_inserted: int
    edges_existing: int


class Graph(Protocol):
    """One tenant's graph. `upsert` is idempotent by id; an id seen again with other content is an error."""

    async def upsert(self, nodes: Sequence[Entity], edges: Sequence[Edge]) -> UpsertResult: ...

    async def query(self, template: str, args: Mapping[str, object]) -> list[Row]: ...
