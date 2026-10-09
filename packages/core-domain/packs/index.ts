// Country-pack engine (R21, R30). Every country difference — tax classes and rates, inclusive vs
// exclusive display, aggregator tax treatment, receipt title and fields, tax ids, MRP rule, buyer-identity
// threshold, surcharge and payroll scope, locale and date format — is read from the pack document passed
// in. There is no branch on a country here; a scan test fails on any pack literal in this package.
//
// Tax: each line's tax components are computed on that line and rounded half-up separately (the bill
// prints them); the line tax is their sum and totals are sums of rounded lines (03-architecture §1.5).
//   amount = round(qty × (unit price + option price deltas) / 1000); after = amount − line discount
//   exclusive:  component = round(after × rate_c / 10000)                net = after, total = net + tax
//   inclusive:  component = round(after × rate_c / (10000 + rate))       total = after, net = total − tax
// A discount on an inclusive pack is taken off the GROSS (tax-inclusive) amount (W1 fix #53).
import type { ReasonCode } from "@munim/contracts";
import type { CountryPack } from "@munim/contracts/packs";
import { decimalString, formatMoney, money, mulDiv, roundDiv } from "../money/index.ts";
import { localDate } from "../tz/index.ts";

type TaxClass = CountryPack["tax"]["classes"][number];

export type SaleLine = {
  name: string;
  qty_milli: number;
  unit_price_minor: number;
  /** Sum of the selected options' price_delta_minor, per unit (added to the unit price). */
  option_delta_minor?: number;
  /** Line discount in minor units (core-computed; deals, coupons). */
  line_discount_minor?: number;
  tax_class: string | null;
  /** The item's printed MRP. */
  mrp_minor: number | null;
  /** The batch sold, when one was picked: its printed MRP binds instead of the item's (W1 ruling #61). */
  batch?: { mrp_minor: number | null } | null;
};
export type TaxAmount = { code: string; rate_bp: number; amount_minor: number };
export type TaxedLine = {
  line_no: number;
  name: string;
  qty_milli: number;
  /** Unit price including option price deltas. */
  unit_price_minor: number;
  /** qty × unit price as priced (tax-exclusive or tax-inclusive per the pack), before the discount. */
  amount_minor: number;
  discount_minor: number;
  net_minor: number;
  tax_minor: number;
  total_minor: number;
  tax_class: string;
  components: TaxAmount[];
};
export type OrderTax = {
  currency: string;
  lines: TaxedLine[];
  net_minor: number;
  tax_minor: number;
  total_minor: number;
  components: TaxAmount[];
  /** Tax in the merchant's own output-tax liability. */
  own_liability_minor: number;
  /** Tax the aggregator pays instead (pack `tax_treatment: operator_collects_excluded`). */
  operator_liability_minor: number;
};
/** Reason codes of pack refusals (W1 fix #56; contracts-parity test checks them against ReasonCode). */
export const PACK_REFUSAL_CODES = ["unknown_tax_class", "unknown_channel", "price_above_mrp", "tax_id_missing", "buyer_identity_required"] as const satisfies readonly ReasonCode[];
export type Refusal =
  | { reason_code: "unknown_tax_class"; line_no: number; code: string }
  | { reason_code: "unknown_channel"; code: string }
  | { reason_code: "price_above_mrp"; line_no: number }
  /** `problem`: absent, or present but not matching the pack pattern (no valid id either way). */
  | { reason_code: "tax_id_missing"; code: string; problem: "absent" | "pattern" }
  | { reason_code: "buyer_identity_required" };

const AGGREGATOR = /^aggregator:(.+)$/;

function components(pack: CountryPack, cls: TaxClass, amount: number): TaxAmount[] {
  const inclusive = pack.tax.price_display === "inclusive";
  return cls.components.map((c) => ({
    code: c.code,
    rate_bp: c.rate_bp,
    amount_minor: mulDiv(amount, c.rate_bp, inclusive ? 10000 + cls.rate_bp : 10000),
  }));
}

/** The tax-inclusive unit price a buyer pays, for the printed-price (MRP) comparison. */
function inclusiveUnit(pack: CountryPack, cls: TaxClass, unit: number): number {
  if (pack.tax.price_display === "inclusive") return unit;
  return unit + components(pack, cls, unit).reduce((a, c) => a + c.amount_minor, 0);
}

