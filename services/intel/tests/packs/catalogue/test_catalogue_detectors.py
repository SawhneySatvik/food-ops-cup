"""T-044 offline gates: the Menu & Pricing detectors and draft mappings against fixture rows (core's internal API is the
system boundary; test_catalogue_e2e.py runs the real one). Hand values: packs/catalogue.md §4 thresholds (IN ₹5 =
500 paise and AU A$0.10 = 10 cents of cost increase; 800 bp; 300 bp; 20 units; 30 orders; 14 days), the IN ladder L
(medium ≥ 200,000, high ≥ 1,000,000, critical ≥ 5,000,000 paise a month) and pack §6 (which cell each leaf cites).
C3 `deal_loss` is history-only (detector-map.json pack_cases C3), so its gate is a fixture."""

from __future__ import annotations

import re
from dataclasses import replace
from datetime import date
from typing import Any

from menu_market_harness import AS_OF, OUTLET, FakeCore, frame, run

from munim_intel.contracts_gen.models import InternalDraftsRequest
from munim_intel.detect import REGISTRY, OutletFrame
from munim_intel.mapping import Detection, draft_body, snap_ref
from munim_intel.watch.detectors.catalogue import below_cost, cost_drift, deal_loss, drafts, negative_margin, recipe_waste_gap

ITEM = "01920000-0000-7000-8000-0000000044e1"
RECIPE = "01920000-0000-7000-8000-0000000044e2"
DEAL = "01920000-0000-7000-8000-0000000044e3"
ING = ("01920000-0000-7000-8000-0000000044f1", "01920000-0000-7000-8000-0000000044f2")
FINDING = "01920000-0000-7000-8000-0000000044d1"
SNAP = "01920000-0000-7000-8000-00000000aaaa"
SNAP2 = "01920000-0000-7000-8000-00000000bbbb"
SPECS = [negative_margin.SPEC, cost_drift.SPEC, recipe_waste_gap.SPEC, deal_loss.SPEC, below_cost.SPEC]


def margin_row(**over: Any) -> dict[str, Any]:
    row = {
        "item_id": ITEM,
        "recipe_version_id": RECIPE,
        "units_sold": 20,
        "units_rank": 11,
        "net_sales_minor": 400_000,
        "unit_cost_minor": 25_000,
        "observed_waste_bp": 200,
        "recipe_waste_bp": 200,
        "margin_minor": 0,
        "loss_minor": 0,
        "margin_bp": 0,
        "excess_waste_minor": 0,
        "suggested_price_minor": 31_000,
        "lines_unpriced": 0,
    }
    return {**row, **over}


def drift_row(change_bp: int, then: int, now: int, drift: int = 224_041) -> dict[str, Any]:
    return {
        "item_id": ITEM,
        "price_minor": 28_000,
        "cost_then_minor": then,
        "cost_now_minor": now,
        "cost_change_bp": change_bp,
        "cost_drift_minor": drift,
    }


def count(template: str, rows: list[dict[str, Any]], spec: Any, code: str = "IN", kind: str = "restaurant") -> int:
    core = FakeCore({template: rows})
    run(core, frame(code, kind), "catalogue", [spec])
    return len(core.findings)


# -- thresholds: just below finds nothing, at the threshold finds one -----------------------------------------------


