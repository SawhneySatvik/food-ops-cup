"""T-048 offline gates: the People detectors and skill against an in-memory core (../kitchen/fake_core.py). Thresholds
come from the country pack the Frame carries; every expected value is worked by hand from packs/people.md §4–§7 (IN:
Σ extra ≥ 600 min in 4 weeks and week 4 > week 1; attended ≥ 1.5 × needed on ≥ 4 of the last 6 same-weekday slots;
labour ≥ target for 2 consecutive weeks; advance ≥ ₹2,000 = 200,000 paise outstanding > 60 days) and the ladder L
(IN medium ≥ 200,000, high ≥ 1,000,000, critical ≥ 5,000,000 paise of monthly impact) — never from the code under test.
The P2 fixture is here because worldgen's RG-P2 meets a degenerate demand norm (see test_people_e2e.py)."""

from __future__ import annotations

import asyncio
import re
import sys
from datetime import date, timedelta
from pathlib import Path
from typing import Any

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "kitchen"))

from fake_core import CTX, OUTLET, FakeCore, frame  # noqa: E402

import munim_intel.watch.detectors  # noqa: E402,F401 — registers every detector (REGISTRY is read directly below)
from conftest import REPO  # noqa: E402
from munim_intel.config import load_config  # noqa: E402
from munim_intel.detect import REGISTRY  # noqa: E402
from munim_intel.runtime.internal_client import InternalClient  # noqa: E402
from munim_intel.skills.people import skill  # noqa: E402
from munim_intel.tools.handles import HandleTable  # noqa: E402
from munim_intel.watch.pipeline import WatchRun, detectors_for  # noqa: E402

CFG = load_config(env={}, run_dir=REPO / "nonexistent")
STAFF = "01920000-0000-7000-8000-0000000046f1"
STAFF_B = "01920000-0000-7000-8000-0000000046f2"


def sweep(serve: Any, code: str = "IN") -> FakeCore:
    core = FakeCore(serve)
    asyncio.run(WatchRun(CTX, core, frame(code), CFG).run({"people": detectors_for(None)["people"]}))
    return core


def found(core: FakeCore, kind: str) -> list[dict[str, Any]]:
    return [f for f in core.finding_rows() if f["type"] == kind]


def ot(staff: str, week: str, extra: int, cost: int) -> dict[str, Any]:
    return {
        "staff_id": staff,
        "iso_week": week,
        "rostered_min": 2400,
        "attended_min": 2400 + extra,
        "extra_min": extra,
        "extra_cost_minor": cost,
    }


def test_overtime_drift_needs_600_minutes_in_four_weeks_and_a_growing_last_week() -> None:
    rows = [
        # STAFF: 100 + 150 + 150 + 200 = 600 min, and W41 (200) > W38 (100) → fires on the W41 row.
        ot(STAFF, "2026-W38", 100, 30_000), ot(STAFF, "2026-W39", 150, 45_000), ot(STAFF, "2026-W40", 150, 45_000),
        ot(STAFF, "2026-W41", 200, 60_000),
        # STAFF_B: 300 + 300 = 600 min but the last week (W41: 0 extra, a row) is not above the first (W38: 300).
        ot(STAFF_B, "2026-W38", 300, 90_000), ot(STAFF_B, "2026-W40", 300, 90_000), ot(STAFF_B, "2026-W41", 0, 0),
    ]  # fmt: skip
    core = sweep(lambda t, p: rows if t == "people.overtime_drift" and (p["from"], p["to"]) == ("2026-09-14", "2026-10-10") else [])
    (f,) = found(core, "people.overtime_drift")
    # Four-week Σ cost 180,000 → low (< 200,000). The impact is the W41 row's own extra_cost_minor.
    assert (f["dedupe_key"], f["severity"], f["impact_row"], f["impact_column"]) == (
        f"people.overtime_drift:{OUTLET}:{STAFF}:2026-w41",
        "low",
        3,
        "extra_cost_minor",
    )


