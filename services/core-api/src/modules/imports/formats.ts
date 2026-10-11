// File formats (R28). Every format — built-in or a tenant's approved one — is the same thing: a header plus a
// mapping of column → Munim field with the unit the column is written in. Built-in parsers are mappings this
// module ships (aggregator layouts are "-shaped" synthetic layouts, never an operator's real export — pack
// `_unverified`). The mapping grammar is renames + units: no expressions, no arithmetic, no derived columns.
import { createHash } from "node:crypto";
import type { ImportKind } from "@munim/contracts/imports";

export type FieldType = "text" | "money" | "date" | "decimal";
export type Field = { type: FieldType; required: boolean };
export type MappingEntry = { source: string; target: string; unit?: string | undefined };

const t = (required = false): Field => ({ type: "text", required });
const m = (required = false): Field => ({ type: "money", required });
const d = (required = false): Field => ({ type: "date", required });
const n = (required = false): Field => ({ type: "decimal", required });

/** The Munim fields each kind of file can fill. A tenant mapping must cover every required one. */
export const FIELDS: Record<ImportKind, Record<string, Field>> = {
  payout_statement: {
    channel_code: t(true), payout_ref: t(true), period_from: d(true), period_to: d(true), paid_on: d(), outlet: t(),
    order_ref: t(), order_date: d(), line_kind: t(true), gross: m(), commission: m(), ad_fee: m(), promo_share: m(),
    tax_withheld: m(), net: m(true), currency: t(),
  },
  bank_statement: {
    txn_date: d(true), reference: t(true), narration: t(), mode: t(true), payee_vpa: t(), amount: m(true), account: t(true),
    outlet: t(), currency: t(),
  },
  tally_export: {
    voucher_date: d(true), voucher_type: t(true), voucher_no: t(true), ledger: t(true), party: t(true), amount: m(true), tax: m(),
    narration: t(), outlet: t(), currency: t(),
  },
  pos_export: {
    bill_no: t(true), bill_date: d(true), outlet: t(true), order_type: t(), payment_mode: t(), subtotal: m(true), discount: m(),
    tax: m(), total: m(true), currency: t(),
  },
  market_signal: {
    on_date: d(true), kind: t(true), label: t(true), outlet: t(), value: { type: "decimal", required: false }, unit: t(), source: t(true),
  },
  // History (R44b): one row per bill line; the bill's own columns repeat on each of its lines and must agree.
  pos_bills: {
    bill_no: t(true), bill_date: d(true), bill_time: t(), outlet: t(true), channel: t(), brand: t(), order_type: t(true),
    customer_phone: t(), bill_status: t(), item_code: t(true), variant_code: t(), qty: n(true), unit_price: m(true), tax_class: t(),
    line_discount: m(), line_total: m(true), void_reason: t(), cash: m(), card: m(), upi: m(), refund: m(), refund_mode: t(),
    refund_reason: t(), refund_date: d(), currency: t(),
  },
  waste_log: {
    waste_date: d(true), waste_time: t(), outlet: t(true), ingredient: t(true), qty: n(true), unit: t(true), reason: t(true), note: t(),
  },
  // T-093: one row per closed drawer session. `cash_tenders` is the file's net cash taken in the shift: a control only.
  shift_log: {
    shift_no: t(true), shift_date: d(true), outlet: t(true), opened_at: t(true), closed_at: t(true), opened_by: t(true), closed_by: t(true),
    float: m(true), counted_cash: m(true), cash_tenders: m(true),
  },
  // T-093: one row per counted ingredient; the count's own columns repeat on each of its rows and must agree.
  stock_count: {
    count_no: t(true), count_date: d(true), count_time: t(), outlet: t(true), counted_by: t(true), ingredient: t(true), qty: n(true), unit: t(true), batch: t(),
  },
};

/** The field whose TOTAL row is the file's printed control total (none for market signals). */
export const CONTROL_FIELD: Record<ImportKind, string | null> = {
  payout_statement: "net", bank_statement: "amount", tally_export: "amount", pos_export: "total", market_signal: null,
  pos_bills: "line_total", waste_log: null, shift_log: null, stock_count: null,
};

