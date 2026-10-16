"""One Manager ask, end to end (ADR-014 §3.3; ledger R45 F8, F9 a; T-088a's AskPort is synchronous).

core → intel `/ask` {answer_id, question, addressed_to, thread} with the ask's run token; intel stores ONE answer under
core's `answer_id` with the member's question unchanged (core refuses any other text) and returns {answer_id, tainted}.
No signature text ever leaves intel: core composes "{Specialist} · via Manager" from `addressed_to`.

  1. `@Kitchen` (any specialist off for every outlet kind in scope) → abstain not_applicable, no model call;
  2. AI off or the month's budget spent (run-frame `narration` ≠ model, the typed kill switch) → abstain model_blocked,
     no model call (rule 11: degrade, never error) — except over the month's cap with AI on, in live mode (llm.over_cap,
     T-127): the models are built `capped`, every call served from its recorded fixture or abstaining. The models are
     resolved only after these two exits (R-E 2-A): a role that cannot be built (no key, a retired id, model roles
     unreadable) is model_blocked too, never a 502;
  3. route.intent → path (paths.py); `certification_request` → abstain not_a_certificate, no model call; an unscored
     unaddressed `investigate` is answered by the Manager alone, its envelope offering follow_up `dig_deeper` (R47 D5);
  4. otherwise one Manager LlmAgent (`munim`) over the T-082a assembler and PackToolset, ending in submit_answer.
Every exit stores an answer: a run that ends without a submission (budget fallback, the assembler's cap, a provider
error) stores an abstention, `missing_ref` — the generic "cannot verify" (§5.3).

Spend (W3 close ruling): one buffer per ask, in the month's budget currency; the route.intent calls (DecisionResult
`call_usage`), the Manager's and every branch's calls are rows in it, posted before the answer is stored.

Taint: a tainted thread starts the run tainted through the Assembler (T-082a, the one carry into RunState); the
response returns RunState.tainted. An early exit runs nothing and returns the thread's own taint.

Time (go-live E-2): with `MUNIM_ASK_BUDGET_S` set, the Manager's run stops once that long has passed since the ask
began (the route counts), its traces and spend flushed as on any other exit, and the ask stores what it has: the
submitted answer, else `missing_ref`. Core waits `MUNIM_ASK_TIMEOUT_S`, set above it, so the stored answer is there when
core reads it. Unset: no limit beyond each call's own timeout.
"""

from __future__ import annotations

import asyncio
import logging
from collections.abc import Awaitable
from dataclasses import dataclass
from typing import Protocol

import httpx
from google.adk.agents import LlmAgent
from google.adk.models import BaseLlm
from google.adk.tools.base_tool import BaseTool
from pydantic import ValidationError

from munim_intel.config import Config, ConfigError
from munim_intel.context.assembler import AGENT_NAME, Assembler
from munim_intel.contracts_gen.models import (
    AnswerEnvelope,
    InternalAnswersRequest,
    InternalRunFrameResponse,
    ThreadsIntelAskRequest,
    ThreadsIntelAskResponse,
)
from munim_intel.decide.mimic import router_decision_model
from munim_intel.decide.port import Band, DecisionModel, DecisionState, EgressRefused, answer_or_fallback
from munim_intel.decide.questions import ROUTE_INTENT
from munim_intel.fanout.tool import Branches, FanOutTool, orchestrator_budget
from munim_intel.llm import cause, frame_over_cap, llm_for_role, price_of, provider_of
from munim_intel.llm.providers import PriceRefused, ProviderUnavailable, RetiredModelRefused
from munim_intel.manager.paths import FAN_OUT, Binding, bind, not_applicable, path_for
from munim_intel.runtime.context import RunContext
from munim_intel.runtime.internal_client import PREFIX, SERVICE_SECRET_HEADER, CoreError, InternalClient
from munim_intel.runtime.runner import RunFailed, run_agent
from munim_intel.runtime.state import RunState
from munim_intel.skills.loader import PackToolset
from munim_intel.tools.answer import SubmitAnswerTool
from munim_intel.tools.handles import HandleTable
from munim_intel.trace.buffer import TraceBuffer
from munim_intel.trace.served import ModelPath
from munim_intel.trace.spend import Meter, SpendBuffer, spend_currency

log = logging.getLogger("munim_intel.manager")

#: The abstention of a run that ended without submit_answer (§5.3: "cannot verify").
NO_ANSWER = "missing_ref"


@dataclass(frozen=True)
class Models:
    decide: DecisionModel
    #: The Manager's model: the `reason` role (R36).
    reason: BaseLlm


