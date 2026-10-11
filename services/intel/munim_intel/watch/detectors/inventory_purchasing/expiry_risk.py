"""`inventory.expiry_risk` (packs/inventory-purchasing.md §4, §5, §6; plant I4; answer key ST-I4).

Template `inventory.expiry_risk` per outlet, `days` = the larger of the pack's two horizons (7): batches expiring from
today on that still hold stock, with the forecast use before expiry (FEFO) taken off. Fires when `days_to_expiry` ≤
`days_to_expiry_lte` (3), or ≤ `sku_days_to_expiry_lte` (7) for a shop SKU, and `at_risk_minor` ≥ `at_risk_minor_gte`
(₹500 / A$10). Severity L on `at_risk_minor`. Dedupe `<outlet>:<batch>`.

No draft yet: pack §6 maps this finding to `inventory.transfer.create.v1` or `purchasing.supplier_return.create.v1`, and
both need the batch's ingredient and unit (and a destination outlet, or the supplier) that the template's row does not
carry — a mapping places only cells and ids it has (T-046 report). "Today" is the database's now() in the outlet's zone.
"""

from __future__ import annotations

from munim_intel.detect import DetectorSpec, Ladder, OutletFrame, Row, Severity, Thresholds, Window, num, register


def windows(outlet: OutletFrame, t: Thresholds) -> list[Window]:
    days = max(t["days_to_expiry_lte"], t["sku_days_to_expiry_lte"])
    return [Window({"outlet_id": outlet.id, "days": days, "as_of": None}, outlet.id)]


def fires(row: Row, t: Thresholds) -> bool:
    left, at_risk = num(row, "days_to_expiry"), num(row, "at_risk_minor")
    if not isinstance(row.get("batch_id"), str) or left is None or at_risk is None:
        return False
    horizon = t["sku_days_to_expiry_lte"] if row.get("is_sku") is True else t["days_to_expiry_lte"]
    return left <= horizon and at_risk >= t["at_risk_minor_gte"]


def severity(row: Row, _: Thresholds, ladder: Ladder) -> Severity:
    return ladder.of(num(row, "at_risk_minor") or 0)


def dedupe(row: Row, w: Window) -> str:
    return f"{w.params['outlet_id']}:{row['batch_id']}"


SPEC = register(
    DetectorSpec(
        id="inventory.expiry_risk",
        pack="inventory_purchasing",
        template="inventory.expiry_risk",
        finding_type="inventory.expiry_risk",
        impact_column="at_risk_minor",
        windows=windows,
        fires=fires,
        severity=severity,
        dedupe=dedupe,
        narration=(
            "A batch expires on {expiry_on} with {remaining_qty_milli} still in stock and only {use_before_expiry_qty_milli} "
            "expected to be used before then: {at_risk_qty_milli} worth {at_risk_minor} is at risk of being thrown away."
        ),
    )
)
