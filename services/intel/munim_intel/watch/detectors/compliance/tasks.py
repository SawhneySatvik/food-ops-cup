"""The compliance task draft (packs/compliance-assets.md §6): `goals.task.create.v1` — "renew a licence, fix log
discipline". No numeric leaves. The assignee is the outlet's manager, read from the detection row's
`manager_member_id` cell (0023 L1/L2: the outlet's own manager before an area manager); a row without one abstains with
`assignee_missing` — a mapping never guesses who should do the work (the approver can assign a task by hand).

The title is an i18n key (the task text is never free text, contracts GoalsTaskCreateV1). `based_on` cites the
manager cell (approval re-checks it: a changed manager makes the draft stale) and the finding's own measure.
"""

from __future__ import annotations

from datetime import date

from munim_intel.mapping import Abstain, Detection, Proposal

TASK = "goals.task.create.v1"


def task(d: Detection, title_key: str, measure: str, due_on: date, *, tenant_wide: bool = False) -> Proposal | Abstain:
    """`tenant_wide`: a business-wide task (a business-held licence) — no outlet, `outlet_ids` [], owner-approved."""
    manager = d.row.get("manager_member_id")
    if not isinstance(manager, str):
        return Abstain("assignee_missing")
    outlet = None if tenant_wide else d.outlet.id
    return Proposal(
        command_type=TASK,
        payload={
            "outlet_id": outlet,
            "title_key": title_key,
            "assignee_member_id": manager,
            "due_on": due_on.isoformat(),
            "finding_id": d.finding_id,
        },
        based_on=[d.ref("manager_member_id"), d.ref(measure)],
        targets=[manager] if outlet is None else [outlet, manager],
        minted=["task_id"],
        outlet_ids=[] if tenant_wide else None,
    )
