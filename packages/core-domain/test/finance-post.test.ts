// T-026 posting-rule goldens (expected lines written by hand, never computed by the code under test) and the
// pure property gate: 1,000 generated source documents → every result balances (Σ = 0), has ≥ 2 non-zero lines
// on distinct roles, or is null only when the document moves no money. Plus the chart: every role's code is in
// both pack charts with the right type, or is one of Munim's structural accounts.
import { PACKS } from "@munim/contracts/packs";
import { describe, expect, it } from "vitest";
import {
  chartFor, channelTreatment, codesOf, finish, type Line, PNL_GROUPS, postAdvance, postExpense, postGrn, postLoyaltyRedemption, postOrder, postPayroll, postRefund, postSettlement,
  postSupplierInvoice, postTender, reverse, roleResolver, ROLES, STRUCTURAL_ACCOUNTS, tallyCsv,
} from "../finance/index.ts";

const L = (...pairs: Array<[Line["role"], number]>): Line[] => pairs.map(([role, amount_minor]) => ({ role, amount_minor }));
const counter = { aggregator: false, operator_collects: false };
const aggOperator = { aggregator: true, operator_collects: true };
const aggMerchant = { aggregator: true, operator_collects: false };

describe("posting goldens (hand-computed)", () => {
  it("finance.post_order", () => {
    expect(postOrder({ ...counter, total_minor: 33600, tax_minor: 1600 })).toEqual(L(["counter_receivable", 33600], ["sales", -32000], ["output_tax", -1600]));
    // Operator pays the tax (e.g. Sec 9(5)): neither our output tax nor owed to us.
    expect(postOrder({ ...aggOperator, total_minor: 52500, tax_minor: 2500 })).toEqual(L(["channel_receivable", 50000], ["sales", -50000]));
    expect(postOrder({ ...aggMerchant, total_minor: 11000, tax_minor: 1000 })).toEqual(L(["channel_receivable", 11000], ["sales", -10000], ["output_tax", -1000]));
    expect(postOrder({ ...counter, total_minor: 0, tax_minor: 0 })).toBeNull();
  });

  it("finance.post_loyalty_redemption: the points' value leaves 1110; with the order and its tender 1110 nets to 0 (R2-S1-4)", () => {
    // total 25,200 (tax 1,200); 100 points × 10 = 1,000 redeemed; the till takes the remaining 24,200 by card.
    const o = postOrder({ ...counter, total_minor: 25200, tax_minor: 1200 })!;
    const r = postLoyaltyRedemption({ aggregator: false, value_minor: 1000 });
    expect(r).toEqual(L(["loyalty_redemption", 1000], ["counter_receivable", -1000]));
    const t = postTender({ aggregator: false, method: "card", amount_minor: 24200, rounding_minor: 0 })!;
    expect([...o, ...r!, ...t].filter((l) => l.role === "counter_receivable").reduce((a, l) => a + l.amount_minor, 0)).toBe(0);
    expect(postLoyaltyRedemption({ aggregator: false, value_minor: 0 })).toBeNull();
  });

  it("finance.post_tender (cash rounding to its own account)", () => {
    expect(postTender({ aggregator: false, method: "cash", amount_minor: 33600, rounding_minor: 0 })).toEqual(L(["cash", 33600], ["counter_receivable", -33600]));
    expect(postTender({ aggregator: false, method: "cash", amount_minor: 33600, rounding_minor: 2 })).toEqual(L(["cash", 33600], ["counter_receivable", -33598], ["rounding", -2]));
    expect(postTender({ aggregator: false, method: "cash", amount_minor: 33600, rounding_minor: -3 })).toEqual(L(["cash", 33600], ["counter_receivable", -33603], ["rounding", 3]));
    expect(postTender({ aggregator: false, method: "upi", amount_minor: 33600, rounding_minor: 0 })).toEqual(L(["bank", 33600], ["counter_receivable", -33600]));
  });

  it("finance.post_refund (tax share pro rata, half away from zero)", () => {
    expect(postRefund({ operator_collects: false, method: "cash", amount_minor: 16800, order_total_minor: 33600, order_tax_minor: 1600 })).toEqual(L(["sales", 16000], ["output_tax", 800], ["cash", -16800]));
    // 1000 × 1600 / 33600 = 47.62 → 48
    expect(postRefund({ operator_collects: false, method: "card", amount_minor: 1000, order_total_minor: 33600, order_tax_minor: 1600 })).toEqual(L(["sales", 952], ["output_tax", 48], ["bank", -1000]));
    expect(postRefund({ operator_collects: true, method: "upi", amount_minor: 1000, order_total_minor: 52500, order_tax_minor: 2500 })).toEqual(L(["sales", 1000], ["bank", -1000]));
  });

  it("finance.post_refund: partial refunds reverse exactly the order's tax (cumulative shares, R2-S3-2)", () => {
    // 1,050 order with 50 tax refunded 351 + 351 + 348: shares round(351·50/1050)=17, round(702·50/1050)=33 → 16, 50 − 33 = 17.
    const parts = [[0, 351], [351, 351], [702, 348]].map(([prior, a]) =>
      postRefund({ operator_collects: false, method: "cash", amount_minor: a!, order_total_minor: 1050, order_tax_minor: 50, prior_refunded_minor: prior! })!);
    expect(parts).toEqual([L(["sales", 334], ["output_tax", 17], ["cash", -351]), L(["sales", 335], ["output_tax", 16], ["cash", -351]), L(["sales", 331], ["output_tax", 17], ["cash", -348])]);
    expect(parts.flat().filter((l) => l.role === "output_tax").reduce((a, l) => a + l.amount_minor, 0)).toBe(50);
  });

  it("finance.post_refund of a sale never posted (paid → refunded → cancelled): 1110 back against the till, sales and tax untouched (R2 P4)", () => {
    // 21,000 cash taken (Dr 1000 / Cr 1110), refunded in full before completion.
    const t = postTender({ aggregator: false, method: "cash", amount_minor: 21000, rounding_minor: 0 })!;
    const r = postRefund({ operator_collects: false, method: "cash", amount_minor: 21000, order_total_minor: 21000, order_tax_minor: 1000, sale_posted: false })!;
    expect(r).toEqual(L(["counter_receivable", 21000], ["cash", -21000]));
    const sum = (role: string) => [...t, ...r].filter((l) => l.role === role).reduce((a, l) => a + l.amount_minor, 0);
    expect([sum("counter_receivable"), sum("cash"), sum("sales"), sum("output_tax")]).toEqual([0, 0, 0, 0]);
    // An aggregator order never posted: nothing to undo (no entry).
    expect(postRefund({ aggregator: true, operator_collects: true, method: "upi", amount_minor: 1000, order_total_minor: 1050, order_tax_minor: 50, sale_posted: false })).toBeNull();
  });

  it("finance.post_refund of an aggregator order is a deduction from the channel, never our till (R2-S2-10)", () => {
    // AU merchant-collects: 11,000 with 1,000 GST refunded 5,500 → sales 5,000, GST 500, against the channel receivable.
    expect(postRefund({ aggregator: true, operator_collects: false, method: "card", amount_minor: 5500, order_total_minor: 11000, order_tax_minor: 1000 }))
      .toEqual(L(["sales", 5000], ["output_tax", 500], ["channel_receivable", -5500]));
    // IN Sec 9(5): the operator's tax is not ours; the whole refund is sales.
    expect(postRefund({ aggregator: true, operator_collects: true, method: "upi", amount_minor: 1000, order_total_minor: 52500, order_tax_minor: 2500 }))
      .toEqual(L(["sales", 1000], ["channel_receivable", -1000]));
  });

  it("finance.post_grn (purchases method) and finance.post_supplier_invoice (GRNI, no double count)", () => {
    // 12 kg × 340.00 = 4080.00; 2.5 × 19.99 = 49.975 → 49.98
    expect(postGrn({ lines: [{ qty_milli: 12000, unit_cost_minor: 34000 }, { qty_milli: 2500, unit_cost_minor: 1999 }] })).toEqual(L(["cogs", 412998], ["grni", -412998]));
    expect(postSupplierInvoice({ subtotal_minor: 408000, tax_minor: 20400, total_minor: 428400, input_tax: true })).toEqual(L(["grni", 408000], ["input_tax", 20400], ["payables", -428400]));
    expect(postSupplierInvoice({ subtotal_minor: 408000, tax_minor: 20400, total_minor: 428400, input_tax: false })).toEqual(L(["grni", 408000], ["cogs", 20400], ["payables", -428400]));
  });

  it("invoice above the GRN price: GRNI clears for what was received, the variance is cost (R2-S1-6)", () => {
    // 10 kg received at ₹100/kg (GRN 1,00,000), billed at ₹105/kg + ₹52.50 tax (IN: no input-tax account).
    const g = postGrn({ lines: [{ qty_milli: 10000, unit_cost_minor: 10000 }] })!;
    const i = postSupplierInvoice({ subtotal_minor: 105000, tax_minor: 5250, total_minor: 110250, input_tax: false, grni_minor: 100000 })!;
    expect(i).toEqual(L(["grni", 100000], ["cogs", 10250], ["payables", -110250]));
    const net = (role: string) => [...g, ...i].filter((l) => l.role === role).reduce((a, l) => a + l.amount_minor, 0);
    expect([net("cogs"), net("grni"), net("payables")]).toEqual([110250, 0, -110250]);
    // Billed below the GRN (₹98/kg) with input tax (AU): the variance credits cost.
    expect(postSupplierInvoice({ subtotal_minor: 98000, tax_minor: 9800, total_minor: 107800, input_tax: true, grni_minor: 100000 }))
      .toEqual(L(["grni", 100000], ["cogs", -2000], ["input_tax", 9800], ["payables", -107800]));
  });

  it("finance.post_advance: given and paid back directly against the bank; a payroll recovery posts nothing here (R2-S1-5)", () => {
    expect(postAdvance({ kind: "given", amount_minor: 200000, via_payroll: false })).toEqual(L(["staff_advances", 200000], ["bank", -200000]));
    expect(postAdvance({ kind: "recovered", amount_minor: 50000, via_payroll: false })).toEqual(L(["staff_advances", -50000], ["bank", 50000]));
    expect(postAdvance({ kind: "recovered", amount_minor: 200000, via_payroll: true })).toBeNull();
    // ₹2,000 given, ₹2,000 recovered through a ₹30,000 payroll: 1250 ends at 0.
    const p = postPayroll({ lines: [{ base_minor: 3000000, overtime_minor: 0, tips_minor: 0, advance_recovery_minor: 200000, net_minor: 2800000 }] })!;
    const all = [...postAdvance({ kind: "given", amount_minor: 200000, via_payroll: false })!, ...p];
    expect(all.filter((l) => l.role === "staff_advances").reduce((a, l) => a + l.amount_minor, 0)).toBe(0);
  });

  it("finance.post_settlement", () => {
    const orderLine = { gross_minor: 52500, commission_minor: 11550, ad_fee_minor: 0, promo_share_minor: 0, tax_withheld_minor: 2500, net_minor: 38450 };
    const adLine = { gross_minor: 0, commission_minor: 0, ad_fee_minor: 3000, promo_share_minor: 0, tax_withheld_minor: 0, net_minor: -3000 };
    expect(postSettlement({ ...aggOperator, net_minor: 35450, lines: [orderLine, adLine] })).toEqual(L(["bank", 35450], ["commission", 11550], ["channel_promotions", 3000], ["channel_receivable", -50000]));
    const m = { gross_minor: 11000, commission_minor: 2420, ad_fee_minor: 0, promo_share_minor: 0, tax_withheld_minor: 110, net_minor: 8470 };
    expect(postSettlement({ ...aggMerchant, net_minor: 8470, lines: [m] })).toEqual(L(["bank", 8470], ["commission", 2420], ["output_tax", 110], ["channel_receivable", -11000]));
    expect(postSettlement({ ...aggMerchant, net_minor: 26208, lines: [] })).toEqual(L(["bank", 26208], ["channel_receivable", -26208]));
  });

  it("finance.post_expense and finance.post_payroll", () => {
    expect(postExpense({ category: "utilities", amount_minor: 450000, tax_minor: 0, input_tax: true })).toEqual(L(["utilities", 450000], ["bank", -450000]));
    expect(postExpense({ category: "repairs", amount_minor: 11800, tax_minor: 1800, input_tax: true })).toEqual(L(["other_expense", 10000], ["input_tax", 1800], ["bank", -11800]));
    expect(postExpense({ category: "repairs", amount_minor: 11800, tax_minor: 1800, input_tax: false })).toEqual(L(["other_expense", 11800], ["bank", -11800]));
    expect(postExpense({ category: "packaging", amount_minor: 5000, tax_minor: 0, input_tax: false })).toEqual(L(["cogs", 5000], ["bank", -5000]));
    expect(postPayroll({ lines: [
      { base_minor: 1500000, overtime_minor: 120000, tips_minor: 20000, advance_recovery_minor: 50000, net_minor: 1590000 },
      { base_minor: 1200000, overtime_minor: 0, tips_minor: 0, advance_recovery_minor: 0, net_minor: 1200000 },
    ] })).toEqual(L(["wages", 2840000], ["bank", -2790000], ["staff_advances", -50000]));
  });

  it("reverse negates every line; finish refuses an unbalanced set", () => {
    expect(reverse(L(["cash", 100], ["sales", -100]))).toEqual(L(["cash", -100], ["sales", 100]));
    expect(() => finish(L(["cash", 100], ["sales", -99]))).toThrow(/do not balance/);
  });
});

