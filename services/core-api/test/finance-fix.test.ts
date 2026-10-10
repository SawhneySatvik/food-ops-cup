// W2 fix cycle 1 (lane f-2) — finance derivations on embedded Postgres, through the book guard, hand-computed:
//   R2-S1-4 points redeemed: finance.post_loyalty_redemption (0016) moves their value out of 1110; it nets to 0 with the tenders;
//   R2-S1-6 invoice vs GRN: GRNI clears for what was received, the variance and non-goods lines are cost;
//   R2-S3-2 partial refunds reverse exactly the order's tax; R2-S2-10 an aggregator refund is a channel deduction;
//   R2 P4 a refund of a sale never posted (paid, refunded, then cancelled) leaves sales and tax alone;
//   R2-S2-9 short payout expects the ORDER's tax where the operator collects it;
//   R2-S3-5 an invoice / payout dated in a closed month posts on the first open day, labelled (an expense still refuses).
// Synthetic data only.
import { type TestDb, uuidv7 } from "@munim/db";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { postFor, recordSettlement } from "../src/modules/finance/index.ts";
import { openDb } from "./db.ts";
import {
  buildFinanceTenant, completedOrder, type Fx, grn, ingredient, inImportApproval, own, previewedRun, refund, supplier, tender, terms,
} from "./finance-fixture.ts";

let db: TestDb;
let fx: Fx;

beforeAll(async () => {
  db = await openDb();
  fx = await buildFinanceTenant(db, "IN");
}, 120_000);
afterAll(async () => db?.stop());

/** account code → Σ amount over the entries of `sourceId` (optionally one rule). */
async function net(sourceIds: string[], rule?: string): Promise<Record<string, number>> {
  const r = await db.admin<{ code: string; s: string }>(
    `SELECT a.code, sum(p.amount_minor)::text AS s FROM core.journal_entry j JOIN core.posting p ON p.tenant_id = j.tenant_id AND p.journal_entry_id = j.id
       JOIN core.account a ON a.tenant_id = p.tenant_id AND a.id = p.account_id
      WHERE j.source_id = ANY ($1) AND ($2::text IS NULL OR j.posting_rule = $2) GROUP BY a.code ORDER BY a.code`, [sourceIds, rule ?? null]);
  return Object.fromEntries(r.rows.map((x) => [x.code, Number(x.s)]));
}
const inCmd = <T>(f: Fx, type: string, fn: (c: { query: (s: string, p?: unknown[]) => Promise<{ rows: any[] }> }) => Promise<T>) =>
  db.withContext("munim_core", own(f, type), fn);

describe("R2-S1-4: an order part-paid in points", () => {
  it("completed: the order posts 1110 for its total, the redemption entry moves the points' 1,000 to 4100; the card tender clears 1110 to 0", async () => {
    // total 25,200 (tax 1,200); 100 points worth 1,000 applied at placement; the till takes 24,200.
    const order = async (redeem: boolean) => {
      const id = uuidv7(), cust = uuidv7(), entry = uuidv7();
      await inCmd(fx, "customers.customer.upsert.v1", (c) =>
        c.query(`INSERT INTO core.customer (tenant_id, id, name, is_guest, origin) VALUES ($1, $2, 'Synthetic Points Holder', false, '{}')`, [fx.tenant, cust]));
      await inCmd(fx, "customers.loyalty.adjust.v1", async (c) => {
        await c.query(`INSERT INTO core.loyalty_entry (tenant_id, id, customer_id, seq, kind, points, balance_after, note, origin) VALUES ($1, $2, $3, 0, 'adjust', 100, 0, 'seed', '{}')`,
          [fx.tenant, uuidv7(), cust]);
      });
      await inCmd(fx, "orders.place.v1", async (c) => {
        await c.query(`INSERT INTO core."order" (tenant_id, id, outlet_id, channel_id, kind, status, subtotal_minor, tax_minor, total_minor, currency, pricing_snapshot, customer_id)
                       VALUES ($1, $2, $3, $4, 'takeaway', 'placed', 24000, 1200, 25200, 'INR', $5, $6)`,
          [fx.tenant, id, fx.outlets[0], fx.counter, { loyalty: { entry_id: entry, points: 100, value_minor: 1000 } }, cust]);
        if (redeem) {
          await c.query(`INSERT INTO core.loyalty_entry (tenant_id, id, customer_id, seq, kind, points, balance_after, order_id, origin) VALUES ($1, $2, $3, 0, 'redeem', -100, 0, $4, '{}')`,
            [fx.tenant, entry, cust, id]);
        }
      });
      await inCmd(fx, "kitchen.ticket.advance.v1", async (c) => {
        for (const st of ["accepted", "preparing", "ready", "completed"]) await c.query(`UPDATE core."order" SET status = $2 WHERE id = $1`, [id, st]);
        await postFor(c as never, "finance.post_order", `core.order:${id}`);
      });
      return id;
    };
    const id = await order(true);
    expect(await net([id], "finance.post_order")).toEqual({ "1110": 25200, "2100": -1200, "4000": -24000 });
    expect(await net([id], "finance.post_loyalty_redemption")).toEqual({ "1110": -1000, "4100": 1000 });
    const t = await tender(db, fx, { order: id, outlet: fx.outlets[0], method: "card", amount: 24200 });
    expect((await net([id, t]))["1110"] ?? 0).toBe(0);
    // A snapshot value with no redeem row behind it does not trace to the ledger: no redemption entry.
    const bare = await order(false);
    expect(await net([bare])).toEqual({ "1110": 25200, "2100": -1200, "4000": -24000 });
  });
});

