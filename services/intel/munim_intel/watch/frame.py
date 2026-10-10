"""The run's Frame: what a watcher needs to know about the tenant that the run token does not carry.

  pack_code, currency     the tenant's country pack (rule 7: thresholds and the ladder are pack data, not code)
  detectors, ladder       `detectors.<id>.thresholds` and `severity_ladder` from that pack
  outlets                 id, kind and business date of every outlet in the run's scope (core's one tz module)
  narration               "model" or "template" — the typed kill switch; the budget's soft cap means "template"

It comes from core's `GET /internal/intel/v1/run-frame` (T-040b, not landed): until then there is no source, and a
watcher run does nothing rather than guess a country (FrameSource returns None; the app logs `frame_unavailable`).
"""

from __future__ import annotations

from collections.abc import Awaitable, Callable, Mapping
from dataclasses import dataclass
from datetime import date
from typing import Any, Literal

from munim_intel.detect import Ladder, OutletFrame, Thresholds
from munim_intel.runtime.context import RunContext

Narration = Literal["template", "model"]


@dataclass(frozen=True)
class Frame:
    pack_code: str
    currency: str
    ladder: Ladder
    detectors: Mapping[str, Thresholds]
    outlets: tuple[OutletFrame, ...]
    narration: Narration

    def in_scope(self, ctx: RunContext) -> tuple[OutletFrame, ...]:
        if ctx.outlet_scope == ("*",):
            return self.outlets
        return tuple(o for o in self.outlets if o.id in ctx.outlet_scope)


def frame_from_pack(pack: Mapping[str, Any], outlets: list[dict[str, str]], narration: Narration) -> Frame:
    """A Frame from a country-pack document (packages/contracts/packs/<CODE>.json shape) and the outlets' rows."""
    ladder = pack["severity_ladder"]
    return Frame(
        pack_code=pack["code"],
        currency=pack["currency"]["code"],
        ladder=Ladder(ladder["critical_minor_gte"], ladder["high_minor_gte"], ladder["medium_minor_gte"]),
        detectors={k: dict(v["thresholds"]) for k, v in pack["detectors"].items()},
        outlets=tuple(OutletFrame(o["id"], o["kind"], date.fromisoformat(o["business_date"])) for o in outlets),  # type: ignore[arg-type]
        narration=narration,
    )


FrameSource = Callable[[RunContext], Awaitable[Frame | None]]


async def no_frame(_: RunContext) -> Frame | None:
    return None
