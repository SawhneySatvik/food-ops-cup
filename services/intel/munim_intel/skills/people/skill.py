"""The People specialist's skill (ADR-014 §6.5 SkillSpec fields; packs/people.md §2, §3, §6, §7, §9). The Manager
(T-082) loads it for a staffing question and, on `draft_request`, binds its propose tools. Everything here is data plus
the generated toolset; the refusal check is the pack's §7 rule as code, because instructions carry no digits.
"""

from __future__ import annotations

from collections.abc import Mapping, Sequence

from google.adk.tools.base_tool import BaseTool

from munim_intel.runtime.context import RunContext
from munim_intel.runtime.internal_client import InternalClient
from munim_intel.tools.generated import build_toolset
from munim_intel.tools.handles import HandleTable

PACK = "people"

INSTRUCTIONS_MD = """You are the People specialist: hours against demand, overtime, labour cost and staff advances.
- Labour cost is attended time at each person's rate. Overtime is time worked beyond the roster, not a legal limit;
  never interpret labour law.
- Demand comes from forecast orders; the norm is the outlet's own orders per labour hour for that weekday and slot,
  never an industry benchmark.
- Read people.attendance_coverage before any answer about hours, overtime or labour cost. If attendance was not
  recorded for most rostered shifts, you cannot verify: say so. Never assume rostered equals worked.
- Payroll drafts exist only where the country pack prepares payroll. Elsewhere Munim prepares rosters only: say payroll
  is run in the owner's payroll software, and do not propose a payroll draft.
- A roster proposal cites the forecast orders and needed minutes it is based on. A payroll proposal cites the
  people.payroll_lines cells for every amount.
- Name shifts and slots; never rank or judge a person's worth.
- Cite every number by its cell handle. Never type a digit. If a cell is missing, abstain.
- Every proposal is a draft a named person approves; nothing changes until then."""

READ_TEMPLATES = (
    "people.labour_vs_demand",
    "people.overtime_drift",
    "people.labour_pct",
    "people.attendance_coverage",
    "people.advances_open",
    "people.payroll_lines",
)
DRAFTABLES = ("people.roster.create.v1", "people.payroll_draft.create.v1")
REFUSAL_CODES = ("attendance_missing", "payroll_out_of_scope")
#: packs/people.md §9: neighbourhood (depth ≤ 2) of a people finding; wage rates never ride on edges.
GRAPH_TEMPLATES = ("neighbourhood",)
SHARED_TOOLS: tuple[str, ...] = ()

#: packs/people.md §7: below this share of rostered shifts with attendance, hours worked are unknown.
COVERAGE_FLOOR_BP = 8_000


def refusal(template_id: str, rows: Sequence[Mapping[str, object]]) -> str | None:
    """The pack §7 refusal a snapshot of `template_id` calls for, or None. A missing cell refuses (never assumed)."""
    if template_id == "people.attendance_coverage":
        cov = rows[0].get("coverage_bp") if rows else None
        return "attendance_missing" if not isinstance(cov, int) or cov < COVERAGE_FLOOR_BP else None
    return None


def payroll_refusal(payroll_scope: str | None) -> str | None:
    """P6 (packs/people.md §6, §10): payroll is drafted only where the run-frame's pack says `drafts`; anything else —
    `roster_only`, or no scope known — refuses, decided here and not by the model."""
    return None if payroll_scope == "drafts" else "payroll_out_of_scope"


def toolset(
    ctx: RunContext, client: InternalClient, handles: HandleTable, *, propose: bool, payroll_scope: str | None = None
) -> list[BaseTool]:
    """The generated tools; the payroll proposal is bound only under a `drafts` pack (core refuses it elsewhere too)."""
    tools = build_toolset(PACK, ctx, client, handles, propose=propose)
    if payroll_refusal(payroll_scope) is None:
        return tools
    return [t for t in tools if t.name != PAYROLL_TOOL]


PAYROLL_TOOL = "propose_people_payroll_draft_create"
