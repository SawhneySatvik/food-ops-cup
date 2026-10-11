"""T-055a gates — negotiation, rule half (BOARD b-55; ledger R45 F4; pack inventory-purchasing §6, §10 I7/S1).

Expected values come from the hand-kept world (s1_world.json `expected`, worked from the pack §6 personalities and the
RG-S1 answer-key shortfall), never from the code under test. Recorded models only (MUNIM_MODEL_MODE=recorded).
"""

from __future__ import annotations

import asyncio
import copy
import json
import shutil
import tomllib
from pathlib import Path
from typing import Any

import httpx
from a2a.client import A2ACardResolver
from test_lockfile import lock_violations

from conftest import REPO
from kit import (
    FIXTURES,
    KEYS,
    PUBLIC,
    SUPPLIER_IDS,
    WORLD,
    CountingLlm,
    Run,
    StubChooser,
    bounds_frame,
    build_app,
    load_data,
    run_s1,
    supplier_key,
)
from kit import no_fixture_misses as no_fixture_misses  # autouse: a missing recorded fixture fails the test
from munim_intel.negotiate.policy import NegotiationPolicy, Options, options, policy_from
from munim_intel.negotiate.review import best, review_quote

EXPECT = WORLD["expected"]
#: Hard rule 5, literal (never the code's own constant): cards carry the words, traces the slug (labels have no spaces).
LABEL = "Simulated supplier"
LABEL_SLUG = "simulated_supplier"
ACTOR = "specialist:inventory_purchasing"


def _traces(r: Run, kind: str) -> list[Any]:
    return [e for e in r.state.traces.events if e.kind == kind]


def _po(r: Run) -> dict[str, Any]:
    assert r.outcome.draft is not None and r.outcome.draft_request is not None, "no PO draft"
    return r.outcome.draft_request


def _refused(r: Run) -> dict[str, str]:
    out: dict[str, str] = {}
    for x in r.outcome.reviewed:
        if x.refused is not None and x.refused.reason_code:
            out[supplier_key(x.supplier_id)] = x.refused.reason_code
    return out


def test_gate1_default_policy_three_rfqs_two_counters_one_po(tmp_path: Path) -> None:
    r = asyncio.run(run_s1(tmp_path, chooser=StubChooser(lambda _r, _l: None)))
    sends = _traces(r, "a2a_send")
    rfqs = [e for e in sends if e.payload["move"].root == "rfq"]
    counters = [e for e in sends if e.payload["move"].root == "counter"]
    per_supplier = {k: sum(e.payload["supplier"].root == SUPPLIER_IDS[k] for e in counters) for k in KEYS}
    counter_rounds = sorted({e.payload["round"].root for e in counters})
    po = _po(r)
    line = po["payload"]["lines"][0]
    receives = len(_traces(r, "a2a_receive"))
    print(f"rfqs {len(rfqs)}, counters per supplier {per_supplier}, counter rounds {counter_rounds}, receives {receives}")
    print(
        f"PO supplier {supplier_key(po['payload']['supplier_id'])}, price {r.core.cell(line['unit_price_minor'])}, "
        f"qty {r.core.cell(line['qty_milli'])}, refused {_refused(r)}, draft {r.outcome.draft.status if r.outcome.draft else None}"
    )
    assert len(rfqs) == EXPECT["rfqs"]
    assert counters and max(per_supplier.values()) <= 2 and len(counter_rounds) <= 2
    assert len(_traces(r, "a2a_receive")) == len(sends)
    assert len(r.core.drafts) == 1 and r.outcome.draft is not None and r.outcome.draft.status == "proposed"
    assert supplier_key(po["payload"]["supplier_id"]) == EXPECT["po_supplier"]
    assert r.core.cell(line["unit_price_minor"]) == EXPECT["po_unit_price_minor"]
    assert r.core.cell(line["qty_milli"]) == EXPECT["po_qty_milli"]
    compare = next(s for s in r.core.snapshots.values() if s["template_id"] == "purchasing.quote_compare")
    prefix = f"⟨snap:{compare['snapshot_id']}·"
    assert line["unit_price_minor"].startswith(prefix) and line["qty_milli"].startswith(prefix)
    assert _refused(r) == EXPECT["refused"]


