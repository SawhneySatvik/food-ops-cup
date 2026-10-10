// postFor (W2 seam, T-026): the derived journal entry for one source row under one seeded posting rule,
// written inside the CALLER's transaction (the module that owns the source row's lifecycle calls it right
// after the row reaches the rule's source state). The book guard admits the entry only as that derivation:
// app.posting_rule + app.source_ref name the rule and row, and core.derivation_rule.source_state must hold
// (e.g. an order 'completed', an invoice 'approved', a settlement whose import run is 'committed').
//   • one entry per (rule, source): a second call returns the existing entry and writes nothing;
//   • nothing to post (every line 0, e.g. a fully discounted order) → no entry;
//   • the entry balances per currency (checked here by core-domain, then by the deferred DB trigger, which
//     is fired at the end of this call so an imbalance surfaces at the call site, not at the caller's COMMIT);
//   • corrections are reversals (reverseFor), never edits;
//   • a source that leaves its posted state (an approved invoice disputed or voided, an approved payroll voided)
//     is reversed under its own reversal rule (reverseSource, 0015 A6); re-approved, postFor re-posts it as the
//     reversal of that reversal (db/README "Journal re-post after a reversal").
import type { CountryPack } from "@munim/contracts/packs";
import {
  type ChannelTreatment, channelTreatment, type ExpenseCategory, type Line, POSTING_RULES, type PostingRuleId, postAdvance, postExpense, postGrn,
  postLoyaltyRedemption, postOrder, postPayroll, postRefund, postSettlement, postSupplierInvoice, postTender, roleResolver, type TenderMethod,
} from "@munim/core-domain/finance";
import { mulDiv } from "@munim/core-domain/money";
import { businessDate } from "@munim/core-domain/tz";
import { uuidv7 } from "../../commit/index.ts";
import type { Queryable } from "../../runtoken/index.ts";

export type Tx = Queryable;

/** An entry's header fields (its date decides the period; outlet / brand / channel are the P&L keys). `memo_key`
 *  labels an entry moved out of a closed month (lateDated). */
type Header = { entry_date: string; outlet_id: string | null; brand_id: string | null; channel_id: string | null; currency: string; memo_key?: string };
type Derived = { header: Header; lines: Line[] | null };

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const n = (v: string | number | null | undefined): number => (v === null || v === undefined ? 0 : Number(v));

/** The tenant's active country pack document (the same row the order-numbering trigger reads). */
export async function tenantPack(tx: Tx): Promise<CountryPack> {
  const r = await tx.query<{ doc: CountryPack }>(
    `SELECT p.doc FROM core.tenant t JOIN platform.country_pack p ON p.code = t.country_code AND p.status = 'active'
      WHERE t.tenant_id = current_setting('app.tenant_id')::uuid ORDER BY p.version DESC LIMIT 1`);
  if (!r.rows[0]) throw new Error("finance: no active country pack for this tenant");
  return r.rows[0].doc;
}

const one = async <R extends Record<string, unknown>>(tx: Tx, sql: string, id: string): Promise<R> => {
  const r = await tx.query<R>(sql, [id]);
  if (!r.rows[0]) throw new Error("finance: source row not found");
  return r.rows[0];
};

const hhmm = (t: string) => t.slice(0, 5);
/** Last day of the month that starts on `first` (YYYY-MM-01). */
const monthEnd = (first: string) => {
  const d = new Date(`${first}T00:00:00Z`);
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0)).toISOString().slice(0, 10);
};

