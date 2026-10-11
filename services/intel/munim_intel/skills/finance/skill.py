"""The Finance specialist's skill (ADR-014 §6.5 SkillSpec fields; packs/finance.md §1, §2, §3, §6, §7, §9). The Manager
(T-082) loads it for a money question and, on `draft_request`, binds its propose tools. Everything here is data plus the
generated toolset; the pack §7 refusals are code over typed cells, because instructions carry no digits.
"""

from __future__ import annotations

from collections.abc import Mapping, Sequence

from google.adk.tools.base_tool import BaseTool

from munim_intel.runtime.context import RunContext
from munim_intel.runtime.internal_client import InternalClient
from munim_intel.tools.generated import build_toolset
from munim_intel.tools.handles import HandleTable

PACK = "finance"

INSTRUCTIONS_MD = """You are the Finance specialist: what the delivery channels paid against what they owe, counter
payments against the bank, profit by outlet, brand and channel, and the month-end close. All data is synthetic and every
payment is recorded, never processed.
- Lead with unapproved deductions. An ad fee or promotion share is unapproved only against the channel's recorded terms
  for that month. Read finance.unapproved_deductions; when a channel has no recorded terms, refuse with
  consent_record_missing and ask the owner to add the terms they agreed.
- A short payout is expected net (order value less contracted commission, tax withheld and the refunds we recorded) less
  what was paid, per line: read finance.settlement_vs_orders. A refund we recorded explains a lower payout; it is not a
  shortfall.
- Completed orders absent from every payout after the channel's cycle are missing payouts, not short ones: read
  finance.missing_payouts.
- Counter UPI and card payments are matched to bank credits per outlet per day: read finance.tender_vs_bank. When no bank
  credit covers the days asked, refuse with bank_lines_missing. When gaps rise with voids on a single person's shifts, name
  the shifts, never a motive.
- Profit comes only from postings: read finance.pnl, and finance.margin_bridge for why margin moved from the month before.
- Tax collected and paid by code comes from finance.gst_summary.
  Before stating a month's profit, read finance.close_status; when settlements_imported is not done, refuse with
  settlements_missing, because payouts not yet imported would make the profit wrong.
- Tax checks compare order tax with posted tax: read finance.gst_check. Tax rules come from the country pack, never from
  you.
- Payout and bank files are imports a person approves; nothing is reconciled before that.
- Disputes are drafted for the owner to send. Munim never contacts a channel. Propose finance.dispute.draft with the
  claimed total cited from the snapshot cell that measures it; finance.journal.adjust and finance.period.close only with
  every amount and account cited from cells you read.
- Cite every number by its cell handle. Never type a digit. If a cell is missing, abstain.
- Every proposal is a draft a named person approves; nothing changes until then."""

READ_TEMPLATES = (
    "finance.unapproved_deductions",
    "finance.settlement_vs_orders",
    "finance.missing_payouts",
    "finance.tender_vs_bank",
    "finance.pnl",
    "finance.gst_check",
    "finance.close_status",
    "finance.margin_bridge",
    "finance.gst_summary",
)
DRAFTABLES = ("finance.dispute.draft.v1", "finance.journal.adjust.v1", "finance.period.close.v1")
REFUSAL_CODES = ("consent_record_missing", "bank_lines_missing", "settlements_missing")
#: packs/finance.md §9: neighbourhood (depth ≤ 2) of a finance finding; no money on edges.
GRAPH_TEMPLATES = ("neighbourhood",)
SHARED_TOOLS: tuple[str, ...] = ()


def refusal(template_id: str, rows: Sequence[Mapping[str, object]]) -> str | None:
    """The pack §7 refusal a snapshot of `template_id` calls for, or None. A missing cell refuses (never assumed)."""
    if template_id == "finance.unapproved_deductions":
        # No terms for the channel-month: the template leaves ads_opted_in (and every allowance) null.
        return "consent_record_missing" if any(not isinstance(r.get("ads_opted_in"), bool) for r in rows) else None
    if template_id == "finance.tender_vs_bank":
        credited = [r.get("credited_minor") for r in rows if r.get("business_on") is not None]
        return None if any(isinstance(c, int) and c > 0 for c in credited) else "bank_lines_missing"
    if template_id == "finance.close_status":
        item = next((r for r in rows if r.get("item_code") == "settlements_imported"), None)
        return None if item is not None and item.get("done") is True else "settlements_missing"
    return None


def toolset(ctx: RunContext, client: InternalClient, handles: HandleTable, *, propose: bool) -> list[BaseTool]:
    return build_toolset(PACK, ctx, client, handles, propose=propose)
