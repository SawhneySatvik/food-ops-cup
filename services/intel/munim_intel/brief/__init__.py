"""Daily brief (T-054; ADR-014 §3.3 row 4, 04 §5): "what needs me today?".

Core ranks (core-api `inbox/ranking.ts`: impact x confidence x urgency, deduped, drafts attached); this module only words
the ranked items. Each item arrives as the finding's stored, core-validated text and the canonical ref of its impact cell
(a `BriefItem`). It carries no `dedupe_key`: the key can hold weeks and dates and is never shown (review R-B).

Template wording always exists: the stored text, a draft clause, and the specialist's signature. It has no digit of its
own. Model wording is at most ONE call (L1, no tools) for the whole brief: it sees item handles ({I1}), the specialist's
desk, the severity word and the kind of finding — never a value, a name or a key — and writes one line per item. Code
expands the handle into the impact cell's canonical ref and keeps a line only if it is the first line naming its item,
the model typed no ref delimiter itself, it cites only its own item's refs, and it passes core's number grammar
(tools/grammar.py: digits, number words, magnitude suffixes after a ref, quotations), so a typed number never reaches
core. Budget out, AI off, a failed call or an unusable line leaves the item on its template (rule 11). The brief is
posted as one answer (`answers`). Should core still abstain a brief that carries model lines, the template-only brief is
posted once more under its own answer id (R-E 1-A): an abstained brief is never the day's last word.
"""

from __future__ import annotations

import re
from collections.abc import Sequence
from dataclasses import dataclass
from typing import Protocol

from google.adk.agents import LlmAgent
from google.adk.models import BaseLlm

from munim_intel.config import Config
from munim_intel.contracts_gen.models import InternalAnswersRequest, InternalAnswersResponse
from munim_intel.mapping import uuid7_ms
from munim_intel.runtime.context import RunContext
from munim_intel.runtime.internal_client import InternalClient
from munim_intel.runtime.runner import RunFailed, run_agent
from munim_intel.runtime.state import RunState
from munim_intel.tools.generated import uuid7
from munim_intel.tools.grammar import ANY_REF, check_grammar, ref_ids, typed_bracket

QUESTION = "What needs me today?"
TOP = 5
DESK = {
    "catalogue": "Catalogue",
    "kitchen": "Kitchen",
    "inventory_purchasing": "Inventory and purchasing",
    "finance": "Finance",
    "people": "People",
    "customers": "Customers",
    "compliance": "Compliance",
    "market": "Market",
}
SEVERITY_WORD = {"low": "low", "medium": "medium", "high": "high", "critical": "critical"}

_HANDLE = re.compile(r"\{(I\d+)\}")
_QUOTES = "\"'`“”‘’«»"

INSTRUCTION = (
    # No literal {handle} here: ADK reads {name} in an instruction as a session-state variable.
    "You write the morning brief for the owner of a restaurant or shop: one short plain-English line per item, in the "
    "order given, on its own line. Each line must cite its item by writing that item's handle in braces, exactly as given, "
    "once. A line without its handle is discarded. Never write a digit, a number word, a percent sign, a currency amount, "
    "a date, a name or a quotation yourself. Do not give advice. Reply with the lines only."
)


@dataclass(frozen=True)
class BriefItem:
    """One ranked item, in rank order, as core hands it over. Fields hold ids, labels and core-validated text only."""

    finding_id: str
    specialist: str
    severity: str
    kind: str  # the finding type, e.g. "finance.tender_gap"
    #: The finding envelope's stored segment texts (digit-free prose with canonical refs), validated by core when stored.
    texts: tuple[str, ...]
    #: Canonical ref token of the impact cell, `⟨snap:…·row·col⟩`; None when the viewer cannot open it.
    impact_ref: str | None
    draft_ids: tuple[str, ...] = ()


@dataclass
class Report:
    items: int = 0
    model_calls: int = 0
    model_items: int = 0
    template_items: int = 0
    dropped: int = 0  # model lines dropped
    posted: bool = False
    abstained: bool = False  # core refused the brief (and its template-only re-post); nothing is shown
    reposted: bool = False  # core abstained the brief with model lines; the template-only brief was posted under a new id


class AnswerSink(Protocol):
    async def post(self, req: InternalAnswersRequest) -> InternalAnswersResponse: ...


class CoreAnswerSink:
    def __init__(self, client: InternalClient) -> None:
        self._client = client

    async def post(self, req: InternalAnswersRequest) -> InternalAnswersResponse:
        return await self._client.write_answer(req)


def clean(text: str, allowed: set[str]) -> bool:
    """The drop rule: at least one ref token, every token one of this item's, core's number grammar, and no brace, stray
    bracket, currency sign or quote outside a token."""
    tokens = ANY_REF.findall(text)
    if not tokens or any(t not in allowed for t in tokens) or len(text) > 1800:
        return False
    rest = ANY_REF.sub(" ", text)
    return not any(ch.isnumeric() or ch.isdigit() or ch in "{}⟨⟩%#₹$" or ch in _QUOTES for ch in rest) and check_grammar(text) is None


