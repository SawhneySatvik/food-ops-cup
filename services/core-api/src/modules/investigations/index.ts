// Investigations, core half (ledger R45 F1, F10; ADR-014 §7.2–§7.5; T-083 Step, T-084b routes, T-089a Plan). Mount name:
// `investigations`.
//   POST /v1/investigations                    {investigation_id, playbook_id, params, outlet_scope?, mode?} → 201 view
//   GET  /v1/investigations                    ?status=&cursor=&limit= → items in the caller's outlet scope
//   GET  /v1/investigations/{id}               → view (404 outside the caller's outlet scope)
//   POST /v1/investigations/{id}:continue      {step_no} → 200 view after exactly that step
//   POST /v1/investigations/{id}:cancel        {} → 200 view, cancelled (the creator; a repeat replays)
//   POST /v1/investigations/{id}:approve-plan  {mode?} → 200 view after the plan's steps ran in this request (plan.ts);
//                                              mode `auto` also gives the standing grant core-worker resumes under (auto.ts)
// The rows are operational (0020), written in the member's own request as munim_core; no book is touched, so no
// command log: the client's investigation id and step number are the idempotency keys, and cancel and plan approval
// are set once (a replay answers the current view with `X-Munim-Replayed: true`). The mode is checked against the
// role's ceiling (T-090) at create and at plan approval. Every write to core.investigation wakes `inbox:<tenant>`
// (stream/feed.ts `inbox.investigation`). A step is decided in one transaction (step.ts); then core mints an `ask` run
// (actor = the member, scope = the investigation's) and asks intel to narrate the step's items (NarratePort, one L1
// call, no tools). Whatever intel did, core then stores its own template narration under the same answer id through
// the internal answers path — a no-op when intel already stored one — so a down, slow or over-budget intel leaves a
// template summary and the status is computed either way (rule 11). The answer is linked to the step once (0020).
// Signatures ("{Specialist}") are composed here from the playbook; intel's payload has no field for them.
// Auto (T-089b): `mode: "auto"` at create opens a plan (0020: auto needs an approved plan, so the row is `plan` until
// `:approve-plan {mode: "auto"}` turns it to `auto` with the grant); core-worker's steps narrate through `autoDeps`.
import { AnswerEnvelope, anyRefTokens, parseRef, REPLAYED_HEADER } from "@munim/contracts";
import {
  ApprovePlanRequest, CancelInvestigationRequest, ContinueInvestigationRequest, CreateInvestigationRequest, InvestigationStatus, NarrateResponse,
} from "@munim/contracts/investigations";
import { PLAYBOOKS } from "@munim/core-domain/investigations";
import { Hono, type Context } from "hono";
import type pg from "pg";
import { contextOf, requireMember } from "../../auth/resolve.ts";
import { uuidv7 } from "../../commit/index.ts";
import type { Run } from "../../internal/auth.ts";
import { writeAnswer } from "../../internal/writes.ts";
import { withContext } from "../../lib/db.ts";
import { ApiError } from "../../lib/errors.ts";
import type { AppEnv, Deps } from "../../lib/types.ts";
import { endRun, mintRunTokenIn, type OutletScope, type Queryable, type RunTokenKeys } from "../../runtoken/index.ts";
import { type AutoDeps, type AutoRun } from "./auto.ts";
import { assertModeAllowed } from "../ai_policy/index.ts";
import { cellOf, loadSnapshots, type Member } from "../approvals/index.ts";
import { CURSOR_SQL, makeCursor, parseCursor, parseLimit } from "../findings/index.ts";
import { approvePlan, mintEstimate, type PlanRow, planPreview } from "./plan.ts";
import { minRoles, PLAYBOOK_IDS, RESTRICTED, restrictedStopReason, roleOpens, statusVisible } from "./redact.ts";
import {
  type ChecklistEntry, freshChecklist, INVESTIGATION_COLS, type InvestigationRow, type ItemUpdate, notifyInbox, runStep, type StepResult, templateSegments,
} from "./step.ts";

export { createHttpNarratePort, type HttpNarratePortOptions, NARRATE_TIMEOUT_MS } from "./narrateport.ts";
export { type AutoDeps, type AutoTally, resumeDaily, resumeOnImports } from "./auto.ts";

