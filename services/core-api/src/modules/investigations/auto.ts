// Investigation Auto mode (ledger R45 F10, F11 O-1; BOARD T-089b). Auto is Plan, plus core-worker resuming the
// investigation when new data lands, under the standing grant its creator gave by approving it as Auto.
//   - Approving Auto (`approveAuto`) is the creator's own act inside `:approve-plan {mode: "auto"}`: the role ceiling must
//     allow `auto` (default: owner only), then one UPDATE stamps the plan approval and `mode = 'auto'` together (0020
//     CHECK investigation_auto_needs_plan) and the grant is inserted for exactly the investigation's scope (0020
//     grant_rules). A repeat is a replay. An already approved Plan is not turned into Auto later (409): Auto is chosen
//     when the plan is approved.
//   - Resuming (`resumeOnImports`, `resumeDaily`; core-worker's investigations jobs) runs on munim_svc only. Each step is
//     one transaction that locks the investigation and re-checks, inside the lock and in this order:
//       1. still `auto`, open or waiting, with a live grant, and not already resumed for this trigger (two workers or a
//          replayed pass → 1 step);
//       2. the creator's CURRENT membership covers the stored scope — otherwise `cancelled`, stop_reason `scope` (review
//          M7, F11 "cancelled when access changes"; 0020 refuses a narrowed grant, so a narrowing that touches the stored
//          scope cancels rather than steps on a smaller scope);
//       3. the ceiling of the creator's current role still allows `auto` — otherwise 0 steps and the run is downgraded to
//          Plan (F10; T-098): `SET stop_reason = 'ceiling'`, and 0027's trigger sets `mode = 'plan'` in the same row write
//          (munim_svc holds no UPDATE on `mode`, so it can write no other mode). Checked before new data, like the access
//          check: a lowered ceiling or a demoted member downgrades the same day, data or not. The standing grant stays
//          unrevoked (only its member can revoke it) but steps nothing: Auto steps and auto_step runs need `mode = 'auto'`,
//          and 0027 auto_entry admits `auto` only in the plan-approving update, which a plan gets once. The creator's
//          `:continue` steps it from there, and sees why it stopped (redact.ts: `ceiling` is shown to the creator);
//       4. the month's AI budget (`effectiveCap`: the lower of the owner's cap and the operator's limit) — none set or
//          none left → stop_reason `budget` and 0 steps (the Plan ruling: no budget row fails closed);
//     then mints the step's `auto_step` run (actor = the creator, grant_id = the grant, scope = the stored scope; 0020
//     re-checks the grant at insert) and runs the step through the `:continue` code path (step.ts) with that run as the
//     snapshot minter. After commit the step is narrated under the same run, and the run stops at waiting, an abstain,
//     a terminal status or the budget, as Plan's does.
//   - The import trigger: an investigation `waiting` on its playbook's data gate resumes when an import of a kind that
//     can complete one of the gate's still-open close items was approved after its last step. No import commit writes
//     an outbox event (imports.run.commit.v1 returns none), so core-worker polls committed `core.import_run` rows.
//   - The daily trigger (R47 D4): every open or waiting Auto investigation with no step since the day's boundary AND new data since
//     its last step (`newData`). A pass with nothing new steps nothing, and burns no model budget.
//   - Auto creates no drafts and links none: no draft-linking lookup exists yet (DECISIONS 11 Oct, Plan rulings), so
//     stop_reason `draft` is never recorded here either.
import type { RunTokenClaims } from "@munim/contracts";
import { outletScopeOf } from "@munim/core-domain/authority";
import { PLAYBOOKS } from "@munim/core-domain/investigations";
import type pg from "pg";
import type { MemberRole } from "../../auth/resolve.ts";
import { uuidv7 } from "../../commit/index.ts";
import { withContext } from "../../lib/db.ts";
import { ApiError } from "../../lib/errors.ts";
import { endRun, mintRunTokenIn, type OutletScope, type Queryable, type RunTokenKeys } from "../../runtoken/index.ts";
import { assertModeAllowed, ceilingFor, effectiveCap } from "../ai_policy/index.ts";
import type { Member } from "../approvals/index.ts";
import { type ChecklistEntry, INVESTIGATION_COLS, type InvestigationRow, notifyInbox, runStep, type StepResult } from "./step.ts";