/** Units a column may be declared in. Money: the currency's major or minor unit (named or generic). */
export const MONEY_UNITS: Record<string, { scale: "major" | "minor"; currency: string | null }> = {
  major: { scale: "major", currency: null },
  minor: { scale: "minor", currency: null },
  rupees: { scale: "major", currency: "INR" },
  paise: { scale: "minor", currency: "INR" },
  dollars: { scale: "major", currency: "AUD" },
  cents: { scale: "minor", currency: "AUD" },
};
export const DATE_UNITS = ["date_dmy", "date_ymd", "date_mdy"] as const;
export const DECIMAL_UNITS = ["decimal"] as const;

/** sha256 over the trimmed, lower-cased header cells joined by U+001F: the same layout always hashes the same. */
export function headerSignature(header: readonly string[]): string {
  return createHash("sha256").update(header.map((h) => h.trim().toLowerCase()).join("\u001f"), "utf8").digest("hex");
}

export type MappingProblem = "source_not_in_header" | "duplicate_target" | "unknown_target" | "unit_invalid" | "required_field_unmapped";

/** Why a mapping is not a pure rename + unit for this kind and header, or null. A source must be a header
 *  cell verbatim, so "Gross - Commission" or any other expression is refused unless the file literally has
 *  that column (in which case it is just that column's name). */
export function checkMapping(kind: ImportKind, header: readonly string[], mapping: readonly MappingEntry[], fixed: readonly string[] = []): MappingProblem | null {
  const fields = FIELDS[kind];
  const cells = new Set(header);
  const seen = new Set<string>();
  for (const e of mapping) {
    const keys = Object.keys(e);
    if (keys.some((k) => k !== "source" && k !== "target" && k !== "unit")) return "unit_invalid";
    if (!cells.has(e.source)) return "source_not_in_header";
    const f = Object.hasOwn(fields, e.target) ? fields[e.target] : undefined;
    if (!f) return "unknown_target";
    if (seen.has(e.target)) return "duplicate_target";
    seen.add(e.target);
    const ok = f.type === "money" ? e.unit !== undefined && Object.hasOwn(MONEY_UNITS, e.unit)
      : f.type === "date" ? (DATE_UNITS as readonly string[]).includes(e.unit ?? "")
      : f.type === "decimal" ? (DECIMAL_UNITS as readonly string[]).includes(e.unit ?? "")
      : e.unit === undefined;
    if (!ok) return "unit_invalid";
  }
  for (const [name, f] of Object.entries(fields)) if (f.required && !seen.has(name) && !fixed.includes(name)) return "required_field_unmapped";
  return null;
}

export interface BuiltIn {
  parser: string;
  kind: ImportKind;
  /** Country packs that offer it (aggregator layouts are pack-listed); null = every pack. */
  countries: readonly string[] | null;
  header: readonly string[];
  mapping: readonly MappingEntry[];
  /** Field values the layout implies (e.g. which aggregator a payout file is from). */
  fixed: Readonly<Record<string, string>>;
  /** Value renames for this layout: field → file text (lower-cased) → Munim value. */
  labels: Readonly<Record<string, Readonly<Record<string, string>>>>;
}

const map = (pairs: ReadonlyArray<readonly [string, string, string?]>): MappingEntry[] =>
  pairs.map(([source, target, unit]) => (unit ? { source, target, unit } : { source, target }));
const headerOf = (mp: readonly MappingEntry[], extra: readonly string[] = []) => [...mp.map((e) => e.source), ...extra];

