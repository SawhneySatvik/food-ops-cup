// T-022 fixtures: the canonical world (buildWorld) plus a small synthetic menu in outlet 1, member logins, and
// LOCAL FAKES for the cross-module seams that have not landed (catalogue priceLines, inventory picks and
// consumption, customers loyalty, finance postFor). The fakes read the real catalogue rows and write REAL rows
// under the seeded derivation rules (app.posting_rule + app.source_ref, cleared after) so the gates prove the
// context and source state orders sets up. T-034 swaps in the owners' functions. Synthetic data only.
import { createLogger } from "@munim/config";
import { citeRef } from "@munim/contracts";
import { allocate, mulDiv } from "@munim/core-domain/money";
import { orderTax } from "@munim/core-domain/packs";
import { businessDate, localDate, localTime } from "@munim/core-domain/tz";
import { buildWorld, type TestDb, type World } from "@munim/db";
import type { Hono } from "hono";
import type pg from "pg";
import { type AppEnv, createApp, TENANT_HEADER } from "../src/app.ts";
import { uuidv7 } from "../src/commit/index.ts";
import type { Queryable } from "../src/runtoken/index.ts";
import type { OrderSeams, PricedLine, PriceLinesResult, Refusal } from "../src/modules/orders/seams.ts";
import { setOrderSeams } from "../src/modules/orders/seams.ts";
import { createLocalIdp } from "../../../adapters/dev/idp-local/index.ts";
import { openDb } from "./db.ts";

export { uuidv7 };
export type Who = "owner" | "staff" | "mgr1" | "mgr2";
export type Res = Omit<Response, "json"> & { json(): Promise<any> };

/** Synthetic menu in outlet 1 (prices IN minor units; AU uses the same numbers in cents). */
export interface Menu {
  dosa: string; chutney: string; coffee: string; biscuits: string; chips: string; juice: string; thali: string; paneer: string;
  biscuitBatch: string; biscuitIngredient: string; save10: string; flat50: string; cap1: string; lunchDeal: string;
  window: string; tableChannel: string; pickupChannel: string;
}

export interface Env {
  db: TestDb;
  w: World;
  menu: Menu;
  app: Hono<AppEnv>;
  pools: { core: pg.Pool; svc: pg.Pool };
  ids: Record<Who, string>;
  call(method: string, path: string, who: Who, body?: unknown): Promise<Res>;
  cmd(path: string, who: Who, type: string, payload: Record<string, unknown>, key?: string): Promise<Res>;
  one<R extends pg.QueryResultRow>(sql: string, params?: unknown[]): Promise<R>;
  rows<R extends pg.QueryResultRow>(sql: string, params?: unknown[]): Promise<R[]>;
  stop(): Promise<void>;
}

const D = (n: number) => n; // minor units, for readability in fixtures

