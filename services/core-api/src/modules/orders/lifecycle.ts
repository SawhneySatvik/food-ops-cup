// Order status changes and promise push-back (project rules 9–10). A status change is conditional on the
// current status (`WHERE status = from`), legal per core.order_status_transition (trigger, MB004) and allowed to
// the caller's role per its `min_role` (here). Every order_event is paired with an outbox event (#80). Entering
// `completed` derives, in the same transaction, the loyalty earn and the sale's journal entry through their
// owners' seams (stock is consumed at placement — place.ts); entering `cancelled`/`rejected` reverses redeemed points and frees the
// pickup slot. No orders.* status command is seeded yet: `orderStatusHandler(type)` is bound to whichever seeded
// command carries the move (today kitchen.ticket.advance.v1, which targets core.order + core.order_event, #41).
import type { CommandHandler, EventDraft, HandlerOutput } from "../../commit/index.ts";
import { uuidv7 } from "../../commit/index.ts";
import { ApiError } from "../../lib/errors.ts";
import type { Queryable } from "../../runtoken/index.ts";
import { asCore, underRule } from "./place.ts";
import { loadChannel, priceCart } from "./pricing.ts";
import { seams } from "./seams.ts";

export const ORDER_STATUSES = ["placed", "accepted", "rejected", "preparing", "ready", "completed", "cancelled"] as const;
export type OrderStatus = (typeof ORDER_STATUSES)[number];
const RANK: Record<string, number> = { customer: 0, staff: 1, manager: 2, owner: 3, judge: 3 };

export type StatusMove = { order_id: string; from_status: OrderStatus; to_status: OrderStatus; reason_code: string | null };
export type Mover = { kind: "member" | "customer"; id: string; role: string };

/** One status step with its event, audit entry and derivations. Exported so the kitchen's ticket advance (and
 *  a future orders.* status command) drive orders through the same path. */
export async function advanceOrder(c: Queryable, move: StatusMove, by: Mover): Promise<HandlerOutput> {
  const t = await c.query<{ min_role: string }>(
    `SELECT min_role FROM core.order_status_transition WHERE from_status = $1 AND to_status = $2`, [move.from_status, move.to_status]);
  const rule = t.rows[0];
  if (!rule) throw new ApiError("illegal_transition");
  if ((RANK[by.role] ?? -1) < RANK[rule.min_role]!) throw new ApiError("forbidden", "authority_denied");
  if ((move.to_status === "rejected" || move.to_status === "cancelled") && !move.reason_code) throw new ApiError("invalid_payload");

  const u = await c.query<{ outlet_id: string; customer_id: string | null; pickup_window_id: string | null }>(
    `UPDATE core."order" SET status = $3 WHERE id = $1 AND status = $2 RETURNING outlet_id, customer_id, pickup_window_id`,
    [move.order_id, move.from_status, move.to_status]);
  const o = u.rows[0];
  if (!o) {
    const seen = await c.query(`SELECT 1 FROM core."order" WHERE id = $1`, [move.order_id]);
    throw new ApiError(seen.rowCount ? "illegal_transition" : "not_found");
  }
  await c.query(
    `INSERT INTO core.order_event (tenant_id, id, outlet_id, order_id, kind, from_status, to_status, actor, reason)
     VALUES (current_setting('app.tenant_id')::uuid, $1, $2, $3, 'status', $4, $5, $6, $7)`,
    [uuidv7(), o.outlet_id, move.order_id, move.from_status, move.to_status, JSON.stringify({ kind: by.kind, id: by.id }), move.reason_code]);

  const source = `core.order:${move.order_id}`;
  if (move.to_status === "completed") {
    if (o.customer_id) await seams.loyaltyEarnFor(c, move.order_id);
    await seams.postFor(c, "finance.post_order", source);
  }
  if (move.to_status === "cancelled" || move.to_status === "rejected") {
    if (o.customer_id) await seams.loyaltyReverseFor(c, move.order_id);
    if (o.pickup_window_id) {
      await asCore(c, o.outlet_id, () =>
        c.query(`UPDATE core.pickup_window SET booked = booked - 1 WHERE id = $1 AND booked > 0`, [o.pickup_window_id]));
    }
  }
  const event: EventDraft = {
    type: "munim.orders.order.status_changed.v1", subject: move.order_id, aggregateType: "order",
    data: { order_id: move.order_id, outlet_id: o.outlet_id, from_status: move.from_status, to_status: move.to_status },
  };
  return {
    entityId: move.order_id,
    audit: [{ entity: "core.order", entityId: move.order_id, before: { status: move.from_status }, after: { status: move.to_status } }],
    events: [event],
  };
}

/** A handler that moves an order one status step under `type` (payload: order_id, from_status, to_status,
 *  reason_code). The actor is read from the transaction's identity, never from the payload. */
export function orderStatusHandler(type: string): CommandHandler {
  return {
    type,
    async run(c, cmd) {
      const p = cmd.payload as Partial<StatusMove>;
      const ok = (s: unknown): s is OrderStatus => typeof s === "string" && (ORDER_STATUSES as readonly string[]).includes(s);
      if (typeof p.order_id !== "string" || !ok(p.from_status) || !ok(p.to_status)) throw new ApiError("invalid_payload");
      if (p.reason_code != null && !/^[a-z][a-z0-9_]*$/.test(p.reason_code)) throw new ApiError("invalid_payload");
      return advanceOrder(c, { order_id: p.order_id, from_status: p.from_status, to_status: p.to_status, reason_code: p.reason_code ?? null }, await mover(c));
    },
  };
}