def test_each_detector_fires_at_its_pack_threshold_and_not_just_below() -> None:
    cases: list[tuple[str, str, Any, Any, str, str, int]] = [  # (what, template, row, spec, pack, kind, findings)
        (
            "margin -1 on 20 units",
            "catalogue.dish_margin",
            margin_row(margin_minor=-1, loss_minor=1),
            negative_margin.SPEC,
            "IN",
            "restaurant",
            1,
        ),
        ("margin 0", "catalogue.dish_margin", margin_row(margin_minor=0), negative_margin.SPEC, "IN", "restaurant", 0),
        (
            "margin -1 on 19 units",
            "catalogue.dish_margin",
            margin_row(margin_minor=-1, loss_minor=1, units_sold=19),
            negative_margin.SPEC,
            "IN",
            "restaurant",
            0,
        ),
        (
            "margin unknown (no recipe)",
            "catalogue.dish_margin",
            margin_row(margin_minor=None, recipe_version_id=None),
            negative_margin.SPEC,
            "IN",
            "restaurant",
            0,
        ),
        ("cost +800 bp, +₹5", "catalogue.cost_drift", [drift_row(800, 5_000, 5_500)], cost_drift.SPEC, "IN", "restaurant", 1),
        ("cost +799 bp", "catalogue.cost_drift", [drift_row(799, 5_000, 5_500)], cost_drift.SPEC, "IN", "restaurant", 0),
        ("cost +₹4.99", "catalogue.cost_drift", [drift_row(800, 5_000, 5_499)], cost_drift.SPEC, "IN", "restaurant", 0),
        ("AU cost +A$0.10", "catalogue.cost_drift", [drift_row(800, 120, 130)], cost_drift.SPEC, "AU", "restaurant", 1),
        ("AU cost +A$0.09", "catalogue.cost_drift", [drift_row(800, 120, 129)], cost_drift.SPEC, "AU", "restaurant", 0),
        (
            "RG-C6 shape: price raised with the cost",
            "catalogue.cost_drift",
            [drift_row(0, 5_450, 5_450, 0)],
            cost_drift.SPEC,
            "IN",
            "restaurant",
            0,
        ),
        ("waste recipe + 300", "catalogue.dish_margin", margin_row(observed_waste_bp=500), recipe_waste_gap.SPEC, "IN", "restaurant", 1),
        ("waste recipe + 299", "catalogue.dish_margin", margin_row(observed_waste_bp=499), recipe_waste_gap.SPEC, "IN", "restaurant", 0),
        (
            "waste gap on 19 units",
            "catalogue.dish_margin",
            margin_row(observed_waste_bp=500, units_sold=19),
            recipe_waste_gap.SPEC,
            "IN",
            "restaurant",
            0,
        ),
        (
            "waste gap, no recipe (a shop SKU)",
            "catalogue.dish_margin",
            margin_row(observed_waste_bp=900, recipe_version_id=None),
            recipe_waste_gap.SPEC,
            "IN",
            "restaurant",
            0,
        ),
        (
            "deal loss 1 on 30 orders",
            "catalogue.deal_cost",
            [{"deal_id": DEAL, "orders": 30, "discount_minor": 9, "deal_loss_minor": 1}],
            deal_loss.SPEC,
            "IN",
            "restaurant",
            1,
        ),
        (
            "deal loss 1 on 29 orders",
            "catalogue.deal_cost",
            [{"deal_id": DEAL, "orders": 29, "discount_minor": 9, "deal_loss_minor": 1}],
            deal_loss.SPEC,
            "IN",
            "restaurant",
            0,
        ),
        (
            "deal loss 0",
            "catalogue.deal_cost",
            [{"deal_id": DEAL, "orders": 30, "discount_minor": 9, "deal_loss_minor": 0}],
            deal_loss.SPEC,
            "IN",
            "restaurant",
            0,
        ),
        (
            "below cost 1, store",
            "catalogue.sku_price_check",
            [{"item_id": ITEM, "units": 3, "below_cost_minor": 1}],
            below_cost.SPEC,
            "IN",
            "store",
            1,
        ),
        (
            "below cost 0, store",
            "catalogue.sku_price_check",
            [{"item_id": ITEM, "units": 3, "below_cost_minor": 0}],
            below_cost.SPEC,
            "IN",
            "store",
            0,
        ),
        (
            "below cost 1, restaurant",
            "catalogue.sku_price_check",
            [{"item_id": ITEM, "units": 3, "below_cost_minor": 1}],
            below_cost.SPEC,
            "IN",
            "restaurant",
            0,
        ),
    ]
    got = []
    for _, template, row, spec, code, kind, _ in cases:
        got.append(count(template, row if isinstance(row, list) else [row], spec, code, kind))
    print("findings:", [(c[0], g) for c, g in zip(cases, got, strict=True)])
    assert got == [c[-1] for c in cases]


