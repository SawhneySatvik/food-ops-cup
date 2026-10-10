// Loyalty ledger seams (R40 C2; packs/customers-growth.md; W2 lane brief "Cross-module seams"). T-022 calls these
// inside ITS transaction, so they take the caller's role-scoped client and never open or commit one.
//
//   loyaltyRedeem    at checkout, written under the CALLER'S command (orders.place.v1 lists core.loyalty_entry for
//                    members and, as a customer's own row, for customers). The order row must already exist.
//   loyaltyEarnFor   a LISTED DERIVATION (rule customers.loyalty_earn): call it AFTER the order's status has become
//                    'completed'; the guard admits the row only while the source order is in that state.
//   loyaltyReverseFor a LISTED DERIVATION (rule customers.loyalty_reverse): call it AFTER the order became
//                    'cancelled' or 'rejected'; it gives back redeemed points (and takes back any earn).
//
// The balance is never stored: every entry carries `seq` and `balance_after`, set by the database trigger while it
// holds the customer's row lock, so concurrent writers queue per customer and a balance can never go below zero
// (MB011 → `loyalty_refused`). A database refusal propagates unchanged and aborts the caller's transaction —
// placement is refused as a whole. Nothing here catches a constraint error and carries on.
import { uuidv7 } from "../../commit/index.ts";
import { asSystem } from "../../lib/db.ts";
import { ApiError } from "../../lib/errors.ts";
import type { Queryable } from "../../runtoken/index.ts";

export interface LoyaltyWrite {
  entry_id: string;
  points: number;
}

interface OrderRow {
  customer_id: string | null;
  status: string;
  net_minor: string;
  outlet_id: string;
  business_date: string;
}

async function orderOf(tx: Queryable, orderId: string): Promise<OrderRow> {
  const r = await tx.query<OrderRow>(
    `SELECT customer_id, status, (subtotal_minor - discount_minor)::text AS net_minor, outlet_id, business_date::text AS business_date
       FROM core."order" WHERE id = $1`, [orderId]);
  if (!r.rows[0]) throw new ApiError("not_found");
  return r.rows[0];
}

/** W2-R4: the tenant's loyalty policy (core.business_policy) in force for the order's outlet on its business date —
 *  an outlet's own row before the tenant-wide one, the latest version first. earn_per_minor = net minor units per
 *  point (1000 = 1 point per ₹10 / A$10); point_value_minor = what a point is worth at redemption. Core's own read:
 *  a shopper cannot read business_policy (0014 customer_scope), so the role is cleared for it. No policy → null. */
export async function loyaltyPolicy(tx: Queryable, outletId: string, on: string): Promise<{ earn_per_minor: number; point_value_minor: number } | null> {
  const r = await asSystem(tx, async () => (await tx.query<{ earn: string; value: string }>(
    `SELECT loyalty_earn_per_minor AS earn, loyalty_point_value_minor AS value FROM core.business_policy
      WHERE (outlet_id = $1 OR outlet_id IS NULL) AND valid_from <= $2::date AND (valid_to IS NULL OR valid_to > $2::date)
      ORDER BY outlet_id NULLS LAST, valid_from DESC, created_at DESC, id DESC LIMIT 1`, [outletId, on])).rows[0]);
  return r ? { earn_per_minor: Number(r.earn), point_value_minor: Number(r.value) } : null;
}

/** The per-customer row lock, taken first so the existence checks below cannot race. */
async function lockCustomer(tx: Queryable, customerId: string): Promise<{ is_guest: boolean; erased: boolean } | null> {
  const r = await tx.query<{ is_guest: boolean; erased: boolean }>(
    `SELECT is_guest, erased_at IS NOT NULL AS erased FROM core.customer WHERE id = $1 FOR UPDATE`, [customerId]);
  return r.rows[0] ?? null;
}

async function insertEntry(tx: Queryable, e: { customer_id: string; kind: string; points: number; order_id: string; reverses_id: string | null; note: string | null }) {
  const id = uuidv7();
  // seq and balance_after are overwritten by the trigger (values supplied here are placeholders).
  await tx.query(
    `INSERT INTO core.loyalty_entry (tenant_id, id, customer_id, seq, kind, points, balance_after, order_id, reverses_id, note, created_by, origin)
     VALUES (current_setting('app.tenant_id')::uuid, $1, $2, 0, $3, $4, 0, $5, $6, $7,
             coalesce(nullif(current_setting('app.member_id', true), ''), nullif(current_setting('app.customer_id', true), ''))::uuid, '{}')`,
    [id, e.customer_id, e.kind, e.points, e.order_id, e.reverses_id, e.note]);
  return id;
}

/** Runs `fn` with the derivation context for `rule` over `core.order:<id>`, then restores whatever was set before,
 *  so the context cannot admit a later write in the caller's transaction. */
async function underRule<T>(tx: Queryable, rule: string, orderId: string, fn: () => Promise<T>): Promise<T> {
  const prev = (await tx.query<{ r: string | null; s: string | null }>(
    `SELECT current_setting('app.posting_rule', true) AS r, current_setting('app.source_ref', true) AS s`)).rows[0]!;
  await tx.query(`SELECT set_config('app.posting_rule', $1, true), set_config('app.source_ref', $2, true)`, [rule, `core.order:${orderId}`]);
  try {
    return await fn();
  } finally {
    await tx.query(`SELECT set_config('app.posting_rule', $1, true), set_config('app.source_ref', $2, true)`, [prev.r ?? "", prev.s ?? ""]);
  }
}

