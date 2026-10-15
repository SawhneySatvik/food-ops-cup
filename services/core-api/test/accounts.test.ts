// T-035 gates (R41, R42) through the real app: storefront key + idp-local token → requireCustomer → the accounts
// router → executeCommand → the book guard and 0014 customer_scope. Expected values are hand-written fixture
// facts (3 claimable guest orders, 1 line each, 1 loyalty entry of 40 points…) or superuser reads — never
// derived from the code under test.
//   1. one login at merchants A and B → two separate profiles; 0 rows of A visible through B
//   2. guest orders claimed with the right tokens = 3 (fixture); a wrong token → 404 and nothing moves
//   3. another customer's order → 404 (and the paired own order → 200)
//   4. export contains only this customer's rows
//   5. erasure anonymises the personal fields and keeps the order rows (counts)
//   6. verified-email merge (0015 A10): 2 orders + 1 reservation move, the guest is merged; 4 audit rows = the
//      function's returned set; an unverified email moves nothing
//   7. ensureProfile seam: first call creates, second returns the same id, guest → 401
//   8. R1-m12: an unhandled Postgres error (a real 23505 whose row holds an email) is logged by SQLSTATE,
//      constraint and table only — the email in its detail never reaches the log line
import { createHash, randomBytes } from "node:crypto";
import { createLogger } from "@munim/config";
import { STOREFRONT_KEY_HEADER } from "@munim/contracts";
import { AccountExport, AccountLoyalty, AccountOrderDetail, AccountOrdersResponse, AccountProfile } from "@munim/contracts/accounts";
import { type TestDb, uuidv7 } from "@munim/db";
import type { Hono } from "hono";
import type pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { type AppEnv, createApp, GUEST_TOKEN_HEADER, requireCustomer, storefrontResolver } from "../src/app.ts";
import { ensureProfile } from "../src/modules/accounts/index.ts";
import { createLocalIdp } from "../src/auth/local-idp.ts";
import { openDb } from "./db.ts";
import { addCustomer, addGuestOrder, buildTenant, type Tenant } from "./world.ts";

const idp = createLocalIdp();
const sign = (sub: string, email?: string, verified = false) => idp.sign({ sub, ...(email ? { email } : {}), ...(verified ? { email_verified: true } : {}) });

let db: TestDb;
let pools: { core: pg.Pool; svc: pg.Pool };
let app: Hono<AppEnv>;
let A: Tenant;
let B: Tenant;

const LOGIN = `acct-login-${uuidv7()}`;
const LOGIN_EMAIL = "asha.synthetic@example.test";
let idA = "";
let idB = "";
let guestProfile = "";
let guestOrders: Array<{ order: string; token: string }> = [];
let otherAccount = "";
let otherOrder: { order: string; token: string };
let unrelatedGuest: { order: string; token: string };

interface Call {
  key: string;
  sub?: string;
  email?: string;
  verified?: boolean;
  guestToken?: string;
  body?: unknown;
}
const call = (method: "GET" | "POST", path: string, o: Call) =>
  app.request(path, {
    method,
    headers: {
      [STOREFRONT_KEY_HEADER]: o.key,
      ...(o.sub ? { Authorization: `Bearer ${sign(o.sub, o.email, o.verified)}` } : {}),
      ...(o.guestToken ? { [GUEST_TOKEN_HEADER]: o.guestToken } : {}),
      ...(o.body !== undefined ? { "Content-Type": "application/json" } : {}),
    },
    ...(o.body !== undefined ? { body: JSON.stringify(o.body) } : {}),
  });
const env = (type: string, payload: object) => ({ command_id: uuidv7(), idempotency_key: `t35.${uuidv7()}`, type, payload });
const linkBody = (name = "Asha (synthetic)") => env("customers.account.link.v1", { name, phone: null });
const n = async (sql: string, params: unknown[]) => Number((await db.admin<{ n: string }>(sql, params)).rows[0]!.n);

/** A guest checkout's profile, created as the guest's own storefront.guest.create.v1 (as T-032 will). */
async function addGuestProfile(t: Tenant, email: string): Promise<string> {
  const id = uuidv7();
  await db.withContext("munim_core", { tenant_id: t.tenant, outlet_ids: [], role: "customer", customer_id: id, command_type: "storefront.guest.create.v1" },
    (c) => c.query(`INSERT INTO core.customer (tenant_id, id, name, email, is_guest) VALUES ($1, $2, 'Guest (synthetic)', $3, true)`, [t.tenant, id, email]));
  return id;
}

