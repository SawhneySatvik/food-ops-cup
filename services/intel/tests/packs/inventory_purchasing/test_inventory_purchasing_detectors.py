"""T-046 offline gates: the inventory & purchasing detectors through the real watcher pipeline against an in-memory core
(the internal API is the system boundary; the real one is in test_inventory_purchasing_e2e.py).

Expected values are hand values, never the code under test: thresholds typed from packs/inventory-purchasing.md §4 (₹ and
A$ in minor units), the ladder L from the packs header (IN ₹50,000 / ₹10,000 / ₹2,000; AU A$1,000 / A$200 / A$40), the
templates, impact columns and §3 columns typed from the pack's §3–§5 tables.
"""

from __future__ import annotations

import asyncio
import json
import re
import shutil
import subprocess
from dataclasses import replace
from datetime import date
from pathlib import Path
from typing import Any

import pytest

from conftest import REPO
from munim_intel.config import load_config
from munim_intel.contracts_gen.models import (
    InternalDraftsRequest,
    InternalDraftsResponse,
    InternalFindingsRequest,
    InternalFindingsResponse,
    InternalSnapshotsRequest,
    InternalTracesBatchRequest,
    InternalTracesBatchResponse,
    InternalWatchClaimResponse,
    Snapshot,
)
from munim_intel.detect import REGISTRY, DetectorSpec, Ladder, OutletFrame, Window
from munim_intel.mapping import Detection, draft_body
from munim_intel.runtime.context import RunContext
from munim_intel.watch.detectors.inventory_purchasing import near_duplicate_invoice, overbilled, shrinkage
from munim_intel.watch.frame import Frame, frame_from_pack
from munim_intel.watch.pipeline import WatchRun

PACK = "inventory_purchasing"
RUN = "01920000-0000-7000-8000-0000000046a1"
TENANT = "01920000-0000-7000-8000-0000000046b1"
OUTLET = "01920000-0000-7000-8000-0000000046c1"
ING = "01920000-0000-7000-8000-0000000046d1"
SUPPLIER = "01920000-0000-7000-8000-0000000046e1"
BATCH = "01920000-0000-7000-8000-0000000046f1"
INVOICE = "01920000-0000-7000-8000-000000004601"
TWIN = "01920000-0000-7000-8000-000000004602"
LINE_A = "01920000-0000-7000-8000-000000004611"
LINE_B = "01920000-0000-7000-8000-000000004612"
COUNT = "01920000-0000-7000-8000-000000004621"
CTX = RunContext(RUN, TENANT, ("*",), "watch_sweep", "watcher:sweep", 2_000_000_000, "h.p.s")
CFG = load_config(env={}, run_dir=Path("/nonexistent"))
BUSINESS_DATE = date(2026, 10, 10)

