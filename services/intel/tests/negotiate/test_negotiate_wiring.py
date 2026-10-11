"""W3.2 wiring for T-055: the run's model-call budget and the deal-review traces. Hand values from s1_world.json
`expected._worked` (three suppliers, two counters: 3 + 2 + 2 extractions and 3 choices) and packs/inventory-purchasing.md
§6 (the five review rules): never from the code under test."""

from __future__ import annotations

import asyncio
from pathlib import Path

import pytest

from kit import WORLD, CountingLlm, run_s1, supplier_key
from munim_intel.negotiate.policy import NegotiationPolicy
from munim_intel.negotiate.run import negotiation_budget
from munim_intel.trace.buffer import TraceBuffer, TraceLabelError

EXPECT = WORLD["expected"]


def test_the_budget_is_twelve_model_calls_for_three_suppliers() -> None:
    # 3 suppliers × (2 counters + the RFQ reply) extractions + 3 decision rounds = 12; a third counter adds 3 + 1.
    assert negotiation_budget(3).max_model_calls == 12
    assert negotiation_budget(3, NegotiationPolicy(max_counters=3)).max_model_calls == 16
    assert negotiation_budget(3).max_tool_calls == 0


def test_a_run_inside_that_budget_counters_reviews_and_traces_one_review_per_accepted_quote(tmp_path: Path) -> None:
    """Paired with gate 5's budget stop (3 calls → no counter): at 12 the worked run counters (the steady supplier ends
    at 792) and stays inside the cap. Review traces: steady pass, premium pass, discounter fail moq_exceeds_need — ids
    and codes only (the contract's TraceReviewPayload)."""
    CountingLlm.log.clear()
    r = asyncio.run(run_s1(tmp_path, max_model_calls=negotiation_budget(3).max_model_calls))
    po = r.outcome.draft_request
    assert po is not None
    assert (supplier_key(po["payload"]["supplier_id"]), r.core.cell(po["payload"]["lines"][0]["unit_price_minor"])) == ("steady", 792)
    assert len(CountingLlm.log) <= 12 and any(d.move == "counter" for d in r.outcome.decisions)
    reviews = [e.model_dump(mode="json") for e in r.core.traces.values() if e.kind == "review"]
    got = sorted((supplier_key(next(q["supplier_id"] for q in r.core.quotes if q["id"] == e["payload"]["subject_id"])),
                  e["payload"]["verdict"], e["payload"]["reason_code"]) for e in reviews)  # fmt: skip
    print("review traces:", got)
    assert got == [("discounter", "fail", "moq_exceeds_need"), ("premium", "pass", None), ("steady", "pass", None)]
    assert all(
        e["actor"] == "specialist:inventory_purchasing" and all(ref.startswith("snap:") for ref in e["payload"]["refs"]) for e in reviews
    )


def test_a_review_trace_takes_only_a_contract_code_set_exactly_when_not_pass() -> None:
    async def sink(_: object) -> object:
        return None

    buf = TraceBuffer(sink)
    ok = asyncio.run(
        buf.review("specialist:inventory_purchasing", "fail", "moq_exceeds_need", ["snap:01920000-0000-7000-8000-000000000001"], None)
    )
    assert buf.events[0].id.root == ok
    with pytest.raises(TraceLabelError):
        asyncio.run(
            buf.review("specialist:inventory_purchasing", "pass", "moq_exceeds_need", ["snap:01920000-0000-7000-8000-000000000001"], None)
        )
    with pytest.raises(ValueError):  # free text where a code belongs: the contracts' ReasonCode refuses it
        asyncio.run(
            buf.review("specialist:inventory_purchasing", "fail", "the supplier lied", ["snap:01920000-0000-7000-8000-000000000001"], None)
        )
    assert len(buf.events) == 1
