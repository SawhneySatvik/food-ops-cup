"""`compliance.licence_expiring` (packs/compliance-assets.md §4, §5; plant A5; answer keys RG-A5, ST-A5, AU-A5).

The template `compliance.licence_calendar` **version 2** (migration 0023 L1) takes `required_kinds`: the outlet's
licence kinds from the run-frame (the pack's `licence_kinds` that list the outlet's kind; rule 7: no kind is named in
code). It returns a row per outlet in scope and kind, with `status` `in_force` | `expired` | `missing`; this detector
keeps only its own outlet's rows.

A row fires when its `status` is `missing` (none ever, or only superseded / not yet started) and the pack has verified
that the kind applies, or when `days_left` ≤ `days_left_lte` (30) — which an expired licence always meets, since v2
gives it `days_left` = `valid_to` − as_of capped at 0 (negative once run out). DECISIONS 11 Oct (W3.2): "missing" fires
only for kinds that apply to the outlet's kind and carry no `_unverified` note; expiry fires for any kind held, so an
expired unverified licence is reported (v1 read it as missing and lost it). Each outlet mints a window per holder and
verification that it has kinds for: verified kinds (`required`, missing fires) and unverified ones (`held`, expiry only),
for the kinds the outlet holds (`outlet`) and the kinds the business holds (`business`, the pack's `holder`).

A business-held kind (IN GST, AU ABN) is one licence for every outlet (R-B S2-D): it is filed once, by the window of the
outlet whose row for that kind comes first in the snapshot (the template orders rows by outlet id), keyed
`<kind>:<valid_to>` with no outlet, and its task is tenant-wide (`outlet_ids` [], no `outlet_id`, owner-approved) and
assigned to that first outlet's manager — a rule chosen here (no cell names who answers for a business licence).
The calendar is minted over every outlet in scope (no outlet param), so the finding of an outlet-held kind names its
outlet (`finding_outlet`, T-114) and its manager sees it with the task; a business-held kind's finding stays tenant-wide.

Severity is `critical` when the kind is missing or `days_left` ≤ `critical_days_left_lte` (7, so every expired one);
otherwise `high`. Dedupe `<outlet>:<kind>:<valid_to>` (business-held: `<kind>:<valid_to>`), with `missing` standing in
for a missing licence's date. A missing row's narration cites its status, never the null date cells.
Draft (pack §6): a `goals.task.create.v1` "renew the licence" for the outlet's manager, due on the licence's `valid_to`
while it is still ahead, else the outlet's next business day (`tasks.py`; no manager → `assignee_missing`).
"""

from __future__ import annotations

from collections.abc import Sequence
from datetime import date, timedelta

from munim_intel.detect import DetectorSpec, Hit, Ladder, OutletFrame, Row, Severity, Thresholds, Window, num, register
from munim_intel.mapping import Abstain, Detection, Proposal
from munim_intel.watch.detectors.compliance.tasks import task

REQUIRED, HELD = "required", "held"
OUTLET, BUSINESS = "outlet", "business"
TITLE = "goals.task.renew_licence"
NARRATION = "A licence on record runs out soon or has run out: {days_left} days left, valid to {valid_to}."


def _missing(row: Row) -> bool:
    return row.get("status") == "missing"


def windows(outlet: OutletFrame, _t: Thresholds) -> list[Window]:
    """Per holder, verified kinds (missing reported) and unverified kinds (expiry only), each a window when it has a kind."""
    as_of = outlet.business_date.isoformat()
    out = []
    for holder in (OUTLET, BUSINESS):
        for mode, unverified in ((REQUIRED, False), (HELD, True)):
            kinds = [k.code for k in outlet.licence_kinds if k.holder == holder and k.unverified == unverified]
            if kinds:
                out.append(Window({"as_of": as_of, "required_kinds": kinds}, f"{outlet.id}:{holder}:{mode}"))
    return out


def fires(row: Row, t: Thresholds) -> bool:
    if not (isinstance(row.get("outlet_id"), str) and isinstance(row.get("kind"), str)):
        return False
    if _missing(row):
        return True
    days = num(row, "days_left")
    return days is not None and days <= t["days_left_lte"]


def severity(row: Row, t: Thresholds, _: Ladder) -> Severity:
    days = num(row, "days_left")
    return "critical" if _missing(row) or (days is not None and days <= t["critical_days_left_lte"]) else "high"


def dedupe(row: Row, w: Window) -> str:
    when = f"{row['kind']}:{row.get('valid_to') or 'missing'}"
    return when if w.key.split(":")[1] == BUSINESS else f"{row['outlet_id']}:{when}"


def select(rows: Sequence[Row], w: Window, t: Thresholds, ladder: Ladder) -> list[Hit]:
    """This window's outlet and kinds only; a `missing` row only in a verified-kinds window; a business-held kind only
    in the window of the outlet whose row for it comes first."""
    outlet, holder, mode = w.key.split(":")
    kinds = w.params["required_kinds"]
    first: dict[object, object] = {}
    for r in rows:
        first.setdefault(r.get("kind"), r.get("outlet_id"))
    return [
        Hit(i, i, severity(r, t, ladder))
        for i, r in enumerate(rows)
        if r.get("outlet_id") == outlet
        and r.get("kind") in kinds
        and fires(r, t)
        and (mode == REQUIRED or not _missing(r))
        and (holder == OUTLET or first.get(r.get("kind")) == outlet)
    ]


def _date(v: object) -> date | None:
    try:
        return date.fromisoformat(v) if isinstance(v, str) else None
    except ValueError:
        return None


def renew(d: Detection) -> Proposal | Abstain:
    tomorrow = d.outlet.business_date + timedelta(days=1)
    valid_to = _date(d.row.get("valid_to"))
    due = valid_to if valid_to is not None and valid_to > tomorrow else tomorrow
    business = any(k.code == d.row.get("kind") and k.holder == BUSINESS for k in d.outlet.licence_kinds)
    return task(d, TITLE, "days_left" if num(d.row, "days_left") is not None else "status", due, tenant_wide=business)


def finding_outlet(row: Row, w: Window) -> str | None:
    """An outlet-held licence's finding is that outlet's (T-114); a business-held one stays tenant-wide, like its task."""
    outlet = row.get("outlet_id")
    return outlet if w.key.split(":")[1] == OUTLET and isinstance(outlet, str) else None


def narration_for(row: Row) -> str:
    if _missing(row):
        return "No licence of this kind is on record: {status}."
    return NARRATION


SPEC = register(
    DetectorSpec(
        id="compliance.licence_expiring",
        thresholds=("critical_days_left_lte", "days_left_lte"),
        pack="compliance",
        template="compliance.licence_calendar",
        finding_type="compliance.licence_expiring",
        impact_column="days_left",
        windows=windows,
        fires=fires,
        severity=severity,
        dedupe=dedupe,
        narration=NARRATION,
        narration_for=narration_for,
        finding_outlet=finding_outlet,
        select=select,
        mapping=renew,
    )
)
