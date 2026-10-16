"""W3.2 pipeline hooks, offline against test_watch's in-memory core. Each gate pairs the hook firing with its accept or
refuse case; expected values are hand values (the fixture's own rows and ids), never read back from the pipeline.

  follow-up mints   a mapping's extra snapshot is minted after the finding, by the detection's params, and handed in
  mapping abstain   a typed refusal is traced as a contracts ReasonCode, never prose; a code outside the list is not
  invalid finding   a finding the contract refuses is traced as `invalid_finding` and the run goes on
  containment       a detector or mapping that raises is traced `detector_error` by type and the sweep goes on (S2-A)
  thresholds        a pack missing a declared key abstains the detector; an undeclared read is an error (S2-A)
  tenant-level      a tenant-wide template is minted once per run and its drafts are tenant-wide (S2-C)
"""

from __future__ import annotations

import asyncio
from collections.abc import AsyncGenerator
from dataclasses import replace
from datetime import date
from typing import Any

from google.adk.models import BaseLlm
from google.adk.models.llm_request import LlmRequest
from google.adk.models.llm_response import LlmResponse
from test_watch import CFG, CTX, ITEM, OUTLET, FakeCore, ad_row, frame, run

from munim_intel.detect import OutletFrame
from munim_intel.llm.recorded import RecordedLlm
from munim_intel.mapping import Abstain, Detection, FollowUp, Proposal
from munim_intel.runtime.internal_client import CoreError
from munim_intel.watch.detectors.catalogue import above_mrp
from munim_intel.watch.detectors.finance import unapproved_ad_fee
from munim_intel.watch.frame import Frame
from munim_intel.watch.pipeline import WatchRun

SPEC = unapproved_ad_fee.SPEC
LINE = {"item_id": ITEM, "audience": 40, "consented": 12}


def follow_rows(consented: int) -> dict[str, list[dict[str, Any]]]:
    return {"finance.unapproved_deductions": [ad_row(55_000)], "test.follow": [{**LINE, "consented": consented}]}


def audience(d: Detection) -> Proposal | Abstain | None:
    """A stand-in mapping (no pack's): refuses with `no_marketing_consent` when the follow-up counts nobody consented,
    else proposes the dispute citing the follow-up's cell."""
    m = d.follow.get("audience")
    if m is None:
        return None
    if m.rows[0]["consented"] == 0:
        return Abstain("no_marketing_consent")
    base = unapproved_ad_fee.dispute(d)
    assert base is not None
    return replace(base, based_on=[*base.based_on, m.ref(0, "consented")])


FOLLOW = FollowUp("audience", "test.follow", lambda d: {"segment_snapshot_id": d.snapshot_id, "finding": d.finding_id})


def test_a_follow_up_is_minted_after_the_finding_with_the_detections_ids_and_reaches_the_mapping() -> None:
    core = FakeCore(follow_rows(12))
    run(core, frame("IN"), {"finance": [replace(SPEC, mapping=audience, follow_ups=(FOLLOW,))]})
    (finding,) = core.findings
    mints = [(m.template_id, m.model_dump(mode="json")["params"]) for m in core.minted]
    sid = finding.envelope.impact_ref.root.split("·")[0].removeprefix("⟨snap:") if finding.envelope.impact_ref else ""
    print("mints:", mints, "drafts:", [d.model_dump(mode="json")["based_on"] for d in core.drafts])
    # Hand list: one follow-up, right after the snapshot that fired (the fixture serves October only), keyed by that
    # snapshot and the finding id core returned (FakeCore echoes the envelope id).
    at = [i for i, (m, _) in enumerate(mints) if m == "test.follow"]
    assert len(at) == 1 and mints[at[0]] == ("test.follow", {"segment_snapshot_id": sid, "finding": finding.envelope.finding_id.root})
    assert mints[at[0] - 1][0] == "finance.unapproved_deductions" and sid == f"01920000-0000-7000-8000-{at[0]:012x}"
    (draft,) = core.drafts
    follow_sid = f"01920000-0000-7000-8000-{at[0] + 1:012x}"
    assert draft.model_dump(mode="json")["based_on"][-1] == f"⟨snap:{follow_sid}·0·consented⟩"


