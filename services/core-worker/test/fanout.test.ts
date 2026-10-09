// Fan-out gates (T-007): one run token per tenant, bounded concurrency, per-tenant failure isolation with
// logs that carry ids and labels only; brief selection by each tenant's outlet-local time.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import pg from "pg";
import type { TestDb } from "@munim/db";
import { activeTenants, fanout, intelHttp } from "../src/fanout.ts";
import { outletNightsDue, tenantClocks, tenantsDueAt } from "../src/local-time.ts";
import { connString, makeTenant, memLog, openDb } from "./db.ts";
import { fakeMinter, startIntelStub } from "./intel-stub.ts";

const SECRET = "svc-secret-0123456789abcdef";
let db: TestDb;
let pool: pg.Pool;
let tenants: string[];
let kolkata: string[];
let melbourne: string[];

beforeAll(async () => {
  db = await openDb();
  pool = new pg.Pool({ connectionString: connString(db, "munim_svc"), max: 4 });
  kolkata = [await makeTenant(db, ["Asia/Kolkata"]), await makeTenant(db, ["Asia/Kolkata", "Asia/Kolkata"]), await makeTenant(db, ["Asia/Kolkata"])];
  melbourne = [await makeTenant(db, ["Australia/Melbourne"]), await makeTenant(db, ["Australia/Melbourne"])];
  tenants = [...kolkata, ...melbourne].sort();
  // Added after the 5-tenant gates below: one chain with outlets in two zones (first outlet in Kolkata).

});
afterAll(async () => {
  await pool.end();
  await db.stop();
});

