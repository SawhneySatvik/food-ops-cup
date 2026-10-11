"""Where ingestion writes: core's `/internal/intel/v1` batch routes and `drafts` (R25 — intel never writes Postgres).

`CoreSink` posts through the run's InternalClient (run token + service secret; core takes the tenant from the token).
Batch bodies are validated against the generated contract models before they leave. The draft body goes as a plain
object: the invoice proposal is new in contracts and the shared `contracts_gen` gains it at the next regeneration; core
validates it either way. InternalClient has no batch methods yet (i-1's file), so this uses its one POST helper.
"""

from __future__ import annotations

from typing import Any, Protocol

from pydantic import BaseModel, RootModel

from munim_intel.contracts_gen.models import (
    InternalAliasesBatchRequest,
    InternalBatchResponse,
    InternalChunksBatchRequest,
    InternalClaimsBatchRequest,
    InternalDraftsResponse,
    InternalEmbeddingsBatchRequest,
    InternalEntitiesBatchRequest,
)
from munim_intel.runtime.internal_client import InternalClient

BATCHES: dict[str, type[BaseModel]] = {
    "entities:batch": InternalEntitiesBatchRequest,
    "aliases:batch": InternalAliasesBatchRequest,
    "chunks:batch": InternalChunksBatchRequest,
    "claims:batch": InternalClaimsBatchRequest,
    "embeddings:batch": InternalEmbeddingsBatchRequest,
}


class IngestSink(Protocol):
    async def batch(self, route: str, body: dict[str, Any]) -> InternalBatchResponse: ...

    async def draft(self, body: dict[str, Any]) -> InternalDraftsResponse: ...


class _Body(RootModel[dict[str, Any]]):
    pass


class CoreSink:
    def __init__(self, client: InternalClient) -> None:
        self._client = client

    async def batch(self, route: str, body: dict[str, Any]) -> InternalBatchResponse:
        return await self._client._post(route, BATCHES[route].model_validate(body), InternalBatchResponse)

    async def draft(self, body: dict[str, Any]) -> InternalDraftsResponse:
        return await self._client._post("drafts", _Body(body), InternalDraftsResponse)
