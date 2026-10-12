// T-022 gates — preview and placement. Expected totals are HAND-WRITTEN below (IN pack: restaurant_5 = CGST 2.5% +
// SGST 2.5%, goods_18 = 9% + 9%, each component rounded half-up per line; prices exclusive), never computed by
// the code under test. Seams: the REAL owners' functions (R3-M3) — catalogue priceLines, inventory FEFO picks and
// consumption, kitchen tickets.
import { createHash } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { OrdersPreviewResponse } from "@munim/contracts/orders";
import { placeOrder } from "../src/modules/orders/place.ts";
import { type Env, placePayload, startEnv, uuidv7 } from "./orders.kit.ts";

let env: Env;
beforeAll(async () => {
  env = await startEnv("IN");
});
afterAll(async () => env?.stop());

type Cart = { name: string; lines: Array<[keyof Env["menu"], number, boolean?]>; coupons?: string[]; expect: [number, number, number, number] };
// [item, qty (units ×1000 = qty_milli), +chutney option] → expected [subtotal, discount, tax, total], by hand.
const CARTS: Cart[] = [
  { name: "1 coffee", lines: [["coffee", 1000]], expect: [4000, 0, 200, 4200] },
  { name: "2 coffee", lines: [["coffee", 2000]], expect: [8000, 0, 400, 8400] },
  { name: "1 dosa", lines: [["dosa", 1000]], expect: [12000, 0, 600, 12600] },
  { name: "1 dosa + chutney (337.5 → 338 per component)", lines: [["dosa", 1000, true]], expect: [13500, 0, 676, 14176] },
  { name: "3 dosa + chutney", lines: [["dosa", 3000, true]], expect: [40500, 0, 2026, 42526] },
  { name: "dosa + coffee", lines: [["dosa", 1000], ["coffee", 1000]], expect: [16000, 0, 800, 16800] },
  { name: "1 biscuits (goods 18%)", lines: [["biscuits", 1000]], expect: [2500, 0, 450, 2950] },
  { name: "4 biscuits", lines: [["biscuits", 4000]], expect: [10000, 0, 1800, 11800] },
  { name: "1 paneer tikka (world price)", lines: [["paneer", 1000]], expect: [32000, 0, 1600, 33600] },
  { name: "paneer + 2 biscuits (two classes)", lines: [["paneer", 1000], ["biscuits", 2000]], expect: [37000, 0, 2500, 39500] },
  { name: "coffee, SAVE10", lines: [["coffee", 1000]], coupons: ["SAVE10"], expect: [4000, 400, 180, 3780] },
  { name: "2 dosa + chutney, SAVE10 (607.5 → 608)", lines: [["dosa", 2000, true]], coupons: ["SAVE10"], expect: [27000, 2700, 1216, 25516] },
  { name: "dosa + coffee, SAVE10", lines: [["dosa", 1000], ["coffee", 1000]], coupons: ["SAVE10"], expect: [16000, 1600, 720, 15120] },
  { name: "2 dosa, FLAT50 (min spend 200)", lines: [["dosa", 2000]], coupons: ["FLAT50"], expect: [24000, 5000, 950, 19950] },
  { name: "paneer, FLAT50", lines: [["paneer", 1000]], coupons: ["FLAT50"], expect: [32000, 5000, 1350, 28350] },
  { name: "dosa + paneer, FLAT50 allocated 1364 / 3636", lines: [["dosa", 1000], ["paneer", 1000]], coupons: ["FLAT50"], expect: [44000, 5000, 1950, 40950] },
  { name: "1.5 coffee", lines: [["coffee", 1500]], expect: [6000, 0, 300, 6300] },
  { name: "0.25 biscuits (56.25 → 56)", lines: [["biscuits", 250]], expect: [625, 0, 112, 737] },
  { name: "3 coffee + biscuits, SAVE10 (202.5 → 203)", lines: [["coffee", 3000], ["biscuits", 1000]], coupons: ["SAVE10"], expect: [14500, 1450, 946, 13996] },
  { name: "2 dosa + chutney, coffee, biscuits", lines: [["dosa", 2000, true], ["coffee", 1000], ["biscuits", 1000]], expect: [33500, 0, 2000, 35500] },
];

