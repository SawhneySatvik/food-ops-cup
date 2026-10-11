"""`catalogue.cost_drift` (packs/catalogue.md §4, §5, §10; plants C1 → RG-C1, RG-C1b; trap C6 → RG-C6).

Template `catalogue.cost_drift`, `since` = the business date − the pack's `lookback_days`: one row per priced item,
its unit cost when its current price was set (`cost_then_minor`) and now, and `cost_drift_minor` = Σ units sold since
`since` × (that day's unit cost − the cost when the price was set). Days before a cost move add nothing, so any
lookback reaching back past the move gives the same cell. Fires when `cost_change_bp` ≥ `cost_change_bp_gte` (800)
and `cost_now_minor` − `cost_then_minor` ≥ `cost_increase_minor_gte` (IN ₹5, AU A$0.10). A price raised after the
cost moved re-bases `cost_then` on the new cost (RG-C6), so a held margin never fires. Severity L on the drift.

Dedupe `<outlet>:<item>`: the pack's suffix is `<outlet>:<item>:<price_id>`, but the template returns no `price_id`
cell (requested from the migrator), so a re-priced item merges into its open finding for the 7-day merge window.
Draft (C1): `catalogue.price.set.v1` with its amount from a follow-up `catalogue.dish_margin` mint (drafts.price_draft).
"""

from __future__ import annotations

from datetime import timedelta

from munim_intel.detect import DetectorSpec, Ladder, OutletFrame, Row, Severity, Thresholds, Window, num, register
from munim_intel.watch.detectors.catalogue.drafts import FOLLOW_MARGIN, price_draft


def windows(outlet: OutletFrame, t: Thresholds) -> list[Window]:
    since = outlet.business_date - timedelta(days=t["lookback_days"])
    return [Window({"outlet_id": outlet.id, "since": since.isoformat(), "as_of": outlet.business_date.isoformat()}, outlet.id)]


def fires(row: Row, t: Thresholds) -> bool:
    change, then, now = num(row, "cost_change_bp"), num(row, "cost_then_minor"), num(row, "cost_now_minor")
    return (
        isinstance(row.get("item_id"), str)
        and change is not None
        and then is not None
        and now is not None
        and change >= t["cost_change_bp_gte"]
        and now - then >= t["cost_increase_minor_gte"]
    )


def severity(row: Row, _: Thresholds, ladder: Ladder) -> Severity:
    return ladder.of(num(row, "cost_drift_minor") or 0)


def dedupe(row: Row, w: Window) -> str:
    return f"{w.params['outlet_id']}:{row['item_id']}"


SPEC = register(
    DetectorSpec(
        id="catalogue.cost_drift",
        thresholds=("cost_change_bp_gte", "cost_increase_minor_gte", "lookback_days"),
        pack="catalogue",
        template="catalogue.cost_drift",
        finding_type="catalogue.cost_drift",
        impact_column="cost_drift_minor",
        windows=windows,
        fires=fires,
        severity=severity,
        dedupe=dedupe,
        mapping=price_draft,
        follow_ups=(FOLLOW_MARGIN,),
        narration=(
            "This item's unit cost rose from {cost_then_minor} when its price of {price_minor} was set to {cost_now_minor} now; "
            "the price has not moved, so sales since then absorbed {cost_drift_minor} of extra cost."
        ),
    )
)
