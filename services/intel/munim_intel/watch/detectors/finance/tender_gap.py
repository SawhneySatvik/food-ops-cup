"""`finance.tender_gap` (packs/finance.md §4, §5; plant F5; answer key RG-F5). No draft (pack §6 maps none).

Template `finance.tender_vs_bank` **version 2** (migration 0023 F3), minted per outlet and method (UPI and card: the
counter money a bank statement credits, pack §1; cash reaches the bank as deposits, not per-day credits) over the
current ISO week and the five before it.
Version 2 puts one Σ row per ISO week first (`business_on` null, `week_start`, `gap_days`): the sums over the week's gap
days — days the statement reaches whose gap is at least the pack's `gap_minor_gte` (₹500, A$10), read by the template
from the same pack. A week with no credit the statement reaches has no Σ row, so a missing statement is never a gap
(pack §7 `bank_lines_missing`).

Fires on a week's Σ row with `gap_days` ≥ the pack's `gap_days_gte` (3 of the ISO week's 7 days). Impact: the week's Σ
`gap_minor` (RG-F5's key is the three weekly sums). Severity L on it; `critical` when the gap days share one
`shift_member_id` and their voids reach the pack's `critical_voids_vs_median_bp_gte` (2×) of the Σ row's
`outlet_median_voids` — which 0023 already states as the per-day median × `gap_days`, so Σ voids × 10,000 ≥ bp × that
cell compares a week's gap days with as many median days (multiplying by `gap_days` again would count the days twice).
The critical clause needs a median above 0 and at least one void (R-B S2-B): against a median of 0 any count, even 0,
is "twice the median", which would make every one-cashier week critical.
Dedupe `<outlet>:<method>:<iso_week>`. Names shifts, never motives.
"""

from __future__ import annotations

from datetime import date, timedelta

from munim_intel.detect import DetectorSpec, Ladder, OutletFrame, Row, Severity, Thresholds, Window, num, register
from munim_intel.watch.detectors.finance.periods import iso_week

#: The current ISO week and the five before it.
WEEKS_BACK = 6
METHODS = ("upi", "card")


def windows(outlet: OutletFrame, _: Thresholds) -> list[Window]:
    day = outlet.business_date
    first = day - timedelta(days=day.weekday() + 7 * (WEEKS_BACK - 1))
    return [Window({"outlet_id": outlet.id, "method": m, "from": first.isoformat(), "to": day.isoformat()}, m) for m in METHODS]


def week_of(row: Row) -> date | None:
    """The Σ row's week (day rows carry business_on instead); a cell that is not an ISO date is no week."""
    try:
        return date.fromisoformat(str(row["week_start"])) if isinstance(row.get("week_start"), str) else None
    except ValueError:
        return None


def fires(row: Row, t: Thresholds) -> bool:
    days = num(row, "gap_days")
    return week_of(row) is not None and days is not None and days >= t["gap_days_gte"]


def severity(row: Row, t: Thresholds, ladder: Ladder) -> Severity:
    voids, median = num(row, "voids"), num(row, "outlet_median_voids")
    if (
        isinstance(row.get("shift_member_id"), str)
        and voids is not None
        and median is not None
        and median > 0
        and voids > 0
        and voids * 10_000 >= t["critical_voids_vs_median_bp_gte"] * median
    ):
        return "critical"
    return ladder.of(num(row, "gap_minor") or 0)


def dedupe(row: Row, w: Window) -> str:
    week = week_of(row)  # `fires` admits only rows with a week
    return f"{w.params['outlet_id']}:{w.key}:{iso_week(week) if week is not None else 'none'}"


SPEC = register(
    DetectorSpec(
        id="finance.tender_gap",
        thresholds=("critical_voids_vs_median_bp_gte", "gap_days_gte"),
        pack="finance",
        template="finance.tender_vs_bank",
        finding_type="cash_control.tender_gap",
        impact_column="gap_minor",
        windows=windows,
        fires=fires,
        severity=severity,
        dedupe=dedupe,
        narration=(
            "Counter payments recorded in the week of {week_start} were not all credited by the bank: {gap_minor} missing over "
            "{gap_days} days, {tendered_minor} recorded against {credited_minor} credited, with {voids} voided bills on those days."
        ),
    )
)
