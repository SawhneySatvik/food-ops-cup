// People command handlers. Each is bound to one seeded command type (db/migrations/0010 command_authority)
// and writes only that command's target tables. `recorded_by` / actor columns come from app.member_id (the
// verified principal, or the approver under a decision) — never from a payload.
import {
  PeopleAdvanceRecordV1, PeopleAttendanceRecordV1, PeopleCandidateUpsertV1, PeopleRosterCreateV1, PeopleRosterUpdateV1,
  PeopleStaffUpsertV1, PeopleTipPoolRecordV1, PeopleTrainingRecordV1,
} from "@munim/contracts/people";
import { allocate } from "@munim/core-domain/money";
import { type CommandHandler, uuidv7 } from "../../commit/index.ts";
import { ApiError } from "../../lib/errors.ts";
import type { Queryable } from "../../runtoken/index.ts";
import { dbRefusal } from "./errors.ts";
import { outstandingAdvance } from "./payroll.ts";
import { postFor } from "./seams.ts";

const T = `current_setting('app.tenant_id')::uuid`;
const ME = `current_setting('app.member_id')::uuid`;

/** Runs a statement block, turning database refusals into client errors (never their text). */
async function guarded<R>(fn: () => Promise<R>): Promise<R> {
  try {
    return await fn();
  } catch (e) {
    throw dbRefusal(e) ?? e;
  }
}

function parse<S extends { parse(v: unknown): unknown }>(schema: S, v: unknown): ReturnType<S["parse"]> {
  try {
    return schema.parse(v) as ReturnType<S["parse"]>;
  } catch {
    throw new ApiError("invalid_payload");
  }
}

// R1-m11: a pay change is audited with its amounts (before → after); name and phone never ride in the audit.
const PAY = `pay_basis, wage_rate_minor::text, monthly_salary_minor::text, contract_min_per_month, ot_multiplier_bp, currency`;
type Pay = { pay_basis: string; wage_rate_minor: string | null; monthly_salary_minor: string | null; contract_min_per_month: number | null; ot_multiplier_bp: number; currency: string };
const payOf = (r: Pay) => ({
  pay_basis: r.pay_basis, wage_rate_minor: r.wage_rate_minor === null ? null : Number(r.wage_rate_minor),
  monthly_salary_minor: r.monthly_salary_minor === null ? null : Number(r.monthly_salary_minor),
  contract_min_per_month: r.contract_min_per_month, ot_multiplier_bp: r.ot_multiplier_bp, currency: r.currency,
});

export const staffUpsertHandler: CommandHandler = {
  type: "people.staff.upsert.v1",
  async run(c, cmd) {
    const p = parse(PeopleStaffUpsertV1, cmd.payload);
    const prior = (await c.query<Pay & { outlet_id: string; role_key: string; active: boolean }>(
      `SELECT ${PAY}, outlet_id, role_key, active FROM core.staff WHERE id = $1 FOR UPDATE`, [p.staff_id])).rows[0];
    const r = await guarded(() => c.query<{ member_id: string | null; joined_on: string; currency: string }>(
      `INSERT INTO core.staff (tenant_id, id, member_id, outlet_id, name, phone, role_key, pay_basis, wage_rate_minor, monthly_salary_minor,
                               contract_min_per_month, ot_multiplier_bp, currency, joined_on, left_on, active, created_by)
       VALUES (${T}, $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, ${ME})
       ON CONFLICT (tenant_id, id) DO UPDATE SET outlet_id = EXCLUDED.outlet_id, name = EXCLUDED.name, phone = EXCLUDED.phone,
         role_key = EXCLUDED.role_key, pay_basis = EXCLUDED.pay_basis, wage_rate_minor = EXCLUDED.wage_rate_minor,
         monthly_salary_minor = EXCLUDED.monthly_salary_minor, contract_min_per_month = EXCLUDED.contract_min_per_month,
         ot_multiplier_bp = EXCLUDED.ot_multiplier_bp, left_on = EXCLUDED.left_on, active = EXCLUDED.active
       RETURNING member_id, to_char(joined_on, 'YYYY-MM-DD') AS joined_on, ${PAY}`,
      [p.staff_id, p.member_id, p.outlet_id, p.name, p.phone, p.role_key, p.pay_basis, p.wage_rate_minor, p.monthly_salary_minor,
       p.contract_min_per_month, p.ot_multiplier_bp, p.currency, p.joined_on, p.left_on, p.active]));
    // member_id, joined_on and currency are fixed at creation (not in the column grant): a change is refused, not dropped.
    const row = r.rows[0]! as Pay & { member_id: string | null; joined_on: string };
    if (row.member_id !== p.member_id || row.joined_on !== p.joined_on || row.currency !== p.currency) throw new ApiError("invalid_payload");
    const after = { outlet_id: p.outlet_id, role_key: p.role_key, active: p.active, ...payOf(row) };
    return {
      entityId: p.staff_id,
      audit: [{ entity: "core.staff", entityId: p.staff_id,
        ...(prior ? { before: { outlet_id: prior.outlet_id, role_key: prior.role_key, active: prior.active, ...payOf(prior) } } : {}), after }],
    };
  },
};

