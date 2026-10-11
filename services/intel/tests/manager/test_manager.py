"""T-082b gates (BOARD b-82 (1)–(6)): the Manager ask, offline — real ADK Runner, real InternalClient, real plugin,
recorded models, an in-memory core (the internal API is the system boundary). The real core is test_manager_e2e.py.

Expected values never come from the code under test:
  (1) the path table is copied by hand below from ADR-014 §3.3's diagram and 04 §2 (and §4.3's low-band fallback);
  (2) propose is expected only on draft_request with one addressed skill (ADR-014 §5.1); each pack's propose tools
      are its registry draftables that are agent-exposed (ontology.json, generated from contracts — not intel code);
  (3) "0 LLM calls" counts the Manager's model; route.intent (the DecisionModel) is how the intent is known, 1 call;
  (4) each skill's expected tools come from that skill's own toolset (skills/<pack>/skill.py, T-044…T-051);
  (5) kitchen is off for shops: packs/kitchen.md §1 (hand);
  (6) one scripted model run, tainted thread vs untainted; drafts counted at the core boundary.
"""

from __future__ import annotations

import asyncio
import json
from typing import Any

import httpx
import pytest
from fastapi.testclient import TestClient

from conftest import SECRET
from manager_kit import (
    CTX,
    DISPUTE,
    EGRESS,
    KITCHEN,
    LLM_FIXTURES,
    LOOKUP_FINANCE,
    PADDED,
    ROUTE,
    SPECIALIST_NEEDED,
    TS,
    UNSCORED_INVESTIGATE,
    UNSURE,
    Counted,
    FakeCore,
    ask,
    frame,
    kit_cfg,
    models,
    reset,
    vid,
)
from munim_intel.app import create_app
from munim_intel.config import Config, load_config
from munim_intel.contracts_gen.models import ThreadsIntelAskRequest
from munim_intel.decide.mimic import LlmMimic
from munim_intel.decide.questions import ROUTE_INTENT
from munim_intel.llm.providers import ProviderUnavailable, RetiredModelRefused, TimedGemini
from munim_intel.manager.ask import Models, answer_ask, default_models, prepare
from munim_intel.manager.paths import PATHS, bind, path_for
from munim_intel.runtime.state import PACKS
from munim_intel.skills import load_skill
from munim_intel.tools.answer import SubmitAnswerTool
from munim_intel.tools.generated import uuid7
from munim_intel.tools.handles import HandleTable
from munim_intel.tools.ontology import load_ontology
from munim_intel.trace.price import Price

#: ADR-014 §3.3 / 04 §2, by hand: route.intent → path. The low band falls back to explain (§4.3).
HAND_PATHS = {
    "lookup": "answer",
    "explain": "answer",
    "out_of_scope": "answer",
    "investigate": "fan_out",
    "draft_request": "draft",
    "certification_request": "certificate",
}
#: ADR-014 §4.3, by hand.
HAND_INTENTS = ("lookup", "explain", "investigate", "draft_request", "certification_request", "out_of_scope")
#: ledger R45 F3.
TOOL_CAP = 20
#: By hand: the packs that propose nothing (R-B S1-B / S1-D ruling, 11 Oct: coupon.set and campaign.create unwired).
NO_DRAFTS = {"customers"}


def run(question: str, **kw: Any) -> tuple[dict[str, Any], FakeCore]:
    reset()
    out, core = asyncio.run(ask(question, **kw))
    return out.model_dump(mode="json"), core


def route_labels(core: FakeCore) -> dict[str, Any]:
    [route] = [e for e in core.traces if e["kind"] == "route" and "path" in e["payload"]]
    return dict(route["payload"])


def own_tools(pack: str, propose: bool = False) -> list[str]:
    frame_args = {"payroll_scope": "drafts"} if pack == "people" else {}
    client = FakeCore().client()
    return [t.name for t in load_skill(pack).toolset(CTX, client, HandleTable(), propose=propose, **frame_args)]


