"""`kitchen.overprep` (packs/kitchen.md §4, §5; plant K3; answer keys RG-K3, RG-K7, AU-K3).

Template `kitchen.remakes_overprep`, one ISO week per window. Over-prep lives only on the template's Σ row (station
NULL): the week's waste logged as `overprep`, valued at the outlet's last receipt cost, and the median of the eight
weeks before. Fires when `overprep_minor` ≥ `overprep_minor_gte` (IN ₹1,000, AU A$20) and ≥ `overprep_vs_median_bp_gte`
(15,000 bp = 1.5 ×) of the median. Severity L on the week × 4.3. Dedupe `<outlet>:<iso_week>`. No draft (pack §6 maps
none: a prep list is drafted on request through the skill, not from a finding).
"""

from __future__ import annotations

from munim_intel.detect import DetectorSpec, Ladder, OutletFrame, Row, Severity, Thresholds, Window, num, register
from munim_intel.watch.detectors.kitchen.weeks import KITCHENS, monthly, week_windows

#: Waste is written as a stock movement (kind waste); a new one is when a week's over-prep can cross the bar.
MOVEMENT_RECORDED = "munim.inventory.movement.recorded.v1"


def windows(outlet: OutletFrame, _: Thresholds) -> list[Window]:
    return week_windows(outlet)


def fires(row: Row, t: Thresholds) -> bool:
    amount, median = num(row, "overprep_minor"), num(row, "median_overprep_minor")
    if row.get("station") is not None or amount is None or median is None:
        return False  # only the Σ row carries over-prep
    return amount >= t["overprep_minor_gte"] and amount * 10_000 >= t["overprep_vs_median_bp_gte"] * median


def severity(row: Row, _: Thresholds, ladder: Ladder) -> Severity:
    return ladder.of(monthly(num(row, "overprep_minor") or 0))


def dedupe(_: Row, w: Window) -> str:
    return f"{w.params['outlet_id']}:{w.key}"


SPEC = register(
    DetectorSpec(
        id="kitchen.overprep",
        thresholds=("overprep_minor_gte", "overprep_vs_median_bp_gte"),
        pack="kitchen",
        template="kitchen.remakes_overprep",
        finding_type="kitchen.overprep",
        impact_column="overprep_minor",
        windows=windows,
        fires=fires,
        severity=severity,
        dedupe=dedupe,
        narration=(
            "Food prepared and thrown away as over-prep in a week came to {overprep_minor}, "
            "against a usual week of {median_overprep_minor}."
        ),
        watches=frozenset({MOVEMENT_RECORDED}),
        outlet_kinds=KITCHENS,
    )
)
