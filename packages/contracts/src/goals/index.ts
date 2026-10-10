// Goals and tasks (02-schema §2.11). A goal's metric is net sales or order count; progress is a snapshot cell,
// never stored here. Tasks may cite the finding that prompted them. Intel may draft goal and task creation
// (R16: a named person approves). goals.task.create.v1 is shared with the market pack.
import { z } from "zod";
import { defineDraftable } from "../shared/draftables.ts";
import { IsoDate, Slug, Uuid7 } from "../shared/primitives.ts";
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

export const SCHEMAS = {
  "goals.goal.create.v1": GoalsGoalCreateV1,
  "goals.goal.update.v1": GoalsGoalUpdateV1,
  "goals.task.create.v1": GoalsTaskCreateV1,
  "goals.task.update.v1": GoalsTaskUpdateV1,
  "proposal.goals.goal.create.v1": GOAL_CREATE_DRAFT.proposal,
  "proposal.goals.task.create.v1": TASK_CREATE_DRAFT.proposal,
};
export const ROUTES: readonly Route[] = [];
