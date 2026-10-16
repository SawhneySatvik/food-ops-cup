"""T-081 gates: the DecisionModel port, LlmMimic on the router role (F2), egress allow-lists, recorded mode.

Recorded results prove plumbing, NOT model quality: the replayed answers are synthetic (tests/decide/make_fixtures.py).
Expected values here are hand-written labels or parsed from independent sources (contracts zod enums, core-api FIELDS).
"""

from __future__ import annotations

import asyncio
import json
import re
import socket
from collections.abc import AsyncGenerator
from pathlib import Path
from typing import Any

import pytest
from google.adk.integrations.openai import OpenAILlm
from google.adk.models import BaseLlm
from google.adk.models.llm_request import LlmRequest
from google.adk.models.llm_response import LlmResponse
from google.genai import types
from google.genai.errors import ClientError
from google.genai.models import AsyncModels
from openai.resources.chat.completions import AsyncCompletions
from openai.types.chat import ChatCompletion

from munim_intel.config import load_config
from munim_intel.contracts_gen.models import InternalRunFrameResponse, PlatformModelRoleRow, PlatformModelRoles
from munim_intel.decide.mimic import FIXTURES_DIR, LlmMimic, recorded_decision, router_decision_model
from munim_intel.decide.port import DecisionQuestion, DecisionResult, DecisionState, EgressRefused, answer_or_fallback
from munim_intel.decide.questions import IMPORT_FIELDS, MAP_COLUMNS, QUESTIONS, ROUTE_INTENT
from munim_intel.llm.providers import build_live_llm
from munim_intel.manager.ask import route
from munim_intel.manager.paths import DRAFT, PATHS, bind
from munim_intel.runtime.context import RunContext
from munim_intel.trace.price import Price
from munim_intel.trace.spend import SpendBuffer

from .make_fixtures import PLANTED_LOW, PLANTED_MAP_NO_LOGPROBS, PLANTED_NO_LOGPROBS, PLANTED_OUT_OF_ENUM, POS_BILLS_HEADERS

REPO = Path(__file__).resolve().parents[4]
TENANT = "01920000-0000-7000-8000-0000000000f1"
CTX = RunContext(
    run_id="01920000-0000-7000-8000-0000000000e1",
    tenant_id=TENANT,
    outlet_scope=("*",),
    trigger="ask",
    actor="01920000-0000-7000-8000-0000000000d1",
    expires_at=4_102_444_800,
    token="not-a-token",  # noqa: S106 — never verified here; decide() must not read it
)

# Hand-labelled route.intent set (ADR-014 §4.5 asks for ≥ 60 in W3 for the live measurement; this gate needs ≥ 20).
LABELLED: list[tuple[str, str]] = [
    ("What were total sales yesterday?", "lookup"),
    ("How much paneer is in stock at the Koramangala kitchen?", "lookup"),
    ("@Finance show me last week's payouts from the delivery apps", "lookup"),
    ("Who is rostered for Saturday dinner?", "lookup"),
    ("Why did food cost go up this week?", "explain"),
    ("@Kitchen why are ticket times slow on weekends?", "explain"),
    ("What does the short payout finding mean?", "explain"),
    ("Why is the butter chicken margin negative?", "explain"),
    ("Dig into why our margin fell this month across all outlets", "investigate"),
    ("@Inventory find out where the extra chicken waste is coming from over the last three months", "investigate"),
    ("Work out step by step what is driving the drop in repeat customers", "investigate"),
    ("Look into why labour cost keeps rising every month since June", "investigate"),
    ("Order 20 kg of onions from our usual supplier", "draft_request"),
    ("@Menu raise the price of masala dosa to match the new cost", "draft_request"),
    ("Make next week's roster for the Indiranagar outlet", "draft_request"),
    ("@Finance draft a dispute for the missing delivery app payout", "draft_request"),
    ("Certify that our GST filing for September is correct", "certification_request"),
    ("@Compliance can you guarantee we pass the food safety audit?", "certification_request"),
    ("Sign off the books for the month as accurate", "certification_request"),
    ("Confirm in writing that the payroll is legally compliant", "certification_request"),
    ("Write me a poem about biryani", "out_of_scope"),
    ("Who won the cricket match last night?", "out_of_scope"),
    ("@Market what's the weather in Goa this weekend?", "out_of_scope"),
    ("Help me with my child's maths homework", "out_of_scope"),
]
# ADR-014 §4.3 table, by hand.
INTENTS = {"lookup", "explain", "investigate", "draft_request", "certification_request", "out_of_scope"}

