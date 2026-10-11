"""T-047 offline gates: the finance detectors, their DraftMappings and the finance skill, against T-043's in-memory core
(tests/watch/test_watch.py `FakeCore`; the internal API is the system boundary). The end-to-end gates on the seeded
worlds are test_finance_e2e.py.

Expected values are independent of the code under test: thresholds from the country packs (packages/contracts/packs,
"INFERENCE: transcribed from packs/finance.md §4"); the ladder L from the packs header; detector ids, templates, finding
types and impact columns typed from packs/finance.md §4 and §5; draft fields from §6; refusal codes from §7; the
template and draftable lists from the ontology (generated from the migrations and contracts).
"""

from __future__ import annotations

import json
import re
import sys
from datetime import date
from pathlib import Path
from typing import Any

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[2] / "watch"))
from test_watch import CHANNEL, CTX, OUTLET, FakeCore, frame, run  # noqa: E402

from conftest import REPO
from munim_intel.contracts_gen.models import InternalDraftsRequest, ReasonCode
from munim_intel.detect import REGISTRY, Ladder, OutletFrame
from munim_intel.mapping import Detection, draft_body, snap_ref
from munim_intel.runtime.internal_client import InternalClient
from munim_intel.skills.finance import skill
from munim_intel.tools.handles import HandleTable
from munim_intel.watch.detectors.finance import gst_mismatch, missing_payout, short_payout, tender_gap
from munim_intel.watch.detectors.finance.periods import iso_week, month_end

SETTLEMENT = "01920000-0000-7000-8000-0000000047a1"
LINE = "01920000-0000-7000-8000-0000000047a2"
ORDER = "01920000-0000-7000-8000-0000000047a3"
MEMBER = "01920000-0000-7000-8000-0000000047a4"
SNAP = "01920000-0000-7000-8000-0000000047a5"
OUT = OutletFrame(OUTLET, "restaurant", date(2026, 10, 10))


def pack(code: str) -> dict[str, Any]:
    doc: dict[str, Any] = json.loads((REPO / "packages" / "contracts" / "packs" / f"{code}.json").read_text("utf8"))
    return doc


def th(code: str, detector: str) -> dict[str, int]:
    return dict(pack(code)["detectors"][detector]["thresholds"])


def ladder(code: str) -> Ladder:
    lad = pack(code)["severity_ladder"]
    return Ladder(lad["critical_minor_gte"], lad["high_minor_gte"], lad["medium_minor_gte"])


# Rows shaped as the version-2 templates return them (tests/packs/finance/requested_templates_v2.sql).
def short_sigma(short: int, *, settlement: str | None = SETTLEMENT, channel: str | None = CHANNEL) -> dict[str, Any]:
    return {"settlement_id": settlement, "channel_id": channel, "settlement_line_id": None, "matched_order_id": None,
            "order_total_minor": 0, "commission_minor": 0, "net_minor": 0, "expected_commission_minor": 0, "refund_minor": 0,
            "expected_net_minor": 0, "short_minor": short}  # fmt: skip


def missing_sigma(days: int | None, total: int = 29_400, *, channel: str | None = CHANNEL) -> dict[str, Any]:
    return {"channel_id": channel, "order_id": None, "order_total_minor": total, "expected_net_minor": 21_532, "days_unsettled": days}


def week_sigma(days: int, gap: int, *, member: str | None = None, voids: int = 0, median: int = 0) -> dict[str, Any]:
    return {"business_on": None, "week_start": "2026-09-07", "tendered_minor": gap, "credited_minor": 0, "gap_minor": gap,
            "voids": voids, "void_minor": 0, "outlet_median_voids": median, "shift_member_id": member, "gap_days": days}  # fmt: skip


# -- the registry: pack §4 / §5, by hand ---------------------------------------------------------------------------

