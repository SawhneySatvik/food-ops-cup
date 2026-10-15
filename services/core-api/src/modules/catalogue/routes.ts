// Catalogue read routes (T-092b; hand list rows 15-19): the settings screens' lists, as rows. Items, variants and
// recipes are tenant-wide (outlet isolation N/A); prices carry an outlet policy; deals and coupons have an `outlet_ids`
// array ('{}' = every outlet) that RLS does not look at, so the member's scope is applied here.
//   GET /v1/catalogue/items?include_inactive=&limit=&cursor=
//   GET /v1/catalogue/recipes?item=&limit=&cursor=                        (each version with its lines)
//   GET /v1/catalogue/prices?item=&outlet=&channel_kind=&limit=&cursor=   (every validity window, future-dated included)
//   GET /v1/catalogue/deals?limit=&cursor= · GET /v1/catalogue/coupons?limit=&cursor=
import { Hono, type Context } from "hono";
import { requireMember } from "../../auth/resolve.ts";
import { ApiError } from "../../lib/errors.ts";
import { cursorOf, inScope, iso, limitOf, memberOf, methodGuard, optUuid, page, readAs } from "../../lib/reads.ts";
import type { AppEnv } from "../../lib/types.ts";

const scopeOf = (c: Context<AppEnv>): string[] | null => {
  const m = memberOf(c);
  return m.outlet_ids === "*" ? null : m.outlet_ids;
};

