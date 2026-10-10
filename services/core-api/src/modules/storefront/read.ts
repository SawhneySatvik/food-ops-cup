// Public reads under the shopper's own context (customer_scope: catalogue / outlet / calendar / pickup windows are
// public to a storefront key; nothing else is). Every value returned is a row's own field (R26).
import type { Accepting, CalendarRow } from "./state.ts";
import { effectiveState, openByCalendar } from "./state.ts";
import { ApiError } from "../../lib/errors.ts";
import type { Queryable } from "../../runtoken/index.ts";
import { now, seam, type SaleEntry } from "./config.ts";

export interface OutletRow {
  id: string;
  name: string;
  kind: "restaurant" | "cloud_kitchen" | "store";
  tz: string;
  address: string;
  accepting_orders: Accepting;
  busy_extra_min: number;
  default_prep_min: number;
  cancel_window_min: number;
  reschedule_window_min: number;
}

/** The shopper channels a storefront key may sit on (never `counter` or an aggregator). */
const STOREFRONT_KINDS = ["table_qr", "pickup", "own_site"] as const;
export type StorefrontKind = (typeof STOREFRONT_KINDS)[number];

/** The key's channel → its kind. A key on any other channel kind is no storefront: 404 (gotcha 16). */
export async function channelKind(c: Queryable, channel_id: string): Promise<StorefrontKind> {
  const r = await c.query<{ kind: string; active: boolean }>(`SELECT kind, active FROM core.channel WHERE id = $1`, [channel_id]);
  const row = r.rows[0];
  if (!row || !row.active || !(STOREFRONT_KINDS as readonly string[]).includes(row.kind)) throw new ApiError("not_found");
  return row.kind as StorefrontKind;
}

const OUTLET_COLS = `id, name, kind, tz, address, accepting_orders, busy_extra_min, default_prep_min, cancel_window_min, reschedule_window_min`;

export async function outletRow(c: Queryable, outlet_id: string): Promise<OutletRow> {
  const r = await c.query<OutletRow>(`SELECT ${OUTLET_COLS} FROM core.outlet WHERE id = $1`, [outlet_id]);
  if (!r.rows[0]) throw new ApiError("not_found");
  return r.rows[0];
}

export async function outlets(c: Queryable) {
  const r = await c.query<OutletRow>(`SELECT ${OUTLET_COLS} FROM core.outlet ORDER BY name, id`);
  return { outlets: r.rows.map((o) => ({ outlet_id: o.id, name: o.name, kind: o.kind, tz: o.tz, address: o.address })) };
}

export async function calendarOf(c: Queryable, outlet_id: string): Promise<CalendarRow[]> {
  const r = await c.query<{ kind: "weekly" | "override"; weekday: number | null; on_date: string | null; opens_at: string | null; closes_at: string | null; closed: boolean }>(
    `SELECT kind, weekday, to_char(on_date, 'YYYY-MM-DD') AS on_date, opens_at::text AS opens_at, closes_at::text AS closes_at, closed
       FROM core.outlet_calendar WHERE outlet_id = $1`, [outlet_id]);
  return r.rows;
}

export async function accepting(c: Queryable, outlet: OutletRow, at: Date = now()) {
  const eff = effectiveState({ accepting_orders: outlet.accepting_orders, calendar: await calendarOf(c, outlet.id), tz: outlet.tz, at });
  return {
    outlet_id: outlet.id,
    state: eff.state,
    busy_extra_min: outlet.busy_extra_min,
    default_prep_min: outlet.default_prep_min,
    next_open: eff.next_open ? eff.next_open.toISOString() : null,
    tz: outlet.tz,
    as_of: at.toISOString(),
  };
}

