"""`purchasing.near_duplicate_invoice` (packs/inventory-purchasing.md §4, §5; plant I3; answer keys RG-I3, ST-I3).

Template `purchasing.invoice_duplicates` per supplier invoice: other invoices of the same supplier with the same total
whose numbers match once non-alphanumerics are stripped (exact duplicates are refused by the books). Fires when
`days_apart` ≤ `days_apart_lte` (7). Severity L on `total_minor`. Dedupe `<invoice>`, where the invoice is the smaller id
of the pair: each invoice of a pair lists the other, and both listings are one problem.

No draft: pack §6 claims `total_claimed_minor` ← `total_minor`, but `purchasing.invoice.dispute.v1` has no total field
and needs ≥ 1 line `{invoice_line_id, claimed_minor}`, which this template's row does not carry (T-046 report).
Enumeration: the same invoice listing as `purchasing.overbilled` (`purchasing.invoices` over the last `window_days`,
migration 0022), one window per invoice; tenant-level, once per run (R-B S2-C).
"""

from __future__ import annotations

from munim_intel.detect import DetectorSpec, Driver, Ladder, OutletFrame, Row, Severity, Thresholds, Window, num, register
from munim_intel.watch.detectors.inventory_purchasing.overbilled import invoices_listed


def window(supplier_invoice_id: str) -> Window:
    return Window({"supplier_invoice_id": supplier_invoice_id}, supplier_invoice_id)


def windows(_outlet: OutletFrame, _t: Thresholds) -> list[Window]:
    return []


def fires(row: Row, t: Thresholds) -> bool:
    apart = num(row, "days_apart")
    return isinstance(row.get("twin_invoice_id"), str) and apart is not None and apart <= t["days_apart_lte"]


def severity(row: Row, _: Thresholds, ladder: Ladder) -> Severity:
    return ladder.of(num(row, "total_minor") or 0)


def dedupe(row: Row, w: Window) -> str:
    return min(str(w.params["supplier_invoice_id"]), str(row["twin_invoice_id"]))


SPEC = DetectorSpec(
    id="purchasing.near_duplicate_invoice",
    thresholds=("days_apart_lte", "window_days"),
    pack="inventory_purchasing",
    template="purchasing.invoice_duplicates",
    finding_type="purchasing.near_duplicate_invoice",
    impact_column="total_minor",
    windows=windows,
    fires=fires,
    severity=severity,
    dedupe=dedupe,
    narration=(
        "This supplier invoice looks like a second copy of another: same supplier, same total of {total_minor}, an "
        "invoice number that differs only in punctuation, dated {days_apart} days apart."
    ),
    driver=Driver("purchasing.invoices", invoices_listed, "supplier_invoice_id", lambda i, _o, _t: window(i)),
    tenant_level=True,
)

register(SPEC)
