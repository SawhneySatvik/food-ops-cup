// Payroll (IN only: the country pack's `payroll_scope = 'drafts'`; AU is rosters only, R21). Two parts:
//   • previewPayroll — proposed lines for a month, computed from attendance, roster, tips and advances;
//   • payrollDraftHandler — executes `people.payroll_draft.create.v1` (an approved draft, or the owner's own
//     command): the payroll_draft + lines, one 'recovered' advance entry per recovery, then finance.postFor.
// Pack scope is judged by the database (MB013 from core.payroll_pack_scope) — the preview reads the same
// platform.country_pack row; no country code is named here.
import { PeoplePayrollDraftCreateV1, PeoplePayrollDraftStatusV1 } from "@munim/contracts/people";
import { mulDiv } from "@munim/core-domain/money";
import { type CommandHandler, uuidv7 } from "../../commit/index.ts";
import { ApiError } from "../../lib/errors.ts";
import type { Queryable } from "../../runtoken/index.ts";
import { dbRefusal } from "./errors.ts";
import { overtimeRows, requireAttendance } from "./overtime.ts";
import { postFor, reverseSource } from "./seams.ts";

export interface PayrollLine {
  staff_id: string;
  base_minor: number;
  overtime_minor: number;
  advance_recovery_minor: number;
  tips_minor: number;
  net_minor: number;
  outstanding_advance_minor: number;
}

export async function payrollScope(c: Queryable): Promise<string | null> {
  const r = await c.query<{ scope: string | null }>(
    `SELECT p.doc ->> 'payroll_scope' AS scope
       FROM core.tenant t JOIN platform.country_pack p ON p.code = t.country_code AND p.status = 'active'
      WHERE t.tenant_id = current_setting('app.tenant_id', true)::uuid ORDER BY p.version DESC LIMIT 1`);
  return r.rows[0]?.scope ?? null;
}

const monthEnd = async (c: Queryable, month: string) =>
  (await c.query<{ d: string }>(`SELECT to_char(($1::date + interval '1 month - 1 day')::date, 'YYYY-MM-DD') AS d`, [month])).rows[0]!.d;

/** Given less recovered; a recovery booked on a payroll that was later voided did not happen. */
export async function outstandingAdvance(c: Queryable, staffId: string): Promise<number> {
  const r = await c.query<{ n: string }>(
    `SELECT coalesce(sum(CASE a.kind WHEN 'given' THEN a.amount_minor ELSE -a.amount_minor END), 0) AS n FROM core.advance a
      WHERE a.staff_id = $1
        AND NOT EXISTS (SELECT 1 FROM core.payroll_draft d WHERE d.tenant_id = a.tenant_id AND d.id = a.payroll_draft_id AND d.status = 'void')`, [staffId]);
  return Number(r.rows[0]!.n);
}

/**
 * Proposed payroll lines. INFERENCE (documented, not in the pack text):
 *   hourly base  = round(base_min × wage_rate_minor / 60), base_min = attended minutes less overtime minutes;
 *   monthly base = monthly_salary_minor (the contract minutes only fix the hourly rate used for overtime);
 *   overtime     = Σ weekly extra_cost_minor, only for weeks the person was rostered (an unrostered week has no
 *                  roster to be "over"); tips = Σ tip_pool_share of pools ending in the month;
 *   advance recovery starts at 0 — a person decides it (typed value on the draft).
 * Refuses `payroll_out_of_scope` outside a 'drafts' pack and `attendance_missing` when hours are unknown.
 */
export async function previewPayroll(c: Queryable, outletId: string, month: string): Promise<{ currency: string; lines: PayrollLine[] }> {
  if ((await payrollScope(c)) !== "drafts") throw new ApiError("out_of_pack_scope", "payroll_out_of_scope");
  const end = await monthEnd(c, month);
  await requireAttendance(c, outletId, month, end);
  const staff = await c.query<{ id: string; pay_basis: string; wage_rate_minor: string | null; monthly_salary_minor: string | null; currency: string }>(
    `SELECT id, pay_basis, wage_rate_minor, monthly_salary_minor, currency FROM core.staff
      WHERE outlet_id = $1 AND joined_on <= $3::date AND (left_on IS NULL OR left_on >= $2::date) ORDER BY id`, [outletId, month, end]);
  const ot = await overtimeRows(c, outletId, month, end);
  const tips = await c.query<{ staff_id: string; n: string }>(
    `SELECT sh.staff_id, sum(sh.amount_minor) AS n FROM core.tip_pool_share sh JOIN core.tip_pool p ON p.tenant_id = sh.tenant_id AND p.id = sh.tip_pool_id
      WHERE p.outlet_id = $1 AND p.period_to BETWEEN $2::date AND $3::date GROUP BY 1`, [outletId, month, end]);
  const tipOf = new Map(tips.rows.map((t) => [t.staff_id, Number(t.n)]));
  const lines: PayrollLine[] = [];
  for (const s of staff.rows) {
    const rows = ot.filter((r) => r.staff_id === s.id);
    const baseMin = rows.reduce((t, r) => t + r.attended_min - (r.rostered_min > 0 ? r.extra_min : 0), 0);
    const overtime = rows.reduce((t, r) => t + (r.rostered_min > 0 ? r.extra_cost_minor : 0), 0);
    const base = s.pay_basis === "hourly" ? mulDiv(baseMin, Number(s.wage_rate_minor), 60) : Number(s.monthly_salary_minor);
    if (s.pay_basis === "hourly" && rows.length === 0) continue; // nothing attended, nothing to pay
    const tipsMinor = tipOf.get(s.id) ?? 0;
    lines.push({ staff_id: s.id, base_minor: base, overtime_minor: overtime, advance_recovery_minor: 0, tips_minor: tipsMinor,
      net_minor: base + overtime + tipsMinor, outstanding_advance_minor: await outstandingAdvance(c, s.id) });
  }
  const currency = staff.rows[0]?.currency ?? (await c.query<{ b: string }>(`SELECT base_currency AS b FROM core.tenant`)).rows[0]!.b;
  return { currency, lines };
}

