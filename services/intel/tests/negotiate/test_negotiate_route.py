"""T-114 gates: `POST /negotiate` — a person's request for quotes, from core's request to the PO draft.

`run_negotiation` against `RouteCore` (kit.FakeCore at the service boundary, plus the three reads this route adds: the
sales history the forecast is trained on, the shortfall, the last price) and the real suppliers-sim over ASGI. The S1
hand world (s1_world.json) supplies the RFQ: 20 pc of takeaway boxes, last price 800 — so the recorded S1 fixtures
replay unchanged (no model request names an outlet), and the expected PO is S1's: steady at 792 for 20 pc.
  (1) two chosen outlets: forecast posted (both methods, every item, each point citing its history snapshot), one RFQ
      round to the three simulated suppliers, ONE PO draft whose outlet ids are both outlets and whose qty and price are
      quote_compare cells — status `drafted`;
  (2) no shortfall → `no_shortfall`: no supplier is contacted and no model is called;
  (3) AI off (`narration` template) → `model_blocked` before anything is forecast or sent; no supplier → `no_suppliers`;
      over the month's AI cap with AI on, in live mode (T-127, R58) → the models are built capped and the run goes on, while
      AI switched off, no budget for the month or recorded mode stay `model_blocked` with no model built;
  (5) spend (C1 S2-6, R47): every model request of the run — the chooser's and the quarantined extractor's — is one spend
      row of its own role, counted independently at the model boundary;
  (4) the HTTP route: the same 401 without the secret or with a non-`ask` token, 400 when the body's outlets are not the
      token's scope, 503 when core gives no run-frame — none of them reaches a supplier or a model.
Every snapshot the route mints is checked against its template's params schema as core reads it (the latest version, in
the generated ontology): core refuses a mint with a required param missing (422), as it once refused the shortfall
without v2's `as_of`.
"""

from __future__ import annotations

import asyncio
import json
from collections import Counter
from collections.abc import Sequence
from datetime import date, timedelta
from pathlib import Path
from typing import Any

import httpx
from fastapi.testclient import TestClient

from conftest import REPO, SECRET
from kit import (
    INGREDIENT,
    KEYS,
    PUBLIC,
    SUPPLIER_IDS,
    WORLD,
    CountingLlm,
    FakeCore,
    bounds_frame,
    build_app,
    llm,
    load_data,
)
from kit import no_fixture_misses as no_fixture_misses  # autouse: a missing recorded fixture fails the test
from munim_intel.app import create_app
from munim_intel.config import Config
from munim_intel.contracts_gen.models import (
    InternalForecastsBatchRequest,
    InternalRunFrameResponse,
    InternalSnapshotsRequest,
    PurchasingIntelNegotiateRequest,
    Snapshot,
)
from munim_intel.forecast import NAIVE, WEIGHTED
from munim_intel.mapping import SNAP_CLOSE, SNAP_OPEN
from munim_intel.negotiate.route import HISTORY_DAYS, LEAD_DAYS, run_negotiation
from munim_intel.runtime.context import RunContext
from munim_intel.tools.generated import uuid7

OUTLETS = ("0199a000-0000-7000-8000-0000000000a3", "0199a000-0000-7000-8000-0000000000a4")
ITEMS = ("0199a000-0000-7000-8000-0000000000d1", "0199a000-0000-7000-8000-0000000000d2")
BUSINESS_DATE = "2026-10-15"
RFQ = "0199a000-0000-7000-8000-0000000000e1"
#: Each template's params schema, latest version (core-api mints from the latest: modules/evidence/mint.ts).
PARAMS = {
    f["id"]: f["params_schema"]
    for f in json.loads((REPO / "packages" / "contracts" / "generated" / "ontology.json").read_text("utf8"))["functions"]
}


def admitted(template: str, params: dict[str, Any]) -> bool:
    """Every required param given and none the template does not name (core's checkParams, by name)."""
    s = PARAMS[template]
    return set(s.get("required", [])) <= set(params) <= set(s["properties"])


