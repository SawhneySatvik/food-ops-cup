// People read responses and routes (T-092b; hand list rows 11-14). A staff-role member's roster and attendance reads are
// narrowed to their own staff row; advances and payroll drafts are not served to staff-role members. Money is minor units.
import { z } from "zod";
import { CurrencyCode, IsoDate, IsoDateTime, MinorAmount, Uuid7 } from "../shared/primitives.ts";
import type { QueryParam, Route } from "../shared/routes.ts";

const Page = <T extends z.ZodType>(item: T) => z.strictObject({ items: z.array(item), next_cursor: Uuid7.nullable() });
const uuid = { type: "string", pattern: "^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$" };
const date = { type: "string", format: "date" };
const param = (name: string, schema: Record<string, unknown>, required = false): QueryParam => ({ name, required, schema });
const cursor = param("cursor", uuid);
const limit = param("limit", { type: "integer", minimum: 1, maximum: 200 });
const read = (path: string, operationId: string, summary: string, response: string, extra: Partial<Route> = {}): Route =>
  ({ surface: "public", method: "get", path, operationId, summary, auth: "member", response, status: 200, ...extra });

const RosterItem = z.strictObject({
  roster_id: Uuid7, outlet_id: Uuid7, week_start: IsoDate, status: z.enum(["active", "cancelled"]),
  shifts: z.array(z.strictObject({
    roster_shift_id: Uuid7, staff_id: Uuid7, starts_at: IsoDateTime, ends_at: IsoDateTime, role_key: z.string(), status: z.enum(["scheduled", "cancelled"]),
  })),
}).meta({ title: "RosterItem" });

const AttendanceItem = z.strictObject({
  attendance_id: Uuid7, outlet_id: Uuid7, staff_id: Uuid7, roster_shift_id: Uuid7.nullable(), clock_in_at: IsoDateTime, clock_out_at: IsoDateTime.nullable(),
  source: z.enum(["device", "manual"]), recorded_by: Uuid7,
}).meta({ title: "AttendanceItem" });

const AdvanceItem = z.strictObject({
  advance_id: Uuid7, staff_id: Uuid7, outlet_id: Uuid7, kind: z.enum(["given", "recovered"]), amount_minor: MinorAmount, currency: CurrencyCode, on_date: IsoDate,
  payroll_draft_id: Uuid7.nullable(),
  /** The recorder's free-text note: untrusted, rendered as text. */
  note: z.string().nullable(), recorded_by: Uuid7,
}).meta({ title: "AdvanceItem" });

const PayrollDraftItem = z.strictObject({
  payroll_draft_id: Uuid7, outlet_id: Uuid7, period_month: IsoDate, status: z.enum(["approved", "paid_externally", "void"]), currency: CurrencyCode, created_at: IsoDateTime,
  lines: z.array(z.strictObject({
    payroll_line_id: Uuid7, staff_id: Uuid7, base_minor: MinorAmount, overtime_minor: MinorAmount, tips_minor: MinorAmount, advance_recovery_minor: MinorAmount,
    net_minor: MinorAmount, currency: CurrencyCode,
  })),
}).meta({ title: "PayrollDraftItem" });

export const READ_SCHEMAS = {
  "v1.people.rosters": Page(RosterItem),
  "v1.people.attendance": Page(AttendanceItem),
  "v1.people.advances": Page(AdvanceItem),
  "v1.people.payroll-drafts": Page(PayrollDraftItem),
};

export const READ_ROUTES: readonly Route[] = [
  read("/v1/people/rosters", "listRosters", "Rosters with their shifts; week = the roster's Monday. A staff-role member gets only their own shifts", "v1.people.rosters", { query: [param("outlet", uuid), param("week", date), limit, cursor] }),
  read("/v1/people/attendance", "listAttendance", "Clock-ins and outs; from / to = the outlet's business day (local time less its business-day cutoff). A staff-role member gets only their own", "v1.people.attendance", { query: [param("outlet", uuid), param("from", date), param("to", date), limit, cursor] }),
  read("/v1/people/advances", "listAdvances", "Salary advances given and recovered (not for staff-role members)", "v1.people.advances", { query: [param("outlet", uuid), param("staff", uuid), param("status", { type: "string", enum: ["given", "recovered"] }), limit, cursor] }),
  read("/v1/people/payroll-drafts", "listPayrollDrafts", "Approved payroll drafts with their lines; month = the 1st (not for staff-role members)", "v1.people.payroll-drafts", { query: [param("outlet", uuid), param("month", date), limit, cursor] }),
];
