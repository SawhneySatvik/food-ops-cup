import { MEMBER, S1, T, T_PG, snapRef, u } from "./_ids.ts";

const audit = { seq: 42, action: "catalogue.price.set.v1", entity: "core.price", entity_id: u(60), at: T_PG, actor: { member_id: MEMBER, kind: "member", role: "owner" }, decision_id: u(91) };
const decision = { decision_id: u(91), verdict: "approved", reason: null, reason_code: null, decided_by: { member_id: MEMBER, name: "Ravi (synthetic)" }, decided_at: T_PG };
const draft = {
  draft_id: u(90), command_type: "catalogue.price.set.v1", source: "intel:catalogue", outlet_ids: [u(2)], created_at: T,
  outcome: { status: "executed", reason: null, reason_code: null, changes: [], sqlstate: null, failure_reason: null },
};
const chain = {
  audit, decision, draft,
  finding: { finding_id: u(80), pack: "catalogue", type: "catalogue.price_below_target", status: "open", created_at: T },
  run: { run_id: u(81), trigger: "event", actor: "watcher:catalogue", issued_at: T },
  snapshots: [{ snapshot_id: S1, template_id: "catalogue.dish_margin", template_version: 1, refs: [snapRef(S1, 0, "suggested_minor")] }],
  unverified_refs: [],
};
const stale = {
  audit: null, decision: null,
  draft: { ...draft, draft_id: u(92), outcome: { status: "stale", reason: null, reason_code: null, changes: [{ ref: snapRef(S1, 0, "suggested_minor"), now_ref: null }], sqlstate: null, failure_reason: null } },
  finding: null, run: null, snapshots: [], unverified_refs: [snapRef(u(901), 1, "par_qty_milli")],
};
const rejected = { ...stale, decision: { ...decision, verdict: "rejected", reason: "Price is fine for now", reason_code: "not_needed" }, draft: { ...draft, outcome: { ...draft.outcome, status: "rejected", reason: "Price is fine for now", reason_code: "not_needed" } } };

export const SAMPLES: Record<string, unknown> = {
  "v1.lineage.row": { row: { table: "core.price", id: u(60) }, chains: [chain, { ...chain, audit: { ...audit, seq: 43, decision_id: null }, decision: null, draft: null, finding: null, run: null, snapshots: [] }] },
  "v1.lineage.draft": { chain: rejected, touched: [] },
  "v1.draftables": {
    items: [{ command_type: "catalogue.price.set.v1", proposal_schema: { type: "object", properties: {} }, command_schema: { type: "object", properties: {} } }],
  },
};
