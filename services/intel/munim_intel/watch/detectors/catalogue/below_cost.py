"""`catalogue.below_cost` (packs/catalogue.md §4, §5). Shops only; no answer-key plant (detector-map.json).

Template `catalogue.sku_price_check` over the pack's `window_days` (14) ending on the business date, one row per SKU.
Fires when `below_cost_minor` (landed cost of the units sold − what they sold for, when positive) > `below_cost_minor_gt`
(0). Severity L on it. Dedupe `<outlet>:<item>`. No draft: pack §6 maps none to it (a price rise on a shop SKU is
bounded by MRP, which the owner decides).
"""

from __future__ import annotations

from munim_intel.detect import DetectorSpec, Ladder, OutletFrame, Row, Severity, Thresholds, Window, num, register
from munim_intel.watch.detectors.catalogue.windows import rolling


def windows(outlet: OutletFrame, t: Thresholds) -> list[Window]:
    w = rolling(outlet, t["window_days"])
    return [Window(w.params, outlet.id)]


def fires(row: Row, t: Thresholds) -> bool:
    below = num(row, "below_cost_minor")
    return isinstance(row.get("item_id"), str) and below is not None and below > t["below_cost_minor_gt"]


def severity(row: Row, _: Thresholds, ladder: Ladder) -> Severity:
    return ladder.of(num(row, "below_cost_minor") or 0)


def dedupe(row: Row, w: Window) -> str:
    return f"{w.params['outlet_id']}:{row['item_id']}"


SPEC = register(
    DetectorSpec(
        id="catalogue.below_cost",
        thresholds=("below_cost_minor_gt", "window_days"),
        pack="catalogue",
        template="catalogue.sku_price_check",
        finding_type="catalogue.below_cost",
        impact_column="below_cost_minor",
        windows=windows,
        fires=fires,
        severity=severity,
        dedupe=dedupe,
        narration="This item sells for less than it cost to land: {below_cost_minor} lost on {units} units sold over the window.",
        outlet_kinds=frozenset({"store"}),
    )
)
