"""`purchasing.price_creep` (packs/inventory-purchasing.md §4, §5; plant I1, trap I9; answer keys RG-I1, ST-I1, AU-I1, and
the `also` of RG-C1 / RG-C1b).

Template `purchasing.price_creep` (tenant-level: its only param is `as_of`, the business date; minted once per run): price per base
unit per supplier and ingredient against its own lowest 8-week rolling median in 180 days. Like units are compared
(normalised to the base unit in the template), so a pack-size switch at the same price per unit is no creep (I9).
Fires when `creep_bp` ≥ `creep_bp_gte` (500) and `observations` ≥ `observations_gte` (2). Severity L on
`creep_impact_minor`. Dedupe `<supplier>:<ingredient>:<iso_week>` — no outlet: the template is tenant-wide
(`tenant_level`, R-B S2-C). No draft: pack §6 maps none here
(the supplier conversation is negotiation, T-055).
"""

from __future__ import annotations

from munim_intel.detect import DetectorSpec, Ladder, OutletFrame, Row, Severity, Thresholds, Window, num, register


def windows(outlet: OutletFrame, _t: Thresholds) -> list[Window]:
    year, week, _ = outlet.business_date.isocalendar()
    return [Window({"as_of": outlet.business_date.isoformat()}, f"{year}-w{week:02d}")]


def fires(row: Row, t: Thresholds) -> bool:
    creep, seen = num(row, "creep_bp"), num(row, "observations")
    ids = isinstance(row.get("supplier_id"), str) and isinstance(row.get("ingredient_id"), str)
    return ids and creep is not None and seen is not None and creep >= t["creep_bp_gte"] and seen >= t["observations_gte"]


def severity(row: Row, _: Thresholds, ladder: Ladder) -> Severity:
    return ladder.of(num(row, "creep_impact_minor") or 0)


def dedupe(row: Row, w: Window) -> str:
    return f"{row['supplier_id']}:{row['ingredient_id']}:{w.key}"


SPEC = register(
    DetectorSpec(
        id="purchasing.price_creep",
        thresholds=("creep_bp_gte", "observations_gte"),
        pack="inventory_purchasing",
        template="purchasing.price_creep",
        finding_type="purchasing.price_creep",
        impact_column="creep_impact_minor",
        windows=windows,
        fires=fires,
        severity=severity,
        dedupe=dedupe,
        tenant_level=True,
        narration=(
            "This supplier's price for this ingredient has crept up from {baseline_minor} to {latest_minor} per unit, "
            "up {creep_bp}: invoices above the earlier level cost {creep_impact_minor} more."
        ),
    )
)
