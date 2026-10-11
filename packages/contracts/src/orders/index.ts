// Orders / POS commands (02-schema §2.4). Prices and totals are re-derived by core at placement from
// price, option and deal rows (trust boundary T1); nothing in this payload is a price core trusts.
import { z } from "zod";
import { CountryCode, CouponCode, CurrencyCode, IsoDate, IsoDateTime, LocalTime, MinorAmount, Money, QtyMilli, Slug, Uuid7 } from "../shared/primitives.ts";
import { ReasonCode } from "../shared/reason-codes.ts";
import { CiteRef } from "../shared/refs.ts";
import { CommandResult } from "../shared/command.ts";
import { ROUTES as ORDER_ROUTES } from "./routes.ts";
import { READ_ROUTES, READ_SCHEMAS } from "./read-routes.ts";
import type { Route } from "../shared/routes.ts";

export const OrderKind = z.enum(["dine_in", "takeaway", "pickup", "delivery"]);

export const OrdersPlaceV1 = z.strictObject({
  order_id: Uuid7,
  outlet_id: Uuid7,
  channel_id: Uuid7,
  brand_id: Uuid7.nullable(),
  /** The POS device whose invoice series numbers the bill; null for storefront orders. */
  device_id: Uuid7.nullable(),
  kind: OrderKind,
  table_ref: z.string().min(1).max(20).nullable(),
  pickup_window_id: Uuid7.nullable(),
  promised_at: IsoDateTime.nullable(),
  // No customer_id: the customer comes from the verified principal (core-api mints a guest's id at first
  // sign-in), never from a payload (W1 fix #45).
  /** Aggregator / own-site order reference; unique per channel. */
  external_ref: z.string().min(1).max(100).nullable(),
  lines: z
    .array(
      z.strictObject({
        /** REQUIRED, client-generated UUIDv7: becomes the core.order_line id (02-schema §0), unique across the tenant
         *  (a repeat in one order → 422; reusing another order's line id fails the insert). An expired-sale override is
         *  bound to it before placement (0014 #49: override.cart_line_id = this id; placement consumes the override once).
         *  Preview lines (`orders.preview.request`) carry no line_id: a preview writes nothing and binds no override. */
        line_id: Uuid7,
        item_id: Uuid7,
        variant_id: Uuid7.nullable(),
        option_ids: z.array(Uuid7),
        qty_milli: QtyMilli.positive(),
        /** Scanned barcode for shop sales, recorded as typed. */
        barcode: z.string().regex(/^[0-9A-Za-z-]{4,32}$/).nullable(),
        note: z.string().max(200).nullable(),
      }),
    )
    .min(1),
  /** Coupons to apply (core judges each; refusals use the storefront coupon reason codes). */
  coupon_codes: z.array(CouponCode).max(5),
  /** Loyalty points the customer redeems on this order; 0 = none. Checked against the ledger by core. */
  loyalty_redeem_points: z.int().min(0),
  /** The total of the `/v1/orders:preview` the person saw. Core re-prices at placement; if its total
   *  differs, placement is refused with `preview_total_changed` before commit (R40 C1). Null = no preview
   *  (e.g. an aggregator import). */
  preview_total_minor: MinorAmount.nullable(),
  /** What the client displayed. Recorded for tamper detection only; core ignores it for pricing (T1). */
  client_totals: z.strictObject({ subtotal: Money, total: Money }).nullable(),
});

export const OrdersPickupWindowGenerateV1 = z.strictObject({
  outlet_id: Uuid7,
  /** Business date in the outlet's zone; times are outlet-local wall clock. */
  business_date: IsoDate,
  from_local: LocalTime,
  to_local: LocalTime,
  slot_minutes: z.int().min(5).max(120),
  capacity_orders: z.int().min(1).max(1000),
});

// ── R40 C1: pricing preview. Runs core's one pricing function and WRITES NOTHING (no order, outbox,
// window booking, coupon use or stock). Every number is core-computed and each line cites the rows and the
// pack tax-rule version it used as openable refs. Placement re-prices; a different total → the
// `preview_total_changed` refusal before commit.
export const OrdersPreviewRequest = z.strictObject({
  outlet_id: Uuid7,
  channel_id: Uuid7,
  brand_id: Uuid7.nullable(),
  kind: OrderKind,
  pickup_window_id: Uuid7.nullable(),
  promised_at: IsoDateTime.nullable(),
  /** No customer_id — from the principal only (W1 fix #45). */
  coupon_codes: z.array(CouponCode).max(5),
  loyalty_redeem_points: z.int().min(0),
  lines: z
    .array(
      z.strictObject({
        item_id: Uuid7,
        variant_id: Uuid7.nullable(),
        option_ids: z.array(Uuid7),
        qty_milli: QtyMilli.positive(),
        barcode: z.string().regex(/^[0-9A-Za-z-]{4,32}$/).nullable(),
      }),
    )
    .min(1),
});

