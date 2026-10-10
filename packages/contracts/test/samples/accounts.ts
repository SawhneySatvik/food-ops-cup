import { T_PG, T_Z, TENANT, u } from "./_ids.ts";

const profile = {
  customer_id: u(3501), name: "Asha (synthetic)", phone: "+919800000001", email: "asha@example.test",
  email_verified_at: T_PG, consent: { marketing: true, at: T_Z }, is_guest: false, created_at: T_PG,
};
const order = {
  order_id: u(3502), outlet_id: u(2), channel_id: u(3503), kind: "pickup", status: "completed", business_date: "2026-10-09",
  ticket_no: 7, subtotal_minor: 32000, discount_minor: 0, tax_minor: 1600, total_minor: 33600, currency: "INR", created_at: T_PG,
};
const line = {
  line_id: u(3504), line_no: 1, item_id: u(3505), item_name_key: "menu.masala_dosa", variant_id: null, qty_milli: 2000,
  unit_price_minor: 16000, line_discount_minor: 0, tax_minor: 1600,
};
const entry = { entry_id: u(3506), seq: 1, kind: "earn", points: 33, balance_after: 33, order_id: u(3502), note: null, created_at: T_PG };

export const SAMPLES: Record<string, unknown> = {
  "customers.account.link.v1": { name: "Asha (synthetic)", phone: null },
  "customers.profile.update.v1": { name: "Asha R (synthetic)", phone: "+919800000001" },
  "customers.consent.set.v1": { marketing: false },
  "customers.data.export.v1": { format: "json" },
  "customers.erasure.request.v1": { confirm: true },
  "v1.account.profile": profile,
  "v1.account.orders": { orders: [order], next_cursor: null },
  "v1.account.order": { order, lines: [line] },
  "v1.account.loyalty": { balance: { points: 33, entry_id: u(3506), seq: 1 }, entries: [entry] },
  "v1.account.export": {
    command: { command_id: u(3507), type: "customers.data.export.v1", entity_id: u(3501), committed_at: T_PG },
    export: {
      format: "munim.customer-export.v1", generated_at: T_PG, tenant_id: TENANT, profile,
      orders: [{ order, lines: [line] }], loyalty_entries: [entry],
      reservations: [{ reservation_id: u(3508), outlet_id: u(2), name: "Asha (synthetic)", phone: null, party_size: 2, starts_at: T_Z,
        status: "booked", note: null, created_at: T_PG }],
      bulk_orders: [],
      order_events: [{ order_event_id: u(3509), order_id: u(3502), kind: "status", from_status: "placed", to_status: "accepted", from_promised_at: null, to_promised_at: null, reason: null, at: T_PG }],
      tenders: [{ tender_id: u(3510), order_id: u(3502), method: "cash", amount_minor: 33600, tendered_minor: 34000, change_minor: 400, currency: "INR", ref: null, at: T_PG }],
      refunds: [{ refund_id: u(3511), order_id: u(3502), tender_id: u(3510), method: "cash", amount_minor: 16000, currency: "INR", reason_code: "wrong_item", note: "synthetic", at: T_PG }],
      coupon_uses: [{ coupon_use_id: u(3512), coupon_id: u(3513), order_id: u(3502), discount_minor: 500, currency: "INR", at: T_PG }],
      voids: [{ void_id: u(3514), order_id: u(3502), order_line_id: u(3504), reason_code: "remake", note: "synthetic", amount_minor: 16000, currency: "INR", at: T_PG }],
      sale_returns: [{ sale_return_id: u(3515), order_id: u(3502), order_line_id: u(3504), qty_milli: 1000, restock: false, reason_code: "damaged", note: "synthetic", at: T_PG }],
    },
  },
};
