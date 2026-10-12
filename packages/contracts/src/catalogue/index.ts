// Catalogue setup commands (02-schema §2.3). Prices and recipes are versioned by validity; overlaps are
// refused by the database (exclusion constraints).
import { z } from "zod";
import { BasisPoints, CouponCode, CurrencyCode, IsoDate, IsoDateTime, LocalTime, MinorAmount, QtyMilli, Slug, Unit, Uuid7 } from "../shared/primitives.ts";
import { defineDraftable } from "../shared/draftables.ts";
import type { Route } from "../shared/routes.ts";
import { ChannelKind } from "../tenancy/index.ts";
import { READ_ROUTES, READ_SCHEMAS } from "./read-routes.ts";

export const ItemKind = z.enum(["dish", "sku", "combo"]);
const Barcode = z.string().regex(/^[0-9A-Za-z-]{4,32}$/);

// ── Owner-entered display text (0029, docs/kit/gaps.md G-01). Plain text: every client renders it as text, never as
// HTML (gotcha 15); core stores it as typed. NULL = not set — a client shows the row's `name_key` (its i18n string, or a
// title-cased slug). On an upsert an ABSENT field leaves the stored value as it is; `null` clears it.
/** A display name as the owner typed it (core: 1–120 characters). */
export const DisplayName = z.string().min(1).max(120);
/** A short description as the owner typed it (core: 1–500 characters). */
export const DisplayDescription = z.string().min(1).max(500);
/** Diet mark of a dish or product (core CHECK; the country packs carry no diet list). */
export const Diet = z.enum(["veg", "non_veg", "egg", "vegan"]);
const display = { display_name: DisplayName.nullable().optional(), description: DisplayDescription.nullable().optional() };

/** What choosing an option adds to (negative: removes from) the recipe's consumption. `unit` must equal
 *  the ingredient's base unit (refused with `unit_mismatch`, W1 fix #50). */
export const OptionIngredientDelta = z.strictObject({
  delta_id: Uuid7,
  ingredient_id: Uuid7,
  qty_milli: QtyMilli.refine((q) => q !== 0, "qty_milli is not 0"),
  unit: Unit,
  waste_pct_bp: BasisPoints,
});

export const ItemOption = z
  .strictObject({
    option_id: Uuid7,
    name_key: Slug,
    price_delta_minor: MinorAmount,
    /** Must equal the tenant's base currency. */
    currency: CurrencyCode,
    active: z.boolean(),
    ingredient_deltas: z.array(OptionIngredientDelta).max(50),
    ...display,
  })
  .superRefine((o, ctx) => {
    const ids = o.ingredient_deltas.map((d) => d.ingredient_id);
    if (new Set(ids).size !== ids.length) ctx.addIssue({ code: "custom", path: ["ingredient_deltas"], message: "one delta per ingredient" });
  });

export const OptionGroup = z
  .strictObject({
    option_group_id: Uuid7,
    name_key: Slug,
    min_select: z.int().min(0),
    max_select: z.int().min(1),
    required: z.boolean(),
    options: z.array(ItemOption).min(1).max(50),
    ...display,
  })
  .superRefine((g, ctx) => {
    if (g.max_select < g.min_select) ctx.addIssue({ code: "custom", path: ["max_select"], message: "max_select ≥ min_select" });
    if (g.required && g.min_select < 1) ctx.addIssue({ code: "custom", path: ["min_select"], message: "a required group selects at least one" });
  });

export const ItemVariant = z.strictObject({ variant_id: Uuid7, name_key: Slug, barcode: Barcode.nullable(), active: z.boolean(), ...display });

const itemFields = {
  item_id: Uuid7,
  /** i18n key of the display name (core.item.name_key). */
  name_key: Slug,
  category: z.string().min(1).max(100),
  brand_id: Uuid7.nullable(),
  /** EAN/UPC or an in-house code (shops scan these). */
  barcode: Barcode.nullable(),
  /** Printed maximum retail price (packaged goods, packs with an MRP rule) with its currency; both null or
   *  both set (core.item mrp pair). The tax class lives on `price`, not on the item. */
  mrp_minor: MinorAmount.positive().nullable(),
  currency: CurrencyCode.nullable(),
  active: z.boolean(),
  variants: z.array(ItemVariant).max(50),
  option_groups: z.array(OptionGroup).max(20),
  ...display,
  diet: Diet.nullable().optional(),
};

const mrpPair = (i: { mrp_minor: number | null; currency: string | null }, ctx: z.RefinementCtx) => {
  if ((i.mrp_minor === null) !== (i.currency === null)) ctx.addIssue({ code: "custom", path: ["currency"], message: "mrp_minor and currency are set together" });
};

