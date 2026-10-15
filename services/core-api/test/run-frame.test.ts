// T-040b gates — GET /internal/intel/v1/run-frame through the real app (run token + service secret → munim_svc under
// the token's RLS). Embedded Postgres, no model, a pinned frame clock. Synthetic data only.
//   (3) a run scoped to 1 of 3 outlets lists exactly that outlet; a '*' run lists 3
//   (4) budget left = the lower of (owner cap, operator limit) − spend, by hand, with cap < limit and cap > limit
//   (5) at the cap: the run token is still minted and served (never refused for budget); level hard, narration template,
//       ai_enabled still true (T-127: over the cap is not AI switched off); the kill switch off → ai_enabled false
//   (6) pack, currency, ladder, thresholds and business dates = hand values (pack md tables, the tz rules by hand),
//       incl. both Melbourne DST transitions and a Kolkata control
//   (8) R47 D7: negotiation bounds default to 9500/11000, serve the tenant-wide policy in force (each bound alone defaults the other),
//       and never a version that starts after the frame's date
//   (7) no thread block: `?thread_id=` names nothing (the strict schema refuses a `thread` key)
// Hand values: the canonical world (db/src/world.ts) — 3 restaurant outlets in Asia/Kolkata, operator limit 500000
// INR for 2026-10, owner cap 500000 INR, one spend of 15 INR on 2026-10-09 — and the sums written below.
import { createLogger } from "@munim/config";
import { BatchResponse, RunFrameResponse } from "@munim/contracts/internal";
import { buildWorld, ownerCtx, type TestDb, uuidv7, type World } from "@munim/db";
import type pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createLocalIdp } from "../src/auth/local-idp.ts";
import { createApp, type Deps } from "../src/app.ts";
import { svcTx, testKeys } from "../src/commit/testkit.ts";
import { configureInternal } from "../src/internal/index.ts";
import { mintRunToken, type OutletScope, type RunTrigger } from "../src/runtoken/index.ts";
import { openDb } from "./db.ts";
import { buildTenant, type Tenant } from "./world.ts";

const keys = testKeys();
const SECRET = "t040b-frame-service-secret-not-real-0123456789abcdef";
let clock = new Date("2026-10-11T08:00:00Z");
let db: TestDb;
let pools: { core: pg.Pool; svc: pg.Pool };
let app: Awaited<ReturnType<typeof createApp>>;
let A: Tenant;
let AU: World;

type Res = Omit<Response, "json"> & { json(): Promise<any> };
const run = async (t: Pick<World, "tenant" | "owner">, scope: OutletScope, trigger: RunTrigger = "watch_sweep", actor = "watcher:sweep") =>
  (await mintRunToken({ ...keys, svc: svcTx(db) }, { tenantId: t.tenant, outletScope: scope, trigger, actor })).token;
const headers = (token: string) => ({ authorization: `Bearer ${token}`, "x-munim-service-secret": SECRET, "content-type": "application/json" });
const frameRes = async (token: string, q = "") => (await app.request(`/internal/intel/v1/run-frame${q}`, { headers: headers(token) })) as Res;
const frame = async (token: string, q = "") => {
  const r = await frameRes(token, q);
  expect(r.status).toBe(200);
  return RunFrameResponse.parse(await r.json());
};
const spend = async (token: string, amount: number) => {
  const r = (await app.request("/internal/intel/v1/spend", { method: "POST", headers: headers(token), body: JSON.stringify({ entries: [
    { id: uuidv7(), role: "narrate", provider: "gemini", model_id: "gemini-3-flash", input_tokens: 1000, output_tokens: 100, amount_minor: amount, currency: "INR" }] }) })) as Res;
  expect([r.status, BatchResponse.parse(await r.json()).inserted]).toEqual([201, 1]);
};
const setCap = (cap: number) => db.withContext("munim_core", ownerCtx(A, { command_type: "ai_policy.cap.set.v1" }), (c) =>
  c.query(`UPDATE core.ai_budget_cap SET monthly_cap_minor = $2 WHERE tenant_id = $1`, [A.tenant, cap]));

beforeAll(async () => {
  db = await openDb();
  A = await buildTenant(db, "a");
  AU = await buildWorld(db, { country: "AU" });
  pools = { core: db.pool("munim_core", 4), svc: db.pool("munim_svc", 4) };
  const config = { nodeEnv: "test", redact: (s: string) => s };
  const deps: Deps = { pools, idp: createLocalIdp(), storefronts: async () => null, config, log: createLogger(config, () => {}) };
  app = await createApp(deps);
  configureInternal(deps, { serviceSecret: SECRET, keys, watchWindowMs: 0, clock: () => clock });
});

afterAll(async () => {
  await pools?.core.end();
  await pools?.svc.end();
  await db?.stop();
});

