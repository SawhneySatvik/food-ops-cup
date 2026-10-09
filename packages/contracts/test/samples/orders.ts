import { MEMBER, T, T_PG, citeRef, u } from "./_ids.ts";

export const placeOrder = {
  order_id: u(10),
  outlet_id: u(2),
  channel_id: u(4),
  brand_id: u(3),
  device_id: u(5),
  kind: "takeaway",
  table_ref: null,
  pickup_window_id: null,
  promised_at: T,
  external_ref: null,
  lines: [
    { item_id: u(20), variant_id: null, option_ids: [u(23)], qty_milli: 2000, barcode: null, note: "less spicy" },
    { item_id: u(21), variant_id: null, option_ids: [], qty_milli: 1000, barcode: "8901262010016", note: null },
  ],
  coupon_codes: ["DIWALI-10"],
  loyalty_redeem_points: 200,
  preview_total_minor: 58380,
  client_totals: { subtotal: { amount_minor: 55600, currency: "INR" }, total: { amount_minor: 58380, currency: "INR" } },
};

const row = (table: string, n: number) => citeRef("row", `core.${table}:${u(n)}`);

export const cardTender = { tender_id: u(15), order_id: u(10), method: "card", amount_minor: 58380, tendered_minor: null, change_minor: null, rounding_minor: null, currency: "INR", ref: "APPR-4471", recorded_by: MEMBER, at: T_PG };

export const SAMPLES: Record<string, unknown> = {
  "orders.preview.request": { outlet_id: u(2), channel_id: u(4), brand_id: u(3), kind: "takeaway", pickup_window_id: null, promised_at: T, coupon_codes: ["DIWALI-10"], loyalty_redeem_points: 0, lines: [{ item_id: u(20), variant_id: null, option_ids: [u(23)], qty_milli: 2000, barcode: null }] },
  "orders.preview.response": {
    label: "preview",
    priced_at: T_PG,
    currency: "INR",
    tax_rule: { pack_code: "IN", pack_version: 1 },
    lines: [{ line_no: 1, item_id: u(20), variant_id: null, qty_milli: 2000, unit_price_minor: 24900, options_minor: 3000, line_discount_minor: 5580, tax_minor: 2511, line_total_minor: 52731, tax_class: "restaurant_5", price_ref: row("price", 30), option_refs: [row("option", 23)], deal_refs: [], coupon_refs: [row("coupon", 31)] }],
    subtotal_minor: 55800,
    discount_minor: 5580,
    tax_minor: 2511,
    total_minor: 52731,
    refusals: [{ line_no: null, reason_code: "coupon_min_spend" }],
  },
  "orders.tender.record.v1": { tender_id: u(14), order_id: u(10), method: "cash", tendered_minor: 60000, amount_minor: null, currency: "INR", ref: null },
  "v1.tender": { tender_id: u(14), order_id: u(10), method: "cash", amount_minor: 58400, tendered_minor: 60000, change_minor: 1600, rounding_minor: 20, currency: "INR", ref: null, recorded_by: MEMBER, at: T_PG },
  "orders.place.v1": placeOrder,
  "orders.pickup_window.generate.v1": { outlet_id: u(2), business_date: "2026-10-10", from_local: "11:00", to_local: "22:30", slot_minutes: 15, capacity_orders: 10 },
};