describe("channel treatment comes from the pack", () => {
  it("each pack aggregator's tax_treatment decides operator_collects; own channels are counter sales", () => {
    let seen = 0;
    for (const pack of Object.values(PACKS)) {
      for (const a of pack.aggregators) {
        seen++;
        expect(channelTreatment(pack, `aggregator:${a.code}`)).toEqual({ aggregator: true, operator_collects: a.tax_treatment === "operator_collects_excluded" });
      }
      expect(channelTreatment(pack, "counter")).toEqual(counter);
      expect(channelTreatment(pack, "aggregator:not_in_any_pack")).toEqual(aggMerchant);
    }
    expect(seen).toBeGreaterThanOrEqual(4);
  });
});

describe("chart of accounts", () => {
  it("every required role resolves in each pack's seeded chart with its type; structural accounts are added once", () => {
    for (const pack of Object.values(PACKS)) {
      const chart = chartFor(pack);
      expect(chart.length).toBe(pack.chart_of_accounts.length + STRUCTURAL_ACCOUNTS.filter((s) => !pack.chart_of_accounts.some((a) => a.code === s.code)).length);
      expect(new Set(chart.map((a) => a.code)).size).toBe(chart.length);
      const r = roleResolver(chart);
      for (const [role, spec] of Object.entries(ROLES)) {
        if (spec.optional) continue;
        expect(r.need(role as keyof typeof ROLES).type, `${pack.code} ${role}`).toBe(spec.type);
      }
    }
  });

  it("a role with no account in the chart is refused when a rule needs it (paired with the resolved case)", () => {
    const r = roleResolver([{ code: "1000", name: "Cash", type: "asset" }]);
    expect(r.need("cash").code).toBe("1000");
    expect(() => r.need("sales")).toThrow(/account_missing/);
    // a code present with the wrong type is not that role
    expect(roleResolver([{ code: "4000", name: "x", type: "expense" }]).has("sales")).toBe(false);
  });

  it("P&L groups name expense roles only", () => {
    for (const g of Object.values(PNL_GROUPS)) for (const code of codesOf(g)) expect(chartFor(PACKS.IN!).find((a) => a.code === code)?.type).toBe("expense");
  });
});

