// Order reads: the order with its lines and tenders (row fields; paid/remaining computed by core in the same
// read, R40 C1), and the receipt per the country pack. The receipt is re-derived by core-domain buildReceipt
// from the stored lines and snapshot; its totals must equal the stored order row or nothing is printed.
import { buildReceipt, type SaleLine } from "@munim/core-domain/packs";
import { ApiError } from "../../lib/errors.ts";
import type { Queryable } from "../../runtoken/index.ts";
import { orderMoney, remaining } from "./money.ts";
import { loadChannel, loadOutlet, loadPack } from "./pricing.ts";

const iso = (d: Date | null) => (d === null ? null : d.toISOString());

export async function orderView(c: Queryable, orderId: string) {
  const r = await c.query<Record<string, any>>(
    `SELECT id, outlet_id, channel_id, device_id, kind, table_ref, status, business_date::text AS business_date, ticket_no, invoice_fy, invoice_no,
            promised_at, pickup_window_id, subtotal_minor, discount_minor, tax_minor, total_minor, currency, created_at
       FROM core."order" WHERE id = $1`, [orderId]);
  const o = r.rows[0];
  if (!o) throw new ApiError("not_found");
  const m = await orderMoney(c, orderId, false);
  const lines = await c.query<Record<string, any>>(
    `SELECT id, line_no, item_id, variant_id, options, qty_milli, unit_price_minor, line_discount_minor, tax_minor
       FROM core.order_line WHERE order_id = $1 ORDER BY line_no`, [orderId]);
  const tenders = await c.query<Record<string, any>>(
    `SELECT id, order_id, method, amount_minor, tendered_minor, change_minor, rounding_minor, currency, ref, recorded_by, at
       FROM core.tender WHERE order_id = $1 ORDER BY at, id`, [orderId]);
  return {
    order_id: o.id, outlet_id: o.outlet_id, channel_id: o.channel_id, device_id: o.device_id, kind: o.kind, table_ref: o.table_ref,
    status: o.status, business_date: o.business_date, ticket_no: o.ticket_no, invoice_fy: o.invoice_fy,
    invoice_no: o.invoice_no === null ? null : Number(o.invoice_no), promised_at: iso(o.promised_at), pickup_window_id: o.pickup_window_id,
    subtotal_minor: Number(o.subtotal_minor), discount_minor: Number(o.discount_minor), tax_minor: Number(o.tax_minor), total_minor: Number(o.total_minor),
    loyalty_minor: m.loyalty_minor, paid_minor: m.paid_minor, remaining_minor: remaining(m), currency: o.currency,
    lines: lines.rows.map((l) => ({
      line_id: l.id, line_no: l.line_no, item_id: l.item_id, variant_id: l.variant_id, option_ids: l.options, qty_milli: Number(l.qty_milli),
      unit_price_minor: Number(l.unit_price_minor), line_discount_minor: Number(l.line_discount_minor), tax_minor: Number(l.tax_minor),
    })),
    tenders: tenders.rows.map((t) => {
      const cash = t.method === "cash";
      return {
        tender_id: t.id, order_id: t.order_id, method: t.method, amount_minor: Number(t.amount_minor),
        tendered_minor: cash ? Number(t.tendered_minor) : null, change_minor: cash ? Number(t.change_minor) : null,
        rounding_minor: cash ? Number(t.rounding_minor) : null, currency: t.currency, ref: t.ref, recorded_by: t.recorded_by, at: t.at.toISOString(),
      };
    }),
    created_at: o.created_at.toISOString(),
  };
}

type Snap = {
  lines: Array<{ line_no: number; tax_class: string }>;
  picks?: Array<{ line_no: number; mrp_minor: number | null }>;
  repriced?: { lines: Array<{ line_no: number; tax_class?: string }> };
};

/** The receipt. Refusal `tax_id_missing` (a required seller tax id is absent / malformed) → 409, so the POS
 *  shows its settings banner; the sale itself is unaffected. */
