// T-027 gates — the people module through the real app (member auth → withContext → RLS → book guard).
//   AU payroll refused (MB013 → out_of_pack_scope / payroll_out_of_scope), IN accepted with lines, a recovery
//   entry and the finance.post_payroll seam called; overlapping roster shift refused / adjacent accepted;
//   overtime for a fixture fortnight = hand-computed; roster draft writes nothing until approved; staff of
//   outlet A cannot record attendance for outlet B; attendance coverage < 8,000 bp → attendance_missing.
// Hand-computed expectations (outlet 0, Asia/Kolkata, August 2026; W32 = Mon 3 Aug, W33 = Mon 10 Aug):
//   S1 hourly ₹200/h (20000), OT 1.5x. W32 rostered Mon+Tue 09:00-17:00 = 960 min; attended 525 + 510 = 1035
//      → extra 75 min → 75/60 h × 20000 × 1.5 = 37500. W33 rostered Mon 480; attended Mon 480 + Tue (unrostered) 240
//      = 720 → extra 240 → 4 h × 20000 × 1.5 = 120000.
//   S2 monthly ₹30,000 (3,000,000) over 200 h (12000 min) = ₹150/h (15000), OT 2x. W32 rostered 960; attended 480 + 540
//      = 1020 → extra 60 min → 1 h × 15000 × 2 = 30000. W33 rostered 480, attended 480 → extra 0.
// Synthetic data only.
import { createLogger } from "@munim/config";
import { CommandResult } from "@munim/contracts";
import { OvertimeWeekRow, PeopleCommandResult, PeopleOvertimeResponse, PeoplePayrollPreviewResponse, PeopleStaffListResponse } from "@munim/contracts/people";
import { buildWorld, type TestDb } from "@munim/db";
import type { Hono } from "hono";
import type pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { type AppEnv, createApp, TENANT_HEADER } from "../src/app.ts";
import { uuidv7 } from "../src/commit/index.ts";
import { setPostFor } from "../src/modules/people/seams.ts";
import { createLocalIdp } from "../src/auth/local-idp.ts";
import { openDb } from "./db.ts";
import { buildTenant, type Tenant } from "./world.ts";

const idp = createLocalIdp();
let db: TestDb;
let pools: { core: pg.Pool; svc: pg.Pool };
let app: Hono<AppEnv>;
let t: Tenant;
const staffSub = `staff-${uuidv7()}`;
const S1 = uuidv7(), S2 = uuidv7(), S3 = uuidv7();
const posted: Array<{ rule: string; ref: string }> = [];