describe("pack, outlets, business dates (gates 3 and 6)", () => {
  it("the canonical IN world: pack IN v3, INR, ladder L and cost_drift thresholds from the pack md, 3 restaurant outlets in Kolkata", async () => {
    clock = new Date("2026-10-11T20:00:00Z"); // 01:30 IST on the 12th: before the 04:00 cutoff → business date the 11th
    const f = await frame(await run(A, ["*"]));
    expect([f.pack, f.currency]).toEqual([{ code: "IN", version: 4 }, "INR"]); // v4: the optional Cares block (ADR-015 §6)
    // packs header L: ₹50,000 / ₹10,000 / ₹2,000 of monthly impact, in paise.
    expect(f.severity_ladder).toEqual({ critical_minor_gte: 5_000_000, high_minor_gte: 1_000_000, medium_minor_gte: 200_000 });
    // catalogue.md §4: cost_change_bp ≥ 800 and a cost rise ≥ ₹5.
    expect(f.detectors["catalogue.cost_drift"]).toEqual({ thresholds: { cost_change_bp_gte: 800, cost_increase_minor_gte: 500, lookback_days: 90 } });
    // IN.json by hand: payroll drafts; five licence kinds, only FSSAI without `_unverified` notes; fire NOC not for shops.
    expect(f.payroll_scope).toBe("drafts");
    expect(f.licence_kinds.map((k) => [k.code, k.holder, k.unverified, k.outlet_kinds.includes("store")])).toEqual([
      ["fssai", "outlet", false, true], ["gst", "business", true, true], ["trade_licence", "outlet", true, true],
      ["fire_noc", "outlet", true, false], ["shops_establishment", "outlet", true, true]]);
    expect(f.outlets.map((o) => o.id)).toEqual([...A.outlets].sort());
    expect(f.outlets.map((o) => [o.kind, o.tz, o.business_date])).toEqual(Array(3).fill(["restaurant", "Asia/Kolkata", "2026-10-11"]));
    clock = new Date("2026-10-11T23:00:00Z"); // 04:30 IST on the 12th → the 12th (Kolkata control: no DST)
    expect((await frame(await run(A, ["*"]))).outlets[0]!.business_date).toBe("2026-10-12");
  });

  it("a run scoped to 1 of 3 outlets lists exactly that one outlet (core.outlet is tenant-visible: the filter is core's)", async () => {
    const f = await frame(await run(A, [A.outlets[1]!]));
    expect(f.outlets.map((o) => o.id)).toEqual([A.outlets[1]]);
  });

  it("Melbourne across both DST transitions (cutoff 04:00): 4 Oct 2026 spring forward, 5 Apr 2026 fall back; AU ladder and AUD", async () => {
    const tok = await run(AU, ["*"]);
    const cases: Array<[string, string]> = [
      ["2026-10-03T16:30:00Z", "2026-10-03"], // 03:30 AEDT on the 4th (02:00 → 03:00 skipped): before the cutoff
      ["2026-10-03T17:30:00Z", "2026-10-04"], // 04:30 AEDT on the 4th
      ["2026-04-04T17:30:00Z", "2026-04-04"], // 03:30 AEST on the 5th (03:00 → 02:00 repeated at 16:00Z): before the cutoff
      ["2026-04-04T18:30:00Z", "2026-04-05"], // 04:30 AEST on the 5th
    ];
    for (const [at, day] of cases) {
      clock = new Date(at);
      const f = await frame(tok);
      expect([at, f.outlets[0]!.tz, f.outlets[0]!.business_date]).toEqual([at, "Australia/Melbourne", day]);
    }
    const f = await frame(tok);
    // packs header L: A$1,000 / A$200 / A$40 in cents; catalogue.md §4: a cost rise ≥ A$0.10.
    expect([f.pack.code, f.currency, f.severity_ladder]).toEqual(["AU", "AUD", { critical_minor_gte: 100_000, high_minor_gte: 20_000, medium_minor_gte: 4_000 }]);
    expect(f.detectors["catalogue.cost_drift"]!.thresholds.cost_increase_minor_gte).toBe(10);
    // AU.json by hand: rosters only; both licence kinds carry `_unverified` notes.
    expect([f.payroll_scope, f.licence_kinds.map((k) => [k.code, k.holder, k.unverified])]).toEqual(
      ["roster_only", [["food_business_registration", "outlet", true], ["abn", "business", true]]]);
  });
});