export async function receiptView(c: Queryable, orderId: string) {
  const r = await c.query<Record<string, any>>(
    `SELECT o.id, o.outlet_id, o.channel_id, o.ticket_no, o.invoice_no, o.external_ref, o.created_at, o.total_minor, o.tax_minor, o.pricing_snapshot,
            d.invoice_series
       FROM core."order" o LEFT JOIN core.device d ON d.tenant_id = o.tenant_id AND d.id = o.device_id WHERE o.id = $1`, [orderId]);
  const o = r.rows[0];
  if (!o) throw new ApiError("not_found");
  const snap = o.pricing_snapshot as Snap;
  const [pack, outlet, channel] = [await loadPack(c), await loadOutlet(c, o.outlet_id), await loadChannel(c, o.channel_id)];
  const lines = (await c.query<Record<string, any>>(
    `SELECT l.line_no, l.item_id, l.qty_milli, l.unit_price_minor, l.line_discount_minor, i.name_key
       FROM core.order_line l JOIN core.item i ON i.tenant_id = l.tenant_id AND i.id = l.item_id WHERE l.order_id = $1 ORDER BY l.line_no`, [orderId])).rows;
  const sale: SaleLine[] = lines.map((l) => {
    // The latest judgement's tax class (a re-price may land on a price row of another class); the line row
    // carries the money as re-priced (0015 A8).
    // (Re-prices written before f-1 carry no tax_class: the placed line's stands.)
    const s = snap.lines.find((x) => x.line_no === l.line_no);
    const cls = snap.repriced?.lines.find((x) => x.line_no === l.line_no)?.tax_class ?? s?.tax_class;
    const pick = snap.picks?.find((x) => x.line_no === l.line_no && x.mrp_minor !== null);
    if (!s || !cls) throw new ApiError("internal");
    return {
      name: l.name_key, qty_milli: Number(l.qty_milli), unit_price_minor: Number(l.unit_price_minor),
      line_discount_minor: Number(l.line_discount_minor), tax_class: cls, mrp_minor: null,
      batch: pick ? { mrp_minor: pick.mrp_minor } : null,
    };
  });
  const number = o.invoice_no !== null ? `${o.invoice_series}-${o.invoice_no}` : (o.external_ref ?? String(o.ticket_no));
  const built = buildReceipt(pack.doc, {
    seller: { name: outlet.name, address: outlet.address, tax_ids: outlet.tax_ids }, invoice_no: number, issued_at: o.created_at.toISOString(),
    tz: outlet.tz, channel_kind: channel.kind, buyer: null, lines: sale,
  });
  if (!built.ok) throw new ApiError("conflict", built.refusal.reason_code);
  const t = built.receipt.tax;
  if (t.total_minor !== Number(o.total_minor) || t.tax_minor !== Number(o.tax_minor)) throw new ApiError("internal");
  return {
    order_id: o.id, kind: built.receipt.kind, title: built.receipt.title, operator: built.receipt.operator, seller: built.receipt.seller,
    tax_ids: built.receipt.tax_ids, number, date: built.receipt.invoice_date, currency: t.currency,
    lines: t.lines.map((l, i) => ({
      line_no: l.line_no, item_id: lines[i]!.item_id, name_key: l.name, qty_milli: l.qty_milli, unit_price_minor: l.unit_price_minor,
      amount_minor: l.amount_minor, discount_minor: l.discount_minor, net_minor: l.net_minor, tax_minor: l.tax_minor, total_minor: l.total_minor,
      tax_class: l.tax_class, components: l.components,
    })),
    net_minor: t.net_minor, tax_minor: t.tax_minor, total_minor: t.total_minor, components: t.components,
  };
}

/** One drawer shift's own row fields (verify reads the float and counted cash from here, not from a key). */
export async function shiftView(c: Queryable, shiftId: string) {
  const r = await c.query<Record<string, any>>(
    `SELECT id, outlet_id, device_id, status, opened_by, opened_at, float_minor, currency, closed_by, closed_at,
            counted_cash_minor, expected_cash_minor, variance_minor
       FROM core.shift WHERE id = $1`, [shiftId]);
  const s = r.rows[0];
  if (!s) throw new ApiError("not_found");
  const num = (v: string | null) => (v === null ? null : Number(v));
  return {
    shift_id: s.id, outlet_id: s.outlet_id, device_id: s.device_id, status: s.status, opened_by: s.opened_by, opened_at: s.opened_at.toISOString(),
    float_minor: Number(s.float_minor), currency: s.currency, closed_by: s.closed_by, closed_at: iso(s.closed_at),
    counted_cash_minor: num(s.counted_cash_minor), expected_cash_minor: num(s.expected_cash_minor), variance_minor: num(s.variance_minor),
  };
}