# pos_bills header -> the field a person would map it to (None: left unmapped for a person).
MAP_LABELS: dict[str, str | None] = {
    "Bill No": "bill_no",
    "Bill Date": "bill_date",
    "Outlet Name": "outlet",
    "Item Code": "item_code",
    "Qty": "qty",
    "Rate": "unit_price",
    "Line Amount": "line_total",
    "Remarks": None,
}


def route_state(question: str) -> DecisionState:
    return {"question": question, "outlet_kinds": ("restaurant",), "country": "IN"}


def ask(q: DecisionQuestion, state: DecisionState) -> DecisionResult:
    [r] = asyncio.run(recorded_decision().decide(CTX, state, [q]))
    assert r.answer is None or r.answer in q.options
    return r


# ---------------------------------------------------------------------------------------------- answer set (§4.2)


def test_route_intent_labelled_set_plumbing_only() -> None:
    """Plumbing, not quality: each recorded answer comes back as the hand label, inside the answer set."""
    assert len(LABELLED) >= 20
    assert {label for _, label in LABELLED} == INTENTS
    assert sum(q.startswith("@") for q, _ in LABELLED) >= 5
    wrong = [(q, label, r.answer, r.reason) for q, label in LABELLED if (r := ask(ROUTE_INTENT, route_state(q))).answer != label]
    assert wrong == []


def test_out_of_enum_answer_is_decision_invalid_then_fallback() -> None:
    r = ask(ROUTE_INTENT, route_state(PLANTED_OUT_OF_ENUM))
    assert (r.abstained, r.reason, r.answer, r.band) == (True, "decision_invalid", None, "low")
    assert answer_or_fallback(ROUTE_INTENT, r) == "explain"
    ok = ask(ROUTE_INTENT, route_state("What were total sales yesterday?"))  # the paired accept
    assert (ok.abstained, ok.answer) == (False, "lookup")
    assert answer_or_fallback(ROUTE_INTENT, ok) == "lookup"


def test_no_logprobs_is_unscored_for_route_intent_and_abstains_for_map_columns() -> None:
    """T-081 dm-1 (supersedes "no logprobs → band low" for route.intent): an answer without probabilities is used,
    band `unscored`, only by a question that opts in; map.columns still abstains `no_probabilities` (paired refusal)."""
    r = ask(ROUTE_INTENT, route_state(PLANTED_NO_LOGPROBS))
    assert (r.abstained, r.reason, r.band, r.probs_bp, r.answer, r.model_calls) == (False, None, "unscored", None, "lookup", 1)
    assert answer_or_fallback(ROUTE_INTENT, r) == "lookup"
    q = MAP_COLUMNS["pos_bills"]
    m = ask(q, {"header": PLANTED_MAP_NO_LOGPROBS, "headers": POS_BILLS_HEADERS})
    assert (m.abstained, m.reason, m.band, m.probs_bp, m.answer) == (True, "no_probabilities", "low", None, None)
    assert answer_or_fallback(q, m) is None


def test_only_route_intent_accepts_an_unscored_answer() -> None:
    # By hand (dm-1 brief): route.intent's every path is bounded and fails safe; nothing else may act unscored.
    assert {q.key for q in QUESTIONS if q.use_unscored} == {"route.intent"}
    assert all(not q.use_unscored for q in MAP_COLUMNS.values())


def test_below_threshold_is_abstained() -> None:
    r = ask(ROUTE_INTENT, route_state(PLANTED_LOW))
    assert (r.abstained, r.reason, r.band) == (True, "below_threshold", "low")
    assert answer_or_fallback(ROUTE_INTENT, r) == "explain"


def test_map_columns_renames_and_unmapped() -> None:
    q = MAP_COLUMNS["pos_bills"]
    got = {h: answer_or_fallback(q, ask(q, {"header": h, "headers": POS_BILLS_HEADERS})) for h in POS_BILLS_HEADERS}
    assert got == MAP_LABELS


