"""`finance.unapproved_ad_fee` (packs/finance.md §4, §5, §6; plants F1, F2; answer keys RG-F1/F2, CK-F1/F2, AU-F1).

Template `finance.unapproved_deductions`, one row per channel for a month. Fires when `unapproved_minor` ≥ the pack's
`unapproved_minor_gte` (IN ₹100, AU A$2). A channel with no terms has a null `unapproved_minor` (nothing can be called
unapproved without a consent record) and never fires. Severity L on the month's `unapproved_minor`, at least `high`
when ads were never opted in. Dedupe `<outlet>:<channel>:<month>` (pack §4 `<channel>:<month>`, per outlet — T-040 note a).
Draft: `finance.dispute.draft.v1`, basis `unapproved_ad_fee`, no lines, total ← `unapproved_minor` (pack §6).
"""

from __future__ import annotations

from datetime import date

from munim_intel.detect import DetectorSpec, Ladder, OutletFrame, Row, Severity, Thresholds, Window, at_least, num, register
from munim_intel.mapping import Detection, Proposal

#: The months a run looks at: the outlet's current business month and the two before it (pack F1: "for 3 months").
MONTHS_BACK = 3


def _month_starts(today: date, n: int) -> list[date]:
    y, m = today.year, today.month
    out = []
    for _ in range(n):
        out.append(date(y, m, 1))
        y, m = (y, m - 1) if m > 1 else (y - 1, 12)
    return out


def windows(outlet: OutletFrame, _: Thresholds) -> list[Window]:
    return [
        Window({"channel_id": None, "month": m.isoformat(), "outlet_id": outlet.id}, m.isoformat()[:7])
        for m in _month_starts(outlet.business_date, MONTHS_BACK)
    ]


def fires(row: Row, t: Thresholds) -> bool:
    amount = num(row, "unapproved_minor")
    return isinstance(row.get("channel_id"), str) and amount is not None and amount >= t["unapproved_minor_gte"]


def severity(row: Row, _: Thresholds, ladder: Ladder) -> Severity:
    s = ladder.of(num(row, "unapproved_minor") or 0)
    return at_least(s, "high") if row.get("ads_opted_in") is False else s


def dedupe(row: Row, w: Window) -> str:
    return f"{w.params['outlet_id']}:{row['channel_id']}:{w.key}"


def dispute(d: Detection) -> Proposal:
    channel = str(d.row["channel_id"])  # `fires` admits only rows whose channel_id is a uuid string
    total = d.ref("unapproved_minor")
    return Proposal(
        command_type="finance.dispute.draft.v1",
        payload={
            "channel_id": channel,
            "basis": "unapproved_ad_fee",
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
        id="finance.unapproved_ad_fee",
        thresholds=("unapproved_minor_gte",),
        pack="finance",
        template="finance.unapproved_deductions",
        finding_type="reconciliation_break.unapproved_ad_fee",
        impact_column="unapproved_minor",
        windows=windows,
        fires=fires,
        severity=severity,
        dedupe=dedupe,
        narration=(
            "This channel charged ad and promotion fees beyond what was agreed for the month: {unapproved_minor} unapproved, "
            "out of {ad_fee_minor} in ad fees and {promo_share_minor} in promotion share."
        ),
        mapping=dispute,
    )
)