type ShiftIn = { roster_shift_id: string; staff_id: string; starts_at: string; ends_at: string; role_key: string };
type ShiftAudit = { entity: "core.roster_shift"; entityId: string; before?: unknown; after: unknown };

// R1-M2: every roster_shift row written is audited on its own, with what it was before and after. Times are UTC ISO.
const SHIFT = `staff_id, to_char(starts_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"') AS starts_at,
               to_char(ends_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"') AS ends_at, role_key, status`;
type ShiftRow = { id: string; staff_id: string; starts_at: string; ends_at: string; role_key: string; status: string };
const shiftOf = ({ id: _id, ...r }: ShiftRow) => r;

async function insertShifts(c: Queryable, rosterId: string, outletId: string, shifts: ShiftIn[]): Promise<ShiftAudit[]> {
  const out: ShiftAudit[] = [];
  for (const s of shifts) {
    const r = await c.query<ShiftRow>(
      `INSERT INTO core.roster_shift (tenant_id, id, roster_id, outlet_id, staff_id, starts_at, ends_at, role_key, created_by)
       VALUES (${T}, $1, $2, $3, $4, $5, $6, $7, ${ME}) RETURNING id, ${SHIFT}`,
      [s.roster_shift_id, rosterId, outletId, s.staff_id, s.starts_at, s.ends_at, s.role_key]);
    out.push({ entity: "core.roster_shift", entityId: s.roster_shift_id, after: shiftOf(r.rows[0]!) });
  }
  return out;
}

/** Every scheduled shift of the roster must start on a local date inside its week. */
async function assertShiftsInWeek(c: Queryable, rosterId: string) {
  const r = await c.query(
    `SELECT 1 FROM core.roster ro JOIN core.outlet o ON o.tenant_id = ro.tenant_id AND o.id = ro.outlet_id
       JOIN core.roster_shift s ON s.tenant_id = ro.tenant_id AND s.roster_id = ro.id AND s.status = 'scheduled'
      WHERE ro.id = $1 AND NOT ((s.starts_at AT TIME ZONE o.tz)::date BETWEEN ro.week_start AND ro.week_start + 6) LIMIT 1`, [rosterId]);
  if (r.rows.length) throw new ApiError("invalid_payload");
}

/** Also the draft handler: a roster proposed by intel writes nothing until a person approves it. */
export const rosterCreateHandler: CommandHandler = {
  type: "people.roster.create.v1",
  async run(c, cmd) {
    const p = parse(PeopleRosterCreateV1, cmd.payload);
    const shifts = await guarded(async () => {
      await c.query(
        `INSERT INTO core.roster (tenant_id, id, outlet_id, week_start, draft_id, created_by)
         VALUES (${T}, $1, $2, $3, (SELECT draft_id FROM core.decision WHERE id = nullif(current_setting('app.decision_id', true), '')::uuid), ${ME})`,
        [p.roster_id, p.outlet_id, p.week_start]);
      const added = await insertShifts(c, p.roster_id, p.outlet_id, p.shifts);
      await assertShiftsInWeek(c, p.roster_id);
      return added;
    });
    return { entityId: p.roster_id, audit: [{ entity: "core.roster", entityId: p.roster_id, after: { outlet_id: p.outlet_id, week_start: p.week_start, shifts: p.shifts.length } }, ...shifts] };
  },
};

