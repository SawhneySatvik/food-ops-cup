// Gates (W1 fix #77): shopper contexts from contextOf against m-1's 0014 customer_scope / guest_scope.
//   customer: sees exactly its own rows (profile, its orders), the public catalogue, only presented coupons,
//             a guest order only when claiming it, and nothing core-owned (member, audit, outbox, device);
//   guest:    sees exactly its one order (+ that order's children), not the customer behind it, not the
//             same customer's other orders, not the catalogue; writes nothing;
//   asSystem: clears app.role for core-owned rows inside a shopper transaction and restores it.
// Expected sets come from superuser reads of the fixture, never from the code under test.
import { createHash } from "node:crypto";
import type { TestDb } from "@munim/db";
import type pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { asSystem, contextOf, type Principal, withContext } from "../src/app.ts";
import { openDb } from "./db.ts";
import { addCustomer, addGuestOrder, buildTenant, type Tenant } from "./world.ts";

let db: TestDb;
let pool: pg.Pool;
let A: Tenant;
let customerA: string;
let other: string;
let guestA: { order: string; token: string };
let secondA: { order: string; token: string };
let othersGuest: { order: string; token: string };

const hex = (token: string) => createHash("sha256").update(token).digest("hex");
const customer = (id: string): Principal => ({ kind: "customer", tenant_id: A.tenant, channel_id: A.channel, customer_id: id, profile: true, sub: "s" });
const guest = (g: { order: string; token: string }): Principal => ({
  kind: "guest", tenant_id: A.tenant, channel_id: A.channel, order_id: g.order, guest_access_hash: hex(g.token),
});
const ids = async (c: pg.PoolClient, sql: string) => (await c.query<{ id: string }>(sql)).rows.map((r) => r.id).sort();

beforeAll(async () => {
  db = await openDb();
  A = await buildTenant(db, "A");
  await buildTenant(db, "B");
  customerA = await addCustomer(db, A, "cust-A");
  other = await addCustomer(db, A, "cust-other");
  guestA = await addGuestOrder(db, A, customerA);
  secondA = await addGuestOrder(db, A, customerA); // the same customer's other order
  othersGuest = await addGuestOrder(db, A, other);
  pool = db.pool("munim_core", 3);
});
afterAll(async () => {
  await pool.end();
  await db.stop();
});

describe("customer context", () => {
  it("sees exactly its own profile and orders, the catalogue, and nothing core-owned", async () => {
    const own = (await db.admin<{ id: string }>(`SELECT id FROM core."order" WHERE tenant_id = $1 AND customer_id = $2`, [A.tenant, customerA]))
      .rows.map((r) => r.id).sort();
    expect(own).toEqual([guestA.order, secondA.order].sort());
    const items = Number((await db.admin(`SELECT count(*) AS n FROM core.item WHERE tenant_id = $1`, [A.tenant])).rows[0]!.n);
    expect(items).toBeGreaterThanOrEqual(1);
    const seen = await withContext(pool, contextOf(customer(customerA)), async (c) => ({
      customers: await ids(c, "SELECT id FROM core.customer"),
      orders: await ids(c, `SELECT id FROM core."order"`),
      items: (await c.query("SELECT id FROM core.item")).rowCount,
      members: (await c.query("SELECT id FROM core.member")).rowCount,
      audit: (await c.query("SELECT seq FROM core.audit_log")).rowCount,
      outbox: (await c.query("SELECT id FROM core.outbox")).rowCount,
      devices: (await c.query("SELECT id FROM core.device")).rowCount,
      coupons: (await c.query("SELECT id FROM core.coupon")).rowCount,
    }));
    expect(seen).toEqual({ customers: [customerA], orders: own, items, members: 0, audit: 0, outbox: 0, devices: 0, coupons: 0 });
  });

  it("presented coupon codes are readable, others are not; a claimed guest order becomes visible only while claiming", async () => {
    const withCode = await withContext(pool, contextOf(customer(customerA), { coupon_codes: ["WELCOME10"] }), async (c) =>
      (await c.query<{ code: string }>("SELECT code FROM core.coupon")).rows.map((r) => r.code));
    expect(withCode).toEqual(["WELCOME10"]);
    const claim = await withContext(pool, contextOf(customer(customerA), { claim_guest_access_hash: hex(othersGuest.token) }), (c) =>
      ids(c, `SELECT id FROM core."order"`));
    expect(claim).toEqual([guestA.order, secondA.order, othersGuest.order].sort());
  });
});

describe("guest context", () => {
  it("sees exactly its one order: not the customer, not the customer's other order, not the catalogue", async () => {
    const seen = await withContext(pool, contextOf(guest(guestA)), async (c) => ({
      settings: (await c.query("SELECT current_setting('app.role', true) r, current_setting('app.customer_id', true) cu, current_setting('app.outlet_ids', true) o")).rows[0],
      orders: await ids(c, `SELECT id FROM core."order"`),
      customers: (await c.query("SELECT id FROM core.customer")).rowCount,
      items: (await c.query("SELECT id FROM core.item")).rowCount,
      outbox: (await c.query("SELECT id FROM core.outbox")).rowCount,
    }));
    expect(seen).toEqual({ settings: { r: "guest", cu: "", o: "{}" }, orders: [guestA.order], customers: 0, items: 0, outbox: 0 });
  });

  it("a guest writes nothing (RLS refuses the update)", async () => {
    const err = await withContext(pool, contextOf(guest(guestA)), (c) =>
      c.query(`UPDATE core."order" SET status = 'cancelled' WHERE id = $1`, [guestA.order])).then(() => null, (e: { code?: string }) => e.code ?? "?");
    expect(err).not.toBeNull();
    const status = (await db.admin(`SELECT status FROM core."order" WHERE tenant_id = $1 AND id = $2`, [A.tenant, guestA.order])).rows[0]!.status;
    expect(status).toBe("placed");
  });
});

describe("asSystem", () => {
  it("inside a customer transaction: outbox hidden → visible under asSystem → hidden again (role restored)", async () => {
    const r = await withContext(pool, contextOf(customer(customerA)), async (c) => {
      const before = (await c.query("SELECT id FROM core.outbox")).rowCount;
      const during = await asSystem(c, async () => ({
        outbox: (await c.query("SELECT id FROM core.outbox")).rowCount,
        role: (await c.query<{ r: string }>("SELECT current_setting('app.role', true) r")).rows[0]!.r,
        tenant: (await c.query<{ t: string }>("SELECT current_setting('app.tenant_id', true) t")).rows[0]!.t,
      }));
      const after = (await c.query("SELECT id FROM core.outbox")).rowCount;
      const role = (await c.query<{ r: string }>("SELECT current_setting('app.role', true) r")).rows[0]!.r;
      return { before, during, after, role };
    });
    const total = Number((await db.admin(`SELECT count(*) AS n FROM core.outbox WHERE tenant_id = $1`, [A.tenant])).rows[0]!.n);
    expect(total).toBeGreaterThanOrEqual(1);
    expect(r).toEqual({ before: 0, during: { outbox: total, role: "", tenant: A.tenant }, after: 0, role: "customer" });
  });
});