# Pack §4 (template) and §5 (impact column), typed by hand.
SPEC_TABLE = {
    "inventory.shortfall": ("inventory.shortfall", "shortfall_qty_milli"),
    "inventory.waste_spike": ("inventory.waste_week", "excess_minor"),
    "inventory.expiry_risk": ("inventory.expiry_risk", "at_risk_minor"),
    "inventory.shrinkage": ("inventory.shrinkage", "loss_minor"),
    "inventory.dead_stock": ("inventory.dead_stock", "value_minor"),
    "purchasing.price_creep": ("purchasing.price_creep", "creep_impact_minor"),
    "purchasing.overbilled": ("purchasing.invoice_vs_po", "overbilled_minor"),
    "purchasing.near_duplicate_invoice": ("purchasing.invoice_duplicates", "total_minor"),
}
# Pack §3 output columns, typed by hand.
COLUMNS = {
    "inventory.shortfall": {
        "ingredient_id",
        "need_qty_milli",
        "proposed_min_qty_milli",
        "proposed_par_qty_milli",
        "on_hand_qty_milli",
        "open_po_qty_milli",
        "shortfall_qty_milli",
        "stockout_on",
    },
    "inventory.waste_week": {"ingredient_id", "waste_minor", "median_minor", "excess_minor"},
    "inventory.expiry_risk": {
        "batch_id",
        "expiry_on",
        "days_to_expiry",
        "is_sku",
        "remaining_qty_milli",
        "use_before_expiry_qty_milli",
        "at_risk_qty_milli",
        "at_risk_minor",
    },
    "inventory.shrinkage": {"ingredient_id", "expected_qty_milli", "counted_qty_milli", "loss_minor", "counted_value_minor"},
    "inventory.dead_stock": {"ingredient_id", "on_hand_qty_milli", "value_minor", "last_sold_at"},
    "purchasing.price_creep": {
        "supplier_id",
        "ingredient_id",
        "baseline_minor",
        "latest_minor",
        "creep_bp",
        "observations",
        "creep_impact_minor",
    },
    "purchasing.invoice_vs_po": {
        "line_id",
        "po_price_minor",
        "invoice_price_minor",
        "invoice_qty_milli",
        "received_qty_milli",
        "overbilled_minor",
    },
    "purchasing.invoice_duplicates": {"twin_invoice_id", "total_minor", "days_apart"},
}
LADDER = {"IN": Ladder(5_000_000, 1_000_000, 200_000), "AU": Ladder(100_000, 20_000, 4_000)}


class FakeCore:
    """Serves each template's rows on its first window only (every window with `every_window`; the waste detector mints
    six weeks), and records every write as core's internal API would answer it."""

    def __init__(self, rows: dict[str, list[dict[str, Any]]], *, every_window: bool = False) -> None:
        self.rows = rows
        self.every_window = every_window
        self.minted: list[dict[str, Any]] = []
        self.findings: list[InternalFindingsRequest] = []
        self.drafts: list[InternalDraftsRequest] = []
        self.traces: list[dict[str, Any]] = []

    async def claim_event(self, event_id: str) -> None:
        raise AssertionError("no events here")

    async def claim_watch(self, pack: str) -> InternalWatchClaimResponse:
        return InternalWatchClaimResponse(pack=pack, go=True, last_run_at=None)

    async def mint_snapshot(self, req: InternalSnapshotsRequest) -> Snapshot:
        body = req.model_dump(mode="json")
        self.minted.append(body)
        first = all(m["template_id"] != req.template_id for m in self.minted[:-1])
        rows = self.rows.get(req.template_id, []) if first or self.every_window else []
        return Snapshot.model_validate(
            {
                "snapshot_id": f"01920000-0000-7000-8000-{len(self.minted):012x}",
                "template_id": req.template_id,
                "params": body["params"],
                "run_id": RUN,
                "minted_by_member_id": None,
                "minted_by_operator_id": None,
                "outlet_scope": ["*"],
                "columns": [{"name": c, "type": "integer"} for c in sorted({k for r in rows for k in r})],
                "rows": rows,
                "row_count": len(rows),
                "sha256": "0" * 64,
                "created_at": "2026-10-10T10:00:00Z",
            }
        )

    async def write_finding(self, req: InternalFindingsRequest) -> InternalFindingsResponse:
        self.findings.append(req)
        stored = {"finding_id": req.envelope.finding_id.root, "outcome": "stored", "reason_code": None}
        return InternalFindingsResponse.model_validate(stored)

    async def write_draft(self, req: InternalDraftsRequest) -> InternalDraftsResponse:
        self.drafts.append(req)
        return InternalDraftsResponse.model_validate({"draft_id": req.draft_id.root, "status": "proposed", "reason_code": None})

    async def write_traces(self, req: InternalTracesBatchRequest) -> InternalTracesBatchResponse:
        self.traces += [e.model_dump(mode="json") for e in req.events]
        return InternalTracesBatchResponse(inserted=len(req.events), last_seq=len(self.traces))