async function addLine(t: Tenant, order: string): Promise<void> {
  await db.withContext("munim_core", { tenant_id: t.tenant, outlet_ids: "*", role: "owner", member_id: t.owner, command_type: "orders.place.v1" }, (c) =>
    c.query(`INSERT INTO core.order_line (tenant_id, id, outlet_id, order_id, line_no, item_id, qty_milli, unit_price_minor, tax_minor)
             VALUES ($1, $2, $3, $4, 1, $5, 1000, 32000, 1600)`, [t.tenant, uuidv7(), t.outlets[0], order, t.item]));
}

beforeAll(async () => {
  db = await openDb();
  A = await buildTenant(db, "A");
  B = await buildTenant(db, "B");
  // Fixture: one guest profile at A with exactly 3 guest orders (1 line each), each with its own token.
  guestProfile = await addGuestProfile(A, "guest.synthetic@example.test");
  for (let i = 0; i < 3; i++) {
    const g = await addGuestOrder(db, A, guestProfile);
    await addLine(A, g.order);
    guestOrders.push(g);
  }
  // Another signed-in customer at A with an order that also carries a tracker token (not claimable).
  otherAccount = await addCustomer(db, A, `other-login-${uuidv7()}`);
  otherOrder = await addGuestOrder(db, A, otherAccount);
  await addLine(A, otherOrder.order);
  // A different guest's order that is never claimed (its rows must never show up for LOGIN).
  unrelatedGuest = await addGuestOrder(db, A, await addGuestProfile(A, "someone.synthetic@example.test"));

  pools = { core: db.pool("munim_core", 4), svc: db.pool("munim_svc", 2) };
  const config = { nodeEnv: "test", redact: (s: string) => s };
  app = await createApp({ pools, idp, storefronts: storefrontResolver(pools.core), config, log: createLogger(config, () => {}) });
  app.post("/v1/_test/ensure-profile", requireCustomer, async (c) => {
    const id = await ensureProfile(c, { name: "Seam (synthetic)", phone: null });
    const p = c.var.principal;
    return c.json({ id, profile: p.kind === "customer" && p.profile }, 200);
  });
});
afterAll(async () => {
  await pools.core.end();
  await pools.svc.end();
  await db.stop();
});

describe("one login, a separate profile per merchant (R41)", () => {
  it("before linking: no token → 401, signed in without a profile here → 404", async () => {
    expect((await call("GET", "/v1/account", { key: A.storefrontKey })).status).toBe(401);
    expect((await call("GET", "/v1/account", { key: A.storefrontKey, sub: LOGIN })).status).toBe(404);
  });

  it("linking at A and at B creates two different profiles for the same login", async () => {
    const a = await call("POST", "/v1/account:link", { key: A.storefrontKey, sub: LOGIN, email: LOGIN_EMAIL, body: linkBody() });
    expect(a.status).toBe(200);
    idA = ((await a.json()) as { entity_id: string }).entity_id;
    const b = await call("POST", "/v1/account:link", { key: B.storefrontKey, sub: LOGIN, email: LOGIN_EMAIL, body: linkBody() });
    expect(b.status).toBe(200);
    idB = ((await b.json()) as { entity_id: string }).entity_id;
    expect(idA).not.toBe(idB);
    const rows = (await db.admin<{ tenant_id: string; id: string; email: string; is_guest: boolean }>(
      `SELECT tenant_id, id, email, is_guest FROM core.customer WHERE idp_sub = $1 ORDER BY tenant_id`, [LOGIN])).rows;
    expect(rows.map((r) => [r.tenant_id, r.id]).sort()).toEqual([[A.tenant, idA], [B.tenant, idB]].sort());
    expect(rows.every((r) => r.email === LOGIN_EMAIL && r.is_guest === false)).toBe(true);
    const pa = AccountProfile.parse(await (await call("GET", "/v1/account", { key: A.storefrontKey, sub: LOGIN })).json());
    const pb = AccountProfile.parse(await (await call("GET", "/v1/account", { key: B.storefrontKey, sub: LOGIN })).json());
    expect([pa.customer_id, pb.customer_id]).toEqual([idA, idB]);
    // An unverified email is stored but never counted as verified.
    expect(pa.email_verified_at).toBeNull();
  });

  it("linking again with nothing to claim → 409; a replay of the first link returns its stored result", async () => {
    expect((await call("POST", "/v1/account:link", { key: A.storefrontKey, sub: LOGIN, body: linkBody() })).status).toBe(409);
    const login2 = `acct-replay-${uuidv7()}`;
    const body = linkBody("Replay (synthetic)");
    const first = await call("POST", "/v1/account:link", { key: A.storefrontKey, sub: login2, body });
    const firstText = await first.text();
    const again = await call("POST", "/v1/account:link", { key: A.storefrontKey, sub: login2, body });
    expect([first.status, again.status, again.headers.get("X-Munim-Replayed")]).toEqual([200, 200, "true"]);
    expect(await again.text()).toBe(firstText);
    expect(await n(`SELECT count(*) AS n FROM core.customer WHERE idp_sub = $1`, [login2])).toBe(1);
  });
});

