"""T-051 offline gates: the Market & Strategy detectors against fixture rows. Hand values: packs/market-strategy.md §4
(|uplift| ≥ 2,000 bp on ≥ 2 occurrences, forecast within ±500 bp of baseline; gap ≥ 1,000 bp, rank ≤ 20, ≥ 2
observations, medium at ≤ −1,500 bp; pace < 7,000 bp with ≥ 5,000 bp elapsed, high at ≥ 8,000), §10 (M1, M1b, M2, M3,
M6) and the IN ladder L (medium ≥ 200,000, high ≥ 1,000,000 paise). M2 and M3 have no plant (detector-map.json
pack_cases), so their gates are these fixtures; M4 needs a viability table that does not exist (not built)."""

from __future__ import annotations

import re
import sys
from pathlib import Path
from typing import Any

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "catalogue"))
from menu_market_harness import OUTLET, FakeCore, frame, run  # noqa: E402

from munim_intel.detect import REGISTRY  # noqa: E402
from munim_intel.watch.detectors.market import competitor_undercut, event_ahead, goal_off_track  # noqa: E402

ITEM = "01920000-0000-7000-8000-0000000051e1"
GOAL = "01920000-0000-7000-8000-0000000051f1"


def upcoming(
    label: str, uplift: int, occurrences: int, forecast: int | None, baseline: int, base_sales: int, on: str = "2026-10-16"
) -> dict[str, Any]:
    # expected_extra_sales_minor is the template's baseline sales × uplift, worked here by hand per case.
    return {
        "on_date": on,
        "kind": "festival",
        "label": label,
        "value_milli": None,
        "hist_uplift_bp": uplift,
        "occurrences": occurrences,
        "forecast_units": forecast,
        "baseline_orders": baseline,
        "baseline_sales_minor": base_sales,
        "expected_extra_sales_minor": base_sales * uplift // 10_000,
    }


# RG-M1 / RG-M1b as the answer key states them: 781,006 × 4,912 ÷ 10,000 = 383,630; 744,622 × −3,545 ÷ 10,000 → −263,968.
M1 = upcoming("harvest_festival", 4_912, 2, None, 13, 781_006)
M1B = {**upcoming("rain", -3_545, 3, None, 13, 744_622, on="2026-10-17"), "kind": "weather", "expected_extra_sales_minor": -263_968}


def events(rows: list[dict[str, Any]]) -> FakeCore:
    core = FakeCore({"market.upcoming": rows})
    run(core, frame("IN"), "market", [event_ahead.SPEC])
    return core


def test_m1_and_m1b_fire_with_the_ladder_on_the_absolute_impact() -> None:
    core = events([M1, M1B])
    print("findings:", [(f.dedupe_key, f.severity) for f in core.findings])
    assert M1["expected_extra_sales_minor"] == 383_630
    # |383,630| and |−263,968| are both ≥ 200,000 and < 1,000,000 → medium.
    assert [(f.dedupe_key, f.severity) for f in core.findings] == [
        (f"market.event_ahead:{OUTLET}:harvest_festival:2026-10-16", "medium"),
        (f"market.event_ahead:{OUTLET}:rain:2026-10-17", "medium"),
    ]
    assert [
        f.envelope.impact_ref is not None and f.envelope.impact_ref.root.endswith("·expected_extra_sales_minor⟩") for f in core.findings
    ] == [True, True]


