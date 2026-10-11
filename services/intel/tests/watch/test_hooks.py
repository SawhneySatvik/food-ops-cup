"""W3.2 pipeline hooks, offline against test_watch's in-memory core. Each gate pairs the hook firing with its accept or
refuse case; expected values are hand values (the fixture's own rows and ids), never read back from the pipeline.

  follow-up mints   a mapping's extra snapshot is minted after the finding, by the detection's params, and handed in
  mapping abstain   a typed refusal is traced as a contracts ReasonCode, never prose; a code outside the list is not
  invalid finding   a finding the contract refuses is traced as `invalid_finding` and the run goes on
"""

from __future__ import annotations

from dataclasses import replace
from typing import Any

from test_watch import ITEM, OUTLET, FakeCore, ad_row, frame, run

from munim_intel.mapping import Abstain, Detection, FollowUp, Proposal
from munim_intel.runtime.internal_client import CoreError
from munim_intel.watch.detectors.finance import unapproved_ad_fee

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
