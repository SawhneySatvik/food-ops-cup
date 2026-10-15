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

from collections.abc import Callable, Mapping, Sequence
from dataclasses import dataclass, field
from datetime import date
from typing import TYPE_CHECKING, Any, Literal

from munim_intel.runtime.state import PACKS

if TYPE_CHECKING:
    from munim_intel.mapping import DraftMapping, FollowUp

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
class LicenceKind:
    """A country-pack `licence_kinds` entry as the run-frame carries it: code and holder, and whether the pack marks the
    kind `_unverified` (its applicability is not confirmed — DECISIONS 11 Oct: never reported missing, only expiring)."""

    code: str
    holder: Literal["business", "outlet"]
    unverified: bool


@dataclass(frozen=True)
class OutletFrame:
    id: str
    kind: OutletKind
    #: The outlet's business date now, from core's one tz module (run-frame), never computed in intel.
    business_date: date
    #: The pack's licence kinds that apply to this outlet's kind (run-frame `licence_kinds`, rule 7: never named in code).
    licence_kinds: tuple[LicenceKind, ...] = ()
    #: Munim Cares is on for this outlet: enablement, active profile, active outlet (ADR-015 §4; core computes it in the
    #: run-frame). False when the frame says nothing, so a tenant that is not opted in mints no Cares snapshot at all.
    cares_active: bool = False


@dataclass(frozen=True)
class Window:
    """What a detector mints for one outlet: template params, plus the dedupe-key fragment the params stand for
    (e.g. the month) so a key never re-derives it from a cell."""

    params: dict[str, Any]
    key: str


@dataclass(frozen=True)
class Hit:
    """One detection: the row that fired, the row holding its impact cell (the same row, or a Σ row), and its severity.
    `key`: the dedupe-key suffix when it needs rows other than the firing one (a set of orders); None → `spec.dedupe`."""

    row: int
    impact_row: int
    severity: Severity
    key: str | None = None


@dataclass(frozen=True)
class Driver:
    """Enumeration: a list template minted once per outlet whose rows name what the detector's own template is minted
    for (an invoice, a stock count, a coupon, a goal) — one Window per distinct uuid in `id_column`. A row whose id cell
    is not a uuid string (a Σ row) names nothing."""

    template: str
    params: Callable[[OutletFrame, Thresholds], dict[str, Any]]
    id_column: str
    #: (listed id, outlet, thresholds) -> the detector's window for that id.
    window: Callable[[str, OutletFrame, Thresholds], Window]


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
    #: A rule over several rows (a Σ row's total, consecutive weeks, n of the last m slots): (rows, window, thresholds,
    #: ladder) -> the hits. None → `fires` and `severity` on each row, the impact on the firing row.
    select: Callable[[Sequence[Row], Window, Thresholds, Ladder], list[Hit]] | None = None
    #: Severity that needs the window or the outlet's business date (pack §4 "high if stockout ≤ tomorrow"); replaces
    #: `severity` when set. Dates come from the run-frame (core's one tz module), never from intel's clock.
    severity_at: Callable[[Row, Thresholds, Ladder, Window, OutletFrame], Severity] | None = None
    #: Windows from a list template's rows, minted in addition to `windows` (see Driver).
    driver: Driver | None = None
    #: Snapshots the mapping needs beyond the detection's own, minted after the finding is stored (see FollowUp).
    follow_ups: tuple[FollowUp, ...] = ()
    #: The `detectors.<id>.thresholds` keys the detector reads (R-B S2-A). A pack missing one abstains the detector with
    #: `no_pack_thresholds` before anything is minted, and the detector is handed only these keys, so reading another is
    #: an error the sweep traces, never a silent default.
    thresholds: tuple[str, ...] = ()
    #: The template is tenant-wide (no outlet param): minted once per run, not once per outlet, and its drafts are
    #: tenant-wide (`outlet_ids` [], owner-approved) — R-B S2-C. Runs only in a run over every outlet.
    tenant_level: bool = False
    #: A row whose narration differs (a licence that is missing has no date to cite): (row) -> the narration; None → `narration`.
    narration_for: Callable[[Row], str] | None = None
    #: T-114: the one outlet a detection is about when its template takes no outlet param (the snapshot is minted over
    #: every outlet in scope, so core cannot stamp the outlet from it): (row, window) -> the row's outlet, or None for a
    #: business-wide detection. Core accepts it only as the impact row's own `outlet_id` cell.
    finding_outlet: Callable[[Row, Window], str | None] | None = None

    def narration_of(self, row: Row) -> str:
        return self.narration if self.narration_for is None else self.narration_for(row)

    def hits(self, rows: Sequence[Row], w: Window, t: Thresholds, ladder: Ladder, outlet: OutletFrame) -> list[Hit]:
        if self.select is not None:
            return self.select(rows, w, t, ladder)
        sev = self.severity_at
        return [
            Hit(i, i, sev(r, t, ladder, w, outlet) if sev is not None else self.severity(r, t, ladder))
            for i, r in enumerate(rows)
            if self.fires(r, t)
        ]

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
