"""The negotiation run (ledger R45 F4; 04 §6; pack inventory-purchasing §6), owned by Inventory & Purchasing (F8).

  0. Every supplier is checked before anything is sent (`SupplierPort.check`: kind `simulated`, card on the configured
     suppliers-sim origin and named "Simulated supplier"); one that fails refuses the whole negotiation (NotSimulated).
  1. The same RFQ to every simulated supplier over A2A (`SupplierPort`); every message is an `a2a_send` / `a2a_receive`
     trace (actor `specialist:inventory_purchasing`, payload ids and labels only — never message text).
  2. Each reply goes to the no-tools extractor (the run is tainted from the first one) → typed fields grounded field by
     field in the reply → the reply as an untrusted chunk of this run (`chunks:batch`), then the quote with that chunk
     and each field's span in it (`quotes:batch`; simulated suppliers only — core's composite FK refuses any other). The
     approver sees each PO number beside "from the supplier's reply" with its span (DECISIONS 11 Oct, R-C F3).
  3. Decision rounds: the policy computes each open supplier's allowed moves and default; the chooser picks; the policy
     re-validates; code renders the message. A counter brings a new quote (round + 1); accept and walk close the supplier.
     After `max_counters` counters only accept or walk remain, so the run ends by itself.
  4. Deal review over the accepted quotes and the PO draft — `review.py`, deterministic, never `propose_*`.

Model calls: one extraction per reply that carries a quote (suppliers × (max_counters + 1) at most) plus one choice per
decision round — 12 for three suppliers and two counters. The caller sizes `state.budget` with `negotiation_budget`; with
less, counters stop when the budget can no longer read their replies (see `affordable` below), so a budget stop still
ends in a review. Each reviewed quote is traced as a `review` event (verdict, reason code, the two snapshots, the quote
id — ids and codes only).

intel writes nothing itself: quotes, snapshots, traces and the draft all go through core-api `/internal/intel/v1` (R25).
RFQs are non-binding and go only to simulated suppliers (R22); a PO exists only as a draft a person approves (R16).
"""

from __future__ import annotations

import string
from collections.abc import Mapping, Sequence
from dataclasses import dataclass, field
from typing import Any, Literal, Protocol

from google.adk.models import BaseLlm

from munim_intel.contracts_gen.models import (
    InternalBatchResponse,
    InternalChunksBatchRequest,
    InternalDraftsRequest,
    InternalDraftsResponse,
    InternalQuotesBatchRequest,
    InternalSnapshotsRequest,
    Snapshot,
)
from munim_intel.mapping import snap_ref, uuid7_ms
from munim_intel.negotiate import extract as ex
from munim_intel.negotiate.chooser import Chooser, View, compose, note_ok, qty
from munim_intel.negotiate.extract import Extracted, extract
from munim_intel.negotiate.policy import Move, NegotiationPolicy, Options, options, resolve
from munim_intel.negotiate.port import LABEL_SLUG, Supplier, SupplierPort
from munim_intel.negotiate.review import PoRequest, Reviewed, best, po_draft, review_quote
from munim_intel.runtime.context import RunContext
from munim_intel.runtime.state import Budget, RunState
from munim_intel.tools.generated import uuid7

ACTOR = "specialist:inventory_purchasing"


class Core(Protocol):
    """The internal routes a negotiation uses (core-api, R25); `InternalClient` implements it."""

    async def mint_snapshot(self, req: InternalSnapshotsRequest) -> Snapshot: ...
    async def write_chunks(self, req: InternalChunksBatchRequest) -> InternalBatchResponse: ...
    async def write_quotes(self, req: InternalQuotesBatchRequest) -> InternalBatchResponse: ...
    async def write_draft(self, req: InternalDraftsRequest) -> InternalDraftsResponse: ...


def negotiation_budget(suppliers: int, policy: NegotiationPolicy) -> Budget:
    """The run's model-call cap: one extraction per reply that carries a quote (each supplier's RFQ reply and one per
    counter) plus one choice per decision round — 3 × (2 + 1) + 3 = 12 for three suppliers at two counters. No
    model-facing tools run inside a negotiation (the chooser picks a typed move), so no tool calls."""
    return Budget(max_model_calls=suppliers * (policy.max_counters + 1) + policy.decision_rounds, max_tool_calls=0)


