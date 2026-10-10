// T-026 posting gates on embedded Postgres, through the book guard (no superuser writes):
//   • seedChart: the pack's chart + Munim's structural accounts (hand count per pack), idempotent;
//   • same event twice → 1 entry (and a racing pair → 1 entry);
//   • posting into a closed period refused (period_closed), the open month accepted;
//   • unapproved settlement cannot post (source_state): previewed run → refused, 0 entries; committed → 1;
//   • a source outside its rule's state (order not completed, invoice only recorded) → refused, 0 rows;
//   • reversal: one per entry; a disputed invoice cannot be reversed under its rule (reported schema gap);
//   • property: 1,000 generated source documents posted through postFor → every entry balanced, count = key.
import { PACKS } from "@munim/contracts/packs";
import { type TestDb, uuidv7 } from "@munim/db";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { postFor, recordSettlement, reverseFor, seedChart } from "../src/modules/finance/index.ts";
import { openDb } from "./db.ts";
import {
  approveInvoice, buildFinanceTenant, completedOrder, count, entriesFor, type Fx, grn, ingredient, inImportApproval, invoice, own, payroll,
  previewedRun, type Q, refund, supplier, tender,
} from "./finance-fixture.ts";

let db: TestDb;
let fx: Fx;

beforeAll(async () => {
  db = await openDb();
  fx = await buildFinanceTenant(db, "IN");
});
afterAll(async () => db?.stop());

const sqlstate = async (p: Promise<unknown>) => p.then(() => "ok", (e: { code?: string }) => e.code ?? String(e));

describe("seedChart", () => {
  it("IN: 22 pack accounts (the 5 structural ones and 4100 loyalty redemptions included); AU: 23 (hand counts from the pack files); re-seeding adds none", async () => {
    expect(Object.keys(fx.accounts).length).toBe(22);
    expect(fx.accounts["1110"]).toBeDefined(); // counter sales clearing (structural)
    expect(fx.accounts["1300"]).toBeUndefined(); // IN pack carries no input-tax account
    const au = await buildFinanceTenant(db, "AU");
    expect(Object.keys(au.accounts).length).toBe(23);
    expect(au.accounts["1300"]).toBeDefined();
    const again = await db.withContext("munim_core", { tenant_id: fx.tenant, outlet_ids: "*", role: "operator", operator_id: fx.operator, command_type: "tenancy.provision.v1" },
      (c) => seedChart(c, PACKS.IN!));
    expect(again).toEqual(fx.accounts);
    expect(await count(db, `SELECT count(*) n FROM core.account WHERE tenant_id = $1`, [fx.tenant])).toBe(22);
  });

  it("refused outside a command that may write the chart (paired with the accepted provisioning above)", async () => {
    const r = await sqlstate(db.withContext("munim_core", own(fx, "orders.place.v1"), (c) => seedChart(c, { chart_of_accounts: [{ code: "7777", name: "x", type: "expense" }] })));
    expect(r).toBe("MB008");
  });
});