describe("guest-order claim by token", () => {
  it("each right token claims its order: claimed = 3 (fixture count); the list shows exactly those", async () => {
    expect(await n(`SELECT count(*) AS n FROM core."order" WHERE tenant_id = $1 AND customer_id = $2`, [A.tenant, idA])).toBe(0);
    for (const g of guestOrders) {
      const r = await call("POST", "/v1/account:link", { key: A.storefrontKey, sub: LOGIN, guestToken: g.token, body: linkBody() });
      expect(r.status).toBe(200);
    }
    expect(await n(`SELECT count(*) AS n FROM core."order" WHERE tenant_id = $1 AND customer_id = $2`, [A.tenant, idA])).toBe(3);
    const list = AccountOrdersResponse.parse(await (await call("GET", "/v1/account/orders", { key: A.storefrontKey, sub: LOGIN })).json());
    expect(list.orders.map((o) => o.order_id).sort()).toEqual(guestOrders.map((g) => g.order).sort());
    // Pagination: 2 + 1, newest first, no overlap.
    const p1 = AccountOrdersResponse.parse(await (await call("GET", "/v1/account/orders?limit=2", { key: A.storefrontKey, sub: LOGIN })).json());
    const p2 = AccountOrdersResponse.parse(await (await call("GET", `/v1/account/orders?limit=2&cursor=${p1.next_cursor}`, { key: A.storefrontKey, sub: LOGIN })).json());
    expect([p1.orders.length, p2.orders.length, p2.next_cursor]).toEqual([2, 1, null]);
    expect([...p1.orders, ...p2.orders].map((o) => o.order_id).sort()).toEqual(guestOrders.map((g) => g.order).sort());
  });

  it("a wrong token → 404 and nothing moves; an already-claimed token → 404 (0016 forgets the hash on claim); another account's order → 404", async () => {
    const before = await n(`SELECT count(*) AS n FROM core.command_log WHERE tenant_id = $1`, [A.tenant]);
    const wrong = await call("POST", "/v1/account:link", { key: A.storefrontKey, sub: LOGIN, guestToken: randomBytes(32).toString("base64url"), body: linkBody() });
    expect(wrong.status).toBe(404);
    expect(await n(`SELECT count(*) AS n FROM core.command_log WHERE tenant_id = $1`, [A.tenant])).toBe(before);
    expect((await call("POST", "/v1/account:link", { key: A.storefrontKey, sub: LOGIN, guestToken: guestOrders[0]!.token, body: linkBody() })).status).toBe(404);
    const stolen = await call("POST", "/v1/account:link", { key: A.storefrontKey, sub: LOGIN, guestToken: otherOrder.token, body: linkBody() });
    expect(stolen.status).toBe(404);
    expect((await db.admin(`SELECT customer_id FROM core."order" WHERE tenant_id = $1 AND id = $2`, [A.tenant, otherOrder.order])).rows[0]!.customer_id).toBe(otherAccount);
    expect(await n(`SELECT count(*) AS n FROM core."order" WHERE tenant_id = $1 AND customer_id = $2`, [A.tenant, idA])).toBe(3);
  });

  it("A's guest token presented at merchant B → 404; B's profile sees 0 of A's orders", async () => {
    expect((await call("POST", "/v1/account:link", { key: B.storefrontKey, sub: LOGIN, guestToken: unrelatedGuest.token, body: linkBody() })).status).toBe(404);
    const atB = AccountOrdersResponse.parse(await (await call("GET", "/v1/account/orders", { key: B.storefrontKey, sub: LOGIN })).json());
    expect(atB.orders).toEqual([]);
    expect((await call("GET", `/v1/account/orders/${guestOrders[0]!.order}`, { key: B.storefrontKey, sub: LOGIN })).status).toBe(404);
    expect(await n(`SELECT count(*) AS n FROM core."order" WHERE tenant_id = $1 AND customer_id = $2`, [B.tenant, idB])).toBe(0);
  });
});

