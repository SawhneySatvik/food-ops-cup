"""Investigation step narration (ADR-014 §7.2 step 5; ledger R45 F1, F8; T-083).

core decides the step (verdicts and status are code, never a model) and asks intel to narrate it: one item per changed
checklist entry, each with its verdict, the snapshot cells its verdict read (canonical refs) and core's template
sentence citing them. intel stores ONE answer under core's `answer_id` with core's question unchanged — one segment per
item, in order — and returns {answer_id, tainted, source}. core composes the signatures ("{Specialist}") item by item.

The model call (L1, `narrate` role, at most one per step, NO tools): the model sees the playbook id, each item's id and
verdict, and per cell a handle (C1, C2, …) with its column name — never a value, a uuid or a name — and writes one line
per item. A line is used only when it cites at least one of THAT item's handles and nothing else in braces, and the
prose passes core's number grammar (tools/grammar.py, core's own rules) and the model typed no ref delimiter itself; any
other item keeps core's template sentence (cite-or-abstain: every segment cites; nothing typed is a number). A segment the
contract still refuses is that item's template too, and nothing of the model's text reaches a log (R-E 1-B). AI off or
the month's budget spent (run-frame `narration` ≠ model), no model available, or a failed run → every item keeps its
template (rule 11: degrade to template, never to an error).

Only core's cells reach the model, so the run is never tainted (`tainted` is RunState's flag, returned as is).
"""

from __future__ import annotations

import logging
import re
from typing import Any

from google.adk.agents import LlmAgent
from google.adk.models import BaseLlm
from pydantic import ValidationError

from munim_intel.config import Config
from munim_intel.contracts_gen.models import (
    AnswerEnvelope,
    InternalAnswersRequest,
    InternalRunFrameResponse,
    InvestigationsNarrateRequest,
    InvestigationsNarrateResponse,
    Segment,
)
from munim_intel.llm import frame_over_cap, price_of, provider_of
from munim_intel.runtime.context import RunContext
from munim_intel.runtime.internal_client import InternalClient
from munim_intel.runtime.runner import RunFailed, run_agent
from munim_intel.runtime.state import RunState
from munim_intel.tools.answer import ref_id
from munim_intel.tools.grammar import ANY_REF, check_grammar, ref_ids, typed_bracket
from munim_intel.trace.buffer import TraceBuffer
from munim_intel.trace.spend import Meter, SpendBuffer, spend_currency

log = logging.getLogger("munim_intel.investigate")

#: Tenant-invariant (implicit caching). No literal braces: ADK reads {name} in an instruction as a state variable.
INSTRUCTION = (
    "You narrate one step of an investigation into a change in a restaurant or shop's margin. The verdicts are already "
    "decided; do not change or question them. For each item you are given, write exactly one line in the form "
    "item_id: sentence. Each sentence states the item's verdict in plain English and cites at least one of that item's "
    "cell handles, written in curly braces exactly as given. Never write a digit, a number word, a percent sign, a "
    "currency amount or a date yourself, and never name a supplier, customer or person. Reply with the lines only."
)

_LINE = re.compile(r"^\s*[-*]?\s*([a-z][a-z0-9_.]*)\s*:\s*(.+?)\s*$")
_HANDLE = re.compile(r"\{(C[1-9][0-9]*)\}")


def handles(req: InvestigationsNarrateRequest) -> list[dict[str, str]]:
    """One handle per cell, numbered across the step in item order: {handle: canonical ref}, per item."""
    out: list[dict[str, str]] = []
    n = 0
    for item in req.items:
        table: dict[str, str] = {}
        for cell in item.cells:
            n += 1
            table[f"C{n}"] = cell.ref
        out.append(table)
    return out


def message(req: InvestigationsNarrateRequest, tables: list[dict[str, str]]) -> str:
    lines = [f"Playbook: {req.playbook_id}", "Items:"]
    for item, table in zip(req.items, tables, strict=True):
        cited = ", ".join(f"{{{h}}} {c.column}" for h, c in zip(table, item.cells, strict=True))
        lines.append(f"- {item.item_id} (verdict: {item.verdict}); cells: {cited}")
    return "\n".join(lines)