def test_gate2_hidden_minimum_order_refused_ten_of_ten(tmp_path: Path) -> None:
    refused = 0
    for clause in range(10):
        r = asyncio.run(run_s1(tmp_path / str(clause), clause=clause))
        refused += _refused(r).get("discounter") == "moq_exceeds_need"
        # Every phrasing is still read and grounded: no supplier is dropped for a field missing from its reply.
        assert [leg.dropped for leg in r.outcome.legs] == [None, None, None]
        assert supplier_key(_po(r)["payload"]["supplier_id"]) == EXPECT["po_supplier"]
    print(f"hidden minimum-order clause refused {refused}/10")
    assert refused == 10


def test_gate2_paired_accept_no_clause_the_discounter_passes(tmp_path: Path) -> None:
    data = copy.deepcopy(load_data())
    for p in data["personalities"]:
        if p["key"] == "discounter":
            p["min_order_factor_bp"] = 0
    r = asyncio.run(run_s1(tmp_path, data=data))
    disc = next(x for x in r.outcome.reviewed if supplier_key(x.supplier_id) == "discounter")
    print(f"no clause: discounter passed {disc.passed}, PO supplier {supplier_key(_po(r)['payload']['supplier_id'])}")
    # Hand: 720 is the lowest accepted price; with no minimum it passes every rule and wins.
    assert disc.passed and supplier_key(_po(r)["payload"]["supplier_id"]) == "discounter"


def test_gate3_every_supplier_label_reads_simulated_supplier(tmp_path: Path) -> None:
    async def cards() -> list[Any]:
        async with httpx.AsyncClient(transport=httpx.ASGITransport(app=build_app(PUBLIC)), base_url=PUBLIC) as http:
            urls = [f"{PUBLIC}/{k}/.well-known/agent-card.json" for k in KEYS]
            return [await A2ACardResolver(http, u, agent_card_path="").get_agent_card() for u in urls]

    got = asyncio.run(cards())
    labelled_cards = sum(LABEL in c.name and LABEL in c.description for c in got)
    r = asyncio.run(run_s1(tmp_path))
    a2a = _traces(r, "a2a_send") + _traces(r, "a2a_receive")
    labelled_traces = sum(e.payload["label"].root == LABEL_SLUG for e in a2a)
    print(f"cards {labelled_cards}/{len(got)} labelled; a2a traces {labelled_traces}/{len(a2a)} labelled {LABEL_SLUG}")
    assert len(got) == 3 and labelled_cards == 3  # 3 = the pack §6 personalities
    assert a2a and labelled_traces == len(a2a)


def test_gate4_planted_accept_above_walk_away_becomes_walk(tmp_path: Path) -> None:
    # Walk-away 10500 bp = 840. Premium: 896 → (counter) 880 → (counter) 864 > 840 with both counters spent: only walk.
    r = asyncio.run(run_s1(tmp_path, chooser=StubChooser(lambda _r, _l: "accept"), policy=NegotiationPolicy(9_500, 10_500)))
    above = [d for d in r.outcome.decisions if d.chosen == "accept" and "accept" not in d.allowed and d.default == "walk"]
    kept = [d for d in r.outcome.decisions if d.chosen == "accept" and d.in_set]
    print(f"accept above walk-away -> {[d.move for d in above]}; in-set accepts kept {len(kept)}")
    assert len(above) == 1 and above[0].move == "walk" and not above[0].in_set
    assert supplier_key(above[0].supplier_id) == "premium" and above[0].round == 3
    assert kept and all(d.move == "accept" for d in kept)


def test_d7_the_owners_bounds_from_the_run_frame_change_the_allowed_moves() -> None:
    """Ledger R47 D7: target and walk-away are the owner's, read from core's run-frame, never intel constants. By hand, on a
    reference of 10,000 and a supplier at 10,800 with no rival below and no counter yet:
      core's default 9500 / 11000: 10,800 ≤ 11,000 → accept allowed; counter at the target 9,500 → default counter;
      the owner's 9000 / 10500:    10,800 > 10,500 → accept refused; counter at the target 9,000 → default counter."""
    default = policy_from(bounds_frame(9_500, 11_000))
    owner = policy_from(bounds_frame(9_000, 10_500))
    assert (owner.target_bp, owner.walk_away_bp) == (9_000, 10_500)
    assert options(default, 10_000, 10_800, [], 0) == Options(("accept", "counter", "walk"), "counter", 9_500, 11_000)
    assert options(owner, 10_000, 10_800, [], 0) == Options(("counter", "walk"), "counter", 9_000, 10_500)
    # Paired: at 10,500 the owner's walk-away still admits accept (≤), one minor unit above it does not.
    assert "accept" in options(owner, 10_000, 10_500, [], 0).allowed and "accept" not in options(owner, 10_000, 10_501, [], 0).allowed


