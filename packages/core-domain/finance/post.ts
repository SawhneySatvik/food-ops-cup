// Posting rules (T-026): one pure function per seeded `finance.post_*` derivation rule. Each takes the
// source document's own fields and returns signed lines by ROLE (debit +, credit −), merged per role with
// zero lines dropped. Fewer than two lines left → null (nothing to post: e.g. a fully discounted order).
// Every result balances to 0 (asserted here; the database checks it again at commit, MB010).
// Choices marked INFERENCE are documented in the T-026 report; none depends on a country.
import { mulDiv } from "../money/index.ts";
import type { Role } from "./accounts.ts";

export type Line = { role: Role; amount_minor: number };
export type TenderMethod = "cash" | "card" | "upi";

/** Merge by role (first-seen order), drop zeros, assert Σ = 0; null when < 2 lines remain. */
export function finish(raw: readonly Line[]): Line[] | null {
  const out: Line[] = [];
  for (const l of raw) {
    if (!Number.isSafeInteger(l.amount_minor)) throw new Error(`posting: ${l.role} amount is not a safe integer`);
    const hit = out.find((x) => x.role === l.role);
    if (hit) hit.amount_minor += l.amount_minor;
    else out.push({ ...l });
  }
  const lines = out.filter((l) => l.amount_minor !== 0);
  const sum = lines.reduce((a, l) => a + l.amount_minor, 0);
  if (sum !== 0) throw new Error(`posting: lines do not balance (Σ = ${sum})`);
  return lines.length >= 2 ? lines : null;
}

/** A correcting entry: every line negated. */
export const reverse = (lines: readonly Line[]): Line[] => lines.map((l) => ({ role: l.role, amount_minor: -l.amount_minor }));

const receivable = (aggregator: boolean): Role => (aggregator ? "channel_receivable" : "counter_receivable");
const tenderAccount = (m: TenderMethod): Role => (m === "cash" ? "cash" : "bank");

export type ChannelTreatment = {
  /** The channel is an aggregator (`aggregator:<code>`): its money arrives through settlements. */
  aggregator: boolean;
  /** Pack `tax_treatment: operator_collects_excluded`: the operator pays the order's tax, so it is not
   *  the merchant's output tax and not part of what the operator owes the merchant. */
  operator_collects: boolean;
};

/** finance.post_order — a completed order: receivable for the total, sales net of tax, output tax. */
export function postOrder(o: ChannelTreatment & { total_minor: number; tax_minor: number }): Line[] | null {
  const net = o.total_minor - o.tax_minor;
  if (o.operator_collects) return finish([{ role: receivable(o.aggregator), amount_minor: net }, { role: "sales", amount_minor: -net }]);
  return finish([
    { role: receivable(o.aggregator), amount_minor: o.total_minor },
    { role: "sales", amount_minor: -net },
    { role: "output_tax", amount_minor: -o.tax_minor },
  ]);
}

/** finance.post_tender — money taken at the counter clears the order's receivable. A cash tender's
 *  `amount_minor` is the rounded amount taken; `rounding_minor` (rounded − due) goes to cash rounding. */
export function postTender(t: { aggregator: boolean; method: TenderMethod; amount_minor: number; rounding_minor: number }): Line[] | null {
  return finish([
    { role: tenderAccount(t.method), amount_minor: t.amount_minor },
    { role: receivable(t.aggregator), amount_minor: -(t.amount_minor - t.rounding_minor) },
    { role: "rounding", amount_minor: -t.rounding_minor },
  ]);
}

/** finance.post_refund — money paid back: sales and (pro rata to the order) output tax reversed. The tax
 *  share is refund × order tax ÷ order total, half away from zero (INFERENCE: the refund row has no split). */
export function postRefund(r: { operator_collects: boolean; method: TenderMethod; amount_minor: number; order_total_minor: number; order_tax_minor: number }): Line[] | null {
  const tax = r.operator_collects || r.order_total_minor <= 0 ? 0 : mulDiv(r.amount_minor, r.order_tax_minor, r.order_total_minor);
  return finish([
    { role: "sales", amount_minor: r.amount_minor - tax },
    { role: "output_tax", amount_minor: tax },
    { role: tenderAccount(r.method), amount_minor: -r.amount_minor },
  ]);
}

/** Σ round(qty_milli × unit_cost ÷ 1000) over GRN lines (the value received). */
export const grnValue = (lines: ReadonlyArray<{ qty_milli: number; unit_cost_minor: number }>): number =>
  lines.reduce((a, l) => a + mulDiv(l.qty_milli, l.unit_cost_minor, 1000), 0);

