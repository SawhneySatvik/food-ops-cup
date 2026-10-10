// Pricing a cart (preview, placement, push-back re-judge): core's one pricing function (catalogue priceLines)
// supplies each line's price/option/deal/coupon rows and tax; core-domain `orderTax` over those same lines gives
// the line and order totals. A line whose orderTax tax differs from priceLines' is a bug in one of them — refused
// as `internal`, never stored. Reads only; writes nothing.
import type { CountryPack } from "@munim/contracts/packs";
import { orderTax, type OrderTax, type SaleLine } from "@munim/core-domain/packs";
import { ApiError } from "../../lib/errors.ts";
import type { Queryable } from "../../runtoken/index.ts";
import { type PricedLine, type PriceLinesResult, type Refusal, seams } from "./seams.ts";

export type Outlet = {
  id: string;
  name: string;
  address: string;
  kind: "restaurant" | "cloud_kitchen" | "store";
  tz: string;
  /** HH:MM (pg renders `time` as HH:MM:SS; core-domain's cutoff takes HH:MM). */
  cutoff: string;
  accepting_orders: "open" | "busy" | "paused";
  tax_ids: Record<string, string>;
};
export type Channel = { id: string; kind: string; active: boolean };
export type PackRow = { doc: CountryPack; version: number };

export async function loadOutlet(c: Queryable, outletId: string): Promise<Outlet> {
  const r = await c.query<Outlet>(
    `SELECT id, name, address, kind, tz, to_char(business_day_cutoff, 'HH24:MI') AS cutoff, accepting_orders, tax_ids
       FROM core.outlet WHERE id = $1`, [outletId]);
  const o = r.rows[0];
  if (!o) throw new ApiError("not_found");
  return o;
}

export async function loadChannel(c: Queryable, channelId: string): Promise<Channel> {
  const r = await c.query<Channel>(`SELECT id, kind, active FROM core.channel WHERE id = $1`, [channelId]);
  const ch = r.rows[0];
  if (!ch) throw new ApiError("not_found");
  return ch;
}

/** The tenant's active country pack (latest active version) — every country difference comes from here (R21). */
export async function loadPack(c: Queryable): Promise<PackRow> {
  const r = await c.query<PackRow>(
    `SELECT p.doc, p.version FROM core.tenant t
       JOIN platform.country_pack p ON p.code = t.country_code AND p.status = 'active'
      WHERE t.tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid
      ORDER BY p.version DESC LIMIT 1`);
  const p = r.rows[0];
  if (!p) throw new ApiError("unavailable");
  return p;
}

export type CartLine = { line_no: number; item_id: string; variant_id: string | null; option_ids: string[]; qty_milli: number };

export type PricedCart = {
  pack: PackRow;
  priced: PriceLinesResult;
  tax: OrderTax | null;
  totals: { subtotal_minor: number; discount_minor: number; tax_minor: number; total_minor: number };
  refusals: Refusal[];
};

export const saleLine = (l: PricedLine, mrp: number | null): SaleLine => ({
  name: l.item_id,
  qty_milli: l.qty_milli,
  unit_price_minor: l.unit_price_minor,
  option_delta_minor: l.options_minor,
  line_discount_minor: l.line_discount_minor,
  tax_class: l.tax_class,
  mrp_minor: mrp,
});

/** Prices a cart at `at`. Refusals (from priceLines or the pack) are returned, not thrown: preview lists them;
 *  placement refuses with the first. */
export async function priceCart(
  c: Queryable,
  input: { outlet_id: string; channel_kind: string; at: string; lines: CartLine[]; coupon_codes: string[]; customer_id?: string | null; exclude_order_id?: string },
): Promise<PricedCart> {
  const pack = await loadPack(c);
  const priced = await seams.priceLines(c, {
    outlet_id: input.outlet_id, channel_kind: input.channel_kind, at: input.at,
    lines: input.lines.map((l) => ({ item_id: l.item_id, variant_id: l.variant_id, option_ids: l.option_ids, qty_milli: l.qty_milli })),
    ...(input.coupon_codes.length ? { coupon_codes: input.coupon_codes } : {}),
    ...(input.customer_id ? { customer_id: input.customer_id } : {}),
    ...(input.exclude_order_id ? { exclude_order_id: input.exclude_order_id } : {}),
  });
  const refusals = [...priced.refusals];
  const zero = { subtotal_minor: 0, discount_minor: 0, tax_minor: 0, total_minor: 0 };
  if (refusals.length) return { pack, priced, tax: null, totals: zero, refusals };
  if (priced.lines.length !== input.lines.length) throw new ApiError("internal");
  const taxed = orderTax(pack.doc, { channel_kind: input.channel_kind, lines: priced.lines.map((l) => saleLine(l, null)) });
  if (!taxed.ok) {
    const r = taxed.refusal;
    refusals.push({ line_no: "line_no" in r ? r.line_no : null, reason_code: r.reason_code });
    return { pack, priced, tax: null, totals: zero, refusals };
  }
  for (const [i, l] of taxed.tax.lines.entries()) {
    if (l.tax_minor !== priced.lines[i]!.tax_minor) throw new ApiError("internal");
  }
  const t = taxed.tax;
  const discount = t.lines.reduce((a, l) => a + l.discount_minor, 0);
  return {
    pack, priced, tax: t, refusals,
    // total = subtotal − discount + tax (core.order check), for exclusive and inclusive packs alike.
    totals: { subtotal_minor: t.total_minor + discount - t.tax_minor, discount_minor: discount, tax_minor: t.tax_minor, total_minor: t.total_minor },
  };
}
