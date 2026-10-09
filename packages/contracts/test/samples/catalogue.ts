import { u } from "./_ids.ts";

export const priceSet = {
  price_id: u(30),
  item_id: u(20),
  variant_id: null,
  outlet_id: u(2),
  channel_kind: "aggregator:swiggy",
  amount_minor: 24900,
  currency: "INR",
  tax_class: "restaurant_5",
  valid_from: "2026-10-10",
  valid_to: null,
};

/** A shop SKU: stocked through its 1:1 ingredient row, MRP printed. */
export const skuItem = { item_id: u(21), name_key: "sku.butter_100g", category: "dairy", brand_id: null, barcode: "8901262010016", mrp_minor: 5800, currency: "INR", active: true, variants: [], option_groups: [], kind: "sku", stock_ingredient_id: u(43) };

export const SAMPLES: Record<string, unknown> = {
  "catalogue.item.upsert.v1": {
    item_id: u(20),
    name_key: "dish.paneer_tikka",
    category: "starters",
    brand_id: u(3),
    barcode: null,
    mrp_minor: null,
    currency: null,
    active: true,
    variants: [{ variant_id: u(24), name_key: "dish.paneer_tikka.half", barcode: null, active: true }],
    option_groups: [
      {
        option_group_id: u(25),
        name_key: "opt.extras",
        min_select: 0,
        max_select: 2,
        required: false,
        options: [
          { option_id: u(23), name_key: "opt.extra_paneer", price_delta_minor: 3000, currency: "INR", active: true, ingredient_deltas: [{ delta_id: u(26), ingredient_id: u(40), qty_milli: 50, unit: "kg", waste_pct_bp: 0 }] },
          { option_id: u(27), name_key: "opt.no_onion", price_delta_minor: 0, currency: "INR", active: true, ingredient_deltas: [{ delta_id: u(28), ingredient_id: u(42), qty_milli: -20, unit: "kg", waste_pct_bp: 0 }] },
        ],
      },
    ],
    kind: "dish",
    stock_ingredient_id: null,
  },
  "catalogue.recipe.version.create.v1": { recipe_version_id: u(22), item_id: u(20), variant_id: null, version: 1, valid_from: "2026-10-01", valid_to: null, yield_qty_milli: 1000, lines: [{ ingredient_id: u(40), qty_milli: 150, unit: "kg", waste_pct_bp: 500 }] },
  "catalogue.price.set.v1": priceSet,
};