describe("another customer's order → 404", () => {
  it("own order → 200 with its 1 line; another account's, an unclaimed guest's and the world customer's → 404", async () => {
    const own = await call("GET", `/v1/account/orders/${guestOrders[1]!.order}`, { key: A.storefrontKey, sub: LOGIN });
    expect(own.status).toBe(200);
    const d = AccountOrderDetail.parse(await own.json());
    expect([d.order.order_id, d.order.total_minor, d.lines.length, d.lines[0]!.unit_price_minor]).toEqual([guestOrders[1]!.order, 33600, 1, 32000]);
    for (const other of [otherOrder.order, unrelatedGuest.order, A.orders[0]]) {
      expect((await call("GET", `/v1/account/orders/${other}`, { key: A.storefrontKey, sub: LOGIN })).status).toBe(404);
    }
  });
});

describe("self-service: consent, profile, loyalty", () => {
  it("consent and profile updates are the customer's own commands and read back", async () => {
    expect((await call("POST", "/v1/account/consent", { key: A.storefrontKey, sub: LOGIN, body: env("customers.consent.set.v1", { marketing: true }) })).status).toBe(200);
    expect((await call("POST", "/v1/account/profile", { key: A.storefrontKey, sub: LOGIN, body: env("customers.profile.update.v1", { name: "Asha R (synthetic)", phone: "+919800000007" }) })).status).toBe(200);
    const p = AccountProfile.parse(await (await call("GET", "/v1/account", { key: A.storefrontKey, sub: LOGIN })).json());
    expect([p.name, p.phone, p.consent?.marketing]).toEqual(["Asha R (synthetic)", "+919800000007", true]);
    // B's profile is untouched by A's commands.
    const pb = AccountProfile.parse(await (await call("GET", "/v1/account", { key: B.storefrontKey, sub: LOGIN })).json());
    expect([pb.name, pb.consent]).toEqual(["Asha (synthetic)", null]);
    // Refusal paired: a payload naming another field is invalid.
    expect((await call("POST", "/v1/account/profile", { key: A.storefrontKey, sub: LOGIN, body: env("customers.profile.update.v1", { name: "X", phone: null, email: "x@example.test" }) })).status).toBe(422);
  });

  it("loyalty: balance is the latest entry's balance_after (40), entries listed; empty at B", async () => {
    await db.withContext("munim_core", { tenant_id: A.tenant, outlet_ids: "*", role: "owner", member_id: A.owner, command_type: "customers.loyalty.adjust.v1" }, (c) =>
      c.query(`INSERT INTO core.loyalty_entry (tenant_id, id, customer_id, kind, points, order_id) VALUES ($1, $2, $3, 'earn', 40, $4)`,
        [A.tenant, uuidv7(), idA, guestOrders[0]!.order]));
    const l = AccountLoyalty.parse(await (await call("GET", "/v1/account/loyalty", { key: A.storefrontKey, sub: LOGIN })).json());
    expect([l.balance?.points, l.entries.length, l.entries[0]!.points, l.entries[0]!.order_id]).toEqual([40, 1, 40, guestOrders[0]!.order]);
    const lb = AccountLoyalty.parse(await (await call("GET", "/v1/account/loyalty", { key: B.storefrontKey, sub: LOGIN })).json());
    expect(lb).toEqual({ balance: null, entries: [] });
  });
});

