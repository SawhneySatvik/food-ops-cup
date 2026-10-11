// GET /internal/intel/v1/brief-items (T-054 wiring): the ranked inbox for a `brief` run — `rankInbox` over the open findings
// and proposed drafts in the run's tenant and outlet scope, top first. Core ranks; intel only words (04 §5).
// Projected field by field: the finding's dedupe key is never copied (it can hold weeks and dates; review R-B).
// Impact is the value of the finding's `impact_ref` cell, resolved as `findingViews` resolves a ref, for a viewer who may
// open it. The brief is the owner's, so a tenant-wide run resolves as an owner; an outlet-scoped run as a manager of that scope.
import { BriefItemsResponse } from "@munim/contracts/internal";
import type { Queryable } from "../runtoken/index.ts";
import { cellOf, loadSnapshots, type Member, snapIdOf } from "../modules/approvals/index.ts";
import { type DraftIn, type FindingIn, rankInbox, type Severity } from "../modules/inbox/ranking.ts";
import type { Run } from "./auth.ts";

interface Row {
  id: string; pack: string; type: string; severity: Severity; confidence_bp: number; dedupe_key: string;
  envelope: { segments?: Array<{ text: string }>; impact_ref?: string | null }; created_at: Date; updated_at: Date;
}

const TOP = 50;
const asInt = (v: unknown): number | null => {
  const n = typeof v === "number" ? v : typeof v === "string" && /^-?[0-9]+$/.test(v) ? Number(v) : NaN;
  return Number.isSafeInteger(n) ? n : null;
};

export async function briefItems(q: Queryable, run: Run, now: Date) {
  const viewer: Member = {
    kind: "member", tenant_id: run.tenantId, member_id: run.runId,
    role: run.scope[0] === "*" ? "owner" : "manager", outlet_ids: run.scope[0] === "*" ? "*" : run.scope,
  };
  // An abstained finding is stored with an empty envelope: nothing to word.
  const findings = (await q.query<Row>(
    `SELECT id, pack, type, severity, confidence_bp, dedupe_key, envelope, created_at, updated_at FROM intel.finding
      WHERE status = 'open' AND COALESCE(envelope ->> 'abstained', 'false') = 'false'`)).rows;
  const drafts = (await q.query<{ id: string; finding_id: string | null; source: string; created_at: Date }>(
    `SELECT id, finding_id, source, created_at FROM core.draft WHERE status = 'proposed'`)).rows;
  const snaps = await loadSnapshots(q, findings.flatMap((f) => (f.envelope.impact_ref ? [snapIdOf(f.envelope.impact_ref) ?? ""] : [])).filter(Boolean), viewer);
  const cell = new Map(findings.map((f) => [f.id, f.envelope.impact_ref ? cellOf(f.envelope.impact_ref, snaps) : null]));
  const byId = new Map(findings.map((f) => [f.id, f]));
  const ins: FindingIn[] = findings.map((f) => ({
    id: f.id, pack: f.pack, severity: f.severity, confidence_bp: f.confidence_bp, dedupe_key: f.dedupe_key,
    impact: asInt(cell.get(f.id)?.value), created_at: f.created_at, updated_at: f.updated_at,
  }));
  const dins: DraftIn[] = drafts.map((d) => ({ id: d.id, finding_id: d.finding_id, source: d.source, created_at: d.created_at }));
  // A draft with no open finding is its own item, ranked after every finding; a brief words findings, so it is left out.
  const items = rankInbox(ins, dins, now).flatMap((i) => (i.finding ? [{ f: byId.get(i.finding.id)!, drafts: i.drafts }] : [])).slice(0, TOP);
  return BriefItemsResponse.parse({
    items: items.map(({ f, drafts: ds }) => ({
      finding_id: f.id, pack: f.pack, severity: f.severity, type: f.type,
      texts: (f.envelope.segments ?? []).map((s) => s.text),
      impact_ref: cell.get(f.id) ? f.envelope.impact_ref : null,
      draft_ids: ds.map((d) => d.id),
    })),
  });
}
