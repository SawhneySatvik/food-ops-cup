// The one pricing function (W2 seam `priceLines`; R40 C1; project rule 9). Preview, placement and every
// re-price after a promised-time change call this; it reads rows and WRITES NOTHING. Runs on the caller's
// transaction (`withContext` / `executeCommand`), so RLS decides what it can see.
//
// Per line, in this order:
//   unit price   ← the core.price row in force on the outlet's business date of `at` for (item, variant,
//                  outlet, channel kind); a variant without its own row uses the item's row
//   options      ← Σ core.option.price_delta_minor of the selected options (per unit; group min/max checked)
//   amount       = qty × (unit + options) / 1000, rounded half-up (as priced: tax-exclusive or -inclusive)
//   deal         ← at most one core.deal per line, judged at `at` in the outlet's zone: the largest discount
//                  wins (ties → lowest deal id)
//   coupons      ← in the order presented, each on what every line has left after its deal and earlier
//                  coupons: percent per line (half-up); amount split across lines in proportion (largest
//                  remainder). Min spend is judged on the cart after deals, before tax.
//   tax          ← core-domain `orderTax` with the tenant's active country pack (highest version)
// Refusals are returned, never thrown: item_sold_out, price_above_mrp, coupon_invalid (unknown, repeated or
// inactive), coupon_expired (outside its dates), coupon_out_of_scope (another outlet, or customer-only without a
// customer), coupon_cap_reached,
// coupon_min_spend, unknown_channel, unknown_tax_class. A line refused for its MRP is not priced (it cannot be
// sold at all); a sold-out line is priced and refused. Malformed requests (unknown item, an option that is
// not the item's, a group's min/max broken) throw ApiError; an inactive item or variant, or one with no price
// in force, is `conflict` / `item_unavailable` (it went off sale since the menu was read).
import { citeRef, type ReasonCode, type RefusalParams } from "@munim/contracts";
import { DealRule, DealWindow } from "@munim/contracts/catalogue";
import { CountryPack } from "@munim/contracts/packs";
import { allocate, mulDiv } from "@munim/core-domain/money";
import { orderTax, type SaleLine, type TaxAmount } from "@munim/core-domain/packs";
import { businessDate } from "@munim/core-domain/tz";
import { asSystem } from "../../lib/db.ts";
import { ApiError } from "../../lib/errors.ts";
import type { Queryable } from "../../runtoken/index.ts";
import { dealDiscount, dealOpen, type DealRow } from "./deals.ts";

export type PriceRequest = {
  outlet_id: string;
  channel_kind: string;
  /** The promised time (ASAP: now). Deals and validity are judged here. */
  at: Date | string;
  lines: ReadonlyArray<{ item_id: string; variant_id: string | null; option_ids: readonly string[]; qty_milli: number }>;
  coupon_codes?: readonly string[];
  /** From the verified principal, or the order's own row on a re-price (per-customer caps, requires_customer);
   *  null/absent = anonymous. */
  customer_id?: string | null;
  /** Re-pricing this order: its own coupon uses are not counted against the caps (R2-S2-1). */
  exclude_order_id?: string;
};

export type PricedLine = {
  line_no: number;
  item_id: string;
  variant_id: string | null;
  option_ids: string[];
  qty_milli: number;
  /** core.price.amount_minor of `price_ref`. */
  unit_price_minor: number;
  /** Σ option price deltas, per unit. */
  options_minor: number;
  /** qty × (unit + options), before discounts. */
  amount_minor: number;
  deal_discount_minor: number;
  coupon_discount_minor: number;
  line_discount_minor: number;
  tax_class: string;
  net_minor: number;
  tax_minor: number;
  line_total_minor: number;
  components: TaxAmount[];
  item_kind: string;
  price_ref: string;
  option_refs: string[];
  deal_refs: string[];
  coupon_refs: string[];
};

/** `params` (T-099, G-11): the refusal's typed parameters — the line's item, the coupon code, a min-spend shortfall. */
export type PriceRefusal = { line_no: number | null; reason_code: ReasonCode; code?: string; params?: RefusalParams };

