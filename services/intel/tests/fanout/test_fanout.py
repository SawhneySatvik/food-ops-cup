"""T-053 gates (BOARD b-53 (1)–(6)): fan-out, offline — real ADK Runners (the Manager's and one per branch, each with its
own InMemorySessionService), real InternalClient, real plugin, recorded models, an in-memory core. The real core is
test_fanout_e2e.py.

Expected values never come from the code under test:
  (1) labels.json is hand-written (its `_about` says how); the replies are synthetic, so this proves plumbing;
  (2) "parallel" = every branch started before any branch ended, read from the stored trace order (seq);
  (3) the 16k per-call cap is ADR-014 §6.1's; the markers are the member's question and the thread block's text, which
      only the Manager's context holds (positive control: the Manager's own request does hold them);
  (4) each branch's expected tools are `report` plus that skill's own read tools (skills/<pack>/skill.py);
  (5) the injection is planted in a test-only `search` (no skill binds search yet);
  (6) the caps are copied by hand from ADR-014 §3.4's table.
"""

from __future__ import annotations

import asyncio
import json
import re
import unicodedata
from functools import cache
from typing import Any

import pytest

from fanout_kit import (
    BY_QUESTION,
    CTX,
    EXTRA,
    HERE,
    INJECTED,
    INJECTION,
    QUESTIONS,
    RUNAWAY,
    FakeCore,
    Q,
    Run,
    frame,
    kit_cfg,
    models,
    run,
    vid,
)
from munim_intel.contracts_gen.models import ThreadsIntelAskRequest
from munim_intel.fanout.tool import Branches, FanOutTool
from munim_intel.manager.ask import prepare
from munim_intel.manager.paths import PATHS, bind
from munim_intel.runtime.state import PACKS, RunState
from munim_intel.skills import load_skill
from munim_intel.tools.handles import HandleTable
from munim_intel.trace.buffer import TraceBuffer

#: Block 6b's opening words (context/assembler.py thread_block): only the Manager's context of an ask in a thread has them.
THREAD_MARK = "Thread so far: this question follows earlier turns"
LABELS: dict[str, Any] = {k: v for k, v in json.loads((HERE / "labels.json").read_text("utf8")).items() if not k.startswith("_")}
CANONICAL = re.compile(r"⟨snap:([0-9a-f-]{36})·(\d+)·([a-z_][a-z0-9_]*)⟩")

#: ADR-014 §3.4, by hand.
ORCHESTRATOR = {"per_call": 24_000, "calls": 6, "tools": 6, "input": 100_000, "output": 4_000}
BRANCH = {"per_call": 16_000, "calls": 6, "tools": 8, "input": 60_000, "output": 2_000}
RUN_INPUT, RUN_OUTPUT, MAX_BRANCHES = 340_000, 12_000, 4
#: packs/kitchen.md §1: kitchen is off for shops — no model call for it on a shop-only scope.
OFF_FOR_SHOPS = {"kitchen"}

FANNED = [q for q in [*QUESTIONS, *EXTRA] if q.packs]


@cache
def replay(question: str) -> Run:
    return run(BY_QUESTION[question])


def classify(r: Run) -> dict[str, Any]:
    route: dict[str, Any] = next((e["payload"] for e in r.core.traces if e["kind"] == "route" and "path" in e["payload"]), {})
    env = r.envelope
    return {
        "intent": route.get("intent"),
        # R-E 2-C: the band too, so a route fixture that went missing (the router abstains → explain, band low) cannot
        # pass for a recorded `explain`.
        "band": route.get("band"),
        "path": route.get("path"),
        "branches": sorted({e["actor"].removeprefix("branch:") for e in r.core.traces if e["actor"].startswith("branch:")}),
        "outcome": f"abstained:{env['reason_code']}" if env["abstained"] else "answered",
    }


