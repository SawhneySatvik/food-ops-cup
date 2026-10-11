"""Watchers (T-043): the event and sweep entry points over the deterministic detector pipeline (`pipeline.py`).

sweep(ctx, core, frame, cfg)        a `/watch:sweep` run: every registered detector of every pack, per outlet in scope
detectors_for(event_type)           the packs and detectors an event type wakes (events/ uses it)
"""

from __future__ import annotations

from google.adk.models import BaseLlm

from munim_intel.config import Config
from munim_intel.runtime.context import RunContext
from munim_intel.trace.spend import Meter
from munim_intel.watch.frame import Frame
from munim_intel.watch.pipeline import Core, Report, WatchRun, detectors_for


async def sweep(
    ctx: RunContext, core: Core, frame: Frame, cfg: Config, *, llm: BaseLlm | None = None, meter: Meter | None = None
) -> Report:
    return await WatchRun(ctx, core, frame, cfg, llm=llm, meter=meter).run(detectors_for(None))
