import { T, T_PG, T_Z, u } from "./_ids.ts";
import { SAMPLES as ORDERS, placeOrder } from "./orders.ts";

const accepting = { outlet_id: u(2), state: "busy", busy_extra_min: 10, default_prep_min: 15, next_open: null, tz: "Asia/Kolkata", as_of: T_PG };
const guest = { name: "Asha (synthetic)", phone: "+919800000000", email: null, consent: { marketing: false, at: T_Z } };

export const SAMPLES: Record<string, unknown> = {
  "storefront.guest.create.v1": guest,
  "storefront.order.cancel.v1": { order_id: u(10), reason: null },
  "storefront.order.reschedule.v1": { order_id: u(10), pickup_window_id: u(60), promised_at: T, preview_total_minor: 33600 },
  "storefront.reschedule.preview.request": { pickup_window_id: null, promised_at: T },
  "storefront.reschedule.preview.response": { order_id: u(10), promised_at: T, current_total_minor: 30240, preview: ORDERS["orders.preview.response"] },
  "storefront.outlets.response": { outlets: [{ outlet_id: u(2), name: "Outlet 1", kind: "restaurant", tz: "Asia/Kolkata", address: "Synthetic street" }] },
  "storefront.menu.response": {
    outlet_id: u(2),
    channel_kind: "pickup",
    accepting,
    items: [{
      item_id: u(20), name_key: "menu.paneer_tikka", category: "mains", kind: "dish", available: true, price_minor: 32000, currency: "INR", variants: [],
      option_groups: [{ option_group_id: u(22), name_key: "menu.spice", min_select: 0, max_select: 1, required: false, options: [{ option_id: u(23), name_key: "menu.spice.hot", price_delta_minor: 1000 }] }],
    }],
    deals: [{ deal_id: u(24), name_key: "deal.lunch_window", kind: "percent_off", windows: [{ days: [1, 2], from: "12:00", to: "15:00" }], valid_from: "2026-10-01", valid_to: null }],
    pay_at_counter: true,
  },
  "storefront.accepting.response": accepting,
  "storefront.pickup_windows.response": { outlet_id: u(2), windows: [{ pickup_window_id: u(60), starts_at: T_PG, ends_at: T_Z, capacity_orders: 10, booked: 3 }] },
  "storefront.order.place.request": {
    order: { command_id: u(70), idempotency_key: "place-sample-0001", type: "orders.place.v1", payload: placeOrder },
    guest: { command_id: u(71), idempotency_key: "guest-sample-0001", type: "storefront.guest.create.v1", payload: guest },
    contact: null,
  },
  "storefront.order.placed": { order_id: u(10), status: "placed", ticket_no: 47, total_minor: 30240, currency: "INR", promised_at: T, pay_at_counter: true, guest_access_token: "Zm9vYmFyYmF6cXV4MTIzNDU2Nzg5MDEyMzQ1Ng" },
  "storefront.order.view": {
    order_id: u(10), outlet_id: u(2), kind: "pickup", status: "placed", ticket_no: 47, business_date: "2026-10-12", promised_at: T, pickup_window_id: u(60),
    subtotal_minor: 32000, discount_minor: 3200, tax_minor: 1440, total_minor: 30240, currency: "INR", created_at: T_PG, cancel_window_min: 5, reschedule_window_min: 30, pay_at_counter: true,
    lines: [{ line_no: 1, item_id: u(20), variant_id: null, qty_milli: 1000, unit_price_minor: 32000, line_discount_minor: 3200, tax_minor: 1440 }],
    events: [{ kind: "status", from_status: null, to_status: "placed", from_promised_at: null, to_promised_at: null, reason: null, at: T_PG }],
  },
};
