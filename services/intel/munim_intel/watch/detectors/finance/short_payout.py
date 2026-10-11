"""`finance.short_payout` (packs/finance.md §4, §5, §6; plant F3; answer keys RG-F3, CK-F3, AU-F3).

Template `finance.settlement_vs_orders` **version 2** (migration 0023 F1), minted per outlet for the current business
month and the two before it (by settlement period end). Version 2 puts one Σ row per settlement first
(`settlement_line_id` null, with `settlement_id` and `channel_id`, appended columns). The template applies the pack's
per-line rule itself: the Σ sums only the lines that count (short ≥ max(`line_short_minor_gte`, ⌈expected ×
`line_short_bp_gte` ÷ 10,000⌉), core-api reconcileSettlement's rule), and expected net starts from the matched order's
total — so overpaid or rounding-level lines never net a short payout down, and the impact is what a dispute claims.

Fires on a settlement's Σ row when `short_minor` ≥ the pack's `short_minor_gte` (IN ₹200, AU A$5). Severity L on the
settlement's Σ (the pack's "monthly Σ" spans settlements, which one row cannot see). Dedupe
`<outlet>:<settlement>` (pack `<settlement>`, per outlet — T-040 note a).
Draft: `finance.dispute.draft.v1`, basis `short_payout`, no lines (the lines sit in other rows), total ← `short_minor`.
"""

from __future__ import annotations

from munim_intel.detect import DetectorSpec, Ladder, OutletFrame, Row, Severity, Thresholds, Window, num, register
from munim_intel.mapping import Detection, Proposal
from munim_intel.watch.detectors.finance.periods import month_end, month_starts

#: The months a run looks at, as finance.unapproved_ad_fee: the current business month and the two before it.
MONTHS_BACK = 3


def windows(outlet: OutletFrame, _: Thresholds) -> list[Window]:
    return [
        Window({"channel_id": None, "from": m.isoformat(), "to": month_end(m).isoformat(), "outlet_id": outlet.id}, m.isoformat()[:7])
        for m in month_starts(outlet.business_date, MONTHS_BACK)
    ]


def fires(row: Row, t: Thresholds) -> bool:
    short = num(row, "short_minor")
    return (
        row.get("settlement_line_id") is None
        and isinstance(row.get("settlement_id"), str)
        and isinstance(row.get("channel_id"), str)
        and short is not None
        and short >= t["short_minor_gte"]
    )


def severity(row: Row, _: Thresholds, ladder: Ladder) -> Severity:
    return ladder.of(num(row, "short_minor") or 0)


def dedupe(row: Row, w: Window) -> str:
    return f"{w.params['outlet_id']}:{row['settlement_id']}"


def dispute(d: Detection) -> Proposal:
    channel = str(d.row["channel_id"])  # `fires` admits only Σ rows whose channel_id is a uuid string
    total = d.ref("short_minor")
    return Proposal(
        command_type="finance.dispute.draft.v1",
        payload={
            "channel_id": channel,
            "basis": "short_payout",
            "lines": [],
            "total_claimed_minor": total,
            "currency": d.currency,
            "break_ids": [],
        },
        based_on=[total],
        targets=[channel, str(d.row["settlement_id"])],
        minted=["dispute_id"],
    )


SPEC = register(
    DetectorSpec(
        id="finance.short_payout",
        pack="finance",
        template="finance.settlement_vs_orders",
        finding_type="reconciliation_break.short_payout",
        impact_column="short_minor",
        windows=windows,
        fires=fires,
        severity=severity,
        dedupe=dedupe,
        narration=(
            "This payout paid less than the orders it settles should have: {short_minor} short. "
            "It paid {net_minor} where the contracted commission and recorded refunds leave {expected_net_minor}."
        ),
        mapping=dispute,
    )
)
