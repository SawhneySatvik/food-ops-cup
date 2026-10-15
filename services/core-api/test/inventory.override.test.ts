// T-024 gate — R40 C7 expired-sale override where the country pack ALLOWS it. This file's database clone gets a
// test-only IN pack version 3 identical to the seeded one except `expired_sale_override: true` (the real IN and AU
// packs keep false; inventory.test.ts proves the refusal there). Then: staff cannot issue (403, 0 rows); a manager
// issues one for one cart line and batch; the pick draws the expired batch for THAT line only; placement consumes
// it once and the movement cites it; a second use is refused by the database (MB005). Synthetic data only.
import { createLogger } from "@munim/config";
import { PACKS } from "@munim/contracts/packs";
import { buildWorld, type TestDb } from "@munim/db";
import type { Hono } from "hono";
import type pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { type AppEnv, createApp, TENANT_HEADER } from "../src/app.ts";
import { type CommandHandler, executeCommand, uuidv7 } from "../src/commit/index.ts";
import { consumeExpiredOverrides, deriveOrderConsumption, pickSaleBatches } from "../src/modules/inventory/index.ts";
import { createLocalIdp } from "../src/auth/local-idp.ts";
import { openDb } from "./db.ts";

const idp = createLocalIdp();
let db: TestDb;
let pools: { core: pg.Pool; svc: pg.Pool };
let app: Hono<AppEnv>;
const u = uuidv7;
const T = {
  tenant: "", owner: "", staff: "", mgr1: u(), channel: "", currency: "", outlets: ["", "", ""] as [string, string, string],
  subs: { owner: `owner-${u()}`, staff: `staff-${u()}`, mgr1: `mgr1-${u()}` },
  jam: u(), jamSku: u(), expired: u(), fresh: u(), override: u(), cartLine: u(),
};
type Who = keyof typeof T.subs;
const own = (command_type: string) => ({ tenant_id: T.tenant, outlet_ids: "*" as const, role: "owner" as const, member_id: T.owner, command_type });
type Res = Omit<Response, "json"> & { json(): Promise<any> };
const call = async (method: string, path: string, who: Who, body?: unknown): Promise<Res> =>
  (await app.request(path, {
    method,
    headers: { Authorization: `Bearer ${idp.sign({ sub: T.subs[who] })}`, [TENANT_HEADER]: T.tenant, "Content-Type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  })) as Res;
const env = (type: string, payload: unknown) => ({ command_id: u(), idempotency_key: `k-${u()}`, type, payload });
const num = async (sql: string, params: unknown[] = []) => Number((await db.admin(sql, params)).rows[0]!.n);
const issue = (who: Who, override_id: string, cart_line_id: string, qty_milli = 1000) =>
  call("POST", "/v1/inventory/expired-sale-overrides", who, env("inventory.expired_sale.override.v1", {
    override_id, outlet_id: T.outlets[0], cart_line_id, batch_id: T.expired, qty_milli, reason_code: "staff_meal", note: "Eaten by staff the same day" }));

beforeAll(async () => {
  db = await openDb();
  // Test-only pack version (this clone only): the seeded IN document with the override allowed.
  // One above whatever version the repo's pack carries (the seeded one), so it is the version in force.
  const v2 = { ...PACKS.IN, version: PACKS.IN!.version + 1, expired_sale_override: true };
  await db.admin(`INSERT INTO platform.country_pack (code, version, effective_from, doc, status) VALUES ('IN', $2, '2026-01-01', $1, 'active')`, [JSON.stringify(v2), v2.version]);
  const w = await buildWorld(db);
  Object.assign(T, { tenant: w.tenant, owner: w.owner, staff: w.staff, outlets: w.outlets, channel: w.channel, currency: w.currency });
  await db.withContext("munim_core", own("tenancy.member.invite.v1"), async (c) => {
    await c.query(`UPDATE core.member SET idp_sub = $2 WHERE id = $1`, [T.owner, T.subs.owner]);
    await c.query(`UPDATE core.member SET idp_sub = $2 WHERE id = $1`, [T.staff, T.subs.staff]);
    await c.query(`INSERT INTO core.member (tenant_id, id, idp_sub, name, email) VALUES ($1, $2, $3, 'Synthetic mgr1', 'mgr1@example.test')`, [T.tenant, T.mgr1, T.subs.mgr1]);
    await c.query(`INSERT INTO core.membership (tenant_id, member_id, role, outlet_ids) VALUES ($1, $2, 'manager', $3)`, [T.tenant, T.mgr1, [T.outlets[0]]]);
  });
  await db.withContext("munim_core", own("inventory.ingredient.upsert.v1"), (c) =>
    c.query(`INSERT INTO core.ingredient (tenant_id, id, name, base_unit, tracked_by_batch) VALUES ($1, $2, 'Jam jar', 'unit', true)`, [T.tenant, T.jam]));
  await db.withContext("munim_core", own("catalogue.item.upsert.v1"), (c) =>
    c.query(`INSERT INTO core.item (tenant_id, id, kind, name_key, category, stock_ingredient_id) VALUES ($1, $2, 'sku', 'shop.jam', 'shop', $3)`, [T.tenant, T.jamSku, T.jam]));
  pools = { core: db.pool("munim_core", 8), svc: db.pool("munim_svc", 2) };
  const config = { nodeEnv: "test", redact: (s: string) => s };
  app = await createApp({ pools, idp, storefronts: async () => null, config, log: createLogger(config, () => {}) });
  // Jam at outlet 1: 5 jars expired (2020-01-01), 2 fresh (2099).
  const r = await call("POST", "/v1/inventory/stock:receive", "owner", env("inventory.stock.receive.v1", {
    outlet_id: T.outlets[0], source: "opening", at: "2026-10-01T09:00:00+05:30", lines: [
      { movement_id: u(), ingredient_id: T.jam, batch_id: T.expired, batch: { batch_code: "JAM-OLD", expires_on: "2020-01-01", mrp_minor: null }, qty_milli: 5000, unit: "unit", unit_cost: { amount_minor: 1000, currency: T.currency } },
      { movement_id: u(), ingredient_id: T.jam, batch_id: T.fresh, batch: { batch_code: "JAM-NEW", expires_on: "2099-01-01", mrp_minor: null }, qty_milli: 2000, unit: "unit", unit_cost: { amount_minor: 1000, currency: T.currency } },
    ] }));
  expect(r.status).toBe(200);
}, 180_000);

afterAll(async () => {
  await pools?.core.end();
  await pools?.svc.end();
  await db?.stop();
});

const pick = (line_id: string, qty_milli: number) =>
  db.withContext("munim_core", own("orders.place.v1"), (c) => pickSaleBatches(c, T.outlets[0], [{ line_id, item_id: T.jamSku, qty_milli }]));

describe("expired-sale override with the pack flag true", () => {
  it("staff cannot issue one (owner/manager only) → 403, 0 rows", async () => {
    const r = await issue("staff", u(), T.cartLine);
    expect(r.status).toBe(403);
    expect(await num(`SELECT count(*) AS n FROM core.expired_sale_override WHERE tenant_id = $1 AND batch_id = $2`, [T.tenant, T.expired])).toBe(0);
  });

  it("a fresh (unexpired) batch needs no override → 400", async () => {
    const r = await call("POST", "/v1/inventory/expired-sale-overrides", "mgr1", env("inventory.expired_sale.override.v1", {
      override_id: u(), outlet_id: T.outlets[0], cart_line_id: T.cartLine, batch_id: T.fresh, qty_milli: 1000, reason_code: "staff_meal", note: "x" }));
    expect(r.status).toBe(400);
  });

  it("a manager issues one for one cart line, as themselves, unused", async () => {
    const r = await issue("mgr1", T.override, T.cartLine);
    expect(r.status).toBe(200);
    const row = (await db.admin(`SELECT decided_by, cart_line_id, batch_id, qty_milli, used_at, order_line_id FROM core.expired_sale_override WHERE tenant_id = $1 AND id = $2`,
      [T.tenant, T.override])).rows[0]!;
    expect([row.decided_by, row.cart_line_id, row.batch_id, Number(row.qty_milli), row.used_at, row.order_line_id]).toEqual([T.mgr1, T.cartLine, T.expired, 1000, null, null]);
  });

  it("the pick: 3 jars on THAT cart line → fresh 2 + expired 1 under the override; another line is still refused", async () => {
    const ok = await pick(T.cartLine, 3000);
    expect(ok.refusals).toEqual([]);
    expect(ok.lines[0]!.picks.map((p) => [p.batch_id, p.qty_milli, p.override_id])).toEqual([[T.fresh, 2000, null], [T.expired, 1000, T.override]]);
    const other = u();
    expect((await pick(other, 3000)).refusals).toEqual([{ line_id: other, reason_code: "expired_batch", batch_id: T.expired }]);
  });

  it("placement consumes it once and the movement cites it; a second use is refused (MB005); the cart line can no longer draw it", async () => {
    const order = u();
    let consumed: string[] = [];
    const handler: CommandHandler = {
      type: "orders.place.v1",
      async run(c) {
        await c.query(`INSERT INTO core."order" (tenant_id, id, outlet_id, channel_id, kind, status, subtotal_minor, tax_minor, total_minor, currency, pricing_snapshot)
                       VALUES ($1, $2, $3, $4, 'takeaway', 'placed', 0, 0, 0, $5, '{}')`, [T.tenant, order, T.outlets[0], T.channel, T.currency]);
        await c.query(`INSERT INTO core.order_line (tenant_id, id, outlet_id, order_id, line_no, item_id, qty_milli, unit_price_minor) VALUES ($1, $2, $3, $4, 1, $5, 3000, 0)`,
          [T.tenant, T.cartLine, T.outlets[0], order, T.jamSku]);
        consumed = await consumeExpiredOverrides(c, order);
        const r = await deriveOrderConsumption(c, order);
        return { entityId: order, audit: [{ entity: "core.order", entityId: order }], events: r.events };
      },
    };
    await executeCommand({ tx: (fn) => db.withContext("munim_core", own("orders.place.v1"), fn), tenantId: T.tenant, actor: { kind: "member", id: T.owner, role: "owner" } },
      env("orders.place.v1", {}) as never, handler);
    expect(consumed).toEqual([T.override]);
    const ov = (await db.admin(`SELECT used_at IS NOT NULL AS used, order_line_id FROM core.expired_sale_override WHERE tenant_id = $1 AND id = $2`, [T.tenant, T.override])).rows[0]!;
    expect([ov.used, ov.order_line_id]).toEqual([true, T.cartLine]);
    const moves = (await db.admin(`SELECT batch_id, qty_milli, expired_sale_override_id FROM core.stock_movement WHERE tenant_id = $1 AND ref_id = $2 ORDER BY qty_milli`, [T.tenant, order])).rows
      .map((m) => [m.batch_id, Number(m.qty_milli), m.expired_sale_override_id]);
    expect(moves).toEqual([[T.fresh, -2000, null], [T.expired, -1000, T.override]]);

    const again = await db.withContext("munim_core", own("orders.place.v1"), (c) =>
      c.query(`UPDATE core.expired_sale_override SET used_at = now() WHERE id = $1`, [T.override])).catch((e: { code?: string }) => e.code);
    expect(again).toBe("MB005");
    // Fresh stock is gone (2 sold); 4 expired jars remain and the used override no longer covers this line.
    expect((await pick(T.cartLine, 1000)).refusals).toEqual([{ line_id: T.cartLine, reason_code: "expired_batch", batch_id: T.expired }]);
  });
});
