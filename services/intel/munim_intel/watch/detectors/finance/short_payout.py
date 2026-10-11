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
Draft (pack §6): `finance.dispute.draft.v1`, basis `short_payout`, total ← the Σ row's `short_minor`, and one line per
settlement line the Σ counted, `{settlement_line_id, claimed_minor ← that line's short_minor}` (R-B S1-C), so core's
open-dispute check holds each line once. The mapping re-applies the template's line rule (`line_short_minor_gte`,
`line_short_bp_gte`, pack §4) to the settlement's line rows and drafts only when those lines' cells add up to the Σ
cell exactly — core refuses lines that do not sum to the total, and a mismatch means the rule here and the template's
differ, so no draft is better than one that fails at approval.
"""

from __future__ import annotations

from munim_intel.detect import DetectorSpec, Ladder, OutletFrame, Row, Severity, Thresholds, Window, num, register
from munim_intel.mapping import Detection, Proposal, snap_ref
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


def counts(row: Row, t: Thresholds) -> bool:
    """The template's line rule (0023 F1 / 0024 F5): short > 0 and short ≥ max(line minimum, ⌈expected × bp ÷ 10,000⌉)."""
    short, expected = num(row, "short_minor"), num(row, "expected_net_minor")
    if short is None or expected is None:
        return False
    return short > 0 and short >= max(t["line_short_minor_gte"], -(-expected * t["line_short_bp_gte"] // 10_000))


def dispute(d: Detection) -> Proposal | None:
    channel = str(d.row["channel_id"])  # `fires` admits only Σ rows whose channel_id is a uuid string
    settlement = str(d.row["settlement_id"])
    picked = [
        (i, r)
        for i, r in enumerate(d.rows)
        if r.get("settlement_id") == settlement and isinstance(r.get("settlement_line_id"), str) and counts(r, d.thresholds)
    ]
    if not picked or sum(num(r, "short_minor") or 0 for _, r in picked) != num(d.row, "short_minor"):
        return None
    lines = [
        {"settlement_line_id": r["settlement_line_id"], "order_id": None, "claimed_minor": snap_ref(d.snapshot_id, i, "short_minor")}
        for i, r in picked
    ]
    total = d.ref("short_minor")
    return Proposal(
        command_type="finance.dispute.draft.v1",
        payload={
            "channel_id": channel,
            "basis": "short_payout",
            "lines": lines,
            "total_claimed_minor": total,
            "currency": d.currency,
            "break_ids": [],
        },
        based_on=[total, *(str(x["claimed_minor"]) for x in lines)],
        targets=[channel, settlement],
        minted=["dispute_id"],
    )


SPEC = register(
    DetectorSpec(
        id="finance.short_payout",
        thresholds=("line_short_bp_gte", "line_short_minor_gte", "short_minor_gte"),
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