def frame(code: str, kind: str = "store") -> Frame:
    pack = json.loads((REPO / "packages" / "contracts" / "packs" / f"{code}.json").read_text("utf8"))
    return frame_from_pack(pack, [{"id": OUTLET, "kind": kind, "business_date": BUSINESS_DATE.isoformat()}], "template")


def keyed(spec: DetectorSpec) -> DetectorSpec:
    """An id-keyed detector given the one window a listing would hand it (no template lists invoices or counts yet)."""
    w = {
        "inventory.shrinkage": shrinkage.window(COUNT),
        "purchasing.overbilled": overbilled.window(INVOICE),
        "purchasing.near_duplicate_invoice": near_duplicate_invoice.window(INVOICE),
    }.get(spec.id)
    return spec if w is None else replace(spec, windows=lambda _o, _t: [w])


def spec(detector: str) -> DetectorSpec:
    return next(s for s in REGISTRY[PACK] if s.id == detector)


def run(core: FakeCore, f: Frame, detectors: list[str]) -> None:
    asyncio.run(WatchRun(CTX, core, f, CFG).run({PACK: [keyed(spec(d)) for d in detectors]}))


def found(detector: str, rows: list[dict[str, Any]], code: str, *, every_window: bool = False) -> FakeCore:
    core = FakeCore({SPEC_TABLE[detector][0]: rows}, every_window=every_window)
    run(core, frame(code), [detector])
    return core


def waste(w: int, median: int) -> dict[str, Any]:
    return {"ingredient_id": ING, "waste_minor": w, "median_minor": median, "excess_minor": max(w - median, 0)}


def expiry(days: int, sku: bool, at_risk: int) -> dict[str, Any]:
    return {
        "batch_id": BATCH,
        "expiry_on": "2026-10-13",
        "days_to_expiry": days,
        "is_sku": sku,
        "remaining_qty_milli": 40_000,
        "use_before_expiry_qty_milli": 0,
        "at_risk_qty_milli": 40_000,
        "at_risk_minor": at_risk,
    }


def shrink(loss: int, counted: int) -> list[dict[str, Any]]:
    sums = {"loss_minor": loss, "counted_value_minor": counted}
    return [
        {"ingredient_id": ING, "expected_qty_milli": 500_000, "counted_qty_milli": 470_000, **sums},
        {"ingredient_id": None, "expected_qty_milli": None, "counted_qty_milli": None, **sums},
    ]


def dead(value: int) -> dict[str, Any]:
    return {"ingredient_id": ING, "on_hand_qty_milli": 10_000, "value_minor": value, "last_sold_at": None}


def creep(bp: int, seen: int, impact: int = 336_000) -> dict[str, Any]:
    return {
        "supplier_id": SUPPLIER,
        "ingredient_id": ING,
        "baseline_minor": 4_000,
        "latest_minor": 4_560,
        "creep_bp": bp,
        "observations": seen,
        "creep_impact_minor": impact,
    }


def invoice(lines: list[int]) -> list[dict[str, Any]]:
    ids = [LINE_A, LINE_B]
    rows: list[dict[str, Any]] = [
        {
            "line_id": ids[i],
            "po_price_minor": 32_000,
            "invoice_price_minor": 32_600,
            "invoice_qty_milli": 120_000,
            "received_qty_milli": 120_000,
            "overbilled_minor": o,
        }
        for i, o in enumerate(lines)
    ]
    return [
        *rows,
        {
            "line_id": None,
            "po_price_minor": None,
            "invoice_price_minor": None,
            "invoice_qty_milli": None,
            "received_qty_milli": None,
            "overbilled_minor": sum(lines),
        },
    ]


def short(qty: int) -> dict[str, Any]:
    return {
        "ingredient_id": ING,
        "need_qty_milli": 9_000,
        "proposed_min_qty_milli": 9_000,
        "proposed_par_qty_milli": 30_000,
        "on_hand_qty_milli": 9_000 - qty,
        "open_po_qty_milli": 0,
        "shortfall_qty_milli": qty,
        "stockout_on": "2026-10-12",
    }