/** The balance shown: the latest entry's own `balance_after` (0 with no entries). */
export async function loyaltyBalance(tx: Queryable, customerId: string): Promise<{ balance: number; entry_id: string | null }> {
  const r = await tx.query<{ id: string; balance_after: string }>(
    `SELECT id, balance_after::text FROM core.loyalty_entry WHERE customer_id = $1 ORDER BY seq DESC LIMIT 1`, [customerId]);
  return r.rows[0] ? { balance: Number(r.rows[0].balance_after), entry_id: r.rows[0].id } : { balance: 0, entry_id: null };
}

/** Redeem `points` against `orderId` (the order's own customer; never an argument). One redemption per order.
 *  Insufficient balance → the database raises MB011 and the caller's transaction is refused. `value_minor` = points ×
 *  the policy's point value (no policy in force → refused). */
export async function loyaltyRedeem(tx: Queryable, orderId: string, points: number): Promise<LoyaltyWrite & { value_minor: number }> {
  if (!Number.isSafeInteger(points) || points <= 0) throw new ApiError("invalid_payload");
  const order = await orderOf(tx, orderId);
  if (!order.customer_id) throw new ApiError("loyalty_refused"); // points belong to a customer; a walk-in has none
  const policy = await loyaltyPolicy(tx, order.outlet_id, order.business_date);
  if (!policy) throw new ApiError("loyalty_refused");
  if (!(await lockCustomer(tx, order.customer_id))) throw new ApiError("loyalty_refused");
  const dup = await tx.query(`SELECT 1 FROM core.loyalty_entry WHERE order_id = $1 AND kind = 'redeem'`, [orderId]);
  if (dup.rows[0]) throw new ApiError("conflict");
  const entry_id = await insertEntry(tx, { customer_id: order.customer_id, kind: "redeem", points: -points, order_id: orderId, reverses_id: null, note: null });
  return { entry_id, points: -points, value_minor: points * policy.point_value_minor };
}

/** Earn on a completed order: floor(net / the policy's earn_per_minor) points. A no-op (null) for an order that is
 *  not completed, has no customer, a guest (no account → "Create an account to earn points", INFERENCE), an erased
 *  profile, no policy in force, 0 points, or that already earned. */
export async function loyaltyEarnFor(tx: Queryable, orderId: string): Promise<LoyaltyWrite | null> {
  return asSystem(tx, async () => {
    const order = await orderOf(tx, orderId);
    if (order.status !== "completed" || !order.customer_id) return null;
    const cust = await lockCustomer(tx, order.customer_id);
    if (!cust || cust.is_guest || cust.erased) return null;
    const policy = await loyaltyPolicy(tx, order.outlet_id, order.business_date);
    if (!policy) return null;
    const points = Math.floor(Number(order.net_minor) / policy.earn_per_minor);
    if (points <= 0) return null;
    const dup = await tx.query(`SELECT 1 FROM core.loyalty_entry WHERE order_id = $1 AND kind = 'earn'`, [orderId]);
    if (dup.rows[0]) return null;
    const entry_id = await underRule(tx, "customers.loyalty_earn", orderId, () =>
      insertEntry(tx, { customer_id: order.customer_id!, kind: "earn", points, order_id: orderId, reverses_id: null, note: null }));
    return { entry_id, points };
  });
}

/** Reverse every not-yet-reversed redeem/earn entry of a cancelled or rejected order, newest first. A redeem is
 *  given back in full; an earn is taken back up to what the customer still holds (never below zero — the part
 *  already spent stays spent, noted on the row). One reversal per entry (database unique). */
export async function loyaltyReverseFor(tx: Queryable, orderId: string): Promise<LoyaltyWrite[]> {
  return asSystem(tx, async () => {
    const order = await orderOf(tx, orderId);
    if (!["cancelled", "rejected"].includes(order.status) || !order.customer_id) return [];
    if (!(await lockCustomer(tx, order.customer_id))) return [];
    const open = await tx.query<{ id: string; kind: string; points: string }>(
      `SELECT e.id, e.kind, e.points::text FROM core.loyalty_entry e
        WHERE e.order_id = $1 AND e.kind IN ('earn', 'redeem')
          AND NOT EXISTS (SELECT 1 FROM core.loyalty_entry r WHERE r.reverses_id = e.id)
        ORDER BY e.seq DESC`, [orderId]);
    const out: LoyaltyWrite[] = [];
    for (const e of open.rows) {
      let points = -Number(e.points);
      let note: string | null = null;
      if (e.kind === "earn") {
        const held = (await loyaltyBalance(tx, order.customer_id)).balance;
        if (held < -points) {
          points = -held;
          note = "partial: points already spent";
        }
        if (points === 0) continue;
      }
      const entry_id = await underRule(tx, "customers.loyalty_reverse", orderId, () =>
        insertEntry(tx, { customer_id: order.customer_id!, kind: "reverse", points, order_id: orderId, reverses_id: e.id, note }));
      out.push({ entry_id, points });
    }
    return out;
  });
}
