import { draftView } from "./approvals.ts";
import { SPECIALIST_REGISTRY } from "../../src/intel/specialists.ts";
import { findingEnvelope, reviewTrace, traceInput } from "./shared.ts";
import { S1, T, T_PG, snapRef, u } from "./_ids.ts";

const findingView = {
  finding_id: u(80),
  run_id: u(81),
  pack: "inventory_purchasing",
  type: "inventory.below_reorder",
  severity: "high",
  status: "open",
  confidence_bp: 9000,
  dedupe_key: `below_reorder:${u(40)}`,
  envelope: findingEnvelope,
  resolved_refs: [
    { ref: snapRef(S1, 0, "outlet_name"), value: "Indiranagar (synthetic)" },
    { ref: snapRef(S1, 0, "on_hand_qty_milli"), value: 1500 },
    { ref: snapRef(S1, 0, "pct_change"), value: "12.50" },
  ],
  created_at: T,
  updated_at: T_PG,
};

export const SAMPLES: Record<string, unknown> = {
  "v1.finding": findingView,
  "v1.findings.response": { items: [findingView], next_cursor: null },
  "v1.inbox.response": { items: [{ kind: "finding", finding: findingView }, { kind: "draft", draft: draftView }], next_cursor: "c2VxOjQy" },
  "v1.run.response": { run_id: u(81), trigger: "event", actor: "watcher:inventory_purchasing", outlet_scope: ["*"], issued_at: T, expires_at: "2026-10-09T12:15:00+05:30", ended_at: null },
  "v1.runs.response": { items: [{ run_id: u(81), trigger: "event", actor: "watcher:inventory_purchasing", outlet_scope: ["*"], issued_at: T, expires_at: "2026-10-09T12:15:00+05:30", ended_at: null }], next_cursor: null },
  "v1.traces.response": { run_id: u(81), events: [{ run_id: u(81), ...traceInput }, { run_id: u(81), ...reviewTrace }], next_after_seq: 3 },
  "intel.specialists.registry": SPECIALIST_REGISTRY,
  "v1.snapshots.request": { template_id: "catalogue.dish_margin", params: { outlet_id: u(2), from_on: "2026-09-25", to_on: "2026-10-08" } },
  "v1.wiki.pages": { items: [{ page_id: u(3600), entity_id: null, kind: "supplier", slug: "synthetic-supplier", title: "Synthetic supplier", current_version: 1, updated_at: T }], next_cursor: null },
  "v1.wiki.page": { page_id: u(3600), entity_id: null, kind: "supplier", slug: "synthetic-supplier", title: "Synthetic supplier", current_version: 1, updated_at: T, body: [{ type: "text", text: "A synthetic page." }] },
  "v1.wiki.versions": { items: [{ version_id: u(3601), version: 1, body: [{ type: "text", text: "A synthetic page." }], run_id: null, created_at: T }], next_cursor: null },
};
