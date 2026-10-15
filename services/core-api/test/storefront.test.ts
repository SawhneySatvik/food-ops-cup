// Storefront API (T-032) through the real app: auth (storefront key → tenant + channel), RLS, executeCommand, the
// book guard — on the REAL cross-module seams (W2 B4): orders' preview and placement on storefront's own
// transaction, catalogue's itemsForSale and priceLines, accounts' ensureProfile. Nothing is faked; the module's
// clock is the only test hook (configureStorefront), and dates are relative to the real day because placement
// checks the pickup window against the real clock and `created_at` is the database's now().
// Expected values are hand-computed (IN pack: restaurant_5 = CGST 2.5% + SGST 2.5%, each rounded per line):
//   price 32000; lunch deal 10% off 12:00–15:00 outlet-local (the world's always-on deal.lunch is switched off).
//   13:00 with deal: 32000 − 3200 = 28800, tax 720 + 720 = 1440, total 30240
//   + WELCOME10 (10% of 28800 = 2880): 25920, tax 648 + 648 = 1296, total 27216
//   16:00 no deal: tax 800 + 800 = 1600, total 33600
// storefront.order.cancel.v1 / .reschedule.v1 are the seeded rows (0015 A4); no test shim.
import { createHash } from "node:crypto";
import { createLogger } from "@munim/config";
import { buildWorld, ownerCtx, type TestDb, uuidv7 } from "@munim/db";
import type { Hono } from "hono";
import type pg from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createLocalIdp } from "../src/auth/local-idp.ts";
import { type AppEnv, createApp, GUEST_TOKEN_HEADER, STOREFRONT_KEY_HEADER, storefrontResolver } from "../src/app.ts";
import { configureStorefront, resetStorefront } from "../src/modules/storefront/index.ts";
import {
  StorefrontAccepting, StorefrontMenuResponse, StorefrontOrderPlaced, StorefrontOrderView, StorefrontOutletsResponse, StorefrontPickupWindowsResponse,
  StorefrontPreviewResponse, StorefrontReschedulePreviewResponse,
} from "@munim/contracts/storefront";
import { openDb } from "./db.ts";
import { buildTenant, type Tenant } from "./world.ts";

// Asia/Kolkata is UTC+05:30 all year (no DST): an IST wall time on an IST date is that instant.
const istDate = (ms: number) => new Date(ms + 330 * 60_000).toISOString().slice(0, 10);
const ist = (date: string, hhmm: string) => new Date(`${date}T${hhmm}:00+05:30`).toISOString();
const DAY = 86_400_000;
const D1 = istDate(Date.now() + DAY); // tomorrow: every pickup window and promise is in the real future
const D2 = istDate(Date.now() + 2 * DAY); // restricted hours 09:00–22:00 (dated override)
const D5 = istDate(Date.now() + 5 * DAY); // holiday (dated override, closed)
const AT_1300 = new Date(ist(D1, "13:00"));
const P_1300 = ist(D1, "13:00"); // deal window 12:00–15:00
const P_1600 = ist(D1, "16:00"); // no deal
const P_HOLIDAY = ist(D5, "13:00");

const idp = createLocalIdp();
let db: TestDb;
let pools: { core: pg.Pool; svc: pg.Pool };
let app: Hono<AppEnv>;
let W: Tenant;
let other: Tenant;
let KEY: string; // pickup channel key
let CH: string; // pickup channel id
let OUT: string; // outlet 1
let ITEM2: string; // sold-out item
let VARIANT: string; // the world paneer tikka's one variant (the item sells only as it)
let win: { w1300: string; full: string; w1600: string; w1630: string };
let clockNow = AT_1300;

const cmdCtx = (type: string) => ownerCtx(W, { command_type: type });
/** The storefront clock `min` minutes after the order's own created_at (the database's now()). */
const afterCreated = async (id: string, min: number) =>
  new Date(((await db.admin(`SELECT created_at FROM core."order" WHERE id = $1`, [id])).rows[0]!.created_at as Date).getTime() + min * 60_000);

