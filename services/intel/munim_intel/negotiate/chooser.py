"""The AI half of negotiation (T-055b; ledger R45 F4; 04 §6 step 3).

Each decision round, one L1 call on the `reason` role, no tools, makes a typed choice per open supplier — accept,
counter or walk — and writes a note of at most two sentences for each. The model sees supplier letters, prices and the
rule-allowed moves (labels and integers only, never a supplier's text) and types no price: the policy re-validates every
choice (`policy.resolve`), and the message a supplier receives is the note followed by a line code renders from the
rule's values. A note that breaks the number grammar, or is over two sentences, is replaced by the template note.
Budget left at zero, a failed call or an unreadable answer → no choice → every supplier gets the rule's default move.
"""

from __future__ import annotations

import json
import re
from collections.abc import Mapping, Sequence
from dataclasses import dataclass
from typing import Protocol

from google.adk.agents import LlmAgent
from google.adk.models import BaseLlm

from munim_intel.config import Config
from munim_intel.negotiate.grammar import violation
from munim_intel.negotiate.policy import Move, Options
from munim_intel.runtime.context import RunContext
from munim_intel.runtime.runner import RunFailed, run_agent
from munim_intel.runtime.state import RunState

ACTOR = "specialist:inventory_purchasing"
TEMPLATE_NOTE = "Thank you for your quote."
MAX_NOTE_CHARS = 280

#: Tenant-invariant (implicit caching, 04 §10): the round arrives in the message.
INSTRUCTION = (
    "You negotiate a purchase for a restaurant or shop with simulated suppliers, one decision round at a time. For each "
    "supplier listed, choose exactly one move from its allowed moves: counter to push the price down while that is allowed, "
    "accept a price you judge fair, walk away from a supplier whose price stays too high. Rules set every price: never write "
    "a digit, a number word, a percent sign, a price, a quantity or a date. For each supplier also write a polite note of at "
    "most two short sentences; code adds the price line after it. Reply with a JSON object only, keyed by supplier letter: "
    '{"A": {"move": "counter", "note": "..."}}.'
)


@dataclass(frozen=True)
class View:
    letter: str
    latest_minor: int
    options: Options


@dataclass(frozen=True)
class Pick:
    #: As the chooser answered — untrusted until `policy.resolve` re-validates it.
    move: object
    note: object


class Chooser(Protocol):
    async def choose(self, round_: int, last_round: int, views: Sequence[View]) -> Mapping[str, Pick] | None: ...


def message(round_: int, last_round: int, views: Sequence[View], currency: str, unit: str) -> str:
    lines = [f"Decision round {round_} of {last_round}. Prices are integers in minor units of {currency} per {unit}."]
    for v in views:
        moves = ", ".join(
            f"counter (the rules set the counter price at {v.options.counter_minor})" if m == "counter" else m for m in v.options.allowed
        )
        lines.append(
            f"Supplier {v.letter}: latest price {v.latest_minor}; walk-away price {v.options.walk_away_minor}; allowed moves: {moves}"
        )
    return "\n".join(lines)


def parse(text: str) -> dict[str, Pick] | None:
    body = text.strip().removeprefix("```json").removeprefix("```").removesuffix("```").strip()
    try:
        data = json.loads(body)
    except ValueError:
        return None
    if not isinstance(data, dict):
        return None
    return {str(k): Pick(v.get("move"), v.get("note")) for k, v in data.items() if isinstance(v, dict)}


class LlmChooser:
    def __init__(self, llm: BaseLlm, ctx: RunContext, cfg: Config, state: RunState, *, currency: str, unit: str, calls: int) -> None:
        self.llm, self.ctx, self.cfg, self.state = llm, ctx, cfg, state
        self.currency, self.unit = currency, unit
        #: Model calls this negotiation may still make (one per decision round).
        self.calls_left = calls
        self.calls = 0

    async def choose(self, round_: int, last_round: int, views: Sequence[View]) -> Mapping[str, Pick] | None:
        if self.calls_left <= 0 or self.state.budget.models_exhausted():
            return None
        self.calls_left -= 1
        self.calls += 1
        agent = LlmAgent(name="negotiate", model=self.llm, instruction=INSTRUCTION, tools=[])
        try:
            events = await run_agent(
                agent, self.ctx, message(round_, last_round, views, self.currency, self.unit), self.cfg, state=self.state, actor=ACTOR
            )
        except RunFailed:
            return None
        parts = [p for e in events if e.is_final_response() and e.content for p in e.content.parts or []]
        text = "".join(p.text for p in parts if p.text and not p.thought)
        return parse(text)


def note_ok(note: object) -> str | None:
    """The note when it may go to the supplier: text, ≤ 2 sentences, ≤ 280 chars, no number-grammar violation."""
    if not isinstance(note, str) or not note.strip() or len(note) > MAX_NOTE_CHARS:
        return None
    if len(re.findall(r"[.!?]+(?:\s|$)", note.strip())) > 2 or violation(note) is not None:
        return None
    return note.strip()


def money(minor: int, currency: str, minor_unit: int) -> str:
    major, rest = divmod(minor, 10**minor_unit)
    return f"{currency} {major}.{rest:0{minor_unit}d}" if minor_unit else f"{currency} {major}"


def qty(milli: int) -> str:
    whole, rest = divmod(milli, 1000)
    return str(whole) if rest == 0 else f"{whole}.{rest:03d}".rstrip("0")


def compose(move: Move, note: str | None, price_minor: int, qty_milli: int, unit: str, currency: str, minor_unit: int) -> str:
    """The note (or the template note), then the line code renders from the rule's values."""
    p = money(price_minor, currency, minor_unit)
    line = {
        "counter": f"Our counter offer is {p} per {unit} for {qty(qty_milli)} {unit}.",
        "accept": f"We take your quote of {p} per {unit} for {qty(qty_milli)} {unit} to review. This is a non-binding request to a "
        "simulated supplier; no order is placed.",
        "walk": "We will not take this quote further.",
    }[move]
    return f"{note or TEMPLATE_NOTE} {line}"
