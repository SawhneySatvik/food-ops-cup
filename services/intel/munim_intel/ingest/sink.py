"""Where ingestion writes: core's `/internal/intel/v1` batch routes and `drafts` (R25 — intel never writes Postgres).

`CoreSink` posts through the run's InternalClient (run token + service secret; core takes the tenant from the token).
Every body is validated against the generated contract model before it leaves.
"""

from __future__ import annotations

from collections.abc import Awaitable, Callable
from typing import Any, Protocol

from pydantic import BaseModel

from munim_intel.contracts_gen.models import (
    InternalAliasesBatchRequest,
    InternalBatchResponse,
    InternalChunksBatchRequest,
    InternalClaimsBatchRequest,
    InternalDraftsRequest,
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


class CoreSink:
    def __init__(self, client: InternalClient) -> None:
        self._client = client
        self._writers: dict[str, Callable[[Any], Awaitable[InternalBatchResponse]]] = {
            "entities:batch": client.write_entities,
            "aliases:batch": client.write_aliases,
            "chunks:batch": client.write_chunks,
            "claims:batch": client.write_claims,
            "embeddings:batch": client.write_embeddings,
        }

    async def batch(self, route: str, body: dict[str, Any]) -> InternalBatchResponse:
        return await self._writers[route](BATCHES[route].model_validate(body))

    async def draft(self, body: dict[str, Any]) -> InternalDraftsResponse:
        return await self._client.write_draft(InternalDraftsRequest.model_validate(body))
