// Storefront (T-032): the public menu, accepting-orders state, pickup windows, guest / signed-in checkout, the
// shopper's own order read, and cancel / reschedule inside the outlet's windows. Keyed by the storefront key
// (tenant + channel); a channel or customer in a payload is never trusted. Payments are simulated: every
// confirmation says "Pay at the counter" (R4); nothing here moves money.
import { z } from "zod";
import { commandEnvelopeOf } from "../shared/command.ts";
import { CurrencyCode, Email, IsoDate, IsoDateTime, MinorAmount, NonEmpty, QtyMilli, Slug, Uuid7 } from "../shared/primitives.ts";
import type { ReasonCode } from "../shared/reason-codes.ts";
import type { Route } from "../shared/routes.ts";
import { ChannelKind } from "../tenancy/index.ts";
import { OrderKind, OrdersPlaceV1, OrdersPreviewRequest, OrdersPreviewResponse } from "../orders/index.ts";

/** No customer_id: core-api mints the guest's id and puts it on the principal (W1 fix #45). */
export const StorefrontGuestCreateV1 = z.strictObject({
  name: NonEmpty,
  /** E.164. */
  phone: z.string().regex(/^\+[1-9][0-9]{6,14}$/).nullable(),
  email: Email.nullable(),
  consent: z.strictObject({ marketing: z.boolean(), at: IsoDateTime }),
});

/** The customer's own cancel (status placed → cancelled, inside the outlet's cancel window). The order is the
 *  one the path names; the customer comes from the verified token, never from here. */
export const StorefrontOrderCancelV1 = z.strictObject({ order_id: Uuid7, reason: z.string().min(1).max(200).nullable() });

/** The customer's own change of pickup time / window (inside the reschedule window). Core re-prices at the new
 *  time; `preview_total_minor` is the total of the reschedule preview the person saw — a different re-priced
 *  total is refused with `deal_rejudged` before anything is written. */
export const StorefrontOrderRescheduleV1 = z.strictObject({
  order_id: Uuid7,
  pickup_window_id: Uuid7.nullable(),
  promised_at: IsoDateTime,
  preview_total_minor: MinorAmount,
});

export const StorefrontReschedulePreviewRequest = z.strictObject({
  pickup_window_id: Uuid7.nullable(),
  promised_at: IsoDateTime,
});

// ── Read models. Every number is a row's own field (R26); sums are not computed here.
export const AcceptingState = z.enum(["open", "busy", "paused", "closed"]);

export const StorefrontAccepting = z.strictObject({
  outlet_id: Uuid7,
  /** Effective state now: the live toggle (open / busy / paused) on top of the weekly hours and dated overrides. */
  state: AcceptingState,
  /** core.outlet.busy_extra_min — shown only while state = busy. */
  busy_extra_min: z.int().min(0),
  /** core.outlet.default_prep_min; "Ready in about" = this + busy_extra_min (the client adds two row fields). */
  default_prep_min: z.int().min(0),
  /** Next opening instant while paused / closed; null when open or when no opening is found in 14 days. */
  next_open: IsoDateTime.nullable(),
  tz: z.string(),
  as_of: IsoDateTime,
});

export const StorefrontOutlet = z.strictObject({
  outlet_id: Uuid7,
  name: z.string(),
  kind: z.enum(["restaurant", "cloud_kitchen", "store"]),
  tz: z.string(),
  address: z.string(),
});
export const StorefrontOutletsResponse = z.strictObject({ outlets: z.array(StorefrontOutlet) });

export const StorefrontMenuItem = z.strictObject({
  item_id: Uuid7,
  name_key: Slug,
  category: z.string(),
  kind: z.enum(["dish", "sku", "combo"]),
  /** false = sold out at this outlet (core.item_availability) — visible before checkout (R4 §E 4). */
  available: z.boolean(),
  /** core.price.amount_minor for this outlet and the key's channel kind; null when the item is sold by variant. */
  price_minor: MinorAmount.nullable(),
  currency: CurrencyCode,
  /** Each active variant with its own price row (a row's own field). */
  variants: z.array(z.strictObject({ variant_id: Uuid7, name_key: Slug, available: z.boolean(), price_minor: MinorAmount })),
  option_groups: z.array(
    z.strictObject({
      option_group_id: Uuid7,
      name_key: Slug,
      min_select: z.int().min(0),
      max_select: z.int().min(1),
      required: z.boolean(),
      options: z.array(z.strictObject({ option_id: Uuid7, name_key: Slug, price_delta_minor: MinorAmount })),
    }),
  ),
});

export const StorefrontDeal = z.strictObject({
  deal_id: Uuid7,
  name_key: Slug,
  kind: z.string(),
  /** core.deal.windows as stored (outlet-local weekday / time ranges). */
  windows: z.array(z.unknown()),
  valid_from: IsoDate,
  valid_to: IsoDate.nullable(),
});

