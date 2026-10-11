"""T-045 offline gates: the Kitchen detectors and skill against an in-memory core (fake_core.py). Thresholds come from
the country pack the Frame carries; every expected value is worked by hand from packs/kitchen.md §4–§7 (IN: ₹1,000 =
100,000 paise; drift 2,500 bp; ≥ 30 tickets now; load < 13,000 bp; ≥ 300 s gap → at least medium; 2% = 200 bp;
1.5 × median; |gap| ≥ 180 s over ≥ 50 tickets in 14 days) and the ladder L (IN medium ≥ ₹2,000, high ≥ ₹10,000,
critical ≥ ₹50,000 of monthly impact; a week × 4.3) — never from the code under test."""

from __future__ import annotations

import asyncio
import re
from typing import Any

from fake_core import CTX, OUTLET, FakeCore, frame

import munim_intel.watch.detectors  # noqa: F401 — registers every detector (REGISTRY is read directly below)
from conftest import REPO
from munim_intel.config import load_config
from munim_intel.detect import REGISTRY
from munim_intel.runtime.internal_client import InternalClient
from munim_intel.skills.kitchen import skill
from munim_intel.tools.handles import HandleTable
from munim_intel.watch.pipeline import WatchRun, detectors_for

CFG = load_config(env={}, run_dir=REPO / "nonexistent")
WEEK = "2026-10-05"  # the ISO week of the frame's business date (Sat 10 Oct 2026)
ITEM = "01920000-0000-7000-8000-0000000046e1"
ITEM_K = "01920000-0000-7000-8000-0000000046e2"
ITEM_J = "01920000-0000-7000-8000-0000000046e3"
ITEM_L = "01920000-0000-7000-8000-0000000046e4"


def sweep(serve: Any, kind: str = "restaurant", code: str = "IN") -> FakeCore:
    core = FakeCore(serve)
    asyncio.run(WatchRun(CTX, core, frame(code, kind), CFG).run({"kitchen": detectors_for(None)["kitchen"]}))
    return core


def only(template: str, rows: list[dict[str, Any]], **want: Any) -> Any:
    """Serve `rows` for `template` when the params include `want`; nothing otherwise."""

    def serve(t: str, params: dict[str, Any]) -> list[dict[str, Any]]:
        return rows if t == template and all(params.get(k) == v for k, v in want.items()) else []

    return serve


def test_a_shop_mints_no_kitchen_template_and_restaurants_and_cloud_kitchens_do() -> None:
    # Hand count per kitchen outlet: 8 weeks × (ticket_drift + remakes + overprep) + 1 ticket_times window = 25.
    counts = {kind: len(sweep(lambda *_: [], kind).minted) for kind in ("store", "restaurant", "cloud_kitchen")}
    assert counts == {"store": 0, "restaurant": 25, "cloud_kitchen": 25}


def slot(station: str, slot_start: str, drift: int, now: int, load: int, p80_now: int = 900, p80_base: int = 600) -> dict[str, Any]:
    return {"station": station, "slot_start": slot_start, "tickets_now": now, "p80_now_sec": p80_now, "p80_base_sec": p80_base,
            "drift_bp": drift, "load_ratio_bp": load, "late_loss_minor": None}  # fmt: skip


def sigma_drift(loss: int) -> dict[str, Any]:
    return {"station": None, "slot_start": None, "tickets_now": None, "p80_now_sec": None, "p80_base_sec": None,
            "drift_bp": None, "load_ratio_bp": None, "late_loss_minor": loss}  # fmt: skip