/** Dish / combo, or a shop SKU. A SKU is stocked as one ingredient row, so `stock_ingredient_id` is
 *  required when kind = 'sku' (DB check item kind <> 'sku' OR stock_ingredient_id IS NOT NULL) — expressed
 *  as a union on `kind` so JSON Schema and Pydantic enforce it too. */
export const CatalogueItemUpsertV1 = z.discriminatedUnion("kind", [
  z.strictObject({ ...itemFields, kind: z.enum(["dish", "combo"]), stock_ingredient_id: Uuid7.nullable() }).superRefine(mrpPair),
  z.strictObject({ ...itemFields, kind: z.literal("sku"), stock_ingredient_id: Uuid7 }).superRefine(mrpPair),
]);

export const CatalogueRecipeVersionCreateV1 = z.strictObject({
  recipe_version_id: Uuid7,
  item_id: Uuid7,
  variant_id: Uuid7.nullable(),
  version: z.int().min(1),
  valid_from: IsoDate,
  valid_to: IsoDate.nullable(),
  yield_qty_milli: QtyMilli.positive(),
  lines: z
    .array(
      z.strictObject({
        ingredient_id: Uuid7,
        qty_milli: QtyMilli.positive(),
        /** Must equal the ingredient's base unit; core refuses a mismatch with `unit_mismatch` (W1 fix #50). */
        unit: Unit,
        waste_pct_bp: BasisPoints,
      }),
    )
    .min(1),
});

export const CataloguePriceSetV1 = z.strictObject({
  price_id: Uuid7,
  item_id: Uuid7,
  variant_id: Uuid7.nullable(),
  outlet_id: Uuid7,
  channel_kind: ChannelKind,
  amount_minor: MinorAmount.nonnegative(),
  /** Must equal the tenant's base currency (R30). */
  currency: CurrencyCode,
  /** One of the pack's tax.classes[].code. */
  tax_class: Slug,
  valid_from: IsoDate,
  valid_to: IsoDate.nullable(),
});

// ── Deals (02-schema §2.3 `core.deal`). Judged at the promised time in the outlet's zone and re-judged
// whenever it changes (project rule 9). `rule.kind` is stored in `core.deal.kind` too.
// Stacking (R4 §E 6, written down here): at most ONE deal per order line — the one giving that line the
// largest discount (ties → the lowest deal id); coupons then apply, in the order presented, to what each
// line has left after its deal and earlier coupons. A line's discount never exceeds its amount.
const DealItems = z.array(Uuid7).max(200);
export const DealRule = z.discriminatedUnion("kind", [
  /** `bp` off each eligible line (empty `item_ids` = every item). */
  z.strictObject({ kind: z.literal("percent_off"), bp: BasisPoints.min(1), item_ids: DealItems }),
  /** `amount_minor` off each eligible unit (capped at the line amount). */
  z.strictObject({ kind: z.literal("amount_off"), amount_minor: MinorAmount.positive(), item_ids: DealItems }),
  /** Per line: of every (buy_qty + get_qty) whole units, get_qty are free — e.g. 2-for-1 = buy 1 get 1. */
  z.strictObject({ kind: z.literal("buy_x_get_y"), buy_qty: z.int().min(1).max(100), get_qty: z.int().min(1).max(100), item_ids: DealItems.min(1) }),
]);
export type DealRule = z.infer<typeof DealRule>;

/** A weekly window in the outlet's local wall-clock time. `days` are ISO weekdays (1 = Monday). `to` at or
 *  before `from` crosses midnight: the window opens on a listed day and closes on the next day. */
export const DealWindow = z
  .strictObject({ days: z.array(z.int().min(1).max(7)).min(1).max(7), from: LocalTime, to: LocalTime })
  .superRefine((w, ctx) => {
    if (new Set(w.days).size !== w.days.length) ctx.addIssue({ code: "custom", path: ["days"], message: "each day once" });
    if (w.from === w.to) ctx.addIssue({ code: "custom", path: ["to"], message: "an empty window" });
  });
export type DealWindow = z.infer<typeof DealWindow>;

export const CatalogueDealUpsertV1 = z.strictObject({
  deal_id: Uuid7,
  name_key: Slug,
  rule: DealRule,
  /** Empty = any time while valid. */
  windows: z.array(DealWindow).max(20),
  /** Empty = every outlet. */
  outlet_ids: z.array(Uuid7).max(100),
  valid_from: IsoDate,
  /** Exclusive end; null = open. */
  valid_to: IsoDate.nullable(),
  active: z.boolean(),
});

/** Ends a deal (a loss-making one, catalogue pack §6): `valid_to` (exclusive) moves earlier, never later; a
 *  deal that has not started yet is switched off instead. */
