// T-029 gates — compliance module through the real app (member auth → withContext → RLS → book guard).
//   licence kinds come from the country pack (IN five, AU two; unknown kind refused, each with an accepting twin);
//   expiring-licence query returns the hand-listed fixture set in the OUTLET's time zone;
//   temperature readings are flagged against the asset's own safe range;
//   a maintenance draft writes nothing until a named person approves it.
// Expected values are written by hand below, never derived from the code under test. Synthetic data only.
import { SCHEMAS } from "@munim/contracts/compliance";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { addTemplate, type Env, snapRef, startEnv, uuidv7 } from "./compliance.kit.ts";

let e: Env;
let au: Env;
const L = "/v1/compliance/licences";

const licence = (e: Env, over: Record<string, unknown> = {}) => ({
  licence_id: uuidv7(), outlet_id: e.w.outlets[0], kind: "fssai", number: "SYN-0001", issuer: null,
  valid_from: "2026-01-01", valid_to: "2027-01-01", document_id: null, supersedes_licence_id: null, ...over,
});

beforeAll(async () => {
  e = await startEnv("IN");
  au = await startEnv("AU");
  await addTemplate(e.db, "test.maintenance_cost", `SELECT a.id AS asset_id, 250000::bigint AS est_minor FROM core.asset a WHERE a.id = :asset_id::uuid`,
    [{ name: "asset_id", type: "uuid" }, { name: "est_minor", type: "integer", numeric_source: "core.maintenance.estimated_cost_minor" }]);
});
afterAll(async () => {
  await e?.stop();
  await au?.stop();
});

describe("licence kinds come from the pack (R21, MB013)", () => {
  const IN_KINDS = ["fssai", "gst", "trade_licence", "fire_noc", "shops_establishment"];
  const AU_KINDS = ["food_business_registration", "abn"];

  it.each(IN_KINDS)("IN pack accepts %s", async (kind) => {
    const body = licence(e, { kind });
    const r = await e.cmd(L, "owner", "compliance.licence.upsert.v1", body);
    expect(r.status).toBe(200);
    expect(await e.count(`SELECT count(*) n FROM core.licence WHERE id = $1 AND kind = $2`, [body.licence_id, kind])).toBe(1);
  });

  it.each([...AU_KINDS, "liquor_permit"])("IN pack refuses %s with out_of_pack_scope and writes nothing", async (kind) => {
    const body = licence(e, { kind });
    const r = await e.cmd(L, "owner", "compliance.licence.upsert.v1", body);
    expect([r.status, (await r.json()).error.code]).toEqual([422, "out_of_pack_scope"]);
    expect(await e.count(`SELECT count(*) n FROM core.licence WHERE id = $1`, [body.licence_id])).toBe(0);
  });

  it.each(AU_KINDS)("AU pack accepts %s", async (kind) => {
    const body = licence(au, { kind });
    expect((await au.cmd(L, "owner", "compliance.licence.upsert.v1", body)).status).toBe(200);
    expect(await au.count(`SELECT count(*) n FROM core.licence WHERE id = $1`, [body.licence_id])).toBe(1);
  });

  it.each([...IN_KINDS, "liquor_permit"])("AU pack refuses %s", async (kind) => {
    const body = licence(au, { kind });
    const r = await au.cmd(L, "owner", "compliance.licence.upsert.v1", body);
    expect([r.status, (await r.json()).error.code]).toEqual([422, "out_of_pack_scope"]);
    expect(await au.count(`SELECT count(*) n FROM core.licence WHERE id = $1`, [body.licence_id])).toBe(0);
  });

  it("staff cannot file a licence (403, nothing written); a manager of another outlet cannot either", async () => {
    for (const who of ["staff", "mgr2"] as const) {
      const body = licence(e);
      const r = await e.cmd(L, who, "compliance.licence.upsert.v1", body);
      expect([r.status, (await r.json()).error.code]).toEqual([403, "book_write_refused"]);
      expect(await e.count(`SELECT count(*) n FROM core.licence WHERE id = $1`, [body.licence_id])).toBe(0);
    }
    expect((await e.cmd(L, "mgr1", "compliance.licence.upsert.v1", licence(e))).status).toBe(200);
  });

  it("a bad date range is invalid_payload, and a replayed key writes once", async () => {
    const bad = await e.cmd(L, "owner", "compliance.licence.upsert.v1", licence(e, { valid_to: "2025-12-31" }));
    expect([bad.status, (await bad.json()).error.code]).toEqual([422, "invalid_payload"]);
    const body = licence(e);
    const envelope = { command_id: uuidv7(), idempotency_key: "same-key-0001", type: "compliance.licence.upsert.v1", payload: body };
    const first = await e.call("POST", L, "owner", envelope);
    const again = await e.call("POST", L, "owner", envelope);
    expect([first.status, again.status, again.headers.get("X-Munim-Replayed")]).toEqual([200, 200, "true"]);
    expect(await e.count(`SELECT count(*) n FROM core.licence WHERE id = $1`, [body.licence_id])).toBe(1);
    expect(await e.count(`SELECT count(*) n FROM core.audit_log WHERE entity = 'core.licence' AND entity_id = $1`, [body.licence_id])).toBe(1);
  });
});

