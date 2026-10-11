"""AI spend, posted to core (04 §10; W3 close ruling "Intel must post AI spend"; R-E 1-C). core's monthly cap
(`intel.ai_budget_left`, T-090 `effectiveCap`) sums `intel.intel_spend`, so a model call that is not posted is a call
the cap never sees. Every provider call of a run is one row: the Manager's and every fan-out branch's (the plugin's
after_model / on_model_error callbacks, through the run's Meter), the DecisionModel's (its `call_usage`, posted by the
ask), the brief's, the narrations'. Rows are buffered with the traces and flushed with them — run_agent's `finally`
included, so a failed or cancelled run still posts what it spent. Ids are fixed when a row is buffered, so a re-flush
is idempotent at core (same id + same body → `existing`).

Usage is the provider's own count when it reports one; otherwise (a recorded replay, a provider error, a timeout) the
input is estimated from the request's size at 3.5 characters a token (ADR-014 §6.1's estimate) and the row is still
posted: an unreported call is never a free one.

PRICES (ledger R47 D1). The operator sets each role's price on `platform.model_role` (minor units of a currency per 1M input
and per 1M output tokens, an approved config draft, R24); core serves it with the model roles and `llm_for_role` puts it
on the model it builds. A live role with no price, or priced in a currency other than the run's spend currency, is
refused before any call (`llm/__init__.py`): spend is never unpriced and never converted (no FX). A recorded replay
carries no price and is charged 0 unless a test sets one — its rows are still posted, with their token counts. Each
call's amount is rounded UP to a whole minor unit (a small priced call never rounds to zero).
"""

from __future__ import annotations

import asyncio
import json
import math
from collections.abc import Awaitable, Callable
from dataclasses import dataclass
from typing import Any

from google.adk.models.llm_request import LlmRequest

from munim_intel.contracts_gen.models import InternalRunFrameResponse, InternalSpendRequest
from munim_intel.trace.buffer import uuid7
from munim_intel.trace.price import Price

#: core's per-call cap (contracts `SpendRequest.entries` max 100).
BATCH_CAP = 100
CHARS_PER_TOKEN = 3.5


@dataclass(frozen=True)
class Usage:
    input_tokens: int
    output_tokens: int
    #: The provider reported no count: input estimated from the request's size, output 0.
    estimated: bool = False


def amount_minor(usage: Usage, price: Price | None) -> int:
    """The call's cost in minor units of the price's currency, rounded up. No price (a recorded replay) → 0."""
    if price is None:
        return 0
    return -(-(usage.input_tokens * price.input_per_mtok_minor + usage.output_tokens * price.output_per_mtok_minor) // 1_000_000)


def estimate_input_tokens(req: LlmRequest) -> int:
    """The request's input at 3.5 characters a token: system text, tool declarations and contents, as JSON."""
    cfg = req.config
    tools = [
        fd.model_dump(mode="json", exclude_none=True) for t in (cfg.tools or []) for fd in (getattr(t, "function_declarations", None) or [])
    ]
    contents = [c.model_dump(mode="json", exclude_none=True) for c in req.contents]
    text = json.dumps({"system": str(cfg.system_instruction or ""), "tools": tools, "contents": contents}, ensure_ascii=False)
    return math.ceil(len(text) / CHARS_PER_TOKEN)


def spend_currency(frame: InternalRunFrameResponse) -> str:
    """core takes spend only in the month's budget currency (else the tenant's base currency) — the cap sums one."""
    return frame.budget.currency if frame.budget is not None else frame.currency


Sink = Callable[[InternalSpendRequest], Awaitable[object]]


class SpendBuffer:
    """One per run, shared by every Runner of the run (Manager, branches) and the DecisionModel's calls."""

    def __init__(self, sink: Sink, currency: str) -> None:
        self._sink = sink
        self.currency = currency
        self._lock = asyncio.Lock()
        self._entries: list[dict[str, Any]] = []
        self._sent = 0

    @property
    def entries(self) -> list[dict[str, Any]]:
        return list(self._entries)

    def add(self, role: str, provider: str, model_id: str, usage: Usage, price: Price | None) -> None:
        self._entries.append(
            {
                "id": uuid7(),
                "role": role,
                "provider": provider,
                "model_id": model_id,
                "input_tokens": usage.input_tokens,
                "output_tokens": usage.output_tokens,
                "amount_minor": amount_minor(usage, price),
                "currency": self.currency,
            }
        )

    async def flush(self) -> None:
        """Post every unsent row (≤ 100 a call). Raises when core does not take them; the rows stay for the next flush."""
        async with self._lock:
            while self._sent < len(self._entries):
                chunk = self._entries[self._sent : self._sent + BATCH_CAP]
                await self._sink(InternalSpendRequest.model_validate({"entries": chunk}))
                self._sent += len(chunk)


@dataclass(frozen=True)
class Meter:
    """What one context's model calls are charged as: its role, provider, model id and price, into the run's buffer."""

    buffer: SpendBuffer
    role: str
    provider: str
    model_id: str
    price: Price | None

    def record(self, usage: Usage) -> None:
        self.buffer.add(self.role, self.provider, self.model_id, usage, self.price)