export const CatalogueDealEndV1 = z.strictObject({ deal_id: Uuid7, valid_to: IsoDate });

// ── Coupons (02-schema §2.3 `core.coupon`; R4 §E 6). The code is the shared CouponCode (= the DB check).
export const CatalogueCouponSetV1 = z
  .strictObject({
    coupon_id: Uuid7,
    code: CouponCode,
    kind: z.enum(["percent", "amount"]),
    value_bp: z.int().min(1).max(10000).nullable(),
    value_minor: MinorAmount.positive().nullable(),
    /** Must equal the tenant's base currency. */
    currency: CurrencyCode,
    /** Judged on the cart after deals, before tax. */
    min_spend_minor: MinorAmount.nonnegative(),
    global_cap: z.int().min(1).nullable(),
    /** Needs `requires_customer` (an anonymous use cannot be counted per customer). */
    per_customer_cap: z.int().min(1).nullable(),
    requires_customer: z.boolean(),
    /** Empty = every outlet. */
    outlet_ids: z.array(Uuid7).max(100),
    valid_from: IsoDateTime,
    valid_to: IsoDateTime.nullable(),
    active: z.boolean(),
  })
  .superRefine((c, ctx) => {
    if ((c.kind === "percent") !== (c.value_bp !== null) || (c.kind === "amount") !== (c.value_minor !== null))
      ctx.addIssue({ code: "custom", path: ["kind"], message: "percent sets value_bp only; amount sets value_minor only" });
    if (c.per_customer_cap !== null && !c.requires_customer) ctx.addIssue({ code: "custom", path: ["per_customer_cap"], message: "a per-customer cap needs requires_customer" });
  });

/** Sold out / back on sale at one outlet (operational: staff flip it during service). */
export const CatalogueAvailabilitySetV1 = z.strictObject({ outlet_id: Uuid7, item_id: Uuid7, variant_id: Uuid7.nullable(), available: z.boolean() });

/** Intel may propose a price change as a draft (catalogue pack). */
export const PRICE_SET_DRAFT = defineDraftable("catalogue.price.set.v1", CataloguePriceSetV1);
/** Recipe revision draft (catalogue pack §6; D-2 draftable list). */
export const RECIPE_VERSION_CREATE_DRAFT = defineDraftable("catalogue.recipe.version.create.v1", CatalogueRecipeVersionCreateV1);
/** Ends a loss-making deal (catalogue pack §6). */
export const DEAL_END_DRAFT = defineDraftable("catalogue.deal.end.v1", CatalogueDealEndV1);
/** Tightens a leaking coupon (customers-growth pack §6). */
export const COUPON_SET_DRAFT = defineDraftable("catalogue.coupon.set.v1", CatalogueCouponSetV1);

// ── Reads. Every number is a row's own field (R26): price ← core.price.amount_minor, option delta ←
// core.option.price_delta_minor, MRP ← core.item.mrp_minor. No totals here — carts are priced by the
// pricing function (orders preview / place).
/** The stored display text (0029): plain text, null when the owner set none (show `name_key`). */
const shown = { display_name: z.string().nullable(), description: z.string().nullable() };
export const MenuOption = z.strictObject({ option_id: Uuid7, name_key: Slug, price_delta_minor: MinorAmount, currency: CurrencyCode, ...shown });
export const MenuOptionGroup = z.strictObject({
  option_group_id: Uuid7,
  name_key: Slug,
  min_select: z.int().min(0),
  max_select: z.int().min(1),
  required: z.boolean(),
  options: z.array(MenuOption),
  ...shown,
});
/** One sellable (item, variant) at an outlet and channel, with the price row in force now. */
export const MenuEntry = z.strictObject({
  item_id: Uuid7,
  variant_id: Uuid7.nullable(),
  kind: ItemKind,
  name_key: Slug,
  variant_name_key: Slug.nullable(),
  category: z.string(),
  /** core.item.brand_id (multi-brand kitchens); null = no brand. */
  brand_id: Uuid7.nullable(),
  /** The item's display text and diet mark (0029); null = not set. */
  display_name: z.string().nullable(),
  description: z.string().nullable(),
  diet: Diet.nullable(),
  /** The variant's display text; null for an item sold as itself, or not set. */
  variant_display_name: z.string().nullable(),
  variant_description: z.string().nullable(),
  barcode: z.string().nullable(),
  price_id: Uuid7,
  price_minor: MinorAmount,
  currency: CurrencyCode,
  tax_class: Slug,
  mrp_minor: MinorAmount.nullable(),
  /** false = sold out at this outlet (core.item_availability). */
  available: z.boolean(),
  option_groups: z.array(MenuOptionGroup),
  /** Deals that can apply to this item at this outlet today (badges); each is judged again at the promised time. */
  deals: z.array(z.strictObject({ deal_id: Uuid7, name_key: Slug, kind: z.string(), windows: z.array(DealWindow) })),
});
export const MenuResponse = z.strictObject({
  outlet_id: Uuid7,
  channel_kind: ChannelKind,
  /** The outlet's business date the prices were read for. */
  business_date: IsoDate,
  entries: z.array(MenuEntry),
});
/** A scanned code (item or variant barcode). Unknown code → 404. `entry` is null when the item is not on
 *  sale here (inactive, or no price in force for this outlet and channel). */
