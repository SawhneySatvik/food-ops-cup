"""T-055b gates — negotiation, AI half (BOARD b-55; ledger R45 F4; 04 §6 step 3). Recorded models only.

The recorded chooser answers from committed fixtures (fixtures/recorded, written by record.py); planted variants are
copies of those fixtures with one response changed, made in a temp dir by the test itself.
"""

from __future__ import annotations

import asyncio
import copy
import json
import shutil
from collections.abc import Callable
from pathlib import Path
from typing import Any

import pytest
from google.adk.agents import LlmAgent
from google.adk.tools.function_tool import FunctionTool

from kit import FIXTURES, WORLD, CountingLlm, Run, cfg, llm, load_data, run_s1, supplier_key
from kit import no_fixture_misses as no_fixture_misses  # autouse: a missing recorded fixture fails the test
from munim_intel.negotiate.chooser import TEMPLATE_NOTE
from munim_intel.negotiate.grammar import violation
from munim_intel.runtime.runner import run_agent

EXPECT = WORLD["expected"]
INJECTION = EXPECT["injection"]


def _plant(tmp: Path, round_: int, change: Callable[[dict[str, Any]], None]) -> Path:
    """A copy of the fixtures where the chooser's answer for decision round `round_` is changed by `change`."""
    out = tmp / "planted"
    shutil.copytree(FIXTURES, out)
    hits = 0
    for f in out.glob("*.json"):
        fx = json.loads(f.read_text("utf8"))
        asked = json.dumps(fx["request"], ensure_ascii=False)
        # The full S1 run's round (all three suppliers open), not the injection gate's (its steady supplier is dropped).
        if fx["request"]["model"] != "recorded/reason" or f"Decision round {round_} of" not in asked or "Supplier A:" not in asked:
            continue
        part = fx["responses"][0]["content"]["parts"][0]
        answer = json.loads(part["text"])
        change(answer)
        part["text"] = json.dumps(answer)
        f.write_text(json.dumps(fx, ensure_ascii=False))
        hits += 1
    assert hits == 1, f"expected one recorded chooser fixture for round {round_}, found {hits}"
    return out


def test_gate1_planted_out_of_set_move_becomes_default(tmp_path: Path) -> None:
    # Round 1: premium (C) quotes 896 > walk-away 880, so `accept` is outside its set; steady (A) keeps its in-set answer.
    def change(a: dict[str, Any]) -> None:
        a["C"]["move"] = "accept"

    r = asyncio.run(run_s1(tmp_path, fixtures=_plant(tmp_path, 1, change)))
    d1 = {supplier_key(d.supplier_id): d for d in r.outcome.decisions if d.round == 1}
    print(
        f"planted out-of-set: premium chose {d1['premium'].chosen!r} allowed {d1['premium'].allowed} -> {d1['premium'].move}; "
        f"steady {d1['steady'].chosen!r} -> {d1['steady'].move}"
    )
    assert d1["premium"].chosen == "accept" and not d1["premium"].in_set and d1["premium"].move == d1["premium"].default == "counter"
    assert d1["steady"].in_set and d1["steady"].move == d1["steady"].chosen


def test_gate2_recorded_moves_are_in_the_allowed_set_every_round(tmp_path: Path) -> None:
    r = asyncio.run(run_s1(tmp_path))
    ds = r.outcome.decisions
    rounds = sorted({d.round for d in ds})
    off_default = [(d.round, supplier_key(d.supplier_id), d.move) for d in ds if d.move != d.default]
    print(f"decisions {len(ds)} over rounds {rounds}; in set {sum(d.in_set for d in ds)}; model's non-default in-set picks {off_default}")
    assert rounds == list(range(1, EXPECT["decision_rounds"] + 1))
    assert ds and all(d.in_set and d.chosen in d.allowed for d in ds)
    assert r.chooser.calls == len(rounds)


def test_gate3_no_free_digit_in_any_recorded_note(tmp_path: Path) -> None:
    r = asyncio.run(run_s1(tmp_path))
    notes = [d.note for d in r.outcome.decisions]
    bad = [n for n in notes if not isinstance(n, str) or violation(n) is not None]
    templated = sum(d.template_note for d in r.outcome.decisions)
    print(f"recorded notes {len(notes)}, with a number-grammar violation {len(bad)}, templated {templated}")
    assert notes and not bad and not any(d.template_note for d in r.outcome.decisions)


