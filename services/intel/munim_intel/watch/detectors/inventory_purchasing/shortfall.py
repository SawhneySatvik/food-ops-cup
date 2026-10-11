"""`inventory.shortfall` (packs/inventory-purchasing.md §4, §5, §6). No answer-key plant (detector-map.json).

Template `inventory.shortfall` per outlet at the pack's `lead_days` (2): forecast need over the lead time against stock
on hand and open committed POs. Fires when `shortfall_qty_milli` > `shortfall_qty_milli_gt` (0). With no forecast run
the template has no rows, so nothing fires. Dedupe `<outlet>:<ingredient>:<date>` (the outlet's business date).

Severity: the pack says `high` if `stockout_on` ≤ tomorrow, else `medium`. "Tomorrow" is the outlet's business date + 1
from the run-frame (core's one tz module), handed in through `severity_at`. A `stockout_on` that is not a date is
`medium`: an unknown stockout day is never ranked as imminent.

Draft: `inventory.reorder_level.set.v1` with min / par ← `proposed_min_qty_milli` / `proposed_par_qty_milli` (pack §6).
The PO draft from the same finding goes through negotiation (T-055), not this mapping.
"""

from __future__ import annotations

from datetime import date, timedelta

from munim_intel.detect import DetectorSpec, Ladder, OutletFrame, Row, Severity, Thresholds, Window, num, register
from munim_intel.mapping import Detection, Proposal


def windows(outlet: OutletFrame, t: Thresholds) -> list[Window]:
    return [
        Window(
            {"outlet_id": outlet.id, "lead_days": t["lead_days"], "as_of": outlet.business_date.isoformat()},
            outlet.business_date.isoformat(),
        )
    ]


def fires(row: Row, t: Thresholds) -> bool:
    short = num(row, "shortfall_qty_milli")
    return isinstance(row.get("ingredient_id"), str) and short is not None and short > t["shortfall_qty_milli_gt"]


def severity(_row: Row, _t: Thresholds, _ladder: Ladder) -> Severity:
    return "medium"


def severity_at(row: Row, t: Thresholds, ladder: Ladder, _w: Window, outlet: OutletFrame) -> Severity:
    on = row.get("stockout_on")
    if not isinstance(on, str):
        return severity(row, t, ladder)
    try:
        day = date.fromisoformat(on)
    except ValueError:
        return severity(row, t, ladder)
    return "high" if day <= outlet.business_date + timedelta(days=1) else "medium"


def dedupe(row: Row, w: Window) -> str:
    return f"{w.params['outlet_id']}:{row['ingredient_id']}:{w.key}"


def reorder_level(d: Detection) -> Proposal:
    ingredient = str(d.row["ingredient_id"])  # `fires` admits only rows whose ingredient_id is a uuid string
    lo, hi = d.ref("proposed_min_qty_milli"), d.ref("proposed_par_qty_milli")
    return Proposal(
        command_type="inventory.reorder_level.set.v1",
        payload={"outlet_id": d.outlet.id, "ingredient_id": ingredient, "min_qty_milli": lo, "par_qty_milli": hi},
        based_on=[d.ref("shortfall_qty_milli"), lo, hi],
        targets=[d.outlet.id, ingredient],
    )


SPEC = register(
    DetectorSpec(
        id="inventory.shortfall",
        thresholds=("lead_days", "shortfall_qty_milli_gt"),
        pack="inventory_purchasing",
        template="inventory.shortfall",
        finding_type="inventory.shortfall",
        impact_column="shortfall_qty_milli",
        windows=windows,
        fires=fires,
        severity=severity,
        severity_at=severity_at,
        dedupe=dedupe,
        narration=(
            "This ingredient will run short before the next delivery: forecast use of {need_qty_milli} against "
            "{on_hand_qty_milli} on hand and {open_po_qty_milli} on open orders leaves {shortfall_qty_milli} short, "
            "first on {stockout_on}."
        ),
        mapping=reorder_level,
    )
)
