// Goals and tasks handlers (T-029). goals.goal.create.v1 and goals.task.create.v1 are draftable (R16): the same
// handler runs under a member's own command or under an approved decision. Progress toward a goal is never
// stored — it is a snapshot cell (W3 template); the row holds only the target the owner chose.
import { GoalsGoalCreateV1, GoalsGoalUpdateV1, GoalsTaskCreateV1, GoalsTaskUpdateV1 } from "@munim/contracts/goals";
import type { CommandHandler } from "../../commit/index.ts";
import { ApiError } from "../../lib/errors.ts";
import type { Queryable } from "../../runtoken/index.ts";

const TENANT = `current_setting('app.tenant_id')::uuid`;
const ME = `current_setting('app.member_id')::uuid`;

function parse<T>(schema: { safeParse(v: unknown): { success: true; data: T } | { success: false } }, payload: unknown): T {
  const r = schema.safeParse(payload);
  if (!r.success) throw new ApiError("invalid_payload");
  return r.data;
}

const one = async <T extends object>(c: Queryable, sql: string, params: unknown[]) => (await c.query<T>(sql, params)).rows[0];

export const goalCreate: CommandHandler = {
  type: "goals.goal.create.v1",
  async run(c, cmd) {
    const p = parse(GoalsGoalCreateV1, cmd.payload);
    if (p.due_on <= p.period_from) throw new ApiError("invalid_payload");
    // net_sales is money in the business currency; an order count carries none (DB: currency iff net_sales).
    const currency = p.metric === "net_sales"
      ? (await one<{ cur: string }>(c, `SELECT base_currency AS cur FROM core.tenant WHERE tenant_id = ${TENANT}`, []))!.cur
      : null;
    if (p.basis_snapshot_id !== null && !(await one(c, `SELECT 1 FROM evidence.snapshot WHERE id = $1`, [p.basis_snapshot_id]))) throw new ApiError("not_found");
    const r = await c.query(
      `INSERT INTO core.goal (tenant_id, id, outlet_id, metric, target_value, currency, period_from, due_on, basis_snapshot_id, created_by)
       VALUES (${TENANT}, $1, $2, $3, $4, $5, $6, $7, $8, ${ME}) ON CONFLICT DO NOTHING`,
      [p.goal_id, p.outlet_id, p.metric, p.target_value, currency, p.period_from, p.due_on, p.basis_snapshot_id]);
    if (r.rowCount !== 1) throw new ApiError("conflict");
    return { entityId: p.goal_id, audit: [{ entity: "core.goal", entityId: p.goal_id, after: { metric: p.metric, outlet_id: p.outlet_id, due_on: p.due_on } }] };
  },
};

export const goalUpdate: CommandHandler = {
  type: "goals.goal.update.v1",
  async run(c, cmd) {
    const p = parse(GoalsGoalUpdateV1, cmd.payload);
    const prior = await one<{ status: string }>(c, `SELECT status FROM core.goal WHERE id = $1`, [p.goal_id]);
    if (!prior) throw new ApiError("not_found");
    // Only active goals move (book_status_transition); a closed goal is not reopened.
    if (prior.status !== "active") throw new ApiError("illegal_transition");
    await c.query(`UPDATE core.goal SET status = $2 WHERE id = $1`, [p.goal_id, p.status]);
    return { entityId: p.goal_id, audit: [{ entity: "core.goal", entityId: p.goal_id, before: { status: prior.status }, after: { status: p.status } }] };
  },
};

export const taskCreate: CommandHandler = {
  type: "goals.task.create.v1",
  async run(c, cmd) {
    const p = parse(GoalsTaskCreateV1, cmd.payload);
    if (!(await one(c, `SELECT 1 FROM core.member WHERE id = $1`, [p.assignee_member_id]))) throw new ApiError("not_found");
    // A task cites the finding that prompted it; a finding this tenant cannot see is not a citation.
    if (p.finding_id !== null && !(await one(c, `SELECT 1 FROM intel.finding WHERE id = $1`, [p.finding_id]))) throw new ApiError("not_found");
    // ADR-015 §4: a pack-and-hand-over task names a Munim Cares listing of its own outlet (the FK pins the tenant).
    if (p.cares_listing_id !== null && !(await one(c, `SELECT 1 FROM core.cares_listing WHERE id = $1 AND ($2::uuid IS NULL OR outlet_id = $2)`,
      [p.cares_listing_id, p.outlet_id]))) throw new ApiError("not_found");
    const r = await c.query(
      `INSERT INTO core.task (tenant_id, id, outlet_id, title_key, assignee_member_id, due_on, finding_id, cares_listing_id, created_by)
       VALUES (${TENANT}, $1, $2, $3, $4, $5, $6, $7, ${ME}) ON CONFLICT DO NOTHING`,
      [p.task_id, p.outlet_id, p.title_key, p.assignee_member_id, p.due_on, p.finding_id, p.cares_listing_id]);
    if (r.rowCount !== 1) throw new ApiError("conflict");
    return { entityId: p.task_id, audit: [{ entity: "core.task", entityId: p.task_id,
      after: { title_key: p.title_key, assignee_member_id: p.assignee_member_id, finding_id: p.finding_id, cares_listing_id: p.cares_listing_id } }] };
  },
};

export const taskUpdate: CommandHandler = {
  type: "goals.task.update.v1",
  async run(c, cmd) {
    const p = parse(GoalsTaskUpdateV1, cmd.payload);
    const prior = await one<{ status: string; assignee_member_id: string; due_on: string }>(
      c, `SELECT status, assignee_member_id, due_on::text FROM core.task WHERE id = $1`, [p.task_id]);
    if (!prior) throw new ApiError("not_found");
    if (prior.status !== "open") throw new ApiError("illegal_transition");
    const me = (await one<{ id: string; role: string }>(c, `SELECT ${ME} AS id, current_setting('app.role') AS role`, []))!;
    // Staff may tick off their own task and nothing else; reassigning or moving a date is a manager's call.
    if (me.role === "staff" && (p.status !== "done" || p.assignee_member_id !== null || p.due_on !== null || prior.assignee_member_id !== me.id)) {
      throw new ApiError("forbidden", "authority_denied");
    }
    if (p.assignee_member_id !== null && !(await one(c, `SELECT 1 FROM core.member WHERE id = $1`, [p.assignee_member_id]))) throw new ApiError("not_found");
    await c.query(
      `UPDATE core.task SET assignee_member_id = coalesce($2, assignee_member_id), due_on = coalesce($3::date, due_on),
              status = coalesce($4, status), done_at = CASE WHEN $4 = 'done' THEN now() END, done_by = CASE WHEN $4 = 'done' THEN ${ME} END
        WHERE id = $1`,
      [p.task_id, p.assignee_member_id, p.due_on, p.status]);
    return {
      entityId: p.task_id,
      audit: [{ entity: "core.task", entityId: p.task_id, before: { status: prior.status }, after: { status: p.status ?? prior.status, assignee_member_id: p.assignee_member_id ?? prior.assignee_member_id, due_on: p.due_on ?? prior.due_on } }],
    };
  },
};