describe("budget (gates 4 and 5; F11 O-2: the lower of owner cap and operator limit)", () => {
  it("after 3 recorded spends (1000 + 2500 + 4000) and the world's 15: cap < limit and cap > limit, by hand", async () => {
    clock = new Date("2026-10-11T08:00:00Z");
    const tok = await run(A, ["*"]);
    for (const amount of [1000, 2500, 4000]) await spend(tok, amount);
    // Σ spend = 15 + 1000 + 2500 + 4000 = 7515.
    await setCap(300_000); // owner cap below the operator limit 500000 → cap 300000, left 300000 − 7515 = 292485
    expect((await frame(tok)).budget).toEqual({ month: "2026-10-01", currency: "INR", owner_cap_minor: 300_000, operator_limit_minor: 500_000,
      effective_cap_minor: 300_000, spent_minor: 7_515, hard_left_minor: 292_485, level: "ok" });
    await setCap(800_000); // owner cap above the limit → the limit binds: 500000 − 7515 = 492485
    const f = await frame(tok);
    expect([f.budget!.effective_cap_minor, f.budget!.hard_left_minor, f.budget!.level, f.narration]).toEqual([500_000, 492_485, "ok", "model"]);
  });

  it("at the cap: a new run token is minted and served (never refused for budget), level hard, narration template; spend past the cap is still recorded", async () => {
    clock = new Date("2026-10-11T08:00:00Z");
    await setCap(7_515); // = Σ spend → left 0
    const tok = await run(A, ["*"]); // minted at the cap
    const f = await frame(tok);
    expect([f.budget!.hard_left_minor, f.budget!.level, f.narration, f.ai_enabled]).toEqual([0, "hard", "template", true]);
    await spend(tok, 40); // recorded past the cap
    expect((await frame(tok)).budget!.hard_left_minor).toBe(-40);
    // The run's other routes still work at the cap (rules only).
    const claim = (await app.request("/internal/intel/v1/events:claim", { method: "POST", headers: headers(tok), body: JSON.stringify({ event_id: uuidv7() }) })) as Res;
    expect(claim.status).toBe(200);
    await setCap(500_000);
    expect((await frame(tok)).narration).toBe("model");
  });

  it("the kill switch off → template with budget left; a month with no operator budget → budget null, template", async () => {
    clock = new Date("2026-10-11T08:00:00Z");
    const tok = await run(A, ["*"]);
    await db.admin(`UPDATE platform.feature_flag SET value = 'false' WHERE key = 'intel.enabled'`);
    const off = await frame(tok);
    expect([off.budget!.level, off.narration, off.ai_enabled]).toEqual(["ok", "template", false]);
    await db.admin(`UPDATE platform.feature_flag SET value = 'true' WHERE key = 'intel.enabled'`);
    clock = new Date("2026-11-02T08:00:00Z");
    const nov = await frame(tok);
    expect([nov.budget, nov.narration, nov.ai_enabled]).toEqual([null, "template", true]);
    clock = new Date("2026-10-11T08:00:00Z");
  });
});

describe("no thread block (ruling 11 Oct: the ask body is the only source)", () => {
  it("an ask run naming a thread by ?thread_id= gets the same frame, with no thread key", async () => {
    const ask = await run(A, ["*"], "ask", A.owner);
    const r = await frameRes(ask, `?thread_id=${A.thread}`);
    const body = await r.json();
    expect([r.status, "thread" in body]).toEqual([200, false]);
    expect(RunFrameResponse.parse(body).outlets.length).toBe(3);
  });
});

describe("R47 D7: negotiation bounds in the frame", () => {
  it("unset → 9500/11000; one bound set → the other stays its default; both → served; a future version and an outlet override are not served", async () => {
    const tok = await run(A, ["*"]);
    const bounds = async () => (await frame(tok)).negotiation;
    // Behind the book guard (these are test plants, not commands): triggers off for the one statement.
    const plant = (sql: string, args: unknown[] = []) => db.admin(`BEGIN; SET LOCAL session_replication_role = replica; ${sql.replace(/\$(\d)/g, (_, i) => `'${args[Number(i) - 1]}'`)}; COMMIT;`);
    expect(await bounds()).toEqual({ target_bp: 9500, walkaway_bp: 11000 });
    await plant(`UPDATE core.business_policy SET negotiation_target_bp = 9000 WHERE tenant_id = $1 AND outlet_id IS NULL`, [A.tenant]);
    expect(await bounds()).toEqual({ target_bp: 9000, walkaway_bp: 11000 });
    await plant(`UPDATE core.business_policy SET negotiation_walkaway_bp = 10200 WHERE tenant_id = $1 AND outlet_id IS NULL`, [A.tenant]);
    expect(await bounds()).toEqual({ target_bp: 9000, walkaway_bp: 10200 });
    // A version dated after the frame's day (the clock pins 2026-10-11) is not in force; an outlet-level row is not the business's.
    await plant(`INSERT INTO core.business_policy (tenant_id, id, outlet_id, valid_from, negotiation_target_bp, negotiation_walkaway_bp, origin)
                 VALUES ($1, $2, NULL, '2099-01-01', 8000, 9000, '{}')`, [A.tenant, uuidv7()]);
    await plant(`INSERT INTO core.business_policy (tenant_id, id, outlet_id, valid_from, negotiation_target_bp, negotiation_walkaway_bp, origin)
                 VALUES ($1, $2, $3, '2026-01-01', 7000, 8000, '{}')`, [A.tenant, uuidv7(), A.outlets[0]]);
    expect(await bounds()).toEqual({ target_bp: 9000, walkaway_bp: 10200 });
  });
});
