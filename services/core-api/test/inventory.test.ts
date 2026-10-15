// T-024 gates — the inventory module through the real app and its seams (member auth → withContext → RLS → book
// guard; derived movements under their seeded rule):
//   on-hand after 50 fixture orders = hand values (45 placed, 5 cancelled and refused); consumption refused for
//   an order outside the rule's source_state (0 movements) / accepted for a placed one; FEFO through the seam and
//   the pick's business date = the order row's; sale above MRP refused (batch MRP when picked, item MRP otherwise,
//   tax-inclusive per the IN pack) with accept pairs; expired batch refused; an override with the pack flag false
//   (IN default) → out_of_pack_scope and 0 rows; waste, count, transfer (both ends), reorder level, batch update,
//   GRN receipt (kg → g), sale return. Synthetic data only.
// Every expected number is written by hand in this file (the arithmetic is in the comments), never derived from
// the code under test. The override with the flag TRUE is in inventory.override.test.ts (its own pack row).
import { createLogger } from "@munim/config";
import { CommandResult } from "@munim/contracts";
import { InventoryBatchesResponse, InventoryMovementsResponse, InventoryReorderLevelsResponse } from "@munim/contracts/inventory";
import { buildWorld, type TestDb } from "@munim/db";
import type { Hono } from "hono";
import type pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { type AppEnv, createApp, TENANT_HEADER } from "../src/app.ts";
import { type CommandHandler, executeCommand, uuidv7 } from "../src/commit/index.ts";
import { ApiError } from "../src/lib/errors.ts";
import { draftHandler } from "../src/modules/approvals/handlers.ts";
import {
  type ConsumptionResult, consumeExpiredOverrides, deriveGoodsReceipt, deriveOrderConsumption, deriveSaleReturn, onNegativeOnHand, pickSaleBatches,
} from "../src/modules/inventory/index.ts";
import { createLocalIdp } from "../src/auth/local-idp.ts";
import { openDb } from "./db.ts";

const idp = createLocalIdp();
let db: TestDb;
let pools: { core: pg.Pool; svc: pg.Pool };
let app: Hono<AppEnv>;