describe("tally export", () => {
  it("renders one row per posting with debit/credit columns and neutralises formula text", () => {
    const csv = tallyCsv([{ entry_id: "e1", entry_date: "2026-09-30", narration: "finance.post_order", postings: [
      { account_code: "1110", account_name: "Counter sales clearing", amount_minor: 33600 },
      { account_code: "4000", account_name: "=HYPERLINK(\"x\")", amount_minor: -32000 },
      { account_code: "2100", account_name: "Output tax, payable", amount_minor: -1600 },
    ] }], 2);
    expect(csv).toBe([
      "Date,Voucher Type,Voucher No,Ledger Code,Ledger,Debit,Credit,Narration",
      "30-09-2026,Journal,e1,1110,Counter sales clearing,336.00,,finance.post_order",
      "30-09-2026,Journal,e1,4000,\"'=HYPERLINK(\"\"x\"\")\",,320.00,finance.post_order",
      "30-09-2026,Journal,e1,2100,\"Output tax, payable\",,16.00,finance.post_order",
      "",
    ].join("\r\n"));
  });
});

// ---- property gate: 1,000 generated source documents -------------------------------------------------
// Deterministic PRNG (mulberry32) so a failure reproduces; the seed is printed in the test name.
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

const SEED = 20261010;
export function generateDocs(n: number, seed = SEED): Array<{ kind: string; lines: Line[] | null; moves: boolean }> {
  const r = rng(seed);
  const int = (lo: number, hi: number) => lo + Math.floor(r() * (hi - lo + 1));
  const pick = <T>(xs: readonly T[]) => xs[int(0, xs.length - 1)]!;
  const out: Array<{ kind: string; lines: Line[] | null; moves: boolean }> = [];
  const kinds = ["order", "tender", "refund", "grn", "invoice", "settlement", "expense", "payroll"] as const;
  for (let i = 0; i < n; i++) {
    const kind = kinds[i % kinds.length]!;
    const tr = pick([counter, aggOperator, aggMerchant]);
    switch (kind) {
      case "order": {
        const total = pick([0, int(1, 99), int(100, 5_000_000)]);
        const tax = total === 0 ? 0 : int(0, Math.floor(total / 5));
        out.push({ kind, lines: postOrder({ ...tr, total_minor: total, tax_minor: tax }), moves: total > 0 && (!tr.operator_collects || total > tax) });
        break;
      }
      case "tender": {
        const amount = int(1, 2_000_000);
        const rounding = pick([0, 0, int(-50, 50)]);
        out.push({ kind, lines: postTender({ aggregator: tr.aggregator, method: pick(["cash", "card", "upi"] as const), amount_minor: amount, rounding_minor: rounding }), moves: true });
        break;
      }
      case "refund": {
        const total = int(1, 2_000_000);
        const prior = pick([0, int(0, total - 1)]);
        out.push({ kind, lines: postRefund({ aggregator: tr.aggregator, operator_collects: tr.operator_collects, method: pick(["cash", "card", "upi"] as const), amount_minor: int(1, total - prior),
          order_total_minor: total, order_tax_minor: int(0, Math.floor(total / 5)), prior_refunded_minor: prior, sale_posted: tr.aggregator || r() < 0.8 }), moves: true });
        break;
      }
      case "grn": {
        const lines = Array.from({ length: int(1, 6) }, () => ({ qty_milli: int(1, 50_000_000), unit_cost_minor: pick([0, int(1, 100), int(100, 90_000)]) }));
        out.push({ kind, lines: postGrn({ lines }), moves: lines.some((l) => Math.round((l.qty_milli * l.unit_cost_minor) / 1000) !== 0) });
        break;
      }
      case "invoice": {
        const sub = int(0, 9_000_000);
        const tax = pick([0, int(0, Math.floor(sub / 5))]);
        const grni = pick([sub, int(0, 9_000_000)]);
        out.push({ kind, lines: postSupplierInvoice({ subtotal_minor: sub, tax_minor: tax, total_minor: sub + tax, input_tax: r() < 0.5, grni_minor: grni }), moves: sub + tax > 0 });
        break;
      }
      case "settlement": {
        const lines = Array.from({ length: int(0, 8) }, () => {
          const kindL = pick(["order", "ad_fee", "promo_share", "adjustment"] as const);
          const gross = kindL === "order" ? int(0, 900_000) : kindL === "adjustment" ? int(-50_000, 50_000) : 0;
          const commission = kindL === "order" ? int(0, Math.floor(gross / 3)) : 0;
          const ad = kindL === "ad_fee" ? int(0, 30_000) : 0;
          const promo = kindL === "promo_share" ? int(0, 30_000) : 0;
          const tax = kindL === "order" ? int(0, Math.floor(gross / 20)) : 0;
          return { gross_minor: gross, commission_minor: commission, ad_fee_minor: ad, promo_share_minor: promo, tax_withheld_minor: tax, net_minor: gross - commission - ad - promo - tax };
        });
        const net = lines.length ? lines.reduce((a, l) => a + l.net_minor, 0) : int(-1000, 900_000);
        const moves = lines.length ? lines.some((l) => l.gross_minor !== 0 || l.net_minor !== 0) : net !== 0;
        out.push({ kind, lines: postSettlement({ ...tr, net_minor: net, lines }), moves });
        break;
      }
      case "expense": {
        const amount = int(1, 5_000_000);
        out.push({ kind, lines: postExpense({ category: pick(["rent", "utilities", "repairs", "marketing", "packaging", "bank_charges", "professional_fees", "other"] as const), amount_minor: amount, tax_minor: int(0, Math.floor(amount / 5)), input_tax: r() < 0.5 }), moves: true });
        break;
      }
      case "payroll": {
        const lines = Array.from({ length: int(1, 12) }, () => {
          const base = int(0, 3_000_000); const ot = int(0, 200_000); const tips = int(0, 50_000);
          const rec = int(0, base + ot + tips);
          return { base_minor: base, overtime_minor: ot, tips_minor: tips, advance_recovery_minor: rec, net_minor: base + ot + tips - rec };
        });
        out.push({ kind, lines: postPayroll({ lines }), moves: lines.some((l) => l.base_minor + l.overtime_minor + l.tips_minor > 0) });
        break;
      }
    }
  }
  return out;
}