def test_overtime_drift_one_minute_short_finds_nothing() -> None:
    rows = [ot(STAFF, "2026-W38", 99, 0), ot(STAFF, "2026-W39", 150, 0), ot(STAFF, "2026-W40", 150, 0), ot(STAFF, "2026-W41", 200, 0)]
    assert found(sweep(lambda t, _: rows if t == "people.overtime_drift" else []), "people.overtime_drift") == []


def test_overtime_drift_ignores_rostered_long_shifts_p7() -> None:
    # P7 trap: festival-week long shifts were rostered and worked as rostered — no extra minutes in any week.
    rows = [{**ot(STAFF, w, 0, 0), "rostered_min": 4200, "attended_min": 4200} for w in ("2026-W38", "2026-W39", "2026-W40", "2026-W41")]
    assert found(sweep(lambda t, _: rows if t == "people.overtime_drift" else []), "people.overtime_drift") == []


def lvd(day: date, slot: str, attended: int, needed: int | None, excess: int | None) -> dict[str, Any]:
    return {"business_on": day.isoformat(), "slot_start": slot, "attended_min": attended, "rostered_min": attended, "orders": 4,
            "forecast_orders": None, "needed_min": needed, "excess_cost_minor": excess}  # fmt: skip


TUESDAYS = [date(2026, 9, 1) + timedelta(weeks=k) for k in range(6)]  # the last six Tuesdays before Sat 10 Oct


def p2_rows(over: int, needed: int = 120) -> list[dict[str, Any]]:
    """Tuesday 15:00 on six Tuesdays: the last `over` staffed at 300 min against `needed` (2.5 ×), the rest at 150."""
    return [
        lvd(d, "15:00", 300, needed, 24_000) if i >= 6 - over else lvd(d, "15:00", 150, needed, 4_000) for i, d in enumerate(TUESDAYS)
    ] + [lvd(TUESDAYS[-1], "12:00", 500, 0, 66_000)]  # a zero norm: never a staffing judgement


def serve_for(rows: list[dict[str, Any]]) -> Any:
    """`rows` for the detector's one window: six weeks of complete days to Fri 9 Oct (42 days from 29 Aug), hourly."""
    window = ("2026-08-29", "2026-10-09", 60)
    return lambda t, p: rows if t == "people.labour_vs_demand" and (p["from"], p["to"], p["slot_minutes"]) == window else []


def test_p2_fixture_overstaffed_slot_on_four_of_six_tuesdays() -> None:
    core = sweep(serve_for(p2_rows(4)))
    (f,) = found(core, "people.overstaffed_slot")
    # Six-day Σ excess = 4 × 24,000 + 2 × 4,000 = 104,000; × 4.3 ÷ 6 = 74,533 → low. Latest qualifying row = 6 Oct (index 5).
    assert (f["dedupe_key"], f["severity"], f["impact_row"]) == (f"people.overstaffed_slot:{OUTLET}:tue:15:00", "low", 5)
    assert found(sweep(serve_for(p2_rows(3))), "people.overstaffed_slot") == []
    # Exactly 1.5 ×: 180 against 120 qualifies (≥); a zero or missing norm never does.
    at_bar = [lvd(d, "15:00", 180, 120, 12_000) for d in TUESDAYS]
    assert len(found(sweep(serve_for(at_bar)), "people.overstaffed_slot")) == 1
    no_norm = [lvd(d, "15:00", 900, n, None) for d, n in zip(TUESDAYS, [0, None, 0, None, 0, 0], strict=True)]
    assert found(sweep(serve_for(no_norm)), "people.overstaffed_slot") == []


def pct(week: str, labour_bp: int, target: int | None, excess: int) -> dict[str, Any]:
    return {"iso_week": week, "labour_minor": labour_bp * 100, "net_sales_minor": 1_000_000, "labour_bp": labour_bp, "target_bp": target,
            "excess_labour_minor": excess}  # fmt: skip


