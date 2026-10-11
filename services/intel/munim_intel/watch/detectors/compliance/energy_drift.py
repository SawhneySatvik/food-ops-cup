"""`compliance.energy_drift` (packs/compliance-assets.md §4, §5; plant A4, not plantable on the 100-day profile per
detector-map.json; the offline fixture gates it).

Template `compliance.energy_per_order` for one outlet: utility expense per completed order for this month and last
month, each against the median of the 3 months before it. The template reads today itself, as the outlet's business
date. The detector fires when `per_order_minor` ≥ `per_order_vs_median_bp_gte` (13,000) ÷ 10,000 ×
`median_per_order_minor`, compared in integers.

It needs a baseline above zero and an excess above zero. Without them an outlet with no utility expense would pass as
0 ≥ 0 every month: every gate world records none. Severity is L on `energy_excess_minor`. Dedupe `<outlet>:<month>`.
No draft (pack §6 maps none).
"""

from __future__ import annotations

from munim_intel.detect import DetectorSpec, Ladder, OutletFrame, Row, Severity, Thresholds, Window, num, register

MONTHS = 2


def windows(outlet: OutletFrame, _: Thresholds) -> list[Window]:
    return [Window({"outlet_id": outlet.id, "months": MONTHS, "as_of": outlet.business_date.isoformat()}, outlet.id)]


def fires(row: Row, t: Thresholds) -> bool:
    per, median, excess = num(row, "per_order_minor"), num(row, "median_per_order_minor"), num(row, "energy_excess_minor")
    if not isinstance(row.get("month_on"), str) or per is None or median is None or excess is None:
        return False
    return median > 0 and excess > 0 and per * 10_000 >= t["per_order_vs_median_bp_gte"] * median


def severity(row: Row, _: Thresholds, ladder: Ladder) -> Severity:
    return ladder.of(num(row, "energy_excess_minor") or 0)


def dedupe(row: Row, w: Window) -> str:
    return f"{w.params['outlet_id']}:{str(row['month_on'])[:7]}"


SPEC = register(
    DetectorSpec(
        id="compliance.energy_drift",
        thresholds=("per_order_vs_median_bp_gte",),
        pack="compliance",
        template="compliance.energy_per_order",
        finding_type="compliance.energy_drift",
        impact_column="energy_excess_minor",
        windows=windows,
        fires=fires,
        severity=severity,
        dedupe=dedupe,
        narration=(
            "Utility cost per order in the month of {month_on} is {per_order_minor} against a usual {median_per_order_minor} over "
            "{orders} orders: {energy_excess_minor} above the usual level. This is a drift signal, not an equipment diagnosis."
        ),
    )
)
