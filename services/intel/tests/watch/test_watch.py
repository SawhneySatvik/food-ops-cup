"""T-043 offline gates: the watcher pipeline against an in-memory core (the internal API is the system boundary; the
real one is in test_watch_e2e.py). Expected values are hand values from the pack docs, never the code under test:
packs/finance.md §4 `unapproved_minor` ≥ ₹100 (A$2) = 10,000 paise (200 cents); packs/catalogue.md §4 above MRP by
any amount; the ladder L in the packs header."""

from __future__ import annotations

import asyncio
import json
import shutil
import subprocess
from dataclasses import replace
from datetime import date
from pathlib import Path
from typing import Any, cast

from conftest import REPO
from munim_intel.config import load_config
from munim_intel.contracts_gen.models import (
    InternalDraftsRequest,
    InternalDraftsResponse,
    InternalEventsClaimResponse,
    InternalFindingsRequest,
    InternalFindingsResponse,
    InternalSnapshotsRequest,
    InternalTracesBatchRequest,
    InternalTracesBatchResponse,
    InternalWatchClaimResponse,
    Snapshot,
)
from munim_intel.detect import REGISTRY, DetectorSpec, OutletFrame
from munim_intel.llm.recorded import RecordedLlm
from munim_intel.mapping import Detection, draft_id
from munim_intel.runtime.context import RunContext
from munim_intel.runtime.internal_client import InternalClient
from munim_intel.tools.generated import ReadTemplateTool
from munim_intel.tools.handles import HandleTable
from munim_intel.tools.ontology import load_ontology
from munim_intel.trace.plugin import _invalid_args
from munim_intel.watch.detectors.catalogue import above_mrp
from munim_intel.watch.detectors.finance import unapproved_ad_fee
from munim_intel.watch.frame import Frame, Narration, frame_from_pack
from munim_intel.watch.pipeline import Report, WatchRun, detectors_for

RUN = "01920000-0000-7000-8000-0000000043a1"
TENANT = "01920000-0000-7000-8000-0000000043b1"
OUTLET = "01920000-0000-7000-8000-0000000043c1"
CHANNEL = "01920000-0000-7000-8000-0000000043d1"
ITEM = "01920000-0000-7000-8000-0000000043e1"
CTX = RunContext(RUN, TENANT, ("*",), "watch_sweep", "watcher:sweep", 2_000_000_000, "h.p.s")
CFG = load_config(env={}, run_dir=Path("/nonexistent"))


class FakeCore:
    """Serves each template's rows as a snapshot (for October only: the other months a detector mints are empty) and
    records every write, as core's internal API would answer them."""

    def __init__(self, rows: dict[str, list[dict[str, Any]]]) -> None:
        self.rows = rows
        self.minted: list[InternalSnapshotsRequest] = []
        self.findings: list[InternalFindingsRequest] = []
        self.drafts: list[InternalDraftsRequest] = []
        self.traces: list[dict[str, Any]] = []
        self.claimed: set[str] = set()

    async def claim_event(self, event_id: str) -> InternalEventsClaimResponse | None:
        if event_id in self.claimed:
            return None
        self.claimed.add(event_id)
        return InternalEventsClaimResponse.model_validate({"event_id": event_id, "claimed_at": "2026-10-10T10:00:00Z"})

    async def claim_watch(self, pack: str) -> InternalWatchClaimResponse:
        return InternalWatchClaimResponse(pack=pack, go=True, last_run_at=None)

    async def mint_snapshot(self, req: InternalSnapshotsRequest) -> Snapshot:
        self.minted.append(req)
        params = req.model_dump(mode="json")["params"]
        rows = self.rows.get(req.template_id, []) if params.get("month", "2026-10-01") == "2026-10-01" else []
        sid = f"01920000-0000-7000-8000-{len(self.minted):012x}"
        cols = sorted({k for r in rows for k in r})
        return Snapshot.model_validate(
            {
                "snapshot_id": sid,
                "template_id": req.template_id,
                "params": params,
                "run_id": RUN,
                "minted_by_member_id": None,
                "minted_by_operator_id": None,
                "outlet_scope": ["*"],
                "columns": [{"name": c, "type": "uuid" if c.endswith("_id") else "integer"} for c in cols],
                "rows": rows,
                "row_count": len(rows),
                "sha256": "0" * 64,
                "created_at": "2026-10-10T10:00:00Z",
            }
        )

    async def write_finding(self, req: InternalFindingsRequest) -> InternalFindingsResponse:
        self.findings.append(req)
        return InternalFindingsResponse.model_validate(
            {"finding_id": req.envelope.finding_id.root, "outcome": "stored", "reason_code": None}
        )

    async def write_draft(self, req: InternalDraftsRequest) -> InternalDraftsResponse:
        self.drafts.append(req)
        return InternalDraftsResponse.model_validate({"draft_id": req.draft_id.root, "status": "proposed", "reason_code": None})

    async def write_traces(self, req: InternalTracesBatchRequest) -> InternalTracesBatchResponse:
        self.traces += [e.model_dump(mode="json") for e in req.events]
        return InternalTracesBatchResponse(inserted=len(req.events), last_seq=len(self.traces))


