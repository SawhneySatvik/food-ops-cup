"""`customers.coupon_cap_evasion` (packs/customers-growth.md §4, §5; plant G1; answer key RG-G1).

Template `customers.coupon_leakage`, one row per coupon over the last `window_days` business days. A use beyond the
coupon's per-customer cap by one phone number, counted across every customer record that carries that number, is cap
evasion. The detector fires when `cap_evasion_minor` ≥ `cap_evasion_minor_gte` (IN ₹500, AU A$10). Severity is L on that
amount.

The template is tenant-level and takes no `outlet_id`, so a sweep mints the same rows once per outlet. The dedupe key is
the pack's `<coupon>:<month>`, with no outlet in it, so those copies merge into one finding.

No draft yet. Pack §6 tightens the coupon with `catalogue.coupon.set.v1`, which needs the `coupon_current` cells and
the coupon's code, kind and validity, and no template carries those (reported).
"""

from __future__ import annotations

from datetime import timedelta

from munim_intel.detect import DetectorSpec, Ladder, OutletFrame, Row, Severity, Thresholds, Window, num, register


def windows(outlet: OutletFrame, t: Thresholds) -> list[Window]:
    start = outlet.business_date - timedelta(days=t["window_days"] - 1)
    return [Window({"from": start.isoformat(), "to": outlet.business_date.isoformat()}, outlet.business_date.isoformat()[:7])]


def fires(row: Row, t: Thresholds) -> bool:
    amount = num(row, "cap_evasion_minor")
    return isinstance(row.get("coupon_id"), str) and amount is not None and amount >= t["cap_evasion_minor_gte"]


def severity(row: Row, _: Thresholds, ladder: Ladder) -> Severity:
    return ladder.of(num(row, "cap_evasion_minor") or 0)


def dedupe(row: Row, w: Window) -> str:
    return f"{row['coupon_id']}:{w.key}"


SPEC = register(
    DetectorSpec(
        id="customers.coupon_cap_evasion",
        pack="customers",
        template="customers.coupon_leakage",
        finding_type="customers.coupon_cap_evasion",
        impact_column="cap_evasion_minor",
        windows=windows,
        fires=fires,
        severity=severity,
        dedupe=dedupe,
        narration=(
            "This coupon was used beyond its per-customer cap by phone numbers shared across several customer records: "
            "{cap_evasion_uses} extra uses gave away {cap_evasion_minor} in discounts."
        ),
    )
)