#: The Ask screen's suggested Cobnut questions (tests/manager/record_cobnut_ask.py, T-114): each routes to `lookup`.
COBNUT_QUESTIONS = (
    "Which ingredients are below their reorder level?",
    "How much stock is at risk of expiring in the next three days?",
    "How did this week's waste compare with a usual week?",
    "What was labour as a share of sales last week?",
    "How much food have we donated through Munim Cares this month?",
)


def test_probabilities_sum_to_10000_on_every_recorded_result() -> None:
    results = [ask(ROUTE_INTENT, route_state(q)) for q, _ in LABELLED]
    results += [ask(ROUTE_INTENT, route_state(q)) for q in (PLANTED_OUT_OF_ENUM, PLANTED_NO_LOGPROBS, PLANTED_LOW)]
    results += [ask(MAP_COLUMNS["pos_bills"], {"header": h, "headers": POS_BILLS_HEADERS}) for h in POS_BILLS_HEADERS]
    results += [ask(MAP_COLUMNS["pos_bills"], {"header": PLANTED_MAP_NO_LOGPROBS, "headers": POS_BILLS_HEADERS})]
    cobnut = [ask(ROUTE_INTENT, route_state(q)) for q in COBNUT_QUESTIONS]
    assert [(r.answer, r.band) for r in cobnut] == [("lookup", "high")] * 5
    results += cobnut
    # Every committed fixture is exercised above (24 labelled + 3 planted + 8 headers + 1 planted header + 5 Cobnut, by
    # hand).
    assert len(list(FIXTURES_DIR.glob("*.json"))) == len(results) == 41
    with_probs = [r for r in results if r.probs_bp is not None]
    # 24 labelled + 7 mapped headers + 5 Cobnut carry probabilities (hand count); the 3 abstained and 1 unscored results
    # carry none.
    assert len(with_probs) == 36
    for r in with_probs:
        assert r.probs_bp is not None
        assert abs(sum(r.probs_bp.values()) - 10_000) <= 1, (r.key, r.probs_bp)
        assert r.band in ("medium", "high")


@pytest.mark.fixture_miss_expected
def test_adapter_error_is_an_abstain_without_model_text() -> None:
    r = ask(ROUTE_INTENT, route_state("a question with no recorded fixture"))
    assert (r.abstained, r.reason, r.answer) == (True, "adapter_error", None)
    assert answer_or_fallback(ROUTE_INTENT, r) == "explain"


# ------------------------------------------------------------------------------------------------- egress (§4.3)


@pytest.fixture
def sockets(monkeypatch: pytest.MonkeyPatch) -> list[str]:
    """Counts every attempt to reach the network (and refuses it), on top of conftest's block."""
    attempts: list[str] = []

    def guard(name: str) -> Any:
        def refuse(*_: Any, **__: Any) -> Any:
            attempts.append(name)
            raise OSError("network blocked in a test")

        return refuse

    for name in ("connect", "connect_ex"):
        monkeypatch.setattr(socket.socket, name, guard(name))
    monkeypatch.setattr(socket, "create_connection", guard("create_connection"))
    monkeypatch.setattr(socket, "getaddrinfo", guard("getaddrinfo"))
    return attempts


def live_router() -> LlmMimic:
    """A real Gemini client (fake key), so a request that got past the builder would try the network."""
    cfg = load_config(env={"GEMINI_API_KEY": "gemini-test-key-not-real-0001"})
    row = PlatformModelRoleRow.model_validate(
        {
            "role": "router",
            "provider": "gemini",
            "model_id": "gemini-3.5-flash-lite",
            "location": "global",
            "probed_at": None,
            "updated_at": "2026-10-10T00:00:00Z",
            **ROUTER_PRICE_COLUMNS,
        }
    )
    return LlmMimic(build_live_llm(row, cfg, ROUTER_PRICE))


#: An operator's router price (R47 D1), typed by hand: ₹27 / ₹225 per 1M tokens, in paise.
ROUTER_PRICE = Price(2_700, 22_500, "INR")
ROUTER_PRICE_COLUMNS = {"input_price_per_mtok_minor": 2_700, "output_price_per_mtok_minor": 22_500, "price_currency": "INR"}


