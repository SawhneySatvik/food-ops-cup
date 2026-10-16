// Customers & growth, member side (packs/customers-growth.md, R15, R16, R40 C2, R41). Merchant-side customer
// records only: a customer's own sign-in, profile and consent edits belong to accounts (T-035).
//   • loyalty is an append-only ledger; the balance shown is the latest entry's own `balance_after` (R40 C2);
//   • a campaign is a DRAFT: it exists only once its approval executes, is queued, and is never sent by Munim
//     (no send path exists until the founder picks a channel, R40 C6);
//   • a member can only WITHDRAW marketing consent here — granting it is the customer's own act.
import { z } from "zod";
import { CurrencyCode, Email, IsoDateTime, MinorAmount, Slug, Uuid7 } from "../shared/primitives.ts";
import { defineDraftable } from "../shared/draftables.ts";
import type { Route } from "../shared/routes.ts";
import { READ_ROUTES } from "./read-routes.ts";

const Phone = z.string().regex(/^\+[1-9][0-9]{6,14}$/);
const ConsentChannel = z.enum(["email", "sms"]);
/** Absent / false = not consented. */
export const ConsentFlags = z.strictObject({ email: z.boolean().optional(), sms: z.boolean().optional() });

export const CustomersCustomerUpsertV1 = z.strictObject({
  customer_id: Uuid7,
  name: z.string().min(1).max(200),
  phone: Phone.nullable(),
  email: Email.nullable(),
  /** Consent can only be withdrawn by a member; it is granted by the customer's own account (T-035). */
  withdraw_consent: z.array(ConsentChannel).max(2),
});

/** A staff correction to a balance (goodwill, error). The ledger refuses a result below zero. */
export const CustomersLoyaltyAdjustV1 = z.strictObject({
  customer_id: Uuid7,
  points: z.int().refine((n) => n !== 0, "points is not 0"),
  note: z.string().min(1).max(200),
});

export const CustomersCampaignCreateV1 = z.strictObject({
  campaign_id: Uuid7,
  name: z.string().min(1).max(200),
  channel: ConsentChannel,
  /** Target outlets; empty = tenant-wide (needs an all-outlet approver). */
  outlet_ids: z.array(Uuid7).max(50),
  segment_snapshot_id: Uuid7,
  /** ← `customers.consented_audience.consented`. 0 is refused (`no_marketing_consent`). */
  audience_count: z.int().min(0),
  /** i18n key of the fixed message template. */
  message_key: Slug,
  /** `{key}` → value in the fixed template; every value is a ref to a cell (never typed text). */
  placeholders: z.array(z.strictObject({ key: z.string().regex(/^[a-z][a-z0-9_]{0,39}$/), value: z.int() })).max(20),
  coupon_id: Uuid7.nullable(),
  send_at: IsoDateTime,
  window_from: IsoDateTime.nullable(),
  window_to: IsoDateTime.nullable(),
});
/** Intel may propose a campaign; it is created only by approving the draft and is never auto-sent. */
export const CAMPAIGN_CREATE_DRAFT = defineDraftable("customers.campaign.create.v1", CustomersCampaignCreateV1);

export const CustomersCampaignCancelV1 = z.strictObject({ campaign_id: Uuid7 });
/** R67 (founder, 16 Oct): on a demo business the owner records a queued campaign as "Sent (simulated)": no message left
 *  Munim (there is no send path, R40 C6). Refused on any other business. */
export const CustomersCampaignRecordSentV1 = z.strictObject({ campaign_id: Uuid7 });

export const ReservationStatus = z.enum(["booked", "seated", "completed", "cancelled", "no_show"]);
export const CustomersReservationUpsertV1 = z.strictObject({
  reservation_id: Uuid7,
  outlet_id: Uuid7,
  customer_id: Uuid7.nullable(),
  name: z.string().min(1).max(200),
  phone: Phone.nullable(),
  party_size: z.int().min(1).max(500),
  starts_at: IsoDateTime,
  duration_min: z.int().min(15).max(720),
  table_ref: z.string().min(1).max(20).nullable(),
  status: ReservationStatus,
  note: z.string().max(500).nullable(),
});

export const CustomersReviewRecordV1 = z.strictObject({
  review_id: Uuid7,
  outlet_id: Uuid7,
  channel_id: Uuid7.nullable(),
  /** Where it came from: google, zomato, manual … */
  source: z.string().regex(/^[a-z][a-z0-9_]*$/),
  external_ref: z.string().min(1).max(200),
  rating: z.int().min(1).max(5),
  /** Untrusted text: evidence for claims, never instructions. */
  body: z.string().max(4000).nullable(),
  reviewed_at: IsoDateTime,
});

