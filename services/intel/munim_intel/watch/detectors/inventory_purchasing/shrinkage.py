"""`inventory.shrinkage` (packs/inventory-purchasing.md §4, §5, §7; plant I5; answer key ST-I5).

Template `inventory.shrinkage` per stock count (`count_id`): expected vs counted per ingredient, the loss valued at the
last receipt cost, and a Σ row (ingredient NULL). Fires on the Σ row when there is a loss and `loss_minor` ≥
`loss_share_bp_gte` (200 bp = 2%) of `counted_value_minor`, or `loss_minor` ≥ `loss_minor_gte` (₹2,000 / A$40). Severity
L on `loss_minor`. Dedupe `<count_id>`. No draft: pack §6 maps none (the count itself already adjusted the books).

Enumeration: the outlet's submitted counts of the last `window_days` (`inventory.counts`, migration 0022), one window
per count.
"""

from __future__ import annotations

from datetime import timedelta
from typing import Any

from munim_intel.detect import DetectorSpec, Driver, Ladder, OutletFrame, Row, Severity, Thresholds, Window, num, register


def window(count_id: str) -> Window:
    return Window({"count_id": count_id}, count_id)


def windows(_outlet: OutletFrame, _t: Thresholds) -> list[Window]:
    return []


def counts_listed(outlet: OutletFrame, t: Thresholds) -> dict[str, Any]:
    """`inventory.counts(outlet_id, from, to)`: the outlet's counts submitted in the `window_days` ending on its date."""
    start = outlet.business_date - timedelta(days=t["window_days"] - 1)
    return {"outlet_id": outlet.id, "from": start.isoformat(), "to": outlet.business_date.isoformat()}


def fires(row: Row, t: Thresholds) -> bool:
    loss, counted = num(row, "loss_minor"), num(row, "counted_value_minor")
    if row.get("ingredient_id") is not None or loss is None or counted is None or loss <= 0:
        return False
    return loss * 10_000 >= t["loss_share_bp_gte"] * counted or loss >= t["loss_minor_gte"]


def severity(row: Row, _: Thresholds, ladder: Ladder) -> Severity:
    return ladder.of(num(row, "loss_minor") or 0)


def dedupe(_row: Row, w: Window) -> str:
    return str(w.params["count_id"])


SPEC = DetectorSpec(
    id="inventory.shrinkage",
    thresholds=("loss_minor_gte", "loss_share_bp_gte", "window_days"),
    pack="inventory_purchasing",
    template="inventory.shrinkage",
    finding_type="inventory.shrinkage",
    impact_column="loss_minor",
    windows=windows,
    fires=fires,
    severity=severity,
    dedupe=dedupe,
    narration=("A stock count found stock missing: {loss_minor} short against the books, out of {counted_value_minor} counted."),
    driver=Driver("inventory.counts", counts_listed, "count_id", lambda i, _o, _t: window(i)),
)

register(SPEC)
