"""`inventory.waste_spike` (packs/inventory-purchasing.md §4, §5; plant I6; answer keys CK-I6, CK-K7, ST-K7, AU-K7, and the
`also` of RG-A1 and RG-C2).

Template `inventory.waste_week` per outlet and ISO week (`week_start` = its Monday): an ingredient's waste value that week
against the median of the 8 weeks before. Fires when `waste_minor` ≥ 1.5 × `median_minor` (the pack's
`waste_vs_median_bp_gte`, 15,000 bp) and `excess_minor` ≥ `excess_minor_gte` (₹1,500 / A$30). Severity L on the monthly
equivalent 4.3 × `excess_minor`. Dedupe `<outlet>:<ingredient>:<iso_week>`.

A run looks at the outlet's current ISO week and the WEEKS_BACK − 1 before it, so a spike recorded late (dated waste logs
imported after the fact) is still reported once. No draft: pack §6 maps none to this finding.
"""

from __future__ import annotations

from datetime import timedelta

from munim_intel.detect import DetectorSpec, Ladder, OutletFrame, Row, Severity, Thresholds, Window, num, register

#: INFERENCE (the pack gives no lookback): six ISO weeks, about the 40 days back the gate profile's oldest waste plant sits.
WEEKS_BACK = 6


def windows(outlet: OutletFrame, _t: Thresholds) -> list[Window]:
    monday = outlet.business_date - timedelta(days=outlet.business_date.weekday())
    out = []
    for k in range(WEEKS_BACK):
        start = monday - timedelta(weeks=k)
        year, week, _ = start.isocalendar()
        out.append(Window({"outlet_id": outlet.id, "week_start": start.isoformat()}, f"{year}-w{week:02d}"))
    return out


def fires(row: Row, t: Thresholds) -> bool:
    waste, median, excess = num(row, "waste_minor"), num(row, "median_minor"), num(row, "excess_minor")
    if not isinstance(row.get("ingredient_id"), str) or waste is None or median is None or excess is None:
        return False
    return waste * 10_000 >= t["waste_vs_median_bp_gte"] * median and excess >= t["excess_minor_gte"]


def severity(row: Row, _: Thresholds, ladder: Ladder) -> Severity:
    return ladder.of((num(row, "excess_minor") or 0) * 43 // 10)


def dedupe(row: Row, w: Window) -> str:
    return f"{w.params['outlet_id']}:{row['ingredient_id']}:{w.key}"


SPEC = register(
    DetectorSpec(
        id="inventory.waste_spike",
        thresholds=("excess_minor_gte", "waste_vs_median_bp_gte"),
        pack="inventory_purchasing",
        template="inventory.waste_week",
        finding_type="inventory.waste_spike",
        impact_column="excess_minor",
        windows=windows,
        fires=fires,
        severity=severity,
        dedupe=dedupe,
        narration=(
            # No "this week": a run reports any of the last WEEKS_BACK weeks, and no cell names the week.
            "Waste of this ingredient spiked in a recent week: {waste_minor} written off against a usual week of {median_minor}, "
            "{excess_minor} more than usual."
        ),
    )
)