export type PriceResult = {
  currency: string;
  business_date: string;
  tax_rule: { pack_code: string; pack_version: number };
  lines: PricedLine[];
  /** Per applied coupon: what core.coupon_use records at placement. */
  coupons: Array<{ coupon_id: string; code: string; discount_minor: number; ref: string }>;
  /** = total − tax + discount, so `total = subtotal − discount + tax` holds for both pack displays. */
  subtotal_minor: number;
  discount_minor: number;
  tax_minor: number;
  total_minor: number;
  /** The order's tax per pack component (e.g. CGST + SGST, or GST), summed over the lines by the pack engine. */
  components: TaxAmount[];
  /** Tax the merchant owes vs. what an aggregator pays (pack tax_treatment). */
  own_liability_minor: number;
  operator_liability_minor: number;
  refusals: PriceRefusal[];
};

const row = (table: string, id: string) => citeRef("row", `core.${table}:${id}`);
const n = (v: string | number | null) => (v === null ? null : Number(v));

/** The tenant's active country pack (highest version) — the same choice the database triggers make. */
export async function tenantPack(tx: Queryable): Promise<CountryPack> {
  const r = await tx.query<{ doc: unknown }>(
    `SELECT p.doc FROM core.tenant t JOIN platform.country_pack p ON p.code = t.country_code AND p.status = 'active'
      WHERE t.tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid ORDER BY p.version DESC LIMIT 1`);
  if (!r.rows[0]) throw new ApiError("not_found");
  return CountryPack.parse(r.rows[0].doc);
}

export async function outletClock(tx: Queryable, outlet_id: string, at: Date | string) {
  const r = await tx.query<{ tz: string; cutoff: string }>(`SELECT tz, business_day_cutoff::text AS cutoff FROM core.outlet WHERE id = $1`, [outlet_id]);
  const o = r.rows[0];
  if (!o) throw new ApiError("not_found");
  return { tz: o.tz, business_date: businessDate(at, o.tz, o.cutoff.slice(0, 5)) };
}

/** Deal rows whose rule and windows match the contract shape; a row that does not is never applied. */
export async function loadDeals(tx: Queryable): Promise<Array<DealRow & { name_key: string; kind: string }>> {
  const r = await tx.query<{ id: string; kind: string; name_key: string; rule: unknown; windows: unknown; outlet_ids: string[]; valid_from: string; valid_to: string | null; active: boolean }>(
    `SELECT id, kind, name_key, rule, windows, outlet_ids, valid_from::text, valid_to::text, active FROM core.deal WHERE active ORDER BY id`);
  return r.rows.flatMap((d) => {
    const rule = DealRule.safeParse(d.rule);
    const windows = DealWindow.array().safeParse(d.windows);
    if (!rule.success || !windows.success || rule.data.kind !== d.kind) return [];
    return [{ ...d, rule: rule.data, windows: windows.data }];
  });
}

/** THE rule for what is on sale, as SQL over an item row `i` and a variant id expression `v`: an item with active
 *  variants sells only as one of its active variants; an item without sells only as itself (variant null).
 *  itemsForSale lists exactly the pairs it admits and priceLines prices no other pair (one rule, both places). */
export const sellableAs = (i: string, v: string) =>
  `(CASE WHEN ${v} IS NULL THEN NOT EXISTS (SELECT 1 FROM core.variant w WHERE w.tenant_id = ${i}.tenant_id AND w.item_id = ${i}.id AND w.active)
         ELSE EXISTS (SELECT 1 FROM core.variant w WHERE w.tenant_id = ${i}.tenant_id AND w.item_id = ${i}.id AND w.id = ${v} AND w.active) END)`;

type OptionRow = { id: string; group_id: string; price_delta_minor: string; active: boolean; min_select: number; max_select: number; required: boolean };

