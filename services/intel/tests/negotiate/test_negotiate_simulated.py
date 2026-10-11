"""RFQs go only to simulated suppliers (R22; R-C F4; DECISIONS 11 Oct, "W3.2 review ruling"): `negotiate()` checks every
supplier before it sends anything or writes any trace — kind `simulated` (from a core read filtered to it), card URL on
the configured suppliers-sim origin, the published card named "Simulated supplier" and advertising no other origin.
One supplier that fails refuses the whole negotiation. Each refusal is paired with the accept that differs only in it."""

from __future__ import annotations

import asyncio
import copy
from typing import Any

import httpx

from kit import (
    DEFAULT_POLICY,
    NOT_SIMULATED,
    OUTLET,
    PUBLIC,
    SUPPLIER_IDS,
    TENANT,
    WORLD,
    FakeCore,
    StubChooser,
    build_app,
    llm,
    load_data,
    suppliers,
)
from kit import no_fixture_misses as no_fixture_misses  # autouse: a missing recorded fixture fails the test
from munim_intel.negotiate.port import A2aSuppliers, NotSimulated, Supplier, simulated_suppliers
from munim_intel.negotiate.run import negotiate, negotiation_budget, rfq_from
from munim_intel.runtime.context import RunContext
from munim_intel.runtime.state import RunState
from munim_intel.trace.buffer import TraceBuffer

CTX = RunContext("0199a000-0000-7000-8000-00000000e0f0", TENANT, (OUTLET,), "event", "watcher:inventory_purchasing", 2_000_000_000, "tok")
OTHER = "https://elsewhere.example.test"


class _Port:
    """The real A2A port, counting sends: a refusal must come before the first one."""

    def __init__(self, inner: A2aSuppliers) -> None:
        self.inner, self.sends = inner, 0

    async def check(self, s: Supplier) -> None:
        await self.inner.check(s)

    async def send(self, s: Supplier, context_id: str, data: dict[str, Any], text: str) -> str:
        self.sends += 1
        return await self.inner.send(s, context_id, data, text)


def _negotiate(
    supplier_list: list[Supplier], *, sim_url: str = PUBLIC, data: dict[str, Any] | None = None
) -> tuple[str | None, int, int, int]:
    """(refusal code or None, sends, a2a traces, quotes stored) for one negotiation over the in-process sim, which is
    built for `sim_url` but always reached at PUBLIC, the configured origin."""

    async def go() -> tuple[str | None, int, int, int]:
        core = FakeCore(WORLD["deal_inputs"], run_id=CTX.run_id)
        state = RunState(traces=TraceBuffer(core.write_traces), budget=negotiation_budget(len(supplier_list), DEFAULT_POLICY))
        w = WORLD["rfq"]
        rfq = rfq_from(core.shortfall().model_dump(mode="json"), 0, core.last_price().model_dump(mode="json"), 0, "latest_minor",
                       item_name=w["item_name"], unit=w["unit"], currency=w["currency"], minor_unit=w["minor_unit"],
                       needed_by=w["needed_by"], outlet_ids=(OUTLET,))  # fmt: skip
        app = build_app(sim_url, data=data or load_data())
        async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url=PUBLIC) as http:
            port = _Port(A2aSuppliers(http, PUBLIC))
            code = None
            try:
                await negotiate(CTX, rfq, supplier_list, port=port, core=core, chooser=StubChooser(lambda _r, _l: None),
                                extract_llm=llm("extract"), state=state, policy=DEFAULT_POLICY)  # fmt: skip
            except NotSimulated as e:
                code = e.code
        a2a = [e for e in state.traces.events if e.kind.startswith("a2a_")]
        return code, port.sends, len(a2a), len(core.quotes)

    return asyncio.run(go())


def test_simulated_suppliers_negotiate() -> None:
    """The accept every refusal below is paired with: three simulated suppliers on the configured origin."""
    code, sends, a2a, quotes = _negotiate(suppliers())
    print(f"simulated only: refusal {code}, sends {sends}, a2a traces {a2a}, quotes {quotes}")
    assert code is None and sends >= 3 and a2a == 2 * sends and quotes >= 3


def test_a_supplier_of_another_kind_refuses_the_run_before_any_send() -> None:
    real = Supplier(NOT_SIMULATED, f"{PUBLIC}/steady/.well-known/agent-card.json", "real")
    got = _negotiate([*suppliers(), real])
    print(f"with a kind=real supplier: {got}")
    assert got == ("not_simulated", 0, 0, 0)


def test_the_core_read_keeps_simulated_rows_with_a_card_only() -> None:
    rows: list[dict[str, Any]] = [
        {"supplier_id": SUPPLIER_IDS["steady"], "kind": "simulated", "a2a_card_url": f"{PUBLIC}/steady/.well-known/agent-card.json"},
        {"supplier_id": NOT_SIMULATED, "kind": "real", "a2a_card_url": "https://supplier.example.test/card.json"},
        {"supplier_id": SUPPLIER_IDS["premium"], "kind": "simulated", "a2a_card_url": None},
    ]
    kept = simulated_suppliers(rows)
    assert [(s.id, s.kind) for s in kept] == [(SUPPLIER_IDS["steady"], "simulated")]


def test_a_card_url_off_the_configured_origin_is_refused() -> None:
    off = [Supplier(s.id, s.card_url.replace(PUBLIC, OTHER), "simulated") for s in suppliers()]
    assert _negotiate(off) == ("card_off_origin", 0, 0, 0)


def test_a_card_not_named_simulated_supplier_is_refused() -> None:
    data = copy.deepcopy(load_data())
    data["label"] = "Supplier"
    assert _negotiate(suppliers(), data=data) == ("card_not_labelled", 0, 0, 0)


def test_a_card_advertising_another_origin_is_refused() -> None:
    """The sim built for another public URL publishes interfaces there, though its cards are fetched at PUBLIC."""
    assert _negotiate(suppliers(), sim_url=OTHER) == ("interface_off_origin", 0, 0, 0)
