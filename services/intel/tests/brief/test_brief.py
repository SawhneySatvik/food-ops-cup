"""T-054 brief gates without core. Gate 3: at most one model call. Gate 4: the hard-cap / AI-off / failed-call fallback is
a complete, cited, digit-free brief. Plus: every number is a ref of its own item, the trace carries no prose, and no
dedupe key can be rendered."""

from __future__ import annotations

import dataclasses
import json
from pathlib import Path
from typing import Any

import pytest
from google.adk.models.llm_response import LlmResponse
from google.genai import types

from munim_intel.brief import BriefItem, Report, compile_brief
from munim_intel.config import load_config
from munim_intel.contracts_gen.models import InternalAnswersRequest, InternalAnswersResponse, InternalSpendRequest
from munim_intel.llm.recorded import RecordedLlm, projection
from munim_intel.mapping import snap_ref
from munim_intel.narrate import refs_of
from munim_intel.runtime.context import RunContext
from munim_intel.runtime.state import RunState
from munim_intel.trace.buffer import TraceBuffer
from munim_intel.trace.spend import Meter, SpendBuffer

from .briefkit import ROWS, RecordingSink, aio, items, texts, vid

FIXTURES = Path(__file__).parent / "fixtures"
CANARY = "CANARYXQZ"
DESKS = ("Customers", "People", "Finance", "Finance", "Inventory and purchasing")


class Spy(RecordedLlm):
    seen: list[str] = []

    async def generate_content_async(self, llm_request: Any, stream: bool = False) -> Any:
        self.seen.append(json.dumps(projection(llm_request), ensure_ascii=False))
        async for r in super().generate_content_async(llm_request, stream):
            yield r


def harness(tmp_path: Path, sent: list[Any] | None = None) -> tuple[RunContext, Any, RunState]:
    cfg = load_config(env={}, run_dir=tmp_path)
    ctx = RunContext(vid(0xAA), vid(0xBB), ("*",), "brief", "brief", 0, "")

    async def sink(req: Any) -> None:
        if sent is not None:
            sent.append(req)

    return ctx, cfg, RunState(traces=TraceBuffer(sink))


def assert_clean_brief(sink: RecordingSink, source: list[BriefItem]) -> None:
    """Hand-stated shape of a good brief: one signed segment per item, in rank order, each citing its own impact cell and
    nothing else, and no digit outside a ref."""
    (req,) = sink.calls
    segs = req.envelope.segments
    assert len(segs) == len(source)
    for seg, item, desk in zip(segs, source, DESKS, strict=True):
        assert seg.text.endswith(f" — {desk} desk")
        assert [r.root for r in seg.refs] == refs_of(seg.text) == [item.impact_ref[1:].split("·")[0]]  # type: ignore[index]
        rest = seg.text
        for t in refs_of(seg.text):
            rest = rest.replace(f"⟨{t}·0·impact_minor⟩", "")
        assert not any(ch.isdigit() for ch in rest), rest


@aio
async def test_one_recorded_model_call_words_every_item_and_each_is_signed(tmp_path: Path) -> None:
    ctx, cfg, state = harness(tmp_path)
    spent: list[Any] = []

    async def spend_sink(req: InternalSpendRequest) -> None:
        spent.extend(req.entries)

    state.meter = Meter(SpendBuffer(spend_sink, "INR"), "narrate", "gemini", "recorded/narrate", None)
    llm = Spy(model="recorded/narrate", fixtures_dir=FIXTURES, seen=[])
    sink, src = RecordingSink(), items()
    before = RecordedLlm.calls
    r = await compile_brief(src, sink, ctx=ctx, llm=llm, cfg=cfg, state=state)
    assert RecordedLlm.calls - before == 1 and len(llm.seen) == 1 and r.model_calls == 1  # gate 3
    assert (r.model_items, r.template_items, r.dropped, r.posted) == (5, 0, 0, True)
    assert_clean_brief(sink, src)
    got = texts(sink)
    assert got[0].startswith("Lapsed regulars are the biggest money at risk today ⟨snap:")
    # W3 close ruling (money): the one call is one `narrate` spend row, posted by the run's flush.
    # Recorded: no operator price (R47 D1) → 0, but the row and its tokens are posted.
    assert [(e.role, e.currency, e.amount_minor) for e in spent] == [("narrate", "INR", 0)] and spent[0].input_tokens > 0
    assert got[2].endswith("A draft is ready for your decision. — Finance desk")  # item 3 has the one draft
    assert sum("A draft is ready" in t for t in got) == 1
    assert state.fired  # the plugin saw the call


