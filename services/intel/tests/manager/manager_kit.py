"""T-082b test kit: run frames, an in-memory core behind the real InternalClient (the internal API is the system
boundary; the real one runs in test_manager_e2e.py), recorded models, and the fixture recorder.

Fixtures (`tests/manager/fixtures/`), authored with `uv run --frozen python tests/manager/manager_kit.py --record`:
  decide/   route.intent replies, written as the router model's option CODE with a probability spread (as T-081's
            make_fixtures): SYNTHETIC — they prove the plumbing, never routing quality (ADR-014 §4.5);
  reason/   the Manager's model steps, recorded from SCRIPTS through the real ADK Runner (as T-082a's recorder).
"""

from __future__ import annotations

import asyncio
import json
import math
import sys
from collections import Counter
from collections.abc import AsyncGenerator
from pathlib import Path
from typing import Any, ClassVar

import httpx
from google.adk.models import BaseLlm
from google.adk.models.llm_request import LlmRequest
from google.adk.models.llm_response import LlmResponse
from google.genai import types

from munim_intel.config import Config, load_config
from munim_intel.contracts_gen.models import (
    InternalRunFrameResponse,
    ThreadsBlock,
    ThreadsIntelAskRequest,
    ThreadsIntelAskResponse,
)
from munim_intel.decide.mimic import LlmMimic, build_request
from munim_intel.decide.port import DecisionState
from munim_intel.decide.questions import ROUTE_INTENT
from munim_intel.llm.recorded import RecordedLlm, projection, request_key
from munim_intel.manager.ask import Models, answer_ask, outlet_kinds
from munim_intel.runtime.context import RunContext
from munim_intel.runtime.internal_client import InternalClient
from munim_intel.tools.generated import uuid7
from munim_intel.tools.ontology import load_ontology

HERE = Path(__file__).resolve().parent
DM_FIXTURES = HERE / "fixtures" / "decide"
LLM_FIXTURES = HERE / "fixtures" / "reason"
TS = 1_760_000_000_000


def vid(n: int) -> str:
    return uuid7(TS, f"t082b-{n}")


TENANT, MEMBER, RUN = vid(1), vid(2), vid(3)
CTX = RunContext(RUN, TENANT, ("*",), "ask", MEMBER, 2_000_000_000, "h.p.s")
LADDER = {"critical_minor_gte": 5_000_000, "high_minor_gte": 1_000_000, "medium_minor_gte": 100_000}
OUTLETS: dict[str, list[dict[str, str]]] = {
    "restaurant": [
        {"id": vid(20), "name": "Indiranagar Kitchen", "kind": "restaurant", "tz": "Asia/Kolkata", "business_date": "2026-10-10"},
        {"id": vid(21), "name": "Koramangala Cloud", "kind": "cloud_kitchen", "tz": "Asia/Kolkata", "business_date": "2026-10-10"},
    ],
    "store": [{"id": vid(22), "name": "Jayanagar Corner Store", "kind": "store", "tz": "Asia/Kolkata", "business_date": "2026-10-10"}],
    "mixed": [
        {"id": vid(22), "name": "Jayanagar Corner Store", "kind": "store", "tz": "Asia/Kolkata", "business_date": "2026-10-10"},
        {"id": vid(20), "name": "Indiranagar Kitchen", "kind": "restaurant", "tz": "Asia/Kolkata", "business_date": "2026-10-10"},
    ],
}


def frame(scope: str = "restaurant", narration: str = "model") -> InternalRunFrameResponse:
    return InternalRunFrameResponse.model_validate(
        {
            "pack": {"code": "IN", "version": 3},
            "currency": "INR",
            "severity_ladder": LADDER,
            "detectors": {},
            "outlets": OUTLETS[scope],
            "budget": None,
            "narration": narration,
            "licence_kinds": [],
            "payroll_scope": "drafts",
            "negotiation": {"target_bp": 9500, "walkaway_bp": 11000},
        }
    )


def thread(tainted: bool) -> ThreadsBlock:
    """A thread with two earlier turns; one cited segment in the rolling summary."""
    return ThreadsBlock.model_validate(
        {
            "thread_id": vid(90),
            "summary_refs": [{"turn_no": 1, "answer_id": vid(91), "segment": 0, "refs": [f"snap:{vid(92)}"]}],
            "last_turn_ids": [vid(93), vid(94)],
            "tainted": tainted,
        }
    )


#: The abstention of an unaddressed draft request (contracts reason-codes.ts, T-088b).
SPECIALIST_NEEDED = "specialist_needed"


# -- the in-memory core ----------------------------------------------------------------------------------------------