export const readRoutes = methodGuard(
  new Hono<AppEnv>()
    .get("/v1/catalogue/items", requireMember, async (c) => {
      const flag = c.req.query("include_inactive");
      if (flag !== undefined && flag !== "true" && flag !== "false") throw new ApiError("bad_request");
      const inactive = flag === "true";
      const limit = limitOf(c);
      const cursor = cursorOf(c);
      const out = await readAs(c, async (db) => {
        const items = (await db.query<Record<string, any>>(
          `SELECT id, kind, name_key, category, brand_id, barcode, stock_ingredient_id, active FROM core.item
            WHERE ($1::boolean OR active) AND ($2::uuid IS NULL OR id < $2) ORDER BY id DESC LIMIT $3`, [inactive, cursor, limit + 1])).rows;
        const variants = (await db.query<Record<string, any>>(
          `SELECT id, item_id, name_key, barcode, active FROM core.variant WHERE item_id = ANY ($1::uuid[]) AND ($2::boolean OR active) ORDER BY position, name_key, id`,
          [items.slice(0, limit).map((i) => i.id), inactive])).rows;
        return page(items, limit, (i) => ({
          item_id: i.id, kind: i.kind, name_key: i.name_key, category: i.category, brand_id: i.brand_id, barcode: i.barcode,
          stock_ingredient_id: i.stock_ingredient_id, active: i.active,
          variants: variants.filter((v) => v.item_id === i.id).map((v) => ({ variant_id: v.id, name_key: v.name_key, barcode: v.barcode, active: v.active })),
        }));
      });
      return c.json(out, 200);
    })
    .get("/v1/catalogue/recipes", requireMember, async (c) => {
      const item = optUuid(c, "item");
      const limit = limitOf(c);
      const cursor = cursorOf(c);
      const out = await readAs(c, async (db) => {
        const versions = (await db.query<Record<string, any>>(
          `SELECT id, item_id, variant_id, version, valid_from::text AS valid_from, valid_to::text AS valid_to, yield_qty_milli FROM core.recipe_version
            WHERE ($1::uuid IS NULL OR item_id = $1) AND ($2::uuid IS NULL OR id < $2) ORDER BY id DESC LIMIT $3`, [item, cursor, limit + 1])).rows;
        const lines = (await db.query<Record<string, any>>(
          `SELECT id, recipe_version_id, ingredient_id, qty_milli, unit, waste_pct_bp FROM core.recipe_line WHERE recipe_version_id = ANY ($1::uuid[]) ORDER BY id`,
          [versions.slice(0, limit).map((v) => v.id)])).rows;
        return page(versions, limit, (v) => ({
          recipe_version_id: v.id, item_id: v.item_id, variant_id: v.variant_id, version: v.version, valid_from: v.valid_from, valid_to: v.valid_to,
          yield_qty_milli: Number(v.yield_qty_milli),
          lines: lines.filter((l) => l.recipe_version_id === v.id).map((l) => ({
            recipe_line_id: l.id, ingredient_id: l.ingredient_id, qty_milli: Number(l.qty_milli), unit: l.unit, waste_pct_bp: l.waste_pct_bp,
          })),
        }));
      });
      return c.json(out, 200);
    })
    .get("/v1/catalogue/prices", requireMember, async (c) => {
      const item = optUuid(c, "item");
      const outlet = optUuid(c, "outlet");
      if (outlet !== null) inScope(memberOf(c), outlet);
      const channelKind = c.req.query("channel_kind") ?? null;
      if (channelKind !== null && !/^(counter|table_qr|pickup|own_site|aggregator:[a-z][a-z0-9_]*)$/.test(channelKind)) throw new ApiError("bad_request");
      const limit = limitOf(c);
      const cursor = cursorOf(c);
      const rows = await readAs(c, async (db) => (await db.query<Record<string, any>>(
        `SELECT id, item_id, variant_id, outlet_id, channel_kind, amount_minor, currency, tax_class, valid_from::text AS valid_from, valid_to::text AS valid_to
           FROM core.price
          WHERE ($1::uuid IS NULL OR item_id = $1) AND ($2::uuid IS NULL OR outlet_id = $2) AND ($3::text IS NULL OR channel_kind = $3) AND ($4::uuid IS NULL OR id < $4)
          ORDER BY id DESC LIMIT $5`, [item, outlet, channelKind, cursor, limit + 1])).rows);
      return c.json(page(rows, limit, (p) => ({
        price_id: p.id, item_id: p.item_id, variant_id: p.variant_id, outlet_id: p.outlet_id, channel_kind: p.channel_kind,
        amount_minor: Number(p.amount_minor), currency: p.currency, tax_class: p.tax_class, valid_from: p.valid_from, valid_to: p.valid_to,
      })), 200);
    })
    .get("/v1/catalogue/deals", requireMember, async (c) => {
      const scope = scopeOf(c);
      const limit = limitOf(c);
      const cursor = cursorOf(c);
      const rows = await readAs(c, async (db) => (await db.query<Record<string, any>>(
        `SELECT id, kind, name_key, rule, windows, outlet_ids, valid_from::text AS valid_from, valid_to::text AS valid_to, active FROM core.deal
          WHERE ($1::uuid[] IS NULL OR outlet_ids = '{}' OR outlet_ids && $1::uuid[]) AND ($2::uuid IS NULL OR id < $2)
          ORDER BY id DESC LIMIT $3`, [scope, cursor, limit + 1])).rows);
      return c.json(page(rows, limit, (d) => ({
        deal_id: d.id, kind: d.kind, name_key: d.name_key, rule: d.rule, windows: d.windows, outlet_ids: d.outlet_ids,
        valid_from: d.valid_from, valid_to: d.valid_to, active: d.active,
      })), 200);
    })
    .get("/v1/catalogue/coupons", requireMember, async (c) => {
      const scope = scopeOf(c);
      const limit = limitOf(c);
      const cursor = cursorOf(c);
      const rows = await readAs(c, async (db) => (await db.query<Record<string, any>>(
        `SELECT id, code, kind, value_bp, value_minor, currency, min_spend_minor, global_cap, per_customer_cap, requires_customer, outlet_ids,
                campaign_id, valid_from, valid_to, active FROM core.coupon
          WHERE ($1::uuid[] IS NULL OR outlet_ids = '{}' OR outlet_ids && $1::uuid[]) AND ($2::uuid IS NULL OR id < $2)
          ORDER BY id DESC LIMIT $3`, [scope, cursor, limit + 1])).rows);
      return c.json(page(rows, limit, (k) => ({
        coupon_id: k.id, code: k.code, kind: k.kind, value_bp: k.value_bp, value_minor: k.value_minor === null ? null : Number(k.value_minor), currency: k.currency,
        min_spend_minor: Number(k.min_spend_minor), global_cap: k.global_cap, per_customer_cap: k.per_customer_cap, requires_customer: k.requires_customer,
        outlet_ids: k.outlet_ids, campaign_id: k.campaign_id, valid_from: k.valid_from.toISOString(), valid_to: iso(k.valid_to), active: k.active,
      })), 200);
    }),
  [
    ["/v1/catalogue/items", "GET, POST"], ["/v1/catalogue/recipes", "GET, POST"], ["/v1/catalogue/prices", "GET, POST"],
    ["/v1/catalogue/deals", "GET, POST"], ["/v1/catalogue/coupons", "GET, POST"],
  ],
);
