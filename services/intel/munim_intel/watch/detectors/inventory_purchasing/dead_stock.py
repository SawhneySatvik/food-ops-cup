"""`inventory.dead_stock` (packs/inventory-purchasing.md §4, §5). No answer-key plant (detector-map.json).

Template `inventory.dead_stock` per outlet at the pack's `days` (60): ingredients with stock on hand and no sale
consumption in that many days, valued at the last receipt cost. Fires when `value_minor` ≥ `value_minor_gte`
(₹1,000 / A$20). Severity `low`, `medium` at ≥ `medium_value_minor_gte` (₹10,000 / A$200). Dedupe
`<outlet>:<ingredient>:<month>` (the outlet's business month). No draft: pack §6 maps none to this finding.
"""

from __future__ import annotations

from munim_intel.detect import DetectorSpec, Ladder, OutletFrame, Row, Severity, Thresholds, Window, num, register


def windows(outlet: OutletFrame, t: Thresholds) -> list[Window]:
    return [
        Window({"outlet_id": outlet.id, "days": t["days"], "as_of": outlet.business_date.isoformat()}, outlet.business_date.isoformat()[:7])
    ]


def fires(row: Row, t: Thresholds) -> bool:
    value = num(row, "value_minor")
    return isinstance(row.get("ingredient_id"), str) and value is not None and value >= t["value_minor_gte"]


def severity(row: Row, t: Thresholds, _: Ladder) -> Severity:
    return "medium" if (num(row, "value_minor") or 0) >= t["medium_value_minor_gte"] else "low"


def dedupe(row: Row, w: Window) -> str:
    return f"{w.params['outlet_id']}:{row['ingredient_id']}:{w.key}"


SPEC = register(
    DetectorSpec(
        id="inventory.dead_stock",
        thresholds=("days", "medium_value_minor_gte", "value_minor_gte"),
        pack="inventory_purchasing",
        template="inventory.dead_stock",
        finding_type="inventory.dead_stock",
        impact_column="value_minor",
        windows=windows,
        fires=fires,
        severity=severity,
        dedupe=dedupe,
        narration="This stock has not been used in a sale for a long time: {on_hand_qty_milli} on hand, worth {value_minor}.",
    )
)