describe("expiring-licence query (outlet time zone)", () => {
  // Fixture licences on a fresh IN tenant. as_of 2026-10-10T19:00:00Z is 2026-10-11 00:30 in Asia/Kolkata (UTC date is
  // still 10-10), so a UTC implementation would be off by one on every row. Hand-counted days_left from 2026-10-11:
  //   gst 10-09 → -2 · fssai 10-11 → 0 · tenant-wide gst 10-20 → 9 · trade 11-09 → 29 · fire 11-10 → 30 · shops 11-11 → 31 (out)
  let t: Env;
  const AS_OF = "2026-10-10T19:00:00Z";
  beforeAll(async () => {
    t = await startEnv("IN");
    const put = async (over: Record<string, unknown>) => expect((await t.cmd(L, "owner", "compliance.licence.upsert.v1", licence(t, over))).status).toBe(200);
    await put({ kind: "gst", valid_to: "2026-10-09", number: "G-EXPIRED" });
    await put({ kind: "fssai", valid_to: "2026-10-11", number: "F-TODAY" });
    await put({ kind: "gst", outlet_id: null, valid_to: "2026-10-20", number: "G-TENANT" });
    await put({ kind: "trade_licence", valid_to: "2026-11-09", number: "T-29" });
    await put({ kind: "fire_noc", valid_to: "2026-11-10", number: "N-30" });
    await put({ kind: "shops_establishment", valid_to: "2026-11-11", number: "S-31" });
    await put({ kind: "fssai", valid_to: null, number: "F-NOEXPIRY" });
    // A renewal: the old licence is superseded and drops out of the query even though it expires tomorrow.
    const old = licence(t, { kind: "fssai", valid_to: "2026-10-12", number: "F-OLD" });
    await t.cmd(L, "owner", "compliance.licence.upsert.v1", old);
    await put({ kind: "fssai", valid_to: "2027-10-12", number: "F-RENEWED", supersedes_licence_id: old.licence_id });
  });
  afterAll(() => t?.stop());

  const expected = [
    { number: "G-EXPIRED", days_left: -2, expired: true },
    { number: "F-TODAY", days_left: 0, expired: false },
    { number: "G-TENANT", days_left: 9, expired: false },
    { number: "T-29", days_left: 29, expired: false },
    { number: "N-30", days_left: 30, expired: false },
  ];

  it("returns exactly the five hand-listed licences, soonest first", async () => {
    const r = await t.call("GET", `${L}/expiring?within_days=30&as_of=${encodeURIComponent(AS_OF)}`, "owner");
    expect(r.status).toBe(200);
    const items = (await r.json()).items as Array<{ id: string; days_left: number; expired: boolean }>;
    const numbers = await Promise.all(items.map(async (i) => (await t.one<{ number: string }>(`SELECT number FROM core.licence WHERE id = $1`, [i.id])).number));
    expect(items.map((i, k) => ({ number: numbers[k], days_left: i.days_left, expired: i.expired }))).toEqual(expected);
  });

  it("a wider window adds the 31-day licence; the superseded and no-expiry ones never appear", async () => {
    const r = await t.call("GET", `${L}/expiring?within_days=31&as_of=${encodeURIComponent(AS_OF)}`, "owner");
    expect((await r.json()).items.length).toBe(6);
  });

  it("an outlet manager sees their outlet's rows plus tenant-wide ones, never another outlet's; a malformed parameter is a bad_request", async () => {
    const r = await t.call("GET", `${L}/expiring?within_days=30&as_of=${encodeURIComponent(AS_OF)}`, "mgr1");
    expect((await r.json()).items.length).toBe(5); // four outlet-1 licences + the tenant-wide one
    const other = await t.call("GET", `${L}/expiring?within_days=30&as_of=${encodeURIComponent(AS_OF)}`, "mgr2");
    expect((await other.json()).items.length).toBe(1); // outlet 2 holds no licence here: only the tenant-wide one
    const bad = await t.call("GET", `${L}/expiring?as_of=yesterday`, "owner");
    expect([bad.status, (await bad.json()).error.code]).toEqual([400, "bad_request"]);
  });

  it("an Australian outlet uses its own zone: 2026-10-10T14:00Z is 2026-10-11 01:00 in Melbourne (UTC date 10-10)", async () => {
    // AU: food_business_registration valid_to 10-11 is 0 days left in Melbourne (a UTC reading would say 1); abn 10-10 is -1.
    await au.cmd(L, "owner", "compliance.licence.upsert.v1", licence(au, { kind: "food_business_registration", valid_to: "2026-10-11", number: "FBR-TODAY" }));
    await au.cmd(L, "owner", "compliance.licence.upsert.v1", licence(au, { kind: "abn", valid_to: "2026-10-10", number: "ABN-YESTERDAY" }));
    const r = await au.call("GET", `${L}/expiring?within_days=1&as_of=${encodeURIComponent("2026-10-10T14:00:00Z")}`, "owner");
    const rows = await Promise.all(((await r.json()).items as Array<{ id: string; days_left: number }>).map(async (i) =>
      ({ number: (await au.one<{ number: string }>(`SELECT number FROM core.licence WHERE id = $1`, [i.id])).number, days_left: i.days_left })));
    expect(rows.filter((x) => x.number === "ABN-YESTERDAY" || x.number === "FBR-TODAY")).toEqual([
      { number: "ABN-YESTERDAY", days_left: -1 }, { number: "FBR-TODAY", days_left: 0 },
    ]);
  });
});

