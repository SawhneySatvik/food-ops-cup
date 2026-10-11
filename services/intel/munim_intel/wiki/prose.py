"""Model prose for a page (narration role, no tools, 04 §5). The model sees handles ({C1} {N1} {K1}), the entity kind and
the cells' keys, never a name, a quote or a value. Code splits its text into sentences, expands handles into canonical
refs and keeps only the sentences that pass `pages.keep`. A budget that is out, a failed run or no usable sentence leaves
the template page (rule 11: AI surfaces degrade to template, never to an error).
"""

from __future__ import annotations

import re
from typing import Protocol

from google.adk.agents import LlmAgent
from google.adk.models import BaseLlm

from munim_intel.config import Config
from munim_intel.runtime.context import RunContext
from munim_intel.runtime.runner import RunFailed, run_agent
from munim_intel.runtime.state import RunState
from munim_intel.wiki.pages import EntityIn, handles

HANDLE = re.compile(r"\{([A-Z]\d+)\}")

INSTRUCTION = (
    # No literal {handle} here: ADK reads {name} in an instruction as a session-state variable.
    "You write short wiki sentences about one entity of a restaurant or shop business. Each sentence must cite what it "
    "states by writing a handle you are given, in braces, exactly as given. A sentence without a "
    "handle is discarded. Never write a digit, a number word, a quotation, a name or a currency amount yourself. "
    "Reply with the sentences only, one to four of them."
)


class Narrator(Protocol):
    async def prose(self, e: EntityIn) -> str:
        """Raw text with `{handle}` citations; the compiler splits, expands and filters it."""
        ...


def message(e: EntityIn) -> str:
    keys = {f"K{i}": k.key for i, k in enumerate(sorted(e.cells, key=lambda c: c.key)[:20], 1)}
    lines = []
    for h in handles(e):
        what = {"C": "a recorded claim", "N": "a linked record", "K": f"a figure ({keys.get(h, '')})"}[h[0]]
        lines.append(f"- {{{h}}}: {what}")
    return f"Entity kind: {e.kind}\nHandles you may cite:\n" + "\n".join(lines)


class LlmNarrator:
    def __init__(self, llm: BaseLlm, ctx: RunContext, cfg: Config, state: RunState, *, actor: str = "manager") -> None:
        self._llm, self._ctx, self._cfg, self._state, self._actor = llm, ctx, cfg, state, actor

    async def prose(self, e: EntityIn) -> str:
        if not handles(e) or self._state.budget.models_exhausted():
            return ""
        agent = LlmAgent(name="wiki", model=self._llm, instruction=INSTRUCTION)
        try:
            events = await run_agent(agent, self._ctx, message(e), self._cfg, state=self._state, actor=self._actor)
        except RunFailed:
            return ""
        parts = [p for ev in events if ev.is_final_response() and ev.content for p in ev.content.parts or []]
        return "".join(p.text for p in parts if p.text and not p.thought)


def split_sentences(text: str) -> list[str]:
    """Split at . ! ? or a line break that is outside {…} and ⟨…⟩ (refs and handles contain dots)."""
    out: list[str] = []
    cur: list[str] = []
    depth = 0
    for ch in text:
        if ch in "{⟨":
            depth += 1
        elif ch in "}⟩":
            depth = max(0, depth - 1)
        cur.append(ch)
        if depth == 0 and ch in ".!?\n":
            out.append("".join(cur).strip())
            cur = []
    out.append("".join(cur).strip())
    return [s for s in out if s]


def expand(sentence: str, table: dict[str, str]) -> str:
    """Known handles become refs; anything else is left as typed, so the drop rule sees it."""
    return HANDLE.sub(lambda m: table.get(m.group(1), m.group(0)), sentence)