def assert_refs_resolve(r: Run) -> None:
    """Every number in the stored answer is a canonical ref to a cell the core minted in this run, and refs[] lists
    exactly the snapshots cited; outside the refs, no numeric character at all."""
    env = r.envelope
    assert env["segments"], "an answered ask has segments"
    for seg in env["segments"]:
        cited = CANONICAL.findall(seg["text"])
        assert cited, f"segment cites nothing: {seg['text']!r}"
        for sid, row, col in cited:
            snap = r.core.snapshots[sid]
            assert int(row) < len(snap["rows"]) and col in snap["rows"][int(row)], (sid, row, col)
        assert seg["refs"] == list(dict.fromkeys(f"snap:{sid}" for sid, _, _ in cited))
        prose = CANONICAL.sub("", seg["text"])
        assert not any(unicodedata.category(c)[0] == "N" for c in prose), f"a typed number: {prose!r}"


# -- gate 1: 20 recorded questions → the hand-labelled classifications, 4 abstentions ---------------------------------


def test_the_labels_are_twenty_questions_with_four_abstentions() -> None:
    assert len(QUESTIONS) == 20 and set(LABELS) == {q.question for q in QUESTIONS}
    assert sum(1 for v in LABELS.values() if v["outcome"].startswith("abstained:")) == 4


@pytest.mark.parametrize("q", QUESTIONS, ids=lambda q: q.question[:32])
def test_each_recorded_question_gets_its_hand_label(q: Q) -> None:
    r = replay(q.question)
    got = classify(r)
    print(f"{q.question[:44]:44} {got}")
    assert got == LABELS[q.question]
    if got["outcome"] == "answered":
        assert_refs_resolve(r)


def test_the_merged_answer_cites_cells_the_branches_minted() -> None:
    """The Manager merges in submit_answer through the run's one HandleTable: every snapshot it cites was minted by a
    branch (the Manager read nothing itself), and each branch that answered is cited."""
    r = replay("Why was this week bad?")
    assert r.prepared is not None and r.prepared.fan_out is not None
    assert len(r.core.snapshots) == 3, "one read per branch, none by the Manager"
    cited = {sid for seg in r.envelope["segments"] for sid, _, _ in CANONICAL.findall(seg["text"])}
    assert cited == set(r.core.snapshots)


def test_every_model_call_of_a_fan_out_ask_is_one_spend_row() -> None:
    """W3 close ruling (R-E 1-C, money): the DecisionModel's call, the Manager's and every branch's are each one spend
    row, posted before the answer. By hand from the kit's script for this question: route.intent 1 call; the Manager 2
    (fan_out, then the merge); each of its 3 branches 2 (its read, then report) = 9."""
    r = replay("Why was this week bad?")
    assert sorted(e["role"] for e in r.core.spend) == ["reason"] * 8 + ["router"]
    # A replay has no operator price (R47 D1): each row is charged 0, never skipped (priced: tests/trace/test_spend.py).
    assert len({e["id"] for e in r.core.spend}) == 9 and all(e["currency"] == "INR" and e["amount_minor"] == 0 for e in r.core.spend)
    # No usage in a recorded reply: each row's input is the request-size estimate, never zero.
    assert all(e["input_tokens"] > 0 for e in r.core.spend)


def test_paired_a_certification_ask_posts_only_its_route_call() -> None:
    r = replay("Certify that our books for September are correct")
    assert [e["role"] for e in r.core.spend] == ["router"], "the route.intent call only: certification needs no Manager"


# -- gate 2: ≥ 3 parallel branches in the trace -----------------------------------------------------------------------


def branch_spans(r: Run) -> dict[str, tuple[int, int]]:
    starts: dict[str, int] = {}
    ends: dict[str, int] = {}
    for e in sorted(r.core.traces, key=lambda e: e["seq"]):
        if e["actor"].startswith("branch:") and e["kind"] == "subagent_start":
            starts.setdefault(e["actor"], e["seq"])
        if e["actor"].startswith("branch:") and e["kind"] == "subagent_end":
            ends[e["actor"]] = e["seq"]
    return {a: (starts[a], ends[a]) for a in starts}