export interface AutoRun { token: string; claims: RunTokenClaims }
/** Narrates a committed Auto step under its run and ends the run (index.ts autoDeps). */
export type AutoNarrate = (m: Member, id: string, stepNo: number, step: StepResult, run: AutoRun) => Promise<void>;
/** What the resume passes need: the munim_svc pool (and nothing that logs in as munim_core), the run-token keys and
 *  the narration. */
export interface AutoDeps { svc: pg.Pool; keys: RunTokenKeys; narrate: AutoNarrate; log: (msg: string) => void }
/** One pass: investigations that ran ≥ 1 step, the steps, and those stopped by scope (cancelled), budget or ceiling. */
export interface AutoTally { resumed: number; steps: number; cancelled: number; budget: number; ceiling: number }

/** The gate's close items (finance.close_status, 0019) → the import kind whose approval can complete each:
 *  pos_days_closed counts closed core.shift rows (shift_log_v1; a live POS close is caught by the daily pass),
 *  settlements_imported core.settlement periods (payout_statement), bank_imported core.bank_line dates (bank_statement). */
const CLOSE_ITEM_KINDS: Readonly<Record<string, string>> = {
  pos_days_closed: "shift_log", settlements_imported: "payout_statement", bank_imported: "bank_statement",
};

const RANK = { step: 1, plan: 2, auto: 3 } as const;
const covers = (viewer: "*" | readonly string[], scope: readonly string[]) =>
  viewer === "*" || (scope[0] !== "*" && scope.every((o) => viewer.includes(o)));
const svcCtx = (tenantId: string) => ({ tenant_id: tenantId, outlet_ids: "*" as const, role: "service" as const });
/** Resumable stops: waiting for data, or the budget (re-checked each time). An abstain waits for a person. */
const RESUMABLE = `(i.stop_reason IS NULL OR i.stop_reason IN ('waiting', 'budget'))`;

/** `:approve-plan {mode: "auto"}` inside approvePlan's transaction, the investigation row locked. true = a replay. */
export async function approveAuto(q: Queryable, m: Member, id: string,
  inv: { mode: string; status: string; plan_approved_by: string | null }): Promise<boolean> {
  await assertModeAllowed(q, m, "auto");
  if (inv.mode === "auto") return true;
  if (inv.mode !== "plan" || inv.plan_approved_by !== null || (inv.status !== "open" && inv.status !== "waiting")) throw new ApiError("illegal_transition");
  await q.query(`UPDATE core.investigation SET plan_approved_by = $2, mode = 'auto', stop_reason = NULL WHERE id = $1`, [id, m.member_id]);
  await q.query(
    `INSERT INTO core.investigation_grant (tenant_id, id, investigation_id, member_id, outlet_scope)
     SELECT tenant_id, $2, id, created_by, outlet_scope FROM core.investigation WHERE id = $1`, [id, uuidv7()]);
  await notifyInbox(q, m.tenant_id, id);
  return false;
}

/** The member as their membership stands now (as requireMember resolves it), or null when it is gone. */
async function currentMember(q: Queryable, tenantId: string, memberId: string): Promise<Member | null> {
  const r = await q.query<{ role: MemberRole; outlet_ids: string[] }>(
    `SELECT ms.role, ms.outlet_ids FROM core.member mb JOIN core.membership ms ON ms.tenant_id = mb.tenant_id AND ms.member_id = mb.id
      WHERE mb.id = $1 AND mb.active AND ms.active`, [memberId]);
  const row = r.rows[0];
  if (!row) return null;
  const scope = outletScopeOf(row);
  return { kind: "member", tenant_id: tenantId, member_id: memberId, role: row.role, outlet_ids: scope.includes("*") ? "*" : scope };
}

/** The import kinds an investigation waits on: its gate's close items not done in the gate's latest snapshots (all
 *  of the gate's items when those cannot be read, e.g. not minted above the creator's role). */
