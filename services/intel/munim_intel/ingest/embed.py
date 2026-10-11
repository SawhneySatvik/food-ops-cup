"""Chunk embeddings (768-d, gotcha 26) sent to core's `embeddings:batch` as integer millionths (no contract carries a
float). Core answers 503 `unavailable` where the database has no pgvector column (embedded Postgres in every gate):
that is an outcome, not a failure — the chunks and claims stand without vectors and search falls back.

UNVERIFIED: the success path against a pgvector database has not run in any gate. The recorded embedder is a
deterministic stand-in with no semantic meaning; no live embedder is built here.
"""

from __future__ import annotations

import hashlib
import math
import struct
from collections.abc import Sequence
from dataclasses import dataclass
from typing import Literal, Protocol

from munim_intel.ingest.sink import IngestSink
from munim_intel.runtime.internal_client import CoreError

DIMENSIONS = 768
#: contracts EmbeddingsBatchRequest max rows.
BATCH = 100


class Embedder(Protocol):
    async def embed(self, texts: Sequence[str]) -> list[list[float]]: ...


class RecordedEmbedder:
    """sha256 in counter mode → a unit vector. Same text, same vector; similarity between vectors means nothing."""

    async def embed(self, texts: Sequence[str]) -> list[list[float]]:
        out = []
        for t in texts:
            raw = b"".join(hashlib.sha256(f"{i}\0{t}".encode()).digest() for i in range(DIMENSIONS * 4 // 32))
            v = [x / 2**31 for x in struct.unpack(f">{DIMENSIONS}i", raw)]
            norm = math.sqrt(sum(x * x for x in v)) or 1.0
            out.append([x / norm for x in v])
        return out


def to_micro(v: Sequence[float]) -> list[int]:
    if len(v) != DIMENSIONS:
        raise ValueError(f"an embedding has {DIMENSIONS} dimensions")
    return [round(x * 1_000_000) for x in v]


@dataclass(frozen=True)
class EmbedOutcome:
    status: Literal["stored", "unavailable", "none"]
    inserted: int = 0
    existing: int = 0


async def write_embeddings(sink: IngestSink, embedder: Embedder, chunks: Sequence[tuple[str, str]]) -> EmbedOutcome:
    """`chunks` = (chunk_id, text), already stored in core. 503 → `unavailable` (no retry); any other refusal raises."""
    if not chunks:
        return EmbedOutcome("none")
    inserted = existing = 0
    for i in range(0, len(chunks), BATCH):
        part = chunks[i : i + BATCH]
        vectors = await embedder.embed([t for _, t in part])
        body = {"embeddings": [{"chunk_id": cid, "embedding_micro": to_micro(v)} for (cid, _), v in zip(part, vectors, strict=True)]}
        try:
            r = await sink.batch("embeddings:batch", body)
        except CoreError as e:
            if e.status == 503:
                return EmbedOutcome("unavailable", inserted, existing)
            raise
        inserted += r.inserted
        existing += r.existing
    return EmbedOutcome("stored", inserted, existing)
