"""`POST /negotiate` (T-114): a person's request for quotes, run end to end (pack inventory-purchasing §6 "Trigger: … or
a person's ask"). core-api's `POST /v1/rfq-requests` records the person's command, mints an `ask` run whose actor is the
person and whose scope is exactly the outlets they chose, and calls this route with its own reads of the tenant (the
ingredient's name and unit, the simulated suppliers with an agent card, the items sold). intel writes nothing itself:
every row goes through core's `/internal/intel/v1` under the run token (R25).

  1. The forecast the shortfall and the deal review read: per chosen outlet and item, `forecast.sales_history` over the
     last HISTORY_DAYS business days to yesterday → the deterministic engine (T-052; no model) → one forecast run of the
     shipped method with both methods' points (`forecasts:batch`). It becomes the tenant's latest run, which every
     forecast-reading template reads; it covers every item sold at those outlets so that no other ingredient's use drops.
  2. The RFQ quantity is the cell `inventory.shortfall.shortfall_qty_milli` over the run's outlets at LEAD_DAYS, as of the
     run frame's business date — never a typed number. No shortfall → `no_shortfall`: no supplier is contacted and no
     model is called.
  3. The reference price is `purchasing.price_creep.latest_minor`: the lowest last price any supplier holds for the
     ingredient (the buyer's anchor; the policy's target and walk-away are basis points of it).
  4. `run.negotiate` with the person's chosen outlets: simulated suppliers only (checked before anything is sent), the
     no-tools extractor, the chooser within the rules, deterministic deal review, and at most one PO **draft** whose
     outlet ids are the chosen outlets and whose numbers are `purchasing.quote_compare` cells. Nothing auto-applies (R16).

The answer is ids and a status code only. Every refusal of a caller is the same 401, as in app.py; nothing returned
carries model text, supplier text, a token or an exception message.
"""

from __future__ import annotations

import hmac
import logging
import time
from collections.abc import Awaitable, Callable
from datetime import date, timedelta
from typing import Any, Protocol

import httpx
from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PublicKey
from fastapi import APIRouter, Request
from fastapi.responses import JSONResponse
from google.adk.models import BaseLlm
from pydantic import ValidationError

from munim_intel.config import Config, ConfigError
from munim_intel.contracts_gen.models import (
    InternalForecastsBatchRequest,
    InternalForecastsBatchResponse,
    InternalRunFrameResponse,
    InternalSnapshotsRequest,
    PurchasingIntelNegotiateRequest,
)
from munim_intel.forecast import WEIGHTED, Series, forecast_series
from munim_intel.forecast.engine import HOLDOUT, HORIZON
from munim_intel.llm import cause, frame_over_cap, llm_for_role, price_of, provider_of
from munim_intel.llm.providers import ProviderUnavailable, RetiredModelRefused
from munim_intel.manager.ask import fetch_run_frame
from munim_intel.mapping import uuid7_ms
from munim_intel.negotiate.chooser import LlmChooser
from munim_intel.negotiate.policy import policy_from
from munim_intel.negotiate.port import A2aSuppliers, NotSimulated, simulated_suppliers
from munim_intel.negotiate.run import Outcome, negotiate, negotiation_budget, rfq_from
from munim_intel.runtime.context import RunContext, RunTokenRefused, load_public_key, verify_run_token
from munim_intel.runtime.internal_client import SERVICE_SECRET_HEADER, CoreError, InternalClient
from munim_intel.runtime.state import RunState
from munim_intel.tools.generated import uuid7
from munim_intel.trace.buffer import TraceBuffer
from munim_intel.trace.spend import Meter, SpendBuffer, spend_currency

log = logging.getLogger("munim_intel.negotiate")

#: Twelve weeks of daily sales: the engine backtests from eight (MIN_BACKTEST) and serves nothing under four.
HISTORY_DAYS = 84
#: The engine forecasts seven days from today (trained through yesterday), so the shortfall reads six days ahead.
LEAD_DAYS = 6
#: `forecasts:batch` takes at most 500 points a call (contracts ForecastsBatchRequest).
POINTS_PER_BATCH = 500
#: One supplier's A2A request (the reply is code on the simulated side).
SUPPLIER_TIMEOUT_S = 20.0


class NegotiateModels(Protocol):
    """(client, the run's spend currency, capped) -> (the chooser's `reason` model, the extractor's `extract` model); `capped`:
    over the month's AI cap (llm.over_cap), every call is served from its recorded fixture or abstains (T-125, T-127)."""

    def __call__(self, client: InternalClient, currency: str, capped: bool = False, /) -> Awaitable[tuple[BaseLlm, BaseLlm]]: ...


def default_models(cfg: Config) -> NegotiateModels:
    async def build(client: InternalClient, currency: str, capped: bool = False) -> tuple[BaseLlm, BaseLlm]:
        return (
            await llm_for_role("reason", cfg, client, currency=currency, capped=capped),
            await llm_for_role("extract", cfg, client, currency=currency, capped=capped),
        )

    return build


def _error(status: int, code: str) -> JSONResponse:
    return JSONResponse({"error": {"code": code, "message": code, "reason_code": None}}, status_code=status)


