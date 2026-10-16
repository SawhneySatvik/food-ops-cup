// Storefront (T-032): the public menu, accepting-orders state, pickup windows, guest / signed-in checkout, the
// shopper's own order read, and cancel / reschedule inside the outlet's windows. Keyed by the storefront key
// (tenant + channel); a channel or customer in a payload is never trusted. Payments are simulated: every
// confirmation says "Pay at the counter" (R4); nothing here moves money.
import { z } from "zod";
import { commandEnvelopeOf } from "../shared/command.ts";
import { RefusalErrorResponse, RefusalParams } from "../shared/error.ts";
import { BasisPoints, CurrencyCode, Email, IsoDate, IsoDateTime, MinorAmount, NonEmpty, QtyMilli, Slug, Uuid7 } from "../shared/primitives.ts";
import { ReasonCode } from "../shared/reason-codes.ts";
import type { Route } from "../shared/routes.ts";
import { DealWindow, Diet } from "../catalogue/index.ts";
import { ChannelKind } from "../tenancy/index.ts";
import { OrderKind, OrdersPlaceV1, OrdersPreviewRequest, OrdersPreviewResponse, TenderMethod } from "../orders/index.ts";
import { PAGE_ROUTES, PAGE_SCHEMAS } from "./page.ts";

export * from "./page.ts";

/** No customer_id: core-api mints the guest's id and puts it on the principal (W1 fix #45). */
export const StorefrontGuestCreateV1 = z.strictObject({
  name: NonEmpty,
  /** E.164. */
  phone: z.string().regex(/^\+[1-9][0-9]{6,14}$/).nullable(),
  email: Email.nullable(),
  consent: z.strictObject({ marketing: z.boolean(), at: IsoDateTime }),
});

/** Why a shopper cancels: a fixed list (the tracker shows one choice per code). Free text is never taken — it
 *  would be stored for good in the order's event (R1-m1). null = "customer_cancelled". */
export const StorefrontCancelReason = z.enum(["changed_mind", "ordered_by_mistake", "wait_too_long", "other"]);

/** The customer's own cancel (status placed → cancelled, inside the outlet's cancel window). The order is the
 *  one the path names; the customer comes from the verified token, never from here. */
export const StorefrontOrderCancelV1 = z.strictObject({ order_id: Uuid7, reason: StorefrontCancelReason.nullable() });

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

/** How a storefront order is paid: at the counter, recorded by staff, never processed online (R4). The methods come from
 *  the tenant's country pack (`pay_at_counter_methods`, G-13); null while the pack does not list them — then show the
 *  generic "Pay at the counter". */
const PayAtCounterMethods = z.array(TenderMethod).nullable();

export const StorefrontOutlet = z.strictObject({
  outlet_id: Uuid7,
  name: z.string(),
  kind: z.enum(["restaurant", "cloud_kitchen", "store"]),
  tz: z.string(),
  address: z.string(),
  /** core.outlet.phone (E.164), null = none (G-04). */
  phone: z.string().nullable(),
  /** The outlet's tax registrations the pack prints on every receipt (`tax_ids[].on_receipt`), in pack order, with the
   *  pack's label — e.g. GSTIN and FSSAI Lic. No. in India. Only ids the outlet has set; values as stored. */
  tax_ids: z.array(z.strictObject({ code: z.string(), label: z.string(), value: z.string() })),
});
export const StorefrontOutletsResponse = z.strictObject({ outlets: z.array(StorefrontOutlet), pay_at_counter_methods: PayAtCounterMethods });

/** Owner-entered display text (0029, G-01): PLAIN TEXT — render it as text, never as HTML (gotcha 15). null = the owner
 *  set none: show `name_key` (its i18n string, else the slug title-cased). */
const shown = { display_name: z.string().nullable(), description: z.string().nullable() };

export const StorefrontMenuItem = z.strictObject({
  item_id: Uuid7,
  name_key: Slug,
  ...shown,
  /** veg / non_veg / egg / vegan; null = not marked (never guess it from the name). */
  diet: Diet.nullable(),
  category: z.string(),
  /** core.item.brand_id: send it as the order's `brand_id` when the cart is one brand's (null = no brand). */
  brand_id: Uuid7.nullable(),
  kind: z.enum(["dish", "sku", "combo"]),
  /** false = sold out at this outlet (core.item_availability) — visible before checkout (R4 §E 4). */
  available: z.boolean(),
  /** core.price.amount_minor for this outlet and the key's channel kind; null when the item is sold by variant. */
  price_minor: MinorAmount.nullable(),
  currency: CurrencyCode,
  /** Each active variant with its own price row (a row's own field). */
  variants: z.array(z.strictObject({ variant_id: Uuid7, name_key: Slug, ...shown, available: z.boolean(), price_minor: MinorAmount })),
  option_groups: z.array(
    z.strictObject({
      option_group_id: Uuid7,
      name_key: Slug,
      ...shown,
      min_select: z.int().min(0),
      max_select: z.int().min(1),
      required: z.boolean(),
      options: z.array(z.strictObject({ option_id: Uuid7, name_key: Slug, ...shown, price_delta_minor: MinorAmount })),
    }),
  ),
});

