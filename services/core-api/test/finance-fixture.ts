// T-026 fixtures: a fresh synthetic tenant whose chart comes from its country pack through the seam
// (seedChart under tenancy.provision.v1), and helpers that write each source document under the command that
// owns it, then call postFor in the same transaction — exactly as the owning module (orders, purchasing,
// people, imports) will. Every write passes the book guard; no superuser shortcuts. Synthetic data only.
import { PACKS } from "@munim/contracts/packs";
import { type AppContext, type TestDb, uuidv7 } from "@munim/db";
import type pg from "pg";
import { postFor, seedChart } from "../src/modules/finance/index.ts";

export interface Fx {
  tenant: string;
  country: "IN" | "AU";
  currency: string;
  operator: string;
  owner: string;
  manager: string;
  staff: string;
  advisor: string;
  subs: { owner: string; manager: string; staff: string; advisor: string };
  outlets: [string, string];
  brand: string;
  counter: string;
  agg: string;
  accounts: Record<string, string>;
}
type Who = "owner" | "manager" | "staff" | "advisor";

export const own = (fx: Fx, command_type: string, extra: AppContext = {}): AppContext =>
  ({ tenant_id: fx.tenant, outlet_ids: "*", role: "owner", member_id: fx.owner, command_type, ...extra });

export async function buildFinanceTenant(db: TestDb, country: "IN" | "AU" = "IN"): Promise<Fx> {
  const pack = PACKS[country]!;
  const fx: Fx = {
    tenant: uuidv7(), country, currency: pack.currency.code, operator: uuidv7(), owner: uuidv7(), manager: uuidv7(), staff: uuidv7(), advisor: uuidv7(),
    subs: { owner: `fin-owner-${uuidv7()}`, manager: `fin-manager-${uuidv7()}`, staff: `fin-staff-${uuidv7()}`, advisor: `fin-advisor-${uuidv7()}` },
    outlets: [uuidv7(), uuidv7()], brand: uuidv7(), counter: uuidv7(), agg: uuidv7(), accounts: {},
  };
  await db.withContext("munim_core", { tenant_id: fx.tenant, outlet_ids: "*", role: "operator", operator_id: fx.operator, command_type: "tenancy.provision.v1" }, async (c) => {
    await c.query(`INSERT INTO core.tenant (tenant_id, name, country_code, base_currency, fy_start_month) VALUES ($1, 'Synthetic Finance Tenant', $2, $3, $4)`,
      [fx.tenant, country, fx.currency, pack.fy_start_month]);
    await c.query(`INSERT INTO core.member (tenant_id, id, name, email, idp_sub) VALUES ($1, $2, 'Owner', 'owner@example.test', $3)`, [fx.tenant, fx.owner, fx.subs.owner]);
    await c.query(`INSERT INTO core.membership (tenant_id, member_id, role) VALUES ($1, $2, 'owner')`, [fx.tenant, fx.owner]);
    fx.accounts = await seedChart(c, pack);
  });
  await inCmd(db, fx, "tenancy.outlet.create.v1", async (c) => {
    for (const [i, o] of fx.outlets.entries()) {
      await c.query(`INSERT INTO core.outlet (tenant_id, id, name, kind, tz, address) VALUES ($1, $2, $3, 'restaurant', $4, 'Synthetic street')`,
        [fx.tenant, o, `Outlet ${"AB"[i]}`, pack.default_timezone]);
    }
    await c.query("SELECT set_config('app.command_type', 'tenancy.brand.create.v1', true)");
    await c.query(`INSERT INTO core.brand (tenant_id, id, name, outlet_ids) VALUES ($1, $2, 'Brand X', $3)`, [fx.tenant, fx.brand, fx.outlets]);
    await c.query("SELECT set_config('app.command_type', 'tenancy.channel.create.v1', true)");
    await c.query(`INSERT INTO core.channel (tenant_id, id, name, kind) VALUES ($1, $2, 'Counter', 'counter'), ($1, $3, 'Aggregator', $4)`,
      [fx.tenant, fx.counter, fx.agg, `aggregator:${pack.aggregators[0]!.code}`]);
    await c.query("SELECT set_config('app.command_type', 'tenancy.member.invite.v1', true)");
    for (const [who, role, outlets] of [["manager", "manager", [fx.outlets[0]]], ["staff", "staff", [fx.outlets[0]]], ["advisor", "advisor", []]] as const) {
      await c.query(`INSERT INTO core.member (tenant_id, id, name, email, idp_sub) VALUES ($1, $2, $3, $4, $5)`, [fx.tenant, fx[who], who, `${who}@example.test`, fx.subs[who]]);
      await c.query(`INSERT INTO core.membership (tenant_id, member_id, role, outlet_ids) VALUES ($1, $2, $3, $4)`, [fx.tenant, fx[who], role, outlets]);
    }
  });
  return fx;
}