/** A row ref of the form ⟨cite:row:core.<table>:<id>⟩. */
const RowRef = CiteRef;

export const OrdersPreviewResponse = z.strictObject({
  /** Shown as "Preview" — not an order, not a bill. */
  label: z.literal("preview"),
  priced_at: IsoDateTime,
  currency: CurrencyCode,
  /** Which pack rules priced the tax. */
  tax_rule: z.strictObject({ pack_code: CountryCode, pack_version: z.int().min(1) }),
  lines: z.array(
    z.strictObject({
      line_no: z.int().min(1),
      item_id: Uuid7,
      variant_id: Uuid7.nullable(),
      qty_milli: QtyMilli.positive(),
      unit_price_minor: MinorAmount,
      options_minor: MinorAmount,
      line_discount_minor: MinorAmount,
      tax_class: Slug,
      tax_minor: MinorAmount,
      line_total_minor: MinorAmount,
      /** core.price row used. */
      price_ref: RowRef,
      /** core.option rows, core.deal rows, core.coupon rows applied to this line. */
      option_refs: z.array(RowRef),
      deal_refs: z.array(RowRef),
      coupon_refs: z.array(RowRef),
    }),
  ),
  subtotal_minor: MinorAmount,
  discount_minor: MinorAmount,
  tax_minor: MinorAmount,
  total_minor: MinorAmount,
  /** Lines or codes core would refuse at placement (e.g. item_sold_out, price_above_mrp, coupon_min_spend). */
  refusals: z.array(z.strictObject({ line_no: z.int().min(1).nullable(), reason_code: ReasonCode })),
});

// ── R40 C1 + ruling #59: tenders. Recorded only — Munim does not process payments. For cash the member
// records what was handed over; core computes `amount_minor` (applied to the order, after the pack's
// `cash_rounding_minor`), `change_minor` and `rounding_minor` from the order row and that order's tender
// rows in one read. Card / UPI: `tendered_minor`, `change_minor`, `rounding_minor` are null and the amount
// may not exceed what is due (T-022). The client never computes Remaining or Change.
export const TenderMethod = z.enum(["cash", "card", "upi"]);

export const OrdersTenderRecordV1 = z
  .strictObject({
    tender_id: Uuid7,
    order_id: Uuid7,
    method: TenderMethod,
    /** Cash handed over; null for card / UPI. */
    tendered_minor: MinorAmount.positive().nullable(),
    /** Card / UPI amount charged; null for cash (core computes the cash amount). */
    amount_minor: MinorAmount.positive().nullable(),
    currency: CurrencyCode,
    /** Card slip / UPI reference as typed; null for cash. */
    ref: z.string().min(1).max(100).nullable(),
  })
  .superRefine((t, ctx) => {
    const cash = t.method === "cash";
    if (cash !== (t.tendered_minor !== null)) ctx.addIssue({ code: "custom", path: ["tendered_minor"], message: "tendered_minor is set exactly for cash" });
    if (cash !== (t.amount_minor === null)) ctx.addIssue({ code: "custom", path: ["amount_minor"], message: "amount_minor is set exactly for card / UPI" });
  });

/** core.tender row as read back (a row's own fields; R26). */
export const TenderView = z
  .strictObject({
    tender_id: Uuid7,
    order_id: Uuid7,
    method: TenderMethod,
    amount_minor: MinorAmount.positive(),
    tendered_minor: MinorAmount.positive().nullable(),
    change_minor: MinorAmount.nonnegative().nullable(),
    /** Cash rounding applied to the due amount (pack `cash_rounding_minor`); signed; null for non-cash. */
    rounding_minor: MinorAmount.nullable(),
    currency: CurrencyCode,
    ref: z.string().nullable(),
    recorded_by: Uuid7,
    at: IsoDateTime,
  })
  .superRefine((t, ctx) => {
    const cash = t.method === "cash";
    if ([t.tendered_minor, t.change_minor, t.rounding_minor].some((x) => (x !== null) !== cash))
      ctx.addIssue({ code: "custom", path: ["tendered_minor"], message: "tendered_minor, change_minor and rounding_minor are set exactly for cash" });
    if (t.tendered_minor !== null && t.change_minor !== null && t.tendered_minor - t.amount_minor !== t.change_minor)
      ctx.addIssue({ code: "custom", path: ["change_minor"], message: "change_minor = tendered_minor − amount_minor" });
  });