export const StorefrontDeal = z.strictObject({
  deal_id: Uuid7,
  name_key: Slug,
  kind: z.string(),
  /** core.deal.windows: outlet-local ISO weekdays (1 = Monday) and a time range (an overnight range wraps). */
  windows: z.array(DealWindow),
  valid_from: IsoDate,
  valid_to: IsoDate.nullable(),
});

export const StorefrontMenuResponse = z.strictObject({
  outlet_id: Uuid7,
  /** The storefront key's channel (G-02): send it as `channel_id` in preview / place (core overwrites it with the key's
   *  own anyway). */
  channel_id: Uuid7,
  channel_kind: ChannelKind,
  /** Active brands that sell at this outlet (core.brand), for the order's `brand_id`. */
  brands: z.array(z.strictObject({ brand_id: Uuid7, name: z.string() })),
  /** The pack's price display (G-03): true = menu prices include tax ("GST included"); false = tax is added at checkout. */
  prices_include_tax: z.boolean(),
  accepting: StorefrontAccepting,
  items: z.array(StorefrontMenuItem),
  deals: z.array(StorefrontDeal),
  /** "Pay at the counter". Always true; no card fields exist (R4). */
  pay_at_counter: z.literal(true),
  pay_at_counter_methods: PayAtCounterMethods,
});

export const StorefrontPickupWindow = z.strictObject({
  pickup_window_id: Uuid7,
  starts_at: IsoDateTime,
  ends_at: IsoDateTime,
  capacity_orders: z.int().min(1),
  booked: z.int().min(0),
});
/** Only windows with booked < capacity_orders that have not ended; full windows are hidden (R4 §E 1).
 *  Ordering for a window (G-12): send its `pickup_window_id` with `promised_at` null (core promises the window's
 *  `starts_at`) or an instant inside it (`starts_at` ≤ promised_at < `ends_at`; outside → 422
 *  `pickup_time_outside_window`). ASAP: both null. A `promised_at` without a window is a time the outlet's hours admit. */
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
  /** core.order.tax_minor (G-03). */
  tax_minor: MinorAmount,
  /** The pack (the version that priced the order) displays prices tax-inclusive: "includes GST" vs "+ GST". Null =
   *  cannot verify (that pack version's row is missing or unreadable; core never substitutes the current pack). */
  prices_include_tax: z.boolean().nullable(),
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
  /** The line's tax class rate and its pack components' rates (e.g. CGST 250 + SGST 250), from the pack version that
   *  priced the order (G-03); null / [] when the order carries no tax class for the line (an imported order) or that
   *  pack version cannot be read (cannot verify). */
  tax_rate_bp: BasisPoints.nullable(),
  tax_component_rates: z.array(z.strictObject({ code: z.string(), rate_bp: BasisPoints })),
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
  /** As StorefrontOrderPlaced.prices_include_tax (null = cannot verify). */
  prices_include_tax: z.boolean().nullable(),
  lines: z.array(StorefrontOrderLine),
  events: z.array(StorefrontOrderEvent),
});

// ── Checkout preview with tax display and refusal parameters (T-099: G-03, G-11). The orders preview, plus per line the
// tax class rate and the pack engine's per-component amounts (as core's pricing computed them; IN: CGST + SGST halves on
// an intra-state sale, AU: one GST), the order's per-component totals, the pack's price display, and refusal parameters.
const TaxComponentAmount = z.strictObject({ code: z.string(), rate_bp: BasisPoints, amount_minor: MinorAmount });
const PreviewLine = OrdersPreviewResponse.shape.lines.element;
export const StorefrontPreviewResponse = OrdersPreviewResponse.extend({
  lines: z.array(PreviewLine.extend({ tax_rate_bp: BasisPoints, tax_components: z.array(TaxComponentAmount) })),
  /** Σ per component over the lines (the pack engine's order components); [] on a refused cart. */
  tax_components: z.array(TaxComponentAmount),
  prices_include_tax: z.boolean(),
  refusals: z.array(z.strictObject({ line_no: z.int().min(1).nullable(), reason_code: ReasonCode, params: RefusalParams.optional() })),
});

/** One server-sent event of `GET /v1/stream` (each `data:` line's JSON): a CloudEvent's id and type and its payload —
 *  ids and statuses only, never reason text (R15). On any event, re-read the resource it names. */
