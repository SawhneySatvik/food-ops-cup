// The shopper's own order: read, cancel, reschedule (+ its write-nothing preview).
//   read:       a signed-in customer (own orders) or a guest-token holder (that one order) — anything else is 404.
//   cancel / reschedule: signed-in customers only. A guest is refused `guest_cannot_change` ("Call the outlet to
//   change this order", W2-R2); a guest context writes nothing (0014 guest_scope).
//   The status move is orders.advanceOrder's (W2-R9): the paired outbox event (#80), the loyalty and stock reversals
//   and the pickup slot release happen there, in this transaction. The re-price is orders' quoteReprice /
//   applyReprice: the order as placed, judged at the new time.
//   Windows (INFERENCE: G-SF-1 has no definition, screen O3 reads "window − elapsed"): minutes after
//   core.order.created_at, per core.outlet.cancel_window_min / reschedule_window_min; only a `placed` order is
//   changeable online (the transition table lets a customer cancel only from placed).
import type { CommandEnvelope } from "@munim/contracts";
import { OrdersPreviewResponse } from "@munim/contracts/orders";
import { StorefrontOrderCancelV1, StorefrontOrderRescheduleV1, StorefrontReschedulePreviewRequest } from "@munim/contracts/storefront";
import { contextOf, type Principal } from "../../auth/resolve.ts";
import { executeCommand, publishCommitted, uuidv7, type CommandHandler, type ExecuteResult } from "../../commit/index.ts";
import { asSystem, withContext } from "../../lib/db.ts";
import { ApiError } from "../../lib/errors.ts";
import type { Deps } from "../../lib/types.ts";
import type { Queryable } from "../../runtoken/index.ts";
import { advanceOrder, applyReprice, previewBody, quoteReprice, refuseIfTendered } from "../orders/index.ts";
import { now } from "./config.ts";
import { type CustomerPrincipal, refused } from "./checkout.ts";
import { outletRow, ownRefusals, type PackRef, pricedPack } from "./read.ts";

type Shopper = CustomerPrincipal | Extract<Principal, { kind: "guest" }>;

