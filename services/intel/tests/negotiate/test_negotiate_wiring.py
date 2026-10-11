"""W3.2 wiring for T-055: the run's model-call budget and the deal-review traces. Hand values from s1_world.json
`expected._worked` (three suppliers, two counters: 3 + 2 + 2 extractions and 3 choices) and packs/inventory-purchasing.md
§6 (the five review rules): never from the code under test."""

from __future__ import annotations

import asyncio
import json
from pathlib import Path

import pytest

from kit import DEFAULT_POLICY, WORLD, CountingLlm, run_s1, supplier_key
from kit import no_fixture_misses as no_fixture_misses  # autouse: a missing recorded fixture fails the test
from munim_intel.negotiate.policy import NegotiationPolicy
from munim_intel.negotiate.run import negotiation_budget
from munim_intel.trace.buffer import TraceBuffer, TraceLabelError

EXPECT = WORLD["expected"]
RUN_ID = "0199a000-0000-7000-8000-00000000e0e0"


def test_the_budget_is_twelve_model_calls_for_three_suppliers() -> None:
    # 3 suppliers × (2 counters + the RFQ reply) extractions + 3 decision rounds = 12; one counter: 3 × 2 + 2 = 8.
    assert negotiation_budget(3, DEFAULT_POLICY).max_model_calls == 12
    assert negotiation_budget(3, NegotiationPolicy(9_500, 11_000, max_counters=1)).max_model_calls == 8
    assert negotiation_budget(3, DEFAULT_POLICY).max_tool_calls == 0


def test_a_third_counter_is_refused_at_config() -> None:
    """intel.supplier_quote CHECK (round BETWEEN 1 AND 3): the RFQ round plus at most two counters."""
    with pytest.raises(ValueError):
        NegotiationPolicy(9_500, 11_000, max_counters=3)
    with pytest.raises(ValueError):
        NegotiationPolicy(9_500, 11_000, max_counters=-1)
    assert NegotiationPolicy(9_500, 11_000, max_counters=2).decision_rounds == 3


def test_no_trace_carries_a_note_or_reply_text(tmp_path: Path) -> None:
    """Decision.note (model prose) and supplier replies stay out of traces: ids, labels and codes only."""
    r = asyncio.run(run_s1(tmp_path))
    notes = {d.note for d in r.outcome.decisions if isinstance(d.note, str)}
    replies = {c["text"] for c in r.core.chunks.values()}
    payloads = [json.dumps(e.model_dump(mode="json")["payload"], ensure_ascii=False) for e in r.core.traces.values()]
    leaked = [p for p in payloads if any(n in p for n in notes | replies)]
    words = [p for p in payloads if any(w in p for w in ("Thank you", "Simulated supplier", "we can supply"))]
    print(
        f"notes {len(notes)}, replies {len(replies)}, trace payloads {len(payloads)}, carrying either {len(leaked)}, "
        f"prose words {len(words)}"
    )
    assert notes and replies and payloads and leaked == [] and words == []


def test_quote_ids_are_the_same_for_the_same_run(tmp_path: Path) -> None:
    """A retried negotiation (same run) posts the same quote and chunk ids, so core answers `existing`, not new rows."""
    a = asyncio.run(run_s1(tmp_path / "a", run_id=RUN_ID))
    b = asyncio.run(run_s1(tmp_path / "b", run_id=RUN_ID))
    c = asyncio.run(run_s1(tmp_path / "c"))
    ids = [sorted(q["id"] for q in x.core.quotes) for x in (a, b, c)]
    chunks = [sorted(x.core.chunks) for x in (a, b)]
    assert ids[0] and ids[0] == ids[1] and set(ids[0]).isdisjoint(ids[2])
    assert chunks[0] and chunks[0] == chunks[1]
    assert [q["source_chunk_id"] for q in a.core.quotes] == [q["source_chunk_id"] for q in b.core.quotes]


def test_the_po_cites_the_last_price_its_bounds_came_from(tmp_path: Path) -> None:
    r = asyncio.run(run_s1(tmp_path))
    po = r.outcome.draft_request
    assert po is not None
    price = next(s for s in r.core.snapshots.values() if s["template_id"] == "purchasing.price_creep")
    cited = [ref for ref in po["based_on"] if price["snapshot_id"] in ref]
    assert len(cited) == 1 and r.core.cell(cited[0]) == WORLD["rfq"]["reference_price_minor"]
    assert f"snap:{price['snapshot_id']}" in po["evidence"]


def test_a_run_inside_that_budget_counters_reviews_and_traces_one_review_per_accepted_quote(tmp_path: Path) -> None:
    """Paired with gate 5's budget stop (3 calls → no counter): at 12 the worked run counters (the steady supplier ends
    at 792) and stays inside the cap. Review traces: steady pass, premium pass, discounter fail moq_exceeds_need — ids
    and codes only (the contract's TraceReviewPayload)."""
    CountingLlm.log.clear()
    r = asyncio.run(run_s1(tmp_path, max_model_calls=negotiation_budget(3, DEFAULT_POLICY).max_model_calls))
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
