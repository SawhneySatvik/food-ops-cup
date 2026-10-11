// People read routes (T-092b; hand list rows 11-14). Rows under the member's RLS (rosters, shifts, attendance and
// payroll drafts carry outlet policies). Two rules RLS cannot express:
//   * a staff-role member sees only their OWN roster shifts and attendance (staff.member_id = the caller); a member with
//     no staff row sees nothing — the filter is a flag plus an id, never "id IS NULL means everyone";
//   * advances and payroll carry wages: not for staff-role members (as /v1/people/staff and payroll-preview).
//   GET /v1/people/rosters?outlet=&week=&limit=&cursor=      (week = the roster's Monday)
//   GET /v1/people/attendance?outlet=&from=&to=&limit=&cursor=   (from / to = the outlet's business day: local time less its cutoff)
//   GET /v1/people/advances?outlet=&staff=&status=&limit=&cursor=       (status given | recovered = the advance row's kind)
//   GET /v1/people/payroll-drafts?outlet=&month=&limit=&cursor=         (month = the 1st; each with its lines)
import { Hono, type Context } from "hono";
import { requireMember } from "../../auth/resolve.ts";
import { ApiError } from "../../lib/errors.ts";
import { cursorOf, DATE_RE, inScope, iso, limitOf, memberOf, methodGuard, optDate, optEnum, optUuid, page, readAs } from "../../lib/reads.ts";
import type { AppEnv } from "../../lib/types.ts";
import type { Queryable } from "../../runtoken/index.ts";

/** `own` = the caller is a staff-role member: every row is narrowed to `id` (their staff row; null = none = no rows). */
async function ownStaff(db: Queryable, role: string, memberId: string): Promise<{ own: boolean; id: string | null }> {
  if (role !== "staff") return { own: false, id: null };
  const r = await db.query<{ id: string }>(`SELECT id FROM core.staff WHERE member_id = $1`, [memberId]);
  return { own: true, id: r.rows[0]?.id ?? null };
}

function outletOf(c: Context<AppEnv>): string | null {
  const o = optUuid(c, "outlet");
  if (o !== null) inScope(memberOf(c), o);
  return o;
}

function wageReader(c: Context<AppEnv>): void {
  if (memberOf(c).role === "staff") throw new ApiError("forbidden", "authority_denied");
}