export async function mover(c: Queryable): Promise<Mover> {
  const r = await c.query<{ role: string | null; member: string | null; customer: string | null }>(
    `SELECT nullif(current_setting('app.role', true), '') AS role, nullif(current_setting('app.member_id', true), '') AS member,
            nullif(current_setting('app.customer_id', true), '') AS customer`);
  const s = r.rows[0]!;
  if (s.role === "customer" && s.customer) return { kind: "customer", id: s.customer, role: "customer" };
  if (s.role && s.member) return { kind: "member", id: s.member, role: s.role };
  throw new ApiError("forbidden");
}

// ── Push-back (orders.promise.push_back.v1) ────────────────────────────────────────────────────────────────

const PUSHABLE = new Set(["placed", "accepted", "preparing"]);

/** Moves the promise later, records why, and re-judges the order's deals at the new time with the one pricing
 *  function. While the order is `placed`/`accepted` (the orders.reprice source state) a changed price is applied
 *  to the header and the snapshot under that derivation; order lines are not re-written (no UPDATE grant —
 *  the snapshot's `repriced` entry carries the new per-line breakdown). Later states keep their price. */
export const pushBackHandler: CommandHandler = {
  type: "orders.promise.push_back.v1",
  async run(c, cmd) {
    const p = cmd.payload as { order_id: string; from_promised_at: string | null; to_promised_at: string; reason_code: string };
    const r = await c.query<{
      outlet_id: string; channel_id: string; status: string; promised_at: Date | null; total_minor: string; pricing_snapshot: Record<string, unknown>;
    }>(`SELECT outlet_id, channel_id, status, promised_at, total_minor, pricing_snapshot FROM core."order" WHERE id = $1 FOR UPDATE`, [p.order_id]);
    const o = r.rows[0];
    if (!o) throw new ApiError("not_found");
    const before = o.promised_at?.toISOString() ?? null;
    const asked = p.from_promised_at === null ? null : new Date(p.from_promised_at).toISOString();
    if (before !== asked || !PUSHABLE.has(o.status)) throw new ApiError("conflict");
    const to = new Date(p.to_promised_at);
    if (to.getTime() <= Date.now() || (o.promised_at && to <= o.promised_at)) throw new ApiError("invalid_payload");

    await c.query(`UPDATE core."order" SET promised_at = $2 WHERE id = $1`, [p.order_id, to.toISOString()]);
    await c.query(
      `INSERT INTO core.order_event (tenant_id, id, outlet_id, order_id, kind, from_promised_at, to_promised_at, actor, reason)
       VALUES (current_setting('app.tenant_id')::uuid, $1, $2, $3, 'promised_at', $4, $5, $6, $7)`,
      [uuidv7(), o.outlet_id, p.order_id, before, to.toISOString(), JSON.stringify({ kind: "member", id: (await mover(c)).id }), p.reason_code]);
    const audit: HandlerOutput["audit"] = [{ entity: "core.order", entityId: p.order_id, before: { promised_at: before }, after: { promised_at: to.toISOString() } }];

    if (o.status === "placed" || o.status === "accepted") {
      const changed = await rejudge(c, p.order_id, o.outlet_id, o.channel_id, to.toISOString(), Number(o.total_minor), o.pricing_snapshot);
      if (changed) audit.push({ entity: "core.order", entityId: p.order_id, action: "orders.reprice", before: { total_minor: Number(o.total_minor) }, after: changed });
    }
    return {
      entityId: p.order_id,
      audit,
      events: [{ type: "munim.orders.order.promise_changed.v1", subject: p.order_id, aggregateType: "order",
        data: { order_id: p.order_id, outlet_id: o.outlet_id, reason_code: p.reason_code } }],
    };
  },
};

/** Re-prices the order's own lines at `at`. Returns the new header when it changed, else null. Coupons stay
 *  as applied at placement (their uses are recorded rows); deals are what moves with time. */
async function rejudge(c: Queryable, orderId: string, outletId: string, channelId: string, at: string, total: number, snap: Record<string, unknown>) {
  const lines = (await c.query<{ line_no: number; item_id: string; variant_id: string | null; options: string[]; qty_milli: string }>(
    `SELECT line_no, item_id, variant_id, options, qty_milli FROM core.order_line WHERE order_id = $1 ORDER BY line_no`, [orderId])).rows;
  const codes = (await c.query<{ code: string }>(
    `SELECT k.code FROM core.coupon_use u JOIN core.coupon k ON k.tenant_id = u.tenant_id AND k.id = u.coupon_id WHERE u.order_id = $1`, [orderId])).rows.map((x) => x.code);
  const channel = await loadChannel(c, channelId);
  const cart = await priceCart(c, {
    outlet_id: outletId, channel_kind: channel.kind, at, coupon_codes: codes,
    lines: lines.map((l) => ({ line_no: l.line_no, item_id: l.item_id, variant_id: l.variant_id, option_ids: l.options, qty_milli: Number(l.qty_milli) })),
  });
  if (cart.refusals.length) throw new ApiError("conflict", cart.refusals[0]!.reason_code);
  if (cart.totals.total_minor === total) return null;
  const repriced = {
    judged_at: at,
    lines: cart.priced.lines.map((l) => ({
      line_no: l.line_no, deal_refs: l.deal_refs, coupon_refs: l.coupon_refs, line_discount_minor: l.line_discount_minor, tax_minor: l.tax_minor,
    })),
  };
  await underRule(c, "orders.reprice", `core.order:${orderId}`, () =>
    c.query(`UPDATE core."order" SET subtotal_minor = $2, discount_minor = $3, tax_minor = $4, total_minor = $5, pricing_snapshot = $6 WHERE id = $1`,
      [orderId, cart.totals.subtotal_minor, cart.totals.discount_minor, cart.totals.tax_minor, cart.totals.total_minor, JSON.stringify({ ...snap, repriced })]));
  return cart.totals;
}
