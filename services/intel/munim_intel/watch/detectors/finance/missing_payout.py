"""`finance.missing_payout` (packs/finance.md §4, §5, §6; plants F4, F7; answer keys RG-F4, RG-F7).

Template `finance.missing_payouts` **version 2** (requested from the migrator: tests/packs/finance/
requested_templates_v2.sql), minted per outlet as of the outlet's business date. Version 2 puts one Σ row per channel
first (`order_id` null, with `channel_id`), whose `days_unsettled` is the oldest unsettled order's age; version 1's Σ
row has a null age and no channel, so on version 1 this detector never fires.

Fires on a channel's Σ row when the oldest completed order in no payout is older than the pack's `days_unsettled_gt`
(10 days): the channel is overdue. Impact: the Σ `order_total_minor` of every order of that channel in no payout — the
answer keys measure the order values (RG-F4 6 × 29,400; RG-F7 Σ order values), and pack §4 grades severity on "Σ order
totals"; pack §5 names `expected_net_minor` instead, which the dispute claims (reported). Severity L on that Σ.
Dedupe `<outlet>:<channel>:<iso_week>` of the business date: a backlog still unpaid next week is raised again.
Draft: `finance.dispute.draft.v1`, basis `missing_payout`, no lines, total ← the Σ row's `expected_net_minor` (pack §6).
"""

from __future__ import annotations

from munim_intel.detect import DetectorSpec, Ladder, OutletFrame, Row, Severity, Thresholds, Window, num, register
from munim_intel.mapping import Detection, Proposal
from munim_intel.watch.detectors.finance.periods import iso_week


def windows(outlet: OutletFrame, _: Thresholds) -> list[Window]:
    day = outlet.business_date
    return [Window({"channel_id": None, "as_of": day.isoformat(), "outlet_id": outlet.id}, iso_week(day))]


def fires(row: Row, t: Thresholds) -> bool:
    oldest = num(row, "days_unsettled")
    return row.get("order_id") is None and isinstance(row.get("channel_id"), str) and oldest is not None and oldest > t["days_unsettled_gt"]


def severity(row: Row, _: Thresholds, ladder: Ladder) -> Severity:
    return ladder.of(num(row, "order_total_minor") or 0)


def dedupe(row: Row, w: Window) -> str:
    return f"{w.params['outlet_id']}:{row['channel_id']}:{w.key}"


def dispute(d: Detection) -> Proposal:
    channel = str(d.row["channel_id"])  # `fires` admits only Σ rows whose channel_id is a uuid string
    total = d.ref("expected_net_minor")
    return Proposal(
        command_type="finance.dispute.draft.v1",
        payload={
            "channel_id": channel,
            "basis": "missing_payout",
            "lines": [],
            "total_claimed_minor": total,
            "currency": d.currency,
            "break_ids": [],
        },
        based_on=[total],
        targets=[channel],
        minted=["dispute_id"],
    )


SPEC = register(
    DetectorSpec(
        id="finance.missing_payout",
        pack="finance",
        template="finance.missing_payouts",
        finding_type="reconciliation_break.missing_payout",
        impact_column="order_total_minor",
        windows=windows,
        fires=fires,
        severity=severity,
        dedupe=dedupe,
        narration=(
            "Completed orders on this channel are in no payout: {order_total_minor} in order value, the oldest unpaid for "
            "{days_unsettled} days. After its commission the channel owes {expected_net_minor} for them."
        ),
        mapping=dispute,
    )
)