describe("fan-out", () => {
  it("lists tenants through core.active_tenants() as munim_svc", async () => {
    expect(await activeTenants(pool)).toEqual(tenants);
  });

  it("5 tenants, one failing → 4 successful calls + 1 logged failure, no secret in the log", async () => {
    const failing = tenants[1]!; // not last: an abort-on-first-error loop would lose the tenants after it
    const intel = await startIntelStub({ failFor: new Set([failing]), delayMs: 100 });
    const minter = fakeMinter();
    const log = memLog();
    try {
      const result = await fanout({ minter, intel: intelHttp({ baseUrl: intel.url, serviceSecret: SECRET }), log, concurrency: 2 },
        "/watch:sweep", await activeTenants(pool), new AbortController().signal);
      const ok = intel.calls.filter((c) => c.tenant !== failing);
      const failures = log.lines.filter((l) => l.event === "fanout.tenant_failed");
      console.log(`fan-out: result=${JSON.stringify(result)}, calls=${intel.calls.length}, ok calls=${ok.length}, ` +
        `logged failures=${failures.length} (${JSON.stringify(failures[0]?.fields)}), max in flight=${intel.maxInFlight()}`);
      expect(result).toEqual({ ok: 4, failed: 1 });
      expect(ok).toHaveLength(4);
      expect(new Set(ok.map((c) => c.tenant))).toEqual(new Set(tenants.filter((t) => t !== failing)));
      expect(failures).toHaveLength(1);
      expect(failures[0]!.fields).toMatchObject({ tenant_id: failing, error: "http_500", path: "/watch:sweep" });
      // One token per tenant, minted for that tenant, sent with the service secret to /watch:sweep.
      expect(minter.mints.map((m) => m.tenantId).sort()).toEqual(tenants);
      expect(minter.mints.every((m) => m.trigger === "watch_sweep" && m.actor === "watcher:sweep")).toBe(true);
      for (const c of intel.calls) {
        expect(c.path).toBe("/watch:sweep");
        expect(c.secret).toBe(SECRET);
        expect(minter.mints.find((m) => m.token === c.token)?.tenantId).toBe(c.tenant);
      }
      expect(intel.maxInFlight()).toBe(2);
      // Every minted run is ended once intel returned — the failing tenant's too (ruling: end after return).
      expect(minter.ended.sort()).toEqual(minter.mints.map((m) => m.run_id).sort());
      const text = log.text();
      expect(text).not.toContain(SECRET);
      for (const m of minter.mints) expect(text).not.toContain(m.token);
      expect(text).not.toContain("leaked body text");
    } finally {
      await intel.close();
    }
  });

  it("a minter failure is isolated too, and an aborted fan-out starts no new tenant", async () => {
    const intel = await startIntelStub();
    const minter = fakeMinter();
    const failing = tenants[0]!;
    const flaky = { mint: async (r: Parameters<typeof minter.mint>[0]) => {
      if (r.tenantId === failing) throw Object.assign(new Error("db down"), { code: "57P01" });
      return minter.mint(r);
    } };
    const log = memLog();
    const deps = { minter: flaky, intel: intelHttp({ baseUrl: intel.url, serviceSecret: SECRET }), log, concurrency: 3 };
    try {
      expect(await fanout(deps, "/brief", tenants, new AbortController().signal)).toEqual({ ok: 4, failed: 1 });
      const aborted = new AbortController();
      aborted.abort();
      expect(await fanout(deps, "/brief", tenants, aborted.signal)).toEqual({ ok: 0, failed: 0 });
      expect(intel.calls).toHaveLength(4);
    } finally {
      await intel.close();
    }
  });

  it("brief: only tenants whose outlet-local 06:00 falls in the slot window", async () => {
    // 00:30Z = 06:00 Asia/Kolkata; Melbourne is 11:30 there.
    const ist = await tenantsDueAt(pool, tenants, "06:00", { prev: new Date("2026-10-10T00:15:00Z"), at: new Date("2026-10-10T00:30:00Z") });
    // 19:00Z on 9 Oct = 06:00 on 10 Oct in Melbourne (AEDT, +11).
    const mel = await tenantsDueAt(pool, tenants, "06:00", { prev: new Date("2026-10-09T18:45:00Z"), at: new Date("2026-10-09T19:00:00Z") });
    const none = await tenantsDueAt(pool, tenants, "06:00", { prev: new Date("2026-10-10T03:00:00Z"), at: new Date("2026-10-10T03:15:00Z") });
    console.log(`brief due: IST slot=${ist.length} tenants, Melbourne slot=${mel.length} tenants, other slot=${none.length}`);
    expect(ist.sort()).toEqual([...kolkata].sort());
    expect(mel.sort()).toEqual([...melbourne].sort());
    expect(none).toEqual([]);
  });

  it("multi-zone tenant: brief once at the home zone (default = first outlet); nightly per outlet at its own cutoff", async () => {
    const chain = await makeTenant(db, ["Asia/Kolkata", "Australia/Melbourne"]);
    const clocks = await tenantClocks(pool, chain);
    console.log(`chain clocks: home=${clocks.homeTz}, outlets=${clocks.outlets.map((o) => `${o.tz}@${o.cutoff}`).join(", ")}`);
    expect(clocks.homeTz).toBe("Asia/Kolkata");
    expect(clocks.outlets.map((o) => o.cutoff)).toEqual(["04:00", "04:00"]);
    // Walk one UTC day (9 Oct 12:00Z → 10 Oct 12:00Z) in 15-minute slots.
    const briefs: string[] = [];
    const nights: string[] = [];
    for (let t = Date.parse("2026-10-09T12:00:00Z"); t < Date.parse("2026-10-10T12:00:00Z"); t += 15 * 60_000) {
      const slot = { prev: new Date(t), at: new Date(t + 15 * 60_000) };
      if ((await tenantsDueAt(pool, [chain], "06:00", slot)).length) briefs.push(slot.at.toISOString());
      for (const n of await outletNightsDue(pool, [chain], slot)) {
        nights.push(`${clocks.outlets.find((o) => o.outlet_id === n.outlet_id)!.tz} ${slot.at.toISOString()} → ${n.business_date}`);
      }
    }
    console.log(`chain brief at: ${briefs.join(", ")}; nightly: ${nights.join(" | ")}`);
    expect(briefs).toEqual(["2026-10-10T00:30:00.000Z"]); // 06:00 IST, not also at 06:00 AEDT (19:00Z)
    expect(nights).toEqual([
      "Australia/Melbourne 2026-10-09T17:00:00.000Z → 2026-10-09", // 04:00 AEDT on 10 Oct
      "Asia/Kolkata 2026-10-09T22:30:00.000Z → 2026-10-09", // 04:00 IST on 10 Oct
    ]);
  });

  it("home_tz set: the brief follows it, not the first outlet; outlet cutoffs come from each outlet", async () => {
    const chain = await makeTenant(db, ["Asia/Kolkata", "Australia/Melbourne"], { homeTz: "Australia/Melbourne", cutoffs: ["05:30", "03:00"] });
    const clocks = await tenantClocks(pool, chain);
    expect(clocks.homeTz).toBe("Australia/Melbourne");
    expect(clocks.outlets.map((o) => `${o.tz}@${o.cutoff}`)).toEqual(["Asia/Kolkata@05:30", "Australia/Melbourne@03:00"]);
    const briefs: string[] = [];
    const nights: string[] = [];
    for (let t = Date.parse("2026-10-09T12:00:00Z"); t < Date.parse("2026-10-10T12:00:00Z"); t += 15 * 60_000) {
      const slot = { prev: new Date(t), at: new Date(t + 15 * 60_000) };
      if ((await tenantsDueAt(pool, [chain], "06:00", slot)).length) briefs.push(slot.at.toISOString());
      for (const n of await outletNightsDue(pool, [chain], slot)) nights.push(`${slot.at.toISOString()} → ${n.business_date}`);
    }
    console.log(`home_tz chain brief at: ${briefs.join(", ")}; nightly: ${nights.join(" | ")}`);
    expect(briefs).toEqual(["2026-10-09T19:00:00.000Z"]); // 06:00 AEDT on 10 Oct
    expect(nights).toEqual([
      "2026-10-09T16:00:00.000Z → 2026-10-09", // 03:00 AEDT
      "2026-10-10T00:00:00.000Z → 2026-10-09", // 05:30 IST
    ]);
  });
});