# (id, template, finding type, impact column). missing_payout's impact is `order_total_minor` where §5 names
# `expected_net_minor`: the answer keys (RG-F4, RG-F7) and §4's severity measure order totals (T-047 report).
PACK_4_5 = [
    ("finance.unapproved_ad_fee", "finance.unapproved_deductions", "reconciliation_break.unapproved_ad_fee", "unapproved_minor"),
    ("finance.short_payout", "finance.settlement_vs_orders", "reconciliation_break.short_payout", "short_minor"),
    ("finance.missing_payout", "finance.missing_payouts", "reconciliation_break.missing_payout", "order_total_minor"),
    ("finance.tender_gap", "finance.tender_vs_bank", "cash_control.tender_gap", "gap_minor"),
    ("finance.gst_mismatch", "finance.gst_check", "tax.gst_mismatch", "diff_minor"),
]


def test_all_five_pack_detectors_are_registered_under_finance_with_their_template_type_and_impact() -> None:
    got = [(s.id, s.template, s.finding_type, s.impact_column) for s in REGISTRY["finance"]]
    print("finance detectors:", got)
    assert sorted(got) == sorted(PACK_4_5)
    assert all(s.pack == "finance" for s in REGISTRY["finance"])
    assert all(not re.search(r"\d", s.narration) for s in REGISTRY["finance"]), "narration templates carry no digit"


def test_every_threshold_a_finance_detector_reads_is_in_both_packs() -> None:
    """A detector without pack thresholds does not run (pipeline: `no_pack_thresholds`); each must find its keys."""
    read = {
        "finance.short_payout": {"short_minor_gte"},
        "finance.missing_payout": {"days_unsettled_gt"},
        "finance.tender_gap": {"gap_days_gte", "critical_voids_vs_median_bp_gte"},
        "finance.gst_mismatch": {"abs_diff_minor_gte"},
    }
    missing = [(c, d, k) for c in ("IN", "AU") for d, keys in read.items() for k in keys if k not in th(c, d)]
    assert missing == []


# -- thresholds: each refusal paired with an accept, at the pack's own edge -----------------------------------------


@pytest.mark.parametrize("code", ["IN", "AU"])
def test_short_payout_fires_at_the_pack_threshold_on_a_settlement_sigma_row_only(code: str) -> None:
    t = th(code, "finance.short_payout")
    edge = t["short_minor_gte"]  # IN ₹200 = 20,000 paise; AU A$5 = 500 cents
    assert edge == {"IN": 20_000, "AU": 500}[code]
    line = {**short_sigma(edge), "settlement_line_id": LINE}
    version1 = short_sigma(edge, settlement=None, channel=None)  # v1's Σ row: no ids
    got = [short_payout.fires(r, t) for r in (short_sigma(edge), short_sigma(edge - 1), line, version1)]
    assert got == [True, False, False, False]


@pytest.mark.parametrize("code", ["IN", "AU"])
def test_missing_payout_fires_when_the_oldest_order_is_older_than_ten_days(code: str) -> None:
    t = th(code, "finance.missing_payout")
    assert t["days_unsettled_gt"] == 10
    order_row = {**missing_sigma(11), "order_id": ORDER}
    got = [missing_payout.fires(r, t) for r in (missing_sigma(11), missing_sigma(10), order_row, missing_sigma(None, channel=None))]
    assert got == [True, False, False, False]


@pytest.mark.parametrize("code", ["IN", "AU"])
def test_tender_gap_fires_on_three_gap_days_of_a_week_and_not_on_two_or_on_a_day_row(code: str) -> None:
    t = th(code, "finance.tender_gap")
    assert (t["gap_days_gte"], t["window_days"]) == (3, 7)
    day = {**week_sigma(3, 90_000), "business_on": "2026-09-07", "week_start": None, "gap_days": None}
    got = [tender_gap.fires(r, t) for r in (week_sigma(3, 90_000), week_sigma(2, 90_000), day)]
    assert got == [True, False, False]


