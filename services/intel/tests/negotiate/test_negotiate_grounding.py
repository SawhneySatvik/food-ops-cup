"""Clause 2 on the supplier path (R-C F1, F2; DECISIONS 11 Oct, "W3.2 review ruling — quote provenance"): each quote
field the extractor returns is bound to its own place in the simulated supplier's reply — the price after the currency
code and before "per <unit>", quantities before the unit, the payment term before "days" — each on its own token; every
other number in the reply must be claimed (echoes of the RFQ item name and quantity excepted); the quantity is the RFQ's.
Otherwise the quote is dropped, never stored, and the run goes on without it.

Expected values are hand-worked in s1_world.json (`expected.invented_price`, `expected.f1_plants`, `expected.injection`),
never read from the code."""

from __future__ import annotations

import asyncio
import copy
import json
import shutil
from collections.abc import Callable
from decimal import Decimal
from pathlib import Path
from typing import Any

import pytest

from kit import FIXTURES, WORLD, StubChooser, load_data, run_s1, supplier_key
from kit import no_fixture_misses as no_fixture_misses  # autouse: a missing recorded fixture fails the test
from munim_intel.negotiate.extract import QuoteFields, Rfq, ground, tokens

PLANT = WORLD["expected"]["invented_price"]
F1 = WORLD["expected"]["f1_plants"]
INJECTION = WORLD["expected"]["injection"]
REPLY = (
    "Steady Wholesale (Simulated supplier): we can supply 1,200 pc of Takeaway boxes at INR 8.16 per pc. "
    "Payment: net 15 days. Terms: minimum order 60 pc."
)
RFQ = Rfq("Takeaway boxes", "pc", 1_200_000, "INR", 2)
CLEAN = {"unit_price_minor": 816, "qty_milli": 1_200_000, "min_order_qty_milli": 60_000, "payment_days": 15}


def _plant(tmp: Path, who: str, change: Callable[[dict[str, Any]], None]) -> Path:
    """A copy of the fixtures where `who`'s round-1 (RFQ) extraction answer is changed by `change`."""
    out = tmp / "planted"
    shutil.copytree(FIXTURES, out)
    hits = 0
    for f in out.glob("*.json"):
        fx = json.loads(f.read_text("utf8"))
        asked = json.dumps(fx["request"], ensure_ascii=False)
        if fx["request"]["model"] == "recorded/extract" and who in asked and "we can supply" in asked and "SYSTEM" not in asked:
            part = fx["responses"][0]["content"]["parts"][0]
            fields = json.loads(part["text"])
            change(fields)
            part["text"] = json.dumps(fields)
            f.write_text(json.dumps(fx, ensure_ascii=False))
            hits += 1
    assert hits >= 1
    return out


def _po(tmp: Path, fixtures: Path) -> tuple[dict[str, str | None], tuple[str, int, int] | None]:
    r = asyncio.run(run_s1(tmp, chooser=StubChooser(lambda _r, _l: None), fixtures=fixtures))
    dropped: dict[str, str | None] = {supplier_key(leg.supplier.id): leg.dropped for leg in r.outcome.legs if leg.dropped}
    po = r.outcome.draft_request
    if po is None:
        return dropped, None
    line = po["payload"]["lines"][0]
    return dropped, (supplier_key(po["payload"]["supplier_id"]), r.core.cell(line["unit_price_minor"]), r.core.cell(line["qty_milli"]))


def test_a_planted_invented_price_drops_the_quote_and_the_po_goes_elsewhere(tmp_path: Path) -> None:
    def invent(f: dict[str, Any]) -> None:
        f["unit_price_minor"] = PLANT["planted_minor"]

    dropped, po = _po(tmp_path, _plant(tmp_path, "Steady Wholesale", invent))
    print(f"invented price: dropped {dropped}, PO {po}")
    assert dropped == PLANT["dropped"]
    assert po is not None and po[:2] == (PLANT["po_supplier"], PLANT["po_unit_price_minor"])