async def _snapshot(client: InternalClient, template: str, params: dict[str, Any]) -> dict[str, Any]:
    body: dict[str, Any] = (
        await client.mint_snapshot(InternalSnapshotsRequest.model_validate({"template_id": template, "params": params}))
    ).model_dump(mode="json")
    return body


async def forecast(ctx: RunContext, client: InternalClient, frame: InternalRunFrameResponse, item_ids: list[str]) -> int:
    """Step 1. Returns the number of points posted (0: no series had enough history, nothing is written)."""
    t0 = uuid7_ms(ctx.run_id)
    run_id = uuid7(t0, f"{ctx.run_id}/forecast")
    points: list[dict[str, Any]] = []
    trained: list[date] = []
    backtested = False
    for outlet in frame.outlets:
        last = date.fromisoformat(outlet.business_date) - timedelta(days=1)
        first = last - timedelta(days=HISTORY_DAYS - 1)
        for item in item_ids:
            snap = await _snapshot(
                client,
                "forecast.sales_history",
                {"outlet_id": outlet.id.root, "item_id": item, "from": first.isoformat(), "to": last.isoformat()},
            )
            rows = snap["rows"]
            series = Series(outlet.id.root, item, first, tuple(int(r["qty_milli"]) for r in rows), tuple(bool(r["closed"]) for r in rows))
            f = forecast_series(series)
            if f.status != "ok":
                continue
            trained.append(f.trained_through)
            backtested = backtested or f.holdout_days > 0
            for m in f.methods:
                for p in m.points:
                    on = p.business_on.isoformat()
                    points.append(
                        {
                            "id": uuid7(t0, f"{run_id}/{outlet.id.root}/{item}/{m.method}/{on}"),
                            "outlet_id": outlet.id.root,
                            "item_id": item,
                            "business_on": on,
                            "slot_start": None,
                            "method": m.method,
                            "qty_milli": p.qty_milli,
                            # contracts: with no backtest intel sends lo = hi = qty.
                            "lo_qty_milli": p.qty_milli if p.lo_qty_milli is None else p.lo_qty_milli,
                            "hi_qty_milli": p.qty_milli if p.hi_qty_milli is None else p.hi_qty_milli,
                            "inputs_snapshot_id": snap["snapshot_id"],
                        }
                    )
    if not points:
        return 0
    run = {
        "id": run_id,
        "method": WEIGHTED,
        "trained_through": max(trained).isoformat(),
        "horizon_days": HORIZON,
        "holdout_days": HOLDOUT if backtested else 0,
        "wape_bp": None,
        "baseline_wape_bp": None,
        "bias_bp": None,
    }
    for i in range(0, len(points), POINTS_PER_BATCH):
        # One run, posted in parts: core inserts the run once and the points of each part (a retried part is `existing`).
        req = InternalForecastsBatchRequest.model_validate({"forecast_run": run, "points": points[i : i + POINTS_PER_BATCH]})
        # InternalClient has no named method for this route yet (runtime/ is not this module's).
        await client._post("forecasts:batch", req, InternalForecastsBatchResponse)
    return len(points)


def _status(out: Outcome) -> tuple[str, str | None]:
    if out.draft is not None:
        return ("drafted", out.draft.draft_id.root) if out.draft.status == "proposed" else ("draft_refused", None)
    return ("no_passing_quote", None) if out.reviewed else ("no_quote", None)


