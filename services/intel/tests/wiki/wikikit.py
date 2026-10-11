"""Shared fixtures for the wiki gates: a hand-built world and a recording sink."""

from __future__ import annotations

import asyncio
import functools
from collections.abc import Awaitable, Callable
from typing import Any, ParamSpec

from munim_intel.contracts_gen.models import InternalWikiBatchRequest, InternalWikiBatchResponse
from munim_intel.wiki import CellIn, ClaimIn, EntityIn, Neighbour

P = ParamSpec("P")


def aio[**P](fn: Callable[P, Awaitable[None]]) -> Callable[P, None]:
    """The suite has no async plugin (as its siblings): a test body is one asyncio.run."""

    @functools.wraps(fn)
    def run(*a: P.args, **k: P.kwargs) -> None:
        asyncio.run(fn(*a, **k))  # type: ignore[arg-type]

    return run


def vid(n: int) -> str:
    return f"01920000-0000-7000-8000-{n:012x}"


SNAP = vid(0x5AA)


def cell(key: str, value: str | int | None, snapshot: str = SNAP) -> CellIn:
    return CellIn(f"⟨snap:{snapshot}·0·{key}⟩", key, value, f"The recent {key.replace('_', ' ')} is")


def world() -> list[EntityIn]:
    """Six page-kind entities (2 suppliers, 2 ingredients, 1 item, 1 outlet) and one entity of a kind with no page."""
    return [
        EntityIn(vid(1), "supplier", "Steady Dairy", claims=(ClaimIn(vid(0xC1)),), neighbours=(Neighbour(vid(3), "ingredient"),)),
        EntityIn(vid(2), "supplier", "Fresh Greens", claims=(ClaimIn(vid(0xC2)),)),
        EntityIn(vid(3), "ingredient", "Paneer", neighbours=(Neighbour(vid(1), "supplier"),)),
        EntityIn(vid(4), "ingredient", "Spinach", neighbours=(Neighbour(vid(2), "supplier"),)),
        EntityIn(vid(5), "item", "Palak Paneer", cells=(cell("margin_minor", 40),)),
        EntityIn(vid(6), "outlet", "Main Street", cells=(cell("sales_minor", 900),)),
        EntityIn(vid(7), "person", "A Cook", claims=(ClaimIn(vid(0xC3)),)),
    ]


class RecordingSink:
    """Stores every page core would (all valid), counting calls and pages; `abstain` ids come back abstained."""

    def __init__(self, abstain_when=None) -> None:  # type: ignore[no-untyped-def]
        self.calls = 0
        self.pages: list[dict[str, Any]] = []
        self._abstain = abstain_when

    async def post(self, req: InternalWikiBatchRequest) -> InternalWikiBatchResponse:
        self.calls += 1
        out = []
        for p in req.model_dump(mode="json")["pages"]:
            bad = self._abstain is not None and self._abstain(p)
            if not bad:
                self.pages.append(p)
            status, reason = ("abstained", "number_grammar") if bad else ("stored", None)
            out.append({"page_id": p["page_id"], "version": p["version"], "status": status, "reason_code": reason})
        return InternalWikiBatchResponse.model_validate({"pages": out})
