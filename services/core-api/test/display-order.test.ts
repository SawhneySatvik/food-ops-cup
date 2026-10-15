// T-115 gates — display order (0030) through the real app: catalogue.item.upsert.v1 on the member route writes positions
// (array index for variants, option groups and options; the tenant's next value for a new item), and the storefront lists
// items within a category, variants, option groups and options in that order, and outlets in the order they were opened.
// Every name below sorts the OTHER way alphabetically, so a read ordered by name key (or outlet name) fails each assertion.
// Red-proof: test/redproof-t115.sh. Synthetic data only.
import { createHash } from "node:crypto";
import { createLogger } from "@munim/config";
import { CommandResult } from "@munim/contracts";
import { StorefrontMenuResponse, StorefrontOutletsResponse } from "@munim/contracts/storefront";
import { ownerCtx, type TestDb, uuidv7 } from "@munim/db";
import type { Hono } from "hono";
import type pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createLocalIdp } from "../src/auth/local-idp.ts";
import { type AppEnv, createApp, STOREFRONT_KEY_HEADER, storefrontResolver, TENANT_HEADER } from "../src/app.ts";
import { openDb } from "./db.ts";
import { buildTenant, type Tenant } from "./world.ts";

const idp = createLocalIdp();
let db: TestDb;
let pools: { core: pg.Pool; svc: pg.Pool };
let app: Hono<AppEnv>;
let W: Tenant;
let OUT: string;
let KEY: string;
const LATE_OUTLET = uuidv7();
const I = { cocoa: uuidv7(), mid: uuidv7(), last: uuidv7(), regular: uuidv7(), large: uuidv7(), gZest: uuidv7(), gBase: uuidv7(),
  salted: uuidv7(), almond: uuidv7(), dairy: uuidv7() };

