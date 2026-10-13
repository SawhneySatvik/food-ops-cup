"""`catalogue.recipe_waste_gap` (packs/catalogue.md §4, §5, §6, §10; plant C2 → RG-C2).

Template `catalogue.dish_margin` over the pack's `window_days` (14) ending on the business date — the window the
pack gives `negative_margin` on the same template. Fires when the item has a recipe (`recipe_version_id`: a shop SKU
has none, so there is no recipe allowance to be wrong), `observed_waste_bp` ≥ `recipe_waste_bp` + `waste_gap_bp_gte`
(300) and `units_sold` ≥ `units_sold_gte` (20). Severity L on `excess_waste_minor`. Dedupe `<outlet>:<item>:<iso_week>`.

Measured against the gate worlds (T-044 report): RG-C2 lies 13–26 days back, outside any 14-day window ending on the
as-of date, and baseline waste lifts other dishes past the gap — both are pack/plant mismatches for the orchestrator,
not window choices made here. The C2 recipe draft takes its lines from a follow-up `catalogue.recipe_current` mint
(drafts.recipe_draft).
"""

from __future__ import annotations

from munim_intel.detect import DetectorSpec, Ladder, OutletFrame, Row, Severity, Thresholds, Window, num, register
from munim_intel.watch.detectors.catalogue.drafts import FOLLOW_RECIPE, recipe_draft
from munim_intel.watch.detectors.catalogue.windows import rolling


def windows(outlet: OutletFrame, t: Thresholds) -> list[Window]:
    return [rolling(outlet, t["window_days"], channel_kind=None)]


def fires(row: Row, t: Thresholds) -> bool:
    observed, recipe, units = num(row, "observed_waste_bp"), num(row, "recipe_waste_bp"), num(row, "units_sold")
    return (
        isinstance(row.get("item_id"), str)
        and isinstance(row.get("recipe_version_id"), str)
        and observed is not None
        and recipe is not None
        and units is not None
        and observed >= recipe + t["waste_gap_bp_gte"]
        and units >= t["units_sold_gte"]
    )


def severity(row: Row, _: Thresholds, ladder: Ladder) -> Severity:
    return ladder.of(num(row, "excess_waste_minor") or 0)


def dedupe(row: Row, w: Window) -> str:
    return f"{w.params['outlet_id']}:{row['item_id']}:{w.key}"


SPEC = register(
    DetectorSpec(
        id="catalogue.recipe_waste_gap",
        thresholds=("units_sold_gte", "waste_gap_bp_gte", "window_days"),
        pack="catalogue",
        template="catalogue.dish_margin",
        finding_type="catalogue.recipe_waste_gap",
        impact_column="excess_waste_minor",
        windows=windows,
        fires=fires,
        severity=severity,
        dedupe=dedupe,
        narration=(
            "Waste on this dish's ingredients ran at {observed_waste_bp} against the recipe's allowance of "
            "{recipe_waste_bp}: over {units_sold} units sold the extra waste cost {excess_waste_minor}."
        ),
        outlet_kinds=frozenset({"restaurant", "cloud_kitchen"}),
        mapping=recipe_draft,
        follow_ups=(FOLLOW_RECIPE,),
    )
)
