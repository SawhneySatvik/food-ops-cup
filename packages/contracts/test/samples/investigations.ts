import { MEMBER, OUTLET, S1, T, T_PG, snapRef, u } from "./_ids.ts";

const sig = (specialist: string) => ({ key: "investigation.signature.specialist", specialist, name_key: `specialist.${specialist}.name` });
const share = snapRef(S1, 3, "share_bp");
const delta = snapRef(S1, 3, "delta_minor");
const update = {
  item_id: "supplier_price", specialist: "inventory_purchasing", from: "pending", to: "supported", frozen: true, reopened: false,
  snapshot_ids: [S1], refs: [delta, share],
};
const S2 = u(901);
const item = {
  investigation_id: u(130), playbook_id: "margin_fall", params: { period_month: "2026-09-01", compare_month: "2026-08-01" }, outlet_scope: ["*"],
  mode: "plan", status: "waiting", stop_reason: "waiting", created_by: MEMBER, steps_done: 1, max_steps: 10, created_at: T, updated_at: T_PG,
};
const narrateItem = {
  item_id: "supplier_price", specialist: "inventory_purchasing", verdict: "supported",
  cells: [{ ref: delta, column: "delta_minor" }, { ref: share, column: "share_bp" }],
  template: `Supplier prices moved the margin by ${delta}, a share of ${share}.`,
};

export const SAMPLES: Record<string, unknown> = {
  "v1.investigation.create.request": {
    investigation_id: u(130), playbook_id: "margin_fall", params: { period_month: "2026-09-01", compare_month: "2026-08-01" }, outlet_scope: [OUTLET],
    mode: "plan",
  },
  "v1.investigation.continue.request": { step_no: 2 },
  "v1.investigation.cancel.request": {},
  "v1.investigation.approve-plan.request": { mode: "auto" },
  "v1.investigations.response": { items: [item], next_cursor: null },
  "v1.investigation": {
    investigation_id: u(130), playbook_id: "margin_fall", params: { period_month: "2026-09-01", compare_month: "2026-08-01" }, outlet_scope: ["*"],
    mode: "plan", status: "waiting", stop_reason: "waiting", created_by: MEMBER, steps_done: 1, max_steps: 10,
    plan: {
      items: [{ item_id: "supplier_price", label_key: "investigation.margin_fall.supplier_price", specialist: "inventory_purchasing" },
        { item_id: "channel_fees", label_key: "investigation.margin_fall.channel_fees", specialist: "finance" }],
      specialists: ["inventory_purchasing", "finance"],
      estimate: { label: "estimate (computed)", status: "computed", snapshot_id: S2, estimate_ref: snapRef(S2, 0, "estimate_minor"), currency_ref: snapRef(S2, 0, "currency") },
      approved_by: MEMBER, approved_at: T_PG,
    },
    checklist: [
      { item_id: "supplier_price", label_key: "investigation.margin_fall.supplier_price", specialist: "inventory_purchasing",
        signature: sig("inventory_purchasing"), status: "supported", frozen: true, snapshot_ids: [S1], refs: [delta, share] },
      { item_id: "channel_fees", label_key: "investigation.margin_fall.channel_fees", specialist: "finance",
        signature: sig("finance"), status: "pending", frozen: false, snapshot_ids: [], refs: [] },
    ],
    steps: [{
      step_no: 1, member_id: MEMBER, triggered_by: "plan", started_at: T_PG, item_updates: [update], tainted: false,
      narration: {
        answer_id: u(131),
        envelope: { answer_id: u(131), segments: [{ text: narrateItem.template, refs: [`snap:${S1}`] }], abstained: false, reason_code: null },
        signatures: [sig("inventory_purchasing")],
      },
    }],
    resolved_refs: [{ ref: delta, value: -704000 }, { ref: share, value: -3698 }, { ref: snapRef(S2, 0, "estimate_minor"), value: 8638 },
      { ref: snapRef(S2, 0, "currency"), value: "INR" }],
    created_at: T, updated_at: T_PG,
  },
  "investigations.narrate.request": { answer_id: u(131), question: "investigation step", playbook_id: "margin_fall", owner: "finance", items: [narrateItem] },
  "investigations.narrate.response": { answer_id: u(131), tainted: false, source: "template" },
};
