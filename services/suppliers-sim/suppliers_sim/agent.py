"""One simulated supplier: prices from its personality (basis points of the RFQ's reference price), state per A2A
context. The buyer's messages are data parts (`rfq`, `counter`, `accept`, `walk`); any text part is ignored. Replies are
plain text — the minimum-order clause, when the personality has one, sits only in the terms sentence.

The sim is public with no secret (R64 X-4), so every input is bounded before it is used (C1 S3-5): a field out of range
gets the "did not understand" reply, which echoes nothing the buyer sent, and an open offer lives at most OFFER_TTL_S
with at most MAX_OFFERS held (oldest dropped first).
"""

from __future__ import annotations

import hashlib
import json
import re
import time
from collections.abc import Callable
from dataclasses import dataclass
from pathlib import Path
from typing import Any

from a2a.helpers import get_data_parts, new_text_message
from a2a.server.agent_execution import AgentExecutor, RequestContext
from a2a.server.events import EventQueue

DATA = Path(__file__).with_name("personalities.json")


#: ISO 4217 minor units (the packs' INR and AUD are 2); anything else is refused — `10**minor_unit` is formatted per reply.
MINOR_UNITS = frozenset({0, 2, 3})
#: Whole numbers only (A2A data parts arrive as JSON numbers, i.e. floats); a price or quantity above these is not a quote.
MAX_MINOR = 10**12
MAX_QTY_MILLI = 10**12
MAX_ITEM = 200
MAX_CONTEXT_ID = 200
UNIT = re.compile(r"[a-z][a-z_]{0,15}")
CURRENCY = re.compile(r"[A-Z]{3}")
OFFER_TTL_S = 30 * 60
MAX_OFFERS = 1_000


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


def whole(v: object, lo: int, hi: int) -> int | None:
    """`v` as an int when it is a whole JSON number in [lo, hi] (never a bool or a string), else None. Compared before any
    conversion, so 1e308 or NaN never becomes a huge int."""
    if isinstance(v, bool) or not isinstance(v, int | float) or not lo <= v <= hi or v != int(v):
        return None
    return int(v)


def text(v: object, pattern: re.Pattern[str] | None = None, cap: int = MAX_ITEM) -> str | None:
    if not isinstance(v, str) or not 0 < len(v) <= cap or (pattern is not None and not pattern.fullmatch(v)):
        return None
    return v


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
    def __init__(
        self,
        personality: dict[str, Any],
        label: str,
        clauses: list[str],
        clause: int | None = None,
        now: Callable[[], float] = time.monotonic,
    ) -> None:
        self.p = personality
        self.label = label
        self.clauses = clauses
        #: A fixed clause phrasing (the 10-variant gate), else one picked by the context id.
        self.clause = clause
        self.now = now
        #: context id -> (opened at, offer), oldest first.
        self.offers: dict[str, tuple[float, Offer]] = {}

    def _open(self, context_id: str) -> Offer | None:
        t = self.now()
        for k in [k for k, (at, _) in self.offers.items() if t - at >= OFFER_TTL_S]:
            del self.offers[k]
        held = self.offers.get(context_id)
        return held[1] if held else None

    def _hold(self, context_id: str, o: Offer) -> None:
        self.offers.pop(context_id, None)
        while len(self.offers) >= MAX_OFFERS:
            del self.offers[next(iter(self.offers))]
        self.offers[context_id] = (self.now(), o)

    def _rfq(self, context_id: str, msg: dict[str, Any]) -> Offer | None:
        item, unit, currency = text(msg.get("item")), text(msg.get("unit"), UNIT), text(msg.get("currency"), CURRENCY)
        q, ref = whole(msg.get("qty_milli"), 1, MAX_QTY_MILLI), whole(msg.get("reference_price_minor"), 1, MAX_MINOR)
        mu = whole(msg.get("minor_unit"), 0, 3)
        if item is None or unit is None or currency is None or q is None or ref is None or mu not in MINOR_UNITS:
            return None
        bp = int(self.p["first_bp"])
        return Offer(item, unit, q, ref, currency, mu, bp, price_minor(ref, bp), self._pick_clause(context_id, q, unit))

    def _heading(self) -> str:
        return f"{self.p['name']} ({self.label})"

    def _terms(self, o: Offer) -> str:
        text = f"Payment: net {self.p['payment_days']} days."
        if o.clause:
            text += " " + o.clause
        if self.p.get("note"):
            text += " " + str(self.p["note"])
        return text

    def _pick_clause(self, context_id: str, qty_milli: int, unit: str) -> str | None:
        factor = int(self.p["min_order_factor_bp"])
        if factor == 0:
            return None
        n = self.clause if self.clause is not None else int(hashlib.sha256(context_id.encode()).hexdigest(), 16) % len(self.clauses)
        moq = (qty_milli * factor + 9_999) // 10_000
        return self.clauses[n].format(moq=f"{qty(moq)} {unit}")

    def reply(self, context_id: str, msg: dict[str, Any]) -> str:
        kind = msg.get("kind")
        if len(context_id) > MAX_CONTEXT_ID:
            return f"{self._heading()}: we did not understand that request."
        o = self._open(context_id)
        if kind == "rfq":
            o = self._rfq(context_id, msg)
            if o is None:
                return f"{self._heading()}: we did not understand that request."
            self._hold(context_id, o)
            return (
                f"{self._heading()}: we can supply {qty(o.qty_milli)} {o.unit} of {o.item} at "
                f"{money(o.price_minor, o.currency, o.minor_unit)} per {o.unit}. {self._terms(o)}"
            )
        if o is None:
            return f"{self._heading()}: we have no open request in this conversation."
        if kind == "counter":
            asked = whole(msg.get("unit_price_minor"), 0, MAX_MINOR)
            if asked is None:
                return f"{self._heading()}: we did not understand that request."
            o.bp = max(int(self.p["floor_bp"]), o.bp - int(self.p["concede_bp_per_round"]))
            # Never below the conceded price, never above the last offer; a counter at or above the concession is met.
            o.price_minor = min(o.price_minor, max(price_minor(o.reference_minor, o.bp), asked))
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