async function waitedKinds(q: Queryable, inv: { playbook_id: string; checklist: ChecklistEntry[] }): Promise<string[]> {
  const pb = PLAYBOOKS[inv.playbook_id];
  const gate = pb?.items.find((i) => i.item_id === pb.gate);
  if (!gate || gate.verdict.kind !== "close_status") return [];
  let open: readonly string[] = gate.verdict.items;
  const ids = inv.checklist.find((c) => c.item_id === gate.item_id)?.snapshot_ids ?? [];
  if (ids.length > 0) {
    const s = await q.query<{ rows: Array<{ item_code?: unknown; done?: unknown }> }>(`SELECT rows FROM evidence.snapshot WHERE id = ANY ($1::uuid[])`, [ids]);
    if (s.rows.length === ids.length) open = open.filter((code) => s.rows.some((x) => !x.rows.some((r) => r.item_code === code && r.done === true)));
  }
  return [...new Set(open.flatMap((code) => (CLOSE_ITEM_KINDS[code] ? [CLOSE_ITEM_KINDS[code]] : [])))];
}

/** Every `auto` investigation waiting on an import kind that an approved import of the tenant committed after its last
 *  step: one resumption each. */
export async function resumeOnImports(deps: AutoDeps, tenantId: string): Promise<AutoTally> {
  const due = await withContext(deps.svc, svcCtx(tenantId), async (q) => {
    const c = await q.query<{ id: string; playbook_id: string; checklist: ChecklistEntry[]; last: Date }>(
      `SELECT i.id, i.playbook_id, i.checklist,
              coalesce((SELECT max(s.started_at) FROM core.investigation_step s WHERE s.tenant_id = i.tenant_id AND s.investigation_id = i.id), i.plan_approved_at) AS last
         FROM core.investigation i
        WHERE i.mode = 'auto' AND i.status = 'waiting' AND ${RESUMABLE}
        ORDER BY i.created_at, i.id`);
    const out: Array<{ id: string; since: Date }> = [];
    for (const inv of c.rows) {
      const kinds = await waitedKinds(q, inv);
      if (kinds.length === 0) continue;
      const at = await q.query<{ at: Date | null }>(
        `SELECT max(d.decided_at) AS at FROM core.import_run r JOIN core.decision d ON d.tenant_id = r.tenant_id AND d.id = r.decision_id
          WHERE r.status = 'committed' AND r.kind = ANY ($1::text[]) AND d.decided_at > $2`, [kinds, inv.last]);
      if (at.rows[0]?.at) out.push({ id: inv.id, since: at.rows[0].at });
    }
    return out;
  });
  return tallyOf(deps, tenantId, due, false);
}

/** Every open or waiting `auto` investigation with no step since `since` (the day's boundary) whose data changed (the check is
 *  `autoStep`'s, inside the row lock): one resumption each. */
export async function resumeDaily(deps: AutoDeps, tenantId: string, since: Date): Promise<AutoTally> {
  const due = await withContext(deps.svc, svcCtx(tenantId), async (q) => (await q.query<{ id: string }>(
    `SELECT i.id FROM core.investigation i
      WHERE i.mode = 'auto' AND i.status IN ('open', 'waiting') AND ${RESUMABLE}
        AND coalesce((SELECT max(s.started_at) FROM core.investigation_step s WHERE s.tenant_id = i.tenant_id AND s.investigation_id = i.id),
                     i.plan_approved_at) < $1
      ORDER BY i.created_at, i.id`, [since])).rows.map((r) => ({ id: r.id, since })));
  return tallyOf(deps, tenantId, due, true);
}

async function tallyOf(deps: AutoDeps, tenantId: string, due: ReadonlyArray<{ id: string; since: Date }>, needsNewData: boolean): Promise<AutoTally> {
  const t: AutoTally = { resumed: 0, steps: 0, cancelled: 0, budget: 0, ceiling: 0 };
  for (const d of due) {
    const r = await resume(deps, tenantId, d.id, d.since, needsNewData);
    if (r.steps > 0) t.resumed++;
    t.steps += r.steps;
    if (r.stop === "cancelled" || r.stop === "budget" || r.stop === "ceiling") t[r.stop]++;
  }
  return t;
}

type Gate = { kind: "since"; at: Date; needsNewData: boolean } | { kind: "after"; step_no: number };
type Outcome =
  | { kind: "stopped"; stop: "none" | "cancelled" | "budget" | "ceiling" }
  | { kind: "stepped"; m: Member; step_no: number; step: StepResult; run: AutoRun };

