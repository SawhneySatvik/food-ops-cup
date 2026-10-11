// Dated history files (R44b, 0018): what the parser checks before a person sees the preview. A history row keeps its
// own business date, so it is refused (quarantined, with a reason) when that date is the outlet's current business
// date or later (it would take a number from the live day's ticket series) or falls in a closed period (the books of
// that month are final). Everything a row names — outlet, channel, brand, item, variant, customer, ingredient, tax
// class, payment and refund modes — must already exist; nothing is guessed (D4). Money is never taken from the file:
// line tax and totals are core-domain's (orderTax, the same rule a live sale uses), and the file's own Line Total is
// only compared with them. The checks run as munim_svc inside parseRun; they read, never write.
import type { CountryPack } from "@munim/contracts/packs";
import { mulDiv } from "@munim/core-domain/money";
import { orderTax, type TaxedLine } from "@munim/core-domain/packs";
import { businessDate, localToInstant } from "@munim/core-domain/tz";
import type { Queryable } from "../../runtoken/index.ts";
import type { RowOutcome, Staged } from "./rows.ts";

type Value = string | number | null;
type Row = Record<string, Value>;

export interface HistoryCtx {
  pack: CountryPack;
  /** outlet id → zone, business-day cutoff (HH:MM) and its business date now. */
  outlets: Map<string, { tz: string; cutoff: string; today: string }>;
  /** channel kind → channel id (active first, then oldest). */
  channels: Map<string, string>;
  brands: Map<string, string[]>;
  /** barcode, and lower-cased name_key → items with it. */
  items: Map<string, Array<{ id: string; kind: string; mrp_minor: number | null }>>;
  /** `<item id>␟<barcode or name_key>` → variant ids. */
  variants: Map<string, string[]>;
  /** E.164 phone → live, unmerged customer ids. */
  customers: Map<string, string[]>;
  ingredients: Map<string, Array<{ id: string; base_unit: string; tracked: boolean }>>;
  /** Active members by lower-cased name (shift and count files name people; core resolves them). */
  members: Map<string, string[]>;
  closed: Array<{ month: string; outlet_id: string | null }>;
  /** `<channel id>␟<external_ref>` already in the books (an import of the same bill twice). */
  existing: Set<string>;
}

const add = <K, V>(m: Map<K, V[]>, k: K, v: V) => m.set(k, [...(m.get(k) ?? []), v]);
const SEP = "\u001f";

