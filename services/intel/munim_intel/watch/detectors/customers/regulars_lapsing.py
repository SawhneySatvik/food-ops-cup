"""`customers.regulars_lapsing` (packs/customers-growth.md §4, §5; plant G4; answer keys RG-G4, CK-G4, ST-G4, AU-G4).

Template `customers.churn_segments` for one outlet as of its business date. Its last row is the Σ row (customer NULL);
that row is the detection. The detector fires when `at_risk_count` ≥ `at_risk_count_gte` (15), or when `at_risk_count`
× 10,000 ≥ `at_risk_share_bp_gte` (1,000) × `regular_count`. It needs at least one customer at risk, because an outlet
with no regulars would otherwise pass the share test as 0 ≥ 0. Severity is L on `at_risk_spend_minor`, the at-risk
customers' 90-day spend ÷ 3. Who counts as at risk is the template's rule (an INFERENCE in 0021). Dedupe
`<outlet>:<iso_week>`.

Draft (R67, founder 16 Oct; T-128): the win-back campaign (pack §6), by code — the model never proposes it. Its audience is
the Σ row's `at_risk_count` and its segment is this very snapshot, so the campaign names the finding's at-risk customers and
nobody else; core admits it on a demo business only (synthetic customers: no marketing-consent count) and refuses it
everywhere else (`campaign_audience_unscoped`, the 11 Oct S1-D ruling). The message is a fixed template (`message_key`, no
placeholders), so no copy is written here. Nothing is ever sent: approved, it is queued; on a demo the owner may record it as
sent, simulated.
"""

from __future__ import annotations

from datetime import timedelta

from munim_intel.detect import DetectorSpec, Ladder, OutletFrame, Row, Severity, Thresholds, Window, num, register
from munim_intel.mapping import Detection, Proposal

CAMPAIGN = "customers.campaign.create.v1"


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


def win_back(d: Detection) -> Proposal:
    """Plain text with no digit (core's number grammar reads `name`). `send_at`: noon UTC on the day after the outlet's
    business date — that day in every pack's zones (IN +05:30, AU +10/+11) — so the screens show the planned day; intel
    computes no local time (one tz module, in core)."""
    day = d.outlet.business_date + timedelta(days=1)
    return Proposal(
        command_type=CAMPAIGN,
        payload={
            "name": "Win back regulars who have stopped coming",
            "channel": "sms",
            "outlet_ids": [d.outlet.id],
            "segment_snapshot_id": d.snapshot_id,
            "audience_count": d.ref("at_risk_count"),
            "message_key": "campaign.win_back",
            "placeholders": [],
            "coupon_id": None,
            "send_at": f"{day.isoformat()}T12:00:00Z",
            "window_from": None,
            "window_to": None,
        },
        based_on=[d.ref("at_risk_count")],
        targets=[d.outlet.id],
        minted=["campaign_id"],
    )


SPEC = register(
    DetectorSpec(
        id="customers.regulars_lapsing",
        thresholds=("at_risk_count_gte", "at_risk_share_bp_gte"),
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
        mapping=win_back,
    )
)
