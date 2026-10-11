"""`catalogue.deal_loss` (packs/catalogue.md §4, §5, §6; plant C3 is history-only — RG-C3 carries no deal-tagged order,
detector-map.json — so this is gated on fixtures).

Template `catalogue.deal_cost` over the pack's `window_days` (14) ending on the business date, one row per deal the
outlet's completed orders were priced under. Fires when `deal_loss_minor` > `deal_loss_minor_gt` (0) on ≥ `orders_gte`
(30) orders; a deal with an unpriced recipe line has a null loss and never fires. Severity L on the loss. Dedupe
`<outlet>:<deal>:<iso_week>` (pack `<deal_id>:<iso_week>`, per outlet as T-043 note a files every finding).
Draft: `catalogue.deal.end.v1`, ending the deal tomorrow.
"""

from __future__ import annotations

from munim_intel.detect import DetectorSpec, Ladder, OutletFrame, Row, Severity, Thresholds, Window, num, register
from munim_intel.watch.detectors.catalogue.drafts import deal_end
from munim_intel.watch.detectors.catalogue.windows import rolling


def windows(outlet: OutletFrame, t: Thresholds) -> list[Window]:
    return [rolling(outlet, t["window_days"])]


def fires(row: Row, t: Thresholds) -> bool:
    loss, orders = num(row, "deal_loss_minor"), num(row, "orders")
    return (
        isinstance(row.get("deal_id"), str)
        and loss is not None
        and orders is not None
        and loss > t["deal_loss_minor_gt"]
        and orders >= t["orders_gte"]
    )


def severity(row: Row, _: Thresholds, ladder: Ladder) -> Severity:
    return ladder.of(num(row, "deal_loss_minor") or 0)


def dedupe(row: Row, w: Window) -> str:
    return f"{w.params['outlet_id']}:{row['deal_id']}:{w.key}"


SPEC = register(
    DetectorSpec(
        id="catalogue.deal_loss",
        thresholds=("deal_loss_minor_gt", "orders_gte", "window_days"),
        pack="catalogue",
        template="catalogue.deal_cost",
        finding_type="catalogue.deal_loss",
        impact_column="deal_loss_minor",
        windows=windows,
        fires=fires,
        severity=severity,
        dedupe=dedupe,
        narration=(
            "This deal sells below cost: across {orders} orders it gave away {discount_minor} and lost {deal_loss_minor} "
            "once the food's cost is counted."
        ),
        mapping=deal_end,
    )
)
