"""The run's Frame: what a watcher needs to know about the tenant that the run token does not carry.

  pack_code, currency     the tenant's country pack (rule 7: thresholds and the ladder are pack data, not code)
  detectors, ladder       `detectors.<id>.thresholds` and `severity_ladder` from that pack
  outlets                 id, kind and business date of every outlet in the run's scope (core's one tz module), each
                          with the pack's `licence_kinds` that apply to its kind (code, holder, `_unverified` as a flag)
  payroll_scope           the pack's `payroll_scope` ("drafts" | "roster_only"): where payroll may be drafted at all
  narration               "model" or "template" — the typed kill switch; the budget's soft cap means "template"
  ai_enabled, budget_level the kill switch alone and the month's budget level (T-127): over the cap with AI on, a live run
                          narrates with a capped model (llm.over_cap), never with AI off

It comes from core's `GET /internal/intel/v1/run-frame` (T-040b; `core_frame_source`, the app's default). When core
cannot give one (unreachable, refused, an unexpected body) the source returns None and a watcher run does nothing
rather than guess a country (the app logs `frame_unavailable`). The response also carries the month's budget, which
this Frame does not keep yet (T-042 / T-082a extend it); a watcher needs only the narration mode core derived from the
budget and the kill switch. An ask's thread excerpt is not in the run-frame: it rides in core's `/ask` body.
"""

from __future__ import annotations

import logging
from collections.abc import Awaitable, Callable, Mapping, Sequence
from dataclasses import dataclass
from datetime import date
from typing import Any, Literal

import httpx

from munim_intel.config import Config, ConfigError
from munim_intel.detect import Ladder, LicenceKind, OutletFrame, Thresholds
from munim_intel.runtime.context import RunContext
from munim_intel.runtime.internal_client import PREFIX, SERVICE_SECRET_HEADER

log = logging.getLogger("munim_intel.watch.frame")

Narration = Literal["template", "model"]
PayrollScope = Literal["drafts", "roster_only"]


@dataclass(frozen=True)
class Frame:
    pack_code: str
    currency: str
    ladder: Ladder
    detectors: Mapping[str, Thresholds]
    outlets: tuple[OutletFrame, ...]
    narration: Narration
    payroll_scope: PayrollScope
    #: The month's AI budget currency (run-frame `budget.currency`): core takes spend rows only in it. None: no budget.
    budget_currency: str | None = None
    #: The typed kill switch alone (run-frame `ai_enabled`) and the month's budget level (None: no budget) — llm.over_cap's inputs.
    ai_enabled: bool = False
    budget_level: str | None = None

    @property
    def spend_currency(self) -> str:
        return self.budget_currency or self.currency

    def in_scope(self, ctx: RunContext) -> tuple[OutletFrame, ...]:
        if ctx.outlet_scope == ("*",):
            return self.outlets
        return tuple(o for o in self.outlets if o.id in ctx.outlet_scope)


def _outlet(o: Mapping[str, Any], kinds: Sequence[Mapping[str, Any]]) -> OutletFrame:
    """An outlet with the licence kinds that apply to its kind, in pack order."""
    return OutletFrame(
        o["id"],
        o["kind"],
        date.fromisoformat(o["business_date"]),
        tuple(LicenceKind(k["code"], k["holder"], bool(k["unverified"])) for k in kinds if o["kind"] in k["outlet_kinds"]),
        o.get("cares_active") is True,
    )


def _payroll_scope(v: object) -> PayrollScope:
    if v == "drafts" or v == "roster_only":
        return v
    raise ValueError("payroll_scope")


def frame_from_pack(pack: Mapping[str, Any], outlets: list[dict[str, str]], narration: Narration) -> Frame:
    """A Frame from a country-pack document (packages/contracts/packs/<CODE>.json shape) and the outlets' rows."""
    ladder = pack["severity_ladder"]
    kinds = [{**k, "unverified": bool(k.get("_unverified"))} for k in pack["licence_kinds"]]
    return Frame(
        pack_code=pack["code"],
        currency=pack["currency"]["code"],
        ladder=Ladder(ladder["critical_minor_gte"], ladder["high_minor_gte"], ladder["medium_minor_gte"]),
        detectors={k: dict(v["thresholds"]) for k, v in pack["detectors"].items()},
        outlets=tuple(_outlet(o, kinds) for o in outlets),
        narration=narration,
        payroll_scope=_payroll_scope(pack["payroll_scope"]),
    )


def frame_from_run_frame(body: Mapping[str, Any]) -> Frame:
    """A Frame from core's run-frame response (packages/contracts/src/internal `internal.run-frame.response`)."""
    ladder = body["severity_ladder"]
    narration = body["narration"]
    if narration not in ("model", "template"):
        raise ValueError("narration")
    return Frame(
        pack_code=body["pack"]["code"],
        currency=body["currency"],
        ladder=Ladder(int(ladder["critical_minor_gte"]), int(ladder["high_minor_gte"]), int(ladder["medium_minor_gte"])),
        detectors={k: {n: int(x) for n, x in v["thresholds"].items()} for k, v in body["detectors"].items()},
        outlets=tuple(_outlet(o, body["licence_kinds"]) for o in body["outlets"]),
        narration=narration,
        payroll_scope=_payroll_scope(body["payroll_scope"]),
        budget_currency=body["budget"]["currency"] if body.get("budget") else None,
        ai_enabled=body.get("ai_enabled") is True,
        budget_level=body["budget"]["level"] if body.get("budget") else None,
    )


FrameSource = Callable[[RunContext], Awaitable[Frame | None]]


async def no_frame(_: RunContext) -> Frame | None:
    return None


def core_frame_source(cfg: Config, transport: httpx.AsyncBaseTransport | None = None) -> FrameSource:
    """The run's Frame from core-api, under the run's own token (core takes tenant and scope from it alone). A GET
    writes nothing; it is not retried — a run without a frame does nothing and the next sweep covers it."""

    async def source(ctx: RunContext) -> Frame | None:
        try:
            headers = {"authorization": f"Bearer {ctx.token}", SERVICE_SECRET_HEADER: cfg.service_secret()}
            async with httpx.AsyncClient(base_url=cfg.core_url, timeout=10.0, transport=transport, headers=headers) as http:
                res = await http.get(f"{PREFIX}/run-frame")
            if not res.is_success:
                log.info("intel: run %s run-frame refused (%s)", ctx.run_id, res.status_code)
                return None
            return frame_from_run_frame(res.json())
        except (httpx.HTTPError, ConfigError, KeyError, TypeError, ValueError) as e:
            log.warning("intel: run %s run-frame unavailable: %s", ctx.run_id, type(e).__name__)
            return None

    return source