def bound(intent: str, addressed: str | None, scope: str = "restaurant") -> list[str]:
    core = FakeCore(frame(scope))
    req = ThreadsIntelAskRequest.model_validate({"answer_id": vid(80), "question": "q", "addressed_to": addressed, "thread": None})
    p = prepare(CTX, req, core.run_frame, core.client(), bind(PATHS[intent], addressed))
    return [t.name for t in p.toolset.tools]


# -- gate 1: route.intent → the hand path table ----------------------------------------------------------------------


def test_route_intent_options_are_the_six_of_adr_4_3() -> None:
    assert ROUTE_INTENT.options == HAND_INTENTS and set(PATHS) == set(HAND_INTENTS)


@pytest.mark.parametrize("question,code", [(q, c) for q, _, c, _ in ROUTE if not q.lstrip().startswith("@")], ids=lambda x: str(x)[:24])
def test_each_route_intent_takes_the_hand_path(question: str, code: str) -> None:
    intent = "explain" if question == UNSURE else HAND_INTENTS["ABCDEF".index(code)]
    out, core = run(question)
    labels = route_labels(core)
    print(f"{code} {labels}")
    assert labels["intent"] == intent and labels["path"] == HAND_PATHS[intent]
    assert (labels["band"] == "low") == (question == UNSURE)
    [answer] = core.answers
    assert answer["question"] == question and answer["envelope"]["answer_id"] == vid(80) == out["answer_id"]


def test_a_question_the_egress_check_refuses_falls_back_to_explain_and_sends_nothing() -> None:
    """A pasted id in the question: no UUID may leave the process (§4.3), so the router is not called at all."""
    out, core = run(EGRESS)
    assert route_labels(core) == {"intent": "explain", "band": "low", "path": "answer"}
    assert Counted.CALLS["recorded/router"] == 0 and len(core.answers) == 1


# -- R47 D5: ask before fanning out -----------------------------------------------------------------------------------

#: The scored investigation (ROUTE: code C at 0.83).
SCORED_INVESTIGATE = "Dig into why our margin fell this month across all outlets"


def declared(n: int) -> list[str]:
    """The tool names the Manager's model was offered on its n-th call."""
    return sorted(t["name"] for t in Counted.SEEN[n]["tools"])


def test_an_unscored_investigate_answers_single_agent_and_offers_to_dig_deeper() -> None:
    """Ledger R47 D5: route.intent says investigate with no probabilities (band `unscored`) → no `fan_out` on any of the
    Manager's calls (it loads one skill, reads, answers alone) and the stored answer offers follow_up `dig_deeper`."""
    out, core = run(UNSCORED_INVESTIGATE)
    assert route_labels(core) == {"intent": "investigate", "band": "unscored", "path": "answer", "follow_up": "dig_deeper"}
    assert len(Counted.SEEN) == 3 and all("fan_out" not in declared(n) for n in range(3))
    assert "read_finance_pnl" in declared(2), "it answered alone, through the skill it loaded"
    [answer] = core.answers
    assert answer["envelope"]["abstained"] is False and answer["envelope"]["follow_up"] == "dig_deeper"
    assert [t["actor"] for t in core.traces if t["kind"] == "subagent_start"] == ["manager"], "the Manager alone, no branch"


def test_paired_an_unscored_investigate_the_member_asked_to_dig_deeper_fans_out() -> None:
    """R47 D5, the offer tapped: the same unscored investigation with the member's `deep` binds `fan_out` (declared on
    the Manager's first call) and offers nothing more."""
    out, core = run(UNSCORED_INVESTIGATE, deep=True)
    assert route_labels(core) == {"intent": "investigate", "band": "unscored", "path": "fan_out"}
    assert "fan_out" in declared(0)
    [answer] = core.answers
    assert answer["envelope"]["follow_up"] is None