type OrderRow = {
  status: string; outlet_id: string; brand_id: string | null; channel_id: string; business_date: string; total_minor: string; tax_minor: string;
  loyalty_minor: string; currency: string; kind: string;
};
// loyalty_minor: the points' value the order's pricing snapshot applied, standing only while the snapshot names this
// order's unreversed redeem row in core.loyalty_entry — the same rule (and figure) orders uses for what the till is
// owed (orders/money.ts), so the order's receivable and its tenders net to zero and the value traces to the ledger.
const ORDER_SQL = `SELECT o.status, o.outlet_id, o.brand_id, o.channel_id, o.business_date::text AS business_date, o.total_minor, o.tax_minor,
                          CASE WHEN EXISTS (SELECT 1 FROM core.loyalty_entry e WHERE e.tenant_id = o.tenant_id AND e.order_id = o.id AND e.kind = 'redeem'
                                              AND e.id::text = o.pricing_snapshot -> 'loyalty' ->> 'entry_id'
                                              AND -e.points = coalesce((o.pricing_snapshot -> 'loyalty' ->> 'points')::bigint, 0)
                                              AND NOT EXISTS (SELECT 1 FROM core.loyalty_entry x WHERE x.tenant_id = e.tenant_id AND x.reverses_id = e.id))
                               THEN coalesce((o.pricing_snapshot -> 'loyalty' ->> 'value_minor')::bigint, 0) ELSE 0 END AS loyalty_minor,
                          o.currency, ch.kind
                     FROM core."order" o JOIN core.channel ch ON ch.tenant_id = o.tenant_id AND ch.id = o.channel_id WHERE o.id = $1`;

/** R2-S3-5: a supplier's invoice or a channel's payout is dated by its sender, so one can arrive for a month already
 *  closed. Its first posting then lands on the first day of the next open month (the same closed-month test as the
 *  database's MB009 trigger), labelled with its own date in memo_key (the Tally narration). Dates in open months
 *  are unchanged. */
async function lateDated(tx: Tx, h: Header): Promise<Header> {
  const closed = async (d: string) => (await tx.query<{ c: boolean }>(
    `SELECT EXISTS (SELECT 1 FROM core.period_close pc WHERE pc.period_month = date_trunc('month', $1::date)::date
                       AND (pc.outlet_id IS NULL OR $2::uuid IS NULL OR pc.outlet_id = $2::uuid)) AS c`, [d, h.outlet_id])).rows[0]!.c;
  if (!(await closed(h.entry_date))) return h;
  let d = h.entry_date;
  do {
    d = (await tx.query<{ d: string }>(`SELECT (date_trunc('month', $1::date) + interval '1 month')::date::text AS d`, [d])).rows[0]!.d;
  } while (await closed(d));
  return { ...h, entry_date: d, memo_key: `finance.closed_period.from_${h.entry_date.replaceAll("-", "_")}` };
}

// Units a purchase quantity converts between exactly (the same table purchasing and inventory use); any other
// pair is not matched, never guessed.
const BASE_FACTORS: Record<string, Record<string, number>> = { kg: { g: 1000 }, l: { ml: 1000 } };
const toBase = (unit: string, base: string): number | null => (unit === base ? 1 : BASE_FACTORS[unit]?.[base] ?? null);

/** R2-S1-6: how much of an invoice's subtotal is cost rather than GRNI (the rest settles GRNI). Per invoice line:
 *    • not goods (no ingredient, no PO line — delivery and the like): the whole line is cost;
 *    • goods matched to receipts (same PO line, else same PO + ingredient): GRNI is settled by the GRN value of the
 *      quantity it bills that was received and not already billed by another approved invoice (cumulative, so
 *      rounding never drifts); the line's price/quantity variance against that value is cost;
 *    • goods billed beyond what was received, with no PO or no receipt to match, or in a unit that does not
 *      convert: none of it — the billed amount stays in GRNI for the receipt that will credit it (INFERENCE: an
 *      invoice ahead of its goods; an invoice with no lines settles GRNI with its whole subtotal, as before). */
