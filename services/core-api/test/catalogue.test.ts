// T-021 gates — the catalogue module through the real app (member auth → withContext → RLS → book guard) and the
// pricing seam `priceLines` on the caller's transaction.
//   validity: overlapping price / recipe validity → 409, adjacent → 200 (and the exclusion constraint backstop);
//   authority: staff cannot set a price (403), the outlet's manager can for that outlet only, the owner can;
//   SKU without stock_ingredient_id → 400 (and 0 rows), with one → 200; a unit that is not the ingredient's
//   base unit → 400 unit_mismatch; sold-out per outlet; barcode lookup; menu; deal end; coupon set; drafts;
//   priceLines on 20 hand-computed carts (IN tax-exclusive, AU tax-inclusive; options, deals, coupons, refusals).
// Every expected number below is worked out by hand in the comment beside it (never by the code under test).
// Synthetic data only.
import { createLogger } from "@munim/config";
import { CommandResult } from "@munim/contracts";
import { BarcodeLookupResponse, MenuResponse } from "@munim/contracts/catalogue";
import { buildWorld, ownerCtx, type TestDb, uuidv7, type World } from "@munim/db";
import type { Hono } from "hono";
import type pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { type AppEnv, contextOf, createApp, TENANT_HEADER, withContext } from "../src/app.ts";
import { draftHandler } from "../src/modules/approvals/handlers.ts";
import { DRAFT_HANDLERS } from "../src/modules/catalogue/handlers.ts";
import { couponUses, itemsForSale, priceLines, type PriceRequest, type PriceResult } from "../src/modules/catalogue/index.ts";
import { createLocalIdp } from "../src/auth/local-idp.ts";
import { openDb } from "./db.ts";

const idp = createLocalIdp();
let db: TestDb;
let pools: { core: pg.Pool; svc: pg.Pool };
let app: Hono<AppEnv>;
let IN: World;
let AU: World;
const manager = uuidv7();
const subs = { owner: `owner-${uuidv7()}`, staff: `staff-${uuidv7()}`, manager: `manager-${uuidv7()}`, auOwner: `au-owner-${uuidv7()}` };
type Who = keyof typeof subs;

const ids = () => ({
  ingBisc: uuidv7(), ingChips: uuidv7(), ingMilk: uuidv7(),
  A: uuidv7(), gExtras: uuidv7(), xCheese: uuidv7(), xPaneer: uuidv7(), dCheese: uuidv7(), gSpice: uuidv7(), sMild: uuidv7(), sHot: uuidv7(),
  B: uuidv7(), vGarlic: uuidv7(), vPlain: uuidv7(), C: uuidv7(), D: uuidv7(), E: uuidv7(),
  DL1: uuidv7(), DL2: uuidv7(), DL3: uuidv7(), DL4: uuidv7(),
  F: uuidv7(), gMilk: uuidv7(), oat: uuidv7(), G: uuidv7(), DLA: uuidv7(), DLB: uuidv7(),
});
const I = ids();
// Deals are tried in id order; give the all-items 5% deal (DL4) the LOWER id so "largest discount wins" is what
// picks DL2 for naan in cart 7 (a first-match rule would pick DL4).
const [lowDeal, highDeal] = [I.DL4, I.DL2].sort() as [string, string];
I.DL4 = lowDeal;
I.DL2 = highDeal;
const coupon = { SAVE10: uuidv7(), FLAT100: uuidv7(), CAPPED: uuidv7(), EXPIRED: uuidv7(), OUTLET2: uuidv7(), MEMBERONLY: uuidv7(), TENOFF: uuidv7() };

