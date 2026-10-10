import { proposalPo } from "./approvals.ts";
import { findingEnvelope, envelopeSegments, reviewTrace, traceInput } from "./shared.ts";
import { S1, T, u, snapRef } from "./_ids.ts";

export const SAMPLES: Record<string, unknown> = {
  "internal.events-claim.request": { event_id: u(110) },
  "internal.events-claim.response": { event_id: u(110), claimed_at: T },
  "internal.watch-claim.request": { pack: "inventory_purchasing" },
  "internal.watch-claim.response": { pack: "inventory_purchasing", go: true, last_run_at: null },
  "internal.snapshots.request": { template_id: "inventory.below_reorder", params: { outlet_id: u(2), ingredient_ids: [u(40)], as_of: null } },
  "internal.findings.request": { pack: "inventory_purchasing", type: "inventory.below_reorder", severity: "high", confidence_bp: 9000, dedupe_key: `below_reorder:${u(40)}`, envelope: findingEnvelope },
  "internal.findings.response": { finding_id: u(80), outcome: "abstained", reason_code: "number_grammar" },
  "internal.drafts.request": { draft_id: u(90), pack: "inventory_purchasing", command_type: "purchasing.po.create.v1", payload: proposalPo, outlet_ids: [u(2)], finding_id: u(80), evidence: [`snap:${S1}`, `row:intel.supplier_quote:${u(70)}`], based_on: [snapRef(S1, 0, "on_hand_qty_milli")] },
  "internal.drafts.response": { draft_id: u(90), status: "proposed", reason_code: null },
  "internal.answers.request": { question: "Why is paneer short at Indiranagar?", envelope: { answer_id: u(130), segments: envelopeSegments, abstained: false } },
  "internal.answers.response": { answer_id: u(130), abstained: false, reason_code: null },
  "internal.traces-batch.request": { events: [traceInput, { ...traceInput, id: u(101), seq: 2, parent_id: u(100), kind: "tool_result", payload: { snapshot_id: S1 } }, reviewTrace] },
  "internal.traces-batch.response": { inserted: 3, last_seq: 3 },
};
