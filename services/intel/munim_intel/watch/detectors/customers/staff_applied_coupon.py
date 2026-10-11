"""`customers.staff_applied_coupon` (packs/customers-growth.md §4, §5; plant G2; answer key CK-G2).

Template `customers.staff_coupon_use`, one row per coupon and member for one ISO week of anonymous uses (orders with no
customer) at one outlet. The detector fires when `uses` ≥ `uses_gte` and `uses` ≥ `uses_vs_outlet_median_bp_gte` ÷
10,000 × `outlet_median_uses`. The ratio is compared in integers. Severity is L on the week's `discount_minor`, and at
least `high` when more than half of the uses were paid in cash (`cash_uses` × 10,000 > `high_cash_share_bp_gt` ×
`uses`).

It mints this ISO week and the one before, so a week that ends between two sweeps is still judged whole. The dedupe key
is `<outlet>:<coupon>:<member>:<iso_week>`: the pack's key, filed per outlet as T-040 note a requires. No draft (pack §6
maps none to this finding).
"""

from __future__ import annotations

from datetime import date, timedelta

from munim_intel.detect import DetectorSpec, Ladder, OutletFrame, Row, Severity, Thresholds, Window, at_least, num, register


def iso_week(d: date) -> str:
    y, w, _ = d.isocalendar()
    return f"{y}-w{w:02d}"


def windows(outlet: OutletFrame, _: Thresholds) -> list[Window]:
    monday = outlet.business_date - timedelta(days=outlet.business_date.weekday())
    return [Window({"outlet_id": outlet.id, "week_start": m.isoformat()}, iso_week(m)) for m in (monday, monday - timedelta(days=7))]


def fires(row: Row, t: Thresholds) -> bool:
    uses, median = num(row, "uses"), num(row, "outlet_median_uses")
    if not (isinstance(row.get("coupon_id"), str) and isinstance(row.get("member_id"), str)) or uses is None or median is None:
        return False
    return uses >= t["uses_gte"] and uses * 10_000 >= t["uses_vs_outlet_median_bp_gte"] * median


def severity(row: Row, t: Thresholds, ladder: Ladder) -> Severity:
    s = ladder.of(num(row, "discount_minor") or 0)
    uses, cash = num(row, "uses") or 0, num(row, "cash_uses") or 0
    return at_least(s, "high") if cash * 10_000 > t["high_cash_share_bp_gt"] * uses else s


def dedupe(row: Row, w: Window) -> str:
    return f"{w.params['outlet_id']}:{row['coupon_id']}:{row['member_id']}:{w.key}"


SPEC = register(
    DetectorSpec(
        id="customers.staff_applied_coupon",
        thresholds=("high_cash_share_bp_gt", "uses_gte", "uses_vs_outlet_median_bp_gte"),
        pack="customers",
        template="customers.staff_coupon_use",
        finding_type="customers.staff_applied_coupon",
        impact_column="discount_minor",
        windows=windows,
        fires=fires,
        severity=severity,
        dedupe=dedupe,
        narration=(
            "A staff member applied this coupon to {uses} orders with no customer on them in a week, {cash_uses} of them "
            "paid in cash, against a typical {outlet_median_uses} for a member: {discount_minor} in discounts."
        ),
    )
)