def test_no_params_means_no_follow_up_mint_and_the_mapping_sees_it_absent() -> None:
    core = FakeCore(follow_rows(12))
    skip = FollowUp("audience", "test.follow", lambda _d: None)
    run(core, frame("IN"), {"finance": [replace(SPEC, mapping=audience, follow_ups=(skip,))]})
    assert ([m.template_id for m in core.minted if m.template_id == "test.follow"], len(core.findings), core.drafts) == ([], 1, [])


def test_a_failed_follow_up_mint_drafts_nothing_and_is_traced() -> None:
    class Refusing(FakeCore):
        async def mint_snapshot(self, req: Any) -> Any:
            if req.template_id == "test.follow":
                raise CoreError(404, "not_found", None)
            return await super().mint_snapshot(req)

    core = Refusing(follow_rows(12))
    report, _ = run(core, frame("IN"), {"finance": [replace(SPEC, mapping=audience, follow_ups=(FOLLOW,))]})
    errors = [t["payload"] for t in core.traces if t["kind"] == "error"]
    print("errors:", errors)
    assert (len(core.findings), core.drafts, report.errors) == (1, [], 1)
    assert errors == [{"where": "follow_up", "detector": SPEC.id, "error": "core_404_not_found"}]


def test_a_mapping_abstention_is_traced_as_its_reason_code_and_the_accept_case_drafts() -> None:
    refused, accepted = FakeCore(follow_rows(0)), FakeCore(follow_rows(12))
    for core in (refused, accepted):
        run(core, frame("IN"), {"finance": [replace(SPEC, mapping=audience, follow_ups=(FOLLOW,))]})
    abstains = [t["payload"] for t in refused.traces if t["kind"] == "abstain"]
    print("refused:", abstains, "accepted drafts:", len(accepted.drafts))
    assert (len(refused.drafts), abstains) == (0, [{"detector": SPEC.id, "reason": "no_marketing_consent"}])
    assert (len(accepted.drafts), [t for t in accepted.traces if t["kind"] == "abstain"]) == (1, [])


def test_a_reason_code_outside_the_contracts_list_never_reaches_a_trace() -> None:
    core = FakeCore(follow_rows(0))
    prose = "Nobody agreed to marketing, 12 customers"
    run(core, frame("IN"), {"finance": [replace(SPEC, mapping=lambda _d: Abstain(prose))]})
    abstains = [t["payload"] for t in core.traces if t["kind"] == "abstain"]
    assert abstains == [{"detector": SPEC.id, "reason": "invalid_reason_code"}]
    assert prose not in str(core.traces)


def test_a_finding_the_contract_refuses_is_traced_and_the_run_goes_on() -> None:
    """The first detector's dedupe key breaks the contract's pattern (upper case, a space): that finding is lost and
    traced as `invalid_finding` (no pydantic text); the second detector's finding is still posted."""
    broken = replace(SPEC, id="finance.broken", dedupe=lambda _r, _w: "NOT A KEY")
    f = frame("IN")
    f = replace(f, detectors={**f.detectors, "finance.broken": f.detectors[SPEC.id]})
    core = FakeCore({"finance.unapproved_deductions": [ad_row(55_000)]})
    report, _ = run(core, f, {"finance": [broken, SPEC]})
    errors = [t["payload"] for t in core.traces if t["kind"] == "error"]
    print("errors:", errors, "findings:", [f.dedupe_key for f in core.findings])
    assert errors == [{"where": "finding", "detector": "finance.broken", "error": "invalid_finding"}]
    assert ([f.type for f in core.findings], report.errors) == (["reconciliation_break.unapproved_ad_fee"], 1)
    assert "NOT A KEY" not in str(core.traces) and OUTLET not in str(errors)


# -- R-B S2-A: one detector's defect never ends the sweep ---------------------------------------------------------------

MRP = {"catalogue.sku_price_check": [{"item_id": ITEM, "price_minor": 3000, "mrp_minor": 2800, "above_mrp_minor": 28_000}]}


