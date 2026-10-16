// One Step-mode step (ADR-014 §7.2 steps 1–4; ledger R45 F1, F10), in ONE munim_core transaction under the member:
//   1. lock the investigation row (FOR UPDATE: a concurrent `:continue` of the same step waits here, then replays);
//      outside the member's outlet scope it is not visible at all (0020 RLS → 404, review M7);
//   2. narrow the transaction's outlet scope to the investigation's (a subset of the member's current scope, which
//      RLS just proved covers it), so every template — `finance.margin_bridge` has no outlet param — reads exactly the
//      investigation's outlets;
//   3. mint each evaluable, non-frozen item's template as a MEMBER snapshot (R40 C4) — one mint per distinct
//      template + params per step — and judge it in code (core-domain `judge`); a supported item freezes;
//   4. compute the status (§7.4); a candidate `done` first re-judges every item frozen in an earlier step on fresh
//      snapshots, and a flip reopens that item and keeps the investigation open (review m11);
//   5. insert the step with its explicit number (0020: gapless, member = the signed-in member) and update the row;
//      a step clears any earlier Plan stop reason (0020: NULL while it runs) and wakes `inbox:<tenant>` at commit.
// Narration happens after commit (index.ts): the transaction never waits on intel.
// An Auto step (T-089b, auto.ts) is this same path on munim_svc under core-worker: `m` is the creator as their membership
// stands now, the snapshots are minted by the step's `auto_step` run (R40 C4 via F11's standing grant) after the same
// role check a member mint gets, and the step row names the grant and the run (0020 step_rules).
import {
  bindParams, type Cell, evaluable, type ItemStatus, judge, nextStatus, type Playbook, type PlaybookItem, PLAYBOOKS, residualWithin,
  type Snap, templateSentence,
} from "@munim/core-domain/investigations";
import { snapRef } from "@munim/contracts";
import { ApiError } from "../../lib/errors.ts";
import type { OutletScope, Queryable } from "../../runtoken/index.ts";
import { type Member } from "../approvals/index.ts";
import { mintSnapshot } from "../evidence/index.ts";

export interface ChecklistEntry {
  item_id: string;
  specialist: string;
  status: ItemStatus;
  frozen: boolean;
  snapshot_ids: string[];
  refs: string[];
}

export interface ItemUpdate {
  item_id: string;
  specialist: string;
  from: ItemStatus;
  to: ItemStatus;
  frozen: boolean;
  reopened: boolean;
  snapshot_ids: string[];
  refs: string[];
}

export interface InvestigationRow {
  id: string;
  playbook_id: string;
  params: Record<string, unknown>;
  outlet_scope: string[];
  created_by: string;
  mode: string;
  status: string;
  checklist: ChecklistEntry[];
  steps_done: number;
  max_steps: number;
}

export const INVESTIGATION_COLS = `i.id, i.playbook_id, i.params, i.outlet_scope::text[] AS outlet_scope, i.created_by, i.mode, i.status, i.stop_reason,
  i.checklist, i.steps_done, i.max_steps, i.created_at, i.updated_at`;

/** What the narration needs once the step has committed: each changed item, its cells and core's template sentence. */
export interface StepResult {
  replayed: boolean;
  /** `status` is never `pending`: only judged items are narrated. */
  narrate: Array<{ item: PlaybookItem; status: ItemStatus; cells: Cell[] }>;
  scope: OutletScope;
  playbook: Playbook;
}

export function freshChecklist(pb: Playbook): ChecklistEntry[] {
  return pb.items.map((i) => ({ item_id: i.item_id, specialist: i.specialist, status: "pending", frozen: false, snapshot_ids: [], refs: [] }));
}

/** Wakes `inbox:<tenant>` streams when the transaction commits; the payload is ids only (One Guarantee: NOTIFY carries
 *  ids, every subscriber re-reads under its own RLS context, stream/feed.ts). Every write to core.investigation calls it
 *  in the writing transaction. */