#: What each template mint returns (synthetic).
ROWS: dict[str, list[dict[str, Any]]] = {
    "finance.pnl": [
        {
            "key": "swiggy",
            "revenue_minor": 1_250_000,
            "cogs_minor": 400_000,
            "channel_fees_minor": 230_000,
            "labour_minor": 180_000,
            "other_minor": 40_000,
            "net_minor": 400_000,
        },
        {
            "key": "zomato",
            "revenue_minor": 980_000,
            "cogs_minor": 320_000,
            "channel_fees_minor": 190_000,
            "labour_minor": 150_000,
            "other_minor": 30_000,
            "net_minor": 290_000,
        },
    ],
    "finance.settlement_vs_orders": [
        {
            "settlement_line_id": vid(40),
            "matched_order_id": vid(41),
            "order_total_minor": 84_000,
            "commission_minor": 15_120,
            "net_minor": 52_000,
            "expected_commission_minor": 15_120,
            "refund_minor": 0,
            "expected_net_minor": 64_960,
            "short_minor": 12_960,
            "settlement_id": vid(42),
            "channel_id": vid(43),
        },
    ],
}


class FakeCore:
    """core's internal API in memory: every request intel sends is kept (raw bodies too, for the signature scan)."""

    def __init__(self, run_frame: InternalRunFrameResponse | None = None, model_roles: dict[str, Any] | None = None) -> None:
        self.run_frame = run_frame or frame()
        #: `platform.model_role` as core serves it (live mode only reads it).
        self.model_roles = model_roles
        self.minted: list[str] = []
        self.drafts: list[dict[str, Any]] = []
        self.answers: list[dict[str, Any]] = []
        self.traces: list[dict[str, Any]] = []
        #: Spend rows intel posted (one per provider call; W3 close ruling).
        self.spend: list[dict[str, Any]] = []
        self.bodies: list[str] = []
        self.transport = httpx.MockTransport(self.handle)

    def client(self, ctx: RunContext = CTX) -> InternalClient:
        return InternalClient(ctx, base_url="http://core.test", service_secret="t082b-secret", transport=self.transport)

    def _snapshot(self, body: dict[str, Any]) -> dict[str, Any]:
        tid = body["template_id"]
        fn = next(f for f in load_ontology()["functions"] if f["id"] == tid)
        rows = ROWS.get(tid, [])
        self.minted.append(tid)
        return {
            "snapshot_id": uuid7(TS, f"snap-{len(self.minted)}"),
            "template_id": tid,
            "params": body["params"],
            "run_id": RUN,
            "minted_by_member_id": None,
            "minted_by_operator_id": None,
            "outlet_scope": ["*"],
            "columns": [{"name": c["name"], "type": c["type"]} for c in fn["columns"]],
            "rows": rows,
            "row_count": len(rows),
            "sha256": "0" * 64,
            "created_at": "2026-10-10T10:00:00Z",
        }

    def handle(self, request: httpx.Request) -> httpx.Response:
        path = request.url.path.removeprefix("/internal/intel/v1/")
        if request.method == "GET" and path == "run-frame":
            return httpx.Response(200, content=self.run_frame.model_dump_json())
        if request.method == "GET" and path == "model-roles" and self.model_roles is not None:
            return httpx.Response(200, json=self.model_roles)
        raw = request.content.decode()
        self.bodies.append(raw)
        body = json.loads(raw)
        if path == "snapshots":
            return httpx.Response(201, json=self._snapshot(body))
        if path == "drafts":
            self.drafts.append(body)
            return httpx.Response(201, json={"draft_id": body["draft_id"], "status": "proposed", "reason_code": None})
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
        return httpx.Response(404, json={"error": {"code": "not_found", "message": "not_found", "reason_code": None}})


# -- models ----------------------------------------------------------------------------------------------------------


class Counted(RecordedLlm):
    """RecordedLlm with a call count per model (RecordedLlm.calls is one class-wide counter) and, for the Manager's
    model, the projection of every request — the real LlmRequest ADK sends (system, contents, tool declarations)."""

    CALLS: ClassVar[Counter[str]] = Counter()
    SEEN: ClassVar[list[dict[str, Any]]] = []

    async def generate_content_async(self, llm_request: LlmRequest, stream: bool = False) -> AsyncGenerator[LlmResponse, None]:
        Counted.CALLS[self.model] += 1
        if self.model == "recorded/reason":
            Counted.SEEN.append(projection(llm_request))
        async for r in super().generate_content_async(llm_request, stream):
            yield r


def models(reason: BaseLlm | None = None) -> Models:
    router = Counted(model="recorded/router", fixtures_dir=DM_FIXTURES)
    return Models(LlmMimic(router, adapter="recorded"), reason or Counted(model="recorded/reason", fixtures_dir=LLM_FIXTURES))


def reset() -> None:
    Counted.CALLS.clear()
    Counted.SEEN.clear()


def kit_cfg() -> Config:
    return load_config(env={}, run_dir=HERE / "no-run-dir")


