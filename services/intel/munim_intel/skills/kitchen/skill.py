"""The Kitchen specialist's skill (ADR-014 §6.5 SkillSpec fields; packs/kitchen.md §2, §3, §6, §7, §9). The Manager
(T-082) loads it for a kitchen question and, on `draft_request`, binds its propose tools. Everything here is data plus
the generated toolset; the refusal check is the pack's §7 rule as code, because instructions carry no digits.
"""

from __future__ import annotations

from collections.abc import Mapping, Sequence

from google.adk.tools.base_tool import BaseTool

from munim_intel.runtime.context import RunContext
from munim_intel.runtime.internal_client import InternalClient
from munim_intel.tools.generated import build_toolset
from munim_intel.tools.handles import HandleTable

PACK = "kitchen"

INSTRUCTIONS_MD = """You are the Kitchen specialist for restaurants and cloud kitchens. A shop has no kitchen: say so and stop.
- Ticket time runs from accepted to ready; lateness from the promised time to ready. Judge a station or slot against
  its own earlier weeks and its load: a busy festival night is load, not drift.
- Read kitchen.ticket_coverage before any answer about ticket times. Too few timed tickets means you cannot verify:
  say so and ask staff to bump tickets on the kitchen display.
- Lateness money is only what was recorded: refunds for lateness and orders cancelled after their promised time.
  Never estimate lost sales.
- Remakes and over-prep are the other kitchen leaks; name stations, dishes and slots, never people.
- A prep time proposal cites the observed slow-ticket time from kitchen.ticket_times.
- A prep list cites kitchen.prep_need cells; with no current forecast for the date you cannot verify.
- Cite every number by its cell handle. Never type a digit. If a cell is missing, abstain.
- Every proposal is a draft a manager approves; nothing changes until then."""

READ_TEMPLATES = (
    "kitchen.ticket_times",
    "kitchen.ticket_drift",
    "kitchen.remakes_overprep",
    "kitchen.prep_need",
    "kitchen.ticket_coverage",
)
DRAFTABLES = ("kitchen.prep_time.set.v1", "kitchen.prep_list.create.v1")
REFUSAL_CODES = ("ticket_times_missing", "forecast_stale")
#: packs/kitchen.md §9: from a kitchen finding to the dishes and day involved.
GRAPH_TEMPLATES = ("neighbourhood",)
SHARED_TOOLS: tuple[str, ...] = ()

#: packs/kitchen.md §7: below this share of timed tickets, ticket times cannot be verified.
COVERAGE_FLOOR_BP = 8_000


def refusal(template_id: str, rows: Sequence[Mapping[str, object]]) -> str | None:
    """The pack §7 refusal a snapshot of `template_id` calls for, or None. A missing cell refuses (never assumed)."""
    if template_id == "kitchen.ticket_coverage":
        cov = rows[0].get("coverage_bp") if rows else None
        return "ticket_times_missing" if not isinstance(cov, int) or cov < COVERAGE_FLOOR_BP else None
    if template_id == "kitchen.prep_need":
        # No row = no forecast points for the date (the template reads the latest run that has them).
        return "forecast_stale" if not rows else None
    return None


def toolset(ctx: RunContext, client: InternalClient, handles: HandleTable, *, propose: bool) -> list[BaseTool]:
    return build_toolset(PACK, ctx, client, handles, propose=propose)