// ── Order lifecycle commands (T-022). Every one writes only its seeded command's target_tables (0007/0014).

/** The kitchen pushes the promised time back (R4 §E 13). Re-judges deals at the new time through core's one
 *  pricing function (rule 9); a changed total is applied under the `orders.reprice` derivation while the order
 *  is `placed`/`accepted`. `from_promised_at` is the optimistic guard (stale → 409). The reason is a code from
 *  the KDS list, never free text (it reaches the customer's tracker). */
export const OrdersPromisePushBackV1 = z.strictObject({
  order_id: Uuid7,
  from_promised_at: IsoDateTime.nullable(),
  to_promised_at: IsoDateTime,
  reason_code: Slug,
});

/** A void with reason (before tender: a line or the whole order). Core computes `amount_minor` (the value
 *  written off) from the order / order-line row; the payload carries no amount. */
export const OrdersVoidRecordV1 = z.strictObject({
  void_id: Uuid7,
  order_id: Uuid7,
  /** null = the whole order. */
  order_line_id: Uuid7.nullable(),
  reason_code: Slug,
  note: z.string().min(1).max(500),
});

/** A refund recorded against an order (money handed back outside Munim — recorded, never processed). Within
 *  what was paid for the order less earlier refunds; within the member's command authority. */
export const OrdersRefundRecordV1 = z.strictObject({
  refund_id: Uuid7,
  order_id: Uuid7,
  /** The tender refunded; null = not tied to one tender. Method defaults to that tender's. */
  tender_id: Uuid7.nullable(),
  method: TenderMethod,
  amount_minor: MinorAmount.positive(),
  currency: CurrencyCode,
  reason_code: Slug,
  note: z.string().min(1).max(500),
});

export const OrdersShiftOpenV1 = z.strictObject({
  shift_id: Uuid7,
  outlet_id: Uuid7,
  /** The POS device whose drawer this is; null = the outlet's only drawer. */
  device_id: Uuid7.nullable(),
  float_minor: MinorAmount.nonnegative(),
  currency: CurrencyCode,
});

/** Close with the counted cash. Core computes expected cash (float + cash tenders − cash refunds of the
 *  drawer's orders in the shift window) and the variance; the payload carries only the count. */
export const OrdersShiftCloseV1 = z.strictObject({
  shift_id: Uuid7,
  counted_cash_minor: MinorAmount.nonnegative(),
});

export const OrderStatus = z.enum(["placed", "accepted", "rejected", "preparing", "ready", "completed", "cancelled"]);

// ── POS status commands (0015 A4, #41). Each moves one order one step, conditional on its current status, along
// core.order_status_transition; the caller's role must reach the step's min_role. The actor is the signed-in member.

/** placed → accepted. */
export const OrdersOrderAcceptV1 = z.strictObject({ order_id: Uuid7 });
/** placed → rejected, with a reason code (stock, loyalty and the pickup slot are given back). */
export const OrdersOrderRejectV1 = z.strictObject({ order_id: Uuid7, reason_code: Slug });
/** Every other step: accepted → preparing → ready → completed, or placed / accepted → cancelled (reason required).
 *  Accepting and rejecting have their own commands. `from_status` is the optimistic guard (stale → 409). */
export const OrdersOrderAdvanceV1 = z.strictObject({
  order_id: Uuid7,
  from_status: OrderStatus,
  to_status: OrderStatus.exclude(["accepted", "rejected", "placed"]),
  reason_code: Slug.nullable(),
});

/** core.order with its lines and tenders, as read back (row fields, R26). `paid_minor` and `remaining_minor`
 *  are computed by core from this order row and its tender/refund rows in the same read (R40 C1). */
export const OrderView = z.strictObject({
  order_id: Uuid7,
  outlet_id: Uuid7,
  channel_id: Uuid7,
  device_id: Uuid7.nullable(),
  kind: OrderKind,
  table_ref: z.string().nullable(),
  status: OrderStatus,
  business_date: IsoDate,
  ticket_no: z.int().min(1),
  invoice_fy: z.int().nullable(),
  invoice_no: z.int().nullable(),
  promised_at: IsoDateTime.nullable(),
  pickup_window_id: Uuid7.nullable(),
  subtotal_minor: MinorAmount,
  discount_minor: MinorAmount,
  tax_minor: MinorAmount,
  total_minor: MinorAmount,
  /** Loyalty points' value applied to this order (INFERENCE: points are a means of payment, not a discount). */
  loyalty_minor: MinorAmount.nonnegative(),
  paid_minor: MinorAmount.nonnegative(),
  remaining_minor: MinorAmount.nonnegative(),
  currency: CurrencyCode,
  lines: z.array(z.strictObject({
    line_id: Uuid7,
    line_no: z.int().min(1),
    item_id: Uuid7,
    variant_id: Uuid7.nullable(),
    option_ids: z.array(Uuid7),
    qty_milli: QtyMilli.positive(),
    unit_price_minor: MinorAmount,
    line_discount_minor: MinorAmount,
    tax_minor: MinorAmount,
  })),
  tenders: z.array(TenderView),
  created_at: IsoDateTime,
});