def errors_of(core: FakeCore) -> list[dict[str, Any]]:
    return [t["payload"] for t in core.traces if t["kind"] == "error"]


def boom(*_args: Any) -> Any:
    raise ZeroDivisionError("a message with ₹1,234 in it, never traced")


def test_a_detector_that_raises_is_traced_by_type_and_the_other_packs_still_run() -> None:
    """Hand list: finance's detector raises in `fires` (every window), catalogue's above-MRP still files its finding. The
    trace names the type only — never the message. Paired: the same sweep without the defect files both findings."""
    rows = {**follow_rows(12), **MRP}
    broken, clean = FakeCore(rows), FakeCore(rows)
    f = frame("IN", "store")
    for core, finance in ((broken, replace(SPEC, fires=boom)), (clean, SPEC)):
        run(core, f, {"finance": [finance], "catalogue": [above_mrp.SPEC]})
    print("errors:", errors_of(broken), "findings:", [x.type for x in broken.findings], [x.type for x in clean.findings])
    assert [x.type for x in broken.findings] == ["catalogue.above_mrp"]
    assert [x.type for x in clean.findings] == ["reconciliation_break.unapproved_ad_fee", "catalogue.above_mrp"]
    assert errors_of(broken) == [{"where": "hits", "detector": SPEC.id, "error": "detector_error", "type": "ZeroDivisionError"}]
    assert "₹" not in str(broken.traces) and errors_of(clean) == []


def test_a_mapping_that_raises_costs_its_draft_only() -> None:
    core = FakeCore(follow_rows(12))
    report, _ = run(core, frame("IN"), {"finance": [replace(SPEC, mapping=boom)]})
    assert (len(core.findings), core.drafts, report.errors) == (1, [], 1)
    assert errors_of(core) == [{"where": "mapping", "detector": SPEC.id, "error": "detector_error", "type": "ZeroDivisionError"}]


def test_a_pack_missing_a_declared_threshold_abstains_the_detector_and_an_undeclared_read_is_an_error() -> None:
    """The detector declares `unapproved_minor_gte`: a pack without it abstains with no_pack_thresholds before any mint.
    A detector reading a key it did not declare is handed only its declared keys, so the read raises (traced KeyError),
    never a silent default. Paired: the full pack runs and files the finding."""
    f = frame("IN")
    missing = replace(f, detectors={**f.detectors, SPEC.id: {"other_key": 1}})
    undeclared = replace(SPEC, thresholds=())
    a, b, ok = FakeCore(follow_rows(12)), FakeCore(follow_rows(12)), FakeCore(follow_rows(12))
    run(a, missing, {"finance": [SPEC]})
    run(b, f, {"finance": [undeclared]})
    run(ok, f, {"finance": [SPEC]})
    print("a:", a.traces, "b:", errors_of(b))
    assert (a.minted, [t["payload"] for t in a.traces if t["kind"] == "abstain"]) == (
        [],
        [{"detector": SPEC.id, "reason": "no_pack_thresholds"}],
    )
    assert (b.findings, errors_of(b)) == ([], [{"where": "hits", "detector": SPEC.id, "error": "detector_error", "type": "KeyError"}])
    assert len(ok.findings) == 1 and errors_of(ok) == []