type Res = Omit<Response, "json"> & { json(): Promise<any> };
const member = async (method: string, path: string, body?: unknown): Promise<Res> =>
  (await app.request(path, {
    method,
    headers: { Authorization: `Bearer ${idp.sign({ sub: W.ownerSub })}`, [TENANT_HEADER]: W.tenant, "Content-Type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  })) as Res;
const shopper = async (path: string): Promise<Res> => (await app.request(path, { headers: { [STOREFRONT_KEY_HEADER]: KEY } })) as Res;
const send = async (type: string, path: string, payload: unknown) => {
  const r = await member("POST", path, { command_id: uuidv7(), idempotency_key: `k-${uuidv7()}`, type, payload });
  const body = await r.json();
  if (r.status !== 200) throw new Error(`${type}: expected 200, got ${r.status} ${JSON.stringify(body)}`);
  return CommandResult.parse(body);
};
const option = (option_id: string, name_key: string, price_delta_minor = 0) =>
  ({ option_id, name_key, price_delta_minor, currency: "INR", active: true, ingredient_deltas: [] });
const dish = (item_id: string, name_key: string, extra: Record<string, unknown> = {}) => ({
  item_id, name_key, category: "drinks", brand_id: null, barcode: null, mrp_minor: null, currency: null, active: true, variants: [], option_groups: [],
  kind: "dish", stock_ingredient_id: null, ...extra,
});
/** The cocoa: sizes Regular then Large, groups Zest then Base, Zest's options Salted then Almond (each against name order). */
const cocoa = (variants: string[]) => dish(I.cocoa, "menu.zz_cocoa", {
  variants: variants.map((k) => ({ variant_id: k === "regular" ? I.regular : I.large, name_key: `menu.zz_cocoa.${k}`, barcode: null, active: true })),
  option_groups: [
    { option_group_id: I.gZest, name_key: "opt.zest", min_select: 0, max_select: 2, required: false, options: [option(I.salted, "opt.salted", 500), option(I.almond, "opt.almond", 700)] },
    { option_group_id: I.gBase, name_key: "opt.base", min_select: 1, max_select: 1, required: true, options: [option(I.dairy, "opt.dairy")] },
  ],
});
const price = (item_id: string, amount_minor: number) => ({
  price_id: uuidv7(), item_id, variant_id: null, outlet_id: OUT, channel_kind: "pickup", amount_minor, currency: "INR", tax_class: "restaurant_5",
  valid_from: "2026-10-01", valid_to: null,
});
const drinks = async () => {
  const r = await shopper(`/v1/storefront/outlets/${OUT}/menu`);
  expect(r.status).toBe(200);
  return StorefrontMenuResponse.parse(await r.json()).items.filter((i) => i.category === "drinks");
};

beforeAll(async () => {
  db = await openDb();
  W = await buildTenant(db, "T115");
  OUT = W.outlets[0];
  const channel = uuidv7();
  KEY = `sfk_T115_${uuidv7().replaceAll("-", "")}${uuidv7().replaceAll("-", "")}`;
  await db.withContext("munim_core", ownerCtx(W, { command_type: "tenancy.channel.create.v1" }), (c) =>
    c.query(`INSERT INTO core.channel (tenant_id, id, name, kind) VALUES ($1, $2, 'Pickup', 'pickup')`, [W.tenant, channel]));
  await db.withContext("munim_core", ownerCtx(W), (c) =>
    c.query(`INSERT INTO core.storefront_key (tenant_id, id, channel_id, key_hash) VALUES ($1, $2, $3, $4)`, [W.tenant, uuidv7(), channel, createHash("sha256").update(KEY).digest("hex")]));
  // Opened after the world's three outlets (its own transaction, so a later created_at), with a name that sorts first.
  await db.withContext("munim_core", ownerCtx(W, { command_type: "tenancy.outlet.create.v1" }), (c) =>
    c.query(`INSERT INTO core.outlet (tenant_id, id, name, kind, tz, address) VALUES ($1, $2, 'Aardvark Lane (synthetic)', 'restaurant', 'Asia/Kolkata', 'Synthetic street')`, [W.tenant, LATE_OUTLET]));

  pools = { core: db.pool("munim_core", 4), svc: db.pool("munim_svc", 2) };
  const config = { nodeEnv: "test", redact: (s: string) => s };
  app = await createApp({ pools, idp, storefronts: storefrontResolver(pools.core), config, log: createLogger(config, () => {}) });

  // Added in this order: cocoa, mid, last (name order is the reverse).
  await send("catalogue.item.upsert.v1", "/v1/catalogue/items", cocoa(["regular", "large"]));
  await send("catalogue.item.upsert.v1", "/v1/catalogue/items", dish(I.mid, "menu.mm_mid"));
  await send("catalogue.item.upsert.v1", "/v1/catalogue/items", dish(I.last, "menu.aa_last"));
  for (const [id, amount] of [[I.cocoa, 16000], [I.mid, 9000], [I.last, 8000]] as const) await send("catalogue.price.set.v1", "/v1/catalogue/prices", price(id, amount));
});
afterAll(async () => {
  await pools?.core.end();
  await pools?.svc.end();
  await db?.stop();
});

describe("T-115 display order", () => {
  it("storefront menu: items in the order added, sizes / groups / options in payload order (not name order)", async () => {
    const items = await drinks();
    console.log("ORDER menu:", JSON.stringify(items.map((i) => [i.name_key, i.variants.map((v) => v.name_key), i.option_groups.map((g) => [g.name_key, g.options.map((o) => o.name_key)])])));
    expect(items.map((i) => i.name_key)).toEqual(["menu.zz_cocoa", "menu.mm_mid", "menu.aa_last"]);
    const c = items[0]!;
    expect(c.variants.map((v) => v.name_key)).toEqual(["menu.zz_cocoa.regular", "menu.zz_cocoa.large"]);
    expect(c.option_groups.map((g) => g.name_key)).toEqual(["opt.zest", "opt.base"]);
    expect(c.option_groups[0]!.options.map((o) => o.name_key)).toEqual(["opt.salted", "opt.almond"]);
  });

  it("positions as stored: the items 1, 2, 3 (max + 1 after the world's SQL-made rows at 0); children = array index", async () => {
    const r = (await db.admin<{ k: string; p: number }>(
      `SELECT k, p FROM (SELECT name_key k, position p FROM core.item WHERE tenant_id = $1 AND category = 'drinks'
         UNION ALL SELECT name_key, position FROM core.variant WHERE tenant_id = $1 AND item_id = $2
         UNION ALL SELECT name_key, position FROM core.option_group WHERE tenant_id = $1 AND item_id = $2
         UNION ALL SELECT o.name_key, o.position FROM core.option o JOIN core.option_group g ON g.tenant_id = o.tenant_id AND g.id = o.option_group_id
                    WHERE o.tenant_id = $1 AND g.item_id = $2) x ORDER BY k`, [W.tenant, I.cocoa])).rows;
    // The world's own items sit at 0 (inserted by SQL, not the command), so the first command-made item is max + 1 = 1.
    expect(r).toEqual([
      { k: "menu.aa_last", p: 3 }, { k: "menu.mm_mid", p: 2 }, { k: "menu.zz_cocoa", p: 1 },
      { k: "menu.zz_cocoa.large", p: 1 }, { k: "menu.zz_cocoa.regular", p: 0 },
      { k: "opt.almond", p: 1 }, { k: "opt.base", p: 1 }, { k: "opt.dairy", p: 0 }, { k: "opt.salted", p: 0 }, { k: "opt.zest", p: 0 },
    ]);
  });

  it("resending the item with its sizes reversed reorders them (the owner's own command); the item keeps its place", async () => {
    await send("catalogue.item.upsert.v1", "/v1/catalogue/items", cocoa(["large", "regular"]));
    const items = await drinks();
    expect(items.map((i) => i.name_key)).toEqual(["menu.zz_cocoa", "menu.mm_mid", "menu.aa_last"]);
    expect(items[0]!.variants.map((v) => v.name_key)).toEqual(["menu.zz_cocoa.large", "menu.zz_cocoa.regular"]);
    const list = await member("GET", "/v1/catalogue/items");
    const row = ((await list.json()) as { items: Array<{ item_id: string; variants: Array<{ name_key: string }> }> }).items.find((i) => i.item_id === I.cocoa)!;
    expect(row.variants.map((v) => v.name_key)).toEqual(["menu.zz_cocoa.large", "menu.zz_cocoa.regular"]);
    await send("catalogue.item.upsert.v1", "/v1/catalogue/items", cocoa(["regular", "large"]));
  });

  it("storefront outlets: in the order opened (the world's three, then the later 'Aardvark Lane'), not by name", async () => {
    const r = await shopper("/v1/storefront/outlets");
    expect(r.status).toBe(200);
    const names = StorefrontOutletsResponse.parse(await r.json()).outlets.map((o) => o.name);
    console.log("ORDER outlets:", JSON.stringify(names));
    expect(names).toEqual(["Outlet 1", "Outlet 2", "Outlet 3", "Aardvark Lane (synthetic)"]);
  });
});