describe("R2-S1-6: supplier invoice against the goods received", () => {
  /** A committed PO line, a GRN of `received` kg against it at `cost` per kg, and a recorded invoice of `lines`. */
  async function chain(o: { qty: number; cost: number; received: number[]; billed: Array<{ kg: number | null; price: number; tax: number; text?: string }> }) {
    const sup = await supplier(db, fx);
    const ing = await ingredient(db, fx); // base unit kg
    const po = uuidv7(), poLine = uuidv7(), inv = uuidv7();
    await inCmd(fx, "purchasing.po.create.v1", async (c) => {
      await c.query(`INSERT INTO core.purchase_order (tenant_id, id, supplier_id, outlet_ids, currency, total_minor) VALUES ($1, $2, $3, $4, 'INR', $5)`,
        [fx.tenant, po, sup, [fx.outlets[0]], (o.qty * o.cost) / 1000]);
      await c.query(`INSERT INTO core.po_line (tenant_id, id, po_id, line_no, ingredient_id, qty_milli, unit, unit_price_minor) VALUES ($1, $2, $3, 1, $4, $5, 'kg', $6)`,
        [fx.tenant, poLine, po, ing, o.qty, o.cost]);
    });
    const grns: string[] = [];
    const receive = async (kg: number) => {
      const g = uuidv7();
      await inCmd(fx, "purchasing.grn.receive.v1", async (c) => {
        await c.query(`INSERT INTO core.goods_received (tenant_id, id, outlet_id, supplier_id, po_id, received_by) VALUES ($1, $2, $3, $4, $5, $6)`,
          [fx.tenant, g, fx.outlets[0], sup, po, fx.owner]);
        await c.query(`INSERT INTO core.grn_line (tenant_id, id, goods_received_id, po_line_id, ingredient_id, qty_milli, unit, unit_cost_minor, currency)
                       VALUES ($1, $2, $3, $4, $5, $6, 'kg', $7, 'INR')`, [fx.tenant, uuidv7(), g, poLine, ing, kg, o.cost]);
        await postFor(c as never, "finance.post_grn", `core.goods_received:${g}`);
      });
      grns.push(g);
    };
    for (const kg of o.received) await receive(kg);
    await inCmd(fx, "purchasing.invoice.record.v1", async (c) => {
      const sub = o.billed.reduce((a, l) => a + Math.round(((l.kg ?? 1000) * l.price) / 1000), 0);
      const tax = o.billed.reduce((a, l) => a + l.tax, 0);
      await c.query(`INSERT INTO core.supplier_invoice (tenant_id, id, supplier_id, invoice_no, invoice_date, po_id, subtotal_minor, tax_minor, total_minor, currency)
                     VALUES ($1, $2, $3, $4, current_date, $5, $6, $7, $8, 'INR')`, [fx.tenant, inv, sup, `INV-${inv.slice(-6)}`, po, sub, tax, sub + tax]);
      for (const [i, l] of o.billed.entries()) {
        const amount = Math.round(((l.kg ?? 1000) * l.price) / 1000);
        await c.query(`INSERT INTO core.supplier_invoice_line (tenant_id, id, supplier_invoice_id, line_no, po_line_id, ingredient_id, description, qty_milli, unit, unit_price_minor, tax_minor, line_total_minor)
                       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)`,
          [fx.tenant, uuidv7(), inv, i + 1, l.kg === null ? null : poLine, l.kg === null ? null : ing, l.text ?? null, l.kg ?? 1000, l.kg === null ? "unit" : "kg", l.price, l.tax, amount + l.tax]);
      }
    });
    await inCmd(fx, "purchasing.invoice.approve.v1", async (c) => {
      await c.query(`UPDATE core.supplier_invoice SET status = 'approved' WHERE id = $1`, [inv]);
      await postFor(c as never, "finance.post_supplier_invoice", `core.supplier_invoice:${inv}`);
    });
    return { inv, grns, receive };
  }

  it("hand fixture: 10 kg received at ₹100, billed at ₹105 + ₹52.50 tax (IN) → COGS 1,10,250, GRNI 0, payable 1,10,250", async () => {
    const x = await chain({ qty: 10000, cost: 10000, received: [10000], billed: [{ kg: 10000, price: 10500, tax: 5250 }] });
    expect(await net([x.inv])).toEqual({ "2000": -110250, "2050": 100000, "5000": 10250 });
    expect(await net([x.inv, ...x.grns])).toEqual({ "2000": -110250, "2050": 0, "5000": 110250 });
  });

  it("billed before all of it arrived, plus delivery: the received 6 kg clear GRNI, the 4 kg wait in it, delivery is cost; the later receipt clears it to 0", async () => {
    // Billed 10 kg at ₹100 (1,00,000) + delivery ₹15 (1,500): received 6 kg → clears 60,000; 40,000 stays in GRNI; COGS 1,500 + 0 variance.
    const x = await chain({ qty: 10000, cost: 10000, received: [6000], billed: [{ kg: 10000, price: 10000, tax: 0 }, { kg: null, price: 1500, tax: 0, text: "Delivery" }] });
    expect(await net([x.inv])).toEqual({ "2000": -101500, "2050": 100000, "5000": 1500 });
    expect((await net([x.inv, ...x.grns]))["2050"]).toBe(40000);
    await x.receive(4000);
    expect(await net([x.inv, ...x.grns])).toEqual({ "2000": -101500, "2050": 0, "5000": 101500 });
  });
});

