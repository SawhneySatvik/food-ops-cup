"""The catalogue detectors' one window shape: the `days` business days ending on the outlet's business date (pack §4:
"14-day window"), keyed by that date's ISO week — the pack's `<iso_week>` dedupe suffix, so one finding per item per
week however often the sweep runs."""

from __future__ import annotations

from datetime import date, timedelta

from munim_intel.detect import OutletFrame, Window


def iso_week(d: date) -> str:
    year, week, _ = d.isocalendar()
    return f"{year}-w{week:02d}"


def rolling(outlet: OutletFrame, days: int, **params: object) -> Window:
    end = outlet.business_date
    start = end - timedelta(days=days - 1)
    return Window({"outlet_id": outlet.id, **params, "from": start.isoformat(), "to": end.isoformat()}, iso_week(end))