describe("one entry per source per rule", () => {
  it("same event twice → 1 entry, second call returns it with created=false and writes no postings", async () => {
    const order = await completedOrder(db, fx, { outlet: fx.outlets[0], channel: fx.counter, brand: fx.brand, subtotal: 100000, tax: 5000 });
    expect(await entriesFor(db, order)).toBe(1);
    const postingsBefore = await count(db, `SELECT count(*) n FROM core.posting WHERE tenant_id = $1`, [fx.tenant]);
    const again = await db.withContext("munim_core", own(fx, "kitchen.ticket.advance.v1"), (c) => postFor(c, "finance.post_order", `core.order:${order}`));
    expect(again.created).toBe(false);
    expect(again.entry_id).not.toBeNull();
    expect(await entriesFor(db, order)).toBe(1);
    expect(await count(db, `SELECT count(*) n FROM core.posting WHERE tenant_id = $1`, [fx.tenant])).toBe(postingsBefore);
  });

  it("two concurrent posters of the same source → exactly 1 entry", async () => {
    const order = uuidv7();
    await db.withContext("munim_core", own(fx, "orders.place.v1"), (c) =>
      c.query(`INSERT INTO core."order" (tenant_id, id, outlet_id, channel_id, kind, status, subtotal_minor, tax_minor, total_minor, currency, pricing_snapshot)
               VALUES ($1, $2, $3, $4, 'takeaway', 'completed', 1000, 50, 1050, 'INR', '{}')`, [fx.tenant, order, fx.outlets[0], fx.counter]));
    const results = await Promise.allSettled([0, 1].map(() =>
      db.withContext("munim_core", own(fx, "kitchen.ticket.advance.v1"), (c) => postFor(c, "finance.post_order", `core.order:${order}`))));
    expect(results.every((r) => r.status === "fulfilled")).toBe(true);
    expect(await entriesFor(db, order)).toBe(1);
  });
});

describe("closed periods", () => {
  it("an entry dated in a closed month is refused (MB009); the open month is accepted", async () => {
    await db.withContext("munim_core", own(fx, "finance.period.close.v1"), (c) =>
      c.query(`INSERT INTO core.period_close (tenant_id, id, outlet_id, period_month, checklist, net_minor, currency, closed_by)
               VALUES ($1, $2, $3, '2026-03-01', '[]', 0, 'INR', $4)`, [fx.tenant, uuidv7(), fx.outlets[0], fx.owner]));
    const expense = (on: string) => db.withContext("munim_core", own(fx, "finance.expense.record.v1"), async (c) => {
      const id = uuidv7();
      await c.query(`INSERT INTO core.expense (tenant_id, id, outlet_id, category, incurred_on, amount_minor, currency, payee) VALUES ($1, $2, $3, 'rent', $4, 2500000, 'INR', 'Landlord')`,
        [fx.tenant, id, fx.outlets[0], on]);
      await postFor(c, "finance.post_expense", `core.expense:${id}`);
      return id;
    });
    expect(await sqlstate(expense("2026-03-15"))).toBe("MB009");
    expect(await count(db, `SELECT count(*) n FROM core.journal_entry WHERE tenant_id = $1 AND entry_date = '2026-03-15'`, [fx.tenant])).toBe(0);
    const ok = await expense("2026-04-15");
    expect(await entriesFor(db, ok)).toBe(1);
    // The other outlet's March is still open.
    const other = await db.withContext("munim_core", own(fx, "finance.expense.record.v1"), async (c) => {
      const id = uuidv7();
      await c.query(`INSERT INTO core.expense (tenant_id, id, outlet_id, category, incurred_on, amount_minor, currency, payee) VALUES ($1, $2, $3, 'rent', '2026-03-15', 100, 'INR', 'Landlord')`,
        [fx.tenant, id, fx.outlets[1]]);
      await postFor(c, "finance.post_expense", `core.expense:${id}`);
      return id;
    });
    expect(await entriesFor(db, other)).toBe(1);
  });
});

