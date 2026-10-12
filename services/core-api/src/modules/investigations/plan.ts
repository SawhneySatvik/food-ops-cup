// Investigation Plan mode (ledger R45 F10; BOARD T-089a). The creator sees a preview — the playbook's checklist items,
// the specialists involved and the estimated AI cost — approves it once, and the steps then run without further clicks.
//   - The estimate is an `intel.investigation_cost_estimate` snapshot (v2, 0025) minted for the creator when the plan is
//     opened (in that transaction, so the template sees the new checklist and step count). v2 prices per STEP, not per
//     item (one step judges every evaluable item in one call): estimate_minor = per_step_minor (the playbook's average
//     spend per run-linked step, zero-spend steps included) × remaining_steps (max_steps − steps done, capped by the
//     checklist items not yet frozen). The preview cites its cells; no number is typed.
//   - `:approve-plan` is the member's own act on an operational row: `plan_approved_by` is stamped once, by the
//     signed-in member (0020 investigation_rules), after the role ceiling is checked in the same transaction (T-090).
//     A repeat by the same member is a replay: the current view, no further steps (`:continue` is what resumes).
//   - The approved steps run synchronously INSIDE the approving request (no core-api background loop, R35): the
//     member's verified identity supplies the scope for the R40 C4 member-minted snapshots. Each step is the
//     `:continue` code path (`step`), in its own transaction, `triggered_by = plan`, so a dropped request leaves every
//     finished step durable and gapless.
//   - Before each step core re-reads the member's CURRENT membership (the request's principal is stale by then): access
//     to the investigation's outlets gone → cancelled, stop_reason `scope` (review M7, F10); and the month's AI budget
//     (T-090 effectiveCap): none set or none left → stop_reason `budget` before the step, so no further model call.
//     The role's ceiling is re-checked too (R-D): lowered below `plan`, or the member demoted to such a role → the run
//     stops with stop_reason `scope` before the step (`ceiling`, 0027, is Auto's downgrade to Plan; Plan → Step is not ruled).
//   - After each step: an abstained narration → `abstain`; `waiting` → `waiting`; any terminal status ends the run.
//     Investigations create no drafts and nothing links one in v1 (ADR-014 §7.2), so `draft` is never recorded here.
//   - `mode: "auto"` (T-089b) approves the same plan as Auto: the mode and the creator's standing grant are written in the
//     approving transaction (auto.ts approveAuto), and the in-request steps run exactly as Plan's.
import { outletScopeOf } from "@munim/core-domain/authority";
import { type Playbook } from "@munim/core-domain/investigations";
import { contextOf, type MemberRole } from "../../auth/resolve.ts";
import { withContext } from "../../lib/db.ts";
import { ApiError } from "../../lib/errors.ts";
import type { Deps } from "../../lib/types.ts";
import type { OutletScope, Queryable } from "../../runtoken/index.ts";
import { assertModeAllowed, ceilingFor, effectiveCap } from "../ai_policy/index.ts";
import { loadSnapshots, type Member } from "../approvals/index.ts";
import { mintSnapshot } from "../evidence/index.ts";
import { approveAuto } from "./auto.ts";
import { notifyInbox } from "./step.ts";

export const ESTIMATE_TEMPLATE = "intel.investigation_cost_estimate";
export const ESTIMATE_LABEL = "estimate (computed)" as const;

type StopReason = "abstain" | "budget" | "scope" | "waiting";
/** One step through the `:continue` code path (index.ts continueInvestigation), passed in to keep the modules acyclic. */
export type StepFn = (deps: Deps, m: Member, id: string, stepNo: number, trigger: "plan") => Promise<{ replayed: boolean }>;

const covers = (viewer: "*" | readonly string[], scope: readonly string[]) =>
  viewer === "*" || (scope[0] !== "*" && scope.every((o) => viewer.includes(o)));

/** Core's own reads and its scope cancellation: munim_svc, tenant-wide (0020 lets a service context see every row). */
const svc = <T>(deps: Deps, tenantId: string, fn: (q: Queryable) => Promise<T>) =>
  withContext(deps.pools.svc, { tenant_id: tenantId, outlet_ids: "*", role: "service" }, fn);