# (detector, pack, rows, findings by hand) — each threshold at its boundary, both sides, IN and AU (pack §4).
BOUNDARY: list[tuple[str, str, list[dict[str, Any]], int]] = [
    ("inventory.shortfall", "IN", [short(0)], 0),
    ("inventory.shortfall", "IN", [short(1)], 1),
    # excess ≥ ₹1,500 = 150,000 paise; A$30 = 3,000 cents (median 0: the 1.5× rule holds for any waste)
    ("inventory.waste_spike", "IN", [waste(149_999, 0)], 0),
    ("inventory.waste_spike", "IN", [waste(150_000, 0)], 1),
    ("inventory.waste_spike", "AU", [waste(2_999, 0)], 0),
    ("inventory.waste_spike", "AU", [waste(3_000, 0)], 1),
    # waste ≥ 1.5 × median: 600,000 against 400,000 fires; a paisa less does not (its excess is still ≥ ₹1,500)
    ("inventory.waste_spike", "IN", [waste(599_999, 400_000)], 0),
    ("inventory.waste_spike", "IN", [waste(600_000, 400_000)], 1),
    # days_to_expiry ≤ 3, ≤ 7 for a SKU; at_risk ≥ ₹500 = 50,000 paise, A$10 = 1,000 cents
    ("inventory.expiry_risk", "IN", [expiry(4, False, 100_000)], 0),
    ("inventory.expiry_risk", "IN", [expiry(3, False, 100_000)], 1),
    ("inventory.expiry_risk", "IN", [expiry(8, True, 100_000)], 0),
    ("inventory.expiry_risk", "IN", [expiry(7, True, 100_000)], 1),
    ("inventory.expiry_risk", "IN", [expiry(2, True, 49_999)], 0),
    ("inventory.expiry_risk", "IN", [expiry(2, True, 50_000)], 1),
    ("inventory.expiry_risk", "AU", [expiry(2, True, 999)], 0),
    ("inventory.expiry_risk", "AU", [expiry(2, True, 1_000)], 1),
    # loss ≥ 2% of counted value, or ≥ ₹2,000 = 200,000 paise (A$40 = 4,000 cents); the Σ row only
    ("inventory.shrinkage", "IN", shrink(199, 10_000), 0),
    ("inventory.shrinkage", "IN", shrink(200, 10_000), 1),
    ("inventory.shrinkage", "IN", shrink(199_999, 100_000_000), 0),
    ("inventory.shrinkage", "IN", shrink(200_000, 100_000_000), 1),
    ("inventory.shrinkage", "AU", shrink(3_999, 100_000_000), 0),
    ("inventory.shrinkage", "AU", shrink(4_000, 100_000_000), 1),
    ("inventory.shrinkage", "IN", shrink(0, 0), 0),
    # value ≥ ₹1,000 = 100,000 paise; A$20 = 2,000 cents
    ("inventory.dead_stock", "IN", [dead(99_999)], 0),
    ("inventory.dead_stock", "IN", [dead(100_000)], 1),
    ("inventory.dead_stock", "AU", [dead(1_999)], 0),
    ("inventory.dead_stock", "AU", [dead(2_000)], 1),
    # creep_bp ≥ 500 and observations ≥ 2
    ("purchasing.price_creep", "IN", [creep(499, 3)], 0),
    ("purchasing.price_creep", "IN", [creep(500, 2)], 1),
    ("purchasing.price_creep", "AU", [creep(900, 1)], 0),
    # Σ overbilled ≥ ₹100 = 10,000 paise; A$2 = 200 cents; a line row never fires on its own
    ("purchasing.overbilled", "IN", invoice([9_999]), 0),
    ("purchasing.overbilled", "IN", invoice([10_000]), 1),
    ("purchasing.overbilled", "IN", invoice([6_000, 4_000]), 1),
    ("purchasing.overbilled", "AU", invoice([199]), 0),
    ("purchasing.overbilled", "AU", invoice([200]), 1),
    # days_apart ≤ 7
    ("purchasing.near_duplicate_invoice", "IN", [{"twin_invoice_id": TWIN, "total_minor": 520_000, "days_apart": 8}], 0),
    ("purchasing.near_duplicate_invoice", "IN", [{"twin_invoice_id": TWIN, "total_minor": 520_000, "days_apart": 7}], 1),
]


