"""`customers.rating_drop` (packs/customers-growth.md §4, §5).

Template `customers.review_trend`, one row per ISO week with reviews at one outlet. The detector fires when `reviews` ≥
`reviews_gte` (10) and `avg_rating_x100` ≤ `mean_8w_x100` − `rating_drop_x100_gte` (50, i.e. half a star). Severity is
`medium`, or `high` when late kitchen tickets that week rose by `high_late_change_bp_gte` (2,500 bp) or more. That
rise is only a co-occurrence, shown through its own cell; the pack links reviews to kitchen findings only through
cited rows.

It reads last week and this week, and the dedupe key `<outlet>:<iso_week>` comes from the row's own week. The worlds
plant no reviews, so the offline fixture gates this detector. No draft (pack §6 maps none).
"""

from __future__ import annotations

from datetime import timedelta

from munim_intel.detect import DetectorSpec, Ladder, OutletFrame, Row, Severity, Thresholds, Window, num, register


def windows(outlet: OutletFrame, _: Thresholds) -> list[Window]:
    last_monday = outlet.business_date - timedelta(days=outlet.business_date.weekday() + 7)
    return [Window({"outlet_id": outlet.id, "from": last_monday.isoformat(), "to": outlet.business_date.isoformat()}, outlet.id)]


def fires(row: Row, t: Thresholds) -> bool:
    reviews, avg, mean = num(row, "reviews"), num(row, "avg_rating_x100"), num(row, "mean_8w_x100")
    if not isinstance(row.get("iso_week"), str) or reviews is None or avg is None or mean is None:
        return False
    return reviews >= t["reviews_gte"] and avg <= mean - t["rating_drop_x100_gte"]


def severity(row: Row, t: Thresholds, _: Ladder) -> Severity:
    late = num(row, "late_change_bp")
    return "high" if late is not None and late >= t["high_late_change_bp_gte"] else "medium"


def dedupe(row: Row, w: Window) -> str:
    return f"{w.params['outlet_id']}:{str(row['iso_week']).lower()}"


SPEC = register(
    DetectorSpec(
        id="customers.rating_drop",
        thresholds=("high_late_change_bp_gte", "rating_drop_x100_gte", "reviews_gte"),
        pack="customers",
        template="customers.review_trend",
        finding_type="customers.rating_drop",
        impact_column="avg_rating_x100",
        windows=windows,
        fires=fires,
        severity=severity,
        dedupe=dedupe,
        narration=(
            "The {reviews} reviews of week {iso_week} average {avg_rating_x100} against {mean_8w_x100} over the weeks before; "
            "late kitchen tickets that week moved by {late_change_bp} against their usual level."
        ),
    )
)