PLANTS: list[tuple[DecisionQuestion, DecisionState, DecisionState, str]] = [
    # (question, allow-listed state, the same state with one planted field, the planted field)
    (ROUTE_INTENT, route_state("Why did food cost go up?"), {**route_state("Why did food cost go up?"), "tenant_id": TENANT}, "tenant_id"),
    (
        MAP_COLUMNS["pos_bills"],
        {"header": "Qty", "headers": POS_BILLS_HEADERS},
        {"header": "Qty", "headers": POS_BILLS_HEADERS, "sample_row": ("B-1001", "11/10/2026", "2", "180.00")},
        "sample_row",
    ),
]


@pytest.mark.parametrize(("q", "good", "bad", "planted"), PLANTS, ids=["route.intent+tenant_uuid", "map.columns+sample_cell"])
def test_planted_field_refused_before_network(
    sockets: list[str], q: DecisionQuestion, good: DecisionState, bad: DecisionState, planted: str
) -> None:
    dm = live_router()
    with pytest.raises(EgressRefused) as e:
        asyncio.run(dm.decide(CTX, bad, [q]))
    assert (e.value.field_name, e.value.rule) == (planted, "not_allow_listed")
    assert TENANT not in str(e.value) and "B-1001" not in str(e.value)  # the message names the field, never the value
    assert sockets == []
    # The paired accept: the allow-listed state does go to the provider (the guard is armed and counts it).
    [r] = asyncio.run(dm.decide(CTX, good, [q]))
    assert (r.abstained, r.reason) == (True, "adapter_error")
    assert len(sockets) >= 1


@pytest.mark.parametrize(
    ("state", "field", "rule"),
    [
        ({**route_state("x"), "country": "India"}, "country", "value_not_allowed"),
        ({**route_state("x"), "outlet_kinds": ("Koramangala Kitchen",)}, "outlet_kinds", "value_not_allowed"),
        (route_state(f"refund order {TENANT}"), "question", "uuid"),
        ({"question": "x", "outlet_kinds": ("store",)}, "country", "missing"),
    ],
    ids=["country-name", "outlet-name", "uuid-in-text", "missing"],
)
def test_value_rules_refused_before_network(sockets: list[str], state: DecisionState, field: str, rule: str) -> None:
    with pytest.raises(EgressRefused) as e:
        asyncio.run(live_router().decide(CTX, state, [ROUTE_INTENT]))
    assert (e.value.field_name, e.value.rule) == (field, rule)
    assert sockets == []


class SpyLlm(BaseLlm):
    """Captures each request and answers `A` with full-confidence logprobs."""

    model: str = "spy/router"
    seen: list[LlmRequest] = []

    async def generate_content_async(self, llm_request: LlmRequest, stream: bool = False) -> AsyncGenerator[LlmResponse, None]:
        self.seen.append(llm_request)
        c = types.LogprobsResultCandidate(token="A", log_probability=0.0)
        yield LlmResponse(
            content=types.Content(role="model", parts=[types.Part(text="A")]),
            logprobs_result=types.LogprobsResult(chosen_candidates=[c], top_candidates=[types.LogprobsResultTopCandidates(candidates=[c])]),
        )


@pytest.mark.parametrize(
    ("q", "state", "fields"),
    [
        (ROUTE_INTENT, route_state("Why did food cost go up?"), {"question", "outlet_kinds", "country"}),
        (MAP_COLUMNS["pos_bills"], {"header": "Qty", "headers": POS_BILLS_HEADERS}, {"header", "headers"}),
    ],
    ids=["route.intent", "map.columns"],
)
def test_allow_listed_request_carries_exactly_the_listed_fields(q: DecisionQuestion, state: DecisionState, fields: set[str]) -> None:
    spy = SpyLlm(seen=[])
    [r] = asyncio.run(LlmMimic(spy).decide(CTX, state, [q]))
    assert r.answer == q.options[0] and r.probs_bp is not None
    [req] = spy.seen
    assert len(req.contents) == 1 and len(req.contents[0].parts or []) == 1
    text = req.contents[0].parts[0].text or ""  # type: ignore[index]
    assert set(json.loads(text)) == fields
    assert not (req.config.tools or [])
    wire = req.model_dump_json()
    for secret in (CTX.tenant_id, CTX.run_id, CTX.actor, CTX.token):
        assert secret not in wire