describe("data export", () => {
  // Hand fixture (B14): on the customer's 3 orders — 1 order_event, 2 tenders (cash 33,600 with 34,000 handed over, upi 33,600),
  // 1 refund (16,000 of the cash tender), 1 coupon use (500 off), 1 void (16,000, a line), 1 sale return (1 unit) — and, on
  // other people's orders, 1 tender + 1 order_event + 1 coupon use + 1 refund that must NOT appear.
  const foreign: string[] = [];
  const asOwner = (type: string, fn: (c: pg.ClientBase) => Promise<unknown>) =>
    db.withContext("munim_core", { tenant_id: A.tenant, outlet_ids: "*", role: "owner", member_id: A.owner, command_type: type }, fn);
  const tender = async (order: string, method: string, tendered: number | null) => {
    const id = uuidv7();
    await asOwner("orders.tender.record.v1", (c) => c.query(
      `INSERT INTO core.tender (tenant_id, id, outlet_id, order_id, method, amount_minor, tendered_minor, change_minor, currency, recorded_by)
       VALUES ($1, $2, $3, $4, $5, 33600, $6, $7, $8, $9)`, [A.tenant, id, A.outlets[0], order, method, tendered, tendered === null ? null : tendered - 33600, A.currency, A.owner]));
    return id;
  };
  beforeAll(async () => {
    const [o0, o1, o2] = guestOrders.map((g) => g.order) as [string, string, string];
    const line = async (o: string) => (await db.admin<{ id: string }>(`SELECT id FROM core.order_line WHERE order_id = $1`, [o])).rows[0]!.id;
    const [l0, l1] = [await line(o0), await line(o1)];
    const cash = await tender(o0, "cash", 34000);
    await tender(o1, "upi", null);
    foreign.push(await tender(otherOrder.order, "card", null));
    await asOwner("orders.place.v1", async (c) => {
      await c.query(`INSERT INTO core.order_event (tenant_id, id, outlet_id, order_id, kind, from_status, to_status, actor) VALUES ($1, $2, $3, $4, 'status', 'placed', 'accepted', '{"kind":"member"}')`,
        [A.tenant, uuidv7(), A.outlets[0], o0]);
      const foreignEvent = uuidv7();
      foreign.push(foreignEvent);
      await c.query(`INSERT INTO core.order_event (tenant_id, id, outlet_id, order_id, kind, from_status, to_status, actor) VALUES ($1, $2, $3, $4, 'status', 'placed', 'accepted', '{"kind":"member"}')`,
        [A.tenant, foreignEvent, A.outlets[0], unrelatedGuest.order]);
      const coupon = (await db.admin<{ id: string }>(`SELECT id FROM core.coupon WHERE tenant_id = $1 LIMIT 1`, [A.tenant])).rows[0]!.id;
      const foreignUse = uuidv7();
      foreign.push(foreignUse);
      await c.query(`INSERT INTO core.coupon_use (tenant_id, id, coupon_id, order_id, customer_id, discount_minor, currency, applied_by) VALUES ($1, $2, $3, $4, $5, 500, $6, $7)`,
        [A.tenant, uuidv7(), coupon, o2, idA, A.currency, A.owner]);
      await c.query(`INSERT INTO core.coupon_use (tenant_id, id, coupon_id, order_id, customer_id, discount_minor, currency, applied_by) VALUES ($1, $2, $3, $4, $5, 500, $6, $7)`,
        [A.tenant, foreignUse, coupon, otherOrder.order, otherAccount, A.currency, A.owner]);
    });
    await asOwner("orders.refund.record.v1", (c) => c.query(
      `INSERT INTO core.refund (tenant_id, id, outlet_id, order_id, tender_id, method, amount_minor, currency, reason_code, note, actor) VALUES ($1, $2, $3, $4, $5, 'cash', 16000, $6, 'wrong_item', 'synthetic', $7)`,
      [A.tenant, uuidv7(), A.outlets[0], o0, cash, A.currency, A.owner]));
    await asOwner("orders.void.record.v1", (c) => c.query(
      `INSERT INTO core.void (tenant_id, id, outlet_id, order_id, order_line_id, reason_code, note, amount_minor, currency, actor) VALUES ($1, $2, $3, $4, $5, 'remake', 'synthetic', 16000, $6, $7)`,
      [A.tenant, uuidv7(), A.outlets[0], o1, l1, A.currency, A.owner]));
    await asOwner("orders.sale_return.record.v1", (c) => c.query(
      `INSERT INTO core.sale_return (tenant_id, id, outlet_id, order_id, order_line_id, qty_milli, restock, reason_code, note, actor) VALUES ($1, $2, $3, $4, $5, 1000, false, 'damaged', 'synthetic', $6)`,
      [A.tenant, uuidv7(), A.outlets[0], o0, l0, A.owner]));
  });

  it("contains the customer's order events, tenders, refunds, coupon uses, voids and sale returns (hand counts) and nothing of anyone else's", async () => {
    const r = await call("POST", "/v1/account:export", { key: A.storefrontKey, sub: LOGIN, body: env("customers.data.export.v1", { format: "json" }) });
    expect(r.status).toBe(200);
    const x = AccountExport.parse(await r.json()).export;
    expect([x.order_events.length, x.tenders.length, x.refunds.length, x.coupon_uses.length, x.voids.length, x.sale_returns.length]).toEqual([1, 2, 1, 1, 1, 1]);
    expect(x.tenders.map((t) => [t.method, t.amount_minor, t.tendered_minor, t.change_minor]).sort()).toEqual([["cash", 33600, 34000, 400], ["upi", 33600, null, null]]);
    expect(x.refunds[0]).toMatchObject({ amount_minor: 16000, method: "cash", reason_code: "wrong_item" });
    expect(x.coupon_uses[0]).toMatchObject({ discount_minor: 500, order_id: guestOrders[2]!.order });
    expect(x.voids[0]).toMatchObject({ amount_minor: 16000, order_id: guestOrders[1]!.order });
    expect(x.sale_returns[0]).toMatchObject({ qty_milli: 1000, restock: false, order_id: guestOrders[0]!.order });
    expect(x.order_events[0]).toMatchObject({ from_status: "placed", to_status: "accepted", order_id: guestOrders[0]!.order });
    const text = JSON.stringify(x);
    for (const id of foreign) expect(text.includes(id)).toBe(false);
    // staff ids never leave: neither the owner's member id nor an actor object
    expect(text.includes(A.owner)).toBe(false);
  });

  it("contains only this customer's rows at this merchant", async () => {
    const r = await call("POST", "/v1/account:export", { key: A.storefrontKey, sub: LOGIN, body: env("customers.data.export.v1", { format: "json" }) });
    expect(r.status).toBe(200);
    const x = AccountExport.parse(await r.json());
    expect(x.export.tenant_id).toBe(A.tenant);
    expect(x.export.profile.customer_id).toBe(idA);
    expect(x.export.orders.map((o) => o.order.order_id).sort()).toEqual(guestOrders.map((g) => g.order).sort());
    expect(x.export.orders.map((o) => o.lines.length)).toEqual([1, 1, 1]);
    expect(x.export.loyalty_entries.map((e) => e.points)).toEqual([40]);
    // The world customer at A owns a reservation and a 100-point entry: neither is here.
    expect(x.export.reservations).toEqual([]);
    expect(x.export.bulk_orders).toEqual([]);
    const text = JSON.stringify(x);
    for (const foreign of [otherOrder.order, unrelatedGuest.order, A.orders[0], A.orders[1], otherAccount, guestProfile, A.customer, idB, B.tenant]) {
      expect(text.includes(foreign)).toBe(false);
    }
    expect(await n(`SELECT count(*) AS n FROM core.audit_log WHERE tenant_id = $1 AND action = 'customers.data.export.v1' AND entity_id = $2`, [A.tenant, idA])).toBe(2); // two exports have run in this file
  });
});