async function invoiceCost(tx: Tx, invoiceId: string, poId: string | null): Promise<number> {
  const lines = await tx.query<{ id: string; po_line_id: string | null; ingredient_id: string | null; qty_milli: string; unit: string; unit_price_minor: string; base_unit: string | null }>(
    `SELECT l.id, l.po_line_id, coalesce(l.ingredient_id, pl.ingredient_id) AS ingredient_id, l.qty_milli, l.unit, l.unit_price_minor, ing.base_unit
       FROM core.supplier_invoice_line l
       LEFT JOIN core.po_line pl ON pl.tenant_id = l.tenant_id AND pl.id = l.po_line_id
       LEFT JOIN core.ingredient ing ON ing.tenant_id = l.tenant_id AND ing.id = coalesce(l.ingredient_id, pl.ingredient_id)
      WHERE l.supplier_invoice_id = $1 ORDER BY l.line_no`, [invoiceId]);
  let cost = 0;
  for (const l of lines.rows) {
    const billed = mulDiv(n(l.qty_milli), n(l.unit_price_minor), 1000);
    if (!l.ingredient_id || !l.base_unit) {
      cost += billed;
      continue;
    }
    const base = l.base_unit;
    // The pool a line draws on: its PO line, else its PO's receipts of the same ingredient.
    const byLine = l.po_line_id !== null;
    const key = byLine ? l.po_line_id : poId;
    const fi = toBase(l.unit, base);
    if (!key || fi === null) continue;
    const got = await tx.query<{ qty_milli: string; unit: string; unit_cost_minor: string }>(
      `SELECT g.qty_milli, g.unit, g.unit_cost_minor FROM core.grn_line g JOIN core.goods_received r ON r.tenant_id = g.tenant_id AND r.id = g.goods_received_id
        WHERE g.ingredient_id = $2 AND ${byLine ? "g.po_line_id = $1" : "r.po_id = $1"}`, [key, l.ingredient_id]);
    const before = await tx.query<{ qty_milli: string; unit: string }>(
      `SELECT x.qty_milli, x.unit FROM core.supplier_invoice_line x JOIN core.supplier_invoice i ON i.tenant_id = x.tenant_id AND i.id = x.supplier_invoice_id
         LEFT JOIN core.po_line pl ON pl.tenant_id = x.tenant_id AND pl.id = x.po_line_id
        WHERE i.status = 'approved' AND i.id <> $3 AND coalesce(x.ingredient_id, pl.ingredient_id) = $2
          AND ${byLine ? "x.po_line_id = $1" : "i.po_id = $1 AND x.po_line_id IS NULL"}`,
      [key, l.ingredient_id, invoiceId]);
    const qty = (rows: Array<{ qty_milli: string; unit: string }>) =>
      rows.reduce<number | null>((a, r) => (a === null || toBase(r.unit, base) === null ? null : a + n(r.qty_milli) * toBase(r.unit, base)!), 0);
    const received = qty(got.rows);
    const prior = qty(before.rows);
    if (received === null || prior === null || received === 0) continue;
    const value = got.rows.reduce((a, g) => a + mulDiv(n(g.qty_milli), n(g.unit_cost_minor), 1000), 0);
    const want = n(l.qty_milli) * fi;
    const matched = Math.max(Math.min(want, received - prior), 0);
    const cleared = mulDiv(Math.min(prior + matched, received), value, received) - mulDiv(Math.min(prior, received), value, received);
    cost += (matched === want ? billed : mulDiv(billed, matched, want)) - cleared;
  }
  return cost;
}