async function lineFacts(tx: Queryable, req: PriceRequest, line: PriceRequest["lines"][number], business_date: string) {
  const item = (await tx.query<{ kind: string; active: boolean; mrp_minor: string | null }>(
    `SELECT kind, active, mrp_minor FROM core.item WHERE id = $1`, [line.item_id])).rows[0];
  if (!item) throw new ApiError("not_found");
  if (line.variant_id !== null) {
    const v = (await tx.query<{ active: boolean }>(`SELECT active FROM core.variant WHERE id = $1 AND item_id = $2`, [line.variant_id, line.item_id])).rows[0];
    if (!v) throw new ApiError("not_found");
    if (!v.active) throw new ApiError("conflict", "item_unavailable");
  }
  if (!item.active) throw new ApiError("conflict", "item_unavailable");
  // The menu's rule (sellableAs, as itemsForSale lists): an item that has active variants is sold only as one of them.
  const sellable = (await tx.query<{ ok: boolean }>(`SELECT ${sellableAs("i", "$2::uuid")} AS ok FROM core.item i WHERE i.id = $1`, [line.item_id, line.variant_id])).rows[0];
  if (!sellable?.ok) throw new ApiError("conflict", "item_unavailable");
  const price = (await tx.query<{ id: string; amount_minor: string; tax_class: string }>(
    `SELECT id, amount_minor, tax_class FROM core.price
      WHERE item_id = $1 AND outlet_id = $2 AND channel_kind = $3 AND (variant_id = $4 OR variant_id IS NULL)
        AND valid_from <= $5::date AND (valid_to IS NULL OR $5::date < valid_to)
      ORDER BY variant_id NULLS LAST LIMIT 1`,
    [line.item_id, req.outlet_id, req.channel_kind, line.variant_id, business_date])).rows[0];
  if (!price) throw new ApiError("conflict", "item_unavailable");

  const opts = (await tx.query<OptionRow>(
    `SELECT o.id, o.option_group_id AS group_id, o.price_delta_minor, o.active, g.min_select, g.max_select, g.required
       FROM core.option_group g JOIN core.option o ON o.tenant_id = g.tenant_id AND o.option_group_id = g.id
      WHERE g.item_id = $1 ORDER BY o.id`, [line.item_id])).rows;
  if (new Set(line.option_ids).size !== line.option_ids.length) throw new ApiError("bad_request");
  const chosen = line.option_ids.map((id) => {
    const o = opts.find((x) => x.id === id);
    if (!o || !o.active) throw new ApiError("bad_request");
    return o;
  });
  for (const g of new Map(opts.map((o) => [o.group_id, o])).values()) {
    const k = chosen.filter((o) => o.group_id === g.group_id).length;
    if (k > g.max_select || k < (g.required || k > 0 ? g.min_select : 0)) throw new ApiError("bad_request");
  }
  const sold = (await tx.query(
    `SELECT 1 FROM core.item_availability WHERE outlet_id = $1 AND item_id = $2 AND (variant_id IS NULL OR variant_id = $3) AND NOT available LIMIT 1`,
    [req.outlet_id, line.item_id, line.variant_id])).rows.length > 0;
  return {
    kind: item.kind,
    mrp_minor: n(item.mrp_minor),
    price: { id: price.id, amount_minor: Number(price.amount_minor), tax_class: price.tax_class },
    options: chosen.map((o) => ({ id: o.id, delta: Number(o.price_delta_minor) })),
    sold_out: sold,
  };
}

type CouponRow = {
  id: string; code: string; kind: "percent" | "amount"; value_bp: number | null; value_minor: string | null; min_spend_minor: string;
  global_cap: number | null; per_customer_cap: number | null; requires_customer: boolean; outlet_ids: string[];
  valid_from: Date; valid_to: Date | null; active: boolean;
};

/** Uses so far, counted over every order of the tenant, except uses on orders that were cancelled or rejected (the
 *  use row stays — append-only — but no longer counts towards a cap) and, on a re-price, the order's own. A cap is tenant-wide, so the count is core's
 *  own read for every caller: role cleared and every outlet in view for this one statement (a shopper can read
 *  neither others' uses nor their orders; a member scoped to some outlets cannot see another outlet's cancellation),
 *  then restored. Only the two counts leave it. orders' placement (recordCoupons) counts the same way. */
