"""One simulated supplier: prices from its personality (basis points of the RFQ's reference price), state per A2A
context. The buyer's messages are data parts (`rfq`, `counter`, `accept`, `walk`); any text part is ignored. Replies are
plain text — the minimum-order clause, when the personality has one, sits only in the terms sentence.
"""

from __future__ import annotations

import hashlib
import json
from dataclasses import dataclass
from pathlib import Path
from typing import Any

from a2a.helpers import get_data_parts, new_text_message
from a2a.server.agent_execution import AgentExecutor, RequestContext
from a2a.server.events import EventQueue

DATA = Path(__file__).with_name("personalities.json")


def load_data(path: Path = DATA) -> dict[str, Any]:
    data: dict[str, Any] = json.loads(path.read_text("utf8"))
    return data


@dataclass
class Offer:
    item: str
    unit: str
    qty_milli: int
    reference_minor: int
    currency: str
    minor_unit: int
    bp: int
    price_minor: int
    clause: str | None


def price_minor(reference_minor: int, bp: int) -> int:
    """Half-up rounding of reference × bp / 10,000 (integers only)."""
    return (reference_minor * bp + 5_000) // 10_000


def money(minor: int, currency: str, minor_unit: int) -> str:
    major, rest = divmod(minor, 10**minor_unit)
    return f"{currency} {major}.{rest:0{minor_unit}d}" if minor_unit else f"{currency} {major}"


def qty(milli: int) -> str:
    whole, rest = divmod(milli, 1000)
    return str(whole) if rest == 0 else f"{whole}.{rest:03d}".rstrip("0")


class SupplierAgent(AgentExecutor):
    def __init__(self, personality: dict[str, Any], label: str, clauses: list[str], clause: int | None = None) -> None:
        self.p = personality
        self.label = label
        self.clauses = clauses
        #: A fixed clause phrasing (the 10-variant gate), else one picked by the context id.
        self.clause = clause
        self.offers: dict[str, Offer] = {}

    def _heading(self) -> str:
        return f"{self.p['name']} ({self.label})"

    def _terms(self, o: Offer) -> str:
        text = f"Payment: net {self.p['payment_days']} days."
        if o.clause:
            text += " " + o.clause
        if self.p.get("note"):
            text += " " + str(self.p["note"])
        return text

    def _pick_clause(self, context_id: str, rfq: dict[str, Any]) -> str | None:
        factor = int(self.p["min_order_factor_bp"])
        if factor == 0:
            return None
        n = self.clause if self.clause is not None else int(hashlib.sha256(context_id.encode()).hexdigest(), 16) % len(self.clauses)
        moq = (int(rfq["qty_milli"]) * factor + 9_999) // 10_000
        return self.clauses[n].format(moq=f"{qty(moq)} {rfq['unit']}")

    def reply(self, context_id: str, msg: dict[str, Any]) -> str:
        kind = msg.get("kind")
        o = self.offers.get(context_id)
        if kind == "rfq":
            bp = int(self.p["first_bp"])
            ref = int(msg["reference_price_minor"])
            o = Offer(
                str(msg["item"]),
                str(msg["unit"]),
                int(msg["qty_milli"]),
                ref,
                str(msg["currency"]),
                int(msg["minor_unit"]),
                bp,
                price_minor(ref, bp),
                self._pick_clause(context_id, msg),
            )
            self.offers[context_id] = o
            return (
                f"{self._heading()}: we can supply {qty(o.qty_milli)} {o.unit} of {o.item} at "
                f"{money(o.price_minor, o.currency, o.minor_unit)} per {o.unit}. {self._terms(o)}"
            )
        if o is None:
            return f"{self._heading()}: we have no open request in this conversation."
        if kind == "counter":
            o.bp = max(int(self.p["floor_bp"]), o.bp - int(self.p["concede_bp_per_round"]))
            # Never below the conceded price, never above the last offer; a counter at or above the concession is met.
            o.price_minor = min(o.price_minor, max(price_minor(o.reference_minor, o.bp), int(msg["unit_price_minor"])))
            return (
                f"{self._heading()}: our revised price is {money(o.price_minor, o.currency, o.minor_unit)} per {o.unit} "
                f"for {qty(o.qty_milli)} {o.unit}. {self._terms(o)}"
            )
        if kind == "accept":
            return f"{self._heading()}: noted. This is a simulated, non-binding quote: no order is placed and no money moves."
        if kind == "walk":
            return f"{self._heading()}: understood, thank you."
        return f"{self._heading()}: we did not understand that request."

    async def execute(self, context: RequestContext, event_queue: EventQueue) -> None:
        context_id = context.context_id or ""
        parts = context.message.parts if context.message is not None else []
        data = [d for d in get_data_parts(parts) if isinstance(d, dict)]
        text = self.reply(context_id, data[0] if data else {})
        await event_queue.enqueue_event(new_text_message(text, context_id=context.context_id))

    async def cancel(self, context: RequestContext, event_queue: EventQueue) -> None:
        return None