def test_a_sigma_row_with_null_ids_never_fires() -> None:
    sigma = margin_row(item_id=None, margin_minor=-500_000, loss_minor=500_000, observed_waste_bp=9_000)
    assert count("catalogue.dish_margin", [sigma], negative_margin.SPEC) == 0
    assert count("catalogue.dish_margin", [sigma], recipe_waste_gap.SPEC) == 0


# -- severity: ladder L worked by hand ------------------------------------------------------------------------------


def test_severity_is_the_ladder_on_the_pack_impact_with_the_pack_floors() -> None:
    f = frame("IN")
    t = f.detectors
    cases = [
        # negative_margin: 100,000 lost in 14 days = 214,285 a month → medium; rank 10 → at least high.
        (negative_margin.SPEC, margin_row(margin_minor=-100_000, loss_minor=100_000, units_rank=11), "medium"),
        (negative_margin.SPEC, margin_row(margin_minor=-100_000, loss_minor=100_000, units_rank=10), "high"),
        # 93,000 a fortnight = 199,285 a month → low.
        (negative_margin.SPEC, margin_row(margin_minor=-93_000, loss_minor=93_000, units_rank=11), "low"),
        # cost_drift: RG-C1's 224,041 → medium; 1,000,000 → high.
        (cost_drift.SPEC, drift_row(2_142, 5_029, 6_106, 224_041), "medium"),
        (cost_drift.SPEC, drift_row(2_142, 5_029, 6_106, 1_000_000), "high"),
        # recipe_waste_gap: RG-C2's 295,008 → medium.
        (recipe_waste_gap.SPEC, margin_row(observed_waste_bp=1_078, excess_waste_minor=295_008), "medium"),
        (deal_loss.SPEC, {"deal_id": DEAL, "orders": 30, "deal_loss_minor": 5_000_000}, "critical"),
        (below_cost.SPEC, {"item_id": ITEM, "below_cost_minor": 199_999}, "low"),
    ]
    got = [spec.severity(row, t[spec.id], f.ladder) for spec, row, _ in cases]
    assert got == [want for _, _, want in cases]


# -- windows: pack data, never constants ----------------------------------------------------------------------------


def test_windows_come_from_the_pack_thresholds() -> None:
    outlet = OutletFrame(OUTLET, "restaurant", AS_OF)
    t = frame("IN").detectors
    # 14 days ending on 10 Oct 2026 (ISO week 41); cost drift looks back the pack's lookback_days.
    (w,) = negative_margin.SPEC.windows(outlet, t["catalogue.negative_margin"])
    assert (w.params["from"], w.params["to"], w.params["channel_kind"], w.key) == ("2026-09-27", "2026-10-10", None, "2026-w41")
    (w,) = recipe_waste_gap.SPEC.windows(outlet, t["catalogue.recipe_waste_gap"])
    assert (w.params["from"], w.params["to"]) == ("2026-09-27", "2026-10-10")
    (w,) = cost_drift.SPEC.windows(outlet, t["catalogue.cost_drift"])
    assert (AS_OF - date.fromisoformat(w.params["since"])).days == t["catalogue.cost_drift"]["lookback_days"]
    # A pack without the lookback mints nothing (never a guessed window) and says so: the pipeline abstains the detector
    # with no_pack_thresholds (R-B S2-A), where a silent [] used to look like "no finding". Paired: with the key it mints.
    f = frame("IN")
    no_key = {k: v for k, v in t["catalogue.cost_drift"].items() if k != "lookback_days"}
    for pack_t, minted, abstains in (
        (no_key, 0, [{"detector": "catalogue.cost_drift", "reason": "no_pack_thresholds"}]),
        (t["catalogue.cost_drift"], 1, []),
    ):
        core = FakeCore({})
        run(core, replace(f, detectors={**f.detectors, "catalogue.cost_drift": pack_t}), "catalogue", [cost_drift.SPEC])
        assert (len(core.minted), [x["payload"] for x in core.traces if x["kind"] == "abstain"]) == (minted, abstains)


# -- dedupe and narration ----------------------------------------------------------------------------------------------


