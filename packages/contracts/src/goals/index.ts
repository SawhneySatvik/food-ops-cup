// Goals and tasks (02-schema §2.11). A goal's metric is net sales or order count; progress is a snapshot cell,
// never stored here. Tasks may cite the finding that prompted them. Intel may draft goal and task creation
// (R16: a named person approves). goals.task.create.v1 is shared with the market pack.
import { z } from "zod";
import { defineDraftable } from "../shared/draftables.ts";
import { CurrencyCode, IsoDate, IsoDateTime, MinorAmount, Slug, Uuid7 } from "../shared/primitives.ts";
import type { Route } from "../shared/routes.ts";

export const GoalsGoalCreateV1 = z.strictObject({
  goal_id: Uuid7,
  /** null = the whole business (needs a tenant-wide scope). */
  outlet_id: Uuid7.nullable(),
  metric: z.enum(["net_sales", "orders"]),
  /** Numeric leaf: net_sales in minor units of the business currency, or an order count. */
  target_value: z.int().positive(),
  period_from: IsoDate,
  due_on: IsoDate,
  basis_snapshot_id: Uuid7.nullable(),
});

export const GoalsGoalUpdateV1 = z.strictObject({
  goal_id: Uuid7,
  status: z.enum(["achieved", "missed", "cancelled"]),
});

export const GoalsTaskCreateV1 = z.strictObject({
  task_id: Uuid7,
  outlet_id: Uuid7.nullable(),
  /** i18n key; the task text is never free text from a model. */
  title_key: Slug,
  assignee_member_id: Uuid7,
  due_on: IsoDate,
  finding_id: Uuid7.nullable(),
  /** ADR-015: the Munim Cares listing a pack-and-hand-over task is for. Absent = null (every other task). */
  cares_listing_id: Uuid7.nullable().default(null),
});

/** At least one change. `status` done/cancelled closes the task; the assignee/due date may be changed by a manager. */
export const GoalsTaskUpdateV1 = z
  .strictObject({
    task_id: Uuid7,
    status: z.enum(["done", "cancelled"]).nullable(),
    assignee_member_id: Uuid7.nullable(),
    due_on: IsoDate.nullable(),
  })
  .refine((v) => v.status !== null || v.assignee_member_id !== null || v.due_on !== null, { message: "nothing to change" });

export const GOAL_CREATE_DRAFT = defineDraftable("goals.goal.create.v1", GoalsGoalCreateV1);
export const TASK_CREATE_DRAFT = defineDraftable("goals.task.create.v1", GoalsTaskCreateV1);

// ---- Read models (T-029): rows only; a goal's progress is a snapshot cell (W3 template), never computed here.
export const GoalView = z.strictObject({
  id: Uuid7,
  outlet_id: Uuid7.nullable(),
  metric: GoalsGoalCreateV1.shape.metric,
  target_value: MinorAmount.positive(),
  /** Set for net_sales; null for an order-count goal. */
  currency: CurrencyCode.nullable(),
  period_from: IsoDate,
  due_on: IsoDate,
  status: z.enum(["active", "achieved", "missed", "cancelled"]),
  basis_snapshot_id: Uuid7.nullable(),
});
export const GoalsResponse = z.strictObject({ items: z.array(GoalView) });

export const TaskView = z.strictObject({
  id: Uuid7,
  outlet_id: Uuid7.nullable(),
  title_key: Slug,
  assignee_member_id: Uuid7,
  due_on: IsoDate,
  finding_id: Uuid7.nullable(),
  /** ADR-015: the Munim Cares listing a pack-and-hand-over task is for (null for every other task). */
  cares_listing_id: Uuid7.nullable(),
  status: z.enum(["open", "done", "cancelled"]),
  done_at: IsoDateTime.nullable(),
  done_by: Uuid7.nullable(),
});
export const TasksResponse = z.strictObject({ items: z.array(TaskView) });

export const SCHEMAS = {
  "goals.goal.create.v1": GoalsGoalCreateV1,
  "goals.goal.update.v1": GoalsGoalUpdateV1,
  "goals.task.create.v1": GoalsTaskCreateV1,
  "goals.task.update.v1": GoalsTaskUpdateV1,
  "proposal.goals.goal.create.v1": GOAL_CREATE_DRAFT.proposal,
  "proposal.goals.task.create.v1": TASK_CREATE_DRAFT.proposal,
  "v1.goals": GoalsResponse,
  "v1.tasks": TasksResponse,
};

const q = (name: string, schema: Record<string, unknown>) => ({ name, required: false, schema });
const UUID_Q = { type: "string", format: "uuid" } as const;
const write = (path: string, operationId: string, command: string, summary: string): Route =>
  ({ surface: "public", method: "post", path, operationId, summary: `${command} — ${summary}`, auth: "member", command, response: "command-result", status: 200, conflict: true });

export const ROUTES: readonly Route[] = [
  {
    surface: "public", method: "get", path: "/v1/goals", operationId: "listGoals", summary: "Goals in the caller's outlets and the tenant-wide ones", auth: "member", response: "v1.goals", status: 200,
    query: [q("outlet", UUID_Q), q("status", { type: "string", enum: ["active", "achieved", "missed", "cancelled"] })],
  },
  write("/v1/goals", "createGoal", "goals.goal.create.v1", "set a goal (intel may draft it)"),
  write("/v1/goals/update", "updateGoal", "goals.goal.update.v1", "close a goal as achieved, missed or cancelled"),
  {
    surface: "public", method: "get", path: "/v1/tasks", operationId: "listTasks", summary: "Tasks in the caller's outlets and the tenant-wide ones", auth: "member", response: "v1.tasks", status: 200,
    query: [q("outlet", UUID_Q), q("assignee", UUID_Q), q("status", { type: "string", enum: ["open", "done", "cancelled"] }), q("due_before", { type: "string", format: "date" })],
  },
  write("/v1/tasks", "createTask", "goals.task.create.v1", "assign a task (intel may draft it)"),
  write("/v1/tasks/update", "updateTask", "goals.task.update.v1", "close or reassign a task"),
];