const swiggyMap = map([
  ["Payout Ref", "payout_ref"], ["Cycle Start", "period_from", "date_dmy"], ["Cycle End", "period_to", "date_dmy"],
  ["Paid On", "paid_on", "date_dmy"], ["Outlet", "outlet"], ["Order No", "order_ref"], ["Order Date", "order_date", "date_dmy"],
  ["Line Type", "line_kind"], ["Order Value (Rs)", "gross", "rupees"], ["Commission (Rs)", "commission", "rupees"],
  ["Ads (Rs)", "ad_fee", "rupees"], ["Discount Share (Rs)", "promo_share", "rupees"], ["GST Withheld (Rs)", "tax_withheld", "rupees"],
  ["Net Payable (Rs)", "net", "rupees"],
]);
const zomatoMap = map([
  ["settlement_id", "payout_ref"], ["period_from", "period_from", "date_ymd"], ["period_to", "period_to", "date_ymd"],
  ["settled_on", "paid_on", "date_ymd"], ["outlet_name", "outlet"], ["order_id", "order_ref"], ["order_date", "order_date", "date_ymd"],
  ["entry_type", "line_kind"], ["bill_amount_paise", "gross", "paise"], ["platform_fee_paise", "commission", "paise"],
  ["ads_fee_paise", "ad_fee", "paise"], ["promo_paise", "promo_share", "paise"], ["tax_deducted_paise", "tax_withheld", "paise"],
  ["payout_paise", "net", "paise"], ["currency", "currency"],
]);
const ubereatsMap = map([
  ["Statement ID", "payout_ref"], ["Period Start", "period_from", "date_dmy"], ["Period End", "period_to", "date_dmy"],
  ["Payment Date", "paid_on", "date_dmy"], ["Store", "outlet"], ["Order ID", "order_ref"], ["Date", "order_date", "date_dmy"],
  ["Type", "line_kind"], ["Sales (incl. GST)", "gross", "dollars"], ["Service Fee", "commission", "dollars"],
  ["Marketing", "ad_fee", "dollars"], ["Offers", "promo_share", "dollars"], ["Tax Withheld", "tax_withheld", "dollars"],
  ["Payout", "net", "dollars"], ["Currency", "currency"],
]);
const doordashMap = map([
  ["payout_id", "payout_ref"], ["start_date", "period_from", "date_ymd"], ["end_date", "period_to", "date_ymd"],
  ["payout_date", "paid_on", "date_ymd"], ["store_name", "outlet"], ["order_ref", "order_ref"], ["order_date", "order_date", "date_ymd"],
  ["transaction_type", "line_kind"], ["subtotal_cents", "gross", "cents"], ["commission_cents", "commission", "cents"],
  ["marketing_cents", "ad_fee", "cents"], ["promotion_cents", "promo_share", "cents"], ["withheld_cents", "tax_withheld", "cents"],
  ["net_cents", "net", "cents"],
]);
const bankMap = map([
  ["Txn Date", "txn_date", "date_dmy"], ["Reference", "reference"], ["Narration", "narration"], ["Mode", "mode"],
  ["Payee VPA", "payee_vpa"], ["Amount", "amount", "major"], ["Currency", "currency"], ["Account", "account"], ["Outlet", "outlet"],
]);
const posMap = map([
  ["Bill No", "bill_no"], ["Bill Date", "bill_date", "date_ymd"], ["Outlet", "outlet"], ["Order Type", "order_type"],
  ["Payment Mode", "payment_mode"], ["Subtotal", "subtotal", "major"], ["Discount", "discount", "major"], ["Tax", "tax", "major"],
  ["Total", "total", "major"],
]);
const tallyMap = map([
  ["Date", "voucher_date", "date_dmy"], ["Voucher Type", "voucher_type"], ["Voucher No", "voucher_no"], ["Ledger", "ledger"],
  ["Party", "party"], ["Amount", "amount", "major"], ["GST", "tax", "major"], ["Narration", "narration"], ["Cost Centre", "outlet"],
]);
// History layouts (R44b). Money in the currency's major unit; Unit Price in the pack's price display (tax-exclusive
// for IN, tax-inclusive for AU); Line Total is the other POS's figure, checked against core's own (never used).
const posBillsMap = map([
  ["Bill No", "bill_no"], ["Bill Date", "bill_date", "date_ymd"], ["Bill Time", "bill_time"], ["Outlet", "outlet"], ["Channel", "channel"],
  ["Brand", "brand"], ["Order Type", "order_type"], ["Customer Phone", "customer_phone"], ["Bill Status", "bill_status"],
  ["Item Code", "item_code"], ["Variant Code", "variant_code"], ["Qty", "qty", "decimal"], ["Unit Price", "unit_price", "major"],
  ["Tax Class", "tax_class"], ["Line Discount", "line_discount", "major"], ["Line Total", "line_total", "major"], ["Void Reason", "void_reason"],
  ["Cash", "cash", "major"], ["Card", "card", "major"], ["UPI", "upi", "major"], ["Refund", "refund", "major"], ["Refund Mode", "refund_mode"],
  ["Refund Reason", "refund_reason"], ["Refund Date", "refund_date", "date_ymd"],
]);
const wasteMap = map([
  ["Date", "waste_date", "date_ymd"], ["Time", "waste_time"], ["Outlet", "outlet"], ["Ingredient", "ingredient"], ["Qty", "qty", "decimal"],
  ["Unit", "unit"], ["Reason", "reason"], ["Note", "note"],
]);
// T-093 layouts. Money in the currency's major unit; times are the outlet's wall clock (HH:MM) on the business date.
const shiftMap = map([
  ["Shift No", "shift_no"], ["Date", "shift_date", "date_ymd"], ["Outlet", "outlet"], ["Opened At", "opened_at"], ["Closed At", "closed_at"],
  ["Opened By", "opened_by"], ["Closed By", "closed_by"], ["Float", "float", "major"], ["Counted Cash", "counted_cash", "major"],
  ["Cash Tenders", "cash_tenders", "major"],
]);
const countMap = map([
  ["Count No", "count_no"], ["Date", "count_date", "date_ymd"], ["Time", "count_time"], ["Outlet", "outlet"], ["Counted By", "counted_by"],
  ["Ingredient", "ingredient"], ["Counted Qty", "qty", "decimal"], ["Unit", "unit"], ["Batch", "batch"],
]);
const marketMap = map([
  ["on_date", "on_date", "date_ymd"], ["kind", "kind"], ["label", "label"], ["outlet_ref", "outlet"], ["value", "value", "decimal"],
  ["unit", "unit"], ["source", "source"],
]);