const cartPayload = (cart: Cart, extra: Record<string, unknown> = {}) =>
  placePayload(env, cart.lines.map(([k, qty, opt]) => ({ item: env.menu[k] as string, qty, options: opt ? [env.menu.chutney] : [] })),
    { coupon_codes: cart.coupons ?? [], ...extra });

describe("placement: server pricing, client totals ignored", () => {
  it("20 carts with tampered client totals → stored totals equal the hand-written fixture", async () => {
    expect(CARTS).toHaveLength(20);
    const got: Array<[string, number[]]> = [];
    for (const cart of CARTS) {
      const p = cartPayload(cart, { client_totals: { subtotal: { amount_minor: 1, currency: "INR" }, total: { amount_minor: 1, currency: "INR" } } });
      const r = await env.cmd("/v1/orders", "staff", "orders.place.v1", p);
      expect(r.status, cart.name).toBe(201);
      const o = await env.one<Record<string, string>>(`SELECT subtotal_minor, discount_minor, tax_minor, total_minor, client_totals FROM core."order" WHERE id = $1`, [p.order_id]);
      expect((o.client_totals as any).total.amount_minor).toBe(1);
      got.push([cart.name, [Number(o.subtotal_minor), Number(o.discount_minor), Number(o.tax_minor), Number(o.total_minor)]]);
    }
    expect(got).toEqual(CARTS.map((c) => [c.name, c.expect]));
  });

  it("lines store core's per-unit price incl. options, the discount and tax; numbers come from the DB (ticket, invoice)", async () => {
    const p = cartPayload(CARTS[11]!);
    expect((await env.cmd("/v1/orders", "staff", "orders.place.v1", p)).status).toBe(201);
    const l = await env.one<Record<string, string>>(`SELECT unit_price_minor, line_discount_minor, tax_minor FROM core.order_line WHERE order_id = $1`, [p.order_id]);
    expect([Number(l.unit_price_minor), Number(l.line_discount_minor), Number(l.tax_minor)]).toEqual([13500, 2700, 1216]);
    const o = await env.one<Record<string, string>>(`SELECT ticket_no, invoice_no FROM core."order" WHERE id = $1`, [p.order_id]);
    expect(Number(o.ticket_no)).toBeGreaterThan(0);
    expect(Number(o.invoice_no)).toBeGreaterThan(0);
  });

  it("refusals: price above the item MRP; sold batch's MRP binds (#61); only-expired stock (C7, pack flag off); coupon min spend", async () => {
    // chips: price 2500 + 18% = 2950 ≤ item MRP 5000, but the picked batch's MRP is 2900 → refused.
    const chips = await env.cmd("/v1/orders", "staff", "orders.place.v1", placePayload(env, [{ item: env.menu.chips }]));
    expect([chips.status, (await chips.json()).error.reason_code]).toEqual([409, "price_above_mrp"]);
    const juice = await env.cmd("/v1/orders", "staff", "orders.place.v1", placePayload(env, [{ item: env.menu.juice }]));
    expect([juice.status, (await juice.json()).error.reason_code]).toEqual([409, "expired_batch"]);
    const min = await env.cmd("/v1/orders", "staff", "orders.place.v1", placePayload(env, [{ item: env.menu.coffee }], { coupon_codes: ["FLAT50"] }));
    expect([min.status, (await min.json()).error.reason_code]).toEqual([409, "coupon_min_spend"]);
    // accept: biscuits (batch MRP 3000 ≥ 2950).
    expect((await env.cmd("/v1/orders", "staff", "orders.place.v1", placePayload(env, [{ item: env.menu.biscuits }]))).status).toBe(201);
  });

  it("exclusive tax on a deal plus a coupon (R3-M3): thali 20000, deal 20% → 16000, SAVE10 → 14400, tax 360 + 360 → 15120", async () => {
    await env.db.withContext("munim_core", { tenant_id: env.w.tenant, outlet_ids: "*", role: "owner", member_id: env.w.owner, command_type: "catalogue.deal.upsert.v1" }, (c) =>
      c.query(`INSERT INTO core.deal (tenant_id, id, kind, name_key, rule, windows, valid_from) VALUES ($1, $2, 'percent_off', 'deal.thali_any_time', $3, '[]', '2026-01-01')`,
        [env.w.tenant, uuidv7(), { kind: "percent_off", bp: 2000, item_ids: [env.menu.thali] }]));
    const p = placePayload(env, [{ item: env.menu.thali }], { coupon_codes: ["SAVE10"] });
    expect((await env.cmd("/v1/orders", "staff", "orders.place.v1", p)).status).toBe(201);
    const o = await env.one<Record<string, string>>(`SELECT subtotal_minor, discount_minor, tax_minor, total_minor FROM core."order" WHERE id = $1`, [p.order_id]);
    expect([o.subtotal_minor, o.discount_minor, o.tax_minor, o.total_minor].map(Number)).toEqual([20000, 5600, 720, 15120]);
    expect(await env.rows(`SELECT discount_minor::int AS d FROM core.coupon_use WHERE order_id = $1`, [p.order_id])).toEqual([{ d: 1600 }]);
  });

  it("a coupon's global cap holds: CAP1 (cap 1) → first 201, second 409 coupon_cap_reached", async () => {
    const a = await env.cmd("/v1/orders", "staff", "orders.place.v1", placePayload(env, [{ item: env.menu.coffee }], { coupon_codes: ["CAP1"] }));
    const b = await env.cmd("/v1/orders", "staff", "orders.place.v1", placePayload(env, [{ item: env.menu.coffee }], { coupon_codes: ["CAP1"] }));
    expect([a.status, b.status, (await b.json()).error.reason_code]).toEqual([201, 409, "coupon_cap_reached"]);
    expect(Number((await env.one<{ n: string }>(`SELECT count(*) AS n FROM core.coupon_use WHERE coupon_id = $1`, [env.menu.cap1])).n)).toBe(1);
  });

  it("authority: an outlet-2 manager cannot place in outlet 1 (403); staff of outlet 1 can (201)", async () => {
    const r = await env.cmd("/v1/orders", "mgr2", "orders.place.v1", placePayload(env, [{ item: env.menu.coffee }]));
    expect([r.status, (await r.json()).error.reason_code]).toEqual([403, "authority_denied"]);
    expect((await env.cmd("/v1/orders", "staff", "orders.place.v1", placePayload(env, [{ item: env.menu.coffee }]))).status).toBe(201);
  });

  it("table QR order: dine_in with a table ref on the table_qr channel → 201; without a table ref → 422", async () => {
    const ok = placePayload(env, [{ item: env.menu.dosa }], { channel_id: env.menu.tableChannel, device_id: null, kind: "dine_in", table_ref: "T4" });
    expect((await env.cmd("/v1/orders", "staff", "orders.place.v1", ok)).status).toBe(201);
    expect((await env.one<{ table_ref: string }>(`SELECT table_ref FROM core."order" WHERE id = $1`, [ok.order_id])).table_ref).toBe("T4");
    const bad = placePayload(env, [{ item: env.menu.dosa }], { channel_id: env.menu.tableChannel, device_id: null, kind: "dine_in", table_ref: null });
    expect((await env.cmd("/v1/orders", "staff", "orders.place.v1", bad)).status).toBe(422);
  });

  it("#80: every order_event of a placement is paired with an outbox event of that order", async () => {
    const p = cartPayload(CARTS[5]!);
    await env.cmd("/v1/orders", "staff", "orders.place.v1", p);
    const ev = await env.one<{ n: string }>(`SELECT count(*) AS n FROM core.order_event WHERE order_id = $1`, [p.order_id]);
    const ob = await env.one<{ n: string }>(`SELECT count(*) AS n FROM core.outbox WHERE aggregateid = $1 AND type LIKE 'munim.orders.order.%'`, [p.order_id]);
    expect([Number(ev.n), Number(ob.n)]).toEqual([1, 1]);
    const data = await env.one<{ d: any }>(`SELECT payload -> 'data' AS d FROM core.outbox WHERE aggregateid = $1`, [p.order_id]);
    expect(data.d.outlet_id).toBe(env.w.outlets[0]);
  });
});

