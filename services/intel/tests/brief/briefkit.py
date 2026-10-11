"""Shared fixtures for the brief gates: five ranked items (hand-built, synthetic) and a recording sink."""

from __future__ import annotations

import asyncio
import functools
from collections.abc import Awaitable, Callable

from munim_intel.brief import BriefItem
from munim_intel.contracts_gen.models import InternalAnswersRequest, InternalAnswersResponse
from munim_intel.mapping import snap_ref


def aio[**P](fn: Callable[P, Awaitable[None]]) -> Callable[P, None]:
    """The suite has no async plugin (as its siblings): a test body is one asyncio.run."""

    @functools.wraps(fn)
    def run(*a: P.args, **k: P.kwargs) -> None:
        asyncio.run(fn(*a, **k))  # type: ignore[arg-type]

    return run


def vid(n: int) -> str:
    return f"01920000-0000-7000-8000-{n:012x}"


# (specialist, severity, kind, stored text with {ref} for the impact cell) in rank order — the restaurant_group top 5.
ROWS = (
    ("customers", "high", "customers.regulars_lapsing", "Regulars have stopped coming back, about {ref} of sales at risk."),
    ("people", "high", "people.advance_unrecovered", "Staff advances are still outstanding, {ref} in all."),
    ("finance", "medium", "finance.tender_gap", "Card and cash takings do not match the till, a gap of {ref}."),
    ("finance", "medium", "finance.missing_payout", "Delivery payouts have not arrived, {ref} is unpaid."),
    ("inventory_purchasing", "medium", "purchasing.near_duplicate_invoice", "A near-identical invoice was booked again, {ref} each time."),
)


def items(*, drafts: tuple[int, ...] = (2,)) -> list[BriefItem]:
    out = []
    for n, (spec, sev, kind, text) in enumerate(ROWS):
        ref = snap_ref(vid(0x500 + n), 0, "impact_minor")
        out.append(BriefItem(vid(0xF00 + n), spec, sev, kind, (text.format(ref=ref),), ref, (vid(0xD00 + n),) if n in drafts else ()))
    return out


class RecordingSink:
    def __init__(self) -> None:
        self.calls: list[InternalAnswersRequest] = []

    async def post(self, req: InternalAnswersRequest) -> InternalAnswersResponse:
        self.calls.append(req)
        return InternalAnswersResponse.model_validate({"answer_id": req.envelope.answer_id.root, "abstained": False, "reason_code": None})


def texts(sink: RecordingSink) -> list[str]:
    (req,) = sink.calls
    return [s.text for s in req.envelope.segments]


def reply() -> str:
    """What the recorded model says: one line per item, each citing only its handle."""
    return "\n".join(
        [
            "Lapsed regulars are the biggest money at risk today {I1}.",
            "Money lent to staff is still waiting to be recovered {I2}.",
            "The takings do not add up against the till {I3}.",
            "Payouts that should have arrived are missing {I4}.",
            "The same supplier bill looks booked twice {I5}.",
        ]
    )


__all__ = ["RecordingSink", "aio", "items", "reply", "texts", "vid"]
