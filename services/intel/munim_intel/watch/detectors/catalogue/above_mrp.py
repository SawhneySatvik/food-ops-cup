"""`catalogue.above_mrp` (packs/catalogue.md §4, §5; plant C4; answer key ST-C4). Shops only.

Template `catalogue.sku_price_check`, one row per SKU, over the last 14 business days. The pack's predicate is
"`price_minor` > `mrp_minor`, any amount"; `price_minor` is the price row's own amount (tax-exclusive in the IN pack),
while MRP is tax-inclusive — the template compares the inclusive shelf price and puts the excess on units sold and on
hand in `above_mrp_minor`. So the detector fires on that column: `above_mrp_minor` > `price_over_mrp_minor_gt` (0 in
both packs). Always `critical` (legal exposure). Dedupe `<outlet>:<item>`. No draft: MRP is a ceiling, never a
reason to draft a price upward, and pack §6 maps none to this finding.
"""

from __future__ import annotations

from datetime import timedelta

from munim_intel.detect import DetectorSpec, Ladder, OutletFrame, Row, Severity, Thresholds, Window, num, register

WINDOW_DAYS = 14
MOVEMENT_RECORDED = "munim.inventory.movement.recorded.v1"


def windows(outlet: OutletFrame, _: Thresholds) -> list[Window]:
    start = outlet.business_date - timedelta(days=WINDOW_DAYS - 1)
    return [Window({"outlet_id": outlet.id, "from": start.isoformat(), "to": outlet.business_date.isoformat()}, outlet.id)]


def fires(row: Row, t: Thresholds) -> bool:
    above = num(row, "above_mrp_minor")
    return isinstance(row.get("item_id"), str) and above is not None and above > t["price_over_mrp_minor_gt"]


def severity(_row: Row, _t: Thresholds, _ladder: Ladder) -> Severity:
    return "critical"


def dedupe(row: Row, w: Window) -> str:
    return f"{w.params['outlet_id']}:{row['item_id']}"


SPEC = register(
    DetectorSpec(
        id="catalogue.above_mrp",
        thresholds=("price_over_mrp_minor_gt",),
        pack="catalogue",
        template="catalogue.sku_price_check",
        finding_type="catalogue.above_mrp",
        impact_column="above_mrp_minor",
        windows=windows,
        fires=fires,
        severity=severity,
        dedupe=dedupe,
        narration=(
            # price_minor is left out: it is tax-exclusive in the IN pack, so it would read as below the MRP it exceeds.
            "This item's shelf price is above its printed MRP of {mrp_minor}: "
            "{above_mrp_minor} is charged or at risk above MRP on units sold and on hand."
        ),
        # A new batch arriving (its printed MRP) is when a shelf price can start to exceed it.
        watches=frozenset({MOVEMENT_RECORDED}),
        outlet_kinds=frozenset({"store"}),
    )
)