def test_deep_widens_only_an_unaddressed_investigation() -> None:
    """By hand from paths.py's table (R47 D5): `deep` changes the path of an unaddressed unscored `investigate` only."""
    got = {
        (intent, addressed): path_for(intent, "unscored", addressed, deep=True)
        for intent in ("lookup", "explain", "investigate", "out_of_scope")
        for addressed in (None, "finance")
    }
    assert {k: (p.name, f) for k, (p, f) in got.items()} == {
        ("lookup", None): ("answer", None),
        ("lookup", "finance"): ("answer", None),
        ("explain", None): ("answer", None),
        ("explain", "finance"): ("answer", None),
        ("investigate", None): ("fan_out", None),
        ("investigate", "finance"): ("fan_out", None),
        ("out_of_scope", None): ("answer", None),
        ("out_of_scope", "finance"): ("answer", None),
    }
    assert bind(path_for("investigate", "unscored", "finance", deep=True)[0], "finance").skill == "finance"  # still single agent


def test_paired_a_scored_investigate_binds_fan_out_and_offers_nothing() -> None:
    out, core = run(SCORED_INVESTIGATE)
    labels = route_labels(core)
    assert (labels["intent"], labels["path"], labels["band"] != "unscored") == ("investigate", "fan_out", True)
    assert "follow_up" not in labels and "fan_out" in declared(0)
    [answer] = core.answers
    assert answer["envelope"]["follow_up"] is None


# -- gate 2: propose_* only on draft_request with one skill ----------------------------------------------------------


def test_propose_is_bound_only_on_draft_request_with_one_addressed_skill() -> None:
    finance_drafts = sorted(
        a["tool"] for a in load_ontology()["actions"] if a["agent_exposed"] and a["command_type"].startswith("finance.")
    )
    assert len(finance_drafts) == 3, "packs/finance.md §6: dispute, journal adjust, period close"
    for intent in HAND_INTENTS:
        for addressed in (None, "finance"):
            if PATHS[intent].abstain is not None:
                continue
            tools = bound(intent, addressed)
            propose = sorted(t for t in tools if t.startswith("propose_"))
            print(f"{intent:22} {addressed or '-':8} tools {len(tools):2} propose {len(propose)}")
            if intent == "draft_request" and addressed == "finance":
                assert propose == finance_drafts and "load_skill" not in tools
            else:
                assert propose == [], (intent, addressed)


def test_an_unaddressed_draft_request_abstains_specialist_needed_with_no_manager_model_call() -> None:
    """DECISIONS 11 Oct (W3.3): no model picks the skill for a draft. Main thread, no @Name → `specialist_needed`."""
    [question] = [q for q, _, code, _ in ROUTE if code == "D" and not q.startswith("@")]
    out, core = run(question)
    [answer] = core.answers
    want = {"answer_id": vid(80), "segments": [], "abstained": True, "reason_code": SPECIALIST_NEEDED, "follow_up": None}
    assert answer["envelope"] == want
    assert Counted.CALLS["recorded/router"] == 1 and Counted.CALLS["recorded/reason"] == 0
    assert route_labels(core) == {"intent": "draft_request", "band": "high", "path": "draft"}
    assert core.minted == [] and core.drafts == [] and not [e for e in core.traces if e["kind"] == "skill_load"]
    assert out == {"answer_id": vid(80), "tainted": False}


def test_paired_an_addressed_draft_request_runs_the_model_with_that_skills_drafts() -> None:
    out, core = run(DISPUTE, addressed="finance", tainted_thread=False)
    assert Counted.CALLS["recorded/reason"] >= 1 and len(core.drafts) == 1
    assert core.answers[0]["envelope"]["reason_code"] is None and route_labels(core)["path"] == "draft"