describe("temperature logs against the asset's safe range", () => {
  const chiller = uuidv7();
  const oven = uuidv7();
  const T = "/v1/compliance/temp-logs";
  const reading = (asset: string, milli: number, at: string, over: Record<string, unknown> = {}) =>
    ({ log_id: uuidv7(), outlet_id: e.w.outlets[0], asset_id: asset, reading_milli_c: milli, read_at: at, note: null, ...over });
  const asset = (id: string, kind: string, min: number | null, max: number | null, over: Record<string, unknown> = {}) =>
    ({ asset_id: id, outlet_id: e.w.outlets[0], kind, name: `Synthetic ${kind}`, make_model: null, serial_no: null, safe_min_milli_c: min, safe_max_milli_c: max, installed_on: null, active: true, ...over });

  beforeAll(async () => {
    expect((await e.cmd("/v1/compliance/assets", "mgr1", "compliance.asset.upsert.v1", asset(chiller, "chiller", 0, 5000))).status).toBe(200);
    expect((await e.cmd("/v1/compliance/assets", "mgr1", "compliance.asset.upsert.v1", asset(oven, "oven", null, null))).status).toBe(200);
  });

  it("flags out-of-range readings against 0–5000 milli-°C; the limits themselves are in range; a range-less asset is null", async () => {
    // [reading, hand-decided out_of_range]; read_at 2026-10-09T20:00Z is 2026-10-10 01:30 in Kolkata (local_date 10-10).
    const plan: Array<[number, boolean, string]> = [
      [9000, true, "2026-10-09T08:00:00Z"], [3500, false, "2026-10-09T07:00:00Z"], [5000, false, "2026-10-09T06:00:00Z"],
      [5001, true, "2026-10-09T05:00:00Z"], [0, false, "2026-10-09T04:00:00Z"], [-500, true, "2026-10-09T03:00:00Z"],
    ];
    for (const [milli, , at] of plan) expect((await e.cmd(T, "staff", "compliance.temp.record.v1", reading(chiller, milli, at))).status).toBe(200);
    expect((await e.cmd(T, "staff", "compliance.temp.record.v1", reading(oven, 200000, "2026-10-09T20:00:00Z"))).status).toBe(200);

    const c = (await (await e.call("GET", `${T}?asset=${chiller}`, "owner")).json()).items as Array<{ reading_milli_c: number; out_of_range: boolean }>;
    expect(c.map((x) => [x.reading_milli_c, x.out_of_range])).toEqual(plan.map(([m, f]) => [m, f]));
    const o = (await (await e.call("GET", `${T}?asset=${oven}`, "owner")).json()).items as Array<{ out_of_range: boolean | null; local_date: string }>;
    expect(o).toEqual([expect.objectContaining({ out_of_range: null, local_date: "2026-10-10" })]);
    expect(c.filter((x) => x.out_of_range).length).toBe(3);
  });

  it("a reading in the future is refused; a reading for an asset in another outlet is not found; staff of another outlet is refused", async () => {
    const future = await e.cmd(T, "staff", "compliance.temp.record.v1", reading(chiller, 3000, "2099-01-01T00:00:00Z"));
    expect([future.status, (await future.json()).error.code]).toEqual([422, "invalid_payload"]);
    const wrongOutlet = await e.cmd(T, "owner", "compliance.temp.record.v1", reading(chiller, 3000, "2026-10-09T01:00:00Z", { outlet_id: e.w.outlets[1] }));
    expect([wrongOutlet.status, (await wrongOutlet.json()).error.code]).toEqual([404, "not_found"]);
    const other = await e.cmd(T, "mgr2", "compliance.temp.record.v1", reading(chiller, 3000, "2026-10-09T01:00:00Z"));
    // Outlet 2's manager cannot see outlet 1's asset at all (0015 A3 outlet RLS): 404, as for any row outside their scope.
    expect([other.status, (await other.json()).error.code]).toEqual([404, "not_found"]);
  });

  it("asset range must be min < max and both or neither; the identity of an asset cannot be rewritten", async () => {
    for (const bad of [asset(uuidv7(), "chiller", 5000, 0), asset(uuidv7(), "chiller", 0, null)]) {
      const r = await e.cmd("/v1/compliance/assets", "mgr1", "compliance.asset.upsert.v1", bad);
      expect([r.status, (await r.json()).error.code]).toEqual([422, "invalid_payload"]);
    }
    const rename = await e.cmd("/v1/compliance/assets", "mgr1", "compliance.asset.upsert.v1", asset(chiller, "chiller", 0, 4000, { name: "Walk-in chiller" }));
    expect(rename.status).toBe(200);
    expect(await e.one(`SELECT name, safe_max_milli_c FROM core.asset WHERE id = $1`, [chiller])).toEqual({ name: "Walk-in chiller", safe_max_milli_c: 4000 });
    const kind = await e.cmd("/v1/compliance/assets", "mgr1", "compliance.asset.upsert.v1", asset(chiller, "freezer", 0, 4000));
    expect([kind.status, (await kind.json()).error.code]).toEqual([409, "conflict"]);
  });
});

