// T-099 storefront API completeness (docs/kit/gaps.md G-01…G-04, G-11, G-12, G-13) through the real app on the real seams.
// Expected values are hand-computed from the pack tables (packages/contracts/packs/*.json, typed here by hand), never read
// from the code under test:
//   IN (restaurant_5, exclusive: CGST 2.5% + SGST 2.5%, each rounded per line): 1 × 32000 → CGST 800 + SGST 800 = 1600,
//      total 33600, rate 500.
//   AU (gst_10, inclusive: GST = round(480 × 1000 / 11000) = round(43.64) = 44): 1 × 480 → GST 44, total 480, rate 1000.
//   TENSPEND (min spend 100000) on a 32000 cart (no deal): shortfall 68000.
// Gates: G-01 round trip (catalogue command → DB 0 → 1 → storefront menu, a `<script>` name is just a JSON string and the
// contract types it as plain string); G-02 channel / brands; G-03 tax fields IN + AU (preview, place, order view);
// G-04 phone + the pack's on-receipt tax ids; G-11 coupon_min_spend params (preview and place); G-12 a promise outside its
// window → 422 pickup_time_outside_window, inside → 201; G-13 methods null while the pack lists none.
// Fix cycle W1: 2-A a placed order's key replays the stored result before any refusal (capacity-1 window, paused outlet, item
// off sale) and another body under it stays 409 idempotency_conflict; an order whose pack version is missing or unparseable
// shows null rates and prices_include_tax (cannot verify); the preview reads one snapshot (a price committed between its two
// readings → 200 with the first, not 500). Red-proof: test/redproof-t099.sh.
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { createLogger } from "@munim/config";
import { CommandResult } from "@munim/contracts";
import { buildWorld, ownerCtx, type TestDb, uuidv7, type World } from "@munim/db";
import {
  StorefrontMenuItem, StorefrontMenuResponse, StorefrontOrderPlaced, StorefrontOrderView, StorefrontOutletsResponse, StorefrontPreviewResponse,
} from "@munim/contracts/storefront";
import type { Hono } from "hono";
import type pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createLocalIdp } from "../src/auth/local-idp.ts";
import { type AppEnv, createApp, GUEST_TOKEN_HEADER, STOREFRONT_KEY_HEADER, storefrontResolver, TENANT_HEADER } from "../src/app.ts";
import { previewIn } from "../src/modules/orders/index.ts";
import { configureStorefront, resetStorefront } from "../src/modules/storefront/index.ts";
import { openDb } from "./db.ts";
import { buildTenant, type Tenant } from "./world.ts";

const idp = createLocalIdp();
// G-13 expected values: the pack documents themselves (the hand-kept source the DB is seeded from), not the code under test.
// The pack file's own list (G-13; null only for a pack that lists none, as v1–v3 did).
const packMethods = (code: "IN" | "AU"): string[] | null =>
  (JSON.parse(readFileSync(fileURLToPath(new URL(`../../../packages/contracts/packs/${code}.json`, import.meta.url)), "utf8")) as { pay_at_counter_methods?: string[] }).pay_at_counter_methods ?? null;
const SCRIPT = `<script>alert("x")</script> Paneer & "Tikka"`;
const DAY = 86_400_000;
const LATER = () => new Date(Date.now() + DAY + 2 * 3_600_000).toISOString(); // tomorrow: open all day, no deal anywhere

let db: TestDb;
let pools: { core: pg.Pool; svc: pg.Pool };
let app: Hono<AppEnv>;
let W: Tenant; // IN
let A: World; // AU
type Shop = { tenant: string; outlet: string; channel: string; key: string; item: string };
let IN: Shop;
let AU: Shop;
let win: { id: string; starts: string; ends: string };
const group = uuidv7();
const option = uuidv7();