/** core → intel `/investigate:narrate` with the step's run token; resolves to intel's JSON body (validated here). */
export type NarratePort = (runToken: string, body: unknown) => Promise<unknown>;
export interface InvestigationsConfig { keys: RunTokenKeys; narrate: NarratePort | null }

const configs = new WeakMap<Deps, InvestigationsConfig>();
/** Wires narration into one composed app, keyed by that Deps object (as configureThreads). Unconfigured, steps are
 *  still decided and stored; they carry no narration. */
export function configureInvestigations(deps: Deps, cfg: InvestigationsConfig): void {
  configs.set(deps, cfg);
}

const ID = "[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}";

function member(c: Context<AppEnv>): Member {
  const p = c.var.principal;
  if (p.kind !== "member") throw new ApiError("forbidden");
  return p;
}

const svc = <T>(pool: pg.Pool, tenantId: string, scope: OutletScope, fn: (q: Queryable) => Promise<T>) =>
  withContext(pool, { tenant_id: tenantId, outlet_ids: scope[0] === "*" ? "*" : scope, role: "service" }, fn);

const signature = (specialist: string) => ({ key: "investigation.signature.specialist" as const, specialist, name_key: `specialist.${specialist}.name` });
const covers = (viewer: "*" | readonly string[], scope: readonly string[]) =>
  viewer === "*" || (scope[0] !== "*" && scope.every((o) => viewer.includes(o)));
const sameParams = (a: Record<string, unknown>, b: Record<string, unknown>) =>
  Object.keys(a).length === Object.keys(b).length && Object.entries(a).every(([k, v]) => b[k] === v);
const actionId = (c: Context<AppEnv>, verb: string) => c.req.param("action")!.slice(0, -verb.length);

type ItemRow = Omit<InvestigationRow, "checklist"> & { stop_reason: string | null; created_at: Date; updated_at: Date };
const itemView = (inv: ItemRow) => ({
  investigation_id: inv.id, playbook_id: inv.playbook_id, params: inv.params, outlet_scope: inv.outlet_scope, mode: inv.mode,
  status: inv.status, stop_reason: inv.stop_reason, created_by: inv.created_by, steps_done: inv.steps_done, max_steps: inv.max_steps,
  created_at: inv.created_at.toISOString(), updated_at: inv.updated_at.toISOString(),
});

interface StepRow {
  step_no: number; member_id: string; triggered_by: "member" | "plan" | "auto"; started_at: Date; item_updates: ItemUpdate[];
  tainted: boolean; summary_answer_id: string | null; envelope: unknown;
}

/** The investigation as this member may see it, or null (RLS: outside their scope → 404). Verdicts the viewer may not
 *  read are `restricted` (redact.ts). */
