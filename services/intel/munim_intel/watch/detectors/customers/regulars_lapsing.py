"""`customers.regulars_lapsing` (packs/customers-growth.md §4, §5; plant G4; answer keys RG-G4, CK-G4, ST-G4, AU-G4).

Template `customers.churn_segments` for one outlet as of its business date. Its last row is the Σ row (customer NULL);
that row is the detection. The detector fires when `at_risk_count` ≥ `at_risk_count_gte` (15), or when `at_risk_count`
× 10,000 ≥ `at_risk_share_bp_gte` (1,000) × `regular_count`. It needs at least one customer at risk, because an outlet
with no regulars would otherwise pass the share test as 0 ≥ 0. Severity is L on `at_risk_spend_minor`, the at-risk
customers' 90-day spend ÷ 3. Who counts as at risk is the template's rule (an INFERENCE in 0021). Dedupe
`<outlet>:<iso_week>`.

No draft yet. The win-back campaign (pack §6) takes `audience_count` from `consented_audience`, minted on this snapshot,
and a mapping cannot mint (reported). Pack §7's `no_marketing_consent` belongs to that draft.
"""

from __future__ import annotations

from munim_intel.detect import DetectorSpec, Ladder, OutletFrame, Row, Severity, Thresholds, Window, num, register


def windows(outlet: OutletFrame, _: Thresholds) -> list[Window]:
    y, w, _day = outlet.business_date.isocalendar()
    return [Window({"outlet_id": outlet.id, "as_of": outlet.business_date.isoformat()}, f"{y}-w{w:02d}")]


def fires(row: Row, t: Thresholds) -> bool:
    at_risk, regular = num(row, "at_risk_count"), num(row, "regular_count")
    if row.get("customer_id") is not None or at_risk is None or regular is None or at_risk < 1:
        return False
    return at_risk >= t["at_risk_count_gte"] or at_risk * 10_000 >= t["at_risk_share_bp_gte"] * regular


def severity(row: Row, _: Thresholds, ladder: Ladder) -> Severity:
    return ladder.of(num(row, "at_risk_spend_minor") or 0)


def dedupe(_: Row, w: Window) -> str:
    return f"{w.params['outlet_id']}:{w.key}"


SPEC = register(
    DetectorSpec(
        id="customers.regulars_lapsing",
        pack="customers",
        template="customers.churn_segments",
        finding_type="customers.regulars_lapsing",
        impact_column="at_risk_spend_minor",
        windows=windows,
        fires=fires,
        severity=severity,
        dedupe=dedupe,
        narration=(
            "{at_risk_count} regular customers have stayed away well past their usual gap between orders, "
            "alongside {regular_count} who still come; together they spent {at_risk_spend_minor} a month."
        ),
    )
)