/** A pickup channel with a storefront key, a price for `item` on it, every weekday open, and the world's always-on deal off. */
async function shop(w: World, item: string, amount: number, taxClass: string): Promise<Shop> {
  const s: Shop = { tenant: w.tenant, outlet: w.outlets[0], channel: uuidv7(), key: `sfk_T99_${uuidv7().replaceAll("-", "")}${uuidv7().replaceAll("-", "")}`, item };
  const ctx = (t: string) => ownerCtx(w, { command_type: t });
  await db.withContext("munim_core", ctx("tenancy.channel.create.v1"), (c) =>
    c.query(`INSERT INTO core.channel (tenant_id, id, name, kind) VALUES ($1, $2, 'Pickup', 'pickup')`, [w.tenant, s.channel]));
  await db.withContext("munim_core", ownerCtx(w), (c) =>
    c.query(`INSERT INTO core.storefront_key (tenant_id, id, channel_id, key_hash) VALUES ($1, $2, $3, $4)`, [w.tenant, uuidv7(), s.channel, createHash("sha256").update(s.key).digest("hex")]));
  await db.withContext("munim_core", ctx("catalogue.price.set.v1"), (c) =>
    c.query(`INSERT INTO core.price (tenant_id, id, item_id, outlet_id, channel_kind, amount_minor, currency, tax_class, valid_from) VALUES ($1, $2, $3, $4, 'pickup', $5, $6, $7, '2026-10-01')`,
      [w.tenant, uuidv7(), item, s.outlet, amount, w.currency, taxClass]));
  await db.withContext("munim_core", ctx("catalogue.deal.end.v1"), (c) => c.query(`UPDATE core.deal SET active = false WHERE name_key = 'deal.lunch'`));
  await db.withContext("munim_core", ctx("tenancy.outlet.create.v1"), async (c) => {
    for (const d of [0, 1, 2, 3, 4, 5, 6])
      await c.query(`INSERT INTO core.outlet_calendar (tenant_id, id, outlet_id, kind, weekday, opens_at, closes_at) VALUES ($1, $2, $3, 'weekly', $4, '00:00', '24:00')`, [w.tenant, uuidv7(), s.outlet, d]);
  });
  return s;
}

const member = (path: string, body: unknown, t: Tenant = W) =>
  app.request(path, { method: "POST", headers: { Authorization: `Bearer ${idp.sign({ sub: t.ownerSub })}`, [TENANT_HEADER]: t.tenant, "Content-Type": "application/json" }, body: JSON.stringify(body) });
