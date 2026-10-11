"""One Manager ask, end to end (ADR-014 §3.3; ledger R45 F8, F9 a; T-088a's AskPort is synchronous).

core → intel `/ask` {answer_id, question, addressed_to, thread} with the ask's run token; intel stores ONE answer under
core's `answer_id` with the member's question unchanged (core refuses any other text) and returns {answer_id, tainted}.
No signature text ever leaves intel: core composes "{Specialist} · via Manager" from `addressed_to`.

  1. `@Kitchen` (any specialist off for every outlet kind in scope) → abstain not_applicable, no model call;
  2. AI off or the month's budget spent (run-frame `narration` ≠ model, the typed kill switch) → abstain model_blocked,
     no model call (rule 11: degrade, never error);
  3. route.intent → path (paths.py); `certification_request` → abstain not_a_certificate, no model call;
  4. otherwise one Manager LlmAgent (`munim`) over the T-082a assembler and PackToolset, ending in submit_answer.
Every exit stores an answer: a run that ends without a submission (budget fallback, the assembler's cap, a provider
error) stores an abstention, `missing_ref` — the generic "cannot verify" (§5.3).

Taint: a tainted thread starts the run tainted through the Assembler (T-082a, the one carry into RunState); the
response returns RunState.tainted. An early exit runs nothing and returns the thread's own taint.
"""

from __future__ import annotations

import logging
from collections.abc import Awaitable, Callable
from dataclasses import dataclass

import httpx
from google.adk.agents import LlmAgent
from google.adk.models import BaseLlm
from pydantic import ValidationError

from munim_intel.config import Config, ConfigError
from munim_intel.context.assembler import AGENT_NAME, CORE_RULES, Assembler, skill_block
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
from munim_intel.llm import llm_for_role
from munim_intel.manager.paths import PATHS, Binding, bind, not_applicable
from munim_intel.runtime.context import RunContext
from munim_intel.runtime.internal_client import PREFIX, SERVICE_SECRET_HEADER, InternalClient
from munim_intel.runtime.runner import RunFailed, run_agent
from munim_intel.runtime.state import RunState
from munim_intel.skills import SkillSpec
from munim_intel.skills.loader import PackToolset
from munim_intel.tools.answer import ALWAYS, SubmitAnswerTool
from munim_intel.tools.handles import HandleTable
from munim_intel.trace.buffer import TraceBuffer

log = logging.getLogger("munim_intel.manager")

#: The abstention of a run that ended without submit_answer (§5.3: "cannot verify").
NO_ANSWER = "missing_ref"


@dataclass(frozen=True)
class Models:
    decide: DecisionModel
    #: The Manager's model: the `reason` role (R36).
    reason: BaseLlm


ModelsFactory = Callable[[InternalClient], Awaitable[Models]]


def default_models(cfg: Config) -> ModelsFactory:
    async def build(client: InternalClient) -> Models:
        return Models(await router_decision_model(cfg, client), await llm_for_role("reason", cfg, client))

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


async def route(ctx: RunContext, question: str, frame: InternalRunFrameResponse, decide: DecisionModel) -> tuple[str, Band]:
    """(intent, band). Abstained or below threshold → `explain` (§4.3); so is a question the egress check refuses to
    send (e.g. a pasted id: no UUID leaves the process) — nothing is sent, the caller's fallback runs."""
    state: DecisionState = {"question": question, "outlet_kinds": outlet_kinds(frame), "country": frame.pack.code}
    try:
        [result] = await decide.decide(ctx, state, [ROUTE_INTENT])
    except EgressRefused:
        return "explain", "low"
    return answer_or_fallback(ROUTE_INTENT, result) or "explain", result.band


def output_contract(skills: list[SkillSpec]) -> str:
    """Block 2 for the Manager: abstain is folded into submit_answer (the assembler's text names an `abstain` tool)."""
    codes = list(dict.fromkeys([c for s in skills for c in s.refusal_codes] + list(ALWAYS)))
    return (
        "Output contract:\n"
        "- Finish by calling submit_answer once with short segments; every number in a segment is a cell handle in braces.\n"
        f"- To abstain, call submit_answer with no segments and abstain set to one reason code: {', '.join(codes)}."
    )


class ManagerAssembler(Assembler):
    def system(self) -> str:
        return "\n\n".join([CORE_RULES, output_contract(self.toolset.skills), skill_block(self.toolset.skills)])


@dataclass(frozen=True)
class Prepared:
    state: RunState
    handles: HandleTable
    toolset: PackToolset
    assembler: ManagerAssembler
    submit: SubmitAnswerTool


def prepare(ctx: RunContext, req: ThreadsIntelAskRequest, frame: InternalRunFrameResponse, client: InternalClient, b: Binding) -> Prepared:
    """The Manager's context for one ask: one RunState and HandleTable, submit_answer as the one base tool, the
    addressed skill loaded in code (no load_skill), propose tools only as the binding says."""
    state = RunState(traces=TraceBuffer(client.write_traces))
    handles = HandleTable(state.handles)
    toolset: PackToolset
    submit = SubmitAnswerTool(req.answer_id.root, handles, lambda: [c for s in toolset.skills for c in s.refusal_codes])
    toolset = PackToolset(
        ctx, client, handles, state, propose=b.propose, payroll_scope=frame.payroll_scope, base_tools=[submit], loadable=b.loadable
    )
    if b.skill is not None:
        toolset.load(b.skill)
    assembler = ManagerAssembler("orchestrator", state, handles, toolset, frame, ctx.trigger, thread=req.thread)
    return Prepared(state, handles, toolset, assembler, submit)


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
    models: Models,
) -> ThreadsIntelAskResponse:
    actor = f"specialist:{req.addressed_to}" if req.addressed_to else "manager"
    thread_tainted = req.thread is not None and req.thread.tainted

    async def early(code: str, labels: dict[str, str | list[str]]) -> ThreadsIntelAskResponse:
        traces = TraceBuffer(client.write_traces)
        if labels:
            await traces.append("route", actor, labels)
        await traces.append("abstain", actor, {"reason": code})
        await traces.flush()
        return await _store(client, req, abstained(req, code), thread_tainted)

    if not_applicable(req.addressed_to, frozenset(outlet_kinds(frame))):
        return await early("not_applicable", {})
    if frame.narration != "model":
        return await early("model_blocked", {})
    intent, band = await route(ctx, req.question, frame, models.decide)
    b = bind(PATHS[intent], req.addressed_to)
    labels: dict[str, str | list[str]] = {"intent": intent, "band": band, "path": b.path.name}
    if b.abstain is not None:
        return await early(b.abstain, labels)

    p = prepare(ctx, req, frame, client, b)
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
        await run_agent(agent, ctx, req.question, cfg, state=p.state, actor=actor)
    except RunFailed as e:
        # Rule 11: the ask degrades to "cannot verify"; the failure's class name only, never its text.
        log.warning("intel: ask run %s failed: %s", ctx.run_id, e.kind)
    envelope = p.submit.envelope or abstained(req, NO_ANSWER)
    return await _store(client, req, envelope, p.state.tainted)
