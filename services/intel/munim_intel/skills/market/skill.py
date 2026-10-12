"""The Market & Strategy skill (ADR-014 §3.2 row 23, §5.1; packs/market-strategy.md §1, §2, §7): its instructions and
its generated tools — the specialist's six `read_market_*` templates and, on a `draft_request`, `propose_goals_*`.
Hand-written procedural memory; the Manager (T-082) loads it. No digits in the instructions."""

from __future__ import annotations

from google.adk.tools.base_tool import BaseTool

from munim_intel.runtime.context import RunContext
from munim_intel.runtime.internal_client import InternalClient
from munim_intel.tools.generated import build_toolset
from munim_intel.tools.handles import HandleTable

PACK = "market"

INSTRUCTIONS_MD = (
    "You are Market & Strategy. You answer what is coming up for an outlet, what similar days did to its orders, "
    "how its goals are pacing and whether a new site would pay back, only from the snapshot cells your tools return; "
    "cite every amount, count and date by its cell handle and never type a figure yourself.\n"
    "- Weather, festivals, local events and competitor prices exist only as market signals the owner imported and "
    "approved. If none covers the outlet and dates asked about, abstain with signal_source_missing. Never forecast "
    "the weather yourself.\n"
    "- A signal's effect is measured on this outlet's own history against the same weekday without the signal "
    "(signal_uplift, upcoming). With too few past occurrences the effect is unknown: say so.\n"
    "- Forecast notes explain the forecast; they never change it.\n"
    "- Viability is break-even orders a day and payback months from the owner's stated case and a comparable "
    "outlet's closed months (viability). Without closed months or the site's rent and setup cost, abstain with "
    "insufficient_history. Never predict success.\n"
    "- A competitor price gap is a prompt to review a price, never a price proposal.\n"
    "- A goal proposal takes its target from a goal_baseline cell; a task proposal names the finding it answers. "
    "A proposal changes nothing until a named person approves it.\n"
    "- Cares figures go to simulated recipients and are measured on synthetic data; meals are cooked portions only."
)

READ_TEMPLATES = (
    "market.signal_uplift",
    "market.upcoming",
    "market.competitor_gap",
    "market.viability",
    "market.goal_progress",
    "market.goal_baseline",
    "market.goals",
    # ADR-015 §4: the Cares listings and impact report (0028).
    "cares.listings",
    "cares.impact",
)
DRAFTABLES = ("goals.goal.create.v1", "goals.task.create.v1")
#: The pack §7 refusals this skill names.
REFUSAL_CODES = ("signal_source_missing", "insufficient_history")
#: packs/market-strategy.md §9.
GRAPH_TEMPLATES = ("claim_support", "neighbourhood")
SHARED_TOOLS: tuple[str, ...] = ()


def toolset(ctx: RunContext, client: InternalClient, handles: HandleTable, *, propose: bool) -> list[BaseTool]:
    """The skill's generated tools; `propose` only on a `draft_request` with this skill alone loaded (T-082a's rule)."""
    return build_toolset(PACK, ctx, client, handles, propose=propose)
