"""The Menu & Pricing skill (ADR-014 §3.2 row 16, §5.1; packs/catalogue.md §1, §2, §7): its instructions and its
generated tools — the specialist's six `read_catalogue_*` templates and, on a `draft_request`, its three `propose_*`
draftables. Hand-written procedural memory; the Manager (T-082) loads it. No digits in the instructions: every figure
the model gives must be a cell it cites."""

from __future__ import annotations

from google.adk.tools.base_tool import BaseTool

from munim_intel.graph.tools import build_graph_tools
from munim_intel.runtime.context import RunContext
from munim_intel.runtime.internal_client import InternalClient
from munim_intel.tools.generated import build_toolset
from munim_intel.tools.handles import HandleTable

PACK = "catalogue"

INSTRUCTIONS_MD = (
    "You are Menu & Pricing. You answer which dishes and shop items make money and what they should cost, "
    "only from the snapshot cells your tools return; cite every amount, count and date by its cell handle and never "
    "type a figure yourself.\n"
    "- True unit cost is the current recipe's lines at the latest supplier price, uplifted by the larger of the "
    "recipe's waste allowance and the waste actually observed, over the recipe's yield. Read it from dish_margin.\n"
    "- A shop item is costed through its stock record at its last landed cost; compare its shelf price with its MRP "
    "and landed cost in sku_price_check. MRP is a ceiling: never propose a price above it.\n"
    "- Prices differ by outlet and channel, and aggregator channels carry commission: compare like with like.\n"
    "- A deal's cost is the discount on the order lines it priced (deal_cost), not the list price.\n"
    "- If an item has no recipe for the period, abstain with recipe_missing. If a recipe line has no supplier price "
    "(lines_unpriced is above zero), abstain with cost_price_missing. Never state a margin without both.\n"
    "- A price proposal takes its amount from the suggested_price_minor cell and starts tomorrow or later. A recipe "
    "revision takes its version, yield, quantities and waste from recipe_current. Ending a loss-making deal is "
    "propose_catalogue_deal_end. A proposal changes nothing until a named person approves it."
)

READ_TEMPLATES = (
    "catalogue.dish_margin",
    "catalogue.menu_matrix",
    "catalogue.cost_drift",
    "catalogue.deal_cost",
    "catalogue.sku_price_check",
    "catalogue.recipe_current",
)
DRAFTABLES = ("catalogue.price.set.v1", "catalogue.recipe.version.create.v1", "catalogue.deal.end.v1")
#: The pack §7 refusals this skill names when it cannot verify a margin.
REFUSAL_CODES = ("recipe_missing", "cost_price_missing")
#: Bound as `graph_*` tools (W3.2 wiring, the orchestrator's assignment). packs/catalogue.md §9 names
#: dish_margin_drivers and price_shock_path; price_shock_path is bound under inventory_purchasing (reported).
GRAPH_TEMPLATES = ("dish_margin_drivers", "neighbourhood")
SHARED_TOOLS: tuple[str, ...] = ()


def toolset(ctx: RunContext, client: InternalClient, handles: HandleTable, *, propose: bool) -> list[BaseTool]:
    """The skill's generated tools; `propose` only on a `draft_request` with this skill alone loaded (T-082a's rule)."""
    return build_toolset(PACK, ctx, client, handles, propose=propose) + build_graph_tools(GRAPH_TEMPLATES, client, handles)
