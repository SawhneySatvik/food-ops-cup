// Gate: withContext sets app.* for one transaction only (SET LOCAL, gotcha 2) — on a one-connection pool the
// next checkout of the same connection reads '' — and rolls back on error. Also: createApp loads the
// contracts registry, so draftable types are registered (gotcha 28).
import { draftableTypes } from "@munim/contracts";
import { createLogger } from "@munim/config";
import type { TestDb } from "@munim/db";
import type pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createApp, withContext } from "../src/app.ts";
import { createLocalIdp } from "../src/auth/local-idp.ts";
import { openDb } from "./db.ts";
import { buildTenant, type Tenant } from "./world.ts";

let db: TestDb;
let one: pg.Pool;
let A: Tenant;

beforeAll(async () => {
  db = await openDb();
  A = await buildTenant(db, "A");
  one = db.pool("munim_core", 1);
});
afterAll(async () => {
  await one.end();
  await db.stop();
});

describe("withContext", () => {
  it("context is visible inside the transaction and gone on the same pooled connection afterwards", async () => {
    const pid = (c: pg.PoolClient | pg.Pool) => c.query<{ pid: number }>("SELECT pg_backend_pid() AS pid").then((r) => r.rows[0]!.pid);
    const inside = await withContext(one, { tenant_id: A.tenant, outlet_ids: [A.outlets[0]], role: "manager", member_id: A.manager }, async (c) => ({
      pid: await pid(c),
      s: (await c.query("SELECT current_setting('app.tenant_id', true) t, current_setting('app.outlet_ids', true) o, current_setting('app.role', true) r")).rows[0],
      devices: (await c.query("SELECT id FROM core.device")).rowCount,
    }));
    expect(inside.s).toEqual({ t: A.tenant, o: `{${A.outlets[0]}}`, r: "manager" });
    expect(inside.devices).toBe(1);
    expect(await pid(one)).toBe(inside.pid); // same connection …
    const after = (await one.query("SELECT current_setting('app.tenant_id', true) t, current_setting('app.role', true) r")).rows[0];
    expect(after).toEqual({ t: "", r: "" }); // … and the context did not survive the transaction
    expect((await one.query("SELECT id FROM core.device")).rowCount).toBe(0);
  });

  it("rolls back on error and leaves the connection usable", async () => {
    await expect(withContext(one, { tenant_id: A.tenant }, (c) => c.query("SELECT 1/0"))).rejects.toMatchObject({ code: "22012" });
    expect((await one.query("SELECT 1 AS x")).rows[0]).toEqual({ x: 1 });
  });
});

describe("boot", () => {
  it("createApp registers the contracts' draftable command types", async () => {
    const config = { nodeEnv: "production", redact: (s: string) => s };
    const app = await createApp({ pools: { core: one, svc: one }, idp: createLocalIdp(), storefronts: async () => null, config, log: createLogger(config, () => {}) });
    expect(draftableTypes().length).toBeGreaterThanOrEqual(1);
    // Outside NODE_ENV=test the probe route is not mounted.
    expect((await app.request("/v1/_probe/devices")).status).toBe(404);
  });
});
