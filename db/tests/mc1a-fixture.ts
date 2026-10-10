// M-C1a fixture (0019): outlet data in outlets A (1) and B (2) of a canonical world, in two months, so every outlet-scoped
// table and every M-C1a template has rows in both outlets and outlet C (3) has none. Written like buildWorld: each
// book row under the command bound to its table (own commands as the owner, history rows inside an approved
// imports.run.commit.v1 draft, postings and stock movements as derivations of the approved rows). Synthetic data only.
//
// Hand values (IN tenant, exclusive tax; paneer-free fixture items so buildWorld's own rows do not mix in):
//   Dish D: recipe 0.200 kg flour (waste 2%), price 30000 at A and B. SKU S: 1 pc biscuit (MRP 2800), price 3000.
//   Flour landed cost: Aug 4000/kg, Sep 4400/kg (both outlets). Biscuits 2000/pc.
//   Per outlet and month (k = 1 at A, 2 at B): counter orders of D, qty k each, one line under the deal (10% off);
//   one aggregator order of D (qty 1); one counter order of S (qty 2). Postings by finance.post_order; wages, COGS and
//   commission by approved journal adjustments. Sep settlement at each outlet: the aggregator order paid at 28%
//   (contract 22%) plus an ad-fee line the terms never allowed. Waste: 2 kg flour at A on 20 Sep. Three days before
//   today: one more D sale per outlet and a little waste at both (the windows that end today).
import type pg from "pg";
import type { TestDb } from "../src/harness.ts";
import { approveDraft, ownerCtx, uuidv7, type World } from "./world.ts";

export interface McFixture {
  A: string;
  B: string;
  C: string;
  dish: string;
  sku: string;
  deal: string;
  agg: string;
  flour: string;
  months: [string, string];
  managerA: string;
  advisor: string;
}

const u = uuidv7;
type Q = (sql: string, params?: unknown[]) => Promise<pg.QueryResult>;

