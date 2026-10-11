"""Test kit for the negotiation gates (T-055a/b).

- The suppliers are the real `suppliers-sim` app (loaded from services/suppliers-sim by path — intel does not import
  another service), spoken to over A2A through httpx's ASGI transport: no socket opens (intel's tests block them).
- `FakeCore` stands in for core-api's internal routes at the service boundary: it validates every body with the
  generated contract models, refuses a quote for a supplier that is not simulated (core's composite FK) or whose trace is
  not stored yet (the trace_event FK), mints `purchasing.quote_compare` from the stored quotes as 0021's SQL orders them,
  `purchasing.deal_inputs` from the quote plus the world's hand values, and resolves every ref of a draft.
- Models are `RecordedLlm` over this directory's fixtures (MUNIM_MODEL_MODE=recorded); a missing fixture fails the run.
"""

from __future__ import annotations

import hashlib
import json
import sys
from collections.abc import Mapping, Sequence
from dataclasses import dataclass, field
from datetime import UTC, datetime
from pathlib import Path
from typing import Any, ClassVar

import httpx
from google.adk.models.llm_request import LlmRequest
from google.adk.models.llm_response import LlmResponse

from munim_intel.config import Config
from munim_intel.contracts_gen.models import (
    InternalBatchResponse,
    InternalDraftsRequest,
    InternalDraftsResponse,
    InternalQuotesBatchRequest,
    InternalSnapshotsRequest,
    InternalTracesBatchRequest,
    InternalTracesBatchResponse,
    Snapshot,
)
from munim_intel.llm.recorded import RecordedLlm
from munim_intel.mapping import SNAP_CLOSE, SNAP_OPEN, snap_ref
from munim_intel.negotiate.chooser import LlmChooser, Pick, View
from munim_intel.negotiate.policy import NegotiationPolicy
from munim_intel.negotiate.port import A2aSuppliers, Supplier
from munim_intel.negotiate.run import Outcome, Rfq, negotiate
from munim_intel.runtime.context import RunContext
from munim_intel.runtime.state import Budget, RunState
from munim_intel.tools.generated import uuid7
from munim_intel.trace.buffer import TraceBuffer

HERE = Path(__file__).resolve().parent
REPO = HERE.parents[3]
FIXTURES = HERE / "fixtures" / "recorded"
WORLD: dict[str, Any] = json.loads((HERE / "s1_world.json").read_text("utf8"))
PUBLIC = "https://suppliers-sim.example.test"
KEYS = ("steady", "discounter", "premium")

sys.path.insert(0, str(REPO / "services" / "suppliers-sim"))
from suppliers_sim.agent import load_data as load_data  # noqa: E402
from suppliers_sim.app import build_app as build_app  # noqa: E402

TENANT = "0199a000-0000-7000-8000-000000000001"
OUTLET = "0199a000-0000-7000-8000-0000000000a3"
INGREDIENT = "0199a000-0000-7000-8000-0000000000b1"
SUPPLIER_IDS = {k: f"0199a000-0000-7000-8000-00000000c00{i}" for i, k in enumerate(KEYS, 1)}
NOT_SIMULATED = "0199a000-0000-7000-8000-00000000c0ff"


def now_iso() -> str:
    return datetime.now(UTC).isoformat().replace("+00:00", "Z")


class CountingLlm(RecordedLlm):
    """RecordedLlm that logs (model, tool declarations) per request: the extractor tool-count gate reads it."""

    log: ClassVar[list[tuple[str, int]]] = []

    async def generate_content_async(self, llm_request: LlmRequest, stream: bool = False):  # type: ignore[no-untyped-def]
        tools = [fd for t in (llm_request.config.tools or []) for fd in (getattr(t, "function_declarations", None) or [])]
        CountingLlm.log.append((self.model, len(tools) + len(llm_request.tools_dict)))
        async for r in super().generate_content_async(llm_request, stream):
            yield r


#: record.py swaps in its authoring class; the gates always replay.
LLM: type[RecordedLlm] = CountingLlm


def llm(role: str, fixtures: Path = FIXTURES) -> RecordedLlm:
    return LLM(model=f"recorded/{role}", fixtures_dir=fixtures)