describe("preview (R40 C1)", () => {
  const counts = async () => {
    const tables = await env.rows<{ t: string }>(
      `SELECT format('%I.%I', n.nspname, c.relname) AS t FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE c.relkind IN ('r', 'p') AND n.nspname IN ('core', 'evidence', 'intel') ORDER BY 1`);
    const out: Record<string, number> = {};
    for (const { t } of tables) out[t] = Number((await env.one<{ n: string }>(`SELECT count(*) AS n FROM ${t}`)).n);
    const k = await env.one<Record<string, string>>(
      `SELECT (SELECT coalesce(sum(last_no), 0) FROM core.ticket_counter) AS tickets, (SELECT coalesce(sum(last_no), 0) FROM core.invoice_counter) AS invoices,
              (SELECT coalesce(sum(booked), 0) FROM core.pickup_window) AS booked`);
    return { tables: out, counters: { tickets: Number(k.tickets), invoices: Number(k.invoices), booked: Number(k.booked) } };
  };
  const previewReq = () => ({
    outlet_id: env.w.outlets[0], channel_id: env.menu.pickupChannel, brand_id: null, kind: "pickup", pickup_window_id: env.menu.window, promised_at: null,
    coupon_codes: ["SAVE10"], loyalty_redeem_points: 0,
    lines: [{ item_id: env.menu.dosa, variant_id: null, option_ids: [env.menu.chutney], qty_milli: 2000, barcode: null }],
  });

  it("writes 0 rows in every core/evidence/intel table and moves no counter; placing the same cart does write (control)", async () => {
    const before = await counts();
    expect(Object.keys(before.tables).length).toBeGreaterThan(100);
    const r = await env.call("POST", "/v1/orders:preview", "staff", previewReq());
    expect(r.status).toBe(200);
    const body = OrdersPreviewResponse.parse(await r.json());
    // Hand-written: 2 × (12000 + 1500) = 27000; SAVE10 2700; tax 2 × round(24300 × 2.5%) = 2 × 608.
    expect([body.label, body.subtotal_minor, body.discount_minor, body.tax_minor, body.total_minor]).toEqual(["preview", 27000, 2700, 1216, 25516]);
    expect(body.lines[0]!.price_ref).toMatch(/^⟨cite:row:core\.price:/);
    expect(body.lines[0]!.option_refs).toEqual([`⟨cite:row:core.option:${env.menu.chutney}⟩`]);
    expect(body.lines[0]!.coupon_refs).toEqual([`⟨cite:row:core.coupon:${env.menu.save10}⟩`]);
    expect(body.tax_rule).toEqual({ pack_code: "IN", pack_version: 4 });
    expect(await counts()).toEqual(before);

    const place = { ...placePayload(env, [], {}), ...previewReq(), device_id: null, table_ref: null, external_ref: null, client_totals: null, preview_total_minor: 25516,
      lines: previewReq().lines.map((l) => ({ ...l, line_id: uuidv7(), note: null })) };
    const pr = await env.cmd("/v1/orders", "staff", "orders.place.v1", place);
    expect(pr.status).toBe(201);
    const after = await counts();
    expect([after.tables[`core."order"`]! - before.tables[`core."order"`]!, after.counters.booked - before.counters.booked]).toEqual([1, 1]);
  });

  it("placement refuses a preview total that no longer holds (preview_total_changed) and writes nothing", async () => {
    const p = cartPayload(CARTS[0]!, { preview_total_minor: 4199 });
    const r = await env.cmd("/v1/orders", "staff", "orders.place.v1", p);
    expect([r.status, (await r.json()).error.reason_code]).toEqual([409, "preview_total_changed"]);
    expect(Number((await env.one<{ n: string }>(`SELECT count(*) AS n FROM core."order" WHERE id = $1`, [p.order_id])).n)).toBe(0);
    expect((await env.cmd("/v1/orders", "staff", "orders.place.v1", { ...p, preview_total_minor: 4200 })).status).toBe(201);
  });

  it("lists refusals instead of failing (FLAT50 on one coffee → coupon_min_spend), still writing nothing", async () => {
    const before = await counts();
    const r = await env.call("POST", "/v1/orders:preview", "staff", { ...previewReq(), channel_id: env.w.channel, pickup_window_id: null, kind: "takeaway",
      coupon_codes: ["FLAT50"], lines: [{ item_id: env.menu.coffee, variant_id: null, option_ids: [], qty_milli: 1000, barcode: null }] });
    expect(r.status).toBe(200);
    expect((await r.json()).refusals).toEqual([{ line_no: null, reason_code: "coupon_min_spend" }]);
    expect(await counts()).toEqual(before);
  });
});

