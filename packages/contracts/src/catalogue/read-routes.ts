// Catalogue read responses and routes (T-092b; hand list rows 15-19). Prices in minor units with their currency; future-dated
// windows are listed with the current ones.
import { z } from "zod";
import { CouponCode, CurrencyCode, IsoDate, IsoDateTime, MinorAmount, QtyMilli, Slug, Unit, Uuid7 } from "../shared/primitives.ts";
import type { QueryParam, Route } from "../shared/routes.ts";

const Page = <T extends z.ZodType>(item: T) => z.strictObject({ items: z.array(item), next_cursor: Uuid7.nullable() });
const uuid = { type: "string", pattern: "^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$" };
const date = { type: "string", format: "date" };
const param = (name: string, schema: Record<string, unknown>, required = false): QueryParam => ({ name, required, schema });
const cursor = param("cursor", uuid);
const limit = param("limit", { type: "integer", minimum: 1, maximum: 200 });
const read = (path: string, operationId: string, summary: string, response: string, extra: Partial<Route> = {}): Route =>
  ({ surface: "public", method: "get", path, operationId, summary, auth: "member", response, status: 200, ...extra });

const ItemRow = z.strictObject({
  item_id: Uuid7, kind: z.enum(["dish", "sku", "combo"]), name_key: Slug, category: z.string(), brand_id: Uuid7.nullable(), barcode: z.string().nullable(),
  stock_ingredient_id: Uuid7.nullable(), active: z.boolean(),
  variants: z.array(z.strictObject({ variant_id: Uuid7, name_key: Slug, barcode: z.string().nullable(), active: z.boolean() })),
}).meta({ title: "CatalogueItemRow" });

const RecipeRow = z.strictObject({
  recipe_version_id: Uuid7, item_id: Uuid7, variant_id: Uuid7.nullable(), version: z.int().min(1), valid_from: IsoDate, valid_to: IsoDate.nullable(), yield_qty_milli: QtyMilli,
  lines: z.array(z.strictObject({ recipe_line_id: Uuid7, ingredient_id: Uuid7, qty_milli: QtyMilli, unit: Unit, waste_pct_bp: z.int().min(0).max(10000) })),
}).meta({ title: "CatalogueRecipeRow" });

const PriceRow = z.strictObject({
  price_id: Uuid7, item_id: Uuid7, variant_id: Uuid7.nullable(), outlet_id: Uuid7, channel_kind: z.string(), amount_minor: MinorAmount, currency: CurrencyCode,
  tax_class: z.string(), valid_from: IsoDate, valid_to: IsoDate.nullable(),
}).meta({ title: "CataloguePriceRow" });

const DealRow = z.strictObject({
  deal_id: Uuid7, kind: z.string(), name_key: Slug, rule: z.record(z.string(), z.unknown()), windows: z.array(z.unknown()), outlet_ids: z.array(Uuid7),
  valid_from: IsoDate, valid_to: IsoDate.nullable(), active: z.boolean(),
}).meta({ title: "CatalogueDealRow" });

const CouponRow = z.strictObject({
  coupon_id: Uuid7, code: CouponCode, kind: z.enum(["percent", "amount"]), value_bp: z.int().nullable(), value_minor: MinorAmount.nullable(), currency: CurrencyCode,
  min_spend_minor: MinorAmount, global_cap: z.int().nullable(), per_customer_cap: z.int().nullable(), requires_customer: z.boolean(), outlet_ids: z.array(Uuid7),
  campaign_id: Uuid7.nullable(), valid_from: IsoDateTime, valid_to: IsoDateTime.nullable(), active: z.boolean(),
}).meta({ title: "CatalogueCouponRow" });

export const READ_SCHEMAS = {
  "v1.catalogue.items": Page(ItemRow),
  "v1.catalogue.recipes": Page(RecipeRow),
  "v1.catalogue.prices": Page(PriceRow),
  "v1.catalogue.deals": Page(DealRow),
  "v1.catalogue.coupons": Page(CouponRow),
};

export const READ_ROUTES: readonly Route[] = [
  read("/v1/catalogue/items", "listCatalogueItems", "Items with their variants; inactive ones only with include_inactive=true", "v1.catalogue.items", { query: [param("include_inactive", { type: "string", enum: ["true", "false"] }), limit, cursor] }),
  read("/v1/catalogue/recipes", "listCatalogueRecipes", "Recipe versions with their lines, optionally of one item", "v1.catalogue.recipes", { query: [param("item", uuid), limit, cursor] }),
  read("/v1/catalogue/prices", "listCataloguePrices", "Price rows in every validity window, future-dated included", "v1.catalogue.prices", { query: [param("item", uuid), param("outlet", uuid), param("channel_kind", { type: "string", pattern: "^(counter|table_qr|pickup|own_site|aggregator:[a-z][a-z0-9_]*)$" }), limit, cursor] }),
  read("/v1/catalogue/deals", "listCatalogueDeals", "Deals visible to the caller's outlet scope (an empty outlet list = every outlet)", "v1.catalogue.deals", { query: [limit, cursor] }),
  read("/v1/catalogue/coupons", "listCatalogueCoupons", "Coupons visible to the caller's outlet scope (an empty outlet list = every outlet)", "v1.catalogue.coupons", { query: [limit, cursor] }),
];