/** Each rule: read the source row(s) the caller can see, compute the lines in core-domain. */
const DERIVE: Record<PostingRuleId, (tx: Tx, id: string, pack: CountryPack, input_tax: boolean) => Promise<Derived>> = {
  async "finance.post_order"(tx, id, pack) {
    const o = await one<OrderRow>(tx, ORDER_SQL, id);
    return {
      header: { entry_date: o.business_date, outlet_id: o.outlet_id, brand_id: o.brand_id, channel_id: o.channel_id, currency: o.currency },
      lines: postOrder({ ...channelTreatment(pack, o.kind), total_minor: n(o.total_minor), tax_minor: n(o.tax_minor) }),
    };
  },
  async "finance.post_loyalty_redemption"(tx, id, pack) {
    const o = await one<OrderRow>(tx, ORDER_SQL, id);
    return {
      header: { entry_date: o.business_date, outlet_id: o.outlet_id, brand_id: o.brand_id, channel_id: o.channel_id, currency: o.currency },
      lines: postLoyaltyRedemption({ aggregator: channelTreatment(pack, o.kind).aggregator, value_minor: n(o.loyalty_minor) }),
    };
  },
  async "finance.post_tender"(tx, id, pack) {
    const t = await one<{ order_id: string; method: TenderMethod; amount_minor: string; rounding_minor: string; at: Date; currency: string; tz: string; cutoff: string }>(tx,
      `SELECT t.order_id, t.method, t.amount_minor, t.rounding_minor, t.at, t.currency, ou.tz, ou.business_day_cutoff::text AS cutoff
         FROM core.tender t JOIN core.outlet ou ON ou.tenant_id = t.tenant_id AND ou.id = t.outlet_id WHERE t.id = $1`, id);
    const o = await one<OrderRow>(tx, ORDER_SQL, t.order_id);
    return {
      header: { entry_date: businessDate(t.at, t.tz, hhmm(t.cutoff)), outlet_id: o.outlet_id, brand_id: o.brand_id, channel_id: o.channel_id, currency: t.currency },
      lines: postTender({ aggregator: channelTreatment(pack, o.kind).aggregator, method: t.method, amount_minor: n(t.amount_minor), rounding_minor: n(t.rounding_minor) }),
    };
  },
  async "finance.post_refund"(tx, id, pack) {
    // prior: the order's other refunds already posted — the tax share is cumulative (R2-S3-2). Refunds of one
    // order are serialised by the order row lock (orders/money.ts), so "already posted" is "recorded before".
    // posted: whether the order's sale was ever posted (finance.post_order) — a refund before completion (paid, refunded,
    // cancelled: R2 P4) reverses only the tender's clearing.
    const f = await one<{ order_id: string; method: TenderMethod; amount_minor: string; at: Date; currency: string; tz: string; cutoff: string; prior: string; posted: boolean }>(tx,
      `SELECT f.order_id, f.method, f.amount_minor, f.at, f.currency, ou.tz, ou.business_day_cutoff::text AS cutoff,
              (SELECT coalesce(sum(x.amount_minor), 0) FROM core.refund x WHERE x.tenant_id = f.tenant_id AND x.order_id = f.order_id AND x.id <> f.id
                  AND EXISTS (SELECT 1 FROM core.journal_entry je WHERE je.tenant_id = x.tenant_id AND je.posting_rule = 'finance.post_refund'
                                AND je.source_type = 'core.refund' AND je.source_id = x.id AND je.reverses_id IS NULL)) AS prior,
              EXISTS (SELECT 1 FROM core.journal_entry je WHERE je.tenant_id = f.tenant_id AND je.posting_rule = 'finance.post_order'
                         AND je.source_type = 'core.order' AND je.source_id = f.order_id AND je.reverses_id IS NULL) AS posted
         FROM core.refund f JOIN core.outlet ou ON ou.tenant_id = f.tenant_id AND ou.id = f.outlet_id WHERE f.id = $1`, id);
    const o = await one<OrderRow>(tx, ORDER_SQL, f.order_id);
    const tr = channelTreatment(pack, o.kind);
    return {
      header: { entry_date: businessDate(f.at, f.tz, hhmm(f.cutoff)), outlet_id: o.outlet_id, brand_id: o.brand_id, channel_id: o.channel_id, currency: f.currency },
      lines: postRefund({ aggregator: tr.aggregator, operator_collects: tr.operator_collects, method: f.method, amount_minor: n(f.amount_minor),
        order_total_minor: n(o.total_minor), order_tax_minor: n(o.tax_minor), prior_refunded_minor: n(f.prior), sale_posted: f.posted }),
    };
  },
  async "finance.post_grn"(tx, id) {
    const g = await one<{ outlet_id: string; received_at: Date; tz: string; cutoff: string }>(tx,
      `SELECT g.outlet_id, g.received_at, ou.tz, ou.business_day_cutoff::text AS cutoff
         FROM core.goods_received g JOIN core.outlet ou ON ou.tenant_id = g.tenant_id AND ou.id = g.outlet_id WHERE g.id = $1`, id);
    const lines = await tx.query<{ qty_milli: string; unit_cost_minor: string; currency: string }>(
      `SELECT qty_milli, unit_cost_minor, currency FROM core.grn_line WHERE goods_received_id = $1 ORDER BY id`, [id]);
    const currencies = [...new Set(lines.rows.map((l) => l.currency))];
    if (currencies.length > 1) throw new Error("finance: a goods-received note in more than one currency");
    return {
      header: { entry_date: businessDate(g.received_at, g.tz, hhmm(g.cutoff)), outlet_id: g.outlet_id, brand_id: null, channel_id: null, currency: currencies[0] ?? "" },
      lines: postGrn({ lines: lines.rows.map((l) => ({ qty_milli: n(l.qty_milli), unit_cost_minor: n(l.unit_cost_minor) })) }),
    };
  },
  async "finance.post_supplier_invoice"(tx, id, _pack, input_tax) {
    // A single-outlet PO gives the invoice its outlet (P&L key); otherwise it is tenant-wide.
    const i = await one<{ invoice_date: string; subtotal_minor: string; tax_minor: string; total_minor: string; currency: string; po_id: string | null; outlet_ids: string[] | null }>(tx,
      `SELECT i.invoice_date::text AS invoice_date, i.subtotal_minor, i.tax_minor, i.total_minor, i.currency, i.po_id, po.outlet_ids
         FROM core.supplier_invoice i LEFT JOIN core.purchase_order po ON po.tenant_id = i.tenant_id AND po.id = i.po_id WHERE i.id = $1`, id);
    const outlet = i.outlet_ids?.length === 1 ? i.outlet_ids[0]! : null;
    return {
      header: await lateDated(tx, { entry_date: i.invoice_date, outlet_id: outlet, brand_id: null, channel_id: null, currency: i.currency }),
      lines: postSupplierInvoice({ subtotal_minor: n(i.subtotal_minor), tax_minor: n(i.tax_minor), total_minor: n(i.total_minor), input_tax,
        grni_minor: n(i.subtotal_minor) - (await invoiceCost(tx, id, i.po_id)) }),
    };
  },
  async "finance.post_settlement"(tx, id, pack) {
    const s = await one<{ channel_id: string; outlet_id: string | null; on: string; net_minor: string; currency: string; kind: string }>(tx,
      `SELECT s.channel_id, s.outlet_id, coalesce(s.paid_on, s.period_to)::text AS on, s.net_minor, s.currency, ch.kind
         FROM core.settlement s JOIN core.channel ch ON ch.tenant_id = s.tenant_id AND ch.id = s.channel_id WHERE s.id = $1`, id);
    const lines = await tx.query<Record<string, string>>(
      `SELECT gross_minor, commission_minor, ad_fee_minor, promo_share_minor, tax_withheld_minor, net_minor
         FROM core.settlement_line WHERE settlement_id = $1 ORDER BY line_no`, [id]);
    const tr: ChannelTreatment = channelTreatment(pack, s.kind);
    return {
      header: await lateDated(tx, { entry_date: s.on, outlet_id: s.outlet_id, brand_id: null, channel_id: s.channel_id, currency: s.currency }),
      lines: postSettlement({ ...tr, net_minor: n(s.net_minor), lines: lines.rows.map((l) => ({
        gross_minor: n(l.gross_minor), commission_minor: n(l.commission_minor), ad_fee_minor: n(l.ad_fee_minor),
        promo_share_minor: n(l.promo_share_minor), tax_withheld_minor: n(l.tax_withheld_minor), net_minor: n(l.net_minor),
      })) }),
    };
  },
  async "finance.post_expense"(tx, id, _pack, input_tax) {
    const e = await one<{ outlet_id: string | null; category: ExpenseCategory; incurred_on: string; amount_minor: string; tax_minor: string; currency: string }>(tx,
      `SELECT outlet_id, category, incurred_on::text AS incurred_on, amount_minor, tax_minor, currency FROM core.expense WHERE id = $1`, id);
    return {
      header: { entry_date: e.incurred_on, outlet_id: e.outlet_id, brand_id: null, channel_id: null, currency: e.currency },
      lines: postExpense({ category: e.category, amount_minor: n(e.amount_minor), tax_minor: n(e.tax_minor), input_tax }),
    };
  },
  async "finance.post_advance"(tx, id) {
    const a = await one<{ kind: "given" | "recovered"; amount_minor: string; currency: string; on_date: string; via_payroll: boolean; outlet_id: string }>(tx,
      `SELECT a.kind, a.amount_minor, a.currency, a.on_date::text AS on_date, a.payroll_draft_id IS NOT NULL AS via_payroll, s.outlet_id
         FROM core.advance a JOIN core.staff s ON s.tenant_id = a.tenant_id AND s.id = a.staff_id WHERE a.id = $1`, id);
    return {
      header: { entry_date: a.on_date, outlet_id: a.outlet_id, brand_id: null, channel_id: null, currency: a.currency },
      lines: postAdvance({ kind: a.kind, amount_minor: n(a.amount_minor), via_payroll: a.via_payroll }),
    };
  },
  async "finance.post_payroll"(tx, id) {
    const p = await one<{ outlet_id: string; period_month: string; currency: string }>(tx,
      `SELECT outlet_id, period_month::text AS period_month, currency FROM core.payroll_draft WHERE id = $1`, id);
    const lines = await tx.query<Record<string, string>>(
      `SELECT base_minor, overtime_minor, tips_minor, advance_recovery_minor, net_minor FROM core.payroll_draft_line WHERE payroll_draft_id = $1 ORDER BY id`, [id]);
    return {
      header: { entry_date: monthEnd(p.period_month), outlet_id: p.outlet_id, brand_id: null, channel_id: null, currency: p.currency },
      lines: postPayroll({ lines: lines.rows.map((l) => ({ base_minor: n(l.base_minor), overtime_minor: n(l.overtime_minor), tips_minor: n(l.tips_minor),
        advance_recovery_minor: n(l.advance_recovery_minor), net_minor: n(l.net_minor) })) }),
    };
  },
};

