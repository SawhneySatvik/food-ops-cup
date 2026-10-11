import { S1, T, T_PG, snapRef, u } from "./_ids.ts";

const shift = { roster_shift_id: u(1100), staff_id: u(1000), starts_at: "2026-10-12T09:00:00+05:30", ends_at: "2026-10-12T17:00:00+05:30", role_key: "cook" };
const payrollLine = (v: unknown) => ({ staff_id: u(1000), base_minor: v, overtime_minor: v, advance_recovery_minor: v, tips_minor: v, net_minor: v });
const lineSnap = (col: string) => snapRef(S1, 0, col);

export const SAMPLES: Record<string, unknown> = {
  "people.staff.upsert.v1": {
    staff_id: u(1000), member_id: null, outlet_id: u(2), name: "Synthetic Cook", phone: "+919800000000", role_key: "cook", pay_basis: "hourly",
    wage_rate_minor: 20000, monthly_salary_minor: null, contract_min_per_month: null, ot_multiplier_bp: 15000, currency: "INR",
    joined_on: "2026-01-01", left_on: null, active: true,
  },
  "people.roster.create.v1": { roster_id: u(1010), outlet_id: u(2), week_start: "2026-10-12", shifts: [shift] },
  "people.roster.update.v1": { roster_id: u(1010), cancel_roster: false, add_shifts: [], edit_shifts: [{ roster_shift_id: u(1100), starts_at: shift.starts_at, ends_at: "2026-10-12T16:00:00+05:30", role_key: "cook" }], cancel_shift_ids: [] },
  "people.attendance.record.v1": { attendance_id: u(1020), outlet_id: u(2), staff_id: u(1000), action: "clock_in", at: T, roster_shift_id: u(1100), source: "device" },
  "people.payroll_draft.create.v1": { payroll_draft_id: u(1030), outlet_id: u(2), period_month: "2026-09-01", currency: "INR", lines: [payrollLine(100000)] },
  "people.payroll_draft.status.v1": { payroll_draft_id: u(1030), status: "void", reason_code: "entered_twice" },
  "people.advance.record.v1": { advance_id: u(1040), staff_id: u(1000), kind: "given", amount_minor: 1500000, currency: "INR", on_date: "2026-10-01", note: null },
  "people.tip_pool.record.v1": {
    tip_pool_id: u(1050), outlet_id: u(2), period_from: "2026-10-01", period_to: "2026-10-07", basis: "equal", total_minor: 20000, currency: "INR",
    manual_shares: [], staff_ids: [u(1000)],
  },
  "people.training.record.v1": { training_id: u(1060), staff_id: u(1000), course_key: "training.food_safety", completed_on: "2026-09-15", valid_to: null, document_id: null },
  "people.candidate.upsert.v1": { candidate_id: u(1070), outlet_id: u(2), name: "Synthetic Applicant", phone: null, email: null, role_key: "server", stage: "applied", source: "walk_in", note: null },
  "proposal.people.roster.create.v1": { roster_id: u(1010), outlet_id: u(2), week_start: "2026-10-12", shifts: [shift] },
  "proposal.people.payroll_draft.create.v1": {
    payroll_draft_id: u(1030), outlet_id: u(2), period_month: "2026-09-01", currency: "INR",
    lines: [{ staff_id: u(1000), base_minor: lineSnap("base_minor"), overtime_minor: lineSnap("overtime_minor"), advance_recovery_minor: lineSnap("advance_recovery_minor"), tips_minor: lineSnap("tips_minor"), net_minor: lineSnap("net_minor") }],
  },
  "v1.people.command-result": { command_id: u(1080), type: "people.staff.upsert.v1", entity_id: u(1000), committed_at: T },
  "v1.people.overtime.response": {
    outlet_id: u(2), from: "2026-08-01", to: "2026-08-31",
    rows: [{ staff_id: u(1000), iso_week: "2026-W32", rostered_min: 960, attended_min: 1035, extra_min: 75, extra_cost_minor: 37500 }],
  },
  "v1.people.staff.list": {
    outlet_id: u(2),
    staff: [{
      staff_id: u(1000), member_id: null, outlet_id: u(2), name: "Synthetic Cook", role_key: "cook", pay_basis: "hourly", wage_rate_minor: 20000, monthly_salary_minor: null,
      contract_min_per_month: null, ot_multiplier_bp: 15000, currency: "INR", joined_on: "2026-01-01", left_on: null, active: true,
    }],
  },
  "v1.people.payroll-preview.response": {
    outlet_id: u(2), period_month: "2026-08-01", currency: "INR",
    lines: [{ staff_id: u(1000), base_minor: 500000, overtime_minor: 157500, advance_recovery_minor: 0, tips_minor: 5000, net_minor: 662500, outstanding_advance_minor: 19000 }],
  },
  "v1.people.rosters": {
    items: [{ roster_id: u(3300), outlet_id: u(2), week_start: "2026-10-12", status: "active", shifts: [{ roster_shift_id: u(3301), staff_id: u(1000), starts_at: T, ends_at: T_PG, role_key: "cook", status: "scheduled" }] }],
    next_cursor: null,
  },
  "v1.people.attendance": {
    items: [{ attendance_id: u(3310), outlet_id: u(2), staff_id: u(1000), roster_shift_id: null, clock_in_at: T, clock_out_at: null, source: "device", recorded_by: u(8) }],
    next_cursor: null,
  },
  "v1.people.advances": {
    items: [{ advance_id: u(3320), staff_id: u(1000), outlet_id: u(2), kind: "given", amount_minor: 1500000, currency: "INR", on_date: "2026-10-01", payroll_draft_id: null, note: null, recorded_by: u(8) }],
    next_cursor: null,
  },
  "v1.people.payroll-drafts": {
    items: [{
      payroll_draft_id: u(3330), outlet_id: u(2), period_month: "2026-09-01", status: "approved", currency: "INR", created_at: T,
      lines: [{ payroll_line_id: u(3331), staff_id: u(1000), base_minor: 2000000, overtime_minor: 100000, tips_minor: 0, advance_recovery_minor: 500000, net_minor: 1600000, currency: "INR" }],
    }],
    next_cursor: null,
  },
};
