"""TraceBuffer: one per run, shared by every Runner of the run. Assigns `seq` gaplessly and flushes to core's
`traces:batch` in seq order.

core appends a batch only right after the run's last stored seq (a gap is 409) and skips a seq it already holds
under the same id. So allocation and sending share one lock and every flush sends from the watermark in order:
two branches flushing at once cannot overtake each other. Ids are fixed at append time, so a flush retried after a
lost response re-sends identical events and core inserts 0 (ADR-014 §10: any flush is idempotent by seq).

Payload values are labels (rule 8; 03 §1.8; ADR-014 §6.4 rule 5): one token of at most 200 characters with no
whitespace. Prose — a question, model text, a tool argument or result, an exception message — cannot pass, and an
attempt raises, failing the run rather than shipping text. The one typed kind is `review` (a deal-review verdict, T-055):
its payload is the contract's TraceReviewPayload — a verdict, a contracts reason code, RefIds and a subject id — so it
holds ids and codes only by construction (`review`).
"""

from __future__ import annotations

import asyncio
import os
import re
import time
import uuid
from collections.abc import Awaitable, Callable
from datetime import UTC, datetime
from typing import Any, Literal

import httpx

from munim_intel.contracts_gen.models import Events, Events1, InternalTracesBatchRequest
from munim_intel.runtime.internal_client import CoreError

#: core's per-call cap (contracts `TracesBatchRequest` max 500).
BATCH_CAP = 500
#: Flush during the run every this many unsent events (04 §7).
FLUSH_EVERY = 50

# Same pattern as packages/contracts/src/shared/trace.ts: a bare number of 4+ digits ("450000", "4500.50") is not a label (R25);
# short counts ("round", "claims" in negotiate / ingest traces) stay legitimate.
LABEL = re.compile(r"^(?![0-9][0-9.]{3,}$)[A-Za-z0-9][A-Za-z0-9_.:/-]{0,199}$")

Payload = dict[str, str | list[str]]
Sink = Callable[[InternalTracesBatchRequest], Awaitable[object]]


class TraceLabelError(ValueError):
    """A payload value is not a label. The message names the key only, never the value."""


def label_of(class_name: str) -> str:
    """A class name as a label. ADK wraps a provider 429 as `_ResourceExhaustedError`, and no label may start with an
    underscore: leading separators and characters outside the label set are dropped. For a name already taken off its
    exception (`RunFailed.kind`); anything else uses `error_label`."""
    name = re.sub(r"[^A-Za-z0-9_.:/-]", "", class_name).lstrip("_.:/-")[:200]
    return name if LABEL.match(name) else "error"


def error_label(e: BaseException) -> str:
    """An exception's class name as a label (never its message): the only way an exception reaches a trace."""
    return label_of(type(e).__name__)


def check_payload(payload: Payload) -> Payload:
    for k, v in payload.items():
        for label in v if isinstance(v, list) else [v]:
            if not LABEL.match(label):
                raise TraceLabelError(f"trace payload {k!r} is not a label")
    return payload


def uuid7() -> str:
    """RFC 9562 UUIDv7: 48-bit unix ms, version 7, 12 + 62 random bits, variant 10."""
    rand = int.from_bytes(os.urandom(10), "big")
    value = (time.time_ns() // 1_000_000) << 80 | 0x7 << 76 | (rand >> 62 & 0xFFF) << 64 | 0b10 << 62 | rand & (1 << 62) - 1
    return str(uuid.UUID(int=value))


class TraceBuffer:
    def __init__(self, sink: Sink, *, flush_every: int = FLUSH_EVERY) -> None:
        self._sink = sink
        self._flush_every = flush_every
        self._lock = asyncio.Lock()
        self._events: list[Events | Events1] = []
        #: Events [0, _sent) are stored in core.
        self._sent = 0

    @property
    def events(self) -> list[Events | Events1]:
        return list(self._events)

    @property
    def unsent(self) -> int:
        return len(self._events) - self._sent

    async def append(self, kind: str, actor: str, payload: Payload, *, parent_id: str | None = None) -> str:
        check_payload(payload)
        return await self._add(Events, kind, actor, payload, parent_id)

    async def review(
        self,
        actor: str,
        verdict: Literal["pass", "fail", "cannot_verify"],
        reason_code: str | None,
        refs: list[str],
        subject_id: str | None,
        *,
        parent_id: str | None = None,
    ) -> str:
        """A deal-review verdict (`review` kind). The contract model validates it: reason code from the contracts list
        and set exactly when the verdict is not pass (core re-checks), refs as RefIds, at least one."""
        if (verdict == "pass") != (reason_code is None):
            raise TraceLabelError("review: reason_code is set exactly when the verdict is not pass")
        payload = {"verdict": verdict, "reason_code": reason_code, "refs": refs, "subject_id": subject_id}
        return await self._add(Events1, "review", actor, payload, parent_id)

    async def _add(self, model: type[Events] | type[Events1], kind: str, actor: str, payload: dict[str, Any], parent_id: str | None) -> str:
        async with self._lock:
            event = model.model_validate(
                {
                    "id": uuid7(),
                    "seq": len(self._events) + 1,
                    "parent_id": parent_id,
                    "actor": actor,
                    "at": datetime.now(UTC).isoformat().replace("+00:00", "Z"),
                    "kind": kind,
                    "payload": payload,
                }
            )
            self._events.append(event)
            if event.seq % self._flush_every == 0:
                # Mid-run: a failed flush keeps the events for the next one (same ids, so core skips what it has).
                try:
                    await self._send()
                except (CoreError, httpx.HTTPError):
                    pass
            return event.id.root

    async def flush(self) -> None:
        """Send everything unsent. Raises when core does not take it."""
        async with self._lock:
            await self._send()

    async def _send(self) -> None:
        while self._sent < len(self._events):
            chunk = self._events[self._sent : self._sent + BATCH_CAP]
            await self._sink(InternalTracesBatchRequest(events=chunk))
            self._sent += len(chunk)
