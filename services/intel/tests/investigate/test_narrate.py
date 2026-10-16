"""T-083 narration (intel half), offline: core's internal API in memory, the model a scripted stand-in that records each
request it is sent. Expected values are hand-written here (the template sentences are core's, carried in the request).

  - the narration agent is sent 0 tools, makes at most 1 model call, and the run is untainted;
  - a model line stands only if it cites its own item's handle and types no number; anything else → core's template;
  - AI off (run-frame narration = template), no run-frame, a failed run → every item is core's template, 0 model calls;
  - the answer is stored once under core's answer id with core's question unchanged; the reply has no prose;
  - the route takes ask tokens only and refuses a malformed body.
"""

from __future__ import annotations

import asyncio
import json
from collections.abc import AsyncGenerator
from typing import Any

import httpx
import pytest
from fastapi.testclient import TestClient
from google.adk.models import BaseLlm
from google.adk.models.google_llm import Gemini
from google.adk.models.llm_request import LlmRequest
from google.adk.models.llm_response import LlmResponse
from google.genai import types
from google.genai.errors import ClientError

from conftest import GEMINI_KEY, SECRET
from munim_intel.app import create_app
from munim_intel.config import Config, load_config
from munim_intel.contracts_gen.models import InternalRunFrameResponse, InvestigationsNarrateRequest
from munim_intel.investigate import narrate_step
from munim_intel.runtime.context import RunContext
from munim_intel.runtime.internal_client import InternalClient


def vid(n: int) -> str:
    return f"0199e0a0-0000-7000-8000-{n:012x}"


S1, S2 = vid(900), vid(901)
CTX = RunContext(vid(3), vid(1), ("*",), "ask", vid(2), 2_000_000_000, "h.p.s")
QUESTION = "investigation margin_fall step"


def ref(s: str, row: int, col: str) -> str:
    return f"⟨snap:{s}·{row}·{col}⟩"


TEMPLATES = {
    "supplier_price": (
        f"Supplier prices moved the margin the same way as the total change {ref(S1, 3, 'delta_minor')}, {ref(S1, 3, 'share_bp')}."
    ),
    "labour": f"Labour cost does not explain this margin change {ref(S1, 7, 'delta_minor')}, {ref(S1, 7, 'share_bp')}.",
    "data_complete": f"Some tills, payouts or bank lines are still missing for the months compared {ref(S2, 1, 'open_count')}.",
}


def request() -> InvestigationsNarrateRequest:
    return InvestigationsNarrateRequest.model_validate(
        {
            "answer_id": vid(50),
            "question": QUESTION,
            "playbook_id": "margin_fall",
            "owner": "finance",
            "items": [
                {
                    "item_id": "supplier_price",
                    "specialist": "inventory_purchasing",
                    "verdict": "supported",
                    "cells": [
                        {"ref": ref(S1, 3, "delta_minor"), "column": "delta_minor"},
                        {"ref": ref(S1, 3, "share_bp"), "column": "share_bp"},
                    ],
                    "template": TEMPLATES["supplier_price"],
                },
                {
                    "item_id": "labour",
                    "specialist": "people",
                    "verdict": "refuted",
                    "cells": [
                        {"ref": ref(S1, 7, "delta_minor"), "column": "delta_minor"},
                        {"ref": ref(S1, 7, "share_bp"), "column": "share_bp"},
                    ],
                    "template": TEMPLATES["labour"],
                },
                {
                    "item_id": "data_complete",
                    "specialist": "finance",
                    "verdict": "cannot_verify",
                    "cells": [{"ref": ref(S2, 1, "open_count"), "column": "open_count"}],
                    "template": TEMPLATES["data_complete"],
                },
            ],
        }
    )


def frame(narration: str = "model") -> InternalRunFrameResponse:
    return InternalRunFrameResponse.model_validate(
        {
            "pack": {"code": "IN", "version": 3},
            "currency": "INR",
            "severity_ladder": {"critical_minor_gte": 1, "high_minor_gte": 1, "medium_minor_gte": 1},
            "detectors": {},
            "outlets": [],
            "budget": None,
            "narration": narration,
            "licence_kinds": [],
            "payroll_scope": "drafts",
            "negotiation": {"target_bp": 9500, "walkaway_bp": 11000},
        }
    )


#: platform.model_role with the narrate role priced in INR (a live narration needs a price, R47 D1).
ROLES = {
    "items": [
        {
            "role": "narrate",
            "model_id": "gemini-3.5-flash-lite",
            "provider": "gemini",
            "location": "global",
            "probed_at": None,
            "updated_at": "2026-10-10T00:00:00Z",
            "input_price_per_mtok_minor": 2_700,
            "output_price_per_mtok_minor": 22_500,
            "price_currency": "INR",
        }
    ]
}