class RouteCore(FakeCore):
    """FakeCore plus the reads `/negotiate` makes before the negotiation, and the forecast and spend it posts."""

    shortfall_qty: int = WORLD["rfq"]["qty_milli"]
    forecasts: list[InternalForecastsBatchRequest]
    spend: list[Any]
    history: list[str]

    async def mint_snapshot(self, req: InternalSnapshotsRequest) -> Snapshot:
        p = req.model_dump(mode="json")["params"]
        assert admitted(req.template_id, p), f"core would refuse {req.template_id} with params {sorted(p)}"
        if req.template_id == "forecast.sales_history":
            start = date.fromisoformat(p["from"])
            days = (date.fromisoformat(p["to"]) - start).days + 1
            rows = [
                {"business_on": (start + timedelta(days=d)).isoformat(), "qty_milli": 4_000 + 1_000 * (d % 7), "closed": False}
                for d in range(days)
            ]
            snap = self._snapshot(req.template_id, p, [("business_on", "date"), ("qty_milli", "integer"), ("closed", "boolean")], rows)
            self.history.append(snap.snapshot_id.root)
            return snap
        if req.template_id == "inventory.shortfall":
            assert p == {"outlet_id": None, "lead_days": LEAD_DAYS, "as_of": BUSINESS_DATE}
            rows = [{"ingredient_id": INGREDIENT, "shortfall_qty_milli": self.shortfall_qty, "stockout_on": None}]
            return self._snapshot(
                req.template_id, p, [("ingredient_id", "uuid"), ("shortfall_qty_milli", "integer"), ("stockout_on", "date")], rows
            )
        if req.template_id == "purchasing.price_creep":
            # Two suppliers hold a last price; the anchor is the lower (S1's 800), whichever row comes first.
            rows = [
                {"supplier_id": SUPPLIER_IDS["premium"], "ingredient_id": INGREDIENT, "latest_minor": 950},
                {"supplier_id": SUPPLIER_IDS["steady"], "ingredient_id": INGREDIENT, "latest_minor": WORLD["rfq"]["reference_price_minor"]},
            ]
            return self._snapshot(
                req.template_id, p, [("supplier_id", "uuid"), ("ingredient_id", "uuid"), ("latest_minor", "integer")], rows
            )
        return await super().mint_snapshot(req)

    async def _post(self, path: str, body: Any, out: type[Any]) -> Any:
        assert path == "forecasts:batch"
        self.forecasts.append(body)
        return out.model_validate({"run_inserted": len(self.forecasts) == 1, "inserted": len(body.points), "existing": 0})

    async def write_spend(self, req: Any) -> Any:
        self.spend.append(req)


def route_core(run_id: str, shortfall_qty: int | None = None) -> RouteCore:
    core = RouteCore(WORLD["deal_inputs"], run_id=run_id)
    core.forecasts, core.spend, core.history = [], [], []
    if shortfall_qty is not None:
        core.shortfall_qty = shortfall_qty
    return core


def frame(narration: str = "model") -> InternalRunFrameResponse:
    base = bounds_frame(9_500, 11_000).model_dump(mode="json")
    outlets = [
        {"id": o, "name": f"Outlet {o[-2:]}", "kind": "restaurant", "tz": "Asia/Kolkata", "business_date": BUSINESS_DATE} for o in OUTLETS
    ]
    return InternalRunFrameResponse.model_validate({**base, "outlets": outlets, "narration": narration})


def request(suppliers: Sequence[str] = KEYS) -> PurchasingIntelNegotiateRequest:
    w = WORLD["rfq"]
    return PurchasingIntelNegotiateRequest.model_validate(
        {
            "rfq_id": RFQ,
            "ingredient_id": INGREDIENT,
            "item_name": w["item_name"],
            "unit": w["unit"],
            "currency": w["currency"],
            "minor_unit": w["minor_unit"],
            "outlet_ids": list(OUTLETS),
            "suppliers": [
                {"supplier_id": SUPPLIER_IDS[k], "kind": "simulated", "card_url": f"{PUBLIC}/{k}/.well-known/agent-card.json"}
                for k in suppliers
            ],
            "item_ids": list(ITEMS),
        }
    )


class Counting(httpx.AsyncBaseTransport):
    """The suppliers-sim app over ASGI, counting every request (a contacted supplier is at least its agent card)."""

    def __init__(self) -> None:
        self.inner = httpx.ASGITransport(app=build_app(PUBLIC, data=load_data(), clause=0))
        self.requests = 0

    async def handle_async_request(self, request: httpx.Request) -> httpx.Response:
        self.requests += 1
        return await self.inner.handle_async_request(request)


async def models(_client: Any, _currency: str, _capped: bool = False) -> tuple[Any, Any]:
    return llm("reason"), llm("extract")


