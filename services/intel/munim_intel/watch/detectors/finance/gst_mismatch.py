"""`finance.gst_mismatch` (packs/finance.md §4, §5; plant F6 — not plantable today, detector-map.json pack_cases F6).

Template `finance.gst_check` **version 2** (migration 0023 F4): one row per outlet, the month's order tax against the
output tax posted from those orders. Each outlet's window passes its own `outlet_id`, which narrows both sides, so the
snapshot — and the finding cut from it — belong to that outlet (core mints a one-outlet param under that outlet's scope).
Fires when |`diff_minor`| ≥ the pack's `abs_diff_minor_gte` (IN ₹10, AU A$1), either sign. Severity at least `high`
(filing risk), above that L on |diff|. Dedupe `<outlet>:<month>` from the row's outlet. No draft (pack §6).
"""

from __future__ import annotations

from munim_intel.detect import DetectorSpec, Ladder, OutletFrame, Row, Severity, Thresholds, Window, at_least, num, register
from munim_intel.watch.detectors.finance.periods import month_starts

#: The current business month and the one before it (a return is filed for the month just closed).
MONTHS_BACK = 2


def windows(outlet: OutletFrame, _: Thresholds) -> list[Window]:
    return [
        Window({"period_month": m.isoformat(), "outlet_id": outlet.id}, m.isoformat()[:7])
        for m in month_starts(outlet.business_date, MONTHS_BACK)
    ]


def fires(row: Row, t: Thresholds) -> bool:
    diff = num(row, "diff_minor")
    return isinstance(row.get("outlet_id"), str) and diff is not None and abs(diff) >= t["abs_diff_minor_gte"]


def severity(row: Row, _: Thresholds, ladder: Ladder) -> Severity:
    return at_least(ladder.of(abs(num(row, "diff_minor") or 0)), "high")


def dedupe(row: Row, w: Window) -> str:
    return f"{row['outlet_id']}:{w.key}"


SPEC = register(
    DetectorSpec(
        id="finance.gst_mismatch",
        thresholds=("abs_diff_minor_gte",),
        pack="finance",
        template="finance.gst_check",
        finding_type="tax.gst_mismatch",
        impact_column="diff_minor",
        windows=windows,
        fires=fires,
        severity=severity,
        dedupe=dedupe,
        narration=(
            "This outlet's tax on its orders does not match the tax posted to the books for the month: "
            "{order_tax_minor} on the orders against {posted_tax_minor} posted, a difference of {diff_minor}."
        ),
    )
)
