"""`people.overtime_drift` (packs/people.md §4, §5; plants P1, trap P7; answer keys RG-P1, AU-P1).

Template `people.overtime_drift` **version 2** (migration 0023 P1) over the last `window_weeks` (4) ISO weeks,
outlet-local, ending today: one Σ row per staff member first (`iso_week` NULL, the member's window totals), then one row
per member and week (attended minutes beyond rostered ones, costed at the overtime multiplier). The rule: the Σ row's
`extra_min` ≥ `extra_min_gte` (600) and the last week's `extra_min` > the first week's — drift, not one long week.
The last week is the current one, so it is partial until Sunday: the comparison is per day (the last week's minutes
over its days so far against the first week's over seven), so a sweep early in the week does not read a short week
as no drift.
Worked-as-rostered long shifts have no extra minutes (P7). The finding sits on the member's last-week row (its dedupe
week and narration), and its impact is the member's Σ `extra_cost_minor` — pack §5's "4-week Σ row", a cell core
minted, never a sum intel adds up. Severity L on that cell. Dedupe `<outlet>:<staff>:<iso_week>`. No draft (pack §6
attaches none: rosters are drafted on request through the skill).
"""

from __future__ import annotations

from collections.abc import Sequence
from datetime import date, timedelta

from munim_intel.detect import DetectorSpec, Hit, Ladder, OutletFrame, Row, Severity, Thresholds, Window, num, register
from munim_intel.watch.detectors.people.weeks import label, monday


def windows(outlet: OutletFrame, t: Thresholds) -> list[Window]:
    start = monday(outlet.business_date) - timedelta(weeks=t["window_weeks"] - 1)
    params = {"outlet_id": outlet.id, "from": start.isoformat(), "to": outlet.business_date.isoformat()}
    return [Window(params, label(outlet.business_date))]


def fires(row: Row, _: Thresholds) -> bool:
    """A week row (the Σ rows carry no `iso_week`)."""
    return isinstance(row.get("staff_id"), str) and isinstance(row.get("iso_week"), str) and num(row, "extra_min") is not None


def severity(row: Row, _: Thresholds, ladder: Ladder) -> Severity:
    """`row` is the member's Σ row: L on the window's `extra_cost_minor`."""
    return ladder.of(num(row, "extra_cost_minor") or 0)


def select(rows: Sequence[Row], w: Window, t: Thresholds, ladder: Ladder) -> list[Hit]:
    today = date.fromisoformat(w.params["to"])
    first, last = label(date.fromisoformat(w.params["from"])), label(today)
    days_so_far = today.weekday() + 1
    sigma: dict[str, int] = {}
    weeks: dict[str, dict[str, int]] = {}
    for i, r in enumerate(rows):
        staff = r.get("staff_id")
        if not isinstance(staff, str):
            continue
        if r.get("iso_week") is None:
            sigma[staff] = i
        elif fires(r, t):
            weeks.setdefault(staff, {})[str(r["iso_week"])] = i
    hits = []
    for staff, s in sigma.items():
        week = weeks.get(staff, {})
        total = num(rows[s], "extra_min")
        extra = {wk: num(rows[i], "extra_min") or 0 for wk, i in week.items()}
        # last ÷ days_so_far > first ÷ 7, in integers.
        if last in week and total is not None and total >= t["extra_min_gte"] and extra[last] * 7 > extra.get(first, 0) * days_so_far:
            hits.append(Hit(week[last], s, severity(rows[s], t, ladder)))
    return sorted(hits, key=lambda h: h.row)


def dedupe(row: Row, w: Window) -> str:
    return f"{w.params['outlet_id']}:{row['staff_id']}:{str(row['iso_week']).lower()}"


SPEC = register(
    DetectorSpec(
        id="people.overtime_drift",
        thresholds=("extra_min_gte", "window_weeks"),
        pack="people",
        template="people.overtime_drift",
        finding_type="people.overtime_drift",
        impact_column="extra_cost_minor",
        windows=windows,
        fires=fires,
        severity=severity,
        dedupe=dedupe,
        narration=(
            "Shifts have run past the roster over the last few weeks and the overrun is growing: in week {iso_week}, {extra_min} minutes "
            "beyond the {rostered_min} rostered; over the whole window the extra time cost {extra_cost_minor} at the overtime rate."
        ),
        select=select,
    )
)