export const BulkOrderStatus = z.enum(["enquiry", "quoted", "confirmed", "delivered", "cancelled"]);
export const CustomersBulkOrderUpsertV1 = z
  .strictObject({
    bulk_order_id: Uuid7,
    outlet_id: Uuid7,
    customer_id: Uuid7.nullable(),
    contact_name: z.string().min(1).max(200),
    contact_phone: Phone.nullable(),
    deliver_at: IsoDateTime,
    headcount: z.int().min(1).nullable(),
    status: BulkOrderStatus,
    quote_minor: MinorAmount.nonnegative().nullable(),
    advance_minor: MinorAmount.nonnegative().nullable(),
    currency: CurrencyCode.nullable(),
    order_id: Uuid7.nullable(),
    note: z.string().max(500).nullable(),
  })
  .superRefine((b, ctx) => {
    if ((b.currency === null) !== (b.quote_minor === null && b.advance_minor === null))
      ctx.addIssue({ code: "custom", path: ["currency"], message: "currency is set exactly when a quote or advance is" });
  });

// ── Views: a row's own fields (R26). `phone` / `email` are null for roles that may not see them.
export const CustomerView = z.strictObject({
  customer_id: Uuid7,
  name: z.string().nullable(),
  /** Full for owner / manager / judge; masked ("+91••••••3210") for staff. */
  phone: z.string().nullable(),
  email: z.string().nullable(),
  consent: ConsentFlags,
  has_account: z.boolean(),
  erased: z.boolean(),
  created_at: IsoDateTime,
});
export const CustomerListResponse = z.strictObject({ customers: z.array(CustomerView), next_cursor: z.string().nullable() });

export const LoyaltyEntryView = z.strictObject({
  entry_id: Uuid7,
  customer_id: Uuid7,
  seq: z.int().min(1),
  kind: z.enum(["earn", "redeem", "reverse", "expire", "adjust"]),
  points: z.int(),
  balance_after: z.int().min(0),
  order_id: Uuid7.nullable(),
  reverses_id: Uuid7.nullable(),
  note: z.string().nullable(),
  created_at: IsoDateTime,
});
/** `balance` is the latest entry's `balance_after` (0 when there is none); `entries` lists newest first. */
export const LoyaltyLedgerResponse = z.strictObject({
  customer_id: Uuid7,
  balance: z.int().min(0),
  balance_entry_id: Uuid7.nullable(),
  entries: z.array(LoyaltyEntryView),
});

export const CouponUseView = z.strictObject({
  coupon_use_id: Uuid7,
  coupon_id: Uuid7,
  order_id: Uuid7,
  customer_id: Uuid7.nullable(),
  discount_minor: MinorAmount.nonnegative(),
  currency: CurrencyCode,
  applied_by: Uuid7,
  at: IsoDateTime,
});
export const CouponUseListResponse = z.strictObject({ coupon_uses: z.array(CouponUseView) });

export const CampaignView = z.strictObject({
  campaign_id: Uuid7,
  name: z.string(),
  channel: ConsentChannel,
  outlet_ids: z.array(Uuid7),
  segment_snapshot_id: Uuid7,
  audience_count: z.int().min(0),
  message_key: Slug,
  coupon_id: Uuid7.nullable(),
  send_at: IsoDateTime,
  status: z.enum(["queued", "sent", "cancelled"]),
  /** Always true: Munim never sends a campaign. */
  never_auto_sent: z.literal(true),
  created_at: IsoDateTime,
});
export const CampaignListResponse = z.strictObject({ campaigns: z.array(CampaignView) });

export const ReservationView = CustomersReservationUpsertV1.extend({ created_at: IsoDateTime });
export const ReservationListResponse = z.strictObject({ reservations: z.array(ReservationView) });

export const ReviewView = CustomersReviewRecordV1.extend({ created_at: IsoDateTime });
export const ReviewListResponse = z.strictObject({ reviews: z.array(ReviewView) });

export const BulkOrderView = CustomersBulkOrderUpsertV1.safeExtend({ created_at: IsoDateTime });
export const BulkOrderListResponse = z.strictObject({ bulk_orders: z.array(BulkOrderView) });