/** A request body that does not fit is 400; a command payload that does not fit is 422 invalid_payload (R3-M6). */
function parse<T>(schema: { safeParse(v: unknown): { success: true; data: T } | { success: false } }, body: unknown, code: "bad_request" | "invalid_payload" = "bad_request"): T {
  const r = schema.safeParse(body);
  if (!r.success) throw new ApiError(code);
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
        pack: PackRef; classes: Array<{ line_no?: unknown; tax_class?: unknown }> | null;
      }>(
        `SELECT id, outlet_id, kind, status, ticket_no, to_char(business_date, 'YYYY-MM-DD') AS business_date, promised_at, pickup_window_id,
                subtotal_minor, discount_minor, tax_minor, total_minor, currency, created_at,
                pricing_snapshot -> 'pack' AS pack, pricing_snapshot -> 'lines' AS classes
           FROM core."order" WHERE id = $1`, [order_id])
    ).rows[0];
    if (!o) throw new ApiError("not_found"); // RLS shows a shopper only their own order: someone else's looks absent
    const lines = await c.query<{ line_no: number; item_id: string; variant_id: string | null; qty_milli: string; unit_price_minor: string; line_discount_minor: string; tax_minor: string }>(
      `SELECT line_no, item_id, variant_id, qty_milli, unit_price_minor, line_discount_minor, tax_minor FROM core.order_line WHERE order_id = $1 ORDER BY line_no`, [order_id]);
    const events = await c.query<{ kind: string; from_status: string | null; to_status: string | null; from_promised_at: Date | null; to_promised_at: Date | null; reason: string | null; at: Date }>(
      `SELECT kind, from_status, to_status, from_promised_at, to_promised_at, reason, at FROM core.order_event WHERE order_id = $1 ORDER BY seq`, [order_id]);
    // The outlet is public to a customer but not to a guest context; its two window columns are not secret.
    const w = await asSystem(c, async () =>
      (await c.query<{ cancel_window_min: number; reschedule_window_min: number }>(`SELECT cancel_window_min, reschedule_window_min FROM core.outlet WHERE id = $1`, [o.outlet_id])).rows[0]!);
    // G-03: each line's tax class (as priced, in the order's snapshot) → that pack version's rate and component rates.
    const pack = await pricedPack(c, o.pack);
    const rates = (line_no: number) => {
      const code = (Array.isArray(o.classes) ? o.classes : []).find((x) => x.line_no === line_no)?.tax_class;
      const cls = pack?.tax.classes.find((x) => x.code === code);
      return { tax_rate_bp: cls ? cls.rate_bp : null, tax_component_rates: cls ? cls.components.map((k) => ({ code: k.code, rate_bp: k.rate_bp })) : [] };
    };
    return {
      order_id: o.id, outlet_id: o.outlet_id, kind: o.kind, status: o.status, ticket_no: o.ticket_no, business_date: o.business_date,
      promised_at: o.promised_at ? iso(o.promised_at) : null, pickup_window_id: o.pickup_window_id,
      subtotal_minor: Number(o.subtotal_minor), discount_minor: Number(o.discount_minor), tax_minor: Number(o.tax_minor), total_minor: Number(o.total_minor),
      currency: o.currency, created_at: iso(o.created_at), cancel_window_min: w.cancel_window_min, reschedule_window_min: w.reschedule_window_min,
      pay_at_counter: true as const,
      prices_include_tax: pack ? pack.tax.price_display === "inclusive" : null,
      lines: lines.rows.map((l) => ({
        line_no: l.line_no, item_id: l.item_id, variant_id: l.variant_id, qty_milli: Number(l.qty_milli),
        unit_price_minor: Number(l.unit_price_minor), line_discount_minor: Number(l.line_discount_minor), tax_minor: Number(l.tax_minor),
        ...rates(l.line_no),
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
      const p = parse(StorefrontOrderCancelV1, cmd.payload, "invalid_payload");
      if (p.order_id !== order_id) throw new ApiError("invalid_payload");
      const o = await lockOrder(c, order_id, true);
      changeable(o, o.cancel_window_min);
      // The reason is one of the contract's fixed codes, else a fixed code: free text is never stored (R1-m1).
      return advanceOrder(c, { order_id, from_status: "placed", to_status: "cancelled", reason_code: p.reason ?? "customer_cancelled" },
        { kind: "customer", id: who.customer_id, role: "customer" });
    },
  };
}

// ── Reschedule: re-price at the new promised time
const lineKeys = async (c: Queryable, order_id: string) =>
  (await c.query<{ item_id: string; variant_id: string | null }>(`SELECT item_id, variant_id FROM core.order_line WHERE order_id = $1 ORDER BY line_no`, [order_id])).rows;

/** Write-nothing: the order re-priced at the new time, with the same refusals placement would raise. */
export async function reschedulePreview(deps: Deps, who: CustomerPrincipal, order_id: string, body: unknown) {
  const req = parse(StorefrontReschedulePreviewRequest, body);
  return withContext(deps.pools.core, contextOf(who), async (c) => {
    const o = await lockOrder(c, order_id, false);
    await refuseIfTendered(c, order_id, o.outlet_id);
    const priced = previewBody((await quoteReprice(c, order_id, req.promised_at)).cart, req.promised_at);
    const outlet = await outletRow(c, o.outlet_id);
    const own = await ownRefusals(c, { outlet, pickup_window_id: req.pickup_window_id, promised_at: req.promised_at, lines: await lineKeys(c, order_id) });
    // The order's own current window is already counted in `booked`; staying in it is not a capacity problem.
    const refusals = own.filter((r) => !(r.reason_code === "window_full" && req.pickup_window_id === o.pickup_window_id));
    return {
      order_id, promised_at: req.promised_at, current_total_minor: o.total_minor,
      preview: OrdersPreviewResponse.parse({ ...priced, refusals: [...refusals, ...priced.refusals] }),
    };
  });
}

export function rescheduleHandler(who: CustomerPrincipal, order_id: string): CommandHandler {
  return {
    type: "storefront.order.reschedule.v1",
    async run(c, cmd) {
      const p = parse(StorefrontOrderRescheduleV1, cmd.payload, "invalid_payload");
      if (p.order_id !== order_id) throw new ApiError("invalid_payload");
      const o = await lockOrder(c, order_id, true);
      changeable(o, o.reschedule_window_min);
      await refuseIfTendered(c, order_id, o.outlet_id);
      const outlet = await outletRow(c, o.outlet_id);
      const own = await ownRefusals(c, { outlet, pickup_window_id: p.pickup_window_id, promised_at: p.promised_at, lines: await lineKeys(c, order_id) });
      const blocking = own.find((r) => !(r.reason_code === "window_full" && p.pickup_window_id === o.pickup_window_id));
      if (blocking) throw refused(blocking.reason_code);

      const quote = await quoteReprice(c, order_id, p.promised_at);
      const bad = quote.cart.refusals[0];
      if (bad) throw refused(bad.reason_code);
      // The person confirms the re-priced total they saw; a deal that stopped (or started) applying at the new
      // time changes it, and nothing is written until they see the new figure (R4 §E 5).
      if (quote.cart.totals.total_minor !== p.preview_total_minor) {
        throw refused("deal_rejudged", { old_total_minor: p.preview_total_minor, new_total_minor: quote.cart.totals.total_minor, currency: quote.cart.pack.doc.currency.code });
      }

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
      // The money (header, moved lines, the merged snapshot) moves only under orders.reprice, each row audited.
      const repriced = await applyReprice(c, order_id, quote);
      return {
        entityId: order_id,
        audit: [{
          entity: "core.order", entityId: order_id,
          before: { promised_at: o.promised_at ? iso(o.promised_at) : null, pickup_window_id: o.pickup_window_id },
          after: { promised_at: p.promised_at, pickup_window_id: p.pickup_window_id },
        }, ...repriced],
        // #80: the promised_at order_event is paired with its outbox event (shopper feed and KDS wake on it).
        events: [{ type: "munim.orders.order.promise_changed.v1", subject: order_id, aggregateType: "order",
          data: { order_id, outlet_id: o.outlet_id, reason_code: "customer_rescheduled" } }],
      };
    },
  };
}

/** Runs a shopper command on its own transaction and publishes after commit. */
export async function runShopperCommand(deps: Deps, who: CustomerPrincipal, command: CommandEnvelope, handler: CommandHandler): Promise<ExecuteResult> {
  const out = await withContext(deps.pools.core, contextOf(who), (c) =>
    executeCommand({ tx: (fn) => fn(c), tenantId: who.tenant_id, actor: { kind: "customer", id: who.customer_id, role: "customer" } }, command, handler));
  if (deps.publish) await publishCommitted(deps.publish, who.tenant_id, out.outbox);
  return out;
}