class Core:
    def __init__(self, run_frame: InternalRunFrameResponse | None = None) -> None:
        self.run_frame = run_frame
        self.answers: list[dict[str, Any]] = []
        self.traces: list[dict[str, Any]] = []
        self.spend: list[dict[str, Any]] = []
        self.transport = httpx.MockTransport(self.handle)

    def client(self) -> InternalClient:
        return InternalClient(CTX, base_url="http://core.test", service_secret="t083-secret", transport=self.transport)

    def handle(self, request: httpx.Request) -> httpx.Response:
        path = request.url.path.removeprefix("/internal/intel/v1/")
        if request.method == "GET" and path == "run-frame":
            return httpx.Response(200, content=self.run_frame.model_dump_json()) if self.run_frame else httpx.Response(503)
        if request.method == "GET" and path == "model-roles":
            return httpx.Response(200, json=ROLES)
        body = json.loads(request.content)
        if path == "answers":
            self.answers.append(body)
            env = body["envelope"]
            return httpx.Response(
                201, json={"answer_id": env["answer_id"], "abstained": env["abstained"], "reason_code": env["reason_code"]}
            )
        if path == "traces:batch":
            self.traces += body["events"]
            return httpx.Response(201, json={"inserted": len(body["events"]), "last_seq": len(self.traces)})
        if path == "spend":
            self.spend += body["entries"]
            return httpx.Response(201, json={"inserted": len(body["entries"]), "existing": 0})
        return httpx.Response(404)


class Scripted(BaseLlm):
    """Answers every request with `reply`; keeps each request (its tools are the gate's evidence)."""

    model: str = "scripted/narrate"
    reply: str = ""
    fail: bool = False
    requests: list[LlmRequest] = []

    async def generate_content_async(self, llm_request: LlmRequest, stream: bool = False) -> AsyncGenerator[LlmResponse, None]:
        self.requests.append(llm_request)
        if self.fail:
            raise RuntimeError("provider down")
        yield LlmResponse(content=types.Content(role="model", parts=[types.Part(text=self.reply)]))


def config() -> Config:
    return load_config(env={})


def run(core: Core, llm: BaseLlm | None, narration: str | None = "model") -> Any:
    core.run_frame = frame(narration) if narration else None
    return asyncio.run(narrate_step(CTX, request(), core.run_frame, core.client(), config(), llm))


def segments(core: Core) -> dict[str, str]:
    [answer] = core.answers
    return {i: s["text"] for i, s in zip(["supplier_price", "labour", "data_complete"], answer["envelope"]["segments"], strict=True)}


def test_one_call_no_tools_handles_not_values_and_untainted() -> None:
    llm = Scripted(
        reply="supplier_price: Supplier prices pushed the margin down {C1}.\nlabour: Labour is not the cause {C4}.\n"
        "data_complete: Some payouts are still missing {C5}.",
        requests=[],
    )
    core = Core()
    out = run(core, llm)
    assert len(llm.requests) == 1
    req = llm.requests[0]
    assert not (req.config.tools or []), "the narration agent is sent no tools"
    sent = json.dumps([c.model_dump(mode="json") for c in req.contents])
    assert "{C1}" in sent and "⟨snap:" not in sent and S1 not in sent, "the model sees handles, never refs or ids"
    assert (out.source, out.tainted, out.answer_id.root) == ("model", False, vid(50))
    s = segments(core)
    assert s["supplier_price"] == f"Supplier prices pushed the margin down {ref(S1, 3, 'delta_minor')}."
    assert s["labour"] == f"Labour is not the cause {ref(S1, 7, 'share_bp')}."
    [answer] = core.answers
    assert answer["question"] == QUESTION and answer["envelope"]["abstained"] is False
    assert [seg["refs"] for seg in answer["envelope"]["segments"]] == [[f"snap:{S1}"], [f"snap:{S1}"], [f"snap:{S2}"]]
    assert {e["actor"] for e in core.traces} == {"specialist:finance"}
    # W3 close ruling (money): the one call is one spend row, `narrate`, in the frame's currency — with its tokens, at 0:
    # a replay has no operator price (R47 D1; priced arithmetic: tests/trace/test_spend.py).
    assert [(e["role"], e["currency"], e["amount_minor"]) for e in core.spend] == [("narrate", "INR", 0)]
    assert core.spend[0]["input_tokens"] > 0