def sentence(text: str, table: dict[str, str]) -> str | None:
    """The model's line for one item with its handles expanded, or None when it may not stand."""
    cited = _HANDLE.findall(text)
    if not cited or any(h not in table for h in cited) or typed_bracket(text):
        return None
    out = _HANDLE.sub(lambda m: table[m.group(1)], text)
    if "{" in out or "}" in out or len(out) > 2000:
        return None
    return out if check_grammar(out) is None else None


def _segment(text: str) -> dict[str, Any] | None:
    """The segment as the contract takes it, or None. Every ref-shaped token becomes a RefId, so a malformed one fails the
    contract here rather than at core. A ValidationError's text echoes its input, so it is dropped here, unlogged."""
    seg = {"text": text, "refs": list(dict.fromkeys(ref_id(t) for t in ANY_REF.findall(text)))}
    try:
        Segment.model_validate(seg)
    except ValidationError:
        return None
    return seg


def segments(req: InvestigationsNarrateRequest, tables: list[dict[str, str]], reply: str) -> tuple[list[dict[str, object]], bool]:
    """One segment per item (model line or core's template) and whether any model line was used."""
    lines: dict[str, str] = {}
    for raw in reply.splitlines():
        m = _LINE.match(raw)
        if m and m.group(1) not in lines:
            lines[m.group(1)] = m.group(2)
    out: list[dict[str, object]] = []
    used = False
    for item, table in zip(req.items, tables, strict=True):
        text = sentence(lines[item.item_id], table) if item.item_id in lines else None
        seg = _segment(text) if text is not None else None
        used = used or seg is not None
        out.append(seg or {"text": item.template, "refs": ref_ids(item.template)})
    return out, used


async def model_reply(
    ctx: RunContext, req: InvestigationsNarrateRequest, tables: list[dict[str, str]], llm: BaseLlm, cfg: Config, state: RunState
) -> str:
    """The model's raw text ('' on a failed run). One call: the budget allows one, and the agent has no tools."""
    state.budget.max_model_calls = 1
    agent = LlmAgent(name="narrate", model=llm, instruction=INSTRUCTION)
    try:
        events = await run_agent(agent, ctx, message(req, tables), cfg, state=state, actor=f"specialist:{req.owner}")
    except RunFailed as e:
        log.warning("intel: narrate run %s failed: %s", ctx.run_id, e.kind)
        return ""
    return "".join(p.text for e in events if e.is_final_response() and e.content for p in e.content.parts or [] if p.text and not p.thought)


async def narrate_step(
    ctx: RunContext,
    req: InvestigationsNarrateRequest,
    frame: InternalRunFrameResponse | None,
    client: InternalClient,
    cfg: Config,
    llm: BaseLlm | None,
) -> InvestigationsNarrateResponse:
    state = RunState(traces=TraceBuffer(client.write_traces))
    tables = handles(req)
    reply = ""
    if llm is not None and frame is not None and (frame.narration == "model" or frame_over_cap(cfg, frame)):
        # The one call is charged to the month's budget (W3 close ruling); run_agent posts the row with the traces.
        state.meter = Meter(SpendBuffer(client.write_spend, spend_currency(frame)), "narrate", provider_of(llm), llm.model, price_of(llm))
        reply = await model_reply(ctx, req, tables, llm, cfg, state)
    else:
        await state.traces.append("abstain", f"specialist:{req.owner}", {"reason": "model_blocked"})
        await state.traces.flush()
    segs, used = segments(req, tables, reply)
    envelope = AnswerEnvelope.model_validate({"answer_id": req.answer_id.root, "segments": segs, "abstained": False, "reason_code": None})
    await client.write_answer(InternalAnswersRequest(question=req.question, envelope=envelope))
    return InvestigationsNarrateResponse(answer_id=req.answer_id, tainted=state.tainted, source="model" if used else "template")