export async function addOutletData(db: TestDb, w: World): Promise<McFixture> {
  const T = w.tenant;
  const [A, B, C] = w.outlets;
  const f: McFixture = {
    A, B, C, dish: u(), sku: u(), deal: u(), agg: u(), flour: u(), months: ["2026-08-01", "2026-09-01"], managerA: u(), advisor: u(),
  };
  const biscuit = u();
  const recipe = u();
  const staffB = u();
  const batches: Record<string, string> = { [A]: u(), [B]: u() };
  const cur = w.currency;

  // 1. Catalogue, channel, terms, members and the own-command rows of every newly outlet-scoped table.
  await db.withContext("munim_core", ownerCtx(w), async (c) => {
    const q: Q = (sql, params) => c.query(sql, params);
    const cmd = (type: string) => c.query("SELECT set_config('app.command_type', $1, true)", [type]);
    await cmd("tenancy.member.invite.v1");
    await q(`INSERT INTO core.member (tenant_id, id, name, email) VALUES ($1, $2, 'Manager A', 'manager-a@example.test'), ($1, $3, 'Advisor', 'advisor@example.test')`,
      [T, f.managerA, f.advisor]);
    await q(`INSERT INTO core.membership (tenant_id, member_id, role, outlet_ids) VALUES ($1, $2, 'manager', $3), ($1, $4, 'advisor', '{}')`,
      [T, f.managerA, [A], f.advisor]);
    await cmd("inventory.ingredient.upsert.v1");
    await q(`INSERT INTO core.ingredient (tenant_id, id, name, base_unit, tracked_by_batch) VALUES ($1, $2, 'Fixture flour', 'kg', false), ($1, $3, 'Fixture biscuit', 'pc', true)`,
      [T, f.flour, biscuit]);
    await cmd("catalogue.item.upsert.v1");
    await q(`INSERT INTO core.item (tenant_id, id, kind, name_key, category) VALUES ($1, $2, 'dish', 'menu.fixture_roti', 'mains')`, [T, f.dish]);
    await q(`INSERT INTO core.item (tenant_id, id, kind, name_key, category, stock_ingredient_id, mrp_minor, currency) VALUES ($1, $2, 'sku', 'shop.fixture_biscuit', 'snacks', $3, 3000, $4)`,
      [T, f.sku, biscuit, cur]);
    await cmd("catalogue.recipe.version.create.v1");
    await q(`INSERT INTO core.recipe_version (tenant_id, id, item_id, version, valid_from, yield_qty_milli) VALUES ($1, $2, $3, 1, '2026-07-01', 1000)`, [T, recipe, f.dish]);
    await q(`INSERT INTO core.recipe_line (tenant_id, id, recipe_version_id, ingredient_id, qty_milli, unit, waste_pct_bp) VALUES ($1, $2, $3, $4, 200, 'kg', 200)`,
      [T, u(), recipe, f.flour]);
    await cmd("catalogue.price.set.v1");
    for (const o of [A, B]) {
      await q(`INSERT INTO core.price (tenant_id, id, item_id, outlet_id, channel_kind, amount_minor, currency, tax_class, valid_from)
               VALUES ($1, $2, $3, $4, 'counter', 30000, $5, 'restaurant_5', '2026-07-01'), ($1, $6, $7, $4, 'counter', 3000, $5, 'goods_exempt', '2026-07-01')`,
        [T, u(), f.dish, o, cur, u(), f.sku]);
    }
    await cmd("catalogue.deal.upsert.v1");
    await q(`INSERT INTO core.deal (tenant_id, id, kind, name_key, rule, valid_from) VALUES ($1, $2, 'percent_off', 'deal.fixture', $3, '2026-07-01')`,
      [T, f.deal, { kind: "percent_off", bp: 1000, item_ids: [f.dish] }]);
    await cmd("tenancy.channel.create.v1");
    await q(`INSERT INTO core.channel (tenant_id, id, name, kind) VALUES ($1, $2, 'Swiggy', 'aggregator:swiggy')`, [T, f.agg]);
    await cmd("finance.channel_terms.set.v1");
    await q(`INSERT INTO core.channel_terms (tenant_id, id, channel_id, commission_bp, ads_opted_in, promo_share_bp, payout_cycle_days, currency, valid_from)
             VALUES ($1, $2, $3, 2200, false, 0, 7, $4, '2026-07-01')`, [T, u(), f.agg, cur]);
    await cmd("tenancy.policy.set.v1");
    await q(`INSERT INTO core.business_policy (tenant_id, id, outlet_id, target_margin_bp, valid_from) VALUES ($1, $2, $3, 6000, '2026-07-01'), ($1, $4, $5, 6500, '2026-07-01')`,
      [T, u(), A, u(), B]);

    // Stock: flour received in each month at each outlet; biscuits into a batch printed at MRP 2800.
    await cmd("inventory.stock.receive.v1");
    for (const o of [A, B]) {
      await q(`INSERT INTO core.batch (tenant_id, id, outlet_id, ingredient_id, batch_code, mrp_minor, currency) VALUES ($1, $2, $3, $4, 'FX-B', 2800, $5)`,
        [T, batches[o], o, biscuit, cur]);
      for (const [at, per1000] of [["2026-08-02T06:00:00Z", 4000000], ["2026-09-02T06:00:00Z", 4400000]] as const) {
        await q(`INSERT INTO core.stock_movement (tenant_id, id, outlet_id, ingredient_id, qty_milli, unit, kind, unit_cost_per_1000_minor, currency, at)
                 VALUES ($1, $2, $3, $4, 50000, 'kg', 'receipt', $5, $6, $7)`, [T, u(), o, f.flour, per1000, cur, at]);
      }
      await q(`INSERT INTO core.stock_movement (tenant_id, id, outlet_id, ingredient_id, batch_id, qty_milli, unit, kind, unit_cost_per_1000_minor, currency, at)
               VALUES ($1, $2, $3, $4, $5, 100000, 'pc', 'receipt', 2000000, $6, '2026-08-02T06:00:00Z')`, [T, u(), o, biscuit, batches[o], cur]);
    }

    // The other newly outlet-scoped tables: a row in outlet B (outlet A has buildWorld's), and in A where buildWorld has none.
    // Tenant-wide rows (outlet NULL, visible to every member) in budget, expense and period_close as well.
    await cmd("finance.budget.set.v1");
    await q(`INSERT INTO core.budget (tenant_id, id, outlet_id, category, period_month, amount_minor, currency)
             VALUES ($1, $2, $3, 'labour', '2026-09-01', 900000, $4), ($1, $5, NULL, 'marketing', '2026-09-01', 300000, $4)`, [T, u(), B, cur, u()]);
    await cmd("customers.bulk_order.upsert.v1");
    await q(`INSERT INTO core.bulk_order (tenant_id, id, outlet_id, customer_id, contact_name, deliver_at, headcount) VALUES ($1, $2, $3, $4, 'Office B', '2026-10-21T12:00:00Z', 30)`,
      [T, u(), B, w.customer]);
    const convB = u();
    await q(`INSERT INTO core.conversation (tenant_id, id, outlet_id, kind, title) VALUES ($1, $2, $3, 'handover', 'Evening handover B')`, [T, convB, B]);
    await q(`INSERT INTO core.message (tenant_id, id, conversation_id, author_member_id, body) VALUES ($1, $2, $3, $4, 'Closing count done.')`, [T, u(), convB, w.owner]);
    await cmd("finance.expense.record.v1");
    await q(`INSERT INTO core.expense (tenant_id, id, outlet_id, category, incurred_on, amount_minor, currency, payee)
             VALUES ($1, $2, $3, 'repairs', '2026-09-03', 120000, $4, 'Fixit'), ($1, $5, NULL, 'professional_fees', '2026-09-04', 80000, $4, 'Accountant')`,
      [T, u(), B, cur, u()]);
    await cmd("people.candidate.upsert.v1");
    await q(`INSERT INTO core.hiring_candidate (tenant_id, id, outlet_id, name, role_key) VALUES ($1, $2, $3, 'Applicant A', 'cook')`, [T, u(), A]);
    await cmd("people.staff.upsert.v1");
    await q(`INSERT INTO core.staff (tenant_id, id, outlet_id, name, role_key, pay_basis, wage_rate_minor, ot_multiplier_bp, currency, joined_on)
             VALUES ($1, $2, $3, 'Cook B', 'cook', 'hourly', 14000, 15000, $4, '2026-01-01')`, [T, staffB, B, cur]);
    if (w.country === "IN") {
      const pd = u();
      await cmd("people.payroll_draft.create.v1");
      await q(`INSERT INTO core.payroll_draft (tenant_id, id, outlet_id, period_month, currency) VALUES ($1, $2, $3, '2026-09-01', $4)`, [T, pd, B, cur]);
      await q(`INSERT INTO core.payroll_draft_line (tenant_id, id, payroll_draft_id, staff_id, base_minor, overtime_minor, tips_minor, advance_recovery_minor, net_minor, currency)
               VALUES ($1, $2, $3, $4, 2200000, 0, 0, 0, 2200000, $5)`, [T, u(), pd, staffB, cur]);
    }
    await cmd("finance.period.close.v1");
    await q(`INSERT INTO core.period_close (tenant_id, id, outlet_id, period_month, checklist, net_minor, currency, closed_by)
             VALUES ($1, $2, $3, '2025-04-01', '[]', 0, $4, $5), ($1, $6, NULL, '2025-05-01', '[]', 0, $4, $5)`,
      [T, u(), B, cur, w.owner, u()]);
    await cmd("customers.reservation.upsert.v1");
    await q(`INSERT INTO core.reservation (tenant_id, id, outlet_id, customer_id, name, party_size, starts_at) VALUES ($1, $2, $3, $4, 'Guest B', 2, '2026-10-13T19:00:00Z')`,
      [T, u(), B, w.customer]);
    await cmd("customers.review.record.v1");
    await q(`INSERT INTO core.review (tenant_id, id, outlet_id, source, external_ref, rating, body, reviewed_at) VALUES ($1, $2, $3, 'google', 'R-B1', 5, 'Great roti', '2026-10-06T12:00:00Z')`,
      [T, u(), B]);
    await cmd("finance.tax_return.prepare.v1");
    for (const o of [A, B]) {
      await q(`INSERT INTO core.tax_return_draft (tenant_id, id, outlet_id, return_code, period_from, period_to, output_tax_minor, input_tax_minor, net_payable_minor, currency)
               VALUES ($1, $2, $3, $4, '2026-08-01', '2026-08-31', 1000, 0, 1000, $5)`, [T, u(), o, w.country === "IN" ? "gst.gstr3b" : "ato.bas", cur]);
    }
    const pool = u();
    await cmd("people.tip_pool.record.v1");
    await q(`INSERT INTO core.tip_pool (tenant_id, id, outlet_id, period_from, period_to, basis, total_minor, currency) VALUES ($1, $2, $3, '2026-10-01', '2026-10-07', 'equal', 9000, $4)`,
      [T, pool, B, cur]);
    await q(`INSERT INTO core.tip_pool_share (tenant_id, id, tip_pool_id, staff_id, amount_minor, currency) VALUES ($1, $2, $3, $4, 9000, $5)`, [T, u(), pool, staffB, cur]);
    await cmd("finance.break.update.v1");
    for (const o of [A, B]) {
      await q(`INSERT INTO core.reconciliation_break (tenant_id, id, kind, outlet_id, amount_minor, currency) VALUES ($1, $2, 'other', $3, 700, $4)`, [T, u(), o, cur]);
    }
  });

  // 2. History through an approved import (R28, R44b): completed orders with lines and tenders, the payouts and bank
  //    lines, a market signal at B; the orders' postings and stock consumption as derivations of those rows.
  const run = u();
  const doc = u();
  await db.withContext("munim_core", ownerCtx(w), (c) =>
    c.query(`INSERT INTO core.document (tenant_id, id, kind, media_type, filename, byte_size, sha256, storage_ref, uploaded_by)
             VALUES ($1, $2, 'pos_bills', 'text/csv', 'fixture.csv', 512, repeat('c', 64), 'docs/fixture.csv', $3)`, [T, doc, w.owner]));
  await db.withContext("munim_svc", { tenant_id: T, outlet_ids: "*" }, async (c) => {
    await c.query(`INSERT INTO core.import_run (tenant_id, id, document_id, kind, parser) VALUES ($1, $2, $3, 'pos_bills', 'pos_bills_v2')`, [T, run, doc]);
    await c.query(`UPDATE core.import_run SET status = 'previewed', rows_ok = 1, control_total_minor = 0, currency = $3 WHERE tenant_id = $1 AND id = $2`, [T, run, cur]);
  });
  const accounts = Object.fromEntries((await db.admin<{ code: string; id: string }>(`SELECT code, id FROM core.account WHERE tenant_id = $1`, [T])).rows.map((r) => [r.code, r.id]));
  await approveDraft(db, w, "imports.run.commit.v1", async (q, decision) => {
    await q(`UPDATE core.import_run SET status = 'committed', decision_id = $3 WHERE tenant_id = $1 AND id = $2`, [T, run, decision]);
    const derive = async (rule: string, source: string, fn: () => Promise<unknown>) => {
      await q("SELECT set_config('app.posting_rule', $1, true), set_config('app.source_ref', $2, true)", [rule, source]);
      await fn();
      await q("SELECT set_config('app.posting_rule', '', true), set_config('app.source_ref', '', true)");
    };
    for (const [k, o] of [[1, A], [2, B]] as const) {
      for (const [mi, day] of [[0, "2026-08-10"], [1, "2026-09-10"]] as const) {
        const at = `${day}T07:30:00Z`;
        // order = [channel, item, qty_milli, unit price, line discount, tax, deal?]
        const bills: Array<[string, string, number, number, number, number, boolean, string | null]> = [
          [w.channel, f.dish, 1000 * k, 30000, 3000 * k, Math.round((30000 * k - 3000 * k) * 0.05), true, null],
          [w.channel, f.dish, 1000 * k, 30000, 0, Math.round(30000 * k * 0.05), false, null],
          [f.agg, f.dish, 1000, 30000, 0, 1500, false, `AGG-${k}-${mi}`],
          [w.channel, f.sku, 2000, 3000, 0, 0, false, null],
        ];
        for (const [channel, item, qty, price, disc, tax, deal, ext] of bills) {
          const order = u();
          const line = u();
          const sub = Math.round((qty * price) / 1000);
          const total = sub - disc + tax;
          const snapshot = { lines: [{ line_id: line, line_no: 1, deal_refs: deal ? [`⟨cite:row:core.deal:${f.deal}⟩`] : [] }], synthetic: true };
          await q(`INSERT INTO core."order" (tenant_id, id, outlet_id, channel_id, kind, status, business_date, subtotal_minor, discount_minor, tax_minor, total_minor,
                                              currency, pricing_snapshot, external_ref, created_at)
                   VALUES ($1, $2, $3, $4, 'takeaway', 'completed', $5, $6, $7, $8, $9, $10, $11, $12, $13)`,
            [T, order, o, channel, day, sub, disc, tax, total, cur, snapshot, ext, at]);
          await q(`INSERT INTO core.order_line (tenant_id, id, outlet_id, order_id, line_no, item_id, qty_milli, unit_price_minor, line_discount_minor, tax_minor, created_at)
                   VALUES ($1, $2, $3, $4, 1, $5, $6, $7, $8, $9, $10)`, [T, line, o, order, item, qty, price, disc, tax, at]);
          if (channel === w.channel) {
            await q(`INSERT INTO core.tender (tenant_id, id, outlet_id, order_id, method, amount_minor, currency, recorded_by, at) VALUES ($1, $2, $3, $4, 'upi', $5, $6, $7, $8)`,
              [T, u(), o, order, total, cur, w.owner, at]);
          }
          const agg = channel === f.agg;
          await derive("finance.post_order", `core.order:${order}`, async () => {
            const je = u();
            await q(`INSERT INTO core.journal_entry (tenant_id, id, outlet_id, channel_id, entry_date, source_type, source_id, posting_rule)
                     VALUES ($1, $2, $3, $4, $5, 'core.order', $6, 'finance.post_order')`, [T, je, o, channel, day, order]);
            const lines: Array<[string, number]> = agg
              ? [["1100", total - tax], ["4000", -(total - tax)]]
              : [["1110", total], ["4000", -(total - tax)], ...(tax ? [["2100", -tax] as [string, number]] : [])];
            for (const [code, amount] of lines) {
              await q(`INSERT INTO core.posting (tenant_id, id, journal_entry_id, account_id, amount_minor, currency) VALUES ($1, $2, $3, $4, $5, $6)`,
                [T, u(), je, accounts[code], amount, cur]);
            }
          });
          await derive("inventory.consume_order", `core.order:${order}`, () => item === f.dish
            ? q(`INSERT INTO core.stock_movement (tenant_id, id, outlet_id, ingredient_id, qty_milli, unit, kind, ref_type, ref_id, at)
                 VALUES ($1, $2, $3, $4, $5, 'kg', 'sale_consumption', 'core.order', $6, $7)`, [T, u(), o, f.flour, -(200 * qty) / 1000, order, at])
            : q(`INSERT INTO core.stock_movement (tenant_id, id, outlet_id, ingredient_id, batch_id, qty_milli, unit, kind, ref_type, ref_id, at)
                 VALUES ($1, $2, $3, $4, $5, $6, 'pc', 'sale_consumption', 'core.order', $7, $8)`, [T, u(), o, biscuit, batches[o], -qty, order, at]));
          if (agg && mi === 1) {
            // The September payout: this order at 28% commission (contract 22%) and an ad fee never agreed.
            const s = u();
            await q(`INSERT INTO core.settlement (tenant_id, id, channel_id, outlet_id, period_from, period_to, paid_on, external_ref, net_minor, currency, import_run_id)
                     VALUES ($1, $2, $3, $4, '2026-09-08', '2026-09-14', '2026-09-16', $5, $6, $7, $8)`,
              [T, s, f.agg, o, `PAY-${k}`, total - 8820 - 5000 * k, cur, run]);
            await q(`INSERT INTO core.settlement_line (tenant_id, id, settlement_id, line_no, line_kind, matched_order_id, gross_minor, commission_minor, net_minor, currency)
                     VALUES ($1, $2, $3, 1, 'order', $4, $5, 8820, $6, $7)`, [T, u(), s, order, total, total - 8820, cur]);
            await q(`INSERT INTO core.settlement_line (tenant_id, id, settlement_id, line_no, line_kind, ad_fee_minor, net_minor, currency)
                     VALUES ($1, $2, $3, 2, 'ad_fee', $4, $5, $6)`, [T, u(), s, 5000 * k, -5000 * k, cur]);
          }
        }
        await q(`INSERT INTO core.bank_line (tenant_id, id, outlet_id, account_ref, value_date, amount_minor, currency, method, external_ref, import_run_id)
                 VALUES ($1, $2, $3, 'BANK-FX', $4, $5, $6, 'upi', $7, $8)`, [T, u(), o, day, 40000 * k, cur, `UTR-${k}-${mi}`, run]);
      }
      // Three days ago: one more sale of D, so the windows that end today (recipe_current's 28 days) see consumption.
      const order = u();
      const line = u();
      await q(`INSERT INTO core."order" (tenant_id, id, outlet_id, channel_id, kind, status, business_date, subtotal_minor, discount_minor, tax_minor, total_minor,
                                          currency, pricing_snapshot, created_at)
               VALUES ($1, $2, $3, $4, 'takeaway', 'completed', $5, $6, 0, $7, $8, $9, '{"synthetic": true}', $10)`,
        [T, order, o, w.channel, RECENT, 30000 * k, 1500 * k, 31500 * k, cur, `${RECENT}T07:30:00Z`]);
      await q(`INSERT INTO core.order_line (tenant_id, id, outlet_id, order_id, line_no, item_id, qty_milli, unit_price_minor, line_discount_minor, tax_minor, created_at)
               VALUES ($1, $2, $3, $4, 1, $5, $6, 30000, 0, $7, $8)`, [T, line, o, order, f.dish, 1000 * k, 1500 * k, `${RECENT}T07:30:00Z`]);
      await derive("inventory.consume_order", `core.order:${order}`, () =>
        q(`INSERT INTO core.stock_movement (tenant_id, id, outlet_id, ingredient_id, qty_milli, unit, kind, ref_type, ref_id, at)
           VALUES ($1, $2, $3, $4, $5, 'kg', 'sale_consumption', 'core.order', $6, $7)`, [T, u(), o, f.flour, -200 * k, order, `${RECENT}T07:30:00Z`]));
    }
    await q(`INSERT INTO core.market_signal (tenant_id, id, outlet_id, on_date, kind, label, source, import_run_id) VALUES ($1, $2, $3, '2026-10-24', 'festival', 'festival.dussehra', 'calendar.csv', $4)`,
      [T, u(), B, run]);
    // A tenant-wide bank line paid to outlet A's own UPI VPA (finance.tender_vs_bank credits it to A).
    await q(`INSERT INTO core.bank_line (tenant_id, id, outlet_id, account_ref, value_date, amount_minor, currency, method, payee_vpa, external_ref, import_run_id)
             VALUES ($1, $2, NULL, 'BANK-FX', '2026-09-10', 15000, $3, 'upi', 'outlet1@okbank', 'UTR-VPA-1', $4)`, [T, u(), cur, run]);
  }, { import_run_id: run });

  // 3. Wages, COGS and commission per outlet and month (approved journal adjustments), September rent tenant-wide
  //    (outlet NULL), and waste.
  await approveDraft(db, w, "finance.journal.adjust.v1", async (q) => {
    const je = u();
    await q(`INSERT INTO core.journal_entry (tenant_id, id, outlet_id, entry_date, memo_key) VALUES ($1, $2, NULL, '2026-09-28', 'finance.memo.fixture')`, [T, je]);
    await q(`INSERT INTO core.posting (tenant_id, id, journal_entry_id, account_id, amount_minor, currency) VALUES ($1, $2, $3, $4, 50000, $6), ($1, $7, $3, $5, -50000, $6)`,
      [T, u(), je, accounts["6100"], accounts["1010"], cur, u()]);
  });
  for (const [o, wages, cogs, fees] of [[A, [100000, 120000], [80000, 95000], [6600, 8820]], [B, [50000, 70000], [40000, 60000], [6600, 8820]]] as const) {
    await approveDraft(db, w, "finance.journal.adjust.v1", async (q) => {
      for (const mi of [0, 1]) {
        const je = u();
        await q(`INSERT INTO core.journal_entry (tenant_id, id, outlet_id, entry_date, memo_key) VALUES ($1, $2, $3, $4, 'finance.memo.fixture')`,
          [T, je, o, mi === 0 ? "2026-08-28" : "2026-09-28"]);
        for (const [code, amount] of [["6300", wages[mi]!], ["5000", cogs[mi]!], ["6000", fees[mi]!], ["1010", -(wages[mi]! + cogs[mi]! + fees[mi]!)]] as const) {
          await q(`INSERT INTO core.posting (tenant_id, id, journal_entry_id, account_id, amount_minor, currency) VALUES ($1, $2, $3, $4, $5, $6)`,
            [T, u(), je, accounts[code], amount, cur]);
        }
      }
    });
  }
  // Waste: 2 kg at A on 20 Sep; and in the last three days 50 g at A, 30 g at B (recipe_current's window).
  for (const [o, qty, at] of [[A, 2000, "2026-09-20T09:00:00Z"], [A, 50, `${RECENT}T09:00:00Z`], [B, 30, `${RECENT}T09:00:00Z`]] as const) {
    const waste = u();
    await db.withContext("munim_core", ownerCtx(w, { command_type: "inventory.waste.record.v1" }), async (c) => {
      await c.query(`INSERT INTO core.waste_log (tenant_id, id, outlet_id, ingredient_id, qty_milli, unit, reason, recorded_by, at) VALUES ($1, $2, $3, $4, $5, 'kg', 'overprep', $6, $7)`,
        [T, waste, o, f.flour, qty, w.owner, at]);
      await c.query("SELECT set_config('app.posting_rule', 'inventory.record_waste', true), set_config('app.source_ref', $1, true)", [`core.waste_log:${waste}`]);
      await c.query(`INSERT INTO core.stock_movement (tenant_id, id, outlet_id, ingredient_id, qty_milli, unit, kind, ref_type, ref_id, at)
                     VALUES ($1, $2, $3, $4, $5, 'kg', 'waste', 'core.waste_log', $6, $7)`, [T, u(), o, f.flour, -qty, waste, at]);
    });
  }
  return f;
}

/** Three days before today (UTC): the fixture's recent rows, inside any window that ends today. */
const RECENT = new Date(Date.now() - 3 * 86_400_000).toISOString().slice(0, 10);