// ─────────────────────────────────────── fixture ───────────────────────────────────────
beforeAll(async () => {
  db = await openDb();
  W = await buildTenant(db, "S");
  other = await buildTenant(db, "O");
  OUT = W.outlets[0];
  CH = uuidv7();
  ITEM2 = uuidv7();
  KEY = `sfk_P_${uuidv7().replaceAll("-", "")}${uuidv7().replaceAll("-", "")}`;
  win = { w1300: uuidv7(), full: uuidv7(), w1600: uuidv7(), w1630: uuidv7() };

  await db.withContext("munim_core", cmdCtx("tenancy.channel.create.v1"), (c) =>
    c.query(`INSERT INTO core.channel (tenant_id, id, name, kind) VALUES ($1, $2, 'Pickup', 'pickup')`, [W.tenant, CH]));
  await db.withContext("munim_core", ownerCtx(W), (c) =>
    c.query(`INSERT INTO core.storefront_key (tenant_id, id, channel_id, key_hash) VALUES ($1, $2, $3, $4)`, [W.tenant, uuidv7(), CH, createHash("sha256").update(KEY).digest("hex")]));
  await db.withContext("munim_core", cmdCtx("catalogue.item.upsert.v1"), async (c) => {
    await c.query(`INSERT INTO core.item (tenant_id, id, kind, name_key, category) VALUES ($1, $2, 'dish', 'menu.lassi', 'drinks')`, [W.tenant, ITEM2]);
  });
  // The world's paneer tikka is sold by its one variant (catalogue's sellable rule): carts name it.
  VARIANT = (await db.admin<{ id: string }>(`SELECT id FROM core.variant WHERE tenant_id = $1 AND item_id = $2`, [W.tenant, W.item])).rows[0]!.id;
  await db.withContext("munim_core", cmdCtx("catalogue.price.set.v1"), async (c) => {
    await c.query(`INSERT INTO core.price (tenant_id, id, item_id, outlet_id, channel_kind, amount_minor, currency, tax_class, valid_from) VALUES ($1, $2, $3, $4, 'pickup', 32000, 'INR', 'restaurant_5', '2026-10-01')`, [W.tenant, uuidv7(), W.item, OUT]);
    await c.query(`INSERT INTO core.price (tenant_id, id, item_id, outlet_id, channel_kind, amount_minor, currency, tax_class, valid_from) VALUES ($1, $2, $3, $4, 'pickup', 8000, 'INR', 'restaurant_5', '2026-10-01')`, [W.tenant, uuidv7(), ITEM2, OUT]);
  });
  await db.withContext("munim_core", cmdCtx("catalogue.deal.upsert.v1"), (c) =>
    c.query(`INSERT INTO core.deal (tenant_id, id, kind, name_key, rule, windows, valid_from) VALUES ($1, $2, 'percent_off', 'deal.lunch_window', $3, $4, '2026-10-01')`,
      [W.tenant, uuidv7(), JSON.stringify({ kind: "percent_off", bp: 1000, item_ids: [] }), JSON.stringify([{ days: [1, 2, 3, 4, 5, 6, 7], from: "12:00", to: "15:00" }])]));
  // The world's always-on 10% deal.lunch would discount every hour; switched off so the window deal is the only one.
  await db.withContext("munim_core", cmdCtx("catalogue.deal.end.v1"), (c) => c.query(`UPDATE core.deal SET active = false WHERE name_key = 'deal.lunch'`));
  await db.withContext("munim_core", cmdCtx("catalogue.coupon.set.v1"), async (c) => {
    const ins = (code: string, extra: string, args: unknown[]) =>
      c.query(`INSERT INTO core.coupon (tenant_id, id, code, kind, value_bp, currency, ${extra.split("|")[0]}) VALUES ($1, $2, $3, 'percent', 1000, 'INR', ${extra.split("|")[1]})`, [W.tenant, uuidv7(), code, ...args]);
    await ins("TENSPEND", "min_spend_minor, valid_from|100000, '2026-10-01'", []);
    await ins("CAPPED1", "global_cap, valid_from|1, '2026-10-01'", []);
    await ins("EXPIRED1", "valid_from, valid_to|'2026-09-01', '2026-10-05'", []);
  });
  // CAPPED1 has already been used once (the cap is 1): a coupon_use on the world's first order.
  await db.withContext("munim_core", cmdCtx("orders.place.v1"), (c) =>
    c.query(`INSERT INTO core.coupon_use (tenant_id, id, coupon_id, order_id, customer_id, discount_minor, currency, applied_by)
             SELECT $1, $2, id, $3, $4, 0, 'INR', $5 FROM core.coupon WHERE code = 'CAPPED1'`, [W.tenant, uuidv7(), W.orders[0], W.customer, W.owner]));
  // Open round the clock every weekday (the change-window gates run on the real clock), except two dated
  // overrides: D2 trades 09:00–22:00 only, D5 is a holiday.
  await db.withContext("munim_core", cmdCtx("tenancy.outlet.create.v1"), async (c) => {
    for (const d of [0, 1, 2, 3, 4, 5, 6])
      await c.query(`INSERT INTO core.outlet_calendar (tenant_id, id, outlet_id, kind, weekday, opens_at, closes_at) VALUES ($1, $2, $3, 'weekly', $4, '00:00', '24:00')`, [W.tenant, uuidv7(), OUT, d]);
    await c.query(`INSERT INTO core.outlet_calendar (tenant_id, id, outlet_id, kind, on_date, opens_at, closes_at) VALUES ($1, $2, $3, 'override', $4, '09:00', '22:00')`, [W.tenant, uuidv7(), OUT, D2]);
    await c.query(`INSERT INTO core.outlet_calendar (tenant_id, id, outlet_id, kind, on_date, closed) VALUES ($1, $2, $3, 'override', $4, true)`, [W.tenant, uuidv7(), OUT, D5]);
  });
  await db.withContext("munim_core", ownerCtx(W), async (c) => {
    const ins = (id: string, from: string, to: string, cap: number, booked: number) =>
      c.query(`INSERT INTO core.pickup_window (tenant_id, id, outlet_id, starts_at, ends_at, capacity_orders, booked) VALUES ($1, $2, $3, $4, $5, $6, $7)`, [W.tenant, id, OUT, from, to, cap, booked]);
    await ins(win.w1300, ist(D1, "13:00"), ist(D1, "13:30"), 100, 0);
    await ins(win.full, ist(D1, "13:30"), ist(D1, "14:00"), 1, 1);
    await ins(win.w1600, ist(D1, "16:00"), ist(D1, "16:30"), 100, 0);
    await ins(win.w1630, ist(D1, "16:30"), ist(D1, "17:00"), 100, 0);
  });

  pools = { core: db.pool("munim_core", 6), svc: db.pool("munim_svc", 2) };
  const config = { nodeEnv: "test", redact: (s: string) => s };
  app = await createApp({ pools, idp, storefronts: storefrontResolver(pools.core), config, log: createLogger(config, () => {}) });
});
afterAll(async () => {
  resetStorefront();
  await pools.core.end();
  await pools.svc.end();
  await db.stop();
});
beforeEach(() => {
  clockNow = AT_1300;
  configureStorefront({ clock: () => clockNow });
});