function addInto(acc: TaxAmount[], items: TaxAmount[]): void {
  for (const t of items) {
    const hit = acc.find((x) => x.code === t.code && x.rate_bp === t.rate_bp);
    if (hit) hit.amount_minor += t.amount_minor;
    else acc.push({ ...t });
  }
}

/** Tax for a sale on a channel. Refuses unknown tax classes, aggregators the pack does not list, and
 *  (where the pack has the rule) a line priced above its printed MRP. */
type Aggregator = CountryPack["aggregators"][number];

function aggregatorOf(pack: CountryPack, channel_kind: string): Aggregator | null | undefined {
  const agg = AGGREGATOR.exec(channel_kind);
  return agg ? pack.aggregators.find((x) => x.code === agg[1]) : null; // undefined = not in the pack
}

export function orderTax(pack: CountryPack, sale: { channel_kind: string; lines: readonly SaleLine[] }): { ok: true; tax: OrderTax } | { ok: false; refusal: Refusal } {
  const agg = aggregatorOf(pack, sale.channel_kind);
  if (agg === undefined) return { ok: false, refusal: { reason_code: "unknown_channel", code: sale.channel_kind } };
  const operatorCollects = agg?.tax_treatment === "operator_collects_excluded";
  const lines: TaxedLine[] = [];
  for (const [i, l] of sale.lines.entries()) {
    const line_no = i + 1;
    const code = l.tax_class ?? pack.tax.default_class;
    const cls = pack.tax.classes.find((c) => c.code === code);
    if (!cls) return { ok: false, refusal: { reason_code: "unknown_tax_class", line_no, code } };
    const unit = l.unit_price_minor + (l.option_delta_minor ?? 0);
    // The sold batch's MRP when a batch is picked and carries one, else the item's (INFERENCE for a batch
    // without a printed MRP). Compared with the tax-inclusive unit price before any discount.
    const mrp = l.batch?.mrp_minor ?? l.mrp_minor;
    if (pack.printed_price.rule === "sale_above_mrp_refused" && mrp !== null && inclusiveUnit(pack, cls, unit) > mrp)
      return { ok: false, refusal: { reason_code: "price_above_mrp", line_no } };
    const amount = mulDiv(l.qty_milli, unit, 1000);
    const discount = l.line_discount_minor ?? 0;
    if (discount < 0 || discount > amount) throw new Error(`orderTax: line ${line_no} discount ${discount} outside 0..${amount}`);
    const after = amount - discount;
    const comps = components(pack, cls, after);
    const tax = comps.reduce((a, c) => a + c.amount_minor, 0);
    const inclusive = pack.tax.price_display === "inclusive";
    lines.push({
      line_no,
      name: l.name,
      qty_milli: l.qty_milli,
      unit_price_minor: unit,
      amount_minor: amount,
      discount_minor: discount,
      net_minor: inclusive ? after - tax : after,
      tax_minor: tax,
      total_minor: inclusive ? after : after + tax,
      tax_class: code,
      components: comps,
    });
  }
  const comps: TaxAmount[] = [];
  for (const l of lines) addInto(comps, l.components);
  const total = (k: "net_minor" | "tax_minor" | "total_minor") => lines.reduce((a, l) => a + l[k], 0);
  const tax_minor = total("tax_minor");
  return {
    ok: true,
    tax: {
      currency: pack.currency.code,
      lines,
      net_minor: total("net_minor"),
      tax_minor,
      total_minor: total("total_minor"),
      components: comps,
      own_liability_minor: operatorCollects ? 0 : tax_minor,
      operator_liability_minor: operatorCollects ? tax_minor : 0,
    },
  };
}

export type ReceiptInput = {
  seller: { name: string; address: string; tax_ids: Record<string, string> };
  invoice_no: string;
  issued_at: string;
  tz: string;
  channel_kind: string;
  buyer: { name: string } | null;
  lines: SaleLine[];
};

export type Receipt = {
  /** `record`: the aggregator pays the tax and issues the tax invoice (pack tax_treatment
   *  operator_collects_excluded, e.g. Sec 9(5)) — the merchant prints an order record with no tax lines. */
  kind: "tax_invoice" | "record";
  /** The aggregator's display name on a record. */
  operator: string | null;
  title: string;
  seller: { name: string; address: string };
  tax_ids: Array<{ code: string; label: string; value: string }>;
  invoice_no: string;
  invoice_date: string;
  buyer: { name: string } | null;
  tax: OrderTax;
};