@pytest.mark.parametrize(("detector", "code", "rows", "want"), BOUNDARY, ids=[f"{d}-{c}-{i}" for i, (d, c, _, _) in enumerate(BOUNDARY)])
def test_each_threshold_fires_at_its_boundary_and_not_one_unit_short(
    detector: str, code: str, rows: list[dict[str, Any]], want: int
) -> None:
    core = found(detector, rows, code)
    assert len(core.findings) == want


def test_every_pack_detector_is_registered_with_the_pack_template_and_impact_column() -> None:
    got = {s.id: (s.template, s.impact_column) for s in REGISTRY[PACK]}
    print("registered:", sorted(got))
    assert got == SPEC_TABLE
    assert all(s.pack == PACK and s.finding_type == s.id for s in REGISTRY[PACK])


def test_the_registry_lists_exactly_these_detectors_for_the_specialist() -> None:
    """packages/contracts/src/intel/specialists.ts (read through node) names the specialist's detectors."""
    node = shutil.which("node")
    assert node, "node is required: the registry is the contracts package's TypeScript"
    script = "import { SPECIALIST_REGISTRY as r } from './packages/contracts/src/intel/specialists.ts'; console.log(JSON.stringify(r))"
    out = subprocess.run([node, "--input-type=module", "-e", script], cwd=REPO, capture_output=True, text=True, check=True, timeout=60)
    owned = next(s for s in json.loads(out.stdout)["specialists"] if s["id"] == PACK)
    assert sorted(owned["detectors"]) == sorted(s.id for s in REGISTRY[PACK])


def number_words() -> set[str]:
    """Core's number grammar refuses these words (packages/contracts grammar/number-words.json, its single definition)."""
    doc = json.loads((REPO / "packages" / "contracts" / "src" / "shared" / "grammar" / "number-words.json").read_text("utf8"))
    return {w.lower() for k in ("english_cardinals", "english_magnitude_plurals", "devanagari") for w in doc[k]}


def test_narrations_carry_no_digit_or_number_word_and_cite_only_their_templates_columns() -> None:
    words, bad = number_words(), []
    for s in REGISTRY[PACK]:
        slots = set(re.findall(r"\{([a-z_][a-z0-9_]*)\}", s.narration))
        typed = {w for w in re.findall(r"[a-z]+(?:-[a-z]+)*", re.sub(r"\{[a-z0-9_]+\}", "", s.narration.lower())) if w in words}
        if re.search(r"\d", s.narration) or typed or not slots <= COLUMNS[s.template] or s.impact_column not in slots:
            bad.append((s.id, sorted(typed), sorted(slots - COLUMNS[s.template])))
    assert bad == []