export const rosterUpdateHandler: CommandHandler = {
  type: "people.roster.update.v1",
  async run(c, cmd) {
    const p = parse(PeopleRosterUpdateV1, cmd.payload);
    if (!p.cancel_roster && !p.add_shifts.length && !p.edit_shifts.length && !p.cancel_shift_ids.length) throw new ApiError("invalid_payload");
    const rows = await guarded(async () => {
      const ro = await c.query<{ outlet_id: string; status: string }>(`SELECT outlet_id, status FROM core.roster WHERE id = $1 FOR UPDATE`, [p.roster_id]);
      if (!ro.rows[0]) throw new ApiError("not_found");
      if (ro.rows[0].status !== "active") throw new ApiError("illegal_transition");
      const out: ShiftAudit[] = [];
      // One shift's update, audited with the row as it was (locked) and as it is now.
      const change = async (id: string, set: string, args: unknown[]) => {
        const before = (await c.query<ShiftRow>(`SELECT id, ${SHIFT} FROM core.roster_shift WHERE id = $1 AND roster_id = $2 AND status = 'scheduled' FOR UPDATE`,
          [id, p.roster_id])).rows[0];
        if (!before) throw new ApiError("illegal_transition");
        const after = (await c.query<ShiftRow>(`UPDATE core.roster_shift SET ${set} WHERE id = $1 RETURNING id, ${SHIFT}`, [id, ...args])).rows[0]!;
        out.push({ entity: "core.roster_shift", entityId: id, before: shiftOf(before), after: shiftOf(after) });
      };
      if (p.cancel_roster) {
        const open = await c.query<{ id: string }>(`SELECT id FROM core.roster_shift WHERE roster_id = $1 AND status = 'scheduled' ORDER BY id`, [p.roster_id]);
        for (const s of open.rows) await change(s.id, `status = 'cancelled'`, []);
        await c.query(`UPDATE core.roster SET status = 'cancelled' WHERE id = $1`, [p.roster_id]);
        return out;
      }
      for (const id of p.cancel_shift_ids) await change(id, `status = 'cancelled'`, []);
      for (const e of p.edit_shifts) await change(e.roster_shift_id, `starts_at = $2, ends_at = $3, role_key = $4`, [e.starts_at, e.ends_at, e.role_key]);
      out.push(...(await insertShifts(c, p.roster_id, ro.rows[0].outlet_id, p.add_shifts)));
      await assertShiftsInWeek(c, p.roster_id);
      return out;
    });
    return {
      entityId: p.roster_id,
      audit: [
        { entity: "core.roster", entityId: p.roster_id, ...(p.cancel_roster ? { before: { status: "active" } } : {}),
          after: { status: p.cancel_roster ? "cancelled" : "active", added: p.add_shifts.length, edited: p.edit_shifts.length, cancelled: p.cancel_shift_ids.length } },
        ...rows,
      ],
    };
  },
};

export const attendanceHandler: CommandHandler = {
  type: "people.attendance.record.v1",
  async run(c, cmd) {
    const p = parse(PeopleAttendanceRecordV1, cmd.payload);
    // A clock time in the future is not a record of anything that happened.
    const fut = await c.query<{ f: boolean }>(`SELECT $1::timestamptz > now() + interval '5 minutes' AS f`, [p.at]);
    if (fut.rows[0]!.f) throw new ApiError("invalid_payload");
    await guarded(async () => {
      if (p.action === "clock_in") {
        await c.query(
          `INSERT INTO core.attendance (tenant_id, id, outlet_id, staff_id, roster_shift_id, clock_in_at, source, recorded_by)
           VALUES (${T}, $1, $2, $3, $4, $5, $6, ${ME})`,
          [p.attendance_id, p.outlet_id, p.staff_id, p.roster_shift_id, p.at, p.source]);
      } else {
        const r = await c.query(
          `UPDATE core.attendance SET clock_out_at = $4 WHERE id = $1 AND outlet_id = $2 AND staff_id = $3 AND clock_out_at IS NULL`,
          [p.attendance_id, p.outlet_id, p.staff_id, p.at]);
        if (r.rowCount !== 1) throw new ApiError("conflict");
      }
    });
    return { entityId: p.attendance_id, audit: [{ entity: "core.attendance", entityId: p.attendance_id, after: { action: p.action, outlet_id: p.outlet_id, staff_id: p.staff_id } }] };
  },
};

export const advanceHandler: CommandHandler = {
  type: "people.advance.record.v1",
  async run(c, cmd) {
    const p = parse(PeopleAdvanceRecordV1, cmd.payload);
    await guarded(async () => {
      if (p.kind === "recovered" && p.amount_minor > (await outstandingAdvance(c, p.staff_id))) throw new ApiError("conflict");
      await c.query(
        `INSERT INTO core.advance (tenant_id, id, staff_id, kind, amount_minor, currency, on_date, note, recorded_by)
         VALUES (${T}, $1, $2, $3, $4, $5, $6, $7, ${ME})`,
        [p.advance_id, p.staff_id, p.kind, p.amount_minor, p.currency, p.on_date, p.note]);
      // R2-S1-5: money handed to (or paid back by) a staff member moves staff advances (1250) — finance.post_advance.
      await postFor(c, "finance.post_advance", `core.advance:${p.advance_id}`);
    });
    return { entityId: p.advance_id, audit: [{ entity: "core.advance", entityId: p.advance_id, after: { staff_id: p.staff_id, kind: p.kind, amount_minor: p.amount_minor } }] };
  },
};