describe(`property: 1,000 generated source documents (seed ${SEED})`, () => {
  const docs = generateDocs(1000);

  it("every document's entry balances, with ≥ 2 non-zero lines on distinct roles; null only when nothing moves", () => {
    expect(docs.length).toBe(1000);
    const bad: string[] = [];
    let posted = 0;
    for (const [i, d] of docs.entries()) {
      if (d.lines === null) {
        if (d.moves) bad.push(`#${i} ${d.kind}: null although money moves`);
        continue;
      }
      posted++;
      const sum = d.lines.reduce((a, l) => a + l.amount_minor, 0);
      if (sum !== 0) bad.push(`#${i} ${d.kind}: Σ = ${sum}`);
      if (d.lines.length < 2) bad.push(`#${i} ${d.kind}: ${d.lines.length} line(s)`);
      if (d.lines.some((l) => l.amount_minor === 0 || !Number.isSafeInteger(l.amount_minor))) bad.push(`#${i} ${d.kind}: zero or unsafe line`);
      if (new Set(d.lines.map((l) => l.role)).size !== d.lines.length) bad.push(`#${i} ${d.kind}: repeated role`);
    }
    expect(bad).toEqual([]);
    // Most generated documents move money (the generator's zero cases are a minority).
    expect(posted).toBeGreaterThan(900);
  });

  it("loyalty redemptions: 1,000 generated values balance on two lines; only 0 is null", () => {
    const r = rng(SEED + 2);
    const bad: string[] = [];
    for (let i = 0; i < 1000; i++) {
      const v = r() < 0.05 ? 0 : 1 + Math.floor(r() * 5_000_000);
      const lines = postLoyaltyRedemption({ aggregator: r() < 0.5, value_minor: v });
      if ((lines === null) !== (v === 0)) bad.push(`#${i}: ${v}`);
      if (lines && (lines.length !== 2 || lines.reduce((t, l) => t + l.amount_minor, 0) !== 0)) bad.push(`#${i}: unbalanced`);
    }
    expect(bad).toEqual([]);
  });

  it("advances: 1,000 generated rows balance; only a payroll recovery is null", () => {
    const r = rng(SEED + 1);
    const bad: string[] = [];
    let posted = 0;
    for (let i = 0; i < 1000; i++) {
      const a = { kind: r() < 0.5 ? ("given" as const) : ("recovered" as const), amount_minor: 1 + Math.floor(r() * 5_000_000), via_payroll: r() < 0.3 };
      if (a.kind === "given") a.via_payroll = false; // the table's CHECK: only a recovery names a payroll
      const lines = postAdvance(a);
      if (lines === null) {
        if (!a.via_payroll) bad.push(`#${i}: null`);
        continue;
      }
      posted++;
      if (lines.length !== 2 || lines.reduce((t, l) => t + l.amount_minor, 0) !== 0) bad.push(`#${i}: unbalanced`);
    }
    expect(bad).toEqual([]);
    expect(posted).toBeGreaterThan(600);
  });

  it("every kind is exercised (125 each)", () => {
    const by = new Map<string, number>();
    for (const d of docs) by.set(d.kind, (by.get(d.kind) ?? 0) + 1);
    expect([...by.values()]).toEqual([125, 125, 125, 125, 125, 125, 125, 125]);
  });
});
