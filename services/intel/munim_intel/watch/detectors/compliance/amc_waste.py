"""`compliance.amc_waste` (packs/compliance-assets.md §4, §5; plants A2, A3; answer keys CK-A2, CK-A3).

Template `compliance.asset_costs` for one outlet over the last `window_days` (90) business days. It has one row per
asset. `amc_waste_minor` adds two things: breakdown repairs billed outside a contract while an AMC was valid, and the
days two AMCs of the asset overlap, priced at the earlier contract's daily cost. The detector fires when that sum is at
least `amc_waste_minor_gte` (IN ₹1,000, AU A$20). Severity is L. Dedupe `<asset>:<quarter>`, the quarter being the
business date's. No draft (pack §6 maps none).
"""

from __future__ import annotations

from datetime import timedelta

from munim_intel.detect import DetectorSpec, Ladder, OutletFrame, Row, Severity, Thresholds, Window, num, register


def windows(outlet: OutletFrame, t: Thresholds) -> list[Window]:
    d = outlet.business_date
    start = d - timedelta(days=t["window_days"] - 1)
    return [Window({"outlet_id": outlet.id, "from": start.isoformat(), "to": d.isoformat()}, f"{d.year}-q{(d.month - 1) // 3 + 1}")]


def fires(row: Row, t: Thresholds) -> bool:
    waste = num(row, "amc_waste_minor")
    return isinstance(row.get("asset_id"), str) and waste is not None and waste >= t["amc_waste_minor_gte"]


def severity(row: Row, _: Thresholds, ladder: Ladder) -> Severity:
    return ladder.of(num(row, "amc_waste_minor") or 0)


def dedupe(row: Row, w: Window) -> str:
    return f"{row['asset_id']}:{w.key}"


SPEC = register(
    DetectorSpec(
        id="compliance.amc_waste",
        thresholds=("amc_waste_minor_gte", "window_days"),
        pack="compliance",
        template="compliance.asset_costs",
        finding_type="compliance.amc_waste",
        impact_column="amc_waste_minor",
        windows=windows,
        fires=fires,
        severity=severity,
        dedupe=dedupe,
        narration=(
            "This asset's maintenance is being paid for over cover it already has: {repairs_under_amc_minor} in repairs "
            "billed while a contract was valid, and {amc_overlap_minor} for {amc_overlap_days} days of overlapping "
            "contracts, {amc_waste_minor} in all."
        ),
    )
)
