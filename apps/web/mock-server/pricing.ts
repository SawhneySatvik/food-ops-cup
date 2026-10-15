// Server-side pricing for the mock: the only place in the project where money is added up. It mirrors what the
// Munim mock does (checked on 13 Oct 2026): deal first, then coupon, both as a percent of the line, then GST per
// component on the discounted line.
import type { Schemas } from "@munim/sdk";
import {
  CHANNEL_ID, COUPONS, CURRENCY, DEALS, ITEMS, OUTLETS, PREP_MIN, TAX, TAX_CLASS, TZ_OFFSET_MIN,
  groupId, itemId, optionId, variantId, type MockItem, type MockOutlet,
} from "./data";
import { findWindow } from "./windows";

type PreviewRequest = Schemas["OrdersPreviewRequest"];
type Preview = Schemas["StorefrontPreviewResponse"];
type Refusal = Preview["refusals"][number];
export type Accepting = "open" | "busy" | "paused" | "closed";

export class BadRequest extends Error {}

const ref = (table: string, id: string) => `⟨cite:row:core.${table}:${id}⟩`;
const pct = (amount: number, bp: number) => Math.round((amount * bp) / 10_000);

export const itemById = new Map(ITEMS.map((i) => [itemId(i.slug), i]));

/** Outlet-local minutes since midnight and ISO weekday (1 = Monday) of an instant. */
export function localClock(at: Date): { minutes: number; weekday: number } {
  const local = new Date(at.getTime() + TZ_OFFSET_MIN * 60_000);
  const day = local.getUTCDay();
  return { minutes: local.getUTCHours() * 60 + local.getUTCMinutes(), weekday: day === 0 ? 7 : day };
}

const hm = (s: string) => Number(s.slice(0, 2)) * 60 + Number(s.slice(3, 5));

function dealFor(item: MockItem, promised: Date) {
  const { minutes, weekday } = localClock(promised);
  return DEALS.find((d) => d.items.includes(item.slug) && d.windows.some((w) => w.days.includes(weekday) && minutes >= hm(w.from) && minutes < hm(w.to)));
}

/** The instant the order is promised for: the window's start, the asked time, or now + prep (+ busy extra). */
export function promisedAt(outlet: MockOutlet, state: Accepting, windowId: string | null, asked: string | null, now: Date): Date {
  if (asked) return new Date(asked);
  if (windowId) {
    const w = findWindow(outlet.outlet_id, windowId, now);
    if (w) return new Date(w.starts_at);
  }
  return new Date(now.getTime() + (PREP_MIN + (state === "busy" ? outlet.busy_extra_min : 0)) * 60_000);
}

export interface Priced {
  preview: Preview;
  promised: Date;
}