/** Renders a date with the pack's pattern; only the yyyy, MM and dd tokens are understood. */
function formatDate(isoDate: string, pattern: string): string {
  const [y, m, d] = isoDate.split("-");
  if (/[A-Za-z]/.test(pattern.replace(/yyyy|MM|dd/g, ""))) throw new Error(`receipt: unsupported date pattern '${pattern}'`);
  return pattern.replace(/yyyy|MM|dd/g, (t) => (t === "yyyy" ? y! : t === "MM" ? m! : d!));
}

// Invoice field slugs (pack `invoice.required_fields`) → how a built receipt satisfies them. A slug the
// engine does not know throws: a new pack field is never silently ignored. Tax-id fields are linked by the
// pack (`tax_ids[].receipt_field`). The tax and total slugs are satisfied by construction (always printed).
const FIELDS: Record<string, (r: Receipt) => boolean> = {
  seller_name: (r) => r.seller.name.trim() !== "",
  seller_address: (r) => r.seller.address.trim() !== "",
  invoice_no: (r) => r.invoice_no.trim() !== "",
  invoice_date: (r) => r.invoice_date !== "",
  items: (r) => r.tax.lines.length > 0,
  taxable_value: () => true,
  tax_components: () => true,
  gst_amount: () => true,
  total: () => true,
  tax_invoice_words: (r) => r.title.trim() !== "",
};

function fieldPresent(pack: CountryPack, r: Receipt, slug: string): boolean {
  const taxId = pack.tax_ids.find((t) => t.receipt_field === slug);
  if (taxId) return r.tax_ids.some((t) => t.code === taxId.code);
  const check = FIELDS[slug];
  if (!check) throw new Error(`receipt: pack requires invoice field '${slug}' that the engine does not know`);
  return check(r);
}

/** A tax invoice / receipt per the pack, or the refusal that blocks it. */
export function buildReceipt(pack: CountryPack, input: ReceiptInput): { ok: true; receipt: Receipt } | { ok: false; refusal: Refusal } {
  for (const t of pack.tax_ids) {
    const value = input.seller.tax_ids[t.code];
    if (value === undefined || value === "") {
      if (t.required) return { ok: false, refusal: { reason_code: "tax_id_missing", code: t.code, problem: "absent" } };
      continue;
    }
    if (!new RegExp(t.pattern).test(value)) return { ok: false, refusal: { reason_code: "tax_id_missing", code: t.code, problem: "pattern" } };
  }
  const taxed = orderTax(pack, { channel_kind: input.channel_kind, lines: input.lines });
  if (!taxed.ok) return taxed;
  const agg = aggregatorOf(pack, input.channel_kind);
  const record = agg?.tax_treatment === "operator_collects_excluded";
  const threshold = pack.invoice.buyer_identity_above_minor;
  // "above" = strictly greater (the pack marks the > vs ≥ boundary UNVERIFIED). Tax-invoice rule only.
  if (!record && threshold !== null && taxed.tax.total_minor > threshold && !input.buyer) return { ok: false, refusal: { reason_code: "buyer_identity_required" } };
  const receipt: Receipt = {
    kind: record ? "record" : "tax_invoice",
    operator: record ? agg!.display_name : null,
    title: pack.invoice.title,
    seller: { name: input.seller.name, address: input.seller.address },
    tax_ids: pack.tax_ids
      .filter((t) => t.on_receipt && input.seller.tax_ids[t.code])
      .map((t) => ({ code: t.code, label: t.label, value: input.seller.tax_ids[t.code]! })),
    invoice_no: input.invoice_no,
    // The calendar date of issue, not the business date (a sale at 00:15 is dated that day).
    invoice_date: formatDate(localDate(input.issued_at, input.tz), pack.formats.date),
    buyer: input.buyer,
    tax: taxed.tax,
  };
  const missing = record ? [] : pack.invoice.required_fields.filter((f) => !fieldPresent(pack, receipt, f));
  if (missing.length > 0) throw new Error(`receipt: required fields not satisfied: ${missing.join(", ")}`);
  return { ok: true, receipt };
}