def frame_at(ai_enabled: bool, level: str | None) -> InternalRunFrameResponse:
    """The route's frame as core derives it (frame.ts): narration `model` only with AI on and budget left; no budget → null."""
    budget = None
    if level is not None:
        left = 0 if level == "hard" else 400_000
        budget = {
            "month": "2026-10-01",
            "currency": "INR",
            "owner_cap_minor": None,
            "operator_limit_minor": 500_000,
            "effective_cap_minor": 500_000,
            "spent_minor": 500_000 - left,
            "hard_left_minor": left,
            "level": level,
        }
    narration = "model" if ai_enabled and level == "ok" else "template"
    body = frame(narration).model_dump(mode="json")
    return InternalRunFrameResponse.model_validate({**body, "budget": budget, "ai_enabled": ai_enabled})


def run(
    tmp: Path,
    *,
    shortfall_qty: int | None = None,
    narration: str = "model",
    suppliers: Sequence[str] = KEYS,
    the_frame: InternalRunFrameResponse | None = None,
    mode: str = "recorded",
    models_of: Any = models,
) -> tuple[str, str | None, RouteCore, Counting]:
    run_id = uuid7(1_760_500_000_000, f"route/{tmp}")
    ctx = RunContext(
        run_id, "0199a000-0000-7000-8000-000000000001", OUTLETS, "ask", "0199a000-0000-7000-8000-0000000000f9", 2_000_000_000, "t"
    )
    core = route_core(run_id, shortfall_qty)
    sim = Counting()
    cfg = Config({"MUNIM_MODEL_MODE": mode, "SUPPLIERS_SIM_PUBLIC_URL": PUBLIC}, {}, tmp)
    f = the_frame or frame(narration)
    status, draft = asyncio.run(run_negotiation(ctx, request(suppliers), f, core, cfg, models_of, sim))  # type: ignore[arg-type]
    return status, draft, core, sim


def cell(core: FakeCore, ref: str) -> Any:
    return core.cell(ref)


def test_two_outlets_forecast_then_one_po_draft_covering_both(tmp_path: Path) -> None:
    status, draft_id, core, sim = run(tmp_path)
    [f] = core.forecasts
    points = f.model_dump(mode="json")["points"]
    run_ = f.forecast_run.model_dump(mode="json")
    print(
        f"forecast: {len(points)} points, method {run_['method']}, trained through {run_['trained_through']}, "
        f"holdout {run_['holdout_days']}"
    )
    # Hand values: 2 outlets x 2 items x 2 methods x 7 days; trained through the day before the business date.
    assert (
        len(points) == 2 * 2 * 2 * 7
        and run_["method"] == WEIGHTED
        and run_["trained_through"] == "2026-10-14"
        and run_["holdout_days"] == 28
    )
    assert {p["method"] for p in points} == {WEIGHTED, NAIVE}
    assert {p["inputs_snapshot_id"] for p in points} == set(core.history) and len(core.history) == 4
    assert min(p["business_on"] for p in points) == BUSINESS_DATE
    hist = [s for s in core.snapshots.values() if s["template_id"] == "forecast.sales_history"]
    assert {(s["params"]["from"], s["params"]["to"]) for s in hist} == {
        ((date(2026, 10, 14) - timedelta(days=HISTORY_DAYS - 1)).isoformat(), "2026-10-14")
    }
    [d] = core.drafts
    line = d["payload"]["lines"][0]
    print(
        f"status {status}, PO {d['payload']['supplier_id']} outlets {d['outlet_ids']} "
        f"qty {cell(core, line['qty_milli'])} price {cell(core, line['unit_price_minor'])}"
    )
    assert status == "drafted" and draft_id == d["draft_id"]
    assert d["outlet_ids"] == list(OUTLETS) and d["payload"]["outlet_ids"] == list(OUTLETS)
    e = WORLD["expected"]
    assert d["payload"]["supplier_id"] == SUPPLIER_IDS[e["po_supplier"]]
    assert (cell(core, line["unit_price_minor"]), cell(core, line["qty_milli"])) == (e["po_unit_price_minor"], e["po_qty_milli"])
    for ref in (line["qty_milli"], line["unit_price_minor"]):
        assert ref.startswith(SNAP_OPEN) and ref.endswith(SNAP_CLOSE)
        assert core.snapshots[ref[len(SNAP_OPEN) + len("snap:") :].split("·")[0]]["template_id"] == "purchasing.quote_compare"
    # The RFQ's anchor was the lower last price (800), the cell the draft cites as what the bounds came from.
    assert any(cell(core, b) == WORLD["rfq"]["reference_price_minor"] for b in d["based_on"])
    assert sim.requests > 0


