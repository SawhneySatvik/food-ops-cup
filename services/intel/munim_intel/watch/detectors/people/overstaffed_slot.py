"""`people.overstaffed_slot` (packs/people.md §4, §5; plant P2; answer key RG-P2).

Template `people.labour_vs_demand` over the last six weeks of complete business days, hourly slots: per day and slot,
attended minutes beside `needed_min` (the day's orders × the outlet's own 8-week median attended minutes per order for
that weekday and slot). A weekday-slot fires when, among its last `slots_window` (6) days, `attended_min` ≥
`attended_vs_needed_bp_gte` (15,000 bp = 1.5 ×) of a positive `needed_min` on ≥ `slots_gte` (4). A slot whose norm is
missing or zero (no measured orders per labour-minute) never qualifies: 1.5 × nothing is not a staffing judgement.
The finding sits on the latest qualifying day; its impact is that row's `excess_cost_minor` (the pack's monthly Σ has
no cell). Severity L on the six days' `excess_cost_minor` scaled to a month (× 4.3 ÷ 6). Dedupe
`<outlet>:<weekday>:<slot>`. No draft (a roster is drafted on request through the skill).
"""

from __future__ import annotations

from collections.abc import Sequence
from datetime import date, timedelta

from munim_intel.detect import DetectorSpec, Hit, Ladder, OutletFrame, Row, Severity, Thresholds, Window, num, register

#: The template's slot length (its `slot_minutes` param: 15, 30 or 60). Hourly: the pack judges staffing per slot, and
#: a shift is planned in hours.
SLOT_MINUTES = 60
WEEKS = 6
DAYS = ("mon", "tue", "wed", "thu", "fri", "sat", "sun")


def windows(outlet: OutletFrame, _: Thresholds) -> list[Window]:
    to = outlet.business_date - timedelta(days=1)  # complete days only
    start = to - timedelta(weeks=WEEKS) + timedelta(days=1)
    return [Window({"outlet_id": outlet.id, "from": start.isoformat(), "to": to.isoformat(), "slot_minutes": SLOT_MINUTES}, outlet.id)]


def fires(row: Row, t: Thresholds) -> bool:
    """One day's slot is over-staffed against a positive need."""
    attended, needed = num(row, "attended_min"), num(row, "needed_min")
    if not isinstance(row.get("business_on"), str) or not isinstance(row.get("slot_start"), str):
        return False
    return attended is not None and needed is not None and needed > 0 and attended * 10_000 >= t["attended_vs_needed_bp_gte"] * needed


def severity(row: Row, _: Thresholds, ladder: Ladder) -> Severity:
    """`row` carries the slot's six-day Σ `excess_cost_minor` (see `select`)."""
    return ladder.of((num(row, "excess_cost_minor") or 0) * 43 // (10 * WEEKS))


def select(rows: Sequence[Row], _: Window, t: Thresholds, ladder: Ladder) -> list[Hit]:
    groups: dict[tuple[int, str], list[int]] = {}
    for i, r in enumerate(rows):
        if isinstance(r.get("business_on"), str) and isinstance(r.get("slot_start"), str):
            day = date.fromisoformat(str(r["business_on"]))
            groups.setdefault((day.weekday(), str(r["slot_start"])), []).append(i)
    hits = []
    for idx in groups.values():
        last = sorted(idx, key=lambda i: str(rows[i]["business_on"]))[-t["slots_window"] :]
        over = [i for i in last if fires(rows[i], t)]
        if len(over) >= t["slots_gte"]:
            total = sum(num(rows[i], "excess_cost_minor") or 0 for i in last)
            hits.append(Hit(over[-1], over[-1], severity({"excess_cost_minor": total}, t, ladder)))
    return sorted(hits, key=lambda h: h.row)


def dedupe(row: Row, w: Window) -> str:
    return f"{w.params['outlet_id']}:{DAYS[date.fromisoformat(str(row['business_on'])).weekday()]}:{row['slot_start']}"


SPEC = register(
    DetectorSpec(
        id="people.overstaffed_slot",
        pack="people",
        template="people.labour_vs_demand",
        finding_type="people.overstaffed_slot",
        impact_column="excess_cost_minor",
        windows=windows,
        fires=fires,
        severity=severity,
        dedupe=dedupe,
        narration=(
            "This slot keeps being staffed beyond what its orders need: {attended_min} minutes worked against "
            "{needed_min} needed for {orders} orders, costing {excess_cost_minor} on the latest such day."
        ),
        select=select,
    )
)