export const StreamEvent = z.strictObject({ id: z.string(), type: z.string(), data: z.record(z.string(), z.unknown()) });

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
  coupon_expired: "order.refuse.coupon_expired",
  coupon_out_of_scope: "order.refuse.coupon_out_of_scope",
  coupon_cap_reached: "order.refuse.coupon_cap",
  coupon_min_spend: "order.refuse.coupon_min_spend",
  pickup_time_outside_window: "order.refuse.pickup_time_outside_window",
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
  "storefront.preview.response": StorefrontPreviewResponse,
  "storefront.refusal-error": RefusalErrorResponse,
  "stream.event": StreamEvent,
  ...PAGE_SCHEMAS,
};

const outlet = [{ name: "outlet_id", uuid: true }];
export const ROUTES: readonly Route[] = [
  { surface: "public", method: "get", path: "/v1/storefront/outlets", operationId: "storefrontOutlets", summary: "Outlets the storefront key's tenant offers", auth: "storefront", response: "storefront.outlets.response", status: 200 },
  { surface: "public", method: "get", path: "/v1/storefront/outlets/{outlet_id}/menu", operationId: "storefrontMenu", summary: "Public menu with availability, deals and the effective accepting state", auth: "storefront", response: "storefront.menu.response", status: 200, pathParams: outlet },
  { surface: "public", method: "get", path: "/v1/storefront/outlets/{outlet_id}/state", operationId: "storefrontState", summary: "Effective accepting-orders state (open / busy +N / paused / closed) with next opening", auth: "storefront", response: "storefront.accepting.response", status: 200, pathParams: outlet },
  { surface: "public", method: "get", path: "/v1/storefront/outlets/{outlet_id}/pickup-windows", operationId: "storefrontPickupWindows", summary: "Pickup windows with spare capacity", auth: "storefront", response: "storefront.pickup_windows.response", status: 200, pathParams: outlet },
  { surface: "public", method: "post", path: "/v1/storefront/orders:preview", operationId: "storefrontPreviewOrder", summary: "Price a cart (Preview; writes nothing) with tax rates, component amounts and refusal parameters; channel comes from the key", auth: "storefront", request: "orders.preview.request", response: "storefront.preview.response", status: 200, conflict: true, errors: "storefront.refusal-error" },
  { surface: "public", method: "post", path: "/v1/storefront/orders", operationId: "storefrontPlaceOrder", summary: "Guest or signed-in checkout in one transaction; pay at the counter. A refusal's 409 / 422 body carries `params`", auth: "storefront", request: "storefront.order.place.request", response: "storefront.order.placed", status: 201, conflict: true, errors: "storefront.refusal-error" },
  { surface: "public", method: "get", path: "/v1/storefront/orders/{id}", operationId: "storefrontGetOrder", summary: "The shopper's own order (customer token or guest access token); anything else is 404", auth: "storefront", guest: true, response: "storefront.order.view", status: 200, pathParams: [{ name: "id", uuid: true }] },
  { surface: "public", method: "post", path: "/v1/storefront/orders/{id}:cancel", operationId: "storefrontCancelOrder", summary: "storefront.order.cancel.v1 — inside the outlet's cancel window", auth: "storefront", command: "storefront.order.cancel.v1", response: "command-result", status: 200, pathParams: [{ name: "id", uuid: true }], conflict: true },
  { surface: "public", method: "post", path: "/v1/storefront/orders/{id}:reschedule-preview", operationId: "storefrontReschedulePreview", summary: "Re-price the order at a new pickup time; writes nothing", auth: "storefront", request: "storefront.reschedule.preview.request", response: "storefront.reschedule.preview.response", status: 200, pathParams: [{ name: "id", uuid: true }], conflict: true },
  { surface: "public", method: "post", path: "/v1/storefront/orders/{id}:reschedule", operationId: "storefrontRescheduleOrder", summary: "storefront.order.reschedule.v1 — inside the outlet's reschedule window; deals re-priced (deal_rejudged carries old/new totals in `params`)", auth: "storefront", command: "storefront.order.reschedule.v1", response: "command-result", status: 200, pathParams: [{ name: "id", uuid: true }], conflict: true, errors: "storefront.refusal-error" },
  // G-07: the server-sent event stream (services/core-api/src/stream). Members: memberToken + X-Munim-Tenant; customers:
  // storefront key + their token; guests: storefront key + X-Munim-Guest-Token (topic order:<that order>). Resume with
  // the Last-Event-ID header. Any topic the caller may not read → 404 for the whole request.
  { surface: "public", method: "get", path: "/v1/stream", operationId: "streamEvents", summary: "Server-sent events for the given topics (kds / order / inbox / trace); text/event-stream, read with the SDK's openStream; resume with Last-Event-ID; heartbeat every 20 s, closed at 55 min", auth: "storefront", guest: true, alsoAuth: ["member"], stream: true, response: "stream.event", status: 200,
    query: [{ name: "topics", required: true, schema: { type: "string", minLength: 1, description: "Comma list of kds:<outlet id>, order:<order id>, inbox:<tenant id>, trace:<run id>" } }] },
  ...PAGE_ROUTES,
];
