// Order status changes and promise push-back (project rules 9–10). A status change is conditional on the
// current status (`WHERE status = from`), legal per core.order_status_transition (trigger, MB004) and allowed to
// the caller's role per its `min_role` (here). Every order_event is paired with an outbox event (#80). Entering
// `completed` derives, in the same transaction, the loyalty earn and the sale's journal entry through their
// owners' seams (stock is consumed at placement — place.ts); entering `cancelled`/`rejected` is refused while
// payments stand unrefunded (the POS refunds first, R2-S1-3), then reverses redeemed points, gives the consumed
// stock back (W2-R6, inventory's seam) and frees the pickup slot. `orderStatusHandler(type)` binds the move to the
// seeded command that carries it: the POS's orders.order.accept.v1 / .reject.v1 / .advance.v1 (each limited to its
// own steps by posStatusHandler — the database binds all three to the same tables), the kitchen's
// kitchen.ticket.advance.v1, the shopper's storefront.order.cancel.v1 and a whole-order void (0015 A4/A8, #41).
// Re-pricing an order at a new promised time (push-back here, the shopper's reschedule in storefront) is one
// function pair, quoteReprice / applyReprice.
import type { AuditEntry, CommandHandler, EventDraft, HandlerOutput } from "../../commit/index.ts";
import { uuidv7 } from "../../commit/index.ts";
import { ApiError } from "../../lib/errors.ts";
import type { Queryable } from "../../runtoken/index.ts";
import { asCore, underRule } from "./place.ts";
import { loadChannel, type PricedCart, priceCart } from "./pricing.ts";
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
  const ending = move.to_status === "rejected" || move.to_status === "cancelled";
  if (ending && !move.reason_code) throw new ApiError("invalid_payload", "reason_required");
  // A reason is a code (it reaches the tracker and the KDS); free text is never stored (R1-m1).
  if (move.reason_code !== null && !REASON.test(move.reason_code)) throw new ApiError("invalid_payload");
  if (ending) {
    // The same paid − refunded quantity that bounds a refund (money.ts), so a fully refunded order can end.
    const left = await asCore(c, (await outletOf(c, move.order_id)), async () => (await c.query<{ n: string }>(
      `SELECT (SELECT coalesce(sum(amount_minor - rounding_minor), 0) FROM core.tender WHERE order_id = $1)
            - (SELECT coalesce(sum(amount_minor), 0) FROM core.refund WHERE order_id = $1) AS n`, [move.order_id])).rows[0]!.n);
    if (Number(left) > 0) throw new ApiError("conflict", "refund_first");
  }

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
  // Loyalty is core's own bookkeeping on the order's one outlet (asCore): a customer's own cancel has no outlet
  // scope, so the derivation would not even see its source order.
  if (move.to_status === "completed") {
    if (o.customer_id) await asCore(c, o.outlet_id, () => seams.loyaltyEarnFor(c, move.order_id));
    await seams.postFor(c, "finance.post_order", source);
  }
  const events: EventDraft[] = [{
    type: "munim.orders.order.status_changed.v1", subject: move.order_id, aggregateType: "order",
    data: { order_id: move.order_id, outlet_id: o.outlet_id, from_status: move.from_status, to_status: move.to_status },
  }];
  if (ending) {
    if (o.customer_id) await asCore(c, o.outlet_id, () => seams.loyaltyReverseFor(c, move.order_id));
    if (o.pickup_window_id) {
      await asCore(c, o.outlet_id, () =>
        c.query(`UPDATE core.pickup_window SET booked = booked - 1 WHERE id = $1 AND booked > 0`, [o.pickup_window_id]));
    }
    events.push(...((await asCore(c, o.outlet_id, () => seams.reverseOrderConsumption(c, move.order_id)))?.events ?? []));
    // The order's coupon uses stay as recorded (append-only, no reversal column); a cancelled or rejected order's
    // use no longer counts towards a cap (recordCoupons in place.ts).
  }
  return {
    entityId: move.order_id,
    audit: [{ entity: "core.order", entityId: move.order_id, before: { status: move.from_status }, after: { status: move.to_status } }],
    events,
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
      return advanceOrder(c, { order_id: p.order_id, from_status: p.from_status, to_status: p.to_status, reason_code: p.reason_code ?? null }, await mover(c));
    },
  };
}