def test_labour_pct_high_needs_two_consecutive_weeks_at_or_over_a_policy_target() -> None:
    def run(rows: list[dict[str, Any]]) -> list[tuple[str, str]]:
        core = sweep(lambda t, p: rows if t == "people.labour_pct" and p["from"] == "2026-09-21" else [])
        return [(f["dedupe_key"], f["severity"]) for f in found(core, "people.labour_pct_high")]

    # W40 at the target and W41 above it → one finding on W41: 60,000 × 4.3 = 258,000 → medium.
    assert run([pct("2026-W39", 3000, 3500, 0), pct("2026-W40", 3500, 3500, 0), pct("2026-W41", 4100, 3500, 60_000)]) == [
        (f"people.labour_pct_high:{OUTLET}:2026-w41", "medium")
    ]
    assert run([pct("2026-W39", 4100, 3500, 6), pct("2026-W40", 3499, 3500, 0), pct("2026-W41", 4100, 3500, 6)]) == []
    # No policy target (as in every worldgen world): no excess cell to cite, so nothing fires even at 150%.
    assert run([pct("2026-W40", 15000, None, 0), pct("2026-W41", 15000, None, 0)]) == []
    # A week missing between two high weeks is not consecutive.
    assert run([pct("2026-W39", 4100, 3500, 6), pct("2026-W41", 4100, 3500, 6)]) == []


def test_advance_unrecovered_is_in_only_and_fires_from_two_thousand_rupees_after_sixty_days() -> None:
    rows = [
        {"staff_id": STAFF, "outstanding_minor": 200_000, "days_since_given": 61},
        {"staff_id": STAFF_B, "outstanding_minor": 199_999, "days_since_given": 90},
        {"staff_id": OUTLET, "outstanding_minor": 1_500_000, "days_since_given": 60},
    ]
    core = sweep(lambda t, _: rows if t == "people.advances_open" else [])
    # 200,000 → medium (≥ 200,000).
    assert [(f["dedupe_key"], f["severity"]) for f in found(core, "people.advance_unrecovered")] == [
        (f"people.advance_unrecovered:{OUTLET}:{STAFF}:2026-10", "medium")
    ]
    au = FakeCore(lambda t, _: rows if t == "people.advances_open" else [])
    asyncio.run(WatchRun(CTX, au, frame("AU"), CFG).run({"people": detectors_for(None)["people"]}))
    assert [m[0] for m in au.minted if m[0] == "people.advances_open"] == []
    assert {"detector": "people.advance_unrecovered", "reason": "no_pack_thresholds"} in [t["payload"] for t in au.traces]


def test_every_people_finding_and_trace_carries_the_people_specialist() -> None:
    rows = {
        "people.overtime_drift": [ot(STAFF, "2026-W38", 0, 0), ot(STAFF, "2026-W41", 700, 210_000)],
        "people.advances_open": [{"staff_id": STAFF, "outstanding_minor": 1_500_000, "days_since_given": 90}],
    }
    core = sweep(lambda t, _: rows.get(t, []))
    assert sorted(f["type"] for f in core.finding_rows()) == ["people.advance_unrecovered", "people.overtime_drift"]
    assert {f["pack"] for f in core.finding_rows()} == {"people"} and core.drafts == []
    assert {t["actor"] for t in core.traces} == {"watcher:people"}


def test_people_detectors_are_the_pack_section_4_list() -> None:
    # Hand list: packs/people.md §4.
    assert sorted(s.id for s in REGISTRY["people"]) == [
        "people.advance_unrecovered",
        "people.labour_pct_high",
        "people.overstaffed_slot",
        "people.overtime_drift",
    ]


