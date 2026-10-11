// People commands and read models (02-schema §2.8, packs/people.md). Rosters and payroll drafts are the two
// things intel may propose (R16): `people.roster.create.v1` has no numeric leaf, `people.payroll_draft.create.v1`
// has five per line, all Refs when proposed. Everything else is a member's own command (R27).
import { z } from "zod";
import { defineDraftable } from "../shared/draftables.ts";
import { CommandResult } from "../shared/command.ts";
import { CurrencyCode, IsoDate, IsoDateTime, MinorAmount, NonEmpty, Slug, Uuid7 } from "../shared/primitives.ts";
import type { Route } from "../shared/routes.ts";
import { READ_ROUTES, READ_SCHEMAS } from "./read-routes.ts";

const RoleKey = z.string().regex(/^[a-z][a-z0-9_]*$/);
const Phone = z.string().regex(/^\+[1-9][0-9]{6,14}$/);
/** First day of a month; one pattern (a refined IsoDate would put two accept-anything parts in a draft schema). */
const MonthStart = z.string().regex(/^[0-9]{4}-(0[1-9]|1[0-2])-01$/);
const Monday = IsoDate;

export const PeopleStaffUpsertV1 = z.strictObject({
  staff_id: Uuid7,
  /** Optional link to a login. Set at creation only (the column is not updatable). */
  member_id: Uuid7.nullable(),
  outlet_id: Uuid7,
  name: NonEmpty,
  phone: Phone.nullable(),
  role_key: RoleKey,
  pay_basis: z.enum(["hourly", "monthly"]),
  /** Hourly staff: minor units per hour. Monthly staff: null. */
  wage_rate_minor: MinorAmount.nonnegative().nullable(),
  /** Monthly staff: salary and the contract minutes it covers (core derives the hourly rate). Hourly: null. */
  monthly_salary_minor: MinorAmount.nonnegative().nullable(),
  contract_min_per_month: z.int().positive().nullable(),
  ot_multiplier_bp: z.int().min(10000).max(40000),
  currency: CurrencyCode,
  joined_on: IsoDate,
  left_on: IsoDate.nullable(),
  active: z.boolean(),
});

export const RosterShiftInput = z.strictObject({
  roster_shift_id: Uuid7,
  staff_id: Uuid7,
  starts_at: IsoDateTime,
  ends_at: IsoDateTime,
  role_key: RoleKey,
});

/** A week's roster. No numeric leaf: the draft carries `based_on` forecast / needed-minutes cells instead. */
export const PeopleRosterCreateV1 = z.strictObject({
  roster_id: Uuid7,
  outlet_id: Uuid7,
  /** A Monday. */
  week_start: Monday,
  shifts: z.array(RosterShiftInput).min(1),
});
export const ROSTER_CREATE_DRAFT = defineDraftable("people.roster.create.v1", PeopleRosterCreateV1);

export const PeopleRosterUpdateV1 = z.strictObject({
  roster_id: Uuid7,
  /** Cancels the roster and every scheduled shift on it. */
  cancel_roster: z.boolean(),
  add_shifts: z.array(RosterShiftInput),
  edit_shifts: z.array(z.strictObject({ roster_shift_id: Uuid7, starts_at: IsoDateTime, ends_at: IsoDateTime, role_key: RoleKey })),
  cancel_shift_ids: z.array(Uuid7),
});

export const PeopleAttendanceRecordV1 = z.strictObject({
  attendance_id: Uuid7,
  outlet_id: Uuid7,
  staff_id: Uuid7,
  /** Clock-in opens the row; clock-out closes the row named by `attendance_id`. */
  action: z.enum(["clock_in", "clock_out"]),
  at: IsoDateTime,
  roster_shift_id: Uuid7.nullable(),
  source: z.enum(["device", "manual"]),
});

/** IN only (pack `payroll_scope = 'drafts'`); under an AU pack the database refuses it (MB013). */
export const PeoplePayrollDraftCreateV1 = z.strictObject({
  payroll_draft_id: Uuid7,
  outlet_id: Uuid7,
  /** First day of the month. */
  period_month: MonthStart,
  currency: CurrencyCode,
  lines: z
    .array(
      z.strictObject({
        staff_id: Uuid7,
        base_minor: MinorAmount.nonnegative(),
        overtime_minor: MinorAmount.nonnegative(),
        advance_recovery_minor: MinorAmount.nonnegative(),
        tips_minor: MinorAmount.nonnegative(),
        net_minor: MinorAmount,
      }),
    )
    .min(1),
});
export const PAYROLL_DRAFT_CREATE_DRAFT = defineDraftable("people.payroll_draft.create.v1", PeoplePayrollDraftCreateV1);

