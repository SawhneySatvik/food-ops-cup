// Dated history (R44b): the bills and waste a business already had before today, written as the history files
// core-api's built-in parsers read (pos_bills_v2, waste_log_v1) and committed through the approved-import path.
// A file row never carries a number the importer takes on trust: core re-derives every line's tax and total with
// the pack and quarantines the bill when the printed Line Total differs, so the small tax table below is a hand copy
// that fails the seed loudly if it ever drifts from the packs (packages/contracts/packs).
//
// Everything here is a pure function of (seed, world, asOf, days): the same inputs give the same bytes in any time zone.
import { csv, major } from "./csv.ts";
import type { Ctx } from "./ctx.ts";
import { customer, importFile, type Ingredient, type OutletInfo } from "./kit.ts";
import { Prng } from "./prng.ts";
import { addDays, isoWeekday } from "./time.ts";

const TAX: Record<string, { rate: number; comps: number[] }> = {
  restaurant_5: { rate: 500, comps: [250, 250] }, goods_5: { rate: 500, comps: [250, 250] }, goods_12: { rate: 1200, comps: [600, 600] },
  goods_18: { rate: 1800, comps: [900, 900] }, goods_exempt: { rate: 0, comps: [] }, gst_10: { rate: 1000, comps: [1000] }, gst_free: { rate: 0, comps: [] },
};
const rdiv = (a: number, b: number, d: number): number => Math.floor((2 * a * b + d) / (2 * d)); // round half up, as core's mulDiv

/** A line's tax and total as core-domain's orderTax computes them (per-line, per-component half-up). */
export function priceLine(taxClass: string, unitMinor: number, qty: number, discountMinor: number, inclusive: boolean): { tax: number; total: number } {
  const cls = TAX[taxClass];
  if (!cls) throw new Error(`history: unknown tax class ${taxClass}`);
  const after = unitMinor * qty - discountMinor;
  const tax = cls.comps.reduce((a, c) => a + rdiv(after, c, inclusive ? 10000 + cls.rate : 10000), 0);
  return { tax, total: inclusive ? after : after + tax };
}

export type Method = "cash" | "card" | "upi";
export interface HItem { key: string; priceMinor: number; taxClass: string; brand?: string; w: number; recipe: Array<[Ingredient, number]> }
export interface HChannel { kind: string; w: number; types: readonly string[]; /** indexes into `outlets`; all when absent */ outlets?: readonly number[] }

/** One bill, as intended: amounts are filled in by `finish`. Planted bills are written out in full; baseline bills are drawn. */
export interface PBill {
  no: string; date: string; time: string; outlet: number; channel: string; brand?: string; type: string; phone?: string;
  lines: Array<{ item: string; qty: number; discBp?: number; voidReason?: string }>;
  tender?: Method | "split";
  refund?: { minor: number | "full" | "half"; mode: Method; reason: string; date?: string };
  voidReason?: string;
}

export interface HCfg {
  prefix: string;
  outlets: Array<{ outlet: OutletInfo; perDay: [number, number] }>;
  channels: HChannel[];
  items: HItem[];
  /** The customer pool (phones that exist as customers); baseline bills draw from it. Planted regulars are not in it. */
  phones: string[];
  inclusive: boolean;
  /** Trading hours for drawn bills (default: lunch and dinner peaks between 10:00 and 23:30). */
  hours?: [number, number];
  planted: PBill[];
  /** Baseline waste: (outlet index, ingredient) pairs that get small logs a few times a week. */
  waste: Array<{ outlet: number; ing: Ingredient; qtyMilli: [number, number] }>;
  /** Planted waste rows (a spike, a bad day): explicit. */
  plantedWaste: Waste[];
  /** Scales a day's baseline bill count at one outlet (a level shift, a festival, a calibrated month). The draw itself is unchanged, so a
   *  factor of 1 leaves every other day byte-identical. */
  dayFactor?: (date: string, outletIdx: number) => number;
}
export interface Waste { date: string; time: string; outlet: number; ing: Ingredient; qtyMilli: number; reason: "temperature" | "overprep" | "expired" | "damaged"; note?: string }