@pytest.mark.parametrize("mode", ["swap", "omit", "days"])
def test_reviewer_plants_on_the_discounter_no_longer_win_the_po(tmp_path: Path, mode: str) -> None:
    """R-C F1's three plants on the discounter's RFQ reading ("we can supply 20 pc … at INR 7.20 per pc. Payment: net 7
    days. … 60 pc"): swap qty and minimum order, omit the minimum order, read the price off "net 7 days". Before the
    fix each gave the discounter the PO (720 x 60, 720 x 20, 700 x 20)."""

    def change(f: dict[str, Any]) -> None:
        if mode == "swap":
            f["qty_milli"], f["min_order_qty_milli"] = f["min_order_qty_milli"], 0
        elif mode == "omit":
            f["min_order_qty_milli"] = 0
        else:
            f["unit_price_minor"], f["min_order_qty_milli"] = 700, 0

    dropped, po = _po(tmp_path, _plant(tmp_path, "Bargain Bulk", change))
    want = F1[mode]
    print(f"{mode}: dropped {dropped}, PO {po}")
    assert dropped == {"discounter": want["dropped"]}
    assert po == (want["po_supplier"], want["po_unit_price_minor"], want["po_qty_milli"])


def test_every_recorded_reply_is_grounded_or_dropped_as_the_world_says() -> None:
    """Every recorded extraction: the clean replies ground; the injected one (its note names `create_v1`, a digit no field
    claims) is unbound."""
    files = [json.loads(f.read_text("utf8")) for f in sorted(FIXTURES.glob("*.json"))]
    extracts = [fx for fx in files if fx["request"]["model"] == "recorded/extract"]
    w = WORLD["rfq"]
    rfq = Rfq(w["item_name"], w["unit"], w["qty_milli"], w["currency"], w["minor_unit"])
    got: dict[str, int] = {}
    for fx in extracts:
        text = "\n".join(p.get("text", "") for c in fx["request"]["contents"] for p in c["parts"])
        reply = text.split("<untrusted>\n")[1].split("\n</untrusted>")[0]
        fields = QuoteFields.model_validate(json.loads(fx["responses"][0]["content"]["parts"][0]["text"]))
        reason = ground(fields, reply, rfq).reason
        key = "grounded" if reason is None else f"{'injected' if 'SYSTEM' in reply else 'clean'}:{reason}"
        got[key] = got.get(key, 0) + 1
    print(f"recorded extractions: {got}")
    # Hand count of the readings the gates replay: the RFQ replies of steady (1), premium (1) and the discounter under
    # each of the 10 minimum-order phrasings plus once with none (11), two counter replies each from steady and premium
    # (4), and steady's three replies carrying the digit-free injection (3) = 20 grounded; the steady RFQ reply carrying
    # the injection with a digit = 1 unbound.
    assert got == {"grounded": 20, "injected:unbound_number": 1}


def test_ground_binds_each_field_to_its_own_token() -> None:
    x = ground(QuoteFields(**CLEAN), REPLY, RFQ)
    assert x.fields is not None and x.reason is None
    assert {k: REPLY[a:b] for k, (a, b) in x.spans.items()} == {
        "unit_price_minor": "8.16",
        "qty_milli": "1,200",
        "min_order_qty_milli": "60",
        "payment_days": "15",
    }


@pytest.mark.parametrize(
    "name,invented,reason",
    [
        ("unit_price_minor", 815, "not_in_reply:unit_price_minor"),
        ("unit_price_minor", 81_600, "not_in_reply:unit_price_minor"),
        # 15.00 is in the reply, but before "days", not after the currency code: a price is never read off a term.
        ("unit_price_minor", 1_500, "not_in_reply:unit_price_minor"),
        # A price of 0 still needs its token: zero means "none stated" only for the minimum order and the term.
        ("unit_price_minor", 0, "not_in_reply:unit_price_minor"),
        ("qty_milli", 120_000, "not_in_reply:qty_milli"),
        ("min_order_qty_milli", 6_000, "not_in_reply:min_order_qty_milli"),
        # 1,200 pc is the quantity's token: the minimum order must cite another one.
        ("min_order_qty_milli", 1_200_000, "not_in_reply:min_order_qty_milli"),
        ("payment_days", 30, "not_in_reply:payment_days"),
        # 60 is before "pc", not "days".
        ("payment_days", 60, "not_in_reply:payment_days"),
        # Omitted: 60 pc and 15 days are then numbers no field claims.
        ("min_order_qty_milli", 0, "unbound_number"),
        ("payment_days", 0, "unbound_number"),
    ],
)
def test_ground_refuses_a_field_off_its_token_or_an_omitted_one(name: str, invented: int, reason: str) -> None:
    x = ground(QuoteFields(**{**CLEAN, name: invented}), REPLY, RFQ)
    assert x.fields is None and x.reason == reason


