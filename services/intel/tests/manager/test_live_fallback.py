"""T-125 (ledger R56 G-4): live models with a recorded fallback — offline: recorded fixtures only, no network, no real key.

The Cup's live URL runs `MUNIM_MODEL_MODE=live`. A live call that fails (a free-tier 429, a timeout, any provider error) or
is over the month's AI cap (`capped`) is served from the recorded fixture of that exact call; with none it abstains exactly
as before (rule 11). The provider is planted in place of the network (Gemini's own call, as test_models.py plants it): the
socket guard stays on.

The fixtures replayed here were authored in RECORDED mode — manager_kit's committed route and reason fixtures, and the
validator cases authored below through the recorded Runner — so a live request keyed differently from the recorded one
(the failure that would blank every curated Ask on the live URL) fails these tests.

Expected values never come from the code under test: the answers are the scripts' text expanded by hand (as
test_manager.py), today's degraded answer is the same ask on live models with no fallback at all, and each role's fallback
directory is the one recorded mode replays.
"""

from __future__ import annotations

import asyncio
import json
import time
from collections.abc import AsyncGenerator, Awaitable, Callable
from pathlib import Path
from typing import Any

import pytest
from google.adk.models import BaseLlm
from google.adk.models.google_llm import Gemini
from google.adk.models.llm_request import LlmRequest
from google.adk.models.llm_response import LlmResponse
from google.genai import types
from google.genai.errors import ClientError

from conftest import GEMINI_KEY
from manager_kit import CTX, DM_FIXTURES, LLM_FIXTURES, LOOKUP_FINANCE, SCRIPTS, TS, FakeCore, call, frame, kit_cfg, vid
from munim_intel.config import Config, load_config
from munim_intel.contracts_gen.models import ThreadsIntelAskRequest
from munim_intel.decide.mimic import LlmMimic, recorded_decision
from munim_intel.decide.port import DecisionResult, DecisionState
from munim_intel.decide.questions import ROUTE_INTENT
from munim_intel.llm import llm_for_role
from munim_intel.llm.providers import TimedGemini
from munim_intel.llm.recorded import RecordedLlm, request_key
from munim_intel.manager.ask import Models, answer_ask, default_models, outlet_kinds
from munim_intel.runtime.runner import RunFailed
from munim_intel.smoke import smoke_run
from munim_intel.tools.generated import uuid7

ROUTER, REASON = "gemini-3.5-flash-lite", "gemini-3.8-flash"
_ROLE = {"provider": "gemini", "location": "global", "probed_at": None, "updated_at": "2026-10-10T00:00:00Z"}
_INR = {"input_price_per_mtok_minor": 2_700, "output_price_per_mtok_minor": 22_500, "price_currency": "INR"}
ROLES = {"items": [{"role": "router", "model_id": ROUTER, **_ROLE, **_INR}, {"role": "reason", "model_id": REASON, **_ROLE, **_INR}]}
#: No route or reason fixture holds this question.
NOBODY = "A question nobody recorded an answer for"
#: Every way a live call fails; `over_cap` makes no provider call at all.
KINDS = ("rate_limited", "provider_error", "timeout", "over_cap")
#: Provider requests per model call, by how the provider fails: a 429 is started over once (llm/providers.retrying, C3), any other
#: error or a timeout is not, and over the cap none is made.
ATTEMPTS = {"rate_limited": 2, "provider_error": 1, "timeout": 1, "over_cap": 0}
SNAP = uuid7(TS, "snap-1")  # the in-memory core's first mint
#: The kit's LOOKUP_FINANCE script answer, expanded by hand.
RECORDED_ANSWER = f"Net for ⟨snap:{SNAP}·0·key⟩ this month was ⟨snap:{SNAP}·0·net_minor⟩."


def live_cfg(tmp_path: Path) -> Config:
    """Live mode with a fake key; timeouts short enough for the planted slow provider."""
    env = {
        "MUNIM_MODEL_MODE": "live",
        "GEMINI_API_KEY": GEMINI_KEY,
        "MUNIM_MODEL_TIMEOUT_ROUTER_S": "0.05",
        "MUNIM_MODEL_TIMEOUT_REASON_S": "0.05",
    }
    return load_config(env=env, run_dir=tmp_path)