export interface Line { item: string; qty: number; unit: number; taxClass: string; disc: number; tax: number; total: number; voidReason: string | null }
export interface Bill {
  no: string; date: string; time: string; outlet: number; channel: string; brand: string | null; type: string; phone: string | null;
  lines: Line[]; total: number; voided: string | null; cash: number; card: number; upi: number;
  refund: { minor: number; mode: Method; reason: string; date: string } | null;
}

const HEADER = ["Bill No", "Bill Date", "Bill Time", "Outlet", "Channel", "Brand", "Order Type", "Customer Phone", "Bill Status", "Item Code", "Variant Code", "Qty",
  "Unit Price", "Tax Class", "Line Discount", "Line Total", "Void Reason", "Cash", "Card", "UPI", "Refund", "Refund Mode", "Refund Reason", "Refund Date"];
const FILE_BILLS = 1800; // bills per file: a month, split when a month is bigger (the import commit is chunked at 500 inside)

export class Plan {
  readonly bills: Bill[];
  readonly waste: Waste[];
  readonly #cfg: HCfg;
  readonly #c: Ctx;

  constructor(c: Ctx, cfg: HCfg) {
    this.#c = c;
    this.#cfg = cfg;
    const first = addDays(c.asOf, -c.days);
    const last = addDays(c.asOf, -1);
    const byKey = new Map(cfg.items.map((i) => [i.key, i]));
    const finish = (p: PBill, rng: Prng): Bill => {
      const lines: Line[] = p.lines.map((l) => {
        const it = byKey.get(l.item);
        if (!it) throw new Error(`history: bill ${p.no} names unknown item ${l.item}`);
        const disc = l.discBp ? rdiv(it.priceMinor * l.qty, l.discBp, 10000) : 0;
        const t = priceLine(it.taxClass, it.priceMinor, l.qty, disc, cfg.inclusive);
        return { item: it.key, qty: l.qty, unit: it.priceMinor, taxClass: it.taxClass, disc, tax: t.tax, total: t.total, voidReason: l.voidReason ?? null };
      });
      const total = lines.reduce((a, l) => a + l.total, 0);
      const aggregator = p.channel.startsWith("aggregator:");
      const paying = !p.voidReason && !aggregator;
      let cash = 0, card = 0, upi = 0;
      if (paying) {
        const m = p.tender === "split" ? "split" : (p.tender ?? rng.pick(["cash", "upi", "upi", "card"] as const));
        if (m === "cash") cash = total; else if (m === "card") card = total; else if (m === "upi") upi = total;
        else { cash = Math.floor(total / 2); upi = total - cash; }
      }
      let refund: Bill["refund"] = null;
      if (p.refund && !p.voidReason) {
        const minor = p.refund.minor === "full" ? total : p.refund.minor === "half" ? Math.max(1, Math.floor(total / 2)) : p.refund.minor;
        const date = p.refund.date && p.refund.date <= last ? p.refund.date : p.date;
        refund = { minor, mode: p.refund.mode, reason: p.refund.reason, date };
      }
      return { no: p.no, date: p.date, time: p.time, outlet: p.outlet, channel: p.channel, brand: p.brand ?? null, type: p.type, phone: p.phone ?? null, lines, total,
        voided: p.voidReason ?? null, cash, card, upi, refund };
    };

    // Aggregator bills only where a payout cycle covers them (cycle w: days 7w+13 .. 7w+7 back from asOf): everything else
    // in the planted window is deliberately unreconciled, and a long-window detector must not see baseline bills as missing.
    const weeks = Math.floor((c.days - 14) / 7);
    const aggOk = (date: string) => { const n = (Date.parse(c.asOf) - Date.parse(date)) / 86_400_000; return n >= 14 && n <= 13 + 7 * weeks; };

    const brands = [...new Set(cfg.items.flatMap((x) => (x.brand ? [x.brand] : [])))];
    const out: Bill[] = [];
    for (let d = first; d <= last; d = addDays(d, 1)) {
      for (const [oi, o] of cfg.outlets.entries()) {
        const rng = new Prng(c.seed, c.world, "bills", cfg.prefix, d, String(oi));
        const n = Math.round(rng.int(...o.perDay) * (isoWeekday(d) >= 5 ? 1.35 : 1) * (cfg.dayFactor?.(d, oi) ?? 1));
        const chans = cfg.channels.filter((ch) => (!ch.outlets || ch.outlets.includes(oi)) && (!ch.kind.startsWith("aggregator:") || aggOk(d)));
        const weight = chans.reduce((a, ch) => a + ch.w, 0);
        const planted = cfg.planted.filter((p) => p.date === d && p.outlet === oi);
        for (let i = 0; i < n; i++) {
          let u = rng.next() * weight;
          const ch = chans.find((x) => (u -= x.w) < 0) ?? chans[0]!;
          const brand = brands.length ? rng.pick(brands) : undefined;
          const pool = cfg.items.filter((x) => x.brand === brand);
          const k = rng.next() < 0.55 ? 1 : rng.next() < 0.67 ? 2 : 3;
          const picked: string[] = [];
          while (picked.length < Math.min(k, pool.length)) {
            let v = rng.next() * pool.reduce((a, x) => a + x.w, 0);
            const it = pool.find((x) => (v -= x.w) < 0) ?? pool[0]!;
            if (!picked.includes(it.key)) picked.push(it.key);
          }
          const lines = picked.map((key) => ({ item: key, qty: rng.chance(0.2) ? 2 : 1 } as PBill["lines"][number]));
          const r = rng.next();
          const aggregator = ch.kind.startsWith("aggregator:");
          const voidIt = r < 0.01;
          if (!voidIt && r < 0.022) lines[rng.int(0, lines.length - 1)]!.voidReason = "wastage";
          if (rng.chance(0.07)) lines[rng.int(0, lines.length - 1)]!.discBp = 1000;
          const h = rng.next();
          const hour = cfg.hours ? rng.int(...cfg.hours) : h < 0.4 ? rng.int(12, 14) : h < 0.85 ? rng.int(19, 22) : rng.int(10, 23);
          // Refund reasons are the packs' slugs: `late` is the one kitchen.ticket_drift counts (packs/kitchen.md §2, K1).
          const wantsRefund = !voidIt && rng.chance(0.015);
          const p: PBill = {
            no: `${cfg.prefix}${oi + 1}-${d.replaceAll("-", "")}-${String(i + 1).padStart(3, "0")}`, date: d,
            time: `${String(hour).padStart(2, "0")}:${String(rng.int(0, hour === 23 ? 29 : 59)).padStart(2, "0")}`, outlet: oi, channel: ch.kind,
            ...(brand ? { brand } : {}), type: rng.pick(ch.types), lines,
            ...(!aggregator && !voidIt && cfg.phones.length > 0 && rng.chance(0.35) ? { phone: rng.pick(cfg.phones) } : {}),
            ...(voidIt ? { voidReason: rng.pick(["customer_left", "wrong_order", "duplicate_punch"]) } : {}),
            ...(wantsRefund ? { refund: { minor: rng.chance(0.5) ? ("full" as const) : ("half" as const), mode: rng.pick(["cash", "card", "upi"] as const),
              reason: aggregator ? "late" : rng.pick(["customer_complaint", "late", "wrong_item"]), date: addDays(d, rng.int(0, 2)) } } : {}),
          };
          out.push(finish(p, rng));
        }
        for (const p of planted) out.push(finish(p, new Prng(c.seed, c.world, "planted", p.no)));
      }
    }
    for (const p of cfg.planted) if (p.date < first || p.date > last) throw new Error(`history: planted bill ${p.no} on ${p.date} is outside the timeline`);
    this.bills = out.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : a.outlet - b.outlet));

    // Waste: baseline logs on the baseline pairs, then the planted rows. Baseline waste is spoilage and breakage, never overprep: kitchen.overprep
    // judges an outlet's whole week, so a baseline overprep log would ride along in a planted week's impact (RG-K7). Three slots keep the draw.
    const w: Waste[] = [];
    for (let d = first; d <= last; d = addDays(d, 1)) {
      const rng = new Prng(c.seed, c.world, "waste", cfg.prefix, d);
      for (const pair of cfg.waste) {
        if (!rng.chance(0.18)) continue;
        w.push({ date: d, time: `${rng.int(20, 22)}:${String(rng.int(0, 59)).padStart(2, "0")}`, outlet: pair.outlet, ing: pair.ing,
          qtyMilli: rng.int(...pair.qtyMilli), reason: rng.pick(["damaged", "expired", "damaged"] as const) });
      }
    }
    for (const x of cfg.plantedWaste) if (x.date < first || x.date > last) throw new Error(`history: planted waste on ${x.date} is outside the timeline`);
    this.waste = [...w, ...cfg.plantedWaste];
  }

  /** What the bills and waste will draw from one ingredient at one outlet (milli-units, recipe waste allowance and a margin included),
   *  so a world can stock enough that history never drives on-hand negative. */
  need(outletIdx: number, ing: Ingredient): number {
    const items = new Map(this.#cfg.items.map((i) => [i.key, i]));
    let milli = 0;
    for (const b of this.bills) {
      if (b.outlet !== outletIdx || b.voided) continue;
      for (const l of b.lines) for (const [g, q] of items.get(l.item)!.recipe) if (g.id === ing.id) milli += l.qty * q;
    }
    for (const x of this.waste) if (x.outlet === outletIdx && x.ing.id === ing.id) milli += x.qtyMilli;
    return Math.ceil(milli * 1.1);
  }

  /** What core's consumption draws from one ingredient at one outlet over the history, exactly (milli-units): per bill, the
   *  recipe quantity grossed up by its waste allowance `wasteBp` and rounded half up once per ingredient, as core-domain's
   *  consume-order does, plus the waste logs. For a world that must end with a known amount on hand (need() only bounds it). */
  draw(outletIdx: number, ing: Ingredient, wasteBp: number): number {
    const items = new Map(this.#cfg.items.map((i) => [i.key, i]));
    let milli = 0;
    for (const b of this.bills) {
      if (b.outlet !== outletIdx || b.voided) continue;
      let raw = 0;
      for (const l of b.lines) for (const [g, q] of items.get(l.item)!.recipe) if (g.id === ing.id) raw += l.qty * q;
      milli += Math.floor((raw * (10_000 + wasteBp) + 5_000) / 10_000);
    }
    for (const x of this.waste) if (x.outlet === outletIdx && x.ing.id === ing.id) milli += x.qtyMilli;
    return milli;
  }

  /** Aggregator bills of one outlet and channel inside [from, to] (a payout cycle): the lines its statement lists, with the bill's tax. */
  aggregatorBills(outletIdx: number, channel: string, from: string, to: string): Array<{ no: string; date: string; gross: number; tax: number }> {
    return this.bills.filter((b) => !b.voided && b.outlet === outletIdx && b.channel === channel && b.date >= from && b.date <= to)
      .map((b) => ({ no: b.no, date: b.date, gross: b.total, tax: b.lines.reduce((a, l) => a + l.tax, 0) }));
  }

  /** What an outlet's customers paid by UPI on one date (completed bills only): the bank credits a statement would list. */
  upiTendered(outletIdx: number, date: string): number {
    return this.bills.filter((b) => b.outlet === outletIdx && b.date === date && !b.voided).reduce((a, b) => a + b.upi, 0);
  }

  /** The cash a history drawer took at one outlet on one business date: cash tenders of its bills that day less the cash refunds
   *  dated that day (a refund lands on its own date, at its bill's time). Core's own figure for a shift over that day (imports/
   *  shifts.ts cashIn), which a shift log's "Cash Tenders" control total must equal to the paisa. */
  cashIn(outletIdx: number, date: string): number {
    const taken = this.bills.filter((b) => b.outlet === outletIdx && b.date === date && !b.voided).reduce((a, b) => a + b.cash, 0);
    const back = this.bills.filter((b) => b.outlet === outletIdx && b.refund?.mode === "cash" && b.refund.date === date).reduce((a, b) => a + b.refund!.minor, 0);
    return taken - back;
  }

  /** The dates one outlet traded on (a bill that was not voided): each needs a closed shift for its month to close. */
  tradingDays(outletIdx: number): string[] {
    return [...new Set(this.bills.filter((b) => b.outlet === outletIdx && !b.voided).map((b) => b.date))].sort();
  }

  /** Queue the month files of bills and one waste file; the caller flushes. */
  queue(): void {
    const { prefix, outlets } = this.#cfg;
    const byMonth = new Map<string, Bill[]>();
    for (const b of this.bills) byMonth.set(b.date.slice(0, 7), [...(byMonth.get(b.date.slice(0, 7)) ?? []), b]);
    for (const [month, bills] of byMonth) {
      for (let i = 0, part = 1; i < bills.length; i += FILE_BILLS, part++) {
        const chunk = bills.slice(i, i + FILE_BILLS);
        const key = `history:bills:${prefix}:${month}${bills.length > FILE_BILLS ? `:${part}` : ""}`;
        importFile(this.#c, key, "pos_bills", `${prefix}-bills-${month}-${part}.csv`, billsFile(chunk, outlets.map((o) => o.outlet.name)), "Synthetic dated history");
      }
    }
    if (this.waste.length) {
      const rows: Array<Array<string | number>> = [["Date", "Time", "Outlet", "Ingredient", "Qty", "Unit", "Reason", "Note"]];
      for (const x of [...this.waste].sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : a.outlet - b.outlet || (a.time < b.time ? -1 : 1)))) {
        rows.push([x.date, x.time, outlets[x.outlet]!.outlet.name, x.ing.name, major(x.qtyMilli, 3), x.ing.unit, x.reason, x.note ?? ""]);
      }
      importFile(this.#c, `history:waste:${prefix}`, "waste_log", `${prefix}-waste.csv`, csv(rows), "Synthetic dated history");
    }
  }
}

const tender = (n: number) => (n === 0 ? "" : major(n));

function billsFile(bills: Bill[], outletNames: string[]): string {
  const rows: Array<Array<string | number>> = [HEADER];
  let sum = 0;
  for (const b of bills) {
    for (const l of b.lines) {
      sum += l.total;
      rows.push([b.no, b.date, b.time, outletNames[b.outlet]!, b.channel, b.brand ?? "", b.type, b.phone ?? "", b.voided ? "void" : "", l.item, "", l.qty, major(l.unit), l.taxClass,
        major(l.disc), major(l.total), b.voided ?? l.voidReason ?? "", tender(b.cash), tender(b.card), tender(b.upi),
        b.refund ? major(b.refund.minor) : "", b.refund?.mode ?? "", b.refund?.reason ?? "", b.refund?.date ?? ""]);
    }
  }
  const t: Array<string | number> = HEADER.map(() => "");
  t[0] = "TOTAL";
  t[15] = major(sum);
  rows.push(t);
  return csv(rows);
}

/** Customer phones for a world: a pool the baseline bills draw from and the named regulars the lapse plants use. IN: +91 then ten digits; AU: +61 4 then eight. */
export const phone = (country: "IN" | "AU", series: number, i: number): string =>
  country === "IN" ? `+91900${series}${String(i).padStart(6, "0")}`.slice(0, 13) : `+61400${series}${String(i).padStart(5, "0")}`.slice(0, 12);

/** Creates the customers history bills refer to (an import never invents a customer: an unknown phone quarantines the bill). */
export async function customers(c: Ctx, country: "IN" | "AU", pool: number, regulars: number): Promise<{ pool: string[]; regulars: string[] }> {
  const out = { pool: Array.from({ length: pool }, (_, i) => phone(country, 1, i + 1)), regulars: Array.from({ length: regulars }, (_, i) => phone(country, 2, i + 1)) };
  for (const [i, p] of out.pool.entries()) await customer(c, `pool:${i + 1}`, `Customer ${String(i + 1).padStart(2, "0")} (synthetic)`, p, 0);
  for (const [i, p] of out.regulars.entries()) await customer(c, `regular:${i + 1}`, `Regular ${i + 1} (synthetic)`, p, 0);
  return out;
}