export async function notifyInbox(q: Queryable, tenantId: string, id: string): Promise<void> {
  await q.query(`SELECT pg_notify('munim_inbox', $1)`, [`${tenantId}:${id}`]);
}

const refsOf = (cells: readonly Cell[]) => cells.map((c) => snapRef(c.snapshot_id, c.row, c.column));
const idsOf = (snaps: ReadonlyArray<Snap | null>) => snaps.flatMap((s) => (s ? [s.snapshot_id] : []));

/** The run and grant behind an Auto step (auto.ts). */
export interface AutoStep { run_id: string; grant_id: string }

/** `trigger`: `member` (Step mode, a `:continue`), `plan` (T-089a: the approving member's request runs the steps) or
 *  `auto` (T-089b: core-worker under the creator's standing grant, with `auto` set). */
export async function runStep(q: Queryable, m: Member, id: string, stepNo: number, trigger: "member" | "plan" | "auto" = "member", auto?: AutoStep): Promise<StepResult> {
  const r = await q.query<InvestigationRow>(`SELECT ${INVESTIGATION_COLS} FROM core.investigation i WHERE i.id = $1 FOR UPDATE`, [id]);
  const inv = r.rows[0];
  if (!inv) throw new ApiError("not_found");
  const pb = PLAYBOOKS[inv.playbook_id];
  if (!pb) throw new ApiError("invalid_payload");
  const scope = inv.outlet_scope as OutletScope;
  const params = inv.params;
  // Step mode: the creator steps their own investigation, under their own current scope (F10).
  if (inv.created_by !== m.member_id) throw new ApiError("forbidden");
  if (stepNo <= inv.steps_done) {
    const s = await q.query<{ member_id: string }>(`SELECT member_id FROM core.investigation_step WHERE investigation_id = $1 AND step_no = $2`, [id, stepNo]);
    if (s.rows[0]?.member_id === m.member_id) return { replayed: true, narrate: [], scope, playbook: pb };
    throw new ApiError("conflict");
  }
  if (inv.status !== "open" && inv.status !== "waiting") throw new ApiError("illegal_transition");
  if (stepNo !== inv.steps_done + 1) throw new ApiError("sequence_gap");

  await q.query(`SELECT set_config('app.outlet_ids', $1, true)`, [scope[0] === "*" ? "{*}" : `{${scope.join(",")}}`]);
  const minter = auto ? { kind: "run" as const, run_id: auto.run_id, actor: m.member_id, scope } : { kind: "member" as const, member_id: m.member_id, role: m.role, scope };
  const minted = new Map<string, Snap | null>();
  async function mint(templateId: string, params: Record<string, unknown>): Promise<Snap | null> {
    const key = `${templateId} ${JSON.stringify(params)}`;
    if (!minted.has(key)) {
      try {
        // An Auto step's run mint ranks its creator's current role in mint.ts, as the member's own mint does.
        const s = await mintSnapshot(q, m.tenant_id, minter, templateId, params);
        minted.set(key, { snapshot_id: s.snapshot_id, rows: s.rows as Snap["rows"] });
      } catch (e) {
        // A template above the member's role (or not theirs to mint) is not visible: that item cannot be verified (§7.2 step 1).
        if (!(e instanceof ApiError && e.code === "not_found")) throw e;
        minted.set(key, null);
      }
    }
    return minted.get(key)!;
  }
  // Sequential: one transaction runs one statement at a time.
  async function snapsOf(item: PlaybookItem): Promise<Array<Snap | null>> {
    const out: Array<Snap | null> = [];
    for (const p of item.params_from) out.push(await mint(item.template_id, bindParams(p, params)));
    return out;
  }

  const checklist = new Map(inv.checklist.map((c) => [c.item_id, { ...c }]));
  const statuses: Record<string, ItemStatus> = Object.fromEntries(inv.checklist.map((c) => [c.item_id, c.status]));
  const updates: ItemUpdate[] = [];
  const narrate: StepResult["narrate"] = [];
  const judgedNow = new Set<string>();
  for (const item of pb.items) {
    const cur = checklist.get(item.item_id)!;
    if (cur.frozen || !evaluable(item, statuses)) continue;
    const snaps = await snapsOf(item);
    const j = judge(item.verdict, snaps);
    statuses[item.item_id] = j.status;
    judgedNow.add(item.item_id);
    const next = { ...cur, status: j.status, frozen: j.status === "supported", snapshot_ids: idsOf(snaps), refs: refsOf(j.cells) };
    checklist.set(item.item_id, next);
    updates.push({ item_id: item.item_id, specialist: item.specialist, from: cur.status, to: j.status, frozen: next.frozen, reopened: false,
      snapshot_ids: next.snapshot_ids, refs: next.refs });
    if (j.cells.length > 0) narrate.push({ item, status: j.status, cells: j.cells });
  }

  const residual = residualWithin(await mint(pb.residual.template_id, bindParams(pb.residual.params_from, params)), pb.residual.component, pb.residual.max_bp);
  let status = nextStatus(pb, statuses, residual.ok, stepNo);
  if (status === "done") {
    // §7.4 / review m11: before `done`, every item frozen in an earlier step is judged again on fresh snapshots.
    let flipped = false;
    for (const item of pb.items) {
      const cur = checklist.get(item.item_id)!;
      if (!cur.frozen || judgedNow.has(item.item_id)) continue;
      const snaps = await snapsOf(item);
      const j = judge(item.verdict, snaps);
      if (j.status === "supported") continue;
      flipped = true;
      statuses[item.item_id] = j.status;
      const next = { ...cur, status: j.status, frozen: false, snapshot_ids: idsOf(snaps), refs: refsOf(j.cells) };
      checklist.set(item.item_id, next);
      updates.push({ item_id: item.item_id, specialist: item.specialist, from: cur.status, to: j.status, frozen: false, reopened: true,
        snapshot_ids: next.snapshot_ids, refs: next.refs });
      if (j.cells.length > 0) narrate.push({ item, status: j.status, cells: j.cells });
    }
    // A flip reopens: the status is computed again over the re-judged items (a gate flip → waiting, or cannot_verify at
    // max steps; R-D), and never `done` in this step.
    if (flipped) {
      const again = nextStatus(pb, statuses, residual.ok, stepNo);
      status = again === "done" ? (stepNo >= pb.max_steps ? "exhausted" : "open") : again;
    }
  }

  if (auto) {
    await q.query(
      `INSERT INTO core.investigation_step (tenant_id, investigation_id, step_no, member_id, triggered_by, item_updates, grant_id, run_id)
       VALUES ($1, $2, $3, $4, 'auto', $5, $6, $7)`, [m.tenant_id, id, stepNo, m.member_id, JSON.stringify(updates), auto.grant_id, auto.run_id]);
  } else await q.query(
    `INSERT INTO core.investigation_step (tenant_id, investigation_id, step_no, member_id, triggered_by, item_updates)
     VALUES ($1, $2, $3, $4, $6, $5)`, [m.tenant_id, id, stepNo, m.member_id, JSON.stringify(updates), trigger]);
  await q.query(`UPDATE core.investigation SET status = $2, checklist = $3, steps_done = $4 WHERE id = $1`,
    [id, status, JSON.stringify(pb.items.map((i) => checklist.get(i.item_id)!)), stepNo]);
  await q.query(`UPDATE core.investigation SET stop_reason = NULL WHERE id = $1 AND stop_reason IS NOT NULL`, [id]);
  await notifyInbox(q, m.tenant_id, id);
  return { replayed: false, narrate, scope, playbook: pb };
}

/** Core's template narration: one sentence per narrated item, citing its cells. */
export function templateSegments(items: StepResult["narrate"]): Array<{ text: string; refs: string[] }> {
  return items.map((n) => ({
    text: templateSentence(n.item, n.status as Exclude<ItemStatus, "pending">, n.cells),
    refs: [...new Set(n.cells.map((c) => `snap:${c.snapshot_id}`))],
  }));
}