async def run_negotiation(
    ctx: RunContext,
    req: PurchasingIntelNegotiateRequest,
    frame: InternalRunFrameResponse,
    client: InternalClient,
    cfg: Config,
    models: NegotiateModels,
    sim_transport: httpx.AsyncBaseTransport | None = None,
) -> tuple[str, str | None]:
    """(status, draft id). Raises CoreError / httpx errors from core's internal API (the route answers 502)."""
    body = req.model_dump(mode="json")
    suppliers = simulated_suppliers(
        {"supplier_id": s["supplier_id"], "kind": s["kind"], "a2a_card_url": s["card_url"]} for s in body["suppliers"]
    )
    if not suppliers:
        return "no_suppliers", None
    # Rule 11: with AI off or no budget for the month no supplier reply can be read — nothing is sent at all. Over the month's
    # cap with AI on (live mode) the models are built capped: each call is served from its recorded fixture or abstains (T-127).
    capped = frame_over_cap(cfg, frame)
    if frame.narration != "model" and not capped:
        return "model_blocked", None
    try:
        reason_llm, extract_llm = await models(client, spend_currency(frame), capped)
    except (ProviderUnavailable, RetiredModelRefused, CoreError, httpx.HTTPError) as e:
        log.warning("intel: negotiate run %s has no model: %s", ctx.run_id, cause(e))
        return "model_blocked", None

    await forecast(ctx, client, frame, body["item_ids"])
    # One business date anchors the shortfall, the last price and (through `rfq.as_of`) the deal review. The shortfall
    # template's v2 requires `as_of` (0022); without it core refuses the mint (422).
    as_of = max(date.fromisoformat(o.business_date) for o in frame.outlets)
    shortfall = await _snapshot(client, "inventory.shortfall", {"outlet_id": None, "lead_days": LEAD_DAYS, "as_of": as_of.isoformat()})
    s_row = next(
        (i for i, r in enumerate(shortfall["rows"]) if r["ingredient_id"] == body["ingredient_id"] and int(r["shortfall_qty_milli"]) > 0),
        None,
    )
    if s_row is None:
        return "no_shortfall", None
    price = await _snapshot(client, "purchasing.price_creep", {"as_of": as_of.isoformat()})
    held = [
        (int(r["latest_minor"]), i)
        for i, r in enumerate(price["rows"])
        if r["ingredient_id"] == body["ingredient_id"] and r["latest_minor"] is not None
    ]
    if not held:
        return "no_reference_price", None
    p_row = min(held)[1]
    stockout = shortfall["rows"][s_row].get("stockout_on")
    rfq = rfq_from(
        shortfall,
        s_row,
        price,
        p_row,
        "latest_minor",
        item_name=body["item_name"],
        unit=body["unit"],
        currency=body["currency"],
        minor_unit=body["minor_unit"],
        needed_by=stockout or (as_of + timedelta(days=LEAD_DAYS)).isoformat(),
        outlet_ids=tuple(body["outlet_ids"]),
    )
    policy = policy_from(frame)
    spend = SpendBuffer(client.write_spend, spend_currency(frame))
    state = RunState(
        traces=TraceBuffer(client.write_traces),
        budget=negotiation_budget(len(suppliers), policy),
        meter=Meter(spend, "reason", provider_of(reason_llm), reason_llm.model, price_of(reason_llm)),
    )
    chooser = LlmChooser(reason_llm, ctx, cfg, state, currency=rfq.currency, unit=rfq.unit, calls=policy.decision_rounds)
    try:
        async with httpx.AsyncClient(transport=sim_transport, timeout=SUPPLIER_TIMEOUT_S) as http:
            out = await negotiate(
                ctx,
                rfq,
                suppliers,
                port=A2aSuppliers(http, cfg.suppliers_sim_public_url),
                core=client,
                chooser=chooser,
                extract_llm=extract_llm,
                state=state,
                policy=policy,
            )
    except NotSimulated as e:
        log.warning("intel: negotiate run %s refused a supplier: %s", ctx.run_id, e.code)
        return "not_simulated", None
    finally:
        await state.traces.flush()
        await spend.flush()
    return _status(out)


def negotiate_router(
    cfg: Config,
    *,
    now: Callable[[], float] = time.time,
    core_transport: httpx.AsyncBaseTransport | None = None,
    sim_transport: httpx.AsyncBaseTransport | None = None,
    models: NegotiateModels | None = None,
) -> APIRouter:
    router = APIRouter()
    keys: dict[str, Ed25519PublicKey] = {}
    models_of = models or default_models(cfg)

    def context(request: Request) -> RunContext | JSONResponse:
        try:
            secret = cfg.service_secret()
            if "k" not in keys:
                keys["k"] = load_public_key(cfg.run_token_public_key_pem())
        except ConfigError as e:
            log.error("intel: refusing requests — %s", e)
            return _error(503, "unavailable")
        if not hmac.compare_digest(request.headers.get(SERVICE_SECRET_HEADER, "").encode(), secret.encode()):
            return _error(401, "unauthenticated")
        auth = request.headers.get("authorization", "")
        if not auth.startswith("Bearer "):
            return _error(401, "unauthenticated")
        try:
            ctx = verify_run_token(auth[7:], keys["k"], now=now)
        except RunTokenRefused as e:
            log.info("intel: %s on /negotiate", e)
            return _error(401, "unauthenticated")
        # Only a member's own run buys a negotiation (an event, sweep or brief token must not contact suppliers).
        return ctx if ctx.trigger == "ask" else _error(401, "unauthenticated")

    @router.post("/negotiate")
    async def negotiate_route(request: Request) -> JSONResponse:
        ctx = context(request)
        if isinstance(ctx, JSONResponse):
            return ctx
        try:
            req = PurchasingIntelNegotiateRequest.model_validate_json(await request.body() or b"{}")
        except ValidationError:
            return _error(400, "bad_request")
        # The run's scope is exactly the outlets the person chose: the draft may cover no other.
        if sorted(o.root for o in req.outlet_ids) != sorted(ctx.outlet_scope):
            return _error(400, "bad_request")
        frame = await fetch_run_frame(ctx, cfg, core_transport)
        if frame is None:
            return _error(503, "unavailable")
        client = InternalClient(ctx, base_url=cfg.core_url, service_secret=cfg.service_secret(), transport=core_transport)
        try:
            status, draft_id = await run_negotiation(ctx, req, frame, client, cfg, models_of, sim_transport)
        except (CoreError, httpx.HTTPError) as e:
            log.error("intel: negotiate run %s failed: %s", ctx.run_id, type(e).__name__)
            return _error(502, "internal")
        finally:
            await client.aclose()
        log.info("intel: negotiate run %s %s", ctx.run_id, status)
        return JSONResponse({"run_id": ctx.run_id, "status": status, "draft_id": draft_id})

    return router
