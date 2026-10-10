// Account reads. Every query runs on a client already under the customer's own context (contextOf: app.role =
// customer, app.customer_id = the principal, the storefront's tenant): RLS (0014 customer_scope) admits only
// this customer's rows at this merchant, and each query also names the customer explicitly. Every number
// returned is a row's own field — no sums, no counts (One Guarantee clause 2; the loyalty balance is the latest
// entry's balance_after, R40). Staff ids (created_by, recorded_by, actor, applied_by) and token hashes are
// never selected.
import type { Queryable } from "../../runtoken/index.ts";

const iso = (d: Date | null): string | null => (d === null ? null : d.toISOString());
const num = (v: string | number | null): number | null => (v === null ? null : Number(v));

interface ProfileRow {
  id: string; name: string | null; phone: string | null; email: string | null; email_verified_at: Date | null;
  consent: Record<string, unknown>; is_guest: boolean; created_at: Date;
}

function consentOf(c: Record<string, unknown>): { marketing: boolean; at: string } | null {
  return typeof c.marketing === "boolean" && typeof c.at === "string" ? { marketing: c.marketing, at: c.at } : null;
}

export async function profileOf(db: Queryable, customerId: string) {
  const r = (await db.query<ProfileRow>(
    `SELECT id, name, phone, email, email_verified_at, consent, is_guest, created_at
       FROM core.customer WHERE id = $1 AND erased_at IS NULL`, [customerId])).rows[0];
  if (!r) return null;
  return {
    customer_id: r.id, name: r.name, phone: r.phone, email: r.email, email_verified_at: iso(r.email_verified_at),
    consent: consentOf(r.consent), is_guest: r.is_guest, created_at: r.created_at.toISOString(),
  };
}

const ORDER_COLS = `o.id, o.outlet_id, o.channel_id, o.kind, o.status, o.business_date::text AS business_date, o.ticket_no,
  o.subtotal_minor, o.discount_minor, o.tax_minor, o.total_minor, o.currency, o.created_at`;

interface OrderRow {
  id: string; outlet_id: string; channel_id: string; kind: string; status: string; business_date: string; ticket_no: number;
  subtotal_minor: string; discount_minor: string; tax_minor: string; total_minor: string; currency: string; created_at: Date;
}

const orderView = (r: OrderRow) => ({
  order_id: r.id, outlet_id: r.outlet_id, channel_id: r.channel_id, kind: r.kind, status: r.status, business_date: r.business_date,
  ticket_no: r.ticket_no, subtotal_minor: Number(r.subtotal_minor), discount_minor: Number(r.discount_minor),
  tax_minor: Number(r.tax_minor), total_minor: Number(r.total_minor), currency: r.currency, created_at: r.created_at.toISOString(),
});

interface LineRow {
  id: string; order_id: string; line_no: number; item_id: string; item_name_key: string; variant_id: string | null; qty_milli: string;
  unit_price_minor: string; line_discount_minor: string; tax_minor: string;
}

const lineView = (l: LineRow) => ({
  line_id: l.id, line_no: l.line_no, item_id: l.item_id, item_name_key: l.item_name_key, variant_id: l.variant_id, qty_milli: Number(l.qty_milli),
  unit_price_minor: Number(l.unit_price_minor), line_discount_minor: Number(l.line_discount_minor), tax_minor: Number(l.tax_minor),
});

const LINES_SQL = `SELECT l.id, l.order_id, l.line_no, l.item_id, i.name_key AS item_name_key, l.variant_id, l.qty_milli, l.unit_price_minor,
         l.line_discount_minor, l.tax_minor
    FROM core.order_line l
    JOIN core."order" o ON o.tenant_id = l.tenant_id AND o.id = l.order_id
    JOIN core.item i ON i.tenant_id = l.tenant_id AND i.id = l.item_id`;

export async function ordersOf(db: Queryable, customerId: string, limit: number, cursor: string | null) {
  const rows = (await db.query<OrderRow>(
    `SELECT ${ORDER_COLS} FROM core."order" o
      WHERE o.customer_id = $1 AND ($2::uuid IS NULL OR o.id < $2::uuid)
      ORDER BY o.id DESC LIMIT $3`, [customerId, cursor, limit + 1])).rows;
  const page = rows.slice(0, limit);
  return { orders: page.map(orderView), next_cursor: rows.length > limit ? page.at(-1)!.id : null };
}