/** The POS commands' payloads as the one status-move shape. Each command is limited to its own steps by its
 *  contract: accept / reject carry no statuses (always placed → accepted / rejected) and advance's to_status
 *  excludes accepted, rejected and placed — the database binds all three to the same tables, so this is where the
 *  difference lives. */
export function posStatusHandler(type: "orders.order.accept.v1" | "orders.order.reject.v1" | "orders.order.advance.v1"): CommandHandler {
  const inner = orderStatusHandler(type);
  return {
    type,
    run(c, cmd) {
      const p = cmd.payload as { order_id: string; reason_code?: string; from_status?: string; to_status?: string };
      const move = type === "orders.order.accept.v1" ? { order_id: p.order_id, from_status: "placed", to_status: "accepted", reason_code: null }
        : type === "orders.order.reject.v1" ? { order_id: p.order_id, from_status: "placed", to_status: "rejected", reason_code: p.reason_code }
        : p;
      return inner.run(c, { ...cmd, payload: move });
    },
  };
}

const REASON = /^[a-z][a-z0-9_]*$/;

/** The order's outlet, or not_found (RLS: an order outside the caller's view looks absent). */
async function outletOf(c: Queryable, orderId: string): Promise<string> {
  const r = await c.query<{ outlet_id: string }>(`SELECT outlet_id FROM core."order" WHERE id = $1`, [orderId]);
  if (!r.rows[0]) throw new ApiError("not_found");
  return r.rows[0].outlet_id;
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

// ── Push-back (orders.promise.push_back.v1) and the shared re-price ────────────────────────────────────────

const PUSHABLE = new Set(["placed", "accepted", "preparing"]);

/** Moves the promise later, records why, and re-judges the order's deals at the new time with the one pricing
 *  function. While the order is `placed`/`accepted` (the orders.reprice source state) a changed price is applied
 *  to the header, its lines and the snapshot under that derivation. Later states keep their price. Refused once a
 *  payment is recorded (R2-S2-6): a re-price would move a total that was already paid. */
export const pushBackHandler: CommandHandler = {
  type: "orders.promise.push_back.v1",
  async run(c, cmd) {
    const p = cmd.payload as { order_id: string; from_promised_at: string | null; to_promised_at: string; reason_code: string };
    const r = await c.query<{ outlet_id: string; status: string; promised_at: Date | null }>(
      `SELECT outlet_id, status, promised_at FROM core."order" WHERE id = $1 FOR UPDATE`, [p.order_id]);
    const o = r.rows[0];
    if (!o) throw new ApiError("not_found");
    const before = o.promised_at?.toISOString() ?? null;
    const asked = p.from_promised_at === null ? null : new Date(p.from_promised_at).toISOString();
    if (before !== asked || !PUSHABLE.has(o.status)) throw new ApiError("conflict");
    const to = new Date(p.to_promised_at);
    if (to.getTime() <= Date.now() || (o.promised_at && to <= o.promised_at)) throw new ApiError("invalid_payload");
    await refuseIfTendered(c, p.order_id, o.outlet_id);

    await c.query(`UPDATE core."order" SET promised_at = $2 WHERE id = $1`, [p.order_id, to.toISOString()]);
    await c.query(
      `INSERT INTO core.order_event (tenant_id, id, outlet_id, order_id, kind, from_promised_at, to_promised_at, actor, reason)
       VALUES (current_setting('app.tenant_id')::uuid, $1, $2, $3, 'promised_at', $4, $5, $6, $7)`,
      [uuidv7(), o.outlet_id, p.order_id, before, to.toISOString(), JSON.stringify({ kind: "member", id: (await mover(c)).id }), p.reason_code]);
    const audit: AuditEntry[] = [{ entity: "core.order", entityId: p.order_id, before: { promised_at: before }, after: { promised_at: to.toISOString() } }];

    if (o.status === "placed" || o.status === "accepted") {
      const quote = await quoteReprice(c, p.order_id, to.toISOString());
      audit.push(...(await applyReprice(c, p.order_id, quote)));
    }
    return {
      entityId: p.order_id,
      audit,
      events: [{ type: "munim.orders.order.promise_changed.v1", subject: p.order_id, aggregateType: "order",
        data: { order_id: p.order_id, outlet_id: o.outlet_id, reason_code: p.reason_code } }],
    };
  },
};

/** R2-S2-6: no re-price once any payment is recorded on the order (read as core: a shopper's context sees it too). */
export async function refuseIfTendered(c: Queryable, orderId: string, outletId: string): Promise<void> {
  const t = await asCore(c, outletId, () => c.query(`SELECT 1 FROM core.tender WHERE order_id = $1 LIMIT 1`, [orderId]));
  if (t.rowCount) throw new ApiError("conflict", "order_tendered");
}

type Snapshot = Record<string, unknown> & { coupons?: Array<{ coupon_id: string }> };
export type RepriceQuote = { at: string; cart: PricedCart; snapshot: Snapshot; header: { subtotal_minor: number; discount_minor: number; tax_minor: number; total_minor: number } };

/** The order priced again at `at` exactly as it was placed: its own lines, its coupons in the order they were
 *  applied at placement (R2-S2-3), this order's own coupon uses not counted against their caps (R2-S2-1), and its
 *  customer (R2-S2-2). Core's own read of the order's rows (asCore): the caller authorised the change first.
 *  Writes nothing; refusals are returned on the cart. */
export async function quoteReprice(c: Queryable, orderId: string, at: string): Promise<RepriceQuote> {
  const outlet = await outletOf(c, orderId);
  return asCore(c, outlet, async () => {
    const o = (await c.query<{ channel_id: string; customer_id: string | null; pricing_snapshot: Snapshot; subtotal_minor: string; discount_minor: string; tax_minor: string; total_minor: string }>(
      `SELECT channel_id, customer_id, pricing_snapshot, subtotal_minor, discount_minor, tax_minor, total_minor FROM core."order" WHERE id = $1`, [orderId])).rows[0]!;
    const lines = (await c.query<{ line_no: number; item_id: string; variant_id: string | null; options: string[]; qty_milli: string }>(
      `SELECT line_no, item_id, variant_id, options, qty_milli FROM core.order_line WHERE order_id = $1 ORDER BY line_no`, [orderId])).rows;
    const ids = (o.pricing_snapshot.coupons ?? []).map((k) => k.coupon_id);
    const found = ids.length
      ? (await c.query<{ id: string; code: string }>(`SELECT id, code FROM core.coupon WHERE id = ANY ($1::uuid[])`, [ids])).rows
      : [];
    const codes = ids.map((id) => found.find((k) => k.id === id)!.code);
    const channel = await loadChannel(c, o.channel_id);
    const cart = await priceCart(c, {
      outlet_id: outlet, channel_kind: channel.kind, at, coupon_codes: codes, customer_id: o.customer_id, exclude_order_id: orderId,
      lines: lines.map((l) => ({ line_no: l.line_no, item_id: l.item_id, variant_id: l.variant_id, option_ids: l.options, qty_milli: Number(l.qty_milli) })),
    });
    const header = { subtotal_minor: Number(o.subtotal_minor), discount_minor: Number(o.discount_minor), tax_minor: Number(o.tax_minor), total_minor: Number(o.total_minor) };
    return { at, cart, snapshot: o.pricing_snapshot, header };
  });
}

/** Writes a quote under orders.reprice: the header, each line whose money moved, and the snapshot MERGED (R2-S1-1:
 *  loyalty, picks, coupons, pack and judged_at stay; `repriced` records this judgement — per-line refs, tax class,
 *  discount and each coupon's new share, R2-S3-7). Returns the audit entries: the header and every changed line
 *  with before / after (R2-S1-2). A refused quote is refused here with its first reason; nothing moved → no write. */
export async function applyReprice(c: Queryable, orderId: string, q: RepriceQuote): Promise<AuditEntry[]> {
  if (q.cart.refusals.length) throw new ApiError("conflict", q.cart.refusals[0]!.reason_code);
  const was = (await c.query<{ id: string; line_no: number; unit_price_minor: string; line_discount_minor: string; tax_minor: string }>(
    `SELECT id, line_no, unit_price_minor, line_discount_minor, tax_minor FROM core.order_line WHERE order_id = $1 ORDER BY line_no`, [orderId])).rows;
  const moved = q.cart.priced.lines.flatMap((l) => {
    const w = was.find((x) => x.line_no === l.line_no)!;
    const before = { unit_price_minor: Number(w.unit_price_minor), line_discount_minor: Number(w.line_discount_minor), tax_minor: Number(w.tax_minor) };
    const after = { unit_price_minor: l.unit_price_minor + l.options_minor, line_discount_minor: l.line_discount_minor, tax_minor: l.tax_minor };
    return before.unit_price_minor === after.unit_price_minor && before.line_discount_minor === after.line_discount_minor && before.tax_minor === after.tax_minor
      ? [] : [{ id: w.id, l, before, after }];
  });
  // R2-S3-7: each coupon's new share is written to its use row (core.coupon_use), under the same rule as the header.
  const uses = (await c.query<{ id: string; coupon_id: string; discount_minor: string }>(
    `SELECT id, coupon_id, discount_minor FROM core.coupon_use WHERE order_id = $1`, [orderId])).rows;
  const split = q.cart.priced.coupons.flatMap((k) => {
    const u = uses.find((x) => x.coupon_id === k.coupon_id);
    return u && Number(u.discount_minor) !== k.discount_minor ? [{ id: u.id, before: Number(u.discount_minor), after: k.discount_minor }] : [];
  });
  const t = q.cart.totals;
  if (!moved.length && !split.length && t.total_minor === q.header.total_minor && t.tax_minor === q.header.tax_minor && t.discount_minor === q.header.discount_minor) return [];
  const snapshot = {
    ...q.snapshot,
    repriced: {
      judged_at: q.at,
      lines: q.cart.priced.lines.map((l) => ({
        line_no: l.line_no, price_ref: l.price_ref, option_refs: l.option_refs, deal_refs: l.deal_refs, coupon_refs: l.coupon_refs,
        tax_class: l.tax_class, line_discount_minor: l.line_discount_minor, tax_minor: l.tax_minor,
      })),
      coupons: q.cart.priced.coupons.map((k) => ({ coupon_id: k.coupon_id, discount_minor: k.discount_minor })),
    },
  };
  await underRule(c, "orders.reprice", `core.order:${orderId}`, async () => {
    await c.query(`UPDATE core."order" SET subtotal_minor = $2, discount_minor = $3, tax_minor = $4, total_minor = $5, pricing_snapshot = $6 WHERE id = $1`,
      [orderId, t.subtotal_minor, t.discount_minor, t.tax_minor, t.total_minor, JSON.stringify(snapshot)]);
    for (const m of moved) {
      await c.query(`UPDATE core.order_line SET unit_price_minor = $2, line_discount_minor = $3, tax_minor = $4 WHERE id = $1`,
        [m.id, m.after.unit_price_minor, m.after.line_discount_minor, m.after.tax_minor]);
    }
    for (const k of split) await c.query(`UPDATE core.coupon_use SET discount_minor = $2 WHERE id = $1`, [k.id, k.after]);
  });
  return [
    { entity: "core.order", entityId: orderId, action: "orders.reprice", before: q.header, after: { ...t, judged_at: q.at } },
    ...moved.map((m) => ({ entity: "core.order_line", entityId: m.id, action: "orders.reprice", before: m.before, after: m.after })),
    ...split.map((k) => ({ entity: "core.coupon_use", entityId: k.id, action: "orders.reprice", before: { discount_minor: k.before }, after: { discount_minor: k.after } })),
  ];
}
