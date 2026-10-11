"""`compliance.licence_expiring` (packs/compliance-assets.md §4, §5; plant A5; answer keys RG-A5, ST-A5, AU-A5).

The template `compliance.licence_calendar` takes `required_kinds`: the outlet's licence kinds from the run-frame (the
pack's `licence_kinds` that list the outlet's kind; rule 7: no kind is named in code). It returns a row per outlet in
scope and kind; this detector keeps only its own outlet's rows.

A row fires when `days_left` ≤ `days_left_lte` (30), or when its kind is `missing` (none in force on `as_of`) and the
pack has verified that the kind applies. DECISIONS 11 Oct (W3.2): "missing" fires only for kinds that apply to the
outlet's kind and carry no `_unverified` note; expiry fires for any kind held. So each outlet mints two windows: its
verified kinds (`:required`, missing fires) and its unverified ones (`:held`, expiry only). An unverified kind whose
licence has already expired reads `missing` in v1 and is not reported; `licence_calendar` v2 (expired vs missing) is a
migrator request.

Severity is `critical` when the kind is missing or `days_left` ≤ `critical_days_left_lte` (7); otherwise `high`. Dedupe
`<outlet>:<kind>:<valid_to>`, with `missing` standing in for a missing licence's date.
"""

from __future__ import annotations

from collections.abc import Sequence

from munim_intel.detect import DetectorSpec, Hit, Ladder, OutletFrame, Row, Severity, Thresholds, Window, num, register

REQUIRED, HELD = "required", "held"


def windows(outlet: OutletFrame, _t: Thresholds) -> list[Window]:
    """Verified kinds (missing reported) and unverified kinds (expiry only), each a window when there is any kind."""
    as_of = outlet.business_date.isoformat()
    out = []
    for mode, kinds in (
        (REQUIRED, [k.code for k in outlet.licence_kinds if not k.unverified]),
        (HELD, [k.code for k in outlet.licence_kinds if k.unverified]),
    ):
        if kinds:
            out.append(Window({"as_of": as_of, "required_kinds": kinds}, f"{outlet.id}:{mode}"))
    return out


def fires(row: Row, t: Thresholds) -> bool:
    if not (isinstance(row.get("outlet_id"), str) and isinstance(row.get("kind"), str)):
        return False
    if row.get("missing") is True:
        return True
    days = num(row, "days_left")
    return days is not None and days <= t["days_left_lte"]


def severity(row: Row, t: Thresholds, _: Ladder) -> Severity:
    days = num(row, "days_left")
    return "critical" if row.get("missing") is True or (days is not None and days <= t["critical_days_left_lte"]) else "high"


def dedupe(row: Row, _: Window) -> str:
    return f"{row['outlet_id']}:{row['kind']}:{row.get('valid_to') or 'missing'}"


def select(rows: Sequence[Row], w: Window, t: Thresholds, ladder: Ladder) -> list[Hit]:
    """This window's outlet and kinds only; a `missing` row only in the verified-kinds window."""
    outlet, mode = w.key.rsplit(":", 1)
    kinds = w.params["required_kinds"]
    return [
        Hit(i, i, severity(r, t, ladder))
        for i, r in enumerate(rows)
        if r.get("outlet_id") == outlet and r.get("kind") in kinds and fires(r, t) and (mode == REQUIRED or r.get("missing") is not True)
    ]


SPEC = register(
    DetectorSpec(
        id="compliance.licence_expiring",
        pack="compliance",
        template="compliance.licence_calendar",
        finding_type="compliance.licence_expiring",
        impact_column="days_left",
        windows=windows,
        fires=fires,
        severity=severity,
        dedupe=dedupe,
        narration="A licence this outlet holds runs out soon, or none is on record: {days_left} days left, valid to {valid_to}.",
        select=select,
    )
)
