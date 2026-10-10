// The shopper's own order: read, cancel, reschedule (+ its write-nothing preview).
//   read:       a signed-in customer (own orders) or a guest-token holder (that one order) — anything else is 404.
//   cancel / reschedule: signed-in customers only. A guest context writes nothing (0014 guest_scope refuses every
//   write) and carries no customer_id (ruling 10 Oct 03:55); whether a token holder may act is escalated, not decided.
//   Windows (INFERENCE: G-SF-1 has no definition, screen O3 reads "window − elapsed"): minutes after
//   core.order.created_at, per core.outlet.cancel_window_min / reschedule_window_min; only a `placed` order is
//   changeable online (the transition table lets a customer cancel only from placed).
import type { CommandEnvelope } from "@munim/contracts";
import { OrdersPreviewResponse } from "@munim/contracts/orders";
import { StorefrontOrderCancelV1, StorefrontOrderRescheduleV1, StorefrontReschedulePreviewRequest } from "@munim/contracts/storefront";
import { contextOf, type Principal } from "../../auth/resolve.ts";
import { executeCommand, publishCommitted, uuidv7, type CommandContext, type CommandHandler, type ExecuteResult } from "../../commit/index.ts";
import { asSystem, withContext } from "../../lib/db.ts";
import { ApiError } from "../../lib/errors.ts";
import type { Deps } from "../../lib/types.ts";
import type { Queryable } from "../../runtoken/index.ts";
import { now, optionalSeam, seam } from "./config.ts";
import { type CustomerPrincipal, refused } from "./checkout.ts";
import { outletRow, ownRefusals } from "./read.ts";

type Shopper = CustomerPrincipal | Extract<Principal, { kind: "guest" }>;

function parse<T>(schema: { safeParse(v: unknown): { success: true; data: T } | { success: false } }, body: unknown): T {
  const r = schema.safeParse(body);
  if (!r.success) throw new ApiError("bad_request");
  return r.data;
}
const iso = (d: Date) => d.toISOString();

// ── Read
export async function getOrder(deps: Deps, who: Shopper, order_id: string) {
  if (who.kind === "guest" && who.order_id !== order_id) throw new ApiError("not_found");
  return withContext(deps.pools.core, contextOf(who), async (c) => {
    const o = (
      await c.query<{
        id: string; outlet_id: string; kind: string; status: string; ticket_no: number; business_date: string; promised_at: Date | null;
        pickup_window_id: string | null; subtotal_minor: string; discount_minor: string; tax_minor: string; total_minor: string; currency: string; created_at: Date;
      }>(
        `SELECT id, outlet_id, kind, status, ticket_no, to_char(business_date, 'YYYY-MM-DD') AS business_date, promised_at, pickup_window_id,
                subtotal_minor, discount_minor, tax_minor, total_minor, currency, created_at
           FROM core."order" WHERE id = $1`, [order_id])
    ).rows[0];
    if (!o) throw new ApiError("not_found"); // RLS shows a shopper only their own order: someone else's looks absent
    const lines = await c.query<{ line_no: number; item_id: string; variant_id: string | null; qty_milli: string; unit_price_minor: string; line_discount_minor: string; tax_minor: string }>(
      `SELECT line_no, item_id, variant_id, qty_milli, unit_price_minor, line_discount_minor, tax_minor FROM core.order_line WHERE order_id = $1 ORDER BY line_no`, [order_id]);
    const events = await c.query<{ kind: string; from_status: string | null; to_status: string | null; from_promised_at: Date | null; to_promised_at: Date | null; reason: string | null; at: Date }>(
      `SELECT kind, from_status, to_status, from_promised_at, to_promised_at, reason, at FROM core.order_event WHERE order_id = $1 ORDER BY at, id`, [order_id]);
    // The outlet is public to a customer but not to a guest context; its two window columns are not secret.
    const w = await asSystem(c, async () =>
      (await c.query<{ cancel_window_min: number; reschedule_window_min: number }>(`SELECT cancel_window_min, reschedule_window_min FROM core.outlet WHERE id = $1`, [o.outlet_id])).rows[0]!);
    return {
      order_id: o.id, outlet_id: o.outlet_id, kind: o.kind, status: o.status, ticket_no: o.ticket_no, business_date: o.business_date,
      promised_at: o.promised_at ? iso(o.promised_at) : null, pickup_window_id: o.pickup_window_id,
      subtotal_minor: Number(o.subtotal_minor), discount_minor: Number(o.discount_minor), tax_minor: Number(o.tax_minor), total_minor: Number(o.total_minor),
      currency: o.currency, created_at: iso(o.created_at), cancel_window_min: w.cancel_window_min, reschedule_window_min: w.reschedule_window_min,
      pay_at_counter: true as const,
      lines: lines.rows.map((l) => ({
        line_no: l.line_no, item_id: l.item_id, variant_id: l.variant_id, qty_milli: Number(l.qty_milli),
        unit_price_minor: Number(l.unit_price_minor), line_discount_minor: Number(l.line_discount_minor), tax_minor: Number(l.tax_minor),
      })),
      events: events.rows.map((e) => ({
        kind: e.kind, from_status: e.from_status, to_status: e.to_status,
        from_promised_at: e.from_promised_at ? iso(e.from_promised_at) : null, to_promised_at: e.to_promised_at ? iso(e.to_promised_at) : null,
        reason: e.reason, at: iso(e.at),
      })),
    };
  });
}

