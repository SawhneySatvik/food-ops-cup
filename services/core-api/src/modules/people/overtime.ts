// Overtime and attendance coverage read models (packs/people.md §3 `people.overtime_drift`,
// `people.attendance_coverage`). Overtime is measured against the ROSTER, never a statutory limit: attended
// minutes beyond rostered minutes in an ISO week, costed at the staff member's ot_multiplier_bp.
//   extra_cost_minor = round(extra_min × hourly_rate × ot_multiplier_bp / 600000)
//   hourly_rate      = wage_rate_minor (hourly) | monthly_salary_minor × 60 / contract_min_per_month (monthly)
// Weeks are ISO weeks of the OUTLET's local date (the shift's start / the clock-in), not UTC.
import type { Queryable } from "../../runtoken/index.ts";
import { ApiError } from "../../lib/errors.ts";

export interface OvertimeRow {
  staff_id: string;
  iso_week: string;
  rostered_min: number;
  attended_min: number;
  extra_min: number;
  extra_cost_minor: number;
}

export interface Coverage {
  rostered_shifts: number;
  attended_shifts: number;
  attended_rows: number;
  coverage_bp: number;
}

/** Below this the pack refuses overtime and labour cost (`attendance_missing`, packs/people.md §7). */
export const MIN_COVERAGE_BP = 8000;

/** Rostered shifts that have a closed attendance row linked to them, over [from, to] outlet-local dates. */
export async function coverage(c: Queryable, outletId: string, from: string, to: string): Promise<Coverage> {
  const r = await c.query<{ rostered: string; attended: string; rows: string }>(
    `WITH o AS (SELECT tz FROM core.outlet WHERE id = $1)
     SELECT (SELECT count(*) FROM core.roster_shift s, o
              WHERE s.outlet_id = $1 AND s.status = 'scheduled' AND (s.starts_at AT TIME ZONE o.tz)::date BETWEEN $2::date AND $3::date) AS rostered,
            (SELECT count(*) FROM core.roster_shift s, o
              WHERE s.outlet_id = $1 AND s.status = 'scheduled' AND (s.starts_at AT TIME ZONE o.tz)::date BETWEEN $2::date AND $3::date
                AND EXISTS (SELECT 1 FROM core.attendance a WHERE a.tenant_id = s.tenant_id AND a.roster_shift_id = s.id AND a.clock_out_at IS NOT NULL)) AS attended,
            (SELECT count(*) FROM core.attendance a, o
              WHERE a.outlet_id = $1 AND a.clock_out_at IS NOT NULL AND (a.clock_in_at AT TIME ZONE o.tz)::date BETWEEN $2::date AND $3::date) AS rows`,
    [outletId, from, to]);
  const x = r.rows[0]!;
  const rostered = Number(x.rostered);
  const attended = Number(x.attended);
  return { rostered_shifts: rostered, attended_shifts: attended, attended_rows: Number(x.rows), coverage_bp: rostered === 0 ? 0 : Math.floor((attended * 10000) / rostered) };
}

/** Refuses (`attendance_missing`) when attendance cannot support an hours claim: nothing clocked, or fewer than
 *  8,000 bp of the rostered shifts have attendance. Never assumes rostered = worked. */
export async function requireAttendance(c: Queryable, outletId: string, from: string, to: string): Promise<Coverage> {
  const cov = await coverage(c, outletId, from, to);
  if (cov.attended_rows === 0 || (cov.rostered_shifts > 0 && cov.coverage_bp < MIN_COVERAGE_BP)) {
    throw new ApiError("cannot_verify", "attendance_missing");
  }
  return cov;
}

export async function overtimeRows(c: Queryable, outletId: string, from: string, to: string): Promise<OvertimeRow[]> {
  const r = await c.query<{ staff_id: string; iso_week: string; rostered_min: number; attended_min: number; extra_min: number; extra_cost_minor: string }>(
    `WITH o AS (SELECT tz FROM core.outlet WHERE id = $1),
          r AS (SELECT s.staff_id, to_char((s.starts_at AT TIME ZONE o.tz)::date, 'IYYY-"W"IW') AS wk,
                       sum(extract(epoch FROM s.ends_at - s.starts_at) / 60)::int AS m
                  FROM core.roster_shift s, o
                 WHERE s.outlet_id = $1 AND s.status = 'scheduled' AND (s.starts_at AT TIME ZONE o.tz)::date BETWEEN $2::date AND $3::date
                 GROUP BY 1, 2),
          a AS (SELECT t.staff_id, to_char((t.clock_in_at AT TIME ZONE o.tz)::date, 'IYYY-"W"IW') AS wk,
                       sum(extract(epoch FROM t.clock_out_at - t.clock_in_at) / 60)::int AS m
                  FROM core.attendance t, o
                 WHERE t.outlet_id = $1 AND t.clock_out_at IS NOT NULL AND (t.clock_in_at AT TIME ZONE o.tz)::date BETWEEN $2::date AND $3::date
                 GROUP BY 1, 2)
     SELECT a.staff_id, a.wk AS iso_week, coalesce(r.m, 0) AS rostered_min, a.m AS attended_min,
            greatest(a.m - coalesce(r.m, 0), 0) AS extra_min,
            round(greatest(a.m - coalesce(r.m, 0), 0)::numeric
                  * CASE WHEN s.pay_basis = 'hourly' THEN s.wage_rate_minor::numeric * s.ot_multiplier_bp / 600000
                         ELSE s.monthly_salary_minor::numeric * s.ot_multiplier_bp / (s.contract_min_per_month::numeric * 10000) END
            )::bigint AS extra_cost_minor
       FROM a LEFT JOIN r ON r.staff_id = a.staff_id AND r.wk = a.wk
       JOIN core.staff s ON s.id = a.staff_id
      ORDER BY a.wk, a.staff_id`,
    [outletId, from, to]);
  return r.rows.map((x) => ({
    staff_id: x.staff_id, iso_week: x.iso_week, rostered_min: x.rostered_min, attended_min: x.attended_min,
    extra_min: x.extra_min, extra_cost_minor: Number(x.extra_cost_minor),
  }));
}