export const readRoutes = methodGuard(
  new Hono<AppEnv>()
    .get("/v1/people/rosters", requireMember, async (c) => {
      const m = memberOf(c);
      const outlet = outletOf(c);
      const week = optDate(c, "week");
      const limit = limitOf(c, 20, 100);
      const cursor = cursorOf(c);
      const out = await readAs(c, async (db) => {
        const who = await ownStaff(db, m.role, m.member_id);
        const rosters = (await db.query<Record<string, any>>(
          `SELECT r.id, r.outlet_id, r.week_start::text AS week_start, r.status FROM core.roster r
            WHERE ($1::uuid IS NULL OR r.outlet_id = $1) AND ($2::date IS NULL OR r.week_start = $2) AND ($3::uuid IS NULL OR r.id < $3)
              AND (NOT $4::boolean OR EXISTS (SELECT 1 FROM core.roster_shift x WHERE x.tenant_id = r.tenant_id AND x.roster_id = r.id AND x.staff_id = $5::uuid))
            ORDER BY r.id DESC LIMIT $6`, [outlet, week, cursor, who.own, who.id, limit + 1])).rows;
        const shown = rosters.slice(0, limit);
        const shifts = (await db.query<Record<string, any>>(
          `SELECT id, roster_id, staff_id, starts_at, ends_at, role_key, status FROM core.roster_shift
            WHERE roster_id = ANY ($1::uuid[]) AND (NOT $2::boolean OR staff_id = $3::uuid) ORDER BY starts_at, id`, [shown.map((r) => r.id), who.own, who.id])).rows;
        return page(rosters, limit, (r) => ({
          roster_id: r.id, outlet_id: r.outlet_id, week_start: r.week_start, status: r.status,
          shifts: shifts.filter((s) => s.roster_id === r.id).map((s) => ({
            roster_shift_id: s.id, staff_id: s.staff_id, starts_at: s.starts_at.toISOString(), ends_at: s.ends_at.toISOString(), role_key: s.role_key, status: s.status,
          })),
        }));
      });
      return c.json(out, 200);
    })
    .get("/v1/people/attendance", requireMember, async (c) => {
      const m = memberOf(c);
      const outlet = outletOf(c);
      const from = optDate(c, "from");
      const to = optDate(c, "to");
      if (from && to && to < from) throw new ApiError("bad_request");
      const limit = limitOf(c);
      const cursor = cursorOf(c);
      const out = await readAs(c, async (db) => {
        const who = await ownStaff(db, m.role, m.member_id);
        const rows = (await db.query<Record<string, any>>(
          `SELECT a.id, a.outlet_id, a.staff_id, a.roster_shift_id, a.clock_in_at, a.clock_out_at, a.source, a.recorded_by
             FROM core.attendance a JOIN core.outlet ou ON ou.tenant_id = a.tenant_id AND ou.id = a.outlet_id
            WHERE ($1::uuid IS NULL OR a.outlet_id = $1)
              AND ($2::date IS NULL OR ((a.clock_in_at AT TIME ZONE ou.tz) - ou.business_day_cutoff)::date >= $2)
              AND ($3::date IS NULL OR ((a.clock_in_at AT TIME ZONE ou.tz) - ou.business_day_cutoff)::date <= $3)
              AND (NOT $4::boolean OR a.staff_id = $5::uuid) AND ($6::uuid IS NULL OR a.id < $6)
            ORDER BY a.id DESC LIMIT $7`, [outlet, from, to, who.own, who.id, cursor, limit + 1])).rows;
        return page(rows, limit, (a) => ({
          attendance_id: a.id, outlet_id: a.outlet_id, staff_id: a.staff_id, roster_shift_id: a.roster_shift_id, clock_in_at: a.clock_in_at.toISOString(),
          clock_out_at: iso(a.clock_out_at), source: a.source, recorded_by: a.recorded_by,
        }));
      });
      return c.json(out, 200);
    })
    .get("/v1/people/advances", requireMember, async (c) => {
      wageReader(c);
      const outlet = outletOf(c);
      const staff = optUuid(c, "staff");
      const status = optEnum(c, "status", ["given", "recovered"] as const);
      const limit = limitOf(c);
      const cursor = cursorOf(c);
      const rows = await readAs(c, async (db) => (await db.query<Record<string, any>>(
        // core.staff carries the outlet (and its policy): an advance of a staff member outside the caller's scope is not joined.
        `SELECT a.id, a.staff_id, s.outlet_id, a.kind, a.amount_minor, a.currency, a.on_date::text AS on_date, a.payroll_draft_id, a.note, a.recorded_by
           FROM core.advance a JOIN core.staff s ON s.tenant_id = a.tenant_id AND s.id = a.staff_id
          WHERE ($1::uuid IS NULL OR s.outlet_id = $1) AND ($2::uuid IS NULL OR a.staff_id = $2) AND ($3::text IS NULL OR a.kind = $3)
            AND ($4::uuid IS NULL OR a.id < $4)
          ORDER BY a.id DESC LIMIT $5`, [outlet, staff, status, cursor, limit + 1])).rows);
      return c.json(page(rows, limit, (a) => ({
        advance_id: a.id, staff_id: a.staff_id, outlet_id: a.outlet_id, kind: a.kind, amount_minor: Number(a.amount_minor), currency: a.currency,
        on_date: a.on_date, payroll_draft_id: a.payroll_draft_id,
        // The recorder's free-text note: untrusted, returned as text.
        note: a.note, recorded_by: a.recorded_by,
      })), 200);
    })
    .get("/v1/people/payroll-drafts", requireMember, async (c) => {
      wageReader(c);
      const outlet = outletOf(c);
      const month = c.req.query("month") ?? null;
      if (month !== null && (!DATE_RE.test(month) || !month.endsWith("-01") || optDate(c, "month") === null)) throw new ApiError("bad_request");
      const limit = limitOf(c, 20, 100);
      const cursor = cursorOf(c);
      const out = await readAs(c, async (db) => {
        const drafts = (await db.query<Record<string, any>>(
          `SELECT id, outlet_id, period_month::text AS period_month, status, currency, created_at FROM core.payroll_draft
            WHERE ($1::uuid IS NULL OR outlet_id = $1) AND ($2::date IS NULL OR period_month = $2) AND ($3::uuid IS NULL OR id < $3)
            ORDER BY id DESC LIMIT $4`, [outlet, month, cursor, limit + 1])).rows;
        const lines = (await db.query<Record<string, any>>(
          `SELECT id, payroll_draft_id, staff_id, base_minor, overtime_minor, tips_minor, advance_recovery_minor, net_minor, currency
             FROM core.payroll_draft_line WHERE payroll_draft_id = ANY ($1::uuid[]) ORDER BY staff_id`, [drafts.slice(0, limit).map((d) => d.id)])).rows;
        return page(drafts, limit, (d) => ({
          payroll_draft_id: d.id, outlet_id: d.outlet_id, period_month: d.period_month, status: d.status, currency: d.currency, created_at: d.created_at.toISOString(),
          lines: lines.filter((l) => l.payroll_draft_id === d.id).map((l) => ({
            payroll_line_id: l.id, staff_id: l.staff_id, base_minor: Number(l.base_minor), overtime_minor: Number(l.overtime_minor), tips_minor: Number(l.tips_minor),
            advance_recovery_minor: Number(l.advance_recovery_minor), net_minor: Number(l.net_minor), currency: l.currency,
          })),
        }));
      });
      return c.json(out, 200);
    }),
  [["/v1/people/rosters", "GET, POST"], ["/v1/people/attendance", "GET, POST"], ["/v1/people/advances", "GET, POST"], ["/v1/people/payroll-drafts", "GET, POST"]],
);