def test_gate4_planted_counter_after_max_rounds_becomes_default(tmp_path: Path) -> None:
    r = asyncio.run(run_s1(tmp_path, chooser=StubChooser(lambda _r, _l: "counter")))
    late = [d for d in r.outcome.decisions if d.chosen == "counter" and "counter" not in d.allowed and d.round == 3]
    early = [d for d in r.outcome.decisions if d.chosen == "counter" and d.in_set]
    print(f"counter after max rounds -> {[(supplier_key(d.supplier_id), d.move) for d in late]}; in-set counters {len(early)}")
    # Hand: steady and premium are countered in decision rounds 1 and 2; at round 3 only accept / walk remain.
    assert len(late) == 2 and all(d.move == d.default == "accept" and not d.in_set for d in late)
    assert len(early) == 4 and all(d.move == "counter" for d in early)


LOCK = REPO / "uv.lock"


def test_gate5_lock_clean_with_a2a_red_with_planted_litellm() -> None:
    text = LOCK.read_text("utf8")
    lock = tomllib.loads(text)
    names = {p["name"]: p.get("version") for p in lock["package"]}
    members = set(lock["manifest"]["members"])
    print(f"a2a-sdk {names.get('a2a-sdk')}, members {sorted(members)}, violations {lock_violations(text)}")
    assert names.get("a2a-sdk") == "1.2.2" and {"munim-intel", "munim-suppliers-sim"} <= members
    assert lock_violations(text) == []
    planted = text + '\n[[package]]\nname = "litellm"\nversion = "1.84.0"\nsource = { registry = "https://pypi.org/simple" }\n'
    assert lock_violations(planted)


def test_gate6_every_a2a_trace_carries_the_specialist(tmp_path: Path) -> None:
    r = asyncio.run(run_s1(tmp_path))
    a2a = _traces(r, "a2a_send") + _traces(r, "a2a_receive")
    every = r.state.traces.events
    mine = sum(e.actor == ACTOR for e in every)
    print(f"a2a traces {len(a2a)}, actor {ACTOR}: {sum(e.actor == ACTOR for e in a2a)}; all run traces {mine}/{len(every)}")
    assert len(a2a) >= 2 * EXPECT["rfqs"] and all(e.actor == ACTOR for e in a2a)
    assert all(e.actor == ACTOR for e in every)


def test_gate2_an_omitted_minimum_order_drops_the_quote_ten_of_ten(tmp_path: Path) -> None:
    """Gate 2 above passes because the recorded extractor reads each minimum order; this measures the grounding instead:
    every discounter reading with the minimum order left out (0, "none stated") is dropped — the clause's number is
    claimed by no field — under each of the 10 phrasings."""
    out = tmp_path / "omitted"
    shutil.copytree(FIXTURES, out)
    for f in out.glob("*.json"):
        fx = json.loads(f.read_text("utf8"))
        if fx["request"]["model"] == "recorded/extract" and "Bargain Bulk" in json.dumps(fx["request"], ensure_ascii=False):
            part = fx["responses"][0]["content"]["parts"][0]
            part["text"] = json.dumps({**json.loads(part["text"]), "min_order_qty_milli": 0})
            f.write_text(json.dumps(fx, ensure_ascii=False))
    dropped = 0
    for clause in range(10):
        r = asyncio.run(run_s1(tmp_path / str(clause), clause=clause, fixtures=out, chooser=StubChooser(lambda _r, _l: None)))
        legs = {supplier_key(leg.supplier.id): leg.dropped for leg in r.outcome.legs}
        dropped += legs == {"steady": None, "discounter": "unbound_number", "premium": None}
        assert supplier_key(_po(r)["payload"]["supplier_id"]) == EXPECT["po_supplier"]
    print(f"omitted minimum order dropped {dropped}/10")
    assert dropped == 10