@dataclass(frozen=True)
class Rfq:
    """What to ask for. Built by `rfq_from` from two snapshot cells core minted, never typed: the quantity from the
    shortfall (pack §6: qty ← `shortfall.shortfall_qty_milli`) and the reference price from a last-price cell."""

    ingredient_id: str
    #: Tenant-trusted name (ADR-014 §6.4), sent to the simulated supplier.
    item_name: str
    unit: str
    qty_milli: int
    shortfall_ref: str
    shortfall_snapshot_id: str
    #: The tenant's last supplier price per unit: the policy's and the simulation's anchor, read from `reference_ref`.
    reference_price_minor: int
    reference_ref: str
    reference_snapshot_id: str
    currency: str
    minor_unit: int
    needed_by: str
    outlet_ids: tuple[str, ...]
    finding_id: str | None = None
    #: The business date the shortfall was read at (its snapshot's `as_of`; None = today): deal review reads the same day.
    as_of: str | None = None


def rfq_from(
    shortfall: Mapping[str, Any],
    shortfall_row: int,
    price: Mapping[str, Any],
    price_row: int,
    price_column: str,
    *,
    item_name: str,
    unit: str,
    currency: str,
    minor_unit: int,
    needed_by: str,
    outlet_ids: tuple[str, ...],
    finding_id: str | None = None,
) -> Rfq:
    """`shortfall` / `price`: core Snapshot bodies. The two rows must be the same ingredient's."""
    s, p = shortfall["rows"][shortfall_row], price["rows"][price_row]
    if s["ingredient_id"] != p["ingredient_id"]:
        raise ValueError("the shortfall and the price are not the same ingredient")
    return Rfq(
        ingredient_id=str(s["ingredient_id"]),
        item_name=item_name,
        unit=unit,
        qty_milli=int(s["shortfall_qty_milli"]),
        shortfall_ref=snap_ref(shortfall["snapshot_id"], shortfall_row, "shortfall_qty_milli"),
        shortfall_snapshot_id=str(shortfall["snapshot_id"]),
        reference_price_minor=int(p[price_column]),
        reference_ref=snap_ref(price["snapshot_id"], price_row, price_column),
        reference_snapshot_id=str(price["snapshot_id"]),
        currency=currency,
        minor_unit=minor_unit,
        needed_by=needed_by,
        outlet_ids=outlet_ids,
        finding_id=finding_id,
        as_of=shortfall["params"].get("as_of"),
    )


LegState = Literal["open", "accepted", "walked", "no_quote"]


@dataclass
class Leg:
    supplier: Supplier
    letter: str
    context_id: str
    state: LegState = "open"
    counters: int = 0
    quotes: list[dict[str, Any]] = field(default_factory=list)
    #: Why the supplier dropped out without a usable quote (extract.Extracted.reason).
    dropped: str | None = None
    #: Per stored quote, where each field was found in the reply (stored with the quote, against its source chunk).
    spans: list[dict[str, tuple[int, int]]] = field(default_factory=list)

    @property
    def price(self) -> int:
        return int(self.quotes[-1]["unit_price_minor"])


@dataclass(frozen=True)
class Decision:
    round: int
    supplier_id: str
    allowed: tuple[Move, ...]
    default: Move
    chosen: object
    move: Move
    in_set: bool
    #: The note the model wrote, as given (gates read it; it never leaves the process except in the message, and is
    #: never traced — test_negotiate_wiring asserts no trace payload carries it).
    note: object
    template_note: bool
    message: str


@dataclass
class Outcome:
    legs: list[Leg]
    decisions: list[Decision]
    reviewed: list[Reviewed]
    winner: Reviewed | None
    draft: InternalDraftsResponse | None
    draft_request: dict[str, Any] | None


