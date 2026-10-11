// One file row → one staged row or one quarantine reason. Reading a value means reading it in its declared
// unit (a rupee amount "1,234.50" is 123450 paise; a date in day-month-year order) — the only conversions a
// mapping can ask for (R28). The checks below compare what the file says against itself and the books; they
// never fill in or recompute a figure: a row whose net does not equal its parts is quarantined, not fixed.
import type { ImportKind } from "@munim/contracts/imports";
import { DATE_UNITS, FIELDS, MONEY_UNITS, type MappingEntry } from "./formats.ts";
import { dateRefusal, type HistoryCtx } from "./history.ts";

export type Staged = { target_table: string; data: Record<string, unknown>; amount_minor: number | null; external_ref: string | null };
export type RowOutcome = { ok: true; row: Staged } | { ok: false; reason: string };
type Value = string | number | null;

export interface RowContext {
  kind: ImportKind;
  currency: string;
  /** Digits of the currency's minor unit (country pack). */
  minorDigits: number;
  /** Outlet name (trimmed, lower-cased) → ids with that name. */
  outlets: Map<string, string[]>;
  /** aggregator channel code → channel id (payout files). */
  channels: Map<string, string>;
  /** Keys already in the books: `payout:<channel>:<ref>`, `bank:<account>:<ref>`. */
  existing: Set<string>;
  labels: Readonly<Record<string, Readonly<Record<string, string>>>>;
  fixed: Readonly<Record<string, string>>;
  /** Dated rows (POS exports and the history kinds): channels, existing bills, outlet business dates, closed periods. */
  history?: HistoryCtx;
}

const MAX_SAFE = BigInt(Number.MAX_SAFE_INTEGER);

/** A money cell in its declared unit → minor units; null when empty; "bad" when it is not a plain amount. */
export function readMoney(raw: string, unit: string, digits: number): number | null | "bad" {
  const s = raw.trim();
  if (s === "") return null;
  const u = MONEY_UNITS[unit];
  if (!u) return "bad";
  const m = u.scale === "minor" ? /^(-?)(\d+)$/.exec(s) : /^(-?)(\d{1,3}(?:,\d{2,3})+|\d+)(?:\.(\d+))?$/.exec(s);
  if (!m) return "bad";
  const frac = m[3] ?? "";
  if (frac.length > digits) return "bad";
  const whole = BigInt(m[2]!.replaceAll(",", ""));
  const v = u.scale === "minor" ? whole : whole * 10n ** BigInt(digits) + BigInt(frac.padEnd(digits, "0") || "0");
  if (v > MAX_SAFE) return "bad";
  return m[1] === "-" && v !== 0n ? -Number(v) : Number(v);
}

/** A date cell in its declared order → ISO yyyy-mm-dd (a real calendar date), null when empty, "bad" otherwise. */
export function readDate(raw: string, unit: string): string | null | "bad" {
  const s = raw.trim();
  if (s === "") return null;
  const m = unit === "date_ymd" ? /^(\d{4})[-/](\d{1,2})[-/](\d{1,2})$/.exec(s) : /^(\d{1,2})[-/](\d{1,2})[-/](\d{4})$/.exec(s);
  if (!m) return "bad";
  const [y, mo, d] = unit === "date_ymd" ? [m[1]!, m[2]!, m[3]!] : unit === "date_dmy" ? [m[3]!, m[2]!, m[1]!] : [m[3]!, m[1]!, m[2]!];
  const iso = `${y}-${mo.padStart(2, "0")}-${d.padStart(2, "0")}`;
  const dt = new Date(`${iso}T00:00:00Z`);
  return Number.isNaN(dt.getTime()) || dt.toISOString().slice(0, 10) !== iso ? "bad" : iso;
}

