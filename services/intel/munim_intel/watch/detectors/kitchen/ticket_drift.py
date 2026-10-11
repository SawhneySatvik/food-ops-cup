"""`kitchen.ticket_drift` (packs/kitchen.md §4, §5; plants K1, K1b, trap K6 — not plantable today, T-086: fixtures).

Template `kitchen.ticket_drift`, one ISO week per window: a row per station and 30-minute slot (this week's p80 against
the same slot's four weeks before, and the load ratio), then the Σ row (station and slot NULL) with the week's
`late_loss_minor` (refunds with reason `late` + orders cancelled after their promised time). A slot fires when
`drift_bp` ≥ `drift_bp_gte` (2,500), `tickets_now` ≥ `tickets_now_gte` (30) and `load_ratio_bp` < `load_ratio_bp_lt`
(13,000: a busier-than-usual slot is load, not drift — K6). The impact is the Σ row's `late_loss_minor`; severity L on
it × 4.3, at least `medium` when the p80 moved by ≥ `medium_p80_gap_sec_gte` (300 s). Dedupe
`<outlet>:<station>:<slot>:<iso_week>`. No draft (pack §6 maps none).
"""

from __future__ import annotations

from collections.abc import Sequence

from munim_intel.detect import DetectorSpec, Hit, Ladder, OutletFrame, Row, Severity, Thresholds, Window, at_least, num, register
from munim_intel.watch.detectors.kitchen.weeks import KITCHENS, monthly, week_windows

TICKET_ADVANCED = "munim.kitchen.ticket.advanced.v1"


def windows(outlet: OutletFrame, _: Thresholds) -> list[Window]:
    return week_windows(outlet)


def fires(row: Row, t: Thresholds) -> bool:
    drift, now, load = num(row, "drift_bp"), num(row, "tickets_now"), num(row, "load_ratio_bp")
    if not isinstance(row.get("station"), str) or drift is None or now is None or load is None:
        return False  # the Σ row, or a slot without a baseline
    return drift >= t["drift_bp_gte"] and now >= t["tickets_now_gte"] and load < t["load_ratio_bp_lt"]


def severity(row: Row, t: Thresholds, ladder: Ladder) -> Severity:
    """`row` is the slot row with the Σ row's `late_loss_minor` beside it (see `select`)."""
    s = ladder.of(monthly(num(row, "late_loss_minor") or 0))
    gap = (num(row, "p80_now_sec") or 0) - (num(row, "p80_base_sec") or 0)
    return at_least(s, "medium") if gap >= t["medium_p80_gap_sec_gte"] else s


def select(rows: Sequence[Row], _: Window, t: Thresholds, ladder: Ladder) -> list[Hit]:
    if not rows or rows[-1].get("station") is not None:
        return []
    total = len(rows) - 1
    loss = rows[total].get("late_loss_minor")
    return [Hit(i, total, severity({**r, "late_loss_minor": loss}, t, ladder)) for i, r in enumerate(rows[:total]) if fires(r, t)]


def dedupe(row: Row, w: Window) -> str:
    return f"{w.params['outlet_id']}:{row['station']}:{row['slot_start']}:{w.key}"


SPEC = register(
    DetectorSpec(
        id="kitchen.ticket_drift",
        thresholds=("drift_bp_gte", "load_ratio_bp_lt", "medium_p80_gap_sec_gte", "tickets_now_gte"),
        pack="kitchen",
        template="kitchen.ticket_drift",
        finding_type="kitchen.ticket_drift",
        impact_column="late_loss_minor",
        windows=windows,
        fires=fires,
        severity=severity,
        dedupe=dedupe,
        narration=(
            "Slow tickets at this station in this slot now take {p80_now_sec} seconds against {p80_base_sec} in the weeks "
            "before, on a similar load; late refunds and cancellations that week came to {late_loss_minor}."
        ),
        watches=frozenset({TICKET_ADVANCED}),
        outlet_kinds=KITCHENS,
        select=select,
    )
)