/** Plain-text rendering. Words come from the pack (title, tax-id labels, component codes, class labels)
 *  or from `labels` (i18n keys `receipt.*`); numbers from the receipt, formatted by the pack's locale. */
export function renderReceipt(r: Receipt, pack: CountryPack, labels: Record<string, string>): string {
  const L = (key: string) => {
    const s = labels[key];
    if (s === undefined) throw new Error(`receipt: missing label ${key}`);
    return s;
  };
  const cur = pack.currency.code;
  const m = (minor: number) => formatMoney(money(minor, cur), pack);
  const qty = new Intl.NumberFormat(pack.locale, { maximumFractionDigits: 3 });
  const pct = new Intl.NumberFormat(pack.locale, { style: "percent", maximumFractionDigits: 2 });
  const rate = (bp: number) => pct.format(decimalString(bp, 4));
  const record = r.kind === "record";
  const out = [record ? L("receipt.record_title") : r.title, r.seller.name, r.seller.address, ...r.tax_ids.map((t) => `${t.label}: ${t.value}`)];
  out.push(`${L(record ? "receipt.order_no" : "receipt.invoice_no")}: ${r.invoice_no}`, `${L("receipt.date")}: ${r.invoice_date}`);
  if (record) out.push(`${L("receipt.channel")}: ${r.operator}`);
  if (r.buyer) out.push(`${L("receipt.buyer")}: ${r.buyer.name}`);
  out.push("----");
  for (const l of r.tax.lines) {
    out.push(`${l.line_no} ${l.name}`);
    out.push(`  ${qty.format(decimalString(l.qty_milli, 3))} x ${m(l.unit_price_minor)} = ${m(l.amount_minor)}`);
    if (l.discount_minor !== 0) out.push(`  ${L("receipt.discount")} ${m(-l.discount_minor)}`);
    if (record) continue;
    if (l.components.length === 0) out.push(`  ${pack.tax.classes.find((c) => c.code === l.tax_class)!.label}`);
    for (const c of l.components) out.push(`  ${c.code} ${rate(c.rate_bp)} ${m(c.amount_minor)}`);
  }
  out.push("----");
  if (record) {
    out.push(`${L("receipt.total")}: ${m(r.tax.net_minor)}`, `${L("receipt.tax_paid_by")}: ${r.operator}`);
  } else if (pack.tax.price_display === "exclusive") {
    out.push(`${L("receipt.net")}: ${m(r.tax.net_minor)}`);
    for (const c of r.tax.components) out.push(`${c.code} ${rate(c.rate_bp)}: ${m(c.amount_minor)}`);
    out.push(`${L("receipt.tax_total")}: ${m(r.tax.tax_minor)}`, `${L("receipt.total")}: ${m(r.tax.total_minor)}`);
  } else {
    out.push(`${L("receipt.total")}: ${m(r.tax.total_minor)}`);
    for (const c of r.tax.components) out.push(`${L("receipt.includes")} ${c.code} ${rate(c.rate_bp)}: ${m(c.amount_minor)}`);
  }
  return `${out.join("\n")}\n`;
}

/** False when the pack refuses card surcharge lines; `not_applicable` and `allowed` admit them. */
export function cardSurchargeAllowed(pack: CountryPack): boolean {
  return pack.surcharges.card_surcharge !== "prohibited";
}

/** True when payroll runs are drafted for approval; `roster_only` packs have rosters and shifts only. */
export function payrollDrafted(pack: CountryPack): boolean {
  return pack.payroll_scope === "drafts";
}

/** A tender's amount after cash rounding (W1 ruling #59): cash rounds the amount due half-up to the pack's
 *  `cash_rounding_minor`; every other method pays the exact amount. `rounding_minor` (rounded − due) is
 *  recorded on the tender. */
export function cashTender(pack: CountryPack, method: string, due_minor: number): { amount_minor: number; rounding_minor: number } {
  if (method !== "cash") return { amount_minor: due_minor, rounding_minor: 0 };
  const step = pack.cash_rounding_minor;
  const amount = Number(roundDiv(BigInt(due_minor), BigInt(step))) * step;
  return { amount_minor: amount, rounding_minor: amount - due_minor };
}