// ── Shared locked read for cancel / reschedule
interface Locked {
  id: string; outlet_id: string; status: string; pickup_window_id: string | null; created_at: Date; total_minor: number;
  promised_at: Date | null; cancel_window_min: number; reschedule_window_min: number;
}
async function lockOrder(c: Queryable, order_id: string, lock: boolean): Promise<Locked> {
  const r = await c.query<Omit<Locked, "total_minor"> & { total_minor: string }>(
    `SELECT o.id, o.outlet_id, o.status, o.pickup_window_id, o.created_at, o.total_minor, o.promised_at, t.cancel_window_min, t.reschedule_window_min
       FROM core."order" o JOIN core.outlet t ON t.tenant_id = o.tenant_id AND t.id = o.outlet_id
      WHERE o.id = $1 ${lock ? "FOR UPDATE OF o" : ""}`, [order_id]);
  const o = r.rows[0];
  if (!o) throw new ApiError("not_found");
  return { ...o, total_minor: Number(o.total_minor) };
}
/** Inside its window and still `placed`; otherwise the outlet has taken the order — "please call the outlet". */
function changeable(o: Locked, windowMin: number): void {
  const until = o.created_at.getTime() + windowMin * 60_000;
  if (o.status !== "placed" || now().getTime() > until) throw refused("change_window_closed");
}

const actorOf = (p: CustomerPrincipal) => ({ kind: "customer", id: p.customer_id });

// ── Cancel
export function cancelHandler(who: CustomerPrincipal, order_id: string): CommandHandler {
  return {
    type: "storefront.order.cancel.v1",
    async run(c, cmd) {
      const p = parse(StorefrontOrderCancelV1, cmd.payload);
      if (p.order_id !== order_id) throw new ApiError("bad_request");
      const o = await lockOrder(c, order_id, true);
      changeable(o, o.cancel_window_min);
      await c.query(`UPDATE core."order" SET status = 'cancelled' WHERE id = $1`, [order_id]);
      await c.query(
        `INSERT INTO core.order_event (tenant_id, id, outlet_id, order_id, kind, from_status, to_status, actor, reason)
         VALUES (current_setting('app.tenant_id')::uuid, $1, $2, $3, 'status', 'placed', 'cancelled', $4, $5)`,
        [uuidv7(), o.outlet_id, order_id, actorOf(who), p.reason]);
      if (o.pickup_window_id) {
        await c.query(`UPDATE core.pickup_window SET booked = booked - 1 WHERE id = $1 AND booked > 0`, [o.pickup_window_id]);
      }
      // Points, coupon use and consumption are reversed by their owners' derivations in this same transaction.
      await optionalSeam("loyaltyReverseFor")?.(c, order_id);
      return {
        entityId: order_id,
        audit: [{ entity: "core.order", entityId: order_id, before: { status: "placed" }, after: { status: "cancelled" } }],
      };
    },
  };
}