describe("pickup-window capacity under the row lock", () => {
  it("11 concurrent pickup orders against capacity 10 → exactly 10 placed, 1 window_full, booked = 10", async () => {
    const before = Number((await env.one<{ b: string }>(`SELECT booked AS b FROM core.pickup_window WHERE id = $1`, [env.menu.window])).b);
    const window = uuidv7();
    await env.db.withContext("munim_core", { tenant_id: env.w.tenant, outlet_ids: "*", role: "owner", member_id: env.w.owner }, (c) =>
      c.query(`INSERT INTO core.pickup_window (tenant_id, id, outlet_id, starts_at, ends_at, capacity_orders) VALUES ($1, $2, $3, now() + interval '5 hours', now() + interval '315 minutes', 10)`,
        [env.w.tenant, window, env.w.outlets[0]]));
    void before;
    const res = await Promise.all(Array.from({ length: 11 }, () =>
      env.cmd("/v1/orders", "staff", "orders.place.v1",
        placePayload(env, [{ item: env.menu.coffee }], { channel_id: env.menu.pickupChannel, device_id: null, kind: "pickup", pickup_window_id: window }))));
    const statuses = res.map((r) => r.status).sort();
    const refused = await Promise.all(res.filter((r) => r.status === 409).map(async (r) => (await r.json()).error.reason_code));
    expect({ placed: statuses.filter((s) => s === 201).length, refused }).toEqual({ placed: 10, refused: ["window_full"] });
    const w = await env.one<{ booked: number; n: string }>(
      `SELECT booked, (SELECT count(*) FROM core."order" WHERE pickup_window_id = $1) AS n FROM core.pickup_window WHERE id = $1`, [window]);
    expect([w.booked, Number(w.n)]).toEqual([10, 10]);
  });
});