@dataclass
class FakeCore:
    deal_inputs: Mapping[str, Any]
    simulated: frozenset[str] = frozenset(SUPPLIER_IDS.values())
    traces: dict[str, Any] = field(default_factory=dict)
    quotes: list[dict[str, Any]] = field(default_factory=list)
    snapshots: dict[str, dict[str, Any]] = field(default_factory=dict)
    drafts: list[dict[str, Any]] = field(default_factory=list)
    run_id: str = ""

    async def write_traces(self, req: InternalTracesBatchRequest) -> InternalTracesBatchResponse:
        for e in req.events:
            self.traces[e.id.root] = e
        return InternalTracesBatchResponse(inserted=len(req.events), last_seq=len(self.traces))

    async def write_quotes(self, req: InternalQuotesBatchRequest) -> InternalBatchResponse:
        body = req.model_dump(mode="json")
        for q in body["quotes"]:
            if q["supplier_id"] not in self.simulated:
                raise AssertionError("422: supplier is not simulated (composite FK)")
            if q["trace_event_id"] is not None and q["trace_event_id"] not in self.traces:
                raise AssertionError("422: trace_event_id not stored (FK)")
        self.quotes += body["quotes"]
        return InternalBatchResponse(inserted=len(body["quotes"]), existing=0)

    def _snapshot(self, template: str, params: dict[str, Any], columns: list[tuple[str, str]], rows: list[dict[str, Any]]) -> Snapshot:
        sid = uuid7(int(datetime.now(UTC).timestamp() * 1000), f"{template}/{json.dumps(params, sort_keys=True)}/{len(self.snapshots)}")
        body = {
            "snapshot_id": sid,
            "template_id": template,
            "params": params,
            "run_id": self.run_id,
            "minted_by_member_id": None,
            "minted_by_operator_id": None,
            "outlet_scope": [OUTLET],
            "columns": [{"name": n, "type": t} for n, t in columns],
            "rows": rows,
            "row_count": len(rows),
            "sha256": hashlib.sha256(json.dumps(rows, sort_keys=True).encode()).hexdigest(),
            "created_at": now_iso(),
        }
        self.snapshots[sid] = body
        return Snapshot.model_validate(body)

    def shortfall(self) -> Snapshot:
        r = WORLD["rfq"]
        return self._snapshot(
            "inventory.shortfall",
            {"outlet_id": OUTLET, "lead_days": "2", "as_of": None},
            [("ingredient_id", "uuid"), ("shortfall_qty_milli", "integer")],
            [{"ingredient_id": INGREDIENT, "shortfall_qty_milli": r["qty_milli"]}],
        )

    async def mint_snapshot(self, req: InternalSnapshotsRequest) -> Snapshot:
        p = req.model_dump(mode="json")["params"]
        if req.template_id == "purchasing.quote_compare":
            assert set(p) == {"negotiation_run_id"} and p["negotiation_run_id"] == self.run_id
            cols = ["quote_id", "supplier_id", "round", "unit_price_minor", "qty_milli", "min_order_qty_milli", "payment_days"]
            order = sorted(enumerate(self.quotes), key=lambda iq: (iq[1]["round"], iq[1]["supplier_id"], iq[0]))
            rows = [{"quote_id": q["id"], **{c: q[c] for c in cols[1:]}} for _, q in order]
            return self._snapshot(req.template_id, p, [(c, "uuid" if c.endswith("_id") else "integer") for c in cols], rows)
        if req.template_id == "purchasing.deal_inputs":
            # v2 (0022): `as_of` is a required named param.
            assert set(p) == {"quote_id", "as_of"}
            q = next(q for q in self.quotes if q["id"] == p["quote_id"])
            key = next(k for k, v in SUPPLIER_IDS.items() if v == q["supplier_id"])
            d = self.deal_inputs
            row = {
                "quote_total_minor": (q["unit_price_minor"] * q["qty_milli"] + 500) // 1000,
                "quote_payment_days": q["payment_days"],
                "budget_left_minor": d["budget_left_minor"],
                "open_commit_qty_milli": d["open_commit_qty_milli"],
                "need_qty_milli": d["need_qty_milli"],
                "use_in_shelf_life_qty_milli": d["use_in_shelf_life_qty_milli"],
                "margin_at_quote_bp": d["margin_at_quote_bp"][key],
                "margin_floor_bp": d["margin_floor_bp"],
                "min_payment_days": d["min_payment_days"],
            }
            return self._snapshot(req.template_id, p, [(c, "integer") for c in row], [row])
        raise AssertionError(f"unexpected template {req.template_id}")

    def cell(self, ref: str) -> Any:
        sid, row, col = ref[len(SNAP_OPEN) + len("snap:") : -len(SNAP_CLOSE)].split("·")
        snap = self.snapshots[sid]
        assert col in {c["name"] for c in snap["columns"]}, f"unresolved column {col}"
        return snap["rows"][int(row)][col]

    async def write_draft(self, req: InternalDraftsRequest) -> InternalDraftsResponse:
        body = req.model_dump(mode="json")
        line = body["payload"]["lines"][0]
        for ref in [line["qty_milli"], line["unit_price_minor"], *body["based_on"]]:
            self.cell(ref)  # every ref resolves to a cell this core minted, or the test fails
        for e in body["evidence"]:
            assert e.removeprefix("snap:") in self.snapshots
        self.drafts.append(body)
        return InternalDraftsResponse(draft_id=body["draft_id"], status="proposed", reason_code=None)


