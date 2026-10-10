import { SPECIALIST_REGISTRY } from "../../src/intel/specialists.ts";
import { draftView } from "./approvals.ts";
import { findingEnvelope } from "./shared.ts";
import { S1, T, T_PG, snapRef, u } from "./_ids.ts";

const finance = SPECIALIST_REGISTRY.specialists.find((s) => s.id === "finance")!;
const cells = Object.fromEntries(["proposed", "approved", "edited", "rejected", "stale", "abstained"].map((c) => [c, snapRef(S1, 0, c)]));
const finding = {
  finding_id: u(80), run_id: u(81), pack: "finance", type: "finance.short_payout", severity: "high", status: "open", confidence_bp: 9000,
  dedupe_key: `short_payout:${u(40)}`, envelope: findingEnvelope, resolved_refs: [{ ref: snapRef(S1, 0, "outlet_name"), value: "Indiranagar (synthetic)" }],
  created_at: T, updated_at: T_PG,
};

export const SAMPLES: Record<string, unknown> = {
  "v1.specialists.response": { items: SPECIALIST_REGISTRY.specialists.filter((s) => s.kind !== "service") },
  "v1.specialist.desk": {
    specialist: finance,
    applicable: true,
    findings: [finding],
    drafts: [{ ...draftView, source: "intel:finance" }],
    track_record: { snapshot_id: S1, cells },
    threads: [{ thread_id: u(120), last_activity_at: T }],
  },
};