@pytest.mark.fixture_miss_expected
@aio
async def test_hard_cap_ai_off_and_a_failed_call_each_give_the_complete_template_brief_with_no_model_call(tmp_path: Path) -> None:
    src = items()
    for how in ("cap", "off", "fail"):
        ctx, cfg, state = harness(tmp_path)
        llm: RecordedLlm | None = RecordedLlm(model="recorded/narrate", fixtures_dir=FIXTURES)
        if how == "cap":
            state.budget.model_calls = state.budget.max_model_calls
        if how == "off":
            llm = None
        if how == "fail":
            llm = RecordedLlm(model="recorded/narrate", fixtures_dir=tmp_path)  # no fixtures here: the call fails
        sink = RecordingSink()
        before = RecordedLlm.calls
        r = await compile_brief(src, sink, ctx=ctx, llm=llm, cfg=cfg, state=state)
        assert RecordedLlm.calls - before == 0, how
        assert (r.model_items, r.template_items, r.posted) == (0, 5, True), how
        assert r.model_calls == (1 if how == "fail" else 0), how
        assert_clean_brief(sink, src)
        assert texts(sink)[0].startswith("Regulars have stopped coming back, about ⟨snap:"), how


class Lines(RecordedLlm):
    """A model that says `reply` (no fixture: these lines are the plant)."""

    reply: str = ""

    async def generate_content_async(self, llm_request: Any, stream: bool = False) -> Any:
        yield LlmResponse(content=types.Content(role="model", parts=[types.Part(text=self.reply)]))


@aio
async def test_a_planted_digit_or_forged_ref_or_second_line_is_dropped_to_the_template(tmp_path: Path) -> None:
    ctx, cfg, state = harness(tmp_path)
    src = items()
    forged = snap_ref(vid(0xBAD), 0, "impact_minor")
    reply = "\n".join(
        [
            "Seven regulars are at risk {I1}.",  # a number word: core's grammar refuses it, so item 1 keeps its template
            "Another view of the same item {I1}.",  # a later line for item 1 does not stand in for the refused one
            f"Staff money is owed {forged} {{I2}}.",  # a ref the model typed (forged)
            "Takings are off {I3}.",  # accepted
            "Payouts are late by 12 days {I4}.",  # a digit
            "Payouts are late {I9}.",  # unknown handle
            "No handle at all.",
            "The same bill looks booked again {I5}k.",  # a magnitude suffix on the expanded ref (⟩k)
        ]
    )
    sink = RecordingSink()
    r = await compile_brief(src, sink, ctx=ctx, llm=Lines(model="recorded/narrate", reply=reply), cfg=cfg, state=state)
    got = texts(sink)
    # By hand: only item 3's line stands; items 1, 2, 4 and 5 keep their stored text; all 8 lines but one are dropped.
    assert got[0].startswith("Regulars have stopped coming back")
    assert got[1].startswith("Staff advances are still outstanding")
    assert got[2].startswith("Takings are off ⟨snap:")
    assert got[3].startswith("Delivery payouts have not arrived")
    assert got[4].startswith("A near-identical invoice was booked again")
    assert (r.model_items, r.template_items, r.dropped) == (1, 4, 7)
    assert forged not in " ".join(got) and "Seven" not in " ".join(got)


@aio
async def test_a_stored_text_citing_a_document_lists_that_cite_in_refs(tmp_path: Path) -> None:
    """R-E 3: refs[] holds every ref the text cites — a cite too, not only snapshot cells — or core refuses the segment
    (every ref must be declared). Hand: the item's impact cell and a document span."""
    ctx, _, _ = harness(tmp_path)
    doc = f"⟨cite:doc:{vid(0xD0C)}·0-12⟩"
    item = dataclasses.replace(items()[0], texts=(f"Regulars lapsed {items()[0].impact_ref}, as the review {doc} says.",))
    sink = RecordingSink()
    await compile_brief([item], sink, ctx=ctx)
    (req,) = sink.calls
    assert [r.root for r in req.envelope.segments[0].refs] == [f"snap:{vid(0x500)}", f"doc:{vid(0xD0C)}"]


class AbstainingSink(RecordingSink):
    """core refusing the first `refuse` posts (as its validator would a brief it cannot verify)."""

    def __init__(self, refuse: int) -> None:
        super().__init__()
        self.refuse = refuse

    async def post(self, req: InternalAnswersRequest) -> InternalAnswersResponse:
        self.calls.append(req)
        abstained = len(self.calls) <= self.refuse
        return InternalAnswersResponse.model_validate(
            {"answer_id": req.envelope.answer_id.root, "abstained": abstained, "reason_code": "number_grammar" if abstained else None}
        )


