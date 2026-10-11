"""T-046 skill gates (ADR-014 §5.1, §6.5). Hand values: the read and propose tools the ADR's §5.1 counts and the
specialist registry name for inventory_purchasing (9 reads + 5 draftables), the 20-tool cap (F3), the 1.5k instruction cap,
and the pack §7 refusal codes this skill owns (count_missing, expiry_missing; moq_exceeds_need is T-055's deal review)."""

from __future__ import annotations

import re
from typing import cast

from munim_intel.contracts_gen.models import ReasonCode
from munim_intel.runtime.context import RunContext
from munim_intel.runtime.internal_client import InternalClient
from munim_intel.skills.inventory_purchasing import skill
from munim_intel.tools.handles import HandleTable

CTX = RunContext(
    "01920000-0000-7000-8000-0000000046a1", "01920000-0000-7000-8000-0000000046b1", ("*",), "ask", "manager", 2_000_000_000, "h.p.s"
)
# The pack §3 nine plus the three 0022 reads the orchestrator assigned (11 Oct): purchasing.invoices, inventory.counts,
# inventory.count_variance.
READS = {
    "read_purchasing_invoices",
    "read_inventory_counts",
    "read_inventory_count_variance",
    "read_inventory_below_reorder",
    "read_inventory_shortfall",
    "read_inventory_waste_week",
    "read_inventory_expiry_risk",
    "read_inventory_shrinkage",
    "read_inventory_dead_stock",
    "read_purchasing_price_creep",
    "read_purchasing_invoice_vs_po",
    "read_purchasing_quote_compare",
}
PROPOSES = {
    "propose_purchasing_po_create",
    "propose_purchasing_invoice_dispute",
    "propose_purchasing_supplier_return_create",
    "propose_inventory_reorder_level_set",
    "propose_inventory_transfer_create",
}


def names(propose: bool) -> set[str]:
    return {t.name for t in skill.toolset(CTX, cast(InternalClient, None), HandleTable(), propose=propose)}


def test_instructions_have_no_digit_and_fit_the_cap() -> None:
    print("instruction chars:", len(skill.INSTRUCTIONS_MD))
    assert re.findall(r"\d", skill.INSTRUCTIONS_MD) == []
    assert 0 < len(skill.INSTRUCTIONS_MD) <= 1_500


def test_refusal_codes_are_registered_reason_codes_named_in_the_instructions() -> None:
    known = set(ReasonCode.model_fields["root"].annotation.__args__)  # type: ignore[union-attr]
    assert skill.REFUSAL_CODES == ("count_missing", "expiry_missing")
    assert set(skill.REFUSAL_CODES) <= known
    assert all(code in skill.INSTRUCTIONS_MD for code in skill.REFUSAL_CODES)


#: The orchestrator's W3.2 graph wiring (pack §9): two graph tools, bound in both bindings (they read, never propose).
GRAPH = {"graph_supplier_dependency", "graph_price_shock_path"}


def test_the_read_binding_is_the_twelve_reads_and_the_draft_binding_adds_the_five_proposals() -> None:
    reads, both = names(propose=False), names(propose=True)
    print("reads:", sorted(reads), "proposes:", sorted(both - reads))
    assert reads == READS | GRAPH
    assert both == READS | PROPOSES | GRAPH
    assert len(both) == 19 <= 20  # 12 reads + 5 proposals + 2 graph tools (F3 cap 20)


def test_the_skill_names_no_negotiation_tool() -> None:
    assert not any("quote" in n and n != "read_purchasing_quote_compare" for n in names(propose=True))
