import { JWT, S1, T, T_PG, citeRef, snapRef, u } from "./_ids.ts";

export const envelopeSegments = [
  {
    text: `Paneer at ${snapRef(S1, 0, "outlet_name")} is below its reorder level: ${snapRef(S1, 0, "on_hand_qty_milli")} on hand ${citeRef("row", `core.reorder_level:${u(41)}`)}.`,
    refs: [`snap:${S1}`, `row:core.reorder_level:${u(41)}`],
  },
];
export const findingEnvelope = { finding_id: u(80), segments: envelopeSegments, impact_ref: snapRef(S1, 0, "shortfall_qty_milli"), abstained: false };
export const traceInput = {
  id: u(100),
  seq: 1,
  parent_id: null,
  kind: "tool_call",
  actor: "inventory_purchasing",
  payload: { tool: "sql.query", template_id: "inventory.below_reorder", refs: [`snap:${S1}`] },
  at: T,
};
export const snapshot = {
  snapshot_id: S1,
  template_id: "inventory.below_reorder",
  params: { outlet_id: u(2), include_zero: false, limit: 50 },
  run_id: u(81),
  minted_by_member_id: null,
  minted_by_operator_id: null,
  outlet_scope: [u(2)],
  columns: [
    { name: "outlet_name", type: "text" },
    { name: "on_hand_qty_milli", type: "integer" },
    { name: "pct_change", type: "numeric" },
  ],
  rows: [{ outlet_name: "Indiranagar (synthetic)", on_hand_qty_milli: 1500, pct_change: "12.50", counted: true, note: null }],
  row_count: 1,
  sha256: "a".repeat(64),
  created_at: T_PG,
};

export const reviewPayload = { verdict: "fail", reason_code: "margin_below_floor", refs: [`snap:${S1}`, `row:intel.supplier_quote:${u(70)}`], subject_id: u(70) };
export const reviewTrace = { id: u(102), seq: 3, parent_id: u(100), kind: "review", actor: "inventory_purchasing.deal_review", payload: reviewPayload, at: T_PG };

export const SAMPLES: Record<string, unknown> = {
  uuid7: u(12),
  "iso-datetime": T_PG,
  money: { amount_minor: 24900, currency: "INR" },
  ref: citeRef("doc", u(120), [10, 42]),
  "ref-id": `doc:${u(120)}`,
  "reason-code": "authority_denied",
  "answer-envelope": { answer_id: u(130), segments: [], abstained: true, reason_code: "settlements_missing" },
  "finding-envelope": findingEnvelope,
  "person-edit": { value: 10000, typed_by: u(8) },
  "run-token-claims": { iss: "munim-core", aud: "munim-intel", run_id: u(81), tenant_id: u(1), outlet_scope: ["*"], trigger: "event", actor: "watcher:inventory_purchasing", iat: 1791000000, exp: 1791007200 },
  cloudevent: {
    specversion: "1.0",
    id: u(113),
    source: `/tenants/${u(1)}/kitchen`,
    type: "munim.kitchen.ticket.advanced.v1",
    subject: u(11),
    time: T_PG,
    datacontenttype: "application/json",
    tenantid: u(1),
    munimrun: JWT,
    data: { ticket_id: u(11), to_status: "ready", nested: { list: [1, "two", null] } },
  },
  "trace-event": { run_id: u(81), ...reviewTrace },
  "trace-review-payload": { verdict: "pass", reason_code: null, refs: [`snap:${S1}`], subject_id: null },
  "command-envelope": { command_id: u(12), idempotency_key: "pos-1-000123", type: "kitchen.ticket.advance.v1", payload: { ticket_id: u(11), from_status: "queued", to_status: "preparing" } },
  "command-result": { command_id: u(12), type: "orders.place.v1", entity_id: u(10), committed_at: T_PG },
  snapshot: { ...snapshot, run_id: null, minted_by_member_id: u(8) },
  error: { error: { code: "conflict", message: "This changed since you loaded it.", reason_code: null } },
};