export async function startEnv(country: "IN" | "AU" = "IN"): Promise<Env> {
  const idp = createLocalIdp();
  const db = await openDb();
  const w = await buildWorld(db, { country });
  const T = w.tenant;
  const o1 = w.outlets[0];
  const ids: Record<Who, string> = { owner: w.owner, staff: w.staff, mgr1: uuidv7(), mgr2: uuidv7() };
  const subs: Record<Who, string> = { owner: `owner-${uuidv7()}`, staff: `staff-${uuidv7()}`, mgr1: `mgr1-${uuidv7()}`, mgr2: `mgr2-${uuidv7()}` };
  const owner = { tenant_id: T, outlet_ids: "*" as const, role: "owner" as const, member_id: w.owner };
  const m: Menu = {
    dosa: uuidv7(), chutney: uuidv7(), coffee: uuidv7(), biscuits: uuidv7(), chips: uuidv7(), juice: uuidv7(), thali: uuidv7(), paneer: w.item,
    biscuitBatch: uuidv7(), biscuitIngredient: uuidv7(), save10: uuidv7(), flat50: uuidv7(), cap1: uuidv7(), lunchDeal: uuidv7(),
    window: uuidv7(), tableChannel: uuidv7(), pickupChannel: uuidv7(),
  };
  const goods = country === "IN" ? "goods_18" : "gst_10";
  const food = country === "IN" ? "restaurant_5" : "gst_10";
  await db.withContext("munim_core", owner, async (c) => {
    const cmd = (t: string) => c.query("SELECT set_config('app.command_type', $1, true)", [t]);
    await cmd("tenancy.member.invite.v1");
    await c.query(`UPDATE core.member SET idp_sub = $2 WHERE id = $1`, [w.owner, subs.owner]);
    await c.query(`UPDATE core.member SET idp_sub = $2 WHERE id = $1`, [w.staff, subs.staff]);
    for (const [who, outlet] of [["mgr1", o1], ["mgr2", w.outlets[1]]] as const) {
      await c.query(`INSERT INTO core.member (tenant_id, id, idp_sub, name, email) VALUES ($1, $2, $3, $4, $5)`, [T, ids[who], subs[who], `Synthetic ${who}`, `${who}@example.test`]);
      await c.query(`INSERT INTO core.membership (tenant_id, member_id, role, outlet_ids) VALUES ($1, $2, 'manager', $3)`, [T, ids[who], [outlet]]);
    }
    await cmd("tenancy.channel.create.v1");
    await c.query(`INSERT INTO core.channel (tenant_id, id, name, kind) VALUES ($1, $2, 'Table QR', 'table_qr'), ($1, $3, 'Pickup', 'pickup')`, [T, m.tableChannel, m.pickupChannel]);
    // The world's always-on deal would discount every line; switch it off so each fixture deal is explicit.
    await cmd("catalogue.deal.end.v1");
    await c.query(`UPDATE core.deal SET active = false WHERE tenant_id = $1`, [T]);
    await cmd("inventory.ingredient.upsert.v1");
    const ingJ = uuidv7(); const ingX = uuidv7();
    await c.query(`INSERT INTO core.ingredient (tenant_id, id, name, base_unit, tracked_by_batch) VALUES ($1, $2, 'Biscuit pack', 'pc', true), ($1, $3, 'Juice pack', 'pc', true), ($1, $4, 'Chips pack', 'pc', true)`,
      [T, m.biscuitIngredient, ingJ, ingX]);
    await cmd("catalogue.item.upsert.v1");
    const group = uuidv7();
    await c.query(`INSERT INTO core.item (tenant_id, id, kind, name_key, category) VALUES ($1, $2, 'dish', 'menu.dosa', 'mains'), ($1, $3, 'dish', 'menu.coffee', 'drinks'), ($1, $4, 'dish', 'menu.thali', 'mains')`,
      [T, m.dosa, m.coffee, m.thali]);
    await c.query(`INSERT INTO core.item (tenant_id, id, kind, name_key, category, barcode, stock_ingredient_id, mrp_minor, currency)
                   VALUES ($1, $2, 'sku', 'shop.biscuits', 'snacks', '8900000000011', $3, 3000, $6), ($1, $4, 'sku', 'shop.juice', 'drinks', '8900000000028', $5, 9000, $6),
                          ($1, $7, 'sku', 'shop.chips', 'snacks', '8900000000035', $8, 5000, $6)`,
      [T, m.biscuits, m.biscuitIngredient, m.juice, ingJ, w.currency, m.chips, ingX]);
    await c.query(`INSERT INTO core.option_group (tenant_id, id, item_id, name_key, max_select) VALUES ($1, $2, $3, 'menu.extras', 1)`, [T, group, m.dosa]);
    await c.query(`INSERT INTO core.option (tenant_id, id, option_group_id, name_key, price_delta_minor, currency) VALUES ($1, $2, $3, 'menu.extras.chutney', 1500, $4)`, [T, m.chutney, group, w.currency]);
    await cmd("catalogue.price.set.v1");
    const price = (item: string, kind: string, amount: number, cls: string) =>
      c.query(`INSERT INTO core.price (tenant_id, id, item_id, outlet_id, channel_kind, amount_minor, currency, tax_class, valid_from) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, '2026-01-01')`,
        [T, uuidv7(), item, o1, kind, amount, w.currency, cls]);
    for (const kind of ["counter", "pickup", "table_qr"]) {
      await price(m.dosa, kind, D(12000), food);
      await price(m.coffee, kind, D(4000), food);
      await price(m.thali, kind, D(20000), food);
      await price(m.biscuits, kind, D(2500), goods);
      await price(m.juice, kind, D(6000), goods);
      await price(m.chips, kind, D(2500), goods);
    }
    await cmd("catalogue.coupon.set.v1");
    await c.query(`INSERT INTO core.coupon (tenant_id, id, code, kind, value_bp, currency, valid_from) VALUES ($1, $2, 'SAVE10', 'percent', 1000, $3, '2026-01-01')`, [T, m.save10, w.currency]);
    await c.query(`INSERT INTO core.coupon (tenant_id, id, code, kind, value_minor, min_spend_minor, currency, valid_from) VALUES ($1, $2, 'FLAT50', 'amount', 5000, 20000, $3, '2026-01-01')`, [T, m.flat50, w.currency]);
    await c.query(`INSERT INTO core.coupon (tenant_id, id, code, kind, value_bp, global_cap, currency, valid_from) VALUES ($1, $2, 'CAP1', 'percent', 500, 1, $3, '2026-01-01')`, [T, m.cap1, w.currency]);
    await cmd("inventory.stock.receive.v1");
    const jb = uuidv7(); const xb = uuidv7();
    await c.query(`INSERT INTO core.batch (tenant_id, id, outlet_id, ingredient_id, batch_code, expires_on, mrp_minor, currency) VALUES
                     ($1, $2, $3, $4, 'BIS-1', '2030-01-01', 3000, $5), ($1, $6, $3, $7, 'JUI-OLD', '2026-01-01', NULL, NULL), ($1, $8, $3, $9, 'CHP-1', '2030-01-01', 2900, $5)`,
      [T, m.biscuitBatch, o1, m.biscuitIngredient, w.currency, jb, ingJ, xb, ingX]);
    for (const [b, ing] of [[m.biscuitBatch, m.biscuitIngredient], [jb, ingJ], [xb, ingX]] as const) {
      await c.query(`INSERT INTO core.stock_movement (tenant_id, id, outlet_id, ingredient_id, batch_id, qty_milli, unit, kind) VALUES ($1, $2, $3, $4, $5, 100000, 'pc', 'receipt')`,
        [T, uuidv7(), o1, ing, b]);
    }
  });
  // Pickup window (operational) and outlet 1 tax ids for receipts.
  await db.withContext("munim_core", { ...owner, command_type: "tenancy.outlet.create.v1" }, async (c) => {
    await c.query(`INSERT INTO core.pickup_window (tenant_id, id, outlet_id, starts_at, ends_at, capacity_orders) VALUES ($1, $2, $3, now() + interval '3 hours', now() + interval '195 minutes', 10)`,
      [T, m.window, o1]);
  });
  const taxIds = country === "IN" ? { GSTIN: "29ABCDE1234F1Z5", FSSAI: "12345678901234" } : { ABN: "51824753556" };
  await db.withContext("munim_core", { ...owner, command_type: "tenancy.outlet.update.v1" }, (c) =>
    c.query(`UPDATE core.outlet SET tax_ids = $2 WHERE id = $1`, [o1, taxIds]));

  const pools = { core: db.pool("munim_core", 16), svc: db.pool("munim_svc", 2) };
  const config = { nodeEnv: "test", redact: (s: string) => s };
  const sink = process.env.ORDERS_DEBUG ? (line: string) => console.error(line) : () => {};
  const app = await createApp({ pools, idp, storefronts: async () => null, config, log: createLogger(config, sink) });
  const call: Env["call"] = async (method, path, who, body) =>
    (await app.request(path, {
      method,
      headers: { Authorization: `Bearer ${idp.sign({ sub: subs[who] })}`, [TENANT_HEADER]: T, "Content-Type": "application/json" },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    })) as Res;
  const rows: Env["rows"] = async (sql, params = []) => (await db.admin(sql, params)).rows as any;
  return {
    db, w, menu: m, app, pools, ids, call, rows,
    one: async (sql, params = []) => (await db.admin(sql, params)).rows[0] as any,
    cmd: (path, who, type, payload, key = `k-${uuidv7()}`) => call("POST", path, who, { command_id: uuidv7(), idempotency_key: key, type, payload }),
    async stop() {
      await pools.core.end();
      await pools.svc.end();
      await db.stop();
    },
  };
}

