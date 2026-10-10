// Tenders, voids, refunds and drawer shifts. Payments are RECORDED, never processed (project hard rule 5).
// "Remaining", change and cash rounding are computed by core from the order row and that order's tender rows in
// one read under the order's row lock (R40 C1); the client never computes them. Cash rounding is pack data
// (core-domain cashTender, ruling #59). Each recorded tender / refund is posted by its finance rule (postFor).
import { cashTender } from "@munim/core-domain/packs";
import { slots } from "@munim/core-domain/tz";
import { type CommandHandler, uuidv7 } from "../../commit/index.ts";
import { ApiError } from "../../lib/errors.ts";
import type { Queryable } from "../../runtoken/index.ts";
import { advanceOrder, mover } from "./lifecycle.ts";
import { asCore } from "./place.ts";
import { loadPack } from "./pricing.ts";
import { seams } from "./seams.ts";

type OrderMoney = { outlet_id: string; device_id: string | null; status: string; total_minor: number; loyalty_minor: number; paid_minor: number; refunded_minor: number; currency: string };

/** The order's money in one read: total, the loyalty value applied, Σ tenders toward the bill
 *  (amount − cash rounding), Σ refunds. `lock` takes the order row lock first (tenders, refunds).
 *  Loyalty (clause 2): the value stands only while the snapshot's redeem names this order's `core.loyalty_entry`
 *  redeem row with the same points, unreversed; a reversed redeem (cancel) counts 0. Any other disagreement
 *  between the entries and the snapshot fails closed rather than show a number that does not trace. */
export async function orderMoney(c: Queryable, orderId: string, lock: boolean): Promise<OrderMoney> {
  if (lock) await c.query(`SELECT 1 FROM core."order" WHERE id = $1 FOR UPDATE`, [orderId]);
  const r = await c.query<{ [k: string]: string }>(
    `SELECT o.outlet_id, o.device_id, o.status, o.total_minor, o.currency,
            (o.pricing_snapshot -> 'loyalty' ->> 'entry_id') AS loyalty_entry,
            coalesce((o.pricing_snapshot -> 'loyalty' ->> 'points')::bigint, 0) AS loyalty_points,
            coalesce((o.pricing_snapshot -> 'loyalty' ->> 'value_minor')::bigint, 0) AS loyalty_value,
            (SELECT coalesce(-sum(e.points), 0) FROM core.loyalty_entry e WHERE e.order_id = o.id AND e.kind = 'redeem'
                AND NOT EXISTS (SELECT 1 FROM core.loyalty_entry x WHERE x.tenant_id = e.tenant_id AND x.reverses_id = e.id)) AS redeemed_points,
            (SELECT count(*) FROM core.loyalty_entry e WHERE e.order_id = o.id AND e.kind = 'redeem'
                AND e.id::text = o.pricing_snapshot -> 'loyalty' ->> 'entry_id') AS entry_matches,
            (SELECT coalesce(sum(t.amount_minor - t.rounding_minor), 0) FROM core.tender t WHERE t.order_id = o.id) AS paid_minor,
            (SELECT coalesce(sum(f.amount_minor), 0) FROM core.refund f WHERE f.order_id = o.id) AS refunded_minor
       FROM core."order" o WHERE o.id = $1`, [orderId]);
  const o = r.rows[0];
  if (!o) throw new ApiError("not_found");
  const redeemed = Number(o.redeemed_points);
  const named = o.loyalty_entry !== null && Number(o.entry_matches) === 1;
  if (redeemed !== 0 && !(named && redeemed === Number(o.loyalty_points))) throw new ApiError("internal");
  if (o.loyalty_entry !== null && !named) throw new ApiError("internal");
  return {
    outlet_id: o.outlet_id!, device_id: o.device_id ?? null, status: o.status!, currency: o.currency!,
    total_minor: Number(o.total_minor), loyalty_minor: redeemed === 0 ? 0 : Number(o.loyalty_value), paid_minor: Number(o.paid_minor), refunded_minor: Number(o.refunded_minor),
  };
}

export const remaining = (m: OrderMoney) => Math.max(m.total_minor - m.loyalty_minor - m.paid_minor, 0);