async def negotiate(
    ctx: RunContext,
    rfq: Rfq,
    suppliers: Sequence[Supplier],
    *,
    port: SupplierPort,
    core: Core,
    chooser: Chooser,
    extract_llm: BaseLlm,
    state: RunState,
    policy: NegotiationPolicy,
) -> Outcome:
    """`policy`: the owner's bounds (`policy_from(run_frame)`, R47 D7) — the same object `negotiation_budget` sized the run with."""
    # Simulated only, before any message or trace (R22; R-C F4): one supplier that fails refuses the whole run.
    for s in suppliers:
        await port.check(s)
    t0 = uuid7_ms(ctx.run_id)
    read_as = ex.Rfq(rfq.item_name, rfq.unit, rfq.qty_milli, rfq.currency, rfq.minor_unit)
    legs = [Leg(s, string.ascii_uppercase[i], uuid7(t0, f"{ctx.run_id}/a2a/{s.id}")) for i, s in enumerate(suppliers)]
    decisions: list[Decision] = []

    async def send(leg: Leg, move: str, round_: int, data: dict[str, Any], text: str) -> tuple[str, str]:
        await state.traces.append("a2a_send", ACTOR, {"supplier": leg.supplier.id, "move": move, "round": str(round_), "label": LABEL_SLUG})
        try:
            reply = await port.send(leg.supplier, leg.context_id, data, text)
            outcome = "ok"
        except Exception as e:  # noqa: BLE001 — a supplier that fails drops out; only the class name is traced
            reply, outcome = "", f"error:{type(e).__name__}"
        trace_id = await state.traces.append(
            "a2a_receive", ACTOR, {"supplier": leg.supplier.id, "round": str(round_), "outcome": outcome, "label": LABEL_SLUG}
        )
        return reply, trace_id

    async def quote(round_: int, replies: list[tuple[Leg, str, str]]) -> None:
        rows: list[dict[str, Any]] = []
        chunks: list[dict[str, Any]] = []
        for leg, reply, trace_id in replies:
            # contracts ChunksBatchRequest: a chunk holds at most 8000 characters; a longer reply is not read at all.
            x = Extracted(None, "no_text" if not reply else "reply_too_long" if len(reply) > 8000 else None)
            if x.reason is None:
                x = await extract(reply, read_as, llm=extract_llm, state=state, actor=ACTOR)
            f = x.fields
            if f is None:
                leg.state, leg.dropped = "no_quote", x.reason
                await state.traces.append(
                    "abstain", ACTOR, {"supplier": leg.supplier.id, "round": str(round_), "reason": str(x.reason), "label": LABEL_SLUG}
                )
                continue
            leg.spans.append(x.spans)
            # Deterministic per (run, supplier, round): a retried batch is `existing`, never a second quote.
            chunk_id = uuid7(t0, f"{ctx.run_id}/reply/{leg.supplier.id}/{round_}")
            chunks.append({"id": chunk_id, "document_id": None, "message_id": None, "seq": 0, "char_start": 0, "text": reply})
            row = {
                "id": uuid7(t0, f"{ctx.run_id}/quote/{leg.supplier.id}/{round_}"),
                "supplier_id": leg.supplier.id,
                "ingredient_id": rfq.ingredient_id,
                "round": round_,
                "qty_milli": f.qty_milli,
                "unit": rfq.unit,
                "unit_price_minor": f.unit_price_minor,
                "currency": rfq.currency,
                "min_order_qty_milli": f.min_order_qty_milli,
                "payment_days": f.payment_days,
                "terms": {"simulated": True},
                "trace_event_id": trace_id,
                "source_chunk_id": chunk_id,
                # Every field's key: a zero minimum order or term has no token, so its span is null (contracts).
                "spans": {k: list(x.spans[k]) if k in x.spans else None for k in ex.QuoteFields.model_fields},
            }
            leg.quotes.append(row)
            rows.append(row)
        if rows:
            # quote.trace_event_id references intel.trace_event and source_chunk_id intel.chunk: both are stored first.
            await state.traces.flush()
            await core.write_chunks(InternalChunksBatchRequest.model_validate({"chunks": chunks}))
            await core.write_quotes(InternalQuotesBatchRequest.model_validate({"quotes": rows}))

    rfq_data = {
        "kind": "rfq",
        "item": rfq.item_name,
        "unit": rfq.unit,
        "qty_milli": rfq.qty_milli,
        "reference_price_minor": rfq.reference_price_minor,
        "currency": rfq.currency,
        "minor_unit": rfq.minor_unit,
        "needed_by": rfq.needed_by,
    }
    rfq_text = (
        f"Request for quote (non-binding, to a simulated supplier): {rfq.item_name}, "
        f"{qty(rfq.qty_milli)} {rfq.unit}, needed by {rfq.needed_by}."
    )
    await quote(1, [(leg, *await send(leg, "rfq", 1, rfq_data, rfq_text)) for leg in legs])

    for round_ in range(1, policy.decision_rounds + 1):
        open_legs = [leg for leg in legs if leg.state == "open"]
        if not open_legs:
            break
        # A counter's reply can be read only by a model call: counter only while the run's budget covers this round's
        # choice plus one extraction per open supplier. Otherwise accept / walk on the quotes already read.
        b = state.budget
        affordable = not b.models_exhausted() and b.max_model_calls - b.model_calls >= len(open_legs) + 1
        opts: dict[str, Options] = {}
        for leg in open_legs:
            rivals = [o.price for o in legs if o is not leg and o.quotes and o.state in ("open", "accepted")]
            opts[leg.letter] = options(policy, rfq.reference_price_minor, leg.price, rivals, leg.counters, affordable=affordable)
        picks = await chooser.choose(round_, policy.decision_rounds, [View(leg.letter, leg.price, opts[leg.letter]) for leg in open_legs])
        replies: list[tuple[Leg, str, str]] = []
        for leg in open_legs:
            o = opts[leg.letter]
            pick = (picks or {}).get(leg.letter)
            move, in_set = resolve(o, pick.move if pick else None)
            note = note_ok(pick.note) if pick else None
            price = o.counter_minor if move == "counter" and o.counter_minor is not None else leg.price
            text = compose(move, note, price, rfq.qty_milli, rfq.unit, rfq.currency, rfq.minor_unit)
            decisions.append(
                Decision(
                    round_,
                    leg.supplier.id,
                    o.allowed,
                    o.default,
                    pick.move if pick else None,
                    move,
                    in_set,
                    pick.note if pick else None,
                    note is None,
                    text,
                )
            )
            data: dict[str, Any] = {"kind": move}
            if move == "counter":
                data["unit_price_minor"] = price
            reply, trace_id = await send(leg, move, round_ + 1 if move == "counter" else round_, data, text)
            if move == "counter":
                leg.counters += 1
                replies.append((leg, reply, trace_id))
            else:
                # An acknowledgement carries no quote: it is dropped unread (only the extractor ever reads supplier text).
                leg.state = "accepted" if move == "accept" else "walked"
        if replies:
            await quote(round_ + 1, replies)

    accepted = [leg for leg in legs if leg.state == "accepted"]
    reviewed: list[Reviewed] = []
    winner: Reviewed | None = None
    body: dict[str, Any] | None = None
    draft: InternalDraftsResponse | None = None
    if accepted:
        compare = (
            await core.mint_snapshot(
                InternalSnapshotsRequest(template_id="purchasing.quote_compare", params={"negotiation_run_id": ctx.run_id})
            )
        ).model_dump(mode="json")
        index = {str(r["quote_id"]): i for i, r in enumerate(compare["rows"])}
        for leg in accepted:
            qid = leg.quotes[-1]["id"]
            inputs = (
                await core.mint_snapshot(
                    InternalSnapshotsRequest(template_id="purchasing.deal_inputs", params={"quote_id": qid, "as_of": rfq.as_of})
                )
            ).model_dump(mode="json")
            r = review_quote(compare, index[qid], inputs)
            reviewed.append(r)
            refused = r.refused
            await state.traces.review(
                ACTOR,
                "pass" if refused is None else refused.verdict,
                None if refused is None else refused.reason_code,
                [f"snap:{compare['snapshot_id']}", f"snap:{r.deal_inputs_id}"],
                qid,
            )
        winner = best(reviewed, compare)
        if winner is not None:
            body = po_draft(
                winner,
                compare,
                PoRequest(
                    ctx.run_id,
                    rfq.ingredient_id,
                    rfq.unit,
                    rfq.currency,
                    rfq.outlet_ids,
                    rfq.needed_by,
                    rfq.shortfall_ref,
                    rfq.shortfall_snapshot_id,
                    rfq.reference_ref,
                    rfq.reference_snapshot_id,
                    rfq.finding_id,
                ),
            )
            draft = await core.write_draft(InternalDraftsRequest.model_validate(body))
    await state.traces.flush()
    return Outcome(legs, decisions, reviewed, winner, draft, body)
