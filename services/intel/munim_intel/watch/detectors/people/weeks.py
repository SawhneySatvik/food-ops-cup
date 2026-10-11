"""ISO-week arithmetic for the people detectors (labels as the templates print them: `IYYY-"W"IW`)."""

from __future__ import annotations

from datetime import date, timedelta


def monday(d: date) -> date:
    return d - timedelta(days=d.weekday())


def label(d: date) -> str:
    y, w, _ = d.isocalendar()
    return f"{y}-W{w:02d}"


def start_of(week: str) -> date:
    y, w = week.split("-W")
    return date.fromisocalendar(int(y), int(w), 1)
