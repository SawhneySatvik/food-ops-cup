"""Window arithmetic the finance detectors share. Dates are the outlet's business dates from core's one tz module
(the run-frame); nothing here reads a clock or a zone."""

from __future__ import annotations

from datetime import date, timedelta


def month_starts(today: date, n: int) -> list[date]:
    """The first day of `today`'s month and of the n − 1 months before it, newest first."""
    y, m = today.year, today.month
    out = []
    for _ in range(n):
        out.append(date(y, m, 1))
        y, m = (y, m - 1) if m > 1 else (y - 1, 12)
    return out


def month_end(first: date) -> date:
    return (first.replace(day=28) + timedelta(days=4)).replace(day=1) - timedelta(days=1)


def iso_week(d: date) -> str:
    """`2026-w41`: the ISO year and week of `d` (weeks start on Monday), lower-case as dedupe keys must be."""
    y, w, _ = d.isocalendar()
    return f"{y}-w{w:02d}"
