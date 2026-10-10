"""DraftMapping (ADR-014 §3.3, §5.5, §5.7): a detection → the specialist's draftable, by code. No model, no handles:
the mapping holds the snapshot id and places canonical refs (`⟨snap:<id>·<row>·<col>⟩`) at every numeric leaf, the
literal uuid of an id cell at every id leaf, and pack data (currency) at the rest. Core validates and stores the
draft as `proposed`; a named person approves it before anything changes (R16).

Draft id (review M6): UUIDv7 whose time is the finding's and whose random bits are sha256(finding id ‖ command type ‖
target ids). Not the run id and not snapshot ids, so a re-detection in a later run — which merges into the same open
finding and comes back with that finding's id — names the same draft; core answers it with 409 (same id, newer refs)
and no row is added. New-entity ids inside the payload are sha256(draft id ‖ JSON pointer), as the generated tools do.
"""

from __future__ import annotations

from collections.abc import Callable
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
class Detection:
    """What a mapping may read: the firing row and where it sits, the outlet it was minted for, the pack's currency."""

    snapshot_id: str
    row_index: int
    row: Row
    outlet: OutletFrame
    currency: str

    def ref(self, column: str) -> str:
        return snap_ref(self.snapshot_id, self.row_index, column)


@dataclass(frozen=True)
class Proposal:
    command_type: str
    #: The proposal payload without its minted id leaves (see `minted`).
    payload: dict[str, Any]
    #: Canonical refs of the cells the proposal assumes; core re-checks them at approval (stale → no execution).
    based_on: list[str]
    #: The existing entity ids the proposal acts on (they key the draft id).
    targets: list[str]
    #: Top-level payload keys that take a minted new-entity id.
    minted: list[str] = field(default_factory=list)


DraftMapping = Callable[[Detection], Proposal | None]


def draft_id(finding_id: str, p: Proposal) -> str:
    return uuid7(uuid7_ms(finding_id), "\0".join([finding_id, p.command_type, *sorted(p.targets)]))


def draft_body(pack: str, finding_id: str, d: Detection, p: Proposal) -> dict[str, Any]:
    """The `internal.drafts.request` body (a dict; the caller validates it against the generated model)."""
    did = draft_id(finding_id, p)
    payload = dict(p.payload)
    for key in p.minted:
        payload[key] = uuid7(uuid7_ms(did), f"{did}/{key}")
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
        "outlet_ids": [d.outlet.id],
        "finding_id": finding_id,
        "evidence": evidence,
        "based_on": p.based_on,
    }