Answer = Callable[[LlmRequest], Awaitable[LlmResponse]]


class Provider:
    """The live provider, planted in place of the network: `answer` per call; every call's model id is kept."""

    def __init__(self, monkeypatch: pytest.MonkeyPatch, answer: Answer) -> None:
        self.calls: list[str] = []
        calls = self.calls

        async def generate(_llm: Gemini, llm_request: LlmRequest, stream: bool = False) -> AsyncGenerator[LlmResponse, None]:
            calls.append(llm_request.model or "")
            yield await answer(llm_request)

        monkeypatch.setattr(Gemini, "generate_content_async", generate)


def failing(kind: str) -> Answer:
    async def answer(_req: LlmRequest) -> LlmResponse:
        if kind == "timeout":
            await asyncio.sleep(5)
        if kind == "rate_limited":
            raise ClientError(429, {"error": {"code": 429, "message": "PLANTED quota exceeded", "status": "RESOURCE_EXHAUSTED"}})
        raise RuntimeError("PLANTED provider failure")  # provider_error; over_cap never reaches the provider

    return answer


def text(t: str) -> LlmResponse:
    return LlmResponse(content=types.Content(role="model", parts=[types.Part(text=t)]))


def submit(t: str) -> LlmResponse:
    return call("submit_answer", {"segments": [{"text": t}], "abstain": None})


def ask_req(question: str, addressed: str | None) -> ThreadsIntelAskRequest:
    return ThreadsIntelAskRequest.model_validate({"answer_id": vid(80), "question": question, "addressed_to": addressed, "thread": None})


def run_ask(cfg: Config, question: str, addressed: str | None, models: Callable[[FakeCore], Awaitable[Models]]) -> FakeCore:
    core = FakeCore(frame(), model_roles=ROLES)

    async def go() -> None:
        client = core.client()
        try:
            await answer_ask(CTX, ask_req(question, addressed), core.run_frame, client, cfg, await models(core))
        finally:
            await client.aclose()

    asyncio.run(go())
    return core


def live_ask(
    cfg: Config,
    question: str,
    addressed: str | None = None,
    *,
    capped: bool = False,
    router_dir: Path | None = DM_FIXTURES,
    reason_dir: Path | None = LLM_FIXTURES,
) -> FakeCore:
    """One ask on live models (core's model roles), each role's fallback reading the given recorded fixtures."""

    async def models(core: FakeCore) -> Models:
        client = core.client()
        try:
            router = await llm_for_role("router", cfg, client, currency="INR", fallback_dir=router_dir, capped=capped)
            reason = await llm_for_role("reason", cfg, client, currency="INR", fallback_dir=reason_dir, capped=capped)
        finally:
            await client.aclose()
        return Models(LlmMimic(router), reason)

    return run_ask(cfg, question, addressed, models)


def paths(core: FakeCore) -> tuple[str | None, list[str]]:
    """(the router call's path on the ask's route trace, each Manager call's path in order)."""
    [route] = [e["payload"] for e in core.traces if e["kind"] == "route" and "path" in e["payload"]]
    manager = [e["payload"]["model_path"] for e in core.traces if e["kind"] == "route" and list(e["payload"]) == ["model_path"]]
    return route.get("model_path"), manager


# -- a failed call with a fixture: served from it, traced recorded-fallback ------------------------------------------