/** Mints the plan's cost estimate for its creator, in the transaction that opened the plan, under the investigation's
 *  outlet scope (R-D; a subset of the creator's, which RLS just proved covers it), then restores the transaction's scope.
 *  A template above the creator's role is simply not minted: the preview then reads "cannot verify". */
export async function mintEstimate(q: Queryable, m: Member, id: string, scope: OutletScope): Promise<void> {
  const prior = (await q.query<{ s: string | null }>(`SELECT current_setting('app.outlet_ids', true) AS s`)).rows[0]!.s;
  await q.query(`SELECT set_config('app.outlet_ids', $1, true)`, [scope[0] === "*" ? "{*}" : `{${scope.join(",")}}`]);
  try {
    await mintSnapshot(q, m.tenant_id, { kind: "member", member_id: m.member_id, role: m.role, scope }, ESTIMATE_TEMPLATE, { investigation_id: id });
  } catch (e) {
    if (!(e instanceof ApiError && e.code === "not_found")) throw e;
  }
  await q.query(`SELECT set_config('app.outlet_ids', $1, true)`, [prior ?? ""]);
}

export interface PlanRow { id: string; mode: string; created_by: string; plan_approved_by: string | null; plan_approved_at: Date | null }

/** The preview for a Plan/Auto investigation, as `viewer` may see it: the estimate is the latest estimate snapshot minted
 *  for the creator, in the business's currency (or its only row); not visible or no row → `cannot_verify`. */
export async function planPreview(q: Queryable, viewer: Member, inv: PlanRow, pb: Playbook) {
  const s = await q.query<{ id: string; rows: Array<Record<string, unknown>>; base: string }>(
    `SELECT s.id, s.rows, (SELECT base_currency FROM core.tenant) AS base FROM evidence.snapshot s
      WHERE s.template_id = $1 AND s.params ->> 'investigation_id' = $2 AND s.minted_by_member_id = $3
      ORDER BY s.created_at DESC, s.id DESC LIMIT 1`, [ESTIMATE_TEMPLATE, inv.id, inv.created_by]);
  const snap = s.rows[0];
  const visible = snap ? (await loadSnapshots(q, [snap.id], viewer)).has(snap.id) : false;
  const rows = snap?.rows ?? [];
  const row = rows.length === 1 ? 0 : rows.findIndex((r) => r.currency === snap?.base);
  const ok = visible && row >= 0;
  const ref = (column: string) => (ok ? `⟨snap:${snap!.id}·${row}·${column}⟩` : null);
  return {
    items: pb.items.map((i) => ({ item_id: i.item_id, label_key: i.label_key, specialist: i.specialist })),
    specialists: [...new Set(pb.items.map((i) => i.specialist))],
    estimate: {
      label: ESTIMATE_LABEL, status: ok ? "computed" as const : "cannot_verify" as const, snapshot_id: ok ? snap!.id : null,
      estimate_ref: ref("estimate_minor"), currency_ref: ref("currency"),
    },
    approved_by: inv.plan_approved_by, approved_at: inv.plan_approved_at?.toISOString() ?? null,
  };
}

/** The member as their membership stands now (as requireMember resolves it), or null when it is gone. */
async function currentMember(deps: Deps, m: Member): Promise<Member | null> {
  const r = await withContext(deps.pools.core, { tenant_id: m.tenant_id }, (q) =>
    q.query<{ role: MemberRole; outlet_ids: string[] }>(
      `SELECT ms.role, ms.outlet_ids FROM core.member mb JOIN core.membership ms ON ms.tenant_id = mb.tenant_id AND ms.member_id = mb.id
        WHERE mb.id = $1 AND mb.active AND ms.active`, [m.member_id]));
  const row = r.rows[0];
  if (!row) return null;
  const scope = outletScopeOf(row);
  return { kind: "member", tenant_id: m.tenant_id, member_id: m.member_id, role: row.role, outlet_ids: scope.includes("*") ? "*" : scope };
}

/** Approves the plan (once) and, unless this is a replay, runs its steps inside the caller's request. Returns the
 *  member as they stand after the run (null when their access is gone) for the response's view. */