export function parseSourceRef(rule: string, sourceRef: string): { rule: PostingRuleId; table: string; id: string } {
  if (!(rule in POSTING_RULES)) throw new Error(`finance: '${rule}' is not a posting rule`);
  const table = POSTING_RULES[rule as PostingRuleId];
  const [t, id] = sourceRef.split(":");
  if (t !== table || !id || !UUID.test(id)) throw new Error(`finance: ${rule} posts from ${table}:<uuid>`);
  return { rule: rule as PostingRuleId, table, id };
}

/** Runs `fn` with app.posting_rule / app.source_ref set (transaction-local) and restores the previous values.
 *  app.command_type is never touched (W2 brief). On a throw the caller's transaction is failing anyway. */
export async function underRule<T>(tx: Tx, rule: string, sourceRef: string, fn: () => Promise<T>): Promise<T> {
  const prev = (await tx.query<{ r: string | null; s: string | null }>(
    `SELECT current_setting('app.posting_rule', true) AS r, current_setting('app.source_ref', true) AS s`)).rows[0]!;
  await tx.query(`SELECT set_config('app.posting_rule', $1, true), set_config('app.source_ref', $2, true)`, [rule, sourceRef]);
  const out = await fn();
  await tx.query(`SELECT set_config('app.posting_rule', $1, true), set_config('app.source_ref', $2, true)`, [prev.r ?? "", prev.s ?? ""]);
  return out;
}

