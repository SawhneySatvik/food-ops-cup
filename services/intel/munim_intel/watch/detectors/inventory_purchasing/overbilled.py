"""`purchasing.overbilled` (packs/inventory-purchasing.md §4, §5, §6; plant I2; answer keys RG-I2, CK-I2, ST-I2, AU-I2).

Template `purchasing.invoice_vs_po` per supplier invoice: each line against its PO price and received quantity, and a Σ
row (line NULL). Fires on the Σ row when `overbilled_minor` ≥ `overbilled_minor_gte` (₹100 / A$2). Severity L on it.
Dedupe `<invoice>`.

Draft (pack §6): `purchasing.invoice.dispute.v1`, basis `overbilled`, one line per overbilled invoice line with
`claimed_minor` ← that line's `overbilled_minor`, from the window's invoice id (`Detection.params`) and the line rows of
the same snapshot (`Detection.rows`).

Enumeration: `DRIVER` lists the tenant's invoices dated in the last `window_days` (`purchasing.invoices`, migration 0022),
one window per invoice. Both templates are tenant-level, so the detector runs once per run and its dispute is
tenant-wide (`outlet_ids` [], owner-approved; R-B S2-C) rather than filed under whichever outlet a sweep visited first.
"""

from __future__ import annotations

from collections.abc import Sequence
from datetime import timedelta
from typing import Any

from munim_intel.detect import DetectorSpec, Driver, Ladder, OutletFrame, Row, Severity, Thresholds, Window, num, register
from munim_intel.mapping import Detection, Proposal, snap_ref


def window(supplier_invoice_id: str) -> Window:
    return Window({"supplier_invoice_id": supplier_invoice_id}, supplier_invoice_id)


def windows(_outlet: OutletFrame, _t: Thresholds) -> list[Window]:
    return []


def invoices_listed(outlet: OutletFrame, t: Thresholds) -> dict[str, Any]:
    """`purchasing.invoices(from, to)`: the invoices dated in the `window_days` business days ending on the outlet's date."""
    return {"from": (outlet.business_date - timedelta(days=t["window_days"] - 1)).isoformat(), "to": outlet.business_date.isoformat()}


DRIVER = Driver("purchasing.invoices", invoices_listed, "supplier_invoice_id", lambda i, _o, _t: window(i))


def fires(row: Row, t: Thresholds) -> bool:
    over = num(row, "overbilled_minor")
    return row.get("line_id") is None and over is not None and over >= t["overbilled_minor_gte"]


def severity(row: Row, _: Thresholds, ladder: Ladder) -> Severity:
    return ladder.of(num(row, "overbilled_minor") or 0)


def dedupe(_row: Row, w: Window) -> str:
    return str(w.params["supplier_invoice_id"])


def dispute(d: Detection, supplier_invoice_id: str, rows: Sequence[Row]) -> Proposal | None:
    """The dispute of one overbilled invoice: every line row with a positive overbilled cell, claimed by ref."""
    lines = [
        {"invoice_line_id": r["line_id"], "claimed_minor": snap_ref(d.snapshot_id, i, "overbilled_minor")}
        for i, r in enumerate(rows)
        if isinstance(r.get("line_id"), str) and (num(r, "overbilled_minor") or 0) > 0
    ]
    if not lines:
        return None
    return Proposal(
        command_type="purchasing.invoice.dispute.v1",
        payload={"supplier_invoice_id": supplier_invoice_id, "basis": "overbilled", "lines": lines},
        based_on=[d.ref("overbilled_minor"), *(str(x["claimed_minor"]) for x in lines)],
        targets=[supplier_invoice_id],
        minted=["dispute_id"],
    )


def mapping(d: Detection) -> Proposal | None:
    return dispute(d, str(d.params["supplier_invoice_id"]), d.rows)


SPEC = DetectorSpec(
    id="purchasing.overbilled",
    thresholds=("overbilled_minor_gte", "window_days"),
    pack="inventory_purchasing",
    template="purchasing.invoice_vs_po",
    finding_type="purchasing.overbilled",
    impact_column="overbilled_minor",
    windows=windows,
    fires=fires,
    severity=severity,
    dedupe=dedupe,
    narration=(
        "This supplier invoice charges more than the purchase order agreed or more than was received: {overbilled_minor} overbilled in all."
    ),
    driver=DRIVER,
    mapping=mapping,
    tenant_level=True,
)

register(SPEC)