describe("erasure", () => {
  it("anonymises personal fields, keeps order rows (3 orders, 3 lines, 1 loyalty entry), closes the profile", async () => {
    const counts = async () => [
      await n(`SELECT count(*) AS n FROM core."order" WHERE tenant_id = $1 AND customer_id = $2`, [A.tenant, idA]),
      await n(`SELECT count(*) AS n FROM core.order_line l JOIN core."order" o ON o.tenant_id = l.tenant_id AND o.id = l.order_id
               WHERE o.tenant_id = $1 AND o.customer_id = $2`, [A.tenant, idA]),
      await n(`SELECT count(*) AS n FROM core.loyalty_entry WHERE tenant_id = $1 AND customer_id = $2`, [A.tenant, idA]),
    ];
    expect(await counts()).toEqual([3, 3, 1]);
    const r = await call("POST", "/v1/account:erase", { key: A.storefrontKey, sub: LOGIN, body: env("customers.erasure.request.v1", { confirm: true }) });
    expect(r.status).toBe(200);
    const row = (await db.admin(`SELECT name, phone, email, idp_sub, email_verified_at, consent, erased_at FROM core.customer WHERE tenant_id = $1 AND id = $2`,
      [A.tenant, idA])).rows[0]!;
    expect({ ...row, erased_at: row.erased_at !== null }).toEqual({ name: null, phone: null, email: null, idp_sub: null, email_verified_at: null, consent: {}, erased_at: true });
    expect(await counts()).toEqual([3, 3, 1]);
    // The audit trail names no personal field.
    const audit = (await db.admin<{ t: string }>(`SELECT coalesce(before::text, '') || coalesce(after::text, '') AS t FROM core.audit_log WHERE tenant_id = $1 AND entity_id = $2`,
      [A.tenant, idA])).rows.map((a) => a.t).join(" ");
    expect(audit.length).toBeGreaterThan(0);
    for (const pii of [LOGIN_EMAIL, "Asha", "+919800000007", LOGIN]) expect(audit.includes(pii)).toBe(false);
    // The login no longer resolves to the erased profile at A; B's profile is untouched.
    expect((await call("GET", "/v1/account", { key: A.storefrontKey, sub: LOGIN })).status).toBe(404);
    expect((await call("GET", "/v1/account", { key: B.storefrontKey, sub: LOGIN })).status).toBe(200);
  });

  it("an erased profile is final (MB007) — paired with an accepted update on a live profile", async () => {
    const ctx = (id: string) => ({ tenant_id: A.tenant, outlet_ids: [] as string[], role: "customer" as const, customer_id: id, command_type: "customers.profile.update.v1" });
    const ok = await db.withContext("munim_core", { ...ctx(otherAccount) }, (c) =>
      c.query(`UPDATE core.customer SET name = 'Other (synthetic)' WHERE id = $1`, [otherAccount])).then((r) => r.rowCount, () => -1);
    expect(ok).toBe(1);
    const err = await db.withContext("munim_core", ctx(idA), (c) => c.query(`UPDATE core.customer SET name = 'Back' WHERE id = $1`, [idA]))
      .then(() => "none", (e: { code?: string }) => e.code ?? "?");
    expect(err).toBe("MB007");
  });

  it("signing in again after erasure starts a fresh profile with no orders", async () => {
    const r = await call("POST", "/v1/account:link", { key: A.storefrontKey, sub: LOGIN, email: LOGIN_EMAIL, body: linkBody() });
    expect(r.status).toBe(200);
    const fresh = ((await r.json()) as { entity_id: string }).entity_id;
    expect(fresh).not.toBe(idA);
    const list = AccountOrdersResponse.parse(await (await call("GET", "/v1/account/orders", { key: A.storefrontKey, sub: LOGIN })).json());
    expect(list.orders).toEqual([]);
  });
});

