// Catalogue setup commands (02-schema §2.3). Prices and recipes are versioned by validity; overlaps are
// refused by the database (exclusion constraints).
import { z } from "zod";
import { BasisPoints, CurrencyCode, IsoDate, MinorAmount, QtyMilli, Slug, Unit, Uuid7 } from "../shared/primitives.ts";
import { defineDraftable } from "../shared/draftables.ts";
import type { Route } from "../shared/routes.ts";
import { ChannelKind } from "../tenancy/index.ts";

export const ItemKind = z.enum(["dish", "sku", "combo"]);
const Barcode = z.string().regex(/^[0-9A-Za-z-]{4,32}$/);

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
  })
  .superRefine((g, ctx) => {
    if (g.max_select < g.min_select) ctx.addIssue({ code: "custom", path: ["max_select"], message: "max_select ≥ min_select" });
    if (g.required && g.min_select < 1) ctx.addIssue({ code: "custom", path: ["min_select"], message: "a required group selects at least one" });
  });

export const ItemVariant = z.strictObject({ variant_id: Uuid7, name_key: Slug, barcode: Barcode.nullable(), active: z.boolean() });

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

/** Intel may propose a price change as a draft (catalogue pack). */
export const PRICE_SET_DRAFT = defineDraftable("catalogue.price.set.v1", CataloguePriceSetV1);

export const SCHEMAS = {
  "catalogue.item.upsert.v1": CatalogueItemUpsertV1,
  "catalogue.recipe.version.create.v1": CatalogueRecipeVersionCreateV1,
  "catalogue.price.set.v1": CataloguePriceSetV1,
  "proposal.catalogue.price.set.v1": PRICE_SET_DRAFT.proposal,
};
export const ROUTES: readonly Route[] = [];
