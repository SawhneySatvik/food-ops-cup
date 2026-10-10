import { MEMBER, T, T_PG, T_Z, citeRef, u } from "./_ids.ts";

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
    { line_id: u(40), item_id: u(20), variant_id: null, option_ids: [u(23)], qty_milli: 2000, barcode: null, note: "less spicy" },
    { line_id: u(41), item_id: u(21), variant_id: null, option_ids: [], qty_milli: 1000, barcode: "8901262010016", note: null },
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
  "orders.promise.push_back.v1": { order_id: u(10), from_promised_at: T, to_promised_at: "2026-10-09T10:30:00+05:30", reason_code: "kitchen_busy" },
  "orders.void.record.v1": { void_id: u(16), order_id: u(10), order_line_id: u(40), reason_code: "wrong_item", note: "rang up the wrong dish" },
  "orders.refund.record.v1": { refund_id: u(17), order_id: u(10), tender_id: u(15), method: "card", amount_minor: 5000, currency: "INR", reason_code: "quality", note: "cold food" },
  "orders.shift.open.v1": { shift_id: u(18), outlet_id: u(2), device_id: u(5), float_minor: 500000, currency: "INR" },
  "orders.shift.close.v1": { shift_id: u(18), counted_cash_minor: 558400 },
  "orders.order.accept.v1": { order_id: u(10) },
  "orders.order.reject.v1": { order_id: u(10), reason_code: "out_of_stock" },
  "orders.order.advance.v1": { order_id: u(10), from_status: "preparing", to_status: "ready", reason_code: null },
  "v1.order": {
    order_id: u(10), outlet_id: u(2), channel_id: u(4), device_id: u(5), kind: "takeaway", table_ref: null, status: "placed", business_date: "2026-10-09",
    ticket_no: 47, invoice_fy: 2026, invoice_no: 1203, promised_at: T_PG, pickup_window_id: null,
    subtotal_minor: 55600, discount_minor: 0, tax_minor: 2780, total_minor: 58380, loyalty_minor: 0, paid_minor: 0, remaining_minor: 58380, currency: "INR",
    lines: [{ line_id: u(40), line_no: 1, item_id: u(20), variant_id: null, option_ids: [u(23)], qty_milli: 2000, unit_price_minor: 27800, line_discount_minor: 0, tax_minor: 2780 }],
    tenders: [], created_at: T_Z,
  },
  "v1.order.receipt": {
    order_id: u(10), kind: "tax_invoice", title: "Tax Invoice", operator: null, seller: { name: "Outlet A", address: "1 Synthetic Road" },
    tax_ids: [{ code: "GSTIN", label: "GSTIN", value: "29ABCDE1234F1Z5" }], number: "POS1-1203", date: "09/10/2026", currency: "INR",
    lines: [{ line_no: 1, item_id: u(20), name_key: "menu.paneer_tikka", qty_milli: 2000, unit_price_minor: 27800, amount_minor: 55600, discount_minor: 0, net_minor: 55600, tax_minor: 2780, total_minor: 58380, tax_class: "restaurant_5",
      components: [{ code: "CGST", rate_bp: 250, amount_minor: 1390 }, { code: "SGST", rate_bp: 250, amount_minor: 1390 }] }],
    net_minor: 55600, tax_minor: 2780, total_minor: 58380, components: [{ code: "CGST", rate_bp: 250, amount_minor: 1390 }, { code: "SGST", rate_bp: 250, amount_minor: 1390 }],
  },
  "orders.place.guest-response": { result: { command_id: u(11), type: "orders.place.v1", entity_id: u(10), committed_at: T_PG }, guest_access_token: "gst_4f9c2a7b1e8d3c6a5b0f9e8d7c6b5a49" },
  "orders.pickup_window.generate.v1": { outlet_id: u(2), business_date: "2026-10-10", from_local: "11:00", to_local: "22:30", slot_minutes: 15, capacity_orders: 10 },
};