describe("verified-email merge of guest profiles (R41, 0015 A10)", () => {
  it("unverified moves 0; verified moves the guest's 2 orders and 1 reservation and merges the guest — one audit row per changed row", async () => {
    const email = "ravi.synthetic@example.test";
    const g = await addGuestProfile(A, email);
    const orders = [(await addGuestOrder(db, A, g)).order, (await addGuestOrder(db, A, g)).order];
    const reservation = uuidv7();
    await db.withContext("munim_core", { tenant_id: A.tenant, outlet_ids: "*", role: "owner", member_id: A.owner, command_type: "customers.reservation.upsert.v1" }, (c) =>
      c.query(`INSERT INTO core.reservation (tenant_id, id, outlet_id, customer_id, name, party_size, starts_at) VALUES ($1, $2, $3, $4, 'Ravi', 2, '2026-10-20T19:00:00Z')`,
        [A.tenant, reservation, A.outlets[0], g]));
    const unverified = await call("POST", "/v1/account:link", { key: A.storefrontKey, sub: `acct-unverified-${uuidv7()}`, email, body: linkBody("Ravi U (synthetic)") });
    expect(unverified.status).toBe(200);
    expect(await n(`SELECT count(*) AS n FROM core."order" WHERE tenant_id = $1 AND customer_id = $2`, [A.tenant, g])).toBe(2);

    const r = await call("POST", "/v1/account:link", { key: A.storefrontKey, sub: `acct-verified-${uuidv7()}`, email, verified: true, body: linkBody("Ravi (synthetic)") });
    expect(r.status).toBe(200);
    const id = ((await r.json()) as { entity_id: string }).entity_id;
    expect(await n(`SELECT count(*) AS n FROM core."order" WHERE tenant_id = $1 AND customer_id = $2`, [A.tenant, id])).toBe(2);
    expect(await n(`SELECT count(*) AS n FROM core."order" WHERE tenant_id = $1 AND customer_id = $2`, [A.tenant, g])).toBe(0);
    expect(await n(`SELECT count(*) AS n FROM core.reservation WHERE tenant_id = $1 AND customer_id = $2`, [A.tenant, id])).toBe(1);
    expect(await n(`SELECT count(*) AS n FROM core.customer WHERE tenant_id = $1 AND id = $2 AND merged_into = $3`, [A.tenant, g, id])).toBe(1);
    // The audit entries of this command are exactly the changed rows (hand-listed: 2 orders, 1 reservation, the guest),
    // plus the new profile itself; each moved row names the guest it came from.
    const audit = (await db.admin<{ entity: string; entity_id: string; before: Record<string, unknown> | null }>(
      `SELECT entity, entity_id, before FROM core.audit_log WHERE tenant_id = $1 AND action = 'customers.account.link.v1' AND entity_id = ANY ($2::text[]) ORDER BY entity, entity_id`,
      [A.tenant, [...orders, reservation, g]])).rows;
    expect(audit).toEqual([
      { entity: "core.customer", entity_id: g, before: { merged_into: null } },
      ...[...orders].sort().map((o) => ({ entity: "core.order", entity_id: o, before: { customer_id: g } })),
      { entity: "core.reservation", entity_id: reservation, before: { customer_id: g } },
    ]);
  });
});

