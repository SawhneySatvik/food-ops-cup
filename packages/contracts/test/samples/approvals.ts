import { priceSet } from "./catalogue.ts";
import { reorderSet } from "./inventory.ts";
import { poCreate } from "./purchasing.ts";
import { MEMBER, S1, T, T_PG, citeRef, snapRef, u } from "./_ids.ts";

export const qtyRef = snapRef(S1, 0, "suggested_qty_milli");
export const proposalPo = {
  ...poCreate,
  lines: [{ ingredient_id: u(40), qty_milli: qtyRef, unit: "kg", unit_price_minor: citeRef("row", `intel.supplier_quote:${u(70)}`) }],
};
const proposalPrice = { ...priceSet, amount_minor: snapRef(S1, 0, "proposed_price_minor") };
const proposalReorder = { ...reorderSet, min_qty_milli: snapRef(S1, 1, "min_qty_milli"), par_qty_milli: snapRef(S1, 1, "par_qty_milli") };
/** The owner changed the quantity (typed by them); the price stays the proposed ref. */
export const editedPo = { ...proposalPo, lines: [{ ...proposalPo.lines[0], qty_milli: { value: 10000, typed_by: MEMBER } }] };

export const draftView = {
  draft_id: u(90),
  command_type: "purchasing.po.create.v1",
  payload: editedPo,
  resolved_refs: [{ path: "/lines/0/unit_price_minor", ref: citeRef("row", `intel.supplier_quote:${u(70)}`), value: 34000 }],
  outlet_ids: [u(2)],
  source: "intel:inventory_purchasing",
  finding_id: u(80),
  run_id: u(81),
  evidence: [`snap:${S1}`],
  based_on: [{ ref: snapRef(S1, 0, "on_hand_qty_milli"), template_id: "inventory.below_reorder", params: { outlet_id: u(2) }, expected: 1500 }],
  status: "proposed",
  created_at: T,
  updated_at: T_PG,
};

const decision = { decision_id: u(91), verdict: "edited", reason: "Half a crate is already on the way", decided_by: { member_id: MEMBER, name: "Ravi (synthetic)" }, decided_at: T_PG };
const tenantWide = { ...draftView, draft_id: u(92), outlet_ids: [], status: "stale" };
const change = { ref: snapRef(S1, 0, "on_hand_qty_milli"), value: 1500, now_ref: snapRef(u(901), 0, "on_hand_qty_milli"), now: 9000 };

export const SAMPLES: Record<string, unknown> = {
  "v1.drafts.response": { items: [{ draft: draftView, decision: null, unverified_refs: [] }, { draft: tenantWide, decision: null, unverified_refs: [snapRef(S1, 2, "par_qty_milli")] }], has_more: true, next_cursor: "MjAyNi0xMC0wOVQwNDo0NTowMC4xMjM0NTZafDAxOTll" },
  "v1.draft.detail": {
    draft: { ...draftView, status: "executed" },
    decision,
    unverified_refs: [],
    history: [
      { event: "proposed", at: T, by: "intel:inventory_purchasing" },
      { event: "edited", at: T_PG, by: decision.decided_by, reason: decision.reason },
      { event: "stale", at: T_PG, by: { member_id: MEMBER, role: "manager" }, decision_id: null, changes: [change] },
      { event: "failed", at: T_PG, by: { member_id: MEMBER, role: "owner" }, decision_id: u(91), sqlstate: "MB001" },
    ],
  },
  "drafts.decision-error": { error: { code: "stale_draft", message: "This proposal is out of date: the numbers it relied on have changed.", reason_code: "stale_draft" }, changes: [change] },
  "drafts.approve.v1": { draft_id: u(90), command_type: "purchasing.po.create.v1", edited_payload: editedPo, reason: "Half a crate is already on the way" },
  "drafts.reject.v1": { draft_id: u(90), reason: "Supplier closed for the festival", reason_code: "bad_timing" },
  "proposal.purchasing.po.create.v1": proposalPo,
  "proposal.catalogue.price.set.v1": proposalPrice,
  "proposal.inventory.reorder_level.set.v1": proposalReorder,
  "v1.draft": draftView,
};