export const StorefrontMenuResponse = z.strictObject({
  outlet_id: Uuid7,
  channel_kind: ChannelKind,
  accepting: StorefrontAccepting,
  items: z.array(StorefrontMenuItem),
  deals: z.array(StorefrontDeal),
  /** "Pay at the counter — cash, card or UPI." Always true; no card fields exist (R4). */
  pay_at_counter: z.literal(true),
});

export const StorefrontPickupWindow = z.strictObject({
  pickup_window_id: Uuid7,
  starts_at: IsoDateTime,
  ends_at: IsoDateTime,
  capacity_orders: z.int().min(1),
  booked: z.int().min(0),
});
/** Only windows with booked < capacity_orders that have not ended; full windows are hidden (R4 §E 1). */
export const StorefrontPickupWindowsResponse = z.strictObject({ outlet_id: Uuid7, windows: z.array(StorefrontPickupWindow) });

// ── Checkout.
/** Guest: both envelopes (guest.create + place) in one request and one transaction. Signed in (customer token
 *  present): `guest` is null. `order.payload.channel_id` / `device_id` are overwritten by core-api from the key;
 *  `client_totals` is recorded for tamper detection only. */
export const StorefrontOrderPlaceRequest = z.strictObject({
  order: commandEnvelopeOf("orders.place.v1", OrdersPlaceV1),
  guest: commandEnvelopeOf("storefront.guest.create.v1", StorefrontGuestCreateV1).nullable(),
  /** First checkout of a signed-in customer who has no profile at this merchant yet: what the profile row needs
   *  (name, optional phone). Null otherwise (a guest uses `guest`). */
  contact: z.strictObject({ name: NonEmpty, phone: z.string().regex(/^\+[1-9][0-9]{6,14}$/).nullable() }).nullable(),
});

export const StorefrontOrderPlaced = z.strictObject({
  order_id: Uuid7,
  status: z.enum(["placed", "accepted", "rejected", "preparing", "ready", "completed", "cancelled"]),
  ticket_no: z.int().min(1),
  total_minor: MinorAmount,
  currency: CurrencyCode,
  promised_at: IsoDateTime.nullable(),
  pay_at_counter: z.literal(true),
  /** One-time guest access token (shown once; only its sha256 is stored). Null for a signed-in customer and on a
   *  replay of an already-placed order. */
  guest_access_token: z.string().nullable(),
});

export const StorefrontOrderLine = z.strictObject({
  line_no: z.int().min(1),
  item_id: Uuid7,
  variant_id: Uuid7.nullable(),
  qty_milli: QtyMilli,
  unit_price_minor: MinorAmount,
  line_discount_minor: MinorAmount,
  tax_minor: MinorAmount,
});
export const StorefrontOrderEvent = z.strictObject({
  kind: z.enum(["status", "promised_at"]),
  from_status: z.string().nullable(),
  to_status: z.string().nullable(),
  from_promised_at: IsoDateTime.nullable(),
  to_promised_at: IsoDateTime.nullable(),
  /** Chosen from the KDS list, never free text; null when none was given. */
  reason: z.string().nullable(),
  at: IsoDateTime,
});
/** The shopper's own order (row fields). The countdown is created_at + the outlet's window minutes; both are rows. */
export const StorefrontOrderView = z.strictObject({
  order_id: Uuid7,
  outlet_id: Uuid7,
  kind: OrderKind,
  status: z.enum(["placed", "accepted", "rejected", "preparing", "ready", "completed", "cancelled"]),
  ticket_no: z.int().min(1),
  business_date: IsoDate,
  promised_at: IsoDateTime.nullable(),
  pickup_window_id: Uuid7.nullable(),
  subtotal_minor: MinorAmount,
  discount_minor: MinorAmount,
  tax_minor: MinorAmount,
  total_minor: MinorAmount,
  currency: CurrencyCode,
  created_at: IsoDateTime,
  cancel_window_min: z.int().min(0),
  reschedule_window_min: z.int().min(0),
  pay_at_counter: z.literal(true),
  lines: z.array(StorefrontOrderLine),
  events: z.array(StorefrontOrderEvent),
});

export const StorefrontReschedulePreviewResponse = z.strictObject({
  order_id: Uuid7,
  promised_at: IsoDateTime,
  /** core.order.total_minor now (a row field). */
  current_total_minor: MinorAmount,
  /** Core's re-pricing at the new promised time (Preview, writes nothing). */
  preview: OrdersPreviewResponse,
});

/** Refusal reason code → D-2 copy key (`order.refuse.*`, docs/plan/screens/storefront.md O2/O3). The wire text
 *  is composed by core-api; the web app resolves the key and its parameters. `guest_cannot_change` is W2-R2
 *  ("Call the outlet to change this order"). */