@pytest.mark.parametrize("code", ["IN", "AU"])
def test_gst_mismatch_fires_on_either_sign_from_the_pack_threshold(code: str) -> None:
    t = th(code, "finance.gst_mismatch")
    edge = t["abs_diff_minor_gte"]  # IN ₹10 = 1,000 paise; AU A$1 = 100 cents
    assert edge == {"IN": 1_000, "AU": 100}[code]

    def row(d: int) -> dict[str, Any]:
        return {"outlet_id": OUTLET, "order_tax_minor": 0, "posted_tax_minor": d, "diff_minor": d}

    got = [gst_mismatch.fires(row(d), t) for d in (edge, -edge, edge - 1, -(edge - 1), 0)]
    assert got == [True, True, False, False, False]


# -- severity: ladder L (packs header: IN ₹50,000 / ₹10,000 / ₹2,000) and the pack's floors -------------------------


def test_severities_follow_ladder_l_and_the_pack_floors() -> None:
    lad, ts, tg = ladder("IN"), th("IN", "finance.tender_gap"), th("IN", "finance.gst_mismatch")
    got = {
        "short 60,000 (RG-F3)": short_payout.severity(short_sigma(60_000), {}, lad),
        "short 200,000": short_payout.severity(short_sigma(200_000), {}, lad),
        "missing 898,800 (RG-F4+F7)": missing_payout.severity(missing_sigma(20, 898_800), {}, lad),
        "missing 176,400 (RG-F4)": missing_payout.severity(missing_sigma(12, 176_400), {}, lad),
        "tender 246,000, no shift member": tender_gap.severity(week_sigma(3, 246_000, voids=9), ts, lad),
        # 2× the outlet's median per gap day: 3 days × median 1 × 2 = 6 voids is the edge
        "tender, one member, voids 6 of median 1 × 3 days": tender_gap.severity(
            week_sigma(3, 246_000, member=MEMBER, voids=6, median=1), ts, lad
        ),
        "tender, one member, voids 5 of median 1 × 3 days": tender_gap.severity(
            week_sigma(3, 246_000, member=MEMBER, voids=5, median=1), ts, lad
        ),
        "gst 1,000": gst_mismatch.severity({"diff_minor": 1_000}, tg, lad),
        "gst -6,000,000": gst_mismatch.severity({"diff_minor": -6_000_000}, tg, lad),
    }
    print(got)
    assert got == {
        "short 60,000 (RG-F3)": "low",
        "short 200,000": "medium",
        "missing 898,800 (RG-F4+F7)": "medium",
        "missing 176,400 (RG-F4)": "low",
        "tender 246,000, no shift member": "medium",
        "tender, one member, voids 6 of median 1 × 3 days": "critical",
        "tender, one member, voids 5 of median 1 × 3 days": "medium",
        "gst 1,000": "high",
        "gst -6,000,000": "critical",
    }


# -- windows and dedupe -------------------------------------------------------------------------------------------