/** finance.post_grn — goods received, valued at GRN cost, expensed to COGS (purchases method — no
 *  consumption posting rule is seeded; INFERENCE) against goods-received-not-invoiced. */
export function postGrn(g: { lines: ReadonlyArray<{ qty_milli: number; unit_cost_minor: number }> }): Line[] | null {
  const v = grnValue(g.lines);
  return finish([{ role: "cogs", amount_minor: v }, { role: "grni", amount_minor: -v }]);
}

/** finance.post_supplier_invoice — an approved invoice moves its subtotal from GRNI to payables; its tax is
 *  input tax where the chart has an input-tax account, else part of the cost (COGS). */
export function postSupplierInvoice(i: { subtotal_minor: number; tax_minor: number; total_minor: number; input_tax: boolean }): Line[] | null {
  return finish([
    { role: "grni", amount_minor: i.subtotal_minor },
    { role: i.input_tax ? "input_tax" : "cogs", amount_minor: i.tax_minor },
    { role: "payables", amount_minor: -i.total_minor },
  ]);
}

export type SettlementLine = {
  gross_minor: number;
  commission_minor: number;
  ad_fee_minor: number;
  promo_share_minor: number;
  tax_withheld_minor: number;
  net_minor: number;
};

/** finance.post_settlement — an approved payout: bank gets Σ net, the channel receivable is cleared by
 *  Σ gross, commission and ad/promo deductions are expensed. Tax withheld clears the receivable where the
 *  operator collects the tax (it never was ours), else it is a credit against output tax. A payout with no
 *  lines posts its net against the receivable. */
export function postSettlement(s: ChannelTreatment & { net_minor: number; lines: readonly SettlementLine[] }): Line[] | null {
  const recv = receivable(s.aggregator);
  if (s.lines.length === 0) return finish([{ role: "bank", amount_minor: s.net_minor }, { role: recv, amount_minor: -s.net_minor }]);
  const t = (k: keyof SettlementLine) => s.lines.reduce((a, l) => a + l[k], 0);
  return finish([
    { role: "bank", amount_minor: t("net_minor") },
    { role: "commission", amount_minor: t("commission_minor") },
    { role: "channel_promotions", amount_minor: t("ad_fee_minor") + t("promo_share_minor") },
    { role: s.operator_collects ? recv : "output_tax", amount_minor: t("tax_withheld_minor") },
    { role: recv, amount_minor: -t("gross_minor") },
  ]);
}

export type ExpenseCategory = "rent" | "utilities" | "repairs" | "marketing" | "packaging" | "bank_charges" | "professional_fees" | "other";
export const EXPENSE_ROLE: Readonly<Record<ExpenseCategory, Role>> = {
  rent: "rent",
  utilities: "utilities",
  bank_charges: "payment_fees",
  packaging: "cogs",
  repairs: "other_expense",
  marketing: "other_expense",
  professional_fees: "other_expense",
  other: "other_expense",
};

/** finance.post_expense — an expense paid from the bank (INFERENCE: the row has no payment method);
 *  `amount_minor` includes `tax_minor`, which is input tax where the chart has the account, else cost. */
export function postExpense(e: { category: ExpenseCategory; amount_minor: number; tax_minor: number; input_tax: boolean }): Line[] | null {
  const role = EXPENSE_ROLE[e.category];
  return finish([
    { role, amount_minor: e.amount_minor - e.tax_minor },
    { role: e.input_tax ? "input_tax" : role, amount_minor: e.tax_minor },
    { role: "bank", amount_minor: -e.amount_minor },
  ]);
}

/** finance.post_payroll — an approved payroll: wages at gross (base + overtime + tips), net paid from the
 *  bank (paid externally; INFERENCE), advances recovered credited to staff advances. */
export function postPayroll(p: { lines: ReadonlyArray<{ base_minor: number; overtime_minor: number; tips_minor: number; advance_recovery_minor: number; net_minor: number }> }): Line[] | null {
  const t = (f: (l: (typeof p.lines)[number]) => number) => p.lines.reduce((a, l) => a + f(l), 0);
  return finish([
    { role: "wages", amount_minor: t((l) => l.base_minor + l.overtime_minor + l.tips_minor) },
    { role: "bank", amount_minor: -t((l) => l.net_minor) },
    { role: "staff_advances", amount_minor: -t((l) => l.advance_recovery_minor) },
  ]);
}