export async function investigationView(q: Queryable, m: Member, id: string) {
  const r = await q.query<InvestigationRow & ItemRow & Omit<PlanRow, "id">>(
    `SELECT ${INVESTIGATION_COLS}, i.plan_approved_by, i.plan_approved_at FROM core.investigation i WHERE i.id = $1`, [id]);
  const inv = r.rows[0];
  if (!inv) return null;
  const pb = PLAYBOOKS[inv.playbook_id]!;
  const steps = await q.query<StepRow>(
    `SELECT s.step_no, s.member_id, s.triggered_by, s.started_at, s.item_updates, s.tainted, s.summary_answer_id, a.envelope
       FROM core.investigation_step s LEFT JOIN intel.answer a ON a.tenant_id = s.tenant_id AND a.id = s.summary_answer_id
      WHERE s.investigation_id = $1 ORDER BY s.step_no`, [id]);
  const byId = new Map(pb.items.map((i) => [i.item_id, i]));
  const mins = await minRoles(q, [...new Set(pb.items.map((i) => i.template_id))]);
  const opened = await loadSnapshots(q, [...inv.checklist.flatMap((c) => c.snapshot_ids), ...steps.rows.flatMap((s) => s.item_updates.flatMap((u) => u.snapshot_ids))], m);
  const opens = (itemId: string, snapshotIds: readonly string[]) =>
    roleOpens(m.role, mins.get(byId.get(itemId)?.template_id ?? "")) && snapshotIds.every((s) => opened.has(s));
  const stepViews = steps.rows.map((s) => {
    const env = s.envelope ? AnswerEnvelope.parse(s.envelope) : null;
    // Segment i narrates the i-th update that cited cells (step.ts narrates exactly those, in order); a restricted
    // item's segment and signature are dropped together.
    const narrated = s.item_updates.filter((u) => u.refs.length > 0);
    const keep = narrated.map((u) => opens(u.item_id, u.snapshot_ids));
    const shown = env && !env.abstained ? { ...env, segments: env.segments.filter((_, i) => keep[i]) } : env;
    return {
      step_no: s.step_no, member_id: s.member_id, triggered_by: s.triggered_by, started_at: s.started_at.toISOString(),
      item_updates: s.item_updates.map((u) => (opens(u.item_id, u.snapshot_ids) ? u
        : { ...u, from: RESTRICTED, to: RESTRICTED, frozen: false, reopened: false, snapshot_ids: [], refs: [] })),
      tainted: s.tainted,
      narration: shown && s.summary_answer_id
        ? { answer_id: s.summary_answer_id, envelope: shown, signatures: env!.abstained ? [] : narrated.map((u) => signature(u.specialist)).filter((_, i) => keep[i]) }
        : null,
    };
  });
  const checklist = inv.checklist.map((c: ChecklistEntry) => {
    const shown = opens(c.item_id, c.snapshot_ids);
    return {
      item_id: c.item_id, label_key: byId.get(c.item_id)!.label_key, specialist: c.specialist, signature: signature(c.specialist),
      status: shown ? c.status : RESTRICTED, frozen: shown && c.frozen, snapshot_ids: shown ? c.snapshot_ids : [], refs: shown ? c.refs : [],
    };
  });
  // stop_reason `waiting` would name the gate's verdict: hidden with the status (the creator still sees `ceiling`, redact.ts).
  if (!(await statusVisible(q, m.role, [inv.playbook_id])).has(inv.playbook_id)) {
    Object.assign(inv, { status: RESTRICTED, stop_reason: restrictedStopReason(inv.stop_reason, inv.created_by, m.member_id) });
  }
  const plan = inv.mode === "step" ? null : await planPreview(q, m, inv, pb);
  const refs = new Set<string>([...checklist.flatMap((c) => c.refs), ...stepViews.flatMap((s) => s.item_updates.flatMap((u) => u.refs))]);
  for (const ref of [plan?.estimate.estimate_ref, plan?.estimate.currency_ref]) if (ref) refs.add(ref);
  for (const s of stepViews) for (const seg of s.narration?.envelope.segments ?? []) for (const t of seg.text.matchAll(anyRefTokens())) refs.add(t[0]);
  const snapIds = [...refs].map((x) => parseRef(x)).flatMap((p) => (p?.kind === "snap" ? [p.snapshot_id] : []));
  const snaps = await loadSnapshots(q, snapIds, m);
  const resolved = [...refs].flatMap((ref) => {
    const cell = cellOf(ref, snaps);
    return cell ? [{ ref, value: cell.value }] : [];
  });
  return { ...itemView(inv), checklist, plan, steps: stepViews, resolved_refs: resolved };
}

/** Narrates a committed step (ADR-014 §7.2 step 5) under an `ask` run minted for it. */
async function narrateStep(deps: Deps, m: Member, id: string, stepNo: number, step: StepResult): Promise<void> {
  const cfg = configs.get(deps);
  if (!cfg || step.narrate.length === 0) return;
  const minted = await svc(deps.pools.svc, m.tenant_id, step.scope, (q) =>
    mintRunTokenIn(q, cfg.keys, { tenantId: m.tenant_id, outletScope: step.scope, trigger: "ask", actor: m.member_id }));
  await narrateRun(deps.pools.svc, cfg, deps.log, m, id, stepNo, step, minted, (fn) => withContext(deps.pools.core, contextOf(m), fn));
}