def test_dedupe_keys_follow_the_pack_suffixes_and_the_finding_alphabet() -> None:
    core = FakeCore({"catalogue.dish_margin": [margin_row(margin_minor=-1, loss_minor=1, observed_waste_bp=600)]})
    run(core, frame("IN"), "catalogue", [negative_margin.SPEC, recipe_waste_gap.SPEC])
    keys = sorted(f.dedupe_key for f in core.findings)
    assert keys == [
        f"catalogue.negative_margin:{OUTLET}:{ITEM}:2026-w41",
        f"catalogue.recipe_waste_gap:{OUTLET}:{ITEM}:2026-w41",
    ]
    assert all(re.fullmatch(r"[a-z0-9_.:-]{1,200}", k) for k in keys)


def test_every_narration_is_digit_free_and_cites_its_impact_cell() -> None:
    for spec in [*SPECS, *(s for s in REGISTRY["catalogue"] if s not in SPECS)]:
        assert not re.search(r"\d", spec.narration), spec.id
        assert "{" + spec.impact_column + "}" in spec.narration, spec.id


# -- the specialist on every finding, draft and trace ---------------------------------------------------------------


def test_every_finding_draft_and_trace_carries_the_catalogue_specialist() -> None:
    core = FakeCore(
        {
            "catalogue.dish_margin": [
                margin_row(margin_minor=-1, loss_minor=1, observed_waste_bp=600, channel_kind="counter", tax_class="restaurant_5")
            ],
            "catalogue.cost_drift": [drift_row(2_142, 5_029, 6_106)],
            "catalogue.deal_cost": [{"deal_id": DEAL, "orders": 30, "discount_minor": 9, "deal_loss_minor": 1}],
        }
    )
    run(core, frame("IN"), "catalogue", SPECS)
    print("findings:", [(f.type, f.pack) for f in core.findings], "drafts:", [(d.command_type, d.pack) for d in core.drafts])
    # Hand count: negative margin + waste gap on the one dish row, one cost drift, one deal = 4 findings; the negative
    # margin's price draft, the deal's end draft, and the cost drift's price draft from its follow-up dish_margin mint
    # (the same item's row, W3.2) = 3 drafts. The waste gap's recipe draft needs recipe_current rows (none served) → none.
    assert (len(core.findings), len(core.drafts)) == (4, 3)
    assert {f.pack for f in core.findings} == {"catalogue"} and {d.pack for d in core.drafts} == {"catalogue"}
    assert {t["actor"] for t in core.traces} == {"watcher:catalogue"}


# -- draft mappings: every numeric leaf a canonical ref to its pack §6 cell -------------------------------------------


def detection(row: dict[str, Any], snap: str = SNAP, at: int = 0) -> Detection:
    return Detection(snap, at, row, OutletFrame(OUTLET, "restaurant", AS_OF), "INR")


def request(d: Detection, p: Any) -> InternalDraftsRequest:
    return InternalDraftsRequest.model_validate(draft_body("catalogue", FINDING, d, p))


def test_the_negative_margin_price_draft_cites_suggested_price_and_starts_tomorrow() -> None:
    d = detection(margin_row(margin_minor=-1, loss_minor=1, channel_kind="counter", tax_class="restaurant_5"))
    p = negative_margin.draft(d)
    assert p is not None
    req = request(d, p).model_dump(mode="json")
    pay = req["payload"]
    assert pay["amount_minor"] == snap_ref(SNAP, 0, "suggested_price_minor")
    assert (pay["item_id"], pay["outlet_id"], pay["channel_kind"], pay["tax_class"], pay["currency"]) == (
        ITEM,
        OUTLET,
        "counter",
        "restaurant_5",
        "INR",
    )
    assert (pay["valid_from"], pay["valid_to"], pay["variant_id"]) == ("2026-10-11", None, None)
    assert req["based_on"] == [snap_ref(SNAP, 0, "suggested_price_minor"), snap_ref(SNAP, 0, "loss_minor")]
    assert re.fullmatch(r"[0-9a-f-]{36}", pay["price_id"])
    # Without the tax_class / channel_kind cells (today's dish_margin) there is no price draft — never a guessed class.
    assert negative_margin.draft(detection(margin_row(margin_minor=-1, loss_minor=1))) is None