export const tipPoolHandler: CommandHandler = {
  type: "people.tip_pool.record.v1",
  async run(c, cmd) {
    const p = parse(PeopleTipPoolRecordV1, cmd.payload);
    let shares: Array<{ staff_id: string; amount_minor: number }>;
    if (p.basis === "manual") {
      shares = p.manual_shares;
      if (!shares.length || shares.reduce((t, s) => t + s.amount_minor, 0) !== p.total_minor) throw new ApiError("invalid_payload");
    } else {
      if (!p.staff_ids.length || p.manual_shares.length || new Set(p.staff_ids).size !== p.staff_ids.length) throw new ApiError("invalid_payload");
      let weights: number[];
      if (p.basis === "equal") weights = p.staff_ids.map(() => 1);
      else {
        // Attended minutes in the period at this outlet; no attendance, no split (never assume rostered = worked).
        const r = await c.query<{ staff_id: string; m: number }>(
          `SELECT a.staff_id, sum(extract(epoch FROM a.clock_out_at - a.clock_in_at) / 60)::int AS m
             FROM core.attendance a JOIN core.outlet o ON o.tenant_id = a.tenant_id AND o.id = a.outlet_id
            WHERE a.outlet_id = $1 AND a.clock_out_at IS NOT NULL AND a.staff_id = ANY($4::uuid[])
              AND (a.clock_in_at AT TIME ZONE o.tz)::date BETWEEN $2::date AND $3::date GROUP BY 1`,
          [p.outlet_id, p.period_from, p.period_to, p.staff_ids]);
        const by = new Map(r.rows.map((x) => [x.staff_id, x.m]));
        weights = p.staff_ids.map((id) => by.get(id) ?? 0);
        if (weights.every((w) => w === 0)) throw new ApiError("cannot_verify", "attendance_missing");
      }
      const parts = allocate(p.total_minor, weights);
      shares = p.staff_ids.map((staff_id, i) => ({ staff_id, amount_minor: parts[i]! }));
    }
    await guarded(async () => {
      await c.query(
        `INSERT INTO core.tip_pool (tenant_id, id, outlet_id, period_from, period_to, basis, total_minor, currency, created_by)
         VALUES (${T}, $1, $2, $3, $4, $5, $6, $7, ${ME})`,
        [p.tip_pool_id, p.outlet_id, p.period_from, p.period_to, p.basis, p.total_minor, p.currency]);
      for (const s of shares) {
        await c.query(
          `INSERT INTO core.tip_pool_share (tenant_id, id, tip_pool_id, staff_id, amount_minor, currency) VALUES (${T}, $1, $2, $3, $4, $5)`,
          [uuidv7(), p.tip_pool_id, s.staff_id, s.amount_minor, p.currency]);
      }
    });
    return { entityId: p.tip_pool_id, audit: [{ entity: "core.tip_pool", entityId: p.tip_pool_id, after: { outlet_id: p.outlet_id, basis: p.basis, shares: shares.length } }] };
  },
};

export const trainingHandler: CommandHandler = {
  type: "people.training.record.v1",
  async run(c, cmd) {
    const p = parse(PeopleTrainingRecordV1, cmd.payload);
    await guarded(() => c.query(
      `INSERT INTO core.training_record (tenant_id, id, staff_id, course_key, completed_on, valid_to, document_id, created_by)
       VALUES (${T}, $1, $2, $3, $4, $5, $6, ${ME})`,
      [p.training_id, p.staff_id, p.course_key, p.completed_on, p.valid_to, p.document_id]));
    return { entityId: p.training_id, audit: [{ entity: "core.training_record", entityId: p.training_id, after: { staff_id: p.staff_id, course_key: p.course_key } }] };
  },
};

export const candidateHandler: CommandHandler = {
  type: "people.candidate.upsert.v1",
  async run(c, cmd) {
    const p = parse(PeopleCandidateUpsertV1, cmd.payload);
    // Only stage and note are updatable (0010 grant); the stage move itself is judged by book_status_transition (MB004).
    const r = await guarded(() => c.query<{ outlet_id: string; name: string; role_key: string; stage: string }>(
      `INSERT INTO core.hiring_candidate (tenant_id, id, outlet_id, name, phone, email, role_key, stage, source, note, created_by)
       VALUES (${T}, $1, $2, $3, $4, $5, $6, $7, $8, $9, ${ME})
       ON CONFLICT (tenant_id, id) DO UPDATE SET stage = EXCLUDED.stage, note = EXCLUDED.note
       RETURNING outlet_id, name, role_key, stage`,
      [p.candidate_id, p.outlet_id, p.name, p.phone, p.email, p.role_key, p.stage, p.source, p.note]));
    const row = r.rows[0]!;
    if (row.outlet_id !== p.outlet_id || row.name !== p.name || row.role_key !== p.role_key) throw new ApiError("invalid_payload");
    return { entityId: p.candidate_id, audit: [{ entity: "core.hiring_candidate", entityId: p.candidate_id, after: { stage: p.stage } }] };
  },
};