@pytest.mark.parametrize("question", ["Why was this week bad?", "Look into why weekend sales were weak"])
def test_at_least_three_branches_run_in_parallel(question: str) -> None:
    spans = branch_spans(replay(question))
    print(question, spans)
    assert len(spans) >= 3 and len(spans) == len(BY_QUESTION[question].packs)
    assert max(s for s, _ in spans.values()) < min(e for _, e in spans.values()), "every branch starts before any ends"
    seqs = [e["seq"] for e in replay(question).core.traces]
    assert seqs == list(range(1, len(seqs) + 1)), "one gapless trace sequence across the Manager and its branches"


# -- gate 3: each branch's first LlmRequest: 0 orchestrator events, ≤ 16k tokens -------------------------------------


@pytest.mark.parametrize("q", FANNED, ids=lambda q: q.question[:32])
def test_each_branch_first_request_holds_no_orchestrator_event_and_fits_16k(q: Q) -> None:
    r = replay(q.question)
    expected = sorted(p for p in q.packs if not (q.scope == "store" and p in OFF_FOR_SHOPS))
    firsts = [s for s in r.seen if s.agent == "munim_branch" and s.step == 0]
    assert sorted(s.pack or "" for s in firsts) == expected
    for s in firsts:
        print(f"{q.question[:36]:36} branch:{s.pack:22} first request {s.tokens:6} tokens")
        [content] = s.request["contents"]
        assert content["role"] == "user" and [list(p) for p in content["parts"]] == [["text"], ["text"]]
        lead, brief = (p["text"] for p in content["parts"])
        assert lead.startswith("Run frame:") and "\n\n" not in lead, "block 5 only"
        assert brief == q.brief
        text = json.dumps(s.request, ensure_ascii=False)
        assert q.question not in text and THREAD_MARK not in text
        assert s.tokens <= BRANCH["per_call"]
    manager = next(s for s in r.seen if s.agent == "munim" and s.step == 0)
    assert q.question in json.dumps(manager.request, ensure_ascii=False), "positive control: the Manager's context holds it"
    if q.in_thread:
        assert THREAD_MARK in json.dumps(manager.request, ensure_ascii=False)


# -- gate 4: branch tool lists hold 0 propose_* -------------------------------------------------------------------------


def own_tools(pack: str, *, propose: bool) -> list[str]:
    frame_args = {"payroll_scope": "drafts"} if pack == "people" else {}
    return [t.name for t in load_skill(pack).toolset(CTX, FakeCore(frame()).client(), HandleTable(), propose=propose, **frame_args)]


@cache
def declared_by_branch() -> dict[str, set[str]]:
    out: dict[str, set[str]] = {}
    for q in FANNED:
        if q.searching is None:
            for s in replay(q.question).seen:
                if s.agent == "munim_branch":
                    out.setdefault(s.pack or "", set()).add(json.dumps(sorted(t["name"] for t in s.request["tools"])))
    return out


@pytest.mark.parametrize("pack", PACKS)
def test_a_branch_declares_its_skills_read_tools_and_report_only(pack: str) -> None:
    [declared] = [json.loads(d) for d in declared_by_branch()[pack]]
    print(f"branch:{pack}: {len(declared)} tools")
    assert declared == sorted(["report", *own_tools(pack, propose=False)])
    assert not [t for t in declared if t.startswith("propose_") or t in ("request_quotes", "load_skill", "fan_out", "submit_answer")]
    # Paired: the same skill proposes its DRAFTABLES; by hand, customers has none (R-B S1-B / S1-D ruling, 11 Oct).
    proposes = [t for t in own_tools(pack, propose=True) if t.startswith("propose_")]
    assert len(proposes) == len(load_skill(pack).draftables), "paired: the same skill can propose"
    assert bool(proposes) == (pack != "customers")


# -- gate 5: a branch that reads a planted injection taints the orchestrator --------------------------------------------


def reports(r: Run) -> list[dict[str, Any]]:
    manager = [s for s in r.seen if s.agent == "munim"]
    responses = [p["data"] for s in manager for c in s.request["contents"] for p in c["parts"] if p.get("response") == "fan_out"]
    return list(responses[0]["reports"])