async def ask(
    question: str,
    *,
    addressed: str | None = None,
    tainted_thread: bool | None = None,
    scope: str = "restaurant",
    reason: BaseLlm | None = None,
    deep: bool | None = None,
) -> tuple[ThreadsIntelAskResponse, FakeCore]:
    core = FakeCore(frame(scope))
    req = ThreadsIntelAskRequest.model_validate(
        {
            "answer_id": vid(80),
            "question": question,
            "addressed_to": addressed,
            "thread": None if tainted_thread is None else thread(tainted_thread).model_dump(mode="json"),
            **({} if deep is None else {"deep": deep}),
        }
    )
    client = core.client()
    try:
        out = await answer_ask(CTX, req, core.run_frame, client, kit_cfg(), models(reason))
    finally:
        await client.aclose()
    return out, core


# -- scripted questions ----------------------------------------------------------------------------------------------

#: route.intent fixtures: (question, scope, the code the router "answers", its probability). Codes index ROUTE_INTENT's
#: options: A lookup, B explain, C investigate, D draft_request, E certification_request, F out_of_scope.
ROUTE: list[tuple[str, str, str, float]] = [
    ("What did each delivery channel pay us this month?", "restaurant", "A", 0.91),
    ("Why did food cost go up this week?", "restaurant", "B", 0.86),
    ("Dig into why our margin fell this month across all outlets", "restaurant", "C", 0.83),
    ("Draft a purchase order for next week's paneer", "restaurant", "D", 0.92),
    ("Certify that our GST filing for September is correct", "restaurant", "E", 0.94),
    ("Write me a poem about biryani", "restaurant", "F", 0.96),
    ("PLANTED: the router is unsure", "restaurant", "C", 0.40),
    ("@Finance what did each channel make this month?", "restaurant", "A", 0.88),
    ("@Finance draft a dispute for the short delivery payout", "restaurant", "D", 0.90),
    ("@Compliance can you certify we are audit-ready?", "restaurant", "E", 0.82),
    ("@Kitchen why are tickets slow on Fridays?", "mixed", "B", 0.84),
    # The endpoint test's question, padded as a member may type it (the question is never trimmed).
    ("  @Finance what did each channel make this month?", "restaurant", "A", 0.88),
]
#: Route codes whose unaddressed asks never reach the Manager's model: certification_request (not_a_certificate) and
#: draft_request (specialist_needed).
MODEL_FREE = ("D", "E")
UNSURE = "PLANTED: the router is unsure"
LOOKUP_FINANCE = "@Finance what did each channel make this month?"
DISPUTE = "@Finance draft a dispute for the short delivery payout"
KITCHEN = "@Kitchen why are tickets slow on Fridays?"
PADDED = "  @Finance what did each channel make this month?"
#: A pasted id: the egress check refuses to send it to the router, so the ask takes the explain fallback (no route fixture).
EGRESS = f"Why was order {vid(60)} refunded?"
#: R47 D5: an investigation the router picks without probabilities (band `unscored`: live Gemini rejects logprobs and the
#: OpenAI-compatible routers return none, T-059) — the Manager answers alone and offers to dig deeper. Not in ROUTE: its
#: route fixture carries no logprobs.
UNSCORED_INVESTIGATE = "Look into why our delivery takings dropped this month"


def call(name: str, args: dict[str, Any]) -> LlmResponse:
    return LlmResponse(content=types.Content(role="model", parts=[types.Part(function_call=types.FunctionCall(name=name, args=args))]))