def test_gemini_wire_is_enum_with_logprobs(monkeypatch: pytest.MonkeyPatch) -> None:
    """The default router provider (0015 seed: gemini). The request is captured at the genai SDK, past ADK's Gemini class,
    and the response goes back through ADK's own LlmResponse.create, so the logprob mapping is tested end to end."""
    calls: list[dict[str, Any]] = []

    async def generate_content(
        self: Any, *, model: str, contents: Any, config: types.GenerateContentConfig
    ) -> types.GenerateContentResponse:
        calls.append({"model": model, "contents": contents, "config": config})

        def cand(token: str, lp: float) -> types.LogprobsResultCandidate:
            return types.LogprobsResultCandidate(token=token, log_probability=lp)

        top = [cand("B", -0.1), cand("C", -2.6), cand("A", -3.5), cand("\n", -4.0)]
        return types.GenerateContentResponse(
            candidates=[
                types.Candidate(
                    content=types.Content(role="model", parts=[types.Part(text="B")]),
                    finish_reason=types.FinishReason.STOP,
                    logprobs_result=types.LogprobsResult(
                        chosen_candidates=[cand("B", -0.1)], top_candidates=[types.LogprobsResultTopCandidates(candidates=top)]
                    ),
                )
            ],
        )

    monkeypatch.setattr(AsyncModels, "generate_content", generate_content)
    [r] = asyncio.run(live_router().decide(CTX, route_state("Why did food cost go up?"), [ROUTE_INTENT]))
    [call] = calls
    cfg: types.GenerateContentConfig = call["config"]
    assert cfg.response_mime_type == "text/x.enum"
    assert isinstance(cfg.response_schema, types.Schema) and cfg.response_schema.enum == list("ABCDEF")
    assert (cfg.response_logprobs, cfg.logprobs, cfg.temperature, cfg.tools) == (True, 6, 0, None)
    [content] = call["contents"]
    [part] = content.parts
    assert set(json.loads(part.text)) == {"question", "outlet_kinds", "country"}
    wire = json.dumps([str(call["contents"]), cfg.model_dump(mode="json")], default=str)
    for secret in (CTX.tenant_id, CTX.run_id, CTX.actor, CTX.token):
        assert secret not in wire
    assert (r.abstained, r.answer, r.band) == (False, "explain", "medium")
    assert r.probs_bp is not None and sum(r.probs_bp.values()) == 10_000


def test_openai_compatible_wire_is_strict_enum_without_logprobs(monkeypatch: pytest.MonkeyPatch) -> None:
    """FACT (installed ADK OpenAILlm): no logprobs on this path. The same policy as Gemini's unscored retry (gate d):
    route.intent acts on the answer, band `unscored`; map.columns abstains `no_probabilities`. No retry: one call each.
    The wire is captured at the SDK."""
    calls: list[dict[str, Any]] = []

    async def create(self: Any, **kwargs: Any) -> ChatCompletion:
        calls.append(kwargs)
        return ChatCompletion.model_validate(
            {
                "id": "c1",
                "object": "chat.completion",
                "created": 0,
                "model": kwargs["model"],
                "choices": [{"index": 0, "finish_reason": "stop", "message": {"role": "assistant", "content": '{"answer":"D"}'}}],
            }
        )

    monkeypatch.setattr(AsyncCompletions, "create", create)
    llm = OpenAILlm(model="vendor/router-model", api_key="openrouter-test-key-not-real-0002", base_url="https://openrouter.ai/api/v1")
    [r] = asyncio.run(LlmMimic(llm).decide(CTX, route_state("Why did food cost go up?"), [ROUTE_INTENT]))
    [kw] = calls
    fmt = kw["response_format"]
    assert fmt["type"] == "json_schema" and fmt["json_schema"]["strict"] is True
    assert fmt["json_schema"]["schema"]["properties"]["answer"]["enum"] == list("ABCDEF")
    [system, user] = kw["messages"]
    assert system["role"] == "system" and user["role"] == "user"
    assert set(json.loads(user["content"] if isinstance(user["content"], str) else user["content"][0]["text"])) == {
        "question",
        "outlet_kinds",
        "country",
    }
    assert "logprobs" not in kw and TENANT not in json.dumps(kw, default=str)
    assert (r.abstained, r.reason, r.band, r.answer, r.probs_bp, r.model_calls) == (False, None, "unscored", "draft_request", None, 1)
    assert answer_or_fallback(ROUTE_INTENT, r) == "draft_request"
    # Paired refusal: map.columns on the same path (D = the 4th pos_bills field, `outlet`) abstains, and is not retried.
    q = MAP_COLUMNS["pos_bills"]
    [m] = asyncio.run(LlmMimic(llm).decide(CTX, {"header": "Outlet Name", "headers": POS_BILLS_HEADERS}, [q]))
    assert (m.abstained, m.reason, m.band, m.model_calls) == (True, "no_probabilities", "low", 1)
    assert answer_or_fallback(q, m) is None and len(calls) == 2