describe("R2-S3-2 and R2-S2-10: refunds", () => {
  it("351 + 351 + 348 of a 1,050 order with 50 tax reverse 17 + 16 + 17 = 50 of output tax", async () => {
    const o = await completedOrder(db, fx, { outlet: fx.outlets[0], channel: fx.counter, brand: null, subtotal: 1000, tax: 50 });
    await tender(db, fx, { order: o, outlet: fx.outlets[0], method: "cash", amount: 1050 });
    const rs: string[] = [];
    for (const a of [351, 351, 348]) rs.push(await refund(db, fx, { order: o, outlet: fx.outlets[0], method: "cash", amount: a }));
    const tax = [];
    for (const r of rs) tax.push((await net([r]))["2100"]);
    expect(tax).toEqual([17, 16, 17]);
    expect((await net([o, ...rs]))["2100"] ?? 0).toBe(0);
  });

  it("R2 P4: paid 21,000 cash, refunded before it completed (no sale posted): the refund debits 1110 back against cash; sales and tax untouched, 1110 nets to 0", async () => {
    const o = uuidv7();
    await inCmd(fx, "orders.place.v1", (c) =>
      c.query(`INSERT INTO core."order" (tenant_id, id, outlet_id, channel_id, kind, status, subtotal_minor, tax_minor, total_minor, currency, pricing_snapshot)
               VALUES ($1, $2, $3, $4, 'takeaway', 'placed', 20000, 1000, 21000, 'INR', '{}')`, [fx.tenant, o, fx.outlets[0], fx.counter]));
    const t = await tender(db, fx, { order: o, outlet: fx.outlets[0], method: "cash", amount: 21000 });
    const r = await refund(db, fx, { order: o, outlet: fx.outlets[0], method: "cash", amount: 21000 });
    expect(await net([r])).toEqual({ "1000": -21000, "1110": 21000 });
    expect(await net([o, t, r])).toEqual({ "1000": 0, "1110": 0 });
  });

  it("an aggregator order's refund (IN Sec 9(5)) debits sales and credits the channel receivable — no cash or bank", async () => {
    const o = await completedOrder(db, fx, { outlet: fx.outlets[1], channel: fx.agg, brand: null, subtotal: 50000, tax: 2500 });
    const r = await refund(db, fx, { order: o, outlet: fx.outlets[1], method: "upi", amount: 1000 });
    expect(await net([r])).toEqual({ "1100": -1000, "4000": 1000 });
  });
});

