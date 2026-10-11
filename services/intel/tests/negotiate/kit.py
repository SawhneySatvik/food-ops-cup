"""Test kit for the negotiation gates (T-055a/b).

- The suppliers are the real `suppliers-sim` app (loaded from services/suppliers-sim by path — intel does not import
  another service), spoken to over A2A through httpx's ASGI transport: no socket opens (intel's tests block them).
- `FakeCore` stands in for core-api's internal routes at the service boundary: it validates every body with the
  generated contract models, refuses a quote for a supplier that is not simulated (core's composite FK), whose trace is
  not stored yet (the trace_event FK), or whose source chunk is not stored or whose spans are not inside it (0024 and
  core's writeQuotes) — and, stricter than core, whose span text is not the field's value. It mints
  `purchasing.quote_compare` from the stored quotes as 0021's SQL orders them, `purchasing.deal_inputs` from the quote
  plus the world's hand values, a last-price cell (`purchasing.price_creep`), and resolves every ref of a draft.
- Models are `RecordedLlm` over this directory's fixtures (MUNIM_MODEL_MODE=recorded). A missing fixture is counted
  (`no_fixture_misses`, autouse in every gate module): a run that silently fell back to a default fails its test.
"""

from __future__ import annotations

import hashlib
import json
import sys
from collections.abc import Iterator, Mapping, Sequence
from dataclasses import dataclass, field
from datetime import UTC, datetime
from decimal import Decimal
from pathlib import Path
from typing import Any, ClassVar

import httpx
import pytest
from google.adk.models.llm_request import LlmRequest
from google.adk.models.llm_response import LlmResponse

from munim_intel.config import Config
from munim_intel.contracts_gen.models import (
    InternalBatchResponse,
    InternalChunksBatchRequest,
    InternalDraftsRequest,
    InternalDraftsResponse,
    InternalQuotesBatchRequest,
    InternalRunFrameResponse,
    InternalSnapshotsRequest,
    InternalTracesBatchRequest,
    InternalTracesBatchResponse,
    Snapshot,
)
from munim_intel.llm.recorded import RecordedFixtureMissing, RecordedLlm
from munim_intel.mapping import SNAP_CLOSE, SNAP_OPEN
from munim_intel.negotiate.chooser import LlmChooser, Pick, View
from munim_intel.negotiate.policy import NegotiationPolicy, policy_from
from munim_intel.negotiate.port import A2aSuppliers, Supplier
from munim_intel.negotiate.run import Outcome, negotiate, rfq_from
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
    """RecordedLlm that logs (model, tool declarations) per request — the extractor tool-count gate reads it — and every
    fixture it could not find (`misses`; R-C F9: a miss is not a silent default)."""

    log: ClassVar[list[tuple[str, int]]] = []
    misses: ClassVar[list[str]] = []

    async def generate_content_async(self, llm_request: LlmRequest, stream: bool = False):  # type: ignore[no-untyped-def]
        tools = [fd for t in (llm_request.config.tools or []) for fd in (getattr(t, "function_declarations", None) or [])]
        CountingLlm.log.append((self.model, len(tools) + len(llm_request.tools_dict)))
        try:
            async for r in super().generate_content_async(llm_request, stream):
                yield r
        except RecordedFixtureMissing as e:
            CountingLlm.misses.append(e.key)
            raise


@pytest.fixture(autouse=True)
def no_fixture_misses() -> Iterator[list[str]]:
    """Imported into every gate module (autouse there): the test fails when any recorded fixture was missing — the run
    would otherwise have carried on with a rule default and passed for the wrong reason. A test that plants a miss on
    purpose clears the list it is handed."""
    CountingLlm.misses.clear()
    yield CountingLlm.misses
    assert CountingLlm.misses == [], f"recorded fixtures missing: {CountingLlm.misses}"


#: record.py swaps in its authoring class; the gates always replay.
LLM: type[RecordedLlm] = CountingLlm


def llm(role: str, fixtures: Path = FIXTURES) -> RecordedLlm:
    return LLM(model=f"recorded/{role}", fixtures_dir=fixtures)