/** core-worker's Auto narration (auto.ts): the step's own `auto_step` run, its answer linked on munim_svc. */
export function autoDeps(o: { svc: pg.Pool; keys: RunTokenKeys; narrate: NarratePort | null; log: (msg: string) => void }): AutoDeps {
  return {
    svc: o.svc, keys: o.keys, log: o.log,
    narrate: (m, id, stepNo, step, run) => narrateRun(o.svc, { keys: o.keys, narrate: o.narrate }, o.log, m, id, stepNo, step, run,
      (fn) => withContext(o.svc, { tenant_id: m.tenant_id, outlet_ids: "*", role: "service" }, fn)),
  };
}

/** Narrates under `minted` (its run ends here), then links the answer to the step through `link`. Never throws for
 *  intel's sake: a failed port leaves the template. */
async function narrateRun(pool: pg.Pool, cfg: InvestigationsConfig, log: (msg: string) => void, m: Member, id: string, stepNo: number,
  step: StepResult, { token, claims }: AutoRun, link: (fn: (q: Queryable) => Promise<void>) => Promise<void>): Promise<void> {
  const answerId = uuidv7();
  const question = `investigation ${step.playbook.playbook_id} step`;
  const template = templateSegments(step.narrate);
  const run: Run = { tenantId: m.tenant_id, runId: claims.run_id, scope: step.scope, actor: claims.actor, trigger: claims.trigger };
  let reported: boolean | null = null;
  try {
    if (cfg.narrate) {
      try {
        const out = NarrateResponse.safeParse(await cfg.narrate(token, {
          answer_id: answerId, question, playbook_id: step.playbook.playbook_id, owner: step.playbook.owner,
          items: step.narrate.map((n, i) => ({
            item_id: n.item.item_id, specialist: n.item.specialist, verdict: n.status,
            cells: n.cells.map((c) => ({ ref: `⟨snap:${c.snapshot_id}·${c.row}·${c.column}⟩`, column: c.column })),
            template: template[i]!.text,
          })),
        }));
        if (out.success && out.data.answer_id === answerId) reported = out.data.tainted;
      } catch (e) {
        log(`investigations: narration fell back to the template (${(e as Error).name})`);
      }
    }
    // A no-op when intel stored its answer under this id; otherwise core's template is the narration.
    await svc(pool, m.tenant_id, step.scope, (q) =>
      writeAnswer(q, run, { question, envelope: { answer_id: answerId, segments: template, abstained: false, reason_code: null } }));
  } finally {
    await endRun({ svc: (s, fn) => svc(pool, s.tenantId, s.outletScope, fn) }, m.tenant_id, claims.run_id);
  }
  await link(async (q) => {
    const a = await q.query<{ envelope: unknown }>(`SELECT envelope FROM intel.answer WHERE id = $1 AND run_id = $2 AND question = $3`, [answerId, claims.run_id, question]);
    if (!a.rows[0]) return;
    // Signatures go to segments by position (investigationView): an answer with another segment count is not linked.
    const env = AnswerEnvelope.parse(a.rows[0].envelope);
    if (!env.abstained && env.segments.length !== step.narrate.length) return;
    // Taint from the stored answer, not only intel's word (R-D): intel's report, any cited source other than a core
    // snapshot, or an answer intel stored without reporting its taint (fail closed) taints the step.
    const template_ = !env.abstained && env.segments.every((s, i) => s.text === template[i]!.text);
    const tainted = reported === true || env.segments.some((s) => s.refs.some((r) => !r.startsWith("snap:"))) || (reported === null && !template_);
    await q.query(`UPDATE core.investigation_step SET run_id = $3, summary_answer_id = $4, tainted = $5 WHERE investigation_id = $1 AND step_no = $2`,
      [id, stepNo, claims.run_id, answerId, tainted]);
    // The narration moves the investigation (SSE `inbox.investigation` re-reads by updated_at; R-D).
    await q.query(`UPDATE core.investigation SET updated_at = now() WHERE id = $1`, [id]);
    await notifyInbox(q, m.tenant_id, id);
  });
}

/** One step end to end — decided and stored in one transaction, then narrated — as the `:continue` route runs it.
 *  T-089a's plan runner calls this once per step with `trigger = "plan"` inside the approving member's request. */
