"""`people.advance_unrecovered` (packs/people.md §4, §5; plant P3; answer key RG-P3). IN only: the AU pack carries no
thresholds for it, so an AU run skips it (`no_pack_thresholds`).

Template `people.advances_open` (no date param: "today" is the outlet's business date), one row per staff member with
something outstanding. Fires when `outstanding_minor` ≥ `outstanding_minor_gte` (₹2,000) and `days_since_given` >
`days_since_given_gt` (60). Severity L on `outstanding_minor`. Dedupe `<outlet>:<staff>:<month>` (pack `<staff>:<month>`,
per outlet as every watcher key). No draft (a recovery is a payroll line, drafted on request through the skill).
"""

from __future__ import annotations

from munim_intel.detect import DetectorSpec, Ladder, OutletFrame, Row, Severity, Thresholds, Window, num, register


def windows(outlet: OutletFrame, _: Thresholds) -> list[Window]:
    return [Window({"outlet_id": outlet.id, "as_of": outlet.business_date.isoformat()}, outlet.business_date.isoformat()[:7])]


def fires(row: Row, t: Thresholds) -> bool:
    owed, days = num(row, "outstanding_minor"), num(row, "days_since_given")
    if not isinstance(row.get("staff_id"), str) or owed is None or days is None:
        return False
    return owed >= t["outstanding_minor_gte"] and days > t["days_since_given_gt"]


def severity(row: Row, _: Thresholds, ladder: Ladder) -> Severity:
    return ladder.of(num(row, "outstanding_minor") or 0)


def dedupe(row: Row, w: Window) -> str:
    return f"{w.params['outlet_id']}:{row['staff_id']}:{w.key}"


SPEC = register(
    DetectorSpec(
        id="people.advance_unrecovered",
        thresholds=("days_since_given_gt", "outstanding_minor_gte"),
        pack="people",
        template="people.advances_open",
        finding_type="people.advance_unrecovered",
        impact_column="outstanding_minor",
        windows=windows,
        fires=fires,
        severity=severity,
        dedupe=dedupe,
        narration="An advance to a staff member is still outstanding at {outstanding_minor}, {days_since_given} days after it was given.",
    )
)