/** Everything the history checks read, in a handful of queries (munim_svc, the run's tenant). */
export async function loadHistoryCtx(c: Queryable, refs: readonly string[]): Promise<HistoryCtx> {
  const pack = (await c.query<{ doc: CountryPack }>(
    `SELECT p.doc FROM core.tenant t JOIN platform.country_pack p ON p.code = t.country_code AND p.status = 'active'
      WHERE t.tenant_id = current_setting('app.tenant_id')::uuid ORDER BY p.version DESC LIMIT 1`)).rows[0]!.doc;
  const h: HistoryCtx = {
    pack, outlets: new Map(), channels: new Map(), brands: new Map(), items: new Map(), variants: new Map(), customers: new Map(),
    ingredients: new Map(), members: new Map(), closed: [], existing: new Set(),
  };
  const now = (await c.query<{ now: Date }>(`SELECT now() AS now`)).rows[0]!.now;
  for (const o of (await c.query<{ id: string; tz: string; cutoff: string }>(
    `SELECT id, tz, to_char(business_day_cutoff, 'HH24:MI') AS cutoff FROM core.outlet`)).rows) {
    h.outlets.set(o.id, { tz: o.tz, cutoff: o.cutoff, today: businessDate(now, o.tz, o.cutoff) });
  }
  for (const ch of (await c.query<{ id: string; kind: string }>(`SELECT id, kind FROM core.channel ORDER BY active DESC, created_at, id`)).rows) {
    if (!h.channels.has(ch.kind)) h.channels.set(ch.kind, ch.id);
  }
  for (const b of (await c.query<{ id: string; name: string }>(`SELECT id, name FROM core.brand`)).rows) add(h.brands, b.name.trim().toLowerCase(), b.id);
  for (const i of (await c.query<{ id: string; kind: string; name_key: string; barcode: string | null; mrp_minor: string | null }>(
    `SELECT id, kind, name_key, barcode, mrp_minor::text FROM core.item`)).rows) {
    const it = { id: i.id, kind: i.kind, mrp_minor: i.mrp_minor === null ? null : Number(i.mrp_minor) };
    add(h.items, i.name_key, it);
    if (i.barcode !== null && i.barcode !== i.name_key) add(h.items, i.barcode, it);
  }
  for (const v of (await c.query<{ id: string; item_id: string; name_key: string; barcode: string | null }>(
    `SELECT id, item_id, name_key, barcode FROM core.variant`)).rows) {
    add(h.variants, `${v.item_id}${SEP}${v.name_key}`, v.id);
    if (v.barcode !== null && v.barcode !== v.name_key) add(h.variants, `${v.item_id}${SEP}${v.barcode}`, v.id);
  }
  for (const cu of (await c.query<{ id: string; phone: string }>(
    `SELECT id, phone FROM core.customer WHERE phone IS NOT NULL AND erased_at IS NULL AND merged_into IS NULL`)).rows) add(h.customers, cu.phone, cu.id);
  for (const g of (await c.query<{ id: string; name: string; base_unit: string; tracked_by_batch: boolean }>(
    `SELECT id, name, base_unit, tracked_by_batch FROM core.ingredient`)).rows) {
    add(h.ingredients, g.name.trim().toLowerCase(), { id: g.id, base_unit: g.base_unit, tracked: g.tracked_by_batch });
  }
  for (const m of (await c.query<{ id: string; name: string }>(`SELECT id, name FROM core.member WHERE active`)).rows) add(h.members, m.name.trim().toLowerCase(), m.id);
  h.closed = (await c.query<{ month: string; outlet_id: string | null }>(
    `SELECT period_month::text AS month, outlet_id FROM core.period_close`)).rows;
  if (refs.length) {
    for (const o of (await c.query<{ channel_id: string; external_ref: string }>(
      `SELECT channel_id, external_ref FROM core."order" WHERE external_ref = ANY ($1::text[])`, [refs])).rows) {
      h.existing.add(`${o.channel_id}${SEP}${o.external_ref}`);
    }
  }
  return h;
}

/** The month of `date` is closed for this outlet (its own close, or a tenant-wide one) — the MB009 test. */
export const periodClosed = (h: HistoryCtx, outletId: string, date: string): boolean =>
  h.closed.some((p) => p.month === `${date.slice(0, 7)}-01` && (p.outlet_id === null || p.outlet_id === outletId));

/** Why a dated history row may not land on `date` at this outlet, or null. */
export function dateRefusal(h: HistoryCtx, outletId: string, date: string): string | null {
  const o = h.outlets.get(outletId)!;
  if (date >= o.today) return "date_not_past";
  if (periodClosed(h, outletId, date)) return "period_closed";
  return null;
}

const HHMM = /^([01]\d|2[0-3]):[0-5]\d$/;
const CODE = /^[a-z][a-z0-9_]*$/;

/** The instant a business date + local wall time names at this outlet (a time before the cutoff belongs to the next
 *  calendar day); null when that instant would not fall on the business date (a DST gap) or the time is unreadable. */
export function instantOf(h: HistoryCtx, outletId: string, date: string, time: string | null): string | null {
  const o = h.outlets.get(outletId)!;
  const t = time ?? "12:00";
  if (!HHMM.test(t)) return null;
  const day = t < o.cutoff ? new Date(Date.parse(`${date}T00:00:00Z`) + 86_400_000).toISOString().slice(0, 10) : date;
  const at = localToInstant(day, t, o.tz);
  return businessDate(at, o.tz, o.cutoff) === date ? at.toISOString() : null;
}

