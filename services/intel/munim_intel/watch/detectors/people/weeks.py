"""ISO-week arithmetic for the people detectors (labels as the templates print them: `IYYY-"W"IW`)."""

from __future__ import annotations

from datetime import date, timedelta


def monday(d: date) -> date:
    return d - timedelta(days=d.weekday())


def label(d: date) -> str:
    y, w, _ = d.isocalendar()
    return f"{y}-W{w:02d}"


def start_of(week: str) -> date | None:
    """The Monday of an `IYYY-"W"IW` label; None for a cell that is not one (never a ValueError out of a detector)."""
    try:
        y, w = week.split("-W")
        return date.fromisocalendar(int(y), int(w), 1)
    except ValueError:
        return None


def day_of(v: object) -> date | None:
    """An ISO date cell, or None for a cell that is not one."""
    try:
        return date.fromisoformat(v) if isinstance(v, str) else None
    except ValueError:
        return None