def test_severities_worked_by_hand_from_the_ladder() -> None:
    """L on the impact cell; waste on 4.3 × excess; dead stock low / medium at ₹10,000 (A$200); shortfall medium (the
    'stockout ≤ tomorrow → high' rule needs the business date, which the severity callable is not handed)."""
    cases = [  # (detector, pack, rows, severity by hand)
        ("purchasing.price_creep", "IN", [creep(1_400, 3, 336_000)], "medium"),  # RG-I1: ≥ ₹2,000, < ₹10,000
        ("purchasing.price_creep", "AU", [creep(1_200, 3, 21_600)], "high"),  # AU-I1: ≥ A$200
        ("purchasing.overbilled", "IN", invoice([72_000]), "low"),  # RG-I2: < ₹2,000
        ("purchasing.overbilled", "AU", invoice([10_000]), "medium"),  # AU-I2: ≥ A$40
        ("inventory.shrinkage", "IN", shrink(1_350_000, 21_150_000), "high"),  # ST-I5: ≥ ₹10,000
        ("inventory.expiry_risk", "IN", [expiry(2, True, 100_000)], "low"),  # ST-I4
        ("inventory.waste_spike", "IN", [waste(252_000, 0)], "high"),  # CK-K7: 4.3 × 252,000 = 1,083,600 ≥ ₹10,000
        ("inventory.waste_spike", "IN", [waste(220_000, 0)], "medium"),  # 4.3 × 220,000 = 946,000 < ₹10,000
        ("inventory.dead_stock", "IN", [dead(999_999)], "low"),
        ("inventory.dead_stock", "IN", [dead(1_000_000)], "medium"),
        ("inventory.dead_stock", "AU", [dead(20_000)], "medium"),
        ("inventory.shortfall", "IN", [short(1)], "medium"),
        # RG-I3: ₹5,200 ≥ ₹2,000
        ("purchasing.near_duplicate_invoice", "IN", [{"twin_invoice_id": TWIN, "total_minor": 520_000, "days_apart": 2}], "medium"),
    ]
    got = [(d, c, [f.severity for f in found(d, rows, c).findings]) for d, c, rows, _ in cases]
    assert got == [(d, c, [want]) for d, c, _, want in cases]


def test_a_stockout_tomorrow_is_high() -> None:
    """Pack §4: `high` when stockout_on ≤ tomorrow (the outlet's business date + 1, from the run-frame), else `medium`."""
    days = ["2026-10-09", "2026-10-10", "2026-10-11", "2026-10-12", None]  # the business date is 2026-10-10
    got = [[f.severity for f in found("inventory.shortfall", [{**short(1), "stockout_on": d}], "IN").findings] for d in days]
    print("stockout → severity:", list(zip(days, got, strict=True)))
    assert got == [["high"], ["high"], ["high"], ["medium"], ["medium"]]


def test_both_listings_of_a_near_duplicate_pair_are_one_problem() -> None:
    s = spec("purchasing.near_duplicate_invoice")
    a = s.dedupe({"twin_invoice_id": TWIN, "total_minor": 1, "days_apart": 2}, near_duplicate_invoice.window(INVOICE))
    b = s.dedupe({"twin_invoice_id": INVOICE, "total_minor": 1, "days_apart": 2}, near_duplicate_invoice.window(TWIN))
    assert a == b == INVOICE


def test_dedupe_keys_follow_pack_section_4() -> None:
    def key(detector: str, rows: list[dict[str, Any]]) -> list[str]:
        return [f.dedupe_key for f in found(detector, rows, "IN", every_window=True).findings]

    # 2026-10-10 is a Saturday in ISO week 41; the waste windows are its Monday and the five Mondays before.
    weeks = [f"inventory.waste_spike:{OUTLET}:{ING}:2026-w{w}" for w in (41, 40, 39, 38, 37, 36)]
    assert key("inventory.waste_spike", [waste(150_000, 0)]) == weeks
    assert key("inventory.shortfall", [short(1)]) == [f"inventory.shortfall:{OUTLET}:{ING}:2026-10-10"]
    assert key("inventory.expiry_risk", [expiry(2, True, 100_000)]) == [f"inventory.expiry_risk:{OUTLET}:{BATCH}"]
    assert key("inventory.dead_stock", [dead(100_000)]) == [f"inventory.dead_stock:{OUTLET}:{ING}:2026-10"]
    assert key("purchasing.price_creep", [creep(1_400, 3)]) == [f"purchasing.price_creep:{SUPPLIER}:{ING}:2026-w41"]
    assert key("purchasing.overbilled", invoice([72_000])) == [f"purchasing.overbilled:{INVOICE}"]
    assert key("inventory.shrinkage", shrink(1_350_000, 21_150_000)) == [f"inventory.shrinkage:{COUNT}"]


