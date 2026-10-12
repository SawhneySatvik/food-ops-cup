import { S1, T, snapRef, u } from "./_ids.ts";

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

/** 2-for-1 on paneer tikka, weekday tea time, outlet 2 only. */
export const dealUpsert = {
  deal_id: u(50), name_key: "deal.tea_time_2for1", rule: { kind: "buy_x_get_y", buy_qty: 1, get_qty: 1, item_ids: [u(20)] },
  windows: [{ days: [1, 2, 3, 4, 5], from: "15:00", to: "18:00" }, { days: [5, 6], from: "22:00", to: "02:00" }],
  outlet_ids: [u(2)], valid_from: "2026-10-01", valid_to: null, active: true,
};
export const couponSet = {
  coupon_id: u(51), code: "WELCOME10", kind: "percent", value_bp: 1000, value_minor: null, currency: "INR", min_spend_minor: 30000,
  global_cap: 500, per_customer_cap: null, requires_customer: false, outlet_ids: [], valid_from: T, valid_to: null, active: true,
};
const menuEntry = {
  item_id: u(20), variant_id: u(24), kind: "dish", name_key: "dish.paneer_tikka", variant_name_key: "dish.paneer_tikka.half", category: "starters",
  brand_id: null, display_name: "Paneer Tikka (synthetic)", description: "Charred cottage cheese", diet: "veg", variant_display_name: "Half plate", variant_description: null,
  barcode: null, price_id: u(30), price_minor: 24900, currency: "INR", tax_class: "restaurant_5", mrp_minor: null, available: true,
  option_groups: [{ option_group_id: u(25), name_key: "opt.extras", min_select: 0, max_select: 2, required: false, display_name: "Extras", description: null,
    options: [{ option_id: u(23), name_key: "opt.extra_paneer", price_delta_minor: 3000, currency: "INR", display_name: "Extra paneer", description: null }] }],
  deals: [{ deal_id: u(50), name_key: "deal.tea_time_2for1", kind: "buy_x_get_y", windows: dealUpsert.windows }],
};

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
  "catalogue.deal.upsert.v1": dealUpsert,
  "catalogue.deal.end.v1": { deal_id: u(50), valid_to: "2026-10-20" },
  "catalogue.coupon.set.v1": couponSet,
  "catalogue.availability.set.v1": { outlet_id: u(2), item_id: u(20), variant_id: null, available: false },
  "proposal.catalogue.recipe.version.create.v1": {
    recipe_version_id: u(29), item_id: u(20), variant_id: null, version: snapRef(S1, 0, "next_version"), valid_from: "2026-10-12", valid_to: null,
    yield_qty_milli: snapRef(S1, 0, "yield_qty_milli"),
    lines: [{ ingredient_id: u(40), qty_milli: snapRef(S1, 0, "qty_milli"), unit: "kg", waste_pct_bp: snapRef(S1, 0, "observed_waste_bp") }],
  },
  "proposal.catalogue.deal.end.v1": { deal_id: u(50), valid_to: "2026-10-12" },
  "proposal.catalogue.coupon.set.v1": {
    ...couponSet, value_bp: snapRef(S1, 0, "value_bp"), min_spend_minor: snapRef(S1, 0, "min_spend_minor"),
    global_cap: snapRef(S1, 0, "global_cap"), per_customer_cap: snapRef(S1, 0, "per_customer_cap"), requires_customer: true,
  },
  "v1.catalogue.menu": { outlet_id: u(2), channel_kind: "counter", business_date: "2026-10-09", entries: [menuEntry] },
  "v1.catalogue.barcode": { barcode: "8901262010016", item_id: u(21), variant_id: null, on_sale: true, entry: { ...menuEntry, item_id: u(21), kind: "sku", name_key: "sku.butter_100g", variant_id: null, variant_name_key: null, barcode: "8901262010016", mrp_minor: 5800, option_groups: [], deals: [] } },
  "v1.catalogue.items": {
    items: [{ item_id: u(3400), kind: "dish", name_key: "dish.paneer_tikka", category: "starters", brand_id: null, barcode: null, stock_ingredient_id: null, active: true,
      variants: [{ variant_id: u(3401), name_key: "variant.half", barcode: null, active: true }] }],
    next_cursor: null,
  },
  "v1.catalogue.recipes": {
    items: [{ recipe_version_id: u(3410), item_id: u(3400), variant_id: null, version: 1, valid_from: "2026-01-01", valid_to: null, yield_qty_milli: 1000,
      lines: [{ recipe_line_id: u(3411), ingredient_id: u(3200), qty_milli: 150000, unit: "g", waste_pct_bp: 500 }] }],
    next_cursor: null,
  },
  "v1.catalogue.prices": {
    items: [{ price_id: u(3420), item_id: u(3400), variant_id: null, outlet_id: u(2), channel_kind: "counter", amount_minor: 32000, currency: "INR", tax_class: "restaurant_5", valid_from: "2026-11-01", valid_to: null }],
    next_cursor: null,
  },
  "v1.catalogue.deals": {
    items: [{ deal_id: u(3430), kind: "happy_hour", name_key: "deal.happy_hour", rule: { percent_bp: 1000 }, windows: [], outlet_ids: [], valid_from: "2026-10-01", valid_to: null, active: true }],
    next_cursor: null,
  },
  "v1.catalogue.coupons": {
    items: [{ coupon_id: u(3440), code: "WELCOME10", kind: "percent", value_bp: 1000, value_minor: null, currency: "INR", min_spend_minor: 20000, global_cap: 100, per_customer_cap: 1,
      requires_customer: false, outlet_ids: [], campaign_id: null, valid_from: T, valid_to: null, active: true }],
    next_cursor: null,
  },
};