@aio
async def test_a_brief_core_abstains_is_reposted_template_only_under_its_own_id(tmp_path: Path) -> None:
    ctx, cfg, state = harness(tmp_path)
    src = items()
    sink = AbstainingSink(refuse=1)
    r = await compile_brief(src, sink, ctx=ctx, llm=RecordedLlm(model="recorded/narrate", fixtures_dir=FIXTURES), cfg=cfg, state=state)
    first, second = sink.calls
    assert [s.text for s in first.envelope.segments][0].startswith("Lapsed regulars are the biggest money at risk today")
    # The re-post is the template brief, by hand: each item's stored text, the draft clause on item 3, signed.
    want = [t.format(ref=it.impact_ref) for (_, _, _, t), it in zip(ROWS, src, strict=True)]
    want[2] += " A draft is ready for your decision."
    assert [s.text for s in second.envelope.segments] == [f"{w} — {d} desk" for w, d in zip(want, DESKS, strict=True)]
    assert second.envelope.answer_id.root != first.envelope.answer_id.root and second.question == first.question
    assert (r.posted, r.abstained, r.reposted, r.model_items, r.template_items) == (True, False, True, 0, 5)
    # Deterministic ids: the same run re-posts under the same two ids (a retried /brief replays, never duplicates).
    again = AbstainingSink(refuse=1)
    _, _, state2 = harness(tmp_path)
    await compile_brief(src, again, ctx=ctx, llm=RecordedLlm(model="recorded/narrate", fixtures_dir=FIXTURES), cfg=cfg, state=state2)
    assert [c.envelope.answer_id.root for c in again.calls] == [c.envelope.answer_id.root for c in sink.calls]


@aio
async def test_paired_a_brief_core_accepts_or_a_template_brief_it_abstains_is_posted_once(tmp_path: Path) -> None:
    ctx, cfg, state = harness(tmp_path)
    ok = AbstainingSink(refuse=0)
    r = await compile_brief(items(), ok, ctx=ctx, llm=RecordedLlm(model="recorded/narrate", fixtures_dir=FIXTURES), cfg=cfg, state=state)
    assert len(ok.calls) == 1 and (r.posted, r.reposted, r.model_items) == (True, False, 5)
    refused = AbstainingSink(refuse=2)
    r = await compile_brief(items(), refused, ctx=ctx)  # AI off: the template brief; a refusal of it has nothing to fall back to
    assert len(refused.calls) == 1 and (r.posted, r.abstained, r.reposted) == (False, True, False)


@aio
async def test_untrusted_text_never_reaches_the_model_or_a_trace_and_no_dedupe_key_exists(tmp_path: Path) -> None:
    sent: list[Any] = []
    ctx, cfg, state = harness(tmp_path, sent)
    src = items()
    src[0] = dataclasses.replace(src[0], texts=(src[0].texts[0] + f" {CANARY}",))
    llm = Spy(model="recorded/narrate", fixtures_dir=FIXTURES, seen=[])
    sink = RecordingSink()
    await compile_brief(src, sink, ctx=ctx, llm=llm, cfg=cfg, state=state)
    assert len(llm.seen) == 1 and CANARY not in llm.seen[0]  # the request holds handles, desks, severities and kinds only
    await state.traces.flush()
    assert sent and CANARY not in json.dumps([r.model_dump(mode="json") for r in sent])
    assert not any(f.name in ("dedupe_key", "key") for f in dataclasses.fields(BriefItem))  # review R-B: no key to render
    # a stored text that carries a key-like string with digits is not rendered either (the drop rule), the item falls back
    keyed = dataclasses.replace(items()[0], texts=("Lapsed regulars 2026-W41 outlet-1 " + items()[0].impact_ref,))  # type: ignore[operator]
    sink2 = RecordingSink()
    await compile_brief([keyed], sink2, ctx=ctx, llm=None)
    assert "2026" not in texts(sink2)[0] and "W41" not in texts(sink2)[0]
    assert texts(sink2)[0].startswith("A high finding needs your attention, impact ⟨snap:")


@aio
async def test_an_empty_brief_posts_nothing_and_only_the_top_five_are_worded(tmp_path: Path) -> None:
    ctx, cfg, state = harness(tmp_path)
    sink = RecordingSink()
    r = await compile_brief([], sink, ctx=ctx, llm=None)
    assert (r, sink.calls) == (Report(), [])
    seven = items() + items()[:2]
    r = await compile_brief(seven, sink, ctx=ctx, llm=None)
    assert r.items == 5 and len(texts(sink)) == 5