export const PeopleAdvanceRecordV1 = z.strictObject({
  advance_id: Uuid7,
  staff_id: Uuid7,
  kind: z.enum(["given", "recovered"]),
  amount_minor: MinorAmount.positive(),
  currency: CurrencyCode,
  on_date: IsoDate,
  note: z.string().max(500).nullable(),
});

export const PeopleTipPoolRecordV1 = z.strictObject({
  tip_pool_id: Uuid7,
  outlet_id: Uuid7,
  period_from: IsoDate,
  period_to: IsoDate,
  basis: z.enum(["equal", "hours", "manual"]),
  total_minor: MinorAmount.nonnegative(),
  currency: CurrencyCode,
  /** `manual` basis: the amounts a person typed (must sum to total). Other bases: core splits and this is []. */
  manual_shares: z.array(z.strictObject({ staff_id: Uuid7, amount_minor: MinorAmount.nonnegative() })),
  /** Staff sharing the pool (`equal`, `hours`). */
  staff_ids: z.array(Uuid7),
});

export const PeopleTrainingRecordV1 = z.strictObject({
  training_id: Uuid7,
  staff_id: Uuid7,
  course_key: Slug,
  completed_on: IsoDate,
  valid_to: IsoDate.nullable(),
  document_id: Uuid7.nullable(),
});

export const CandidateStage = z.enum(["applied", "interviewed", "offered", "hired", "rejected", "withdrawn"]);
export const PeopleCandidateUpsertV1 = z.strictObject({
  candidate_id: Uuid7,
  outlet_id: Uuid7,
  name: NonEmpty,
  phone: Phone.nullable(),
  email: z.string().max(254).nullable(),
  role_key: RoleKey,
  stage: CandidateStage,
  source: z.string().max(100).nullable(),
  note: z.string().max(1000).nullable(),
});

/** One staff member's overtime for one ISO week (packs/people.md §3 `people.overtime_drift`). */
export const OvertimeWeekRow = z.strictObject({
  staff_id: Uuid7,
  iso_week: z.string().regex(/^[0-9]{4}-W[0-9]{2}$/),
  rostered_min: z.int().nonnegative(),
  attended_min: z.int().nonnegative(),
  extra_min: z.int().nonnegative(),
  extra_cost_minor: MinorAmount.nonnegative(),
});
export const PeopleOvertimeResponse = z.strictObject({
  outlet_id: Uuid7,
  from: IsoDate,
  to: IsoDate,
  rows: z.array(OvertimeWeekRow),
});

/** Proposed payroll lines for a month (IN only). `advance_recovery_minor` starts at 0: a person decides it. */
export const PeoplePayrollPreviewResponse = z.strictObject({
  outlet_id: Uuid7,
  period_month: MonthStart,
  currency: CurrencyCode,
  lines: z.array(
    z.strictObject({
      staff_id: Uuid7,
      base_minor: MinorAmount.nonnegative(),
      overtime_minor: MinorAmount.nonnegative(),
      advance_recovery_minor: MinorAmount.nonnegative(),
      tips_minor: MinorAmount.nonnegative(),
      net_minor: MinorAmount,
      outstanding_advance_minor: MinorAmount,
    }),
  ),
});

/** A staff record as wage-bearing reads show it (not to staff-role members): pay basis, rate or salary, contract
 *  minutes and the overtime multiplier — the rows' own fields. The phone is not in the view. */
export const StaffView = PeopleStaffUpsertV1.omit({ phone: true });
export const PeopleStaffListResponse = z.strictObject({ outlet_id: Uuid7, staff: z.array(StaffView) });

/** What every command route in this module returns (a module-own copy: contract names are global). */
export const PeopleCommandResult = z.strictObject({ ...CommandResult.shape });

/** An approved payroll draft is marked paid outside Munim (recorded, never processed) or voided with a reason; a
 *  void reverses its journal entry (finance.reverse_payroll) and its advance recoveries no longer count. */
export const PeoplePayrollDraftStatusV1 = z.strictObject({
  payroll_draft_id: Uuid7,
  status: z.enum(["paid_externally", "void"]),
  /** Required for a void. */
  reason_code: Slug.nullable(),
});

