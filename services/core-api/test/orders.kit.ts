// T-022 fixtures: the canonical world (buildWorld) plus a small synthetic menu in outlet 1 and member logins. The
// gates run on the REAL seams (R3-M3): catalogue priceLines, inventory picks / consumption, customers loyalty,
// finance postFor and kitchen tickets, as their owners wrote them. Synthetic data only.
import { createLogger } from "@munim/config";
import { buildWorld, type TestDb, type World } from "@munim/db";
import type { Hono } from "hono";
import type pg from "pg";
import { type AppEnv, createApp, TENANT_HEADER } from "../src/app.ts";
import { uuidv7 } from "../src/commit/index.ts";
import { createLocalIdp } from "../src/auth/local-idp.ts";
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
    // The world's paneer tikka carries one variant; with it active the item sells only as that variant (catalogue's
    // sellable rule). The gates sell the bare item, so the variant is retired.
    await cmd("catalogue.item.upsert.v1");
    await c.query(`UPDATE core.variant SET active = false WHERE item_id = $1`, [w.item]);
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
  // customers' earn skips guest profiles (T-028 INFERENCE): the world customer is a signed-up one.
  await db.withContext("munim_core", { ...owner, command_type: "customers.customer.upsert.v1" }, (c) =>
    c.query(`UPDATE core.customer SET is_guest = false, idp_sub = 'cust-sub' WHERE id = $1`, [w.customer]));
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