/** A decimal cell → thousandths (market signal values), null when empty, "bad" otherwise. */
export function readMilli(raw: string): number | null | "bad" {
  const s = raw.trim();
  if (s === "") return null;
  const m = /^(-?)(\d+)(?:\.(\d{1,3}))?$/.exec(s);
  if (!m) return "bad";
  const v = BigInt(m[2]!) * 1000n + BigInt((m[3] ?? "").padEnd(3, "0"));
  if (v > MAX_SAFE) return "bad";
  return m[1] === "-" && v !== 0n ? -Number(v) : Number(v);
}

/** Header cell (normalised) of each mapped source → its column index; undefined when a source is missing. */
export function columnIndex(header: readonly string[], mapping: readonly MappingEntry[]): Map<string, number> | undefined {
  const norm = (s: string) => s.trim().toLowerCase();
  const out = new Map<string, number>();
  for (const e of mapping) {
    const i = header.findIndex((h) => norm(h) === norm(e.source));
    if (i < 0) return undefined;
    out.set(e.target, i);
  }
  return out;
}

/** Reads every mapped field of one record in its unit. Fields are read in mapping order; the first failure is the reason. */
export function readFields(cells: readonly string[], cols: Map<string, number>, mapping: readonly MappingEntry[], ctx: RowContext):
  { ok: true; v: Record<string, Value> } | { ok: false; reason: string } {
  const fields = FIELDS[ctx.kind];
  const v: Record<string, Value> = {};
  for (const [k, x] of Object.entries(ctx.fixed)) v[k] = x;
  for (const e of mapping) {
    const raw = cells[cols.get(e.target)!] ?? "";
    const f = fields[e.target]!;
    let val: Value | "bad";
    if (f.type === "money") val = readMoney(raw, e.unit!, ctx.minorDigits);
    else if (f.type === "date") val = (DATE_UNITS as readonly string[]).includes(e.unit!) ? readDate(raw, e.unit!) : "bad";
    else if (f.type === "decimal") val = readMilli(raw);
    else val = raw.trim() === "" ? null : raw.trim();
    if (val === "bad") return { ok: false, reason: f.type === "date" ? "date_unreadable" : "amount_unreadable" };
    v[e.target] = val;
  }
  for (const [name, f] of Object.entries(fields)) if (f.required && (v[name] ?? null) === null) return { ok: false, reason: "field_missing" };
  return { ok: true, v };
}

const label = (ctx: RowContext, field: string, value: string, canonical: readonly string[]): string | undefined => {
  const key = value.trim().toLowerCase();
  const hit = ctx.labels[field]?.[key];
  if (hit) return hit;
  return canonical.includes(key) ? key : undefined;
};

/** Outlet by exact name (case-insensitive). Two outlets with one name cannot be told apart: unknown. */
export function outletOf(ctx: RowContext, name: Value): { id: string | null } | undefined {
  if (name === null) return { id: null };
  const ids = ctx.outlets.get(String(name).trim().toLowerCase());
  return ids?.length === 1 ? { id: ids[0]! } : undefined;
}

const POS_KINDS: readonly string[] = ["dine_in", "takeaway", "pickup", "delivery"];
const POS_METHODS: readonly string[] = ["cash", "card", "upi"];
const LINE_KINDS = ["order", "ad_fee", "promo_share", "adjustment", "other"] as const;
const METHODS = ["upi", "card", "bank_transfer", "neft", "imps", "rtgs", "cash_deposit", "cheque", "fee", "other"] as const;
const SIGNAL_KINDS = ["weather", "festival", "holiday", "local_event", "competitor_price", "other"] as const;
const VPA = /^[A-Za-z0-9._-]{2,255}@[A-Za-z][A-Za-z0-9]{1,63}$/;
/** Tally ledger names (lower-cased) → expense category; any other ledger is `other`. */
const LEDGER_CATEGORY: Record<string, string> = {
  rent: "rent", electricity: "utilities", water: "utilities", internet: "utilities", "gas cylinder": "utilities",
  repairs: "repairs", maintenance: "repairs", advertising: "marketing", marketing: "marketing", packaging: "packaging",
  "packing material": "packaging", "bank charges": "bank_charges", "professional fees": "professional_fees", "audit fees": "professional_fees",
};