@pytest.mark.parametrize(
    ("line", "why"),
    [
        ("labour: Labour moved by 0 rupees {C4}.", "a typed digit"),
        ("labour: Labour moved by five percent {C4}.", "a number word"),
        ("labour: Labour is not the cause {C1}.", "another item's handle"),
        ("labour: Labour is not the cause {C9}.", "an unknown handle"),
        ("labour: Labour is not the cause.", "no handle"),
        ("labour: Labour is not the cause {C4} {S1.r0.x}.", "a stray brace"),
        ("labour: Labour moved by {C4}k.", "a magnitude suffix on the expanded ref"),
        (f"labour: Labour is not the cause {ref(S1, 7, 'share_bp')} {{C4}}.", "a ref the model typed itself"),
        ("labour: Labour is not the cause ⟨snap:CANARYXQZ⟩ {C4}.", "a malformed ref the model typed"),
    ],
)
def test_an_unusable_line_is_core_template_for_that_item_only(line: str, why: str) -> None:
    llm = Scripted(reply=f"supplier_price: Supplier prices pushed the margin down {{C1}}.\n{line}", requests=[])
    core = Core()
    out = run(core, llm)
    s = segments(core)
    assert s["labour"] == TEMPLATES["labour"], why
    assert s["data_complete"] == TEMPLATES["data_complete"], "a missing line is the template"
    assert s["supplier_price"] != TEMPLATES["supplier_price"] and out.source == "model"


def test_a_line_the_contract_refuses_is_template_and_no_model_text_reaches_a_log(
    monkeypatch: pytest.MonkeyPatch, caplog: pytest.LogCaptureFixture, cfg: Config, minted: dict[str, Any]
) -> None:
    """R-E 1-B: a model line that passes the line checks but not the contract (here: the bracket and grammar checks are
    planted away, so a typed bogus ref reaches the envelope) is that item's template; the route answers 200, not 500, and
    no log line carries the model's text (pydantic's ValidationError echoes its input)."""
    import munim_intel.investigate as inv

    monkeypatch.setattr(inv, "typed_bracket", lambda _: False)
    monkeypatch.setattr(inv, "check_grammar", lambda _: None)
    core = Core(frame("model"))

    async def model_of(_: object) -> BaseLlm:
        return Scripted(reply="supplier_price: Fine {C1}.\nlabour: Labour moved ⟨snap:CANARYXQZ⟩ {C4}.", requests=[])

    client = TestClient(create_app(cfg, core_transport=core.transport, narrate_llm=model_of), raise_server_exceptions=False)
    headers = {"x-munim-service-secret": SECRET, "authorization": f"Bearer {minted['tokens']['ask']}"}
    with caplog.at_level("DEBUG"):
        r = client.post("/investigate:narrate", json=request().model_dump(mode="json"), headers=headers)
    assert r.status_code == 200 and r.json()["source"] == "model"
    s = segments(core)
    assert s["labour"] == TEMPLATES["labour"] and s["supplier_price"] == f"Fine {ref(S1, 3, 'delta_minor')}."
    assert "CANARYXQZ" not in caplog.text and "CANARYXQZ" not in r.text


def test_an_auto_step_token_buys_a_narration_and_its_call_is_charged_and_an_event_token_does_not(
    cfg: Config, minted: dict[str, Any]
) -> None:
    """Auto mode (T-089b): the worker narrates each step under an `auto_step` run, so the route takes that token as it
    takes an ask one, and the call is one `narrate` spend row as under an ask (W3 close ruling). Paired: an event token
    is the uniform 401 and nothing is written."""
    core = Core(frame("model"))

    async def model_of(_: object) -> BaseLlm:
        return Scripted(reply="supplier_price: Supplier prices pushed the margin down {C1}.", requests=[])

    client = TestClient(create_app(cfg, core_transport=core.transport, narrate_llm=model_of))
    body = request().model_dump(mode="json")
    event = {"x-munim-service-secret": SECRET, "authorization": f"Bearer {minted['tokens']['valid']}"}
    refused = client.post("/investigate:narrate", json=body, headers=event)
    assert refused.status_code == 401 and core.answers == [] and core.spend == []
    auto = {"x-munim-service-secret": SECRET, "authorization": f"Bearer {minted['tokens']['auto_step']}"}
    r = client.post("/investigate:narrate", json=body, headers=auto)
    assert r.status_code == 200 and r.json() == {"answer_id": vid(50), "tainted": False, "source": "model"}
    assert len(core.answers) == 1 and [(e["role"], e["currency"]) for e in core.spend] == [("narrate", "INR")]


@pytest.mark.parametrize(("narration", "fail"), [("template", False), (None, False), ("model", True)])
def test_ai_off_no_frame_or_a_failed_run_is_all_template(narration: str | None, fail: bool) -> None:
    llm = Scripted(reply="supplier_price: Fine {C1}.", fail=fail, requests=[])
    core = Core()
    out = run(core, llm, narration)
    assert segments(core) == TEMPLATES
    assert out.source == "template" and out.tainted is False
    assert len(llm.requests) == (1 if fail else 0)
    assert len(core.spend) == (1 if fail else 0), "a failed call is still charged; no call, no row"