describe("R3-M2: seams fail closed", () => {
  it("an owner's export that cannot be resolved refuses the sale with 503 unavailable and writes nothing (no stand-in)", async () => {
    // The process-wide resolution cache (orders/seams.ts): null = the owner's module or export was not found.
    const state = (globalThis as Record<symbol, { real: Map<string, unknown> }>)[Symbol.for("munim.orders.seams")]!;
    const real = state.real.get("priceLines");
    state.real.set("priceLines", null);
    try {
      const p = placePayload(env, [{ item: env.menu.coffee }]);
      const r = await env.cmd("/v1/orders", "staff", "orders.place.v1", p);
      expect([r.status, (await r.json()).error.code]).toEqual([503, "unavailable"]);
      expect(Number((await env.one<{ n: string }>(`SELECT count(*) AS n FROM core."order" WHERE id = $1`, [p.order_id])).n)).toBe(0);
    } finally {
      if (real === undefined) state.real.delete("priceLines");
      else state.real.set("priceLines", real);
    }
    expect((await env.cmd("/v1/orders", "staff", "orders.place.v1", placePayload(env, [{ item: env.menu.coffee }]))).status).toBe(201);
  });
});

describe("guest checkout token", () => {
  it("a guest gets a one-time access token: only its sha256 is stored, nowhere raw, and a replay returns none", async () => {
    const customer = uuidv7();
    await env.db.withContext("munim_core", { tenant_id: env.w.tenant, outlet_ids: "*", role: "owner", member_id: env.w.owner, command_type: "customers.customer.upsert.v1" }, (c) =>
      c.query(`INSERT INTO core.customer (tenant_id, id, name, phone) VALUES ($1, $2, 'Guest Shopper', '+919800000001')`, [env.w.tenant, customer]));
    const principal = { kind: "customer" as const, tenant_id: env.w.tenant, channel_id: env.menu.pickupChannel, customer_id: customer, profile: true, sub: null };
    const payload = placePayload(env, [{ item: env.menu.dosa }], { channel_id: env.menu.pickupChannel, device_id: null, kind: "pickup", pickup_window_id: env.menu.window });
    const command = { command_id: uuidv7(), idempotency_key: `k-${uuidv7()}`, type: "orders.place.v1", payload };
    const deps = { pools: env.pools, log: () => {} };
    const first = await placeOrder({ deps, principal }, command);
    expect(first.out.replayed).toBe(false);
    const token = first.guest_access_token!;
    expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    const hash = createHash("sha256").update(token, "utf8").digest("hex");
    const row = await env.one<{ h: string; customer_id: string }>(`SELECT encode(guest_access_hash, 'hex') AS h, customer_id FROM core."order" WHERE id = $1`, [payload.order_id]);
    expect(row).toEqual({ h: hash, customer_id: customer });

    // Scan every text / json / bytea column of core, evidence, intel and platform for the raw token and (control) for its hash.
    const cols = await env.rows<{ t: string; c: string }>(
      `SELECT format('%I.%I', table_schema, table_name) AS t, quote_ident(column_name) AS c FROM information_schema.columns
        WHERE table_schema IN ('core', 'evidence', 'intel', 'platform') AND data_type IN ('text', 'jsonb', 'json', 'bytea', 'character varying', 'ARRAY')`);
    const hits = async (needle: string) => {
      let n = 0;
      for (const { t, c } of cols) n += Number((await env.one<{ n: string }>(`SELECT count(*) AS n FROM ${t} WHERE ${c}::text LIKE '%' || $1 || '%'`, [needle])).n);
      return n;
    };
    expect(cols.length).toBeGreaterThan(200);
    expect(await hits(token)).toBe(0);
    expect(await hits(hash)).toBeGreaterThanOrEqual(1);

    const again = await placeOrder({ deps, principal }, command);
    expect([again.out.replayed, again.guest_access_token, again.out.body]).toEqual([true, null, first.out.body]);
    // A signed-in customer gets no token.
    const signedIn = await placeOrder({ deps, principal: { ...principal, sub: "cust-sub" } },
      { ...command, command_id: uuidv7(), idempotency_key: `k-${uuidv7()}`, payload: { ...payload, order_id: uuidv7(), lines: payload.lines.map((l) => ({ ...l, line_id: uuidv7() })) } });
    expect(signedIn.guest_access_token).toBeNull();
  });

  it("T-032 path: a hash passed by the storefront is stored as given and no token is minted here; a malformed hash → 422", async () => {
    const principal = { kind: "customer" as const, tenant_id: env.w.tenant, channel_id: env.menu.pickupChannel, customer_id: env.w.customer, profile: true, sub: null };
    const hash = createHash("sha256").update(`storefront-issued-${uuidv7()}`, "utf8").digest("hex");
    const payload = placePayload(env, [{ item: env.menu.coffee }], { channel_id: env.menu.pickupChannel, device_id: null, kind: "pickup" });
    const cmd = { command_id: uuidv7(), idempotency_key: `k-${uuidv7()}`, type: "orders.place.v1", payload };
    const deps = { pools: env.pools, log: () => {} };
    await expect(placeOrder({ deps, principal }, cmd, { guest_access_hash: "nothex" })).rejects.toMatchObject({ code: "invalid_payload" });
    const r = await placeOrder({ deps, principal }, cmd, { guest_access_hash: hash });
    expect(r.guest_access_token).toBeNull();
    expect((await env.one<{ h: string }>(`SELECT encode(guest_access_hash, 'hex') AS h FROM core."order" WHERE id = $1`, [payload.order_id])).h).toBe(hash);
  });
});