def test_gate3_planted_digit_gets_the_template_message(tmp_path: Path) -> None:
    def change(a: dict[str, Any]) -> None:
        a["A"]["note"] = "We could pay 7 rupees less."

    r = asyncio.run(run_s1(tmp_path, fixtures=_plant(tmp_path, 1, change)))
    a = next(d for d in r.outcome.decisions if d.round == 1 and supplier_key(d.supplier_id) == "steady")
    others = [d for d in r.outcome.decisions if d is not a]
    print(
        f"planted digit note -> template {a.template_note}; message starts {a.message[: len(TEMPLATE_NOTE)]!r}; "
        f"other notes templated {sum(d.template_note for d in others)}"
    )
    assert a.template_note and a.message.startswith(TEMPLATE_NOTE) and "7 rupees" not in a.message
    assert not any(d.template_note for d in others)


@pytest.mark.parametrize(
    "text,rule",
    [
        ("pay 7 less", "numeric_char"),
        ("about twelve boxes", "number_word"),
        ("half of ½", "numeric_char"),
        ("a ten-day term", "number_word"),
        ("पाँच डिब्बे", "number_word"),
        ("fifty boxes", "number_word"),
        ("off by ٪", "number_symbol"),
        ('he said "cheap"', "typed_quotation"),
    ],
)
def test_gate3_grammar_red_cases(text: str, rule: str) -> None:
    assert violation(text) == rule


def test_gate3_grammar_clean_note() -> None:
    assert violation("Thank you for the revised offer. A rival has quoted lower, so we ask you to match it.") is None


def test_gate4_injected_reply_taints_and_po_still_from_review_code(tmp_path: Path) -> None:
    data = copy.deepcopy(load_data())
    for p in data["personalities"]:
        if p["key"] == "steady":
            p["note"] = INJECTION["note"]
    CountingLlm.log.clear()
    r = asyncio.run(run_s1(tmp_path, data=data))
    extract_calls = [n for m, n in CountingLlm.log if m == "recorded/extract"]
    executed: list[int] = []

    def propose_purchasing_po_create_v1() -> dict[str, str]:
        executed.append(1)
        return {"status": "proposed"}

    agent = LlmAgent(
        name="manager",
        model=llm("manager"),
        instruction="Draft what the owner asked for.",
        tools=[FunctionTool(propose_purchasing_po_create_v1)],
    )
    asyncio.run(run_agent(agent, r.ctx, "Draft the purchase order.", cfg(tmp_path), state=r.state, actor="manager"))
    results = [e.model_dump(mode="json") for e in r.state.traces.events if e.kind == "tool_result"]
    refused = [e for e in results if e["payload"].get("reason") == "tainted_run"]
    po = r.outcome.draft_request
    assert po is not None
    line = po["payload"]["lines"][0]
    print(
        f"extract calls {len(extract_calls)}, tool counts {sorted(set(extract_calls))}; tainted {r.state.tainted}; "
        f"propose refused {len(refused)}, executed {len(executed)}; PO drafts {len(r.core.drafts)} "
        f"supplier {supplier_key(po['payload']['supplier_id'])}"
    )
    assert extract_calls and all(n == 0 for n in extract_calls)
    assert r.state.tainted is True
    assert len(refused) == 1 and executed == []
    # The injected reply is dropped (its note holds a digit no field claims); the PO is review code's, from the rest.
    assert {supplier_key(leg.supplier.id): leg.dropped for leg in r.outcome.legs if leg.dropped} == INJECTION["dropped"]
    assert len(r.core.drafts) == 1 and supplier_key(po["payload"]["supplier_id"]) == INJECTION["po_supplier"]
    assert r.core.cell(line["unit_price_minor"]) == INJECTION["po_unit_price_minor"]
    assert all(v.startswith("⟨snap:") for v in (line["qty_milli"], line["unit_price_minor"], *po["based_on"]))