@pytest.mark.parametrize("kind", KINDS)
def test_a_failed_live_call_is_served_from_the_fixture_of_that_exact_call(
    kind: str, tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    provider = Provider(monkeypatch, failing(kind))
    core = live_ask(live_cfg(tmp_path), LOOKUP_FINANCE, "finance", capped=kind == "over_cap")
    [answer] = core.answers
    assert answer["envelope"]["abstained"] is False
    assert [s["text"] for s in answer["envelope"]["segments"]] == [RECORDED_ANSWER]
    assert paths(core) == ("recorded-fallback", ["recorded-fallback", "recorded-fallback"])
    # Each call went to the provider first (the router's, then the Manager's two steps), each as often as ATTEMPTS says.
    n = ATTEMPTS[kind]
    assert provider.calls == [ROUTER] * n + [REASON] * (2 * n)
    # One spend row per model call, as today; over the cap no provider was called, so none is charged.
    assert len(core.spend) == 3
    if kind == "over_cap":
        assert [r["amount_minor"] for r in core.spend] == [0, 0, 0]


# -- a failed call with no fixture: abstains as today, traced abstained -----------------------------------------------


@pytest.mark.parametrize("kind", KINDS)
def test_with_no_fixture_a_failed_live_call_abstains_exactly_as_today(kind: str, tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    Provider(monkeypatch, failing("rate_limited"))
    today = live_ask(live_cfg(tmp_path), NOBODY, router_dir=None, reason_dir=None)  # live models with no fallback at all
    provider = Provider(monkeypatch, failing(kind))
    core = live_ask(live_cfg(tmp_path), NOBODY, capped=kind == "over_cap")
    assert core.answers == today.answers
    [answer] = core.answers
    assert answer["envelope"]["abstained"] is True and answer["envelope"]["reason_code"] == "missing_ref"  # "cannot verify"
    assert paths(core) == ("abstained", ["abstained"])
    # Today's error trace stays, right after the label: the class name only.
    i = next(i for i, e in enumerate(core.traces) if e["payload"] == {"model_path": "abstained"})
    assert core.traces[i + 1]["kind"] == "error" and core.traces[i + 1]["payload"]["where"] == "model"
    assert provider.calls == [ROUTER] * ATTEMPTS[kind] + [REASON] * ATTEMPTS[kind]


def test_a_400_on_a_logprobs_request_with_no_fixture_is_still_retried_without_logprobs(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """T-059 (FACT): live Gemini answers 400 to a logprobs request. With no fixture the DecisionModel gets the original
    ClientError, untouched, and retries once without logprobs, as today. Paired: a curated question's logprobs request
    has a fixture, which serves it on the 400 — one call, the recorded probabilities."""

    async def answer(req: LlmRequest) -> LlmResponse:
        if req.config.response_logprobs:
            raise ClientError(400, {"error": {"code": 400, "message": "PLANTED logprobs unsupported", "status": "INVALID_ARGUMENT"}})
        return text("B")

    provider = Provider(monkeypatch, answer)
    core = FakeCore(frame(), model_roles=ROLES)
    cfg = live_cfg(tmp_path)

    async def decide(question: str) -> DecisionResult:
        client = core.client()
        try:
            router = await llm_for_role("router", cfg, client, currency="INR", fallback_dir=DM_FIXTURES)
        finally:
            await client.aclose()
        state: DecisionState = {"question": question, "outlet_kinds": outlet_kinds(core.run_frame), "country": "IN"}
        [d] = await LlmMimic(router).decide(CTX, state, [ROUTE_INTENT])
        return d

    d = asyncio.run(decide(NOBODY))
    assert (d.model_calls, d.answer, d.band, d.model_path) == (2, "explain", "unscored", "live") and len(provider.calls) == 2
    served = asyncio.run(decide(LOOKUP_FINANCE))
    assert (served.model_calls, served.answer, served.model_path) == (1, "lookup", "recorded-fallback") and len(provider.calls) == 3
    assert served.band != "unscored" and served.probs_bp is not None


# -- the ask's own time budget (go-live E-2): intel answers before core stops waiting --------------------------------


def test_past_its_time_budget_the_ask_stops_and_stores_cannot_verify_with_its_spend_and_traces(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """MUNIM_ASK_BUDGET_S: a Manager step that would outlast the ask's budget (its own per-call timeout is the default 60 s)
    is cut at the budget; the ask still stores its answer ("cannot verify") and posts the router's spend and the run's
    traces, so core finds an answer, not a 503, and the calls made are counted. Paired: the same ask with no budget set
    waits for the step."""

    def slow(seconds: float) -> Answer:
        async def answer(req: LlmRequest) -> LlmResponse:
            if req.model == ROUTER:
                return text("B")  # explain
            await asyncio.sleep(seconds)
            return submit("Too late to matter.")

        return answer

    budget = load_config(env={"MUNIM_MODEL_MODE": "live", "GEMINI_API_KEY": GEMINI_KEY, "MUNIM_ASK_BUDGET_S": "0.5"}, run_dir=tmp_path)
    assert budget.ask_budget_s == 0.5
    provider = Provider(monkeypatch, slow(5))
    started = time.monotonic()
    core = live_ask(budget, NOBODY, router_dir=None, reason_dir=None)
    took = time.monotonic() - started
    assert took < 3, f"the ask took {took:.1f} s against a 0.5 s budget"
    assert provider.calls == [ROUTER, REASON]
    [answer] = core.answers
    assert answer["envelope"]["abstained"] is True and answer["envelope"]["reason_code"] == "missing_ref"
    assert [r["role"] for r in core.spend] == ["router"]
    assert any(e["kind"] == "route" and e["payload"].get("intent") == "explain" for e in core.traces)

    # Paired: no budget — the same step is waited for to its end (a shorter step keeps the test quick).
    unbounded = load_config(env={"MUNIM_MODEL_MODE": "live", "GEMINI_API_KEY": GEMINI_KEY}, run_dir=tmp_path)
    assert unbounded.ask_budget_s is None
    provider = Provider(monkeypatch, slow(1.0))
    started = time.monotonic()
    live_ask(unbounded, NOBODY, router_dir=None, reason_dir=None)
    assert time.monotonic() - started >= 1.0 and provider.calls[:2] == [ROUTER, REASON]
    with pytest.raises(Exception, match="MUNIM_ASK_BUDGET_S"):
        load_config(env={"MUNIM_ASK_BUDGET_S": "0"}, run_dir=tmp_path)


# -- a successful live call: used as is, traced live ------------------------------------------------------------------


def test_paired_a_successful_live_call_is_used_as_is_and_traced_live(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    """The same ask as above with a provider that answers: its own answer (not the fixture's, which exists for each of
    these calls), no fixture read, every call traced live."""
    steps = [SCRIPTS[LOOKUP_FINANCE][0].model_copy(deep=True), submit("Live: net for {S1.r0.key} was {S1.r0.net_minor}.")]

    async def answer(req: LlmRequest) -> LlmResponse:
        return text("A") if req.model == ROUTER else steps.pop(0)

    provider = Provider(monkeypatch, answer)
    before = RecordedLlm.calls
    core = live_ask(live_cfg(tmp_path), LOOKUP_FINANCE, "finance")
    [answer_body] = core.answers
    assert [s["text"] for s in answer_body["envelope"]["segments"]] == [f"Live: net for ⟨snap:{SNAP}·0·key⟩ was ⟨snap:{SNAP}·0·net_minor⟩."]
    assert paths(core) == ("live", ["live", "live"])
    assert RecordedLlm.calls == before and provider.calls == [ROUTER, REASON, REASON]


# -- the validator is unchanged: a recorded answer passes cite-or-abstain like a live one ---------------------------

#: Planted on every authored response: a served fixture's token counts are the authoring run's, never this call's.
AUTHORED_USAGE = types.GenerateContentResponseUsageMetadata(prompt_token_count=987_654, candidates_token_count=4_321)


class Author(BaseLlm):
    """Authoring only, in recorded mode (as manager_kit.ScriptLlm): answers each step from `steps` and writes it as that
    request's fixture under `out`."""

    model: str = "recorded/reason"
    out: Path
    steps: list[LlmResponse]

    async def generate_content_async(self, llm_request: LlmRequest, stream: bool = False) -> AsyncGenerator[LlmResponse, None]:
        step = self.steps.pop(0)
        key, canonical, _ = request_key(llm_request)
        # In the fixture only: the authoring run's own budget would count it.
        recorded = step.model_copy(update={"usage_metadata": AUTHORED_USAGE}).model_dump(mode="json", exclude_none=True)
        (self.out / f"{key}.json").write_text(
            json.dumps({"request": json.loads(canonical), "responses": [recorded]}, ensure_ascii=False), "utf8"
        )
        yield step


@pytest.mark.parametrize(
    ("segment", "code"),
    [
        ("Net for {S1.r0.key} this month was {S1.r0.net_minor}.", None),
        ("Net for {S1.r0.key} this month was {S1.r0.net_minor}, up 12 on last month.", "number_grammar"),  # a free digit
        (f"Net was ⟨snap:{vid(70)}·0·net_minor⟩.", "unresolved_ref"),  # a ref this run never minted (forged)
    ],
)
def test_a_fallback_answer_passes_the_validator_as_a_live_one_would(
    segment: str, code: str | None, tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """Fixtures authored in recorded mode (a refused answer is answered again once, §5.3), then replayed by a live run
    whose every call is rate-limited: each step is the fallback, and the answer is the validator's — stored when clean,
    "cannot verify" (an abstention with the rule) with a free digit or a forged ref."""
    out = tmp_path / "reason"
    out.mkdir()
    steps = [SCRIPTS[LOOKUP_FINANCE][0].model_copy(deep=True)] + [submit(segment)] * (1 if code is None else 2)
    router = recorded_decision(DM_FIXTURES)

    async def authoring(_core: FakeCore) -> Models:
        return Models(router, Author(out=out, steps=list(steps)))

    run_ask(kit_cfg(), LOOKUP_FINANCE, "finance", authoring)
    assert len(list(out.glob("*.json"))) == len(steps)

    Provider(monkeypatch, failing("rate_limited"))
    core = live_ask(live_cfg(tmp_path), LOOKUP_FINANCE, "finance", reason_dir=out)
    assert paths(core) == ("recorded-fallback", ["recorded-fallback"] * len(steps))
    env = core.answers[0]["envelope"]
    if code is None:
        assert env["abstained"] is False and [s["text"] for s in env["segments"]] == [RECORDED_ANSWER]
    else:
        assert env["abstained"] is True and env["reason_code"] == code and env["segments"] == []
    assert not [r for r in core.spend if r["input_tokens"] == 987_654 or r["output_tokens"] == 4_321]


# -- wiring -----------------------------------------------------------------------------------------------------------


def test_each_role_falls_back_to_the_fixtures_recorded_mode_replays(tmp_path: Path) -> None:
    async def build(core: FakeCore) -> Models:
        client = core.client()
        try:
            return await default_models(live_cfg(tmp_path))(client, "INR")
        finally:
            await client.aclose()

    m = asyncio.run(build(FakeCore(frame(), model_roles=ROLES)))
    router = m.decide._llm  # type: ignore[attr-defined]  # noqa: SLF001
    replays = recorded_decision()._llm  # noqa: SLF001
    assert isinstance(router, TimedGemini) and router.fallback is not None and not router.capped
    assert isinstance(replays, RecordedLlm)
    assert (router.fallback.model, router.fallback.fixtures_dir) == (replays.model, replays.fixtures_dir)
    assert isinstance(m.reason, TimedGemini) and m.reason.fallback is not None and not m.reason.capped
    assert (m.reason.fallback.model, m.reason.fallback.fixtures_dir) == ("recorded/reason", RecordedLlm().fixtures_dir)


def test_the_live_probe_is_never_served_from_a_fixture(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    """smoke.py's run is the live probe: a dead provider fails it, though `make smoke`'s recorded fixtures hold these
    exact calls (what a fallback would have served)."""
    provider = Provider(monkeypatch, failing("rate_limited"))
    core = FakeCore(frame(), model_roles=ROLES)

    async def probe() -> dict[str, Any]:
        client = core.client()
        try:
            return await smoke_run(CTX, live_cfg(tmp_path), client, client, "ping")
        finally:
            await client.aclose()

    with pytest.raises(RunFailed) as failed:
        asyncio.run(probe())
    assert failed.value.kind == "ClientError" and provider.calls == [ROUTER] * ATTEMPTS["rate_limited"]
