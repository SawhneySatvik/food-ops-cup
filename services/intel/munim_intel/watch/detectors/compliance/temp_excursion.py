"""`compliance.temp_excursion` (packs/compliance-assets.md §4, §5; plants A1 and A8 (trap); answer keys RG-A1, AU-A1).

Template `compliance.temp_excursions` for one outlet over the last `WINDOW_DAYS` business days. It has one row per asset
and outlet-local day with readings. The detector fires when `out_of_range` ≥ `out_of_range_gte` (2), so a single bad
reading during a delivery stays silent (A8). Severity is `high`, or L on `temp_waste_minor` when L is higher.

The impact column is `temp_waste_minor`, the outlet's temperature waste that day. Pack §5 falls back to `out_of_range`
when there is no waste, but a spec has one impact column: a day with no waste carries a 0 impact cell, and its
`out_of_range` cell is in the narration. Dedupe `<asset>:<date>`. No draft (pack §6 maps none).
"""

from __future__ import annotations

from datetime import timedelta

from munim_intel.detect import DetectorSpec, Ladder, OutletFrame, Row, Severity, Thresholds, Window, at_least, num, register

WINDOW_DAYS = 7


def windows(outlet: OutletFrame, _: Thresholds) -> list[Window]:
    start = outlet.business_date - timedelta(days=WINDOW_DAYS - 1)
    return [Window({"outlet_id": outlet.id, "from": start.isoformat(), "to": outlet.business_date.isoformat()}, outlet.id)]


def fires(row: Row, t: Thresholds) -> bool:
    bad = num(row, "out_of_range")
    return (
        isinstance(row.get("asset_id"), str) and isinstance(row.get("logged_on"), str) and bad is not None and bad >= t["out_of_range_gte"]
    )


def severity(row: Row, _: Thresholds, ladder: Ladder) -> Severity:
    return at_least(ladder.of(num(row, "temp_waste_minor") or 0), "high")


def dedupe(row: Row, _: Window) -> str:
    return f"{row['asset_id']}:{row['logged_on']}"


SPEC = register(
    DetectorSpec(
        id="compliance.temp_excursion",
        thresholds=("out_of_range_gte",),
        pack="compliance",
        template="compliance.temp_excursions",
        finding_type="compliance.temp_excursion",
        impact_column="temp_waste_minor",
        windows=windows,
        fires=fires,
        severity=severity,
        dedupe=dedupe,
        narration=(
            "This asset read outside its safe range {out_of_range} times out of {readings} readings on {logged_on}, peaking at "
            "{max_milli_c}; stock binned for temperature at the outlet that day was worth {temp_waste_minor}."
        ),
    )
)
