import { T, T_PG, T_Z, citeRef, u } from "./_ids.ts";
import { SAMPLES as ORDERS, placeOrder } from "./orders.ts";

const accepting = { outlet_id: u(2), state: "busy", busy_extra_min: 10, default_prep_min: 15, next_open: null, tz: "Asia/Kolkata", as_of: T_PG };
const guest = { name: "Asha (synthetic)", phone: "+919800000000", email: null, consent: { marketing: false, at: T_Z } };

const pageDoc = {
  theme: { primary: "#7b3f1d", secondary: "#9e2f4e", accent: "#f6d9c8", radius: "round", layout: "hero-banner" },
  sections: [
    { kind: "hero", visible: true, badge: "Lucknow · pickup only", tagline: "Baked at dawn." },
    { kind: "outlets", visible: true, title: "Pick your bakehouse" },
    { kind: "ribbon", visible: false },
    { kind: "cards", visible: true, cards: [{ title: "Gift boxes", body: "Pick a box." }, { title: "Cakes", body: "With a message." }] },
  ],
};
const pageVersion = { page_id: u(70), version: 2, created_at: T_PG, created_by: u(4), created_by_name: "Nandini (synthetic)" };

export const SAMPLES: Record<string, unknown> = {
  "storefront.page.doc": pageDoc,
  "storefront.page.save.v1": { page_id: u(70), based_on_version: 1, doc: pageDoc },
  "storefront.page.publish.v1": { publish_id: u(71), page_id: u(70) },
  "v1.storefront-pages": { versions: [pageVersion], live: { page_id: u(70), version: 2, published_at: T_PG, published_by: u(4), published_by_name: "Nandini (synthetic)" } },
  "v1.storefront-page": { ...pageVersion, doc: pageDoc },
  "storefront.page.public": { page: { version: 2, published_at: T_PG, doc: pageDoc } },
  "storefront.guest.create.v1": guest,
  "storefront.order.cancel.v1": { order_id: u(10), reason: "changed_mind" },
  "storefront.order.reschedule.v1": { order_id: u(10), pickup_window_id: u(60), promised_at: T, preview_total_minor: 33600 },
  "storefront.reschedule.preview.request": { pickup_window_id: null, promised_at: T },
  "storefront.reschedule.preview.response": { order_id: u(10), promised_at: T, current_total_minor: 30240, preview: ORDERS["orders.preview.response"] },
  "storefront.outlets.response": {
    outlets: [{ outlet_id: u(2), name: "Outlet 1", kind: "restaurant", tz: "Asia/Kolkata", address: "Synthetic street", phone: "+918041234567",
      tax_ids: [{ code: "GSTIN", label: "GSTIN", value: "29ABCDE1234F1Z5" }, { code: "FSSAI", label: "FSSAI Lic. No.", value: "12345678901234" }] }],
    pay_at_counter_methods: ["cash", "card", "upi"],
  },
  "storefront.menu.response": {
    outlet_id: u(2),
    channel_id: u(4),
    channel_kind: "pickup",
    brands: [{ brand_id: u(3), name: "Spice Route Express (synthetic)" }],
    prices_include_tax: false,
    accepting,
    items: [{
      item_id: u(20), name_key: "menu.paneer_tikka", display_name: "Paneer Tikka", description: "Charred cottage cheese, mint chutney", diet: "veg", category: "mains", brand_id: u(3),
      kind: "dish", available: true, price_minor: 32000, currency: "INR", variants: [],
      option_groups: [{ option_group_id: u(22), name_key: "menu.spice", display_name: "Spice level", description: null, min_select: 0, max_select: 1, required: false,
        options: [{ option_id: u(23), name_key: "menu.spice.hot", display_name: "Hot", description: null, price_delta_minor: 1000 }] }],
    }],
    deals: [{ deal_id: u(24), name_key: "deal.lunch_window", kind: "percent_off", windows: [{ days: [1, 2], from: "12:00", to: "15:00" }], valid_from: "2026-10-01", valid_to: null }],
    pay_at_counter: true,
    pay_at_counter_methods: null,
  },
  "storefront.accepting.response": accepting,
  "storefront.pickup_windows.response": { outlet_id: u(2), windows: [{ pickup_window_id: u(60), starts_at: T_PG, ends_at: T_Z, capacity_orders: 10, booked: 3 }] },
  "storefront.order.place.request": {
    order: { command_id: u(70), idempotency_key: "place-sample-0001", type: "orders.place.v1", payload: placeOrder },
    guest: { command_id: u(71), idempotency_key: "guest-sample-0001", type: "storefront.guest.create.v1", payload: guest },
    contact: null,
  },
  "storefront.order.placed": { order_id: u(10), status: "placed", ticket_no: 47, total_minor: 30240, tax_minor: 1440, prices_include_tax: false, currency: "INR", promised_at: T, pay_at_counter: true, guest_access_token: "Zm9vYmFyYmF6cXV4MTIzNDU2Nzg5MDEyMzQ1Ng" },
  "storefront.order.view": {
    order_id: u(10), outlet_id: u(2), kind: "pickup", status: "placed", ticket_no: 47, business_date: "2026-10-12", promised_at: T, pickup_window_id: u(60),
    subtotal_minor: 32000, discount_minor: 3200, tax_minor: 1440, total_minor: 30240, currency: "INR", created_at: T_PG, cancel_window_min: 5, reschedule_window_min: 30, pay_at_counter: true,
    prices_include_tax: false,
    lines: [{ line_no: 1, item_id: u(20), variant_id: null, qty_milli: 1000, unit_price_minor: 32000, line_discount_minor: 3200, tax_minor: 1440,
      tax_rate_bp: 500, tax_component_rates: [{ code: "CGST", rate_bp: 250 }, { code: "SGST", rate_bp: 250 }] }],
    events: [{ kind: "status", from_status: null, to_status: "placed", from_promised_at: null, to_promised_at: null, reason: null, at: T_PG }],
  },
  // T-099: hand-computed IN cart (restaurant_5, exclusive): 32000 → CGST 800 + SGST 800.
  "storefront.preview.response": {
    label: "preview", priced_at: T_PG, currency: "INR", tax_rule: { pack_code: "IN", pack_version: 1 },
    lines: [{ line_no: 1, item_id: u(20), variant_id: null, qty_milli: 1000, unit_price_minor: 32000, options_minor: 0, line_discount_minor: 0, tax_minor: 1600, line_total_minor: 33600,
      tax_class: "restaurant_5", price_ref: citeRef("row", `core.price:${u(30)}`), option_refs: [], deal_refs: [], coupon_refs: [],
      tax_rate_bp: 500, tax_components: [{ code: "CGST", rate_bp: 250, amount_minor: 800 }, { code: "SGST", rate_bp: 250, amount_minor: 800 }] }],
    subtotal_minor: 32000, discount_minor: 0, tax_minor: 1600, total_minor: 33600,
    tax_components: [{ code: "CGST", rate_bp: 250, amount_minor: 800 }, { code: "SGST", rate_bp: 250, amount_minor: 800 }],
    prices_include_tax: false,
    refusals: [],
  },
  "storefront.refusal-error": {
    error: { code: "conflict", message: "Spend a little more to use this coupon.", reason_code: "coupon_min_spend" },
    params: { code: "TENSPEND", min_spend_minor: 100000, shortfall_minor: 68000, currency: "INR" },
  },
  "stream.event": { id: u(80), type: "munim.orders.order.placed.v1", data: { order_id: u(10), outlet_id: u(2), status: "placed" } },
};