export const one = <V>(m: Map<string, V[]>, k: string | null): V | undefined => {
  if (k === null) return undefined;
  const hit = m.get(k);
  return hit?.length === 1 ? hit[0] : undefined;
};

// ---- POS bills (pos_bills_v2) -----------------------------------------------------------------------------------

const ORDER_KINDS = ["dine_in", "takeaway", "pickup", "delivery"] as const;
const METHODS = ["cash", "card", "upi"] as const;
/** Bill-level columns: the same on every line of one bill. */
const BILL_FIELDS = ["bill_date", "bill_time", "outlet", "channel", "brand", "order_type", "customer_phone", "bill_status", "cash", "card", "upi",
  "refund", "refund_mode", "refund_reason", "refund_date"] as const;

interface BillRow { line: number; v: Row; out?: RowOutcome }

/** One file → one outcome per row. A bill is staged whole or not at all: when any of its rows fails, its other rows
 *  are quarantined `bill_rejected`. */
export function checkBills(rows: ReadonlyArray<{ line: number; v: Row }>, outletIdOf: (name: Value | undefined) => string | undefined, h: HistoryCtx): RowOutcome[] {
  const no = (reason: string): RowOutcome => ({ ok: false, reason });
  const s = (v: Row, k: string) => (v[k] === null || v[k] === undefined ? null : String(v[k]).trim());
  const lower = (v: Row, k: string) => s(v, k)?.toLowerCase() ?? null;
  const n = (v: Row, k: string) => (v[k] ?? 0) as number;

  const bills = new Map<string, BillRow[]>();
  const all: BillRow[] = rows.map((r) => ({ line: r.line, v: r.v }));
  for (const r of all) add(bills, String(r.v.bill_no).trim(), r);

  for (const [billNo, lines] of bills) {
    const fail = (bad: Map<BillRow, string>) => {
      for (const r of lines) r.out = no(bad.get(r) ?? "bill_rejected");
    };
    const head = lines[0]!.v;
    // 1. The bill's own columns agree on every line (a bill number repeated across outlets or days lands here).
    const key = (v: Row) => JSON.stringify(BILL_FIELDS.map((k) => v[k] ?? null)) + (lower(v, "bill_status") === "void" ? `|${s(v, "void_reason")}` : "");
    if (lines.some((r) => key(r.v) !== key(head))) {
      fail(new Map(lines.map((r) => [r, "bill_header_differs"])));
      continue;
    }
    // 2. The bill's header.
    const outletId = outletIdOf(head.outlet);
    const channelKind = lower(head, "channel") ?? "counter";
    const channelId = h.channels.get(channelKind);
    const brandName = lower(head, "brand");
    const brandId = brandName === null ? null : one(h.brands, brandName);
    const kind = lower(head, "order_type");
    const phone = s(head, "customer_phone");
    const customerId = phone === null ? null : one(h.customers, phone);
    const statusText = lower(head, "bill_status");
    const status = statusText === null || statusText === "completed" ? "completed" : statusText === "void" ? "cancelled" : null;
    const refund = n(head, "refund");
    const refundMode = lower(head, "refund_mode");
    const refundReason = lower(head, "refund_reason");
    const tenders = METHODS.map((m) => ({ method: m, amount_minor: n(head, m) }));
    const headReason =
      !outletId ? "outlet_unknown"
      : !channelId ? "channel_unknown"
      : brandId === undefined ? "brand_unknown"
      : !(ORDER_KINDS as readonly string[]).includes(kind ?? "") ? "order_type_unknown"
      : customerId === undefined ? "customer_unknown"
      : status === null ? "bill_status_unknown"
      : dateRefusal(h, outletId, String(head.bill_date))
        ?? (h.existing.has(`${channelId}${SEP}${billNo}`) ? "already_imported" : null)
        ?? (tenders.some((t) => t.amount_minor < 0) || refund < 0 ? "amount_negative" : null)
        ?? (refund > 0 && !(METHODS as readonly string[]).includes(refundMode ?? "") ? "refund_mode_unknown" : null)
        ?? (refund > 0 && !CODE.test(refundReason ?? "") ? "refund_reason_invalid" : null)
        ?? (refund === 0 && (refundMode !== null || refundReason !== null || head.refund_date !== null) ? "refund_amount_missing" : null)
        ?? null;
    if (headReason) {
      fail(new Map(lines.map((r) => [r, headReason])));
      continue;
    }
    const at = instantOf(h, outletId!, String(head.bill_date), s(head, "bill_time"));
    const refundDate = head.refund_date === null || head.refund_date === undefined ? String(head.bill_date) : String(head.refund_date);
    const refundAt = refund > 0 ? instantOf(h, outletId!, refundDate, s(head, "bill_time")) : null;
    const timeReason = !at || (refund > 0 && !refundAt) ? "time_unreadable"
      : refund > 0 && refundDate < String(head.bill_date) ? "refund_before_bill"
      : refund > 0 ? dateRefusal(h, outletId!, refundDate) : null;
    if (timeReason) {
      fail(new Map(lines.map((r) => [r, timeReason])));
      continue;
    }

    // 3. Each line: item, variant, quantity, price, tax class, void reason.
    const bad = new Map<BillRow, string>();
    const resolved = lines.map((r) => {
      const code = s(r.v, "item_code")!;
      const item = one(h.items, code) ?? one(h.items, code.toLowerCase());
      const vcode = s(r.v, "variant_code");
      const variantId = !item || vcode === null ? null
        : one(h.variants, `${item.id}${SEP}${vcode}`) ?? one(h.variants, `${item.id}${SEP}${vcode.toLowerCase()}`);
      const qty = n(r.v, "qty");
      const unit = n(r.v, "unit_price");
      const discount = n(r.v, "line_discount");
      const taxClass = lower(r.v, "tax_class") ?? h.pack.tax.default_class;
      const voidReason = status === "completed" ? lower(r.v, "void_reason") : null;
      const why = !item ? "item_unknown"
        : variantId === undefined ? "variant_unknown"
        : qty <= 0 ? "qty_invalid"
        : unit < 0 || discount < 0 ? "amount_negative"
        : discount > mulDiv(qty, unit, 1000) ? "discount_exceeds_amount"
        : !h.pack.tax.classes.some((c) => c.code === taxClass) ? "tax_class_unknown"
        : voidReason !== null && !CODE.test(voidReason) ? "void_reason_invalid"
        : null;
      if (why) bad.set(r, why);
      return { r, item, variantId: variantId ?? null, qty, unit, discount, taxClass, voidReason };
    });
    if (bad.size) {
      fail(bad);
      continue;
    }
    // 4. Tax and totals are core's (orderTax over the bill's lines, item MRPs); the file's Line Total must match.
    const priced = orderTax(h.pack, { channel_kind: channelKind, lines: resolved.map((l, i) => ({
      name: String(i + 1), qty_milli: l.qty, unit_price_minor: l.unit, line_discount_minor: l.discount, tax_class: l.taxClass, mrp_minor: l.item!.mrp_minor,
    })) });
    if (!priced.ok) {
      const which = "line_no" in priced.refusal ? lines[priced.refusal.line_no - 1]! : lines[0]!;
      fail(new Map([[which, priced.refusal.reason_code === "unknown_channel" ? "channel_unknown" : priced.refusal.reason_code]]));
      continue;
    }
    const taxed: TaxedLine[] = priced.tax.lines;
    for (const [i, r] of lines.entries()) if (n(r.v, "line_total") !== taxed[i]!.total_minor) bad.set(r, "total_mismatch");
    if (bad.size) {
      fail(bad);
      continue;
    }
    // 5. Money in: tenders cover the bill exactly (an aggregator collects itself; a void bill took nothing).
    const total = priced.tax.total_minor;
    const paid = tenders.reduce((a, t) => a + t.amount_minor, 0);
    const aggregator = channelKind.startsWith("aggregator:");
    const voidReason = status === "cancelled" ? lower(head, "void_reason") : null;
    const moneyReason =
      status === "cancelled" ? (paid > 0 || refund > 0 ? "void_bill_paid" : !CODE.test(voidReason ?? "") ? "void_reason_invalid" : null)
      : aggregator ? (paid > 0 ? "tender_on_aggregator" : refund > total ? "refund_exceeds_paid" : null)
      : paid !== total ? "tender_mismatch"
      : refund > paid ? "refund_exceeds_paid"
      : null;
    if (moneyReason) {
      fail(new Map(lines.map((r) => [r, moneyReason])));
      continue;
    }
    for (const [i, l] of resolved.entries()) {
      const t = taxed[i]!;
      const data: Record<string, Value> = {
        bill_no: billNo, bill_date: String(head.bill_date), at, outlet_id: outletId!, channel_id: channelId!, channel_kind: channelKind,
        brand_id: brandId ?? null, kind, customer_id: customerId ?? null, status, line_no: i + 1, item_id: l.item!.id, variant_id: l.variantId,
        qty_milli: l.qty, unit_price_minor: t.unit_price_minor, tax_class: l.taxClass, line_discount_minor: t.discount_minor,
        line_tax_minor: t.tax_minor, line_total_minor: t.total_minor, void_reason: status === "cancelled" ? voidReason : l.voidReason,
        cash_minor: tenders[0]!.amount_minor, card_minor: tenders[1]!.amount_minor, upi_minor: tenders[2]!.amount_minor,
        refund_minor: refund, refund_method: refund > 0 ? refundMode : null, refund_reason: refund > 0 ? refundReason : null, refund_at: refundAt,
      };
      const row: Staged = { target_table: "core.order_line", amount_minor: t.total_minor, external_ref: billNo, data };
      l.r.out = { ok: true, row };
    }
  }
  return all.map((r) => r.out!);
}