// ─────────────────────────────────────── helpers ───────────────────────────────────────
const H = (extra: Record<string, string> = {}, key = KEY) => ({ "Content-Type": "application/json", [STOREFRONT_KEY_HEADER]: key, ...extra });
const call = (method: string, path: string, body?: unknown, headers: Record<string, string> = {}, key = KEY) =>
  app.request(path, { method, headers: H(headers, key), ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
const bearer = (sub: string) => ({ Authorization: `Bearer ${idp.sign({ sub })}` });
const GUEST = { name: "Test Guest", phone: "+919800000001", email: null, consent: { marketing: false, at: "2026-10-10T07:00:00.000Z" } };

function placeBody(over: Record<string, unknown> = {}, opts: { guest?: boolean; item?: string; key?: string } = {}) {
  const orderId = uuidv7();
  const key = opts.key ?? `place-${orderId}`;
  return {
    order_id: orderId,
    body: {
      order: {
        command_id: uuidv7(), idempotency_key: key, type: "orders.place.v1",
        payload: {
          order_id: orderId, outlet_id: OUT, channel_id: W.channel, brand_id: null, device_id: null, kind: "pickup", table_ref: null,
          pickup_window_id: win.w1300, promised_at: P_1300, external_ref: null,
          lines: [{ line_id: uuidv7(), item_id: opts.item ?? W.item, variant_id: (opts.item ?? W.item) === W.item ? VARIANT : null, option_ids: [], qty_milli: 1000, barcode: null, note: null }],
          coupon_codes: [], loyalty_redeem_points: 0, preview_total_minor: null, client_totals: null,
          ...over,
        },
      },
      contact: opts.guest === false ? { name: "Signed In", phone: null } : null,
      guest: opts.guest === false ? null : { command_id: uuidv7(), idempotency_key: `guest-${orderId}`, type: "storefront.guest.create.v1", payload: GUEST },
    },
  };
}
const place = async (over: Record<string, unknown> = {}, opts: Parameters<typeof placeBody>[1] = {}, headers: Record<string, string> = {}) => {
  const b = placeBody(over, opts);
  const res = await call("POST", "/v1/storefront/orders", b.body, headers);
  return { res, id: b.order_id, body: (await res.clone().json()) as Record<string, any> };
};
const orderRow = async (id: string) => (await db.admin(`SELECT * FROM core."order" WHERE id = $1`, [id])).rows[0]!;
const reason = (b: Record<string, any>) => b.error?.reason_code;

// ─────────────────────────────────────── gates ───────────────────────────────────────
describe("keys and public reads", () => {
  it("a bad key, and a key on a counter channel, are 404 — never 403", async () => {
    expect((await call("GET", "/v1/storefront/outlets", undefined, {}, "sfk_not_a_real_key_0000000000000000")).status).toBe(404);
    expect((await call("GET", `/v1/storefront/outlets/${OUT}/menu`, undefined, {}, W.storefrontKey)).status).toBe(404); // bound to the counter channel
    // The good key's outlet list parses with its contract schema (a real response, R3-M5).
    const list = await call("GET", "/v1/storefront/outlets");
    expect(StorefrontOutletsResponse.parse(await list.json()).outlets.map((o) => o.outlet_id)).toContain(OUT);
  });

  it("menu: priced for the key's channel kind, availability per outlet, the deal, the accepting state, pay at the counter", async () => {
    await db.withContext("munim_core", cmdCtx("catalogue.availability.set.v1"), (c) =>
      c.query(`INSERT INTO core.item_availability (tenant_id, id, outlet_id, item_id, available, updated_by) VALUES ($1, $2, $3, $4, false, $5)`, [W.tenant, uuidv7(), OUT, ITEM2, W.owner]));
    const res = await call("GET", `/v1/storefront/outlets/${OUT}/menu`);
    expect(res.status).toBe(200);
    const m = (await res.json()) as any;
    StorefrontMenuResponse.parse(m);
    expect(m.channel_kind).toBe("pickup");
    expect(m.pay_at_counter).toBe(true);
    // The world's paneer tikka is sold by variant (catalogue itemsForSale): no item price, the variant carries the row's 32000.
    expect(m.items.map((i: any) => [i.name_key, i.price_minor, i.available, i.variants.map((v: any) => v.price_minor)]))
      .toEqual([["menu.lassi", 8000, false, []], ["menu.paneer_tikka", null, true, [32000]]]);
    expect(m.deals.map((d: any) => d.name_key).sort()).toEqual(["deal.lunch_window"]);
    expect(m.accepting).toMatchObject({ state: "open", busy_extra_min: 0, default_prep_min: 15, next_open: null });
    await db.admin(`DELETE FROM core.item_availability WHERE item_id = $1`, [ITEM2]);
  });

  it("accepting state: busy shows +N, paused has no resume time, after hours is closed with the next opening (calendar)", async () => {
    const setOutlet = (state: string, extra: number) => db.withContext("munim_core", cmdCtx("tenancy.outlet.create.v1"), (c) =>
      c.query(`UPDATE core.outlet SET accepting_orders = $2, busy_extra_min = $3 WHERE id = $1`, [OUT, state, extra]));
    const st = async () => StorefrontAccepting.parse(await (await call("GET", `/v1/storefront/outlets/${OUT}/state`)).json());
    await setOutlet("busy", 10);
    expect(await st()).toMatchObject({ state: "busy", busy_extra_min: 10 });
    await setOutlet("paused", 0);
    expect(await st()).toMatchObject({ state: "paused", next_open: null });
    await setOutlet("open", 0);
    expect((await st()).state).toBe("open");
    clockNow = new Date(ist(D2, "23:00")); // D2 trades 09:00–22:00 only
    // The next opening is the following day's weekly row, 00:00 IST = 18:30Z on D2.
    expect(await st()).toMatchObject({ state: "closed", next_open: `${D2}T18:30:00.000Z` });
  });

  it("pickup windows: the full window is hidden, windows with spare capacity are listed with their row fields", async () => {
    const r = StorefrontPickupWindowsResponse.parse(await (await call("GET", `/v1/storefront/outlets/${OUT}/pickup-windows`)).json());
    const ids = r.windows.map((w) => w.pickup_window_id);
    expect(ids).toContain(win.w1300);
    expect(ids).not.toContain(win.full);
    expect(r.windows.find((w: any) => w.pickup_window_id === win.w1300)).toMatchObject({ capacity_orders: 100 });
  });
});

describe("guest checkout", () => {
  it("happy path: one request creates the guest and the order; the key's channel wins; client totals are ignored; Pay at the counter", async () => {
    const { res, id, body } = await place({
      channel_id: W.channel, // a payload channel (the counter channel) must be ignored
      client_totals: { subtotal: { amount_minor: 1, currency: "INR" }, total: { amount_minor: 1, currency: "INR" } }, // tampered
    });
    expect(res.status).toBe(201);
    expect(body).toMatchObject({ order_id: id, status: "placed", total_minor: 30240, currency: "INR", pay_at_counter: true });
    expect(body.ticket_no).toBeGreaterThanOrEqual(1);
    expect(typeof body.guest_access_token).toBe("string");
    const row = await orderRow(id);
    expect(body.ticket_no).toBe(row.ticket_no); // the response is the row's own field
    expect(row.channel_id).toBe(CH); // the key's channel
    expect(Number(row.total_minor)).toBe(30240); // not the tampered 1
    expect(row.client_totals).toMatchObject({ total: { amount_minor: 1 } }); // recorded only, for tamper detection
    expect(row.guest_access_hash.equals(createHash("sha256").update(body.guest_access_token).digest())).toBe(true);
    const cust = (await db.admin(`SELECT is_guest, name, phone FROM core.customer WHERE id = $1`, [row.customer_id])).rows[0]!;
    expect(cust).toEqual({ is_guest: true, name: "Test Guest", phone: "+919800000001" });
    const window = (await db.admin(`SELECT booked FROM core.pickup_window WHERE id = $1`, [win.w1300])).rows[0]!;
    expect(window.booked).toBeGreaterThanOrEqual(1);
  });

  it("an unknown extra field such as a client price is refused, not silently trusted", async () => {
    const b = placeBody();
    (b.body.order.payload.lines[0] as Record<string, unknown>).unit_price_minor = 1;
    expect((await call("POST", "/v1/storefront/orders", b.body)).status).toBe(400);
    expect(await db.admin(`SELECT 1 FROM core."order" WHERE id = $1`, [b.order_id]).then((r) => r.rowCount)).toBe(0);
  });

  it("a refused placement leaves no guest customer behind (one transaction)", async () => {
    const b = placeBody({ pickup_window_id: win.full, promised_at: ist(D1, "13:30") }); // G-12: the promise lies inside its window
    const before = Number((await db.admin(`SELECT count(*) AS n FROM core.customer WHERE tenant_id = $1`, [W.tenant])).rows[0]!.n);
    expect((await call("POST", "/v1/storefront/orders", b.body)).status).toBe(409);
    expect(Number((await db.admin(`SELECT count(*) AS n FROM core.customer WHERE tenant_id = $1`, [W.tenant])).rows[0]!.n)).toBe(before);
  });

  it("a retry of the same request replays: same order, 201 + X-Munim-Replayed, no second token, no second order", async () => {
    const b = placeBody();
    const first = await call("POST", "/v1/storefront/orders", b.body);
    const again = await call("POST", "/v1/storefront/orders", b.body);
    expect(first.status).toBe(201);
    expect(again.status).toBe(201);
    expect(again.headers.get("X-Munim-Replayed")).toBe("true");
    expect(((await again.json()) as any).guest_access_token).toBeNull();
    expect(Number((await db.admin(`SELECT count(*) AS n FROM core."order" WHERE id = $1`, [b.order_id])).rows[0]!.n)).toBe(1);
  });

  it("signed-in and guest blocks must match the caller: a guest block with a token, or no guest block anonymously, is 400", async () => {
    expect((await call("POST", "/v1/storefront/orders", placeBody({}, { guest: false }).body)).status).toBe(400);
    expect((await call("POST", "/v1/storefront/orders", placeBody().body, bearer("sub-x"))).status).toBe(400);
  });
});

describe("refusals: each code, paired with an accept", () => {
  it("window_full → 409 window_full; a window with room is accepted", async () => {
    const full = await place({ pickup_window_id: win.full, promised_at: ist(D1, "13:30") });
    expect(full.res.status).toBe(409);
    expect(reason(full.body)).toBe("window_full");
    expect((await place({ pickup_window_id: win.w1300 })).res.status).toBe(201);
  });

  it("outlet_paused (live toggle) → outlet_paused; calendar closed (after hours, and a dated holiday) → outlet_paused; open → accepted", async () => {
    const set = (s: string) => db.withContext("munim_core", cmdCtx("tenancy.outlet.create.v1"), (c) => c.query(`UPDATE core.outlet SET accepting_orders = $2 WHERE id = $1`, [OUT, s]));
    await set("paused");
    expect(reason((await place()).body)).toBe("outlet_paused");
    await set("open");
    clockNow = new Date(ist(D2, "23:00")); // after D2's 22:00 close
    expect(reason((await place({ pickup_window_id: null })).body)).toBe("outlet_paused");
    clockNow = AT_1300;
    expect(reason((await place({ pickup_window_id: null, promised_at: P_HOLIDAY })).body)).toBe("outlet_paused"); // D5 override: closed
    expect((await place()).res.status).toBe(201);
  });

  it("item_sold_out → item_sold_out; an available item is accepted", async () => {
    await db.withContext("munim_core", cmdCtx("catalogue.availability.set.v1"), (c) =>
      c.query(`INSERT INTO core.item_availability (tenant_id, id, outlet_id, item_id, available, updated_by) VALUES ($1, $2, $3, $4, false, $5)`, [W.tenant, uuidv7(), OUT, ITEM2, W.owner]));
    expect(reason((await place({}, { item: ITEM2 })).body)).toBe("item_sold_out");
    expect((await place()).res.status).toBe(201);
    await db.admin(`DELETE FROM core.item_availability WHERE item_id = $1`, [ITEM2]);
  });

  it("coupons presented reach the pricing: expired → coupon_expired, unknown → coupon_invalid, spent cap → coupon_cap_reached, below minimum → coupon_min_spend; WELCOME10 accepted (27216)", async () => {
    expect(reason((await place({ coupon_codes: ["EXPIRED1"] })).body)).toBe("coupon_expired");
    expect(reason((await place({ coupon_codes: ["NOSUCH1"] })).body)).toBe("coupon_invalid");
    expect(reason((await place({ coupon_codes: ["CAPPED1"] })).body)).toBe("coupon_cap_reached");
    expect(reason((await place({ coupon_codes: ["TENSPEND"] })).body)).toBe("coupon_min_spend");
    const ok = await place({ coupon_codes: ["WELCOME10"] });
    expect(ok.res.status).toBe(201);
    expect(ok.body.total_minor).toBe(27216);
    expect(Number((await db.admin(`SELECT count(*) AS n FROM core.coupon_use WHERE order_id = $1`, [ok.id])).rows[0]!.n)).toBe(1);
  });

  it("preview: same price, labelled preview, writes nothing, and carries the storefront's own refusals", async () => {
    const before = Number((await db.admin(`SELECT count(*) AS n FROM core."order" WHERE tenant_id = $1`, [W.tenant])).rows[0]!.n);
    // G-12: the promise lies inside the (full) window it names; 13:30 is still in the 12:00–15:00 deal window.
    const req = { outlet_id: OUT, channel_id: W.channel, brand_id: null, kind: "pickup", pickup_window_id: win.full, promised_at: ist(D1, "13:30"), coupon_codes: [], loyalty_redeem_points: 0,
      lines: [{ item_id: W.item, variant_id: VARIANT, option_ids: [], qty_milli: 1000, barcode: null }] };
    const r = StorefrontPreviewResponse.parse(await (await call("POST", "/v1/storefront/orders:preview", req)).json());
    expect(r).toMatchObject({ label: "preview", total_minor: 30240, tax_minor: 1440, discount_minor: 3200 });
    expect(r.refusals).toEqual([{ line_no: null, reason_code: "window_full" }]);
    expect(Number((await db.admin(`SELECT count(*) AS n FROM core."order" WHERE tenant_id = $1`, [W.tenant])).rows[0]!.n)).toBe(before);
  });
});

describe("guest isolation and the tracker read", () => {
  it("a guest reads only their own order; another guest's order, no token, a made-up token and another tenant's order are all 404", async () => {
    const a = await place();
    const b = await place();
    const own = await call("GET", `/v1/storefront/orders/${a.id}`, undefined, { [GUEST_TOKEN_HEADER]: a.body.guest_access_token });
    expect(own.status).toBe(200);
    StorefrontOrderPlaced.parse(a.body);
    const view = StorefrontOrderView.parse(await own.json());
    expect(view).toMatchObject({ order_id: a.id, status: "placed", total_minor: 30240, pay_at_counter: true, cancel_window_min: 5, reschedule_window_min: 30 });
    expect(view.lines).toHaveLength(1);
    expect(view.events[0]).toMatchObject({ kind: "status", to_status: "placed" });
    expect(JSON.stringify(view)).not.toMatch(/guest_access|customer_id|phone/);
    expect((await call("GET", `/v1/storefront/orders/${b.id}`, undefined, { [GUEST_TOKEN_HEADER]: a.body.guest_access_token })).status).toBe(404);
    expect((await call("GET", `/v1/storefront/orders/${a.id}`)).status).toBe(404);
    expect((await call("GET", `/v1/storefront/orders/${a.id}`, undefined, { [GUEST_TOKEN_HEADER]: "x".repeat(43) })).status).toBe(404);
    expect((await call("GET", `/v1/storefront/orders/${a.id}`, undefined, { [GUEST_TOKEN_HEADER]: a.body.guest_access_token }, other.storefrontKey)).status).toBe(404);
  });

  it("R3-M1: the tracker lists an order's events in their sequence, also when two land in one transaction with ids out of order", async () => {
    const a = await place();
    // Two hops in ONE transaction (as the kitchen's multi-hop advance writes them): same `at`; the first-written
    // event gets the larger id, so (at, id) would list them backwards.
    await db.withContext("munim_core", cmdCtx("kitchen.ticket.advance.v1"), async (c) => {
      const ev = `INSERT INTO core.order_event (tenant_id, id, outlet_id, order_id, kind, from_status, to_status, actor) VALUES ($1, $2, $3, $4, 'status', $5, $6, $7)`;
      const actor = JSON.stringify({ kind: "member", id: W.owner });
      await c.query(ev, [W.tenant, "01a1ffff-ffff-7fff-bfff-ffffffffffff", OUT, a.id, "placed", "accepted", actor]);
      await c.query(ev, [W.tenant, "01a10000-0000-7000-8000-000000000000", OUT, a.id, "accepted", "preparing", actor]);
    });
    const view = StorefrontOrderView.parse(await (await call("GET", `/v1/storefront/orders/${a.id}`, undefined, { [GUEST_TOKEN_HEADER]: a.body.guest_access_token })).json());
    expect(view.events.map((e) => e.to_status)).toEqual(["placed", "accepted", "preparing"]);
  });

  it("W2-R2: a guest cannot cancel or reschedule — 403 guest_cannot_change (\"Call the outlet to change this order\"), the order is untouched", async () => {
    const a = await place();
    const cancel = { command_id: uuidv7(), idempotency_key: `cx-${a.id}`, type: "storefront.order.cancel.v1", payload: { order_id: a.id, reason: null } };
    const r = await call("POST", `/v1/storefront/orders/${a.id}:cancel`, cancel, { [GUEST_TOKEN_HEADER]: a.body.guest_access_token });
    const rb = (await r.json()) as any;
    expect([r.status, rb.error.reason_code, rb.error.message]).toEqual([403, "guest_cannot_change", "Call the outlet to change this order"]);
    const rs = await call("POST", `/v1/storefront/orders/${a.id}:reschedule-preview`, { pickup_window_id: win.w1600, promised_at: P_1600 }, { [GUEST_TOKEN_HEADER]: a.body.guest_access_token });
    expect([rs.status, reason((await rs.json()) as any)]).toEqual([403, "guest_cannot_change"]);
    expect((await orderRow(a.id)).status).toBe("placed");
  });
});

describe("signed-in checkout, cancel, reschedule", () => {
  const SUB = "shopper-sub-1";
  let mine: string;

  it("first sign-in checkout creates the profile through ensureProfile; no guest token; the order is theirs alone", async () => {
    const r = await place({}, { guest: false }, bearer(SUB));
    expect(r.res.status).toBe(201);
    expect(r.body.guest_access_token).toBeNull();
    mine = r.id;
    const row = await orderRow(mine);
    const cust = (await db.admin(`SELECT idp_sub, is_guest FROM core.customer WHERE id = $1`, [row.customer_id])).rows[0]!;
    expect(cust).toEqual({ idp_sub: SUB, is_guest: false });
    expect((await call("GET", `/v1/storefront/orders/${mine}`, undefined, bearer(SUB))).status).toBe(200);
    // someone else signed in cannot see it, nor can an anonymous caller
    expect((await call("GET", `/v1/storefront/orders/${mine}`, undefined, bearer("shopper-sub-2"))).status).toBe(404);
    expect((await call("GET", `/v1/storefront/orders/${mine}`)).status).toBe(404);
  });

  const cancelCmd = (id: string) => ({ command_id: uuidv7(), idempotency_key: `cancel-${id}-${uuidv7()}`, type: "storefront.order.cancel.v1", payload: { order_id: id, reason: null } });

  it("cancel: after the 5-minute window → change_window_closed and nothing changes; inside it → cancelled, window released, loyalty reversal called, event written", async () => {
    const r = await place({ pickup_window_id: win.w1600, promised_at: P_1600 }, { guest: false }, bearer(SUB));
    const id = r.id;
    const bookedBefore = (await db.admin(`SELECT booked FROM core.pickup_window WHERE id = $1`, [win.w1600])).rows[0]!.booked;
    clockNow = await afterCreated(id, 6);
    const late = await call("POST", `/v1/storefront/orders/${id}:cancel`, cancelCmd(id), bearer(SUB));
    expect(late.status).toBe(409);
    expect(reason((await late.json()) as any)).toBe("change_window_closed");
    expect((await orderRow(id)).status).toBe("placed");
    clockNow = await afterCreated(id, 4);
    const ok = await call("POST", `/v1/storefront/orders/${id}:cancel`, cancelCmd(id), bearer(SUB));
    expect(ok.status).toBe(200);
    expect((await orderRow(id)).status).toBe("cancelled");
    expect((await db.admin(`SELECT booked FROM core.pickup_window WHERE id = $1`, [win.w1600])).rows[0]!.booked).toBe(bookedBefore - 1);
    // orders.advanceOrder made the move: the order_event is paired with its outbox event (#80).
    const paired = (await db.admin(`SELECT payload->'data'->>'from_status' AS f, payload->'data'->>'to_status' AS t FROM core.outbox
                                     WHERE aggregateid = $1 AND type = 'munim.orders.order.status_changed.v1'`, [id])).rows;
    expect(paired).toEqual([{ f: "placed", t: "cancelled" }]);
    const ev = await db.admin(`SELECT from_status, to_status, actor FROM core.order_event WHERE order_id = $1 AND to_status = 'cancelled'`, [id]);
    expect(ev.rows).toHaveLength(1);
    // another customer cannot cancel it
    expect((await call("POST", `/v1/storefront/orders/${id}:cancel`, cancelCmd(id), bearer("shopper-sub-2"))).status).toBe(404);
  });

  it("reschedule keeps the order's options (order_line.options are option ids): 13:00 + hot 31186 → 16:00 34650", async () => {
    // Hand: unit 32000 + hot 1000 = 33000. 13:00: deal 3300 → 29700, tax 742.5 → 743 × 2 = 1486, total 31186.
    // 16:00: no deal, tax 825 × 2 = 1650, total 34650 (without the option it would be 33600).
    const hot = (await db.admin(`SELECT id FROM core.option WHERE tenant_id = $1 AND name_key = 'menu.spice.hot'`, [W.tenant])).rows[0]!.id as string;
    const b = placeBody({ pickup_window_id: win.w1300, promised_at: P_1300 }, { guest: false });
    (b.body.order.payload.lines[0] as { option_ids: string[] }).option_ids = [hot];
    const res = await call("POST", "/v1/storefront/orders", b.body, bearer(SUB));
    expect([res.status, ((await res.json()) as any).total_minor]).toEqual([201, 31186]);
    clockNow = await afterCreated(b.order_id, 2);
    const pv = StorefrontReschedulePreviewResponse.parse(await (await call("POST", `/v1/storefront/orders/${b.order_id}:reschedule-preview`, { pickup_window_id: win.w1600, promised_at: P_1600 }, bearer(SUB))).json());
    expect([pv.current_total_minor, pv.preview.total_minor]).toEqual([31186, 34650]);
  });

  it("reschedule re-prices a time-boxed deal: 13:00 (deal) → 16:00 costs 33600; a stale total is refused deal_rejudged; the confirmed total commits", async () => {
    const r = await place({ pickup_window_id: win.w1300, promised_at: P_1300 }, { guest: false }, bearer(SUB));
    const id = r.id;
    expect(r.body.total_minor).toBe(30240);
    clockNow = await afterCreated(id, 2);
    const pv = (await (await call("POST", `/v1/storefront/orders/${id}:reschedule-preview`, { pickup_window_id: win.w1600, promised_at: P_1600 }, bearer(SUB))).json()) as any;
    expect(pv.current_total_minor).toBe(30240);
    expect(pv.preview).toMatchObject({ total_minor: 33600, discount_minor: 0, tax_minor: 1600, refusals: [] });
    expect((await orderRow(id)).total_minor).toBe("30240"); // preview wrote nothing
    const body = (total: number) => ({ command_id: uuidv7(), idempotency_key: `rs-${id}-${uuidv7()}`, type: "storefront.order.reschedule.v1",
      payload: { order_id: id, pickup_window_id: win.w1600, promised_at: P_1600, preview_total_minor: total } });
    const stale = await call("POST", `/v1/storefront/orders/${id}:reschedule`, body(30240), bearer(SUB));
    expect(stale.status).toBe(409);
    const staleBody = (await stale.json()) as any;
    expect(reason(staleBody)).toBe("deal_rejudged");
    // G-11: the total the person saw and core's re-priced total (hand values above).
    expect(staleBody.params).toEqual({ old_total_minor: 30240, new_total_minor: 33600, currency: "INR" });
    expect((await orderRow(id)).total_minor).toBe("30240");
    const ok = await call("POST", `/v1/storefront/orders/${id}:reschedule`, body(33600), bearer(SUB));
    expect(ok.status).toBe(200);
    const row = await orderRow(id);
    expect([row.subtotal_minor, row.discount_minor, row.tax_minor, row.total_minor]).toEqual(["32000", "0", "1600", "33600"]);
    // The line follows the header (0015 A8): unit 32000, no discount, tax 1600.
    const line = (await db.admin(`SELECT unit_price_minor::int AS u, line_discount_minor::int AS d, tax_minor::int AS t FROM core.order_line WHERE order_id = $1`, [id])).rows;
    expect(line).toEqual([{ u: 32000, d: 0, t: 1600 }]);
    // R2-S1-1: the snapshot is merged (placement's keys stay) and the re-price is recorded beside them; R2-S1-2:
    // the line's change is audited with before / after.
    expect(Object.keys(row.pricing_snapshot).sort()).toEqual(["coupons", "judged_at", "lines", "loyalty", "pack", "picks", "repriced"]);
    expect((await db.admin(`SELECT a.before, a.after FROM core.audit_log a JOIN core.order_line l ON l.id::text = a.entity_id WHERE l.order_id = $1 AND a.entity = 'core.order_line'`, [id])).rows)
      .toEqual([{ before: { unit_price_minor: 32000, line_discount_minor: 3200, tax_minor: 1440 }, after: { unit_price_minor: 32000, line_discount_minor: 0, tax_minor: 1600 } }]);
    expect(new Date(row.promised_at).toISOString()).toBe(P_1600);
    expect(row.pickup_window_id).toBe(win.w1600);
    const ev = (await db.admin(`SELECT to_promised_at, reason FROM core.order_event WHERE order_id = $1 AND kind = 'promised_at'`, [id])).rows;
    expect(ev).toHaveLength(1);
    expect(ev[0]!.reason).toBe("customer_rescheduled");
    // #80: the promised_at order_event is paired with its outbox event.
    const paired = (await db.admin(`SELECT payload->'data'->>'reason_code' AS r FROM core.outbox WHERE aggregateid = $1 AND type = 'munim.orders.order.promise_changed.v1'`, [id])).rows;
    expect(paired).toEqual([{ r: "customer_rescheduled" }]);
    // after the 30-minute reschedule window the same change is refused
    clockNow = await afterCreated(id, 31);
    const late = await call("POST", `/v1/storefront/orders/${id}:reschedule`, body(33600), bearer(SUB));
    expect(reason((await late.json()) as any)).toBe("change_window_closed");
  });
});
