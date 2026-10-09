// Orders / POS commands (02-schema §2.4). Prices and totals are re-derived by core at placement from
// price, option and deal rows (trust boundary T1); nothing in this payload is a price core trusts.
import { z } from "zod";
import { CountryCode, CouponCode, CurrencyCode, IsoDate, IsoDateTime, LocalTime, MinorAmount, Money, QtyMilli, Slug, Uuid7 } from "../shared/primitives.ts";
import { ReasonCode } from "../shared/reason-codes.ts";
import { CiteRef } from "../shared/refs.ts";
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

export const SCHEMAS = {
  "orders.place.v1": OrdersPlaceV1,
  "orders.pickup_window.generate.v1": OrdersPickupWindowGenerateV1,
  "orders.preview.request": OrdersPreviewRequest,
  "orders.preview.response": OrdersPreviewResponse,
  "orders.tender.record.v1": OrdersTenderRecordV1,
  "v1.tender": TenderView,
};
export const ROUTES: readonly Route[] = [
  {
    surface: "public",
    method: "post",
    path: "/v1/orders:preview",
    operationId: "previewOrder",
    summary: "Price a cart with core's pricing function; writes nothing; labelled Preview (R40 C1)",
    auth: "member",
    request: "orders.preview.request",
    response: "orders.preview.response",
    status: 200,
  },
];