def test_ticket_drift_fires_at_the_bars_cites_the_sigma_rows_loss_and_skips_a_loaded_slot() -> None:
    rows = [
        slot("tandoor", "20:00", 2500, 30, 12999),  # at every bar → fires
        slot("tandoor", "20:30", 2499, 40, 10000),  # drift one below
        slot("grill", "13:00", 4000, 29, 10000),  # one ticket short
        slot("grill", "21:00", 3000, 54, 13000),  # K6: load at the bar is load, not drift
        sigma_drift(54_000),
    ]
    core = sweep(only("kitchen.ticket_drift", rows, week_start=WEEK))
    (f,) = core.finding_rows()
    # 54,000 × 4.3 = 232,200 → medium (≥ 200,000); the 300 s gap floor is also medium.
    assert (f["type"], f["pack"], f["severity"], f["impact_row"], f["impact_column"]) == (
        "kitchen.ticket_drift",
        "kitchen",
        "medium",
        4,
        "late_loss_minor",
    )
    assert f["dedupe_key"] == f"kitchen.ticket_drift:{OUTLET}:tandoor:20:00:2026-w41"
    text = f["envelope"]["segments"][0]["text"]
    assert "·0·p80_now_sec⟩" in text and "·4·late_loss_minor⟩" in text and not re.search(r"\d", re.sub(r"⟨[^⟩]*⟩", "", text))


def test_ticket_drift_severity_floor_needs_a_300_second_gap() -> None:
    def severity_of(loss: int, p80_now: int) -> str:
        core = sweep(
            only("kitchen.ticket_drift", [slot("tandoor", "20:00", 5000, 30, 10000, p80_now, 600), sigma_drift(loss)], week_start=WEEK)
        )
        (f,) = core.finding_rows()
        return str(f["severity"])

    # loss 0 → L = low; gap 299 s stays low, 300 s lifts to medium. 300,000 × 4.3 = 1,290,000 → high (above the floor).
    assert (severity_of(0, 899), severity_of(0, 900), severity_of(300_000, 899)) == ("low", "medium", "high")


def remake(station: str | None, remakes: int, minor: int, orders: int | None = None) -> dict[str, Any]:
    return {"station": station, "remakes": remakes, "remake_minor": minor, "orders": orders, "overprep_minor": None if station else 0,
            "median_overprep_minor": None if station else 0}  # fmt: skip


def test_remakes_judge_a_station_against_the_weeks_orders_on_the_sigma_row() -> None:
    rows = [
        remake("fryer", 1, 100_000),  # ₹1,000 but 1 of 100 orders = 100 bp < 200
        remake("grill", 2, 100_000),  # 2 of 100 = 200 bp and ₹1,000 → fires
        remake("tandoor", 5, 99_999),  # one paisa short
        remake(None, 8, 299_999, 100),
    ]
    core = sweep(only("kitchen.remakes_overprep", rows, week_start=WEEK))
    found = [f for f in core.finding_rows() if f["type"] == "kitchen.remakes"]
    # 100,000 × 4.3 = 430,000 → medium; the impact is the grill row's own remake_minor.
    assert [(f["dedupe_key"], f["severity"], f["impact_row"]) for f in found] == [(f"kitchen.remakes:{OUTLET}:grill:2026-w41", "medium", 1)]


def test_remakes_without_completed_orders_never_fire() -> None:
    core = sweep(only("kitchen.remakes_overprep", [remake("grill", 9, 900_000), remake(None, 9, 900_000, 0)], week_start=WEEK))
    assert [f for f in core.finding_rows() if f["type"] == "kitchen.remakes"] == []


def test_overprep_fires_on_the_sigma_row_at_one_and_a_half_times_the_median_and_one_thousand_rupees() -> None:
    weeks = {"2026-10-05": (150_000, 100_000), "2026-09-28": (149_999, 100_000), "2026-09-21": (100_000, 0), "2026-09-14": (99_999, 0)}

    def serve(t: str, p: dict[str, Any]) -> list[dict[str, Any]]:
        if t != "kitchen.remakes_overprep" or p["week_start"] not in weeks:
            return []
        amount, median = weeks[p["week_start"]]
        return [{"station": None, "remakes": 0, "remake_minor": 0, "orders": 50, "overprep_minor": amount, "median_overprep_minor": median}]

    found = [f for f in sweep(serve).finding_rows() if f["type"] == "kitchen.overprep"]
    # 150,000 × 4.3 = 645,000 → medium; 100,000 × 4.3 = 430,000 → medium.
    assert sorted((f["dedupe_key"], f["severity"], f["impact_column"]) for f in found) == [
        (f"kitchen.overprep:{OUTLET}:2026-w39", "medium", "overprep_minor"),
        (f"kitchen.overprep:{OUTLET}:2026-w41", "medium", "overprep_minor"),
    ]


