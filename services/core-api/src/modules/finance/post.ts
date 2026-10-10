// postFor (W2 seam, T-026): the derived journal entry for one source row under one seeded posting rule,
// written inside the CALLER's transaction (the module that owns the source row's lifecycle calls it right
// after the row reaches the rule's source state). The book guard admits the entry only as that derivation:
// app.posting_rule + app.source_ref name the rule and row, and core.derivation_rule.source_state must hold
// (e.g. an order 'completed', an invoice 'approved', a settlement whose import run is 'committed').
//   • one entry per (rule, source): a second call returns the existing entry and writes nothing;
//   • nothing to post (every line 0, e.g. a fully discounted order) → no entry;
//   • the entry balances per currency (checked here by core-domain, then by the deferred DB trigger, which
//     is fired at the end of this call so an imbalance surfaces at the call site, not at the caller's COMMIT);
//   • corrections are reversals (reverseFor), never edits.
import type { CountryPack } from "@munim/contracts/packs";
import {
  type ChannelTreatment, channelTreatment, type ExpenseCategory, type Line, POSTING_RULES, type PostingRuleId, postExpense, postGrn, postOrder,
  postPayroll, postRefund, postSettlement, postSupplierInvoice, postTender, roleResolver, type TenderMethod,
} from "@munim/core-domain/finance";
import { businessDate } from "@munim/core-domain/tz";
import { uuidv7 } from "../../commit/index.ts";
import type { Queryable } from "../../runtoken/index.ts";

export type Tx = Queryable;

/** An entry's header fields (its date decides the period; outlet / brand / channel are the P&L keys). */
type Header = { entry_date: string; outlet_id: string | null; brand_id: string | null; channel_id: string | null; currency: string };
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

type OrderRow = { status: string; outlet_id: string; brand_id: string | null; channel_id: string; business_date: string; total_minor: string; tax_minor: string; currency: string; kind: string };
const ORDER_SQL = `SELECT o.status, o.outlet_id, o.brand_id, o.channel_id, o.business_date::text AS business_date, o.total_minor, o.tax_minor, o.currency, ch.kind
                     FROM core."order" o JOIN core.channel ch ON ch.tenant_id = o.tenant_id AND ch.id = o.channel_id WHERE o.id = $1`;

/** Each rule: read the source row(s) the caller can see, compute the lines in core-domain. */
const DERIVE: Record<PostingRuleId, (tx: Tx, id: string, pack: CountryPack, input_tax: boolean) => Promise<Derived>> = {
  async "finance.post_order"(tx, id, pack) {
    const o = await one<OrderRow>(tx, ORDER_SQL, id);
    return {
      header: { entry_date: o.business_date, outlet_id: o.outlet_id, brand_id: o.brand_id, channel_id: o.channel_id, currency: o.currency },
      lines: postOrder({ ...channelTreatment(pack, o.kind), total_minor: n(o.total_minor), tax_minor: n(o.tax_minor) }),
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
    const f = await one<{ order_id: string; method: TenderMethod; amount_minor: string; at: Date; currency: string; tz: string; cutoff: string }>(tx,
      `SELECT f.order_id, f.method, f.amount_minor, f.at, f.currency, ou.tz, ou.business_day_cutoff::text AS cutoff
         FROM core.refund f JOIN core.outlet ou ON ou.tenant_id = f.tenant_id AND ou.id = f.outlet_id WHERE f.id = $1`, id);
    const o = await one<OrderRow>(tx, ORDER_SQL, f.order_id);
    return {
      header: { entry_date: businessDate(f.at, f.tz, hhmm(f.cutoff)), outlet_id: o.outlet_id, brand_id: o.brand_id, channel_id: o.channel_id, currency: f.currency },
      lines: postRefund({ operator_collects: channelTreatment(pack, o.kind).operator_collects, method: f.method, amount_minor: n(f.amount_minor),
        order_total_minor: n(o.total_minor), order_tax_minor: n(o.tax_minor) }),
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
    const i = await one<{ invoice_date: string; subtotal_minor: string; tax_minor: string; total_minor: string; currency: string; outlet_ids: string[] | null }>(tx,
      `SELECT i.invoice_date::text AS invoice_date, i.subtotal_minor, i.tax_minor, i.total_minor, i.currency, po.outlet_ids
         FROM core.supplier_invoice i LEFT JOIN core.purchase_order po ON po.tenant_id = i.tenant_id AND po.id = i.po_id WHERE i.id = $1`, id);
    const outlet = i.outlet_ids?.length === 1 ? i.outlet_ids[0]! : null;
    return {
      header: { entry_date: i.invoice_date, outlet_id: outlet, brand_id: null, channel_id: null, currency: i.currency },
      lines: postSupplierInvoice({ subtotal_minor: n(i.subtotal_minor), tax_minor: n(i.tax_minor), total_minor: n(i.total_minor), input_tax }),
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
      header: { entry_date: s.on, outlet_id: s.outlet_id, brand_id: null, channel_id: s.channel_id, currency: s.currency },
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
    `INSERT INTO core.journal_entry (tenant_id, id, outlet_id, brand_id, channel_id, entry_date, source_type, source_id, posting_rule, reverses_id)
     VALUES (current_setting('app.tenant_id')::uuid, $1, $2, $3, $4, $5, $6, $7, $8, $9)
     ON CONFLICT (tenant_id, posting_rule, source_type, source_id) WHERE posting_rule IS NOT NULL AND reverses_id IS NULL DO NOTHING
     RETURNING id`, [entryId, h.outlet_id, h.brand_id, h.channel_id, h.entry_date, table, sourceId, rule, reversesId]);
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

/** The seam: post `sourceRef` ("core.<table>:<uuid>") under `rule` (a seeded finance.post_* id). */
export async function postFor(tx: Tx, rule: string, sourceRef: string): Promise<PostResult> {
  const src = parseSourceRef(rule, sourceRef);
  const prior = await existing(tx, src.rule, src.table, src.id);
  if (prior) return { entry_id: prior, created: false };
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
