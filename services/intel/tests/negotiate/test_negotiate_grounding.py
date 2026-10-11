"""Clause 2 on the supplier path: a quote field the extractor returns must be found in the simulated supplier's reply
(the claim-quote substring idea, MB012). Invented → the quote is dropped, never stored; the run goes on without it.
Expected values: s1_world.json `expected.invented_price`, worked by hand."""

from __future__ import annotations

import asyncio
import json
import shutil
from pathlib import Path

import pytest

from kit import FIXTURES, WORLD, StubChooser, run_s1, supplier_key
from munim_intel.negotiate.extract import QuoteFields, ground, parse

PLANT = WORLD["expected"]["invented_price"]
REPLY = (
    "Steady Wholesale (Simulated supplier): we can supply 1,200 pc of Takeaway boxes at INR 8.16 per pc. "
    "Payment: net 15 days. Terms: minimum order 60 pc."
)
CLEAN = {"unit_price_minor": 816, "qty_milli": 1_200_000, "min_order_qty_milli": 60_000, "payment_days": 15}


def test_a_planted_invented_price_drops_the_quote_and_the_po_goes_elsewhere(tmp_path: Path) -> None:
    out = tmp_path / "planted"
    shutil.copytree(FIXTURES, out)
    hits = 0
    for f in out.glob("*.json"):
        fx = json.loads(f.read_text("utf8"))
        asked = json.dumps(fx["request"], ensure_ascii=False)
        steady_rfq = "Steady Wholesale" in asked and "we can supply" in asked and "SYSTEM" not in asked  # not the injection gate's
        if fx["request"]["model"] == "recorded/extract" and steady_rfq:
            part = fx["responses"][0]["content"]["parts"][0]
            fields = json.loads(part["text"])
            fields["unit_price_minor"] = PLANT["planted_minor"]
            part["text"] = json.dumps(fields)
            f.write_text(json.dumps(fx, ensure_ascii=False))
            hits += 1
    assert hits == 1
    r = asyncio.run(run_s1(tmp_path, chooser=StubChooser(lambda _r, _l: None), fixtures=out))
    dropped = {supplier_key(leg.supplier.id): leg.dropped for leg in r.outcome.legs if leg.dropped}
    stored = [q for q in r.core.quotes if q["unit_price_minor"] == PLANT["planted_minor"]]
    po = r.outcome.draft_request
    assert po is not None
    line = po["payload"]["lines"][0]
    who, price = supplier_key(po["payload"]["supplier_id"]), r.core.cell(line["unit_price_minor"])
    abstains = [e.model_dump(mode="json")["payload"] for e in r.state.traces.events if e.kind == "abstain"]
    print(
        f"invented price: dropped {dropped}, stored with the invented price {len(stored)}, abstain traces {abstains}, PO {who} at {price}"
    )
    assert dropped == PLANT["dropped"] and stored == []
    assert (who, price) == (PLANT["po_supplier"], PLANT["po_unit_price_minor"])


def test_every_recorded_clean_reply_is_grounded() -> None:
    files = [json.loads(f.read_text("utf8")) for f in sorted(FIXTURES.glob("*.json"))]
    extracts = [fx for fx in files if fx["request"]["model"] == "recorded/extract"]
    passed = 0
    for fx in extracts:
        text = "\n".join(p.get("text", "") for c in fx["request"]["contents"] for p in c["parts"])
        reply = text.split("<untrusted>\n")[1].split("\n</untrusted>")[0]
        minor = len(text.split("minor units per major unit: ")[1].split("\n")[0]) - 1
        fields = parse(fx["responses"][0]["content"]["parts"][0]["text"])
        assert fields is not None
        passed += ground(fields, reply, minor).fields is not None
    print(f"recorded extractions grounded {passed}/{len(extracts)}")
    assert len(extracts) >= 20 and passed == len(extracts)


def test_ground_finds_each_field_with_its_span() -> None:
    x = ground(QuoteFields(**CLEAN), REPLY, 2)
    assert x.fields is not None and x.reason is None
    assert {k: REPLY[a:b] for k, (a, b) in x.spans.items()} == {
        "unit_price_minor": "8.16",
        "qty_milli": "1,200",
        "min_order_qty_milli": "60",
        "payment_days": "15",
    }


@pytest.mark.parametrize(
    "name,invented",
    [("unit_price_minor", 815), ("qty_milli", 120_000), ("min_order_qty_milli", 6_000), ("payment_days", 30), ("unit_price_minor", 81_600)],
)
def test_ground_refuses_each_invented_field(name: str, invented: int) -> None:
    x = ground(QuoteFields(**{**CLEAN, name: invented}), REPLY, 2)
    assert x.fields is None and x.reason == f"not_in_reply:{name}"
