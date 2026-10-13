"""`people.labour_pct_high` (packs/people.md §4, §5; plant P4 — not planted by T-086).

Template `people.labour_pct` over the last `consecutive_weeks` + 1 ISO weeks: per week, labour cost against net sales
and the labour target in force (`core.business_policy.labour_target_bp`). Fires on a week whose `labour_bp` ≥
`target_bp` and so did the weeks before it, `consecutive_weeks` (2) in a row. A week without a target never fires: the
template's `excess_labour_minor` is measured against the policy row, so without one there is no excess cell to cite —
the pack's `default_target_bp` would be a number intel made up (reported). Impact = that week's `excess_labour_minor`;
severity L on it × 4.3. Dedupe `<outlet>:<iso_week>`. No draft.
"""

from __future__ import annotations

from collections.abc import Sequence
from datetime import timedelta

from munim_intel.detect import DetectorSpec, Hit, Ladder, OutletFrame, Row, Severity, Thresholds, Window, num, register
from munim_intel.watch.detectors.people.weeks import label, monday, start_of


def windows(outlet: OutletFrame, t: Thresholds) -> list[Window]:
    start = monday(outlet.business_date) - timedelta(weeks=t["consecutive_weeks"])
    params = {"outlet_id": outlet.id, "from": start.isoformat(), "to": outlet.business_date.isoformat()}
    return [Window(params, label(outlet.business_date))]


def fires(row: Row, _: Thresholds) -> bool:
    """This week is at or above its own target."""
    pct, target = num(row, "labour_bp"), num(row, "target_bp")
    return isinstance(row.get("iso_week"), str) and pct is not None and target is not None and pct >= target


def severity(row: Row, _: Thresholds, ladder: Ladder) -> Severity:
    return ladder.of((num(row, "excess_labour_minor") or 0) * 43 // 10)


def select(rows: Sequence[Row], _: Window, t: Thresholds, ladder: Ladder) -> list[Hit]:
    n = t["consecutive_weeks"]
    hits = []
    for j in range(n - 1, len(rows)):
        run = rows[j - n + 1 : j + 1]
        if all(fires(r, t) for r in run) and all(consecutive(a, b) for a, b in zip(run, run[1:], strict=False)):
            hits.append(Hit(j, j, severity(rows[j], t, ladder)))
    return hits


def consecutive(a: Row, b: Row) -> bool:
    first, then = start_of(str(a["iso_week"])), start_of(str(b["iso_week"]))
    return first is not None and then is not None and then - first == timedelta(weeks=1)


def dedupe(row: Row, w: Window) -> str:
    return f"{w.params['outlet_id']}:{str(row['iso_week']).lower()}"


SPEC = register(
    DetectorSpec(
        id="people.labour_pct_high",
        thresholds=("consecutive_weeks",),
        pack="people",
        template="people.labour_pct",
        finding_type="people.labour_pct_high",
        impact_column="excess_labour_minor",
        windows=windows,
        fires=fires,
        severity=severity,
        dedupe=dedupe,
        narration=(
            "Labour cost in week {iso_week} was {labour_bp} of net sales against a target of {target_bp}, "
            "and the week before was over target too: {excess_labour_minor} above the target that week."
        ),
        select=select,
    )
)