def test_a_branch_that_reads_a_planted_injection_taints_the_orchestrator() -> None:
    r = replay(INJECTED.question)
    assert r.prepared is not None
    assert r.prepared.state.tainted is True and r.out.tainted is True, "the orchestrator's RunState is tainted"
    by_pack = {x["pack"]: x["tainted"] for x in reports(r)}
    assert by_pack == {"customers": True, "finance": False}, "taint is per branch, from that branch's own reads"
    searched = [e for e in r.core.traces if e["kind"] == "tool_call" and e["payload"]["tool"] == "search"]
    assert [e["actor"] for e in searched] == ["branch:customers"]
    assert "PLANTEDINJECTION" not in json.dumps(r.core.traces) + "".join(r.core.bodies), "untrusted text stays out of traces"
    assert "PLANTEDINJECTION" in INJECTION


def test_paired_branches_that_only_read_leave_the_orchestrator_untainted() -> None:
    r = replay("Why are customers unhappy lately?")
    assert r.prepared is not None
    assert {x["pack"]: x["tainted"] for x in reports(r)} == {"customers": False, "kitchen": False}
    assert r.prepared.state.tainted is False and r.out.tainted is False


# -- gate 6: run totals within the §3.4 caps, on fixture-reported usage -------------------------------------------------


@pytest.mark.parametrize("q", FANNED, ids=lambda q: q.question[:32])
def test_run_totals_are_within_the_fan_out_caps(q: Q) -> None:
    r = replay(q.question)
    assert r.prepared is not None and r.prepared.fan_out is not None
    o = r.prepared.state.budget
    branches = r.prepared.fan_out.branches
    ran = [b for b in branches if b.state.budget.model_calls]
    print(f"{q.question[:36]:36} manager in {o.input_tokens:6} out {o.output_tokens:4} calls {o.model_calls} tools {o.tool_calls}")
    for b in branches:
        u = b.state.budget
        print(f"{'':36} branch:{b.pack:20} in {u.input_tokens:6} out {u.output_tokens:4} calls {u.model_calls} tools {u.tool_calls}")
        assert u.model_calls <= BRANCH["calls"] and u.tool_calls <= BRANCH["tools"]
        assert u.input_tokens <= BRANCH["input"] and u.output_tokens <= BRANCH["output"]
    assert 0 < o.model_calls <= ORCHESTRATOR["calls"] and o.tool_calls <= ORCHESTRATOR["tools"]
    assert 0 < o.input_tokens <= ORCHESTRATOR["input"] and 0 < o.output_tokens <= ORCHESTRATOR["output"]
    assert ran and all(b.state.budget.input_tokens > 0 for b in ran)
    total_in = o.input_tokens + sum(b.state.budget.input_tokens for b in branches)
    total_out = o.output_tokens + sum(b.state.budget.output_tokens for b in branches)
    assert len(branches) <= MAX_BRANCHES and total_in <= RUN_INPUT and total_out <= RUN_OUTPUT
    # The fixtures' reported prompt tokens are the requests replayed now (no stale fixture can pass): Σ matches.
    assert total_in == sum(s.tokens for s in r.seen)
    for s in r.seen:
        assert s.tokens <= (BRANCH if s.agent == "munim_branch" else ORCHESTRATOR)["per_call"]


def test_a_branch_that_never_reports_is_stopped_at_its_call_cap_and_abstains() -> None:
    r = replay(RUNAWAY.question)
    assert r.prepared is not None and r.prepared.fan_out is not None
    [runaway] = [b for b in r.prepared.fan_out.branches if b.pack == RUNAWAY.runaway]
    assert runaway.state.budget.model_calls == BRANCH["calls"], "stopped exactly at the cap"
    assert {x["pack"]: x["abstain"] for x in reports(r)} == {"finance": "missing_ref", "people": None}
    assert classify(r)["outcome"] == "answered"
    capped = [e for e in r.core.traces if e["actor"] == "branch:finance" and e["payload"].get("reason") == "ai_budget_cap"]
    assert len(capped) == 1


# -- the fan_out tool's own rules ---------------------------------------------------------------------------------------


