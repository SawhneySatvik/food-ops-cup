"""`/events` handling (04 §5, §11 "event dedupe"): one run per event, under that event's own run token.

events:claim first — core keeps the first claim of an event id and answers every later one 409, so a redelivered
event is acknowledged and does nothing (no snapshot, no model call). Then the detectors that watch the event's type
run, pack by pack, behind the leading-edge `watch:claim`, inside the push request.
"""

from __future__ import annotations

from google.adk.models import BaseLlm

from munim_intel.config import Config
from munim_intel.contracts_gen.models import Cloudevent
from munim_intel.runtime.context import RunContext
from munim_intel.trace.spend import Meter
from munim_intel.watch.frame import Frame
from munim_intel.watch.pipeline import Core, Report, WatchRun, detectors_for


async def handle_event(
    event: Cloudevent, ctx: RunContext, core: Core, frame: Frame, cfg: Config, *, llm: BaseLlm | None = None, meter: Meter | None = None
) -> Report | None:
    """The run's report, or None for a redelivery (already claimed)."""
    if await core.claim_event(event.id.root) is None:
        return None
    return await WatchRun(ctx, core, frame, cfg, llm=llm, meter=meter).run(detectors_for(event.type))