// ── Local fakes for the seams (installed with installFakes) ──────────────────────────────────────────────

const ref = (table: string, id: string) => citeRef("row", `core.${table}:${id}`);
const minutes = (hhmm: string) => Number(hhmm.slice(0, 2)) * 60 + Number(hhmm.slice(3, 5));

async function packOf(c: Queryable) {
  return (await c.query<{ doc: any }>(
    `SELECT p.doc FROM core.tenant t JOIN platform.country_pack p ON p.code = t.country_code AND p.status = 'active'
      WHERE t.tenant_id = current_setting('app.tenant_id')::uuid ORDER BY p.version DESC LIMIT 1`)).rows[0]!.doc;
}

/** priceLines stand-in: price row in force on the outlet's business date of `at`, option deltas, open
 *  percent_off deals (windows judged at `at` in the outlet zone), coupons by code (percent per line; amount
 *  allocated by line amount after deals; min spend on Σ amounts), tax by core-domain orderTax. */
async function fakePriceLines(c: Queryable, input: Parameters<OrderSeams["priceLines"]>[1]): Promise<PriceLinesResult> {
  const pack = await packOf(c);
  const o = (await c.query<{ tz: string; cutoff: string }>(`SELECT tz, to_char(business_day_cutoff, 'HH24:MI') AS cutoff FROM core.outlet WHERE id = $1`, [input.outlet_id])).rows[0]!;
  const bd = businessDate(input.at, o.tz, o.cutoff);
  const refusals: Refusal[] = [];
  const lines: PricedLine[] = [];
  const mrps: Array<number | null> = [];
  const deals = (await c.query<{ id: string; rule: any; windows: any[]; outlet_ids: string[] }>(
    `SELECT id, rule, windows, outlet_ids FROM core.deal WHERE active AND valid_from <= $1::date AND (valid_to IS NULL OR valid_to > $1::date)`, [bd])).rows
    .filter((d) => (d.outlet_ids.length === 0 || d.outlet_ids.includes(input.outlet_id)) && d.rule.kind === "percent_off" && inWindows(d.windows, input.at, o.tz));
  for (const [li, l] of input.lines.entries()) {
    const line_no = li + 1;
    const p = (await c.query<{ id: string; amount_minor: string; tax_class: string; mrp_minor: string | null }>(
      `SELECT p.id, p.amount_minor, p.tax_class, i.mrp_minor FROM core.price p JOIN core.item i ON i.tenant_id = p.tenant_id AND i.id = p.item_id
        WHERE p.item_id = $1 AND p.variant_id IS NOT DISTINCT FROM $2 AND p.outlet_id = $3 AND p.channel_kind = $4
          AND p.valid_from <= $5::date AND (p.valid_to IS NULL OR p.valid_to > $5::date) AND i.active`,
      [l.item_id, l.variant_id, input.outlet_id, input.channel_kind, bd])).rows[0];
    if (!p) {
      refusals.push({ line_no, reason_code: "item_sold_out" });
      continue;
    }
    const opts = l.option_ids.length
      ? (await c.query<{ id: string; price_delta_minor: string }>(`SELECT id, price_delta_minor FROM core.option WHERE id = ANY ($1::uuid[]) AND active`, [l.option_ids])).rows
      : [];
    const delta = opts.reduce((a, x) => a + Number(x.price_delta_minor), 0);
    const amount = mulDiv(l.qty_milli, Number(p.amount_minor) + delta, 1000);
    const deal = deals.find((d) => d.rule.item_ids.length === 0 || d.rule.item_ids.includes(l.item_id));
    lines.push({
      line_no, item_id: l.item_id, variant_id: l.variant_id, option_ids: l.option_ids, qty_milli: l.qty_milli,
      price_ref: ref("price", p.id), option_refs: opts.map((x) => ref("option", x.id)), deal_refs: deal ? [ref("deal", deal.id)] : [], coupon_refs: [],
      unit_price_minor: Number(p.amount_minor), options_minor: delta, line_discount_minor: deal ? mulDiv(amount, deal.rule.bp, 10000) : 0,
      tax_class: p.tax_class, tax_minor: 0,
    });
    mrps.push(p.mrp_minor === null ? null : Number(p.mrp_minor));
  }
  const coupons: PriceLinesResult["coupons"] = [];
  if (refusals.length === 0) {
    const gross = lines.reduce((a, l) => a + mulDiv(l.qty_milli, l.unit_price_minor + l.options_minor, 1000), 0);
    for (const code of input.coupon_codes ?? []) {
      const k = (await c.query<{ id: string; kind: string; value_bp: number | null; value_minor: string | null; min_spend_minor: string; outlet_ids: string[] }>(
        `SELECT id, kind, value_bp, value_minor, min_spend_minor, outlet_ids FROM core.coupon
          WHERE code = $1 AND active AND valid_from <= $2::timestamptz AND (valid_to IS NULL OR valid_to > $2::timestamptz)`, [code, input.at])).rows[0];
      if (!k) { refusals.push({ line_no: null, reason_code: "coupon_invalid" }); continue; }
      if (k.outlet_ids.length && !k.outlet_ids.includes(input.outlet_id)) { refusals.push({ line_no: null, reason_code: "coupon_invalid" }); continue; }
      if (gross < Number(k.min_spend_minor)) { refusals.push({ line_no: null, reason_code: "coupon_min_spend" }); continue; }
      const after = lines.map((l) => mulDiv(l.qty_milli, l.unit_price_minor + l.options_minor, 1000) - l.line_discount_minor);
      const parts = k.kind === "percent"
        ? after.map((a) => mulDiv(a, k.value_bp!, 10000))
        : allocate(Math.min(Number(k.value_minor), after.reduce((a, b) => a + b, 0)), after);
      parts.forEach((d, i) => {
        lines[i]!.line_discount_minor += d;
        if (d > 0) lines[i]!.coupon_refs.push(ref("coupon", k.id));
      });
      coupons.push({ coupon_id: k.id, code, discount_minor: parts.reduce((a, b) => a + b, 0) });
    }
  }
  if (refusals.length === 0) {
    const t = orderTax(pack, { channel_kind: input.channel_kind, lines: lines.map((l, i) => ({
      name: l.item_id, qty_milli: l.qty_milli, unit_price_minor: l.unit_price_minor, option_delta_minor: l.options_minor,
      line_discount_minor: l.line_discount_minor, tax_class: l.tax_class, mrp_minor: mrps[i]! })) });
    if (!t.ok) refusals.push({ line_no: "line_no" in t.refusal ? t.refusal.line_no : null, reason_code: t.refusal.reason_code });
    else t.tax.lines.forEach((x, i) => { lines[i]!.tax_minor = x.tax_minor; });
  }
  return { lines, refusals, coupons };
}