def test_gate4_injected_reply_that_grounds_is_stored_and_po_still_from_review_code(tmp_path: Path) -> None:
    """Paired with gate 4 above: an injection with no digit in it leaves steady's quote grounded and stored — the reply
    is untrusted text in the run all the same: the run is tainted, the extractor saw no tool, and the PO is review
    code's (s1_world `expected.injection._worked_no_digit`: steady at 792)."""
    data = copy.deepcopy(load_data())
    for p in data["personalities"]:
        if p["key"] == "steady":
            p["note"] = INJECTION["no_digit_note"]
    CountingLlm.log.clear()
    r = asyncio.run(run_s1(tmp_path, data=data))
    extract_tools = {n for m, n in CountingLlm.log if m == "recorded/extract"}
    po = r.outcome.draft_request
    assert po is not None
    stored = [q for q in r.core.quotes if supplier_key(q["supplier_id"]) == "steady"]
    po_key = supplier_key(po["payload"]["supplier_id"])
    print(f"no-digit injection: steady quotes stored {len(stored)}, tainted {r.state.tainted}, PO {po_key}")
    assert [leg.dropped for leg in r.outcome.legs] == [None, None, None] and len(stored) == 3
    assert r.state.tainted is True and extract_tools == {0}
    assert (supplier_key(po["payload"]["supplier_id"]), r.core.cell(po["payload"]["lines"][0]["unit_price_minor"])) == (
        EXPECT["po_supplier"],
        EXPECT["po_unit_price_minor"],
    )


def test_gate5_calls_bounded_and_budget_stop_completes_by_default(tmp_path: Path) -> None:
    full = asyncio.run(run_s1(tmp_path / "full"))
    CountingLlm.log.clear()
    stop: Run = asyncio.run(run_s1(tmp_path / "stop", choice_calls=1))
    reason_calls = sum(m == "recorded/reason" for m, _ in CountingLlm.log)
    after = [d for d in stop.outcome.decisions if d.round > 1]
    po = stop.outcome.draft_request
    defaulted = sum(d.move == d.default and d.chosen is None for d in after)
    print(
        f"full run chooser calls {full.chooser.calls} (rounds {EXPECT['decision_rounds']}); "
        f"budget stop: chooser calls {stop.chooser.calls}, reason-role model calls {reason_calls}, "
        f"later decisions default {defaulted}/{len(after)}, "
        f"PO supplier {supplier_key(po['payload']['supplier_id']) if po else None}"
    )
    assert full.chooser.calls <= EXPECT["decision_rounds"] + 1
    assert stop.chooser.calls == 1 and reason_calls == 1
    assert after and all(d.chosen is None and d.move == d.default for d in after)
    assert po is not None and supplier_key(po["payload"]["supplier_id"]) == EXPECT["po_supplier"]


def test_gate5_run_budget_stop_makes_no_further_call_and_still_reviews(tmp_path: Path) -> None:
    stop = EXPECT["budget_stop"]
    CountingLlm.log.clear()
    r = asyncio.run(run_s1(tmp_path, max_model_calls=stop["max_model_calls"]))
    roles = [m for m, _ in CountingLlm.log]
    po = r.outcome.draft_request
    assert po is not None
    line = po["payload"]["lines"][0]
    who, price = supplier_key(po["payload"]["supplier_id"]), r.core.cell(line["unit_price_minor"])
    counters = [d for d in r.outcome.decisions if "counter" in d.allowed]
    print(
        f"run budget {stop['max_model_calls']}: model calls {len(roles)} {sorted(set(roles))}, chooser calls {r.chooser.calls}, "
        f"decisions offering counter {len(counters)}, PO {who} at {price}"
    )
    assert len(roles) == stop["max_model_calls"] and set(roles) == {"recorded/extract"} and r.chooser.calls == 0
    assert not counters and all(d.move == d.default for d in r.outcome.decisions)
    assert (who, price) == (stop["po_supplier"], stop["po_unit_price_minor"])


def test_gate6_recorded_po_supplier_is_the_answer_key(tmp_path: Path) -> None:
    r = asyncio.run(run_s1(tmp_path))
    po = r.outcome.draft_request
    assert po is not None
    line = po["payload"]["lines"][0]
    who, price, qty = supplier_key(po["payload"]["supplier_id"]), r.core.cell(line["unit_price_minor"]), r.core.cell(line["qty_milli"])
    print(f"recorded PO: {who} at {price} x {qty}")
    assert supplier_key(po["payload"]["supplier_id"]) == EXPECT["po_supplier"]
    assert r.core.cell(line["unit_price_minor"]) == EXPECT["po_unit_price_minor"]