const env = (type: string, payload: unknown) => ({ command_id: uuidv7(), idempotency_key: `k-${uuidv7()}`, type, payload });
const sf = (s: Shop, method: string, path: string, body?: unknown, extra: Record<string, string> = {}) =>
  app.request(path, { method, headers: { "Content-Type": "application/json", [STOREFRONT_KEY_HEADER]: s.key, ...extra }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
const cart = (s: Shop, over: Record<string, unknown> = {}) => ({
  outlet_id: s.outlet, channel_id: s.channel, brand_id: null, kind: "pickup", pickup_window_id: null, promised_at: LATER(), coupon_codes: [], loyalty_redeem_points: 0,
  lines: [{ item_id: s.item, variant_id: null, option_ids: [], qty_milli: 1000, barcode: null }], ...over,
});
const placeBody = (s: Shop, over: Record<string, unknown> = {}) => {
  const order_id = uuidv7();
  const { lines, ...rest } = cart(s, over);
  return {
    order_id,
    body: {
      order: env("orders.place.v1", { order_id, device_id: null, table_ref: null, external_ref: null, preview_total_minor: null, client_totals: null, ...rest,
        lines: lines.map((l) => ({ ...l, line_id: uuidv7(), note: null })) }),
      guest: env("storefront.guest.create.v1", { name: "T099 Guest", phone: null, email: null, consent: { marketing: false, at: "2026-10-13T07:00:00.000Z" } }),
      contact: null,
    },
  };
};
const count = async (sql: string, params: unknown[]) => Number((await db.admin(sql, params)).rows[0]!.n);

beforeAll(async () => {
  db = await openDb();
  W = await buildTenant(db, "T99");
  A = await buildWorld(db, { country: "AU" });
  pools = { core: db.pool("munim_core", 6), svc: db.pool("munim_svc", 2) };
  const config = { nodeEnv: "test", redact: (s: string) => s };
  app = await createApp({ pools, idp, storefronts: storefrontResolver(pools.core), config, log: createLogger(config, () => {}) });

  // IN: the dish is created by the owner's own catalogue command over HTTP (G-01 round trip below); AU: a direct insert.
  const inItem = uuidv7();
  const created = await member("/v1/catalogue/items", env("catalogue.item.upsert.v1", {
    item_id: inItem, name_key: "menu.t99_paneer_tikka", category: "Starters", brand_id: null, barcode: null, mrp_minor: null, currency: null, active: true,
    kind: "dish", stock_ingredient_id: null, variants: [],
    option_groups: [{ option_group_id: group, name_key: "menu.t99_spice", min_select: 0, max_select: 1, required: false, display_name: "Spice level", description: null,
      options: [{ option_id: option, name_key: "menu.t99_spice.hot", price_delta_minor: 0, currency: "INR", active: true, ingredient_deltas: [], display_name: "Hot", description: "Extra green chilli" }] }],
  }));
  expect(created.status).toBe(200);
  IN = await shop(W, inItem, 32000, "restaurant_5");
  const auItem = uuidv7();
  await db.withContext("munim_core", ownerCtx(A, { command_type: "catalogue.item.upsert.v1" }), (c) =>
    c.query(`INSERT INTO core.item (tenant_id, id, kind, name_key, category, display_name, diet) VALUES ($1, $2, 'dish', 'menu.t99_flat_white', 'Coffee', 'Flat white', 'veg')`, [A.tenant, auItem]));
  AU = await shop(A, auItem, 480, "gst_10");
  await db.withContext("munim_core", ownerCtx(W, { command_type: "catalogue.coupon.set.v1" }), (c) =>
    c.query(`INSERT INTO core.coupon (tenant_id, id, code, kind, value_bp, currency, min_spend_minor, valid_from) VALUES ($1, $2, 'TENSPEND', 'percent', 1000, 'INR', 100000, '2026-10-01')`, [W.tenant, uuidv7()]));
  await db.withContext("munim_core", ownerCtx(W, { command_type: "tenancy.brand.create.v1" }), (c) =>
    c.query(`INSERT INTO core.brand (tenant_id, id, name, outlet_ids, active) VALUES ($1, $2, 'Closed brand', $3, false)`, [W.tenant, uuidv7(), [IN.outlet]]));
  const starts = new Date(Date.now() + DAY);
  win = { id: uuidv7(), starts: starts.toISOString(), ends: new Date(starts.getTime() + 30 * 60_000).toISOString() };
  await db.withContext("munim_core", ownerCtx(W), (c) =>
    c.query(`INSERT INTO core.pickup_window (tenant_id, id, outlet_id, starts_at, ends_at, capacity_orders) VALUES ($1, $2, $3, $4, $5, 50)`, [W.tenant, win.id, IN.outlet, win.starts, win.ends]));
});
afterAll(async () => {
  await pools.core.end();
  await pools.svc.end();
  await db.stop();
});

describe("G-01 display text: catalogue command → DB → storefront menu", () => {
  it("an upsert naming display text writes it (0 → 1 row), the menu returns it verbatim, and an upsert that omits it keeps it", async () => {
    const shown = () => count(`SELECT count(*) AS n FROM core.item WHERE id = $1 AND display_name IS NOT NULL`, [IN.item]);
    expect(await shown()).toBe(0);
    const upsert = (extra: Record<string, unknown>) => member("/v1/catalogue/items", env("catalogue.item.upsert.v1", {
      item_id: IN.item, name_key: "menu.t99_paneer_tikka", category: "Starters", brand_id: null, barcode: null, mrp_minor: null, currency: null, active: true,
      kind: "dish", stock_ingredient_id: null, variants: [], option_groups: [], ...extra }));
    const r = await upsert({ display_name: SCRIPT, description: "Charred cottage cheese, mint chutney", diet: "veg" });
    expect(r.status).toBe(200);
    CommandResult.parse(await r.json());
    expect(await shown()).toBe(1);
    expect((await upsert({})).status).toBe(200); // absent = unchanged
    const res = await sf(IN, "GET", `/v1/storefront/outlets/${IN.outlet}/menu`);
    expect(res.headers.get("content-type")).toMatch(/^application\/json/);
    const menu = StorefrontMenuResponse.parse(await res.json());
    const item = menu.items.find((i) => i.item_id === IN.item)!;
    console.log("G-01 menu item:", JSON.stringify({ display_name: item.display_name, diet: item.diet, groups: item.option_groups }));
    expect([item.display_name, item.description, item.diet, item.category]).toEqual([SCRIPT, "Charred cottage cheese, mint chutney", "veg", "Starters"]);
    expect(item.option_groups).toEqual([{ option_group_id: group, name_key: "menu.t99_spice", display_name: "Spice level", description: null, min_select: 0, max_select: 1, required: false,
      options: [{ option_id: option, name_key: "menu.t99_spice.hot", display_name: "Hot", description: "Extra green chilli", price_delta_minor: 0 }] }]);
    // An item the owner never named: null → the client shows name_key.
    expect(menu.items.filter((i) => i.item_id !== IN.item).every((i) => i.display_name === null)).toBe(true);
  });

  it("plain text: the contract types display text as a bare nullable string (no format) — no HTML path exists", () => {
    for (const k of ["display_name", "description"] as const) {
      const f = StorefrontMenuItem.shape[k];
      expect([f.def.type, f.unwrap().def.type, f.unwrap().format, f.parse(SCRIPT)]).toEqual(["nullable", "string", null, SCRIPT]);
    }
  });
});

describe("G-02 / G-03 / G-13 menu facts", () => {
  it("IN menu: the key's channel id, the outlet's active brands only, prices exclusive of tax, the IN pack's pay-at-counter methods", async () => {
    const m = StorefrontMenuResponse.parse(await (await sf(IN, "GET", `/v1/storefront/outlets/${IN.outlet}/menu`)).json());
    console.log("G-13 IN methods:", JSON.stringify(m.pay_at_counter_methods), "pack:", JSON.stringify(packMethods("IN")));
    expect([m.channel_id, m.brands.map((b) => b.name), m.prices_include_tax, m.pay_at_counter_methods]).toEqual([IN.channel, ["Brand"], false, packMethods("IN")]);
  });
  it("AU menu: prices include tax; the item's own display text and diet; the AU pack's pay-at-counter methods", async () => {
    const m = StorefrontMenuResponse.parse(await (await sf(AU, "GET", `/v1/storefront/outlets/${AU.outlet}/menu`)).json());
    const item = m.items.find((i) => i.item_id === AU.item)!;
    expect([m.prices_include_tax, item.display_name, item.diet, item.price_minor, m.pay_at_counter_methods]).toEqual([true, "Flat white", "veg", 480, packMethods("AU")]);
  });
});

describe("G-03 tax display (hand values in the header)", () => {
  it("IN preview: rate 500, CGST 800 + SGST 800 per line and in total, tax 1600, total 33600, exclusive", async () => {
    const p = StorefrontPreviewResponse.parse(await (await sf(IN, "POST", "/v1/storefront/orders:preview", cart(IN))).json());
    console.log("G-03 IN:", JSON.stringify({ lines: p.lines.map((l) => [l.tax_rate_bp, l.tax_components]), total: p.tax_components }));
    expect(p.lines.map((l) => [l.tax_rate_bp, l.tax_minor, l.tax_components])).toEqual([[500, 1600, [{ code: "CGST", rate_bp: 250, amount_minor: 800 }, { code: "SGST", rate_bp: 250, amount_minor: 800 }]]]);
    expect([p.tax_components, p.tax_minor, p.total_minor, p.prices_include_tax]).toEqual([[{ code: "CGST", rate_bp: 250, amount_minor: 800 }, { code: "SGST", rate_bp: 250, amount_minor: 800 }], 1600, 33600, false]);
  });
  it("AU preview: rate 1000, one GST of 44 inside 480, inclusive", async () => {
    const p = StorefrontPreviewResponse.parse(await (await sf(AU, "POST", "/v1/storefront/orders:preview", cart(AU))).json());
    console.log("G-03 AU:", JSON.stringify({ lines: p.lines.map((l) => [l.tax_rate_bp, l.tax_components]), total: p.tax_components }));
    expect(p.lines.map((l) => [l.tax_rate_bp, l.tax_minor, l.tax_components])).toEqual([[1000, 44, [{ code: "GST", rate_bp: 1000, amount_minor: 44 }]]]);
    expect([p.tax_components, p.tax_minor, p.total_minor, p.prices_include_tax]).toEqual([[{ code: "GST", rate_bp: 1000, amount_minor: 44 }], 44, 480, true]);
  });
  it("IN place and order view: tax 1600 exclusive; the line's rate 500 and component rates CGST 250 + SGST 250", async () => {
    const b = placeBody(IN);
    const res = await sf(IN, "POST", "/v1/storefront/orders", b.body);
    expect(res.status).toBe(201);
    const placed = StorefrontOrderPlaced.parse(await res.json());
    expect([placed.total_minor, placed.tax_minor, placed.prices_include_tax]).toEqual([33600, 1600, false]);
    const view = StorefrontOrderView.parse(await (await sf(IN, "GET", `/v1/storefront/orders/${b.order_id}`, undefined, { [GUEST_TOKEN_HEADER]: placed.guest_access_token! })).json());
    expect([view.prices_include_tax, view.lines.map((l) => [l.tax_rate_bp, l.tax_component_rates])])
      .toEqual([false, [[500, [{ code: "CGST", rate_bp: 250 }, { code: "SGST", rate_bp: 250 }]]]]);
  });
  it("AU place: tax 44 inclusive", async () => {
    const res = await sf(AU, "POST", "/v1/storefront/orders", placeBody(AU).body);
    expect(res.status).toBe(201);
    const placed = StorefrontOrderPlaced.parse(await res.json());
    expect([placed.total_minor, placed.tax_minor, placed.prices_include_tax]).toEqual([480, 44, true]);
  });
});

describe("G-04 outlet phone and public tax ids", () => {
  it("after the owner's outlet update: phone and the pack's on-receipt ids (GSTIN, FSSAI) with pack labels; another outlet: null and []", async () => {
    const r = await member(`/v1/outlets/${IN.outlet}:update`, env("tenancy.outlet.update.v1", {
      outlet_id: IN.outlet, phone: "+918041234567", tax_ids: { GSTIN: "29ABCDE1234F1Z5", FSSAI: "12345678901234" } }));
    expect(r.status).toBe(200);
    const list = StorefrontOutletsResponse.parse(await (await sf(IN, "GET", "/v1/storefront/outlets")).json());
    const mine = list.outlets.find((o) => o.outlet_id === IN.outlet)!;
    const other = list.outlets.find((o) => o.outlet_id === W.outlets[1])!;
    expect([mine.phone, mine.tax_ids]).toEqual(["+918041234567", [{ code: "GSTIN", label: "GSTIN", value: "29ABCDE1234F1Z5" }, { code: "FSSAI", label: "FSSAI Lic. No.", value: "12345678901234" }]]);
    expect([other.phone, other.tax_ids, list.pay_at_counter_methods]).toEqual([null, [], packMethods("IN")]);
    expect((await member(`/v1/outlets/${IN.outlet}:update`, env("tenancy.outlet.update.v1", { outlet_id: IN.outlet, phone: "12345" }))).status).toBe(422);
  });
});

describe("G-11 refusal parameters", () => {
  it("coupon_min_spend: preview and place carry code, min spend 100000 and shortfall 68000; without the coupon the cart is accepted", async () => {
    const p = StorefrontPreviewResponse.parse(await (await sf(IN, "POST", "/v1/storefront/orders:preview", cart(IN, { coupon_codes: ["TENSPEND"] }))).json());
    const want = { code: "TENSPEND", min_spend_minor: 100000, shortfall_minor: 68000, currency: "INR" };
    expect(p.refusals).toEqual([{ line_no: null, reason_code: "coupon_min_spend", params: want }]);
    const b = placeBody(IN, { coupon_codes: ["TENSPEND"] });
    const res = await sf(IN, "POST", "/v1/storefront/orders", b.body);
    const body = (await res.json()) as { error: { reason_code: string }; params: unknown };
    console.log("G-11 place:", res.status, JSON.stringify(body));
    expect([res.status, body.error.reason_code, body.params]).toEqual([409, "coupon_min_spend", want]);
    expect(await count(`SELECT count(*) AS n FROM core."order" WHERE id = $1`, [b.order_id])).toBe(0);
    expect((await sf(IN, "POST", "/v1/storefront/orders", placeBody(IN).body)).status).toBe(201);
  });
  it("a sold-out line carries its line_no and item", async () => {
    await db.withContext("munim_core", ownerCtx(W, { command_type: "catalogue.availability.set.v1" }), (c) =>
      c.query(`INSERT INTO core.item_availability (tenant_id, id, outlet_id, item_id, available, updated_by) VALUES ($1, $2, $3, $4, false, $5)`, [W.tenant, uuidv7(), IN.outlet, IN.item, W.owner]));
    const res = await sf(IN, "POST", "/v1/storefront/orders", placeBody(IN).body);
    const body = (await res.json()) as { error: { reason_code: string }; params: unknown };
    await db.admin(`DELETE FROM core.item_availability WHERE item_id = $1`, [IN.item]);
    expect([res.status, body.error.reason_code, body.params]).toEqual([409, "item_sold_out", { line_no: 1, item_id: IN.item, variant_id: null }]);
  });
});

describe("G-12 promised_at for a chosen window", () => {
  it("a promise before the window, and one at its end, → 422 pickup_time_outside_window; its start, inside it, and null → 201", async () => {
    const at = (ms: number) => new Date(Date.parse(win.starts) + ms).toISOString();
    for (const promised_at of [at(-60_000), win.ends]) {
      const res = await sf(IN, "POST", "/v1/storefront/orders", placeBody(IN, { pickup_window_id: win.id, promised_at }).body);
      const body = (await res.json()) as { error: { reason_code: string } };
      expect([res.status, body.error.reason_code]).toEqual([422, "pickup_time_outside_window"]);
      const pv = await sf(IN, "POST", "/v1/storefront/orders:preview", cart(IN, { pickup_window_id: win.id, promised_at }));
      expect(pv.status).toBe(422);
    }
    for (const promised_at of [win.starts, at(10 * 60_000), null]) {
      const res = await sf(IN, "POST", "/v1/storefront/orders", placeBody(IN, { pickup_window_id: win.id, promised_at }).body);
      expect(res.status).toBe(201);
    }
  });
});

describe("2-A replay of a placed order (fix cycle W1)", () => {
  it("capacity-1 window: place 201; the identical replay → the stored 201 (replayed, same order, no token), not window_full; another body under the key → 409 idempotency_conflict; paused outlet / item off sale → still the stored result", async () => {
    const starts = new Date(Date.now() + DAY + 3 * 3_600_000);
    const one = uuidv7();
    await db.withContext("munim_core", ownerCtx(W), (c) =>
      c.query(`INSERT INTO core.pickup_window (tenant_id, id, outlet_id, starts_at, ends_at, capacity_orders) VALUES ($1, $2, $3, $4, $5, 1)`,
        [W.tenant, one, IN.outlet, starts.toISOString(), new Date(starts.getTime() + 30 * 60_000).toISOString()]));
    const b = placeBody(IN, { pickup_window_id: one, promised_at: null });
    const first = await sf(IN, "POST", "/v1/storefront/orders", b.body);
    expect(first.status).toBe(201);
    const placed = StorefrontOrderPlaced.parse(await first.json());
    expect(placed.guest_access_token).not.toBeNull();
    expect(await count(`SELECT booked AS n FROM core.pickup_window WHERE id = $1`, [one])).toBe(1); // the window is now full
    const replay = async () => {
      const r = await sf(IN, "POST", "/v1/storefront/orders", b.body);
      const body = (await r.json()) as { order_id?: string; ticket_no?: number; guest_access_token?: string | null; error?: { reason_code: string | null } };
      return [r.status, r.headers.get("X-Munim-Replayed"), body.order_id, body.ticket_no, body.guest_access_token, body.error?.reason_code ?? null];
    };
    const stored = [201, "true", placed.order_id, placed.ticket_no, null, null];
    expect(await replay()).toEqual(stored);
    // A retry that re-minted its guest envelope (new key and command id): the order key decides → the stored result, not 500.
    const remint = { ...b.body, guest: { ...b.body.guest, command_id: uuidv7(), idempotency_key: `k-${uuidv7()}` } };
    const rr = await sf(IN, "POST", "/v1/storefront/orders", remint);
    expect([rr.status, rr.headers.get("X-Munim-Replayed"), ((await rr.json()) as { order_id: string }).order_id]).toEqual([201, "true", placed.order_id]);
    // Control: a fresh key into the full window → 409 window_full.
    const fresh = await sf(IN, "POST", "/v1/storefront/orders", placeBody(IN, { pickup_window_id: one, promised_at: null }).body);
    expect([fresh.status, ((await fresh.json()) as { error: { reason_code: string } }).error.reason_code]).toEqual([409, "window_full"]);
    // Another body under the same key: the key's verdict, not the full window's.
    const other = { ...b.body, order: { ...b.body.order, payload: { ...(b.body.order.payload as Record<string, unknown>), order_id: uuidv7() } } };
    const conflict = await sf(IN, "POST", "/v1/storefront/orders", other);
    expect([conflict.status, ((await conflict.json()) as { error: { code: string } }).error.code]).toEqual([409, "idempotency_conflict"]);
    // The outlet paused after placement.
    const accepting = (await db.admin<{ a: string }>(`SELECT accepting_orders AS a FROM core.outlet WHERE id = $1`, [IN.outlet])).rows[0]!.a;
    const setAccepting = (v: string) => db.withContext("munim_core", ownerCtx(W, { command_type: "tenancy.outlet.create.v1" }), (c) =>
      c.query(`UPDATE core.outlet SET accepting_orders = $2 WHERE id = $1`, [IN.outlet, v]));
    await setAccepting("paused");
    try {
      expect(await replay()).toEqual(stored);
    } finally {
      await setAccepting(accepting);
    }
    // The item taken off sale after placement.
    await db.withContext("munim_core", ownerCtx(W, { command_type: "catalogue.availability.set.v1" }), (c) =>
      c.query(`INSERT INTO core.item_availability (tenant_id, id, outlet_id, item_id, available, updated_by) VALUES ($1, $2, $3, $4, false, $5)`, [W.tenant, uuidv7(), IN.outlet, IN.item, W.owner]));
    try {
      expect(await replay()).toEqual(stored);
    } finally {
      await db.admin(`DELETE FROM core.item_availability WHERE item_id = $1`, [IN.item]);
    }
    expect(await count(`SELECT count(*) AS n FROM core."order" WHERE pickup_window_id = $1`, [one])).toBe(1);
  });
});

describe("pricedPack: an order's pack version that cannot be read (fix cycle W1)", () => {
  it("missing pack row and an unparseable one → prices_include_tax null and every line's rate null / [] (cannot verify); control: the intact order shows false and 500", async () => {
    const placeOne = async () => {
      const b = placeBody(IN);
      const r = await sf(IN, "POST", "/v1/storefront/orders", b.body);
      expect(r.status).toBe(201);
      return { id: b.order_id, token: StorefrontOrderPlaced.parse(await r.json()).guest_access_token! };
    };
    const view = async (o: { id: string; token: string }) => {
      const v = StorefrontOrderView.parse(await (await sf(IN, "GET", `/v1/storefront/orders/${o.id}`, undefined, { [GUEST_TOKEN_HEADER]: o.token })).json());
      return [v.prices_include_tax, v.lines.map((l) => [l.tax_rate_bp, l.tax_component_rates])];
    };
    const [intact, missing, corrupt] = [await placeOne(), await placeOne(), await placeOne()];
    // The order snapshot is a book column (the guard would refuse an edit): forged with triggers off, as a corruption would be.
    const repoint = (id: string, version: number) =>
      db.admin(`SET session_replication_role = replica; UPDATE core."order" SET pricing_snapshot = jsonb_set(pricing_snapshot, '{pack,version}', '${version}') WHERE id = '${id}'; SET session_replication_role = origin`);
    await db.admin(`INSERT INTO platform.country_pack (code, version, effective_from, doc, status) VALUES ('IN', 998, '2026-01-01', '{"code": "IN", "version": 998}', 'retired')`);
    try {
      await repoint(missing.id, 999);
      await repoint(corrupt.id, 998);
      expect(await view(intact)).toEqual([false, [[500, [{ code: "CGST", rate_bp: 250 }, { code: "SGST", rate_bp: 250 }]]]]);
      expect(await view(missing)).toEqual([null, [[null, []]]]);
      expect(await view(corrupt)).toEqual([null, [[null, []]]]);
    } finally {
      await db.admin(`SET session_replication_role = replica; DELETE FROM platform.country_pack WHERE code = 'IN' AND version = 998; SET session_replication_role = origin`);
    }
  });
});

describe("previewFlow reads one snapshot (fix cycle W1)", () => {
  it("a price committed between the preview and the detail read → 200 with the first reading (tax 1600, total 33600), not 500; the change did commit", async () => {
    const priceId = (await db.admin<{ id: string }>(`SELECT id FROM core.price WHERE item_id = $1 AND outlet_id = $2 AND channel_kind = 'pickup'`, [IN.item, IN.outlet])).rows[0]!.id;
    const setAmount = (n: number) =>
      db.admin(`SET session_replication_role = replica; UPDATE core.price SET amount_minor = ${n} WHERE id = '${priceId}'; SET session_replication_role = origin`);
    let raced = 0;
    configureStorefront({ seams: { previewOrder: async (c, p, req) => {
      const out = await previewIn(c, p, req);
      await setAmount(64000); // another connection, committed before storefront's second reading
      raced++;
      return out;
    } } });
    try {
      const r = await sf(IN, "POST", "/v1/storefront/orders:preview", cart(IN));
      const committed = Number((await db.admin<{ a: string }>(`SELECT amount_minor AS a FROM core.price WHERE id = $1`, [priceId])).rows[0]!.a);
      expect([r.status, raced, committed]).toEqual([200, 1, 64000]);
      const p = StorefrontPreviewResponse.parse(await r.json());
      expect([p.tax_minor, p.total_minor]).toEqual([1600, 33600]);
    } finally {
      resetStorefront();
      await setAmount(32000);
    }
  });
});