describe("checklists", () => {
  const cl = uuidv7();
  const items = ["ops.item.lights", "ops.item.floor", "ops.item.stock"];
  const run = (over: Record<string, unknown> = {}) => ({
    run_id: uuidv7(), checklist_id: cl, outlet_id: e.w.outlets[0], business_date: "2026-10-09",
    results: { "ops.item.lights": true, "ops.item.floor": true, "ops.item.stock": false }, ...over,
  });

  beforeAll(async () => {
    const r = await e.cmd("/v1/compliance/checklists", "mgr1", "compliance.checklist.upsert.v1", {
      checklist_id: cl, outlet_id: e.w.outlets[0], name_key: "ops.checklist.closing", kind: "closing", frequency: "daily", due_time: "23:00", items, active: true,
    });
    expect(r.status).toBe(200);
  });

  it("staff completes a run with every item answered; the same day twice is a conflict; a missing item, a stranger's key, or tomorrow is refused", async () => {
    expect((await e.cmd("/v1/compliance/checklist-runs", "staff", "compliance.checklist.complete.v1", run())).status).toBe(200);
    const row = await e.one<{ completed_by: string; business_date: string }>(`SELECT completed_by, business_date::text FROM core.checklist_run WHERE checklist_id = $1`, [cl]);
    expect(row).toEqual({ completed_by: e.w.staff, business_date: "2026-10-09" });
    const dup = await e.cmd("/v1/compliance/checklist-runs", "staff", "compliance.checklist.complete.v1", run());
    expect([dup.status, (await dup.json()).error.code]).toEqual([409, "conflict"]);
    for (const bad of [
      run({ business_date: "2026-10-08", results: { "ops.item.lights": true } }),
      run({ business_date: "2026-10-08", results: { "ops.item.lights": true, "ops.item.floor": true, "ops.item.other": true } }),
      run({ business_date: "2099-01-01" }),
    ]) {
      const r = await e.cmd("/v1/compliance/checklist-runs", "staff", "compliance.checklist.complete.v1", bad);
      expect([r.status, (await r.json()).error.code]).toEqual([422, "invalid_payload"]);
    }
    expect(await e.count(`SELECT count(*) n FROM core.checklist_run WHERE checklist_id = $1`, [cl])).toBe(1);
    const runs = (await (await e.call("GET", `/v1/compliance/checklist-runs?outlet=${e.w.outlets[0]}&checklist=${cl}&from=2026-10-09&to=2026-10-09`, "mgr1")).json()).items;
    expect(runs.length).toBe(1);
  });

  it("staff may not define checklists (403)", async () => {
    const r = await e.cmd("/v1/compliance/checklists", "staff", "compliance.checklist.upsert.v1", {
      checklist_id: uuidv7(), outlet_id: e.w.outlets[0], name_key: "ops.checklist.x", kind: "other", frequency: "daily", due_time: "10:00", items, active: true,
    });
    expect([r.status, (await r.json()).error.code]).toEqual([403, "book_write_refused"]);
  });
});