def frame(code: str, kind: str = "restaurant", narration: Narration = "template") -> Frame:
    pack = json.loads((REPO / "packages" / "contracts" / "packs" / f"{code}.json").read_text("utf8"))
    return frame_from_pack(pack, [{"id": OUTLET, "kind": kind, "business_date": "2026-10-10"}], narration)


def ad_row(unapproved: int, opted_in: bool = False) -> dict[str, Any]:
    return {
        "channel_id": CHANNEL,
        "ad_fee_minor": unapproved,
        "promo_share_minor": 0,
        "ad_allowed_minor": 0,
        "promo_allowed_minor": 0,
        "unapproved_minor": unapproved,
        "ads_opted_in": opted_in,
    }


def run(core: FakeCore, f: Frame, packs: dict[str, list[DetectorSpec]] | None = None, *, llm: Any = None) -> tuple[Report, WatchRun]:
    w = WatchRun(CTX, core, f, CFG, llm=llm)
    report = asyncio.run(w.run(packs if packs is not None else detectors_for(None)))
    return report, w


# -- (2) threshold ---------------------------------------------------------------------------------------------


def test_just_below_the_threshold_finds_nothing_and_at_it_finds_one() -> None:
    cases = [  # (pack, unapproved, findings) — the threshold is "≥", so the first value that fires is the threshold itself
        ("IN", 9_999, 0),
        ("IN", 10_000, 1),
        ("AU", 199, 0),
        ("AU", 200, 1),
    ]
    got = []
    for code, amount, _ in cases:
        core = FakeCore({"finance.unapproved_deductions": [ad_row(amount)]})
        run(core, frame(code), {"finance": [unapproved_ad_fee.SPEC]})
        got.append(len(core.findings))
    print("findings per case:", list(zip(cases, got, strict=True)))
    assert got == [1 if want else 0 for _, _, want in cases]
    shop = [(0, 0), (1, 1)]  # above MRP by nothing, by one paisa
    found = []
    for above, _ in shop:
        core = FakeCore(
            {"catalogue.sku_price_check": [{"item_id": ITEM, "price_minor": 3000, "mrp_minor": 2800, "above_mrp_minor": above}]}
        )
        run(core, frame("IN", "store"), {"catalogue": [above_mrp.SPEC]})
        found.append(len(core.findings))
    assert found == [want for _, want in shop]


# -- (3) narration off → 0 model calls; on → 1 ---------------------------------------------------------------------