@pytest.mark.parametrize("pack", PACKS)
def test_every_pack_on_draft_request_binds_its_own_drafts_within_the_cap(pack: str) -> None:
    ont = load_ontology()
    exposed = {a["command_type"]: a["tool"] for a in ont["actions"] if a["agent_exposed"]}
    # The skill's own DRAFTABLES, each an agent-exposed action (customers has none: R-B S1-B / S1-D).
    draftables = load_skill(pack).draftables
    assert all(d in exposed for d in draftables), pack
    expected = {exposed[d] for d in draftables}
    tools = bound("draft_request", pack)
    assert {t for t in tools if t.startswith("propose_")} == expected and bool(expected) == (pack not in NO_DRAFTS)
    assert len(tools) <= TOOL_CAP and tools[0] == "submit_answer" and "load_skill" not in tools


def test_the_scripted_draft_run_declares_propose_tools_to_the_model() -> None:
    """The real LlmRequest of the untainted dispute run: the finance draft tools are declared, nothing else proposes."""
    run(DISPUTE, addressed="finance", tainted_thread=False)
    declared = sorted(t["name"] for t in Counted.SEEN[0]["tools"])
    assert declared == sorted(["submit_answer", *own_tools("finance", propose=True)])
    run(LOOKUP_FINANCE, addressed="finance")
    assert not any(t["name"].startswith("propose_") for t in Counted.SEEN[0]["tools"])


# -- gate 3: certification_request → not_a_certificate, 0 Manager model calls ----------------------------------------


@pytest.mark.parametrize("question,addressed", [(q, "compliance" if q.startswith("@") else None) for q, _, c, _ in ROUTE if c == "E"])
def test_a_certification_request_abstains_not_a_certificate_with_zero_model_calls(question: str, addressed: str | None) -> None:
    out, core = run(question, addressed=addressed)
    [answer] = core.answers
    want = {"answer_id": vid(80), "segments": [], "abstained": True, "reason_code": "not_a_certificate", "follow_up": None}
    assert answer["envelope"] == want
    assert Counted.CALLS["recorded/reason"] == 0 and Counted.CALLS["recorded/router"] == 1
    assert route_labels(core)["path"] == "certificate" and core.minted == [] and core.drafts == []


def test_paired_a_lookup_does_call_the_managers_model() -> None:
    run("What did each delivery channel pay us this month?")
    assert Counted.CALLS["recorded/reason"] == 1 and Counted.CALLS["recorded/router"] == 1


# -- gate 4: @X forces exactly that skill's tools --------------------------------------------------------------------


@pytest.mark.parametrize("pack", PACKS)
def test_addressing_a_specialist_binds_exactly_that_skills_tools(pack: str) -> None:
    tools = bound("explain", pack)
    print(f"@{pack}: {len(tools)} tools")
    assert tools == ["submit_answer", *own_tools(pack)], "submit_answer and the skill's own read tools, nothing else"
    assert "load_skill" not in tools and not any(t.startswith("propose_") for t in tools)


def test_an_addressed_answer_is_the_specialists_and_its_refs_are_canonical() -> None:
    out, core = run(LOOKUP_FINANCE, addressed="finance")
    [answer] = core.answers
    env = answer["envelope"]
    [seg] = env["segments"]
    snap = uuid7(TS, "snap-1")  # the in-memory core's first mint
    assert env["abstained"] is False and seg["refs"] == [f"snap:{snap}"]
    assert seg["text"] == f"Net for ⟨snap:{snap}·0·key⟩ this month was ⟨snap:{snap}·0·net_minor⟩."
    actors = {e["actor"] for e in core.traces}
    assert actors == {"specialist:finance"}, actors
    assert out == {"answer_id": vid(80), "tainted": False}
    # Paired: the same kind of question unaddressed is the Manager's own.
    _, unaddressed = run("What did each delivery channel pay us this month?")
    assert {e["actor"] for e in unaddressed.traces} == {"manager"}


# -- gate 5: @Kitchen on a shop-only scope → not_applicable ----------------------------------------------------------