describe("source state (derivation_rule.source_state)", () => {
  const settlement = (run: string) => ({
    settlement_id: uuidv7(), channel_id: fx.agg, outlet_id: fx.outlets[1], period_from: "2026-05-01", period_to: "2026-05-07", paid_on: "2026-05-09",
    external_ref: `PAYOUT-${uuidv7()}`, net_minor: 38450, currency: "INR", import_run_id: run,
    lines: [{ line_id: uuidv7(), line_no: 1, line_kind: "order" as const, external_order_ref: "AGG-1", matched_order_id: null, gross_minor: 52500,
      commission_minor: 11550, ad_fee_minor: 0, promo_share_minor: 0, tax_withheld_minor: 2500, net_minor: 38450 }],
  });

  it("an unapproved (previewed) import's settlement cannot post: refused with 0 entries; once committed, 1 entry", async () => {
    const run = await previewedRun(db, fx);
    // imports.run.commit.v1 is draft-only (0015 A1): a settlement row exists only under an approved draft. Inside
    // that approval, before the run flips to committed, the posting rule's source_state does not hold, so the guard
    // refuses the entry (savepoints keep the settlement and let the approval finish with the run still previewed).
    const s = settlement(run);
    const { refused, seam } = await inImportApproval(db, fx, run, async (c) => {
      await c.query(`INSERT INTO core.settlement (tenant_id, id, channel_id, period_from, period_to, external_ref, net_minor, currency, import_run_id)
                     VALUES ($1, $2, $3, '2026-05-01', '2026-05-07', $4, 1000, 'INR', $5)`, [fx.tenant, s.settlement_id, fx.agg, s.external_ref, run]);
      const attempt = async (fn: () => Promise<unknown>) => {
        await c.query("SAVEPOINT attempt");
        const code = await sqlstate(fn());
        await c.query("ROLLBACK TO SAVEPOINT attempt");
        return code;
      };
      return {
        refused: await attempt(() => postFor(c, "finance.post_settlement", `core.settlement:${s.settlement_id}`)),
        // The seam refuses before writing anything while the run is not committed.
        seam: await attempt(() => recordSettlement(c, settlement(run))),
      };
    }, { commitRun: false });
    expect(refused).toBe("MB008"); // pinned: the derivation fails, then the draft's command (no journal tables) names the mismatch
    expect(seam).toBe("book_write_refused");
    expect(await entriesFor(db, s.settlement_id)).toBe(0);
    expect(await count(db, `SELECT count(*) n FROM core.settlement WHERE id = $1`, [s.settlement_id])).toBe(1);
    // A person's own imports.run.commit.v1 cannot write a settlement at all (draft-only → MB001).
    const ownCmd = await sqlstate(db.withContext("munim_core", own(fx, "imports.run.commit.v1"), (c) =>
      c.query(`INSERT INTO core.settlement (tenant_id, id, channel_id, period_from, period_to, external_ref, net_minor, currency, import_run_id)
               VALUES ($1, $2, $3, '2026-05-01', '2026-05-07', $4, 1000, 'INR', $5)`, [fx.tenant, uuidv7(), fx.agg, `PAYOUT-${uuidv7()}`, run])));
    expect(ownCmd).toBe("MB001");
    // Approved: the run commits, then the seam records and posts.
    const ok = settlement(run);
    const out = await inImportApproval(db, fx, run, (c) => recordSettlement(c, ok));
    expect(out.entry_id).not.toBeNull();
    expect(await entriesFor(db, ok.settlement_id)).toBe(1);
    const origin = (await db.admin<{ origin: { kind: string; rule_id: string } }>(`SELECT origin FROM core.journal_entry WHERE source_id = $1`, [ok.settlement_id])).rows[0]!.origin;
    expect(origin).toMatchObject({ kind: "derivation", rule_id: "finance.post_settlement" });
  });

  it("an order not completed, an invoice only recorded → refused, 0 entries; approved invoice / approved payroll → 1", async () => {
    const placed = uuidv7();
    await db.withContext("munim_core", own(fx, "orders.place.v1"), (c) =>
      c.query(`INSERT INTO core."order" (tenant_id, id, outlet_id, channel_id, kind, status, subtotal_minor, tax_minor, total_minor, currency, pricing_snapshot)
               VALUES ($1, $2, $3, $4, 'takeaway', 'placed', 1000, 50, 1050, 'INR', '{}')`, [fx.tenant, placed, fx.outlets[0], fx.counter]));
    expect(await sqlstate(db.withContext("munim_core", own(fx, "orders.place.v1"), (c) => postFor(c, "finance.post_order", `core.order:${placed}`)))).toMatch(/^MB00[18]$/);
    expect(await entriesFor(db, placed)).toBe(0);

    const sup = await supplier(db, fx);
    const inv = await invoice(db, fx, { supplier: sup, date: "2026-05-05", subtotal: 260000, tax: 13000 });
    expect(await sqlstate(db.withContext("munim_core", own(fx, "purchasing.invoice.record.v1"), (c) => postFor(c, "finance.post_supplier_invoice", `core.supplier_invoice:${inv}`)))).toMatch(/^MB00[18]$/);
    expect(await entriesFor(db, inv)).toBe(0);
    await approveInvoice(db, fx, inv);
    expect(await entriesFor(db, inv)).toBe(1);

    const pd = await payroll(db, fx, { outlet: fx.outlets[0], month: "2026-05-01", lines: [{ base: 1000000, ot: 0, tips: 0, recovery: 0 }] });
    expect(await entriesFor(db, pd)).toBe(1);
  });
});

