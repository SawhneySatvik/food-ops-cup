"""The ISO weeks a kitchen detector mints: the outlet's current business week and the ones before it."""

from __future__ import annotations

from datetime import timedelta

from munim_intel.detect import OutletFrame, OutletKind, Window

#: Restaurants and cloud kitchens; a shop has no kitchen (packs/kitchen.md §1).
KITCHENS: frozenset[OutletKind] = frozenset({"restaurant", "cloud_kitchen"})

#: Eight weeks back: the over-prep median's own window, so a re-sweep re-judges every week a median covers. Findings
#: dedupe per ISO week, so looking back costs mints, never duplicate findings.
WEEKS_BACK = 8


def week_windows(outlet: OutletFrame) -> list[Window]:
    """`{outlet_id, week_start}` per ISO week (Monday, outlet-local business dates), keyed `yyyy-www` (dedupe keys are
    lower-case)."""
    monday = outlet.business_date - timedelta(days=outlet.business_date.weekday())
    out = []
    for k in range(WEEKS_BACK):
        start = monday - timedelta(weeks=k)
        y, w, _ = start.isocalendar()
        out.append(Window({"outlet_id": outlet.id, "week_start": start.isoformat()}, f"{y}-w{w:02d}"))
    return out


def monthly(weekly_minor: int) -> int:
    """A week's amount on the ladder's monthly scale (× 4.3, packs/kitchen.md §4)."""
    return weekly_minor * 43 // 10