def test_kitchen_on_a_shop_only_scope_abstains_not_applicable_with_no_model_call() -> None:
    out, core = run(KITCHEN, addressed="kitchen", scope="store")
    [answer] = core.answers
    assert answer["envelope"]["reason_code"] == "not_applicable" and answer["envelope"]["abstained"] is True
    assert Counted.CALLS["recorded/router"] == 0 and Counted.CALLS["recorded/reason"] == 0
    assert {e["actor"] for e in core.traces} == {"specialist:kitchen"}


def test_paired_kitchen_with_a_restaurant_in_scope_binds_the_kitchen_tools() -> None:
    for scope in ("restaurant", "mixed"):
        assert bound("explain", "kitchen", scope) == ["submit_answer", *own_tools("kitchen")]
    out, core = run(KITCHEN, addressed="kitchen", scope="mixed")
    assert route_labels(core)["path"] == "answer" and Counted.CALLS["recorded/reason"] == 1
    assert sorted(t["name"] for t in Counted.SEEN[0]["tools"]) == sorted(["submit_answer", *own_tools("kitchen")])


# -- gate 6: a tainted thread → propose_* refused, 0 drafts; untainted → accepted ------------------------------------


def test_a_tainted_thread_refuses_the_proposal_and_writes_no_draft() -> None:
    out, core = run(DISPUTE, addressed="finance", tainted_thread=True)
    refused = [e for e in core.traces if e["kind"] == "tool_result" and e["payload"].get("reason") == "tainted_run"]
    assert [e["payload"]["tool"] for e in refused] == ["propose_finance_dispute_draft"], "refused (1)"
    assert core.drafts == [], "0 drafts"
    assert out["tainted"] is True


def test_paired_an_untainted_thread_accepts_the_proposal() -> None:
    out, core = run(DISPUTE, addressed="finance", tainted_thread=False)
    assert len(core.drafts) == 1, "accepted (1)"
    [draft] = core.drafts
    assert draft["pack"] == "finance" and draft["command_type"] == "finance.dispute.draft.v1"
    assert not [e for e in core.traces if e["payload"].get("reason") == "tainted_run"]
    assert out["tainted"] is False and core.answers[0]["envelope"]["abstained"] is False


# -- every exit stores one answer under core's id; the endpoint ------------------------------------------------------


@pytest.mark.fixture_miss_expected
def test_a_run_that_ends_without_submit_answer_stores_an_abstention() -> None:
    """A provider failure (here: no fixture for the step) degrades to "cannot verify" (rule 11), never an error."""
    out, core = run("A question nobody recorded an answer for", reason=Counted(model="recorded/reason", fixtures_dir=LLM_FIXTURES / "none"))
    [answer] = core.answers
    assert answer["envelope"]["reason_code"] == "missing_ref" and answer["question"] == "A question nobody recorded an answer for"


def test_ai_off_or_the_budget_spent_abstains_with_no_model_call() -> None:
    core = FakeCore(frame(narration="template"))
    req = ThreadsIntelAskRequest.model_validate(
        {"answer_id": vid(80), "question": LOOKUP_FINANCE, "addressed_to": "finance", "thread": None}
    )
    reset()
    asyncio.run(answer_ask(CTX, req, core.run_frame, core.client(), kit_cfg(), models()))
    assert core.answers[0]["envelope"]["reason_code"] == "model_blocked" and sum(Counted.CALLS.values()) == 0


def _roles(price: dict[str, Any]) -> dict[str, Any]:
    """0015's two roles an ask uses, as core serves them after 0026, with `price` on each (R47 D1)."""
    base = {"location": "global", "probed_at": None, "updated_at": "2026-10-10T00:00:00Z", **price}
    return {
        "items": [
            {"role": "router", "provider": "gemini", "model_id": "gemini-3.5-flash-lite", **base},
            {"role": "reason", "provider": "gemini", "model_id": "gemini-3.8-flash", **base},
        ]
    }