/** Fires the deferred balance checks for what this transaction wrote so far, then defers them again. */
export async function checkBalancedNow(tx: Tx): Promise<void> {
  await tx.query(`SET CONSTRAINTS core.entry_balanced, core.posting_balanced IMMEDIATE`);
  await tx.query(`SET CONSTRAINTS core.entry_balanced, core.posting_balanced DEFERRED`);
}

async function chartRoles(tx: Tx) {
  const r = await tx.query<{ id: string; code: string; type: string }>(`SELECT id, code, type FROM core.account WHERE active`);
  return roleResolver(r.rows);
}

async function writeEntry(tx: Tx, entryId: string, h: Header, rule: string, table: string, sourceId: string, reversesId: string | null,
  postings: Array<{ account_id: string; amount_minor: number }>): Promise<boolean> {
  const ins = await tx.query(
    `INSERT INTO core.journal_entry (tenant_id, id, outlet_id, brand_id, channel_id, entry_date, source_type, source_id, posting_rule, reverses_id, memo_key)
     VALUES (current_setting('app.tenant_id')::uuid, $1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
     ON CONFLICT (tenant_id, posting_rule, source_type, source_id) WHERE posting_rule IS NOT NULL AND reverses_id IS NULL DO NOTHING
     RETURNING id`, [entryId, h.outlet_id, h.brand_id, h.channel_id, h.entry_date, table, sourceId, rule, reversesId, h.memo_key ?? null]);
  if (ins.rowCount !== 1) return false;
  for (const p of postings) {
    await tx.query(
      `INSERT INTO core.posting (tenant_id, id, journal_entry_id, account_id, amount_minor, currency)
       VALUES (current_setting('app.tenant_id')::uuid, $1, $2, $3, $4, $5)`, [uuidv7(), entryId, p.account_id, p.amount_minor, h.currency]);
  }
  await checkBalancedNow(tx);
  return true;
}