export const STOREFRONT_REFUSAL_COPY = {
  window_full: "order.refuse.window_full",
  outlet_paused: "order.refuse.outlet_paused",
  item_sold_out: "order.refuse.sold_out",
  deal_rejudged: "order.refuse.deal_rejudged",
  coupon_invalid: "order.refuse.coupon_invalid",
  coupon_cap_reached: "order.refuse.coupon_cap",
  coupon_min_spend: "order.refuse.coupon_min_spend",
  change_window_closed: "order.refuse.change_window_closed",
  guest_cannot_change: "order.refuse.guest_cannot_change",
} as const satisfies Partial<Record<ReasonCode, string>>;

export const SCHEMAS = {
  "storefront.guest.create.v1": StorefrontGuestCreateV1,
  "storefront.order.cancel.v1": StorefrontOrderCancelV1,
  "storefront.order.reschedule.v1": StorefrontOrderRescheduleV1,
  "storefront.reschedule.preview.request": StorefrontReschedulePreviewRequest,
  "storefront.reschedule.preview.response": StorefrontReschedulePreviewResponse,
  "storefront.outlets.response": StorefrontOutletsResponse,
  "storefront.menu.response": StorefrontMenuResponse,
  "storefront.accepting.response": StorefrontAccepting,
  "storefront.pickup_windows.response": StorefrontPickupWindowsResponse,
  "storefront.order.place.request": StorefrontOrderPlaceRequest,
  "storefront.order.placed": StorefrontOrderPlaced,
  "storefront.order.view": StorefrontOrderView,
};

const outlet = [{ name: "outlet_id", uuid: true }];
export const ROUTES: readonly Route[] = [
  { surface: "public", method: "get", path: "/v1/storefront/outlets", operationId: "storefrontOutlets", summary: "Outlets the storefront key's tenant offers", auth: "storefront", response: "storefront.outlets.response", status: 200 },
  { surface: "public", method: "get", path: "/v1/storefront/outlets/{outlet_id}/menu", operationId: "storefrontMenu", summary: "Public menu with availability, deals and the effective accepting state", auth: "storefront", response: "storefront.menu.response", status: 200, pathParams: outlet },
  { surface: "public", method: "get", path: "/v1/storefront/outlets/{outlet_id}/state", operationId: "storefrontState", summary: "Effective accepting-orders state (open / busy +N / paused / closed) with next opening", auth: "storefront", response: "storefront.accepting.response", status: 200, pathParams: outlet },
  { surface: "public", method: "get", path: "/v1/storefront/outlets/{outlet_id}/pickup-windows", operationId: "storefrontPickupWindows", summary: "Pickup windows with spare capacity", auth: "storefront", response: "storefront.pickup_windows.response", status: 200, pathParams: outlet },
  { surface: "public", method: "post", path: "/v1/storefront/orders:preview", operationId: "storefrontPreviewOrder", summary: "Price a cart (Preview; writes nothing); channel comes from the key", auth: "storefront", request: "orders.preview.request", response: "orders.preview.response", status: 200, conflict: true },
  { surface: "public", method: "post", path: "/v1/storefront/orders", operationId: "storefrontPlaceOrder", summary: "Guest or signed-in checkout in one transaction; pay at the counter", auth: "storefront", request: "storefront.order.place.request", response: "storefront.order.placed", status: 201, conflict: true },
  { surface: "public", method: "get", path: "/v1/storefront/orders/{id}", operationId: "storefrontGetOrder", summary: "The shopper's own order (customer token or guest access token); anything else is 404", auth: "storefront", response: "storefront.order.view", status: 200, pathParams: [{ name: "id", uuid: true }] },
  { surface: "public", method: "post", path: "/v1/storefront/orders/{id}:cancel", operationId: "storefrontCancelOrder", summary: "storefront.order.cancel.v1 — inside the outlet's cancel window", auth: "storefront", command: "storefront.order.cancel.v1", response: "command-result", status: 200, pathParams: [{ name: "id", uuid: true }], conflict: true },
  { surface: "public", method: "post", path: "/v1/storefront/orders/{id}:reschedule-preview", operationId: "storefrontReschedulePreview", summary: "Re-price the order at a new pickup time; writes nothing", auth: "storefront", request: "storefront.reschedule.preview.request", response: "storefront.reschedule.preview.response", status: 200, pathParams: [{ name: "id", uuid: true }], conflict: true },
  { surface: "public", method: "post", path: "/v1/storefront/orders/{id}:reschedule", operationId: "storefrontRescheduleOrder", summary: "storefront.order.reschedule.v1 — inside the outlet's reschedule window; deals re-priced", auth: "storefront", command: "storefront.order.reschedule.v1", response: "command-result", status: 200, pathParams: [{ name: "id", uuid: true }], conflict: true },
];