export function price(req: PreviewRequest, outlet: MockOutlet, state: Accepting, now: Date): Priced {
  if (!Array.isArray(req.lines) || req.lines.length === 0) throw new BadRequest("lines");
  if (req.kind !== "pickup") throw new BadRequest("kind");
  const coupons = req.coupon_codes ?? [];
  if (coupons.length > 5) throw new BadRequest("coupons");
  const refusals: Refusal[] = [];

  if (state === "paused" || state === "closed") refusals.push({ line_no: null, reason_code: "outlet_paused" });

  let promised = promisedAt(outlet, state, req.pickup_window_id, req.promised_at, now);
  if (req.pickup_window_id) {
    const w = findWindow(outlet.outlet_id, req.pickup_window_id, now);
    if (!w || w.booked >= w.capacity_orders) {
      refusals.push({ line_no: null, reason_code: "window_full" });
      promised = promisedAt(outlet, state, null, null, now);
    } else if (req.promised_at && (promised < new Date(w.starts_at) || promised >= new Date(w.ends_at))) {
      refusals.push({ line_no: null, reason_code: "pickup_time_outside_window" });
    }
  }

  // Lines before coupons: gross and deal discount per line.
  const work = req.lines.map((l, i) => {
    const line_no = i + 1;
    if (!Number.isInteger(l.qty_milli) || l.qty_milli <= 0 || l.qty_milli % 1000 !== 0) throw new BadRequest("qty");
    const item = itemById.get(l.item_id);
    if (!item) {
      refusals.push({ line_no, reason_code: "item_unavailable", params: { line_no, item_id: l.item_id, variant_id: l.variant_id } });
      return null;
    }
    let unit = item.price;
    if (item.variants.length > 0) {
      const v = item.variants.find((x) => variantId(item.slug, x.slug) === l.variant_id);
      if (!v) throw new BadRequest("variant");
      unit = v.price;
    } else if (l.variant_id !== null) throw new BadRequest("variant");
    let options = 0;
    const optionRefs: string[] = [];
    const ids = new Set(l.option_ids);
    for (const g of item.groups) {
      const chosen = g.options.filter((o) => ids.has(optionId(item.slug, g.slug, o.slug)));
      if (chosen.length < g.min || chosen.length > g.max) throw new BadRequest(`group ${groupId(item.slug, g.slug)}`);
      for (const o of chosen) {
        options += o.delta;
        optionRefs.push(ref("option", optionId(item.slug, g.slug, o.slug)));
        ids.delete(optionId(item.slug, g.slug, o.slug));
      }
    }
    if (ids.size > 0) throw new BadRequest("option");
    if (item.soldOut || outlet.soldOut.includes(item.slug)) {
      refusals.push({ line_no, reason_code: "item_sold_out", params: { line_no, item_id: l.item_id, variant_id: l.variant_id } });
    }
    const qty = l.qty_milli / 1000;
    const gross = (unit! + options) * qty;
    const deal = dealFor(item, promised);
    const dealDiscount = deal ? pct(gross, deal.pctBp) : 0;
    return { line_no, l, item, unit: unit!, options, optionRefs, gross, deal, dealDiscount };
  });

  const afterDeals = work.reduce((s, w) => s + (w ? w.gross - w.dealDiscount : 0), 0);
  const applied: { code: string; coupon_id: string; pctBp: number }[] = [];
  for (const raw of coupons) {
    const code = raw.toUpperCase();
    const c = COUPONS.find((x) => x.code === code);
    if (!c) refusals.push({ line_no: null, reason_code: "coupon_invalid", params: { code } });
    else if (c.expired) refusals.push({ line_no: null, reason_code: "coupon_expired", params: { code } });
    else if (c.capReached) refusals.push({ line_no: null, reason_code: "coupon_cap_reached", params: { code } });
    else if (c.outlet && c.outlet !== outlet.outlet_id) refusals.push({ line_no: null, reason_code: "coupon_out_of_scope", params: { code } });
    else if (c.minSpend !== undefined && afterDeals < c.minSpend) {
      refusals.push({ line_no: null, reason_code: "coupon_min_spend", params: { code, min_spend_minor: c.minSpend, shortfall_minor: c.minSpend - afterDeals, currency: CURRENCY } });
    } else applied.push(c);
  }

  const lines: Preview["lines"] = [];
  for (const w of work) {
    if (!w) continue;
    const afterDeal = w.gross - w.dealDiscount;
    const couponDiscount = applied.reduce((s, c) => s + pct(afterDeal, c.pctBp), 0);
    const discount = w.dealDiscount + couponDiscount;
    const taxable = w.gross - discount;
    const components = TAX.components.map((c) => ({ code: c.code, rate_bp: c.rateBp, amount_minor: pct(taxable, c.rateBp) }));
    const tax = components.reduce((s, c) => s + c.amount_minor, 0);
    lines.push({
      line_no: w.line_no,
      item_id: w.l.item_id,
      variant_id: w.l.variant_id,
      qty_milli: w.l.qty_milli,
      unit_price_minor: w.unit,
      options_minor: w.options,
      line_discount_minor: discount,
      tax_class: TAX_CLASS,
      tax_minor: tax,
      line_total_minor: taxable + tax,
      price_ref: ref("price", w.l.item_id),
      option_refs: w.optionRefs,
      deal_refs: w.deal ? [ref("deal", w.deal.deal_id)] : [],
      coupon_refs: applied.map((c) => ref("coupon", c.coupon_id)),
      tax_rate_bp: TAX.rateBp,
      tax_components: components,
    });
  }

  const sum = (f: (l: Preview["lines"][number]) => number) => lines.reduce((s, l) => s + f(l), 0);
  const preview: Preview = {
    label: "preview",
    priced_at: now.toISOString(),
    currency: CURRENCY,
    tax_rule: { pack_code: "IN", pack_version: 4 },
    lines,
    subtotal_minor: sum((l) => (l.unit_price_minor + l.options_minor) * (l.qty_milli / 1000)),
    discount_minor: sum((l) => l.line_discount_minor),
    tax_minor: sum((l) => l.tax_minor),
    total_minor: sum((l) => l.line_total_minor),
    refusals,
    tax_components: TAX.components.map((c) => ({ code: c.code, rate_bp: c.rateBp, amount_minor: sum((l) => l.tax_components.find((x) => x.code === c.code)?.amount_minor ?? 0) })),
    prices_include_tax: false,
  };
  return { preview, promised };
}

export const outletById = (id: string) => OUTLETS.find((o) => o.outlet_id === id) ?? null;
export { CHANNEL_ID };