export type PostResult = { entry_id: string | null; created: boolean };

const existing = async (tx: Tx, rule: string, table: string, id: string) =>
  (await tx.query<{ id: string }>(
    `SELECT id FROM core.journal_entry WHERE posting_rule = $1 AND source_type = $2 AND source_id = $3 AND reverses_id IS NULL`, [rule, table, id])).rows[0]?.id ?? null;

/** 0015 A6 reversal rules → the posting rule whose entry each reverses (same source table). */
export const REVERSAL_RULES = {
  "finance.reverse_supplier_invoice": "finance.post_supplier_invoice",
  "finance.reverse_payroll": "finance.post_payroll",
} as const;
export type ReversalRuleId = keyof typeof REVERSAL_RULES;

/** One source's chain under a posting rule and its reversal rule: the original entry, its reversal, the re-post
 *  (reversing the reversal)… — each entry reverses the one before, so the chain is linear and its last entry is
 *  the only one nothing reverses. An odd length means the source is posted; an even one, reversed. */
async function chain(tx: Tx, rule: string, reversal: string, table: string, id: string) {
  const r = await tx.query<{ id: string; n: string }>(
    `SELECT je.id, count(*) OVER () AS n FROM core.journal_entry je
      WHERE je.source_type = $3 AND je.source_id = $4 AND je.posting_rule IN ($1, $2)
      ORDER BY NOT EXISTS (SELECT 1 FROM core.journal_entry x WHERE x.reverses_id = je.id) DESC, je.id DESC LIMIT 1`, [rule, reversal, table, id]);
  return r.rows[0] ? { last: r.rows[0].id, posted: Number(r.rows[0].n) % 2 === 1 } : null;
}

/** Today's business date for an entry about `outletId` (the tenant's home zone for a tenant-wide entry): a reversal
 *  or re-post is dated when it happens, in an open period, never back in the original's month. */
async function todayFor(tx: Tx, outletId: string | null): Promise<string> {
  const z = (await tx.query<{ tz: string; cutoff: string }>(
    `SELECT coalesce(o.tz, t.home_tz, (SELECT f.tz FROM core.outlet f ORDER BY f.created_at, f.id LIMIT 1)) AS tz,
            coalesce(o.business_day_cutoff, '04:00')::text AS cutoff
       FROM core.tenant t LEFT JOIN core.outlet o ON o.tenant_id = t.tenant_id AND o.id = $1`, [outletId])).rows[0]!;
  return businessDate(new Date(), z.tz, hhmm(z.cutoff));
}

/** The negation of entry `of` under `rule`, reversing it, dated today. */
async function negate(tx: Tx, rule: string, table: string, sourceId: string, of: string): Promise<string> {
  const h = (await tx.query<Header>(
    `SELECT outlet_id, brand_id, channel_id, entry_date::text AS entry_date, (SELECT p.currency FROM core.posting p WHERE p.journal_entry_id = je.id LIMIT 1) AS currency
       FROM core.journal_entry je WHERE id = $1`, [of])).rows[0]!;
  const ps = await tx.query<{ account_id: string; amount_minor: string }>(`SELECT account_id, amount_minor FROM core.posting WHERE journal_entry_id = $1 ORDER BY id`, [of]);
  const entryId = uuidv7();
  const today = await todayFor(tx, h.outlet_id);
  await underRule(tx, rule, `${table}:${sourceId}`, () =>
    writeEntry(tx, entryId, { ...h, entry_date: today }, rule, table, sourceId, of, ps.rows.map((p) => ({ account_id: p.account_id, amount_minor: -n(p.amount_minor) }))));
  return entryId;
}

/** Reverses the posted entry of a source that left its posted state, under the reversal rule (whose source state
 *  the guard checks: invoice disputed / void, payroll void). Nothing posted, or already reversed → no new entry. */