def test_every_finding_draft_and_trace_carries_the_specialist() -> None:
    rows = {
        "inventory.shortfall": [short(1)],
        "inventory.waste_week": [waste(150_000, 0)],
        "inventory.expiry_risk": [expiry(2, True, 100_000)],
        "inventory.shrinkage": shrink(1_350_000, 21_150_000),
        "inventory.dead_stock": [dead(100_000)],
        "purchasing.price_creep": [creep(1_400, 3)],
        "purchasing.invoice_vs_po": invoice([72_000]),
        "purchasing.invoice_duplicates": [{"twin_invoice_id": TWIN, "total_minor": 520_000, "days_apart": 2}],
    }
    core = FakeCore(rows)
    run(core, frame("IN"), list(SPEC_TABLE))
    print("findings:", [(f.type, f.pack) for f in core.findings], "drafts:", [(d.command_type, d.pack) for d in core.drafts])
    # Hand count: one firing row per detector → 8 findings; the shortfall gets its reorder-level draft and overbilled its
    # dispute (pack §6; the dispute reads the window's invoice id and the snapshot's line rows, W3.2) → 2 drafts.
    assert (len(core.findings), len(core.drafts)) == (8, 2)
    assert {f.pack for f in core.findings} == {PACK} and {d.pack for d in core.drafts} == {PACK}
    assert {t["actor"] for t in core.traces} == {f"watcher:{PACK}"}


def test_the_reorder_level_draft_places_the_shortfall_cells_by_ref() -> None:
    core = FakeCore({"inventory.shortfall": [short(1)]})
    run(core, frame("IN"), ["inventory.shortfall"])
    (d,) = core.drafts
    impact = core.findings[0].envelope.impact_ref
    assert impact is not None
    sid = impact.root.split("·")[0].removeprefix("⟨snap:")
    p = d.model_dump(mode="json")["payload"]
    print("payload:", p)
    assert d.command_type == "inventory.reorder_level.set.v1" and d.outlet_ids[0].root == OUTLET
    assert p == {
        "outlet_id": OUTLET,
        "ingredient_id": ING,
        "min_qty_milli": f"⟨snap:{sid}·0·proposed_min_qty_milli⟩",
        "par_qty_milli": f"⟨snap:{sid}·0·proposed_par_qty_milli⟩",
    }


def test_the_dispute_claims_each_overbilled_line_by_ref_and_validates_as_a_draft() -> None:
    """`overbilled.dispute` (wired once a mapping is handed the window params and the snapshot rows): one line per invoice
    line with a positive overbilled cell — a zero line is left out (claimed_minor must be positive) — under the internal
    drafts schema."""
    sid = "01920000-0000-7000-8000-00000000d150"
    rows = invoice([72_000, 0])
    d = Detection(sid, 2, rows[2], OutletFrame(OUTLET, "restaurant", BUSINESS_DATE), "INR")
    p = overbilled.dispute(d, INVOICE, rows)
    assert p is not None
    body = InternalDraftsRequest.model_validate(draft_body(PACK, "01920000-0000-7000-8000-0000000000f1", d, p)).model_dump(mode="json")
    print("payload:", body["payload"])
    assert body["command_type"] == "purchasing.invoice.dispute.v1" and body["pack"] == PACK
    assert {k: v for k, v in body["payload"].items() if k != "dispute_id"} == {
        "supplier_invoice_id": INVOICE,
        "basis": "overbilled",
        "lines": [{"invoice_line_id": LINE_A, "claimed_minor": f"⟨snap:{sid}·0·overbilled_minor⟩"}],
    }
    assert body["based_on"] == [f"⟨snap:{sid}·2·overbilled_minor⟩", f"⟨snap:{sid}·0·overbilled_minor⟩"]
    assert overbilled.dispute(d, INVOICE, invoice([0])) is None