def test_a_need_of_zero_cannot_be_verified_not_an_overlap(tmp_path: Path) -> None:
    """R-C F7: deal_inputs need 0 (packaging no recipe uses, or no forecast) is `cannot_verify missing_ref` for the overlap
    rule — "open commitments of 0 cover a need of 0" is not evidence. No quote passes, so no PO. Paired: need 20 pc → PO."""
    r = asyncio.run(run_s1(tmp_path / "zero", deal_inputs={**WORLD["deal_inputs"], "need_qty_milli": 0}))
    overlap = {supplier_key(x.supplier_id): next(c for c in x.checks if c.rule == "overlap") for x in r.outcome.reviewed}
    print(f"need 0: overlap {[(k, c.verdict, c.reason_code) for k, c in overlap.items()]}; PO {r.outcome.draft_request is not None}")
    assert overlap and all((c.verdict, c.reason_code) == ("cannot_verify", "missing_ref") for c in overlap.values())
    assert r.outcome.draft_request is None and r.core.drafts == []
    ok = asyncio.run(run_s1(tmp_path / "need"))
    assert all(next(c for c in x.checks if c.rule == "overlap").verdict == "pass" for x in ok.outcome.reviewed)
    assert ok.outcome.draft_request is not None


def _compare(moq: int, qty: int) -> tuple[dict[str, Any], dict[str, Any]]:
    sid, did = "0199a000-0000-7000-8000-00000000f001", "0199a000-0000-7000-8000-00000000f002"
    compare = {
        "snapshot_id": sid,
        "rows": [{"quote_id": "q", "supplier_id": "s", "unit_price_minor": 792, "qty_milli": qty, "min_order_qty_milli": moq}],
    }
    d = WORLD["deal_inputs"]
    row = {"quote_total_minor": 15_840, "quote_payment_days": 15, "budget_left_minor": d["budget_left_minor"], "open_commit_qty_milli": 0,
           "need_qty_milli": 20_000, "use_in_shelf_life_qty_milli": 30_000, "margin_at_quote_bp": 6_400, "margin_rule_applies": True,
           "margin_floor_bp": 6_000, "min_payment_days": 7}  # fmt: skip
    inputs = {"snapshot_id": did, "rows": [row]}
    return compare, inputs


def test_a_po_below_the_suppliers_minimum_order_fails_review() -> None:
    """Minimum 25 pc fits the 30 pc usable before expiry, but the PO would order 20 pc: below the supplier's minimum."""
    compare, inputs = _compare(25_000, 20_000)
    below = review_quote(compare, 0, inputs)
    compare, inputs = _compare(20_000, 20_000)
    met = review_quote(compare, 0, inputs)
    rule = {r.rule: r for r in below.checks}["minimum"]
    assert (rule.verdict, rule.reason_code) == ("fail", "moq_exceeds_need") and not below.passed
    assert met.passed


def _shop(
    margin_bp: int | None, applies: bool, *, total: int = 126_000, floor: int | None = 1_500
) -> tuple[dict[str, Any], dict[str, Any]]:
    """Ledger R47 D3 on the store world's hand values (tools/worldgen/src/worlds/store.ts): Detergent 1 kg is a shelf SKU
    no recipe uses, selling at 11,000 paise on both channels and last bought at 9,000; ST-S1 (answer key store.json): 10
    on hand against a minimum of 24 → 14 short, 14 × 9,000 = 126,000. deal_inputs v3 margins it on its own selling price:
    (11,000 − 9,000) / 11,000 = 1,818 bp. The floor (1,500) and payment terms are this test's own policy: the store world
    sets no business policy. Need = the 14 short; nothing on order."""
    sid, did = "0199a000-0000-7000-8000-00000000f011", "0199a000-0000-7000-8000-00000000f012"
    compare = {
        "snapshot_id": sid,
        "rows": [{"quote_id": "q", "supplier_id": "s", "unit_price_minor": 9_000, "qty_milli": 14_000, "min_order_qty_milli": 14_000}],
    }
    row = {"quote_total_minor": total, "quote_payment_days": 15, "budget_left_minor": 500_000, "open_commit_qty_milli": 0,
           "need_qty_milli": 14_000, "use_in_shelf_life_qty_milli": 30_000, "margin_at_quote_bp": margin_bp,
           "margin_rule_applies": applies, "margin_floor_bp": floor, "min_payment_days": 7}  # fmt: skip
    return compare, {"snapshot_id": did, "rows": [row]}