def test_windows_and_dedupe_keys_by_hand() -> None:
    short = [w.params for w in short_payout.windows(OUT, {})]
    assert short == [
        {"channel_id": None, "from": "2026-10-01", "to": "2026-10-31", "outlet_id": OUTLET},
        {"channel_id": None, "from": "2026-09-01", "to": "2026-09-30", "outlet_id": OUTLET},
        {"channel_id": None, "from": "2026-08-01", "to": "2026-08-31", "outlet_id": OUTLET},
    ]
    assert (month_end(date(2028, 2, 1)), month_end(date(2026, 12, 1))) == (date(2028, 2, 29), date(2026, 12, 31))
    (mw,) = missing_payout.windows(OUT, {})
    assert (mw.params, mw.key) == ({"channel_id": None, "as_of": "2026-10-10", "outlet_id": OUTLET}, "2026-w41")
    # 10 Oct 2026 is a Saturday: its ISO week starts Monday 5 Oct; five weeks before that is Monday 31 Aug.
    tw = tender_gap.windows(OUT, {})
    assert [w.params for w in tw] == [{"outlet_id": OUTLET, "method": m, "from": "2026-08-31", "to": "2026-10-10"} for m in ("upi", "card")]
    assert [w.params for w in gst_mismatch.windows(OUT, {})] == [{"period_month": "2026-10-01"}, {"period_month": "2026-09-01"}]
    assert iso_week(date(2026, 9, 7)) == "2026-w37"
    keys = [
        short_payout.dedupe(short_sigma(1), short_payout.windows(OUT, {})[0]),
        missing_payout.dedupe(missing_sigma(11), mw),
        tender_gap.dedupe(week_sigma(3, 1), tw[0]),
        gst_mismatch.dedupe({"outlet_id": OUTLET}, gst_mismatch.windows(OUT, {})[1]),
    ]
    assert keys == [f"{OUTLET}:{SETTLEMENT}", f"{OUTLET}:{CHANNEL}:2026-w41", f"{OUTLET}:upi:2026-w37", f"{OUTLET}:2026-09"]


# -- drafts: pack §6 dispute fields, refs to the measuring cell -----------------------------------------------------


@pytest.mark.parametrize(
    ("module", "row", "basis", "column"),
    [
        (short_payout, short_sigma(60_000), "short_payout", "short_minor"),
        (missing_payout, missing_sigma(12, 176_400), "missing_payout", "expected_net_minor"),
    ],
)
def test_a_dispute_draft_claims_the_sigma_cell_by_ref_and_validates(module: Any, row: dict[str, Any], basis: str, column: str) -> None:
    d = Detection(SNAP, 0, row, OUT, "INR")
    p = module.dispute(d)
    finding = "01920000-0000-7000-8000-0000000047b1"
    body = InternalDraftsRequest.model_validate(draft_body("finance", finding, d, p)).model_dump(mode="json")
    pl = body["payload"]
    print(basis, pl)
    assert (body["command_type"], pl["basis"], pl["channel_id"], pl["lines"], pl["break_ids"], pl["currency"]) == (
        "finance.dispute.draft.v1", basis, CHANNEL, [], [], "INR",
    )  # fmt: skip
    assert pl["total_claimed_minor"] == snap_ref(SNAP, 0, column) == body["based_on"][0]
    assert body["evidence"] == [f"snap:{SNAP}"] and re.fullmatch(r"[0-9a-f-]{36}", pl["dispute_id"])


def test_tender_gap_and_gst_mismatch_map_to_no_draft() -> None:
    """Pack §6 lists no command for a tender gap or a tax mismatch."""
    assert (tender_gap.SPEC.mapping, gst_mismatch.SPEC.mapping) == (None, None)


def test_a_pipeline_run_files_findings_and_drafts_as_finance_only() -> None:
    """Through T-043's pipeline: one Σ row each for short and missing payouts → 2 findings, 2 drafts, all `finance`;
    the version-1 Σ rows (no ids) beside them → nothing."""
    rows = {
        "finance.settlement_vs_orders": [short_sigma(60_000), short_sigma(70_000, settlement=None, channel=None)],
        "finance.missing_payouts": [missing_sigma(20, 898_800), missing_sigma(None, 5_000, channel=None)],
    }
    core = FakeCore(rows)
    report, _ = run(core, frame("IN"), {"finance": [short_payout.SPEC, missing_payout.SPEC]})
    print(report.as_json())
    # short_payout mints three months, each served the same rows by FakeCore: three posts of one dedupe key.
    assert {f.dedupe_key for f in core.findings} == {
        f"finance.short_payout:{OUTLET}:{SETTLEMENT}",
        f"finance.missing_payout:{OUTLET}:{CHANNEL}:2026-w41",
    }
    assert {f.pack for f in core.findings} == {"finance"} and {d.pack for d in core.drafts} == {"finance"}
    assert {d.model_dump(mode="json")["payload"]["basis"] for d in core.drafts} == {"short_payout", "missing_payout"}
    assert {t["actor"] for t in core.traces} == {"watcher:finance"}


