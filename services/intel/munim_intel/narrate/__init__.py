"""Finding narration (ADR-014 §3.2 row 2, §3.3; 04 §5).

Template narration always exists: the detector's prose with each `{column}` slot replaced by that cell's canonical
ref. It has no digit of its own, so it passes core's number grammar, and it cites the impact cell, so it passes
cite-or-abstain. It costs no model call.

Model narration is one L1 call with no tools, only for findings at `high` or above when the run's Frame allows it.
The model sees the finding type, its severity and the cell *handles* it may cite (`{S1.r0.unapproved_minor}`) — never
a cell value — and writes prose only. Handles are expanded by the run's HandleTable; whatever the model typed that is
not a handle stays as typed, so a free digit reaches core's validator, which refuses the narration (`number_grammar`).
No pre-check here (tools/grammar.py is core's grammar, used where a refusal would cost more than the line): a refused
narration leaves the template finding in place.
"""

from __future__ import annotations

import re

from google.adk.agents import LlmAgent
from google.adk.models import BaseLlm

from munim_intel.config import Config
from munim_intel.detect import DetectorSpec, Severity
from munim_intel.mapping import snap_ref
from munim_intel.runtime.context import RunContext
from munim_intel.runtime.runner import run_agent
from munim_intel.runtime.state import RunState
from munim_intel.tools.handles import HandleTable

SLOT = re.compile(r"\{([a-z_][a-z0-9_]*)\}")
_SNAP_IDS = re.compile(r"⟨snap:([0-9a-f-]{36})·")

NARRATE_AT: tuple[Severity, ...] = ("high", "critical")

#: Tenant-invariant (implicit caching, 04 §10): the finding arrives in the message, never here.
INSTRUCTION = (
    "You explain one finding to the owner of a restaurant or shop in plain English, in at most two short sentences. "
    "Cite every amount, count and date by writing the cell handle you are given, in braces, exactly as given, "
    "for example {S1.r0.amount_minor}. Never write a digit, a number word, a percent sign, a currency amount or a date "
    "yourself. Do not give advice and do not name a supplier, customer or person. Reply with the sentences only."
)


def slots(text: str) -> list[str]:
    return SLOT.findall(text)


def refs_of(text: str) -> list[str]:
    """The bare RefIds (`snap:<id>`) of every canonical snapshot ref in `text`, in first-seen order."""
    out: list[str] = []
    for sid in _SNAP_IDS.findall(text):
        if f"snap:{sid}" not in out:
            out.append(f"snap:{sid}")
    return out


def template_segments(spec: DetectorSpec, snapshot_id: str, row: int, impact_row: int, narration: str) -> list[dict[str, object]]:
    """`narration`: the firing row's (`spec.narration_of`). The impact column's slot cites the impact row (a Σ row for
    some detectors); every other slot the firing row."""
    text = SLOT.sub(lambda m: snap_ref(snapshot_id, impact_row if m.group(1) == spec.impact_column else row, m.group(1)), narration)
    return [{"text": text, "refs": [f"snap:{snapshot_id}"]}]


def message(spec: DetectorSpec, severity: Severity, handle: str, row: int, impact_row: int, narration: str) -> str:
    """The cells the narration names: the impact cell only when the row's narration cites it (a missing licence has none)."""
    named = slots(narration)
    cells = [
        *([(impact_row, spec.impact_column)] if spec.impact_column in named else []),
        *[(row, c) for c in named if c != spec.impact_column],
    ]
    listed = "\n".join(f"- {{{handle}.r{r}.{c}}}: {c}" for r, c in cells)
    return f"Finding type: {spec.finding_type}\nSeverity: {severity}\nCells you may cite:\n{listed}"


async def model_segments(
    spec: DetectorSpec,
    severity: Severity,
    snapshot: dict[str, object],
    row: int,
    impact_row: int,
    *,
    llm: BaseLlm,
    ctx: RunContext,
    cfg: Config,
    state: RunState,
    handles: HandleTable,
) -> list[dict[str, object]] | None:
    """The model's narration with handles expanded, or None (no text). RunFailed propagates to the caller."""
    handle = handles.add_snapshot(snapshot)
    agent = LlmAgent(name="narrate", model=llm, instruction=INSTRUCTION)
    rows = snapshot["rows"]
    narration = spec.narration_of(rows[row]) if isinstance(rows, list) else spec.narration
    events = await run_agent(
        agent, ctx, message(spec, severity, handle, row, impact_row, narration), cfg, state=state, actor=f"watcher:{spec.pack}"
    )
    text = "".join(p.text for e in events if e.is_final_response() and e.content for p in e.content.parts or [] if p.text and not p.thought)
    text = handles.expand_text(text.strip())
    if not text:
        return None
    return [{"text": text[:2000], "refs": refs_of(text)}]