UNPRICED = {"input_price_per_mtok_minor": None, "output_price_per_mtok_minor": None, "price_currency": None}


@pytest.mark.parametrize(
    ("price", "code"),
    [
        (UNPRICED, "price_missing"),
        ({"input_price_per_mtok_minor": 30, "output_price_per_mtok_minor": 250, "price_currency": "USD"}, "price_currency_mismatch"),
    ],
)
def test_live_an_unpriced_or_foreign_priced_role_is_a_model_blocked_abstention_before_any_call(
    tmp_path: Any, price: dict[str, Any], code: str
) -> None:
    """R47 D1 on the ask path, live mode: the router has no operator price, or one in USD while the run spends INR (the
    frame's currency) → a stored model_blocked abstention, its abstain trace naming the price code, no model built, so
    no call and no spend row. Paired accept below: the same roles priced in INR build both models with their price."""
    live = load_config(env={"MUNIM_MODEL_MODE": "live", "MUNIM_RUN_DIR": str(tmp_path), "GEMINI_API_KEY": "gemini-test-key-not-real-0001"})
    core = FakeCore(model_roles=_roles(price))
    req = ThreadsIntelAskRequest.model_validate({"answer_id": vid(80), "question": "q", "addressed_to": None, "thread": None})
    asyncio.run(answer_ask(CTX, req, core.run_frame, core.client(), live, default_models(live)))
    [answer] = core.answers
    assert answer["envelope"]["reason_code"] == "model_blocked" and core.spend == []
    assert [e["payload"] for e in core.traces if e["kind"] == "abstain"] == [{"reason": "model_blocked", "price": code}]


def test_paired_live_roles_priced_in_the_runs_currency_build_both_models_with_their_price(tmp_path: Any) -> None:
    live = load_config(env={"MUNIM_MODEL_MODE": "live", "MUNIM_RUN_DIR": str(tmp_path), "GEMINI_API_KEY": "gemini-test-key-not-real-0001"})
    inr = {"input_price_per_mtok_minor": 2_700, "output_price_per_mtok_minor": 22_500, "price_currency": "INR"}
    core = FakeCore(model_roles=_roles(inr))

    async def build() -> Models:
        return await default_models(live)(core.client(), "INR")

    m = asyncio.run(build())
    assert isinstance(m.reason, TimedGemini) and m.reason.price == Price(2_700, 22_500, "INR")
    assert isinstance(m.decide, LlmMimic) and m.decide._llm.price == Price(2_700, 22_500, "INR")  # type: ignore[attr-defined]  # noqa: SLF001


def app_client(config: Config, core: FakeCore, m: Models | None = None) -> TestClient:
    return TestClient(create_app(config, core_transport=core.transport, ask_models=_factory(m or models())))


def _factory(m: Models) -> Any:
    async def build(*_: object) -> Models:
        return m

    return build


def test_the_ask_endpoint_answers_answer_id_and_taint_only(cfg: Config, minted: dict[str, Any]) -> None:
    core = FakeCore()
    reset()
    question = PADDED  # recorded (R-E 2-C: it once ran on a missing route fixture, unseen)
    body = {"answer_id": vid(81), "question": question, "addressed_to": "finance", "thread": None}
    headers = {"x-munim-service-secret": SECRET, "authorization": f"Bearer {minted['tokens']['ask']}"}
    r = app_client(cfg, core).post("/ask", json=body, headers=headers)
    assert r.status_code == 200 and r.json() == {"answer_id": vid(81), "tainted": False}
    [answer] = core.answers
    assert answer["question"] == question, "the member's question, byte for byte"
    sent = "\n".join([*core.bodies, r.text])
    for text in ("via Manager", "signature", "Finance ·"):
        assert text not in sent, f"intel sent signature text: {text!r}"