export async function couponUses(tx: Queryable, coupon_id: string, customer_id: string | null, exclude_order_id: string | null = null) {
  const prev = (await tx.query<{ o: string | null }>(`SELECT current_setting('app.outlet_ids', true) AS o`)).rows[0]!.o;
  const c = await asSystem(tx, async () => {
    await tx.query(`SELECT set_config('app.outlet_ids', '{*}', true)`);
    const out = (await tx.query<{ all: string; mine: string }>(
      `SELECT count(*) AS all, count(*) FILTER (WHERE u.customer_id = $2) AS mine FROM core.coupon_use u
        WHERE u.coupon_id = $1 AND u.order_id IS DISTINCT FROM $3::uuid
          AND NOT EXISTS (SELECT 1 FROM core."order" o WHERE o.tenant_id = u.tenant_id AND o.id = u.order_id AND o.status IN ('cancelled', 'rejected'))`,
      [coupon_id, customer_id, exclude_order_id])).rows[0]!;
    await tx.query(`SELECT set_config('app.outlet_ids', $1, true)`, [prev ?? ""]);
    return out;
  });
  return { all: Number(c.all), mine: Number(c.mine) };
}

export async function priceLines(tx: Queryable, req: PriceRequest): Promise<PriceResult> {
  const pack = await tenantPack(tx);
  const { tz, business_date } = await outletClock(tx, req.outlet_id, req.at);
  const at = typeof req.at === "string" ? new Date(req.at) : req.at;
  const empty = (refusals: PriceRefusal[]): PriceResult => ({
    currency: pack.currency.code, business_date, tax_rule: { pack_code: pack.code, pack_version: pack.version }, lines: [], coupons: [],
    subtotal_minor: 0, discount_minor: 0, tax_minor: 0, total_minor: 0, components: [], own_liability_minor: 0, operator_liability_minor: 0, refusals,
  });
  // The channel itself (an aggregator the pack does not list) refuses the whole cart.
  const probe = orderTax(pack, { channel_kind: req.channel_kind, lines: [] });
  if (!probe.ok) return empty([{ line_no: null, reason_code: probe.refusal.reason_code, code: req.channel_kind }]);

  const refusals: PriceRefusal[] = [];
  const deals = await loadDeals(tx);
  type Work = PriceRequest["lines"][number] & Awaited<ReturnType<typeof lineFacts>> & { line_no: number; unit: number; amount: number; deal: number; deal_id: string | null; coupon: number; coupon_ids: string[] };
  const work: Work[] = [];
  for (const [i, l] of req.lines.entries()) {
    const f = await lineFacts(tx, req, l, business_date);
    const line_no = i + 1;
    const lineParams = { line_no, item_id: l.item_id, variant_id: l.variant_id };
    if (f.sold_out) refusals.push({ line_no, reason_code: "item_sold_out", params: lineParams });
    const unit = f.price.amount_minor + f.options.reduce((a, o) => a + o.delta, 0);
    // MRP is checked by orderTax itself (pack rule) on the undiscounted unit; a line it refuses is not priced.
    const mrp = orderTax(pack, { channel_kind: req.channel_kind, lines: [{ name: l.item_id, qty_milli: l.qty_milli, unit_price_minor: f.price.amount_minor,
      option_delta_minor: unit - f.price.amount_minor, tax_class: f.price.tax_class, mrp_minor: f.mrp_minor }] });
    if (!mrp.ok) {
      refusals.push({ line_no, reason_code: mrp.refusal.reason_code, params: lineParams });
      continue;
    }
    const amount = mulDiv(l.qty_milli, unit, 1000);
    let best = { d: 0, id: null as string | null };
    for (const d of deals) {
      if (!dealOpen(d, req.outlet_id, at, tz, business_date)) continue;
      const disc = dealDiscount(d.rule, { item_id: l.item_id, qty_milli: l.qty_milli, unit_minor: unit, amount_minor: amount });
      if (disc > best.d) best = { d: disc, id: d.id }; // deals are ordered by id: a tie keeps the lowest
    }
    work.push({ ...l, ...f, line_no, unit, amount, deal: best.d, deal_id: best.id, coupon: 0, coupon_ids: [] });
  }

  const coupons: PriceResult["coupons"] = [];
  const codes = req.coupon_codes ?? [];
  if (codes.length > 0) {
    const rows = (await tx.query<CouponRow>(
      `SELECT id, code, kind, value_bp, value_minor, min_spend_minor, global_cap, per_customer_cap, requires_customer, outlet_ids, valid_from, valid_to, active
         FROM core.coupon WHERE code = ANY($1::text[])`, [codes])).rows;
    const afterDeals = work.reduce((a, w) => a + w.amount - w.deal, 0);
    const customer = req.customer_id ?? null;
    const seen = new Set<string>();
    for (const code of codes) {
      const c = rows.find((r) => r.code === code);
      const refuse = (reason_code: ReasonCode, extra: RefusalParams = {}) => refusals.push({ line_no: null, reason_code, code, params: { code, ...extra } });
      if (!c || seen.has(code) || !c.active) {
        refuse("coupon_invalid");
        continue;
      }
      if (at < c.valid_from || (c.valid_to !== null && at >= c.valid_to)) {
        refuse("coupon_expired");
        continue;
      }
      if ((c.outlet_ids.length > 0 && !c.outlet_ids.includes(req.outlet_id)) || (c.requires_customer && customer === null)) {
        refuse("coupon_out_of_scope");
        continue;
      }
      seen.add(code);
      const uses = await couponUses(tx, c.id, customer, req.exclude_order_id ?? null);
      if ((c.global_cap !== null && uses.all >= c.global_cap) || (c.per_customer_cap !== null && uses.mine >= c.per_customer_cap)) {
        refuse("coupon_cap_reached");
        continue;
      }
      if (afterDeals < Number(c.min_spend_minor)) {
        refuse("coupon_min_spend", { min_spend_minor: Number(c.min_spend_minor), shortfall_minor: Number(c.min_spend_minor) - afterDeals, currency: pack.currency.code });
        continue;
      }
      const left = work.map((w) => w.amount - w.deal - w.coupon);
      const parts = c.kind === "percent"
        ? left.map((l) => mulDiv(l, c.value_bp!, 10000))
        : (() => {
            const total = Math.min(Number(c.value_minor), left.reduce((a, l) => a + l, 0));
            return total === 0 ? left.map(() => 0) : allocate(total, left);
          })();
      parts.forEach((p, i) => {
        work[i]!.coupon += p;
        if (p > 0) work[i]!.coupon_ids.push(c.id);
      });
      coupons.push({ coupon_id: c.id, code: c.code, discount_minor: parts.reduce((a, p) => a + p, 0), ref: row("coupon", c.id) });
    }
  }

  const saleLines: SaleLine[] = work.map((w) => ({
    name: w.item_id, qty_milli: w.qty_milli, unit_price_minor: w.price.amount_minor, option_delta_minor: w.unit - w.price.amount_minor,
    line_discount_minor: w.deal + w.coupon, tax_class: w.price.tax_class, mrp_minor: w.mrp_minor,
  }));
  const taxed = orderTax(pack, { channel_kind: req.channel_kind, lines: saleLines });
  if (!taxed.ok) return empty([...refusals, { line_no: "line_no" in taxed.refusal ? work[taxed.refusal.line_no - 1]!.line_no : null, reason_code: taxed.refusal.reason_code }]);
  const t = taxed.tax;
  const lines: PricedLine[] = work.map((w, i) => {
    const x = t.lines[i]!;
    return {
      line_no: w.line_no, item_id: w.item_id, variant_id: w.variant_id, option_ids: [...w.option_ids], qty_milli: w.qty_milli,
      unit_price_minor: w.price.amount_minor, options_minor: w.unit - w.price.amount_minor, amount_minor: x.amount_minor,
      deal_discount_minor: w.deal, coupon_discount_minor: w.coupon, line_discount_minor: x.discount_minor,
      tax_class: x.tax_class, net_minor: x.net_minor, tax_minor: x.tax_minor, line_total_minor: x.total_minor, components: x.components,
      item_kind: w.kind,
      price_ref: row("price", w.price.id), option_refs: w.options.map((o) => row("option", o.id)),
      deal_refs: w.deal_id && w.deal > 0 ? [row("deal", w.deal_id)] : [], coupon_refs: w.coupon_ids.map((id) => row("coupon", id)),
    };
  });
  const discount = lines.reduce((a, l) => a + l.line_discount_minor, 0);
  return {
    currency: t.currency, business_date, tax_rule: { pack_code: pack.code, pack_version: pack.version }, lines, coupons,
    subtotal_minor: t.total_minor - t.tax_minor + discount, discount_minor: discount, tax_minor: t.tax_minor, total_minor: t.total_minor, components: t.components,
    own_liability_minor: t.own_liability_minor, operator_liability_minor: t.operator_liability_minor, refusals,
  };
}