export async function reverseSource(tx: Tx, reversal: ReversalRuleId, sourceRef: string): Promise<PostResult> {
  const rule = REVERSAL_RULES[reversal];
  const src = parseSourceRef(rule, sourceRef);
  const c = await chain(tx, rule, reversal, src.table, src.id);
  if (!c) return { entry_id: null, created: false };
  if (!c.posted) return { entry_id: c.last, created: false };
  return { entry_id: await negate(tx, reversal, src.table, src.id, c.last), created: true };
}

/** The seam: post `sourceRef` ("core.<table>:<uuid>") under `rule` (a seeded finance.post_* id). A completed order's
 *  post also posts its loyalty redemption (finance.post_loyalty_redemption, 0016) when it redeemed points — the one
 *  call orders makes at completion covers both entries. */
export async function postFor(tx: Tx, rule: string, sourceRef: string): Promise<PostResult> {
  const out = await postOne(tx, rule, sourceRef);
  if (rule === "finance.post_order") await postOne(tx, "finance.post_loyalty_redemption", sourceRef);
  return out;
}

async function postOne(tx: Tx, rule: string, sourceRef: string): Promise<PostResult> {
  const src = parseSourceRef(rule, sourceRef);
  const prior = await existing(tx, src.rule, src.table, src.id);
  if (prior) {
    // Reversed under its reversal rule and now back in the posted state: re-post as the reversal of the reversal.
    const reversal = Object.entries(REVERSAL_RULES).find(([, r]) => r === src.rule)?.[0];
    const c = reversal ? await chain(tx, src.rule, reversal, src.table, src.id) : null;
    if (c && !c.posted) return { entry_id: await negate(tx, src.rule, src.table, src.id, c.last), created: true };
    return { entry_id: c?.last ?? prior, created: false };
  }
  const roles = await chartRoles(tx);
  const d = await DERIVE[src.rule](tx, src.id, await tenantPack(tx), roles.has("input_tax"));
  if (!d.lines) return { entry_id: null, created: false };
  const postings = d.lines.map((l) => ({ account_id: roles.need(l.role).id, amount_minor: l.amount_minor }));
  const entryId = uuidv7();
  const created = await underRule(tx, src.rule, `${src.table}:${src.id}`, () =>
    writeEntry(tx, entryId, d.header, src.rule, src.table, src.id, null, postings));
  // Lost a race with a concurrent poster of the same source: theirs is the entry.
  return created ? { entry_id: entryId, created: true } : { entry_id: await existing(tx, src.rule, src.table, src.id), created: false };
}

/** A correction: the one reversal of the rule's entry for this source, dated `entryDate` (an open period),
 *  under the same rule — so the guard still requires the source to be in the rule's source state. A source
 *  that has LEFT that state (an invoice disputed, a payroll voided) cannot be reversed this way: that needs
 *  an approved finance.journal.adjust.v1 with reverses_id (or a reversal rule the migrator adds). */
export async function reverseFor(tx: Tx, rule: string, sourceRef: string, entryDate: string): Promise<PostResult> {
  const src = parseSourceRef(rule, sourceRef);
  const orig = await existing(tx, src.rule, src.table, src.id);
  if (!orig) return { entry_id: null, created: false };
  const done = (await tx.query<{ id: string }>(`SELECT id FROM core.journal_entry WHERE reverses_id = $1`, [orig])).rows[0]?.id;
  if (done) return { entry_id: done, created: false };
  const h = (await tx.query<Header>(
    `SELECT outlet_id, brand_id, channel_id, entry_date::text AS entry_date, (SELECT p.currency FROM core.posting p WHERE p.journal_entry_id = je.id LIMIT 1) AS currency
       FROM core.journal_entry je WHERE id = $1`, [orig])).rows[0]!;
  const ps = await tx.query<{ account_id: string; amount_minor: string }>(`SELECT account_id, amount_minor FROM core.posting WHERE journal_entry_id = $1 ORDER BY id`, [orig]);
  const negated = ps.rows.map((p) => ({ account_id: p.account_id, amount_minor: -n(p.amount_minor) }));
  const entryId = uuidv7();
  await underRule(tx, src.rule, `${src.table}:${src.id}`, () =>
    writeEntry(tx, entryId, { ...h, entry_date: entryDate }, src.rule, src.table, src.id, orig, negated));
  return { entry_id: entryId, created: true };
}
