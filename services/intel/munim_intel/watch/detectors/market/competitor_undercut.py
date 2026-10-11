"""`market.competitor_undercut` (packs/market-strategy.md §4, §5; case M2 has no plant — the market_signal importer
quarantines kind `competitor_price`, detector-map.json — so this is gated on fixtures).

Template `market.competitor_gap` with `days` = the pack's `window_days` (30). Fires when `gap_bp` ≥ `gap_bp_gte`
(1,000: we are at least 10% dearer), `units_rank` ≤ `units_rank_lte` (20) and `observations` ≥ `observations_gte` (2).
Severity `low`; `medium` when `units_change_bp` ≤ `medium_units_change_bp_lte` (−1,500: our sales of it are falling).
Dedupe `<outlet>:<item>:<month>`. No draft: a competitor gap is a prompt to review price, never a price draft (pack §2).
"""

from __future__ import annotations

from munim_intel.detect import DetectorSpec, Ladder, OutletFrame, Row, Severity, Thresholds, Window, num, register


def windows(outlet: OutletFrame, t: Thresholds) -> list[Window]:
    return [
        Window(
            {"outlet_id": outlet.id, "days": t["window_days"], "as_of": outlet.business_date.isoformat()},
            outlet.business_date.isoformat()[:7],
        )
    ]


def fires(row: Row, t: Thresholds) -> bool:
    gap, rank, seen = num(row, "gap_bp"), num(row, "units_rank"), num(row, "observations")
    return (
        isinstance(row.get("item_id"), str)
        and num(row, "gap_exposure_minor") is not None
        and gap is not None
        and rank is not None
        and seen is not None
        and gap >= t["gap_bp_gte"]
        and rank <= t["units_rank_lte"]
        and seen >= t["observations_gte"]
    )


def severity(row: Row, t: Thresholds, _: Ladder) -> Severity:
    change = num(row, "units_change_bp")
    return "medium" if change is not None and change <= t["medium_units_change_bp_lte"] else "low"


def dedupe(row: Row, w: Window) -> str:
    return f"{w.params['outlet_id']}:{row['item_id']}:{w.key}"


SPEC = register(
    DetectorSpec(
        id="market.competitor_undercut",
        thresholds=("gap_bp_gte", "medium_units_change_bp_lte", "observations_gte", "units_rank_lte", "window_days"),
        pack="market",
        template="market.competitor_gap",
        finding_type="market.competitor_undercut",
        impact_column="gap_exposure_minor",
        windows=windows,
        fires=fires,
        severity=severity,
        dedupe=dedupe,
        narration=(
            "A nearby competitor was seen selling this item for {competitor_price_minor} against our {our_price_minor} "
            "on {observations} occasions; at this month's sales the gap is worth {gap_exposure_minor}."
        ),
    )
)