def test_the_people_skill_is_valid_cites_without_digits_and_binds_eight_tools() -> None:
    assert len(skill.INSTRUCTIONS_MD) <= 1500 and not re.search(r"\d", skill.INSTRUCTIONS_MD)
    # Hand lists: packs/people.md §3 templates, §6 commands, §7 reason codes.
    assert skill.READ_TEMPLATES == (
        "people.labour_vs_demand",
        "people.overtime_drift",
        "people.labour_pct",
        "people.attendance_coverage",
        "people.advances_open",
        "people.payroll_lines",
    )
    assert skill.DRAFTABLES == ("people.roster.create.v1", "people.payroll_draft.create.v1")
    assert skill.REFUSAL_CODES == ("attendance_missing", "payroll_out_of_scope")
    codes = (REPO / "packages" / "contracts" / "src" / "shared" / "reason-codes.ts").read_text("utf8")
    assert all(f'"{c}"' in codes for c in skill.REFUSAL_CODES)
    client = InternalClient(CTX, base_url="http://127.0.0.1:9", service_secret="x")
    tools = skill.toolset(CTX, client, HandleTable({}), propose=True, payroll_scope="drafts")
    assert sorted(t.name for t in tools) == [
        "propose_people_payroll_draft_create",
        "propose_people_roster_create",
        "read_people_advances_open",
        "read_people_attendance_coverage",
        "read_people_labour_pct",
        "read_people_labour_vs_demand",
        "read_people_overtime_drift",
        "read_people_payroll_lines",
    ]
    assert len(tools) <= 20 and len(skill.toolset(CTX, client, HandleTable({}), propose=False)) == 6


def test_p6_payroll_is_refused_outside_a_drafts_pack_and_bound_inside_one() -> None:
    """Packs/people.md §10 P6: an AU café owner asks for payroll. The run-frame's `payroll_scope` decides, not the model:
    IN.json `drafts` → no refusal and the payroll proposal bound; AU.json `roster_only` (or no scope known) →
    `payroll_out_of_scope` and the proposal tool absent; the roster proposal stays in both."""
    client = InternalClient(CTX, base_url="http://127.0.0.1:9", service_secret="x")
    got = {}
    for scope in ("drafts", "roster_only", None):
        names = {t.name for t in skill.toolset(CTX, client, HandleTable({}), propose=True, payroll_scope=scope)}
        got[scope] = (skill.payroll_refusal(scope), "propose_people_payroll_draft_create" in names, "propose_people_roster_create" in names)
    print("P6:", got)
    assert got == {
        "drafts": (None, True, True),
        "roster_only": ("payroll_out_of_scope", False, True),
        None: ("payroll_out_of_scope", False, True),
    }
    assert (frame("IN").payroll_scope, frame("AU").payroll_scope) == ("drafts", "roster_only")


def test_the_attendance_refusal_fires_below_the_coverage_floor() -> None:
    cov = "people.attendance_coverage"
    assert [skill.refusal(cov, r) for r in ([{"coverage_bp": 7999}], [{"coverage_bp": None}], [])] == ["attendance_missing"] * 3
    assert skill.refusal(cov, [{"coverage_bp": 8000}]) is None


#: packs/people.md §3 output columns, by hand.
COLUMNS = {
    "people.labour_vs_demand": {
        "business_on",
        "slot_start",
        "attended_min",
        "rostered_min",
        "orders",
        "forecast_orders",
        "needed_min",
        "excess_cost_minor",
    },
    "people.overtime_drift": {"staff_id", "iso_week", "rostered_min", "attended_min", "extra_min", "extra_cost_minor"},
    "people.labour_pct": {"iso_week", "labour_minor", "net_sales_minor", "labour_bp", "target_bp", "excess_labour_minor"},
    "people.advances_open": {"staff_id", "outstanding_minor", "days_since_given"},
}


def test_people_narrations_have_no_digit_and_cite_only_their_templates_columns() -> None:
    for s in REGISTRY["people"]:
        # Slots become canonical refs (a column name may hold a digit, e.g. p80_sec); the prose around them may not.
        assert not re.search(r"\d", re.sub(r"\{[a-z_0-9]+\}", "", s.narration)), s.id
        assert s.impact_column in COLUMNS[s.template] and set(re.findall(r"\{([a-z_0-9]+)\}", s.narration)) <= COLUMNS[s.template], s.id
        assert "{" + s.impact_column + "}" in s.narration, f"{s.id}: the template narration cites its impact cell"