def test_the_c1_price_draft_takes_its_amount_from_the_items_dish_margin_row() -> None:
    drift = detection(drift_row(2_142, 5_029, 6_106))
    other = "01920000-0000-7000-8000-0000000044e9"
    margin_rows = [
        margin_row(item_id=other, channel_kind="counter", tax_class="restaurant_5"),
        margin_row(channel_kind="counter", tax_class="restaurant_5"),
    ]
    p = drafts.price_for_drift(drift, SNAP2, margin_rows)
    assert p is not None
    req = request(drift, p).model_dump(mode="json")
    assert req["payload"]["amount_minor"] == snap_ref(SNAP2, 1, "suggested_price_minor")  # the drifting item's row, not row 0
    assert req["based_on"] == [snap_ref(SNAP2, 1, "suggested_price_minor"), snap_ref(SNAP, 0, "cost_drift_minor")]
    assert req["evidence"] == [f"snap:{SNAP2}", f"snap:{SNAP}"]
    assert drafts.price_for_drift(drift, SNAP2, margin_rows[:1]) is None  # the item has no margin row: no draft


def test_the_c2_recipe_draft_cites_recipe_current_for_version_yield_and_every_line() -> None:
    gap = detection(margin_row(observed_waste_bp=1_078, excess_waste_minor=295_008))
    current: list[dict[str, Any]] = [
        {
            "recipe_version_id": RECIPE,
            "next_version": 2,
            "yield_qty_milli": 1_000,
            "ingredient_id": ING[0],
            "qty_milli": 200,
            "unit": "kg",
            "waste_pct_bp": 200,
            "observed_waste_bp": 1_078,
        },
        {
            "recipe_version_id": RECIPE,
            "next_version": 2,
            "yield_qty_milli": 1_000,
            "ingredient_id": ING[1],
            "qty_milli": 10,
            "unit": "l",
            "waste_pct_bp": 0,
            "observed_waste_bp": 0,
        },
    ]
    p = drafts.recipe_for_gap(gap, SNAP2, current)
    assert p is not None
    pay = request(gap, p).model_dump(mode="json")["payload"]
    assert (pay["version"], pay["yield_qty_milli"]) == (snap_ref(SNAP2, 0, "next_version"), snap_ref(SNAP2, 0, "yield_qty_milli"))
    assert pay["lines"] == [
        {
            "ingredient_id": ING[0],
            "qty_milli": snap_ref(SNAP2, 0, "qty_milli"),
            "unit": "kg",
            "waste_pct_bp": snap_ref(SNAP2, 0, "observed_waste_bp"),
        },
        {
            "ingredient_id": ING[1],
            "qty_milli": snap_ref(SNAP2, 1, "qty_milli"),
            "unit": "l",
            "waste_pct_bp": snap_ref(SNAP2, 1, "observed_waste_bp"),
        },
    ]
    assert (pay["item_id"], pay["valid_from"]) == (ITEM, "2026-10-11")
    # Today's recipe_current has no `unit` cell: no draft rather than a unit taken from anywhere else.
    assert drafts.recipe_for_gap(gap, SNAP2, [{k: v for k, v in r.items() if k != "unit"} for r in current]) is None


def test_the_c3_deal_end_draft_ends_the_deal_tomorrow_and_rests_on_the_loss_cell() -> None:
    d = detection({"deal_id": DEAL, "orders": 30, "discount_minor": 9, "deal_loss_minor": 1})
    p = deal_loss.SPEC.mapping(d) if deal_loss.SPEC.mapping else None
    assert p is not None
    req = request(d, p).model_dump(mode="json")
    assert (req["command_type"], req["payload"], req["based_on"]) == (
        "catalogue.deal.end.v1",
        {"deal_id": DEAL, "valid_to": "2026-10-11"},
        [snap_ref(SNAP, 0, "deal_loss_minor")],
    )