describe("ensureProfile seam (T-032)", () => {
  it("first call creates the profile, the second returns the same id; a guest → 401", async () => {
    const sub = `acct-seam-${uuidv7()}`;
    const first = await call("POST", "/v1/_test/ensure-profile", { key: A.storefrontKey, sub, email: "seam.synthetic@example.test" });
    expect(first.status).toBe(200);
    const a = (await first.json()) as { id: string; profile: boolean };
    const second = (await (await call("POST", "/v1/_test/ensure-profile", { key: A.storefrontKey, sub })).json()) as { id: string; profile: boolean };
    expect([a.profile, second.id, second.profile]).toEqual([true, a.id, true]);
    expect(await n(`SELECT count(*) AS n FROM core.customer WHERE tenant_id = $1 AND idp_sub = $2`, [A.tenant, sub])).toBe(1);
    expect(await n(`SELECT count(*) AS n FROM core.command_log WHERE tenant_id = $1 AND command_type = 'customers.account.link.v1' AND actor->>'id' = $2`, [A.tenant, a.id])).toBe(1);
    expect((await call("POST", "/v1/_test/ensure-profile", { key: A.storefrontKey })).status).toBe(401);
  });
});

describe("R1-m12: unhandled Postgres errors are logged without row values", () => {
  it("a real 23505 with an email in the duplicate key → 500 internal; the log line has 23505 + constraint + table, not the email", async () => {
    const lines: string[] = [];
    const config = { nodeEnv: "test", redact: (x: string) => x };
    const logged = await createApp({ pools, idp, storefronts: storefrontResolver(pools.core), config, log: createLogger(config, (l) => lines.push(l)) });
    const SENTINEL = `pii.sentinel.${uuidv7()}@example.test`;
    logged.post("/v1/_test/pg-23505", async () => {
      // A real server error from the embedded cluster: a duplicate key in a throwaway table (superuser, temp).
      const c = await db.connect("admin");
      try {
        await c.query("BEGIN");
        await c.query("CREATE TEMP TABLE m12_probe (email text CONSTRAINT m12_probe_email_key PRIMARY KEY) ON COMMIT DROP");
        await c.query("INSERT INTO m12_probe VALUES ($1), ($1)", [SENTINEL]);
      } finally {
        await c.query("ROLLBACK");
        await c.end();
      }
      return new Response(null, { status: 204 });
    });
    const r = await logged.request("/v1/_test/pg-23505", { method: "POST" });
    expect([r.status, ((await r.json()) as { error: { code: string } }).error.code]).toEqual([500, "internal"]);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatch(/^POST \/v1\/_test\/pg-23505: unhandled pg 23505 constraint=m12_probe_email_key table=pg_temp_\d+\.m12_probe$/);
    expect(lines[0]!.includes(SENTINEL)).toBe(false);
    expect(lines.join("\n").includes("already exists")).toBe(false);
  });
});