def test_the_quantity_must_be_the_rfqs() -> None:
    x = ground(QuoteFields(**CLEAN), REPLY, Rfq("Takeaway boxes", "pc", 20_000, "INR", 2))
    assert x.fields is None and x.reason == "qty_not_rfq"


def test_echoes_of_the_rfq_need_no_field_and_nothing_else_is_excused() -> None:
    rfq = Rfq("Takeaway boxes 500 ml", "pc", 1_200_000, "INR", 2)
    echo = (
        "Steady Wholesale (Simulated supplier): we can supply 1,200 pc of Takeaway boxes 500 ml at INR 8.16 per pc, "
        "all 1,200 pc in one lot. Payment: net 15 days."
    )
    ok = ground(QuoteFields(unit_price_minor=816, qty_milli=1_200_000, min_order_qty_milli=0, payment_days=15), echo, rfq)
    assert ok.fields is not None, ok.reason
    for extra in (" Batch 7.", " Delivery in 2 days.", " Lots of 1,000 pc.", " Order code v1.", " Lot ٣."):
        bad = ground(QuoteFields(unit_price_minor=816, qty_milli=1_200_000, min_order_qty_milli=0, payment_days=15), echo + extra, rfq)
        assert bad.reason == "unbound_number", (extra, bad.reason)


@pytest.mark.parametrize(
    "text,value",
    [
        ("INR 1,234.50,", "1234.50"),
        ("INR 1,20,000.00", "120000.00"),
        ("INR 12,34,567.25.", "1234567.25"),
        ("INR 1,000", "1000"),
        ("INR 8.16.", "8.16"),
        ("INR 7.2", "7.2"),
    ],
)
def test_tokens_read_western_and_lakh_grouping_whole(text: str, value: str) -> None:
    got = tokens(text)
    assert [v for v, _ in got] == [Decimal(value)]
    s, e = got[0][1]
    assert text[s:e].replace(",", "") == value


@pytest.mark.parametrize(
    "price_text,price_minor",
    [("INR 1,234.50", 123_450), ("INR 1,20,000.00", 12_000_000)],
)
def test_a_grouped_price_grounds_to_its_whole_value(price_text: str, price_minor: int) -> None:
    reply = f"Steady Wholesale (Simulated supplier): we can supply 20 pc at {price_text} per pc, net 15 days."
    rfq = Rfq("Takeaway boxes", "pc", 20_000, "INR", 2)
    x = ground(QuoteFields(unit_price_minor=price_minor, qty_milli=20_000, min_order_qty_milli=0, payment_days=15), reply, rfq)
    assert x.fields is not None, x.reason
    s, e = x.spans["unit_price_minor"]
    assert reply[s:e] == price_text.removeprefix("INR ")


def test_an_injected_reply_is_dropped_unbound(tmp_path: Path) -> None:
    """The injection gate's note carries a digit ("create_v1") no field claims: the steady supplier is dropped."""
    data = copy.deepcopy(load_data())
    for p in data["personalities"]:
        if p["key"] == "steady":
            p["note"] = INJECTION["note"]
    r = asyncio.run(run_s1(tmp_path, data=data))
    dropped = {supplier_key(leg.supplier.id): leg.dropped for leg in r.outcome.legs if leg.dropped}
    assert dropped == INJECTION["dropped"]