function inWindows(windows: Array<{ days: number[]; from: string; to: string }>, at: string, tz: string): boolean {
  if (windows.length === 0) return true;
  const d = new Date(`${localDate(at, tz)}T00:00:00Z`).getUTCDay() || 7;
  const prev = d === 1 ? 7 : d - 1;
  const t = minutes(localTime(at, tz));
  return windows.some((w) => {
    const f = minutes(w.from), e = minutes(w.to);
    return f < e ? w.days.includes(d) && t >= f && t < e : (w.days.includes(d) && t >= f) || (w.days.includes(prev) && t < e);
  });
}

/** pickSaleBatches stand-in: SKU lines only; non-expired batches FEFO first, then expired ones (flagged). */
async function fakePick(c: Queryable, outlet_id: string, lines: Parameters<OrderSeams["pickSaleBatches"]>[2]) {
  const picks: Awaited<ReturnType<OrderSeams["pickSaleBatches"]>>["picks"] = [];
  const tz = (await c.query<{ tz: string }>(`SELECT tz FROM core.outlet WHERE id = $1`, [outlet_id])).rows[0]!.tz;
  const today = localDate(new Date(), tz);
  for (const l of lines) {
    const ing = (await c.query<{ s: string | null }>(`SELECT stock_ingredient_id AS s FROM core.item WHERE id = $1 AND kind = 'sku'`, [l.item_id])).rows[0]?.s;
    if (!ing) continue;
    const batches = (await c.query<{ id: string; expires_on: string | null; mrp_minor: string | null; on_hand: string }>(
      `SELECT b.id, b.expires_on::text AS expires_on, b.mrp_minor, coalesce(sum(m.qty_milli), 0) AS on_hand
         FROM core.batch b LEFT JOIN core.stock_movement m ON m.tenant_id = b.tenant_id AND m.batch_id = b.id
        WHERE b.outlet_id = $1 AND b.ingredient_id = $2 GROUP BY b.tenant_id, b.id ORDER BY b.expires_on NULLS LAST, b.id`, [outlet_id, ing])).rows
      .filter((b) => Number(b.on_hand) > 0);
    const fresh = batches.filter((b) => b.expires_on === null || b.expires_on >= today);
    let left = l.qty_milli;
    for (const b of [...fresh, ...batches.filter((x) => !fresh.includes(x))]) {
      if (left <= 0) break;
      const q = Math.min(left, Number(b.on_hand));
      picks.push({ line_no: l.line_no, line_id: l.line_id, batch_id: b.id, ingredient_id: ing, qty_milli: q, mrp_minor: b.mrp_minor === null ? null : Number(b.mrp_minor), expired: !fresh.includes(b), override_id: null });
      left -= q;
    }
  }
  return { picks, refusals: [] };
}

