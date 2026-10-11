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

PRICES — UNVERIFIED, FOUNDER QUESTION (money). Neither core, the country packs nor `platform.model_role` holds a model
price, so the rates below are a documented placeholder table, not a source of truth:
  - per-token USD list prices from Google Cloud's "Vertex AI / Agent Platform pricing" page, fetched 9 Oct 2026
    (global endpoint, text): gemini-3.5-flash-lite $0.30 in / $2.50 out per 1M tokens — the first of the two rows the
    page lists for it (the other is $0.54 / $4.50; which tier applies is UNVERIFIED); gemini-3.8-flash $1.50 / $7.50 per
    1M, the standard price from 1 Jan 2027 — the page's introductory $0.75 / $3.75 to 31 Dec 2026 is not used, so the cap
    errs early, never late; gemini-embedding-001 $0.00015 per 1k input read as $0.15 per 1M tokens (unit UNVERIFIED);
  - a model this table does not know is priced at its highest rate;
  - USD → the budget currency at a fixed placeholder rate (₹90 and A$1.55 per US$, chosen, not sourced), never a live
    FX feed; a currency with no rate raises (spend is never unpriced).
Each call's amount is rounded UP to a whole minor unit (a small call never rounds to zero). Replace this table with an
operator-set price per role (a `platform.model_role` column, migrator lane) before any real budget relies on it.
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

#: Nano-USD per token (input, output). UNVERIFIED placeholders; see the module docstring.
RATES_UNVERIFIED: dict[str, tuple[int, int]] = {
    "gemini-3.5-flash-lite": (300, 2_500),
    "gemini-3.8-flash": (1_500, 7_500),
    "gemini-embedding-001": (150, 0),
}
#: A recorded replay stands in for its role's model of record (0015's platform.model_role seed).
RECORDED_AS = {
    "recorded/router": "gemini-3.5-flash-lite",
    "recorded/extract": "gemini-3.5-flash-lite",
    "recorded/narrate": "gemini-3.5-flash-lite",
    "recorded/reason": "gemini-3.8-flash",
    "recorded/vision": "gemini-3.8-flash",
    "recorded/embed": "gemini-embedding-001",
}
#: Minor units of the budget currency per US dollar. UNVERIFIED placeholders (₹90, A$1.55); see the module docstring.
MINOR_PER_USD_UNVERIFIED = {"INR": 9_000, "AUD": 155}
#: core's per-call cap (contracts `SpendRequest.entries` max 100).
BATCH_CAP = 100
CHARS_PER_TOKEN = 3.5


@dataclass(frozen=True)
class Usage:
    input_tokens: int
    output_tokens: int
    #: The provider reported no count: input estimated from the request's size, output 0.
    estimated: bool = False


def rate(model_id: str) -> tuple[int, int]:
    known = RATES_UNVERIFIED.get(RECORDED_AS.get(model_id, model_id))
    if known is not None:
        return known
    return max(r[0] for r in RATES_UNVERIFIED.values()), max(r[1] for r in RATES_UNVERIFIED.values())


def amount_minor(model_id: str, usage: Usage, currency: str) -> int:
    """The call's cost in minor units of `currency`, rounded up. An unknown currency raises: spend is never unpriced."""
    per_usd = MINOR_PER_USD_UNVERIFIED.get(currency)
    if per_usd is None:
        raise ValueError(f"no USD rate for currency {currency!r}")
    rin, rout = rate(model_id)
    nano_usd = usage.input_tokens * rin + usage.output_tokens * rout
    return -(-nano_usd * per_usd // 1_000_000_000)


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

    def add(self, role: str, provider: str, model_id: str, usage: Usage) -> None:
        self._entries.append(
            {
                "id": uuid7(),
                "role": role,
                "provider": provider,
                "model_id": model_id,
                "input_tokens": usage.input_tokens,
                "output_tokens": usage.output_tokens,
                "amount_minor": amount_minor(model_id, usage, self.currency),
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
    """What one context's model calls are charged as: its role, provider and model id, into the run's buffer."""

    buffer: SpendBuffer
    role: str
    provider: str
    model_id: str

    def record(self, usage: Usage) -> None:
        self.buffer.add(self.role, self.provider, self.model_id, usage)