const PAYOUT_LABELS = {
  swiggy: { order: "order", ads: "ad_fee", "discount share": "promo_share", adjustment: "adjustment" },
  zomato: { order: "order", ads: "ad_fee", promo: "promo_share", adjustment: "adjustment", other: "other" },
  ubereats: { order: "order", marketing: "ad_fee", offer: "promo_share", adjustment: "adjustment" },
  doordash: { delivery: "order", marketing_fee: "ad_fee", promotion: "promo_share", adjustment: "adjustment" },
};

/** Built-in parsers (names as the country packs list them; pos/bank/tally/market are pack-neutral). */
export const BUILT_INS: readonly BuiltIn[] = [
  { parser: "swiggy_orders_v1", kind: "payout_statement", countries: ["IN"], header: headerOf(swiggyMap), mapping: swiggyMap,
    fixed: { channel_code: "swiggy" }, labels: { line_kind: PAYOUT_LABELS.swiggy } },
  { parser: "zomato_orders_v1", kind: "payout_statement", countries: ["IN"], header: headerOf(zomatoMap), mapping: zomatoMap,
    fixed: { channel_code: "zomato" }, labels: { line_kind: PAYOUT_LABELS.zomato } },
  { parser: "ubereats_statement_v1", kind: "payout_statement", countries: ["AU"], header: headerOf(ubereatsMap), mapping: ubereatsMap,
    fixed: { channel_code: "ubereats" }, labels: { line_kind: PAYOUT_LABELS.ubereats } },
  { parser: "doordash_statement_v1", kind: "payout_statement", countries: ["AU"], header: headerOf(doordashMap), mapping: doordashMap,
    fixed: { channel_code: "doordash" }, labels: { line_kind: PAYOUT_LABELS.doordash } },
  { parser: "bank_statement_v1", kind: "bank_statement", countries: null, header: headerOf(bankMap), mapping: bankMap, fixed: {},
    labels: { mode: { pos: "card", chq: "cheque", cash: "cash_deposit", chg: "fee", transfer: "bank_transfer" } } },
  { parser: "pos_export_v1", kind: "pos_export", countries: null, header: headerOf(posMap), mapping: posMap, fixed: {}, labels: {} },
  { parser: "tally_export_v1", kind: "tally_export", countries: null, header: headerOf(tallyMap), mapping: tallyMap, fixed: {}, labels: {} },
  { parser: "market_signal_v1", kind: "market_signal", countries: null, header: headerOf(marketMap), mapping: marketMap, fixed: {}, labels: {} },
  { parser: "pos_bills_v2", kind: "pos_bills", countries: null, header: headerOf(posBillsMap), mapping: posBillsMap, fixed: {}, labels: {} },
  { parser: "waste_log_v1", kind: "waste_log", countries: null, header: headerOf(wasteMap), mapping: wasteMap, fixed: {}, labels: {} },
  { parser: "shift_log_v1", kind: "shift_log", countries: null, header: headerOf(shiftMap), mapping: shiftMap, fixed: {}, labels: {} },
  { parser: "stock_count_v1", kind: "stock_count", countries: null, header: headerOf(countMap), mapping: countMap, fixed: {}, labels: {} },
];

export const builtInBySignature = (sig: string): BuiltIn | undefined => BUILT_INS.find((b) => headerSignature(b.header) === sig);
export const builtInByParser = (parser: string): BuiltIn | undefined => BUILT_INS.find((b) => b.parser === parser);