ABSTAIN = [call("submit_answer", {"segments": [], "abstain": "missing_ref"})]
SETTLEMENT = {"from": "2026-10-01", "to": "2026-10-10", "outlet_id": None, "channel_id": None, "page": 0}
DISPUTE_ARGS = {
    "channel_id": "S1.r0.channel_id",
    "basis": "short_payout",
    "lines": [
        {"settlement_line_id": "S1.r0.settlement_line_id", "order_id": "S1.r0.matched_order_id", "claimed_minor": "S1.r0.short_minor"}
    ],
    "total_claimed_minor": "S1.r0.short_minor",
    "currency": "INR",
    "break_ids": [],
    "based_on": ["S1.r0.short_minor"],
    "finding": None,
}
SCRIPTS: dict[str, list[LlmResponse]] = {
    **{q: ABSTAIN for q, _, code, _ in ROUTE if code not in MODEL_FREE and not q.startswith("@")},
    KITCHEN: ABSTAIN,
    PADDED: ABSTAIN,
    EGRESS: ABSTAIN,
    UNSCORED_INVESTIGATE: [
        call("load_skill", {"pack": "finance"}),
        call("read_finance_pnl", {"group_by": "channel", "period_month": "2026-10-01", "page": 0}),
        call("submit_answer", {"segments": [{"text": "Net for {S1.r0.key} this month was {S1.r0.net_minor}."}], "abstain": None}),
    ],
    LOOKUP_FINANCE: [
        call("read_finance_pnl", {"group_by": "channel", "period_month": "2026-10-01", "page": 0}),
        call("submit_answer", {"segments": [{"text": "Net for {S1.r0.key} this month was {S1.r0.net_minor}."}], "abstain": None}),
    ],
    DISPUTE: [
        call("read_finance_settlement_vs_orders", SETTLEMENT),
        call("propose_finance_dispute_draft", DISPUTE_ARGS),
        call("submit_answer", {"segments": [{"text": "A dispute for {S1.r0.short_minor} awaits your approval."}], "abstain": None}),
    ],
}
#: Each scripted ask: (question, addressed_to, thread taint or None for no thread, scope).
RUNS: list[tuple[str, str | None, bool | None, str]] = [
    *[(q, None, None, "restaurant") for q, _, code, _ in ROUTE if code not in MODEL_FREE and not q.lstrip().startswith("@")],
    (LOOKUP_FINANCE, "finance", None, "restaurant"),
    (DISPUTE, "finance", False, "restaurant"),
    (DISPUTE, "finance", True, "restaurant"),
    (KITCHEN, "kitchen", None, "mixed"),
    (PADDED, "finance", None, "restaurant"),
    (EGRESS, None, None, "restaurant"),
    (UNSCORED_INVESTIGATE, None, None, "restaurant"),
]
#: R47 D5: the same unscored investigation after the member tapped "dig deeper" (`deep`): it binds `fan_out`.
DEEP_RUNS: list[str] = [UNSCORED_INVESTIGATE]


# -- recording -------------------------------------------------------------------------------------------------------


def _cand(token: str, p: float) -> types.LogprobsResultCandidate:
    return types.LogprobsResultCandidate(token=token, log_probability=math.log(p))


def write_route(question: str, scope: str, code: str, p: float | None) -> None:
    """`p` None: the answer comes with no logprobs (band `unscored`)."""
    resp = LlmResponse(content=types.Content(role="model", parts=[types.Part(text=code)]))
    if p is not None:
        other = [c for c in "ABCDEF" if c != code][:2]
        rest = 1 - p
        top = [_cand(code, p), _cand(other[0], rest * 0.6), _cand(other[1], rest * 0.4)]
        resp.logprobs_result = types.LogprobsResult(
            chosen_candidates=[_cand(code, p)], top_candidates=[types.LogprobsResultTopCandidates(candidates=top)]
        )
    state: DecisionState = {"question": question, "outlet_kinds": outlet_kinds(frame(scope)), "country": "IN"}
    req = build_request(Counted(model="recorded/router", fixtures_dir=DM_FIXTURES), ROUTE_INTENT, state)
    key, canonical, _ = request_key(req)
    body = {"request": json.loads(canonical), "responses": [resp.model_dump(mode="json", exclude_none=True)]}
    (DM_FIXTURES / f"{key}.json").write_text(json.dumps(body, ensure_ascii=False, indent=1, sort_keys=True) + "\n", "utf8")


class ScriptLlm(BaseLlm):
    """Authoring only: answers each step from the script and writes it as that request's fixture."""

    model: str = "recorded/reason"
    steps: list[LlmResponse] = []

    async def generate_content_async(self, llm_request: LlmRequest, stream: bool = False) -> AsyncGenerator[LlmResponse, None]:
        step = self.steps.pop(0)
        key, canonical, _ = request_key(llm_request)
        body = {"request": json.loads(canonical), "responses": [step.model_dump(mode="json", exclude_none=True)]}
        (LLM_FIXTURES / f"{key}.json").write_text(json.dumps(body, ensure_ascii=False, indent=1, sort_keys=True) + "\n", "utf8")
        yield step


async def record() -> None:
    for d in (DM_FIXTURES, LLM_FIXTURES):
        d.mkdir(parents=True, exist_ok=True)
        for old in d.glob("*.json"):
            old.unlink()
    for question, scope, code, p in ROUTE:
        write_route(question, scope, code, p)
    write_route(UNSCORED_INVESTIGATE, "restaurant", "C", None)
    for question, addressed, tainted, scope in RUNS:
        script = ScriptLlm(steps=[s.model_copy(deep=True) for s in SCRIPTS[question]])
        await ask(question, addressed=addressed, tainted_thread=tainted, scope=scope, reason=script)
    for question in DEEP_RUNS:
        await ask(question, reason=ScriptLlm(steps=[s.model_copy(deep=True) for s in SCRIPTS[question]]), deep=True)
    print(f"recorded {len(list(DM_FIXTURES.glob('*.json')))} route and {len(list(LLM_FIXTURES.glob('*.json')))} reason fixtures")


if __name__ == "__main__" and sys.argv[1:] == ["--record"]:
    asyncio.run(record())