@pytest.mark.parametrize(
    ("ai_enabled", "level", "mode", "narrates"),
    [(False, "hard", "live", False), (True, None, "live", False), (True, "hard", "recorded", False), (True, "hard", "live", True)],
)
def test_over_the_cap_a_live_step_narrates_and_never_with_ai_off(ai_enabled: bool, level: str | None, mode: str, narrates: bool) -> None:
    """T-127 (R58): over the month's AI cap with AI on, in live mode, the step narrates (its model is the capped one the app
    builds: each call served from its recorded fixture or abstaining); AI switched off, no budget for the month or recorded
    mode keep core's template, with no model call."""
    budget = None
    if level is not None:
        budget = {
            "month": "2026-10-01",
            "currency": "INR",
            "owner_cap_minor": None,
            "operator_limit_minor": 500_000,
            "effective_cap_minor": 500_000,
            "spent_minor": 500_000,
            "hard_left_minor": 0,
            "level": level,
        }
    core = Core(
        InternalRunFrameResponse.model_validate({**frame("template").model_dump(mode="json"), "budget": budget, "ai_enabled": ai_enabled})
    )
    llm = Scripted(reply="supplier_price: Supplier prices pushed the margin down {C1}.", requests=[])
    out = asyncio.run(narrate_step(CTX, request(), core.run_frame, core.client(), load_config(env={"MUNIM_MODEL_MODE": mode}), llm))
    assert (out.source, len(llm.requests)) == (("model", 1) if narrates else ("template", 0))


@pytest.mark.parametrize(("level", "provider_calls"), [("hard", 0), ("ok", 2)])
def test_over_the_cap_the_app_builds_the_narration_model_capped_and_no_call_reaches_the_provider(
    level: str, provider_calls: int, cfg: Config, minted: dict[str, Any], monkeypatch: pytest.MonkeyPatch
) -> None:
    """T-127 (R58, money): through the app in live mode, a step over the month's cap (AI on) builds the narrate model `capped`:
    no call reaches the provider (no fixture holds this narration, so the step keeps core's template). Paired: with budget left
    the same step calls the provider (rate-limited here, so it too keeps the template): twice, the try and the one retry of a 429
    (llm/providers.retrying, C3)."""
    calls: list[str] = []

    async def rate_limited(_llm: Gemini, llm_request: LlmRequest, stream: bool = False) -> AsyncGenerator[LlmResponse, None]:
        calls.append(llm_request.model or "")
        raise ClientError(429, {"error": {"code": 429, "message": "PLANTED quota exceeded", "status": "RESOURCE_EXHAUSTED"}})
        yield LlmResponse()  # pragma: no cover — an async generator

    monkeypatch.setattr(Gemini, "generate_content_async", rate_limited)
    live = load_config(env={"MUNIM_RUN_DIR": str(cfg.run_dir), "GEMINI_API_KEY": GEMINI_KEY, "MUNIM_MODEL_MODE": "live"})
    budget = {
        "month": "2026-10-01",
        "currency": "INR",
        "owner_cap_minor": None,
        "operator_limit_minor": 500_000,
        "effective_cap_minor": 500_000,
        "spent_minor": 500_000 if level == "hard" else 0,
        "hard_left_minor": 0 if level == "hard" else 500_000,
        "level": level,
    }
    narration = "template" if level == "hard" else "model"
    core = Core(InternalRunFrameResponse.model_validate({**frame(narration).model_dump(mode="json"), "budget": budget, "ai_enabled": True}))
    client = TestClient(create_app(live, core_transport=core.transport))
    headers = {"x-munim-service-secret": SECRET, "authorization": f"Bearer {minted['tokens']['ask']}"}
    r = client.post("/investigate:narrate", json=request().model_dump(mode="json"), headers=headers)
    assert r.status_code == 200 and r.json()["source"] == "template"
    assert len(calls) == provider_calls


def test_the_route_takes_ask_tokens_only_and_refuses_bad_bodies(cfg: Config, minted: dict[str, Any]) -> None:
    core = Core(frame("template"))

    async def model_of(_: object) -> BaseLlm:
        return Scripted(requests=[])

    client = TestClient(create_app(cfg, core_transport=core.transport, narrate_llm=model_of))
    body = request().model_dump(mode="json")
    ask = {"x-munim-service-secret": SECRET, "authorization": f"Bearer {minted['tokens']['ask']}"}
    event = {"x-munim-service-secret": SECRET, "authorization": f"Bearer {minted['tokens']['valid']}"}
    assert client.post("/investigate:narrate", json=body, headers=event).status_code == 401, "an event token buys no narration"
    assert client.post("/investigate:narrate", json={**body, "signature": "x"}, headers=ask).status_code == 400
    assert core.answers == []
    r = client.post("/investigate:narrate", json=body, headers=ask)
    assert r.status_code == 200 and r.json() == {"answer_id": vid(50), "tainted": False, "source": "template"}
    assert len(core.answers) == 1