def test_event_ahead_thresholds_and_the_forecast_band() -> None:
    cases = [  # (what, row, findings)
        ("M6 trap: +3% on two occurrences", upcoming("regional_fair", 300, 2, None, 13, 781_006), 0),
        ("uplift 1,999 bp", upcoming("x", 1_999, 2, None, 13, 781_006), 0),
        ("uplift 2,000 bp", upcoming("x", 2_000, 2, None, 13, 781_006), 1),
        ("uplift -2,000 bp", upcoming("x", -2_000, 2, None, 13, 781_006), 1),
        ("one past occurrence", upcoming("x", 4_912, 1, None, 13, 781_006), 0),
        # 20 forecast vs 20 baseline: inside ±5% → not yet reflected → fires.
        ("forecast flat", upcoming("x", 4_912, 2, 20, 20, 781_006), 1),
        # 21 vs 20 = 500 bp: on the band's edge, still unreflected; 22 vs 20 = 1,000 bp: reflected → silent.
        ("forecast +5%", upcoming("x", 4_912, 2, 21, 20, 781_006), 1),
        ("forecast +10% (reflected)", upcoming("x", 4_912, 2, 22, 20, 781_006), 0),
        ("forecast -10% (reflected rain)", upcoming("x", -3_545, 3, 18, 20, 744_622), 0),
        ("no baseline sales", {**upcoming("x", 4_912, 2, None, 13, 781_006), "expected_extra_sales_minor": None}, 0),
    ]
    got = [len(events([row]).findings) for _, row, _ in cases]
    print("findings:", [(c[0], g) for c, g in zip(cases, got, strict=True)])
    assert got == [c[-1] for c in cases]


def test_an_imported_label_is_folded_into_the_dedupe_alphabet() -> None:
    core = events([upcoming("Diwali Mela — Sector 9!", 4_912, 2, None, 13, 781_006)])
    (f,) = core.findings
    assert f.dedupe_key == f"market.event_ahead:{OUTLET}:diwali_mela_sector_9:2026-10-16"
    assert re.fullmatch(r"[a-z0-9_.:-]{1,200}", f.dedupe_key)


def gap_row(gap_bp: int, rank: int, observations: int, change_bp: int | None) -> dict[str, Any]:
    # M2: our 30,000 vs the competitor's 25,500 (15% under ours); exposure (30,000 − 25,500) × 120 units = 540,000.
    return {
        "item_id": ITEM,
        "our_price_minor": 30_000,
        "competitor_price_minor": 25_500,
        "observations": observations,
        "gap_bp": gap_bp,
        "monthly_units": 120,
        "units_rank": rank,
        "units_change_bp": change_bp,
        "gap_exposure_minor": 540_000,
    }


def test_m2_competitor_undercut_on_a_fixture_with_hand_values() -> None:
    cases = [  # (what, row, (findings, severity))
        ("M2: 1,765 bp dearer, top seller, six observations, sales down 20%", gap_row(1_765, 1, 6, -2_000), (1, "medium")),
        ("sales down 14.99%", gap_row(1_765, 1, 6, -1_499), (1, "low")),
        ("no prior month", gap_row(1_765, 1, 6, None), (1, "low")),
        ("gap 999 bp", gap_row(999, 1, 6, -2_000), (0, None)),
        ("gap 1,000 bp", gap_row(1_000, 20, 2, 0), (1, "low")),
        ("rank 21", gap_row(1_765, 21, 6, -2_000), (0, None)),
        ("one observation", gap_row(1_765, 1, 1, -2_000), (0, None)),
    ]
    got = []
    for _, row, _ in cases:
        core = FakeCore({"market.competitor_gap": [row]})
        run(core, frame("IN"), "market", [competitor_undercut.SPEC])
        got.append((len(core.findings), core.findings[0].severity if core.findings else None))
    print("cases:", [(c[0], g) for c, g in zip(cases, got, strict=True)])
    assert got == [c[-1] for c in cases]
    core = FakeCore({"market.competitor_gap": [gap_row(1_765, 1, 6, -2_000)]})
    run(core, frame("IN"), "market", [competitor_undercut.SPEC])
    (f,) = core.findings
    assert f.dedupe_key == f"market.competitor_undercut:{OUTLET}:{ITEM}:2026-10"
    assert f.envelope.impact_ref is not None and f.envelope.impact_ref.root.endswith("·gap_exposure_minor⟩")
    assert core.minted[0].model_dump(mode="json")["params"] == {
        "outlet_id": OUTLET,
        "days": 30,
        "as_of": "2026-10-10",
    }  # the run-frame date, never core's clock


