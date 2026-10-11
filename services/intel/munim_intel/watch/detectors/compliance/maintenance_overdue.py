"""`compliance.maintenance_overdue` (packs/compliance-assets.md §4, §5, §6). No answer-key plant; the offline fixture
gates it.

Template `compliance.asset_costs` for one outlet as of its business date. One row per asset; `preventive_overdue_days`
is how late the oldest scheduled preventive job is. The detector fires when that is more than
`preventive_overdue_days_gt` (14). Severity is `medium`.

The pack's dedupe key is `<asset>:<due_on>`. That job's due date is the business date minus the overdue days, because
the template measures them on the date it is minted with.

Draft (pack §6): `compliance.maintenance.schedule.v1`, a preventive job on this asset at its outlet, due today, since it
is already late. `estimated_cost_minor` is a ref to `last_preventive_cost_minor`, or null when the asset has no
completed preventive job with a cost. The vendor note is null: no model text goes into a watcher's draft. Executing
the draft writes the maintenance row under the approver (R16).
"""

from __future__ import annotations

from datetime import date, timedelta

from munim_intel.detect import DetectorSpec, Ladder, OutletFrame, Row, Severity, Thresholds, Window, num, register
from munim_intel.mapping import Detection, Proposal


def windows(outlet: OutletFrame, _: Thresholds) -> list[Window]:
    d = outlet.business_date.isoformat()
    return [Window({"outlet_id": outlet.id, "from": d, "to": d}, d)]


def fires(row: Row, t: Thresholds) -> bool:
    overdue = num(row, "preventive_overdue_days")
    return isinstance(row.get("asset_id"), str) and overdue is not None and overdue > t["preventive_overdue_days_gt"]


def severity(_row: Row, _t: Thresholds, _ladder: Ladder) -> Severity:
    return "medium"


def dedupe(row: Row, w: Window) -> str:
    due_on = date.fromisoformat(w.params["to"]) - timedelta(days=num(row, "preventive_overdue_days") or 0)
    return f"{row['asset_id']}:{due_on.isoformat()}"


def schedule(d: Detection) -> Proposal:
    asset = str(d.row["asset_id"])  # `fires` admits only rows whose asset_id is a uuid string
    overdue = d.ref("preventive_overdue_days")
    cost = d.ref("last_preventive_cost_minor") if num(d.row, "last_preventive_cost_minor") is not None else None
    return Proposal(
        command_type="compliance.maintenance.schedule.v1",
        payload={
            "outlet_id": d.outlet.id,
            "asset_id": asset,
            "kind": "preventive",
            "due_on": d.outlet.business_date.isoformat(),
            "estimated_cost_minor": cost,
            "vendor_note": None,
        },
        based_on=[overdue] if cost is None else [overdue, cost],
        targets=[asset],
        minted=["maintenance_id"],
    )


SPEC = register(
    DetectorSpec(
        id="compliance.maintenance_overdue",
        thresholds=("preventive_overdue_days_gt",),
        pack="compliance",
        template="compliance.asset_costs",
        finding_type="compliance.maintenance_overdue",
        impact_column="preventive_overdue_days",
        windows=windows,
        fires=fires,
        severity=severity,
        dedupe=dedupe,
        narration=(
            "This asset's scheduled preventive maintenance is {preventive_overdue_days} days overdue; "
            "its last preventive job cost {last_preventive_cost_minor}."
        ),
        mapping=schedule,
    )
)