export const payrollDraftHandler: CommandHandler = {
  type: "people.payroll_draft.create.v1",
  async run(c, cmd) {
    const p = PeoplePayrollDraftCreateV1.parse(cmd.payload);
    try {
      await c.query(`INSERT INTO core.payroll_draft (tenant_id, id, outlet_id, period_month, currency)
                     VALUES (current_setting('app.tenant_id')::uuid, $1, $2, $3, $4)`, [p.payroll_draft_id, p.outlet_id, p.period_month, p.currency]);
    } catch (e) {
      // The database judges pack scope (MB013); the refusal carries the pack reason code.
      const r = dbRefusal(e);
      if (r?.code === "out_of_pack_scope") throw new ApiError("out_of_pack_scope", "payroll_out_of_scope");
      throw r ?? e;
    }
    for (const l of p.lines) {
      const s = await c.query<{ outlet_id: string }>(`SELECT outlet_id FROM core.staff WHERE id = $1`, [l.staff_id]);
      if (s.rows[0]?.outlet_id !== p.outlet_id) throw new ApiError("invalid_payload");
      if (l.advance_recovery_minor > (await outstandingAdvance(c, l.staff_id))) throw new ApiError("conflict");
      try {
        await c.query(
          `INSERT INTO core.payroll_draft_line (tenant_id, id, payroll_draft_id, staff_id, base_minor, overtime_minor, tips_minor, advance_recovery_minor, net_minor, currency)
           VALUES (current_setting('app.tenant_id')::uuid, $9, $1, $2, $3, $4, $5, $6, $7, $8)`,
          [p.payroll_draft_id, l.staff_id, l.base_minor, l.overtime_minor, l.tips_minor, l.advance_recovery_minor, l.net_minor, p.currency, uuidv7()]);
        if (l.advance_recovery_minor > 0) {
          await c.query(
            `INSERT INTO core.advance (tenant_id, id, staff_id, kind, amount_minor, currency, on_date, payroll_draft_id, recorded_by)
             VALUES (current_setting('app.tenant_id')::uuid, $6, $1, 'recovered', $2, $3, $4, $5, current_setting('app.member_id')::uuid)`,
            [l.staff_id, l.advance_recovery_minor, p.currency, p.period_month, p.payroll_draft_id, uuidv7()]);
        }
      } catch (e) {
        throw dbRefusal(e) ?? e;
      }
    }
    // Derived postings (finance.post_payroll): written by finance's seam under its rule + source_ref, same transaction.
    await postFor(c, "finance.post_payroll", `core.payroll_draft:${p.payroll_draft_id}`);
    return {
      entityId: p.payroll_draft_id,
      audit: [{ entity: "core.payroll_draft", entityId: p.payroll_draft_id, after: { outlet_id: p.outlet_id, period_month: p.period_month, lines: p.lines.length } }],
    };
  },
};

/** people.payroll_draft.status.v1 (owner): approved → paid_externally (recorded only; the entry stands) or → void
 *  with a reason, which reverses the payroll's journal entry under finance.reverse_payroll in this transaction. */
export const payrollStatusHandler: CommandHandler = {
  type: "people.payroll_draft.status.v1",
  async run(c, cmd) {
    const p = PeoplePayrollDraftStatusV1.parse(cmd.payload);
    if (p.status === "void" && !p.reason_code) throw new ApiError("invalid_payload", "reason_required");
    const cur = (await c.query<{ status: string }>(`SELECT status FROM core.payroll_draft WHERE id = $1 FOR UPDATE`, [p.payroll_draft_id])).rows[0];
    if (!cur) throw new ApiError("not_found");
    if (cur.status !== "approved") throw new ApiError("illegal_transition");
    try {
      await c.query(`UPDATE core.payroll_draft SET status = $2 WHERE id = $1 AND status = 'approved'`, [p.payroll_draft_id, p.status]);
    } catch (e) {
      throw dbRefusal(e) ?? e;
    }
    if (p.status === "void") await reverseSource(c, "finance.reverse_payroll", `core.payroll_draft:${p.payroll_draft_id}`);
    return {
      entityId: p.payroll_draft_id,
      audit: [{ entity: "core.payroll_draft", entityId: p.payroll_draft_id, before: { status: "approved" }, after: { status: p.status, reason_code: p.reason_code } }],
    };
  },
};
