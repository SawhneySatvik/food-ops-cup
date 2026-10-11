"""`customers.coupon_spike` (packs/customers-growth.md §4, §5; plants G3 and G6 (trap); answer key CK-G3).

Its template `customers.coupon_daily` takes a required `coupon_id`, so the coupons come from a driver:
`customers.coupon_leakage` lists the coupons used over the same 28 business days that `coupon_daily` reads (the
template's own span), one window per coupon. Both templates are tenant-level (no outlet param), so the detector runs
once per run (`tenant_level`, R-B S2-C).

A day fires when all four of these hold:
- `uses` ≥ `uses_gte` (20);
- `uses` ≥ `uses_vs_median_bp_gte` (50,000) ÷ 10,000 × `median_uses`;
- `first_time_uses` ≥ `first_time_share_bp_gte` (7,000) ÷ 10,000 × `uses`, compared in integers;
- the day is not inside the send window of one of this coupon's campaigns (G6). A null `in_campaign_window` is not
  judged.

Severity is L on `excess_discount_minor`. Dedupe `<coupon>:<date>`.
"""

from __future__ import annotations

from datetime import timedelta
from typing import Any

from munim_intel.detect import DetectorSpec, Driver, Ladder, OutletFrame, Row, Severity, Thresholds, Window, num, register

#: `customers.coupon_daily` reads the 28 business days ending on `to` (its SQL: `:to - 27 … :to`).
SPAN_DAYS = 28


def coupons_used(outlet: OutletFrame, _t: Thresholds) -> dict[str, Any]:
    return {"from": (outlet.business_date - timedelta(days=SPAN_DAYS - 1)).isoformat(), "to": outlet.business_date.isoformat()}


def window(coupon_id: str, outlet: OutletFrame, _t: Thresholds) -> Window:
    return Window({"coupon_id": coupon_id, "to": outlet.business_date.isoformat()}, coupon_id)


def windows(_outlet: OutletFrame, _t: Thresholds) -> list[Window]:
    return []


def fires(row: Row, t: Thresholds) -> bool:
    uses, median, first = num(row, "uses"), num(row, "median_uses"), num(row, "first_time_uses")
    if not isinstance(row.get("used_on"), str) or uses is None or median is None or first is None:
        return False
    if row.get("in_campaign_window") is not False:
        return False
    return (
        uses >= t["uses_gte"]
        and uses * 10_000 >= t["uses_vs_median_bp_gte"] * median
        and first * 10_000 >= t["first_time_share_bp_gte"] * uses
    )


def severity(row: Row, _: Thresholds, ladder: Ladder) -> Severity:
    return ladder.of(num(row, "excess_discount_minor") or 0)


def dedupe(row: Row, w: Window) -> str:
    return f"{w.params['coupon_id']}:{row['used_on']}"


SPEC = register(
    DetectorSpec(
        id="customers.coupon_spike",
        thresholds=("first_time_share_bp_gte", "uses_gte", "uses_vs_median_bp_gte"),
        pack="customers",
        template="customers.coupon_daily",
        finding_type="customers.coupon_spike",
        impact_column="excess_discount_minor",
        windows=windows,
        fires=fires,
        severity=severity,
        dedupe=dedupe,
        narration=(
            "This coupon's uses on {used_on} jumped to {uses} against a usual {median_uses}, mostly by new customers and "
            "outside any campaign: {excess_discount_minor} more discount than on a usual day."
        ),
        driver=Driver("customers.coupon_leakage", coupons_used, "coupon_id", window),
        tenant_level=True,
    )
)