# ----------------------------------------------------------- logprobs rejected → one unscored retry (T-081 dm-1)

#: A run frame with only what route.intent's egress reads (outlet kinds, country).
FRAME = InternalRunFrameResponse.model_validate(
    {
        "pack": {"code": "IN", "version": 3},
        "currency": "INR",
        "severity_ladder": {"critical_minor_gte": 5_000_000, "high_minor_gte": 1_000_000, "medium_minor_gte": 100_000},
        "detectors": {},
        "outlets": [
            {
                "id": "01920000-0000-7000-8000-0000000000a1",
                "name": "Indiranagar Kitchen",
                "kind": "restaurant",
                "tz": "Asia/Kolkata",
                "business_date": "2026-10-10",
            }
        ],
        "budget": None,
        "narration": "model",
        "licence_kinds": [],
        "payroll_scope": "drafts",
        "negotiation": {"target_bp": 9500, "walkaway_bp": 11000},
    }
)


def gemini_rejecting_logprobs(monkeypatch: pytest.MonkeyPatch, answer: str, status: int = 400) -> list[types.GenerateContentConfig]:
    """Scripts the genai SDK as T-059 and the dm-1 probe measured it: a request with logprobs raises ClientError(status);
    the same request without them answers `answer` (no logprobs). Raised below ADK's Gemini class, so ADK's own error
    handling is in the path (it re-raises ClientError). RecordedLlm cannot replay this: its key ignores the logprobs
    flag, so the retry would hit the rejected request's fixture."""
    seen: list[types.GenerateContentConfig] = []

    async def generate_content(
        self: Any, *, model: str, contents: Any, config: types.GenerateContentConfig
    ) -> types.GenerateContentResponse:
        seen.append(config)
        if config.response_logprobs:
            raise ClientError(status, {"error": {"code": status, "message": "recorded rejection", "status": "INVALID_ARGUMENT"}})
        return types.GenerateContentResponse(
            candidates=[
                types.Candidate(content=types.Content(role="model", parts=[types.Part(text=answer)]), finish_reason=types.FinishReason.STOP)
            ],
            usage_metadata=types.GenerateContentResponseUsageMetadata(prompt_token_count=247),
        )

    monkeypatch.setattr(AsyncModels, "generate_content", generate_content)
    return seen


def test_a_rejected_logprobs_request_is_retried_once_and_routes_draft_request_unscored(monkeypatch: pytest.MonkeyPatch) -> None:
    """Gate (a): 400 on the logprobs request, ok retry → draft_request, band unscored, the draft path (which still
    needs an @specialist: unaddressed it abstains specialist_needed with no model call)."""
    seen = gemini_rejecting_logprobs(monkeypatch, "D")
    dm = live_router()
    [r] = asyncio.run(dm.decide(CTX, route_state("Order 20 kg of onions from our usual supplier"), [ROUTE_INTENT]))
    assert (r.abstained, r.reason, r.answer, r.band, r.probs_bp, r.model_calls, r.input_tokens) == (
        False,
        None,
        "draft_request",
        "unscored",
        None,
        2,
        247,
    )
    first, retry = seen
    assert (first.response_logprobs, first.logprobs) == (True, 6) and (retry.response_logprobs, retry.logprobs) == (None, None)
    # The same constraint and prompt on the retry: only the logprobs request differs.
    assert retry.model_dump(exclude={"response_logprobs", "logprobs"}) == first.model_dump(exclude={"response_logprobs", "logprobs"})
    # Through the Manager's own router (manager/ask.py) and path table: the route trace labels intent, band and path.
    seen.clear()
    intent, band, _ = asyncio.run(route(CTX, "Order 20 kg of onions from our usual supplier", FRAME, dm))
    assert (intent, band, len(seen)) == ("draft_request", "unscored", 2)
    assert PATHS[intent] is DRAFT
    assert bind(PATHS[intent], None).abstain == "specialist_needed"
    assert bind(PATHS[intent], "inventory_purchasing").propose is True