describe("AMCs and maintenance", () => {
  const fridge = uuidv7();
  const amc = (over: Record<string, unknown> = {}) => ({
    amc_id: uuidv7(), asset_id: fridge, vendor: "Synthetic Cool Care", valid_from: "2026-01-01", valid_to: "2026-12-31",
    cost: { amount_minor: 1200000, currency: "INR" }, document_id: null, ...over,
  });
  beforeAll(async () => {
    await e.cmd("/v1/compliance/assets", "owner", "compliance.asset.upsert.v1", {
      asset_id: fridge, outlet_id: e.w.outlets[0], kind: "chiller", name: "AMC fridge", make_model: null, serial_no: null,
      safe_min_milli_c: 0, safe_max_milli_c: 5000, installed_on: null, active: true,
    });
  });

  it("only the owner records an AMC (manager 403); overlapping AMCs are both kept; a foreign currency is refused", async () => {
    const mgr = await e.cmd("/v1/compliance/amcs", "mgr1", "compliance.amc.record.v1", amc());
    expect([mgr.status, (await mgr.json()).error.code]).toEqual([403, "book_write_refused"]);
    expect((await e.cmd("/v1/compliance/amcs", "owner", "compliance.amc.record.v1", amc())).status).toBe(200);
    // early renewal: 2026-10-18 → 2027-10-17 overlaps the first by 75 days (10-18 … 12-31); both rows stay (pack A3).
    expect((await e.cmd("/v1/compliance/amcs", "owner", "compliance.amc.record.v1", amc({ valid_from: "2026-10-18", valid_to: "2027-10-17" }))).status).toBe(200);
    expect(await e.count(`SELECT count(*) n FROM core.amc WHERE asset_id = $1`, [fridge])).toBe(2);
    const aud = await e.cmd("/v1/compliance/amcs", "owner", "compliance.amc.record.v1", amc({ cost: { amount_minor: 1, currency: "AUD" } }));
    expect([aud.status, (await aud.json()).error.code]).toEqual([422, "currency_mismatch"]);
    expect(await e.count(`SELECT count(*) n FROM core.amc WHERE asset_id = $1`, [fridge])).toBe(2);
  });

  it("maintenance: a scheduled job is completed by a record; a breakdown is logged already done; a done job is not recorded twice", async () => {
    const m = uuidv7();
    const sched = { maintenance_id: m, outlet_id: e.w.outlets[0], asset_id: fridge, kind: "preventive", due_on: "2026-10-30", estimated_cost_minor: 250000, vendor_note: null };
    expect((await e.cmd("/v1/compliance/maintenance", "mgr1", "compliance.maintenance.schedule.v1", sched)).status).toBe(200);
    expect(await e.one(`SELECT status, estimated_cost_minor::text, currency FROM core.maintenance WHERE id = $1`, [m])).toEqual({ status: "scheduled", estimated_cost_minor: "250000", currency: "INR" });
    const done = { maintenance_id: m, asset_id: fridge, kind: "preventive", done_on: "2026-10-28", cost_minor: 240000, vendor: "Synthetic Cool Care", amc_id: null, note: null };
    expect((await e.cmd("/v1/compliance/maintenance/record", "mgr1", "compliance.maintenance.record.v1", done)).status).toBe(200);
    expect(await e.one(`SELECT status, cost_minor::text, done_on::text FROM core.maintenance WHERE id = $1`, [m])).toEqual({ status: "done", cost_minor: "240000", done_on: "2026-10-28" });
    const again = await e.cmd("/v1/compliance/maintenance/record", "mgr1", "compliance.maintenance.record.v1", done);
    expect([again.status, (await again.json()).error.code]).toEqual([409, "conflict"]);
    const b = uuidv7();
    expect((await e.cmd("/v1/compliance/maintenance/record", "mgr1", "compliance.maintenance.record.v1",
      { maintenance_id: b, asset_id: fridge, kind: "breakdown", done_on: "2026-10-02", cost_minor: 80000, vendor: null, amc_id: null, note: "Compressor relay" })).status).toBe(200);
    const list = (await (await e.call("GET", `/v1/compliance/maintenance?asset=${fridge}&status=done`, "mgr1")).json()).items;
    expect(list.map((x: { kind: string; cost_minor: number }) => [x.kind, x.cost_minor])).toEqual([["preventive", 240000], ["breakdown", 80000]]);
  });

  it("a maintenance DRAFT writes nothing until a named person approves it; a rejected one never does; staff cannot approve", async () => {
    const m1 = uuidv7();
    const m2 = uuidv7();
    const snap = await e.mint("test.maintenance_cost", { asset_id: fridge }, [e.w.outlets[0]]);
    const ref = snapRef(snap, 0, "est_minor");
    const payload = (id: string) => ({ maintenance_id: id, outlet_id: e.w.outlets[0], asset_id: fridge, kind: "preventive", due_on: "2026-11-15", estimated_cost_minor: ref, vendor_note: null });
    const d1 = await e.draft("compliance.maintenance.schedule.v1", payload(m1), [ref], [e.w.outlets[0]]);
    const d2 = await e.draft("compliance.maintenance.schedule.v1", payload(m2), [ref], [e.w.outlets[0]]);
    const rows = () => e.count(`SELECT count(*) n FROM core.maintenance WHERE id = ANY($1)`, [[m1, m2]]);
    expect(await rows()).toBe(0);

    const staff = await e.approve("staff", d1, "compliance.maintenance.schedule.v1");
    expect(staff.status).toBe(403);
    expect(await rows()).toBe(0);

    const rej = await e.call("POST", `/v1/drafts/${d2}:reject`, "mgr1", {
      command_id: uuidv7(), idempotency_key: `reject-${uuidv7()}`, type: "drafts.reject.v1", payload: { draft_id: d2, reason: "Vendor already booked" },
    });
    expect(rej.status).toBe(200);
    expect(await rows()).toBe(0);

    const ok = await e.approve("mgr1", d1, "compliance.maintenance.schedule.v1");
    expect(ok.status).toBe(200);
    expect(await rows()).toBe(1);
    const row = await e.one<{ estimated_cost_minor: string; status: string; origin: { kind: string; decision_id: string } }>(
      `SELECT estimated_cost_minor::text, status, origin FROM core.maintenance WHERE id = $1`, [m1]);
    // The number is the snapshot cell's (250000), written under the approver's decision.
    expect([row.estimated_cost_minor, row.status, row.origin.kind]).toEqual(["250000", "scheduled", "decision"]);
    expect((await e.one<{ decided_by: string }>(`SELECT decided_by FROM core.decision WHERE id = $1`, [row.origin.decision_id])).decided_by).toBe(e.ids.mgr1);
  });
});

