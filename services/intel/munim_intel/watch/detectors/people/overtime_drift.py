"""`people.overtime_drift` (packs/people.md §4, §5; plants P1, trap P7; answer keys RG-P1, AU-P1).

Template `people.overtime_drift` over the last `window_weeks` (4) ISO weeks, outlet-local, ending today: one row per
staff member and week (attended minutes beyond rostered ones, costed at the overtime multiplier). The rule spans a
member's rows: Σ `extra_min` ≥ `extra_min_gte` (600) and the last week's `extra_min` > the first week's — drift, not
one long week. Worked-as-rostered long shifts have no extra minutes (P7). The finding sits on the member's last-week
row, and its impact is that row's `extra_cost_minor`: the template has no per-member 4-week Σ row (pack §5 names one;
requested from the migrator), and intel never adds cells up into a number it shows. Severity L on the four weeks'
`extra_cost_minor` (a band, not a shown number). Dedupe `<outlet>:<staff>:<iso_week>`. No draft (pack §6 attaches none:
rosters are drafted on request through the skill).
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
    return isinstance(row.get("staff_id"), str) and isinstance(row.get("iso_week"), str) and num(row, "extra_min") is not None


def severity(row: Row, _: Thresholds, ladder: Ladder) -> Severity:
    """`row` carries the member's four-week Σ `extra_cost_minor` (see `select`)."""
    return ladder.of(num(row, "extra_cost_minor") or 0)


def select(rows: Sequence[Row], w: Window, t: Thresholds, ladder: Ladder) -> list[Hit]:
    first, last = label(date.fromisoformat(w.params["from"])), label(date.fromisoformat(w.params["to"]))
    by_staff: dict[str, list[int]] = {}
    for i, r in enumerate(rows):
        if fires(r, t):
            by_staff.setdefault(str(r["staff_id"]), []).append(i)
    hits = []
    for idx in by_staff.values():
        week = {rows[i]["iso_week"]: i for i in idx}
        extra = {wk: num(rows[i], "extra_min") or 0 for wk, i in week.items()}
        if last in week and sum(extra.values()) >= t["extra_min_gte"] and extra[last] > extra.get(first, 0):
            total_cost = sum(num(rows[i], "extra_cost_minor") or 0 for i in idx)
            hits.append(Hit(week[last], week[last], severity({"extra_cost_minor": total_cost}, t, ladder)))
    return sorted(hits, key=lambda h: h.row)


def dedupe(row: Row, w: Window) -> str:
    return f"{w.params['outlet_id']}:{row['staff_id']}:{str(row['iso_week']).lower()}"


SPEC = register(
    DetectorSpec(
        id="people.overtime_drift",
        pack="people",
        template="people.overtime_drift",
        finding_type="people.overtime_drift",
        impact_column="extra_cost_minor",
        windows=windows,
        fires=fires,
        severity=severity,
        dedupe=dedupe,
        narration=(
            "Shifts ran past the roster this week: {extra_min} minutes beyond the {rostered_min} rostered, "
            "costing {extra_cost_minor} at the overtime rate, and it has grown over the last few weeks."
        ),
        select=select,
    )
)
