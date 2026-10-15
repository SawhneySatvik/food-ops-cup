// Public reads under the shopper's own context (customer_scope: catalogue / outlet / calendar / pickup windows are
// public to a storefront key; nothing else is). Every value returned is a row's own field (R26).
import { DealWindow } from "@munim/contracts/catalogue";
import { TenderMethod } from "@munim/contracts/orders";
import { CountryPack } from "@munim/contracts/packs";
import { tenantPack } from "../catalogue/index.ts";
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
  phone: string | null;
  tax_ids: Record<string, string>;
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

const OUTLET_COLS = `id, name, kind, tz, address, accepting_orders, busy_extra_min, default_prep_min, cancel_window_min, reschedule_window_min, phone, tax_ids`;

export async function outletRow(c: Queryable, outlet_id: string): Promise<OutletRow> {
  const r = await c.query<OutletRow>(`SELECT ${OUTLET_COLS} FROM core.outlet WHERE id = $1`, [outlet_id]);
  if (!r.rows[0]) throw new ApiError("not_found");
  return r.rows[0];
}

/** `core.order.pricing_snapshot.pack`: the pack version that priced an order. */
export type PackRef = { code?: unknown; version?: unknown } | null;

/** The pack version that priced an order (its snapshot). Null — "cannot verify" — when the order names none or that
 *  version's row is missing or does not parse: never the tenant's current pack, which may not be the one that priced it. */
export async function pricedPack(c: Queryable, ref: PackRef): Promise<CountryPack | null> {
  if (!ref || typeof ref.code !== "string" || typeof ref.version !== "number") return null;
  const r = await c.query<{ doc: unknown }>(`SELECT doc FROM platform.country_pack WHERE code = $1 AND version = $2`, [ref.code, ref.version]);
  const p = CountryPack.safeParse(r.rows[0]?.doc);
  return p.success ? p.data : null;
}

/** The pay-at-counter methods the tenant's active pack lists (`pay_at_counter_methods`, G-13), else null. Read from the
 *  pack document of the newest active version (the key is optional in CountryPack: v1–v3 packs have none). */
async function payAtCounterMethods(c: Queryable): Promise<Array<ReturnType<typeof TenderMethod.parse>> | null> {
  const r = await c.query<{ m: unknown }>(
    `SELECT p.doc -> 'pay_at_counter_methods' AS m FROM core.tenant t JOIN platform.country_pack p ON p.code = t.country_code AND p.status = 'active'
      WHERE t.tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid ORDER BY p.version DESC LIMIT 1`);
  const m = TenderMethod.array().min(1).safeParse(r.rows[0]?.m);
  return m.success ? m.data : null;
}

/** The outlet's tax ids the pack prints on every receipt (G-04: public by the pack's own rule, `on_receipt`), in pack order. */
const publicTaxIds = (pack: CountryPack, o: OutletRow) =>
  pack.tax_ids.filter((t) => t.on_receipt && typeof o.tax_ids[t.code] === "string").map((t) => ({ code: t.code, label: t.label, value: o.tax_ids[t.code]! }));

/** Outlets in the order the owner opened them (T-115: no command carries an outlet position), then by name. */
export async function outlets(c: Queryable) {
  const r = await c.query<OutletRow>(`SELECT ${OUTLET_COLS} FROM core.outlet ORDER BY created_at, name, id`);
  const pack = await tenantPack(c);
  return {
    outlets: r.rows.map((o) => ({ outlet_id: o.id, name: o.name, kind: o.kind, tz: o.tz, address: o.address, phone: o.phone, tax_ids: publicTaxIds(pack, o) })),
    pay_at_counter_methods: await payAtCounterMethods(c),
  };
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

export async function menu(c: Queryable, outlet: OutletRow, kind: StorefrontKind, channel_id: string) {
  const at = now();
  const entries = await seam("itemsForSale")(c, outlet.id, kind, { at });
  const byItem = new Map<string, SaleEntry[]>();
  for (const e of entries) byItem.set(e.item_id, [...(byItem.get(e.item_id) ?? []), e]);
  const items = [...byItem.values()].map((es) => {
    const base = es[0]!;
    const variants = es.filter((e) => e.variant_id !== null);
    return {
      item_id: base.item_id, name_key: base.name_key, display_name: base.display_name, description: base.description, diet: base.diet,
      category: base.category, brand_id: base.brand_id, kind: base.kind,
      available: es.some((e) => e.available), price_minor: variants.length ? null : base.price_minor, currency: base.currency,
      variants: variants.map((e) => ({ variant_id: e.variant_id!, name_key: e.variant_name_key!, display_name: e.variant_display_name, description: e.variant_description,
        available: e.available, price_minor: e.price_minor })),
      option_groups: base.option_groups.map((g) => ({
        option_group_id: g.option_group_id, name_key: g.name_key, display_name: g.display_name, description: g.description,
        min_select: g.min_select, max_select: g.max_select, required: g.required,
        options: g.options.map((o) => ({ option_id: o.option_id, name_key: o.name_key, display_name: o.display_name, description: o.description, price_delta_minor: o.price_delta_minor })),
      })),
    };
  });
  const deals = await c.query<{ deal_id: string; name_key: string; kind: string; windows: unknown[]; valid_from: string; valid_to: string | null }>(
    `SELECT id AS deal_id, name_key, kind, windows, to_char(valid_from, 'YYYY-MM-DD') AS valid_from, to_char(valid_to, 'YYYY-MM-DD') AS valid_to
       FROM core.deal
      WHERE active AND (outlet_ids = '{}' OR $1::uuid = ANY (outlet_ids))
        AND valid_from <= ($2::timestamptz AT TIME ZONE $3)::date AND (valid_to IS NULL OR valid_to > ($2::timestamptz AT TIME ZONE $3)::date)
      ORDER BY name_key, id`, [outlet.id, at.toISOString(), outlet.tz]);
  const brands = await c.query<{ brand_id: string; name: string }>(
    `SELECT id AS brand_id, name FROM core.brand WHERE active AND $1::uuid = ANY (outlet_ids) ORDER BY name, id`, [outlet.id]);
  const pack = await tenantPack(c);
  return {
    outlet_id: outlet.id,
    channel_id,
    channel_kind: kind,
    brands: brands.rows,
    prices_include_tax: pack.tax.price_display === "inclusive",
    accepting: await accepting(c, outlet, at),
    items,
    // Only deals whose windows have the contract shape (catalogue prices no other deal).
    deals: deals.rows.filter((d) => DealWindow.array().safeParse(d.windows).success),
    pay_at_counter: true as const,
    pay_at_counter_methods: await payAtCounterMethods(c),
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
    const w = await c.query<{ booked: number; capacity_orders: number; starts_at: Date; ends_at: Date }>(
      `SELECT booked, capacity_orders, starts_at, ends_at FROM core.pickup_window WHERE id = $1 AND outlet_id = $2`, [o.pickup_window_id, o.outlet.id]);
    const win = w.rows[0];
    if (!win) throw new ApiError("invalid_payload");
    // G-12: a promise for a chosen window lies inside it, [starts_at, ends_at); null = the window's start (placement).
    const p = o.promised_at === null ? null : Date.parse(o.promised_at);
    if (p !== null && (p < win.starts_at.getTime() || p >= win.ends_at.getTime())) throw new ApiError("invalid_payload", "pickup_time_outside_window");
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