def _allowed(item: BriefItem) -> set[str]:
    out = {t for text in item.texts for t in ANY_REF.findall(text)}
    if item.impact_ref:
        out.add(item.impact_ref)
    return out


def _signature(item: BriefItem) -> str:
    return f" — {DESK.get(item.specialist, 'Munim')} desk"


def template_line(item: BriefItem) -> str | None:
    """The stored text that passes the drop rule (or, failing that, the impact cell alone), plus the draft clause."""
    allowed = _allowed(item)
    kept = [t.strip() for t in item.texts if clean(t, allowed)]
    if not kept:
        if not item.impact_ref:
            return None
        kept = [f"A {SEVERITY_WORD.get(item.severity, 'new')} finding needs your attention, impact {item.impact_ref}."]
    body = " ".join(kept)
    if item.draft_ids:
        body += " A draft is ready for your decision."
    return body


def message(items: Sequence[tuple[str, BriefItem]]) -> str:
    lines = [
        f"- {{{h}}}: {DESK.get(i.specialist, 'general')} desk, severity {SEVERITY_WORD.get(i.severity, 'unknown')}, "
        f"kind {i.kind.split('.')[-1].replace('_', ' ')}{', a draft is waiting' if i.draft_ids else ''}"
        for h, i in items
    ]
    return "Items, most important first:\n" + "\n".join(lines)


async def model_lines(
    items: Sequence[BriefItem], *, llm: BaseLlm, ctx: RunContext, cfg: Config, state: RunState, report: Report
) -> dict[int, str]:
    """index -> the model's line for that item (handle expanded), at most one model call. {} when there is nothing usable."""
    handled = [(f"I{n}", it) for n, it in enumerate(items, 1) if it.impact_ref]
    index = {f"I{n}": n - 1 for n in range(1, len(items) + 1)}
    if not handled or state.budget.models_exhausted():
        return {}
    agent = LlmAgent(name="brief", model=llm, instruction=INSTRUCTION)
    report.model_calls += 1
    try:
        events = await run_agent(agent, ctx, message(handled), cfg, state=state, actor="brief")
    except RunFailed:
        return {}
    text = "".join(p.text for e in events if e.is_final_response() and e.content for p in e.content.parts or [] if p.text and not p.thought)
    by_handle = dict(handled)
    out: dict[int, str] = {}
    seen: set[str] = set()
    for line in (ln.strip() for ln in text.splitlines()):
        if not line:
            continue
        hs = _HANDLE.findall(line)
        # Only the first line naming an item may stand for it: a refused line is not retried by a later one.
        first = len(hs) == 1 and hs[0] not in seen
        seen.update(hs)
        if not first or hs[0] not in by_handle or typed_bracket(line):
            report.dropped += 1
            continue
        it = by_handle[hs[0]]
        expanded = line.replace("{" + hs[0] + "}", it.impact_ref or "")
        if not clean(expanded, _allowed(it)):
            report.dropped += 1
            continue
        out[index[hs[0]]] = expanded
    return out


async def compile_brief(
    items: Sequence[BriefItem],
    sink: AnswerSink,
    *,
    ctx: RunContext,
    llm: BaseLlm | None = None,
    cfg: Config | None = None,
    state: RunState | None = None,
) -> Report:
    """Word the top items and post them as one answer. `llm` None means AI off: templates only, no model call."""
    top = list(items[:TOP])
    report = Report(items=len(top))
    lines: dict[int, str] = {}
    if llm is not None and cfg is not None and state is not None:
        lines = await model_lines(top, llm=llm, ctx=ctx, cfg=cfg, state=state, report=report)
    segments = _segments(top, lines, report)
    if not segments:
        return report
    resp = await sink.post(_request(f"brief:{ctx.run_id}", ctx, segments))
    if resp.abstained and report.model_items:
        # Core refused a brief carrying model lines: post the template-only brief once, under its own deterministic id (a
        # retried /brief replays both posts as stored). No model text is re-used.
        report.model_items, report.template_items, report.reposted = 0, 0, True
        resp = await sink.post(_request(f"brief:{ctx.run_id}:template", ctx, _segments(top, {}, report)))
    report.posted, report.abstained = not resp.abstained, resp.abstained
    return report


def _segments(top: Sequence[BriefItem], lines: dict[int, str], report: Report) -> list[dict[str, object]]:
    segments: list[dict[str, object]] = []
    for n, item in enumerate(top):
        model = lines.get(n)
        body = model if model is not None else template_line(item)
        if body is None:
            continue
        if model is not None and item.draft_ids:
            body += " A draft is ready for your decision."
        if model is not None:
            report.model_items += 1
        else:
            report.template_items += 1
        text = body + _signature(item)
        segments.append({"text": text, "refs": ref_ids(text)})
    return segments


def _request(seed: str, ctx: RunContext, segments: list[dict[str, object]]) -> InternalAnswersRequest:
    return InternalAnswersRequest.model_validate(
        {
            "question": QUESTION,
            "envelope": {"answer_id": uuid7(uuid7_ms(ctx.run_id), seed), "segments": segments, "abstained": False, "reason_code": None},
        }
    )