export type Q = Pick<pg.ClientBase, "query">;
/** A writer runs in its own transaction (TestDb) or inside the caller's (a client): then it sets its own
 *  command type, as the owning module's handler would. */
export type On = TestDb | Q;
async function inCmd<T>(on: On, fx: Fx, command: string, fn: (c: Q) => Promise<T>): Promise<T> {
  if ("withContext" in on) return on.withContext("munim_core", own(fx, command), fn);
  await on.query("SELECT set_config('app.command_type', $1, true)", [command]);
  return fn(on);
}

/** A completed order (the order lifecycle is T-022's; the fixture writes it completed under orders.place.v1)
 *  and its finance.post_order entry. Returns the order id. */
export async function completedOrder(db: On, fx: Fx, o: { outlet: string; channel: string; brand: string | null; subtotal: number; discount?: number; tax: number }): Promise<string> {
  const id = uuidv7();
  await inCmd(db, fx, "orders.place.v1", async (c) => {
    await c.query(`INSERT INTO core."order" (tenant_id, id, outlet_id, channel_id, brand_id, kind, status, subtotal_minor, discount_minor, tax_minor, total_minor, currency, pricing_snapshot)
                   VALUES ($1, $2, $3, $4, $5, 'takeaway', 'completed', $6, $7, $8, $9, $10, '{}')`,
      [fx.tenant, id, o.outlet, o.channel, o.brand, o.subtotal, o.discount ?? 0, o.tax, o.subtotal - (o.discount ?? 0) + o.tax, fx.currency]);
    await postFor(c, "finance.post_order", `core.order:${id}`);
  });
  return id;
}

