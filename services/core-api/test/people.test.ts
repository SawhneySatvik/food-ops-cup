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
import { OvertimeWeekRow, PeopleOvertimeResponse, PeoplePayrollPreviewResponse } from "@munim/contracts/people";
import { buildWorld, type TestDb } from "@munim/db";
import type { Hono } from "hono";
import type pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { type AppEnv, createApp, TENANT_HEADER } from "../src/app.ts";
import { uuidv7 } from "../src/commit/index.ts";
import { setPostFor } from "../src/modules/people/seams.ts";
import { createLocalIdp } from "../../../adapters/dev/idp-local/index.ts";
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
      expect(CommandResult.parse(await r.json())).toMatchObject({ type: "people.staff.upsert.v1", entity_id: id });
    }
    expect(await count(`SELECT count(*) n FROM core.staff WHERE id = ANY($1)`, [[S1, S2, S3]])).toBe(3);
    // Upsert edits a granted column, and refuses to change joined_on (not updatable).
    expect((await post("owner", "/v1/people/staff:upsert", "people.staff.upsert.v1", staffBody(S1, O0(), { name: "Renamed" }))).status).toBe(200);
    expect((await one<{ name: string }>(`SELECT name FROM core.staff WHERE id = $1`, [S1])).name).toBe("Renamed");
    expect((await err(await post("owner", "/v1/people/staff:upsert", "people.staff.upsert.v1", staffBody(S1, O0(), { joined_on: "2026-02-02" })))).code).toBe("invalid_payload");
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