/** One resumption: steps until a stop, each in its own transaction (≤ max_steps, so ≤ 10 iterations). */
async function resume(deps: AutoDeps, tenantId: string, id: string, since: Date, needsNewData: boolean): Promise<{ steps: number; stop: string }> {
  let gate: Gate = { kind: "since", at: since, needsNewData };
  let steps = 0;
  for (let i = 0; i < 10; i++) {
    const o = await withContext(deps.svc, svcCtx(tenantId), (q) => autoStep(q, deps.keys, tenantId, id, gate));
    if (o.kind === "stopped") return { steps, stop: o.stop };
    steps++;
    if (o.step.narrate.length > 0) await deps.narrate(o.m, id, o.step_no, o.step, o.run);
    else await endRun({ svc: (s, fn) => withContext(deps.svc, { tenant_id: s.tenantId, outlet_ids: "*", role: "service" }, fn) }, tenantId, o.run.claims.run_id);
    const stop = await withContext(deps.svc, svcCtx(tenantId), async (q) => {
      const a = (await q.query<{ status: string; abstained: boolean | null }>(
        `SELECT i.status, (a.envelope ->> 'abstained')::boolean AS abstained
           FROM core.investigation i
           LEFT JOIN core.investigation_step s ON s.tenant_id = i.tenant_id AND s.investigation_id = i.id AND s.step_no = $2
           LEFT JOIN intel.answer a ON a.tenant_id = s.tenant_id AND a.id = s.summary_answer_id
          WHERE i.id = $1`, [id, o.step_no])).rows[0]!;
      const reason = a.abstained ? "abstain" : a.status === "waiting" ? "waiting" : null;
      if (reason) {
        const u = await q.query(`UPDATE core.investigation SET stop_reason = $2 WHERE id = $1 AND status IN ('open', 'waiting')`, [id, reason]);
        if (u.rowCount === 1) await notifyInbox(q, tenantId, id);
      }
      return reason !== null || a.status !== "open";
    });
    if (stop) return { steps, stop: "none" };
    gate = { kind: "after", step_no: o.step_no };
  }
  return { steps, stop: "none" };
}

/** R47 D4: did data the playbook reads arrive after `since` (the investigation's last step)? Arrival is the row's own record time
 *  (`created_at` / `updated_at` / the import's decision), never its business date: a backfilled day counts, an old day re-read does not.
 *  margin_fall (the only playbook) reads, within its two months (`period_month`, `compare_month`; the bridge's rows, close_status):
 *    - ledger: journal entries dated in the months (postings carry the P&L);
 *    - sales: orders dated in the months whose row changed (completion, price or discount edits are updates);
 *    - stock: receipts and waste (supplier price effect, waste valuation), by the movement's own day;
 *    - close items: closed shifts (pos_days_closed), settlements overlapping the months, bank lines valued in them;
 *    - any import of the tenant committed after `since` (the commit is what brought the rows above in, and a commit that
 *      changed nothing in these months over-includes by one step, which is the safe side).
 *  Month bounds are the pair's earliest start to the later month's end; stock days compare in UTC (one day of slack). */
async function newData(q: Queryable, params: Record<string, unknown>, since: Date): Promise<boolean> {
  const m = [params.period_month, params.compare_month].filter((x): x is string => typeof x === "string");
  if (m.length === 0) return true; // an investigation without months cannot say what is new: resume (the pre-D4 behaviour)
  const r = await q.query<{ fresh: boolean }>(
    `WITH w AS (SELECT least(${m.map((_, i) => `$${i + 2}::date`).join(", ")}) AS lo,
                       (greatest(${m.map((_, i) => `$${i + 2}::date`).join(", ")}) + interval '1 month')::date AS hi)
     SELECT (EXISTS (SELECT 1 FROM core.journal_entry x, w WHERE x.created_at > $1 AND x.entry_date >= w.lo AND x.entry_date < w.hi)
          OR EXISTS (SELECT 1 FROM core."order" x, w WHERE x.updated_at > $1 AND x.business_date >= w.lo AND x.business_date < w.hi)
          OR EXISTS (SELECT 1 FROM core.stock_movement x, w WHERE x.created_at > $1 AND x.kind IN ('receipt', 'waste') AND x.at >= w.lo AND x.at < w.hi + 1)
          OR EXISTS (SELECT 1 FROM core.shift x, w WHERE x.closed_at > $1 AND x.opened_at >= w.lo AND x.opened_at < w.hi + 1)
          OR EXISTS (SELECT 1 FROM core.settlement x, w WHERE x.created_at > $1 AND x.period_to >= w.lo AND x.period_from < w.hi)
          OR EXISTS (SELECT 1 FROM core.bank_line x, w WHERE x.created_at > $1 AND x.value_date >= w.lo AND x.value_date < w.hi)
          OR EXISTS (SELECT 1 FROM core.import_run r JOIN core.decision d ON d.tenant_id = r.tenant_id AND d.id = r.decision_id
                      WHERE r.status = 'committed' AND d.decided_at > $1)) AS fresh`, [since, ...m]);
  return r.rows[0]!.fresh;
}