def test_every_model_request_of_the_negotiation_is_one_spend_row_of_its_role(tmp_path: Path) -> None:
    """C1 S2-6 (R47, 04 §10): the quarantined extractor's calls are charged like the chooser's, so the month's cap sees them.
    Expected counts are the requests that reached each model (CountingLlm.log, the model boundary), not the meter's own."""
    before = len(CountingLlm.log)
    status, _, core, _ = run(tmp_path)
    calls = Counter(model for model, _ in CountingLlm.log[before:])
    rows = Counter((e["role"], e["model_id"]) for req in core.spend for e in req.model_dump(mode="json")["entries"])
    print(f"model requests {dict(calls)}; spend rows {dict(rows)}")
    assert status == "drafted" and calls["recorded/extract"] > 0 and calls["recorded/reason"] > 0
    assert rows == {("extract", "recorded/extract"): calls["recorded/extract"], ("reason", "recorded/reason"): calls["recorded/reason"]}


def test_no_shortfall_contacts_no_supplier_and_calls_no_model(tmp_path: Path) -> None:
    before = len(CountingLlm.log)
    status, draft_id, core, sim = run(tmp_path, shortfall_qty=0)
    assert (status, draft_id, core.drafts, core.quotes, sim.requests, len(CountingLlm.log) - before) == ("no_shortfall", None, [], [], 0, 0)


def test_ai_off_or_no_supplier_stops_before_anything_is_forecast_or_sent(tmp_path: Path) -> None:
    for kw, want in (({"narration": "template"}, "model_blocked"), ({"suppliers": ()}, "no_suppliers")):
        status, _, core, sim = run(tmp_path / want, **kw)
        assert (status, core.forecasts, core.snapshots, sim.requests) == (want, [], {}, 0)


def test_over_the_cap_negotiates_capped_and_ai_off_never_builds_a_model(tmp_path: Path) -> None:
    """T-127 (R58): over the month's AI cap with AI on, in live mode, the models are built capped (each call served from its
    recorded fixture or abstaining; the kit's stand-ins answer here) and the run drafts as it does with budget left. AI switched
    off — with the budget spent or not — no budget for the month and recorded mode build no model, forecast nothing and contact
    no supplier."""
    built: list[bool] = []

    async def spy(client: Any, currency: str, capped: bool = False) -> tuple[Any, Any]:
        built.append(capped)
        return await models(client, currency)

    for name, ai, level, mode in (
        ("off-hard", False, "hard", "live"),
        ("off-ok", False, "ok", "live"),
        ("no-budget", True, None, "live"),
        ("recorded", True, "hard", "recorded"),
    ):
        status, _, core, sim = run(tmp_path / name, the_frame=frame_at(ai, level), mode=mode, models_of=spy)
        assert (status, built, core.forecasts, core.snapshots, sim.requests) == ("model_blocked", [], [], {}, 0), name
    status, draft_id, core, sim = run(tmp_path / "capped", the_frame=frame_at(True, "hard"), mode="live", models_of=spy)
    assert built == [True] and status == "drafted" and draft_id is not None and sim.requests > 0


def test_the_route_refuses_before_reaching_a_supplier_or_a_model(cfg: Config, minted: dict[str, Any]) -> None:
    calls: list[str] = []

    def core(req: httpx.Request) -> httpx.Response:
        calls.append(req.url.path)
        return httpx.Response(503)

    client = TestClient(create_app(cfg, core_transport=httpx.MockTransport(core)))
    body = request().model_dump(mode="json")
    mine = {**body, "outlet_ids": [minted["outlet"]]}

    def post(token: str, payload: dict[str, Any], secret: str = SECRET) -> httpx.Response:
        r: httpx.Response = client.post(
            "/negotiate", json=payload, headers={"x-munim-service-secret": secret, "authorization": f"Bearer {token}"}
        )
        return r

    unauth = {"error": {"code": "unauthenticated", "message": "unauthenticated", "reason_code": None}}
    for r in (post(minted["tokens"]["ask"], mine, "nope"), post(minted["tokens"]["valid"], mine), post(minted["tokens"]["brief"], mine)):
        assert (r.status_code, r.json()) == (401, unauth)
    assert post(minted["tokens"]["ask"], body).status_code == 400  # the body's outlets are not the token's scope
    assert post(minted["tokens"]["ask"], {"rfq_id": "x"}).status_code == 400
    assert calls == []
    r = post(minted["tokens"]["ask"], mine)
    assert (r.status_code, calls) == (503, ["/internal/intel/v1/run-frame"])