class ModelsFactory(Protocol):
    """(client, the run's spend currency, capped) -> the models, each priced in that currency (R47 D1); `capped`: over the month's
    AI cap (llm.over_cap), every call is served from its recorded fixture or abstains (T-125, T-127)."""

    def __call__(self, client: InternalClient, currency: str, capped: bool = False, /) -> Awaitable[Models]: ...


def default_models(cfg: Config) -> ModelsFactory:
    async def build(client: InternalClient, currency: str, capped: bool = False) -> Models:
        return Models(
            await router_decision_model(cfg, client, currency=currency, capped=capped),
            await llm_for_role("reason", cfg, client, currency=currency, capped=capped),
        )

    return build


async def fetch_run_frame(
    ctx: RunContext, cfg: Config, transport: httpx.AsyncBaseTransport | None = None
) -> InternalRunFrameResponse | None:
    """core's run-frame under the ask's own token (core takes tenant and scope from it alone); None when core cannot
    give one — the ask then fails as unavailable rather than guess a country or an outlet."""
    try:
        headers = {"authorization": f"Bearer {ctx.token}", SERVICE_SECRET_HEADER: cfg.service_secret()}
        async with httpx.AsyncClient(base_url=cfg.core_url, timeout=10.0, transport=transport, headers=headers) as http:
            res = await http.get(f"{PREFIX}/run-frame")
        if not res.is_success:
            log.info("intel: ask run %s run-frame refused (%s)", ctx.run_id, res.status_code)
            return None
        return InternalRunFrameResponse.model_validate_json(res.content)
    except (httpx.HTTPError, ConfigError, ValidationError) as e:
        log.warning("intel: ask run %s run-frame unavailable: %s", ctx.run_id, type(e).__name__)
        return None


def outlet_kinds(frame: InternalRunFrameResponse) -> tuple[str, ...]:
    """The kinds of the outlets in the run's scope (run-frame outlets are the scope), sorted: route.intent egress."""
    return tuple(sorted({o.kind for o in frame.outlets}))


async def route(
    ctx: RunContext, question: str, frame: InternalRunFrameResponse, decide: DecisionModel, spend: SpendBuffer | None = None
) -> tuple[str, Band, ModelPath | None]:
    """(intent, band, the path that served the router's call — live mode only, T-125). Abstained or below threshold →
    `explain` (§4.3); so is a question the egress check refuses to send (e.g. a pasted id: no UUID leaves the process) —
    nothing is sent, the caller's fallback runs. Each provider call the decision cost is a `router` row in `spend`."""
    state: DecisionState = {"question": question, "outlet_kinds": outlet_kinds(frame), "country": frame.pack.code}
    try:
        [result] = await decide.decide(ctx, state, [ROUTE_INTENT])
    except EgressRefused:
        return "explain", "low", None
    if spend is not None:
        for usage in result.call_usage:
            spend.add("router", result.provider, result.model_id, usage, result.price)
    return answer_or_fallback(ROUTE_INTENT, result) or "explain", result.band, result.model_path


@dataclass(frozen=True)
class Prepared:
    state: RunState
    handles: HandleTable
    toolset: PackToolset
    assembler: Assembler
    submit: SubmitAnswerTool
    fan_out: FanOutTool | None = None


def prepare(
    ctx: RunContext,
    req: ThreadsIntelAskRequest,
    frame: InternalRunFrameResponse,
    client: InternalClient,
    b: Binding,
    branches: Branches | None = None,
    meter: Meter | None = None,
) -> Prepared:
    """The Manager's context for one ask: one RunState and HandleTable, submit_answer as the one base tool, the
    addressed skill loaded in code (no load_skill), propose tools only as the binding says. On the unaddressed
    `investigate` path, given `branches`, `fan_out` joins as a base tool (F5) and the run takes §3.4's fan-out
    orchestrator caps; an addressed investigate stays with the named specialist, single agent."""
    state = RunState(traces=TraceBuffer(client.write_traces), meter=meter)
    handles = HandleTable(state.handles)
    toolset: PackToolset
    submit = SubmitAnswerTool(req.answer_id.root, handles, lambda: [c for s in toolset.skills for c in s.refusal_codes])
    fan_out = None
    if b.path is FAN_OUT and b.skill is None and branches is not None:
        state.budget = orchestrator_budget()
        fan_out = FanOutTool(ctx, client, handles, state, frame, branches)
    base: list[BaseTool] = [submit] if fan_out is None else [submit, fan_out]
    toolset = PackToolset(
        ctx, client, handles, state, propose=b.propose, payroll_scope=frame.payroll_scope, base_tools=base, loadable=b.loadable
    )
    if b.skill is not None:
        toolset.load(b.skill)
    assembler = Assembler("orchestrator", state, handles, toolset, frame, ctx.trigger, thread=req.thread)
    return Prepared(state, handles, toolset, assembler, submit, fan_out)