describe("R2-S2-9: short payout", () => {
  it("IN (operator collects): a statement withholding 5,000 on an order whose tax is 2,500 is short by 2,500; withholding the order's tax is not short", async () => {
    await terms(db, fx, { channel: fx.agg, commission_bp: 2200, ads_opted_in: true, from: "2025-01-01" });
    const over = await completedOrder(db, fx, { outlet: fx.outlets[1], channel: fx.agg, brand: null, subtotal: 50000, tax: 2500 });
    const fair = await completedOrder(db, fx, { outlet: fx.outlets[1], channel: fx.agg, brand: null, subtotal: 50000, tax: 2500 });
    const run = await previewedRun(db, fx);
    const line = (n: number, order: string, withheld: number) => ({ line_id: uuidv7(), line_no: n, line_kind: "order" as const, external_order_ref: `AGG-${n}`,
      matched_order_id: order, gross_minor: 52500, commission_minor: 11550, ad_fee_minor: 0, promo_share_minor: 0, tax_withheld_minor: withheld, net_minor: 52500 - 11550 - withheld });
    const out = await inImportApproval(db, fx, run, (c) => recordSettlement(c as never, {
      settlement_id: uuidv7(), channel_id: fx.agg, outlet_id: fx.outlets[1], period_from: "2026-10-01", period_to: "2026-10-07", paid_on: "2026-10-08",
      external_ref: `PAYOUT-${uuidv7()}`, net_minor: 35950 + 38450, currency: "INR", import_run_id: run, lines: [line(1, over, 5000), line(2, fair, 2500)] }));
    const breaks = (await db.admin<{ order_id: string; kind: string; amount_minor: string }>(
      `SELECT order_id, kind, amount_minor FROM core.reconciliation_break WHERE id = ANY ($1)`, [out.break_ids])).rows;
    // expected net = 52,500 − 11,550 − 2,500 (the order's tax) = 38,450; paid 35,950 → short 2,500.
    expect(breaks.map((b) => [b.order_id, b.kind, Number(b.amount_minor)])).toEqual([[over, "short_payout", 2500]]);
  });
});

describe("R2-S3-5: documents dated in a closed month", () => {
  it("an approved invoice and a payout dated in closed months post on the first open day, labelled with their own date; an expense there is still refused", async () => {
    const f = await buildFinanceTenant(db, "IN");
    // August and September closed for the whole business.
    await inCmd(f, "finance.period.close.v1", async (c) => {
      for (const m of ["2026-08-01", "2026-09-01"]) {
        await c.query(`INSERT INTO core.period_close (tenant_id, id, outlet_id, period_month, checklist, net_minor, currency, closed_by) VALUES ($1, $2, NULL, $3, '[]', 0, 'INR', $4)`,
          [f.tenant, uuidv7(), m, f.owner]);
      }
    });
    const sup = await supplier(db, f);
    const inv = uuidv7();
    await inCmd(f, "purchasing.invoice.record.v1", (c) =>
      c.query(`INSERT INTO core.supplier_invoice (tenant_id, id, supplier_id, invoice_no, invoice_date, subtotal_minor, tax_minor, total_minor, currency)
               VALUES ($1, $2, $3, 'INV-LATE', '2026-08-15', 10000, 500, 10500, 'INR')`, [f.tenant, inv, sup]));
    await inCmd(f, "purchasing.invoice.approve.v1", async (c) => {
      await c.query(`UPDATE core.supplier_invoice SET status = 'approved' WHERE id = $1`, [inv]);
      await postFor(c as never, "finance.post_supplier_invoice", `core.supplier_invoice:${inv}`);
    });
    const run = await previewedRun(db, f);
    const s = uuidv7();
    await inImportApproval(db, f, run, (c) => recordSettlement(c as never, {
      settlement_id: s, channel_id: f.agg, outlet_id: null, period_from: "2026-09-20", period_to: "2026-09-26", paid_on: "2026-09-30", external_ref: "PAYOUT-LATE",
      net_minor: 8000, currency: "INR", import_run_id: run, lines: [] }));
    const head = async (id: string) => (await db.admin<{ d: string; m: string | null }>(`SELECT entry_date::text AS d, memo_key AS m FROM core.journal_entry WHERE source_id = $1`, [id])).rows;
    expect(await head(inv)).toEqual([{ d: "2026-10-01", m: "finance.closed_period.from_2026_08_15" }]);
    expect(await head(s)).toEqual([{ d: "2026-10-01", m: "finance.closed_period.from_2026_09_30" }]);
    // A person's own expense dated in a closed month is still refused (they choose the date), paired with the open month.
    const expense = (on: string) => inCmd(f, "finance.expense.record.v1", async (c) => {
      const id = uuidv7();
      await c.query(`INSERT INTO core.expense (tenant_id, id, outlet_id, category, incurred_on, amount_minor, tax_minor, currency, payee) VALUES ($1, $2, $3, 'utilities', $4, 1000, 0, 'INR', 'Power Co')`,
        [f.tenant, id, f.outlets[0], on]);
      await postFor(c as never, "finance.post_expense", `core.expense:${id}`);
    }).then(() => "ok", (e: { code?: string }) => e.code);
    expect([await expense("2026-09-10"), await expense("2026-10-10")]).toEqual(["MB009", "ok"]);
  });
});
