"""`market.event_ahead` (packs/market-strategy.md §4, §5, §10; plants M1 → RG-M1, M1b → RG-M1b; trap M6).

Template `market.upcoming` with `days` = the pack's `days_ahead_lte` (7): approved market signals from the outlet's
business date to that many days ahead, each with its (kind, label)'s past effect on this outlet's orders. Fires when
|`hist_uplift_bp`| ≥ `abs_uplift_bp_gte` (2,000) on ≥ `occurrences_gte` (2) past occurrences and the forecast has not
reflected it: `forecast_units` within ± `unreflected_band_bp` (500) of `baseline_orders` (0022's v2 renamed v1's
`forecast_orders`: the cell sums forecast item units, so the band compares units with orders — INFERENCE, reported).
INFERENCE: a null `forecast_units` (no forecast run covers the day) counts as not reflected — nothing has priced the
event in. A row without an expected-sales cell has no impact and never fires.

Severity L on |`expected_extra_sales_minor`| (negative = fewer sales, the over-prep risk of M1b; its ₹ key is the
absolute value). Dedupe `<outlet>:<label>:<on_date>`, the label folded to the dedupe alphabet (lower-case, runs of
anything else → `_`). No draft: pack §6 links event_ahead to other specialists' drafts; a task draft needs an
assignee and the finding id, neither of which a DraftMapping holds (T-051 report).
"""

from __future__ import annotations

import re

from munim_intel.detect import DetectorSpec, Ladder, OutletFrame, Row, Severity, Thresholds, Window, num, register

BP = 10_000
_NOT_KEY = re.compile(r"[^a-z0-9_]+")


def windows(outlet: OutletFrame, t: Thresholds) -> list[Window]:
    return [Window({"outlet_id": outlet.id, "days": t["days_ahead_lte"], "as_of": outlet.business_date.isoformat()}, outlet.id)]


def unreflected(row: Row, t: Thresholds) -> bool:
    forecast, baseline = num(row, "forecast_units"), num(row, "baseline_orders")
    if forecast is None:
        return True
    if baseline is None:
        return False
    return abs(forecast - baseline) * BP <= t["unreflected_band_bp"] * baseline


def fires(row: Row, t: Thresholds) -> bool:
    uplift, occurrences = num(row, "hist_uplift_bp"), num(row, "occurrences")
    return (
        isinstance(row.get("label"), str)
        and isinstance(row.get("on_date"), str)
        and num(row, "expected_extra_sales_minor") is not None
        and uplift is not None
        and occurrences is not None
        and abs(uplift) >= t["abs_uplift_bp_gte"]
        and occurrences >= t["occurrences_gte"]
        and unreflected(row, t)
    )


def severity(row: Row, _: Thresholds, ladder: Ladder) -> Severity:
    return ladder.of(abs(num(row, "expected_extra_sales_minor") or 0))


def dedupe(row: Row, w: Window) -> str:
    label = _NOT_KEY.sub("_", str(row["label"]).lower()).strip("_")[:60] or "signal"
    return f"{w.params['outlet_id']}:{label}:{row['on_date']}"


SPEC = register(
    DetectorSpec(
        id="market.event_ahead",
        thresholds=("abs_uplift_bp_gte", "days_ahead_lte", "occurrences_gte", "unreflected_band_bp"),
        pack="market",
        template="market.upcoming",
        finding_type="market.event_ahead",
        impact_column="expected_extra_sales_minor",
        windows=windows,
        fires=fires,
        severity=severity,
        dedupe=dedupe,
        # forecast_units is not slotted: it is null whenever no forecast covers the day.
        narration=(
            "An imported event is coming up that moved this outlet's orders by {hist_uplift_bp} on its "
            "{occurrences} past occurrences; a usual day like it sells {baseline_sales_minor}, so expect "
            "{expected_extra_sales_minor} of sales above or below that."
        ),
    )
)