// ── Reschedule: re-price at the new promised time
async function repricingInputs(deps: Deps, who: CustomerPrincipal, order_id: string) {
  return withContext(deps.pools.core, contextOf(who), async (c) => {
    const o = await lockOrder(c, order_id, false);
    const lines = await c.query<{ item_id: string; variant_id: string | null; options: unknown; qty_milli: string }>(
      `SELECT item_id, variant_id, options, qty_milli FROM core.order_line WHERE order_id = $1 ORDER BY line_no`, [order_id]);
    // The customer may read only coupons the request presents, so the order's own codes are read as core.
    const codes = await asSystem(c, async () =>
      (await c.query<{ code: string }>(
        `SELECT cp.code FROM core.coupon_use cu JOIN core.coupon cp ON cp.tenant_id = cu.tenant_id AND cp.id = cu.coupon_id WHERE cu.order_id = $1 ORDER BY cp.code`, [order_id])).rows.map((r) => r.code));
    return { o, lines: lines.rows, codes };
  });
}

/** INFERENCE: order_line.options holds the chosen options as objects carrying `option_id`. */
const optionIds = (options: unknown): string[] =>
  Array.isArray(options) ? options.map((x) => (x as { option_id?: string }).option_id).filter((x): x is string => typeof x === "string") : [];

async function priceAt(
  ctx: CommandContext, c: Queryable, o: Locked, lines: Array<{ item_id: string; variant_id: string | null; options: unknown; qty_milli: string }>,
  codes: string[], to: { pickup_window_id: string | null; promised_at: string },
) {
  const { channel_id: channel, kind } = (await c.query<{ channel_id: string; kind: string }>(`SELECT channel_id, kind FROM core."order" WHERE id = $1`, [o.id])).rows[0]!;
  return seam("previewOrder")(ctx, {
    outlet_id: o.outlet_id, channel_id: channel, brand_id: null, kind: kind as "pickup", pickup_window_id: to.pickup_window_id, promised_at: to.promised_at,
    coupon_codes: codes, loyalty_redeem_points: 0,
    lines: lines.map((l) => ({ item_id: l.item_id, variant_id: l.variant_id, option_ids: optionIds(l.options), qty_milli: Number(l.qty_milli), barcode: null })),
  });
}

/** Write-nothing: the order re-priced at the new time, with the same refusals placement would raise. */
export async function reschedulePreview(deps: Deps, who: CustomerPrincipal, order_id: string, body: unknown) {
  const req = parse(StorefrontReschedulePreviewRequest, body);
  const { o, lines, codes } = await repricingInputs(deps, who, order_id);
  return withContext(deps.pools.core, contextOf(who, { coupon_codes: codes }), async (c) => {
    const ctx: CommandContext = { tx: (fn) => fn(c), tenantId: who.tenant_id, actor: { kind: "customer", id: who.customer_id, role: "customer" } };
    const priced = await priceAt(ctx, c, o, lines, codes, req);
    const outlet = await outletRow(c, o.outlet_id);
    const own = await ownRefusals(c, { outlet, pickup_window_id: req.pickup_window_id, promised_at: req.promised_at, lines: lines.map((l) => ({ item_id: l.item_id, variant_id: l.variant_id })) });
    // The order's own current window is already counted in `booked`; staying in it is not a capacity problem.
    const refusals = own.filter((r) => !(r.reason_code === "window_full" && req.pickup_window_id === o.pickup_window_id));
    return {
      order_id, promised_at: req.promised_at, current_total_minor: o.total_minor,
      preview: OrdersPreviewResponse.parse({ ...priced, refusals: [...refusals, ...priced.refusals] }),
    };
  });
}