async function underRule<T>(c: Queryable, rule: string, src: string, fn: () => Promise<T>): Promise<T> {
  await c.query(`SELECT set_config('app.posting_rule', $1, true), set_config('app.source_ref', $2, true)`, [rule, src]);
  try {
    return await fn();
  } finally {
    await c.query(`SELECT set_config('app.posting_rule', '', true), set_config('app.source_ref', '', true)`);
  }
}

/** deriveOrderConsumption stand-in (called at placement): SKU picks → sale_consumption per batch (consume_sku);
 *  dishes → the recipe version written on each order line (consume_order), no batch. */
async function fakeConsume(c: Queryable, orderId: string) {
  const o = (await c.query<{ outlet_id: string; pricing_snapshot: any; business_date: string }>(
    `SELECT outlet_id, pricing_snapshot, business_date::text AS business_date FROM core."order" WHERE id = $1`, [orderId])).rows[0]!;
  const src = `core.order:${orderId}`;
  await underRule(c, "inventory.consume_sku", src, async () => {
    for (const p of o.pricing_snapshot.picks as Array<{ batch_id: string; ingredient_id: string; qty_milli: number }>) {
      await c.query(`INSERT INTO core.stock_movement (tenant_id, id, outlet_id, ingredient_id, batch_id, qty_milli, unit, kind, ref_type, ref_id)
                     VALUES (current_setting('app.tenant_id')::uuid, $1, $2, $3, $4, $5, 'pc', 'sale_consumption', 'core.order', $6)`,
        [uuidv7(), o.outlet_id, p.ingredient_id, p.batch_id, -p.qty_milli, orderId]);
    }
  });
  const recipe = (await c.query<{ ingredient_id: string; unit: string; qty: string }>(
    `SELECT rl.ingredient_id, rl.unit, sum(round(rl.qty_milli::numeric * l.qty_milli / rv.yield_qty_milli)) AS qty
       FROM core.order_line l JOIN core.item i ON i.tenant_id = l.tenant_id AND i.id = l.item_id AND i.kind = 'dish'
       JOIN core.recipe_version rv ON rv.tenant_id = l.tenant_id AND rv.id = l.recipe_version_id
       JOIN core.recipe_line rl ON rl.tenant_id = rv.tenant_id AND rl.recipe_version_id = rv.id
      WHERE l.order_id = $1 GROUP BY rl.ingredient_id, rl.unit`, [orderId])).rows;
  await underRule(c, "inventory.consume_order", src, async () => {
    for (const r of recipe) {
      await c.query(`INSERT INTO core.stock_movement (tenant_id, id, outlet_id, ingredient_id, qty_milli, unit, kind, ref_type, ref_id)
                     VALUES (current_setting('app.tenant_id')::uuid, $1, $2, $3, $4, $5, 'sale_consumption', 'core.order', $6)`,
        [uuidv7(), o.outlet_id, r.ingredient_id, -Number(r.qty), r.unit, orderId]);
    }
  });
}

