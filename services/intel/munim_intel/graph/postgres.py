"""Graph adapter over Postgres edges (R35, F7): reads and writes both go through core-api, never a database from here.

* writes — `entities:batch` / `edges:batch` (idempotent by id) through a `BatchWriter` (the InternalClient);
* reads  — `graph:query` (the InternalClient): core owns the five templates' SQL
  (services/core-api/src/internal/graph/), validates the arguments exactly as `check_args` does and runs the template
  as munim_svc with `:tenant_id` bound from the run token. Intel keeps only the template names and their arguments.
"""

from __future__ import annotations

from collections.abc import Mapping, Sequence
from typing import Protocol

from munim_intel.contracts_gen.models import Edge, Entity, InternalBatchResponse, InternalEdgesBatchRequest, InternalEntitiesBatchRequest
from munim_intel.graph.port import Row, UpsertResult, check_args

BATCH = 500  # the contracts' max rows per batch


class BatchWriter(Protocol):
    async def write_entities(self, req: InternalEntitiesBatchRequest) -> InternalBatchResponse: ...

    async def write_edges(self, req: InternalEdgesBatchRequest) -> InternalBatchResponse: ...


class GraphReader(Protocol):
    """Runs template `template` with `args` (no tenant) for the run's tenant; rows are ids, kinds, names, depth."""

    async def graph_query(self, template: str, args: dict[str, str | int]) -> list[Row]: ...


class PostgresGraph:
    def __init__(self, writer: BatchWriter, reader: GraphReader) -> None:
        self._writer = writer
        self._reader = reader

    async def upsert(self, nodes: Sequence[Entity], edges: Sequence[Edge]) -> UpsertResult:
        # Entities first: an edge's endpoints are foreign keys.
        ent = [0, 0]
        for i in range(0, len(nodes), BATCH):
            r = await self._writer.write_entities(InternalEntitiesBatchRequest(entities=list(nodes[i : i + BATCH])))
            ent[0] += r.inserted
            ent[1] += r.existing
        edg = [0, 0]
        for i in range(0, len(edges), BATCH):
            r = await self._writer.write_edges(InternalEdgesBatchRequest(edges=list(edges[i : i + BATCH])))
            edg[0] += r.inserted
            edg[1] += r.existing
        return UpsertResult(ent[0], ent[1], edg[0], edg[1])

    async def query(self, template: str, args: Mapping[str, object]) -> list[Row]:
        return await self._reader.graph_query(template, check_args(template, args))
