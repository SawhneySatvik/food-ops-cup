"""`compliance.missed_logs` (packs/compliance-assets.md §4, §5; plant A6; answer key CK-A6).

Template `compliance.log_coverage` for one outlet over the `window_days` (7) business days before today, ending
yesterday. Today's closing checklist may not be due yet, so today is left out; the key's window is from_offset −7 to
to_offset −1. One row per active checklist, then the temperature-log row (checklist NULL).

The detector fires when `coverage_bp` < `coverage_bp_lt` (9,000), on a daily checklist or on the temperature log, which
expects a reading every day. A checklist is daily when its `expected_runs` is at least the window's days: one outlet has
one expected run a day. Weekly and monthly checklists are left out, since the pack names "any daily checklist or temp
log". Severity is `medium`, or `high` below `high_coverage_bp_lt` (6,000).

The dedupe key is `<outlet>:<checklist>:<iso_week>`, with `temp_log` standing in for the temperature row and the window's
last day giving the week. `coverage_bp` is the finding itself, not how complete the records are, so it is not used as
confidence. No draft yet: the pack §6 task draft needs an assignee member that no template carries (reported).
"""

from __future__ import annotations

from datetime import timedelta

from munim_intel.detect import DetectorSpec, Ladder, OutletFrame, Row, Severity, Thresholds, Window, num, register


def windows(outlet: OutletFrame, t: Thresholds) -> list[Window]:
    last = outlet.business_date - timedelta(days=1)
    first = outlet.business_date - timedelta(days=t["window_days"])
    y, w, _ = last.isocalendar()
    return [Window({"outlet_id": outlet.id, "from": first.isoformat(), "to": last.isoformat()}, f"{y}-w{w:02d}")]


def fires(row: Row, t: Thresholds) -> bool:
    coverage = num(row, "coverage_bp")
    if coverage is None or coverage >= t["coverage_bp_lt"]:
        return False
    if isinstance(row.get("checklist_id"), str):
        return (num(row, "expected_runs") or 0) >= t["window_days"]
    return (num(row, "temp_expected") or 0) > 0


def severity(row: Row, t: Thresholds, _: Ladder) -> Severity:
    return "high" if (num(row, "coverage_bp") or 0) < t["high_coverage_bp_lt"] else "medium"


def dedupe(row: Row, w: Window) -> str:
    return f"{w.params['outlet_id']}:{row.get('checklist_id') or 'temp_log'}:{w.key}"


SPEC = register(
    DetectorSpec(
        id="compliance.missed_logs",
        pack="compliance",
        template="compliance.log_coverage",
        finding_type="compliance.missed_logs",
        impact_column="coverage_bp",
        windows=windows,
        fires=fires,
        severity=severity,
        dedupe=dedupe,
        narration=(
            "Records for this log were kept on fewer days than expected last week: {coverage_bp} coverage. "
            "These are evidence records, not a certificate."
        ),
    )
)