type Res = Omit<Response, "json"> & { json(): Promise<any> };
const tenantOf = (who: Who) => (who === "auOwner" ? AU.tenant : IN.tenant);
const call = async (method: string, path: string, who: Who, body?: unknown): Promise<Res> =>
  (await app.request(path, {
    method,
    headers: { Authorization: `Bearer ${idp.sign({ sub: subs[who] })}`, [TENANT_HEADER]: tenantOf(who), "Content-Type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  })) as Res;
const envelope = (type: string, payload: unknown, key = `k-${uuidv7()}`) => ({ command_id: uuidv7(), idempotency_key: key, type, payload });
const send = (who: Who, path: string, type: string, payload: unknown, key?: string) => call("POST", path, who, envelope(type, payload, key));
const ok = async (r: Res) => {
  const body = await r.json();
  if (r.status !== 200) throw new Error(`expected 200, got ${r.status} ${JSON.stringify(body)}`);
  return CommandResult.parse(body);
};
const count = async (sql: string, params: unknown[] = []) => Number((await db.admin(sql, params)).rows[0]!.n);

const dish = (item_id: string, name_key: string, extra: Record<string, unknown> = {}) => ({
  item_id, name_key, category: "mains", brand_id: null, barcode: null, mrp_minor: null, currency: null, active: true, variants: [], option_groups: [],
  kind: "dish", stock_ingredient_id: null, ...extra,
});
const sku = (item_id: string, name_key: string, barcode: string, stock: string, mrp: number, currency = "INR") => ({
  item_id, name_key, category: "shop", brand_id: null, barcode, mrp_minor: mrp, currency, active: true, variants: [], option_groups: [], kind: "sku", stock_ingredient_id: stock,
});
const price = (item_id: string, outlet_id: string, amount_minor: number, tax_class: string, o: Record<string, unknown> = {}) => ({
  price_id: uuidv7(), item_id, variant_id: null, outlet_id, channel_kind: "counter", amount_minor, currency: "INR", tax_class, valid_from: "2026-10-01", valid_to: null, ...o,
});
const deal = (deal_id: string, rule: unknown, windows: unknown[], outlet_ids: string[] = []) => ({
  deal_id, name_key: "deal.t21", rule, windows, outlet_ids, valid_from: "2026-10-01", valid_to: null, active: true,
});
const couponBody = (coupon_id: string, code: string, o: Record<string, unknown> = {}) => ({
  coupon_id, code, kind: "percent", value_bp: 1000, value_minor: null, currency: "INR", min_spend_minor: 0, global_cap: null, per_customer_cap: null,
  requires_customer: false, outlet_ids: [], valid_from: "2026-10-01T00:00:00Z", valid_to: null, active: true, ...o,
});

async function addMembers() {
  await db.withContext("munim_core", ownerCtx(IN, { command_type: "tenancy.member.invite.v1" }), async (c) => {
    await c.query(`UPDATE core.member SET idp_sub = $2 WHERE id = $1`, [IN.owner, subs.owner]);
    await c.query(`UPDATE core.member SET idp_sub = $2 WHERE id = $1`, [IN.staff, subs.staff]);
    await c.query(`INSERT INTO core.member (tenant_id, id, idp_sub, name, email) VALUES ($1, $2, $3, 'Manager', 'm@example.test')`, [IN.tenant, manager, subs.manager]);
    await c.query(`INSERT INTO core.membership (tenant_id, member_id, role, outlet_ids) VALUES ($1, $2, 'manager', $3)`, [IN.tenant, manager, [IN.outlets[0]]]);
  });
  await db.withContext("munim_core", ownerCtx(AU, { command_type: "tenancy.member.invite.v1" }), (c) =>
    c.query(`UPDATE core.member SET idp_sub = $2 WHERE id = $1`, [AU.owner, subs.auOwner]));
  await db.withContext("munim_core", ownerCtx(IN, { command_type: "inventory.ingredient.upsert.v1" }), async (c) => {
    for (const id of [I.ingBisc, I.ingChips]) await c.query(`INSERT INTO core.ingredient (tenant_id, id, name, base_unit) VALUES ($1, $2, 'Synthetic pack', 'pcs')`, [IN.tenant, id]);
  });
}

/** IN fixture: A paneer tikka (options), B naan (plain and garlic variants; plain has no price row of its own and
 *  sells at the item's 6000), C lassi, D/E shop SKUs; four deals; coupons. An item with active variants is sold only
 *  as one of them (catalogue's one rule, sellableAs — W2 fix list C2). */
async function inCatalogue() {
  const O1 = IN.outlets[0];
  await ok(await send("owner", "/v1/catalogue/items", "catalogue.item.upsert.v1", dish(I.A, "menu.t21_paneer_tikka", {
    option_groups: [
      { option_group_id: I.gExtras, name_key: "opt.extras", min_select: 0, max_select: 2, required: false, options: [
        { option_id: I.xCheese, name_key: "opt.extra_cheese", price_delta_minor: 3000, currency: "INR", active: true,
          ingredient_deltas: [{ delta_id: I.dCheese, ingredient_id: IN.ingredient, qty_milli: 20000, unit: "g", waste_pct_bp: 0 }] },
        { option_id: I.xPaneer, name_key: "opt.extra_paneer", price_delta_minor: 5000, currency: "INR", active: true, ingredient_deltas: [] },
      ] },
      { option_group_id: I.gSpice, name_key: "opt.spice", min_select: 1, max_select: 1, required: true, options: [
        { option_id: I.sMild, name_key: "opt.mild", price_delta_minor: 0, currency: "INR", active: true, ingredient_deltas: [] },
        { option_id: I.sHot, name_key: "opt.hot", price_delta_minor: 500, currency: "INR", active: true, ingredient_deltas: [] },
      ] },
    ],
  })));
  await ok(await send("owner", "/v1/catalogue/items", "catalogue.item.upsert.v1", dish(I.B, "menu.t21_naan", {
    variants: [{ variant_id: I.vGarlic, name_key: "menu.t21_naan.garlic", barcode: null, active: true },
      { variant_id: I.vPlain, name_key: "menu.t21_naan.plain", barcode: null, active: true }],
  })));
  await ok(await send("owner", "/v1/catalogue/items", "catalogue.item.upsert.v1", dish(I.C, "menu.t21_lassi")));
  await ok(await send("owner", "/v1/catalogue/items", "catalogue.item.upsert.v1", sku(I.D, "shop.t21_biscuits", "8900000000017", I.ingBisc, 3000)));
  await ok(await send("owner", "/v1/catalogue/items", "catalogue.item.upsert.v1", sku(I.E, "shop.t21_chips", "8900000000024", I.ingChips, 2000)));
  for (const p of [
    price(I.A, O1, 24900, "restaurant_5"), price(I.B, O1, 6000, "restaurant_5"), price(I.B, O1, 7500, "restaurant_5", { variant_id: I.vGarlic }),
    price(I.C, O1, 9900, "restaurant_5"), price(I.D, O1, 2500, "goods_18"), price(I.E, O1, 1600, "goods_18"), // E: 1600 + 18% = 1888 ≤ MRP 2000
  ]) await ok(await send("owner", "/v1/catalogue/prices", "catalogue.price.set.v1", p));
  // The printed MRP of E's new stock is lower: 1888 tax-inclusive is now above it.
  await ok(await send("owner", "/v1/catalogue/items", "catalogue.item.upsert.v1", sku(I.E, "shop.t21_chips", "8900000000024", I.ingChips, 1800)));
  const TEA = { days: [1, 2, 3, 4, 5], from: "15:00", to: "18:00" };
  const LATE = { days: [5, 6], from: "22:00", to: "02:00" };
  for (const d of [
    deal(I.DL1, { kind: "percent_off", bp: 1000, item_ids: [I.C] }, [TEA]),
    deal(I.DL2, { kind: "buy_x_get_y", buy_qty: 1, get_qty: 1, item_ids: [I.B] }, [], [O1]),
    deal(I.DL3, { kind: "amount_off", amount_minor: 2000, item_ids: [I.A] }, [LATE]),
    deal(I.DL4, { kind: "percent_off", bp: 500, item_ids: [] }, [{ days: [7], from: "11:00", to: "14:00" }]),
  ]) await ok(await send("owner", "/v1/catalogue/deals", "catalogue.deal.upsert.v1", d));
  for (const c of [
    couponBody(coupon.SAVE10, "SAVE10", { min_spend_minor: 50000 }),
    couponBody(coupon.FLAT100, "FLAT100", { kind: "amount", value_bp: null, value_minor: 10000 }),
    couponBody(coupon.CAPPED, "CAPPED", { value_bp: 2000, global_cap: 1 }),
    couponBody(coupon.EXPIRED, "EXPIRED", { valid_from: "2026-09-01T00:00:00Z", valid_to: "2026-10-01T00:00:00Z" }),
    couponBody(coupon.OUTLET2, "OUTLET2", { outlet_ids: [IN.outlets[1]] }),
    couponBody(coupon.MEMBERONLY, "MEMBERONLY", { requires_customer: true }),
  ]) await ok(await send("owner", "/v1/catalogue/coupons", "catalogue.coupon.set.v1", c));
  // CAPPED has been used once already (an earlier order of another customer).
  await db.withContext("munim_core", ownerCtx(IN, { command_type: "orders.place.v1" }), (c) =>
    c.query(`INSERT INTO core.coupon_use (tenant_id, id, coupon_id, order_id, customer_id, discount_minor, currency, applied_by) VALUES ($1, $2, $3, $4, NULL, 500, 'INR', $5)`,
      [IN.tenant, uuidv7(), coupon.CAPPED, IN.orders[0], IN.owner]));
}

/** AU fixture: F flat white (oat milk option), G sourdough (GST-free); weekday-breakfast and DST-day deals; a coupon. */
async function auCatalogue() {
  const O1 = AU.outlets[0];
  await ok(await send("auOwner", "/v1/catalogue/items", "catalogue.item.upsert.v1", dish(I.F, "menu.t21_flat_white", {
    option_groups: [{ option_group_id: I.gMilk, name_key: "opt.milk", min_select: 0, max_select: 1, required: false, options: [
      { option_id: I.oat, name_key: "opt.oat", price_delta_minor: 80, currency: "AUD", active: true, ingredient_deltas: [] }] }],
  })));
  await ok(await send("auOwner", "/v1/catalogue/items", "catalogue.item.upsert.v1", dish(I.G, "menu.t21_sourdough")));
  await ok(await send("auOwner", "/v1/catalogue/prices", "catalogue.price.set.v1", price(I.F, O1, 550, "gst_10", { currency: "AUD" })));
  await ok(await send("auOwner", "/v1/catalogue/prices", "catalogue.price.set.v1", price(I.G, O1, 899, "gst_free", { currency: "AUD" })));
  await ok(await send("auOwner", "/v1/catalogue/deals", "catalogue.deal.upsert.v1",
    deal(I.DLA, { kind: "percent_off", bp: 2000, item_ids: [I.F] }, [{ days: [1, 2, 3, 4, 5], from: "07:00", to: "09:00" }])));
  await ok(await send("auOwner", "/v1/catalogue/deals", "catalogue.deal.upsert.v1",
    deal(I.DLB, { kind: "percent_off", bp: 1000, item_ids: [I.G] }, [{ days: [7], from: "01:00", to: "03:30" }])));
  await ok(await send("auOwner", "/v1/catalogue/coupons", "catalogue.coupon.set.v1",
    couponBody(coupon.TENOFF, "TENOFF", { kind: "amount", value_bp: null, value_minor: 1000, currency: "AUD" })));
}

beforeAll(async () => {
  db = await openDb();
  IN = await buildWorld(db);
  AU = await buildWorld(db, { country: "AU" });
  await addMembers();
  pools = { core: db.pool("munim_core", 6), svc: db.pool("munim_svc", 2) };
  const config = { nodeEnv: "test", redact: (s: string) => s };
  app = await createApp({ pools, idp, storefronts: async () => null, config, log: createLogger(config, () => {}) });
  await inCatalogue();
  await auCatalogue();
});

afterAll(async () => {
  await pools?.core.end();
  await pools?.svc.end();
  await db?.stop();
});

const sale = (w: World, req: Omit<PriceRequest, "outlet_id" | "channel_kind"> & { outlet_id?: string }): Promise<PriceResult> =>
  db.withContext("munim_core", ownerCtx(w), (c) => priceLines(c, { outlet_id: w.outlets[0], channel_kind: "counter", ...req }));
const line = (item_id: string, qty: number, option_ids: string[] = [], variant_id: string | null = null) => ({ item_id, variant_id, option_ids, qty_milli: qty * 1000 });
/** [line_no, amount, discount, tax, total] per priced line. */
const shape = (r: PriceResult) => r.lines.map((l) => [l.line_no, l.amount_minor, l.line_discount_minor, l.tax_minor, l.line_total_minor]);
const totals = (r: PriceResult) => ({ subtotal: r.subtotal_minor, discount: r.discount_minor, tax: r.tax_minor, total: r.total_minor });
const refusals = (r: PriceResult) => r.refusals.map((x) => [x.line_no, x.reason_code, x.code ?? null]);
const row = (table: string, id: string) => `⟨cite:row:core.${table}:${id}⟩`;

// Instants: IST = UTC+05:30; Melbourne AEDT = UTC+11 from Sun 4 Oct 2026 03:00, AEST = UTC+10 before it.
const WED_1230 = "2026-10-14T07:00:00Z"; // Wed 12:30 IST
const WED_1600 = "2026-10-14T10:30:00Z"; // Wed 16:00 IST (tea window)
const SAT_0100 = "2026-10-16T19:30:00Z"; // Sat 01:00 IST (Friday's late window, across midnight)
const SUN_1200 = "2026-10-18T06:30:00Z"; // Sun 12:00 IST (DL4 window)

describe("priceLines — 20 hand-computed carts", () => {
  // IN: tax-exclusive; restaurant_5 = CGST 2.5% + SGST 2.5%, goods_18 = CGST 9% + SGST 9%, each rounded half-up per line.
  it("1 · A × 1 mild: 24900; CGST = SGST = 622.5 → 623; total 26146", async () => {
    const r = await sale(IN, { at: WED_1230, lines: [line(I.A, 1, [I.sMild])] });
    expect(shape(r)).toEqual([[1, 24900, 0, 1246, 26146]]);
    expect(totals(r)).toEqual({ subtotal: 24900, discount: 0, tax: 1246, total: 26146 });
    expect(r.lines[0]!.price_ref).toMatch(/^⟨cite:row:core\.price:[0-9a-f-]{36}⟩$/);
    expect(r.lines[0]!.option_refs).toEqual([row("option", I.sMild)]);
    expect(r.tax_rule).toEqual({ pack_code: "IN", pack_version: 4 });
  });
  it("2 · A × 2 extra cheese + hot: unit 24900 + 3000 + 500 = 28400; amount 56800; tax 1420 × 2; total 59640", async () => {
    const r = await sale(IN, { at: WED_1230, lines: [line(I.A, 2, [I.xCheese, I.sHot])] });
    expect(shape(r)).toEqual([[1, 56800, 0, 2840, 59640]]);
    expect([r.lines[0]!.unit_price_minor, r.lines[0]!.options_minor]).toEqual([24900, 3500]);
    expect(r.lines[0]!.option_refs).toEqual([row("option", I.xCheese), row("option", I.sHot)]);
  });
  it("3 · B × 2, buy 1 get 1 (DL2): 12000 − 6000 = 6000; tax 150 × 2; total 6300", async () => {
    const r = await sale(IN, { at: WED_1230, lines: [line(I.B, 2, [], I.vPlain)] });
    expect(shape(r)).toEqual([[1, 12000, 6000, 300, 6300]]);
    expect(totals(r)).toEqual({ subtotal: 12000, discount: 6000, tax: 300, total: 6300 });
    expect(r.lines[0]!.deal_refs).toEqual([row("deal", I.DL2)]);
  });
  it("4 · B garlic variant × 1: the variant's own price 7500; tax 187.5 → 188 × 2; total 7876", async () => {
    const r = await sale(IN, { at: WED_1230, lines: [line(I.B, 1, [], I.vGarlic)] });
    expect(shape(r)).toEqual([[1, 7500, 0, 376, 7876]]);
  });
  it("5 · C × 2 at 16:00 Wed, tea deal 10% (DL1): 19800 − 1980 = 17820; tax 445.5 → 446 × 2; total 18712", async () => {
    const r = await sale(IN, { at: WED_1600, lines: [line(I.C, 2)] });
    expect(shape(r)).toEqual([[1, 19800, 1980, 892, 18712]]);
    expect(r.lines[0]!.deal_refs).toEqual([row("deal", I.DL1)]);
  });
  it("6 · A × 1 at Sat 01:00 — Friday's late deal (₹20 off per unit, DL3) across midnight: 22900; tax 572.5 → 573 × 2; total 24046", async () => {
    const r = await sale(IN, { at: SAT_0100, lines: [line(I.A, 1, [I.sMild])] });
    expect(shape(r)).toEqual([[1, 24900, 2000, 1146, 24046]]);
    expect(r.business_date).toBe("2026-10-16"); // before the 04:00 cutoff: Friday's business day
  });
  it("7 · Sunday noon: A gets DL4 5% (1245); B × 2 gets DL2 (6000 beats DL4's 600) — one deal per line, largest wins", async () => {
    // A: 24900 − 1245 = 23655; tax 591.375 → 591 × 2 = 1182; 24837. B: 6000; tax 300; 6300. Σ 31137, tax 1482, discount 7245.
    const r = await sale(IN, { at: SUN_1200, lines: [line(I.A, 1, [I.sMild]), line(I.B, 2, [], I.vPlain)] });
    expect(shape(r)).toEqual([[1, 24900, 1245, 1182, 24837], [2, 12000, 6000, 300, 6300]]);
    expect(totals(r)).toEqual({ subtotal: 36900, discount: 7245, tax: 1482, total: 31137 });
    expect(r.lines.map((l) => l.deal_refs)).toEqual([[row("deal", I.DL4)], [row("deal", I.DL2)]]);
  });
  it("8 · SAVE10 (10%, min spend 50000) on 56800: coupon 5680; 51120; tax 1278 × 2; total 53676", async () => {
    const r = await sale(IN, { at: WED_1230, lines: [line(I.A, 2, [I.xCheese, I.sHot])], coupon_codes: ["SAVE10"] });
    expect(shape(r)).toEqual([[1, 56800, 5680, 2556, 53676]]);
    expect(r.coupons).toEqual([{ coupon_id: coupon.SAVE10, code: "SAVE10", discount_minor: 5680, ref: row("coupon", coupon.SAVE10) }]);
    expect(r.lines[0]!.coupon_refs).toEqual([row("coupon", coupon.SAVE10)]);
    expect(r.refusals).toEqual([]);
  });
  it("9 · SAVE10 on B × 10 = 60000, but 5 free under DL2 → 30000 after deals (< 50000) → coupon_min_spend; tax 750 × 2; total 31500", async () => {
    const r = await sale(IN, { at: WED_1230, lines: [line(I.B, 10, [], I.vPlain)], coupon_codes: ["SAVE10"] });
    expect(refusals(r)).toEqual([[null, "coupon_min_spend", "SAVE10"]]);
    expect(shape(r)).toEqual([[1, 60000, 30000, 1500, 31500]]);
    expect(totals(r)).toEqual({ subtotal: 60000, discount: 30000, tax: 1500, total: 31500 });
  });
  it("10 · FLAT100 (₹100) split 24900 : 9900 → 7155.17 / 2844.83 → [7155, 2845] (largest remainder); total 26040", async () => {
    // A 17745: tax 443.625 → 444 × 2 = 888 → 18633. C 7055: tax 176.375 → 176 × 2 = 352 → 7407.
    const r = await sale(IN, { at: WED_1230, lines: [line(I.A, 1, [I.sMild]), line(I.C, 1)], coupon_codes: ["FLAT100"] });
    expect(shape(r)).toEqual([[1, 24900, 7155, 888, 18633], [2, 9900, 2845, 352, 7407]]);
    expect(totals(r)).toEqual({ subtotal: 34800, discount: 10000, tax: 1240, total: 26040 });
  });
  it("11 · SAVE10 then FLAT100 stack in order: 56800 − 5680 − 10000 = 41120; tax 1028 × 2; total 43176", async () => {
    const r = await sale(IN, { at: WED_1230, lines: [line(I.A, 2, [I.xCheese, I.sHot])], coupon_codes: ["SAVE10", "FLAT100"] });
    expect(shape(r)).toEqual([[1, 56800, 15680, 2056, 43176]]);
    expect(r.coupons.map((c) => [c.code, c.discount_minor])).toEqual([["SAVE10", 5680], ["FLAT100", 10000]]);
    expect(r.lines[0]!.coupon_refs).toEqual([row("coupon", coupon.SAVE10), row("coupon", coupon.FLAT100)]);
  });
  it("12 · CAPPED (global cap 1, used once) → coupon_cap_reached; C × 1: tax 247.5 → 248 × 2; total 10396", async () => {
    const r = await sale(IN, { at: WED_1230, lines: [line(I.C, 1)], coupon_codes: ["CAPPED"] });
    expect(refusals(r)).toEqual([[null, "coupon_cap_reached", "CAPPED"]]);
    expect(totals(r)).toEqual({ subtotal: 9900, discount: 0, tax: 496, total: 10396 });
  });
  it("13 · expired, other-outlet, unknown, and customer-only-without-a-customer codes → coupon_expired, coupon_out_of_scope, coupon_invalid, coupon_out_of_scope; total as cart 1", async () => {
    const r = await sale(IN, { at: WED_1230, lines: [line(I.A, 1, [I.sMild])], coupon_codes: ["EXPIRED", "OUTLET2", "NOPE1", "MEMBERONLY"] });
    expect(refusals(r)).toEqual([[null, "coupon_expired", "EXPIRED"], [null, "coupon_out_of_scope", "OUTLET2"], [null, "coupon_invalid", "NOPE1"], [null, "coupon_out_of_scope", "MEMBERONLY"]]);
    expect(totals(r)).toEqual({ subtotal: 24900, discount: 0, tax: 1246, total: 26146 });
  });
  it("14 · shop SKU D × 3 (goods_18) after it sold out here: priced 7500 + 675 × 2 = 8850, refused item_sold_out", async () => {
    await ok(await send("staff", "/v1/catalogue/availability", "catalogue.availability.set.v1", { outlet_id: IN.outlets[0], item_id: I.D, variant_id: null, available: false }));
    const r = await sale(IN, { at: WED_1230, lines: [line(I.D, 3)] });
    expect(shape(r)).toEqual([[1, 7500, 0, 1350, 8850]]);
    expect(refusals(r)).toEqual([[1, "item_sold_out", null]]);
  });
  it("15 · SKU E priced 1600 + 18% = 1888 above its MRP 1800 → line 1 refused price_above_mrp and not priced; line 2 C priced 10396", async () => {
    const r = await sale(IN, { at: WED_1230, lines: [line(I.E, 1), line(I.C, 1)] });
    expect(refusals(r)).toEqual([[1, "price_above_mrp", null]]);
    expect(shape(r)).toEqual([[2, 9900, 0, 496, 10396]]);
  });

  // AU: tax-inclusive; gst_10 = GST 10% inside the price (tax = after × 1000 / 11000, half-up), gst_free = 0.
  const WED_1400_MEL = "2026-10-14T03:00:00Z"; // Wed 14:00 AEDT
  it("16 · AU F × 1: 550 includes GST 50 (550/11); net 500; total 550", async () => {
    const r = await sale(AU, { at: WED_1400_MEL, lines: [line(I.F, 1)] });
    expect(shape(r)).toEqual([[1, 550, 0, 50, 550]]);
    expect(totals(r)).toEqual({ subtotal: 500, discount: 0, tax: 50, total: 550 });
    expect(r.tax_rule).toEqual({ pack_code: "AU", pack_version: 4 });
  });
  it("17 · AU F × 2 oat at Mon 08:00 (20% breakfast deal): 1260 − 252 = 1008 incl GST 91.64 → 92", async () => {
    const r = await sale(AU, { at: "2026-10-11T21:00:00Z", lines: [line(I.F, 2, [I.oat])] });
    expect(shape(r)).toEqual([[1, 1260, 252, 92, 1008]]);
    expect(totals(r)).toEqual({ subtotal: 1168, discount: 252, tax: 92, total: 1008 });
  });
  it("18 · AU F × 1 at Mon 09:00 — the breakfast window has closed (to is exclusive): 550, GST 50", async () => {
    const r = await sale(AU, { at: "2026-10-11T22:00:00Z", lines: [line(I.F, 1)] });
    expect(shape(r)).toEqual([[1, 550, 0, 50, 550]]);
  });
  it("19 · AU TENOFF (A$10) split 1798 : 550 → 765.76 / 234.24 → [766, 234]; G GST-free 1032; F 316 incl GST 28.73 → 29", async () => {
    const r = await sale(AU, { at: WED_1400_MEL, lines: [line(I.G, 2), line(I.F, 1)], coupon_codes: ["TENOFF"] });
    expect(shape(r)).toEqual([[1, 1798, 766, 0, 1032], [2, 550, 234, 29, 316]]);
    expect(totals(r)).toEqual({ subtotal: 2319, discount: 1000, tax: 29, total: 1348 });
  });
  it("20 · AU on Melbourne's spring-forward day: G × 1 at 01:59 AEST gets the 10% deal (899 − 90 = 809); at 03:45 AEDT it does not (899)", async () => {
    const inside = await sale(AU, { at: "2026-10-03T15:59:00Z", lines: [line(I.G, 1)] });
    expect(shape(inside)).toEqual([[1, 899, 90, 0, 809]]);
    expect(inside.lines[0]!.deal_refs).toEqual([row("deal", I.DLB)]);
    const after = await sale(AU, { at: "2026-10-03T16:45:00Z", lines: [line(I.G, 1)] });
    expect(shape(after)).toEqual([[1, 899, 0, 0, 899]]);
  });

  it("a shopper's request counts every customer's coupon uses (the cap holds under customer RLS)", async () => {
    const shopper = uuidv7();
    await db.withContext("munim_core", ownerCtx(IN, { command_type: "customers.customer.upsert.v1" }), (c) =>
      c.query(`INSERT INTO core.customer (tenant_id, id, name, is_guest) VALUES ($1, $2, 'Synthetic Shopper', true)`, [IN.tenant, shopper]));
    const ctx = contextOf({ kind: "customer", tenant_id: IN.tenant, channel_id: IN.channel, customer_id: shopper, profile: true, sub: null }, { coupon_codes: ["CAPPED", "SAVE10"] });
    const r = await withContext(pools.core, ctx, async (c) => {
      const seen = Number((await c.query<{ n: string }>(`SELECT count(*) AS n FROM core.coupon_use WHERE coupon_id = $1`, [coupon.CAPPED])).rows[0]!.n);
      return { seen, priced: await priceLines(c, { outlet_id: IN.outlets[0], channel_kind: "counter", at: WED_1230, lines: [line(I.C, 1)], coupon_codes: ["CAPPED"], customer_id: shopper }) };
    });
    expect(r.seen).toBe(0); // the shopper cannot read the other order's use …
    expect(refusals(r.priced)).toEqual([[null, "coupon_cap_reached", "CAPPED"]]); // … but the cap still counts it
  });
  it("couponUses: once the order carrying CAPPED's one use is cancelled, the use no longer counts — for the owner, a member scoped to another outlet and a shopper", async () => {
    const shopper = uuidv7();
    await db.withContext("munim_core", ownerCtx(IN, { command_type: "customers.customer.upsert.v1" }), (c) =>
      c.query(`INSERT INTO core.customer (tenant_id, id, name, is_guest) VALUES ($1, $2, 'Synthetic Shopper 2', true)`, [IN.tenant, shopper]));
    const asShopper = () => withContext(pools.core, contextOf({ kind: "customer", tenant_id: IN.tenant, channel_id: IN.channel, customer_id: shopper, profile: true, sub: null }, { coupon_codes: ["CAPPED"] }),
      (c) => priceLines(c, { outlet_id: IN.outlets[0], channel_kind: "counter", at: WED_1230, lines: [line(I.C, 1)], coupon_codes: ["CAPPED"], customer_id: shopper }));
    // A manager of outlet 2 only: the order carrying the use (outlet 1) is outside their view.
    const asOutlet2 = () => db.withContext("munim_core", { tenant_id: IN.tenant, outlet_ids: [IN.outlets[1]], role: "manager", member_id: IN.owner },
      (c) => couponUses(c, coupon.CAPPED, null));
    // Refusal first: the use's order is still placed → 1 use → cap reached everywhere.
    expect(refusals(await sale(IN, { at: WED_1230, lines: [line(I.C, 1)], coupon_codes: ["CAPPED"] }))).toEqual([[null, "coupon_cap_reached", "CAPPED"]]);
    expect(refusals(await asShopper())).toEqual([[null, "coupon_cap_reached", "CAPPED"]]);
    expect(await asOutlet2()).toEqual({ all: 1, mine: 0 });
    await db.withContext("munim_core", ownerCtx(IN, { command_type: "orders.order.advance.v1" }), (c) =>
      c.query(`UPDATE core."order" SET status = 'cancelled' WHERE id = $1 AND status = 'placed'`, [IN.orders[0]]));
    // Accept: 0 live uses; CAPPED applies (20% of C × 1 — no refusal) for each caller; the use row itself stays.
    expect(refusals(await sale(IN, { at: WED_1230, lines: [line(I.C, 1)], coupon_codes: ["CAPPED"] }))).toEqual([]);
    expect(refusals(await asShopper())).toEqual([]);
    expect(await asOutlet2()).toEqual({ all: 0, mine: 0 });
    expect(Number((await db.admin<{ n: string }>(`SELECT count(*) AS n FROM core.coupon_use WHERE coupon_id = $1`, [coupon.CAPPED])).rows[0]!.n)).toBe(1);
  });
  it("one sellable rule (sellableAs): naan has active variants, so a bare naan line is refused 409 conflict / item_unavailable and the menu never lists it bare; a variant line prices", async () => {
    await expect(sale(IN, { at: WED_1230, lines: [line(I.B, 1)] })).rejects.toMatchObject({ code: "conflict", reason_code: "item_unavailable" });
    const menu = await db.withContext("munim_core", ownerCtx(IN), (c) => itemsForSale(c, IN.outlets[0], "counter", { item_id: I.B }));
    expect(menu.entries.map((e) => e.variant_id).sort()).toEqual([I.vGarlic, I.vPlain].sort());
    expect(shape(await sale(IN, { at: WED_1230, lines: [line(I.B, 1, [], I.vGarlic)] }))[0]!.slice(0, 2)).toEqual([1, 7500]);
    // A lassi (no variants) is sold only bare: naming naan's variant on it is refused too.
    await expect(sale(IN, { at: WED_1230, lines: [line(I.C, 1, [], I.vGarlic)] })).rejects.toMatchObject({ code: "not_found" });
  });
  it("malformed carts throw: an option of another item → 400; a required group left empty → 400; an unknown item → 404", async () => {
    await expect(sale(IN, { at: WED_1230, lines: [line(I.C, 1, [I.sMild])] })).rejects.toMatchObject({ code: "bad_request" });
    await expect(sale(IN, { at: WED_1230, lines: [line(I.A, 1)] })).rejects.toMatchObject({ code: "bad_request" });
    await expect(sale(IN, { at: WED_1230, lines: [line(uuidv7(), 1)] })).rejects.toMatchObject({ code: "not_found" });
  });
});

describe("validity: overlapping refused, adjacent accepted", () => {
  it("price: [10-01,10-15) then adjacent [10-15,∞) → 200; [10-10,10-12) overlaps → 409; [10-20,∞) takes over the open row; same start → 409", async () => {
    const O1 = IN.outlets[0];
    const p = (from: string, to: string | null) => price(I.C, O1, 9000, "restaurant_5", { channel_kind: "pickup", valid_from: from, valid_to: to });
    const first = p("2026-10-01", "2026-10-15");
    await ok(await send("owner", "/v1/catalogue/prices", "catalogue.price.set.v1", first));
    const adjacent = p("2026-10-15", null);
    await ok(await send("owner", "/v1/catalogue/prices", "catalogue.price.set.v1", adjacent));
    const overlap = p("2026-10-10", "2026-10-12");
    const refused = await send("owner", "/v1/catalogue/prices", "catalogue.price.set.v1", overlap);
    expect([refused.status, (await refused.json()).error.code]).toEqual([409, "conflict"]);
    expect(await count(`SELECT count(*) n FROM core.price WHERE id = $1`, [overlap.price_id])).toBe(0);
    const later = p("2026-10-20", null);
    await ok(await send("owner", "/v1/catalogue/prices", "catalogue.price.set.v1", later));
    expect((await db.admin(`SELECT valid_to::text v FROM core.price WHERE id = $1`, [adjacent.price_id])).rows[0]!.v).toBe("2026-10-20");
    const sameStart = await send("owner", "/v1/catalogue/prices", "catalogue.price.set.v1", p("2026-10-20", "2026-10-25"));
    expect(sameStart.status).toBe(409);
    expect(await count(`SELECT count(*) n FROM core.price WHERE item_id = $1 AND channel_kind = 'pickup'`, [I.C])).toBe(3);
  });
  it("the exclusion constraint is the backstop: a raw overlapping insert under the price command → 23P01", async () => {
    await expect(db.withContext("munim_core", ownerCtx(IN, { command_type: "catalogue.price.set.v1" }), (c) =>
      c.query(`INSERT INTO core.price (tenant_id, id, item_id, outlet_id, channel_kind, amount_minor, currency, tax_class, valid_from, valid_to)
               VALUES ($1, $2, $3, $4, 'pickup', 1, 'INR', 'restaurant_5', '2026-10-05', '2026-10-06')`, [IN.tenant, uuidv7(), I.C, IN.outlets[0]])))
      .rejects.toMatchObject({ code: "23P01" });
  });
  it("recipe: v1 [10-01,∞); v2 from 10-15 closes v1 (adjacent) → 200; v3 [10-05,10-10) overlaps closed v1 → 409; wrong version number → 409", async () => {
    const r = (version: number, from: string, to: string | null) => ({
      recipe_version_id: uuidv7(), item_id: I.C, variant_id: null, version, valid_from: from, valid_to: to, yield_qty_milli: 1000,
      lines: [{ ingredient_id: IN.ingredient, qty_milli: 50000, unit: "g", waste_pct_bp: 200 }],
    });
    const v1 = r(1, "2026-10-01", null);
    await ok(await send("owner", "/v1/catalogue/recipes", "catalogue.recipe.version.create.v1", v1));
    const v2 = r(2, "2026-10-15", null);
    await ok(await send("owner", "/v1/catalogue/recipes", "catalogue.recipe.version.create.v1", v2));
    expect((await db.admin(`SELECT valid_to::text v FROM core.recipe_version WHERE id = $1`, [v1.recipe_version_id])).rows[0]!.v).toBe("2026-10-15");
    const v3 = await send("owner", "/v1/catalogue/recipes", "catalogue.recipe.version.create.v1", r(3, "2026-10-05", "2026-10-10"));
    expect(v3.status).toBe(409);
    const skipped = await send("owner", "/v1/catalogue/recipes", "catalogue.recipe.version.create.v1", r(5, "2026-11-01", null));
    expect(skipped.status).toBe(409);
    expect(await count(`SELECT count(*) n FROM core.recipe_version WHERE item_id = $1`, [I.C])).toBe(2);
    expect(await count(`SELECT count(*) n FROM core.recipe_line WHERE recipe_version_id = $1`, [v2.recipe_version_id])).toBe(1);
  });
  it("unit_mismatch: a recipe line or an option delta in kg for an ingredient kept in g → 400 unit_mismatch; in g → 200", async () => {
    const bad = await send("owner", "/v1/catalogue/recipes", "catalogue.recipe.version.create.v1", {
      recipe_version_id: uuidv7(), item_id: I.B, variant_id: null, version: 1, valid_from: "2026-10-01", valid_to: null, yield_qty_milli: 1000,
      lines: [{ ingredient_id: IN.ingredient, qty_milli: 50, unit: "kg", waste_pct_bp: 0 }],
    });
    expect([bad.status, (await bad.json()).error.reason_code]).toEqual([400, "unit_mismatch"]);
    const item = uuidv7();
    const opt = (unit: string) => dish(item, "menu.t21_units", { option_groups: [{ option_group_id: uuidv7(), name_key: "opt.x", min_select: 0, max_select: 1, required: false,
      options: [{ option_id: uuidv7(), name_key: "opt.y", price_delta_minor: 0, currency: "INR", active: true,
        ingredient_deltas: [{ delta_id: uuidv7(), ingredient_id: IN.ingredient, qty_milli: 10, unit, waste_pct_bp: 0 }] }] }] });
    const badOpt = await send("owner", "/v1/catalogue/items", "catalogue.item.upsert.v1", opt("kg"));
    expect([badOpt.status, (await badOpt.json()).error.reason_code]).toEqual([400, "unit_mismatch"]);
    expect(await count(`SELECT count(*) n FROM core.item WHERE id = $1`, [item])).toBe(0);
    await ok(await send("owner", "/v1/catalogue/items", "catalogue.item.upsert.v1", opt("g")));
  });
});

describe("authority", () => {
  it("staff cannot set a price (403, 0 rows); the outlet-1 manager can for outlet 1 but not outlet 2; the owner can", async () => {
    const p = (outlet: string) => price(I.B, outlet, 6500, "restaurant_5", { channel_kind: "table_qr" });
    const staff = p(IN.outlets[0]);
    const denied = await send("staff", "/v1/catalogue/prices", "catalogue.price.set.v1", staff);
    expect([denied.status, (await denied.json()).error]).toEqual([403, { code: "forbidden", message: expect.any(String), reason_code: "authority_denied" }]);
    expect(await count(`SELECT count(*) n FROM core.price WHERE id = $1`, [staff.price_id])).toBe(0);
    const other = p(IN.outlets[1]);
    expect((await send("manager", "/v1/catalogue/prices", "catalogue.price.set.v1", other)).status).toBe(403);
    await ok(await send("manager", "/v1/catalogue/prices", "catalogue.price.set.v1", staff));
    await ok(await send("owner", "/v1/catalogue/prices", "catalogue.price.set.v1", other));
    const origin = (await db.admin(`SELECT origin FROM core.price WHERE id = $1`, [other.price_id])).rows[0]!.origin;
    expect(origin).toMatchObject({ kind: "command" });
  });
  it("SKU without stock_ingredient_id → 422 invalid_payload and 0 rows; with one → 200", async () => {
    const item = uuidv7();
    const missing = await send("owner", "/v1/catalogue/items", "catalogue.item.upsert.v1", { ...sku(item, "shop.t21_nostock", "8900000000031", I.ingBisc, 1000), stock_ingredient_id: null });
    expect([missing.status, (await missing.json()).error.code]).toEqual([422, "invalid_payload"]);
    expect(await count(`SELECT count(*) n FROM core.item WHERE id = $1`, [item])).toBe(0);
    await ok(await send("owner", "/v1/catalogue/items", "catalogue.item.upsert.v1", sku(item, "shop.t21_nostock", "8900000000031", I.ingBisc, 1000)));
    expect(await count(`SELECT count(*) n FROM core.item WHERE id = $1 AND kind = 'sku' AND stock_ingredient_id = $2`, [item, I.ingBisc])).toBe(1);
  });
  it("staff cannot upsert an item; a manager scoped to one outlet cannot either (tenant-wide command)", async () => {
    for (const who of ["staff", "manager"] as const) expect((await send(who, "/v1/catalogue/items", "catalogue.item.upsert.v1", dish(uuidv7(), "menu.t21_denied"))).status).toBe(403);
  });
  it("availability: staff marks sold out at their outlet (200), not at another (403)", async () => {
    await ok(await send("staff", "/v1/catalogue/availability", "catalogue.availability.set.v1", { outlet_id: IN.outlets[0], item_id: I.C, variant_id: null, available: false }));
    expect((await send("staff", "/v1/catalogue/availability", "catalogue.availability.set.v1", { outlet_id: IN.outlets[1], item_id: I.C, variant_id: null, available: false })).status).toBe(403);
    await ok(await send("staff", "/v1/catalogue/availability", "catalogue.availability.set.v1", { outlet_id: IN.outlets[0], item_id: I.C, variant_id: null, available: true }));
    expect(await count(`SELECT count(*) n FROM core.item_availability WHERE item_id = $1 AND outlet_id = $2 AND available`, [I.C, IN.outlets[0]])).toBe(1);
  });
  it("a replayed command returns the same bytes with X-Munim-Replayed and writes once", async () => {
    const body = couponBody(uuidv7(), "REPLAY1");
    const key = `replay-${uuidv7()}`;
    const env = envelope("catalogue.coupon.set.v1", body, key);
    const a = await call("POST", "/v1/catalogue/coupons", "owner", env);
    const b = await call("POST", "/v1/catalogue/coupons", "owner", env);
    expect([a.status, b.status, b.headers.get("X-Munim-Replayed")]).toEqual([200, 200, "true"]);
    expect(await b.text()).toBe(await a.text());
    expect(await count(`SELECT count(*) n FROM core.coupon WHERE code = 'REPLAY1'`)).toBe(1);
  });
});

describe("reads", () => {
  it("menu: one entry per sellable (item, variant) with its price row, options and deal badges", async () => {
    const r = await call("GET", `/v1/catalogue/menu?outlet=${IN.outlets[0]}&channel_kind=counter`, "owner");
    expect(r.status).toBe(200);
    const menu = MenuResponse.parse(await r.json());
    const a = menu.entries.find((e) => e.item_id === I.A)!;
    expect([a.price_minor, a.tax_class, a.available]).toEqual([24900, "restaurant_5", true]);
    expect(a.option_groups.map((g) => [g.name_key, g.required, g.options.map((o) => o.price_delta_minor)])).toEqual([["opt.extras", false, [3000, 5000]], ["opt.spice", true, [0, 500]]]); // payload order (0030): extra_cheese, extra_paneer; mild, hot
    expect(a.deals.map((d) => d.deal_id).sort()).toEqual([I.DL3, I.DL4].sort());
    // B has active variants: listed as each of them (payload order, here also name order), garlic at its own price, plain at the item's; never bare.
    expect(menu.entries.filter((e) => e.item_id === I.B).map((e) => [e.variant_id, e.price_minor])).toEqual([[I.vGarlic, 7500], [I.vPlain, 6000]]);
    expect(menu.entries.find((e) => e.item_id === I.D)!.available).toBe(false); // sold out in cart 14
  });
  it("menu outside the member's outlet scope → 404", async () => {
    expect((await call("GET", `/v1/catalogue/menu?outlet=${IN.outlets[1]}&channel_kind=counter`, "staff")).status).toBe(404);
  });
  it("barcode: a known SKU → its entry and price row; an unknown code → 404; an inactive item → on_sale false", async () => {
    const hit = BarcodeLookupResponse.parse(await (await call("GET", `/v1/catalogue/barcodes/8900000000017?outlet=${IN.outlets[0]}&channel_kind=counter`, "staff")).json());
    expect([hit.item_id, hit.on_sale, hit.entry!.price_minor, hit.entry!.mrp_minor]).toEqual([I.D, true, 2500, 3000]);
    expect((await call("GET", `/v1/catalogue/barcodes/0000000000000?outlet=${IN.outlets[0]}&channel_kind=counter`, "staff")).status).toBe(404);
    const item = uuidv7();
    await ok(await send("owner", "/v1/catalogue/items", "catalogue.item.upsert.v1", { ...sku(item, "shop.t21_gone", "8900000000048", I.ingBisc, 900), active: false }));
    const gone = BarcodeLookupResponse.parse(await (await call("GET", `/v1/catalogue/barcodes/8900000000048?outlet=${IN.outlets[0]}&channel_kind=counter`, "staff")).json());
    expect([gone.on_sale, gone.entry]).toEqual([false, null]);
  });
});

describe("deals, coupons and drafts", () => {
  it("the four catalogue draftables have this module's handlers registered with approvals", () => {
    expect(DRAFT_HANDLERS.map((h) => h.type).sort()).toEqual(["catalogue.coupon.set.v1", "catalogue.deal.end.v1", "catalogue.price.set.v1", "catalogue.recipe.version.create.v1"]);
    for (const h of DRAFT_HANDLERS) expect(draftHandler(h.type)).toBe(h);
  });
  it("deal end through an approved draft: valid_to moves earlier under the decision; ending later than the current end → 409", async () => {
    const d = uuidv7();
    await ok(await send("owner", "/v1/catalogue/deals", "catalogue.deal.upsert.v1", deal(d, { kind: "percent_off", bp: 100, item_ids: [] }, [], [])));
    const draft = uuidv7();
    await db.withContext("munim_svc", { tenant_id: IN.tenant, outlet_ids: "*" }, (c) =>
      c.query(`INSERT INTO core.draft (tenant_id, id, outlet_ids, source, command_type, command_payload, based_on) VALUES ($1, $2, '{}', 'intel:catalogue', 'catalogue.deal.end.v1', $3, '[]')`,
        [IN.tenant, draft, { deal_id: d, valid_to: "2026-10-20" }]));
    const approve = await call("POST", `/v1/drafts/${draft}:approve`, "owner", envelope("drafts.approve.v1",
      { draft_id: draft, command_type: "catalogue.deal.end.v1", edited_payload: null, reason: null }));
    expect(approve.status).toBe(200);
    const after = (await db.admin(`SELECT valid_to::text v, active FROM core.deal WHERE id = $1`, [d])).rows[0]!;
    expect(after).toEqual({ v: "2026-10-20", active: true });
    expect(await count(`SELECT count(*) n FROM core.audit_log WHERE entity = 'core.deal' AND entity_id = $1 AND decision_id IS NOT NULL`, [d])).toBe(1);
    const extend = await send("owner", `/v1/catalogue/deals/${d}:end`, "catalogue.deal.end.v1", { deal_id: d, valid_to: "2026-10-25" });
    expect(extend.status).toBe(409);
    const mismatch = await send("owner", `/v1/catalogue/deals/${d}:end`, "catalogue.deal.end.v1", { deal_id: uuidv7(), valid_to: "2026-10-12" });
    expect([mismatch.status, (await mismatch.json()).error.code]).toEqual([422, "invalid_payload"]);
    await ok(await send("owner", `/v1/catalogue/deals/${d}:end`, "catalogue.deal.end.v1", { deal_id: d, valid_to: "2026-10-12" }));
  });
  it("coupon set: caps and end date change (200); the offered terms cannot (409)", async () => {
    await ok(await send("owner", "/v1/catalogue/coupons", "catalogue.coupon.set.v1", couponBody(coupon.SAVE10, "SAVE10", { min_spend_minor: 50000, global_cap: 100 })));
    expect((await db.admin(`SELECT global_cap FROM core.coupon WHERE id = $1`, [coupon.SAVE10])).rows[0]!.global_cap).toBe(100);
    const changed = await send("owner", "/v1/catalogue/coupons", "catalogue.coupon.set.v1", couponBody(coupon.SAVE10, "SAVE10", { min_spend_minor: 1 }));
    expect(changed.status).toBe(409);
    const dup = await send("owner", "/v1/catalogue/coupons", "catalogue.coupon.set.v1", couponBody(uuidv7(), "SAVE10"));
    expect(dup.status).toBe(409); // the code is unique per tenant
  });
});