async function loyaltyEntry(c: Queryable, customerId: string, kind: string, points: number, orderId: string, reverses: string | null) {
  await c.query(`SELECT 1 FROM core.customer WHERE id = $1 FOR UPDATE`, [customerId]);
  const last = (await c.query<{ seq: string; bal: string }>(
    `SELECT seq, balance_after AS bal FROM core.loyalty_entry WHERE customer_id = $1 ORDER BY seq DESC LIMIT 1`, [customerId])).rows[0];
  const id = uuidv7();
  await c.query(`INSERT INTO core.loyalty_entry (tenant_id, id, customer_id, seq, kind, points, balance_after, order_id, reverses_id)
                 VALUES (current_setting('app.tenant_id')::uuid, $1, $2, $3, $4, $5, $6, $7, $8)`,
    [id, customerId, Number(last?.seq ?? 0) + 1, kind, points, Number(last?.bal ?? 0) + points, orderId, reverses]);
  return id;
}

/** Fake rate: 1 point = 100 minor units. Earn: 1 point per 100 minor units of the order total. */
export const POINT_MINOR = 100;

export const FAKES: OrderSeams = {
  priceLines: fakePriceLines,
  pickSaleBatches: fakePick,
  deriveOrderConsumption: fakeConsume,
  async loyaltyRedeem(c, orderId, points) {
    const cust = (await c.query<{ customer_id: string }>(`SELECT customer_id FROM core."order" WHERE id = $1`, [orderId])).rows[0]!.customer_id;
    return { entry_id: await loyaltyEntry(c, cust, "redeem", -points, orderId, null), value_minor: points * POINT_MINOR };
  },
  async loyaltyEarnFor(c, orderId) {
    const o = (await c.query<{ customer_id: string; total_minor: string }>(`SELECT customer_id, total_minor FROM core."order" WHERE id = $1`, [orderId])).rows[0]!;
    const pts = Math.floor(Number(o.total_minor) / POINT_MINOR);
    if (pts > 0) await underRule(c, "customers.loyalty_earn", `core.order:${orderId}`, () => loyaltyEntry(c, o.customer_id, "earn", pts, orderId, null));
  },
  async loyaltyReverseFor(c, orderId) {
    const r = (await c.query<{ id: string; customer_id: string; points: string }>(
      `SELECT id, customer_id, points FROM core.loyalty_entry WHERE order_id = $1 AND kind = 'redeem'`, [orderId])).rows;
    for (const e of r) await underRule(c, "customers.loyalty_reverse", `core.order:${orderId}`, () => loyaltyEntry(c, e.customer_id, "reverse", -Number(e.points), orderId, e.id));
  },
  async postFor(c, rule, source) {
    postCalls.push({ rule, source });
    if (rule !== "finance.post_order") return;
    const id = source.split(":")[1]!;
    const o = (await c.query<{ outlet_id: string; total_minor: string; currency: string }>(`SELECT outlet_id, total_minor, currency FROM core."order" WHERE id = $1`, [id])).rows[0]!;
    const acct = (await c.query<{ id: string; code: string }>(`SELECT id, code FROM core.account WHERE code IN ('1000', '4000')`)).rows;
    const entry = uuidv7();
    await underRule(c, rule, source, async () => {
      await c.query(`INSERT INTO core.journal_entry (tenant_id, id, outlet_id, entry_date, source_type, source_id, posting_rule, memo_key)
                     VALUES (current_setting('app.tenant_id')::uuid, $1, $2, current_date, 'core.order', $3, $4, 'finance.memo.sale')`, [entry, o.outlet_id, id, rule]);
      for (const [code, sign] of [["1000", 1], ["4000", -1]] as const) {
        await c.query(`INSERT INTO core.posting (tenant_id, id, journal_entry_id, account_id, amount_minor, currency) VALUES (current_setting('app.tenant_id')::uuid, $1, $2, $3, $4, $5)`,
          [uuidv7(), entry, acct.find((a) => a.code === code)!.id, sign * Number(o.total_minor), o.currency]);
      }
    });
  },
  async createTicketsFor() {
    return { applicable: false, events: [], audit: [] };
  },
  async consumeExpiredOverrides() {
    return [];
  },
};
export const postCalls: Array<{ rule: string; source: string }> = [];

