"""`market.goal_off_track` (packs/market-strategy.md §4, §5; case M3 has no plant — goal pace reads orders up to the
real date, detector-map.json — so this is gated on fixtures).

Template `market.goal_progress`, one row per goal (param `goal_id`). Fires when `pace_bp` < `pace_bp_lt` (7,000) with
`elapsed_bp` ≥ `elapsed_bp_gte` (5,000). Severity `medium`; `high` when `elapsed_bp` ≥ `high_elapsed_bp_gte` (8,000).
Impact `projected_miss_value` (minor units for a `net_sales` goal, an order count otherwise). Dedupe
`<goal>:<iso_week>`.

Enumeration: `DRIVER` lists the outlet's own active goals (`market.goals(outlet_id)`, migration 0022), one window per
goal. A tenant-wide goal (no outlet) is listed under no outlet and so is not watched (INFERENCE, reported).
"""

from __future__ import annotations

from collections.abc import Iterable
from datetime import date

from munim_intel.detect import DetectorSpec, Driver, Ladder, OutletFrame, Row, Severity, Thresholds, Window, num, register


def windows_for(goal_ids: Iterable[str], today: date) -> list[Window]:
    year, week, _ = today.isocalendar()
    return [Window({"goal_id": g, "as_of": today.isoformat()}, f"{g}:{year}-w{week:02d}") for g in goal_ids]


def windows(_outlet: OutletFrame, _t: Thresholds) -> list[Window]:
    return []


DRIVER = Driver("market.goals", lambda o, _t: {"outlet_id": o.id}, "goal_id", lambda g, o, _t: windows_for([g], o.business_date)[0])


def fires(row: Row, t: Thresholds) -> bool:
    pace, elapsed = num(row, "pace_bp"), num(row, "elapsed_bp")
    return (
        num(row, "projected_miss_value") is not None
        and pace is not None
        and elapsed is not None
        and pace < t["pace_bp_lt"]
        and elapsed >= t["elapsed_bp_gte"]
    )


def severity(row: Row, t: Thresholds, _: Ladder) -> Severity:
    return "high" if (num(row, "elapsed_bp") or 0) >= t["high_elapsed_bp_gte"] else "medium"


def dedupe(_row: Row, w: Window) -> str:
    return w.key


SPEC = DetectorSpec(
    id="market.goal_off_track",
    thresholds=("elapsed_bp_gte", "high_elapsed_bp_gte", "pace_bp_lt"),
    pack="market",
    template="market.goal_progress",
    finding_type="market.goal_off_track",
    impact_column="projected_miss_value",
    windows=windows,
    fires=fires,
    severity=severity,
    dedupe=dedupe,
    narration=(
        "This goal is behind pace: {actual_value} so far against a target of {target_value}, with {elapsed_bp} "
        "of its time gone; at this pace it ends {projected_miss_value} short."
    ),
    driver=DRIVER,
)

register(SPEC)