export const BarcodeLookupResponse = z.strictObject({
  barcode: z.string(),
  item_id: Uuid7,
  variant_id: Uuid7.nullable(),
  on_sale: z.boolean(),
  entry: MenuEntry.nullable(),
});

export const SCHEMAS = {
  ...READ_SCHEMAS,
  "catalogue.item.upsert.v1": CatalogueItemUpsertV1,
  "catalogue.recipe.version.create.v1": CatalogueRecipeVersionCreateV1,
  "catalogue.price.set.v1": CataloguePriceSetV1,
  "catalogue.deal.upsert.v1": CatalogueDealUpsertV1,
  "catalogue.deal.end.v1": CatalogueDealEndV1,
  "catalogue.coupon.set.v1": CatalogueCouponSetV1,
  "catalogue.availability.set.v1": CatalogueAvailabilitySetV1,
  "proposal.catalogue.price.set.v1": PRICE_SET_DRAFT.proposal,
  "proposal.catalogue.recipe.version.create.v1": RECIPE_VERSION_CREATE_DRAFT.proposal,
  "proposal.catalogue.deal.end.v1": DEAL_END_DRAFT.proposal,
  "proposal.catalogue.coupon.set.v1": COUPON_SET_DRAFT.proposal,
  "v1.catalogue.menu": MenuResponse,
  "v1.catalogue.barcode": BarcodeLookupResponse,
};

const uuid = { type: "string", pattern: "^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$" };
const channelQuery = { name: "channel_kind", required: true, schema: { type: "string", pattern: "^(counter|table_qr|pickup|own_site|aggregator:[a-z][a-z0-9_]*)$" } };
const command = (path: string, operationId: string, type: string, summary: string): Route => ({
  surface: "public", method: "post", path, operationId, summary: `${type} — ${summary}`, auth: "member", command: type, response: "command-result", status: 200, conflict: true,
});
export const ROUTES: readonly Route[] = [
  ...READ_ROUTES,
  command("/v1/catalogue/items", "upsertCatalogueItem", "catalogue.item.upsert.v1", "create or update an item with its variants and option groups (owner/manager, all outlets)"),
  command("/v1/catalogue/recipes", "createRecipeVersion", "catalogue.recipe.version.create.v1", "the next recipe version; closes the open one; an overlapping validity or a unit that is not the ingredient's base unit is refused"),
  command("/v1/catalogue/prices", "setPrice", "catalogue.price.set.v1", "a price for an outlet and channel; closes the open one; an overlapping validity is refused"),
  command("/v1/catalogue/deals", "upsertDeal", "catalogue.deal.upsert.v1", "create or update a deal with its weekly windows (outlet time zone)"),
  { ...command("/v1/catalogue/deals/{id}:end", "endDeal", "catalogue.deal.end.v1", "end a deal (payload deal_id must equal the path id)"), pathParams: [{ name: "id", uuid: true }] },
  command("/v1/catalogue/coupons", "setCoupon", "catalogue.coupon.set.v1", "create a coupon or change its caps, end date or status"),
  command("/v1/catalogue/availability", "setAvailability", "catalogue.availability.set.v1", "mark an item sold out or back on sale at one outlet"),
  {
    surface: "public", method: "get", path: "/v1/catalogue/menu", operationId: "getMenu",
    summary: "Items for sale at an outlet and channel now: price rows, options, sold-out state and deal badges",
    auth: "member", response: "v1.catalogue.menu", status: 200,
    query: [{ name: "outlet", required: true, schema: uuid }, channelQuery],
  },
  {
    surface: "public", method: "get", path: "/v1/catalogue/barcodes/{code}", operationId: "lookupBarcode",
    summary: "Shop scan: the item or variant with this barcode and its price at the outlet; unknown code → 404",
    auth: "member", response: "v1.catalogue.barcode", status: 200,
    pathParams: [{ name: "code", uuid: false }],
    query: [{ name: "outlet", required: true, schema: uuid }, channelQuery],
  },
];
