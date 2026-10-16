import { T, u } from "./_ids.ts";

const reservation = { reservation_id: u(300), outlet_id: u(2), customer_id: u(310), name: "Synthetic Guest", phone: "+919800000001", party_size: 4, starts_at: "2026-10-12T19:30:00+05:30", duration_min: 90, table_ref: "T4", status: "booked", note: null };
const review = { review_id: u(320), outlet_id: u(2), channel_id: null, source: "manual", external_ref: "sample-review-1", rating: 4, body: "Synthetic review text.", reviewed_at: T };
const bulk = { bulk_order_id: u(330), outlet_id: u(2), customer_id: null, contact_name: "Synthetic Office", contact_phone: "+919800000002", deliver_at: "2026-10-20T12:00:00+05:30", headcount: 40, status: "quoted", quote_minor: 1800000, advance_minor: 300000, currency: "INR", order_id: null, note: null };
const entry = { entry_id: u(340), customer_id: u(310), seq: 2, kind: "redeem", points: -10, balance_after: 25, order_id: u(20), reverses_id: null, note: null, created_at: T };
const campaign = { campaign_id: u(350), name: "Come back", channel: "email", outlet_ids: [u(2)], segment_snapshot_id: u(900), audience_count: 12, message_key: "campaign.come_back", coupon_id: null, send_at: T, status: "queued", never_auto_sent: true, created_at: T };
const customer = { customer_id: u(310), name: "Synthetic Customer", phone: "+919800000001", email: "customer@example.test", consent: { email: true, sms: false }, has_account: false, erased: false, created_at: T };
const couponUse = { coupon_use_id: u(360), coupon_id: u(361), order_id: u(20), customer_id: u(310), discount_minor: 5000, currency: "INR", applied_by: u(8), at: T };

export const SAMPLES: Record<string, unknown> = {
  "customers.customer.upsert.v1": { customer_id: u(310), name: "Synthetic Customer", phone: "+919800000001", email: "customer@example.test", withdraw_consent: ["sms"] },
  "customers.loyalty.adjust.v1": { customer_id: u(310), points: 25, note: "Goodwill after a late order" },
  "customers.campaign.create.v1": { campaign_id: u(350), name: "Come back", channel: "email", outlet_ids: [u(2)], segment_snapshot_id: u(900), audience_count: 12, message_key: "campaign.come_back", placeholders: [{ key: "regulars", value: 40 }], coupon_id: null, send_at: T, window_from: null, window_to: null },
  "proposal.customers.campaign.create.v1": { campaign_id: u(350), name: "Come back", channel: "email", outlet_ids: [u(2)], segment_snapshot_id: u(900), audience_count: `⟨snap:${u(900)}·0·consented⟩`, message_key: "campaign.come_back", placeholders: [{ key: "regulars", value: `⟨snap:${u(900)}·0·audience⟩` }], coupon_id: null, send_at: T, window_from: null, window_to: null },
  "customers.campaign.cancel.v1": { campaign_id: u(350) },
  "customers.campaign.record_sent.v1": { campaign_id: u(350) },
  "customers.reservation.upsert.v1": reservation,
  "customers.review.record.v1": review,
  "customers.bulk_order.upsert.v1": bulk,
  "v1.customer": customer,
  "customers.customer.list": { customers: [customer], next_cursor: null },
  "v1.loyalty-entry": entry,
  "customers.loyalty.ledger": { customer_id: u(310), balance: 25, balance_entry_id: u(340), entries: [entry] },
  "v1.coupon-use": couponUse,
  "customers.coupon-use.list": { coupon_uses: [couponUse] },
  "v1.campaign": campaign,
  "customers.campaign.list": { campaigns: [campaign] },
  "v1.reservation": { ...reservation, created_at: T },
  "customers.reservation.list": { reservations: [{ ...reservation, created_at: T }] },
  "v1.review": { ...review, created_at: T },
  "customers.review.list": { reviews: [{ ...review, created_at: T }] },
  "v1.bulk-order": { ...bulk, created_at: T },
  "customers.bulk-order.list": { bulk_orders: [{ ...bulk, created_at: T }] },
};