def test_both_calls_of_a_rejected_then_retried_route_are_spend_rows(monkeypatch: pytest.MonkeyPatch) -> None:
    """W3 close ruling (R-E 1-C, money): the DecisionModel's calls are charged too, each one — by hand, the logprobs request
    the provider rejected (400) and its retry = 2 `router` rows = DecisionResult.model_calls. The rejected call reported no
    usage, so it is charged on the request-size estimate; the retry on the provider's 247 prompt tokens."""
    seen = gemini_rejecting_logprobs(monkeypatch, "D")
    spend = SpendBuffer(_no_sink, "INR")
    intent, band, _ = asyncio.run(route(CTX, "Order 20 kg of onions from our usual supplier", FRAME, live_router(), spend))
    rows = spend.entries
    assert (intent, band, len(seen)) == ("draft_request", "unscored", 2)
    assert [(r["role"], r["provider"], r["model_id"]) for r in rows] == [("router", "gemini", "gemini-3.5-flash-lite")] * 2
    assert rows[0]["input_tokens"] > 0 and rows[1]["input_tokens"] == 247 and all(r["amount_minor"] >= 1 for r in rows)
    # At the router's price (R47 D1), by hand: the retry's 247 prompt tokens × 2,700 / 1,000,000 = 0.67 → 1 paisa.
    assert rows[1]["amount_minor"] == 1


async def _no_sink(_: object) -> None:
    return None


def test_map_columns_with_logprobs_rejected_abstains_without_a_retry(monkeypatch: pytest.MonkeyPatch) -> None:
    """Gate (b): map.columns cannot use an unscored answer, so the rejection abstains no_probabilities at once."""
    seen = gemini_rejecting_logprobs(monkeypatch, "L")
    q = MAP_COLUMNS["pos_bills"]
    [r] = asyncio.run(live_router().decide(CTX, {"header": "Qty", "headers": POS_BILLS_HEADERS}, [q]))
    assert (r.abstained, r.reason, r.band, r.answer, r.model_calls) == (True, "no_probabilities", "low", None, 1)
    assert answer_or_fallback(q, r) is None and len(seen) == 1


def test_the_retry_happens_at_most_once(monkeypatch: pytest.MonkeyPatch) -> None:
    """Gate (c): a retry that fails too ends adapter_error after exactly two calls; a 429 (ADK's
    _ResourceExhaustedError is a ClientError) is not a logprobs rejection: the DecisionModel never retries it (one model call).
    The provider class starts a 429 over once on its own (llm/providers.retrying, C3), so two requests reach the provider."""
    seen = gemini_rejecting_logprobs(monkeypatch, "D")

    async def always_400(self: Any, *, model: str, contents: Any, config: types.GenerateContentConfig) -> Any:
        seen.append(config)
        raise ClientError(400, {"error": {"code": 400, "message": "recorded rejection", "status": "INVALID_ARGUMENT"}})

    monkeypatch.setattr(AsyncModels, "generate_content", always_400)
    [r] = asyncio.run(live_router().decide(CTX, route_state("Order 20 kg of onions"), [ROUTE_INTENT]))
    assert (r.abstained, r.reason, r.model_calls, len(seen)) == (True, "adapter_error", 2, 2)
    assert answer_or_fallback(ROUTE_INTENT, r) == "explain"
    seen = gemini_rejecting_logprobs(monkeypatch, "D", status=429)
    [r] = asyncio.run(live_router().decide(CTX, route_state("Order 20 kg of onions"), [ROUTE_INTENT]))
    assert (r.abstained, r.reason, r.model_calls, len(seen)) == (True, "adapter_error", 1, 2)