def times(item: str, station: str, slot_start: str | None, tickets: int, p80: int, configured: int | None) -> dict[str, Any]:
    """`slot_start` None: v2's whole-window row of the item and station (0023 K1), listed first."""
    return {"station": station, "item_id": item, "slot_start": slot_start, "tickets": tickets, "p50_sec": p80 - 60, "p80_sec": p80,
            "late_tickets": 0, "configured_prep_sec": configured}  # fmt: skip


def test_prep_time_gap_one_finding_per_dish_on_its_whole_window_row_with_a_prep_time_draft_citing_p80() -> None:
    rows = [
        # whole-window rows first (slot_start None)
        times(ITEM, "biryani", None, 179, 860, 600),  # qualifies → the finding's row (0)
        times(ITEM_J, "grill", None, 300, 1200, None),  # nothing promised
        times(ITEM_K, "grill", None, 120, 420, 600),  # faster than promised by exactly 180 s → low (row 2)
        times(ITEM_L, "grill", None, 49, 1200, 600),  # one ticket short over the window
        # per-slot rows: never read, even where one alone would qualify (a slot's p80 is not the dish's)
        times(ITEM, "biryani", "12:00", 50, 900, 600),
        times(ITEM, "biryani", "13:00", 80, 800, 600),
        times(ITEM_L, "grill", "20:00", 60, 1200, 600),
        times(ITEM_K, "grill", "21:00", 60, 779, 600),
    ]
    core = sweep(only("kitchen.ticket_times", rows, **{"from": "2026-09-27", "to": "2026-10-10"}))
    found = sorted(core.finding_rows(), key=lambda f: f["impact_row"])
    assert [(f["dedupe_key"], f["severity"], f["impact_row"], f["impact_column"]) for f in found] == [
        (f"kitchen.prep_time_gap:{OUTLET}:{ITEM}:biryani", "medium", 0, "p80_sec"),
        (f"kitchen.prep_time_gap:{OUTLET}:{ITEM_K}:grill", "low", 2, "p80_sec"),
    ]
    by_finding = {d.model_dump(mode="json")["finding_id"]: d.model_dump(mode="json") for d in core.drafts}
    assert len(by_finding) == 2
    for f in found:
        d = by_finding[f["envelope"]["finding_id"]]
        sid, row = f["impact_snapshot"], f["impact_row"]
        p80, configured = f"⟨snap:{sid}·{row}·p80_sec⟩", f"⟨snap:{sid}·{row}·configured_prep_sec⟩"
        assert (d["pack"], d["command_type"], d["outlet_ids"]) == ("kitchen", "kitchen.prep_time.set.v1", [OUTLET])
        assert d["payload"]["prep_sec"] == p80 == f["envelope"]["impact_ref"]
        assert (d["payload"]["valid_from"], d["based_on"], d["evidence"]) == ("2026-10-11", [p80, configured], [f"snap:{sid}"])
        assert d["payload"]["item_id"] == rows[row]["item_id"] and d["payload"]["station"] == rows[row]["station"]


def test_every_kitchen_finding_draft_and_trace_carries_the_kitchen_specialist() -> None:
    rows = {
        "kitchen.ticket_drift": [slot("tandoor", "20:00", 9000, 40, 9000), sigma_drift(0)],
        "kitchen.remakes_overprep": [remake("grill", 9, 900_000), remake(None, 9, 900_000, 100) | {"overprep_minor": 500_000}],
        "kitchen.ticket_times": [times(ITEM, "biryani", None, 300, 900, 600)],
    }
    core = sweep(lambda t, p: rows.get(t, []) if p.get("week_start", WEEK) == WEEK else [])
    types = sorted(f["type"] for f in core.finding_rows())
    assert types == ["kitchen.overprep", "kitchen.prep_time_gap", "kitchen.remakes", "kitchen.ticket_drift"]
    assert {f["pack"] for f in core.finding_rows()} == {"kitchen"}
    assert [d.model_dump(mode="json")["pack"] for d in core.drafts] == ["kitchen"]
    assert {t["actor"] for t in core.traces} == {"watcher:kitchen"} and len(core.traces) >= 5