# -- the skill ----------------------------------------------------------------------------------------------------


def ontology() -> dict[str, Any]:
    doc: dict[str, Any] = json.loads((REPO / "packages" / "contracts" / "generated" / "ontology.json").read_text("utf8"))
    return doc


def test_skill_binds_the_registry_templates_and_draftables_within_twenty_tools() -> None:
    ont = ontology()
    entry = next(s for s in ont["specialists"] if s["id"] == "finance")
    exposed = {f["id"] for f in ont["functions"] if f["agent_exposed"]}
    assert set(skill.READ_TEMPLATES) == set(entry["templates"]) and set(skill.READ_TEMPLATES) <= exposed
    assert set(skill.DRAFTABLES) == set(entry["draftables"])
    client = InternalClient(CTX, base_url="http://127.0.0.1:9", service_secret="x")
    read = skill.toolset(CTX, client, HandleTable({}), propose=False)
    full = skill.toolset(CTX, client, HandleTable({}), propose=True)
    print("read tools:", [t.name for t in read], "with propose:", len(full))
    assert (len(read), len(full)) == (9, 12) and len(full) <= 20  # pack §3 seven + margin_bridge + gst_summary (0022)


def test_skill_instructions_carry_no_digit_and_no_number_word_and_fit_the_budget() -> None:
    words = json.loads((REPO / "packages" / "contracts" / "src" / "shared" / "grammar" / "number-words.json").read_text("utf8"))
    text = skill.INSTRUCTIONS_MD.lower()
    found = [w for w in words["english_cardinals"] if re.search(rf"\b{re.escape(w)}\b", text)]
    assert not re.search(r"\d", skill.INSTRUCTIONS_MD) and found == []
    assert len(skill.INSTRUCTIONS_MD) <= 6_000, "≤ 1.5k tokens at about four characters a token (ADR-014 §6.5)"
    assert all(t in skill.INSTRUCTIONS_MD for t in skill.READ_TEMPLATES) and all(c in skill.INSTRUCTIONS_MD for c in skill.REFUSAL_CODES)


def test_skill_refusal_codes_are_the_pack_7_codes_and_exist_in_the_contracts() -> None:
    assert set(skill.REFUSAL_CODES) == {"settlements_missing", "consent_record_missing", "bank_lines_missing"}
    for code in skill.REFUSAL_CODES:
        ReasonCode.model_validate(code)


def test_each_pack_7_refusal_fires_on_its_condition_and_not_on_the_accept_case() -> None:
    terms = {"channel_id": CHANNEL, "ad_fee_minor": 30_000, "unapproved_minor": 0, "ads_opted_in": True}
    no_terms = {**terms, "ad_allowed_minor": None, "unapproved_minor": None, "ads_opted_in": None}
    credited = {"business_on": "2026-09-07", "tendered_minor": 1, "credited_minor": 1, "gap_minor": 0}
    uncredited = {**credited, "credited_minor": 0, "gap_minor": 1}

    def close(done: bool) -> list[dict[str, object]]:
        return [{"item_code": "pos_days_closed", "done": True}, {"item_code": "settlements_imported", "done": done}]

    got = [
        skill.refusal("finance.unapproved_deductions", [no_terms]),
        skill.refusal("finance.unapproved_deductions", [terms]),
        skill.refusal("finance.tender_vs_bank", [uncredited, uncredited]),
        skill.refusal("finance.tender_vs_bank", [uncredited, credited]),
        skill.refusal("finance.close_status", close(False)),
        skill.refusal("finance.close_status", close(True)),
        skill.refusal("finance.pnl", []),
    ]
    assert got == ["consent_record_missing", None, "bank_lines_missing", None, "settlements_missing", None, None]