describe("reversal", () => {
  it("reverseFor writes the one negating entry (Σ entry + reversal = 0 per account); a second call returns it", async () => {
    const o = await completedOrder(db, fx, { outlet: fx.outlets[1], channel: fx.counter, brand: null, subtotal: 40000, tax: 2000 });
    const first = await db.withContext("munim_core", own(fx, "kitchen.ticket.advance.v1"), (c) => reverseFor(c, "finance.post_order", `core.order:${o}`, "2026-06-02"));
    expect(first.created).toBe(true);
    const second = await db.withContext("munim_core", own(fx, "kitchen.ticket.advance.v1"), (c) => reverseFor(c, "finance.post_order", `core.order:${o}`, "2026-06-02"));
    expect(second).toEqual({ entry_id: first.entry_id, created: false });
    expect(await entriesFor(db, o)).toBe(2);
    const net = await db.admin<{ account_id: string; s: string }>(
      `SELECT p.account_id, sum(p.amount_minor) s FROM core.posting p JOIN core.journal_entry je ON je.tenant_id = p.tenant_id AND je.id = p.journal_entry_id
        WHERE je.source_id = $1 GROUP BY 1`, [o]);
    expect(net.rows.length).toBe(3);
    expect(net.rows.every((r) => r.s === "0")).toBe(true);
  });

  it("an invoice that left 'approved' (disputed) cannot be reversed under its rule — refused, 0 rows (schema gap reported)", async () => {
    const sup = await supplier(db, fx);
    const inv = await invoice(db, fx, { supplier: sup, date: "2026-05-06", subtotal: 1000, tax: 50 });
    await approveInvoice(db, fx, inv);
    await db.withContext("munim_core", own(fx, "purchasing.invoice.approve.v1"), (c) =>
      c.query(`UPDATE core.supplier_invoice SET status = 'disputed' WHERE id = $1`, [inv]));
    const r = await sqlstate(db.withContext("munim_core", own(fx, "purchasing.invoice.approve.v1"), (c) =>
      reverseFor(c, "finance.post_supplier_invoice", `core.supplier_invoice:${inv}`, "2026-06-02")));
    expect(r).toMatch(/^MB00[18]$/);
    expect(await entriesFor(db, inv)).toBe(1);
  });
});

