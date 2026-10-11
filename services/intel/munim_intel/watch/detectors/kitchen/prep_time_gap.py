"""`kitchen.prep_time_gap` (packs/kitchen.md §4, §5, §6; plant K4 — not plantable today, T-086: a fixture).

Template `kitchen.ticket_times` over the last `window_days` (14) business days. The pack judges an item at a station;
the template's rows are per station, item **and** 30-minute slot (its §3 purpose line), with the configured prep time
beside each. A row qualifies when `configured_prep_sec` is set, `tickets` ≥ `tickets_gte` (50) and |`p80_sec` −
`configured_prep_sec`| ≥ `abs_gap_sec_gte` (180 s); one finding per station and item, on its qualifying row with the
most tickets (the busiest slot; ties → the earlier slot), because p80s of different slots cannot be combined.
Severity `medium` when slower than promised, else `low` (non-₹: the impact is `p80_sec`). Dedupe
`<outlet>:<item>:<station>`. Draft `kitchen.prep_time.set.v1`: `prep_sec` ← that row's `p80_sec`, from tomorrow.
"""

from __future__ import annotations

from collections.abc import Sequence
from datetime import timedelta

from munim_intel.detect import DetectorSpec, Hit, Ladder, OutletFrame, Row, Severity, Thresholds, Window, num, register
from munim_intel.mapping import Detection, Proposal
from munim_intel.watch.detectors.kitchen.weeks import KITCHENS

TICKET_ADVANCED = "munim.kitchen.ticket.advanced.v1"


def windows(outlet: OutletFrame, t: Thresholds) -> list[Window]:
    start = outlet.business_date - timedelta(days=t["window_days"] - 1)
    return [Window({"outlet_id": outlet.id, "from": start.isoformat(), "to": outlet.business_date.isoformat()}, outlet.id)]


def fires(row: Row, t: Thresholds) -> bool:
    p80, configured, tickets = num(row, "p80_sec"), num(row, "configured_prep_sec"), num(row, "tickets")
    if not isinstance(row.get("item_id"), str) or not isinstance(row.get("station"), str):
        return False
    if p80 is None or configured is None or tickets is None:
        return False  # no configured prep time: nothing promised to compare against
    return tickets >= t["tickets_gte"] and abs(p80 - configured) >= t["abs_gap_sec_gte"]


def severity(row: Row, _: Thresholds, __: Ladder) -> Severity:
    return "medium" if (num(row, "p80_sec") or 0) > (num(row, "configured_prep_sec") or 0) else "low"


def select(rows: Sequence[Row], _: Window, t: Thresholds, ladder: Ladder) -> list[Hit]:
    best: dict[tuple[str, str], int] = {}
    for i, r in enumerate(rows):
        if fires(r, t):
            key = (str(r["station"]), str(r["item_id"]))
            if key not in best or (num(r, "tickets") or 0) > (num(rows[best[key]], "tickets") or 0):
                best[key] = i
    return [Hit(i, i, severity(rows[i], t, ladder)) for i in sorted(best.values())]


def dedupe(row: Row, w: Window) -> str:
    return f"{w.params['outlet_id']}:{row['item_id']}:{row['station']}"


def prep_time(d: Detection) -> Proposal:
    item, station = str(d.row["item_id"]), str(d.row["station"])  # `fires` admits only rows with both set
    p80 = d.ref("p80_sec")
    return Proposal(
        command_type="kitchen.prep_time.set.v1",
        payload={
            "outlet_id": d.outlet.id,
            "item_id": item,
            "station": station,
            "prep_sec": p80,
            # Never back-dated: the promise changes from the outlet's next business day.
            "valid_from": (d.outlet.business_date + timedelta(days=1)).isoformat(),
        },
        based_on=[p80, d.ref("configured_prep_sec")],
        targets=[item],
    )


SPEC = register(
    DetectorSpec(
        id="kitchen.prep_time_gap",
        pack="kitchen",
        template="kitchen.ticket_times",
        finding_type="kitchen.prep_time_gap",
        impact_column="p80_sec",
        windows=windows,
        fires=fires,
        severity=severity,
        dedupe=dedupe,
        narration=(
            "This dish at this station is promised in {configured_prep_sec} seconds, but slow tickets take {p80_sec} seconds "
            "over {tickets} tickets in this slot."
        ),
        watches=frozenset({TICKET_ADVANCED}),
        outlet_kinds=KITCHENS,
        mapping=prep_time,
        select=select,
    )
)
