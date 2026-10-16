"""AI spend rows (W3 close ruling, R-E 1-C; munim_intel/trace/spend.py): one row per provider call, priced at the role's
operator price (ledger R47 D1) and rounded up, posted with the traces — on a failed run too — and never for a reply a
callback made up. A replay with no price is still a row, with its tokens, charged 0.

Expected amounts are worked by hand from the prices typed below (minor units per 1M tokens), never from the code.
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
from munim_intel.trace.price import Price
from munim_intel.trace.spend import Meter, SpendBuffer, Usage, amount_minor

CTX = RunContext(
    "01920000-0000-7000-8000-0000000000a1", "01920000-0000-7000-8000-0000000000a2", ("*",), "ask", "manager", 2_000_000_000, "h.p.s"
)


#: An operator's price, typed by hand: ₹135 per 1M input and ₹675 per 1M output tokens, in paise.
PRICE = Price(13_500, 67_500, "INR")


def test_amounts_by_hand_from_the_operator_price_round_up() -> None:
    # 10,000 × 13,500 + 300 × 67,500 = 135,000,000 + 20,250,000 = 155,250,000 / 1,000,000 = 155.25 → 156 paise.
    assert amount_minor(Usage(10_000, 300), PRICE) == 156
    # One input token: 13,500 / 1,000,000 = 0.0135 paise → rounds UP to 1 (a small priced call is never free).
    assert amount_minor(Usage(1, 0), PRICE) == 1
    # Another role's price in cents (A$0.50 / A$3.00 per 1M): 10,000 × 50 = 500,000 / 1,000,000 = 0.5 → 1 cent.
    assert amount_minor(Usage(10_000, 0), Price(50, 300, "AUD")) == 1
    assert amount_minor(Usage(0, 0), PRICE) == 0  # paired: no tokens, nothing charged
    # A replay carries no price (R47 D1, recorded mode): 0, however many tokens.
    assert amount_minor(Usage(10_000, 300), None) == 0


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


def run(mode: str, *, exhausted: bool = False, price: Price | None = PRICE) -> tuple[list[dict[str, Any]], RunState]:
    posted: list[dict[str, Any]] = []

    async def spend_sink(req: InternalSpendRequest) -> None:
        posted.extend(e.model_dump(mode="json") for e in req.entries)

    async def trace_sink(_: Any) -> None:
        return None

    meter = Meter(SpendBuffer(spend_sink, "INR"), "reason", "gemini", "gemini-3.8-flash", price)
    state = RunState(traces=TraceBuffer(trace_sink), meter=meter)
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
    # 1,000 × 13,500 + 150 × 67,500 = 13,500,000 + 10,125,000 = 23,625,000 / 1,000,000 = 23.625 → 24 paise.
    assert row["amount_minor"] == 24 and row["currency"] == "INR"


def test_a_replay_with_no_price_is_still_a_row_with_its_tokens_at_zero() -> None:
    """R47 D1, recorded mode: no operator price → 0, but the row is posted with the call's counts (the cap still sees it)."""
    posted, _ = run("usage", price=None)
    assert [(r["input_tokens"], r["output_tokens"], r["amount_minor"]) for r in posted] == [(1_000, 150, 0)]


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
    buf.add("router", "gemini", "gemini-3.5-flash-lite", Usage(100, 1), PRICE)
    with pytest.raises(RuntimeError):
        asyncio.run(buf.flush())
    asyncio.run(buf.flush())
    asyncio.run(buf.flush())
    assert sent == [[buf.entries[0]["id"]]], "re-sent once, under the id it was buffered with; nothing after"


class _ResourceExhaustedError(RuntimeError):
    """Named as ADK's own wrapper of a provider 429 (google_llm.py): a class name with a leading underscore."""


class RateLimited(BaseLlm):
    model: str = "gemini-3.8-flash"

    async def generate_content_async(self, llm_request: LlmRequest, stream: bool = False) -> AsyncGenerator[LlmResponse, None]:
        raise _ResourceExhaustedError("429 RESOURCE_EXHAUSTED quota for key AIza-not-a-real-key")
        yield  # an async generator, never reached


def test_a_rate_limited_call_is_charged_and_traced_under_a_valid_label() -> None:
    """Production (16 Oct): `_ResourceExhaustedError` is not a label (no leading underscore), so on_model_error raised,
    the error trace was lost and the call's estimate never reached the meter. Now: one estimated row, the error traced as
    `ResourceExhaustedError` (the message never), and the run fails as the provider's error, not the trace check's."""
    posted: list[dict[str, Any]] = []
    events: list[dict[str, Any]] = []

    async def spend_sink(req: InternalSpendRequest) -> None:
        posted.extend(e.model_dump(mode="json") for e in req.entries)

    async def trace_sink(req: Any) -> None:
        events.extend(e.model_dump(mode="json") for e in req.events)

    state = RunState(
        traces=TraceBuffer(trace_sink), meter=Meter(SpendBuffer(spend_sink, "INR"), "reason", "gemini", "gemini-3.8-flash", PRICE)
    )
    agent = LlmAgent(name="munim", model=RateLimited(), instruction="Say done.")
    with pytest.raises(RunFailed) as failed:
        asyncio.run(run_agent(agent, CTX, "hello", load_config(env={}), state=state))
    errors = [e["payload"] for e in events if e["kind"] == "error" and e["payload"].get("where") == "model"]
    print(f"run failed as {failed.value.kind}; model errors {errors}; spend rows {len(posted)}")
    assert failed.value.kind == "_ResourceExhaustedError"
    assert errors == [{"where": "model", "error": "ResourceExhaustedError"}]
    assert len(posted) == 1 and posted[0]["input_tokens"] > 0 and posted[0]["output_tokens"] == 0
    assert "AIza" not in repr(events)


class FailingTraces(TraceBuffer):
    """A trace buffer whose error traces fail (as a flush to an unreachable core would, at that event)."""

    async def append(self, kind: str, *args: Any, **kwargs: Any) -> str:
        if kind == "error":
            raise RuntimeError("core down")
        return await super().append(kind, *args, **kwargs)


def test_a_failed_calls_spend_is_recorded_before_any_trace_can_fail() -> None:
    """on_model_error charges first: a trace that fails after it (any cause) cannot lose the call's estimate."""

    async def trace_sink(_: Any) -> None:
        return None

    meter = Meter(SpendBuffer(lambda _: asyncio.sleep(0), "INR"), "reason", "gemini", "gemini-3.8-flash", PRICE)
    state = RunState(traces=FailingTraces(trace_sink), meter=meter)
    agent = LlmAgent(name="munim", model=RateLimited(), instruction="Say done.")
    with pytest.raises(RunFailed):
        asyncio.run(run_agent(agent, CTX, "hello", load_config(env={}), state=state))
    assert state.fired["on_model_error_callback"] == 1
    assert len(meter.buffer.entries) == 1 and meter.buffer.entries[0]["input_tokens"] > 0
