import { S1, T_PG, snapRef, u } from "./_ids.ts";

const goal = { goal_id: u(320), outlet_id: u(2), metric: "net_sales", target_value: 50000000, period_from: "2026-11-01", due_on: "2026-11-30", basis_snapshot_id: null };
const task = { task_id: u(321), outlet_id: u(2), title_key: "goals.task.renew_licence", assignee_member_id: u(8), due_on: "2026-10-20", finding_id: null };

export const SAMPLES: Record<string, unknown> = {
  "goals.goal.create.v1": goal,
  "goals.goal.update.v1": { goal_id: u(320), status: "achieved" },
  "goals.task.create.v1": task,
  "goals.task.update.v1": { task_id: u(321), status: "done", assignee_member_id: null, due_on: null },
  "proposal.goals.goal.create.v1": { ...goal, target_value: snapRef(S1, 0, "target") },
  "proposal.goals.task.create.v1": task,
  "v1.goals": { items: [{ id: u(320), outlet_id: u(2), metric: "net_sales", target_value: 50000000, currency: "INR", period_from: "2026-11-01", due_on: "2026-11-30", status: "active", basis_snapshot_id: null }] },
  "v1.tasks": { items: [{ id: u(321), outlet_id: u(2), title_key: "goals.task.renew_licence", assignee_member_id: u(8), due_on: "2026-10-20", finding_id: null, cares_listing_id: null, status: "done", done_at: T_PG, done_by: u(8) }] },
};
