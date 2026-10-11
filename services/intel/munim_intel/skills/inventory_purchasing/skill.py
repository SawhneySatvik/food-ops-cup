"""The Inventory & purchasing skill (ADR-014 §6.5; packs/inventory-purchasing.md §1, §2, §7), loaded by the Manager (T-082).

Instructions (no digits; cite or abstain), the refusal codes the skill may abstain with, and its generated toolset —
nothing else. Binding `propose_*` only on `draft_request` with one skill loaded and an untainted run is the Manager's
rule (T-082a), so `tools(..., propose=False)` is the read-only binding. The two `graph_*` tools taint the run when they
return rows (graph/tools.py). No `request_quotes` tool: no template lists the simulated suppliers' agent cards yet (W3.2
report); the negotiation runs as its own workflow (munim_intel/negotiate).
"""

from __future__ import annotations

from google.adk.tools.base_tool import BaseTool

from munim_intel.graph.tools import build_graph_tools
from munim_intel.runtime.context import RunContext
from munim_intel.runtime.internal_client import InternalClient
from munim_intel.tools.generated import build_toolset
from munim_intel.tools.handles import HandleTable

PACK = "inventory_purchasing"

INSTRUCTIONS_MD = """You are the inventory and purchasing specialist: stock on hand, running short, waste, expiry, stock counts, \
supplier prices and supplier invoices.
- Every amount, quantity, count and date you state must be a cell handle from a read tool, written exactly as given. Never \
type a digit, a number word or a currency amount yourself. If no cell answers the question, abstain.
- Stock on hand and its value come from the stock reads; prices per unit from the price creep read; billing against the \
order from the invoice check read.
- Missing stock can be measured only between counts. If no stock count was completed at the outlet in the period, abstain \
with count_missing.
- Expiry is known only for stock tracked by batch. If the item is not tracked by batch, abstain with expiry_missing.
- Suppliers here are simulated. Call each such supplier a "Simulated supplier" and never imply a real supplier, order or payment.
- Do not negotiate with suppliers or ask them for quotes. You may propose a change only when asked for a draft; a named \
person approves every change before it happens."""

READ_TEMPLATES = (
    "inventory.below_reorder",
    "inventory.shortfall",
    "inventory.waste_week",
    "inventory.expiry_risk",
    "inventory.shrinkage",
    "inventory.dead_stock",
    "purchasing.price_creep",
    "purchasing.invoice_vs_po",
    "purchasing.quote_compare",
    "purchasing.invoices",
    "inventory.counts",
    "inventory.count_variance",
)
DRAFTABLES = (
    "purchasing.po.create.v1",
    "purchasing.invoice.dispute.v1",
    "purchasing.supplier_return.create.v1",
    "inventory.reorder_level.set.v1",
    "inventory.transfer.create.v1",
)
#: Pack §7 refusals this skill names (the third, `moq_exceeds_need`, is the deal review's: T-055).
REFUSAL_CODES = ("count_missing", "expiry_missing")
#: packs/inventory-purchasing.md §9, bound as `graph_*` tools (W3.2 wiring).
GRAPH_TEMPLATES = ("supplier_dependency", "price_shock_path")
SHARED_TOOLS: tuple[str, ...] = ()


def toolset(ctx: RunContext, client: InternalClient, handles: HandleTable, *, propose: bool) -> list[BaseTool]:
    """The skill's generated tools; `propose` only on a `draft_request` with this skill alone loaded (T-082a's rule)."""
    return build_toolset(PACK, ctx, client, handles, propose=propose) + build_graph_tools(GRAPH_TEMPLATES, client, handles)