// ---- property: 1,000 generated source documents through postFor into the database ---------------------
function rng(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

describe("property: 1,000 generated source documents (seed 20261010) → 100% balanced in the database", () => {
  it("every committed entry balances per currency, every posting is non-zero, entries = documents that move money", { timeout: 240_000 }, async () => {
    const r = rng(20261010);
    const int = (lo: number, hi: number) => lo + Math.floor(r() * (hi - lo + 1));
    const t = await buildFinanceTenant(db, "IN");
    const sup = await supplier(db, t);
    const ing = await ingredient(db, t);
    let docs = 0;
    let moving = 0;
    const kinds = ["order", "tender", "refund", "grn", "invoice", "settlement", "expense", "payroll"] as const;
    const orders: Array<{ id: string; total: number; outlet: string }> = [];
    // One transaction per kind (each writer sets its own command type, as its module would), orders first
    // (tenders and refunds need them): 125 of each kind.
    const batch = (fn: (c: Q) => Promise<void>) => db.withContext("munim_core", own(t, "orders.place.v1"), fn);
    await batch(async (c) => {
      for (let i = 0; i < 125; i++) {
        const agg = r() < 0.4;
        const subtotal = [0, int(1, 99), int(100, 2_000_000)][int(0, 2)]!;
        const tax = subtotal === 0 ? 0 : int(0, Math.floor(subtotal / 10));
        const id = await completedOrder(c, t, { outlet: t.outlets[i % 2]!, channel: agg ? t.agg : t.counter, brand: r() < 0.5 ? t.brand : null, subtotal, tax });
        orders.push({ id, total: subtotal + tax, outlet: t.outlets[i % 2]! });
        docs++;
        // IN aggregator orders: the operator pays the tax — nothing moves when the order is all tax.
        if (subtotal + tax > 0 && (!agg || subtotal > 0)) moving++;
      }
    });
    const paid = orders.filter((o) => o.total > 0);
    await batch(async (c) => {
      for (let i = 0; i < 125; i++) {
        const o = paid[i % paid.length]!;
        await tender(c, t, { order: o.id, outlet: o.outlet, method: (["cash", "card", "upi"] as const)[int(0, 2)]!, amount: int(1, o.total) });
        docs++; moving++;
      }
    });
    await batch(async (c) => {
      for (let i = 0; i < 125; i++) {
        const o = paid[(i * 7) % paid.length]!;
        await refund(c, t, { order: o.id, outlet: o.outlet, method: (["cash", "card", "upi"] as const)[int(0, 2)]!, amount: int(1, o.total) });
        docs++; moving++;
      }
    });
    await batch(async (c) => {
      for (let i = 0; i < 125; i++) {
        const lines = Array.from({ length: int(1, 4) }, () => [int(1, 50_000_000), [0, int(1, 100), int(100, 90_000)][int(0, 2)]!] as [number, number]);
        await grn(c, t, { outlet: t.outlets[i % 2]!, supplier: sup, ingredient: ing, lines });
        docs++;
        if (lines.some(([q, cost]) => Math.round((q * cost) / 1000) !== 0)) moving++;
      }
    });
    await batch(async (c) => {
      for (let i = 0; i < 125; i++) {
        const sub = int(0, 900_000);
        const tax = r() < 0.5 ? 0 : int(0, Math.floor(sub / 5));
        const inv = await invoice(c, t, { supplier: sup, date: `2026-0${int(1, 9)}-1${int(0, 9)}`, subtotal: sub, tax });
        await approveInvoice(c, t, inv);
        docs++;
        if (sub + tax > 0) moving++;
      }
    });
    const run = await previewedRun(db, t);
    await inImportApproval(db, t, run, async (c) => {
      for (let i = 0; i < 125; i++) {
        const lines = Array.from({ length: int(0, 5) }, (_, n) => {
          const kind = (["order", "ad_fee", "promo_share", "adjustment"] as const)[int(0, 3)]!;
          const gross = kind === "order" ? int(0, 900_000) : kind === "adjustment" ? int(-50_000, 50_000) : 0;
          const commission = kind === "order" ? int(0, Math.floor(gross / 3)) : 0;
          const ad = kind === "ad_fee" ? int(0, 30_000) : 0;
          const promo = kind === "promo_share" ? int(0, 30_000) : 0;
          const tax = kind === "order" ? int(0, Math.floor(gross / 20)) : 0;
          return { line_id: uuidv7(), line_no: n + 1, line_kind: kind, external_order_ref: null, matched_order_id: null, gross_minor: gross, commission_minor: commission,
            ad_fee_minor: ad, promo_share_minor: promo, tax_withheld_minor: tax, net_minor: gross - commission - ad - promo - tax };
        });
        const net = lines.length ? lines.reduce((a, l) => a + l.net_minor, 0) : int(-1000, 900_000);
        await recordSettlement(c, { settlement_id: uuidv7(), channel_id: t.agg, outlet_id: null, period_from: "2026-07-01", period_to: "2026-07-07", paid_on: null,
          external_ref: `P-${i}`, net_minor: net, currency: "INR", import_run_id: run, lines });
        docs++;
        if (lines.length ? lines.some((l) => l.gross_minor !== 0 || l.net_minor !== 0) : net !== 0) moving++;
      }
    });
    await batch(async (c) => {
      for (let i = 0; i < 125; i++) {
        const amount = int(1, 5_000_000);
        const id = uuidv7();
        await c.query("SELECT set_config('app.command_type', 'finance.expense.record.v1', true)");
        await c.query(`INSERT INTO core.expense (tenant_id, id, outlet_id, category, incurred_on, amount_minor, tax_minor, currency, payee) VALUES ($1, $2, $3, $4, $5, $6, $7, 'INR', 'Payee')`,
          [t.tenant, id, t.outlets[i % 2], ["rent", "utilities", "repairs", "marketing", "packaging", "bank_charges", "professional_fees", "other"][int(0, 7)], `2026-0${int(1, 9)}-0${int(1, 9)}`,
           amount, int(0, Math.floor(amount / 5))]);
        await postFor(c, "finance.post_expense", `core.expense:${id}`);
        docs++; moving++;
      }
    });
    await batch(async (c) => {
      for (let i = 0; i < 125; i++) {
        const lines = Array.from({ length: int(1, 3) }, () => {
          const base = int(0, 3_000_000); const ot = int(0, 200_000); const tips = int(0, 50_000);
          return { base, ot, tips, recovery: int(0, base + ot + tips) };
        });
        // One payroll per outlet per month (payroll_draft_one_per_month): outlet i % 2, a distinct month per pair.
        const k = Math.floor(i / 2);
        await payroll(c, t, { outlet: t.outlets[i % 2]!, month: `${2020 + Math.floor(k / 12)}-${String((k % 12) + 1).padStart(2, "0")}-01`, lines });
        docs++;
        if (lines.some((l) => l.base + l.ot + l.tips > 0)) moving++;
      }
    });
    expect(docs).toBe(1000);
    expect(kinds.length * 125).toBe(1000);

    const entries = await count(db, `SELECT count(*) n FROM core.journal_entry WHERE tenant_id = $1`, [t.tenant]);
    expect(entries).toBe(moving);
    expect(entries).toBeGreaterThan(900);
    const unbalanced = await count(db,
      `SELECT count(*) n FROM (SELECT je.id, p.currency FROM core.journal_entry je JOIN core.posting p ON p.tenant_id = je.tenant_id AND p.journal_entry_id = je.id
         WHERE je.tenant_id = $1 GROUP BY je.id, p.currency HAVING sum(p.amount_minor) <> 0) x`, [t.tenant]);
    expect(unbalanced).toBe(0);
    const thin = await count(db, `SELECT count(*) n FROM (SELECT je.id FROM core.journal_entry je LEFT JOIN core.posting p ON p.tenant_id = je.tenant_id AND p.journal_entry_id = je.id
         WHERE je.tenant_id = $1 GROUP BY je.id HAVING count(p.id) < 2) x`, [t.tenant]);
    expect(thin).toBe(0);
    expect(await count(db, `SELECT count(*) n FROM core.posting WHERE tenant_id = $1 AND amount_minor = 0`, [t.tenant])).toBe(0);
    expect(await count(db, `SELECT count(*) n FROM core.journal_entry WHERE tenant_id = $1 AND (origin ->> 'kind') <> 'derivation'`, [t.tenant])).toBe(0);
  });
});