@dataclass
class FakeCore:
    deal_inputs: Mapping[str, Any]
    simulated: frozenset[str] = frozenset(SUPPLIER_IDS.values())
    traces: dict[str, Any] = field(default_factory=dict)
    chunks: dict[str, dict[str, Any]] = field(default_factory=dict)
    quotes: list[dict[str, Any]] = field(default_factory=list)
    snapshots: dict[str, dict[str, Any]] = field(default_factory=dict)
    drafts: list[dict[str, Any]] = field(default_factory=list)
    run_id: str = ""

    async def write_traces(self, req: InternalTracesBatchRequest) -> InternalTracesBatchResponse:
        for e in req.events:
            self.traces[e.id.root] = e
        return InternalTracesBatchResponse(inserted=len(req.events), last_seq=len(self.traces))

    async def write_chunks(self, req: InternalChunksBatchRequest) -> InternalBatchResponse:
        for c in req.model_dump(mode="json")["chunks"]:
            self.chunks[c["id"]] = c
        return InternalBatchResponse(inserted=len(req.chunks), existing=0)

    async def write_quotes(self, req: InternalQuotesBatchRequest) -> InternalBatchResponse:
        body = req.model_dump(mode="json")
        scale = {
            "unit_price_minor": Decimal(10) ** WORLD["rfq"]["minor_unit"],
            "qty_milli": 1000,
            "min_order_qty_milli": 1000,
            "payment_days": 1,
        }
        for q in body["quotes"]:
            if q["supplier_id"] not in self.simulated:
                raise AssertionError("422: supplier is not simulated (composite FK)")
            if q["trace_event_id"] is not None and q["trace_event_id"] not in self.traces:
                raise AssertionError("422: trace_event_id not stored (FK)")
            text = self.chunks[q["source_chunk_id"]]["text"]  # KeyError: the reply chunk was not stored first
            for name, span in q["spans"].items():
                assert (span is None) == (q[name] == 0), f"422: span for {name}"
                if span is not None:
                    s, e = span
                    assert 0 <= s < e <= len(text), "422: span outside the chunk"
                    assert Decimal(text[s:e].replace(",", "")) * scale[name] == q[name], f"span text is not {name}"
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

    def last_price(self) -> Snapshot:
        """RG-S1's last price (800 paise), as the `purchasing.price_creep` cell `latest_minor` a caller would read."""
        return self._snapshot(
            "purchasing.price_creep",
            {"as_of": "2026-10-10"},  # price_creep's as_of is a required date (not nullable)
            [("supplier_id", "uuid"), ("ingredient_id", "uuid"), ("latest_minor", "integer")],
            [{"supplier_id": SUPPLIER_IDS["steady"], "ingredient_id": INGREDIENT, "latest_minor": WORLD["rfq"]["reference_price_minor"]}],
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
            # v2 (0022): `as_of` is a required named param. v3 (0026, R47 D3): `margin_rule_applies`.
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
                "margin_rule_applies": d["margin_rule_applies"],
                "margin_floor_bp": d["margin_floor_bp"],
                "min_payment_days": d["min_payment_days"],
            }
            return self._snapshot(req.template_id, p, [(c, "boolean" if c == "margin_rule_applies" else "integer") for c in row], [row])
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
    return [Supplier(SUPPLIER_IDS[k], f"{PUBLIC}/{k}/.well-known/agent-card.json", "simulated") for k in KEYS]


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
    supplier_list: Sequence[Supplier] | None = None,
    run_id: str | None = None,
    sim_url: str = PUBLIC,
) -> Run:
    run_id = run_id or uuid7(int(datetime.now(UTC).timestamp() * 1000), f"run/{tmp}")
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
    policy = policy or DEFAULT_POLICY
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
    w = WORLD["rfq"]
    rfq = rfq_from(
        core.shortfall().model_dump(mode="json"),
        0,
        core.last_price().model_dump(mode="json"),
        0,
        "latest_minor",
        item_name=w["item_name"],
        unit=w["unit"],
        currency=w["currency"],
        minor_unit=w["minor_unit"],
        needed_by=w["needed_by"],
        outlet_ids=(OUTLET,),
    )
    app = build_app(sim_url, data=data or load_data(), clause=clause)
    async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url=PUBLIC) as http:
        outcome = await negotiate(
            ctx,
            rfq,
            suppliers() if supplier_list is None else supplier_list,
            port=A2aSuppliers(http, PUBLIC),
            core=core,
            chooser=chooser,
            extract_llm=llm("extract", fixtures),
            state=state,
            policy=policy,
        )
    return Run(outcome, core, state, ctx, chooser)


def bounds_frame(target_bp: int, walkaway_bp: int) -> InternalRunFrameResponse:
    """A run-frame as core serves it, carrying the owner's negotiation bounds (R47 D7); the rest is inert here."""
    return InternalRunFrameResponse.model_validate(
        {
            "pack": {"code": "IN", "version": 3},
            "currency": "INR",
            "severity_ladder": {"critical_minor_gte": 5_000_000, "high_minor_gte": 1_000_000, "medium_minor_gte": 200_000},
            "detectors": {},
            "outlets": [],
            "budget": None,
            "narration": "model",
            "negotiation": {"target_bp": target_bp, "walkaway_bp": walkaway_bp},
            "licence_kinds": [],
            "payroll_scope": "drafts",
        }
    )


#: The bounds core serves when the owner set none (R47 D7: 95% / 110%; contracts tenancy NEGOTIATION_DEFAULTS).
DEFAULT_POLICY = policy_from(bounds_frame(9_500, 11_000))


def supplier_key(supplier_id: str) -> str:
    return next(k for k, v in SUPPLIER_IDS.items() if v == supplier_id)


def response_json(obj: Any) -> dict[str, Any]:
    """A recorded LlmResponse whose text is `obj` as JSON."""
    r = LlmResponse.model_validate({"content": {"role": "model", "parts": [{"text": json.dumps(obj)}]}})
    return r.model_dump(mode="json", exclude_none=True)