/** orders.tender.record.v1. Cash: what was handed over → amount applied (the due, rounded per the pack, or all
 *  of it when it does not cover the rounded due — INFERENCE: a part-payment in cash is not rounded), change and
 *  rounding. Card / UPI: the amount may not exceed what is due. */
export const tenderHandler: CommandHandler = {
  type: "orders.tender.record.v1",
  async run(c, cmd) {
    const p = cmd.payload as { tender_id: string; order_id: string; method: "cash" | "card" | "upi"; tendered_minor: number | null; amount_minor: number | null; currency: string; ref: string | null };
    const m = await orderMoney(c, p.order_id, true);
    if (m.status === "cancelled" || m.status === "rejected") throw new ApiError("illegal_transition");
    if (p.currency !== m.currency) throw new ApiError("currency_mismatch");
    const due = remaining(m);
    if (due === 0) throw new ApiError("conflict");
    let amount: number;
    let change: number | null = null;
    let rounding = 0;
    if (p.method === "cash") {
      const pack = (await loadPack(c)).doc;
      const r = cashTender(pack, "cash", due);
      // What is left is below the pack's smallest cash step (e.g. 49 paise after a card part-payment): it can only
      // be taken by card / UPI (R2-S3-1).
      if (r.amount_minor === 0) throw new ApiError("conflict", "cash_below_rounding");
      if (p.tendered_minor! >= r.amount_minor) {
        amount = r.amount_minor;
        rounding = r.rounding_minor;
      } else {
        amount = p.tendered_minor!;
      }
      change = p.tendered_minor! - amount;
    } else {
      amount = p.amount_minor!;
      if (amount > due) throw new ApiError("invalid_payload");
    }
    const by = await mover(c);
    await c.query(
      `INSERT INTO core.tender (tenant_id, id, outlet_id, order_id, method, amount_minor, tendered_minor, change_minor, rounding_minor, currency, recorded_by, ref)
       VALUES (current_setting('app.tenant_id')::uuid, $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
      [p.tender_id, m.outlet_id, p.order_id, p.method, amount, p.method === "cash" ? p.tendered_minor : null, change, rounding, p.currency, by.id, p.ref]);
    await seams.postFor(c, "finance.post_tender", `core.tender:${p.tender_id}`);
    return {
      entityId: p.tender_id,
      audit: [{ entity: "core.tender", entityId: p.tender_id, after: { order_id: p.order_id, method: p.method, amount_minor: amount, rounding_minor: rounding } }],
      events: [{ type: "munim.orders.tender.recorded.v1", subject: p.tender_id, aggregateType: "tender",
        data: { tender_id: p.tender_id, order_id: p.order_id, outlet_id: m.outlet_id, method: p.method } }],
    };
  },
};

/** orders.void.record.v1 — before any tender, on an order not yet ended. The value written off is the line's own
 *  total, or for the whole order what its earlier line voids left of the total (Σ voids ≤ total, R2-S2-5). A
 *  whole-order void ends the order: it moves to `cancelled` through advanceOrder (0015 A8 — reversals, freed
 *  slot, paired event) where the transition table allows it, else it is refused. */
export const voidHandler: CommandHandler = {
  type: "orders.void.record.v1",
  async run(c, cmd) {
    const p = cmd.payload as { void_id: string; order_id: string; order_line_id: string | null; reason_code: string; note: string };
    const m = await orderMoney(c, p.order_id, true);
    if (m.paid_minor > 0) throw new ApiError("conflict");
    if (m.status === "cancelled" || m.status === "rejected") throw new ApiError("illegal_transition");
    let amount = m.total_minor;
    if (!p.order_line_id) {
      const lines = await c.query<{ s: string }>(`SELECT coalesce(sum(amount_minor), 0) AS s FROM core.void WHERE order_id = $1 AND order_line_id IS NOT NULL`, [p.order_id]);
      amount = Math.max(m.total_minor - Number(lines.rows[0]!.s), 0);
    } else {
      const pack = (await loadPack(c)).doc;
      const l = await c.query<{ amount: string; line_discount_minor: string; tax_minor: string }>(
        `SELECT round(qty_milli * unit_price_minor / 1000.0) AS amount, line_discount_minor, tax_minor FROM core.order_line WHERE id = $1 AND order_id = $2`,
        [p.order_line_id, p.order_id]);
      const line = l.rows[0];
      if (!line) throw new ApiError("not_found");
      const after = Number(line.amount) - Number(line.line_discount_minor);
      amount = pack.tax.price_display === "inclusive" ? after : after + Number(line.tax_minor);
    }
    const already = await c.query(`SELECT 1 FROM core.void WHERE order_id = $1 AND (order_line_id IS NOT DISTINCT FROM $2 OR order_line_id IS NULL)`, [p.order_id, p.order_line_id]);
    if (already.rowCount) throw new ApiError("conflict");
    const by = await mover(c);
    await c.query(
      `INSERT INTO core.void (tenant_id, id, outlet_id, order_id, order_line_id, reason_code, note, amount_minor, currency, actor)
       VALUES (current_setting('app.tenant_id')::uuid, $1, $2, $3, $4, $5, $6, $7, $8, $9)`,
      [p.void_id, m.outlet_id, p.order_id, p.order_line_id, p.reason_code, p.note, amount, m.currency, by.id]);
    const ended = p.order_line_id ? null
      : await advanceOrder(c, { order_id: p.order_id, from_status: m.status as "placed", to_status: "cancelled", reason_code: p.reason_code }, by);
    return {
      entityId: p.void_id,
      audit: [{ entity: "core.void", entityId: p.void_id, after: { order_id: p.order_id, order_line_id: p.order_line_id, reason_code: p.reason_code, amount_minor: amount } },
        ...(ended?.audit ?? [])],
      events: [{ type: "munim.orders.void.recorded.v1", subject: p.void_id, aggregateType: "void",
        data: { void_id: p.void_id, order_id: p.order_id, outlet_id: m.outlet_id, reason_code: p.reason_code } }, ...(ended?.events ?? [])],
    };
  },
};

/** orders.refund.record.v1 — at most what was paid less earlier refunds (an aggregator order, which has no
 *  tenders here — the aggregator collected — at most its total less earlier refunds; finance posts it as a channel
 *  deduction, R2-S2-10); a named tender must be the order's. The
 *  role's cap (W2-R3, command_authority.role_caps) binds what that role has refunded on this order in total, this
 *  refund included (R1-M3): checked here, under the order lock, so split or concurrent refunds cannot pass it. */
export const refundHandler: CommandHandler = {
  type: "orders.refund.record.v1",
  async run(c, cmd) {
    const p = cmd.payload as { refund_id: string; order_id: string; tender_id: string | null; method: string; amount_minor: number; currency: string; reason_code: string; note: string };
    const m = await orderMoney(c, p.order_id, true);
    if (p.currency !== m.currency) throw new ApiError("currency_mismatch");
    const ch = await c.query<{ kind: string }>(
      `SELECT ch.kind FROM core."order" o JOIN core.channel ch ON ch.tenant_id = o.tenant_id AND ch.id = o.channel_id WHERE o.id = $1`, [p.order_id]);
    const collected = ch.rows[0]!.kind.startsWith("aggregator:") ? m.total_minor : m.paid_minor;
    if (p.amount_minor > collected - m.refunded_minor) throw new ApiError("invalid_payload");
    if (p.tender_id) {
      const t = await c.query(`SELECT 1 FROM core.tender WHERE id = $1 AND order_id = $2`, [p.tender_id, p.order_id]);
      if (!t.rowCount) throw new ApiError("invalid_payload");
    }
    const by = await mover(c);
    const cap = await c.query<{ cap: string | null; so_far: string }>(
      `SELECT (SELECT coalesce(role_caps ->> $2, max_amount_minor::text) FROM core.command_authority WHERE command_type = 'orders.refund.record.v1') AS cap,
              (SELECT coalesce(sum(amount_minor), 0) FROM core.refund WHERE order_id = $1 AND origin ->> 'role' = $2) AS so_far`, [p.order_id, by.role]);
    const k = cap.rows[0]!;
    if (k.cap !== null && Number(k.so_far) + p.amount_minor > Number(k.cap)) throw new ApiError("forbidden", "authority_denied");
    await c.query(
      `INSERT INTO core.refund (tenant_id, id, outlet_id, order_id, tender_id, method, amount_minor, currency, reason_code, note, actor)
       VALUES (current_setting('app.tenant_id')::uuid, $1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
      [p.refund_id, m.outlet_id, p.order_id, p.tender_id, p.method, p.amount_minor, p.currency, p.reason_code, p.note, by.id]);
    await seams.postFor(c, "finance.post_refund", `core.refund:${p.refund_id}`);
    // A completed order's refund takes back its earned points (W2-R10, customers' seam; the rule cites this refund).
    if (m.status === "completed") await asCore(c, m.outlet_id, () => seams.loyaltyReverseFor(c, p.order_id));
    return {
      entityId: p.refund_id,
      audit: [{ entity: "core.refund", entityId: p.refund_id, after: { order_id: p.order_id, method: p.method, amount_minor: p.amount_minor, reason_code: p.reason_code } }],
      events: [{ type: "munim.orders.refund.recorded.v1", subject: p.refund_id, aggregateType: "refund",
        data: { refund_id: p.refund_id, order_id: p.order_id, outlet_id: m.outlet_id, method: p.method, reason_code: p.reason_code } }],
    };
  },
};

/** orders.shift.open.v1 — one open shift per drawer (device, or the outlet when no device). */
export const shiftOpenHandler: CommandHandler = {
  type: "orders.shift.open.v1",
  async run(c, cmd) {
    const p = cmd.payload as { shift_id: string; outlet_id: string; device_id: string | null; float_minor: number; currency: string };
    await c.query(`SELECT pg_advisory_xact_lock(hashtextextended('core.shift:' || $1 || ':' || coalesce($2, ''), 0))`, [p.outlet_id, p.device_id]);
    const open = await c.query(`SELECT 1 FROM core.shift WHERE outlet_id = $1 AND device_id IS NOT DISTINCT FROM $2 AND status = 'open'`, [p.outlet_id, p.device_id]);
    if (open.rowCount) throw new ApiError("conflict");
    const by = await mover(c);
    await c.query(
      `INSERT INTO core.shift (tenant_id, id, outlet_id, device_id, opened_by, float_minor, currency)
       VALUES (current_setting('app.tenant_id')::uuid, $1, $2, $3, $4, $5, $6)`,
      [p.shift_id, p.outlet_id, p.device_id, by.id, p.float_minor, p.currency]);
    return {
      entityId: p.shift_id,
      audit: [{ entity: "core.shift", entityId: p.shift_id, after: { status: "open", outlet_id: p.outlet_id, device_id: p.device_id, float_minor: p.float_minor } }],
      events: [{ type: "munim.orders.shift.opened.v1", subject: p.shift_id, aggregateType: "shift", data: { shift_id: p.shift_id, outlet_id: p.outlet_id, device_id: p.device_id } }],
    };
  },
};

/** Expected cash in a drawer: float + Σ cash tender amounts − Σ cash refunds, for orders of the shift's
 *  device (or, for a device-less shift, the outlet's device-less orders) recorded between open and `until`.
 *  INFERENCE: tenders carry no shift id; the drawer is the order's device and the shift's time window. */
export async function expectedCash(c: Queryable, shiftId: string, until: string): Promise<{ float_minor: number; expected_minor: number }> {
  const r = await c.query<{ float_minor: string; expected: string }>(
    `SELECT s.float_minor,
            s.float_minor
            + (SELECT coalesce(sum(t.amount_minor), 0) FROM core.tender t JOIN core."order" o ON o.tenant_id = t.tenant_id AND o.id = t.order_id
                WHERE t.method = 'cash' AND o.outlet_id = s.outlet_id AND o.device_id IS NOT DISTINCT FROM s.device_id
                  AND t.at >= s.opened_at AND t.at <= $2::timestamptz)
            - (SELECT coalesce(sum(f.amount_minor), 0) FROM core.refund f JOIN core."order" o ON o.tenant_id = f.tenant_id AND o.id = f.order_id
                WHERE f.method = 'cash' AND o.outlet_id = s.outlet_id AND o.device_id IS NOT DISTINCT FROM s.device_id
                  AND f.at >= s.opened_at AND f.at <= $2::timestamptz) AS expected
       FROM core.shift s WHERE s.id = $1`, [shiftId, until]);
  const s = r.rows[0];
  if (!s) throw new ApiError("not_found");
  return { float_minor: Number(s.float_minor), expected_minor: Number(s.expected) };
}

/** orders.shift.close.v1 — core computes expected cash and the variance (counted − expected). */
export const shiftCloseHandler: CommandHandler = {
  type: "orders.shift.close.v1",
  async run(c, cmd) {
    const p = cmd.payload as { shift_id: string; counted_cash_minor: number };
    const s = await c.query<{ outlet_id: string; device_id: string | null; status: string; now: Date }>(
      `SELECT outlet_id, device_id, status, now() AS now FROM core.shift WHERE id = $1 FOR UPDATE`, [p.shift_id]);
    const shift = s.rows[0];
    if (!shift) throw new ApiError("not_found");
    if (shift.status !== "open") throw new ApiError("illegal_transition");
    const { expected_minor } = await expectedCash(c, p.shift_id, shift.now.toISOString());
    const variance = p.counted_cash_minor - expected_minor;
    const by = await mover(c);
    await c.query(
      `UPDATE core.shift SET status = 'closed', closed_by = $2, closed_at = now(), counted_cash_minor = $3, expected_cash_minor = $4, variance_minor = $5
        WHERE id = $1 AND status = 'open'`, [p.shift_id, by.id, p.counted_cash_minor, expected_minor, variance]);
    return {
      entityId: p.shift_id,
      audit: [{ entity: "core.shift", entityId: p.shift_id, before: { status: "open" },
        after: { status: "closed", counted_cash_minor: p.counted_cash_minor, expected_cash_minor: expected_minor, variance_minor: variance } }],
      events: [{ type: "munim.orders.shift.closed.v1", subject: p.shift_id, aggregateType: "shift", data: { shift_id: p.shift_id, outlet_id: shift.outlet_id, device_id: shift.device_id } }],
    };
  },
};

/** orders.pickup_window.generate.v1 — slots of `slot_minutes` between two outlet-local times on a business
 *  date (core-domain tz `slots`, DST-safe). Operational rows; idempotent per (outlet, starts_at): a slot that
 *  exists keeps its capacity and bookings. */
export const pickupWindowHandler: CommandHandler = {
  type: "orders.pickup_window.generate.v1",
  async run(c, cmd) {
    const p = cmd.payload as { outlet_id: string; business_date: string; from_local: string; to_local: string; slot_minutes: number; capacity_orders: number };
    const tz = (await c.query<{ tz: string }>(`SELECT tz FROM core.outlet WHERE id = $1`, [p.outlet_id])).rows[0]?.tz;
    if (!tz) throw new ApiError("not_found");
    let windows: Array<{ starts_at: string; ends_at: string }>;
    try {
      windows = slots(p.business_date, p.from_local, p.to_local, p.slot_minutes, tz);
    } catch {
      throw new ApiError("invalid_payload");
    }
    let created = 0;
    for (const w of windows) {
      const r = await c.query(
        `INSERT INTO core.pickup_window (tenant_id, id, outlet_id, starts_at, ends_at, capacity_orders)
         VALUES (current_setting('app.tenant_id')::uuid, $1, $2, $3, $4, $5) ON CONFLICT (tenant_id, outlet_id, starts_at) DO NOTHING`,
        [uuidv7(), p.outlet_id, w.starts_at, w.ends_at, p.capacity_orders]);
      created += r.rowCount ?? 0;
    }
    return {
      entityId: p.outlet_id,
      audit: [{ entity: "core.outlet", entityId: p.outlet_id, after: { pickup_windows: { business_date: p.business_date, slots: windows.length, created } } }],
    };
  },
};