def test_every_detector_declares_the_threshold_keys_its_code_reads_and_both_packs_carry_them() -> None:
    """Source scan (independent of the pipeline): every `t["…"]` in a detector's module (and in a callable it borrows from
    another module) is declared in `thresholds`; every declared key is in each country pack that lists the detector."""
    import inspect
    import json
    import re
    from pathlib import Path

    from conftest import REPO
    from munim_intel.detect import REGISTRY
    from munim_intel.watch.pipeline import detectors_for

    detectors_for(None)
    key = re.compile(r'\b_?t\["([a-z0-9_]+)"\]')
    packs = {c: json.loads((REPO / "packages/contracts/packs" / f"{c}.json").read_text("utf8"))["detectors"] for c in ("IN", "AU")}
    bad = []
    for spec in (s for specs in REGISTRY.values() for s in specs):
        home = inspect.getsourcefile(spec.fires)
        read = set(key.findall(Path(str(home)).read_text("utf8")))
        fns: list[Any] = [spec.windows, spec.fires, spec.severity, spec.dedupe, spec.select, spec.severity_at, spec.mapping]
        fns += [spec.driver.params, spec.driver.window] if spec.driver else []
        read |= {k for fn in fns if fn is not None and inspect.getsourcefile(fn) != home for k in key.findall(inspect.getsource(fn))}
        if not read <= set(spec.thresholds):
            bad.append((spec.id, "reads undeclared", sorted(read - set(spec.thresholds))))
        for code, dets in packs.items():
            if spec.id in dets and not set(spec.thresholds) <= set(dets[spec.id]["thresholds"]):
                bad.append((spec.id, code, sorted(set(spec.thresholds) - set(dets[spec.id]["thresholds"]))))
    print("specs:", sum(len(v) for v in REGISTRY.values()), "bad:", bad)
    assert bad == [] and sum(len(v) for v in REGISTRY.values()) == 41  # 41 watcher detectors (forecast's 3 are its service's)


# -- R-B S2-C: a tenant-level detector runs once per run and drafts tenant-wide -----------------------------------------

OUTLET_B = "01920000-0000-7000-8000-0000000043c2"


def two_outlets() -> Frame:
    f = frame("IN")
    later = OutletFrame(OUTLET_B, "restaurant", date(2026, 10, 11))
    return replace(f, outlets=(f.outlets[0], later))


def test_a_tenant_level_detector_mints_once_with_the_latest_business_date_and_drafts_tenant_wide() -> None:
    """Hand values: two outlets (10 and 11 Oct). Tenant-level: one mint, at the later outlet, one finding, its draft
    `outlet_ids` []. Paired: the same detector per outlet mints twice and files each draft under its outlet."""
    tenant, per_outlet = FakeCore(follow_rows(12)), FakeCore(follow_rows(12))
    run(tenant, two_outlets(), {"finance": [replace(SPEC, tenant_level=True)]})
    run(per_outlet, two_outlets(), {"finance": [SPEC]})
    mints = [m.model_dump(mode="json")["params"].get("outlet_id") for m in tenant.minted if m.template_id == SPEC.template]
    both = [m.model_dump(mode="json")["params"].get("outlet_id") for m in per_outlet.minted if m.template_id == SPEC.template]
    print("tenant mints:", mints, "per outlet:", both, "drafts:", [d.model_dump(mode="json")["outlet_ids"] for d in tenant.drafts])
    # The ad-fee detector mints three months a pass (finance.md: this month and the two before): 3 once, 3 per outlet.
    assert (mints, sorted(both)) == ([OUTLET_B] * 3, sorted([OUTLET] * 3 + [OUTLET_B] * 3))
    assert (len(tenant.findings), [d.model_dump(mode="json")["outlet_ids"] for d in tenant.drafts]) == (1, [[]])
    assert sorted(d.model_dump(mode="json")["outlet_ids"][0] for d in per_outlet.drafts) == sorted([OUTLET, OUTLET_B])


def test_a_tenant_level_detector_abstains_in_a_run_scoped_to_some_outlets() -> None:
    """Core refuses a tenant-wide draft from a scoped run (drafts.ts), so a scoped run does not run it: not_applicable."""
    core = FakeCore(follow_rows(12))
    scoped = replace(CTX, outlet_scope=(OUTLET,))
    w = WatchRun(scoped, core, two_outlets(), CFG)
    asyncio.run(w.run({"finance": [replace(SPEC, tenant_level=True)]}))
    assert (core.minted, [t["payload"] for t in core.traces if t["kind"] == "abstain"]) == (
        [],
        [{"detector": SPEC.id, "reason": "not_applicable"}],
    )


# -- R-B polish: every `as_of` a detector mints is the run-frame's business date, never null (core's clock) ---------------


