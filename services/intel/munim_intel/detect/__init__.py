"""Detectors (ADR-014 §3.3 row 1, 04 §5, packs/*.md §4): a detector is a snapshot template plus a threshold rule over
its cells. No model is involved: which rows fire, how severe they are and how they dedupe is code over typed cells.

Thresholds and the severity ladder are country-pack data (`detectors.<id>`, `severity_ladder`; rule 7), handed in by
the run's Frame — never constants here. A spec carries only shape: the template, the params it is minted with
(ids, dates, a window), and which columns it reads.

Pack lanes add a detector by writing a module under `munim_intel/watch/detectors/<pack>/` that calls `register(...)`
and importing it from that package's `__init__`. `register` refuses a pack that is not a specialist (F8);
tests/watch/test_detect.py checks every registered id against the specialist registry's own detector list
(packages/contracts/src/intel/specialists.ts, read through node), so a detector cannot be filed under another specialist.
"""

from __future__ import annotations

from collections.abc import Callable, Mapping
from dataclasses import dataclass, field
from datetime import date
from typing import TYPE_CHECKING, Any, Literal

from munim_intel.runtime.state import PACKS

if TYPE_CHECKING:
    from munim_intel.mapping import DraftMapping

Severity = Literal["low", "medium", "high", "critical"]
OutletKind = Literal["restaurant", "cloud_kitchen", "store"]
Cell = str | int | bool | None
Row = Mapping[str, Cell]
Thresholds = Mapping[str, int]

SEVERITIES: tuple[Severity, ...] = ("low", "medium", "high", "critical")
#: Full coverage (basis points) — the confidence of a detector whose pack names no coverage cell (see `coverage_column`).
FULL_COVERAGE_BP = 10_000


@dataclass(frozen=True)
class Ladder:
    """The pack's monthly-impact ladder **L** (packs/catalogue.md header), in pack minor units."""

    critical_minor_gte: int
    high_minor_gte: int
    medium_minor_gte: int

    def of(self, monthly_impact_minor: int) -> Severity:
        if monthly_impact_minor >= self.critical_minor_gte:
            return "critical"
        if monthly_impact_minor >= self.high_minor_gte:
            return "high"
        if monthly_impact_minor >= self.medium_minor_gte:
            return "medium"
        return "low"


def at_least(severity: Severity, floor: Severity) -> Severity:
    return severity if SEVERITIES.index(severity) >= SEVERITIES.index(floor) else floor


@dataclass(frozen=True)
class OutletFrame:
    id: str
    kind: OutletKind
    #: The outlet's business date now, from core's one tz module (run-frame), never computed in intel.
    business_date: date


@dataclass(frozen=True)
class Window:
    """What a detector mints for one outlet: template params, plus the dedupe-key fragment the params stand for
    (e.g. the month) so a key never re-derives it from a cell."""

    params: dict[str, Any]
    key: str


@dataclass(frozen=True)
class DetectorSpec:
    #: The pack §4 id, e.g. `finance.unapproved_ad_fee`; also the dedupe key's prefix.
    id: str
    #: The specialist that owns it (F8): stamped on its findings (`pack`) and drafts (`intel:<pack>`).
    pack: str
    template: str
    #: The pack §5 finding type (dotted DB form).
    finding_type: str
    #: The pack §5 impact column: the finding's `impact_ref` cell and its ₹ eval key.
    impact_column: str
    #: (outlet, thresholds) -> the windows to mint for that outlet.
    windows: Callable[[OutletFrame, Thresholds], list[Window]]
    #: Rows that are not detections (a Σ row with null ids) are skipped by `fires` itself.
    fires: Callable[[Row, Thresholds], bool]
    severity: Callable[[Row, Thresholds, Ladder], Severity]
    #: (row, window) -> dedupe-key suffix (pack §4 column, ids lower-case).
    dedupe: Callable[[Row, Window], str]
    #: Template narration: prose with `{column}` slots, each replaced by that cell's canonical ref. No digits.
    narration: str
    #: Event types that make this detector worth running now (04 §5); a sweep runs every detector.
    watches: frozenset[str] = frozenset()
    outlet_kinds: frozenset[OutletKind] = frozenset({"restaurant", "cloud_kitchen", "store"})
    #: ADR-014 §14 C3: `confidence_bp` is the coverage cell the pack names (same row), shown only as a band. None —
    #: the pack names none (catalogue, finance): the detector reads complete records, so FULL_COVERAGE_BP.
    coverage_column: str | None = None
    mapping: DraftMapping | None = field(default=None)

    def confidence_bp(self, row: Row) -> int:
        if self.coverage_column is None:
            return FULL_COVERAGE_BP
        value = row.get(self.coverage_column)
        if not isinstance(value, int) or isinstance(value, bool) or not 0 <= value <= FULL_COVERAGE_BP:
            # A coverage cell that is missing or out of range says nothing reliable: lowest band, never invented.
            return 0
        return value


#: pack -> its detectors, in registration order.
REGISTRY: dict[str, list[DetectorSpec]] = {}


def register(spec: DetectorSpec) -> DetectorSpec:
    if spec.pack not in PACKS:
        raise ValueError(f"detector {spec.id!r} names {spec.pack!r}, which is not a specialist")
    if any(d.id == spec.id for specs in REGISTRY.values() for d in specs):
        raise ValueError(f"detector {spec.id!r} registered twice")
    REGISTRY.setdefault(spec.pack, []).append(spec)
    return spec


def num(row: Row, column: str) -> int | None:
    """An integer cell, or None (null, or a value of another type — never coerced)."""
    v = row.get(column)
    return v if isinstance(v, int) and not isinstance(v, bool) else None