export const SCHEMAS = {
  ...READ_SCHEMAS,
  "people.staff.upsert.v1": PeopleStaffUpsertV1,
  "people.roster.create.v1": PeopleRosterCreateV1,
  "people.roster.update.v1": PeopleRosterUpdateV1,
  "people.attendance.record.v1": PeopleAttendanceRecordV1,
  "people.payroll_draft.create.v1": PeoplePayrollDraftCreateV1,
  "people.payroll_draft.status.v1": PeoplePayrollDraftStatusV1,
  "people.advance.record.v1": PeopleAdvanceRecordV1,
  "people.tip_pool.record.v1": PeopleTipPoolRecordV1,
  "people.training.record.v1": PeopleTrainingRecordV1,
  "people.candidate.upsert.v1": PeopleCandidateUpsertV1,
  "proposal.people.roster.create.v1": ROSTER_CREATE_DRAFT.proposal,
  "proposal.people.payroll_draft.create.v1": PAYROLL_DRAFT_CREATE_DRAFT.proposal,
  "v1.people.command-result": PeopleCommandResult,
  "v1.people.overtime.response": PeopleOvertimeResponse,
  "v1.people.payroll-preview.response": PeoplePayrollPreviewResponse,
  "v1.people.staff.list": PeopleStaffListResponse,
};

const command = (type: string, path: string, operationId: string, summary: string): Route => ({
  surface: "public", method: "post", path, operationId, summary, auth: "member", command: type, response: "v1.people.command-result", status: 200, conflict: true,
});
export const ROUTES: readonly Route[] = [
  ...READ_ROUTES,
  command("people.staff.upsert.v1", "/v1/people/staff:upsert", "peopleStaffUpsert", "Create or update a staff record"),
  command("people.roster.create.v1", "/v1/people/rosters", "peopleRosterCreate", "Create a week's roster (a person's own command)"),
  command("people.roster.update.v1", "/v1/people/rosters:update", "peopleRosterUpdate", "Edit or cancel a roster"),
  command("people.attendance.record.v1", "/v1/people/attendance", "peopleAttendanceRecord", "Clock a staff member in or out"),
  command("people.payroll_draft.create.v1", "/v1/people/payroll-drafts", "peoplePayrollDraftCreate", "Record an approved payroll draft (IN only)"),
  { ...command("people.payroll_draft.status.v1", "/v1/people/payroll-drafts/{id}:status", "peoplePayrollDraftStatus",
    "Mark an approved payroll paid outside Munim, or void it with a reason (reverses its journal entry; owner)"), pathParams: [{ name: "id", uuid: true }] },
  command("people.advance.record.v1", "/v1/people/advances", "peopleAdvanceRecord", "Record an advance given or recovered"),
  command("people.tip_pool.record.v1", "/v1/people/tip-pools", "peopleTipPoolRecord", "Record a tip pool and its shares"),
  command("people.training.record.v1", "/v1/people/training", "peopleTrainingRecord", "Record a training completion"),
  command("people.candidate.upsert.v1", "/v1/people/candidates:upsert", "peopleCandidateUpsert", "Create or move a hiring candidate"),
  {
    surface: "public", method: "get", path: "/v1/people/overtime", operationId: "peopleOvertime", summary: "Overtime against the roster, per staff per ISO week",
    auth: "member", response: "v1.people.overtime.response", status: 200,
    query: [
      { name: "outlet", required: true, schema: { type: "string" } },
      { name: "from", required: true, schema: { type: "string" } },
      { name: "to", required: true, schema: { type: "string" } },
    ],
  },
  {
    surface: "public", method: "get", path: "/v1/people/payroll-preview", operationId: "peoplePayrollPreview", summary: "Proposed payroll lines for a month (IN only)",
    auth: "member", response: "v1.people.payroll-preview.response", status: 200,
    query: [
      { name: "outlet", required: true, schema: { type: "string" } },
      { name: "month", required: true, schema: { type: "string" } },
    ],
  },
  {
    surface: "public", method: "get", path: "/v1/people/staff", operationId: "peopleStaffList", summary: "Staff of an outlet with their pay terms (not for staff-role members)",
    auth: "member", response: "v1.people.staff.list", status: 200, query: [{ name: "outlet", required: true, schema: { type: "string" } }],
  },
];