def test_kitchen_detectors_are_the_pack_section_4_list() -> None:
    # Hand list: packs/kitchen.md §4.
    assert sorted(s.id for s in REGISTRY["kitchen"]) == [
        "kitchen.overprep",
        "kitchen.prep_time_gap",
        "kitchen.remakes",
        "kitchen.ticket_drift",
    ]
    assert all(s.outlet_kinds == frozenset({"restaurant", "cloud_kitchen"}) for s in REGISTRY["kitchen"])


def test_the_kitchen_skill_is_valid_cites_without_digits_and_binds_seven_tools() -> None:
    assert len(skill.INSTRUCTIONS_MD) <= 1500 and not re.search(r"\d", skill.INSTRUCTIONS_MD)
    # Hand lists: packs/kitchen.md §3 templates, §6 commands, §7 reason codes.
    assert skill.READ_TEMPLATES == (
        "kitchen.ticket_times",
        "kitchen.ticket_drift",
        "kitchen.remakes_overprep",
        "kitchen.prep_need",
        "kitchen.ticket_coverage",
    )
    assert skill.DRAFTABLES == ("kitchen.prep_time.set.v1", "kitchen.prep_list.create.v1")
    assert skill.REFUSAL_CODES == ("ticket_times_missing", "forecast_stale")
    codes = (REPO / "packages" / "contracts" / "src" / "shared" / "reason-codes.ts").read_text("utf8")
    assert all(f'"{c}"' in codes for c in skill.REFUSAL_CODES)
    client = InternalClient(CTX, base_url="http://127.0.0.1:9", service_secret="x")
    tools = skill.toolset(CTX, client, HandleTable({}), propose=True)
    branch = skill.toolset(CTX, client, HandleTable({}), propose=False)
    assert sorted(t.name for t in tools) == [
        "propose_kitchen_prep_list_create",
        "propose_kitchen_prep_time_set",
        "read_kitchen_prep_need",
        "read_kitchen_remakes_overprep",
        "read_kitchen_ticket_coverage",
        "read_kitchen_ticket_drift",
        "read_kitchen_ticket_times",
    ]
    assert len(tools) <= 20 and len(branch) == 5


def test_the_kitchen_refusals_fire_below_the_coverage_floor_and_without_a_forecast() -> None:
    cov = "kitchen.ticket_coverage"
    assert [skill.refusal(cov, r) for r in ([{"coverage_bp": 7999}], [{"coverage_bp": None}], [])] == ["ticket_times_missing"] * 3
    assert skill.refusal(cov, [{"coverage_bp": 8000}]) is None
    assert skill.refusal("kitchen.prep_need", []) == "forecast_stale"
    assert skill.refusal("kitchen.prep_need", [{"ingredient_id": ITEM, "prep_qty_milli": 1}]) is None


#: packs/kitchen.md §3 output columns, by hand.
COLUMNS = {
    "kitchen.ticket_times": {"station", "item_id", "slot_start", "tickets", "p50_sec", "p80_sec", "late_tickets", "configured_prep_sec"},
    "kitchen.ticket_drift": {
        "station",
        "slot_start",
        "tickets_now",
        "p80_now_sec",
        "p80_base_sec",
        "drift_bp",
        "load_ratio_bp",
        "late_loss_minor",
    },
    "kitchen.remakes_overprep": {"station", "remakes", "remake_minor", "orders", "overprep_minor", "median_overprep_minor"},
}


def test_kitchen_narrations_have_no_digit_and_cite_only_their_templates_columns() -> None:
    for s in REGISTRY["kitchen"]:
        # Slots become canonical refs (a column name may hold a digit, e.g. p80_sec); the prose around them may not.
        assert not re.search(r"\d", re.sub(r"\{[a-z_0-9]+\}", "", s.narration)), s.id
        assert s.impact_column in COLUMNS[s.template] and set(re.findall(r"\{([a-z_0-9]+)\}", s.narration)) <= COLUMNS[s.template], s.id
        assert "{" + s.impact_column + "}" in s.narration, f"{s.id}: the template narration cites its impact cell"