def progress(target: int, actual: int, elapsed_bp: int, pace_bp: int, miss: int) -> dict[str, Any]:
    return {"target_value": target, "actual_value": actual, "elapsed_bp": elapsed_bp, "pace_bp": pace_bp, "projected_miss_value": miss}


# M3: a ₹30,000 net-sales goal for a 30-day month at day 20 (elapsed 6,667 bp) with actual pace 55%:
# actual = 0.55 × 0.6667 × 3,000,000 = 1,100,000; projected miss = 3,000,000 − 1,100,000 ÷ 0.6667 = 1,350,000.
M3 = progress(3_000_000, 1_100_000, 6_667, 5_500, 1_350_000)


def goal_run(rows: list[dict[str, Any]]) -> FakeCore:
    """The registered detector: `market.goals` lists the outlet's one goal (and a row without an id), then goal_progress."""
    core = FakeCore({"market.goals": [{"goal_id": GOAL, "outlet_id": OUTLET}, {"goal_id": None}], "market.goal_progress": rows})
    run(core, frame("IN"), "market", [goal_off_track.SPEC])
    return core


def test_m3_goal_off_track_on_a_fixture_with_hand_values() -> None:
    cases = [  # (what, row, (findings, severity))
        ("M3: pace 55% at day 20", M3, (1, "medium")),
        ("pace 6,999 at elapsed 8,000", progress(3_000_000, 1_679_760, 8_000, 6_999, 900_300), (1, "high")),
        ("pace 7,000", progress(3_000_000, 1_400_000, 6_667, 7_000, 900_000), (0, None)),
        ("elapsed 4,999", progress(3_000_000, 500_000, 4_999, 3_334, 2_000_000), (0, None)),
    ]
    got = []
    for _, row, _ in cases:
        core = goal_run([row])
        got.append((len(core.findings), core.findings[0].severity if core.findings else None))
    assert got == [c[-1] for c in cases]
    core = goal_run([M3])
    (f,) = core.findings
    assert f.dedupe_key == f"market.goal_off_track:{GOAL}:2026-w41"
    assert f.envelope.impact_ref is not None and f.envelope.impact_ref.root.endswith("·projected_miss_value⟩")
    assert [(m.template_id, m.model_dump(mode="json")["params"]) for m in core.minted] == [
        ("market.goals", {"outlet_id": OUTLET}),
        ("market.goal_progress", {"goal_id": GOAL, "as_of": "2026-10-10"}),
    ]


def test_goal_off_track_is_registered_and_enumerates_goals_through_market_goals() -> None:
    """0022 lists an outlet's goals (`market.goals`), so the detector is registered; its own windows stay empty."""
    registered = {s.id for specs in REGISTRY.values() for s in specs}
    assert {"market.goal_off_track", "market.event_ahead", "market.competitor_undercut"} <= registered
    assert goal_off_track.SPEC.windows(frame("IN").outlets[0], {}) == []
    assert goal_off_track.SPEC.driver is not None and goal_off_track.SPEC.driver.template == "market.goals"


def test_every_market_finding_and_trace_carries_the_market_specialist_and_narration_has_no_digit() -> None:
    core = FakeCore({"market.upcoming": [M1, M1B], "market.competitor_gap": [gap_row(1_765, 1, 6, -2_000)]})
    run(core, frame("IN"), "market", [event_ahead.SPEC, competitor_undercut.SPEC])
    # Hand count: two upcoming events + one undercut item = 3 findings, no drafts (pack §6 maps none to them).
    assert (len(core.findings), len(core.drafts)) == (3, 0)
    assert {f.pack for f in core.findings} == {"market"} and {t["actor"] for t in core.traces} == {"watcher:market"}
    for spec in (event_ahead.SPEC, competitor_undercut.SPEC, goal_off_track.SPEC):
        assert not re.search(r"\d", spec.narration), spec.id
        assert "{" + spec.impact_column + "}" in spec.narration, spec.id
        # A slot naming a nullable forecast cell would cite a null whenever no forecast covers the day.
        assert "{forecast_units}" not in spec.narration