def bound(intent: str, addressed: str | None, *, branches: bool = True) -> list[str]:
    core = FakeCore(frame())
    req = ThreadsIntelAskRequest.model_validate({"answer_id": vid(80), "question": "q", "addressed_to": addressed, "thread": None})
    deps = Branches(models().reason, kit_cfg()) if branches else None
    p = prepare(CTX, req, core.run_frame, core.client(), bind(PATHS[intent], addressed), deps)
    return [t.name for t in p.toolset.tools]


def test_fan_out_is_bound_only_on_the_unaddressed_investigate_path() -> None:
    assert bound("investigate", None) == ["submit_answer", "fan_out", "load_skill"]
    assert "fan_out" not in bound("investigate", "finance"), "an addressed investigate stays with that specialist"
    for intent in ("lookup", "explain", "out_of_scope", "draft_request"):
        for addressed in (None, "finance"):
            assert "fan_out" not in bound(intent, addressed), (intent, addressed)
    assert bound("investigate", None, branches=False) == ["submit_answer", "load_skill"]


def fan_out_tool() -> FanOutTool:
    core = FakeCore(frame())
    state = RunState(traces=TraceBuffer(core.client().write_traces))
    return FanOutTool(CTX, core.client(), HandleTable(state.handles), state, core.run_frame, Branches(models().reason, kit_cfg()))


def test_fan_out_takes_one_to_four_known_specialists_and_a_short_brief() -> None:
    tool = fan_out_tool()
    assert tool.validate_args({"specialists": ["finance", "kitchen", "people", "customers"], "question": "q"}) is None
    assert tool.validate_args({"specialists": [*PACKS[:5]], "question": "q"}) is not None, "five"
    assert tool.validate_args({"specialists": [], "question": "q"}) is not None, "none"
    assert tool.validate_args({"specialists": ["manager"], "question": "q"}) is not None, "not a specialist"
    long = asyncio.run(tool.run_async(args={"specialists": ["finance"], "question": "word " * 900}, tool_context=None))  # type: ignore[arg-type]
    assert "error" in long and tool.branches == []


def test_a_second_fan_out_in_the_run_is_refused() -> None:
    r = replay("Why was this week bad?")
    assert r.prepared is not None and r.prepared.fan_out is not None
    again = asyncio.run(r.prepared.fan_out.run_async(args={"specialists": ["finance"], "question": "again"}, tool_context=None))  # type: ignore[arg-type]
    assert again == {"error": "fan_out already ran in this run; merge its reports into submit_answer."}


def test_a_branch_that_raises_cancels_its_siblings_before_the_error_leaves(monkeypatch: pytest.MonkeyPatch) -> None:
    """R-E 3: a branch that raises (rather than failing into its report) ends the fan-out, and the siblings still running
    are cancelled before fan_out returns — not left spending model calls behind a failed run. The error that leaves is
    the branch's own. Paired: a fan-out whose branches all finish returns their reports (gate 1)."""
    cancelled: list[str] = []

    async def branch(self: FanOutTool, pack: str, question: str) -> dict[str, Any]:
        if pack == "finance":
            await asyncio.sleep(0)
            raise RuntimeError("a branch broke")
        try:
            await asyncio.sleep(30)
        except asyncio.CancelledError:
            cancelled.append(pack)
            raise
        return {}

    monkeypatch.setattr(FanOutTool, "_branch", branch)
    tool = fan_out_tool()

    async def go() -> list[str]:
        with pytest.raises(RuntimeError, match="a branch broke"):
            await tool.run_async(args={"specialists": ["finance", "kitchen", "people"], "question": "brief"}, tool_context=None)  # type: ignore[arg-type]
        return sorted(cancelled)  # read before asyncio.run's own shutdown cancels anything left

    assert asyncio.run(go()) == ["kitchen", "people"]


def test_kitchen_on_a_shop_only_scope_answers_not_applicable_without_a_model_call() -> None:
    r = replay("Why was this week bad at the store?")
    assert not [s for s in r.seen if s.pack == "kitchen"]
    assert {x["pack"]: x["abstain"] for x in reports(r)}["kitchen"] == "not_applicable"
    assert [e["kind"] for e in r.core.traces if e["actor"] == "branch:kitchen"] == ["abstain"]