export async function continueInvestigation(deps: Deps, m: Member, id: string, stepNo: number, trigger: "member" | "plan" = "member"): Promise<{ replayed: boolean }> {
  const step = await withContext(deps.pools.core, contextOf(m), (q) => runStep(q, m, id, stepNo, trigger));
  if (!step.replayed) await narrateStep(deps, m, id, stepNo, step);
  return { replayed: step.replayed };
}

async function body(c: Context<AppEnv>): Promise<unknown> {
  const raw: unknown = await c.req.json().catch(() => undefined);
  if (raw === undefined) throw new ApiError("bad_request");
  return raw;
}

export const router = new Hono<AppEnv>()
  .post("/v1/investigations", requireMember, async (c) => {
    const m = member(c);
    const req = CreateInvestigationRequest.safeParse(await body(c));
    if (!req.success) throw new ApiError("invalid_payload");
    const { investigation_id: id, playbook_id, params } = req.data;
    const mode = req.data.mode ?? "step";
    if (m.outlet_ids !== "*" && m.outlet_ids.length === 0) throw new ApiError("forbidden");
    const scope = req.data.outlet_scope ?? (m.outlet_ids === "*" ? ["*"] : m.outlet_ids);
    // Wider than the creator's own scope: not theirs to see (review M7, as an outlet-scoped GET).
    if (!covers(m.outlet_ids, scope)) throw new ApiError("not_found");
    const out = await withContext(c.var.deps.pools.core, contextOf(m), async (q) => {
      // F10: the mode is the creator's pick within their role's ceiling (403 mode_above_ceiling). Auto needs an approved
      // plan and a standing grant (0020 CHECK, F11 O-1), so it is stored as a plan until `:approve-plan {mode: "auto"}`.
      await assertModeAllowed(q, m, mode);
      const stored = mode === "auto" ? "plan" : mode;
      const prior = await q.query<{ playbook_id: string; params: Record<string, unknown>; outlet_scope: string[]; created_by: string; mode: string }>(
        `SELECT playbook_id, params, outlet_scope::text[] AS outlet_scope, created_by, mode FROM core.investigation WHERE id = $1`, [id]);
      const p = prior.rows[0];
      if (p) {
        const same = p.created_by === m.member_id && p.playbook_id === playbook_id && sameParams(p.params, params)
          && (p.mode === stored || (mode === "auto" && p.mode === "auto"))
          && p.outlet_scope.length === scope.length && p.outlet_scope.every((o, i) => o === scope[i]);
        if (!same) throw new ApiError("idempotency_conflict");
        return { replayed: true, view: (await investigationView(q, m, id))! };
      }
      try {
        await q.query(
          `INSERT INTO core.investigation (tenant_id, id, playbook_id, params, outlet_scope, created_by, checklist, mode) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
          [m.tenant_id, id, playbook_id, JSON.stringify(params), scope, m.member_id, JSON.stringify(freshChecklist(PLAYBOOKS[playbook_id]!)), stored]);
      } catch (e) {
        // The id is taken by an investigation this member cannot see.
        if ((e as { code?: unknown }).code === "23505") throw new ApiError("idempotency_conflict");
        throw e;
      }
      if (stored === "plan") await mintEstimate(q, m, id, scope as OutletScope);
      await notifyInbox(q, m.tenant_id, id);
      return { replayed: false, view: (await investigationView(q, m, id))! };
    });
    return c.json(out.view, 201, out.replayed ? { [REPLAYED_HEADER]: "true" } : {});
  })
  .get("/v1/investigations", requireMember, async (c) => {
    const m = member(c);
    const q = c.req.query();
    const limit = parseLimit(q.limit);
    const after = parseCursor(q.cursor);
    if (limit === null || (q.cursor !== undefined && !after) || (q.status !== undefined && !InvestigationStatus.safeParse(q.status).success)) {
      throw new ApiError("bad_request");
    }
    // RLS (0020 scope rule) leaves exactly the investigations this member's outlet scope covers.
    return c.json(await withContext(c.var.deps.pools.core, contextOf(m), async (db) => {
      // A status the viewer may not read is `restricted`, and ?status= matches only statuses they may read (else the
      // filter would tell them the verdict; redact.ts).
      const visible = [...(await statusVisible(db, m.role, PLAYBOOK_IDS))];
      const r = await db.query<ItemRow & { cursor: string }>(
        `SELECT ${INVESTIGATION_COLS}, ${CURSOR_SQL("i")} AS cursor FROM core.investigation i
          WHERE ($1::text IS NULL OR (i.status = $1 AND i.playbook_id = ANY ($5::text[])))
            AND ($2::timestamptz IS NULL OR (i.updated_at, i.id) < ($2::timestamptz, $3::uuid))
          ORDER BY i.updated_at DESC, i.id DESC LIMIT $4`,
        [q.status ?? null, after?.[0] ?? null, after?.[1] ?? null, limit + 1, visible]);
      const page = r.rows.slice(0, limit).map((x) => (visible.includes(x.playbook_id) ? x : { ...x, status: RESTRICTED, stop_reason: restrictedStopReason(x.stop_reason, x.created_by, m.member_id) }));
      return { items: page.map(itemView), next_cursor: r.rows.length > limit ? makeCursor(page.at(-1)!.cursor) : null };
    }), 200);
  })
  .get(`/v1/investigations/:id{${ID}}`, requireMember, async (c) => {
    const m = member(c);
    const view = await withContext(c.var.deps.pools.core, contextOf(m), (q) => investigationView(q, m, c.req.param("id")));
    if (!view) throw new ApiError("not_found");
    return c.json(view, 200);
  })
  .post(`/v1/investigations/:action{${ID}:continue}`, requireMember, async (c) => {
    const m = member(c);
    const id = c.req.param("action")!.slice(0, -":continue".length);
    const req = ContinueInvestigationRequest.safeParse(await body(c));
    if (!req.success) throw new ApiError("invalid_payload");
    const deps = c.var.deps;
    const step = await continueInvestigation(deps, m, id, req.data.step_no);
    const view = await withContext(deps.pools.core, contextOf(m), (q) => investigationView(q, m, id));
    if (!view) throw new ApiError("not_found");
    return c.json(view, 200, step.replayed ? { [REPLAYED_HEADER]: "true" } : {});
  })
  .post(`/v1/investigations/:action{${ID}:cancel}`, requireMember, async (c) => {
    const m = member(c);
    const id = actionId(c, ":cancel");
    if (!CancelInvestigationRequest.safeParse(await body(c)).success) throw new ApiError("invalid_payload");
    // The creator cancels their own open or waiting investigation (ADR-014 §7.4); already cancelled is a replay. The
    // row lock orders it against a step in flight: that step commits first, or sees `cancelled` and refuses (409).
    const out = await withContext(c.var.deps.pools.core, contextOf(m), async (q) => {
      const r = await q.query<{ created_by: string; status: string }>(`SELECT created_by, status FROM core.investigation WHERE id = $1 FOR UPDATE`, [id]);
      const inv = r.rows[0];
      if (!inv) throw new ApiError("not_found");
      if (inv.created_by !== m.member_id) throw new ApiError("forbidden");
      const replayed = inv.status === "cancelled";
      if (!replayed) {
        if (inv.status !== "open" && inv.status !== "waiting") throw new ApiError("illegal_transition");
        await q.query(`UPDATE core.investigation SET status = 'cancelled' WHERE id = $1`, [id]);
        await notifyInbox(q, m.tenant_id, id);
      }
      return { replayed, view: (await investigationView(q, m, id))! };
    });
    return c.json(out.view, 200, out.replayed ? { [REPLAYED_HEADER]: "true" } : {});
  })
  .post(`/v1/investigations/:action{${ID}:approve-plan}`, requireMember, async (c) => {
    const m = member(c);
    const id = actionId(c, ":approve-plan");
    const req = ApprovePlanRequest.safeParse(await body(c));
    if (!req.success) throw new ApiError("invalid_payload");
    const deps = c.var.deps;
    const out = await approvePlan(deps, m, id, continueInvestigation, req.data.mode ?? "plan");
    // Read as the member stands after the run: one whose access went mid-plan no longer sees it (review M7).
    const now = out.member;
    const view = now && (await withContext(deps.pools.core, contextOf(now), (q) => investigationView(q, now, id)));
    if (!view) throw new ApiError("not_found");
    return c.json(view, 200, out.replayed ? { [REPLAYED_HEADER]: "true" } : {});
  });