async def _store(client: InternalClient, req: ThreadsIntelAskRequest, envelope: AnswerEnvelope, tainted: bool) -> ThreadsIntelAskResponse:
    await client.write_answer(InternalAnswersRequest(question=req.question, envelope=envelope))
    return ThreadsIntelAskResponse(answer_id=req.answer_id, tainted=tainted)


def abstained(req: ThreadsIntelAskRequest, code: str) -> AnswerEnvelope:
    return AnswerEnvelope.model_validate({"answer_id": req.answer_id.root, "segments": [], "abstained": True, "reason_code": code})


async def answer_ask(
    ctx: RunContext,
    req: ThreadsIntelAskRequest,
    frame: InternalRunFrameResponse,
    client: InternalClient,
    cfg: Config,
    models: Models | ModelsFactory,
) -> ThreadsIntelAskResponse:
    """`models`: the models, or the factory that builds them — called only once the ask needs a model (R-E 2-A)."""
    actor = f"specialist:{req.addressed_to}" if req.addressed_to else "manager"
    deadline = None if cfg.ask_budget_s is None else asyncio.get_running_loop().time() + cfg.ask_budget_s
    thread_tainted = req.thread is not None and req.thread.tainted
    spend = SpendBuffer(client.write_spend, spend_currency(frame))

    async def early(code: str, labels: dict[str, str | list[str]], price: str | None = None) -> ThreadsIntelAskResponse:
        traces = TraceBuffer(client.write_traces)
        if labels:
            await traces.append("route", actor, labels)
        await traces.append("abstain", actor, {"reason": code} if price is None else {"reason": code, "price": price})
        await traces.flush()
        await spend.flush()
        return await _store(client, req, abstained(req, code), thread_tainted)

    if not_applicable(req.addressed_to, frozenset(outlet_kinds(frame))):
        return await early("not_applicable", {})
    capped = frame_over_cap(cfg, frame)
    if frame.narration != "model" and not capped:
        return await early("model_blocked", {})
    if not isinstance(models, Models):
        try:
            models = await models(client, spend.currency, capped)
        except (ProviderUnavailable, RetiredModelRefused, CoreError, httpx.HTTPError) as e:
            # Rule 11: a model that cannot be built is AI unavailable for this ask — an abstention, never a 502. A price
            # refusal (R47 D1) names its code on the abstain trace.
            log.warning("intel: ask run %s has no model: %s", ctx.run_id, cause(e))
            return await early("model_blocked", {}, e.code if isinstance(e, PriceRefused) else None)
    intent, band, model_path = await route(ctx, req.question, frame, models.decide, spend)
    path, follow_up = path_for(intent, band, req.addressed_to, bool(req.deep))
    b = bind(path, req.addressed_to)
    labels: dict[str, str | list[str]] = {"intent": intent, "band": band, "path": b.path.name}
    if model_path is not None:
        labels["model_path"] = model_path
    if follow_up is not None:
        labels["follow_up"] = follow_up
    if b.abstain is not None:
        return await early(b.abstain, labels)

    meter = Meter(spend, "reason", provider_of(models.reason), models.reason.model, price_of(models.reason))
    p = prepare(ctx, req, frame, client, b, Branches(models.reason, cfg), meter)
    await p.state.traces.append("route", actor, labels)
    if b.skill is not None:
        await p.state.traces.append("skill_load", actor, {"skill": b.skill, "by": "addressed"})
    agent = LlmAgent(
        name=AGENT_NAME["orchestrator"],
        model=models.reason,
        instruction=p.assembler.instruction,
        tools=[p.toolset],
        before_model_callback=p.assembler.before_model,
    )
    try:
        async with asyncio.timeout_at(deadline):
            await run_agent(agent, ctx, req.question, cfg, state=p.state, actor=actor)
    except RunFailed as e:
        # Rule 11: the ask degrades to "cannot verify"; the failure's class name only, never its text.
        log.warning("intel: ask run %s failed: %s", ctx.run_id, e.kind)
    except TimeoutError:
        # MUNIM_ASK_BUDGET_S: cancelled where it stood; run_agent's `finally` has flushed its traces and spend.
        log.warning("intel: ask run %s stopped at its time budget", ctx.run_id)
    envelope = p.submit.envelope or abstained(req, NO_ANSWER)
    if follow_up is not None:
        envelope = envelope.model_copy(update={"follow_up": follow_up})
    await spend.flush()
    return await _store(client, req, envelope, p.state.tainted)