def suppliers() -> list[Supplier]:
    return [Supplier(SUPPLIER_IDS[k], f"{PUBLIC}/{k}/.well-known/agent-card.json") for k in KEYS]


def cfg(tmp: Path) -> Config:
    return Config({"MUNIM_MODEL_MODE": "recorded"}, {}, tmp)


@dataclass
class StubChooser:
    """A planted chooser (gates T-055a (4), T-055b (1)): answers `answer(round, letter)` for every supplier."""

    answer: Any
    note: str = "Thank you for the offer."
    calls: int = 0

    async def choose(self, round_: int, last_round: int, views: Sequence[View]) -> Mapping[str, Pick] | None:
        self.calls += 1
        return {v.letter: Pick(self.answer(round_, v.letter), self.note) for v in views}


@dataclass
class Run:
    outcome: Outcome
    core: FakeCore
    state: RunState
    ctx: RunContext
    chooser: Any


async def run_s1(
    tmp: Path,
    *,
    chooser: Any = None,
    clause: int | None = 0,
    data: dict[str, Any] | None = None,
    policy: NegotiationPolicy | None = None,
    fixtures: Path = FIXTURES,
    choice_calls: int | None = None,
    deal_inputs: Mapping[str, Any] | None = None,
    max_model_calls: int | None = None,
) -> Run:
    run_id = uuid7(int(datetime.now(UTC).timestamp() * 1000), f"run/{tmp}")
    ctx = RunContext(
        run_id=run_id,
        tenant_id=TENANT,
        outlet_scope=(OUTLET,),
        trigger="event",
        actor="watcher:inventory_purchasing",
        expires_at=2_000_000_000,
        token="not-a-token",
    )
    core = FakeCore(deal_inputs or WORLD["deal_inputs"], run_id=run_id)
    # 12 = 3 suppliers x 3 extractions + 3 decision rounds (run.py negotiation_budget); 2 more for the injection gate's
    # propose attempt.
    budget = Budget(max_model_calls=14 if max_model_calls is None else max_model_calls)
    state = RunState(traces=TraceBuffer(core.write_traces), budget=budget)
    c = cfg(tmp)
    policy = policy or NegotiationPolicy()
    if chooser is None:
        chooser = LlmChooser(
            llm("reason", fixtures),
            ctx,
            c,
            state,
            currency=WORLD["rfq"]["currency"],
            unit=WORLD["rfq"]["unit"],
            calls=policy.decision_rounds if choice_calls is None else choice_calls,
        )
    short = core.shortfall()
    w = WORLD["rfq"]
    rfq = Rfq(
        INGREDIENT,
        w["item_name"],
        w["unit"],
        w["qty_milli"],
        snap_ref(short.snapshot_id.root, 0, "shortfall_qty_milli"),
        short.snapshot_id.root,
        w["reference_price_minor"],
        w["currency"],
        w["minor_unit"],
        w["needed_by"],
        (OUTLET,),
    )
    app = build_app(PUBLIC, data=data or load_data(), clause=clause)
    async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url=PUBLIC) as http:
        outcome = await negotiate(
            ctx,
            rfq,
            suppliers(),
            port=A2aSuppliers(http),
            core=core,
            chooser=chooser,
            extract_llm=llm("extract", fixtures),
            cfg=c,
            state=state,
            policy=policy,
        )
    return Run(outcome, core, state, ctx, chooser)


def supplier_key(supplier_id: str) -> str:
    return next(k for k, v in SUPPLIER_IDS.items() if v == supplier_id)


def response_json(obj: Any) -> dict[str, Any]:
    """A recorded LlmResponse whose text is `obj` as JSON."""
    r = LlmResponse.model_validate({"content": {"role": "model", "parts": [{"text": json.dumps(obj)}]}})
    return r.model_dump(mode="json", exclude_none=True)
