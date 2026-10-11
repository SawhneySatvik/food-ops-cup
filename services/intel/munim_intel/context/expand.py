"""Handle expansion with a fail-closed render (ADR-014 §5.7, R25): text either comes out with every handle expanded to
the canonical ref this run's HandleTable holds, or as "cannot verify" — never half-expanded.

  unexpanded  a braced token that is not a handle of this run ({S9.r0.x} when S9 was never minted, {S1.r99.col} past
              its rows, {X} that is not a handle at all);
  forged      a ⟨…⟩ token in the text that is not a well-formed ref; or one this run neither minted nor was handed as a
              ref; or a snapshot cell of a snapshot this run minted whose row or column the snapshot does not have
              (R-E 2-B: the id alone is not enough). A vouched canonical ref counts only as the exact token; a vouched
              bare RefId (core stores `refs[]` so) vouches its id, whose cells core checked when it stored the text.

Core's validator decides again on every ref (R25); this only keeps an unverifiable piece out of a context or a payload.
"""

from __future__ import annotations

import re
from collections.abc import Iterable

from munim_intel.tools.grammar import ANY_REF, is_ref
from munim_intel.tools.handles import SNAP_CLOSE, SNAP_OPEN, HandleTable

CANNOT_VERIFY = "cannot verify"

#: Any braced token left after expansion: a handle that did not resolve, or a made-up one.
_BRACED = re.compile(r"\{[^{}]*\}")
#: A bare RefId (`snap:<uuid>`, `doc:<uuid>`, `row:<table>:<uuid>`): its id is the trailing uuid.
_REF_ID = re.compile(r"([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})")


def _ids(refs: Iterable[str]) -> set[str]:
    """The trailing uuid of each bare RefId (`snap:<uuid>`, `doc:<uuid>`, `row:<table>:<uuid>`)."""
    return {u for r in refs for u in _REF_ID.findall(r)[-1:]}


def _known(token: str, handles: HandleTable, exact: set[str], vouched_ids: set[str]) -> bool:
    if not is_ref(token):
        return False
    if token in exact or token in handles.index.values():
        return True
    tid = _REF_ID.findall(token)[-1]
    if token.startswith(f"{SNAP_OPEN}snap:"):
        _, row, column = token[len(SNAP_OPEN) : -len(SNAP_CLOSE)].split("·")
        cell = handles.has_cell(tid, int(row), column)
        if cell is not None:
            return cell
    return tid in vouched_ids


def expand(text: str, handles: HandleTable, *, refs: Iterable[str] = ()) -> str:
    """`text` with every {handle} expanded, or CANNOT_VERIFY. `refs`: the canonical refs or RefIds the text's source
    vouches for (core's validated refs of a step summary); refs typed in `text` must be among them or minted."""
    refs = tuple(refs)
    exact = {r for r in refs if r.startswith(SNAP_OPEN)}
    vouched_ids = _ids(r for r in refs if not r.startswith(SNAP_OPEN))
    if any(not _known(t, handles, exact, vouched_ids) for t in ANY_REF.findall(text)):
        return CANNOT_VERIFY
    out = handles.expand_text(text)
    return CANNOT_VERIFY if _BRACED.search(out) else out