/** One Auto step in the caller's munim_svc transaction (module header, steps 1–4, then the step itself). */
async function autoStep(q: Queryable, keys: RunTokenKeys, tenantId: string, id: string, gate: Gate): Promise<Outcome> {
  const none = { kind: "stopped", stop: "none" } as const;
  let since = new Date(0);
  const inv = (await q.query<InvestigationRow & { stop_reason: string | null; plan_approved_at: Date | null }>(
    `SELECT ${INVESTIGATION_COLS}, i.plan_approved_at FROM core.investigation i WHERE i.id = $1 FOR UPDATE`, [id])).rows[0];
  if (!inv || inv.mode !== "auto" || (inv.status !== "open" && inv.status !== "waiting")) return none;
  if (gate.kind === "since") {
    if (inv.stop_reason !== null && inv.stop_reason !== "waiting" && inv.stop_reason !== "budget") return none;
    // Read after the lock (a fresh snapshot): a step another worker committed while this one waited is seen here.
    since = (await q.query<{ last: Date | null }>(
      `SELECT max(started_at) AS last FROM core.investigation_step WHERE investigation_id = $1`, [id])).rows[0]!.last ?? inv.plan_approved_at ?? new Date(0);
    if (since >= gate.at) return none;
  } else if (inv.steps_done !== gate.step_no || inv.status !== "open") return none;
  const grant = (await q.query<{ id: string }>(
    `SELECT id FROM core.investigation_grant WHERE investigation_id = $1 AND revoked_at IS NULL`, [id])).rows[0];
  if (!grant) return none;
  const m = await currentMember(q, tenantId, inv.created_by);
  if (!m || !covers(m.outlet_ids, inv.outlet_scope)) {
    await q.query(`UPDATE core.investigation SET status = 'cancelled', stop_reason = 'scope' WHERE id = $1`, [id]);
    await notifyInbox(q, tenantId, id);
    return { kind: "stopped", stop: "cancelled" };
  }
  if (RANK[await ceilingFor(q, m.role)] < RANK.auto) {
    // 0027 ceiling_downgrade: this write also sets mode = 'plan'.
    await q.query(`UPDATE core.investigation SET stop_reason = 'ceiling' WHERE id = $1`, [id]);
    await notifyInbox(q, tenantId, id);
    return { kind: "stopped", stop: "ceiling" };
  }
  // After access and ceiling (both act the same day, data or not), before the budget: that stops a run that would step, and
  // with nothing new it would not.
  if (gate.kind === "since" && gate.needsNewData && !(await newData(q, inv.params, since))) return none;
  const cap = await effectiveCap(q);
  if (!cap || cap.left_minor <= 0) {
    const u = await q.query(`UPDATE core.investigation SET stop_reason = 'budget' WHERE id = $1 AND stop_reason IS DISTINCT FROM 'budget'`, [id]);
    if (u.rowCount === 1) await notifyInbox(q, tenantId, id);
    return { kind: "stopped", stop: "budget" };
  }
  const run = await mintRunTokenIn(q, keys, {
    tenantId, outletScope: inv.outlet_scope as OutletScope, trigger: "auto_step", actor: m.member_id, grantId: grant.id,
  });
  const stepNo = inv.steps_done + 1;
  const step = await runStep(q, m, id, stepNo, "auto", { run_id: run.claims.run_id, grant_id: grant.id });
  return { kind: "stepped", m, step_no: stepNo, step, run };
}