/** Installs the fakes (kitchen too: T-022's gates test orders, not the kitchen lane's tickets).
 *  ORDERS_REAL_PRICING=1 keeps the catalogue lane's landed priceLines instead of the fake (integration run). */
export const installFakes = (extra: Partial<OrderSeams> = {}) => {
  const { priceLines, ...rest } = FAKES;
  return setOrderSeams({ ...rest, ...(process.env.ORDERS_REAL_PRICING ? {} : { priceLines }), ...extra });
};

/** A place.v1 payload for outlet 1 / the world's counter channel / device 1. */
export function placePayload(env: Env, lines: Array<{ item: string; qty?: number; options?: string[] }>, extra: Record<string, unknown> = {}) {
  return {
    order_id: uuidv7(), outlet_id: env.w.outlets[0], channel_id: env.w.channel, brand_id: null, device_id: env.w.devices[0], kind: "takeaway",
    table_ref: null, pickup_window_id: null, promised_at: null, external_ref: null,
    lines: lines.map((l) => ({ line_id: uuidv7(), item_id: l.item, variant_id: null, option_ids: l.options ?? [], qty_milli: l.qty ?? 1000, barcode: null, note: null })),
    coupon_codes: [], loyalty_redeem_points: 0, preview_total_minor: null, client_totals: null,
    ...extra,
  };
}