def test_narration_off_makes_zero_model_calls_and_writes_the_template() -> None:
    rows = {"finance.unapproved_deductions": [ad_row(55_000)]}  # high (never opted in): a narration candidate
    calls = RecordedLlm.calls
    core = FakeCore(rows)
    _, w = run(core, frame("IN", narration="template"), {"finance": [unapproved_ad_fee.SPEC]}, llm=RecordedLlm(model="recorded/narrate"))
    off = (RecordedLlm.calls - calls, w.state.budget.model_calls)
    texts = {f.envelope.segments[0].text.split("⟨")[0] for f in core.findings}
    # The same finding with narration on: one model call per stored high finding (the RG-F1 fixture, handle S1.r0).
    calls = RecordedLlm.calls
    on_core = FakeCore(rows)
    _, on = run(on_core, frame("IN", narration="model"), {"finance": [unapproved_ad_fee.SPEC]}, llm=RecordedLlm(model="recorded/narrate"))
    print("off:", off, "templates:", texts, "on:", (RecordedLlm.calls - calls, on.state.budget.model_calls))
    assert off == (0, 0)
    assert texts == {"This channel charged ad and promotion fees beyond what was agreed for the month: "}
    assert {f.severity for f in core.findings} == {"high"}
    assert (RecordedLlm.calls - calls, on.state.budget.model_calls) == (1, 1)


# -- (4) confidence_bp = the pack's coverage cell -------------------------------------------------------------------


def test_confidence_is_the_coverage_cell_the_pack_names_else_full() -> None:
    # Hand list: catalogue.md and finance.md name no coverage cell → 10,000. A detector whose pack names one (here a
    # fixture reading `coverage_bp`, as compliance.missed_logs does) carries that cell's value: 7,300.
    covered = replace(unapproved_ad_fee.SPEC, coverage_column="coverage_bp", mapping=None)
    core = FakeCore({"finance.unapproved_deductions": [{**ad_row(55_000), "coverage_bp": 7_300}]})
    run(core, frame("IN"), {"finance": [covered]})
    plain = FakeCore({"finance.unapproved_deductions": [ad_row(55_000)]})
    run(plain, frame("IN"), {"finance": [unapproved_ad_fee.SPEC]})
    assert {f.confidence_bp for f in core.findings} == {7_300}
    assert {f.confidence_bp for f in plain.findings} == {10_000}


# -- (5) the specialist on every finding, draft and trace -----------------------------------------------------------


def test_every_finding_draft_and_trace_carries_its_specialist() -> None:
    core = FakeCore(
        {
            "finance.unapproved_deductions": [ad_row(55_000)],
            "catalogue.sku_price_check": [{"item_id": ITEM, "price_minor": 3000, "mrp_minor": 2800, "above_mrp_minor": 28_000}],
        }
    )
    run(core, frame("IN", "store"))
    owner = {"reconciliation_break.unapproved_ad_fee": "finance", "catalogue.above_mrp": "catalogue"}
    by_id = {f.envelope.finding_id.root: f for f in core.findings}
    print("findings:", [(f.type, f.pack) for f in core.findings], "drafts:", [(d.command_type, d.pack) for d in core.drafts])
    # Hand count: 1 channel-month + 1 SKU = 2 findings; the finance one gets a dispute draft.
    assert (len(core.findings), len(core.drafts)) == (2, 1)
    assert [f.pack for f in core.findings] == [owner[f.type] for f in core.findings]
    assert all(d.pack == by_id[d.finding_id.root].pack for d in core.drafts if d.finding_id is not None)
    assert {t["actor"] for t in core.traces} == {"watcher:finance", "watcher:catalogue"}