def test_a_sweep_lists_invoices_and_counts_then_mints_one_id_keyed_template_per_listed_id() -> None:
    """Shrinkage, overbilled and near-duplicate are keyed by a count or invoice id: a sweep lists them first
    (`inventory.counts`, `purchasing.invoices` — 0022) and mints the keyed template once per listed id (hand list: one
    count, two invoices plus a row without an id), while the other five mint per outlet with no listing."""
    other = "01920000-0000-7000-8000-000000004603"
    core = FakeCore(
        {
            "inventory.counts": [{"count_id": COUNT, "outlet_id": OUTLET, "counted_at": "2026-10-09T20:00:00Z"}],
            "purchasing.invoices": [{"supplier_invoice_id": INVOICE}, {"supplier_invoice_id": other}, {"supplier_invoice_id": None}],
        },
        every_window=True,  # both invoice detectors list the same invoices
    )
    asyncio.run(WatchRun(CTX, core, frame("IN"), CFG).run({PACK: REGISTRY[PACK]}))
    keyed_ids = sorted(
        (m["template_id"], next(iter(m["params"].values())))
        for m in core.minted
        if set(m["params"]) in ({"count_id"}, {"supplier_invoice_id"})
    )
    assert keyed_ids == sorted(
        [
            ("inventory.shrinkage", COUNT),
            ("purchasing.invoice_vs_po", INVOICE),
            ("purchasing.invoice_vs_po", other),
            ("purchasing.invoice_duplicates", INVOICE),
            ("purchasing.invoice_duplicates", other),
        ]
    )
    lists = [(m["template_id"], m["params"]) for m in core.minted if m["template_id"] in ("inventory.counts", "purchasing.invoices")]
    # window_days 30 (pack): the 30 business days ending 2026-10-10; invoices listed once per id-keyed detector.
    assert sorted(lists, key=str) == sorted(
        [
            ("purchasing.invoices", {"from": "2026-09-11", "to": "2026-10-10"}),
            ("purchasing.invoices", {"from": "2026-09-11", "to": "2026-10-10"}),
            ("inventory.counts", {"outlet_id": OUTLET, "from": "2026-09-11", "to": "2026-10-10"}),
        ],
        key=str,
    )
    assert len(REGISTRY[PACK]) == 8  # pack §4 lists eight


def test_window_params_are_exactly_the_templates_params() -> None:
    """Pack §3 params by hand (the templates refuse any other key: additionalProperties false)."""
    # 0022: shortfall, expiry_risk and dead_stock v2 take `as_of` (passed: the run-frame business date); the two list templates
    # feed the id-keyed ones.
    want = {
        "inventory.shortfall": {"outlet_id", "lead_days", "as_of"},
        "inventory.waste_week": {"outlet_id", "week_start"},
        "inventory.expiry_risk": {"outlet_id", "days", "as_of"},
        "inventory.dead_stock": {"outlet_id", "days", "as_of"},
        "purchasing.price_creep": {"as_of"},
        "inventory.shrinkage": {"count_id"},
        "purchasing.invoice_vs_po": {"supplier_invoice_id"},
        "purchasing.invoice_duplicates": {"supplier_invoice_id"},
        "inventory.counts": {"outlet_id", "from", "to"},
        "purchasing.invoices": {"from", "to"},
    }
    core = FakeCore({})
    run(core, frame("IN"), list(SPEC_TABLE))
    got: dict[str, set[str]] = {}
    for m in core.minted:
        got.setdefault(m["template_id"], set()).update(m["params"])
    assert got == want
    t = frame("IN").detectors["inventory.expiry_risk"]
    windows: list[Window] = spec("inventory.expiry_risk").windows(OutletFrame(OUTLET, "store", BUSINESS_DATE), t)
    assert windows[0].params["days"] == 7  # the larger of the pack's two horizons (3 days, 7 for a SKU)