/** The file-level state a row is checked against (duplicates within the file, one payout's header fields). */
export class RowChecker {
  readonly #seen = new Set<string>();
  readonly #payouts = new Map<string, string>();
  readonly ctx: RowContext;
  constructor(ctx: RowContext) {
    this.ctx = ctx;
  }

  #dup(key: string): boolean {
    if (this.#seen.has(key)) return true;
    this.#seen.add(key);
    return false;
  }

  build(v: Record<string, Value>): RowOutcome {
    const ctx = this.ctx;
    const no = (reason: string): RowOutcome => ({ ok: false, reason });
    if (v.currency !== undefined && v.currency !== null && String(v.currency).toUpperCase() !== ctx.currency) return no("currency_differs");
    const n = (k: string) => (v[k] ?? 0) as number;
    const s = (k: string) => (v[k] ?? null) as string | null;
    switch (ctx.kind) {
      case "payout_statement": {
        const channel = ctx.channels.get(String(v.channel_code).toLowerCase());
        if (!channel) return no("channel_missing");
        const kind = label(ctx, "line_kind", String(v.line_kind), LINE_KINDS);
        if (!kind) return no("line_kind_unknown");
        const outlet = outletOf(ctx, s("outlet"));
        if (!outlet) return no("outlet_unknown");
        if (s("period_to")! < s("period_from")!) return no("period_invalid");
        const parts = ["commission", "ad_fee", "promo_share", "tax_withheld"].map(n);
        if (parts.some((x) => x < 0) || (kind === "order" && n("gross") < 0)) return no("amount_negative");
        if (n("net") !== n("gross") - parts.reduce((a, b) => a + b, 0)) return no("net_mismatch");
        const ref = s("payout_ref")!;
        if (ctx.existing.has(`payout:${channel}:${ref}`)) return no("already_imported");
        const head = JSON.stringify([s("period_from"), s("period_to"), s("paid_on"), outlet.id]);
        if ((this.#payouts.get(ref) ?? head) !== head) return no("payout_header_differs");
        this.#payouts.set(ref, head);
        if (this.#dup(`${ref}\u001f${kind}\u001f${s("order_ref") ?? ""}`)) return no("duplicate_row");
        return { ok: true, row: { target_table: "core.settlement_line", amount_minor: n("net"), external_ref: s("order_ref"), data: {
          channel_id: channel, payout_ref: ref, period_from: s("period_from"), period_to: s("period_to"), paid_on: s("paid_on"),
          outlet_id: outlet.id, order_ref: s("order_ref"), order_date: s("order_date"), line_kind: kind, gross_minor: n("gross"),
          commission_minor: n("commission"), ad_fee_minor: n("ad_fee"), promo_share_minor: n("promo_share"),
          tax_withheld_minor: n("tax_withheld"), net_minor: n("net"),
        } } };
      }
      case "bank_statement": {
        const method = label(ctx, "mode", String(v.mode), METHODS);
        if (!method) return no("mode_unknown");
        if (n("amount") === 0) return no("amount_zero");
        const vpa = s("payee_vpa");
        if (vpa !== null && (!VPA.test(vpa) || method !== "upi")) return no("vpa_invalid");
        const outlet = outletOf(ctx, s("outlet"));
        if (!outlet) return no("outlet_unknown");
        const key = `bank:${s("account")}:${s("reference")}`;
        if (ctx.existing.has(key)) return no("already_imported");
        if (this.#dup(key)) return no("duplicate_row");
        return { ok: true, row: { target_table: "core.bank_line", amount_minor: n("amount"), external_ref: s("reference"), data: {
          account_ref: s("account"), value_date: s("txn_date"), amount_minor: n("amount"), method, payee_vpa: vpa,
          narration: s("narration"), external_ref: s("reference"), outlet_id: outlet.id,
        } } };
      }
      case "tally_export": {
        if (String(v.voucher_type).trim().toLowerCase() !== "payment") return no("voucher_type_unsupported");
        if (n("amount") <= 0) return no("amount_not_positive");
        if (n("tax") < 0) return no("amount_negative");
        if (n("tax") > n("amount")) return no("tax_exceeds_amount");
        const outlet = outletOf(ctx, s("outlet"));
        if (!outlet) return no("outlet_unknown");
        if (this.#dup(`voucher:${s("voucher_no")}`)) return no("duplicate_row");
        return { ok: true, row: { target_table: "core.expense", amount_minor: n("amount"), external_ref: s("voucher_no"), data: {
          category: LEDGER_CATEGORY[String(v.ledger).trim().toLowerCase()] ?? "other", incurred_on: s("voucher_date"),
          amount_minor: n("amount"), tax_minor: n("tax"), payee: s("party"), note: s("narration"), outlet_id: outlet.id,
          voucher_no: s("voucher_no"), ledger: s("ledger"),
        } } };
      }
      case "pos_export": {
        const h = ctx.history!;
        const outlet = outletOf(ctx, s("outlet"));
        if (!outlet?.id) return no("outlet_unknown");
        if (["subtotal", "discount", "tax", "total"].some((k) => n(k) < 0)) return no("amount_negative");
        if (n("total") !== n("subtotal") - n("discount") + n("tax")) return no("total_mismatch");
        // D4: an order type or payment mode this layout does not name is quarantined, never guessed (an unknown mode
        // would leave the sale's receivable open for ever); a blank order type is a takeaway, as before.
        const kind = (s("order_type") ?? "takeaway").toLowerCase();
        if (!POS_KINDS.includes(kind)) return no("order_type_unknown");
        const method = (s("payment_mode") ?? "").toLowerCase();
        if (n("total") > 0 && !POS_METHODS.includes(method)) return no("payment_mode_unknown");
        const refused = dateRefusal(h, outlet.id, s("bill_date")!);
        if (refused) return no(refused);
        // D4: bills are unique per channel (core.order external_ref), not per outlet — a number repeated across outlets is
        // quarantined here instead of failing the whole approval on the unique index.
        if (h.existing.has(`${h.channels.get("counter")}\u001f${s("bill_no")}`)) return no("already_imported");
        if (this.#dup(`bill:${s("bill_no")}`)) return no("duplicate_row");
        return { ok: true, row: { target_table: "core.order", amount_minor: n("total"), external_ref: s("bill_no"), data: {
          bill_no: s("bill_no"), bill_date: s("bill_date"), outlet_id: outlet.id, order_type: kind,
          payment_mode: n("total") > 0 ? method : null, subtotal_minor: n("subtotal"), discount_minor: n("discount"), tax_minor: n("tax"),
          total_minor: n("total"),
        } } };
      }
      case "market_signal": {
        const kind = String(v.kind).trim().toLowerCase();
        if (!(SIGNAL_KINDS as readonly string[]).includes(kind)) return no("kind_unknown");
        // A competitor price names an item and a price; this layout carries neither (0012 CHECK).
        if (kind === "competitor_price") return no("kind_unsupported");
        if (!/^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)*$/.test(String(v.label))) return no("label_invalid");
        const value = (v.value ?? null) as number | null;
        const unit = s("unit");
        if ((value === null) !== (unit === null)) return no("unit_missing");
        if (unit !== null && !/^[a-z][a-z0-9_]{0,15}$/.test(unit)) return no("unit_invalid");
        const outlet = outletOf(ctx, s("outlet"));
        if (!outlet) return no("outlet_unknown");
        return { ok: true, row: { target_table: "core.market_signal", amount_minor: null, external_ref: null, data: {
          on_date: s("on_date"), kind, label: v.label, outlet_id: outlet.id, value_milli: value, unit, source: s("source"),
        } } };
      }
      case "pos_bills":
      case "waste_log":
      case "shift_log":
      case "stock_count":
        throw new Error("imports: history kinds are checked by history.ts");
    }
  }
}