def test_every_registered_detector_belongs_to_its_specialist_in_the_registry() -> None:
    """The registry (packages/contracts/src/intel/specialists.ts, read through node) lists each specialist's detectors."""
    node = shutil.which("node")
    assert node, "node is required: the registry is the contracts package's TypeScript"
    script = "import { SPECIALIST_REGISTRY as r } from './packages/contracts/src/intel/specialists.ts'; console.log(JSON.stringify(r))"
    out = subprocess.run([node, "--input-type=module", "-e", script], cwd=REPO, capture_output=True, text=True, check=True, timeout=60)
    owned = {s["id"]: set(s["detectors"]) for s in json.loads(out.stdout)["specialists"]}
    detectors_for(None)
    registered = [(pack, s.id, s.pack) for pack, specs in REGISTRY.items() for s in specs]
    print("registered:", registered)
    # The two reference detectors (T-043) are registered; the pack lanes add theirs, each owned by its specialist below.
    assert {("catalogue", "catalogue.above_mrp"), ("finance", "finance.unapproved_ad_fee")} <= {(r[0], r[1]) for r in registered}
    assert [r for r in registered if r[1] not in owned.get(r[0], set()) or r[0] != r[2]] == []


# -- DraftMapping: canonical refs, deterministic id -----------------------------------------------------------------


def test_the_dispute_draft_cites_the_impact_cell_and_its_id_is_keyed_on_the_finding_not_the_run() -> None:
    outlet = OutletFrame(OUTLET, "restaurant", date(2026, 10, 10))
    a = Detection("01920000-0000-7000-8000-00000000aaaa", 0, ad_row(55_000), outlet, "INR")
    b = Detection("01920000-0000-7000-8000-00000000bbbb", 3, ad_row(55_000), outlet, "INR")  # a later run's snapshot
    finding, other = "01920000-0000-7000-8000-0000000000f1", "01920000-0000-7000-8000-0000000000f2"
    assert unapproved_ad_fee.SPEC.mapping is unapproved_ad_fee.dispute
    pa, pb = unapproved_ad_fee.dispute(a), unapproved_ad_fee.dispute(b)
    assert pa.payload["total_claimed_minor"] == "⟨snap:01920000-0000-7000-8000-00000000aaaa·0·unapproved_minor⟩"
    assert pa.based_on == [pa.payload["total_claimed_minor"]]
    assert draft_id(finding, pa) == draft_id(finding, pb) != draft_id(other, pa)


# -- events: a redelivery does nothing -------------------------------------------------------------------------------


def test_three_deliveries_of_one_event_run_the_detectors_once() -> None:
    from munim_intel.contracts_gen.models import Cloudevent
    from munim_intel.events import handle_event

    core = FakeCore({"catalogue.sku_price_check": [{"item_id": ITEM, "price_minor": 3000, "mrp_minor": 2800, "above_mrp_minor": 28_000}]})
    event = Cloudevent.model_validate(
        {
            "specversion": "1.0",
            "id": "01920000-0000-7000-8000-0000000000e1",
            "time": "2026-10-10T10:00:00Z",
            "datacontenttype": "application/json",
            "tenantid": TENANT,
            "munimrun": "h.p.s",
            "source": f"/tenants/{TENANT}/inventory",
            "type": above_mrp.MOVEMENT_RECORDED,
            "subject": "01920000-0000-7000-8000-0000000000e2",
            "data": {},
        }
    )
    reports = [asyncio.run(handle_event(event, CTX, core, frame("IN", "store"), CFG)) for _ in range(3)]
    print("reports:", [r.as_json() if r else None for r in reports], "minted:", len(core.minted))
    assert (len(core.minted), len(core.findings), sum(r is None for r in reports)) == (1, 1, 2)


# -- (b) the plugin honours a generated tool's own argument check ----------------------------------------------------


def test_the_plugin_refuses_a_generated_tools_invalid_arguments_with_its_own_message() -> None:
    fn = next(f for f in load_ontology()["functions"] if f["id"] == "finance.unapproved_deductions")
    tool = ReadTemplateTool(fn, cast(InternalClient, None), HandleTable())  # the client is never called
    good = {"month": "2026-10-01", "outlet_id": None, "channel_id": None, "page": 0}
    bad = {"month": "2026-10-01", "outlet_id": None, "page": "first"}
    problem = _invalid_args(tool, bad)
    print("problem:", problem)
    assert _invalid_args(tool, good) is None
    assert problem is not None and problem.startswith("invalid arguments for read_finance_unapproved_deductions:") and len(problem) <= 300