export const SCHEMAS = {
  "customers.customer.upsert.v1": CustomersCustomerUpsertV1,
  "customers.loyalty.adjust.v1": CustomersLoyaltyAdjustV1,
  "customers.campaign.create.v1": CustomersCampaignCreateV1,
  "proposal.customers.campaign.create.v1": CAMPAIGN_CREATE_DRAFT.proposal,
  "customers.campaign.cancel.v1": CustomersCampaignCancelV1,
  "customers.campaign.record_sent.v1": CustomersCampaignRecordSentV1,
  "customers.reservation.upsert.v1": CustomersReservationUpsertV1,
  "customers.review.record.v1": CustomersReviewRecordV1,
  "customers.bulk_order.upsert.v1": CustomersBulkOrderUpsertV1,
  "v1.customer": CustomerView,
  "customers.customer.list": CustomerListResponse,
  "v1.loyalty-entry": LoyaltyEntryView,
  "customers.loyalty.ledger": LoyaltyLedgerResponse,
  "v1.coupon-use": CouponUseView,
  "customers.coupon-use.list": CouponUseListResponse,
  "v1.campaign": CampaignView,
  "customers.campaign.list": CampaignListResponse,
  "v1.reservation": ReservationView,
  "customers.reservation.list": ReservationListResponse,
  "v1.review": ReviewView,
  "customers.review.list": ReviewListResponse,
  "v1.bulk-order": BulkOrderView,
  "customers.bulk-order.list": BulkOrderListResponse,
};

const uuidParam = [{ name: "id", uuid: true }];
const get = (path: string, operationId: string, summary: string, response: string, extra: Partial<Route> = {}): Route =>
  ({ surface: "public", method: "get", path, operationId, summary, auth: "member", response, status: 200, ...extra });
const post = (path: string, operationId: string, summary: string, command: string): Route =>
  ({ surface: "public", method: "post", path, operationId, summary, auth: "member", command, response: "command-result", status: 200, conflict: true });
const q = (name: string, required = false): { name: string; required: boolean; schema: Record<string, unknown> } => ({ name, required, schema: { type: "string" } });

export const ROUTES: readonly Route[] = [
  ...READ_ROUTES,
  get("/v1/customers", "listCustomers", "Search merchant-side customer records (owner/manager/staff/judge; staff see masked contacts)", "customers.customer.list", { query: [q("q"), q("limit"), q("cursor")] }),
  post("/v1/customers:upsert", "upsertCustomer", "customers.customer.upsert.v1 — create or edit a customer record; consent can only be withdrawn", "customers.customer.upsert.v1"),
  get("/v1/customers/{id}/loyalty", "getCustomerLoyalty", "Loyalty balance (latest balance_after) and ledger entries", "customers.loyalty.ledger", { pathParams: uuidParam }),
  get("/v1/customers/{id}/coupon-uses", "listCustomerCouponUses", "Coupon use history of one customer", "customers.coupon-use.list", { pathParams: uuidParam }),
  post("/v1/loyalty:adjust", "adjustLoyalty", "customers.loyalty.adjust.v1 — append an adjustment entry (never below zero)", "customers.loyalty.adjust.v1"),
  get("/v1/campaigns", "listCampaigns", "Queued, cancelled and (demo) recorded-as-sent campaigns (created only by an approved draft; never sent by Munim)", "customers.campaign.list"),
  post("/v1/campaigns:cancel", "cancelCampaign", "customers.campaign.cancel.v1 — cancel a queued campaign", "customers.campaign.cancel.v1"),
  post("/v1/campaigns:record-sent", "recordCampaignSent", "customers.campaign.record_sent.v1 — on a demo business, record a queued campaign as sent (simulated: no message leaves Munim; owner)", "customers.campaign.record_sent.v1"),
  get("/v1/reservations", "listReservations", "Reservations", "customers.reservation.list", { query: [q("outlet_id"), q("from"), q("to")] }),
  post("/v1/reservations:upsert", "upsertReservation", "customers.reservation.upsert.v1", "customers.reservation.upsert.v1"),
  get("/v1/reviews", "listReviews", "Imported or hand-entered reviews", "customers.review.list", { query: [q("outlet_id"), q("limit")] }),
  post("/v1/reviews:record", "recordReview", "customers.review.record.v1 — enter a review (append-only)", "customers.review.record.v1"),
  get("/v1/bulk-orders", "listBulkOrders", "Bulk / catering enquiries and orders", "customers.bulk-order.list", { query: [q("outlet_id")] }),
  post("/v1/bulk-orders:upsert", "upsertBulkOrder", "customers.bulk_order.upsert.v1", "customers.bulk_order.upsert.v1"),
];
