"""Handle expansion with a fail-closed render (ADR-014 §5.7, R25): text either comes out with every handle expanded to
the canonical ref this run's HandleTable holds, or as "cannot verify" — never half-expanded.

  unexpanded  a braced token that is not a handle of this run ({S9.r0.x} when S9 was never minted, {S1.r99.col} past
              its rows, {X} that is not a handle at all);
  forged      a canonical ⟨kind:id…⟩ typed into the text whose id this run neither minted nor was handed as a ref.

Core's validator decides again on every ref (R25); this only keeps an unverifiable piece out of a context or a payload.
"""

from __future__ import annotations

import re
from collections.abc import Iterable

from munim_intel.tools.handles import SNAP_CLOSE, SNAP_OPEN, HandleTable

CANNOT_VERIFY = "cannot verify"

#: Any braced token left after expansion: a handle that did not resolve, or a made-up one.
_BRACED = re.compile(r"\{[^{}]*\}")
#: A canonical ref ⟨snap:<id>·row·col⟩ / ⟨cite:<id>·…⟩ / ⟨doc:<id>⟩: its kind and id.
_CANONICAL = re.compile(rf"{SNAP_OPEN}([a-z]+):([^·{SNAP_CLOSE}]+)[^{SNAP_CLOSE}]*{SNAP_CLOSE}")
#: A bare RefId (`snap:<uuid>`, `doc:<uuid>`, `row:<table>:<uuid>`): its id is the trailing uuid.
_REF_ID = re.compile(r"([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})")


def _ids(refs: Iterable[str]) -> set[str]:
    out: set[str] = set()
    for r in refs:
        m = _CANONICAL.fullmatch(r)
        out.update([m.group(2)] if m else _REF_ID.findall(r))
    return out


def known_ids(handles: HandleTable) -> set[str]:
    """The ids this run minted or was handed: snapshot ids and cite ids from the table."""
    return _ids(handles.index.values())


def expand(text: str, handles: HandleTable, *, refs: Iterable[str] = ()) -> str:
    """`text` with every {handle} expanded, or CANNOT_VERIFY. `refs`: the canonical refs or RefIds the text's source
    vouches for (core's validated refs of a step summary); canonical refs typed in `text` must be among them or minted."""
    allowed = known_ids(handles) | _ids(refs)
    if any(m.group(2) not in allowed for m in _CANONICAL.finditer(text)):
        return CANNOT_VERIFY
    out = handles.expand_text(text)
    return CANNOT_VERIFY if _BRACED.search(out) else out