@pytest.mark.parametrize("narration", ["template", "model"])
@pytest.mark.parametrize("error", [ProviderUnavailable("gemini: GEMINI_API_KEY is not set"), RetiredModelRefused("gemini-2.5-x")])
def test_a_model_that_cannot_be_built_is_a_model_blocked_abstention_not_a_502(
    cfg: Config, minted: dict[str, Any], narration: str, error: Exception
) -> None:
    """R-E 2-A: the models are built after the AI-off exit, and a role that cannot be built is AI unavailable — a stored
    model_blocked abstention, 200 — on AI off and on AI on alike. Paired accept: the endpoint test above answers."""
    built: list[str] = []

    async def unbuildable(*_: object) -> Models:
        built.append("called")
        raise error

    core = FakeCore(frame(narration=narration))
    client = TestClient(create_app(cfg, core_transport=core.transport, ask_models=unbuildable))
    body = {"answer_id": vid(81), "question": LOOKUP_FINANCE, "addressed_to": "finance", "thread": None}
    headers = {"x-munim-service-secret": SECRET, "authorization": f"Bearer {minted['tokens']['ask']}"}
    r = client.post("/ask", json=body, headers=headers)
    assert r.status_code == 200 and r.json() == {"answer_id": vid(81), "tainted": False}
    [answer] = core.answers
    assert answer["envelope"]["abstained"] is True and answer["envelope"]["reason_code"] == "model_blocked"
    assert built == ([] if narration == "template" else ["called"]), "AI off never builds a model"
    assert core.spend == []


def test_the_ask_endpoint_refuses_other_tokens_and_bad_bodies(cfg: Config, minted: dict[str, Any]) -> None:
    core = FakeCore()
    client = app_client(cfg, core)
    body = {"answer_id": vid(81), "question": "q", "addressed_to": None, "thread": None}
    ok_headers = {"x-munim-service-secret": SECRET, "authorization": f"Bearer {minted['tokens']['ask']}"}
    event_token = {"x-munim-service-secret": SECRET, "authorization": f"Bearer {minted['tokens']['valid']}"}
    no_secret = {"authorization": f"Bearer {minted['tokens']['ask']}"}
    assert client.post("/ask", json=body, headers=event_token).status_code == 401, "an event token buys no ask"
    assert client.post("/ask", json=body, headers=no_secret).status_code == 401
    assert client.post("/ask", json={**body, "signature": "x"}, headers=ok_headers).status_code == 400
    assert client.post("/ask", json={**body, "addressed_to": "manager"}, headers=ok_headers).status_code == 400
    assert core.answers == [] and core.bodies == []


def test_core_refusing_the_run_frame_is_unavailable_and_stores_nothing(cfg: Config, minted: dict[str, Any]) -> None:
    refusing = httpx.MockTransport(lambda _: httpx.Response(503))
    client = TestClient(create_app(cfg, core_transport=refusing, ask_models=_factory(models())))
    headers = {"x-munim-service-secret": SECRET, "authorization": f"Bearer {minted['tokens']['ask']}"}
    r = client.post("/ask", json={"answer_id": vid(81), "question": "q", "addressed_to": None, "thread": None}, headers=headers)
    assert r.status_code == 503 and json.loads(r.text)["error"]["code"] == "unavailable"


# -- submit_answer: fail closed, refs from the expansion, first call wins --------------------------------------------


class _Actions:
    skip_summarization = False


class _Ctx:
    def __init__(self) -> None:
        self.actions = _Actions()


def submit_tool() -> tuple[SubmitAnswerTool, str]:
    table = HandleTable()
    snap = uuid7(TS, "submit-snap")
    table.add_snapshot(
        {
            "snapshot_id": snap,
            "template_id": "finance.pnl",
            "columns": [{"name": "net_minor", "type": "integer"}],
            "rows": [{"net_minor": 5}],
        }
    )
    return SubmitAnswerTool(vid(80), table, lambda: ["settlements_missing"]), snap