def test_every_as_of_a_sweep_mints_is_the_outlets_business_date() -> None:
    """A null `as_of` lets the template read core's clock, so a sweep across midnight judges two days at once. Hand list:
    the detectors whose templates take `as_of` (0022 v2 and price_creep / goal_progress / churn_segments): each mint
    carries the frame's 2026-10-10. `market.goals` lists one goal so goal_progress is minted too."""
    goal = "01920000-0000-7000-8000-0000000043f1"
    core = FakeCore({"market.goals": [{"goal_id": goal}]})
    f = frame("IN")
    run(core, replace(f, outlets=tuple(replace(o, kind="restaurant") for o in f.outlets)))
    as_of = sorted(
        (m.template_id, m.model_dump(mode="json")["params"]["as_of"]) for m in core.minted if "as_of" in m.model_dump(mode="json")["params"]
    )
    print("as_of mints:", as_of)
    want = {
        "catalogue.cost_drift", "compliance.energy_per_order", "compliance.licence_calendar", "customers.churn_segments",
        "inventory.dead_stock", "inventory.expiry_risk", "inventory.shortfall", "market.competitor_gap", "market.goal_progress",
        "market.upcoming", "people.advances_open", "purchasing.price_creep", "finance.missing_payouts",
    }  # fmt: skip
    assert {t for t, _ in as_of} == want and {v for _, v in as_of} == {"2026-10-10"}


# -- C3: a class name reaches a trace only as a label ----------------------------------------------------------------------


class _ResourceExhaustedError(RuntimeError):
    """Named as ADK's own wrapper of a provider 429 (google_llm.py): a class name with a leading underscore, which is not a label."""


class RateLimited(BaseLlm):
    model: str = "gemini-3.8-flash"

    async def generate_content_async(self, llm_request: LlmRequest, stream: bool = False) -> AsyncGenerator[LlmResponse, None]:
        raise _ResourceExhaustedError("429 RESOURCE_EXHAUSTED, a message never traced")
        yield  # an async generator, never reached


def test_a_rate_limited_narration_is_traced_by_label_and_the_finding_stands() -> None:
    """The narration's model answers a 429: run_agent fails with the class name `_ResourceExhaustedError` as `RunFailed.kind`,
    and the pipeline traced it raw, so the trace check (TraceLabelError) ended the whole sweep. Now it is traced as
    `ResourceExhaustedError`, the narration counted failed, and the template finding stays. Paired: the same sweep with a
    model that works traces no error."""
    rows = {"finance.unapproved_deductions": [ad_row(55_000)]}
    limited, fine = FakeCore(rows), FakeCore(rows)
    report, _ = run(limited, frame("IN", narration="model"), {"finance": [SPEC]}, llm=RateLimited())
    run(fine, frame("IN", narration="model"), {"finance": [SPEC]}, llm=RecordedLlm(model="recorded/narrate"))
    print("errors:", errors_of(limited), "narrations:", dict(report.narrations))
    # The ADK plugin traces the same failure under model, agent and run; the pipeline adds its own, narrate.
    assert [e["where"] for e in errors_of(limited)] == ["model", "agent", "run", "narrate"]
    assert {e["error"] for e in errors_of(limited)} == {"ResourceExhaustedError"}
    assert errors_of(limited)[-1] == {"where": "narrate", "detector": SPEC.id, "error": "ResourceExhaustedError"}
    assert (report.narrations["failed"], [f.type for f in limited.findings]) == (1, ["reconciliation_break.unapproved_ad_fee"])
    assert errors_of(fine) == [] and "RESOURCE_EXHAUSTED" not in str(limited.traces)  # the exception's message is never traced


def test_a_detector_failing_with_an_underscored_class_name_is_traced_by_label() -> None:
    def private(*_args: Any) -> Any:
        raise _ResourceExhaustedError("quota, never traced")

    core = FakeCore({**follow_rows(12), **MRP})
    report, _ = run(core, frame("IN", "store"), {"finance": [replace(SPEC, fires=private)], "catalogue": [above_mrp.SPEC]})
    assert errors_of(core) == [{"where": "hits", "detector": SPEC.id, "error": "detector_error", "type": "ResourceExhaustedError"}]
    assert ([x.type for x in core.findings], report.errors) == (["catalogue.above_mrp"], 1) and "quota" not in str(core.traces)
