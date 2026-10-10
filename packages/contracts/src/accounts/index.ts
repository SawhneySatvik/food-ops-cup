// Customer accounts (T-035; ledger R41, R42). One login (an IdP user), one separate core.customer profile per
// merchant. Every route is storefront-keyed (the key names the merchant) and needs the customer's own token;
// the profile, its orders and its loyalty are only ever that customer's own rows at that merchant (R27).
// Tenant, customer id and email are never taken from a payload: they come from the storefront key and the
// verified token. Guest-order claim: the guest access token travels in the `X-Munim-Guest-Token` header,
// never in a payload, an audit entry or a response.
import { z } from "zod";
import { CommandResult } from "../shared/command.ts";
import { CurrencyCode, Email, IsoDate, IsoDateTime, NonEmpty, Uuid7 } from "../shared/primitives.ts";
import type { Route } from "../shared/routes.ts";

/** E.164, equal to the DB check on core.customer.phone. */
const Phone = z.string().regex(/^\+[1-9][0-9]{6,14}$/);
/** Any lowercase UUID (rows written before v7 ids, e.g. test fixtures, are still readable). */
const Id = z.string().regex(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);

/** First sign-in at this merchant creates the profile (name required by the profile row); with the
 *  `X-Munim-Guest-Token` header it also claims that guest order. With a profile already present it only claims. */
export const CustomersAccountLinkV1 = z.strictObject({
  name: NonEmpty,
  phone: Phone.nullable(),
});

/** The login's email is the IdP's and is not editable here. */
export const CustomersProfileUpdateV1 = z.strictObject({
  name: NonEmpty,
  phone: Phone.nullable(),
});

/** Stored as `{marketing, at}` (the storefront.guest.create.v1 shape); `at` is set by core. */
export const CustomersConsentSetV1 = z.strictObject({
  marketing: z.boolean(),
});

export const CustomersDataExportV1 = z.strictObject({
  format: z.literal("json"),
});

/** Personal fields are anonymised and the profile is closed; order rows are kept (legal records). Final. */
export const CustomersErasureRequestV1 = z.strictObject({
  confirm: z.literal(true),
});

export const AccountConsent = z.strictObject({ marketing: z.boolean(), at: IsoDateTime });

export const AccountProfile = z.strictObject({
  customer_id: Id,
  name: z.string().nullable(),
  phone: Phone.nullable(),
  email: Email.nullable(),
  email_verified_at: IsoDateTime.nullable(),
  /** null until the customer (or their guest checkout) recorded a choice. */
  consent: AccountConsent.nullable(),
  is_guest: z.boolean(),
  created_at: IsoDateTime,
});

/** One order, every field the row's own (money in minor units + the order's currency). */
export const AccountOrder = z.strictObject({
  order_id: Id,
  outlet_id: Id,
  channel_id: Id,
  kind: z.enum(["dine_in", "takeaway", "pickup", "delivery"]),
  status: z.enum(["placed", "accepted", "rejected", "preparing", "ready", "completed", "cancelled"]),
  business_date: IsoDate,
  ticket_no: z.int(),
  subtotal_minor: z.int(),
  discount_minor: z.int(),
  tax_minor: z.int(),
  total_minor: z.int(),
  currency: CurrencyCode,
  created_at: IsoDateTime,
});

export const AccountOrderLine = z.strictObject({
  line_id: Id,
  line_no: z.int(),
  item_id: Id,
  /** core.item.name_key of the line's item (an i18n key; the storefront renders it). */
  item_name_key: z.string(),
  variant_id: Id.nullable(),
  qty_milli: z.int(),
  unit_price_minor: z.int(),
  line_discount_minor: z.int(),
  tax_minor: z.int(),
});

export const AccountOrdersResponse = z.strictObject({
  orders: z.array(AccountOrder),
  /** Pass as `cursor` for the next (older) page; null on the last page. */
  next_cursor: Id.nullable(),
});

export const AccountOrderDetail = z.strictObject({
  order: AccountOrder,
  lines: z.array(AccountOrderLine),
});

export const AccountLoyaltyEntry = z.strictObject({
  entry_id: Id,
  seq: z.int(),
  kind: z.enum(["earn", "redeem", "reverse", "expire", "adjust"]),
  points: z.int(),
  balance_after: z.int(),
  order_id: Id.nullable(),
  note: z.string().nullable(),
  created_at: IsoDateTime,
});

/** The balance is the latest entry's own `balance_after` (R40), cited by entry id and seq — never a sum. */
export const AccountLoyalty = z.strictObject({
  balance: z.strictObject({ points: z.int(), entry_id: Id, seq: z.int() }).nullable(),
  entries: z.array(AccountLoyaltyEntry),
});

const ExportReservation = z.strictObject({
  reservation_id: Id,
  outlet_id: Id,
  name: z.string(),
  phone: Phone.nullable(),
  party_size: z.int(),
  starts_at: IsoDateTime,
  status: z.string(),
  note: z.string().nullable(),
  created_at: IsoDateTime,
});

const ExportBulkOrder = z.strictObject({
  bulk_order_id: Id,
  outlet_id: Id,
  contact_name: z.string(),
  contact_phone: Phone.nullable(),
  deliver_at: IsoDateTime,
  headcount: z.int().nullable(),
  status: z.string(),
  quote_minor: z.int().nullable(),
  advance_minor: z.int().nullable(),
  currency: CurrencyCode.nullable(),
  order_id: Id.nullable(),
  note: z.string().nullable(),
  created_at: IsoDateTime,
});