def submit(tool: SubmitAnswerTool, segments: list[str], abstain: str | None = None) -> tuple[dict[str, Any], bool]:
    ctx = _Ctx()
    out = asyncio.run(tool.run_async(args={"segments": [{"text": t} for t in segments], "abstain": abstain}, tool_context=ctx))  # type: ignore[arg-type]
    return out, ctx.actions.skip_summarization


def test_submit_answer_builds_refs_from_the_expansion_and_ends_the_run() -> None:
    tool, snap = submit_tool()
    out, ended = submit(tool, ["Net was {S1.r0.net_minor}."])
    assert out == {"status": "submitted"} and ended
    assert tool.envelope is not None and tool.envelope.model_dump(mode="json") == {
        "answer_id": vid(80),
        "segments": [{"text": f"Net was ⟨snap:{snap}·0·net_minor⟩.", "refs": [f"snap:{snap}"]}],
        "abstained": False,
        "reason_code": None,
        "follow_up": None,
    }
    again, _ = submit(tool, ["Net was {S1.r0.net_minor}."])
    assert "error" in again, "first call wins"


@pytest.mark.parametrize(
    "text,code",
    [
        ("Net was {S9.r0.net_minor}.", "unresolved_ref"),  # never minted
        (f"Net was ⟨snap:{vid(70)}·0·net_minor⟩.", "unresolved_ref"),  # a canonical ref this run never minted (forged)
        ("Net was {S1.r0.net_minor}, up 12 on last month.", "number_grammar"),  # a typed digit
        ("Net was {S1.r0.net_minor}, up twelve on last month.", "number_grammar"),  # a number word
        ("Net went up this month.", "missing_ref"),  # cites nothing
        ("Net was {S1.r0.net_minor}k this month.", "number_grammar"),  # R-E 2-B: a magnitude suffix on the expanded ref
        ("Net was {S1.r0.net_minor} ⟩ this month.", "unresolved_ref"),  # R-E 2-B: a ref delimiter typed by the model
        ("Net was {S1.r0.net_minor} or ⟨snap:bogus⟩.", "unresolved_ref"),  # a malformed ref typed by the model
    ],
)
def test_submit_answer_refuses_once_then_abstains_with_the_rule(text: str, code: str) -> None:
    tool, _ = submit_tool()
    first, ended = submit(tool, [text])
    assert "error" in first and not ended and tool.envelope is None, "one retry (§5.3)"
    second, ended = submit(tool, [text])
    assert second == {"status": "abstained", "reason_code": code} and ended
    assert tool.envelope is not None and tool.envelope.abstained and tool.envelope.segments == []


def test_submit_answer_refuses_a_typed_canonical_ref_even_of_a_minted_cell_and_accepts_its_handle() -> None:
    """R-E 2-B: the model never types a ref, not even an exact copy of one this run minted; the handle is the way."""
    tool, snap = submit_tool()
    first, _ = submit(tool, [f"Net was ⟨snap:{snap}·0·net_minor⟩."])
    assert "error" in first and snap not in first["error"]
    ok, ended = submit(tool, ["Net was {S1.r0.net_minor}."])
    assert ok == {"status": "submitted"} and ended


def test_submit_answer_abstains_only_with_the_loaded_skills_codes_and_the_always_codes() -> None:
    tool, _ = submit_tool()
    enum = tool.schema()["properties"]["abstain"]["enum"]
    assert enum == ["settlements_missing", "missing_ref", "insufficient_history", None]
    assert tool.validate_args({"segments": [], "abstain": "not_a_certificate"}) is not None
    assert tool.validate_args({"segments": [], "abstain": "settlements_missing"}) is None
    out, ended = submit(tool, [], "settlements_missing")
    assert out == {"status": "abstained", "reason_code": "settlements_missing"} and ended