export async function orderOf(db: Queryable, customerId: string, orderId: string) {
  const o = (await db.query<OrderRow>(`SELECT ${ORDER_COLS} FROM core."order" o WHERE o.id = $1 AND o.customer_id = $2`,
    [orderId, customerId])).rows[0];
  if (!o) return null;
  const lines = (await db.query<LineRow>(`${LINES_SQL} WHERE o.id = $1 AND o.customer_id = $2 ORDER BY l.line_no`, [orderId, customerId])).rows;
  return { order: orderView(o), lines: lines.map(lineView) };
}

interface EntryRow {
  id: string; seq: string; kind: string; points: string; balance_after: string; order_id: string | null; note: string | null; created_at: Date;
}

export async function loyaltyOf(db: Queryable, customerId: string) {
  const rows = (await db.query<EntryRow>(
    `SELECT id, seq, kind, points, balance_after, order_id, note, created_at
       FROM core.loyalty_entry WHERE customer_id = $1 ORDER BY seq DESC`, [customerId])).rows;
  const entries = rows.map((e) => ({
    entry_id: e.id, seq: Number(e.seq), kind: e.kind, points: Number(e.points), balance_after: Number(e.balance_after),
    order_id: e.order_id, note: e.note, created_at: e.created_at.toISOString(),
  }));
  const latest = entries[0];
  return { balance: latest ? { points: latest.balance_after, entry_id: latest.entry_id, seq: latest.seq } : null, entries };
}

