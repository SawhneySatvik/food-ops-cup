"""`people.overstaffed_slot` (packs/people.md §4, §5; plant P2; answer key RG-P2).

Template `people.labour_vs_demand` **version 2** (migration 0026, ledger R47 D6) over the last six weeks of complete
business days, hourly slots: per day and slot, attended minutes beside `needed_min` (the day's orders × the outlet's own
8-week median attended minutes per order for that weekday and slot), the excess costed at the rate of the extra staff
(the people beyond the demand norm, not the blended crew rate), plus one Σ row per (outlet, weekday, slot) over the
window (`business_on` NULL; its `excess_cost_minor` the Σ of that weekday-slot's day cells). A weekday-slot qualifies
when, among its last `slots_window` (6) days, `attended_min` ≥ `attended_vs_needed_bp_gte` (15,000 bp = 1.5 ×) of a
positive `needed_min` on ≥ `slots_gte` (4). A slot whose norm is missing or zero (no measured orders per labour-minute)
never qualifies: 1.5 × nothing is not a staffing judgement. One finding per qualifying weekday-slot, as the pack's
dedupe `<outlet>:<weekday>:<slot>` (§4): it sits on that slot's latest qualifying day (its narration), its impact is
that slot's Σ cell — a cell core minted, never a sum intel adds up. Severity L on that Σ scaled to a month (× 4.3 ÷ 6).
Draft (ADR-015 §4): where Munim Cares is on for the outlet, a published Cares listing whose pickup weekday and slot cells
equal this finding's weekday and slot cells gets a `goals.task.create.v1` "pack and hand over" for the first rostered
crew member (`cares.pickup_crew`, the P2 extra-staff order), by code. The mapping drafts the first matching listing
(`cares.listings` is soonest-first); a roster is otherwise drafted on request through the skill.
"""

from __future__ import annotations

from collections.abc import Sequence
from datetime import timedelta

from munim_intel.detect import Cell, DetectorSpec, Hit, Ladder, OutletFrame, Row, Severity, Thresholds, Window, num, register
from munim_intel.mapping import Abstain, Detection, FollowUp, Proposal
from munim_intel.watch.detectors.people.weeks import day_of

#: The template's slot length (its `slot_minutes` param: 15, 30 or 60). Hourly: the pack judges staffing per slot, and
#: a shift is planned in hours.
SLOT_MINUTES = 60
WEEKS = 6


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
    """`row` is the weekday-slot's Σ row: its window `excess_cost_minor`, scaled to a month."""
    return ladder.of((num(row, "excess_cost_minor") or 0) * 43 // (10 * WEEKS))


def select(rows: Sequence[Row], _: Window, t: Thresholds, ladder: Ladder) -> list[Hit]:
    """Day rows and Σ rows are matched on the template's own `outlet_id`, `weekday` and `slot_start` cells."""
    groups: dict[tuple[Cell, Cell, Cell], list[int]] = {}
    sigma: dict[tuple[Cell, Cell, Cell], int] = {}
    for i, r in enumerate(rows):
        k = (r.get("outlet_id"), r.get("weekday"), r.get("slot_start"))
        if r.get("business_on") is None:
            sigma[k] = i
        elif day_of(r.get("business_on")) is not None and isinstance(r.get("slot_start"), str):
            groups.setdefault(k, []).append(i)
    hits = []
    for k, idx in groups.items():
        last = sorted(idx, key=lambda i: str(rows[i]["business_on"]))[-t["slots_window"] :]
        over = [i for i in last if fires(rows[i], t)]
        if len(over) >= t["slots_gte"]:
            # v2's Σ row of this weekday-slot (0026). Its absence (a v1 template) is an error the sweep traces, never a
            # silent default.
            hits.append(Hit(over[-1], sigma[k], severity(rows[sigma[k]], t, ladder)))
    return sorted(hits, key=lambda h: h.row)


def dedupe(row: Row, w: Window) -> str:
    return f"{w.params['outlet_id']}:{row['weekday']}:{row['slot_start']}"


TASK = "goals.task.create.v1"
LISTING_PUBLISHED = "munim.cares.listing.published.v1"


def _listing(d: Detection) -> int | None:
    """Row of the first published listing whose weekday and slot cells equal the finding row's (cell equality only)."""
    listings = d.follow.get("listings")
    weekday, slot = d.row.get("weekday"), d.row.get("slot_start")
    if listings is None or not isinstance(weekday, str) or not isinstance(slot, str):
        return None
    for i, r in enumerate(listings.rows):
        if r.get("pickup_weekday") == weekday and r.get("pickup_slot_start") == slot and isinstance(r.get("listing_id"), str):
            return i
    return None


def listings_params(d: Detection) -> dict[str, str] | None:
    return {"outlet_id": d.outlet.id, "status": "published"} if d.outlet.cares_active else None


def crew_params(d: Detection) -> dict[str, str] | None:
    i = _listing(d)
    return None if i is None else {"outlet_id": d.outlet.id, "listing_id": str(d.follow["listings"].rows[i]["listing_id"])}


FOLLOW_LISTINGS = FollowUp("listings", "cares.listings", listings_params)
FOLLOW_CREW = FollowUp("crew", "cares.pickup_crew", crew_params)


def pack_and_hand_over(d: Detection) -> Proposal | Abstain | None:
    i = _listing(d)
    crew = d.follow.get("crew")
    if i is None or crew is None:
        return None
    listings = d.follow["listings"]
    listing, due = str(listings.rows[i]["listing_id"]), listings.rows[i].get("pickup_on")
    member = crew.rows[0].get("member_id") if crew.rows else None
    if not isinstance(member, str) or not isinstance(due, str):
        return Abstain("no_rostered_staff")
    return Proposal(
        command_type=TASK,
        payload={
            "outlet_id": d.outlet.id,
            "title_key": "cares.task.pack_and_hand_over",
            "assignee_member_id": member,
            "due_on": due,
            "finding_id": d.finding_id,
            "cares_listing_id": listing,
        },
        based_on=[
            d.ref("weekday"),
            d.ref("slot_start"),
            listings.ref(i, "pickup_weekday"),
            listings.ref(i, "pickup_slot_start"),
            listings.ref(i, "pickup_on"),
            crew.ref(0, "member_id"),
        ],
        targets=[listing, due],
        minted=["task_id"],
    )


SPEC = register(
    DetectorSpec(
        id="people.overstaffed_slot",
        thresholds=("attended_vs_needed_bp_gte", "slots_gte", "slots_window"),
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
            "{needed_min} needed for {orders} orders on the latest such day; the extra staff in this slot cost "
            "{excess_cost_minor} across the window."
        ),
        select=select,
        watches=frozenset({LISTING_PUBLISHED}),
        mapping=pack_and_hand_over,
        follow_ups=(FOLLOW_LISTINGS, FOLLOW_CREW),
    )
)