// ---- Waste (waste_log_v1) ---------------------------------------------------------------------------------------

const WASTE_REASONS = ["temperature", "overprep", "expired", "damaged", "other"] as const;

export function checkWaste(v: Row, outletIdOf: (name: Value | undefined) => string | undefined, h: HistoryCtx): RowOutcome {
  const no = (reason: string): RowOutcome => ({ ok: false, reason });
  const s = (k: string) => (v[k] === null || v[k] === undefined ? null : String(v[k]).trim());
  const outletId = outletIdOf(v.outlet);
  if (!outletId) return no("outlet_unknown");
  const ing = one(h.ingredients, s("ingredient")!.toLowerCase());
  if (!ing) return no("ingredient_unknown");
  const qty = (v.qty ?? 0) as number;
  if (qty <= 0) return no("qty_invalid");
  if (s("unit")!.toLowerCase() !== ing.base_unit) return no("unit_mismatch");
  const reason = s("reason")!.toLowerCase();
  if (!(WASTE_REASONS as readonly string[]).includes(reason)) return no("reason_unknown");
  if (reason === "other" && s("note") === null) return no("note_missing");
  const date = String(v.waste_date);
  const refused = dateRefusal(h, outletId, date);
  if (refused) return no(refused);
  const at = instantOf(h, outletId, date, s("waste_time"));
  if (!at) return no("time_unreadable");
  return { ok: true, row: { target_table: "core.waste_log", amount_minor: null, external_ref: null, data: {
    waste_date: date, at, outlet_id: outletId, ingredient_id: ing.id, qty_milli: qty, unit: ing.base_unit, reason, note: s("note"),
  } } };
}
