"""`catalogue.negative_margin` (packs/catalogue.md §4, §5, §6). No answer-key plant (detector-map.json).

Template `catalogue.dish_margin` over the pack's `window_days` (14) ending on the business date, every channel. Fires
when `margin_minor` < `margin_minor_lt` (0) on ≥ `units_sold_gte` (20) units; an item whose margin is unknown (no
recipe, or a recipe line without a price: the template leaves the margin null) never fires — that is the ask path's
`recipe_missing` / `cost_price_missing` refusal, not a finding. Severity L on `loss_minor` × 30 ÷ window (a month),
at least `high` when the item ranks ≤ `high_units_rank_lte` (10) by units. Dedupe `<outlet>:<item>:<iso_week>`.
Draft: `catalogue.price.set.v1`, amount ← `suggested_price_minor` (drafts.price_set; it needs the dish_margin
`channel_kind` and `tax_class` cells requested from the migrator, and proposes nothing until they exist).
"""

from __future__ import annotations

from munim_intel.detect import DetectorSpec, Ladder, OutletFrame, Row, Severity, Thresholds, Window, at_least, num, register
from munim_intel.mapping import Detection, Proposal
from munim_intel.watch.detectors.catalogue.drafts import price_set
from munim_intel.watch.detectors.catalogue.windows import rolling

DAYS_IN_MONTH = 30


def windows(outlet: OutletFrame, t: Thresholds) -> list[Window]:
    return [rolling(outlet, t["window_days"], channel_kind=None)]


def fires(row: Row, t: Thresholds) -> bool:
    margin, units = num(row, "margin_minor"), num(row, "units_sold")
    return (
        isinstance(row.get("item_id"), str)
        and margin is not None
        and units is not None
        and margin < t["margin_minor_lt"]
        and units >= t["units_sold_gte"]
    )


def severity(row: Row, t: Thresholds, ladder: Ladder) -> Severity:
    s = ladder.of((num(row, "loss_minor") or 0) * DAYS_IN_MONTH // t["window_days"])
    rank = num(row, "units_rank")
    return at_least(s, "high") if rank is not None and rank <= t["high_units_rank_lte"] else s


def dedupe(row: Row, w: Window) -> str:
    return f"{w.params['outlet_id']}:{row['item_id']}:{w.key}"


def draft(d: Detection) -> Proposal | None:
    return price_set(d, also=[d.ref("loss_minor")])


SPEC = register(
    DetectorSpec(
        id="catalogue.negative_margin",
        thresholds=("high_units_rank_lte", "margin_minor_lt", "units_sold_gte", "window_days"),
        pack="catalogue",
        template="catalogue.dish_margin",
        finding_type="catalogue.negative_margin",
        impact_column="loss_minor",
        windows=windows,
        fires=fires,
        severity=severity,
        dedupe=dedupe,
        narration=(
            "This dish sells below its true cost: {units_sold} units over the window brought in {net_sales_minor} "
            "and lost {loss_minor} once today's supplier prices and waste are counted."
        ),
        outlet_kinds=frozenset({"restaurant", "cloud_kitchen"}),
        mapping=draft,
    )
)
