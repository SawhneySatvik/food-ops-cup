"""DraftMapping (ADR-014 §3.3, §5.5, §5.7): a detection → the specialist's draftable, by code. No model, no handles:
the mapping holds the snapshot id, and every leaf of the draft is a canonical ref (`⟨snap:<id>·<row>·<col>⟩`), the
literal uuid of an id cell, pack data (currency, an i18n key), or a date code chose from core's business date (a task's
due day, a deal's end) — never a figure intel computed. Core validates and stores the draft as `proposed`; a named
person approves it before anything changes (R16).

Draft id (review M6): UUIDv7 whose time is the finding's and whose random bits are sha256(finding id ‖ command type ‖
target ids). Not the run id and not snapshot ids, so a re-detection in a later run — which merges into the same open
finding and comes back with that finding's id — names the same draft; core answers it with 409 (same id, newer refs)
and no row is added. New-entity ids inside the payload are sha256(draft id ‖ JSON pointer), as the generated tools do.
"""

from __future__ import annotations

from collections.abc import Callable, Mapping, Sequence
from copy import deepcopy
from dataclasses import dataclass, field
from typing import Any

from munim_intel.detect import OutletFrame, Row
from munim_intel.tools.generated import uuid7

SNAP_OPEN, SNAP_CLOSE, DOT = "⟨", "⟩", "·"


def snap_ref(snapshot_id: str, row: int, column: str) -> str:
    return f"{SNAP_OPEN}snap:{snapshot_id}{DOT}{row}{DOT}{column}{SNAP_CLOSE}"


def uuid7_ms(uuid: str) -> int:
    """The unix-ms timestamp a UUIDv7 carries in its first 48 bits."""
    return int(uuid.replace("-", "")[:12], 16)


@dataclass(frozen=True)
class Minted:
    """A snapshot minted for the mapping (FollowUp): its id and rows, to cite as `⟨snap:<id>·<row>·<col>⟩`."""

    snapshot_id: str
    rows: Sequence[Row]

    def ref(self, row: int, column: str) -> str:
        return snap_ref(self.snapshot_id, row, column)


@dataclass(frozen=True)
class Detection:
    """What a mapping may read: the firing row and where it sits, the outlet it was minted for, the pack's currency;
    the window's params and every row of the same snapshot (a dispute claims each line of a Σ detection); the id core
    gave the finding; the follow-up snapshots by name; and the detector's pack thresholds (a line rule a dispute
    re-applies to pick the lines its Σ counted)."""

    snapshot_id: str
    row_index: int
    row: Row
    outlet: OutletFrame
    currency: str
    params: Mapping[str, Any] = field(default_factory=dict)
    rows: Sequence[Row] = ()
    finding_id: str | None = None
    follow: Mapping[str, Minted] = field(default_factory=dict)
    thresholds: Mapping[str, int] = field(default_factory=dict)

    def ref(self, column: str) -> str:
        return snap_ref(self.snapshot_id, self.row_index, column)


@dataclass(frozen=True)
class FollowUp:
    """A snapshot a mapping needs that the detection's own does not hold (a campaign's consented audience, a price's
    suggested amount): template plus params from the detection. The pipeline mints it after the finding is stored and
    hands it to the mapping as `follow[name]`. `params` → None: nothing to mint for this detection (not in `follow`)."""

    name: str
    template: str
    params: Callable[[Detection], dict[str, Any] | None]


@dataclass(frozen=True)
class Abstain:
    """A mapping's typed refusal (pack §7, e.g. `no_marketing_consent`): no draft, and the pipeline traces the code —
    a contracts ReasonCode, never prose."""

    reason_code: str


@dataclass(frozen=True)
class Proposal:
    command_type: str
    #: The proposal payload without its minted id leaves (see `minted`).
    payload: dict[str, Any]
    #: Canonical refs of the cells the proposal assumes; core re-checks them at approval (stale → no execution).
    based_on: list[str]
    #: The existing entity ids the proposal acts on (they key the draft id).
    targets: list[str]
    #: Payload keys that take a minted new-entity id: a top-level key, or a relative JSON pointer into an array element
    #: (`lines/0/line_id`). Same seed form as the generated tools (`<draft id>/<pointer>`), so flat keys keep their ids.
    minted: list[str] = field(default_factory=list)
    #: The draft's target outlets when they are not the detection's outlet (a coupon's own outlet list; `[]` = tenant-wide,
    #: which only an owner approves). None → `[detection outlet]`.
    outlet_ids: list[str] | None = None


DraftMapping = Callable[[Detection], Proposal | Abstain | None]


def draft_id(finding_id: str, p: Proposal) -> str:
    return uuid7(uuid7_ms(finding_id), "\0".join([finding_id, p.command_type, *sorted(p.targets)]))


def draft_body(pack: str, finding_id: str, d: Detection, p: Proposal) -> dict[str, Any]:
    """The `internal.drafts.request` body (a dict; the caller validates it against the generated model)."""
    did = draft_id(finding_id, p)
    payload = deepcopy(p.payload)  # a nested minted id is set in place; the proposal stays as the mapping built it
    for key in p.minted:
        *path, leaf = key.split("/")
        box: Any = payload
        for step in path:
            box = box[int(step)] if isinstance(box, list) else box[step]
        box[leaf] = uuid7(uuid7_ms(did), f"{did}/{key}")
    evidence: list[str] = []
    for r in p.based_on:
        sid = "snap:" + r[len(SNAP_OPEN) + len("snap:") :].split(DOT)[0]
        if sid not in evidence:
            evidence.append(sid)
    return {
        "draft_id": did,
        "pack": pack,
        "command_type": p.command_type,
        "payload": payload,
        "outlet_ids": [d.outlet.id] if p.outlet_ids is None else p.outlet_ids,
        "finding_id": finding_id,
        "evidence": evidence,
        "based_on": p.based_on,
    }