const u = uuidv7;
const T = {
  tenant: "", owner: "", staff: "", mgr1: u(), channel: "", currency: "", supplier: "",
  outlets: ["", "", ""] as [string, string, string],
  subs: { owner: `owner-${u()}`, staff: `staff-${u()}`, mgr1: `mgr1-${u()}` },
  // Fresh stock records (the world's Paneer already has receipts, waste and counts).
  rice: u(), chicken: u(), oil: u(), biscuit: u(), milk: u(), soap: u(), tea: u(), jam: u(), honey: u(),
  biryani: u(), extraChicken: u(), biscuitSku: u(), milkSku: u(), soapSku: u(), teaSku: u(), jamSku: u(), honeySku: u(),
  bOld: u(), bNew: u(), soapB1: u(), soapB2: u(), teaB: u(), jamExpired: u(), jamFresh: u(),
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
const env = (type: string, payload: unknown, key = `k-${u()}`) => ({ command_id: u(), idempotency_key: key, type, payload });
const one = async <R extends pg.QueryResultRow>(sql: string, params: unknown[] = []) => (await db.admin(sql, params)).rows[0] as R;
const num = async (sql: string, params: unknown[] = []) => Number((await one<{ n: string }>(sql, params)).n);
const onHand = (outlet: string, ingredient: string) =>
  num(`SELECT coalesce(sum(qty_milli), 0) AS n FROM core.stock_movement WHERE tenant_id = $1 AND outlet_id = $2 AND ingredient_id = $3`, [T.tenant, outlet, ingredient]);
const batchLeft = (batch: string) => num(`SELECT coalesce(sum(qty_milli), 0) AS n FROM core.stock_movement WHERE tenant_id = $1 AND batch_id = $2`, [T.tenant, batch]);

type PlaceLine = { item: string; qty: number; options?: string[]; line_id?: string; recipe?: string };
/** Stand-in for T-022's orders.place.v1: inserts the order and lines, then calls THE SEAMS in the same transaction
 *  (consumeExpiredOverrides, deriveOrderConsumption) and returns their events. */
async function place(lines: PlaceLine[], o: { outlet?: string; status?: string; derive?: boolean } = {}): Promise<{ order: string; result: ConsumptionResult | null }> {
  const order = u();
  const outlet = o.outlet ?? T.outlets[0];
  let result: ConsumptionResult | null = null;
  const handler: CommandHandler = {
    type: "orders.place.v1",
    async run(c) {
      await c.query(
        `INSERT INTO core."order" (tenant_id, id, outlet_id, channel_id, kind, status, subtotal_minor, tax_minor, total_minor, currency, pricing_snapshot)
         VALUES ($1, $2, $3, $4, 'takeaway', $5, 1000, 0, 1000, $6, '{}')`, [T.tenant, order, outlet, T.channel, o.status ?? "placed", T.currency]);
      for (const [i, l] of lines.entries()) {
        await c.query(`INSERT INTO core.order_line (tenant_id, id, outlet_id, order_id, line_no, item_id, options, qty_milli, unit_price_minor, recipe_version_id)
                       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 1000, $9)`,
          [T.tenant, l.line_id ?? u(), outlet, order, i + 1, l.item, JSON.stringify(l.options ?? []), l.qty, l.recipe ?? null]);
      }
      if (o.derive !== false) {
        await consumeExpiredOverrides(c, order);
        result = await deriveOrderConsumption(c, order);
      }
      return { entityId: order, audit: [{ entity: "core.order", entityId: order }], events: result?.events ?? [] };
    },
  };
  await executeCommand({ tx: (fn) => db.withContext("munim_core", own("orders.place.v1"), fn), tenantId: T.tenant, actor: { kind: "member", id: T.owner, role: "owner" } },
    env("orders.place.v1", {}) as never, handler);
  return { order, result };
}

beforeAll(async () => {
  db = await openDb();
  const w = await buildWorld(db);
  Object.assign(T, { tenant: w.tenant, owner: w.owner, staff: w.staff, outlets: w.outlets, channel: w.channel, currency: w.currency, supplier: w.supplier });
  await db.withContext("munim_core", own("tenancy.member.invite.v1"), async (c) => {
    await c.query(`UPDATE core.member SET idp_sub = $2 WHERE id = $1`, [T.owner, T.subs.owner]);
    await c.query(`UPDATE core.member SET idp_sub = $2 WHERE id = $1`, [T.staff, T.subs.staff]);
    await c.query(`INSERT INTO core.member (tenant_id, id, idp_sub, name, email) VALUES ($1, $2, $3, 'Synthetic mgr1', 'mgr1@example.test')`, [T.tenant, T.mgr1, T.subs.mgr1]);
    await c.query(`INSERT INTO core.membership (tenant_id, member_id, role, outlet_ids) VALUES ($1, $2, 'manager', $3)`, [T.tenant, T.mgr1, [T.outlets[0]]]);
  });
  pools = { core: db.pool("munim_core", 8), svc: db.pool("munim_svc", 2) };
  const config = { nodeEnv: "test", redact: (s: string) => s };
  app = await createApp({ pools, idp, storefronts: async () => null, config, log: createLogger(config, () => {}) });

  // Stock records through the module's own route (owner, all outlets).
  const ingredients: Array<[string, string, string, boolean]> = [
    [T.rice, "Rice", "g", false], [T.chicken, "Chicken", "g", false], [T.oil, "Oil", "ml", false], [T.biscuit, "Biscuits 200 g", "unit", true],
    [T.milk, "Milk 500 ml", "unit", false], [T.soap, "Soap bar", "unit", true], [T.tea, "Tea 250 g", "unit", true], [T.jam, "Jam jar", "unit", true],
    [T.honey, "Honey jar", "unit", false],
  ];
  for (const [id, name, base_unit, tracked_by_batch] of ingredients) {
    const r = await call("POST", "/v1/inventory/ingredients", "owner", env("inventory.ingredient.upsert.v1", { ingredient_id: id, name, base_unit, shelf_life_days: null, tracked_by_batch }));
    expect(r.status).toBe(200);
  }
  // Catalogue fixtures (catalogue is T-021's; written here under its seeded commands): a dish with a recipe in
  // force (v1) and a future one (v2, must NOT be used), an option adding chicken, and SKUs 1:1 on their stock records.
  const rv1 = u(); const rv2 = u(); const grp = u();
  await db.withContext("munim_core", own("catalogue.item.upsert.v1"), async (c) => {
    await c.query(`INSERT INTO core.item (tenant_id, id, kind, name_key, category) VALUES ($1, $2, 'dish', 'menu.biryani', 'mains')`, [T.tenant, T.biryani]);
    await c.query(`INSERT INTO core.option_group (tenant_id, id, item_id, name_key, max_select) VALUES ($1, $2, $3, 'menu.extras', 2)`, [T.tenant, grp, T.biryani]);
    await c.query(`INSERT INTO core.option (tenant_id, id, option_group_id, name_key, price_delta_minor, currency) VALUES ($1, $2, $3, 'menu.extras.chicken', 4000, $4)`,
      [T.tenant, T.extraChicken, grp, T.currency]);
    await c.query(`INSERT INTO core.option_ingredient_delta (tenant_id, id, option_id, ingredient_id, qty_milli, unit) VALUES ($1, $2, $3, $4, 50000, 'g')`, [T.tenant, u(), T.extraChicken, T.chicken]);
    for (const [id, ing, key, mrp] of [[T.biscuitSku, T.biscuit, "shop.biscuits", null], [T.milkSku, T.milk, "shop.milk", null], [T.soapSku, T.soap, "shop.soap", 5000],
      [T.teaSku, T.tea, "shop.tea", 5000], [T.jamSku, T.jam, "shop.jam", null], [T.honeySku, T.honey, "shop.honey", 3000]] as const) {
      await c.query(`INSERT INTO core.item (tenant_id, id, kind, name_key, category, stock_ingredient_id, mrp_minor, currency) VALUES ($1, $2, 'sku', $3, 'shop', $4, $5, $6)`,
        [T.tenant, id, key, ing, mrp, mrp === null ? null : T.currency]);
    }
  });
  await db.withContext("munim_core", own("catalogue.recipe.version.create.v1"), async (c) => {
    await c.query(`INSERT INTO core.recipe_version (tenant_id, id, item_id, version, valid_from, valid_to, yield_qty_milli) VALUES ($1, $2, $3, 1, '2026-01-01', '2099-01-01', 1000)`, [T.tenant, rv1, T.biryani]);
    await c.query(`INSERT INTO core.recipe_version (tenant_id, id, item_id, version, valid_from, yield_qty_milli) VALUES ($1, $2, $3, 2, '2099-01-01', 1000)`, [T.tenant, rv2, T.biryani]);
    // v1 per portion: rice 200 g; chicken 150 g + 10% waste = 165 g; oil 20 ml.
    for (const [ing, qty, unit, waste] of [[T.rice, 200000, "g", 0], [T.chicken, 150000, "g", 1000], [T.oil, 20000, "ml", 0]] as const) {
      await c.query(`INSERT INTO core.recipe_line (tenant_id, id, recipe_version_id, ingredient_id, qty_milli, unit, waste_pct_bp) VALUES ($1, $2, $3, $4, $5, $6, $7)`, [T.tenant, u(), rv1, ing, qty, unit, waste]);
    }
    await c.query(`INSERT INTO core.recipe_line (tenant_id, id, recipe_version_id, ingredient_id, qty_milli, unit) VALUES ($1, $2, $3, $4, 999000, 'g')`, [T.tenant, u(), rv2, T.rice]);
  });

  // Opening stock through the module's route (outlet 1): rice 50 kg given in kg (→ g), chicken 20 000 g, oil 5 l
  // (→ ml), biscuits in two dated batches (old 12, new 24), milk 40, soap (MRP batches), tea (no batch MRP),
  // jam: one expired batch (5) and one fresh (2). Honey: untracked SKU, no stock at all.
  const line = (ingredient_id: string, qty_milli: number, unit: string, cost: number, batch_id: string | null = null, batch: unknown = null) =>
    ({ movement_id: u(), ingredient_id, batch_id, batch, qty_milli, unit, unit_cost: { amount_minor: cost, currency: T.currency } });
  const r = await call("POST", "/v1/inventory/stock:receive", "owner", env("inventory.stock.receive.v1", {
    outlet_id: T.outlets[0], source: "opening", at: "2026-10-01T09:00:00+05:30",
    lines: [
      line(T.rice, 50000, "kg", 9000), line(T.chicken, 20000000, "g", 30), line(T.oil, 5000, "l", 15000),
      line(T.biscuit, 12000, "unit", 2500, T.bOld, { batch_code: "BIS-OLD", expires_on: "2099-03-01", mrp_minor: null }),
      line(T.biscuit, 24000, "unit", 2500, T.bNew, { batch_code: "BIS-NEW", expires_on: "2099-06-01", mrp_minor: null }),
      line(T.milk, 40000, "unit", 2600),
      line(T.soap, 3000, "unit", 3000, T.soapB1, { batch_code: "SOAP-1", expires_on: "2099-01-01", mrp_minor: 4500 }),
      line(T.soap, 9000, "unit", 3000, T.soapB2, { batch_code: "SOAP-2", expires_on: "2099-02-01", mrp_minor: null }),
      line(T.tea, 9000, "unit", 3000, T.teaB, { batch_code: "TEA-1", expires_on: "2099-01-01", mrp_minor: null }),
      line(T.jam, 5000, "unit", 1000, T.jamExpired, { batch_code: "JAM-OLD", expires_on: "2020-01-01", mrp_minor: null }),
      line(T.jam, 2000, "unit", 1000, T.jamFresh, { batch_code: "JAM-NEW", expires_on: "2099-01-01", mrp_minor: null }),
    ],
  }));
  expect(r.status).toBe(200);
}, 180_000);

afterAll(async () => {
  await pools?.core.end();
  await pools?.svc.end();
  await db?.stop();
});

describe("opening stock", () => {
  it("is in the base unit: 50 kg rice = 50 000 000 milli-g at 9 per g (9000 / 1000); 5 l oil = 5 000 000 milli-ml", async () => {
    expect(await onHand(T.outlets[0], T.rice)).toBe(50_000_000);
    expect(await onHand(T.outlets[0], T.oil)).toBe(5_000_000);
    const m = await one<{ unit: string; unit_cost_minor: string; origin: { kind: string; command_type: string } }>(
      `SELECT unit, unit_cost_minor, origin FROM core.stock_movement WHERE tenant_id = $1 AND ingredient_id = $2`, [T.tenant, T.rice]);
    expect([m.unit, Number(m.unit_cost_minor), m.origin.kind, m.origin.command_type]).toEqual(["g", 9, "command", "inventory.stock.receive.v1"]);
  });
  it("R2-S2-8: 12.5 kg received at ₹14.99/kg keeps its exact cost per 1000 g (1,499), valued 18,738 — not 1 paise/g (12,500)", async () => {
    const dal = u();
    expect((await call("POST", "/v1/inventory/ingredients", "owner", env("inventory.ingredient.upsert.v1", { ingredient_id: dal, name: "Dal (synthetic)", base_unit: "g", shelf_life_days: null, tracked_by_batch: false }))).status).toBe(200);
    expect((await call("POST", "/v1/inventory/stock:receive", "owner", env("inventory.stock.receive.v1", { outlet_id: T.outlets[0], source: "opening", at: "2026-10-01T09:00:00+05:30",
      lines: [{ movement_id: u(), ingredient_id: dal, batch_id: null, batch: null, qty_milli: 12_500, unit: "kg", unit_cost: { amount_minor: 1499, currency: T.currency } }] }))).status).toBe(200);
    const m = await one<{ q: string; per1000: string; per1: string; value: string }>(
      `SELECT qty_milli::text AS q, unit_cost_per_1000_minor::text AS per1000, unit_cost_minor::text AS per1,
              round(qty_milli * unit_cost_per_1000_minor / 1000000.0)::text AS value FROM core.stock_movement WHERE tenant_id = $1 AND ingredient_id = $2`, [T.tenant, dal]);
    expect([Number(m.q), Number(m.per1000), Number(m.per1), Number(m.value)]).toEqual([12_500_000, 1499, 1, 18738]);
    const read = InventoryMovementsResponse.parse(await (await call("GET", `/v1/inventory/movements?outlet=${T.outlets[0]}&ingredient=${dal}`, "owner")).json());
    expect(read.movements.map((x) => [x.unit_cost?.amount_minor, x.unit_cost_per_1000?.amount_minor])).toEqual([[1, 1499]]);
  });

  it("untracked stock with a batch is refused; tracked stock without one is refused", async () => {
    const bad1 = await call("POST", "/v1/inventory/stock:receive", "owner", env("inventory.stock.receive.v1", { outlet_id: T.outlets[0], source: "opening", at: "2026-10-01T09:00:00+05:30",
      lines: [{ movement_id: u(), ingredient_id: T.rice, batch_id: u(), batch: { batch_code: "X", expires_on: null, mrp_minor: null }, qty_milli: 1000, unit: "g", unit_cost: { amount_minor: 9, currency: T.currency } }] }));
    const bad2 = await call("POST", "/v1/inventory/stock:receive", "owner", env("inventory.stock.receive.v1", { outlet_id: T.outlets[0], source: "opening", at: "2026-10-01T09:00:00+05:30",
      lines: [{ movement_id: u(), ingredient_id: T.biscuit, batch_id: null, batch: null, qty_milli: 1000, unit: "unit", unit_cost: { amount_minor: 9, currency: T.currency } }] }));
    expect([bad1.status, bad2.status]).toEqual([400, 400]);
  });
});

describe("on-hand after 50 fixture orders = hand values", () => {
  let lastPlaced: string;
  let cancelled: string[] = [];
  beforeAll(async () => {
    // 1–20: one biryani. 21–30: two biryani with extra chicken. 31–40: three biscuit packets. 41–45: one biryani
    // and two milk. 46–50: cancelled before consumption (inserted, never derived; derivation attempted below).
    for (let i = 1; i <= 50; i++) {
      if (i <= 20) lastPlaced = (await place([{ item: T.biryani, qty: 1000 }])).order;
      else if (i <= 30) await place([{ item: T.biryani, qty: 2000, options: [T.extraChicken] }]);
      else if (i <= 40) await place([{ item: T.biscuitSku, qty: 3000 }]);
      else if (i <= 45) await place([{ item: T.biryani, qty: 1000 }, { item: T.milkSku, qty: 2000 }]);
      else cancelled.push((await place([{ item: T.biryani, qty: 1000 }, { item: T.biscuitSku, qty: 1000 }], { status: "cancelled", derive: false })).order);
    }
    for (const order of cancelled) {
      await expect(db.withContext("munim_core", own("orders.place.v1"), (c) => deriveOrderConsumption(c, order))).rejects.toMatchObject({ code: "book_write_refused" });
    }
  }, 180_000);

  it("rice: 50 000 000 − (20×200 000 + 10×400 000 + 5×200 000 = 9 000 000) = 41 000 000", async () => {
    expect(await onHand(T.outlets[0], T.rice)).toBe(41_000_000);
  });
  it("chicken: 20 000 000 − (20×165 000 + 10×2×(165 000 + 50 000) + 5×165 000 = 8 425 000) = 11 575 000", async () => {
    expect(await onHand(T.outlets[0], T.chicken)).toBe(11_575_000);
  });
  it("oil: 5 000 000 − (20×20 000 + 10×40 000 + 5×20 000 = 900 000) = 4 100 000", async () => {
    expect(await onHand(T.outlets[0], T.oil)).toBe(4_100_000);
  });
  it("biscuits: 36 000 − 10×3 000 = 6 000, FEFO: old batch 12 000 → 0, new 24 000 → 6 000", async () => {
    expect(await onHand(T.outlets[0], T.biscuit)).toBe(6_000);
    expect([await batchLeft(T.bOld), await batchLeft(T.bNew)]).toEqual([0, 6_000]);
  });
  it("milk: 40 000 − 5×2 000 = 30 000", async () => {
    expect(await onHand(T.outlets[0], T.milk)).toBe(30_000);
  });
  it("movements: 20×3 + 10×3 + 10×1 + 5×4 = 120 sale_consumption rows, each derived under its rule from its order", async () => {
    const rows = (await db.admin(`SELECT origin->>'kind' AS k, origin->>'rule_id' AS r, count(*) AS n FROM core.stock_movement
                                   WHERE tenant_id = $1 AND kind = 'sale_consumption' AND ingredient_id = ANY ($2) GROUP BY 1, 2 ORDER BY 2`,
      [T.tenant, [T.rice, T.chicken, T.oil, T.biscuit, T.milk]])).rows.map((x) => [x.k, x.r, Number(x.n)]);
    // consume_order: 20×3 + 10×3 + 5×3 = 105; consume_sku: 10 biscuit + 5 milk = 15.
    expect(rows).toEqual([["derivation", "inventory.consume_order", 105], ["derivation", "inventory.consume_sku", 15]]);
  });
  it("the 5 cancelled orders were refused (source_state) and wrote 0 movements", async () => {
    expect(await num(`SELECT count(*) AS n FROM core.stock_movement WHERE tenant_id = $1 AND ref_id = ANY ($2)`, [T.tenant, cancelled])).toBe(0);
  });
  it("deriving a placed order twice writes nothing more (idempotent)", async () => {
    const before = await num(`SELECT count(*) AS n FROM core.stock_movement WHERE tenant_id = $1 AND ref_id = $2`, [T.tenant, lastPlaced]);
    const again = await db.withContext("munim_core", own("orders.place.v1"), (c) => deriveOrderConsumption(c, lastPlaced));
    expect([before, again.derived, again.movement_ids.length]).toEqual([3, false, 3]);
  });
});

describe("derivation only for orders in the rule's source_state", () => {
  it("cancelled → refused (book_write_refused), 0 movements; placed → accepted, 3 movements", async () => {
    const { order: c1 } = await place([{ item: T.biryani, qty: 1000 }], { status: "cancelled", derive: false });
    const err = await db.withContext("munim_core", own("orders.place.v1"), (c) => deriveOrderConsumption(c, c1)).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect((err as ApiError).code).toBe("book_write_refused");
    expect(await num(`SELECT count(*) AS n FROM core.stock_movement WHERE tenant_id = $1 AND ref_id = $2`, [T.tenant, c1])).toBe(0);

    const { order: p1 } = await place([{ item: T.biryani, qty: 1000 }], { derive: false });
    const ok = await db.withContext("munim_core", own("orders.place.v1"), (c) => deriveOrderConsumption(c, p1));
    expect([ok.derived, ok.movement_ids.length]).toEqual([true, 3]);
  });
});

describe("pickSaleBatches (the seam T-022 calls at placement)", () => {
  const pick = (lines: Parameters<typeof pickSaleBatches>[2]) => db.withContext("munim_core", own("orders.place.v1"), (c) => pickSaleBatches(c, T.outlets[0], lines));

  it("the pick's business date is the one the order row gets in the same transaction", async () => {
    const [picked, rowDate] = await db.withContext("munim_core", own("orders.place.v1"), async (c) => {
      const p = await pickSaleBatches(c, T.outlets[0], [{ line_id: u(), item_id: T.soapSku, qty_milli: 1000 }]);
      const order = u();
      await c.query(`INSERT INTO core."order" (tenant_id, id, outlet_id, channel_id, kind, status, subtotal_minor, tax_minor, total_minor, currency, pricing_snapshot)
                     VALUES ($1, $2, $3, $4, 'takeaway', 'placed', 0, 0, 0, $5, '{}')`, [T.tenant, order, T.outlets[0], T.channel, T.currency]);
      const r = await c.query<{ d: string }>(`SELECT business_date::text AS d FROM core."order" WHERE id = $1`, [order]);
      throw Object.assign(new Error("rollback"), { out: [p.business_date, r.rows[0]!.d] });
    }).catch((e: { out: [string, string] }) => e.out);
    expect(picked).toBe(rowDate);
  });

  it("FEFO through the database: soap 4 units → SOAP-1 (exp 2099-01-01) 3 000 then SOAP-2 1 000", async () => {
    const L = u();
    const p = await pick([{ line_id: L, line_no: 1, item_id: T.soapSku, qty_milli: 4000 }]);
    expect(p.lines[0]!.picks.map((x) => [x.batch_id, x.qty_milli])).toEqual([[T.soapB1, 3000], [T.soapB2, 1000]]);
    // Flat picks (the brief's shape) carry the line's binding MRP: min(SOAP-1 4500, SOAP-2 none → item 5000) = 4500.
    expect(p.picks.map((x) => [x.line_no, x.line_id, x.batch_id, x.qty_milli, x.mrp_minor, x.expired])).toEqual([[1, L, T.soapB1, 3000, 4500, false], [1, L, T.soapB2, 1000, 4500, false]]);
  });

  describe("sale above MRP refused (IN: MRP is tax-inclusive; goods_exempt 0%, goods_5 = CGST 2.5% + SGST 2.5% per line, half-up)", () => {
    it("batch MRP binds when picked: soap from SOAP-1 (MRP 4500, item 5000) at 4600 → refused; at 4500 → accepted", async () => {
      const [a, b] = [u(), u()];
      const refused = await pick([{ line_id: a, item_id: T.soapSku, qty_milli: 1000, unit_price_minor: 4600, tax_class: "goods_exempt" }]);
      expect(refused.refusals).toEqual([{ line_id: a, reason_code: "price_above_mrp", mrp_minor: 4500 }]);
      const ok = await pick([{ line_id: b, item_id: T.soapSku, qty_milli: 1000, unit_price_minor: 4500, tax_class: "goods_exempt" }]);
      expect([ok.refusals, ok.lines[0]!.mrp_minor]).toEqual([[], 4500]);
    });
    it("tax counts: soap at 4300 + 5% = 4300 + 108 + 108 = 4516 > 4500 → refused; 4285 + 107 + 107 = 4499 → accepted", async () => {
      const [a, b] = [u(), u()];
      expect((await pick([{ line_id: a, item_id: T.soapSku, qty_milli: 1000, unit_price_minor: 4300, tax_class: "goods_5" }])).refusals.map((r) => r.reason_code)).toEqual(["price_above_mrp"]);
      expect((await pick([{ line_id: b, item_id: T.soapSku, qty_milli: 1000, unit_price_minor: 4285, tax_class: "goods_5" }])).refusals).toEqual([]);
    });
    it("a picked batch with no printed MRP → the item MRP binds: tea (TEA-1 null, item 5000) at 5100 → refused; at 4800 → accepted", async () => {
      const [a, b] = [u(), u()];
      expect((await pick([{ line_id: a, item_id: T.teaSku, qty_milli: 1000, unit_price_minor: 5100, tax_class: "goods_exempt" }])).refusals)
        .toEqual([{ line_id: a, reason_code: "price_above_mrp", mrp_minor: 5000 }]);
      expect((await pick([{ line_id: b, item_id: T.teaSku, qty_milli: 1000, unit_price_minor: 4800, tax_class: "goods_exempt" }])).refusals).toEqual([]);
    });
    it("no batch (untracked SKU) → the item MRP: honey (item 3000) at 3100 → refused; at 3000 → accepted", async () => {
      const [a, b] = [u(), u()];
      expect((await pick([{ line_id: a, item_id: T.honeySku, qty_milli: 1000, unit_price_minor: 3100, tax_class: "goods_exempt" }])).refusals.map((r) => r.reason_code)).toEqual(["price_above_mrp"]);
      const ok = await pick([{ line_id: b, item_id: T.honeySku, qty_milli: 1000, unit_price_minor: 3000, tax_class: "goods_exempt" }]);
      expect([ok.refusals, ok.lines[0]!.picks, ok.lines[0]!.mrp_minor]).toEqual([[], [], 3000]);
    });
  });

  it("expired batch refused: jam 2 units come from the fresh batch (no refusal); 3 units need the expired one → expired_batch", async () => {
    const [a, b] = [u(), u()];
    const ok = await pick([{ line_id: a, item_id: T.jamSku, qty_milli: 2000 }]);
    expect([ok.refusals, ok.lines[0]!.picks.map((x) => [x.batch_id, x.qty_milli])]).toEqual([[], [[T.jamFresh, 2000]]]);
    const no = await pick([{ line_id: b, item_id: T.jamSku, qty_milli: 3000 }]);
    expect(no.refusals).toEqual([{ line_id: b, reason_code: "expired_batch", batch_id: T.jamExpired }]);
  });
});

describe("expired-sale override — IN pack flag expired_sale_override = false (the default)", () => {
  it("issuance refused out_of_pack_scope for a manager and the owner; 0 override rows", async () => {
    const before = await num(`SELECT count(*) AS n FROM core.expired_sale_override WHERE tenant_id = $1`, [T.tenant]);
    for (const who of ["mgr1", "owner"] as const) {
      const r = await call("POST", "/v1/inventory/expired-sale-overrides", who, env("inventory.expired_sale.override.v1", {
        override_id: u(), outlet_id: T.outlets[0], cart_line_id: u(), batch_id: T.jamExpired, qty_milli: 1000, reason_code: "staff_meal", note: "Used the same day" }));
      expect(r.status).toBe(422);
      expect((await r.json()).error.code).toBe("out_of_pack_scope");
    }
    expect(await num(`SELECT count(*) AS n FROM core.expired_sale_override WHERE tenant_id = $1`, [T.tenant])).toBe(before);
  });
});

describe("R2-S3-3: consumption follows the recipe version stamped at placement", () => {
  it("v1 (100 g lentils) stamped at placement, then v2 (300 g) takes over from the order's business date: 2 portions consume 200 g, not 600 g", async () => {
    const lentils = u(), dal = u(), v1 = u(), v2 = u();
    expect((await call("POST", "/v1/inventory/ingredients", "owner", env("inventory.ingredient.upsert.v1", { ingredient_id: lentils, name: "Lentils (synthetic)", base_unit: "g", shelf_life_days: null, tracked_by_batch: false }))).status).toBe(200);
    await db.withContext("munim_core", own("catalogue.item.upsert.v1"), (c) =>
      c.query(`INSERT INTO core.item (tenant_id, id, kind, name_key, category) VALUES ($1, $2, 'dish', 'menu.dal_stamp', 'mains')`, [T.tenant, dal]));
    const version = (id: string, n: number, from: string, grams: number) => db.withContext("munim_core", own("catalogue.recipe.version.create.v1"), async (c) => {
      await c.query(`INSERT INTO core.recipe_version (tenant_id, id, item_id, version, valid_from, yield_qty_milli) VALUES ($1, $2, $3, $4, $5, 1000)`, [T.tenant, id, dal, n, from]);
      await c.query(`INSERT INTO core.recipe_line (tenant_id, id, recipe_version_id, ingredient_id, qty_milli, unit) VALUES ($1, $2, $3, $4, $5, 'g')`, [T.tenant, u(), id, lentils, grams * 1000]);
    });
    await version(v1, 1, "2026-01-01", 100);
    const { order } = await place([{ item: dal, qty: 2000, recipe: v1 }], { derive: false });
    const bd = (await one<{ d: string }>(`SELECT business_date::text AS d FROM core."order" WHERE id = $1`, [order])).d;
    // v2 takes over from the order's own business date (W2-R1: v1 closes at v2's start), so v1 is no longer "in force" then.
    await db.withContext("munim_core", own("catalogue.recipe.version.create.v1"), (c) => c.query(`UPDATE core.recipe_version SET valid_to = $2 WHERE id = $1`, [v1, bd]));
    await version(v2, 2, bd, 300);
    const r = await db.withContext("munim_core", own("orders.place.v1"), (c) => deriveOrderConsumption(c, order));
    expect(r.recipe_lines).toEqual([{ line_no: 1, recipe_version_id: v1 }]);
    expect(await num(`SELECT coalesce(sum(qty_milli), 0) AS n FROM core.stock_movement WHERE tenant_id = $1 AND ref_id = $2 AND ingredient_id = $3`, [T.tenant, order, lentils])).toBe(-200_000);
  });
});

describe("waste, counts, transfers, reorder levels, batches", () => {
  it("waste: a waste_log row by the member + a waste movement derived under inventory.record_waste", async () => {
    const id = u();
    const r = await call("POST", "/v1/inventory/waste", "staff", env("inventory.waste.record.v1", {
      waste_id: id, outlet_id: T.outlets[0], ingredient_id: T.rice, batch_id: null, qty_milli: 1_000_000, unit: "g", reason: "overprep", note: null }));
    expect(r.status).toBe(200);
    CommandResult.parse(await r.json());
    const m = await one<{ qty_milli: string; origin: { kind: string; rule_id: string; source_ref: string } }>(
      `SELECT qty_milli, origin FROM core.stock_movement WHERE tenant_id = $1 AND ref_id = $2`, [T.tenant, id]);
    expect([Number(m.qty_milli), m.origin.kind, m.origin.rule_id, m.origin.source_ref]).toEqual([-1_000_000, "derivation", "inventory.record_waste", `core.waste_log:${id}`]);
    // 41 000 000 after the 50 orders, − 200 000 (the accepted placed order above), − 1 000 000 waste = 39 800 000.
    expect(await onHand(T.outlets[0], T.rice)).toBe(39_800_000);
    const ev = await one<{ type: string; data: { kind: string; ref_type: string } }>(`SELECT type, payload->'data' AS data FROM core.outbox WHERE tenant_id = $1 AND aggregateid = $2`, [T.tenant, id]);
    expect([ev.type, ev.data.kind, ev.data.ref_type]).toEqual(["munim.inventory.movement.recorded.v1", "waste", "core.waste_log"]);
  });

  it("a quantity not in the base unit is refused (unit_mismatch)", async () => {
    const r = await call("POST", "/v1/inventory/waste", "owner", env("inventory.waste.record.v1", {
      waste_id: u(), outlet_id: T.outlets[0], ingredient_id: T.rice, batch_id: null, qty_milli: 1000, unit: "kg", reason: "overprep", note: null }));
    expect([r.status, (await r.json()).error.reason_code]).toEqual([400, "unit_mismatch"]);
  });

  it("blind count: expected computed by core, count_adjust = counted − expected (rice 39 300 000 − 39 800 000 = −500 000; biscuit batch exact → none)", async () => {
    const count = u();
    const r = await call("POST", "/v1/inventory/counts", "staff", env("inventory.count.submit.v1", { count_id: count, outlet_id: T.outlets[0], lines: [
      { line_id: u(), ingredient_id: T.rice, batch_id: null, counted_qty_milli: 39_300_000, unit: "g" },
      { line_id: u(), ingredient_id: T.biscuit, batch_id: T.bNew, counted_qty_milli: 6_000, unit: "unit" },
    ] }));
    expect(r.status).toBe(200);
    const lines = (await db.admin(`SELECT ingredient_id, expected_qty_milli, counted_qty_milli FROM core.stock_count_line WHERE tenant_id = $1 AND stock_count_id = $2 ORDER BY counted_qty_milli DESC`,
      [T.tenant, count])).rows.map((x) => [x.ingredient_id, Number(x.expected_qty_milli), Number(x.counted_qty_milli)]);
    expect(lines).toEqual([[T.rice, 39_800_000, 39_300_000], [T.biscuit, 6_000, 6_000]]);
    const adj = (await db.admin(`SELECT ingredient_id, qty_milli, origin->>'command_type' AS cmd FROM core.stock_movement WHERE tenant_id = $1 AND ref_id = $2`, [T.tenant, count])).rows
      .map((x) => [x.ingredient_id, Number(x.qty_milli), x.cmd]);
    expect(adj).toEqual([[T.rice, -500_000, "inventory.count.submit.v1"]]);
    expect(await onHand(T.outlets[0], T.rice)).toBe(39_300_000);
    expect((await one<{ status: string }>(`SELECT status FROM core.stock_count WHERE tenant_id = $1 AND id = $2`, [T.tenant, count])).status).toBe("submitted");
  });

  it("transfer: both ends — out at the sender on create (sent), in at the receiver on receive (received)", async () => {
    const tr = u();
    const create = await call("POST", "/v1/inventory/transfers", "owner", env("inventory.transfer.create.v1", {
      transfer_id: tr, from_outlet_id: T.outlets[0], to_outlet_id: T.outlets[1], lines: [{ ingredient_id: T.oil, batch_id: null, qty_milli: 1_000_000, unit: "ml" }] }));
    expect(create.status).toBe(200);
    // 4 100 000 − 20 000 (the accepted placed order above) − 1 000 000 sent = 3 080 000; receiver has nothing yet.
    expect([await onHand(T.outlets[0], T.oil), await onHand(T.outlets[1], T.oil)]).toEqual([3_080_000, 0]);
    const rec = await call("POST", `/v1/inventory/transfers/${tr}:receive`, "owner", env("inventory.transfer.receive.v1", { transfer_id: tr }));
    expect(rec.status).toBe(200);
    expect(await onHand(T.outlets[1], T.oil)).toBe(1_000_000);
    const rules = (await db.admin(`SELECT kind, origin->>'rule_id' AS r FROM core.stock_movement WHERE tenant_id = $1 AND ref_id = $2 ORDER BY kind`, [T.tenant, tr])).rows.map((x) => [x.kind, x.r]);
    expect(rules).toEqual([["transfer_in", "inventory.transfer_in"], ["transfer_out", "inventory.transfer_out"]]);
    expect((await one<{ status: string }>(`SELECT status FROM core.transfer WHERE tenant_id = $1 AND id = $2`, [T.tenant, tr])).status).toBe("received");
    // Receiving twice is an illegal transition.
    const again = await call("POST", `/v1/inventory/transfers/${tr}:receive`, "owner", env("inventory.transfer.receive.v1", { transfer_id: tr }));
    expect(again.status).toBe(409);
  });

  it("R2-S1-7: received by the destination's own manager, a batch transfer creates the destination batch with the source's code, expiry and MRP; a second transfer lands in it", async () => {
    const mgr2 = u(), sub2 = `mgr2-${u()}`;
    await db.withContext("munim_core", { tenant_id: T.tenant, outlet_ids: "*", role: "owner", member_id: T.owner, command_type: "tenancy.member.invite.v1" }, async (c) => {
      await c.query(`INSERT INTO core.member (tenant_id, id, idp_sub, name, email) VALUES ($1, $2, $3, 'Synthetic mgr2', 'mgr2@example.test')`, [T.tenant, mgr2, sub2]);
      await c.query(`INSERT INTO core.membership (tenant_id, member_id, role, outlet_ids) VALUES ($1, $2, 'manager', $3)`, [T.tenant, mgr2, [T.outlets[1]]]);
    });
    const asMgr2 = async (path: string, body: unknown) => (await app.request(path, { method: "POST", body: JSON.stringify(body),
      headers: { Authorization: `Bearer ${idp.sign({ sub: sub2 })}`, [TENANT_HEADER]: T.tenant, "Content-Type": "application/json" } }));
    // The expired JAM-OLD batch (2020-01-01) gets a printed MRP first, so both carry over.
    expect((await call("POST", "/v1/inventory/batches:update", "mgr1", env("inventory.batch.update.v1", { batch_id: T.jamExpired, expires_on: "2020-01-01", mrp_minor: 6000 }))).status).toBe(200);
    const send = async (qty: number) => {
      const tr = u();
      expect((await call("POST", "/v1/inventory/transfers", "owner", env("inventory.transfer.create.v1", {
        transfer_id: tr, from_outlet_id: T.outlets[0], to_outlet_id: T.outlets[1], lines: [{ ingredient_id: T.jam, batch_id: T.jamExpired, qty_milli: qty, unit: "unit" }] }))).status).toBe(200);
      expect((await asMgr2(`/v1/inventory/transfers/${tr}:receive`, env("inventory.transfer.receive.v1", { transfer_id: tr }))).status).toBe(200);
    };
    await send(2000);
    const dest = (await db.admin<{ id: string; batch_code: string; expires_on: string; mrp_minor: string }>(
      `SELECT id, batch_code, expires_on::text, mrp_minor::text FROM core.batch WHERE tenant_id = $1 AND outlet_id = $2 AND ingredient_id = $3`, [T.tenant, T.outlets[1], T.jam])).rows;
    expect(dest.map((b) => [b.batch_code, b.expires_on, Number(b.mrp_minor)])).toEqual([["JAM-OLD", "2020-01-01", 6000]]);
    expect(await batchLeft(dest[0]!.id)).toBe(2000);
    await send(1000);
    expect(await num(`SELECT count(*) AS n FROM core.batch WHERE tenant_id = $1 AND outlet_id = $2 AND ingredient_id = $3`, [T.tenant, T.outlets[1], T.jam])).toBe(1);
    expect(await batchLeft(dest[0]!.id)).toBe(3000);
    expect(await batchLeft(T.jamExpired)).toBe(2000); // 5,000 − 3,000 sent
  });

  it("a manager scoped to the sending outlet only cannot create a transfer (transfer scope is both ends, 0014 'pair') — 403, nothing written", async () => {
    const tr = u();
    const r = await call("POST", "/v1/inventory/transfers", "mgr1", env("inventory.transfer.create.v1", {
      transfer_id: tr, from_outlet_id: T.outlets[0], to_outlet_id: T.outlets[1], lines: [{ ingredient_id: T.oil, batch_id: null, qty_milli: 1000, unit: "ml" }] }));
    expect(r.status).toBe(403);
    expect(await num(`SELECT count(*) AS n FROM core.transfer WHERE tenant_id = $1 AND id = $2`, [T.tenant, tr])).toBe(0);
  });

  it("reorder level: set (manager, own outlet) then changed in place; a staff member is refused 403", async () => {
    const set = (who: Who, min: number, par: number) => call("POST", "/v1/inventory/reorder-levels", who, env("inventory.reorder_level.set.v1",
      { outlet_id: T.outlets[0], ingredient_id: T.milk, min_qty_milli: min, par_qty_milli: par }));
    expect((await set("mgr1", 10_000, 30_000)).status).toBe(200);
    expect((await set("mgr1", 12_000, 36_000)).status).toBe(200);
    expect((await set("staff", 1, 2)).status).toBe(403);
    const rows = (await db.admin(`SELECT min_qty_milli, par_qty_milli FROM core.reorder_level WHERE tenant_id = $1 AND outlet_id = $2 AND ingredient_id = $3`,
      [T.tenant, T.outlets[0], T.milk])).rows.map((x) => [Number(x.min_qty_milli), Number(x.par_qty_milli)]);
    expect(rows).toEqual([[12_000, 36_000]]);
    const read = await call("GET", `/v1/inventory/reorder-levels?outlet=${T.outlets[0]}&ingredient=${T.milk}`, "staff");
    expect(InventoryReorderLevelsResponse.parse(await read.json()).reorder_levels.map((x) => [x.ingredient_id, x.min_qty_milli, x.par_qty_milli])).toEqual([[T.milk, 12_000, 36_000]]);
    expect((await call("GET", `/v1/inventory/reorder-levels?outlet=${T.outlets[1]}`, "mgr1")).status).toBe(404);
  });

  it("reorder level and transfer are draftable: approvals executes this module's handlers", () => {
    expect(draftHandler("inventory.reorder_level.set.v1")?.type).toBe("inventory.reorder_level.set.v1");
    expect(draftHandler("inventory.transfer.create.v1")?.type).toBe("inventory.transfer.create.v1");
  });

  it("batch update: a manager corrects the tea batch's MRP; the list route shows the row's own fields", async () => {
    const r = await call("POST", "/v1/inventory/batches:update", "mgr1", env("inventory.batch.update.v1", { batch_id: T.teaB, expires_on: "2099-01-15", mrp_minor: 4900 }));
    expect(r.status).toBe(200);
    const list = InventoryBatchesResponse.parse(await (await call("GET", `/v1/inventory/batches?outlet=${T.outlets[0]}&ingredient=${T.tea}`, "mgr1")).json());
    expect(list.batches.map((b) => [b.batch_id, b.expires_on, b.mrp?.amount_minor])).toEqual([[T.teaB, "2099-01-15", 4900]]);
  });

  it("movements read: rows for the outlet, paged newest first; an outlet outside scope → 404", async () => {
    const page = InventoryMovementsResponse.parse(await (await call("GET", `/v1/inventory/movements?outlet=${T.outlets[0]}&ingredient=${T.oil}&limit=2`, "mgr1")).json());
    expect(page.movements.map((m) => [m.kind, m.qty_milli])).toEqual([["transfer_out", -1_000_000], ["sale_consumption", -20_000]]);
    expect(page.next_cursor).toBe(page.movements[1]!.movement_id);
    expect((await call("GET", `/v1/inventory/movements?outlet=${T.outlets[1]}`, "mgr1")).status).toBe(404);
  });
});

describe("goods received, sale returns, negative on-hand", () => {
  it("deriveGoodsReceipt: 2.5 kg at 41 001 per kg → +2 500 000 milli-g at 41 per g (41 001 / 1000 rounded); idempotent", async () => {
    const grn = u();
    await db.withContext("munim_core", own("inventory.stock.receive.v1"), async (c) => {
      await c.query(`INSERT INTO core.goods_received (tenant_id, id, outlet_id, supplier_id, received_by) VALUES ($1, $2, $3, $4, $5)`, [T.tenant, grn, T.outlets[0], T.supplier, T.owner]);
      await c.query(`INSERT INTO core.grn_line (tenant_id, id, goods_received_id, ingredient_id, qty_milli, unit, unit_cost_minor, currency) VALUES ($1, $2, $3, $4, 2500, 'kg', 41001, $5)`,
        [T.tenant, u(), grn, T.chicken, T.currency]);
    });
    const before = await onHand(T.outlets[0], T.chicken);
    const r = await db.withContext("munim_core", own("inventory.stock.receive.v1"), (c) => deriveGoodsReceipt(c, grn));
    expect(r.movement_ids.length).toBe(1);
    expect((await onHand(T.outlets[0], T.chicken)) - before).toBe(2_500_000);
    const m = await one<{ unit: string; unit_cost_minor: string; rule: string }>(`SELECT unit, unit_cost_minor, origin->>'rule_id' AS rule FROM core.stock_movement WHERE tenant_id = $1 AND ref_id = $2`, [T.tenant, grn]);
    expect([m.unit, Number(m.unit_cost_minor), m.rule]).toEqual(["g", 41, "inventory.receive_grn"]);
    const again = await db.withContext("munim_core", own("inventory.stock.receive.v1"), (c) => deriveGoodsReceipt(c, grn));
    expect([again.derived, (await onHand(T.outlets[0], T.chicken)) - before]).toEqual([false, 2_500_000]);
  });

  it("deriveSaleReturn: a restocked biscuit goes back into the batch the order drew (BIS-NEW); not restocked → nothing", async () => {
    const lineId = u();
    const { order } = await place([{ item: T.biscuitSku, qty: 2000, line_id: lineId }]);
    expect(await batchLeft(T.bNew)).toBe(4_000); // 6 000 − 2 000
    const [sr1, sr2] = [u(), u()];
    await db.withContext("munim_core", own("orders.sale_return.record.v1"), async (c) => {
      await c.query(`INSERT INTO core.sale_return (tenant_id, id, outlet_id, order_id, order_line_id, qty_milli, restock, reason_code, note, actor) VALUES
                     ($1, $2, $4, $5, $6, 1000, true, 'unopened', 'customer changed mind', $7), ($1, $3, $4, $5, $6, 1000, false, 'damaged', 'torn pack', $7)`,
        [T.tenant, sr1, sr2, T.outlets[0], order, lineId, T.owner]);
    });
    const [a, b] = await db.withContext("munim_core", own("orders.sale_return.record.v1"), async (c) => [await deriveSaleReturn(c, sr1), await deriveSaleReturn(c, sr2)]);
    expect([a.movement_ids.length, b.derived, b.movement_ids.length]).toEqual([1, false, 0]);
    expect(await batchLeft(T.bNew)).toBe(5_000);
  });

  it("negative on-hand is allowed and raises the alert hook: honey (no stock) sells 1 → −1 000, listener told once", async () => {
    const seen: Array<{ outlet_id: string; ingredient_id: string }> = [];
    const off = onNegativeOnHand((a) => seen.push(...a));
    const { result } = await place([{ item: T.honeySku, qty: 1000 }]);
    off();
    expect(await onHand(T.outlets[0], T.honey)).toBe(-1_000);
    expect(result!.negative_on_hand).toEqual([{ outlet_id: T.outlets[0], ingredient_id: T.honey }]);
    expect(seen).toEqual([{ outlet_id: T.outlets[0], ingredient_id: T.honey }]);
  });
});
