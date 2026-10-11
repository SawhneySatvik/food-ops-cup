"""`kitchen.remakes` (packs/kitchen.md §4, §5; plant K2; answer keys RG-K2, CK-K2, AU-K2).

Template `kitchen.remakes_overprep`, one ISO week per window: a row per station (remake voids, valued) and the Σ row
(station NULL) with the week's completed `orders`. A station fires when its `remake_minor` ≥ `remake_minor_gte` (IN
₹1,000, AU A$20) and its `remakes` are ≥ `remake_share_bp_gte` (200 bp = 2%) of the week's orders — so the rule reads
two rows, and the impact is the station row's own `remake_minor`. Severity L on the week × 4.3. Dedupe
`<outlet>:<station>:<iso_week>`. No draft (pack §6 maps none).
"""

from __future__ import annotations

from collections.abc import Sequence

from munim_intel.detect import DetectorSpec, Hit, Ladder, OutletFrame, Row, Severity, Thresholds, Window, num, register
from munim_intel.watch.detectors.kitchen.weeks import KITCHENS, monthly, week_windows

VOID_RECORDED = "munim.orders.void.recorded.v1"


def windows(outlet: OutletFrame, _: Thresholds) -> list[Window]:
    return week_windows(outlet)


def fires(row: Row, t: Thresholds) -> bool:
    """The station row's own bar (the share needs the Σ row's orders: `select`)."""
    amount = num(row, "remake_minor")
    return isinstance(row.get("station"), str) and amount is not None and amount >= t["remake_minor_gte"]


def severity(row: Row, _: Thresholds, ladder: Ladder) -> Severity:
    return ladder.of(monthly(num(row, "remake_minor") or 0))


def select(rows: Sequence[Row], _: Window, t: Thresholds, ladder: Ladder) -> list[Hit]:
    orders = num(rows[-1], "orders") if rows and rows[-1].get("station") is None else None
    if not orders:
        return []  # no Σ row, or a week without completed orders: no share to judge
    return [
        Hit(i, i, severity(r, t, ladder))
        for i, r in enumerate(rows)
        if fires(r, t) and (num(r, "remakes") or 0) * 10_000 >= t["remake_share_bp_gte"] * orders
    ]


def dedupe(row: Row, w: Window) -> str:
    return f"{w.params['outlet_id']}:{row['station']}:{w.key}"


SPEC = register(
    DetectorSpec(
        id="kitchen.remakes",
        thresholds=("remake_minor_gte", "remake_share_bp_gte"),
        pack="kitchen",
        template="kitchen.remakes_overprep",
        finding_type="kitchen.remakes",
        impact_column="remake_minor",
        windows=windows,
        fires=fires,
        severity=severity,
        dedupe=dedupe,
        narration="Dishes from this station were remade {remakes} times in a week, writing off {remake_minor}.",
        watches=frozenset({VOID_RECORDED}),
        outlet_kinds=KITCHENS,
        select=select,
    )
)