def _verdicts(compare: dict[str, Any], inputs: dict[str, Any]) -> dict[str, tuple[str, str | None]]:
    return {c.rule: (c.verdict, c.reason_code) for c in review_quote(compare, 0, inputs).checks}


def test_d3_a_shop_item_no_recipe_uses_passes_on_its_selling_price_margin() -> None:
    """A shop PO can now pass: 1,818 bp from the selling price ≥ the 1,500 floor, every other rule passing → the best
    quote. Paired refusals: v2's NULL margin for a no-recipe item (still `cost_price_missing` where the rule applies), and
    the same margin under a 2,000 floor (`margin_below_floor`)."""
    compare, inputs = _shop(1_818, True)
    r = review_quote(compare, 0, inputs)
    assert r.passed and best([r], compare) == r
    assert _verdicts(*_shop(None, True))["margin"] == ("cannot_verify", "cost_price_missing")
    compare, inputs = _shop(1_818, True, floor=2_000)
    assert _verdicts(compare, inputs)["margin"] == ("fail", "margin_below_floor") and not review_quote(compare, 0, inputs).passed


def test_d3_an_item_with_no_selling_price_skips_the_margin_rule_and_is_judged_on_the_rest() -> None:
    """Packaging (no selling price): `margin_rule_applies` false → the margin rule is a pass coded `not_applicable`,
    citing that cell, and the quote stands on need, budget and minimum order. Paired: the same item over budget
    (600,000 > 500,000 left) still fails `budget_exceeded` — the skip waves nothing else through."""
    compare, inputs = _shop(None, False)
    r = review_quote(compare, 0, inputs)
    margin = next(c for c in r.checks if c.rule == "margin")
    assert r.passed and (margin.verdict, margin.reason_code) == ("pass", "not_applicable")
    assert margin.refs == (f"⟨snap:{inputs['snapshot_id']}·0·margin_rule_applies⟩",)
    compare, inputs = _shop(None, False, total=600_000)
    over = review_quote(compare, 0, inputs)
    assert over.refused is not None and (over.refused.rule, over.refused.reason_code) == ("budget", "budget_exceeded")


def test_a_function_call_from_the_extractor_drops_that_reply_and_runs_nothing(tmp_path: Path) -> None:
    """R-C F8: the reply goes through the quarantine, which refuses a response that tries a function call outright —
    nothing in it is read, nothing is called, and no second model call is made for it."""
    out = tmp_path / "called"
    shutil.copytree(FIXTURES, out)
    hits = 0
    for f in out.glob("*.json"):
        fx = json.loads(f.read_text("utf8"))
        asked = json.dumps(fx["request"], ensure_ascii=False)
        if fx["request"]["model"] == "recorded/extract" and "Premium Provisions" in asked and "we can supply" in asked:
            fx["responses"][0]["content"]["parts"] = [{"function_call": {"name": "propose_purchasing_po_create_v1", "args": {}}}]
            f.write_text(json.dumps(fx, ensure_ascii=False))
            hits += 1
    assert hits == 1
    CountingLlm.log.clear()
    r = asyncio.run(run_s1(tmp_path / "run", chooser=StubChooser(lambda _r, _l: None), fixtures=out))
    premium = next(leg for leg in r.outcome.legs if supplier_key(leg.supplier.id) == "premium")
    extracts = [m for m, _ in CountingLlm.log if m == "recorded/extract"]
    print(
        f"function call planted: premium dropped {premium.dropped}; extract calls {len(extracts)}; "
        f"PO {supplier_key(_po(r)['payload']['supplier_id'])}"
    )
    # Hand: 3 RFQ readings; premium out, steady counters twice (2 more) = 5 — one per reply, none repeated.
    assert premium.dropped == "tool_call_attempted" and len(extracts) == 5
    assert supplier_key(_po(r)["payload"]["supplier_id"]) == EXPECT["po_supplier"]