export async function tender(db: On, fx: Fx, t: { order: string; outlet: string; method: "cash" | "card" | "upi"; amount: number; rounding?: number }): Promise<string> {
  const id = uuidv7();
  await inCmd(db, fx, "orders.tender.record.v1", async (c) => {
    const cash = t.method === "cash";
    await c.query(`INSERT INTO core.tender (tenant_id, id, outlet_id, order_id, method, amount_minor, tendered_minor, change_minor, rounding_minor, currency, recorded_by)
                   VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
      [fx.tenant, id, t.outlet, t.order, t.method, t.amount, cash ? t.amount : null, cash ? 0 : null, t.rounding ?? 0, fx.currency, fx.owner]);
    await postFor(c, "finance.post_tender", `core.tender:${id}`);
  });
  return id;
}

export async function refund(db: On, fx: Fx, r: { order: string; outlet: string; method: "cash" | "card" | "upi"; amount: number }): Promise<string> {
  const id = uuidv7();
  await inCmd(db, fx, "orders.refund.record.v1", async (c) => {
    await c.query(`INSERT INTO core.refund (tenant_id, id, outlet_id, order_id, method, amount_minor, currency, reason_code, note, actor)
                   VALUES ($1, $2, $3, $4, $5, $6, $7, 'wrong_item', 'Synthetic refund', $8)`, [fx.tenant, id, r.outlet, r.order, r.method, r.amount, fx.currency, fx.owner]);
    await postFor(c, "finance.post_refund", `core.refund:${id}`);
  });
  return id;
}

export async function supplier(db: On, fx: Fx): Promise<string> {
  const id = uuidv7();
  await inCmd(db, fx, "purchasing.supplier.upsert.v1", (c) =>
    c.query(`INSERT INTO core.supplier (tenant_id, id, name, kind) VALUES ($1, $2, 'Simulated Dairy', 'simulated')`, [fx.tenant, id]));
  return id;
}

export async function ingredient(db: On, fx: Fx): Promise<string> {
  const id = uuidv7();
  await inCmd(db, fx, "inventory.ingredient.upsert.v1", (c) =>
    c.query(`INSERT INTO core.ingredient (tenant_id, id, name, base_unit) VALUES ($1, $2, 'Paneer', 'kg')`, [fx.tenant, id]));
  return id;
}

/** A goods-received note, written under inventory.stock.receive.v1 (the seeded command whose target_tables list core.goods_received; T-025 owns receiving). */
export async function grn(db: On, fx: Fx, g: { outlet: string; supplier: string; ingredient: string; lines: Array<[number, number]> }): Promise<string> {
  const id = uuidv7();
  await inCmd(db, fx, "inventory.stock.receive.v1", async (c) => {
    await c.query(`INSERT INTO core.goods_received (tenant_id, id, outlet_id, supplier_id, received_by) VALUES ($1, $2, $3, $4, $5)`, [fx.tenant, id, g.outlet, g.supplier, fx.owner]);
    for (const [qty, cost] of g.lines) {
      await c.query(`INSERT INTO core.grn_line (tenant_id, id, goods_received_id, ingredient_id, qty_milli, unit, unit_cost_minor, currency) VALUES ($1, $2, $3, $4, $5, 'kg', $6, $7)`,
        [fx.tenant, uuidv7(), id, g.ingredient, qty, cost, fx.currency]);
    }
    await postFor(c, "finance.post_grn", `core.goods_received:${id}`);
  });
  return id;
}

/** A recorded supplier invoice (not yet approved). */
export async function invoice(db: On, fx: Fx, i: { supplier: string; date: string; subtotal: number; tax: number }): Promise<string> {
  const id = uuidv7();
  await inCmd(db, fx, "purchasing.invoice.record.v1", (c) =>
    c.query(`INSERT INTO core.supplier_invoice (tenant_id, id, supplier_id, invoice_no, invoice_date, subtotal_minor, tax_minor, total_minor, currency)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`, [fx.tenant, id, i.supplier, `INV-${id.slice(-6)}`, i.date, i.subtotal, i.tax, i.subtotal + i.tax, fx.currency]));
  return id;
}

/** purchasing.invoice.approve.v1 (T-025's) then the posting, in one transaction. */
export async function approveInvoice(db: On, fx: Fx, id: string) {
  return inCmd(db, fx, "purchasing.invoice.approve.v1", async (c) => {
    await c.query(`UPDATE core.supplier_invoice SET status = 'approved' WHERE id = $1`, [id]);
    return postFor(c, "finance.post_supplier_invoice", `core.supplier_invoice:${id}`);
  });
}

export async function payroll(db: On, fx: Fx, p: { outlet: string; month: string; lines: Array<{ base: number; ot: number; tips: number; recovery: number }> }): Promise<string> {
  const id = uuidv7();
  await inCmd(db, fx, "people.staff.upsert.v1", async (c) => {
    const staff: string[] = [];
    for (const [i] of p.lines.entries()) {
      const s = uuidv7();
      staff.push(s);
      await c.query(`INSERT INTO core.staff (tenant_id, id, outlet_id, name, role_key, pay_basis, monthly_salary_minor, contract_min_per_month, ot_multiplier_bp, currency, joined_on)
                     VALUES ($1, $2, $3, $4, 'cook', 'monthly', 1500000, 12000, 15000, $5, '2026-01-01')`, [fx.tenant, s, p.outlet, `Staff ${i + 1}`, fx.currency]);
    }
    await c.query("SELECT set_config('app.command_type', 'people.payroll_draft.create.v1', true)");
    await c.query(`INSERT INTO core.payroll_draft (tenant_id, id, outlet_id, period_month, currency) VALUES ($1, $2, $3, $4, $5)`, [fx.tenant, id, p.outlet, p.month, fx.currency]);
    for (const [i, l] of p.lines.entries()) {
      await c.query(`INSERT INTO core.payroll_draft_line (tenant_id, id, payroll_draft_id, staff_id, base_minor, overtime_minor, tips_minor, advance_recovery_minor, net_minor, currency)
                     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`, [fx.tenant, uuidv7(), id, staff[i], l.base, l.ot, l.tips, l.recovery, l.base + l.ot + l.tips - l.recovery, fx.currency]);
    }
    await postFor(c, "finance.post_payroll", `core.payroll_draft:${id}`);
  });
  return id;
}

/** An import run for a document, advanced to `previewed` (parser's job, T-030). */
export async function previewedRun(db: TestDb, fx: Fx, kind = "payout_statement"): Promise<string> {
  const doc = uuidv7();
  const run = uuidv7();
  await inCmd(db, fx, "imports.run.commit.v1", async (c) => {
    await c.query(`INSERT INTO core.document (tenant_id, id, kind, media_type, filename, byte_size, sha256, storage_ref, uploaded_by)
                   VALUES ($1, $2, $3, 'text/csv', 'synthetic.csv', 100, $4, $5, $6)`, [fx.tenant, doc, kind, doc.replaceAll("-", "").padEnd(64, "0"), `docs/${doc}`, fx.owner]);
    await c.query(`INSERT INTO core.import_run (tenant_id, id, document_id, kind, parser) VALUES ($1, $2, $3, $4, 'synthetic_v1')`, [fx.tenant, run, doc, kind]);
    await c.query(`UPDATE core.import_run SET status = 'previewed' WHERE id = $1`, [run]);
  });
  return run;
}

/** Runs `fn` inside the approval of an imports.run.commit.v1 draft for `run`: the run flips to committed
 *  first (T-030's order), then `fn` records rows through the finance seams — all under the decision.
 *  `commitRun: false` leaves the run previewed (the source-state refusal gates). */
export async function inImportApproval<T>(db: TestDb, fx: Fx, run: string, fn: (c: Q) => Promise<T>, opts: { commitRun?: boolean } = {}): Promise<T> {
  const draft = uuidv7();
  await db.withContext("munim_svc", { tenant_id: fx.tenant, outlet_ids: "*" }, (c) =>
    c.query(`INSERT INTO core.draft (tenant_id, id, source, command_type, command_payload) VALUES ($1, $2, 'import', 'imports.run.commit.v1', $3)`,
      [fx.tenant, draft, { import_run_id: run }]));
  return db.withContext("munim_core", { tenant_id: fx.tenant, outlet_ids: "*", role: "owner", member_id: fx.owner }, async (c) => {
    const decision = uuidv7();
    await c.query(`UPDATE core.draft SET status = 'executing', exec_txid = txid_current() WHERE id = $1`, [draft]);
    await c.query(`INSERT INTO core.decision (tenant_id, id, draft_id, verdict, final_payload, decided_by) VALUES ($1, $2, $3, 'approved', '{}', $4)`, [fx.tenant, decision, draft, fx.owner]);
    await c.query("SELECT set_config('app.decision_id', $1, true)", [decision]);
    if (opts.commitRun !== false) await c.query(`UPDATE core.import_run SET status = 'committed', decision_id = $2 WHERE id = $1`, [run, decision]);
    const out = await fn(c);
    await c.query(`UPDATE core.draft SET status = 'executed' WHERE id = $1`, [draft]);
    return out;
  });
}

export async function terms(db: TestDb, fx: Fx, t: { channel: string; commission_bp: number; ads_opted_in: boolean; cap?: number | null; from: string; to?: string | null }): Promise<string> {
  const id = uuidv7();
  await inCmd(db, fx, "finance.channel_terms.set.v1", (c) =>
    c.query(`INSERT INTO core.channel_terms (tenant_id, id, channel_id, commission_bp, ads_opted_in, ad_spend_cap_minor, promo_share_bp, payout_cycle_days, currency, valid_from, valid_to)
             VALUES ($1, $2, $3, $4, $5, $6, 0, 7, $7, $8, $9)`, [fx.tenant, id, t.channel, t.commission_bp, t.ads_opted_in, t.cap ?? null, fx.currency, t.from, t.to ?? null]));
  return id;
}

/** Entries / postings visible to the superuser for this tenant (counts in gates). */
export const count = async (db: TestDb, sql: string, params: unknown[]) => Number((await db.admin<{ n: string }>(sql, params)).rows[0]!.n);
export const entriesFor = (db: TestDb, sourceId: string) =>
  count(db, `SELECT count(*) n FROM core.journal_entry WHERE source_id = $1`, [sourceId]);

export type { Who };