export async function approvePlan(deps: Deps, m: Member, id: string, step: StepFn, mode: "plan" | "auto" = "plan"): Promise<{ replayed: boolean; member: Member | null }> {
  const replayed = await withContext(deps.pools.core, contextOf(m), async (q) => {
    const r = await q.query<{ created_by: string; mode: string; status: string; plan_approved_by: string | null }>(
      `SELECT created_by, mode, status, plan_approved_by FROM core.investigation WHERE id = $1 FOR UPDATE`, [id]);
    const inv = r.rows[0];
    if (!inv) throw new ApiError("not_found");
    if (inv.created_by !== m.member_id) throw new ApiError("forbidden");
    await assertModeAllowed(q, m, "plan");
    if (mode === "auto") return approveAuto(q, m, id, inv);
    if (inv.plan_approved_by !== null) return true;
    if (inv.mode !== "plan" || (inv.status !== "open" && inv.status !== "waiting")) throw new ApiError("illegal_transition");
    await q.query(`UPDATE core.investigation SET plan_approved_by = $2, stop_reason = NULL WHERE id = $1`, [id, m.member_id]);
    await notifyInbox(q, m.tenant_id, id);
    return false;
  });
  if (replayed) return { replayed, member: m };
  return { replayed, member: await runPlan(deps, m, id, step) };
}

/** The approved steps, one transaction each, until a stop (module header). At most max_steps iterations: every
 *  iteration either commits a step or ends the run. */
async function runPlan(deps: Deps, approver: Member, id: string, step: StepFn): Promise<Member | null> {
  let m: Member | null = approver;
  for (let i = 0; i < 10; i++) {
    const inv = (await svc(deps, approver.tenant_id, (q) => q.query<{ status: string; steps_done: number; outlet_scope: string[] }>(
      `SELECT status, steps_done, outlet_scope::text[] AS outlet_scope FROM core.investigation WHERE id = $1`, [id]))).rows[0]!;
    if (inv.status !== "open" && inv.status !== "waiting") return m;
    m = await currentMember(deps, approver);
    if (!m || !covers(m.outlet_ids, inv.outlet_scope)) {
      await svc(deps, approver.tenant_id, async (q) => {
        const u = await q.query(`UPDATE core.investigation SET status = 'cancelled', stop_reason = 'scope' WHERE id = $1 AND status IN ('open', 'waiting')`, [id]);
        if (u.rowCount === 1) await notifyInbox(q, approver.tenant_id, id);
      });
      return m;
    }
    if ((await svc(deps, approver.tenant_id, (q) => ceilingFor(q, m!.role))) === "step") return stop(deps, m, id, "scope");
    const cap = await svc(deps, approver.tenant_id, (q) => effectiveCap(q));
    if (!cap || cap.left_minor <= 0) return stop(deps, m, id, "budget");
    try {
      await step(deps, m, id, inv.steps_done + 1, "plan");
    } catch (e) {
      // A concurrent :cancel or :continue took the investigation or this step number: the run ends here.
      if (e instanceof ApiError && ["illegal_transition", "sequence_gap", "conflict"].includes(e.code)) return m;
      throw e;
    }
    const after = (await withContext(deps.pools.core, contextOf(m), (q) => q.query<{ status: string; abstained: boolean | null }>(
      `SELECT i.status, (a.envelope ->> 'abstained')::boolean AS abstained
         FROM core.investigation i
         LEFT JOIN core.investigation_step s ON s.tenant_id = i.tenant_id AND s.investigation_id = i.id AND s.step_no = i.steps_done
         LEFT JOIN intel.answer a ON a.tenant_id = s.tenant_id AND a.id = s.summary_answer_id
        WHERE i.id = $1`, [id]))).rows[0]!;
    if (after.abstained) return stop(deps, m, id, "abstain");
    if (after.status === "waiting") return stop(deps, m, id, "waiting");
    if (after.status !== "open") return m;
  }
  return m;
}

async function stop(deps: Deps, m: Member, id: string, reason: StopReason): Promise<Member> {
  await withContext(deps.pools.core, contextOf(m), async (q) => {
    const u = await q.query(`UPDATE core.investigation SET stop_reason = $2 WHERE id = $1 AND status IN ('open', 'waiting')`, [id, reason]);
    if (u.rowCount === 1) await notifyInbox(q, m.tenant_id, id);
  });
  return m;
}