def test_live_mode_uses_the_router_role_only() -> None:
    rows = json.loads((REPO / "services/intel/fixtures/model_roles_0015.json").read_text("utf8"))

    class Roles:
        async def model_roles(self) -> PlatformModelRoles:
            # 0015's roles, each priced (R47 D1: an unpriced live role is refused — tests/test_models.py).
            return PlatformModelRoles.model_validate({"items": [{**r, **ROUTER_PRICE_COLUMNS} for r in rows["items"]]})

    router_model = next(r["model_id"] for r in rows["items"] if r["role"] == "router")
    reason_model = next(r["model_id"] for r in rows["items"] if r["role"] == "reason")
    assert router_model != reason_model
    cfg = load_config(env={"MUNIM_MODEL_MODE": "live", "GEMINI_API_KEY": "gemini-test-key-not-real-0001"})
    dm = asyncio.run(router_decision_model(cfg, Roles(), currency="INR"))
    assert dm._llm.model == router_model  # noqa: SLF001
    assert dm._llm.price == ROUTER_PRICE  # type: ignore[attr-defined]  # noqa: SLF001


# --------------------------------------------------------------------------------- reflection over the registry (§4.4)


def _zod_enum(path: str, name: str) -> set[str]:
    m = re.search(rf"export const {name} = z\.enum\(\[([^\]]*)\]\)", (REPO / path).read_text("utf8"))
    assert m, f"{name} not found in {path}"
    return set(re.findall(r'"([^"]+)"', m.group(1)))


def test_registry_answers_are_finite_typed_choices_never_numbers_prose_severities_or_verdicts() -> None:
    kinds = set(_zod_enum("packages/contracts/src/imports/index.ts", "ImportKind"))
    assert len(QUESTIONS) == 1 + len(kinds) == 10  # 9 import kinds (T-093 added shift_log, stock_count) + map.columns
    assert {q.variant for q in QUESTIONS if q.key == "map.columns"} == kinds
    forbidden = (
        _zod_enum("packages/contracts/src/internal/index.ts", "Severity")
        | _zod_enum("packages/contracts/src/shared/trace.ts", "ReviewVerdict")
        | _zod_enum("packages/contracts/src/approvals/index.ts", "Verdict")
        | {"approve", "reject", "confirmed", "refuted", "complete", "incomplete"}
    )
    for q in QUESTIONS:
        assert q.kind in ("choice", "score", "predicate"), q.key
        assert isinstance(q.options, tuple) and 2 <= len(q.options) <= 26, q.key
        for o in q.options:
            assert re.fullmatch(r"[a-z][a-z0-9_]*", o), (q.key, o)  # a slug: no digits-only value, no spaces, no prose
            assert o not in forbidden, (q.key, o)
        if q.kind == "predicate":
            assert q.options == ("no", "yes")
        assert not q.egress & {"tenant_id", "run_id", "actor", "outlet_id", "outlet_ids", "token"}, q.key
    assert ROUTE_INTENT.egress == {"question", "outlet_kinds", "country"}
    assert set(ROUTE_INTENT.options) == INTENTS
    assert all(q.egress == {"header", "headers"} for q in MAP_COLUMNS.values())


def test_import_fields_match_core() -> None:
    """The map.columns answer sets equal core-api's FIELDS, parsed from the TypeScript source, in order."""
    src = (REPO / "services/core-api/src/modules/imports/formats.ts").read_text("utf8")
    block = src[src.index("export const FIELDS") : src.index("};", src.index("export const FIELDS"))]
    parsed: dict[str, tuple[str, ...]] = {}
    for kind, body in re.findall(r"\n  (\w+): \{(.*?)\n  \},", block, re.S):
        parsed[kind] = tuple(re.findall(r"(\w+): (?:[tmdn]\(|\{)", body))
    assert len(parsed) == 9  # 7 + shift_log + stock_count (T-093)
    assert parsed == IMPORT_FIELDS
    for kind, fields in IMPORT_FIELDS.items():
        assert MAP_COLUMNS[kind].options == (*fields, "ignore")


def test_question_definitions_refuse_open_answer_sets() -> None:
    """The constructor itself refuses what reflection checks, so a bad question cannot be registered."""
    base: dict[str, Any] = {
        "key": "x.y",
        "version": 1,
        "kind": "choice",
        "options": ("a", "b"),
        "instructions": "",
        "egress": frozenset({"f"}),
        "threshold_bp": 5_000,
        "fallback": None,
    }
    DecisionQuestion(**base)  # the paired accept
    for bad in (
        {"kind": "text"},
        {"options": ("a", "42")},
        {"options": ("a",)},
        {"kind": "predicate"},
        {"options": tuple("abcdefghijklmnopqrstuvwxyza")},
    ):
        with pytest.raises(ValueError):
            DecisionQuestion(**{**base, **bad})