export function rescheduleHandler(who: CustomerPrincipal, order_id: string, codes: string[]): CommandHandler {
  return {
    type: "storefront.order.reschedule.v1",
    async run(c, cmd) {
      const p = parse(StorefrontOrderRescheduleV1, cmd.payload);
      if (p.order_id !== order_id) throw new ApiError("bad_request");
      const o = await lockOrder(c, order_id, true);
      changeable(o, o.reschedule_window_min);
      const outlet = await outletRow(c, o.outlet_id);
      const lines = (await c.query<{ item_id: string; variant_id: string | null; options: unknown; qty_milli: string }>(
        `SELECT item_id, variant_id, options, qty_milli FROM core.order_line WHERE order_id = $1 ORDER BY line_no`, [order_id])).rows;
      const own = await ownRefusals(c, { outlet, pickup_window_id: p.pickup_window_id, promised_at: p.promised_at, lines });
      const blocking = own.find((r) => !(r.reason_code === "window_full" && p.pickup_window_id === o.pickup_window_id));
      if (blocking) throw refused(blocking.reason_code);

      const ctx: CommandContext = { tx: (fn) => fn(c), tenantId: who.tenant_id, actor: { kind: "customer", id: who.customer_id, role: "customer" } };
      const priced = await priceAt(ctx, c, o, lines, codes, p);
      const bad = priced.refusals[0];
      if (bad) throw refused(bad.reason_code);
      // The person confirms the re-priced total they saw; a deal that stopped (or started) applying at the new
      // time changes it, and nothing is written until they see the new figure (R4 §E 5).
      if (priced.total_minor !== p.preview_total_minor) throw refused("deal_rejudged");

      if (p.pickup_window_id !== o.pickup_window_id) {
        if (p.pickup_window_id) {
          const r = await c.query(`UPDATE core.pickup_window SET booked = booked + 1 WHERE id = $1 AND booked < capacity_orders`, [p.pickup_window_id]);
          if (r.rowCount !== 1) throw refused("window_full");
        }
        if (o.pickup_window_id) await c.query(`UPDATE core.pickup_window SET booked = booked - 1 WHERE id = $1 AND booked > 0`, [o.pickup_window_id]);
      }
      await c.query(`UPDATE core."order" SET promised_at = $2, pickup_window_id = $3 WHERE id = $1`, [order_id, p.promised_at, p.pickup_window_id]);
      await c.query(
        `INSERT INTO core.order_event (tenant_id, id, outlet_id, order_id, kind, from_promised_at, to_promised_at, actor, reason)
         VALUES (current_setting('app.tenant_id')::uuid, $1, $2, $3, 'promised_at', $4, $5, $6, 'customer_rescheduled')`,
        [uuidv7(), o.outlet_id, order_id, o.promised_at, p.promised_at, actorOf(who)]);
      // The money columns move only under the seeded pricing rule `orders.reprice`, for this order alone.
      await c.query(`SELECT set_config('app.posting_rule', 'orders.reprice', true), set_config('app.source_ref', $1, true)`, [`core.order:${order_id}`]);
      await c.query(
        `UPDATE core."order" SET subtotal_minor = $2, discount_minor = $3, tax_minor = $4, total_minor = $5, pricing_snapshot = $6 WHERE id = $1`,
        [order_id, priced.subtotal_minor, priced.discount_minor, priced.tax_minor, priced.total_minor,
         { priced_at: priced.priced_at, tax_rule: priced.tax_rule, lines: priced.lines, repriced_for: p.promised_at }]);
      await c.query(`SELECT set_config('app.posting_rule', '', true), set_config('app.source_ref', '', true)`);
      return {
        entityId: order_id,
        audit: [{
          entity: "core.order", entityId: order_id,
          before: { promised_at: o.promised_at ? iso(o.promised_at) : null, total_minor: o.total_minor },
          after: { promised_at: p.promised_at, total_minor: priced.total_minor },
        }],
      };
    },
  };
}

/** Runs a shopper command on its own transaction (coupons presented for the re-pricing) and publishes after commit. */
export async function runShopperCommand(deps: Deps, who: CustomerPrincipal, command: CommandEnvelope, handler: CommandHandler, codes: string[] = []): Promise<ExecuteResult> {
  const out = await withContext(deps.pools.core, contextOf(who, codes.length ? { coupon_codes: codes } : {}), (c) =>
    executeCommand({ tx: (fn) => fn(c), tenantId: who.tenant_id, actor: { kind: "customer", id: who.customer_id, role: "customer" } }, command, handler));
  if (deps.publish) await publishCommitted(deps.publish, who.tenant_id, out.outbox);
  return out;
}

export async function rescheduleInputs(deps: Deps, who: CustomerPrincipal, order_id: string) {
  const { codes } = await repricingInputs(deps, who, order_id);
  return codes;
}