/** The bill as the pack prints it (core-domain buildReceipt over the stored order): an IN/AU tax invoice, or
 *  for an IN aggregator order under Sec 9(5) a record-only receipt (no invoice number, no tax lines). Every
 *  number is re-derived from the order's rows and must equal the stored totals (core refuses to print otherwise). */
const TaxAmount = z.strictObject({ code: z.string().min(1).max(20), rate_bp: z.int().min(0), amount_minor: MinorAmount });
export const ReceiptView = z.strictObject({
  order_id: Uuid7,
  kind: z.enum(["tax_invoice", "record"]),
  title: z.string(),
  /** The aggregator's display name on a record receipt; null on a tax invoice. */
  operator: z.string().nullable(),
  seller: z.strictObject({ name: z.string(), address: z.string() }),
  tax_ids: z.array(z.strictObject({ code: z.string(), label: z.string(), value: z.string() })),
  /** Device series + gapless number for a tax invoice; the external ref or ticket number on a record. */
  number: z.string().min(1),
  date: z.string().min(1),
  currency: CurrencyCode,
  lines: z.array(z.strictObject({
    line_no: z.int().min(1),
    item_id: Uuid7,
    name_key: Slug,
    qty_milli: QtyMilli.positive(),
    unit_price_minor: MinorAmount,
    amount_minor: MinorAmount,
    discount_minor: MinorAmount,
    net_minor: MinorAmount,
    tax_minor: MinorAmount,
    total_minor: MinorAmount,
    tax_class: Slug,
    components: z.array(TaxAmount),
  })),
  net_minor: MinorAmount,
  tax_minor: MinorAmount,
  total_minor: MinorAmount,
  components: z.array(TaxAmount),
});

/** What a storefront placement returns (T-032 route over the `placeOrder` seam): the stored command result and,
 *  for a guest only and only on the first response, the one-time order access token (only its sha256 is
 *  stored; a replay returns null). */
export const OrdersPlaceGuestResponse = z.strictObject({
  result: CommandResult,
  guest_access_token: z.string().min(16).max(256).nullable(),
});

/** One drawer shift as stored (core.shift row fields, R26): the opening float and, once closed, the counted cash,
 *  core's expected cash and the variance (counted − expected). */
export const ShiftView = z.strictObject({
  shift_id: Uuid7,
  outlet_id: Uuid7,
  device_id: Uuid7.nullable(),
  status: z.enum(["open", "closed"]),
  opened_by: Uuid7,
  opened_at: IsoDateTime,
  float_minor: MinorAmount,
  currency: CurrencyCode,
  closed_by: Uuid7.nullable(),
  closed_at: IsoDateTime.nullable(),
  counted_cash_minor: MinorAmount.nullable(),
  expected_cash_minor: MinorAmount.nullable(),
  variance_minor: z.int().nullable(),
});

export const SCHEMAS = {
  ...READ_SCHEMAS,
  "orders.place.v1": OrdersPlaceV1,
  "orders.pickup_window.generate.v1": OrdersPickupWindowGenerateV1,
  "orders.preview.request": OrdersPreviewRequest,
  "orders.preview.response": OrdersPreviewResponse,
  "orders.tender.record.v1": OrdersTenderRecordV1,
  "v1.tender": TenderView,
  "orders.promise.push_back.v1": OrdersPromisePushBackV1,
  "orders.void.record.v1": OrdersVoidRecordV1,
  "orders.refund.record.v1": OrdersRefundRecordV1,
  "orders.shift.open.v1": OrdersShiftOpenV1,
  "orders.shift.close.v1": OrdersShiftCloseV1,
  "orders.order.accept.v1": OrdersOrderAcceptV1,
  "orders.order.reject.v1": OrdersOrderRejectV1,
  "orders.order.advance.v1": OrdersOrderAdvanceV1,
  "v1.order": OrderView,
  "v1.order.receipt": ReceiptView,
  "v1.shift": ShiftView,
  "orders.place.guest-response": OrdersPlaceGuestResponse,
};
export const ROUTES: readonly Route[] = [...ORDER_ROUTES, ...READ_ROUTES];
export { ORDER_EVENT_SCHEMAS } from "./events.ts";
