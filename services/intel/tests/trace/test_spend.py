"""AI spend rows (W3 close ruling, R-E 1-C; munim_intel/trace/spend.py): one row per provider call, priced from the flagged
placeholder table and rounded up, posted with the traces — on a failed run too — and never for a reply a callback made up.

Expected amounts are worked by hand from the module docstring's stated rates (nano-USD per token × minor units per USD).
"""

from __future__ import annotations

import asyncio
from collections.abc import AsyncGenerator
from typing import Any

import pytest
from google.adk.agents import LlmAgent
from google.adk.models import BaseLlm
from google.adk.models.llm_request import LlmRequest
from google.adk.models.llm_response import LlmResponse
from google.genai import types

from munim_intel.config import load_config
from munim_intel.contracts_gen.models import InternalSpendRequest
from munim_intel.runtime.context import RunContext
from munim_intel.runtime.runner import RunFailed, run_agent
from munim_intel.runtime.state import RunState
from munim_intel.trace.buffer import TraceBuffer
from munim_intel.trace.spend import Meter, SpendBuffer, Usage, amount_minor

CTX = RunContext(
    "01920000-0000-7000-8000-0000000000a1", "01920000-0000-7000-8000-0000000000a2", ("*",), "ask", "manager", 2_000_000_000, "h.p.s"
)


def test_amounts_by_hand_round_up_and_never_price_at_zero() -> None:
    # gemini-3.8-flash: 1,500 in / 7,500 out nano-USD a token; INR 9,000 paise a dollar.
    # 10,000 × 1,500 + 300 × 7,500 = 17,250,000 nUSD → × 9,000 / 1e9 = 155.25 → 156 paise.
    assert amount_minor("gemini-3.8-flash", Usage(10_000, 300), "INR") == 156
    # One token on flash-lite: 300 nUSD → 0.0027 paise → rounds UP to 1 (a small call is never free).
    assert amount_minor("gemini-3.5-flash-lite", Usage(1, 0), "INR") == 1
    # AUD: 155 cents a dollar. 10,000 × 1,500 nUSD = 0.015 USD → 2.325 cents → 3.
    assert amount_minor("gemini-3.8-flash", Usage(10_000, 0), "AUD") == 3
    # A recorded replay is priced as its role's model of record; an unknown model at the table's highest rate.
    assert amount_minor("recorded/reason", Usage(10_000, 300), "INR") == 156
    assert amount_minor("some-new-model", Usage(10_000, 300), "INR") == 156
    assert amount_minor("anything", Usage(0, 0), "INR") == 0  # paired: no tokens, nothing charged
    with pytest.raises(ValueError):
        amount_minor("gemini-3.8-flash", Usage(1, 1), "EUR")


class Usaged(BaseLlm):
    """Replies once with a provider usage count, or raises (a provider error), or replies with no count."""

    model: str = "gemini-3.8-flash"
    mode: str = "usage"

    async def generate_content_async(self, llm_request: LlmRequest, stream: bool = False) -> AsyncGenerator[LlmResponse, None]:
        if self.mode == "raise":
            raise RuntimeError("provider down")
        usage = (
            types.GenerateContentResponseUsageMetadata(prompt_token_count=1_000, candidates_token_count=100, thoughts_token_count=50)
            if self.mode == "usage"
            else None
        )
        yield LlmResponse(content=types.Content(role="model", parts=[types.Part(text="done")]), usage_metadata=usage)


def run(mode: str, *, exhausted: bool = False) -> tuple[list[dict[str, Any]], RunState]:
    posted: list[dict[str, Any]] = []

    async def spend_sink(req: InternalSpendRequest) -> None:
        posted.extend(e.model_dump(mode="json") for e in req.entries)

    async def trace_sink(_: Any) -> None:
        return None

    state = RunState(traces=TraceBuffer(trace_sink), meter=Meter(SpendBuffer(spend_sink, "INR"), "reason", "gemini", "gemini-3.8-flash"))
    if exhausted:
        state.budget.model_calls = state.budget.max_model_calls
    agent = LlmAgent(name="munim", model=Usaged(mode=mode), instruction="Say done.")
    try:
        asyncio.run(run_agent(agent, CTX, "hello", load_config(env={}), state=state))
    except RunFailed:
        pass
    return posted, state


def test_a_reported_call_is_one_row_with_the_providers_counts_thinking_billed_as_output() -> None:
    posted, _ = run("usage")
    assert len(posted) == 1
    row = posted[0]
    assert (row["role"], row["provider"], row["model_id"], row["input_tokens"], row["output_tokens"]) == (
        "reason",
        "gemini",
        "gemini-3.8-flash",
        1_000,
        150,
    )
    # 1,000 × 1,500 + 150 × 7,500 = 2,625,000 nUSD → × 9,000 / 1e9 = 23.625 → 24 paise.
    assert row["amount_minor"] == 24 and row["currency"] == "INR"


def test_a_call_with_no_count_is_charged_on_the_request_size_estimate() -> None:
    posted, _ = run("silent")
    assert len(posted) == 1 and posted[0]["input_tokens"] > 0 and posted[0]["output_tokens"] == 0 and posted[0]["amount_minor"] >= 1


def test_a_failed_call_is_still_charged_and_posted_by_the_failed_runs_flush() -> None:
    posted, state = run("raise")
    assert len(posted) == 1 and posted[0]["input_tokens"] > 0
    assert state.meter is not None and len(state.meter.buffer.entries) == 1


def test_paired_a_reply_the_budget_fallback_made_up_is_not_charged() -> None:
    posted, state = run("usage", exhausted=True)
    assert posted == [] and state.fired["after_model_callback"] == 0


def test_a_flush_is_idempotent_and_a_refused_flush_keeps_its_rows_for_the_next() -> None:
    sent: list[list[str]] = []
    fail = [True]

    async def sink(req: InternalSpendRequest) -> None:
        if fail[0]:
            fail[0] = False
            raise RuntimeError("core down")
        sent.append([e.id.root for e in req.entries])

    buf = SpendBuffer(sink, "INR")
    buf.add("router", "gemini", "gemini-3.5-flash-lite", Usage(100, 1))
    with pytest.raises(RuntimeError):
        asyncio.run(buf.flush())
    asyncio.run(buf.flush())
    asyncio.run(buf.flush())
    assert sent == [[buf.entries[0]["id"]]], "re-sent once, under the id it was buffered with; nothing after"