type Res = Omit<Response, "json"> & { json(): Promise<any> };
const call = async (method: string, path: string, sub: string, tenant: string, body?: unknown): Promise<Res> =>
  (await app.request(path, {
    method,
    headers: { Authorization: `Bearer ${idp.sign({ sub })}`, [TENANT_HEADER]: tenant, "Content-Type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  })) as Res;
const env = (type: string, payload: unknown, key = `k-${uuidv7()}`) => ({ command_id: uuidv7(), idempotency_key: key, type, payload });
const as = (who: "owner" | "manager" | "staff") => (who === "owner" ? t.ownerSub : who === "manager" ? t.managerSub : staffSub);
const post = (who: "owner" | "manager" | "staff", path: string, type: string, payload: unknown) => call("POST", path, as(who), t.tenant, env(type, payload));
const one = async <R extends pg.QueryResultRow>(sql: string, params: unknown[] = []) => (await db.admin(sql, params)).rows[0] as R;
const count = async (sql: string, params: unknown[] = []) => Number((await one<{ n: string }>(sql, params)).n);
const err = async (r: Res) => {
  const b = await r.json();
  return { status: r.status, code: b.error.code, reason: b.error.reason_code };
};

const ist = (date: string, hhmm: string) => `${date}T${hhmm}:00+05:30`;
const shift = (staff: string, date: string, from: string, to: string, role = "cook") => ({ roster_shift_id: uuidv7(), staff_id: staff, starts_at: ist(date, from), ends_at: ist(date, to), role_key: role });
const staffBody = (id: string, outlet: string, o: Record<string, unknown> = {}) => ({
  staff_id: id, member_id: null, outlet_id: outlet, name: `Synthetic ${id.slice(-4)}`, phone: null, role_key: "cook", pay_basis: "hourly",
  wage_rate_minor: 20000, monthly_salary_minor: null, contract_min_per_month: null, ot_multiplier_bp: 15000, currency: "INR",
  joined_on: "2026-01-01", left_on: null, active: true, ...o,
});
const clock = (outlet: string, staff: string, shiftId: string | null, date: string, from: string, to: string | null) => async (who: "owner" | "manager" | "staff" = "manager") => {
  const id = uuidv7();
  const inn = await post(who, "/v1/people/attendance", "people.attendance.record.v1", { attendance_id: id, outlet_id: outlet, staff_id: staff, action: "clock_in", at: ist(date, from), roster_shift_id: shiftId, source: "manual" });
  expect(inn.status).toBe(200);
  if (to) {
    const out = await post(who, "/v1/people/attendance", "people.attendance.record.v1", { attendance_id: id, outlet_id: outlet, staff_id: staff, action: "clock_out", at: ist(date, to), roster_shift_id: null, source: "manual" });
    expect(out.status).toBe(200);
  }
  return id;
};

beforeAll(async () => {
  db = await openDb();
  t = await buildTenant(db, "people");
  await db.withContext("munim_core", { tenant_id: t.tenant, outlet_ids: "*", role: "owner", member_id: t.owner, command_type: "tenancy.member.invite.v1" }, (c) =>
    c.query(`UPDATE core.member SET idp_sub = $3 WHERE tenant_id = $1 AND id = $2`, [t.tenant, t.staff, staffSub]));
  pools = { core: db.pool("munim_core", 8), svc: db.pool("munim_svc", 2) };
  const config = { nodeEnv: "test", redact: (s: string) => s };
  app = await createApp({ pools, idp, storefronts: async () => null, config, log: createLogger(config, () => {}) });
  setPostFor(async (_tx, rule, ref) => {
    posted.push({ rule, ref });
  });
});
afterAll(async () => {
  setPostFor(undefined);
  await pools?.core.end();
  await pools?.svc.end();
  await db?.stop();
});

const O0 = () => t.outlets[0];
const O1 = () => t.outlets[1];
const ROSTER_W32 = uuidv7(), ROSTER_W33 = uuidv7();
const shiftIds: Record<string, string> = {};

describe("staff, rosters and the overlap rule", () => {
  it("staff records: owner creates three (hourly, monthly, an outlet-1 cook); a staff-role member is refused", async () => {
    const denied = await post("staff", "/v1/people/staff:upsert", "people.staff.upsert.v1", staffBody(S1, O0()));
    expect(await err(denied)).toEqual({ status: 403, code: "book_write_refused", reason: "authority_denied" });
    expect(await count(`SELECT count(*) n FROM core.staff WHERE id = $1`, [S1])).toBe(0);
    for (const [id, outlet, o] of [
      [S1, O0(), {}],
      [S2, O0(), { pay_basis: "monthly", wage_rate_minor: null, monthly_salary_minor: 3000000, contract_min_per_month: 12000, ot_multiplier_bp: 20000 }],
      [S3, O1(), {}],
    ] as const) {
      const r = await post("owner", "/v1/people/staff:upsert", "people.staff.upsert.v1", staffBody(id, outlet, o));
      expect(r.status).toBe(200);
      expect(PeopleCommandResult.parse(await r.json())).toMatchObject({ type: "people.staff.upsert.v1", entity_id: id });
    }
    expect(await count(`SELECT count(*) n FROM core.staff WHERE id = ANY($1)`, [[S1, S2, S3]])).toBe(3);
    // Upsert edits a granted column, and refuses to change joined_on (not updatable).
    expect((await post("owner", "/v1/people/staff:upsert", "people.staff.upsert.v1", staffBody(S1, O0(), { name: "Renamed" }))).status).toBe(200);
    expect((await one<{ name: string }>(`SELECT name FROM core.staff WHERE id = $1`, [S1])).name).toBe("Renamed");
    expect((await err(await post("owner", "/v1/people/staff:upsert", "people.staff.upsert.v1", staffBody(S1, O0(), { joined_on: "2026-02-02" })))).code).toBe("invalid_payload");
  });

  it("GET /v1/people/staff: the outlet's staff with their pay terms (rows' own fields, no phone); staff-role 403; an outlet outside scope 404", async () => {
    const list = PeopleStaffListResponse.parse(await (await call("GET", `/v1/people/staff?outlet=${O0()}`, t.managerSub, t.tenant)).json());
    const pay = Object.fromEntries(list.staff.map((s) => [s.staff_id, [s.pay_basis, s.wage_rate_minor, s.monthly_salary_minor, s.contract_min_per_month, s.ot_multiplier_bp]]));
    expect([pay[S1], pay[S2], pay[S3]]).toEqual([["hourly", 20000, null, null, 15000], ["monthly", null, 3000000, 12000, 20000], undefined]);
    expect(JSON.stringify(list)).not.toContain("phone");
    expect(await err(await call("GET", `/v1/people/staff?outlet=${O0()}`, staffSub, t.tenant))).toEqual({ status: 403, code: "forbidden", reason: "authority_denied" });
    expect((await call("GET", `/v1/people/staff?outlet=${O1()}`, t.managerSub, t.tenant)).status).toBe(404);
  });

  it("builds the fixture rosters; an overlapping shift for one staff member is refused, an adjacent one accepted", async () => {
    const w32 = [shift(S1, "2026-08-03", "09:00", "17:00"), shift(S1, "2026-08-04", "09:00", "17:00"), shift(S2, "2026-08-03", "10:00", "18:00"), shift(S2, "2026-08-04", "10:00", "18:00")];
    const w33 = [shift(S1, "2026-08-10", "09:00", "17:00"), shift(S2, "2026-08-10", "10:00", "18:00")];
    expect((await post("manager", "/v1/people/rosters", "people.roster.create.v1", { roster_id: ROSTER_W32, outlet_id: O0(), week_start: "2026-08-03", shifts: w32 })).status).toBe(200);
    expect((await post("manager", "/v1/people/rosters", "people.roster.create.v1", { roster_id: ROSTER_W33, outlet_id: O0(), week_start: "2026-08-10", shifts: w33 })).status).toBe(200);
    for (const s of [...w32, ...w33]) shiftIds[`${s.staff_id === S1 ? "S1" : "S2"}-${s.starts_at.slice(0, 10)}`] = s.roster_shift_id;
    expect(await count(`SELECT count(*) n FROM core.roster_shift WHERE roster_id = ANY($1)`, [[ROSTER_W32, ROSTER_W33]])).toBe(6);

    // Overlap (12:00 < 13:00) inside one roster: refused, and the whole command rolls back.
    const bad = uuidv7();
    const overlap = await post("manager", "/v1/people/rosters", "people.roster.create.v1",
      { roster_id: bad, outlet_id: O0(), week_start: "2026-09-21", shifts: [shift(S1, "2026-09-21", "09:00", "13:00"), shift(S1, "2026-09-21", "12:00", "16:00")] });
    expect(await err(overlap)).toEqual({ status: 409, code: "conflict", reason: null });
    expect(await count(`SELECT count(*) n FROM core.roster WHERE id = $1`, [bad])).toBe(0);
    // Adjacent (13:00 = 13:00, half-open ranges): accepted.
    const good = uuidv7();
    const adjacent = await post("manager", "/v1/people/rosters", "people.roster.create.v1",
      { roster_id: good, outlet_id: O0(), week_start: "2026-09-21", shifts: [shift(S1, "2026-09-21", "09:00", "13:00"), shift(S1, "2026-09-21", "13:00", "17:00")] });
    expect(adjacent.status).toBe(200);
    expect(await count(`SELECT count(*) n FROM core.roster_shift WHERE roster_id = $1`, [good])).toBe(2);
    // Any outlet: S1 is rostered at outlet 0 on 21 Sep 09:00-13:00; an outlet-1 shift 11:00-12:00 overlaps it.
    const cross = await post("owner", "/v1/people/rosters", "people.roster.create.v1",
      { roster_id: uuidv7(), outlet_id: O1(), week_start: "2026-09-21", shifts: [shift(S1, "2026-09-21", "11:00", "12:00")] });
    expect((await err(cross)).code).toBe("conflict");
    // A shift outside the roster's week is refused.
    const out = await post("manager", "/v1/people/rosters", "people.roster.create.v1",
      { roster_id: uuidv7(), outlet_id: O0(), week_start: "2026-08-31", shifts: [shift(S2, "2026-09-09", "09:00", "10:00")] });
    expect((await err(out)).code).toBe("invalid_payload");
  });

  it("roster:update cancels a shift, then a replacement may take its slot; a staff member cannot edit rosters", async () => {
    const r = uuidv7();
    const s = shift(S2, "2026-09-14", "09:00", "17:00");
    expect((await post("manager", "/v1/people/rosters", "people.roster.create.v1", { roster_id: r, outlet_id: O0(), week_start: "2026-09-14", shifts: [s] })).status).toBe(200);
    const upd = (who: "manager" | "staff", o: Record<string, unknown>) =>
      post(who, "/v1/people/rosters:update", "people.roster.update.v1", { roster_id: r, cancel_roster: false, add_shifts: [], edit_shifts: [], cancel_shift_ids: [], ...o });
    expect((await upd("staff", { cancel_shift_ids: [s.roster_shift_id] })).status).toBe(403);
    expect((await upd("manager", { cancel_shift_ids: [s.roster_shift_id], add_shifts: [shift(S2, "2026-09-14", "09:00", "12:00")] })).status).toBe(200);
    expect(await count(`SELECT count(*) n FROM core.roster_shift WHERE roster_id = $1 AND status = 'cancelled'`, [r])).toBe(1);
    expect(await count(`SELECT count(*) n FROM core.roster_shift WHERE roster_id = $1 AND status = 'scheduled'`, [r])).toBe(1);
    // cancelling an already-cancelled shift is an illegal transition
    expect((await err(await upd("manager", { cancel_shift_ids: [s.roster_shift_id] }))).code).toBe("illegal_transition");
  });

  it("R1-M2: every roster_shift row written is audited on its own with before/after (cancel, add, edit)", async () => {
    const r = uuidv7();
    const a = shift(S2, "2026-09-08", "09:00", "17:00");
    const b = shift(S2, "2026-09-09", "09:00", "17:00");
    expect((await post("manager", "/v1/people/rosters", "people.roster.create.v1", { roster_id: r, outlet_id: O0(), week_start: "2026-09-07", shifts: [a, b] })).status).toBe(200);
    const audit = async (id: string) => (await db.admin<{ before: unknown; after: unknown }>(
      `SELECT before, after FROM core.audit_log WHERE tenant_id = $1 AND entity = 'core.roster_shift' AND entity_id = $2 ORDER BY seq`, [t.tenant, id])).rows;
    const row = (st: string, en: string, status = "scheduled") => ({ staff_id: S2, starts_at: st, ends_at: en, role_key: "cook", status });
    expect(await audit(a.roster_shift_id)).toEqual([{ before: null, after: row("2026-09-08T03:30:00Z", "2026-09-08T11:30:00Z") }]);
    const upd = await post("manager", "/v1/people/rosters:update", "people.roster.update.v1", { roster_id: r, cancel_roster: false, add_shifts: [],
      edit_shifts: [{ roster_shift_id: a.roster_shift_id, starts_at: ist("2026-09-08", "10:00"), ends_at: ist("2026-09-08", "14:00"), role_key: "cook" }],
      cancel_shift_ids: [b.roster_shift_id] });
    expect(upd.status).toBe(200);
    // IST 10:00–14:00 = 04:30–08:30 UTC (hand).
    expect((await audit(a.roster_shift_id))[1]).toEqual({ before: row("2026-09-08T03:30:00Z", "2026-09-08T11:30:00Z"), after: row("2026-09-08T04:30:00Z", "2026-09-08T08:30:00Z") });
    expect((await audit(b.roster_shift_id))[1]).toEqual({ before: row("2026-09-09T03:30:00Z", "2026-09-09T11:30:00Z"), after: row("2026-09-09T03:30:00Z", "2026-09-09T11:30:00Z", "cancelled") });
    // Cancelling the roster audits the one shift still scheduled.
    expect((await post("manager", "/v1/people/rosters:update", "people.roster.update.v1", { roster_id: r, cancel_roster: true, add_shifts: [], edit_shifts: [], cancel_shift_ids: [] })).status).toBe(200);
    expect((await audit(a.roster_shift_id))[2]).toEqual({ before: row("2026-09-08T04:30:00Z", "2026-09-08T08:30:00Z"), after: row("2026-09-08T04:30:00Z", "2026-09-08T08:30:00Z", "cancelled") });
    expect((await audit(b.roster_shift_id)).length).toBe(2);
  });

  it("R1-m11: a pay change is audited with its amounts before and after (never the name or phone)", async () => {
    const s5 = uuidv7();
    expect((await post("owner", "/v1/people/staff:upsert", "people.staff.upsert.v1", staffBody(s5, O1()))).status).toBe(200);
    expect((await post("owner", "/v1/people/staff:upsert", "people.staff.upsert.v1", staffBody(s5, O1(), { wage_rate_minor: 25000, phone: "+919800000001" }))).status).toBe(200);
    const a = (await db.admin<{ before: Record<string, unknown> | null; after: Record<string, unknown> }>(
      `SELECT before, after FROM core.audit_log WHERE tenant_id = $1 AND entity = 'core.staff' AND entity_id = $2 ORDER BY seq`, [t.tenant, s5])).rows;
    const pay = (wage: number) => ({ outlet_id: O1(), role_key: "cook", active: true, pay_basis: "hourly", wage_rate_minor: wage, monthly_salary_minor: null,
      contract_min_per_month: null, ot_multiplier_bp: 15000, currency: "INR" });
    expect(a).toEqual([{ before: null, after: pay(20000) }, { before: pay(20000), after: pay(25000) }]);
  });
});

describe("roster draft: nothing is written until a person approves", () => {
  const draftRoster = uuidv7();
  const draftShift = uuidv7();
  const payload = () => ({ roster_id: draftRoster, outlet_id: O0(), week_start: "2026-10-12", shifts: [{ roster_shift_id: draftShift, staff_id: S2, starts_at: ist("2026-10-12", "09:00"), ends_at: ist("2026-10-12", "17:00"), role_key: "cook" }] });
  const makeDraft = async () => {
    const id = uuidv7();
    await db.withContext("munim_svc", { tenant_id: t.tenant, outlet_ids: "*", role: "service" }, (c) =>
      c.query(`INSERT INTO core.draft (tenant_id, id, outlet_ids, source, command_type, command_payload, based_on) VALUES ($1, $2, $3, 'intel:people', 'people.roster.create.v1', $4, '[]')`,
        [t.tenant, id, [O0()], payload()]));
    return id;
  };
  const rows = async () => ({
    roster: await count(`SELECT count(*) n FROM core.roster WHERE id = $1`, [draftRoster]),
    shifts: await count(`SELECT count(*) n FROM core.roster_shift WHERE id = $1`, [draftShift]),
  });
  const approveBody = (draft: string) => env("drafts.approve.v1", { draft_id: draft, command_type: "people.roster.create.v1", edited_payload: null, reason: null });

  it("a proposed draft changes no roster row; staff cannot approve; reject changes none; approve writes it under the decision", async () => {
    const d = await makeDraft();
    expect(await rows()).toEqual({ roster: 0, shifts: 0 });
    const denied = await call("POST", `/v1/drafts/${d}:approve`, staffSub, t.tenant, approveBody(d));
    expect(denied.status).toBe(403);
    expect(await rows()).toEqual({ roster: 0, shifts: 0 });
    // reject path (a second draft of the same payload)
    const d2 = await makeDraft();
    const rej = await call("POST", `/v1/drafts/${d2}:reject`, t.managerSub, t.tenant, env("drafts.reject.v1", { draft_id: d2, reason: "Not needed" }));
    expect(rej.status).toBe(200);
    expect(await rows()).toEqual({ roster: 0, shifts: 0 });
    // approve → written, origin = decision, roster.draft_id = the draft
    const ok = await call("POST", `/v1/drafts/${d}:approve`, t.managerSub, t.tenant, approveBody(d));
    expect(ok.status).toBe(200);
    expect(CommandResult.parse(await ok.json())).toMatchObject({ type: "people.roster.create.v1", entity_id: draftRoster });
    expect(await rows()).toEqual({ roster: 1, shifts: 1 });
    const ro = await one<{ draft_id: string; origin: { kind: string } }>(`SELECT draft_id, origin FROM core.roster WHERE id = $1`, [draftRoster]);
    expect(ro.draft_id).toBe(d);
    expect(ro.origin.kind).toBe("decision");
  });
});

describe("attendance and overtime", () => {
  it("staff of outlet A cannot record attendance for outlet B; for outlet A it is accepted", async () => {
    const id = uuidv7();
    const body = (outlet: string, staff: string) => ({ attendance_id: id, outlet_id: outlet, staff_id: staff, action: "clock_in", at: ist("2026-08-17", "09:00"), roster_shift_id: null, source: "device" });
    const denied = await post("staff", "/v1/people/attendance", "people.attendance.record.v1", body(O1(), S3));
    expect((await err(denied)).status).toBe(403);
    expect(await count(`SELECT count(*) n FROM core.attendance WHERE id = $1`, [id])).toBe(0);
    const ok = await post("staff", "/v1/people/attendance", "people.attendance.record.v1", body(O0(), S1));
    expect(ok.status).toBe(200);
    expect(await count(`SELECT count(*) n FROM core.attendance WHERE id = $1 AND outlet_id = $2 AND recorded_by = $3`, [id, O0(), t.staff])).toBe(1);
    // clock-out for the same row, and a second clock-out is refused
    const out = body(O0(), S1);
    const co = { ...out, action: "clock_out", at: ist("2026-08-17", "10:00") };
    expect((await post("staff", "/v1/people/attendance", "people.attendance.record.v1", co)).status).toBe(200);
    expect((await err(await post("staff", "/v1/people/attendance", "people.attendance.record.v1", { ...co, at: ist("2026-08-17", "11:00") }))).code).toBe("conflict");
    // a clock time in the future is not a record
    const fut = await post("staff", "/v1/people/attendance", "people.attendance.record.v1", { ...body(O0(), S1), attendance_id: uuidv7(), at: "2099-01-01T09:00:00+05:30" });
    expect((await err(fut)).code).toBe("invalid_payload");
  });

  it("overtime for the fixture fortnight equals the hand-computed rows; refused at low coverage, accepted once attended", async () => {
    // Outlet 1 first: rostered, nobody clocked → the read model refuses rather than assume rostered = worked.
    const r1 = uuidv7();
    const s3 = shift(S3, "2026-08-03", "09:00", "17:00");
    expect((await post("owner", "/v1/people/rosters", "people.roster.create.v1", { roster_id: r1, outlet_id: O1(), week_start: "2026-08-03", shifts: [s3] })).status).toBe(200);
    const q1 = `/v1/people/overtime?outlet=${O1()}&from=2026-08-01&to=2026-08-31`;
    expect(await err(await call("GET", q1, t.ownerSub, t.tenant))).toEqual({ status: 422, code: "cannot_verify", reason: "attendance_missing" });
    await clock(O1(), S3, s3.roster_shift_id, "2026-08-03", "09:00", "17:00")("owner");
    const ok1 = await call("GET", q1, t.ownerSub, t.tenant);
    expect(ok1.status).toBe(200);
    expect((await ok1.json()).rows).toEqual([{ staff_id: S3, iso_week: "2026-W32", rostered_min: 480, attended_min: 480, extra_min: 0, extra_cost_minor: 0 }]);

    // Outlet 0: clock the fixture week.
    const k = shiftIds;
    await clock(O0(), S1, k["S1-2026-08-03"]!, "2026-08-03", "09:00", "17:45")();
    await clock(O0(), S1, k["S1-2026-08-04"]!, "2026-08-04", "09:00", "17:30")();
    await clock(O0(), S2, k["S2-2026-08-03"]!, "2026-08-03", "10:00", "18:00")();
    await clock(O0(), S2, k["S2-2026-08-04"]!, "2026-08-04", "10:00", "19:00")();
    await clock(O0(), S1, k["S1-2026-08-10"]!, "2026-08-10", "09:00", "17:00")();
    await clock(O0(), S2, k["S2-2026-08-10"]!, "2026-08-10", "10:00", "18:00")();
    await clock(O0(), S1, null, "2026-08-11", "09:00", "13:00")(); // unrostered
    await clock(O0(), S1, null, "2026-08-12", "09:00", null)(); // still clocked in: excluded
    const res = await call("GET", `/v1/people/overtime?outlet=${O0()}&from=2026-08-01&to=2026-08-09`, t.managerSub, t.tenant);
    expect(res.status).toBe(200);
    const body = PeopleOvertimeResponse.parse(await res.json());
    const byKey = (rows: typeof body.rows) => rows.map((r) => OvertimeWeekRow.parse(r)).sort((a, b) => (a.staff_id + a.iso_week).localeCompare(b.staff_id + b.iso_week));
    expect(byKey(body.rows)).toEqual(byKey([
      { staff_id: S1, iso_week: "2026-W32", rostered_min: 960, attended_min: 1035, extra_min: 75, extra_cost_minor: 37500 },
      { staff_id: S2, iso_week: "2026-W32", rostered_min: 960, attended_min: 1020, extra_min: 60, extra_cost_minor: 30000 },
    ]));
    const full = PeopleOvertimeResponse.parse(await (await call("GET", `/v1/people/overtime?outlet=${O0()}&from=2026-08-01&to=2026-08-31`, t.ownerSub, t.tenant)).json());
    expect(byKey(full.rows)).toEqual(byKey([
      { staff_id: S1, iso_week: "2026-W32", rostered_min: 960, attended_min: 1035, extra_min: 75, extra_cost_minor: 37500 },
      { staff_id: S2, iso_week: "2026-W32", rostered_min: 960, attended_min: 1020, extra_min: 60, extra_cost_minor: 30000 },
      { staff_id: S1, iso_week: "2026-W33", rostered_min: 480, attended_min: 720, extra_min: 240, extra_cost_minor: 120000 },
      { staff_id: S2, iso_week: "2026-W33", rostered_min: 480, attended_min: 480, extra_min: 0, extra_cost_minor: 0 },
      // the 17 Aug clock-in/out from the attendance test: S1, 60 min, no roster that week → pack formula: all extra, 1 h × 20000 × 1.5
      { staff_id: S1, iso_week: "2026-W34", rostered_min: 0, attended_min: 60, extra_min: 60, extra_cost_minor: 30000 },
    ]));
    // wages stay off a staff-role member's screen
    expect((await call("GET", `/v1/people/overtime?outlet=${O0()}&from=2026-08-01&to=2026-08-31`, staffSub, t.tenant)).status).toBe(403);
    // a manager of another outlet's scope sees no outlet 1
    expect((await call("GET", q1, t.managerSub, t.tenant)).status).toBe(404);
  });
});

describe("advances, tips, training, candidates", () => {
  it("advances: given then partly recovered; recovering more than outstanding is refused", async () => {
    const adv = (kind: string, amount: number) => ({ advance_id: uuidv7(), staff_id: S1, kind, amount_minor: amount, currency: "INR", on_date: "2026-08-02", note: null });
    expect((await post("manager", "/v1/people/advances", "people.advance.record.v1", adv("given", 20000))).status).toBe(200);
    expect((await err(await post("manager", "/v1/people/advances", "people.advance.record.v1", adv("recovered", 20001)))).code).toBe("conflict");
    expect((await post("manager", "/v1/people/advances", "people.advance.record.v1", adv("recovered", 1000))).status).toBe(200);
    expect(Number((await one<{ n: string }>(`SELECT sum(CASE kind WHEN 'given' THEN amount_minor ELSE -amount_minor END) n FROM core.advance WHERE staff_id = $1 AND on_date = '2026-08-02'`, [S1])).n)).toBe(19000);
    expect((await post("staff", "/v1/people/advances", "people.advance.record.v1", adv("given", 100))).status).toBe(403);
    // R2-S1-5: each recorded advance asks finance for its posting (finance.post_advance); the refused ones do not.
    expect(posted.map((x) => x.rule)).toEqual(["finance.post_advance", "finance.post_advance"]);
    posted.length = 0;
  });

  it("R2-S1-5: with the real finance seam an advance moves 1250 against the bank (hand: given 2,000 → Dr 1250 / Cr 1010; repaid 500 → the reverse)", async () => {
    const restore = setPostFor(undefined);
    try {
      const s6 = uuidv7();
      expect((await post("owner", "/v1/people/staff:upsert", "people.staff.upsert.v1", staffBody(s6, O0()))).status).toBe(200);
      const give = { advance_id: uuidv7(), staff_id: s6, kind: "given", amount_minor: 200000, currency: "INR", on_date: "2026-08-05", note: null };
      const back = { ...give, advance_id: uuidv7(), kind: "recovered", amount_minor: 50000, on_date: "2026-08-20" };
      expect((await post("manager", "/v1/people/advances", "people.advance.record.v1", give)).status).toBe(200);
      expect((await post("manager", "/v1/people/advances", "people.advance.record.v1", back)).status).toBe(200);
      const lines = async (id: string) => (await db.admin<{ code: string; amount: string; d: string; o: string }>(
        `SELECT a.code, p.amount_minor::text AS amount, j.entry_date::text AS d, j.outlet_id::text AS o FROM core.journal_entry j
           JOIN core.posting p ON p.tenant_id = j.tenant_id AND p.journal_entry_id = j.id JOIN core.account a ON a.tenant_id = p.tenant_id AND a.id = p.account_id
          WHERE j.posting_rule = 'finance.post_advance' AND j.source_id = $1 ORDER BY a.code`, [id])).rows.map((x) => [x.code, Number(x.amount), x.d, x.o]);
      expect(await lines(give.advance_id)).toEqual([["1010", -200000, "2026-08-05", O0()], ["1250", 200000, "2026-08-05", O0()]]);
      expect(await lines(back.advance_id)).toEqual([["1010", 50000, "2026-08-20", O0()], ["1250", -50000, "2026-08-20", O0()]]);
    } finally {
      restore();
    }
  });

  it("tip pools: equal split of 10,001 → 5,001 + 5,000; hours basis without attendance is refused", async () => {
    const pool = (o: Record<string, unknown>) => ({ tip_pool_id: uuidv7(), outlet_id: O0(), period_from: "2026-07-01", period_to: "2026-07-07", basis: "equal", total_minor: 10001, currency: "INR", manual_shares: [], staff_ids: [S1, S2], ...o });
    const p = pool({});
    expect((await post("manager", "/v1/people/tip-pools", "people.tip_pool.record.v1", p)).status).toBe(200);
    const shares = (await db.admin(`SELECT staff_id, amount_minor FROM core.tip_pool_share WHERE tip_pool_id = $1 ORDER BY amount_minor DESC`, [p.tip_pool_id])).rows;
    expect(shares.map((s) => [s.staff_id, Number(s.amount_minor)])).toEqual([[S1, 5001], [S2, 5000]]);
    expect(await err(await post("manager", "/v1/people/tip-pools", "people.tip_pool.record.v1", pool({ basis: "hours" })))).toEqual({ status: 422, code: "cannot_verify", reason: "attendance_missing" });
    // August hours basis: S1 attended 1035 + 720(+0 open) vs S2 1020 + 480 minutes... only the weights matter, sum is exact
    const aug = pool({ basis: "manual", period_from: "2026-08-01", period_to: "2026-08-07", total_minor: 10000, staff_ids: [], manual_shares: [{ staff_id: S1, amount_minor: 5000 }, { staff_id: S2, amount_minor: 5000 }] });
    expect((await post("manager", "/v1/people/tip-pools", "people.tip_pool.record.v1", aug)).status).toBe(200);
    // manual shares must add up to the total
    expect((await err(await post("manager", "/v1/people/tip-pools", "people.tip_pool.record.v1", { ...aug, tip_pool_id: uuidv7(), total_minor: 9999 }))).code).toBe("invalid_payload");
  });

  it("training record is written; hiring candidate moves applied → interviewed, but not interviewed → hired", async () => {
    expect((await post("manager", "/v1/people/training", "people.training.record.v1", { training_id: uuidv7(), staff_id: S1, course_key: "training.food_safety", completed_on: "2026-08-01", valid_to: "2027-08-01", document_id: null })).status).toBe(200);
    const cand = uuidv7();
    const c = (stage: string) => ({ candidate_id: cand, outlet_id: O0(), name: "Applicant A", phone: null, email: null, role_key: "server", stage, source: "walk_in", note: null });
    expect((await post("manager", "/v1/people/candidates:upsert", "people.candidate.upsert.v1", c("applied"))).status).toBe(200);
    expect((await post("manager", "/v1/people/candidates:upsert", "people.candidate.upsert.v1", c("interviewed"))).status).toBe(200);
    expect((await err(await post("manager", "/v1/people/candidates:upsert", "people.candidate.upsert.v1", c("hired")))).code).toBe("illegal_transition");
    expect((await one<{ stage: string }>(`SELECT stage FROM core.hiring_candidate WHERE id = $1`, [cand])).stage).toBe("interviewed");
    expect((await post("manager", "/v1/people/candidates:upsert", "people.candidate.upsert.v1", c("offered"))).status).toBe(200);
    expect((await post("manager", "/v1/people/candidates:upsert", "people.candidate.upsert.v1", c("hired"))).status).toBe(200);
  });
});

describe("payroll (IN only)", () => {
  it("preview for August = hand-computed lines; the owner records the draft: lines, a recovery entry, finance seam called once", async () => {
    const pv = await call("GET", `/v1/people/payroll-preview?outlet=${O0()}&month=2026-08-01`, t.ownerSub, t.tenant);
    expect(pv.status).toBe(200);
    const preview = PeoplePayrollPreviewResponse.parse(await pv.json());
    // S1: base (1440 + 60 unrostered-week) min × 20000 / 60 = 500000; OT 37500 + 120000; tips 5000 (manual pool, 10000 over two). S2: salary 3,000,000; OT 30000; tips 5000.
    const sorted = [...preview.lines].sort((a, b) => a.staff_id.localeCompare(b.staff_id));
    expect(sorted).toEqual([
      { staff_id: S1, base_minor: 500000, overtime_minor: 157500, advance_recovery_minor: 0, tips_minor: 5000, net_minor: 662500, outstanding_advance_minor: 19000 },
      { staff_id: S2, base_minor: 3000000, overtime_minor: 30000, advance_recovery_minor: 0, tips_minor: 5000, net_minor: 3035000, outstanding_advance_minor: 0 },
    ].sort((a, b) => a.staff_id.localeCompare(b.staff_id)));

    const draft = uuidv7();
    const payload = {
      payroll_draft_id: draft, outlet_id: O0(), period_month: "2026-08-01", currency: "INR",
      lines: [
        { staff_id: S1, base_minor: 500000, overtime_minor: 157500, advance_recovery_minor: 5000, tips_minor: 5000, net_minor: 657500 },
        { staff_id: S2, base_minor: 3000000, overtime_minor: 30000, advance_recovery_minor: 0, tips_minor: 5000, net_minor: 3035000 },
      ],
    };
    // a manager has no authority over payroll (owner only)
    expect((await post("manager", "/v1/people/payroll-drafts", "people.payroll_draft.create.v1", payload)).status).toBe(403);
    expect(await count(`SELECT count(*) n FROM core.payroll_draft WHERE id = $1`, [draft])).toBe(0);
    expect(posted).toEqual([]);
    // recovery above the outstanding balance is refused, writes nothing
    const over = { ...payload, payroll_draft_id: uuidv7(), lines: [{ ...payload.lines[0]!, advance_recovery_minor: 19001, net_minor: 643499 }] };
    expect((await err(await post("owner", "/v1/people/payroll-drafts", "people.payroll_draft.create.v1", over))).code).toBe("conflict");
    expect(await count(`SELECT count(*) n FROM core.payroll_draft`, [])).toBe(1); // only the world's seeded September draft

    const ok = await post("owner", "/v1/people/payroll-drafts", "people.payroll_draft.create.v1", payload);
    expect(ok.status).toBe(200);
    expect(await count(`SELECT count(*) n FROM core.payroll_draft_line WHERE payroll_draft_id = $1`, [draft])).toBe(2);
    expect(Number((await one<{ n: string }>(`SELECT sum(net_minor) n FROM core.payroll_draft_line WHERE payroll_draft_id = $1`, [draft])).n)).toBe(657500 + 3035000);
    const rec = await one<{ amount_minor: string; kind: string; staff_id: string }>(`SELECT amount_minor, kind, staff_id FROM core.advance WHERE payroll_draft_id = $1`, [draft]);
    expect([rec.kind, Number(rec.amount_minor), rec.staff_id]).toEqual(["recovered", 5000, S1]);
    expect(posted).toEqual([{ rule: "finance.post_payroll", ref: `core.payroll_draft:${draft}` }]);
    // the same month cannot be drafted twice
    expect((await err(await post("owner", "/v1/people/payroll-drafts", "people.payroll_draft.create.v1", { ...payload, payroll_draft_id: uuidv7() }))).code).toBe("conflict");
    expect(posted.length).toBe(1);
  });

  it("people.payroll_draft.status.v1: manager 403, void without a reason 422; paid_externally 200 (entry stands); void 200 → the real finance reversal (Dr 3,000,000 back), recovery no longer counts, the month can be drafted again", async () => {
    // The real finance seam for this test (the file's fake records calls only).
    const restore = setPostFor(undefined);
    try {
      const status = (who: "owner" | "manager", id: string, body: Record<string, unknown>) =>
        call("POST", `/v1/people/payroll-drafts/${id}:status`, as(who), t.tenant, env("people.payroll_draft.status.v1", { payroll_draft_id: id, ...body }));
      const draft = async (month: string, recovery = 0) => {
        const id = uuidv7();
        const r = await post("owner", "/v1/people/payroll-drafts", "people.payroll_draft.create.v1", { payroll_draft_id: id, outlet_id: O0(), period_month: month, currency: "INR",
          lines: [{ staff_id: S2, base_minor: 3000000, overtime_minor: 0, advance_recovery_minor: 0, tips_minor: 0, net_minor: 3000000 },
            ...(recovery ? [{ staff_id: S1, base_minor: 100000, overtime_minor: 0, advance_recovery_minor: recovery, tips_minor: 0, net_minor: 100000 - recovery }] : [])] });
        expect(r.status).toBe(200);
        return id;
      };
      const entries = (id: string) => db.admin<{ rule: string; reverses: boolean; dr: number; net: number }>(
        `SELECT j.posting_rule AS rule, j.reverses_id IS NOT NULL AS reverses, (sum(p.amount_minor) FILTER (WHERE p.amount_minor > 0))::int AS dr, sum(p.amount_minor)::int AS net
           FROM core.journal_entry j JOIN core.posting p ON p.tenant_id = j.tenant_id AND p.journal_entry_id = j.id WHERE j.source_id = $1 GROUP BY j.tenant_id, j.id ORDER BY j.id`, [id]).then((r) => r.rows);
      const statusOf = async (id: string) => (await one<{ status: string }>(`SELECT status FROM core.payroll_draft WHERE id = $1`, [id])).status;

      const paid = await draft("2026-06-01");
      expect((await status("manager", paid, { status: "paid_externally", reason_code: null })).status).toBe(403);
      expect((await status("owner", paid, { status: "paid_externally", reason_code: null })).status).toBe(200);
      expect(await statusOf(paid)).toBe("paid_externally");
      expect(await entries(paid)).toEqual([{ rule: "finance.post_payroll", reverses: false, dr: 3000000, net: 0 }]);
      expect((await err(await status("owner", paid, { status: "void", reason_code: "entered_twice" }))).code).toBe("illegal_transition");

      // S1 owes 19,000 − 5,000 recovered in August = 14,000; July recovers 4,000 more → 10,000, until July is voided.
      const owed = async () => (await (await call("GET", `/v1/people/payroll-preview?outlet=${O0()}&month=2026-08-01`, t.ownerSub, t.tenant)).json())
        .lines.find((l: { staff_id: string }) => l.staff_id === S1).outstanding_advance_minor;
      const voided = await draft("2026-07-01", 4000);
      expect(await owed()).toBe(10000);
      expect((await err(await status("owner", voided, { status: "void", reason_code: null }))).code).toBe("invalid_payload");
      expect(await statusOf(voided)).toBe("approved");
      expect((await status("owner", voided, { status: "void", reason_code: "entered_twice" })).status).toBe(200);
      expect(await statusOf(voided)).toBe("void");
      // Hand: the July entry Dr wages 3,100,000 (3,000,000 + 100,000), reversed in full under finance.reverse_payroll.
      expect(await entries(voided)).toEqual([
        { rule: "finance.post_payroll", reverses: false, dr: 3100000, net: 0 },
        { rule: "finance.reverse_payroll", reverses: true, dr: 3100000, net: 0 },
      ]);
      expect(await owed()).toBe(14000);
      await draft("2026-07-01");
    } finally {
      restore();
    }
  });

  it("R2-S2-7: a week straddling June/July is judged whole and paid in July (the month it ends); no overtime when the week matches its roster", async () => {
    // Hand (S7 hourly ₹200/h, OT 1.5x; ISO week Mon 29 Jun – Sun 5 Jul 2026): rostered Mon, Tue, Thu 09–17 = 1,440 min;
    // attended Mon 600 + Tue 600 + Thu 240 = 1,440 → extra 0 → base 1,440 / 60 × 20,000 = 480,000, overtime 0.
    // Split at the month end the June half alone (960 rostered, 1,200 attended) would pay 240 min as overtime (120,000).
    const s7 = uuidv7();
    expect((await post("owner", "/v1/people/staff:upsert", "people.staff.upsert.v1", staffBody(s7, O0()))).status).toBe(200);
    const shifts = [shift(s7, "2026-06-29", "09:00", "17:00"), shift(s7, "2026-06-30", "09:00", "17:00"), shift(s7, "2026-07-02", "09:00", "17:00")];
    expect((await post("manager", "/v1/people/rosters", "people.roster.create.v1", { roster_id: uuidv7(), outlet_id: O0(), week_start: "2026-06-29", shifts })).status).toBe(200);
    await clock(O0(), s7, shifts[0]!.roster_shift_id, "2026-06-29", "09:00", "19:00")();
    await clock(O0(), s7, shifts[1]!.roster_shift_id, "2026-06-30", "09:00", "19:00")();
    await clock(O0(), s7, shifts[2]!.roster_shift_id, "2026-07-02", "09:00", "13:00")();
    const preview = async (month: string) => call("GET", `/v1/people/payroll-preview?outlet=${O0()}&month=${month}`, t.ownerSub, t.tenant);
    const july = PeoplePayrollPreviewResponse.parse(await (await preview("2026-07-01")).json()).lines.find((l) => l.staff_id === s7);
    expect([july?.base_minor, july?.overtime_minor]).toEqual([480000, 0]);
    // June's pay weeks (1–28 June) hold none of these hours: no line for S7 (and here, no attendance at all → refused).
    expect(await err(await preview("2026-06-01"))).toEqual({ status: 422, code: "cannot_verify", reason: "attendance_missing" });
  });

  it("AU tenant: payroll draft refused (MB013 → out_of_pack_scope / payroll_out_of_scope), preview refused, rosters still work", async () => {
    const w = await buildWorld(db, { country: "AU" });
    const sub = `au-owner-${uuidv7()}`;
    await db.withContext("munim_core", { tenant_id: w.tenant, outlet_ids: "*", role: "owner", member_id: w.owner, command_type: "tenancy.member.invite.v1" }, (c) =>
      c.query(`UPDATE core.member SET idp_sub = $3 WHERE tenant_id = $1 AND id = $2`, [w.tenant, w.owner, sub]));
    const au = (path: string, type: string, payload: unknown) => call("POST", path, sub, w.tenant, env(type, payload));
    const s = uuidv7();
    expect((await au("/v1/people/staff:upsert", "people.staff.upsert.v1", staffBody(s, w.outlets[0], { currency: "AUD" }))).status).toBe(200);
    const draft = uuidv7();
    const payload = { payroll_draft_id: draft, outlet_id: w.outlets[0], period_month: "2026-08-01", currency: "AUD",
      lines: [{ staff_id: s, base_minor: 100000, overtime_minor: 0, advance_recovery_minor: 0, tips_minor: 0, net_minor: 100000 }] };
    const refused = await au("/v1/people/payroll-drafts", "people.payroll_draft.create.v1", payload);
    expect(await err(refused)).toEqual({ status: 422, code: "out_of_pack_scope", reason: "payroll_out_of_scope" });
    expect(await count(`SELECT count(*) n FROM core.payroll_draft WHERE tenant_id = $1`, [w.tenant])).toBe(0);
    const pv = await call("GET", `/v1/people/payroll-preview?outlet=${w.outlets[0]}&month=2026-08-01`, sub, w.tenant);
    expect(await err(pv)).toEqual({ status: 422, code: "out_of_pack_scope", reason: "payroll_out_of_scope" });
    // AU does rosters: the same owner's roster command is accepted
    const roster = await au("/v1/people/rosters", "people.roster.create.v1", { roster_id: uuidv7(), outlet_id: w.outlets[0], week_start: "2026-08-03",
      shifts: [{ roster_shift_id: uuidv7(), staff_id: s, starts_at: "2026-08-03T09:00:00+10:00", ends_at: "2026-08-03T17:00:00+10:00", role_key: "cook" }] });
    expect(roster.status).toBe(200);
  });
});