/** The order's other own rows (B14). Staff ids (actor, recorded_by, applied_by) are never exported. */
const ExportOrderEvent = z.strictObject({
  order_event_id: Id, order_id: Id, kind: z.enum(["status", "promised_at"]), from_status: z.string().nullable(), to_status: z.string().nullable(),
  from_promised_at: IsoDateTime.nullable(), to_promised_at: IsoDateTime.nullable(), reason: z.string().nullable(), at: IsoDateTime,
});
const ExportTender = z.strictObject({
  tender_id: Id, order_id: Id, method: z.enum(["cash", "card", "upi"]), amount_minor: z.int(), tendered_minor: z.int().nullable(),
  change_minor: z.int().nullable(), currency: CurrencyCode, ref: z.string().nullable(), at: IsoDateTime,
});
const ExportRefund = z.strictObject({
  refund_id: Id, order_id: Id, tender_id: Id.nullable(), method: z.enum(["cash", "card", "upi"]), amount_minor: z.int(), currency: CurrencyCode,
  reason_code: z.string(), note: z.string(), at: IsoDateTime,
});
const ExportCouponUse = z.strictObject({ coupon_use_id: Id, coupon_id: Id, order_id: Id, discount_minor: z.int(), currency: CurrencyCode, at: IsoDateTime });
const ExportVoid = z.strictObject({
  void_id: Id, order_id: Id, order_line_id: Id.nullable(), reason_code: z.string(), note: z.string(), amount_minor: z.int(), currency: CurrencyCode, at: IsoDateTime,
});
const ExportSaleReturn = z.strictObject({
  sale_return_id: Id, order_id: Id, order_line_id: Id, qty_milli: z.int(), restock: z.boolean(), reason_code: z.string(), note: z.string(), at: IsoDateTime,
});

/** `customers.data.export.v1`: the customer's own rows at this merchant (read under their own RLS scope). */
export const AccountExport = z.strictObject({
  command: CommandResult,
  export: z.strictObject({
    format: z.literal("munim.customer-export.v1"),
    generated_at: IsoDateTime,
    tenant_id: Id,
    profile: AccountProfile,
    orders: z.array(z.strictObject({ order: AccountOrder, lines: z.array(AccountOrderLine) })),
    loyalty_entries: z.array(AccountLoyaltyEntry),
    reservations: z.array(ExportReservation),
    bulk_orders: z.array(ExportBulkOrder),
    order_events: z.array(ExportOrderEvent),
    tenders: z.array(ExportTender),
    refunds: z.array(ExportRefund),
    coupon_uses: z.array(ExportCouponUse),
    voids: z.array(ExportVoid),
    sale_returns: z.array(ExportSaleReturn),
  }),
});

export const SCHEMAS = {
  "customers.account.link.v1": CustomersAccountLinkV1,
  "customers.profile.update.v1": CustomersProfileUpdateV1,
  "customers.consent.set.v1": CustomersConsentSetV1,
  "customers.data.export.v1": CustomersDataExportV1,
  "customers.erasure.request.v1": CustomersErasureRequestV1,
  "v1.account.profile": AccountProfile,
  "v1.account.orders": AccountOrdersResponse,
  "v1.account.order": AccountOrderDetail,
  "v1.account.loyalty": AccountLoyalty,
  "v1.account.export": AccountExport,
};

const sf = { surface: "public", auth: "storefront" } as const;
export const ROUTES: readonly Route[] = [
  { ...sf, method: "get", path: "/v1/account", operationId: "getAccount", summary: "The signed-in customer's profile at this merchant (404 before first sign-in here)", response: "v1.account.profile", status: 200 },
  { ...sf, method: "post", path: "/v1/account:link", operationId: "linkAccount", summary: "customers.account.link.v1 — first sign-in creates this merchant's profile; X-Munim-Guest-Token claims that guest order", command: "customers.account.link.v1", response: "command-result", status: 200, conflict: true },
  { ...sf, method: "post", path: "/v1/account/profile", operationId: "updateAccountProfile", summary: "customers.profile.update.v1 — name and phone", command: "customers.profile.update.v1", response: "command-result", status: 200, conflict: true },
  { ...sf, method: "post", path: "/v1/account/consent", operationId: "setAccountConsent", summary: "customers.consent.set.v1 — marketing consent", command: "customers.consent.set.v1", response: "command-result", status: 200, conflict: true },
  {
    ...sf, method: "get", path: "/v1/account/orders", operationId: "listAccountOrders", summary: "The customer's orders at this merchant, newest first", response: "v1.account.orders", status: 200,
    query: [
      { name: "limit", required: false, schema: { type: "integer", minimum: 1, maximum: 100 } },
      { name: "cursor", required: false, schema: { type: "string", format: "uuid" } },
    ],
  },
  { ...sf, method: "get", path: "/v1/account/orders/{id}", operationId: "getAccountOrder", summary: "One of the customer's own orders with its lines (404 for any other order)", response: "v1.account.order", status: 200, pathParams: [{ name: "id", uuid: true }] },
  { ...sf, method: "get", path: "/v1/account/loyalty", operationId: "getAccountLoyalty", summary: "Loyalty: latest balance_after and every entry", response: "v1.account.loyalty", status: 200 },
  { ...sf, method: "post", path: "/v1/account:export", operationId: "exportAccount", summary: "customers.data.export.v1 — JSON of the customer's own rows at this merchant", command: "customers.data.export.v1", response: "v1.account.export", status: 200, conflict: true },
  { ...sf, method: "post", path: "/v1/account:erase", operationId: "eraseAccount", summary: "customers.erasure.request.v1 — anonymise the profile; orders are kept", command: "customers.erasure.request.v1", response: "command-result", status: 200, conflict: true },
];