/** customers.data.export.v1: everything this customer owns at this merchant. */
export async function exportOf(db: Queryable, tenantId: string, customerId: string) {
  const profile = await profileOf(db, customerId);
  if (!profile) return null;
  const orders = (await db.query<OrderRow>(`SELECT ${ORDER_COLS} FROM core."order" o WHERE o.customer_id = $1 ORDER BY o.id`, [customerId])).rows;
  const lines = (await db.query<LineRow>(`${LINES_SQL} WHERE o.customer_id = $1 ORDER BY l.order_id, l.line_no`, [customerId])).rows;
  const loyalty = await loyaltyOf(db, customerId);
  const reservations = (await db.query<{
    id: string; outlet_id: string; name: string; phone: string | null; party_size: number; starts_at: Date; status: string; note: string | null; created_at: Date;
  }>(`SELECT id, outlet_id, name, phone, party_size, starts_at, status, note, created_at
        FROM core.reservation WHERE customer_id = $1 ORDER BY id`, [customerId])).rows;
  const bulk = (await db.query<{
    id: string; outlet_id: string; contact_name: string; contact_phone: string | null; deliver_at: Date; headcount: number | null; status: string;
    quote_minor: string | null; advance_minor: string | null; currency: string | null; order_id: string | null; note: string | null; created_at: Date;
  }>(`SELECT id, outlet_id, contact_name, contact_phone, deliver_at, headcount, status, quote_minor, advance_minor, currency, order_id, note, created_at
        FROM core.bulk_order WHERE customer_id = $1 ORDER BY id`, [customerId])).rows;
  // The order's other rows: RLS (customer_scope) already limits them to this customer's orders; the join says so too.
  const mine = `FROM core."order" o JOIN core.%T x ON x.tenant_id = o.tenant_id AND x.order_id = o.id WHERE o.customer_id = $1 ORDER BY x.id`;
  const rows = async <R>(cols: string, table: string) => (await db.query<R & { id: string }>(`SELECT ${cols} ${mine.replace("%T", table)}`, [customerId])).rows;
  const events = await rows<{ order_id: string; kind: "status" | "promised_at"; from_status: string | null; to_status: string | null; from_promised_at: Date | null; to_promised_at: Date | null; reason: string | null; at: Date }>(
    "x.id, x.order_id, x.kind, x.from_status, x.to_status, x.from_promised_at, x.to_promised_at, x.reason, x.at", "order_event");
  const tenders = await rows<{ order_id: string; method: string; amount_minor: string; tendered_minor: string | null; change_minor: string | null; currency: string; ref: string | null; at: Date }>(
    "x.id, x.order_id, x.method, x.amount_minor, x.tendered_minor, x.change_minor, x.currency, x.ref, x.at", "tender");
  const refunds = await rows<{ order_id: string; tender_id: string | null; method: string; amount_minor: string; currency: string; reason_code: string; note: string; at: Date }>(
    "x.id, x.order_id, x.tender_id, x.method, x.amount_minor, x.currency, x.reason_code, x.note, x.at", "refund");
  const uses = await rows<{ order_id: string; coupon_id: string; discount_minor: string; currency: string; at: Date }>(
    "x.id, x.order_id, x.coupon_id, x.discount_minor, x.currency, x.at", "coupon_use");
  const voids = await rows<{ order_id: string; order_line_id: string | null; reason_code: string; note: string; amount_minor: string; currency: string; at: Date }>(
    "x.id, x.order_id, x.order_line_id, x.reason_code, x.note, x.amount_minor, x.currency, x.at", "void");
  const returns = await rows<{ order_id: string; order_line_id: string; qty_milli: string; restock: boolean; reason_code: string; note: string; at: Date }>(
    "x.id, x.order_id, x.order_line_id, x.qty_milli, x.restock, x.reason_code, x.note, x.at", "sale_return");
  return {
    format: "munim.customer-export.v1" as const,
    generated_at: new Date().toISOString(),
    tenant_id: tenantId,
    profile,
    orders: orders.map((o) => ({ order: orderView(o), lines: lines.filter((l) => l.order_id === o.id).map(lineView) })),
    loyalty_entries: [...loyalty.entries].reverse(),
    reservations: reservations.map((r) => ({
      reservation_id: r.id, outlet_id: r.outlet_id, name: r.name, phone: r.phone, party_size: r.party_size, starts_at: r.starts_at.toISOString(),
      status: r.status, note: r.note, created_at: r.created_at.toISOString(),
    })),
    bulk_orders: bulk.map((b) => ({
      bulk_order_id: b.id, outlet_id: b.outlet_id, contact_name: b.contact_name, contact_phone: b.contact_phone, deliver_at: b.deliver_at.toISOString(),
      headcount: b.headcount, status: b.status, quote_minor: num(b.quote_minor), advance_minor: num(b.advance_minor), currency: b.currency,
      order_id: b.order_id, note: b.note, created_at: b.created_at.toISOString(),
    })),
    order_events: events.map((e) => ({
      order_event_id: e.id, order_id: e.order_id, kind: e.kind, from_status: e.from_status, to_status: e.to_status,
      from_promised_at: iso(e.from_promised_at), to_promised_at: iso(e.to_promised_at), reason: e.reason, at: e.at.toISOString(),
    })),
    tenders: tenders.map((t) => ({
      tender_id: t.id, order_id: t.order_id, method: t.method, amount_minor: Number(t.amount_minor), tendered_minor: num(t.tendered_minor),
      change_minor: num(t.change_minor), currency: t.currency, ref: t.ref, at: t.at.toISOString(),
    })),
    refunds: refunds.map((r) => ({
      refund_id: r.id, order_id: r.order_id, tender_id: r.tender_id, method: r.method, amount_minor: Number(r.amount_minor), currency: r.currency,
      reason_code: r.reason_code, note: r.note, at: r.at.toISOString(),
    })),
    coupon_uses: uses.map((u) => ({ coupon_use_id: u.id, coupon_id: u.coupon_id, order_id: u.order_id, discount_minor: Number(u.discount_minor), currency: u.currency, at: u.at.toISOString() })),
    voids: voids.map((v) => ({
      void_id: v.id, order_id: v.order_id, order_line_id: v.order_line_id, reason_code: v.reason_code, note: v.note, amount_minor: Number(v.amount_minor),
      currency: v.currency, at: v.at.toISOString(),
    })),
    sale_returns: returns.map((r) => ({
      sale_return_id: r.id, order_id: r.order_id, order_line_id: r.order_line_id, qty_milli: Number(r.qty_milli), restock: r.restock,
      reason_code: r.reason_code, note: r.note, at: r.at.toISOString(),
    })),
  };
}