// B12: the published read schemas (strict) accept what the routes really return, and each list has rows to prove it.
describe("read shapes parse with the published contracts", () => {
  it.each([
    ["/v1/compliance/licences", "v1.compliance.licences"],
    ["/v1/compliance/licences/expiring?within_days=9999", "v1.compliance.licences-expiring"],
    ["/v1/compliance/assets", "v1.compliance.assets"],
    ["/v1/compliance/checklists", "v1.compliance.checklists"],
    ["/v1/compliance/checklist-runs", "v1.compliance.checklist-runs"],
    ["/v1/compliance/temp-logs", "v1.compliance.temp-logs"],
    ["/v1/compliance/amcs", "v1.compliance.amcs"],
    ["/v1/compliance/maintenance", "v1.compliance.maintenance"],
  ] as const)("%s", async (path, schema) => {
    const r = await e.call("GET", path, "owner");
    expect(r.status).toBe(200);
    const body = SCHEMAS[schema].parse(await r.json());
    expect(body.items.length).toBeGreaterThan(0);
  });
});

describe("malformed command envelope (R3-M6)", () => {
  it("valid JSON that is not an envelope is 422 invalid_payload; a body that is not JSON is 400 bad_request", async () => {
    const bad = await e.call("POST", "/v1/compliance/licences", "owner", { nope: 1 });
    expect(bad.status).toBe(422);
    expect((await bad.json()).error.code).toBe("invalid_payload");
    const none = await e.call("POST", "/v1/compliance/licences", "owner");
    expect(none.status).toBe(400);
    expect((await none.json()).error.code).toBe("bad_request");
  });
});