export async function menu(c: Queryable, outlet: OutletRow, kind: StorefrontKind) {
  const at = now();
  const entries = await seam("itemsForSale")(c, outlet.id, kind);
  const byItem = new Map<string, SaleEntry[]>();
  for (const e of entries) byItem.set(e.item_id, [...(byItem.get(e.item_id) ?? []), e]);
  const items = [...byItem.values()].map((es) => {
    const base = es[0]!;
    const variants = es.filter((e) => e.variant_id !== null);
    return {
      item_id: base.item_id, name_key: base.name_key, category: base.category, kind: base.kind,
      available: es.some((e) => e.available), price_minor: variants.length ? null : base.price_minor, currency: base.currency,
      variants: variants.map((e) => ({ variant_id: e.variant_id!, name_key: e.variant_name_key!, available: e.available, price_minor: e.price_minor })),
      option_groups: base.option_groups,
    };
  });
  const deals = await c.query<{ deal_id: string; name_key: string; kind: string; windows: unknown[]; valid_from: string; valid_to: string | null }>(
    `SELECT id AS deal_id, name_key, kind, windows, to_char(valid_from, 'YYYY-MM-DD') AS valid_from, to_char(valid_to, 'YYYY-MM-DD') AS valid_to
       FROM core.deal
      WHERE active AND (outlet_ids = '{}' OR $1::uuid = ANY (outlet_ids))
        AND valid_from <= ($2::timestamptz AT TIME ZONE $3)::date AND (valid_to IS NULL OR valid_to > ($2::timestamptz AT TIME ZONE $3)::date)
      ORDER BY name_key, id`, [outlet.id, at.toISOString(), outlet.tz]);
  return {
    outlet_id: outlet.id,
    channel_kind: kind,
    accepting: await accepting(c, outlet, at),
    items,
    deals: deals.rows,
    pay_at_counter: true as const,
  };
}

export async function pickupWindows(c: Queryable, outlet: OutletRow) {
  const r = await c.query<{ pickup_window_id: string; starts_at: Date; ends_at: Date; capacity_orders: number; booked: number }>(
    `SELECT id AS pickup_window_id, starts_at, ends_at, capacity_orders, booked FROM core.pickup_window
      WHERE outlet_id = $1 AND ends_at > $2 AND booked < capacity_orders ORDER BY starts_at`, [outlet.id, now().toISOString()]);
  return {
    outlet_id: outlet.id,
    windows: r.rows.map((w) => ({ ...w, starts_at: w.starts_at.toISOString(), ends_at: w.ends_at.toISOString() })),
  };
}

export interface Refusal {
  line_no: number | null;
  reason_code: "outlet_paused" | "window_full" | "item_sold_out";
}

/** The storefront's own refusals, judged from rows it can read: the live toggle and calendar at the promised
 *  time, the window's spare capacity, and per-outlet sold-out. Placement (T-022) re-checks capacity, sold-out,
 *  deals and coupons under its own lock; these run first so the person gets the code before anything is written. */
export async function ownRefusals(
  c: Queryable,
  o: { outlet: OutletRow; pickup_window_id: string | null; promised_at: string | null; lines: ReadonlyArray<{ item_id: string; variant_id: string | null }> },
): Promise<Refusal[]> {
  const out: Refusal[] = [];
  const at = o.promised_at ? new Date(o.promised_at) : now();
  const calendar = await calendarOf(c, o.outlet.id);
  // Paused is the live toggle (now); closed is the calendar at the time the order is for.
  if (o.outlet.accepting_orders === "paused" || !openByCalendar(calendar, o.outlet.tz, at) || !openByCalendar(calendar, o.outlet.tz, now())) {
    out.push({ line_no: null, reason_code: "outlet_paused" });
  }
  if (o.pickup_window_id !== null) {
    const w = await c.query<{ booked: number; capacity_orders: number; ends_at: Date }>(
      `SELECT booked, capacity_orders, ends_at FROM core.pickup_window WHERE id = $1 AND outlet_id = $2`, [o.pickup_window_id, o.outlet.id]);
    const win = w.rows[0];
    if (!win) throw new ApiError("invalid_payload");
    if (win.booked >= win.capacity_orders || win.ends_at.getTime() <= now().getTime()) out.push({ line_no: null, reason_code: "window_full" });
  }
  const off = await c.query<{ item_id: string; variant_id: string | null }>(
    `SELECT item_id, variant_id FROM core.item_availability WHERE outlet_id = $1 AND NOT available`, [o.outlet.id]);
  o.lines.forEach((l, i) => {
    if (off.rows.some((a) => a.item_id === l.item_id && (a.variant_id === null || a.variant_id === l.variant_id)))
      out.push({ line_no: i + 1, reason_code: "item_sold_out" });
  });
  return out;
}
